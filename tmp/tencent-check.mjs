/**
 * 一次性工具（不进包）：核实腾讯 TokenHub 的 key 是否可用 + 拉真实模型清单。
 *
 *   node tmp/tencent-check.mjs
 */
import { loadEnvFile } from '../dsh-plugin/lib/config.mjs';

const BASE = 'https://tokenhub.tencentmaas.com/v1';
const env = loadEnvFile(process.env.USERPROFILE + '/.dsh/llm-router/.env');
const key = env.TENCENT_TOKENHUB_API_KEY;
if (!key) {
  console.error('❌ .env 里没有 TENCENT_TOKENHUB_API_KEY（key 没存上）');
  process.exit(1);
}
console.log(`✅ .env 里有 TENCENT_TOKENHUB_API_KEY（长度 ${key.length}）\n`);

// 1) 模型清单
let models = [];
try {
  const r = await fetch(`${BASE}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  });
  console.log(`GET /v1/models → ${r.status}`);
  const j = await r.json().catch(() => null);
  models = (j?.data ?? []).map((m) => ({ id: m.id, name: m.name, status: m.status }));
  console.log(`模型数：${models.length}\n`);
  for (const m of models) {
    console.log(`  ${String(m.id).padEnd(34)} ${String(m.name ?? '').padEnd(30)} ${m.status ?? ''}`);
  }
} catch (err) {
  console.error('拉模型清单失败：', err.message);
}

// 2) 拿第一个模型真打一发，确认 key 能推理
const probe = models.find((m) => m.status !== 'pre-offline')?.id;
if (probe) {
  console.log(`\n用 ${probe} 试一次对话（max_tokens=1）…`);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: probe, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    let note = t.slice(0, 200);
    try {
      const j = JSON.parse(t);
      note = r.ok
        ? `OK usage=${JSON.stringify(j.usage)}`
        : String(j.error?.message ?? j.error ?? t).slice(0, 200);
    } catch {
      /* 原文 */
    }
    console.log(`  ${r.status} ${note}`);
  } catch (err) {
    console.log('  请求失败：', err.message);
  }
}

// 3) 顺带看一眼代理有没有把腾讯收进池子
try {
  const j = await (await fetch('http://127.0.0.1:19387/api/llm-router/status', { signal: AbortSignal.timeout(15000) })).json();
  const ids = (j.providers ?? []).map((p) => p.id);
  console.log(`\n代理渠道池（${ids.length} 个）：${ids.join(', ')}`);
  console.log(ids.includes('tencent-tokenhub') ? '✅ 腾讯已入池' : '⚠️ 腾讯还不在池子里（需要在面板点一次「重新加载配置」）');
} catch (err) {
  console.log('\n读代理状态失败：', err.message);
}
