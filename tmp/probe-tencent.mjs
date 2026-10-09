/**
 * 一次性工具（不进包）：探测腾讯 TokenHub 里哪些模型真能用于对话。
 *
 *   node tmp/probe-tencent.mjs
 *
 * /v1/models 会返回 118 个条目，但里面混着 embedding / 图像 / 视频 / 3D 生成模型，
 * 它们在 /chat/completions 上必然报错。所以先按关键词粗筛，再真打一发给结论。
 */
import { loadEnvFile } from '../dsh-plugin/lib/config.mjs';
import { writeFileSync } from 'node:fs';

const BASE = 'https://tokenhub.tencentmaas.com/v1';
const env = loadEnvFile(process.env.USERPROFILE + '/.dsh/llm-router/.env');
const key = env.TENCENT_TOKENHUB_API_KEY;
if (!key) {
  console.error('没有 TENCENT_TOKENHUB_API_KEY');
  process.exit(1);
}

const listed = await (
  await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) })
).json();
const all = (listed.data ?? []).map((m) => ({ id: m.id, name: m.name, status: m.status }));
console.log(`模型总数：${all.length}`);

const NOT_CHAT = /embedding|image|video|3d|kling|vidu|pixverse|youtu|kinfra|retopology|motion|format|component/i;
const targets = all.filter((m) => m.status === 'online' && !NOT_CHAT.test(m.id));
console.log(`候选（online 且非 embedding/图像/视频/3D）：${targets.length}\n`);

const results = [];
let cursor = 0;

async function worker() {
  for (;;) {
    const i = cursor;
    cursor += 1;
    if (i >= targets.length) return;
    const m = targets[i];
    const rec = { id: m.id, name: m.name, status: 0, ms: 0, tokens: null, error: null };
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: m.id,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(45000),
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
          rec.error = String(JSON.parse(text)?.error?.message ?? text).slice(0, 110);
        } catch {
          rec.error = text.slice(0, 110);
        }
      }
    } catch (err) {
      rec.status = -1;
      rec.error = String(err?.message ?? err).slice(0, 110);
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

const ok = results.filter((r) => r.status === 200);
// 完整结论落文件，避免控制台输出被截断
writeFileSync(
  'tmp/tencent-ok.json',
  JSON.stringify({ total: results.length, ok: ok.map((r) => ({ id: r.id, tokens: r.tokens, ms: r.ms })) }, null, 2),
  'utf8'
);
console.log(`\n\n可用于对话：${ok.length} / ${results.length}  → 已写入 tmp/tencent-ok.json\n`);
for (const r of ok) console.log(`  ✓ ${r.id.padEnd(38)} ${String(r.tokens).padStart(4)} tok  ${r.ms}ms`);
const bad = results.filter((r) => r.status !== 200);
if (bad.length) {
  console.log('\n不可用：');
  for (const r of bad) console.log(`  ✗ ${r.id.padEnd(38)} ${r.status} ${r.error}`);
}
