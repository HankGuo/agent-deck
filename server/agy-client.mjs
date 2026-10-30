/**
 * Antigravity 适配器 —— 走 print + stream-json(NDJSON),不是 ACP
 *
 * NDJSON 结构(实测 2026-10-22):
 *   {"event":"init",  "conversation_id":"...", "init":{cwd, tools[], permission_mode:"always-proceed"}}
 *   {"event":"step_update","step_update":{step_type:"user_input"|"agent_response"|"tool", state:"ACTIVE"|"DONE",
 *        text_delta?, tool_name?, tool_info?, usage?}}
 *   {"event":"result","result":{status, response, duration_seconds, num_turns, usage}}
 *
 * agent_response 的 ACTIVE/DONE 都带 text_delta,拼起来才是完整回复。
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class AgyRunner extends EventEmitter {
  constructor(agent, opts = {}) {
    super();
    this.agent = agent;
    this.cmd = agent.cmd;
    this.cwd = opts.cwd || agent.cwd || './workspace';
    this.timeoutMs = opts.timeoutMs || 600000;
    this.proc = null;
    this.buf = '';
    this.busy = false;
    this.stopped = false;
    this.lastUsedAt = Date.now();
  }

  async start() { /* agy 是无常驻进程,每条 prompt 起一次 */ }

  describe() {
    return `${this.cmd[0]} (${this.cwd})`;
  }

  async prompt(text, { signal, effort } = {}) {
    this.busy = true;
    this.lastUsedAt = Date.now();

    const [bin, ...rest] = this.cmd;
    // 注意:agy 的 --print 必须写成 --print=<文本>,裸 --print 会把下一个参数当成 prompt 吞掉
    const args = [`--print=${text}`, ...rest];
    // 出计划这种简单活儿用低 effort,快很多
    if (effort) args.push('--effort', effort);
    const proc = spawn(bin, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        HOME: '/home/ubuntu',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        PATH: '/home/ubuntu/.local/bin:/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c) => this._onData(c));
    proc.stderr.setEncoding('utf8');
    let stderrBuf = '';
    proc.stderr.on('data', (c) => {
      stderrBuf = (stderrBuf + c).slice(-4000);
    });
    this._stderr = () => stderrBuf;

    let timer = null;
    const onAbort = () => this._kill();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const done = new Promise((resolve, reject) => {
      let finalResponse = null;
      let status = 'UNKNOWN';

      const handle = (msg) => {
        const ev = msg.event;
        if (ev === 'init') {
          this.emit('capabilities', {
            capabilities: { promptCapabilities: { image: true } },
            agentInfo: { name: 'Antigravity', version: this.agent.version || '1.4.4' },
            permissionMode: msg.init?.permission_mode,
            tools: msg.init?.tools || [],
          });
          return;
        }
        if (ev === 'step_update') {
          const su = msg.step_update || {};
          if (su.step_type === 'agent_response') {
            if (su.text_delta) this.emit('text', { text: su.text_delta });
          } else if (su.step_type === 'tool') {
            this.emit('tool', {
              kind: su.tool_name || 'tool',
              title: su.tool_name || 'tool',
              status: su.state === 'DONE' ? 'completed' : 'pending',
              raw: su.tool_info?.parameters ?? null,
            });
          }
          return;
        }
        if (ev === 'result') {
          finalResponse = msg.result?.response ?? null;
          status = msg.result?.status ?? 'UNKNOWN';
          this.emit('usage', msg.result?.usage || null);
        }
      };
      this._handler = handle;

      timer = setTimeout(() => {
        this.emit('error', { message: 'prompt 超时', timeout: true });
        this._kill();
      }, this.timeoutMs);

      proc.on('error', (e) => {
        clearTimeout(timer);
        console.error(`[agy] spawn 失败: ${e.message}`);
        reject(e);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        const err = stderrBuf.trim();
        if (err) console.error(`[agy] stderr(${code}/${signal}): ${err.slice(-1200)}`);
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          reject(new Error('agent 被终止'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`agy 退出码 ${code}` + (err ? `: ${err.slice(-400)}` : '')));
          return;
        }
        resolve({ status, response: finalResponse, code });
      });
    });

    try {
      return await done;
    } finally {
      this.busy = false;
      this.proc = null;
      this.lastUsedAt = Date.now();
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._handler?.(msg);
    }
  }

  _kill() {
    try { this.proc?.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch {} }, 2500);
  }

  stop() { this.stopped = true; this._kill(); }
}
