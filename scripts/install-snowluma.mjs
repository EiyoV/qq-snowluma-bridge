/**
 * SnowLuma 自动下载安装器
 *
 * - 检测 snowluma-pkg/ 是否存在且有 index.mjs
 * - 没有就从 GitHub 最新 release 下 win-x64 lite 版
 * - 解压到 snowluma-pkg/app/
 *
 * 用法：node install-snowluma.mjs [--force]
 *   --force  强制重新下载（升级用）
 */

import { existsSync, mkdirSync, rmSync, readdirSync, cpSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const TARGET_DIR = resolve(ROOT, 'snowluma-pkg');
const APP_DIR = resolve(TARGET_DIR, 'app');
const FORCE = process.argv.includes('--force');
const REPO = 'SnowLuma/SnowLuma';

async function getLatestRelease() {
  console.log('🔍 查询 SnowLuma 最新版本…');
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'qq-bot-installer' },
  });
  if (!res.ok) throw new Error(`查询 release 失败: ${res.status}`);
  const data = await res.json();
  const lite = data.assets.find(a => a.name.includes('win-x64-lite.zip'));
  if (!lite) throw new Error('没找到 win-x64-lite.zip 资产');
  console.log(`   最新版本: ${data.tag_name}`);
  console.log(`   下载文件: ${lite.name} (${Math.round(lite.size / 1024 / 1024 * 10) / 10} MB)`);
  return { tag: data.tag_name, url: lite.browser_download_url, name: lite.name };
}

async function download(url, dest) {
  console.log(`⬇️  下载中…`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败: ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
  console.log(`   已下载到: ${dest}`);
}

function extract(zipPath, targetDir) {
  console.log(`📦 解压中…`);
  const tmp = resolve(TARGET_DIR, '_tmp_extract');
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  // 用 PowerShell Expand-Archive
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmp}' -Force"`,
    { stdio: 'inherit' });

  // 找到 index.mjs 所在目录（zip 可能包一层子目录 / app / 版本目录）
  function locateIndex(dir, depth = 0) {
    if (depth > 3) return null;
    if (existsSync(resolve(dir, 'index.mjs'))) return dir;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const found = locateIndex(resolve(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  }
  const found = locateIndex(tmp);
  if (!found) throw new Error('解压内容里找不到 index.mjs，包结构异常');

  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // 把找到的目录内容复制到 targetDir
  cpSync(found, targetDir, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`   解压完成: ${targetDir}`);
}

async function main() {
  if (!FORCE && existsSync(resolve(APP_DIR, 'index.mjs'))) {
    console.log('✅ SnowLuma 已安装，跳过。（加 --force 强制更新）');
    return;
  }

  // 升级/重装时备份用户配置（QQ 登录态、OneBot token、WebUI 凭据）
  const CONFIG_DIR = resolve(APP_DIR, 'config');
  const backup = resolve(TARGET_DIR, '_old_config');
  let hadConfig = false;
  if (existsSync(CONFIG_DIR)) {
    hadConfig = true;
    console.log('💾 备份现有配置…');
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    cpSync(CONFIG_DIR, backup, { recursive: true });
  }

  if (existsSync(TARGET_DIR)) {
    rmSync(TARGET_DIR, { recursive: true, force: true });
  }

  mkdirSync(TARGET_DIR, { recursive: true });
  const { tag, url, name } = await getLatestRelease();
  const zipPath = resolve(TARGET_DIR, name);
  await download(url, zipPath);
  extract(zipPath, APP_DIR);

  // 恢复备份配置
  if (hadConfig && existsSync(backup)) {
    cpSync(backup, CONFIG_DIR, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
    console.log('✅ 已恢复登录配置（QQ 登录态/WebUI 凭据）');
  }

  // 删掉 zip 省空间
  try { rmSync(zipPath); } catch {}

  // 写版本标记
  writeFileSync(resolve(TARGET_DIR, 'VERSION'), tag + '\n');

  console.log(`\n🎉 SnowLuma ${tag} 安装完成！`);
  console.log(`   位置: ${APP_DIR}`);
  console.log(`   启动: node ${resolve(APP_DIR, 'index.mjs')}`);
  console.log(`   WebUI: http://127.0.0.1:5099`);
}

main().catch(err => {
  console.error('\n💥 安装失败:', err.message);
  process.exit(1);
});
