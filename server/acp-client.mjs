/**
 * ACP v1 客户端 —— Kimi Code / MiniMax Code 走这条路
 *
 * 协议要点(来自 agentclientprotocol.com v1 规范):
 *   - initialize: clientCapabilities = { fs:{readTextFile,writeTextFile}, terminal }
 *   - session/new: { cwd, mcpServers:[] }
 *   - session/prompt: { sessionId, prompt:[{type:"text",text}] }
 *   - agent → client 反向请求: fs/read_text_file, fs/write_text_file, session/request_permission
 *   - agent → client 通知: session/update(sessionUpdate 变体)
 *
 * 安全:fs 请求走路径白名单,越界直接拒绝。权限请求一律自动放行(allow_always 优先)。
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

let MSG_ID = 0;
const nextId = () => ++MSG_ID;

export class AcpSession extends EventEmitter {
  constructor(agent, opts = {}) {
    super();
    this.agent = agent;
    this.cmd = agent.cmd;
    this.cwd = opts.cwd || agent.cwd || './workspace';
    this.fsAllow = (opts.fsAllow || []).map((p) => path.resolve(p));
    this.timeoutMs = opts.timeoutMs || 600000;
    this.proc = null;
    this.buf = '';
    this.pending = new Map();   // id -> {resolve, reject, method}
    this.sessionId = null;
    this.capabilities = null;
    this.agentInfo = null;
    this.lastUsedAt = Date.now();
    this.busy = false;
    this.stopped = false;
  }

  /* ---------------- 生命周期 ---------------- */

  async start() {
    if (this.proc) return;
    const [bin, ...args] = this.cmd;
    this.proc = spawn(bin, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        HOME: '/home/ubuntu',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        PATH: '/home/ubuntu/.kimi-code/bin:/home/ubuntu/.npm-global/bin:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    // stderr 必须持续消费,否则管道写满会把 agent 卡死
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.stopped = true;
      for (const [, p] of this.pending) p.reject(new Error(`agent exited (code=${code} signal=${signal})`));
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
    this.proc.on('error', (err) => {
      this.emit('error', err);
    });

    await this._call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'agent-deck', version: '1.0.0' },
    }, 60000).then((res) => {
      this.capabilities = res?.agentCapabilities || null;
      this.agentInfo = res?.agentInfo || null;
      this.emit('capabilities', { capabilities: this.capabilities, agentInfo: this.agentInfo });
    });
  }

  async newSession(cwd) {
    if (cwd) this.cwd = cwd;
    const res = await this._call('session/new', { cwd: this.cwd, mcpServers: [] }, 60000);
    this.sessionId = res?.sessionId || null;
    this.lastUsedAt = Date.now();
    return res;
  }

  /**
   * 发一句话,流式吐出事件。
   * 事件类型: text / thought / tool / tool_result / notice / error / done
   */
  async prompt(text, { signal } = {}) {
    if (!this.sessionId) await this.newSession();
    this.busy = true;
    this.lastUsedAt = Date.now();

    const timer = setTimeout(() => {
      this.emit('error', { message: 'prompt 超时', timeout: true });
      this._kill();
    }, this.timeoutMs);

    const onAbort = () => { this._kill(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      const res = await this._call('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      }, this.timeoutMs + 5000);
      this.lastUsedAt = Date.now();
      console.log(`[acp] ${this.agent.name} session/prompt 返回: ${JSON.stringify(res).slice(0, 400)}`);
      return res;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      this.busy = false;
      this.lastUsedAt = Date.now();
    }
  }

  stop() {
    this.stopped = true;
    this._kill();
  }

  _kill() {
    if (!this.proc) return;
    try { this.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch {} }, 3000);
  }

  /* ---------------- JSON-RPC ---------------- */

  _write(obj) {
    if (!this.proc) throw new Error('agent 未启动');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _call(method, params, timeoutMs = 60000) {
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method,
      });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
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
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // agent → client 请求(带 method + id)
    if (msg.method && msg.id !== undefined) {
      this._handleAgentRequest(msg);
      return;
    }
    // agent → client 通知
    if (msg.method) {
      if (msg.method === 'session/update') this._handleUpdate(msg.params || {});
      else this.emit('notice', msg);
      return;
    }
    // client → agent 响应
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error?.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }

  /* ---------------- agent 反向请求 ---------------- */

  async _handleAgentRequest(msg) {
    const { method, id, params = {} } = msg;
    try {
      switch (method) {
        case 'fs/read_text_file': {
          const p = this._guard(params.path, 'read');
          const content = await fs.readFile(p, 'utf8');
          let out = content;
          if (typeof params.line === 'number' && params.line >= 0) {
            const lines = content.split('\n');
            const start = params.line;
            const end = params.limit ? start + params.limit : lines.length;
            out = lines.slice(start, end).join('\n');
          }
          this._write({ jsonrpc: '2.0', id, result: { content: out } });
          this.emit('tool', { kind: 'fs_read', title: path.basename(p), status: 'completed' });
          return;
        }
        case 'fs/write_text_file': {
          const p = this._guard(params.path, 'write');
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, params.content ?? '', 'utf8');
          this._write({ jsonrpc: '2.0', id, result: {} });
          this.emit('tool', { kind: 'fs_write', title: path.basename(p), status: 'completed' });
          this.emit('artifact_candidate', { path: p, name: path.basename(p) });
          return;
        }
        case 'session/request_permission': {
          // 免确认:优先 allow_always,否则第一个允许类选项
          const options = Array.isArray(params.options) ? params.options : [];
          const pick =
            options.find((o) => o.kind === 'allow_always') ||
            options.find((o) => o.kind === 'allow_once') ||
            options.find((o) => /allow/i.test(o.optionId || '')) ||
            options[0];
          if (!pick) {
            this._write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
            return;
          }
          this.emit('tool', { kind: 'permission', title: params.title || pick.name, status: 'completed', auto: true });
          this._write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } });
          return;
        }
        case 'terminal/create':
        case 'terminal/output':
        case 'terminal/release':
        case 'terminal/waitForExit': {
          // 这三个 agent 自带 shell,基本不会走 client terminal;真走到就明确拒
          this._write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'client terminal not supported' } });
          return;
        }
        default: {
          this._write({ jsonrpc: '2.0', id, result: {} });
        }
      }
    } catch (e) {
      this._write({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e.message || e) } });
    }
  }

  /** 路径白名单:越界直接抛,这是"绝对安全"的硬边界 */
  _guard(p, mode) {
    if (typeof p !== 'string' || !p) throw new Error('路径为空');
    const abs = path.resolve(p);
    const ok = this.fsAllow.some((root) => abs === root || abs.startsWith(root + path.sep));
    if (!ok) throw new Error(`路径不在白名单内,拒绝${mode === 'read' ? '读取' : '写入'}: ${abs}`);
    return abs;
  }

  /* ---------------- session/update 翻译 ---------------- */

  _handleUpdate(params) {
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.emit('text', { text: u.content?.text || '' });
        break;
      case 'agent_thought_chunk':
        this.emit('thought', { text: u.content?.text || '' });
        break;
      case 'user_message_chunk':
        this.emit('echo', { text: u.content?.text || '' });
        break;
      case 'tool_call_update':
        this.emit('tool', {
          kind: u.kind || 'tool',
          toolCallId: u.toolCallId,
          title: u.title || u.kind || 'tool',
          status: u.status || 'pending',
          raw: u.rawInput ?? null,
          content: u.content ?? null,
        });
        break;
      case 'tool_call_content':
      case 'tool_call_content_chunk':
        this.emit('tool_content', { toolCallId: u.toolCallId, content: u.content });
        break;
      case 'plan':
      case 'plan_update':
        this.emit('plan', { entries: u.entries || [] });
        break;
      case 'terminal_output_chunk':
      case 'terminal_output':
        this.emit('terminal', { text: u.output || u.data || '' });
        break;
      case 'usage_update':
        this.emit('usage', u);
        break;
      default:
        this.emit('notice', { sessionUpdate: u.sessionUpdate, u });
    }
  }
}
