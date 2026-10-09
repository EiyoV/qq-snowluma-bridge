/**
 * 从 DSH 的凭据库同步 key 到本项目的 .env。
 *
 *   npm run import-dsh              # 预览将要导入哪些键（不写文件）
 *   npm run import-dsh -- --write   # 真正写入 .env
 *
 * 只在你主动运行时执行 —— 代理本身永远不会去读 DSH 的凭据库。
 * 输出只打印键名与长度，不打印值；写入目标 .env 已在 .gitignore 内。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRED = resolve(homedir(), '.dsh', '.credentials.yaml');
const ENV_PATH = resolve(ROOT, '.env');

const doWrite = process.argv.includes('--write');

if (!existsSync(CRED)) {
  console.error(`找不到 DSH 凭据库：${CRED}`);
  process.exit(1);
}

/**
 * 只解析 `refs:` 这个 flow mapping 块里的键值。
 * DSH 的凭据文件顶层还有 records/kind/payload 等结构，全部跳过。
 */
function parseRefs(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^refs\s*:/.test(l));
  if (start < 0) return {};

  const out = {};
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === start) {
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      continue;
    }
    const m = /^\s+([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== '' && !m[2].startsWith('{')) {
      let v = m[2];
      // YAML flow mapping 的条目以逗号分隔，即 `KEY: value,` —— 这个逗号是语法，不属于值。
      // 漏掉这一步会让每个 key 都多带一个尾逗号，上游会报 "API key format is incorrect"。
      if (v.endsWith(',')) v = v.slice(0, -1).trimEnd();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (depth <= 0 && i > start) break;
  }
  return out;
}

const refs = parseRefs(readFileSync(CRED, 'utf8'));
const names = Object.keys(refs);

if (names.length === 0) {
  console.error('没有从 refs 里解析出任何键。凭据库格式可能变了，请手动把 key 填进 .env。');
  process.exit(1);
}

console.log(`从 ${CRED} 读到 ${names.length} 个凭据：`);
for (const n of names) {
  console.log(`  · ${n}  (长度 ${refs[n].length}，前缀 ${refs[n].slice(0, 4)}…)`);
}

if (!doWrite) {
  console.log('\n这是预览，没有写入任何文件。要真正写入 .env，加 --write：');
  console.log('  npm run import-dsh -- --write');
  process.exit(0);
}

// 读现有 .env（如果有），就地更新同名键，保留注释与其他行
const base = existsSync(ENV_PATH)
  ? readFileSync(ENV_PATH, 'utf8')
  : existsSync(resolve(ROOT, '.env.example'))
    ? readFileSync(resolve(ROOT, '.env.example'), 'utf8')
    : '';

const lines = base.replace(/^\uFEFF/, '').split(/\r?\n/);
const updated = new Set();

const next = lines.map((line) => {
  const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (m && refs[m[2]] !== undefined) {
    updated.add(m[2]);
    return `${m[2]}=${refs[m[2]]}`;
  }
  return line;
});

const appended = [];
for (const n of names) {
  if (!updated.has(n)) appended.push(`${n}=${refs[n]}`);
}

let text = next.join('\n');
if (appended.length > 0) {
  text += `\n# ── 由 import-dsh 追加 ──\n${appended.join('\n')}\n`;
}
if (text.includes('OLLAMA_BASE_URL=') === false) {
  text += '\nOLLAMA_BASE_URL=http://127.0.0.1:11434/v1\n';
}

writeFileSync(ENV_PATH, text, 'utf8'); // 无 BOM
console.log(`\n已写入 ${ENV_PATH}`);
console.log(`  更新已有键 ${updated.size} 个，新增键 ${appended.length} 个`);
console.log('注意：DEEPSEEK_API_KEY 目前在本机是失效的（web_search 报 401），导入后记得单独核实。');
