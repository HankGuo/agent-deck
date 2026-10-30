/**
 * 身份卡 + 团队名册
 *
 * 设计意图(设计约定):
 *   每个 agent 的身份和定义是【运营可动态调整】的。
 *   每个 agent 都看得见【全队名册】——知道自己擅长什么、另外两位擅长什么、谁不干什么。
 *   派活由牵头 agent 读名册自己决定,网关只校验和执行,不拍脑袋。
 *
 * 存储:agents/<agentId>.md
 *   --- frontmatter(极简 YAML 子集)---
 *   name: 账龄分析师
 *   role: 应收账龄计算、坏账核销
 *   strengths:
 *     - 账龄测算
 *   avoid:
 *     - 对外文案
 *   --- 结束 ---
 *   正文(可选,给 agent 的补充说明)
 *
 * 注入方式按各家原生机制分层:
 *   MiniMax  → --system-prompt-file(真 system prompt)
 *   Antigravity → --agent <name> + .agents/agents/<name>.md(原生 agent 定义)
 *   Kimi    → prompt 前置块(ACP 无原生口,见 AGENTS.md 踩坑记录)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------- 极简 frontmatter 解析 ---------- */

export function parseCard(raw) {
  const text = String(raw || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text;
  if (m) {
    body = m[2].trim();
    const lines = m[1].split(/\r?\n/);
    let curKey = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item && curKey) {
        (meta[curKey] = meta[curKey] || []).push(item[1].trim());
        continue;
      }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      curKey = kv[1];
      const v = kv[2].trim();
      if (v === '') {
        meta[curKey] = [];
      } else {
        // 逗号分隔也认,方便手写
        meta[curKey] = v.includes(',') && v.includes(' ') ? v.split(',').map((s) => s.trim()) : v;
      }
    }
  }
  const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [String(v)] : []);
  return {
    name: (meta.name && String(meta.name)) || '',
    role: (meta.role && String(meta.role)) || '',
    strengths: asArray(meta.strengths),
    avoid: asArray(meta.avoid),
    notes: body,
  };
}

export function renderCard(card) {
  const fm = [];
  fm.push('---');
  fm.push(`name: ${card.name || ''}`);
  fm.push(`role: ${card.role || ''}`);
  fm.push('strengths:');
  for (const s of card.strengths || []) fm.push(`  - ${s}`);
  fm.push('avoid:');
  for (const a of card.avoid || []) fm.push(`  - ${a}`);
  fm.push('---');
  fm.push('');
  fm.push(card.notes || '');
  fm.push('');
  return fm.join('\n');
}

/* ---------- 身份卡存取 ---------- */

export class CardStore {
  constructor(dir, defaults) {
    this.dir = dir;
    this.defaults = defaults;   // agentId -> 初始身份卡(来自 registry)
  }

  path(id) { return path.join(this.dir, `${id}.md`); }

  async read(id) {
    try {
      const raw = await fs.readFile(this.path(id), 'utf8');
      const c = parseCard(raw);
      if (!c.name) c.name = this.defaults[id]?.name || '';
      if (!c.role) c.role = this.defaults[id]?.role || '';
      if (!c.strengths.length) c.strengths = this.defaults[id]?.strengths || [];
      if (!c.avoid.length) c.avoid = this.defaults[id]?.avoid || [];
      // 坏卡自愈:如果 name 等于 agentId,那是"空卡被兜底写成 id"的痕迹
      // (2026-10-23 实际发生过,会把 "Kimi Code" 显示成 "kimi" 且丢掉 strengths)
      if (c.name === id && this.defaults[id]?.name) {
        return { ...this.defaults[id], notes: c.notes || this.defaults[id].notes || '' };
      }
      return c;
    } catch {
      return this.defaults[id] || { name: '', role: '', strengths: [], avoid: [], notes: '' };
    }
  }

  async readAll(agentIds) {
    const out = {};
    for (const id of agentIds) out[id] = await this.read(id);
    return out;
  }

  async write(id, card) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.path(id), renderCard(card), 'utf8');
  }

  /** 把默认身份卡落盘(首次启动时) */
  async seed(agentIds) {
    await fs.mkdir(this.dir, { recursive: true });
    for (const id of agentIds) {
      try { await fs.access(this.path(id)); }
      catch {
        const d = this.defaults[id];
        if (d) await this.write(id, d);
      }
    }
  }
}

/* ---------- 名册编译 ---------- */

/**
 * 把三张身份卡编译成一份「团队名册」文本。
 * selfId: 当前这个 agent 是谁(名册里要标出来"你自己")
 * hints : { agentId: {score, hits} } 网关算的关键词倾向(可推翻,只作参考)
 */
export function compileRoster(cards, agentIds, selfId, hints = {}) {
  const lines = [];
  lines.push('# 团队名册');
  lines.push('');
  lines.push('你是一个团队成员。下面是你所在团队每个成员的定位。');
  lines.push('**派活、拆步骤、决定谁做什么的时候,以这份名册为准。**');
  lines.push('如果你自己更擅长某件事,就直接接;不要把不擅长的活硬揽下来。');
  lines.push('');

  for (const id of agentIds) {
    const c = cards[id] || {};
    const isSelf = id === selfId;
    lines.push(`## ${c.name || id}${isSelf ? '(就是你自己)' : ''}`);
    if (c.role) lines.push(`- 定位:${c.role}`);
    if (c.strengths && c.strengths.length) lines.push(`- 擅长:${c.strengths.join('、')}`);
    if (c.avoid && c.avoid.length) lines.push(`- 不做:${c.avoid.join('、')}`);
    const h = hints[id];
    if (h && h.hits && h.hits.length) {
      lines.push(`- 本次需求里和它匹配的能力词:${h.hits.join('、')}(仅作参考,可以不采纳)`);
    }
    if (c.notes) {
      lines.push('');
      lines.push(c.notes.split('\n').map((l) => '  ' + l).join('\n'));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 给某个 agent 编译「它自己的身份卡 + 团队名册」,用作 system prompt / agent 定义。
 */
export function compileIdentity(cards, agentIds, selfId, hints = {}) {
  const c = cards[selfId] || {};
  const own = [];
  own.push('# 你的身份');
  own.push('');
  own.push(`你是「${c.name || selfId}」。`);
  if (c.role) own.push(`你的定位是:${c.role}`);
  if (c.strengths && c.strengths.length) own.push(`你擅长:${c.strengths.join('、')}。`);
  if (c.avoid && c.avoid.length) own.push(`你不做:${c.avoid.join('、')}。`);
  if (c.notes) { own.push(''); own.push(c.notes); }
  own.push('');
  return own.join('\n') + '\n' + compileRoster(cards, agentIds, selfId, hints);
}

/**
 * Antigravity 专用:原生 agent 定义格式(必须带 frontmatter,name 用来被 --agent 选中)。
 * 注意:Antigravity 是按 frontmatter 的 name 选 agent,不是文件名。
 */
export function compileAgentFile(cards, agentIds, selfId) {
  const c = cards[selfId] || {};
  const fm = [];
  fm.push('---');
  // name 必须是「全小写 + 连字符」才算合法(大写会被 agent 加载器跳过),
  // 所以技术 id 固定用 id,用户自定义的名字放在正文里由 agent 自报。
  fm.push(`name: ${selfId}`);
  fm.push(`description: ${c.role || (c.strengths || []).join('、') || selfId}`);
  fm.push('---');
  fm.push('');
  const body = compileIdentity(cards, agentIds, selfId);
  fm.push(body);
  fm.push('');
  return fm.join('\n');
}
