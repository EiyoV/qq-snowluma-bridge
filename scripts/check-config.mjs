/**
 * 给启动器用的「确保有 API key」探针。
 *
 *   node scripts/check-config.mjs
 *
 * 退出码：0 = 已就绪（本来就有，或刚从 DSH 自动导入）；1 = 需要人工配置。
 * VBS 靠这个返回码决定要不要弹配置向导。
 */

import { resolve } from 'node:path';
import { ensureApiKeys } from './lib/ensure-config.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const state = ensureApiKeys(ROOT);

if (state === 'imported') console.log('✅ 已从 DSH 凭据库自动导入 API key');
if (state === 'missing') {
  console.log('⚠️ 没有检测到可用的 API key');
  process.exit(1);
}
