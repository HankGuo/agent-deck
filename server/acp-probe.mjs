/**
 * 探针:用 Agent Deck 自己的 ACP client 驱动外部 openclaw/hermes
 * 验证「不在本机运行的 agent 接入」的技术可行性
 */
import { AcpSession } from './acp-client.mjs';

const CMD = process.argv.slice(2);
if (!CMD.length) { console.error('用法: node acp-probe.mjs <cmd...>'); process.exit(1); }

const agent = { name: 'OpenClaw(外部)', cmd: CMD, id: 'openclaw' };
const opts = {
  cwd: './workspace',
  fsAllow: ['./workspace', './uploads', './outputs', '/tmp'],
  timeoutMs: 180000,
};

console.log('命令:', CMD.join(' '));
const s = new AcpSession(agent, opts);

s.on('capabilities', (c) => console.log('握手能力:', JSON.stringify(c).slice(0, 300)));
s.on('text', (d) => process.stdout.write(d.text));
s.on('thought', (d) => console.log('\n[思考]', d.text.slice(0, 120)));
s.on('tool', (d) => console.log('\n[工具]', JSON.stringify(d).slice(0, 200)));
s.on('error', (d) => console.log('\n[错误]', d.message));

try {
  await s.start();
  console.log('\n握手成功。agentInfo =', JSON.stringify(s.agentInfo));
  const sess = await s.newSession('./workspace');
  console.log('session/new ->', JSON.stringify(sess).slice(0, 200));
  const r = await s.prompt('用一句话说明什么是应收账龄,不超过 40 字。');
  console.log('\n\nsession/prompt ->', JSON.stringify(r).slice(0, 200));
} catch (e) {
  console.error('\n\n失败:', e.message);
  process.exitCode = 1;
} finally {
  s.stop();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
