/**
 * 端到端验证：对着**正在运行的** llm-router 发一次真实请求。
 *
 *   npm start                # 另开一个终端先起代理
 *   node test/e2e.mjs
 *
 * 注意：这会真实调用你配好的上游，消耗真实额度（但只消耗几十个 token）。
 */
const BASE = process.env.LLM_ROUTER_BASE ?? 'http://127.0.0.1:8787';

console.log(`目标: ${BASE}\n`);

let health;
try {
  const r = await fetch(`${BASE}/healthz`);
  health = await r.json();
} catch (err) {
  console.error(`连不上代理：${err?.message ?? err}\n先运行 npm start`);
  process.exit(1);
}

console.log(`池子总状态: ${health.ok ? '有可用渠道' : '全部不可用'}\n`);
console.table(
  health.providers.map((p) => ({
    渠道: p.id,
    已配置: p.configured,
    可用: p.available,
    优先级: p.priority,
    能力: p.capabilities.join('+'),
    冷却: p.coolingMs ? `${Math.round(p.coolingMs / 1000)}s` : '-',
    请求: p.requests,
    失败: p.failures,
    token: p.tokens,
  }))
);

const configured = health.providers.filter((p) => p.configured);
if (configured.length === 0) {
  console.error('\n没有任何已配置的渠道 —— 先把 key 填进 .env（或用 npm run import-dsh -- --write）。');
  process.exit(1);
}

console.log(`\n通过代理发一次真实请求（model=auto, max_tokens=512）…`);
const started = Date.now();
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'auto',
    messages: [{ role: 'user', content: '只回答四个字：连接正常' }],
    max_tokens: 512,
    stream: false,
  }),
});
const elapsed = Date.now() - started;
const text = await res.text();

console.log(`\nHTTP ${res.status}  ${elapsed}ms`);
let json = null;
try {
  json = JSON.parse(text);
} catch {
  /* 非 JSON */
}

if (res.ok) {
  const content = json?.choices?.[0]?.message?.content;
  console.log(`回复: ${JSON.stringify(content ?? '(无正文，可能被推理阶段吃光了 max_tokens)')}`);
  console.log(`finish_reason: ${json?.choices?.[0]?.finish_reason}`);
  console.log(`usage: ${JSON.stringify(json?.usage ?? null)}`);
  console.log('\n✓ 代理端到端打通。');
} else {
  console.error(`\n✗ 失败：${json?.error?.message ?? text.slice(0, 500)}`);
  if (json?.error?.attempts) {
    console.error('各上游失败明细：');
    for (const a of json.error.attempts) console.error(`  · ${a}`);
  }
  process.exit(1);
}
