/**
 * 诊断：带认证 token 请求 DSH 的 index.html，看 client 插件有没有被注入。
 * token 从 $DSH_HOME/last-url.txt 读；本脚本只打印长度，不打印 token。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const urlFile = resolve(homedir(), '.dsh', 'last-url.txt');
let raw;
try {
  raw = readFileSync(urlFile, 'utf8').trim();
} catch (err) {
  console.log('读不到 last-url.txt:', err.message);
  process.exit(1);
}

console.log('last-url.txt 长度:', raw.length);

// 这个文件里夹着启动日志，最后才是 URL —— 只把 token 抠出来
const tm = /token=([A-Za-z0-9_-]+)/.exec(raw);
if (!tm) {
  console.log('文件里找不到 token=，前 300 字符:', JSON.stringify(raw.slice(0, 300)));
  process.exit(1);
}
const token = tm[1];
console.log('提取到 token（长度 ' + token.length + '）');

const root = `http://127.0.0.1:19387/?token=${token}`;
const res = await fetch(root, { headers: { accept: 'text/html,application/xhtml+xml' } });
console.log('\nGET 19387/ ->', res.status, res.headers.get('content-type'));
const t = await res.text();
console.log('index.html 长度:', t.length);

if (res.status !== 200) {
  console.log('内容:', JSON.stringify(t.slice(0, 200)));
  process.exit(0);
}

console.log('含 dsh-llm-router-panel:', t.includes('dsh-llm-router-panel'));

const srcs = [...t.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
console.log('\nscript src 共', srcs.length, '条:');
for (const s of srcs) console.log('  ' + s);

const hits = [...t.matchAll(/"([^"]*dsh-llm-router[^"]*)"/g)].map((m) => m[1]);
console.log('\n含本插件名的片段:', hits.length ? hits : '(无)');
