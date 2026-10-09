/**
 * QQ Windows 桌面客户端自动化机器人 v3
 *
 * 单终端启动：内置 llm-router 子进程，一条命令全搞定。
 * 截图 + 视觉模型识别消息 → AI 回复。
 *
 * 启动: node qq-desktop-bot.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

// ─── 配置 ────────────────────────────────────────────
const ROUTER_PORT = 18787;
const LLM_ROUTER_URL = `http://localhost:${ROUTER_PORT}/v1/chat/completions`;
const HEALTHZ_URL = `http://localhost:${ROUTER_PORT}/healthz`;
const POLL_INTERVAL_MS = 3000;
const SCREENSHOT_DIR = tmpdir();

// ─── 子进程管理 ────────────────────────────────────────

let routerProcess = null;

function startRouter() {
  return new Promise((resolve, reject) => {
    console.log('🔧 启动 llm-router（内置）…');
    routerProcess = spawn('node', ['src/index.mjs'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LLM_ROUTER_CONFIG: resolve(ROOT, 'config.json') },
    });

    routerProcess.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) process.stdout.write(`  [router] ${line}\n`);
    });
    routerProcess.stderr.on('data', d => {
      process.stderr.write(`  [router:err] ${d.toString().trim()}\n`);
    });
    routerProcess.on('error', reject);

    // 轮询等它就绪
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch(HEALTHZ_URL, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          clearInterval(check);
          const data = await r.json();
          const avail = Array.isArray(data) ? data.filter(s => s.available).length : '?';
          console.log(`✅ llm-router 就绪（${avail} 渠道可用）\n`);
          resolve();
        }
      } catch {}
      if (attempts > 40) {
        clearInterval(check);
        reject(new Error('llm-router 启动超时'));
      }
    }, 500);
  });
}

function stopRouter() {
  if (routerProcess) {
    routerProcess.kill('SIGTERM');
    setTimeout(() => { try { routerProcess.kill('SIGKILL'); } catch {} }, 3000);
  }
}

// ─── PowerShell 封装 ──────────────────────────────────

function ps(args, timeout = 25000) {
  return new Promise((res, rej) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', args,
    ], { timeout, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => code === 0 ? res(out.trim()) : rej(new Error(err.trim() || out.trim() || `exit ${code}`)));
    child.on('error', rej);
  });
}

// ─── QQ 窗口操作 ──────────────────────────────────────

async function getQQInfo() {
  const raw = await ps(`
    $procs = Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Sort-Object @{E={$_.MainWindowTitle -ceq 'QQ'};D=$true}, @{E={[int]$_.MainWindowHandle};D=$true} | Select -First 1
    if (-not $procs) { '{"error":"not found"}'; exit 0 }
    $h = $procs.MainWindowHandle
    Add-Type @'
using System; using System.Runtime.InteropServices;
public struct RECT { public int L,T,R,B; }
public class QW {
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
    $wr=New-Object RECT; [QW]::GetWindowRect($h,[ref]$wr)
    $cr=New-Object RECT; [QW]::GetClientRect($h,[ref]$cr)
    @{hwnd=$h.ToInt64();pid=$procs.Id;title=$procs.MainWindowTitle;min=[QW]::IsIconic($h);
      win=@{L=$wr.L;T=$wr.T;R=$wr.R;B=$wr.B;W=($wr.R-$wr.L);H=($wr.B-$wr.T)};
      client=@{W=($cr.R-$cr.L);H=($cr.B-$cr.T)}} | ConvertTo-Json -Compress
  `);
  try { return JSON.parse(raw); } catch { return { error: raw }; }
}

async function focusQQWindow() {
  return ps(`
    Add-Type @'
using System; using System.Runtime.InteropServices;
public class FW {[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);}
'@
    $p=Get-Process -Name QQ -ErrorAction SilentlyContinue|?{$_.MainWindowTitle -ne ''}|Select -First 1
    if(!$p){'NONE';exit 1}
    $h=$p.MainWindowHandle
    if([FW]::IsIconic($h)){[FW]::ShowWindow($h,9);Sleep -Milliseconds 400}
    [FW]::SetForegroundWindow($h);Sleep -Milliseconds 200;'OK'
  `);
}

async function captureQQWindow(filePath) {
  const info = await getQQInfo();
  if (info.error) throw new Error(`找不到QQ: ${info.error}`);
  const fp = filePath.replace(/\\/g, '\\\\');
  await ps(`
    Add-Type -AssemblyName System.Drawing
    Add-Type @'
using System; using System.Runtime.InteropServices;
public struct RECT { public int L,T,R,B; }
public class SC {[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);}
'@
    $h=[IntPtr]::new(${info.hwnd})
    if([SC]::IsIconic($h)){[SC]::ShowWindow($h,9);Sleep -Milliseconds 300}
    [SC]::SetForegroundWindow($h);Sleep -Milliseconds 200
    $r=New-Object RECT;[SC]::GetWindowRect($h,[ref]$r)
    $w=$r.R-$r.L;$h2=$r.B-$r.T
    $bmp=New-Object System.Drawing.Bitmap($w,$h2)
    $g=[System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L,$r.T,0,0,(New-Object System.Drawing.Size($w,$h2)))
    $g.Dispose()
    $bmp.Save("${fp}",[System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "OK $w x $h2"
  `);
  return { w: info.win.W, h: info.win.H };
}

// ─── AI 分析（截图→JSON） ──────────────────────────────

async function analyzeScreenshot(imagePath) {
  const buf = readFileSync(imagePath);
  const b64 = buf.toString('base64');
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: `这是QQ聊天窗口的截图。分析并只返回JSON：

QQ气泡：左边气泡=对方发的(sender:"other")，右边气泡=自己发的(sender:"self")。
列出最近1-4条消息。如果窗口标题/顶部有聊天对象名字填 chatName。

{"chatName":"名字或null","messages":[{"sender":"other/self","content":"文字","position":"bottom/middle/top"},...]}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'low' } },
    ],
  }];

  const res = await fetch(LLM_ROUTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto:vision', messages, temperature: 0.1, max_tokens: 600 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    throw new Error(`vision ${res.status}: ${e.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.usage) {
    const u = data.usage;
    console.log(`   👁  tokens: ${u.prompt_tokens ?? '?'}→${u.completion_tokens ?? '?'} (${data.model ?? '?'})`);
  }
  const text = data.choices?.[0]?.message?.content?.trim() ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// ─── AI 回复 ──────────────────────────────────────────

const history = [];

async function generateReply(message, chatName, selfName) {
  history.push({ role: 'user', content: message });
  if (history.length > 20) history.splice(0, history.length - 20);

  const system = `你是${selfName || '一个AI助手'}，在QQ上和别人聊天。用口语化中文回复。
规则：简短（1-3句）· 可加emoji但别泛滥 · 不用markdown · 不说自己是机器人 · 不懂就说"不太清楚"
${chatName ? `你正在和"${chatName}"聊天。` : ''}`;

  const res = await fetch(LLM_ROUTER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: system }, ...history.slice(-12)],
      temperature: 0.7,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
  if (reply) history.push({ role: 'assistant', content: reply });
  if (data.model) console.log(`   🧠 ${data.model} (${data.usage?.total_tokens ?? '?'}t)`);
  return reply || '嗯…';
}

// ─── 发送消息 ─────────────────────────────────────────

async function sendQQMessage(text) {
  const esc = text.replace(/"/g, '\\"').replace(/`/g, '``').replace(/\$/g, '`$');
  await ps(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Clipboard]::SetText("${esc}")
    Sleep -Milliseconds 150
    Add-Type @'
using System; using System.Runtime.InteropServices;
public class KS {
[DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint fl,UIntPtr ex);
public const byte VK_CTRL=0x11,VK_V=0x56,VK_RET=0x0D;
public const uint KEYUP=0x0002;}
'@
    [KS]::keybd_event([KS]::VK_CTRL,0,0,[UIntPtr]::Zero)
    [KS]::keybd_event([KS]::VK_V,0,0,[UIntPtr]::Zero)
    Sleep -Milliseconds 80
    [KS]::keybd_event([KS]::VK_V,0,[KS]::KEYUP,[UIntPtr]::Zero)
    [KS]::keybd_event([KS]::VK_CTRL,0,[KS]::KEYUP,[UIntPtr]::Zero)
    Sleep -Milliseconds 250
    [KS]::keybd_event([KS]::VK_RET,0,0,[UIntPtr]::Zero)
    Sleep -Milliseconds 50
    [KS]::keybd_event([KS]::VK_RET,0,[KS]::KEYUP,[UIntPtr]::Zero)
    'OK'
  `);
}

// ─── 消息去重 ─────────────────────────────────────────

function fp(sender, content) {
  return createHash('md5').update(`${sender}|${content}`).digest('hex').slice(0, 12);
}

// ─── 提取 QQ 昵称 ─────────────────────────────────────

async function detectQQNickname() {
  try {
    // 方式 1：从 QQ 窗口标题提取（可能显示为 "昵称 - QQ" 或 "QQ - 昵称"）
    const info = await getQQInfo();
    if (info.title && info.title !== 'QQ') {
      const m = info.title.match(/^(.+?)\s*[-–—]\s*QQ/) || info.title.match(/^QQ\s*[-–—]\s*(.+)/);
      if (m) return m[1].trim();
    }
    // 方式 2：从 QQ 个人资料读取（注册表）
    const raw = await ps(`
      try {
        $p = Get-ItemProperty "HKCU:\\Software\\Tencent\\QQ" -Name "LastRegisteredUin" -ErrorAction Stop
        $uin = $p.LastRegisteredUin
        if ($uin) { "UIN:$uin" } else { "NONE" }
      } catch { "NONE" }
    `);
    if (raw.startsWith('UIN:')) return `QQ${raw.slice(4)}`;
  } catch {}
  return 'QQ用户';
}

// ─── 主函数 ────────────────────────────────────────────

async function main() {
  console.log('🤖 QQ 桌面机器人 v3（单终端，内置 llm-router）\n');

  // 1. 启动 llm-router
  await startRouter();

  // 2. 检测 QQ 身份
  const selfName = await detectQQNickname();
  console.log(`🪪  当前身份: ${selfName}`);

  // 3. 找 QQ 窗口
  const info = await getQQInfo();
  if (info.error) {
    console.log(`❌ 找不到 QQ 窗口，请登录 QQ 并打开聊天窗口后重试`);
    stopRouter();
    return;
  }
  console.log(`✅ QQ: "${info.title}" (hwnd=${info.hwnd})\n`);

  const screenPath = resolve(SCREENSHOT_DIR, 'qq-bot-snap.png');
  const seen = new Set();
  let idle = 0;

  console.log('👂 监听中…（Ctrl+C 退出）\n');

  while (true) {
    try {
      await captureQQWindow(screenPath);
      const analysis = await analyzeScreenshot(screenPath);

      if (!analysis?.messages?.length) {
        idle++; if (idle % 5 === 0) process.stdout.write('.');
        await sleep(POLL_INTERVAL_MS); continue;
      }

      const { chatName, messages } = analysis;
      const latestOther = messages.filter(m => m.sender === 'other').at(-1);
      if (!latestOther) {
        idle++; if (idle % 5 === 0) process.stdout.write('.');
        await sleep(POLL_INTERVAL_MS); continue;
      }

      const key = fp(latestOther.sender, latestOther.content);
      if (seen.has(key)) {
        idle++; if (idle % 5 === 0) process.stdout.write('.');
        await sleep(POLL_INTERVAL_MS); continue;
      }
      seen.add(key);
      if (seen.size > 200) { const a = [...seen]; a.splice(0, 100); seen.clear(); a.forEach(f => seen.add(f)); }

      const tag = chatName ? `@${chatName} ` : '';
      const ts = new Date().toLocaleTimeString();
      console.log(`\n📩 [${ts}] ${tag}${latestOther.content.slice(0, 60)}${latestOther.content.length > 60 ? '…' : ''}`);

      const reply = await generateReply(latestOther.content, chatName, selfName);
      if (reply) {
        console.log(`📤 ${reply}`);
        await focusQQWindow();
        await sendQQMessage(reply);
        console.log('   ✅');
      }

      try { unlinkSync(screenPath); } catch {}
      idle = 0;
      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error(`\n⚠️ ${err.message}`);
      await sleep(5000);
    }
  }
}

// ─── 入口 ──────────────────────────────────────────────

main().catch(err => {
  console.error('💥', err.message);
  stopRouter();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 停止中…');
  stopRouter();
  try { unlinkSync(resolve(SCREENSHOT_DIR, 'qq-bot-snap.png')); } catch {}
  process.exit(0);
});