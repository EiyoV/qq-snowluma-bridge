/**
 * 交互式配置向导
 *
 *   npm run setup
 *
 * - 列出所有渠道，逐个提示粘贴 key（回车跳过）
 * - 写入 .env（保留已有值，只更新你这次填的）
 * - 从 config.example.json 复制 config.json（如果不存在）
 * - 完成后提示 npm run start-all
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const ENV_EXAMPLE = resolve(ROOT, '.env.example');
const CONFIG_PATH = resolve(ROOT, 'config.json');
const CONFIG_EXAMPLE = resolve(ROOT, 'config.example.json');

// ── 渠道定义（分组 + 中文名 + env 变量名） ──
const GROUPS = [
  {
    title: '国内直连（不需要海外网络）',
    keys: [
      { env: 'SILICONFLOW_API_KEY', name: '硅基流动',  hint: 'api.siliconflow.cn 注册' },
      { env: 'ZHIPU_API_KEY',       name: '智谱 GLM',  hint: 'open.bigmodel.cn 注册' },
      { env: 'DASHSCOPE_API_KEY',   name: '通义千问',  hint: '阿里云百炼控制台' },
      { env: 'ARK_API_KEY',         name: '火山方舟',  hint: 'volcengine.com 控制台' },
      { env: 'DEEPSEEK_API_KEY',    name: 'DeepSeek',  hint: 'platform.deepseek.com' },
    ],
  },
  {
    title: '需要海外网络',
    keys: [
      { env: 'GEMINI_API_KEY',      name: 'Google Gemini', hint: 'aistudio.google.com' },
      { env: 'GROQ_API_KEY',        name: 'Groq',          hint: 'console.groq.com' },
      { env: 'OPENROUTER_API_KEY',  name: 'OpenRouter',    hint: 'openrouter.ai/keys' },
      { env: 'MISTRAL_API_KEY',     name: 'Mistral',       hint: 'console.mistral.ai' },
      { env: 'GITHUB_MODELS_TOKEN', name: 'GitHub Models', hint: 'github.com/settings/tokens' },
      { env: 'CEREBRAS_API_KEY',    name: 'Cerebras',      hint: 'cloud.cerebras.ai（须绑卡）' },
    ],
  },
  {
    title: '本地兜底（不需要 key）',
    keys: [
      { env: 'OLLAMA_BASE_URL', name: 'Ollama 地址', hint: '默认 http://127.0.0.1:11434/v1' },
    ],
  },
];

function loadEnv() {
  const env = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

function ask(rl, q) {
  return new Promise(res => rl.question(q, a => res(a.trim())));
}

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  🤖 llm-router 配置向导');
  console.log('═══════════════════════════════════════\n');

  const env = loadEnv();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── 逐组配置 ──
  for (const g of GROUPS) {
    console.log(`\n── ${g.title} ──────────────────────`);
    for (const k of g.keys) {
      const masked = env[k.env]
        ? `（当前: ${env[k.env].slice(0, 6)}…${env[k.env].slice(-4)}）`
        : '（未设置）';
      console.log(`\n  ${k.name}  [${k.env}]`);
      console.log(`  注册地址: ${k.hint}`);
      console.log(`  ${masked}`);

      let prompt;
      if (k.env === 'OLLAMA_BASE_URL') {
        prompt = env[k.env] || 'http://127.0.0.1:11434/v1';
        const v = await ask(rl, `  地址（回车用默认）: `);
        if (v) env[k.env] = v;
        else if (!env[k.env]) env[k.env] = prompt;
        continue;
      }

      const input = await ask(rl, `  粘贴 key（回车跳过）: `);
      if (input) {
        env[k.env] = input;
        console.log(`  ✅ 已保存`);
      } else {
        console.log(`  ⏭  跳过`);
      }
    }
  }

  rl.close();

  // ── 写 .env ──
  // 用 .env.example 的注释结构做骨架，填入收集到的值
  let skeleton = '';
  if (existsSync(ENV_EXAMPLE)) {
    skeleton = readFileSync(ENV_EXAMPLE, 'utf8').replace(/^\uFEFF/, '');
  }
  const lines = skeleton.split(/\r?\n/);
  const written = new Set();
  const out = lines.map(line => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && env[m[1]]) {
      written.add(m[1]);
      return `${m[1]}=${env[m[1]]}`;
    }
    return line;
  });
  // .env.example 没有但用户填了的（如 DEEPSEEK_API_KEY）
  const extra = [];
  for (const g of GROUPS) {
    for (const k of g.keys) {
      if (env[k.env] && !written.has(k.env)) {
        extra.push(`${k.env}=${env[k.env]}`);
        written.add(k.env);
      }
    }
  }
  let text = out.join('\n');
  if (extra.length) {
    text += `\n# ── 由 setup 向导追加 ──\n${extra.join('\n')}\n`;
  }
  writeFileSync(ENV_PATH, text, 'utf8');
  const count = [...written].filter(k => env[k]).length;
  console.log(`\n✅ .env 已写入（${count} 个 key）`);

  // ── 同步到 API密钥.txt ──
  try {
    const apiKeysPath = resolve(ROOT, 'API密钥.txt');
    if (existsSync(apiKeysPath)) {
      // 读取现有文件，保留注释部分，只更新值
      const existingLines = readFileSync(apiKeysPath, 'utf8').split(/\r?\n/);
      const keyMap = new Map();
      const commentLines = [];
      for (const line of existingLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          commentLines.push(line);
        } else {
          const [key, value] = trimmed.split('=', 2);
          if (key && value) {
            keyMap.set(key.trim(), value.trim());
          }
        }
      }
      // 用新的env值覆盖
      for (const k of GROUPS.flatMap(g => g.keys)) {
        if (env[k.env]) {
          keyMap.set(k.env, env[k.env]);
        }
      }
      // 其他已有key也保留
      for (const [k, v] of Object.entries(env)) {
        if (v) keyMap.set(k, v);
      }
      // 写回
      const outLines = [...commentLines];
      if (commentLines.length) outLines.push('');
      for (const [k, v] of keyMap) {
        outLines.push(`${k}=${v}`);
      }
      writeFileSync(apiKeysPath, outLines.join('\n'), 'utf8');
      console.log(`✅ API密钥.txt 已同步`);
    }
  } catch (err) {
    console.warn(`⚠️ API密钥.txt 同步失败: ${err.message}`);
  }

  // ── 复制 config.json ──
  if (!existsSync(CONFIG_PATH) && existsSync(CONFIG_EXAMPLE)) {
    copyFileSync(CONFIG_EXAMPLE, CONFIG_PATH);
    console.log('✅ config.json 已从示例复制');
  } else if (existsSync(CONFIG_PATH)) {
    console.log('✅ config.json 已存在，保留');
  }

  console.log('\n═══════════════════════════════════════');
  console.log('  🎉 配置完成！');
  console.log('  下一步: npm run start-all');
  console.log('═══════════════════════════════════════');
}

main().catch(err => {
  console.error('\n💥 配置失败:', err.message);
  process.exit(1);
});
