/**
 * 渠道自检探针：真正发一次最小请求，核实"能不能用、模型名对不对、能力声明准不准"。
 *
 *   npm run probe                    探测全部已配置渠道，只测文本
 *   npm run probe -- --vision        额外测图片输入（核实 image 能力声明）
 *   npm run probe -- --tools         额外测工具调用（核实 tools 能力声明）
 *   npm run probe -- --only=groq-free
 *   npm run probe -- --all           连未配置(缺key)的渠道也列出来
 *
 * 这是配置好一批 key 之后的第一件事 —— 模型名/接入点会过时，别靠猜。
 */
import { loadConfig, isConfigured } from './config.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const doVision = has('vision');
const doTools = has('tools');
const only = arg('only', null);
const timeoutMs = Number(arg('timeout', '45000'));

// 1×1 PNG，够用来判断"这个渠道认不认图片输入"
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TOOL_SPEC = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Return the current time. Call this when the user asks for the time.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

function buildBody({ vision, tools }) {
  const body = {
    messages: [
      vision
        ? {
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with exactly: OK' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
            ],
          }
        : { role: 'user', content: 'Reply with exactly: OK' },
    ],
    max_tokens: 16,
    stream: false,
  };
  if (tools) {
    body.tools = TOOL_SPEC;
    body.tool_choice = 'auto';
    body.messages = [{ role: 'user', content: 'What time is it right now? Use the tool.' }];
  }
  return body;
}

async function probe(provider, which) {
  const vision = which === 'vision';
  const tools = which === 'tools';
  const model = provider.defaultModel ?? provider.models[0];
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json', ...provider.headers };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...buildBody({ vision, tools }), model, ...provider.bodyPatch }),
      signal: ac.signal,
    });
    const ms = Date.now() - started;
    const text = (await res.text()).slice(0, 1500);
    let detail = '';
    let ok = res.ok;
    if (!res.ok) {
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message ?? j?.message ?? text.slice(0, 200);
      } catch {
        detail = text.slice(0, 200);
      }
    } else if (tools) {
      // 200 还不够：要看到真的返回了 tool_calls，才算支持工具调用
      let called = false;
      try {
        const j = JSON.parse(text);
        const msg = j?.choices?.[0]?.message;
        called = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
        if (!called) {
          detail = `200 但没返回 tool_calls（finish=${j?.choices?.[0]?.finish_reason ?? '?'}）→ 声明 tools 不可靠`;
          ok = false;
        }
      } catch {
        detail = '返回不是 JSON';
        ok = false;
      }
      if (called) detail = 'tool_calls ✓';
    } else {
      let content = '';
      try {
        const j = JSON.parse(text);
        content = String(j?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 40);
      } catch {
        content = text.slice(0, 40);
      }
      detail = content || '(空回复)';
    }
    return { ok, ms, status: res.status, detail, model };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, status: 0, detail: `连接失败: ${err?.message ?? err}`, model };
  } finally {
    clearTimeout(timer);
  }
}

const config = loadConfig();
const list = config.providers.filter((p) => (only ? p.id === only : true));

console.log(`探测 ${list.length} 个渠道（超时 ${timeoutMs}ms）${doVision ? ' + vision' : ''}${doTools ? ' + tools' : ''}\n`);

const rows = [];
for (const p of list) {
  const chk = isConfigured(p);
  if (!chk.ok) {
    rows.push({ 渠道: p.id, 项: '配置', 结果: `跳过（${chk.why}）`, 状态: '-', 耗时: '-', 模型: '-' });
    if (!has('all')) continue;
  }
  const checks = [['text', await probe(p, 'text')]];
  if (doVision) checks.push(['vision', await probe(p, 'vision')]);
  if (doTools) checks.push(['tools', await probe(p, 'tools')]);

  for (const [name, r] of checks) {
    rows.push({
      渠道: p.id,
      项: name,
      结果: `${r.ok ? '✓' : '✗'} ${r.detail}`.slice(0, 70),
      状态: r.status || 'ERR',
      耗时: `${r.ms}ms`,
      模型: r.model ?? '-',
    });
  }
}

console.table(rows);

const bad = rows.filter((r) => r.结果.startsWith('✗'));
if (bad.length > 0) {
  console.log(`\n有 ${bad.length} 项没通过。常见原因：模型名过时（去官方文档核对）、该渠道免费模型已下线、网络不可达、能力声明写错。`);
  console.log('如果只是"声明了但实际不支持"，把 config.json 里对应渠道的 capabilities 改准即可。');
} else {
  console.log('\n全部通过。');
}
