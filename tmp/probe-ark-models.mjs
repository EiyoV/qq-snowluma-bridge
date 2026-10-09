/**
 * 一次性工具（不进包）：探测火山方舟这把 key 下哪些模型能真用于对话。
 *
 *   node tmp/probe-ark-models.mjs
 *
 * 为什么要逐个试：/api/v3/models 会返回一大堆**不能对话**的模型
 * （embedding、视频生成、图片编辑…），它们在 /chat/completions 上必然报错。
 * 光看名字猜会写错配置，所以真打一发 max_tokens=1 的请求。
 * 每个模型只花个位数 token，相对"每模型每天 200 万"可以忽略。
 */
import { writeFileSync } from 'node:fs';
import { loadEnvFile } from '../dsh-plugin/lib/config.mjs';

const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const env = loadEnvFile(process.env.USERPROFILE + '/.dsh/llm-router/.env');
const key = env.ARK_API_KEY;
if (!key) {
  console.error('llm-router 的 .env 里没有 ARK_API_KEY');
  process.exit(1);
}

const listed = await (
  await fetch(`${BASE}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  })
).json();
const all = (listed.data ?? []).map((m) => m.id ?? m.name);
console.log(`账号下模型总数：${all.length}`);

// 明显不是对话模型的先剔掉，省一轮请求
const NOT_CHAT = /embedding|seedance|seedream|wan2|seededit|seaweed|ui-tars|tts|asr/i;
const targets = all.filter((id) => !NOT_CHAT.test(id));
console.log(`候选（已排除 embedding/视频/图片类）：${targets.length}\n`);

const results = [];
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor;
    cursor += 1;
    if (i >= targets.length) return;
    const model = targets[i];
    const rec = { model, status: 0, ms: 0, tokens: null, error: null };
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await r.text();
      rec.status = r.status;
      if (r.ok) {
        try {
          rec.tokens = JSON.parse(text)?.usage?.total_tokens ?? null;
        } catch {
          /* 忽略 */
        }
      } else {
        try {
          rec.error = String(JSON.parse(text)?.error?.message ?? text).slice(0, 140);
        } catch {
          rec.error = text.slice(0, 140);
        }
      }
    } catch (err) {
      rec.status = -1;
      rec.error = String(err?.message ?? err).slice(0, 140);
    }
    rec.ms = Date.now() - t0;
    results.push(rec);
    process.stdout.write(rec.status === 200 ? '.' : 'x');
  }
}

await Promise.all([worker(), worker(), worker(), worker()]);

results.sort(
  (a, b) =>
    (a.status === 200 ? 0 : 1) - (b.status === 200 ? 0 : 1) ||
    (a.tokens ?? 99999) - (b.tokens ?? 99999) ||
    a.ms - b.ms
);
writeFileSync('tmp/ark-models-result.json', JSON.stringify(results, null, 2), 'utf8');

const ok = results.filter((r) => r.status === 200);
console.log(`\n\n可用于对话：${ok.length} / ${results.length}`);
for (const r of ok) console.log(`  ✓ ${r.model.padEnd(40)} ${String(r.tokens).padStart(4)} token  ${r.ms}ms`);

const bad = results.filter((r) => r.status !== 200);
if (bad.length > 0) {
  console.log('\n不可用（样例）：');
  for (const r of bad.slice(0, 8)) console.log(`  ✗ ${r.model.padEnd(40)} ${r.status} ${r.error}`);
}
