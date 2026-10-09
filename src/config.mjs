/**
 * 配置加载：零依赖。
 * - config.json 是数据（provider 清单、策略、冷却时长），不进 git 的那份是 config.json
 * - .env 只放密钥；key 的引用方式与 DSH 一致（apiKeyEnv 指向环境变量名）
 * - process.env 优先级高于 .env 文件，方便命令行临时覆盖
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：支持 KEY=VALUE、# 注释、成对引号。 */
export function loadEnvFile(path = resolve(ROOT, '.env')) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * API密钥.txt —— 给用户直接改的明文配置，比 .env 好找。
 * 里面带了模板示例值（your-xxx），必须跳过，否则会把 .env 里的真 key 覆盖掉。
 */
export function loadUserApiKeys(path = resolve(ROOT, 'API密钥.txt')) {
  const raw = loadEnvFile(path);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || /^(your-|sk-xxxx|xxxx)/i.test(v)) continue;
    out[k] = v;
  }
  return out;
}

function requireField(obj, field, where) {
  if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error(`配置错误：${where} 缺少字段 "${field}"`);
  }
  return obj[field];
}

/**
 * 读取并规范化配置。
 * @returns {{server:object, policy:object, providers:Array<object>, env:object}}
 */
export function loadConfig(configPath = process.env.LLM_ROUTER_CONFIG ?? resolve(ROOT, 'config.json')) {
  const fileEnv = loadEnvFile();
  // 优先级：process.env > API密钥.txt > .env
  // API密钥.txt 排在 .env 前面，这样用户改那个记事本就能覆盖 .env
  const env = { ...fileEnv, ...loadUserApiKeys(), ...process.env };

  if (!existsSync(configPath)) {
    throw new Error(
      `找不到 ${configPath}\n先把 config.example.json 复制成 config.json，再按 README 填渠道。`
    );
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`config.json 不是合法 JSON：${err.message}`);
  }

  const server = {
    host: raw.server?.host ?? '127.0.0.1',
    port: Number(raw.server?.port ?? 8787),
  };

  const policy = {
    // 单个客户端请求最多尝试几个上游（防止一路试到天荒地老）
    maxAttempts: Number(raw.policy?.maxAttempts ?? 6),
    // 上游等待首字节超时（毫秒）
    connectTimeoutMs: Number(raw.policy?.connectTimeoutMs ?? 20000),
    // 非流式整体超时
    requestTimeoutMs: Number(raw.policy?.requestTimeoutMs ?? 180000),
    // 无可用上游时的行为：'local-first' 会忽略冷却再试本地兜底
    onAllCooling: raw.policy?.onAllCooling ?? 'force-local',
    cooldown: {
      rateLimitMs: Number(raw.policy?.cooldown?.rateLimitMs ?? 60000),
      serverErrorMs: Number(raw.policy?.cooldown?.serverErrorMs ?? 20000),
      authErrorMs: Number(raw.policy?.cooldown?.authErrorMs ?? 30 * 60000),
      minMs: Number(raw.policy?.cooldown?.minMs ?? 5000),
      maxMs: Number(raw.policy?.cooldown?.maxMs ?? 60 * 60000),
    },
  };

  const list = raw.providers;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('配置错误：providers 必须是非空数组');
  }

  const seen = new Set();
  const providers = list.map((p, i) => {
    const where = `providers[${i}]`;
    const id = String(requireField(p, 'id', where));
    if (seen.has(id)) throw new Error(`配置错误：provider id 重复 "${id}"`);
    seen.add(id);

    const apiKeyEnv = p.apiKeyEnv ?? null;
    const apiKey = apiKeyEnv ? env[apiKeyEnv] ?? null : null;

    return {
      id,
      label: p.label ?? id,
      // 本地模型（Ollama）不需要 key
      isLocal: Boolean(p.local),
      apiKeyEnv,
      apiKey,
      enabled: p.enabled !== false,
      baseURL: String(requireField(p, 'baseURL', where)).replace(/\/+$/, ''),
      priority: Number(p.priority ?? 100),
      defaultModel: p.defaultModel ?? null,
      models: Array.isArray(p.models) ? p.models : [],
      // 'openai-completions' 之外先不支持，留字段便于以后加 anthropic 透传
      api: p.api ?? 'openai-completions',
      capabilities: Array.isArray(p.capabilities) ? p.capabilities : ['text'],
      // 该渠道已知的免费额度，仅用于展示与自检，不做强制限流（避免误伤）
      limits: p.limits ?? {},
      // 请求体补丁：某些渠道要求额外字段（如 OpenRouter 的 HTTP-Referer）
      headers: p.headers ?? {},
      bodyPatch: p.bodyPatch ?? {},
      notes: p.notes ?? '',
    };
  });

  return { server, policy, providers, env };
}

/**
 * 判断某个 provider 现在能不能用：启用 + 有密钥（或本地）+ 有模型。
 * 注意：这里不判断冷却，冷却是 health 的职责。
 */
export function isConfigured(p) {
  if (!p.enabled) return { ok: false, why: '已禁用' };
  if (!p.isLocal && p.apiKeyEnv && !p.apiKey) return { ok: false, why: `缺少 ${p.apiKeyEnv}` };
  if (p.models.length === 0 && !p.defaultModel) return { ok: false, why: '未配置模型' };
  return { ok: true, why: '' };
}

/** 解析请求里请求方要的模型：auto / auto:vision / providerId::model */
export function parseModelSpec(requested, providers) {
  const spec = String(requested ?? 'auto').trim();
  if (!spec || spec === 'auto') return { kind: 'auto', providerId: null, model: null, needs: null };
  if (spec.startsWith('auto:')) {
    const need = spec.slice(5).trim();
    return { kind: 'auto', providerId: null, model: null, needs: need ? [need] : null };
  }
  const idx = spec.indexOf('::');
  if (idx > 0) {
    const providerId = spec.slice(0, idx);
    const model = spec.slice(idx + 2);
    if (!providers.some((p) => p.id === providerId)) {
      throw new Error(`未知 provider "${providerId}"，可用：${providers.map((p) => p.id).join(', ')}`);
    }
    return { kind: 'exact', providerId, model, needs: null };
  }
  // 单纯给了个模型名：在所有渠道里找哪个声明了它
  const owners = providers.filter((p) => p.models.includes(spec) || p.defaultModel === spec);
  if (owners.length > 0) return { kind: 'model', providerId: null, model: spec, needs: null };
  return { kind: 'auto', providerId: null, model: null, needs: null };
}
