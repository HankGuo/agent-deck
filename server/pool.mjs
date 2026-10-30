/**
 * Agent 进程池
 *
 * 内存策略(3.6G 小机器的关键):
 *   - ACP agent(kimi/minimax):常驻一个进程,空闲 15 分钟自动回收
 *   - Antigravity:无常驻,每条 prompt 起一次进程,结束即退
 *   - 全局并发上限 + 单 agent 并发上限
 *   - 跑完立即释放,不让 3 套 agent 常驻吃内存
 *
 * 身份注入(按各家原生机制分层,见 AGENTS.md 踩坑记录):
 *   MiniMax    → mcode acp --system-prompt-file <file>   (真 system prompt)
 *   Antigravity→ 写 <workspace>/.agents/agents/<id>.md + --agent "<name>"
 *   Kimi      → ACP 无原生口,由 orchestrator 前置 prompt 块兜底
 */

import { AcpSession } from './acp-client.mjs';
import { AgyRunner } from './agy-client.mjs';
import { EventEmitter } from 'node:events';
import { compileAgentFile, compileIdentity } from './roster.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class AgentPool extends EventEmitter {
  constructor(registry, opts = {}) {
    super();
    this.registry = registry;
    this.limits = registry.limits;
    this.agents = new Map();
    this.sessions = new Map();
    this.dirty = new Set();        // 身份卡改过 → 下次 acquire 重建
    this.activeRuns = 0;
    this.waiters = [];     // 并发满时排队等槽位(单用户场景不该被拒绝,应该排队)
    this.runWindow = [];
    this.identityDir = path.join(registry.contextDir, '..', 'runtime', 'identity');
    this.agentIds = registry.agents.map((a) => a.id);
    this.cardStore = opts.cardStore || null;
    for (const a of registry.agents) this.agents.set(a.id, a);
    this._reaper = setInterval(() => this._reap(), 60000);
    this._reaper.unref?.();
  }

  _canRun() {
    const now = Date.now();
    this.runWindow = this.runWindow.filter((t) => now - t < 3600000);
    if (this.runWindow.length >= this.limits.maxRunsPerHour) {
      throw new Error('已达每小时调用上限,请稍后再试');
    }
    this.runWindow.push(now);
  }

  /**
   * 等一个执行槽位。
   * 单用户场景下「并发满」不代表有人在抢 —— 往往只是自己连点了两次。
   * 所以这里排队等,而不是直接拒绝(拒绝会让人以为坏了)。
   * 排队超过 queueTimeoutMs 才放弃。
   */
  async _acquireSlot() {
    if (this.activeRuns < this.limits.maxConcurrentRuns) { this.activeRuns++; return; }
    const waiters = this.waiters;
    await new Promise((resolve, reject) => {
      const entry = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('排队超时,前面的活还没做完,请稍后再试'));
      }, this.limits.queueTimeoutMs || 90000);
      waiters.push(entry);
    });
    this.activeRuns++;
  }

  _releaseSlot() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    const w = this.waiters.shift();
    if (w) w();   // 唤醒下一个排队的(activeRuns 由它自己 ++)
  }

  /** 身份卡改了 → 把常驻 session 作废,下次用到时重建 */
  markDirty(agentId) {
    this.dirty.add(agentId);
    const e = this.sessions.get(agentId);
    if (e) {
      e.sess.stop();
      this.sessions.delete(agentId);
      console.log(`[pool] ${agentId} 身份已变更,session 作废待重建`);
    }
  }

  /** 把身份写给对应 agent 的原生通道 */
  async _injectIdentity(def, agentId) {
    if (!this.cardStore) return { cmd: [...def.cmd] };
    const cards = await this.cardStore.readAll(this.agentIds);
    const agentName = cards[agentId]?.name || def.name;

    if (def.protocol === 'ndjson') {
      // Antigravity:原生 agent 定义,必须带 frontmatter,按 frontmatter 的 name 选
      // 写在它自己的 workspace 里,避免 Kimi 扫到(Kimi 也会读 workspace 的 .agents/agents/)
      const ws = def.cwd || this.registry.workspace;
      const dir = path.join(ws, '.agents', 'agents');
      await fs.mkdir(dir, { recursive: true });
      // 清掉旧定义,避免残留的 agent 名被误选
      for (const f of await fs.readdir(dir)) {
        if (f.endsWith('.md')) await fs.rm(path.join(dir, f), { force: true });
      }
      await fs.writeFile(path.join(dir, `${def.id}.md`), compileAgentFile(cards, this.agentIds, agentId), 'utf8');
      return { cmd: [...def.cmd, '--agent', def.id] };
    }
    if (def.id === 'minimax') {
      // MiniMax:原生 system prompt 文件(纯正文即可)
      await fs.mkdir(this.identityDir, { recursive: true });
      const f = path.join(this.identityDir, `${def.id}.md`);
      await fs.writeFile(f, compileIdentity(cards, this.agentIds, agentId), 'utf8');
      return { cmd: [...def.cmd, '--system-prompt-file', f] };
    }
    // Kimi:ACP 无原生口,交给 orchestrator 前置
    return { cmd: [...def.cmd] };
  }

  /** 取一个 agent 运行句柄 */
  async acquire(agentId, opts = {}) {
    const def = this.agents.get(agentId);
    if (!def) throw new Error(`未知 agent: ${agentId}`);
    this._canRun();

    const perAgent = [...this.sessions.values()].filter((s) => s.agent.id === agentId && s.sess.busy).length;
    if (perAgent >= this.limits.maxConcurrentPerAgent) {
      throw new Error(`${def.name} 正在忙,稍后再试`);
    }

    await this._acquireSlot();

    let cmd;
    try {
      cmd = await this._injectIdentity(def, agentId);
    } catch (e) {
      this._releaseSlot();
      throw e;
    }
    const runDef = { ...def, cmd: cmd.cmd };

    if (def.protocol === 'ndjson') {
      const runner = new AgyRunner(runDef, {
        cwd: runDef.cwd || this.registry.workspace,
        timeoutMs: this.limits.promptTimeoutMs,
      });
      return { def: runDef, runner, release: () => this._releaseSlot() };
    }

    let entry = this.sessions.get(agentId);
    if (entry && this.dirty.has(agentId)) {
      entry.sess.stop();
      this.sessions.delete(agentId);
      entry = null;
    }
    if (!entry || !entry.sess.proc) {
      const sess = new AcpSession(runDef, {
        cwd: this.registry.workspace,
        fsAllow: this.registry.fsAllow,
        timeoutMs: this.limits.promptTimeoutMs,
      });
      await sess.start();
      await sess.newSession(this.registry.workspace);
      entry = { sess, agent: runDef, timer: null };
      this.sessions.set(agentId, entry);
      this.dirty.delete(agentId);
      console.log(`[pool] ${def.name} ACP 已就绪: ${JSON.stringify(sess.agentInfo)}`);
      sess.on('exit', () => {
        if (this.sessions.get(agentId)?.sess === sess) this.sessions.delete(agentId);
      });
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.sessions.get(agentId)?.sess === entry.sess) {
        entry.sess.stop();
        this.sessions.delete(agentId);
        this.emit('reaped', { agent: agentId });
      }
    }, this.limits.agentIdleReapMs);
    entry.timer.unref?.();

    return { def: runDef, runner: entry.sess, release: () => this._releaseSlot() };
  }

  _reap() {
    const now = Date.now();
    for (const [id, e] of this.sessions) {
      if (!e.sess.busy && now - e.sess.lastUsedAt > this.limits.agentIdleReapMs) {
        e.sess.stop();
        this.sessions.delete(id);
        this.emit('reaped', { agent: id });
      }
    }
  }

  /** 运行时能力矩阵:从握手结果里自动发现,不手抄 */
  capabilityMatrix() {
    const out = {};
    for (const [id, e] of this.sessions) {
      out[id] = {
        agentInfo: e.sess.agentInfo || null,
        capabilities: e.sess.capabilities || null,
      };
    }
    return out;
  }

  async shutdown() {
    clearInterval(this._reaper);
    for (const [, e] of this.sessions) e.sess.stop();
    this.sessions.clear();
  }
}
