/**
 * 编排引擎
 *
 * 【设计意图】(设计约定)
 *   每个 agent 的身份和定义由运营动态调整;
 *   每个 agent 都看得见全队名册,知道自己和另外两位各擅长什么;
 *   派活由牵头 agent 读名册自己决定,网关只校验和执行,不拍脑袋。
 *
 * 三个模式:
 *   单干            → 网关按身份卡匹配挑一个(依据可见,可手动换)
 *   一起干·我分工    → 用户明确指定谁做什么,网关按指定顺序执行(每步都带名册)
 *   一起干·有人牵头  → 牵头 agent 读名册出计划 → 网关校验 → 执行 → 结果回牵头收口
 *
 * 分配依据(全部来自身份卡,不硬编码):
 *   1. 用户点名(句子里出现 agent 名/别名)→ 直接归它
 *   2. 身份卡里的 name/role/擅长词与需求文本求交集 → 命中最多的接管
 *   3. 身份卡里的「不做」命中 → 直接排除该 agent
 *   4. 平手 → Antigravity(工具面最全)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { compileIdentity, compileRoster } from './roster.mjs';

const ALIAS = {
  antigravity: ['antigravity', 'agy', 'google', 'gemini', '算账那套', '算账的', '算数那套', '谷歌那套'],
  kimi: ['kimi', 'ki', '月之暗面', '长文那套', '长文的', 'kimi那套'],
  minimax: ['minimax', 'mm', 'mini max', '跑批那套', '跑批的', '批量那套'],
};

const MAX_STEPS = 6;

export class Orchestrator {
  constructor(registry, pool, cardStore) {
    this.registry = registry;
    this.pool = pool;
    this.cards = cardStore;
    this.agentIds = registry.agents.map((a) => a.id);
  }

  agent(id) { return this.registry.agents.find((a) => a.id === id); }

  /* ---------- 身份卡 ---------- */

  async allCards() { return this.cards.readAll(this.agentIds); }

  /**
   * 用身份卡里的 name / role / 擅长词去和需求文本求交集。
   * 分三级匹配,越精确权重越高:
   *   3 = 整词命中("台账汇总" 里有 "台账汇总")
   *   2 = 拆连接词后命中("逐条核对与差异清单" → "逐条核对" / "差异清单")
   *   1 = 前缀命中("台账汇总" → "台账")
   * 早期版本只认整词,结果「把台账逐条核对一遍」派不到擅长台账的 agent —— 已修。
   */
  _match(text, card) {
    const t = String(text || '').toLowerCase();
    const hits = [];
    const terms = [];
    if (card?.name) terms.push(card.name);
    if (card?.role) terms.push(...String(card.role).split(/[、,。;；/]+/));
    for (const s of card?.strengths || []) terms.push(String(s));
    for (const raw of terms) {
      const term = String(raw || '').trim();
      if (term.length < 2) continue;
      const lower = term.toLowerCase();
      if (t.includes(lower)) { hits.push({ term, w: 3 }); continue; }
      // 拆连接词
      const subs = term.split(/[、,。;；/与和及]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
      const sub = subs.find((x) => t.includes(x.toLowerCase()));
      if (sub) { hits.push({ term: sub, w: 2 }); continue; }
      // 前缀(从长到短)
      let pre = null;
      for (let n = Math.min(lower.length, 10); n >= 2; n--) {
        const p = lower.slice(0, n);
        if (t.includes(p)) { pre = p; break; }
      }
      if (pre) hits.push({ term: pre, w: 1 });
    }
    return hits;
  }

  /** 「不做」命中 → 该 agent 不适合这个活(整词或拆连接词后命中才算) */
  _avoided(text, card) {
    const t = String(text || '').toLowerCase();
    const hits = [];
    for (const raw of card?.avoid || []) {
      const term = String(raw || '').trim();
      if (term.length < 2) continue;
      const lower = term.toLowerCase();
      if (t.includes(lower)) { hits.push(term); continue; }
      const subs = term.split(/[、,。;；/与和及]+/).map((x) => x.trim()).filter((x) => x.length >= 3);
      const sub = subs.find((x) => t.includes(x.toLowerCase()));
      if (sub) hits.push(sub);
    }
    return hits;
  }

  /* ---------- 解析自然语言编排 ---------- */

  namedAgents(text) {
    const lower = String(text || '').toLowerCase();
    const hits = [];
    for (const a of this.registry.agents) {
      const names = [a.name.toLowerCase(), ...(ALIAS[a.id] || [])];
      let best = null;
      for (const n of names) {
        if (!n) continue;
        const pos = lower.indexOf(n);
        if (pos >= 0 && (best === null || pos < best.pos)) best = { pos, alias: n };
      }
      if (best) hits.push({ agentId: a.id, alias: best.alias, pos: best.pos });
    }
    return hits.sort((x, y) => x.pos - y.pos);
  }

  async parse(text, hint = {}) {
    const t = (text || '').trim();
    const named = this.namedAgents(t);
    const leadWord = /牵头|主导|带头|统筹|拆解|拆一下/.test(t);
    const teamWord = /一起干|都来|分工|多个|团队|分别/.test(t);
    const singleWord = /一个人|单干|我自己|别分工/.test(t);

    /* 1. 界面里手动指定过 → 优先按界面 */
    if (hint.scope === 'single') {
      const picked = hint.who
        ? { agentId: hint.who, basis: '手动指定了执行器' }
        : await this.pickAgent(t, hint);
      return { scope: 'single', mode: 'single', who: picked.agentId, basis: picked.basis, crew: [], boss: null };
    }
    if (hint.scope === 'team') {
      if (hint.mode === 'lead') {
        const boss = hint.boss
          ? { agentId: hint.boss, basis: '手动指定了牵头人' }
          : await this.pickAgent(t, hint);
        return { scope: 'team', mode: 'lead', who: null, basis: boss.basis, crew: [], boss: boss.agentId };
      }
      const crew = (hint.crew || []).map((c) => ({
        agentId: c.agentId, task: c.task || '', basis: '手动分工',
      }));
      if (crew.length) return { scope: 'team', mode: 'manual', who: null, basis: '手动分工', crew, boss: null };
    }

    /* 2. 自然语言:有人牵头 */
    if (leadWord) {
      const boss = named.length
        ? { agentId: named[0].agentId, basis: `点名了 ${named[0].alias} 牵头` }
        : await this.pickAgent(t, hint);
      return { scope: 'team', mode: 'lead', who: null, basis: boss.basis, crew: [], boss: boss.agentId };
    }

    /* 3. 自然语言:点名了两个及以上 → 我分工 */
    if ((named.length >= 2 || teamWord) && !singleWord) {
      const parts = t
        .split(/[,,、;;\n]|然后|接着|再让|以及/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1);
      const chunks = parts.length > 1 ? parts : [t];

      const cards = await this.allCards();
      const crew = [];
      for (const seg of chunks) {
        const hit = this.namedAgents(seg);
        let agentId;
        if (hit.length) {
          agentId = hit[0].agentId;
        } else {
          const near = this._nearestNamed(t, seg);
          agentId = near || (await this.pickAgent(seg, hint)).agentId;
        }
        const last = crew[crew.length - 1];
        if (last && last.agentId === agentId) last.task += ';' + seg;
        else crew.push({ agentId, task: seg, basis: `需求点名了 ${this.agent(agentId).name}` });
      }
      if (crew.length === 1) {
        const picked = await this.pickAgent(t, hint);
        return { scope: 'single', mode: 'single', who: picked.agentId, basis: picked.basis, crew: [], boss: null };
      }
      return {
        scope: 'team', mode: 'manual', who: null,
        basis: crew.map((c) => `${this.agent(c.agentId).name}:${c.task.slice(0, 18)}`).join(' → '),
        crew, boss: null,
      };
    }

    /* 4. 单干 */
    const picked = await this.pickAgent(t, hint);
    return { scope: 'single', mode: 'single', who: picked.agentId, basis: picked.basis, crew: [], boss: null };
  }

  _nearestNamed(fullText, seg) {
    const idx = fullText.indexOf(seg);
    if (idx < 0) return null;
    const hits = this.namedAgents(fullText.slice(0, idx));
    return hits.length ? hits[hits.length - 1].agentId : null;
  }

  /** 挑 agent 并给出理由(依据全部来自身份卡) */
  async pickAgent(text, hint = {}) {
    const lower = String(text || '').toLowerCase();

    // 1. 点名
    for (const a of this.registry.agents) {
      const names = [a.name.toLowerCase(), ...(ALIAS[a.id] || [])];
      for (const n of names) {
        if (n && lower.includes(n)) {
          return { agentId: a.id, basis: `需求里点名了 ${a.name}`, score: 999, named: true };
        }
      }
    }

    const cards = await this.allCards();

    // 2. 身份卡「不做」命中 → 排除
    const scores = [];
    for (const a of this.registry.agents) {
      const av = this._avoided(text, cards[a.id]);
      const hits = av.length ? [] : this._match(text, cards[a.id]);
      const score = hits.reduce((n, h) => n + h.w, 0);
      scores.push({ a, hits, av, score });
    }
    scores.sort((x, y) => y.score - x.score);
    const top = scores[0];

    if (top && top.score > 0) {
      const tied = scores.slice(1).filter((s) => s.score === top.score).map((s) => s.a.name);
      const basis = `匹配「${cards[top.a.id]?.name || top.a.name}」身份卡里的擅长:${top.hits.slice(0, 3).map((h) => h.term).join('、')}` +
        (tied.length ? `(与 ${tied.join('、')} 接近,按默认序取前者)` : '');
      return { agentId: top.a.id, basis, score: top.score, named: false };
    }

    // 3. 兜底
    const fallback = this.agent(hint.preferAgent || 'antigravity') || this.registry.agents[0];
    return {
      agentId: fallback.id,
      basis: `需求没有明显特征,交给工具面最全的 ${fallback.name} 处理`,
      score: 0, named: false,
    };
  }

  /* ---------- 身份注入 ---------- */

  /** 给某个 agent 编译「自己的身份 + 团队名册」 */
  async identityFor(agentId) {
    const cards = await this.allCards();
    return compileIdentity(cards, this.agentIds, agentId);
  }

  async rosterFor(agentId) {
    const cards = await this.allCards();
    return compileRoster(cards, this.agentIds, agentId);
  }

  /* ---------- 执行 ---------- */

  /**
   * 挑这次真正相关的约定。
   * 原来是无脑把全部规则塞进 prompt(12 条),用户说句"写段文案"也被糊一脸 —— 已修。
   * 规则:
   *   1. 需求命中某来源的触发词 → 该来源的规则整组带上
   *   2. 需求直接包含某条规则里的关键词 → 那一条单独带上
   *   3. 最多 6 条,一条都不相关就一条都不带
   */
  _relevantCtx(text, ctxTags) {
    const req = String(text || '').toLowerCase();
    if (!req || !ctxTags || !ctxTags.length) return [];
    const triggers = this.registry.contextTriggers || {};
    const hits = new Set();
    for (const [src, words] of Object.entries(triggers)) {
      if (words.some((w) => req.includes(String(w).toLowerCase()))) hits.add(src);
    }
    const out = [];
    const perSource = new Map();   // 每个来源最多带 2 条
    for (const raw of ctxTags) {
      const src = this._ctxOf(raw);
      const body = this._ctxBody(raw);
      const byWord = this._ctxWordHit(req, body);
      const bySource = hits.size && src && hits.has(src);
      if (!byWord && !bySource) continue;
      if (bySource && !byWord) {
        // 只靠来源沾边的:同一来源最多再带 2 条,别把整组都糊上来
        const n = perSource.get(src) || 0;
        if (n >= 2) continue;
        perSource.set(src, n + 1);
      }
      out.push(body);
      if (out.length >= 4) break;
    }
    return out;
  }

  /** ctxTags 格式: "来源\u0000规则正文" */
  _ctxOf(raw) {
    const i = String(raw).indexOf('\u0000');
    return i >= 0 ? String(raw).slice(0, i) : '';
  }
  _ctxBody(raw) {
    const i = String(raw).indexOf('\u0000');
    return i >= 0 ? String(raw).slice(i + 1) : String(raw);
  }

  /** 规则正文里的短语(≥3 字)出现在需求里就算命中 */
  _ctxWordHit(req, body) {
    const parts = String(body).split(/[、,。;；:：()（）「」“”"']+/).map((x) => x.trim()).filter((x) => x.length >= 3);
    return parts.some((p) => req.includes(p.toLowerCase()));
  }

  async run({ text, plan, uploadPaths = [], ctxTags = [] }, emit, opts = {}) {
    const started = Date.now();
    const rel = this._relevantCtx(text, ctxTags);
    const contextBrief = rel.length ? `\n\n【本次适用的约定】\n${rel.map((t) => '· ' + t).join('\n')}` : '';

    if (!plan || !plan.scope) plan = await this.parse(text);

    if (plan.scope === 'single') {
      const r = await this._runOne(this.agent(plan.who), text + contextBrief, plan.basis, emit, plan, { signal: opts.signal, ctxUsed: rel });
      return {
        status: r.error ? 'error' : 'success',
        durationMs: Date.now() - started,
        results: [r],
        artifacts: await this.collectArtifacts(started, r.agentId),
      };
    }

    if (plan.mode === 'lead') {
      return this._runLead(this.agent(plan.boss), text, contextBrief, uploadPaths, emit, plan, started, { ...opts, rel });
    }

    /* 我分工:按用户指定顺序接力 */
    let carry = '';
    const results = [];
    for (const member of plan.crew) {
      const a = this.agent(member.agentId);
      const task =
        `${member.task}${contextBrief}\n\n` +
        (carry ? `上一环节(${results[results.length - 1]?.agentName || ''})的产出,请直接沿用:\n${carry}\n\n` : '') +
        (uploadPaths.length ? `可用输入文件:\n${uploadPaths.map((p) => '· ' + p).join('\n')}\n\n` : '') +
        `最终产出请存到 /home/ubuntu/outputs/,文件名带完整业务要素。`;
      const r = await this._runOne(a, task, member.basis, emit, plan, { signal: opts.signal, ctxUsed: rel });
      results.push(r);
      carry = (r.text || '').slice(0, 4000);
      if (r.error) break;
    }
    return {
      status: results.some((r) => r.error) ? 'partial' : 'success',
      durationMs: Date.now() - started,
      results,
      artifacts: await this.collectArtifacts(started, results.length ? results[results.length - 1].agentId : null),
    };
  }

  /**
   * 有人牵头:三段式
   *   ① 牵头 agent 读名册出计划
   *   ② 网关校验后按计划执行
   *   ③ 结果回牵头,由它汇总收口
   */
  async _runLead(boss, text, contextBrief, uploadPaths, emit, plan, started, opts = {}) {
    const cards = await this.allCards();
    const roster = compileRoster(cards, this.agentIds, boss.id);
    // rel 由 run() 算好传进来。2026-10-23 修:这里原来直接用 rel,
    // 但 rel 是 run() 的局部变量 → ReferenceError "rel is not defined",
    // 导致「有人牵头」模式从上线起 100% 失败(所有 lead_plan 事件都没产出过)。
    const rel = opts.rel || [];

    /* ① 出计划 */
    const planPrompt =
      `${text}${contextBrief}\n\n` +
      `===== 你的团队名册 =====\n${roster}\n\n` +
      `请把上面这件事拆成步骤,并把每一步分给团队里**最擅长**的那位。\n` +
      `规则:\n` +
      `- agent 只能填:${this.agentIds.join(' / ')}\n` +
      `- 步骤不超过 ${MAX_STEPS} 个,能合并就合并\n` +
      `- needs 填前置步骤的序号(从 0 开始),没有前置就填 []\n` +
      `- 你自己能做好的,不必分给别人\n` +
      `- task 写清楚这一步具体要产出什么\n` +
      `只输出 JSON,不要任何解释文字:\n` +
      `{"reason":"一句话说明为什么这么分","steps":[{"agent":"...","task":"...","needs":[]}]}`;

    const p = await this._runOne(boss, planPrompt, '牵头人读团队名册后自行分工', emit, plan, { phase: 'plan', effort: 'low', signal: opts.signal, ctxUsed: rel });
    if (p.error) {
      return { status: 'error', durationMs: Date.now() - started, results: [p], artifacts: [] };
    }

    const parsed = this._parsePlanJson(p.text);
    if (!parsed || !parsed.steps?.length) {
      emit({ type: 'notice', agent: boss.id, notice: '牵头人没给出可执行的分步计划,已按原需求交回牵头人自己完成' });
      const solo = await this._runOne(boss, `${text}${contextBrief}`, '牵头人未产出计划,自行完成', emit, plan, { phase: 'solo', ctxUsed: rel });
      return {
        status: solo.error ? 'error' : 'success',
        durationMs: Date.now() - started,
        results: [p, solo],
        artifacts: await this.collectArtifacts(started, boss.id),
      };
    }

    const steps = this._validateSteps(parsed.steps);
    emit({
      type: 'lead_plan',
      agent: boss.id,
      reason: parsed.reason || '',
      steps: steps.map((s, i) => ({ index: i, agent: s.agent, task: s.task, needs: s.needs })),
    });

    /* ② 执行 */
    const results = [];
    const outputs = [];
    for (const step of steps) {
      const a = this.agent(step.agent);
      if (!a) continue;
      const deps = (step.needs || []).map((n) => outputs[n]).filter(Boolean);
      const task =
        `【这一步的任务】${step.task}\n\n` +
        (deps.length ? `【前序步骤的产出,请直接沿用】\n${deps.join('\n\n---\n\n')}\n\n` : '') +
        (uploadPaths.length ? `【可用输入文件】\n${uploadPaths.map((p) => '· ' + p).join('\n')}\n\n` : '') +
        `完成后把这一段的产出讲清楚,最终交付物存到 /home/ubuntu/outputs/,文件名带全业务要素。`;
      const r = await this._runOne(a, task, `牵头人把它分给了 ${a.name}`, emit, plan, { signal: opts.signal });
      results.push(r);
      const failed = [];
      if (r.error) {
        /* 某一步挂了(比如额度用完)不该让整条链断掉:记录下来,继续下一步 */
        failed.push(`步骤 ${results.length - 1}(${a.name})失败:${r.error}`);
        outputs.push(`[步骤 ${results.length - 1} · ${a.name}]\n(这一步没能完成:${r.error})`);
        emit({ type: 'notice', agent: a.id, notice: `${a.name} 这一步没做完(${r.error}),已跳过,继续后面的步骤` });
      } else {
        outputs.push(`[步骤 ${results.length - 1} · ${a.name}]\n${r.text}`);
      }
    }

    /* ③ 收口 */
    let final = null;
    const failed = results.filter((r) => r.error);
    if (!failed.length) {
      const closePrompt =
        `各步骤都已完成,下面是结果:\n\n${outputs.join('\n\n=====\n\n')}\n\n` +
        `请汇总、核对口径一致性,给出最终交付说明。` +
        `最终交付物必须在 /home/ubuntu/outputs/ 下,并在回复里给出直链。`;
      final = await this._runOne(boss, closePrompt, '牵头人汇总收口', emit, plan, { phase: 'close', signal: opts.signal });
      results.push(final);
    } else {
      emit({ type: 'notice', agent: boss.id, notice: `${failed.length} 个步骤没做完,由牵头人接手收尾` });
      const closePrompt =
        `下面是各步骤的完成情况:\n\n${outputs.join('\n\n=====\n\n')}\n\n` +
        `有步骤没能完成。请你接手,用现有材料给出能给的最终结果,并说明哪部分没做完。` +
        `能交付的交付物必须放在 /home/ubuntu/outputs/ 下,并给出直链。`;
      final = await this._runOne(boss, closePrompt, '牵头人接手收尾', emit, plan, { phase: 'close', signal: opts.signal });
      results.push(final);
    }

    return {
      status: results.some((r) => r.error) ? 'partial' : 'success',
      durationMs: Date.now() - started,
      results,
      plan: { reason: parsed.reason || '', steps: steps.map((s, i) => ({ index: i, agent: s.agent, task: s.task })) },
      artifacts: await this.collectArtifacts(started, boss.id),
    };
  }

  _parsePlanJson(text) {
    const s = String(text || '');
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
    const candidates = [];
    if (fence) candidates.push(fence[1]);
    const brace = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
    if (brace.length > 2) candidates.push(brace);
    for (const c of candidates) {
      try {
        const o = JSON.parse(c.trim());
        if (o && Array.isArray(o.steps)) return o;
      } catch {}
    }
    return null;
  }

  _validateSteps(steps) {
    const out = [];
    for (const s of steps.slice(0, MAX_STEPS)) {
      const agent = String(s.agent || '').trim();
      if (!this.agentIds.includes(agent)) continue;
      const task = String(s.task || '').trim();
      if (!task) continue;
      const needs = Array.isArray(s.needs)
        ? s.needs.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < out.length)
        : [];
      out.push({ agent, task, needs: [...new Set(needs)] });
    }
    // 环检测:若 needs 指到自己或后边,直接去掉
    for (let i = 0; i < out.length; i++) {
      out[i].needs = out[i].needs.filter((n) => n < i);
    }
    return out;
  }

  async _runOne(agent, promptText, basis, emit, plan, opts = {}) {
    const r = await this._runOneInner(agent, promptText, basis, emit, plan, opts);
    /* ACP 常驻进程可能自己退出(mcode 就会 code=0 退出),重试一次 */
    if (r.error && /agent exited/.test(r.error) && !opts._retried) {
      console.warn(`[orch] ${agent.name} 的会话中途退出,重建后重试一次`);
      this.pool.markDirty(agent.id);
      emit({ type: 'notice', agent: agent.id, notice: `${agent.name} 会话中断,正在重试` });
      return this._runOne(agent, promptText, basis, emit, plan, { ...opts, _retried: true });
    }
    return r;
  }

  async _runOneInner(agent, promptText, basis, emit, plan, opts = {}) {
    const agentId = agent.id;
    emit({
      type: 'agent_start',
      agent: agentId,
      agentName: agent.name,
      /* 约定单独走 ctxUsed 字段(前端折叠成 chip),这里别重复摊开 */
      task: promptText.split('\n\n【本次适用的约定】')[0].slice(0, 300),
      basis: basis || plan?.basis || '',
      phase: opts.phase || null,
      ctxUsed: opts.ctxUsed || [],
    });

    const cards = await this.allCards();
    const identity = compileIdentity(cards, this.agentIds, agentId);
    const cardName = cards[agentId]?.name || agent.name;

    let handle;
    try {
      handle = await this.pool.acquire(agentId, { identityText: identity, agentName: cardName });
    } catch (e) {
      emit({ type: 'error', agent: agentId, message: e.message });
      return { agentId, agentName: agent.name, error: e.message, text: '' };
    }

    const { runner, release } = handle;
    const ac = new AbortController();
    let acc = '';
    /* 外部 signal(客户端断开)→ 一并中止 */
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    const onText = (d) => { acc += d.text; emit({ type: 'text', agent: agentId, text: d.text }); };
    const onThought = (d) => emit({ type: 'thought', agent: agentId, text: d.text });
    const onTool = (d) => emit({ type: 'tool', agent: agentId, tool: d });
    const onNotice = (d) => { if (d?.notice) emit({ type: 'notice', agent: agentId, notice: d.notice }); };
    const onError = (d) => emit({ type: 'error', agent: agentId, message: d.message });

    runner.on('text', onText);
    runner.on('thought', onThought);
    runner.on('tool', onTool);
    runner.on('notice', onNotice);
    runner.on('error', onError);

    /* Kimi 的 ACP 没有原生身份注入口,靠 prompt 前置兜底 */
    const finalPrompt = agentId === 'kimi'
      ? `===== 你的身份与团队名册 =====\n${identity}\n\n===== 本次任务 =====\n${promptText}`
      : promptText;

    /* 落盘最后一次实际发出的 prompt:能直接检查身份/名册有没有真的注入 */
    try {
      const pdir = path.join(path.resolve(this.registry.contextDir, '..'), 'runtime', 'prompts');
      await fs.mkdir(pdir, { recursive: true });
      await fs.writeFile(path.join(pdir, `${agentId}.md`), finalPrompt, 'utf8');
    } catch {}

    let error = null;
    try {
      await runner.prompt(finalPrompt, { signal: ac.signal, effort: opts.effort || null });
    } catch (e) {
      error = String(e.message || e);
      console.error(`[orch] ${agent.name} 执行失败: ${error}`);
      emit({ type: 'error', agent: agentId, message: error });
    } finally {
      runner.off?.('text', onText);
      runner.off?.('thought', onThought);
      runner.off?.('tool', onTool);
      runner.off?.('notice', onNotice);
      runner.off?.('error', onError);
      release();
    }

    const text = acc.trim();
    /* 没报错但一个字都没有 → 大概率是配额/限流/被拒,要说清楚,不能静默 */
    if (!error && !text) {
      const hint = `${agent.name} 没有返回任何内容(可能是额度用尽、限流或会话被拒)`;
      console.warn(`[orch] ${hint}`);
      emit({ type: 'notice', agent: agentId, notice: hint });
      error = '没有返回任何内容(可能是额度用尽或限流)';
    }
    emit({
      type: 'agent_done', agent: agentId, agentName: agent.name,
      text: text.slice(0, 4000), error, phase: opts.phase || null,
    });
    return { agentId, agentName: agent.name, text, error, phase: opts.phase || null };
  }

  /** 收集本次跑出来的新产出物 */
  async collectArtifacts(sinceMs, byAgentId = null) {
    const dir = this.registry.outputs;
    const out = [];
    let names = [];
    try { names = await fs.readdir(dir); } catch { return out; }
    for (const n of names) {
      if (n === 'assets') continue;
      try {
        const st = await fs.stat(path.join(dir, n));
        if (st.mtimeMs >= sinceMs - 5000) {
          out.push({
            name: n, size: st.size, mtime: st.mtimeMs,
            path: '/outputs/' + encodeURIComponent(n),
            url: '/outputs/' + encodeURIComponent(n),
            by: byAgentId,
          });
        }
      } catch {}
    }
    return out;
  }
}
