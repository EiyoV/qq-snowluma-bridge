/**
 * 诊断：确认从 DSH 凭据库导入的 key 与 DSH 自己用的 key 是否一致，
 * 以及为什么真实请求会被拒。只打印长度与首尾片段，不打印完整 key。
 *
 *   node test/diag-credentials.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(resolve(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
const envText = readFileSync(resolve(ROOT, '.env'), 'utf8').replace(/^\uFEFF/, '');

function yamlVal(name) {
  const m = new RegExp(`^\\s+${name}\\s*:\\s*(.+?)\\s*$`, 'm').exec(yaml);
  if (!m) return null;
  // flow mapping 的尾逗号是语法
  return m[1].endsWith(',') ? m[1].slice(0, -1).trimEnd() : m[1];
}
function envVal(name) {
  const m = new RegExp(`^${name}=(.*)$`, 'm').exec(envText);
  return m ? m[1] : null;
}

function describe(s) {
  if (s === null) return 'null';
  const codes = [...s].map((c) => c.charCodeAt(0));
  return `len=${s.length} head=${JSON.stringify(s.slice(0, 5))} tail=${JSON.stringify(s.slice(-4))} minCode=${Math.min(...codes)} maxCode=${Math.max(...codes)}`;
}

console.log('=== 凭据库 refs 里的值 vs 我写进 .env 的值 ===');
for (const n of ['ARK_API_KEY', 'AREFREE_API_KEY', 'DEEPSEEK_API_KEY']) {
  const a = yamlVal(n);
  const b = envVal(n);
  console.log(`\n${n}`);
  console.log(`  yaml: ${describe(a)}`);
  console.log(`  env : ${describe(b)}`);
  console.log(`  完全相同: ${a === b}`);
}

// 真正发一次请求，分别用两个来源的 key
async function tryKey(label, key) {
  if (!key) {
    console.log(`  ${label}: 没有 key，跳过`);
    return;
  }
  try {
    const res = await fetch('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-v4-1-flash-260910',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4,
      }),
    });
    const text = (await res.text()).slice(0, 300);
    console.log(`  ${label}: HTTP ${res.status} — ${text}`);
  } catch (err) {
    console.log(`  ${label}: 抛错 ${err?.message ?? err}`);
  }
}

console.log('\n=== 用两个来源的 ARK key 各发一次真实请求 ===');
await tryKey('来自 yaml', yamlVal('ARK_API_KEY'));
await tryKey('来自 .env', envVal('ARK_API_KEY'));
