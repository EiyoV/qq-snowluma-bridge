/**
 * 一键启动 QQ 机器人
 *
 * 流程：
 *  1. 检测 SnowLuma 没装 → 自动下载安装
 *  2. 启动 SnowLuma（后台）
 *  3. 打印登录地址 + 初始密码提示
 *  4. 等你扫码登录好后按回车
 *  5. 自动读取 OneBot 配置里的 WS token
 *  6. 启动 bot（自动拉起 llm-router）
 *
 * 用法：node scripts/start.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import readline from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..');
const APP_DIR = resolve(ROOT, 'snowluma-pkg', 'app');
const CONFIG_DIR = resolve(APP_DIR, 'config');
const ENV_PATH = resolve(ROOT, '.env');
const ENV_EXAMPLE = resolve(ROOT, '.env.example');
const CONFIG_PATH = resolve(ROOT, 'config.json');
const CONFIG_EXAMPLE = resolve(ROOT, 'config.example.json');
const DSH_CRED = resolve(homedir(), '.dsh', '.credentials.yaml');

// ── 0. 确保 API key 已配置 ──
function envHasKeys() {
  if (!existsSync(ENV_PATH)) return false;
  const text = readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '');
  // 至少有一个非空 key（VAR=后面有值且不是注释）
  return /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/m.test(text);
}

function configExists() {
  return existsSync(CONFIG_PATH);
}

async function ensureConfig() {
  // config.json 不存在 → 从 example 复制
  if (!configExists() && existsSync(CONFIG_EXAMPLE)) {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(CONFIG_EXAMPLE, CONFIG_PATH);
    console.log('✅ config.json 已从示例复制');
  }

  if (envHasKeys()) {
    console.log('✅ .env 已有 key');
    return;
  }

  console.log('\n🔑 检测到还没有配置 API key');

  // 方案 A：有 DSH 凭据库 → 自动导入
  if (existsSync(DSH_CRED)) {
    console.log('📦 检测到 DSH 凭据库，自动导入中…');
    const r = spawnSync(process.execPath, ['src/import-dsh-credentials.mjs', '--write'], {
      cwd: ROOT, stdio: 'inherit',
    });
    if (r.status === 0 && envHasKeys()) {
      console.log('✅ DSH key 已导入');
      return;
    }
    console.log('⚠️  DSH 导入未成功，转为手动配置');
  }

  // 方案 C：交互式向导
  console.log('🤖 启动配置向导…\n');
  const r = spawnSync(process.execPath, ['scripts/setup.mjs'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('配置向导失败');
  if (!envHasKeys()) throw new Error('配置完成后 .env 仍为空，请手动填写');
}

// ── 1. 确保 SnowLuma 已安装 ──
async function ensureSnowLuma() {
  if (existsSync(resolve(APP_DIR, 'index.mjs'))) {
    console.log('✅ SnowLuma 已安装');
    return;
  }
  console.log('📦 SnowLuma 未安装，自动下载中…');
  const r = spawnSync(process.execPath, ['scripts/install-snowluma.mjs'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('SnowLuma 安装失败');
}

// ── 2. 启动 SnowLuma ──
let snowProc = null;

function startSnowLuma() {
  console.log('🚀 启动 SnowLuma…');
  snowProc = spawn('node', ['index.mjs'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let logged = false;
  snowProc.stdout.on('data', d => {
    const line = d.toString().trim();
    if (!line) return;
    // 透传：初始登录凭据（★ 行）和监听地址；其余日志静默
    if (line.includes('listening') && !logged) {
      console.log(`   ${line}`);
      logged = true;
    } else if (line.includes('★') || line.includes('凭据') || line.includes('Credentials')
        || /password|用户名|user/i.test(line)) {
      console.log(`   ${line}`);
    }
  });
  snowProc.stderr.on('data', d => {
    process.stderr.write(`   [snowluma:err] ${d.toString().trim()}\n`);
  });
  snowProc.on('exit', code => {
    console.log(`\n💥 SnowLuma 已退出 (code=${code})`);
  });
}

async function waitForPort(port, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(800) });
      if (res.status >= 200) return true;
    } catch {}
    await sleep(800);
  }
  return false;
}

// ── 3. 找 OneBot 配置文件（登录后才会生成） ──
function findOneBotConfig() {
  if (!existsSync(CONFIG_DIR)) return null;
  const files = readdirSync(CONFIG_DIR);
  const onebot = files.find(f => f.startsWith('onebot_') && f.endsWith('.json'));
  return onebot ? resolve(CONFIG_DIR, onebot) : null;
}

function readWsConfig() {
  const cfgPath = findOneBotConfig();
  if (!cfgPath) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const ws = cfg.networks?.wsServers?.[0];
    if (!ws) return null;
    return {
      port: ws.port ?? 3001,
      token: ws.accessToken ?? '',
      host: ws.host ?? '127.0.0.1',
      path: ws.path ?? '/',
    };
  } catch { return null; }
}

// ── 4. 等用户扫码登录 ──
async function waitForLogin() {
  console.log('\n📱 请在浏览器中打开 http://127.0.0.1:5099');
  console.log('   登录 WebUI，同意协议，然后扫码登录 QQ');
  console.log('   （首次登录密码看启动日志里的 initial password）');
  console.log('\n   登录完成后按回车继续…');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(res => rl.question('', () => { rl.close(); res(); }));

  // 等几秒让配置文件生成
  for (let i = 0; i < 15; i++) {
    if (findOneBotConfig()) {
      const ws = readWsConfig();
      if (ws) {
        console.log(`✅ 检测到 QQ 已登录，WS 端口: ${ws.port}`);
        return ws;
      }
    }
    await sleep(1000);
  }
  throw new Error('没检测到 OneBot 配置，确认你登录 QQ 了吗？');
}

// ── 5. 启动 bot ──
function startBot(wsConfig) {
  console.log('\n🤖 启动 QQ 机器人…');
  const wsUrl = `ws://${wsConfig.host}:${wsConfig.port}${wsConfig.path}`;
  const env = {
    ...process.env,
    SNOWLUMA_WS_URL: wsUrl,
    SNOWLUMA_TOKEN: wsConfig.token,
  };
  const bot = spawn('node', ['qq-snowluma-bot.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  bot.on('exit', code => {
    console.log(`\n🤖 机器人已退出 (code=${code})`);
    process.exit(code);
  });
}

// ── 主流程 ──
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  🐳 QQ 机器人一键启动');
  console.log('═══════════════════════════════════════\n');

  await ensureConfig();
  await ensureSnowLuma();

  // SnowLuma 已在运行就复用，不重复启动
  const alreadyUp = await waitForPort(5099, 1500);
  if (alreadyUp) {
    console.log('✅ SnowLuma 已在运行，复用');
  } else {
    startSnowLuma();
    const ok = await waitForPort(5099);
    if (!ok) throw new Error('SnowLuma 启动超时');
  }

  const wsConfig = await waitForLogin();
  startBot(wsConfig);

  // 进程挂起，等 bot 退出
  process.on('SIGINT', () => {
    console.log('\n⏹  正在停止…');
    if (snowProc) snowProc.kill();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('\n💥 启动失败:', err.message);
  if (snowProc) snowProc.kill();
  process.exit(1);
});
