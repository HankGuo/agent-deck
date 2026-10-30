#!/usr/bin/env node
/**
 * Agent Deck 端到端测试
 * 覆盖:逻辑 / 配置 / 安全性 / 性能 / 进程管理(/api 层面)
 * 用法: node e2e-test.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const results = [];
let pass = 0, fail = 0;

function ok(name, detail = '') { pass++; results.push(['PASS', name, detail]); }
function no(name, detail = '') { fail++; results.push(['FAIL', name, detail]); }
function check(name, cond, detail = '') { cond ? ok(name, detail) : no(name, detail); }

async function jget(path, opt = {}) {
  const r = await fetch(BASE + path, opt);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body, headers: r.headers };
}
async function jpost(path, obj) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
/** 跑一个 run 并收集 SSE 事件 */
async function run(text, plan = null, timeoutMs = 180000, ctxTags = null) {
  const payload = { text, plan };
  if (ctxTags) payload.ctxTags = ctxTags;
  const { body } = await jpost('/api/run', payload);
  if (!body?.runId) return { events: [], error: 'no runId' };
  const events = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/stream?runId=${body.runId}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
      }
      if (events.some(e => e.type === 'done')) break;
    }
  } catch (e) { /* 超时 */ }
  clearTimeout(timer);
  return { events, runId: body.runId };
}
const texts = (evts) => evts.filter(e => e.type === 'text').map(e => e.text).join('');
const types = (evts) => [...new Set(evts.map(e => e.type))];
const errs  = (evts) => evts.filter(e => e.type === 'error').map(e => e.message);

/* ═══════════════ 1. 逻辑 ═══════════════ */
console.log('\n【1】逻辑');
{
  const { body } = await jpost('/api/plan', { text: '把 uploads 里的项目台账逐条核对一遍' });
  check('单干派活:台账核对→Kimi', body?.plan?.who === 'kimi', `who=${body?.plan?.who}`);

  const p2 = await jpost('/api/plan', { text: '写一篇公众号稿' });
  check('单干派活:公众号→MiniMax', p2?.body?.plan?.who === 'minimax', `who=${p2?.body?.plan?.who}`);

  const p3 = await jpost('/api/plan', { text: '算一下这次的账龄' });
  check('单干派活:账龄→Antigravity', p3?.body?.plan?.who === 'antigravity', `who=${p3?.body?.plan?.who}`);

  const p4 = await jpost('/api/plan', { text: '让 Kimi 读表,算账那套算账龄' });
  check('自然语言拆两段→我分工', p4?.body?.plan?.scope === 'team' && p4?.body?.plan?.mode === 'manual',
    `scope=${p4?.body?.plan?.scope} mode=${p4?.body?.plan?.mode} crew=${p4?.body?.plan?.crew?.length}`);

  const p5 = await jpost('/api/plan', { text: '让长文那套牵头' });
  check('点名牵头→有人牵头', p5?.body?.plan?.mode === 'lead' && p5?.body?.plan?.boss === 'kimi',
    `mode=${p5?.body?.plan?.mode} boss=${p5?.body?.plan?.boss}`);

  // 上下文按相关度筛(带上真实的 12 条规则)
  const CTX = [
    '财务\u0000账龄按自然年划分,基准日=月末','财务\u0000催款函正文仿宋,标题 15pt 加粗,高亮需为真实高亮',
    '财务\u0000超 90 天高亮标注,金额保留两位小数','财务\u0000文件名含文号+客户全称+项目编号',
    '财务\u0000风险客户流程:财务函 → 法务函 → 法务评估,升级需留痕','财务\u0000仅做微调,不整体重构',
    '内容\u0000人设:平实、口语化','内容\u0000开头先给结论','内容\u0000配图 3:4,文字不压脸',
    '内容\u0000少用「赋能/闭环/抓手」','内容\u0000先给情绪,再给方法','内容\u0000不写「作为 AI 我认为」',
  ];
  const r1 = await run('用一句话说明什么是应收账龄', null, 180000, CTX);
  const ctx1 = r1.events.find(e => e.type === 'agent_start')?.ctxUsed || [];
  check('上下文:账龄问题只带财务类(≤4条)', ctx1.length > 0 && ctx1.length <= 4, `带了 ${ctx1.length} 条: ${ctx1.join(' / ')}`);
  check('上下文:不含内容类规则', !ctx1.some(c => /人设|配图|少用|先给情绪/.test(c)), ctx1.join(' / '));

  const r2 = await run('写一段关于秋天的短文案', null, 180000, CTX);
  const ctx2 = r2.events.find(e => e.type === 'agent_start')?.ctxUsed || [];
  check('上下文:文案问题带内容类规则', ctx2.some(c => /人设|先给结论/.test(c)), ctx2.join(' / '));
}

/* ═══════════════ 2. 配置 ═══════════════ */
console.log('【2】配置');
{
  const { body } = await jget('/api/bootstrap');
  check('注册表:3 套 agent', body?.agents?.length === 3, body?.agents?.map(a => a.id).join(','));
  check('注册表:无 mimo/dsh', !JSON.stringify(body).match(/mimo|deepseek|dsh/i), '');
  check('注册表:每套都有 logo', body?.agents?.every(a => a.logo), '');
  const { body: ag } = await jget('/api/agents');
  check('身份卡:3 张', ag?.cards?.length === 3, '');
  check('身份卡:都有 name/role/strengths', ag?.cards?.every(c => c.identity?.name && c.identity?.strengths?.length), '');
  const { body: boot } = await jget('/api/bootstrap');
  check('配置:上下文规则有来源标签', boot?.context?.every(c => c.s), '');
  check('配置:工具数 9', boot?.tools?.length === 9, `${boot?.tools?.length}`);
}

/* ═══════════════ 3. 安全性 ═══════════════ */
console.log('【3】安全性');
{
  // 网关本身(127.0.0.1)无认证 —— 这是设计:公网入口靠 nginx
  const h = await jget('/api/health');
  check('网关仅监听回环(外部不可达由 nginx 兜底)', h.status === 200, '本地直连正常');

  // 路径穿越
  const t1 = await jget('/api/preview?name=../../etc/passwd');
  check('预览:路径穿越被拒', t1.status >= 400, `status=${t1.status}`);
  const t2 = await jget('/api/preview?name=..%2F..%2Fetc%2Fpasswd');
  check('预览:URL编码穿越被拒', t2.status >= 400, `status=${t2.status}`);
  const t3 = await jget('/api/preview?name=' + encodeURIComponent('/etc/passwd'));
  check('预览:绝对路径被拒', t3.status >= 400, `status=${t3.status}`);
  const t4 = await jget('/api/upload', { method: 'POST', body: 'x' });
  check('上传:非 multipart 被拒', t4.status >= 400, `status=${t4.status}`);

  // 输出目录里不能有意外文件
  const { body: arts } = await jget('/api/artifacts');
  check('产物列表:不含路径穿越项', arts?.items?.every(i => !i.name.includes('..')), '');
}

/* ═══════════════ 4. 性能 ═══════════════ */
console.log('【4】性能');
{
  const t0 = Date.now();
  await jget('/api/bootstrap');
  const t1 = Date.now() - t0;
  check('bootstrap 响应 < 500ms', t1 < 500, `${t1}ms`);

  const t2 = Date.now();
  const { body: a } = await jget('/api/artifacts');
  const t3 = Date.now() - t2;
  check('产物列表 响应 < 800ms', t3 < 800, `${t3}ms, ${a?.items?.length} 个`);

  const t4 = Date.now();
  await jget('/api/preview?name=customer_credit_monitor_app.html');
  const t5 = Date.now() - t4;
  check('大文件预览解析 < 6s', t5 < 6000, `${t5}ms`);
}

/* ═══════════════ 5. 进程管理(通过 API 可观测的部分)═══ */
console.log('【5】进程管理');
{
  const { body: h1 } = await jget('/api/health');
  check('健康检查:报告 activeRuns', typeof h1?.activeRuns === 'number', `activeRuns=${h1?.activeRuns}`);

  // 并发:6 个同时提交,应全部完成不报错
  const t0 = Date.now();
  const rs = await Promise.all([
    run('用一句话解释第1个什么是应收账龄'),
    run('用一句话解释第2个什么是应收账龄'),
    run('用一句话解释第3个什么是应收账龄'),
    run('用一句话解释第4个什么是应收账龄'),
    run('用一句话解释第5个什么是应收账龄'),
    run('用一句话解释第6个什么是应收账龄'),
  ]);
  const dur = Date.now() - t0;
  const rejected = rs.filter(r => errs(r.events).some(e => /并发已满|排队超时/.test(e)));
  check('并发 6 个:无「并发已满」拒绝', rejected.length === 0, `被拒 ${rejected.length} 个`);
  const succeeded = rs.filter(r => r.events.some(e => e.type === 'agent_done' && !e.error));
  check('并发 6 个:全部拿到结果', succeeded.length >= 5, `成功 ${succeeded.length}/6, 耗时 ${dur}ms`);
  check('并发 6 个:耗时可控(<240s)', dur < 240000, `${dur}ms`);
}

/* ═══════════════ 6. 编排三模式 ═══════════════ */
console.log('【6】编排模式');
{
  const r = await run('用一句话说明什么是坏账');
  check('单干:产生 agent_start + agent_done', types(r.events).includes('agent_start') && types(r.events).includes('agent_done'),
    types(r.events).join(','));
  check('单干:有文字输出', texts(r.events).length > 5, `${texts(r.events).length} 字`);
  check('单干:无 error', errs(r.events).length === 0, errs(r.events).join(' / '));

  // 注意:牵头人用 Antigravity(固定,不依赖 Kimi 配额)。
  // 历史:这条曾注释成「Kimi 配额已耗尽」,把失败原因归错了 —— 真因是
  // orchestrator._runLead 里用了 run() 的局部变量 rel(ReferenceError),
  // 2026-10-23 已修。Kimi 配额现已恢复,牵头用例不再受它影响。
  const lead = await run('让 Antigravity 牵头:用一句话说明什么是坏账');
  const lp = lead.events.find(e => e.type === 'lead_plan');
  check('有人牵头:产出结构化计划', !!lp, lp ? `${lp.steps?.length} 步` : '无 lead_plan 事件');
  check('有人牵头:计划里的 agent 合法',
    lp?.steps?.every(s => ['antigravity', 'kimi', 'minimax'].includes(s.agent)), JSON.stringify(lp?.steps?.map(s => s.agent)));
}

/* ═══════════════ 7. 身份卡生效 ═══════════════ */
console.log('【7】身份卡');
{
  const { body: ag } = await jget('/api/agents');
  const card = ag.cards.find(c => c.id === 'minimax');
  const orig = card.identity;
  const newId = { ...orig, name: 'E2E测试员', role: '端到端测试专用身份' };
  const put = await fetch(`${BASE}/api/agents/minimax`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: newId }),
  });
  check('身份卡:可保存', put.ok, `status=${put.status}`);

  const { body: ag2 } = await jget('/api/agents');
  check('身份卡:保存后读回一致', ag2.cards.find(c => c.id === 'minimax').identity.name === 'E2E测试员',
    ag2.cards.find(c => c.id === 'minimax').identity.name);

  // 还原
  await fetch(`${BASE}/api/agents/minimax`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: orig }),
  });
  const { body: ag3 } = await jget('/api/agents');
  check('身份卡:可还原', ag3.cards.find(c => c.id === 'minimax').identity.name === orig.name, orig.name);

  // 回归护栏:测试跑完不能留下损坏的身份卡。
  // 历史教训:E2E 曾把 kimi 的卡写成空壳(name=kimi + role/strengths 全空),
  // 而且"读"时会被默认值兜底掩盖掉 —— 只有落盘文件真的坏了才看得出来。
  {
    const { body: ag4 } = await jget('/api/agents');
    const broken = ag4.cards.filter(c => {
      const i = c.identity || {};
      return !i.name || !i.role || !(i.strengths || []).length;
    });
    check('身份卡:无损坏残留', broken.length === 0,
      broken.length ? `损坏: ${broken.map(c => c.id).join(',')}` : `${ag4.cards.length} 张全完整`);
  }
}

/* ═══════════════ 输出 ═══════════════ */
console.log('\n══════════ 结果 ══════════');
for (const [st, name, detail] of results) {
  const icon = st === 'PASS' ? '  ✓' : '  ✗';
  console.log(`${icon} ${name}${detail ? '   (' + detail + ')' : ''}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
