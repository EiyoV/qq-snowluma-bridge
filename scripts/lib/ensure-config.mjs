/**
 * API key 检测（bot / start.mjs / check-config.mjs 共用）
 *
 * 为什么单独抽出来：启动入口有三个（VBS 静默、npm run start-all、npm run qq-bot2），
 * 检测规则必须一致，否则会出现"这个入口说配好了、那个入口说没配"。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
