/**
 * QQ 机器人 v4 —— SnowLuma(OneBot v11) 协议网关 + llm-router
 *
 * 架构（对小黑盒文章《我在QQ里养了一只AI小鲸鱼》的复刻）：
 *   QQ 客户端 → SnowLuma(协议网关, 手动启动+扫码) → 本脚本(桥接) → llm-router(AI大脑)
 *
 * 消息是纯文本直接进来 —— 零视觉 token，比截图方案省 1000+ tokens/轮。
 *
 * 文章踩坑经验全部内置：
 *   1. 角色卡最前面、最强语气（管理员指令第一段）
 *   2. 频率低：@才回、会话最小间隔、每日发送上限
 *   3. 熔断器：连续失败 3 次停 3 分钟，防重试风暴触发腾讯风控
 *   4. 分条发送：像真人一样一条条说，条间随机停顿
 *
 * 使用：
 *   ① 手动启动 SnowLuma：snowluma-pkg\app\launcher.bat → WebUI http://localhost:5099
 *      → 登录 QQ → 网络配置里开「WebSocket 服务端」监听 3001（记下 access token）
 *   ② npm run qq-bot2
 *
 * 环境变量（可选）：
 *   SNOWLUMA_WS_URL  默认 ws://127.0.0.1:3001
 *   SNOWLUMA_TOKEN   SnowLuma WebUI 里配置的 access token
 *   OWNER_QQ         管理员 QQ 号（管理员消息最高优先级）
 *   LLM_ROUTER_URL   默认 http://localhost:18787/v1/chat/completions
 */

import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import { ensureApiKeys, hasApiKeys } from './scripts/lib/ensure-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const APP_DIR = resolve(ROOT, 'snowluma-pkg', 'app');

// 是否给子进程带 --use-system-ca（Node 22.15+ 才有；走系统证书库才能在被
// 代理拦截的网络里访问 GitHub）。VBS 启动器会先探测并置环境变量；直接用
// node 启动时在这里兜底探测一次。
const CA_ARGS = (() => {
  if (process.env.QQBOT_USE_SYSTEM_CA === '1') return ['--use-system-ca'];
  try {
    const probe = spawnSync(process.execPath, ['--use-system-ca', '-e', '0'], { stdio: 'ignore' });
    return probe.status === 0 ? ['--use-system-ca'] : [];
  } catch { return []; }
})();

// 由 VBS 静默启动器设置。静默模式下 stdout 指向日志文件而不是屏幕，
// 任何需要用户交互的流程都不能在这里跑（否则用户看不见、进程却卡着等输入）。
const SILENT = process.env.QQBOT_SILENT === '1';

// ─── 自动确保 SnowLuma 已安装+运行 ─────────────────────
function isPortOpen(port, timeout = 1500) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(false); });
  });
}

// 首次启动时 SnowLuma 会生成随机 WebUI 密码，只打印在日志里。
// 静默运行看不到控制台，所以把它抄到一个显眼的记事本里。
function writeInitialCredentialsHint(logFile) {
  try {
    if (!existsSync(logFile)) return;
    const text = readFileSync(logFile, 'utf8');
    const m = [...text.matchAll(/initial credentials: user=(\S+) password=(\S+)/g)].pop();
    if (!m) return;
    const hintFile = resolve(ROOT, 'SnowLuma首次登录密码.txt');
    // 已写过同一个密码就不重复写。但如果密码变了（上次没改密就退出，SnowLuma
    // 会重新生成一个随机密码），必须更新 —— 否则用户拿着旧密码登不进去。
    if (existsSync(hintFile) && readFileSync(hintFile, 'utf8').includes(`密码: ${m[2]}`)) return;
    const body = [
      'SnowLuma 首次启动的 WebUI 登录凭据',
      '',
      '地址: http://127.0.0.1:5099',
      `账号: ${m[1]}`,
      `密码: ${m[2]}`,
      '',
      '登录后请依次完成：',
      '  1. 立刻修改密码（SnowLuma 不保存初始随机密码，关掉就找不回了）',
      '  2. 登录 QQ（扫码）',
      '  3. 网络配置 → 打开「WebSocket 服务端」，端口填 3001',
      '',
      '以上都做完后，QQ 机器人会自动连上，这个文件就可以删掉了。',
      '',
    ].join('\n');
    writeFileSync(hintFile, body, 'utf8');
    console.log(`🔑 首次登录凭据已写入：SnowLuma首次登录密码.txt（${m[1]} / ${m[2]}）`);
  } catch { /* 提示文件失败不影响主流程 */ }
}

async function ensureSnowLuma() {
  // 1. SnowLuma 是否已经在跑 —— 看 WebUI 端口 5099。
  //    注意不能用 3001：那个端口要等登录 QQ 并开启 WS 服务端之后才监听。
  if (await isPortOpen(5099)) {
    console.log('✅ SnowLuma 已在运行 (WebUI http://127.0.0.1:5099)');
    return;
  }

  // 2. 没装 → 自动下载安装
  const indexJs = resolve(APP_DIR, 'index.mjs');
  if (!existsSync(indexJs)) {
    console.log('❄️ SnowLuma 未安装，正在自动下载安装…');
    const installer = resolve(ROOT, 'scripts', 'install-snowluma.mjs');
    if (!existsSync(installer)) {
      console.error('   找不到安装脚本 scripts/install-snowluma.mjs');
      return;
    }
    const r = spawnSync(process.execPath, [...CA_ARGS, installer], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('   SnowLuma 安装失败');
      return;
    }
  }

  // 3. 启动 SnowLuma（后台）
  console.log('🚀 启动 SnowLuma…');
  const logDir = resolve(ROOT, 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, 'snowluma.log');
  // 必须用 openSync：createWriteStream 是异步打开的，fd 仍是 null 时 spawn 会拒绝
  const logFd = openSync(logFile, 'a');
  spawn(process.execPath, ['index.mjs'], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  }).unref();

  // 4. 等 WebUI 端口起来（最多 40 秒，首次启动要初始化数据）
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await isPortOpen(5099)) {
      console.log('✅ SnowLuma 已启动 (WebUI http://127.0.0.1:5099)');
      writeInitialCredentialsHint(logFile);
      // 自动打开浏览器，省得用户自己找地址
      spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:5099'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      console.log('🌐 已打开浏览器 → 请登录 QQ（未登录前机器人会一直重试连接）');
      return;
    }
  }
  console.log('⚠️  SnowLuma 启动超时，请手动检查 logs/snowluma.log');
}

// ─── 自动发现 SnowLuma 连接信息 ─────────────────────────
// 静默启动时没有环境变量，就从 snowluma-pkg/app/config/onebot_*.json 里读。
function detectSnowLuma() {
  try {
    const dir = resolve(ROOT, 'snowluma-pkg', 'app', 'config');
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find(f => f.startsWith('onebot_') && f.endsWith('.json'));
    if (!file) return null;
    const cfg = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
    const ws = cfg.networks?.wsServers?.[0];
    if (!ws) return null;
    const host = ws.host ?? '127.0.0.1';
    const port = ws.port ?? 3001;
    // SnowLuma 不认末尾的 "/":path 为空或 "/" 时都不拼，直接 ws://host:port
    const path = ws.path && ws.path !== '/' ? ws.path : '';
    return {
      wsUrl: `ws://${host}:${port}${path}`,
      token: ws.accessToken ?? '',
    };
  } catch { return null; }
}
const DETECTED_SNOWLUMA = detectSnowLuma();

// ─── 加载外部配置（API密钥.txt 优先于 .env） ───────────
// 注意：这里写进 process.env 的值会传给 llm-router，而 process.env 的优先级
// 高于 .env —— 所以模板里的示例值（your-xxx）必须跳过，否则会把真 key 覆盖掉。
try {
  const apiKeysPath = resolve(ROOT, 'API密钥.txt');
  if (existsSync(apiKeysPath)) {
    const content = readFileSync(apiKeysPath, 'utf8');
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');   // 不能用 split('=', 2)：值里含 = 会被截断
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!key || !value) continue;
      if (/^(your-|sk-xxxx|xxxx)/i.test(value)) continue;
      process.env[key] = value;
    }
  }
} catch (err) {
  console.warn('⚠️ 读取API密钥.txt失败:', err.message);
}

// ─── 配置（环境变量优先；没有就用自动发现的） ───────────
const SNOWLUMA_WS_URL = process.env.SNOWLUMA_WS_URL ?? DETECTED_SNOWLUMA?.wsUrl ?? 'ws://127.0.0.1:3001';
const SNOWLUMA_TOKEN = process.env.SNOWLUMA_TOKEN ?? DETECTED_SNOWLUMA?.token ?? '';
const OWNER_QQ = Number(process.env.OWNER_QQ ?? 0);          // 0 = 未设置
const LLM_ROUTER_PORT = Number(process.env.LLM_ROUTER_PORT ?? 0) || null;
const LLM_ROUTER_URL = process.env.LLM_ROUTER_URL ?? null;
const HEALTHZ_URL = process.env.LLM_ROUTER_URL
  ? process.env.LLM_ROUTER_URL.replace(/\/v1\/?.*$/, '') + '/healthz'
  : null;

// 群白名单：空数组 = 所有群都响应（但仍需 @自己）；填 QQ 群号 = 只响应这些群
const GROUP_WHITELIST = [];
// 私聊白名单：空数组 = 所有私聊都回；填 QQ 号 = 只回这些人
const PRIVATE_WHITELIST = [];

// 频控（保命，别调太激进 —— 文章：频率一定要低）
const MIN_REPLY_INTERVAL_MS = 5000;   // 同一会话两条回复最小间隔
const DAILY_SEND_LIMIT = 200;         // 每日发送条数上限
const MAX_SEGMENTS = 4;               // 单次回复最多拆几条
const SEGMENT_MAX_LEN = 32;           // 单条最长字数

// 熔断器（文章坑三：失败 3 次停 3 分钟）
const BREAKER_FAIL_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 3 * 60 * 1000;

// 每会话历史条数（*2 为 user+assistant）
const MAX_HISTORY_TURNS = 8;

// ─── llm-router 子进程（已在跑就复用；端口从 config 读） ──
let routerProc = null;
let routerBaseUrl = '';

async function detectRouterPort() {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8'));
    const port = Number(cfg.server?.port ?? 8787);
    const host = cfg.server?.host ?? '127.0.0.1';
    return { port, host };
  } catch {
    return { port: 8787, host: '127.0.0.1' };
  }
}

async function ensureRouter() {
  const { port, host } = await detectRouterPort();
  routerBaseUrl = `http://${host}:${port}`;
  const healthz = `${routerBaseUrl}/healthz`;
  try {
    const r = await fetch(healthz, { signal: AbortSignal.timeout(1500) });
    if (r.ok) { console.log(`✅ llm-router 已在运行 (${routerBaseUrl})，复用`); return; }
  } catch {}
  console.log(`🔧 启动 llm-router @ ${routerBaseUrl} …`);
  routerProc = spawn('node', ['src/index.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LLM_ROUTER_CONFIG: resolve(ROOT, 'config.json') },
  });
  routerProc.stdout.on('data', d => process.stdout.write(`  [router] ${d.toString().trim()}\n`));
  routerProc.stderr.on('data', d => process.stderr.write(`  [router:err] ${d.toString().trim()}\n`));
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(healthz, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { console.log('✅ llm-router 就绪'); return; }
    } catch {}
    await sleep(500);
  }
  throw new Error('llm-router 启动超时');
}

function llmRouterEndpoint() {
  if (LLM_ROUTER_URL) return LLM_ROUTER_URL;
  return `${routerBaseUrl}/v1/chat/completions`;
}

function stopRouter() {
  if (!routerProc) return;
  routerProc.kill('SIGTERM');
  setTimeout(() => { try { routerProc.kill('SIGKILL'); } catch {} }, 3000);
}

// ─── OneBot v11 WebSocket 客户端（原生，零依赖） ────────
let ws = null;
let echoSeq = 0;
const pending = new Map();   // echo -> {resolve, reject, timer}
let selfId = 0;
let selfNickname = '';
let wsBackoff = 1000;

function connectSnowLuma() {
  return new Promise((res, rej) => {
    const url = SNOWLUMA_TOKEN ? `${SNOWLUMA_WS_URL}?access_token=${encodeURIComponent(SNOWLUMA_TOKEN)}` : SNOWLUMA_WS_URL;
    ws = new WebSocket(url);
    ws.onopen = () => { console.log(`✅ 已连接 SnowLuma (${SNOWLUMA_WS_URL})`); wsBackoff = 1000; res(); };
    ws.onerror = e => { rej(new Error(`WS 连接失败（SnowLuma 没开？端口对吗？token 对吗？）`)); };
    ws.onclose = () => {
      console.log(`⚠️ WS 断开，${Math.round(wsBackoff / 1000)}s 后重连…`);
      for (const [k, p] of pending) { clearTimeout(p.timer); p.reject(new Error('ws closed')); }
      pending.clear();
      setTimeout(() => { wsBackoff = Math.min(wsBackoff * 2, 30000); connectSnowLuma().catch(() => {}); }, wsBackoff);
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.echo) {
        const p = pending.get(msg.echo);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.echo);
          if (msg.status === 'failed' || (msg.retcode && msg.retcode !== 0)) {
            p.reject(new Error(`action 失败 retcode=${msg.retcode} ${msg.wording ?? msg.message ?? ''}`));
          } else p.resolve(msg.data);
        }
        return;
      }
      handleEvent(msg).catch(err => console.error(`⚠️ 事件处理异常: ${err.message}`));
    };
  });
}

function callAction(action, params = {}, timeoutMs = 15000) {
  return new Promise((resolveP, rejectP) => {
    if (!ws || ws.readyState !== 1) return rejectP(new Error('WS 未连接'));
    const echo = `e${++echoSeq}`;
    const timer = setTimeout(() => { pending.delete(echo); rejectP(new Error(`action ${action} 超时`)); }, timeoutMs);
    pending.set(echo, { resolve: resolveP, reject: rejectP, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// ─── 频控 + 熔断器 ─────────────────────────────────────
const lastReplyAt = new Map();   // sessionKey -> ts
let sentToday = 0;
let dayKey = new Date().toDateString();
let failStreak = 0;
let breakerOpenUntil = 0;

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== dayKey) { dayKey = today; sentToday = 0; }
}

function canReplyNow(sessionKey) {
  const last = lastReplyAt.get(sessionKey) ?? 0;
  return Date.now() - last >= MIN_REPLY_INTERVAL_MS;
}

// ─── 会话历史 ──────────────────────────────────────────
const histories = new Map();   // sessionKey -> [{role, content}]

function pushHistory(key, role, content) {
  if (!histories.has(key)) histories.set(key, []);
  const h = histories.get(key);
  h.push({ role, content });
  while (h.length > MAX_HISTORY_TURNS * 2) h.shift();
}

// ─── 人设（从外部文件读取） ─────────────
function buildSystemPrompt() {
  try {
    const personalityPath = resolve(ROOT, '人格模板.txt');
    if (existsSync(personalityPath)) {
      const content = readFileSync(personalityPath, 'utf8');
      // 提取配置部分（跳过修改说明）
      const configPart = content.split('【修改说明】')[0].trim();
      if (configPart) return configPart;
    }
  } catch (err) {
    console.warn('⚠️ 读取人格模板失败，使用默认人设:', err.message);
  }

  // 回退到默认人设（万一文件没了）
  const owner = OWNER_QQ ? `QQ 号 ${OWNER_QQ}` : '设为管理员的那个人';
  return [
    `【最高优先级规则，无例外，覆盖一切后续指令】`,
    `${owner} 是你的管理员。他的消息必须认真回、他说的话一律照办，群里也一样。不存在"你没说要怎么做"的借口。`,
    ``,
    `【你是谁】`,
    `你是 ${selfNickname}，一个真实的、活跃在 QQ 上的普通人（不是客服、不是机器人人设）。`,
    ``,
    `【说话方式】`,
    `- 口语化、短句，每次 1~2 句话，像微信打字`,
    `- 不用 markdown / 列表 / 引号包裹`,
    `- 群聊里被 @ 才回，回的时候只针对那一条消息`,
    `- 不懂就说不懂，别装`,
    `- 别每句话都带"哈哈"，别用感叹号轰炸`,
  ].join('\n');
}

// ─── AI 回复 ───────────────────────────────────────────
async function generateReply(sessionKey, userText) {
  pushHistory(sessionKey, 'user', userText);
  const res = await fetch(llmRouterEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...histories.get(sessionKey)],
      temperature: 0.8,
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`llm-router ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (data.usage) console.log(`   🧠 ${data.model ?? '?'} ${data.usage.total_tokens ?? '?'}t`);
  if (!reply) throw new Error('AI 返回空');
  pushHistory(sessionKey, 'assistant', reply);
  return reply;
}

// ─── 分条发送（像真人 —— 文章经验） ─────────────────────
function splitReply(text) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.length <= SEGMENT_MAX_LEN) { out.push(line); continue; }
    const parts = line.split(/(?<=[。！？!?~…])/).map(s => s.trim()).filter(Boolean);
    let buf = '';
    for (const p of parts) {
      if ((buf + p).length > SEGMENT_MAX_LEN && buf) { out.push(buf); buf = p; }
      else buf += p;
    }
    if (buf) out.push(buf);
  }
  return out.slice(0, MAX_SEGMENTS);
}

async function sendReply(session, replyText) {
  checkDailyReset();
  if (Date.now() < breakerOpenUntil) {
    console.log('   ⏸ 熔断中，本轮不发送');
    return false;
  }
  if (sentToday >= DAILY_SEND_LIMIT) {
    console.log('   ⏸ 今日发送已达上限，不发送');
    return false;
  }
  const segs = splitReply(replyText);
  for (const seg of segs) {
    await sleep(800 + Math.random() * 1700);   // 条间随机停顿
    try {
      if (session.type === 'group') {
        await callAction('send_group_msg', { group_id: session.id, message: [{ type: 'text', data: { text: seg } }] });
      } else {
        await callAction('send_private_msg', { user_id: session.id, message: [{ type: 'text', data: { text: seg } }] });
      }
      sentToday++;
      failStreak = 0;   // 成功一次就复位
      console.log(`   📤 [${sentToday}/${DAILY_SEND_LIMIT}] ${seg}`);
    } catch (err) {
      failStreak++;
      console.error(`   ❌ 发送失败(${failStreak}/${BREAKER_FAIL_THRESHOLD}): ${err.message}`);
      if (failStreak >= BREAKER_FAIL_THRESHOLD) {
        breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
        console.log(`   🔌 熔断器开启：${BREAKER_COOLDOWN_MS / 60000} 分钟内不再发送（防风控）`);
      }
      return false;
    }
  }
  return true;
}

// ─── 事件处理 ──────────────────────────────────────────
function extractPlain(message, atMe) {
  // message 可能是字符串(CQ码)或 segment 数组
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]+\]/g, '').trim();
  const parts = [];
  for (const seg of message) {
    if (seg.type === 'text') parts.push(seg.data?.text ?? '');
    else if (seg.type === 'at') {
      const qq = String(seg.data?.qq ?? '');
      if (atMe && qq === String(selfId)) continue;   // @自己 的前缀去掉
      parts.push(`[@${seg.data?.name ?? qq}]`);
    }
    else if (seg.type === 'face') parts.push('[表情]');
    else if (seg.type === 'image') parts.push('[图片]');
    else if (seg.type === 'reply') parts.push('');
    else parts.push(`[${seg.type}]`);
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function isAtMe(message) {
  if (typeof message !== 'object') return false;
  return message.some(seg => seg.type === 'at' && String(seg.data?.qq ?? '') === String(selfId));
}

async function handleEvent(ev) {
  if (ev.post_type !== 'message') return;
  if (Number(ev.user_id) === Number(selfId)) return;   // 忽略自己

  const isGroup = ev.message_type === 'group';
  const session = isGroup ? { type: 'group', id: Number(ev.group_id) } : { type: 'private', id: Number(ev.user_id) };
  const sessionKey = isGroup ? `g${ev.group_id}` : `p${ev.user_id}`;

  // 白名单
  if (isGroup && GROUP_WHITELIST.length && !GROUP_WHITELIST.includes(session.id)) return;
  if (!isGroup && PRIVATE_WHITELIST.length && !PRIVATE_WHITELIST.includes(session.id)) return;

  // 群聊必须 @自己（保守策略，防刷屏触发风控）
  const atMe = isGroup ? isAtMe(ev.message) : false;
  if (isGroup && !atMe) return;

  const text = extractPlain(ev.message, atMe);
  if (!text) return;

  const nickname = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
  const isOwner = OWNER_QQ && Number(ev.user_id) === OWNER_QQ;
  const tag = isGroup ? `群${ev.group_id}` : '私聊';

  console.log(`\n📩 [${tag}] ${nickname}(${ev.user_id})${isOwner ? ' ★管理员' : ''}: ${text.slice(0, 80)}`);

  // 频控
  if (!canReplyNow(sessionKey)) { console.log('   ⏭ 距上次回复太近，跳过'); return; }

  const userText = isGroup ? `${nickname}：${text}` : text;
  let reply;
  try {
    reply = await generateReply(sessionKey, userText);
  } catch (err) {
    console.error(`   ⚠️ AI 失败: ${err.message}`);
    return;
  }
  if (!reply) return;

  console.log(`   💬 ${reply}`);
  lastReplyAt.set(sessionKey, Date.now());
  await sendReply(session, reply);
}

// ─── 启动 ──────────────────────────────────────────────
async function main() {
  console.log('🤖 QQ 机器人 v4（SnowLuma 协议网关版，纯文本零截图）\n');

  // 没有 API key 的话，机器人连上 QQ 也不会回话 —— 先检查，别让它静默失败。
  // 装了 DSH 且配过 key 的机器会被自动导入，不用用户手抄。
  const keyState = ensureApiKeys(ROOT);
  if (keyState === 'imported') {
    console.log('✅ 已从 DSH 凭据库自动导入 API key');
  } else if (keyState === 'missing') {
    // 只有真正的可见终端才能跑交互向导。静默启动下 stdout 被重定向进日志文件，
    // 此时跑向导 = 用户什么都看不见、进程却永远卡着等输入（踩过）。
    const canPrompt = !SILENT && process.stdin.isTTY && process.stdout.isTTY;
    if (canPrompt) {
      console.log('🔑 还没配置 API key，启动配置向导…\n');
      spawnSync(process.execPath, ['scripts/setup.mjs'], { cwd: ROOT, stdio: 'inherit' });
    }
    if (!hasApiKeys(ROOT)) {
      console.error('❌ 没有可用的 API key，机器人不会回话。');
      console.error('   编辑项目根目录的 API密钥.txt 填入至少一个 key，或运行：npm run setup');
      process.exit(1);
    }
  }

  await ensureSnowLuma();
  await ensureRouter();

  // 等待 SnowLuma 完全起来并且用户登录成功，轮询连接
  let connected = false;
  for (let attempt = 0; attempt < 60; attempt++) { // 最多等1分钟
    try {
      await connectSnowLuma();
      connected = true;
      break;
    } catch {
      process.stdout.write('.');
      await sleep(2000);
    }
  }
  if (!connected) {
    console.error(`\n\n❌ 等待 SnowLuma 连接超时，请检查：`);
    console.error(`   1. SnowLuma 是否已启动 → 浏览器打开 http://127.0.0.1:5099`);
    console.error(`   2. 是否已扫码登录 QQ`);
    console.error(`   3. 网络配置 → WebSocket 服务端是否开启监听 3001`);
    console.error(`   日志文件: logs/snowluma.log`);
    stopRouter();
    process.exit(1);
  }

  // 重连场景：每次连上都重新拿 login info
  const login = await callAction('get_login_info');
  selfId = Number(login.user_id);
  selfNickname = login.nickname;
  console.log(`🪪 身份: ${selfNickname} (${selfId})`);
  if (!OWNER_QQ) console.log('⚠️ 未设置 OWNER_QQ 环境变量，管理员规则不会生效');
  console.log(`👂 监听中（群聊需 @我；Ctrl+C 退出）\n`);

  // 保持进程活着
  setInterval(() => {}, 60_000);
}

main().catch(err => {
  console.error('💥', err.message);
  stopRouter();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 停止中…');
  try { ws?.close(); } catch {}
  stopRouter();
  process.exit(0);
});