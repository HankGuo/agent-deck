/**
 * Agent Deck 网关
 *
 * 只监听 127.0.0.1,由 nginx 反代 + Basic Auth 兜底。
 * 流式走 SSE(浏览器 → 服务端用 POST),免 ws 依赖。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { AgentPool } from './pool.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { CardStore, compileRoster } from './roster.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DECK_ROOT || path.resolve(__dirname, '..');
const WEB = path.join(__dirname, 'web');   // 前端目录跟着 server/ 走,不靠 DECK_ROOT
const PORT = Number(process.env.DECK_PORT || 8788);

const registry = JSON.parse(await fs.readFile(path.join(__dirname, 'registry.json'), 'utf8'));

/* 身份卡存储: agents/<agentId>.md */
const CARD_DIR = path.join(path.resolve(registry.contextDir, '..'), 'agents');
const defaults = {};
for (const a of registry.agents) defaults[a.id] = { ...a.identity };
const cardStore = new CardStore(CARD_DIR, defaults);
await cardStore.seed(registry.agents.map((a) => a.id));

const pool = new AgentPool(registry, { cardStore });
const orch = new Orchestrator(registry, pool, cardStore);

const runs = new Map();          // runId -> { events[], clients:Set, done }
let runSeq = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ── CSRF 防护:写操作校验来源 ──────────────────────────────────────────
 * 背景:认证在 nginx 层(Basic Auth),浏览器会自动带上凭据 →
 *       任何被诱导打开的网页都能往 /api/run 之类打个 POST,
 *       白白启动 agent 烧配额、读工作区文件。
 * 做法:只对写方法校验来源,读方法(SSE/GET)一律放行,不影响使用。
 *   · 有 Origin   → 必须命中白名单
 *   · 无 Origin 有 Referer → Referer 必须命中白名单
 *   · 两者都无    → 放行(非浏览器请求:curl/脚本/E2E)
 *   · Origin 为 "null"(sandbox/file://)→ 一律拒绝
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_ORIGINS = new Set([
  process.env.APP_ORIGIN || 'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:3000',
]);

function originAllowed(value) {
  if (!value) return false;
  const s = String(value).trim();
  if (s === 'null') return false;              // sandbox / file:// 页面,一律拒绝
  try {
    return ALLOWED_ORIGINS.has(new URL(s).origin);
  } catch {
    return false;
  }
}

function csrfCheck(req) {
  if (!WRITE_METHODS.has(req.method)) return null;          // 读操作不管
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!originAllowed(origin)) {
      return `请求来源不被信任: ${origin}`;
    }
    return null;
  }
  const referer = req.headers.referer;
  if (referer !== undefined) {
    if (!originAllowed(referer)) {
      return `请求来源不被信任: ${referer}`;
    }
    return null;
  }
  return null;                                              // 非浏览器请求,放行
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function safeName(name) {
  if (typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // CSRF 闸门:写操作先验来源,不通过直接拒
  const csrfErr = csrfCheck(req);
  if (csrfErr) {
    console.log(`[csrf] 拒绝 ${req.method} ${p} — ${csrfErr}`);
    return json(res, 403, { error: '请求来源不被信任' });
  }

  try {
    if (p === '/api/health') {
      return json(res, 200, { ok: true, agents: registry.agents.map((a) => a.id), activeRuns: pool.activeRuns, uptime: process.uptime() });
    }

    if (p === '/api/bootstrap') {
      return json(res, 200, {
        agents: registry.agents.map((a) => ({
          id: a.id, key: a.key, name: a.name, short: a.short, color: a.color, logo: a.logo,
          model: a.model, capability: a.capability, abilities: a.abilities, bestFor: a.bestFor,
          protocol: a.protocol,
        })),
        tools: registry.tools,
        context: registry.context,
        capabilities: pool.capabilityMatrix(),
        limits: { maxConcurrentRuns: registry.limits.maxConcurrentRuns },
      });
    }

    if (p === '/api/plan' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const plan = await orch.parse(body.text || '', {
        scope: body.scope, mode: body.mode,
        who: body.who, boss: body.boss, crew: body.crew,
      });
      return json(res, 200, { plan });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 8 << 20)).toString('utf8') || '{}');
      const runId = 'r' + (++runSeq) + '-' + Date.now().toString(36);
      const run = { id: runId, events: [], clients: new Set(), done: false, startedAt: Date.now(), ac: new AbortController() };
      runs.set(runId, run);
      // 事件先进缓冲,客户端连上来后补发,避免丢开头
      const emit = (ev) => {
        run.events.push(ev);
        const payload = `data: ${JSON.stringify(ev)}\n\n`;
        for (const c of run.clients) { try { c.write(payload); } catch {} }
      };
      emit({ type: 'run_start', runId });

      (async () => {
        try {
          const plan = body.plan && body.plan.scope ? body.plan : await orch.parse(body.text || '');
          const result = await orch.run({
            text: body.text || '',
            plan,
            uploadPaths: body.uploadPaths || [],
            ctxTags: body.ctxTags || [],
          }, emit, { signal: run.ac.signal });
          emit({ type: 'done', result });
        } catch (e) {
          emit({ type: 'error', message: String(e.message || e) });
          emit({ type: 'done', result: { status: 'error' } });
        } finally {
          run.done = true;
          const payload = `data: ${JSON.stringify({ type: 'done', result: { status: 'done' } })}\n\n`;
          for (const c of run.clients) { try { c.end(payload); } catch {} }
          run.clients.clear();
          setTimeout(() => runs.delete(runId), 10 * 60 * 1000);
        }
      })();

      return json(res, 200, { runId, plan: body.plan || null });
    }

    if (p === '/api/stream') {
      const runId = url.searchParams.get('runId');
      const run = runs.get(runId);
      if (!run) return json(res, 404, { error: 'run 不存在' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (run.done) { res.end(); return; }
      run.clients.add(res);
      /* 用 res 的 close(不是 req 的):req 在 GET 请求体为空时会提前触发,不可靠 */
      res.on('close', () => {
        run.clients.delete(res);
        if (res.writableEnded) return;          /* 正常收尾,不是断线 */
        /* 没人看了就中止,别在后台白烧额度 */
        if (!run.clients.size && !run.done) {
          console.log(`[deck] run ${runId} 客户端断开,中止`);
          run.ac.abort();
        }
      });
      return;
    }

    if (p === '/api/agents') {
      const ids = registry.agents.map((a) => a.id);
      const cards = await cardStore.readAll(ids);
      const roster = compileRoster(cards, ids, null);
      return json(res, 200, {
        cards: ids.map((id) => ({
          id,
          agentName: registry.agents.find((a) => a.id === id).name,
          key: registry.agents.find((a) => a.id === id).key,
          color: registry.agents.find((a) => a.id === id).color,
          logo: registry.agents.find((a) => a.id === id).logo,
          protocol: registry.agents.find((a) => a.id === id).protocol,
          identity: cards[id],
          injection: id === 'minimax' ? '原生 system prompt(--system-prompt-file)'
            : id === 'antigravity' ? '原生 agent 定义(--agent + .agents/agents/)'
            : 'prompt 前置(ACP 无原生口)',
        })),
        roster,
      });
    }

    if (p.startsWith('/api/agents/') && req.method === 'PUT') {
      const id = decodeURIComponent(p.slice('/api/agents/'.length));
      if (!registry.agents.find((a) => a.id === id)) return json(res, 404, { error: '未知 agent' });
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const card = body.identity || body;
      if (!card || typeof card !== 'object') return json(res, 400, { error: '缺身份卡内容' });
      card.name = String(card.name || '').slice(0, 60);
      card.role = String(card.role || '').slice(0, 300);
      card.strengths = (Array.isArray(card.strengths) ? card.strengths : []).map((s) => String(s).slice(0, 60)).slice(0, 20);
      card.avoid = (Array.isArray(card.avoid) ? card.avoid : []).map((s) => String(s).slice(0, 60)).slice(0, 20);
      card.notes = String(card.notes || '').slice(0, 4000);
      // name 是身份卡的核心标识,不能空。
      // 以前这里兜底成 id,结果一张空卡会把 name 写成 "kimi"/"minimax" 并清空 role/strengths/avoid,
      // 把线上配置写坏(2026-10-23 实际发生过一次)。宁可拒写,也不能写坏。
      if (!card.name.trim()) {
        return json(res, 400, { error: '身份卡缺少 name,拒绝写入' });
      }
      await cardStore.write(id, card);
      pool.markDirty(id);
      const ids = registry.agents.map((a) => a.id);
      const cards = await cardStore.readAll(ids);
      return json(res, 200, { ok: true, id, identity: cards[id], roster: compileRoster(cards, ids, null) });
    }

    if (p === '/api/artifacts') {
      const dir = registry.outputs;
      let names = [];
      try { names = await fs.readdir(dir); } catch {}
      const items = [];
      for (const n of names) {
        if (n === 'assets') continue;
        try {
          const st = await fs.stat(path.join(dir, n));
          if (!st.isFile()) continue;
          items.push({ name: n, size: st.size, mtime: st.mtimeMs, url: '/outputs/' + encodeURIComponent(n) });
        } catch {}
      }
      items.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { items });
    }

    if (p === '/api/uploads') {
      const dir = registry.uploads;
      let names = [];
      try { names = await fs.readdir(dir); } catch {}
      const items = [];
      for (const n of names) {
        if (n === 'assets') continue;
        try {
          const st = await fs.stat(path.join(dir, n));
          if (!st.isFile()) continue;
          items.push({ name: n, size: st.size, mtime: st.mtimeMs, url: '/uploads/' + encodeURIComponent(n), abs: path.join(dir, n) });
        } catch {}
      }
      items.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { items });
    }

    if (p === '/api/preview') {
      const name = safeName(url.searchParams.get('name'));
      const which = url.searchParams.get('dir') === 'uploads' ? registry.uploads : registry.outputs;
      if (!name) return json(res, 400, { error: '非法文件名' });
      const abs = path.join(which, name);
      if (!abs.startsWith(which + path.sep) && abs !== which) return json(res, 400, { error: '路径越界' });
      if (!fss.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
      const ext = path.extname(abs).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
        return json(res, 200, { type: 'image', url: '/outputs/' + encodeURIComponent(name) });
      }
      const out = await new Promise((resolve) => {
        execFile('python3', [path.join(__dirname, 'preview.py'), abs], { timeout: 60000, maxBuffer: 64 << 20 }, (err, stdout) => {
          if (err) return resolve({ type: 'raw', note: '解析失败' });
          try { resolve(JSON.parse(stdout)); } catch { resolve({ type: 'raw', note: '解析失败' }); }
        });
      });
      out.name = name;
      out.url = '/outputs/' + encodeURIComponent(name);
      return json(res, 200, out);
    }

    if (p === '/api/upload' && req.method === 'POST') {
      // 简单 multipart 解析:只取第一个文件
      const buf = await readBody(req, registry.limits.maxUploadBytes + 1024 * 1024);
      const ctype = req.headers['content-type'] || '';
      const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
      if (!m) return json(res, 400, { error: '不是 multipart 请求' });
      const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
      const idx = buf.indexOf(boundary);
      if (idx < 0) return json(res, 400, { error: '解析失败' });
      const headerEnd = buf.indexOf('\r\n\r\n', idx);
      if (headerEnd < 0) return json(res, 400, { error: '解析失败' });
      const header = buf.slice(idx, headerEnd).toString('utf8');
      const nextB = buf.indexOf(boundary, headerEnd);
      const content = buf.slice(headerEnd + 4, nextB < 0 ? buf.length : nextB - 2);
      const fn = /filename="([^"]*)"/i.exec(header);
      let name = fn ? fn[1] : '';
      name = path.basename(name).replace(/[^\w.\-一-龥]/g, '_');
      if (!name) return json(res, 400, { error: '缺文件名' });
      const dest = path.join(registry.uploads, name);
      await fs.writeFile(dest, content);
      return json(res, 200, { name, size: content.length, url: '/uploads/' + encodeURIComponent(name), abs: dest });
    }

    if (p === '/api/context' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}');
      const { text, source } = body;
      if (!text) return json(res, 400, { error: '缺内容' });
      const file = path.join(registry.contextDir, 'notes.jsonl');
      await fs.mkdir(registry.contextDir, { recursive: true });
      await fs.appendFile(file, JSON.stringify({ t: text, s: source || '财务', ts: Date.now() }) + '\n', 'utf8');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/context' && req.method === 'GET') {
      const file = path.join(registry.contextDir, 'notes.jsonl');
      let notes = [];
      try {
        const raw = await fs.readFile(file, 'utf8');
        notes = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      return json(res, 200, { notes });
    }

    // 静态文件
    let rel = p === '/' ? '/index.html' : p;
    rel = rel.replace(/\.\./g, '');
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
      });
      return res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent-deck] listening on 127.0.0.1:${PORT}`);
});

const shutdown = async () => {
  await pool.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
