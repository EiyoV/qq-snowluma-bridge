/**
 * 一次性工具（不进包）：验证火山方舟的接入点能不能真调通。
 *
 *   node tmp/probe-endpoints.mjs
 */
import { loadEnvFile } from '../dsh-plugin/lib/config.mjs';

const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const env = loadEnvFile(process.env.USERPROFILE + '/.dsh/llm-router/.env');
const key = env.ARK_API_KEY;
if (!key) {
  console.error('没有 ARK_API_KEY');
  process.exit(1);
}

// 从控制台「在线推理 → 接入点」抄下来的（截图上有一条第 8 个被截断了，先不含它）
const ENDPOINTS = [
  ['Doubao-Seed-2.1-pro-260915', 'ep-m-20261009230644-rm9vx'],
  ['GLM-5.3-Flash-260828', 'ep-m-20261009230644-4rkgc'],
  ['Doubao-Seed-2.1-lite-260915', 'ep-m-20261009230643-4gph8'],
  ['DeepSeek-V4-Flash-260731', 'ep-m-20261009230643-csbxb'],
  ['GLM-5.2-260617', 'ep-m-20261009230643-9sbj4'],
  ['Doubao-Seed-Evolving', 'ep-m-20261009230643-5cs7l'],
  ['Doubao-Seed-Character-260628', 'ep-m-20261009230642-p7hxv'],
  ['Doubao-Seed-2.1-pro-260628', 'ep-m-20261009230642-2dsmt'],
  ['Doubao-Seed-2.0-lite-260428', 'ep-m-20261009230641-4bzr4'],
];

const rows = [];
for (const [label, ep] of ENDPOINTS) {
  const rec = { label, ep, status: 0, ms: 0, tokens: null, error: null };
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: ep, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
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
        rec.error = String(JSON.parse(text)?.error?.message ?? text).slice(0, 130);
      } catch {
        rec.error = text.slice(0, 130);
      }
    }
  } catch (err) {
    rec.status = -1;
    rec.error = String(err?.message ?? err).slice(0, 130);
  }
  rec.ms = Date.now() - t0;
  rows.push(rec);
  console.log(
    `${String(rec.status).padStart(4)}  ${label.padEnd(28)} ${ep.padEnd(30)} ${rec.tokens ?? '-'} token  ${rec.ms}ms  ${rec.error ?? ''}`
  );
}

const ok = rows.filter((r) => r.status === 200);
console.log(`\n可调用：${ok.length} / ${rows.length}`);
