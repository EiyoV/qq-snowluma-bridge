/**
 * 给启动器用的 key 检测探针。
 *
 *   node scripts/check-config.mjs
 *
 * 退出码：0 = 已配置至少一个真实 API key；1 = 还没配置。
 * VBS 靠这个返回码决定要不要弹配置向导。
 */

import { resolve } from 'node:path';
import { hasApiKeys } from './lib/ensure-config.mjs';

const ROOT = resolve(import.meta.dirname, '..');
process.exit(hasApiKeys(ROOT) ? 0 : 1);
