/**
 * llm-router —— 零依赖 OpenAI 兼容多 provider 自动 fallback 代理。
 *
 *   POST /v1/chat/completions   OpenAI 兼容；model 可为 auto / auto:vision / <providerId>::<model>
 *   GET  /v1/models             列出所有渠道的模型（id 形如 providerId::model）
 *   GET  /healthz               池状态：谁可用、谁在冷却、用了多少 token
 *   GET  /admin/clear?id=xxx    手动解除某渠道冷却
 *
 * 关键语义：只有在"尚未向客户端写出任何字节"之前发生的失败才允许换渠道，
 * 所以流式请求会先等上游第一个 chunk 落地，再写客户端响应头 —— 那样 429/5xx
 * 都能被安全接管；一旦开始透传就只能如实报错，不能重放（否则客户端收到半截就重来）。
 */
import http from 'node:http';
import { loadConfig, isConfigured, parseModelSpec } from './config.mjs';
import { HealthRegistry, classifyStatus, FAIL } from './health.mjs';
import { selectCandidates, inferNeeds, describeCandidates } from './pool.mjs';

const MAX_BODY_BYTES = 48 * 1024 * 1024; // 带 base64 图片的请求可以很大

function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 从上游错误响应里尽量挖出可读信息。 */
async function describeUpstreamError(res) {
  let text = '';
  try {
    text = (await res.text()).slice(0, 800);
  } catch {
    /* 读不到就算了 */
  }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message ?? j?.message ?? j?.error ?? text;
  } catch {
    /* 不是 JSON，用原文 */
  }
  const retryAfter = res.headers.get('retry-after');
  let retryAfterMs;
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - Date.now());
    }
  }
  return { message: String(msg ?? '').slice(0, 400), retryAfterMs };
}

async function callUpstream({ provider, model, body, apiKey, timeoutMs, signal }) {
  const url = `${provider.baseURL}/chat/completions`;
  const headers = { 'content-type': 'application/json', ...provider.headers };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const payload = { ...body, model, ...provider.bodyPatch };

  const ac = new AbortController();
  const onAbort = () => ac.abort(new Error('client disconnected'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(new Error(`上游超时 ${timeoutMs}ms`)), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    return { res, clearTimer: () => clearTimeout(timer), detach: () => signal?.removeEventListener('abort', onAbort) };
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw err;
  }
}

/**
 * 把 SSE 从上游透传到客户端；返回结束原因与累计的 usage（如果有）。
 * 注意 reader 由调用方传入：首包探测已经 getReader() 锁定了这条流，
 * 这里再取一次会抛 "Invalid state: ReadableStream is locked"。
 */
async function pipeStream(reader, clientRes, firstChunk) {
  let tail = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  clientRes.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const push = (value) => {
    clientRes.write(value);
    // 只在尾部留一小段用于嗅探 usage；SSE 的 usage 是 ASCII，截断风险可忽略
    tail = (tail + decoder.decode(value, { stream: true })).slice(-8192);
  };

  if (firstChunk) push(firstChunk);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientRes.writableEnded) {
        await reader.cancel().catch(() => {});
        return { completed: false, aborted: true, usage: extractUsage(tail) };
      }
      push(value);
    }
  } catch (err) {
    clientRes.end();
    return { completed: false, error: err, usage: extractUsage(tail) };
  }

  clientRes.end();
  return { completed: true, usage: extractUsage(tail) };
}

function extractUsage(text) {
  const idx = text.lastIndexOf('"usage"');
  if (idx < 0) return null;
  const start = text.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function handleChat(req, res, ctx) {
  const { config, health, providers } = ctx;

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return sendJson(res, 400, { error: { message: `请求体解析失败：${err.message}`, type: 'invalid_request_error' } });
  }

  let spec;
  try {
    spec = parseModelSpec(body?.model, providers);
  } catch (err) {
    return sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
  }

  const needs = inferNeeds(body);
  if (spec.needs) for (const n of spec.needs) needs.add(n);

  const { candidates, rejected } = selectCandidates({
    providers,
    health,
    spec,
    needs,
    policy: config.policy,
  });

  const wantStream = Boolean(body?.stream);
  log(
    `→ ${wantStream ? 'stream' : 'sync'} model=${body?.model ?? 'auto'}` +
      (needs.size ? ` needs=[${[...needs].join(',')}]` : '') +
      ` | 候选 ${describeCandidates(candidates)}`
  );
  if (candidates.length === 0) {
    return sendJson(res, 503, {
      error: {
        message: `没有可用上游。${rejected.length ? `被排除：${rejected.map((r) => `${r.id}(${r.why})`).join('; ')}` : '所有渠道都在冷却中'}`,
        type: 'no_upstream_available',
      },
    });
  }

  const clientAc = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAc.abort();
  });

  const attempts = Math.min(config.policy.maxAttempts, candidates.length);
  const failures = [];

  for (let i = 0; i < attempts; i += 1) {
    const { provider, model, forced } = candidates[i];
    health.markRequest(provider.id);

    const timeoutMs = wantStream ? config.policy.connectTimeoutMs : config.policy.requestTimeoutMs;

    let upstream;
    try {
      upstream = await callUpstream({
        provider,
        model,
        body,
        apiKey: provider.apiKey,
        timeoutMs,
        signal: clientAc.signal,
      });
    } catch (err) {
      const wait = health.markFailure(provider.id, FAIL.network, { message: String(err?.message ?? err) });
      failures.push(`${provider.id}: ${err?.message ?? err}`);
      log(`   ✗ ${provider.id} 网络/超时失败，冷却 ${Math.round(wait / 1000)}s`);
      continue;
    }

    const { res: up, clearTimer, detach } = upstream;

    if (!up.ok) {
      const kind = classifyStatus(up.status) ?? FAIL.serverError;
      const detail = await describeUpstreamError(up);
      clearTimer();
      detach();
      const wait = health.markFailure(provider.id, kind, detail);
      failures.push(`${provider.id}: HTTP ${up.status} ${detail.message}`);
      log(`   ✗ ${provider.id} HTTP ${up.status} (${kind})，冷却 ${Math.round(wait / 1000)}s — ${detail.message.slice(0, 120)}`);
      continue;
    }

    if (wantStream) {
      // 先等上游首个 chunk：这样"200 但立刻报错"也能被接管
      const reader = up.body.getReader();
      let first;
      try {
        first = await reader.read();
      } catch (err) {
        clearTimer();
        detach();
        const wait = health.markFailure(provider.id, FAIL.serverError, { message: String(err?.message ?? err) });
        failures.push(`${provider.id}: 首包失败 ${err?.message ?? err}`);
        log(`   ✗ ${provider.id} 首包失败，冷却 ${Math.round(wait / 1000)}s`);
        continue;
      }
      if (first.done) {
        clearTimer();
        detach();
        const wait = health.markFailure(provider.id, FAIL.empty, { message: '上游返回空流' });
        failures.push(`${provider.id}: 空流`);
        log(`   ✗ ${provider.id} 空流，冷却 ${Math.round(wait / 1000)}s`);
        continue;
      }

      clearTimer();
      // 流已经开始，客户端连接不再允许中途 abort 我们（否则半截响应无法重放）
      detach();
      log(`   ✓ ${provider.id}${forced ? ' (强制)' : ''} 开始流式透传`);
      const outcome = await pipeStream(reader, res, first.value);
      if (outcome.completed) {
        health.markSuccess(provider.id, outcome.usage);
        log(`   ✓ ${provider.id} 流结束`);
      } else {
        health.markFailure(provider.id, FAIL.serverError, { message: '流中途中断' });
        log(`   ✗ ${provider.id} 流中途中断`);
      }
      return;
    }

    // 非流式：整体读完后一次性回给客户端
    let text;
    try {
      text = await up.text();
    } catch (err) {
      clearTimer();
      detach();
      const wait = health.markFailure(provider.id, FAIL.network, { message: String(err?.message ?? err) });
      failures.push(`${provider.id}: 读响应失败`);
      log(`   ✗ ${provider.id} 读响应失败，冷却 ${Math.round(wait / 1000)}s`);
      continue;
    }
    clearTimer();
    detach();

    let usage = null;
    try {
      usage = JSON.parse(text)?.usage ?? null;
    } catch {
      /* 上游返回了非 JSON，原样透传，但我们自己的 usage 记不到 */
    }
    health.markSuccess(provider.id, usage);
    log(`   ✓ ${provider.id}${forced ? ' (强制)' : ''} 200${usage ? ` tokens=${usage.total_tokens ?? '?'}` : ''}`);

    if (res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
    return;
  }

  const retry = candidates
    .slice(0, attempts)
    .map((c) => health.retryAfterMs(c.provider.id))
    .filter((ms) => ms > 0);
  const soonest = retry.length > 0 ? Math.min(...retry) : null;

  sendJson(res, 502, {
    error: {
      message:
        `所有候选上游都失败了（试了 ${attempts} 个）。\n` +
        failures.map((f) => `  · ${f}`).join('\n') +
        (soonest !== null ? `\n最快 ${Math.round(soonest / 1000)}s 后有渠道恢复。` : ''),
      type: 'all_upstreams_failed',
      attempts: failures,
    },
  });
}

function handleModels(res, providers) {
  const now = Math.floor(Date.now() / 1000);
  const data = [];
  for (const p of providers) {
    const models = p.models.length > 0 ? p.models : p.defaultModel ? [p.defaultModel] : [];
    for (const m of models) {
      data.push({
        id: `${p.id}::${m}`,
        object: 'model',
        created: now,
        owned_by: p.label,
      });
    }
  }
  sendJson(res, 200, { object: 'list', data });
}

function handleHealth(res, ctx) {
  const { config, health, providers } = ctx;
  const snap = new Map(health.snapshot().map((s) => [s.id, s]));
  const rows = providers.map((p) => {
    const s = snap.get(p.id);
    return {
      id: p.id,
      label: p.label,
      priority: p.priority,
      capabilities: p.capabilities,
      models: p.models.length > 0 ? p.models : p.defaultModel ? [p.defaultModel] : [],
      local: p.isLocal,
      available: s ? s.available : true,
      coolingMs: s ? s.coolingMs : 0,
      lastError: s?.lastError ?? null,
      requests: s?.totalRequests ?? 0,
      ok: s?.totalOk ?? 0,
      failures: s?.totalFailures ?? 0,
      tokens: s?.usage?.totalTokens ?? 0,
      configured: isConfigured(p).ok,
    };
  });
  sendJson(res, 200, {
    ok: rows.some((r) => r.available && r.configured),
    now: new Date().toISOString(),
    policy: config.policy,
    providers: rows,
  });
}

function main() {
  const config = loadConfig();
  const health = new HealthRegistry(config.policy.cooldown);

  const providers = [];
  const skipped = [];
  for (const p of config.providers) {
    const chk = isConfigured(p);
    if (chk.ok) providers.push(p);
    else skipped.push(`${p.id} (${chk.why})`);
  }

  if (providers.length === 0) {
    console.error('没有任何已配置好的渠道。请检查 .env 里的 key 与 config.json 的 apiKeyEnv 对应关系。');
    process.exit(1);
  }

  const ctx = { config, health, providers };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      handleChat(req, res, ctx).catch((err) => {
        log('未捕获异常：', err);
        sendJson(res, 500, { error: { message: String(err?.message ?? err), type: 'internal_error' } });
      });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return handleModels(res, providers);
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return handleHealth(res, ctx);
    }

    if (req.method === 'GET' && url.pathname === '/admin/clear') {
      const id = url.searchParams.get('id');
      if (id) {
        health.clear(id);
      } else {
        // 不带 id 就清掉全部冷却（面板上的「解除全部冷却」）
        for (const s of health.snapshot()) health.clear(s.id);
      }
      return sendJson(res, 200, {
        cleared: id ?? 'all',
        state: health.snapshot().map((s) => ({ id: s.id, available: s.available })),
      });
    }

    sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}`, type: 'not_found' } });
  });

  server.listen(config.server.port, config.server.host, () => {
    log(`llm-router 监听 http://${config.server.host}:${config.server.port}`);
    log(`已启用渠道（${providers.length}）：${providers.map((p) => `${p.id}#${p.priority}`).join(', ')}`);
    if (skipped.length > 0) log(`已跳过：${skipped.join(', ')}`);
    log(`OpenAI 兼容端点：http://${config.server.host}:${config.server.port}/v1`);
  });

  const shutdown = () => {
    log('收到退出信号，关闭中…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
