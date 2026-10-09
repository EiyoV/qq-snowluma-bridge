/**
 * API key 检测（bot / start.mjs / check-config.mjs 共用）
 *
 * 为什么单独抽出来：启动入口有三个（VBS 静默、npm run start-all、npm run qq-bot2），
 * 检测规则必须一致，否则会出现"这个入口说配好了、那个入口说没配"。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

// DSH 桌面版把 key 存在这里；装过 DSH 并配过 key 的机器可以直接抄过来
const DSH_CRED = resolve(homedir(), '.dsh', '.credentials.yaml');

// 只认长这样的变量名才算 key，避免 OLLAMA_BASE_URL 之类有值就被误判成"已配置"
const KEY_NAME_RE = /(_API_KEY|_TOKEN|_ACCESS_KEY|_SECRET_KEY|_SECRET)$/;
// 占位符（.gitignore 里的示例文件 / API密钥.txt 模板）
const PLACEHOLDER_RE = /^(your-|sk-xxxx|xxxx)/i;

const SOURCES = ['API密钥.txt', '.env'];

/** 是否已经配了至少一个真实可用的 API key */
export function hasApiKeys(root) {
  for (const name of SOURCES) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!KEY_NAME_RE.test(key)) continue;
      if (!val || PLACEHOLDER_RE.test(val)) continue;
      return true;
    }
  }
  return false;
}

/**
 * 确保有可用 API key，能自动搞定的就不麻烦用户。
 *
 * @returns {'ok'|'imported'|'missing'}
 *   ok       —— 本来就已经配好了
 *   imported —— 刚从 DSH 凭据库自动导入成功（用户什么都不用做）
 *   missing  —— 确实没有，需要人工配置（弹向导或手填）
 */
export function ensureApiKeys(root) {
  if (hasApiKeys(root)) return 'ok';

  // 装了 DSH 且配过 key：直接导入，省得用户手抄一遍
  if (existsSync(DSH_CRED)) {
    const importer = resolve(root, 'src', 'import-dsh-credentials.mjs');
    if (existsSync(importer)) {
      const r = spawnSync(process.execPath, [importer, '--write'], {
        cwd: root, stdio: 'pipe', encoding: 'utf8',
      });
      if (r.status === 0 && hasApiKeys(root)) return 'imported';
    }
  }

  return 'missing';
}
