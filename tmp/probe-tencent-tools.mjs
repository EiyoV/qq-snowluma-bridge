/**
 * 一次性工具（不进包）：验证腾讯 TokenHub 的模型是否支持 function calling。
 *
 * 为什么要单独验：DSH 的 agent 请求带 tools。如果某个模型不支持，
 * 往它发带 tools 的请求会 400，而声明 capabilities 时写错了比不写更危险。
 */
import { loadEnvFile } from '../dsh-plugin/lib/config.mjs';

const BASE = 'https://tokenhub.tencentmaas.com/v1';
const env = loadEnvFile(process.env.USERPROFILE + '/.dsh/llm-router/.env');
const key = env.TENCENT_TOKENHUB_API_KEY;
if (!key) {
  console.error('没有 TENCENT_TOKENHUB_API_KEY');
  process.exit(1);
}

const MODELS = [
  'deepseek/deepseek-flash',
  'deepseek-v4-pro',
  'glm-5.3-flash',
  'kimi-k2.6',
  'hy4-preview',
  'mimo-v2.6-flash',
  'step-5-preview',
];

const BODY = (model) => ({
  model,
  messages: [{ role: 'user', content: '北京现在天气怎么样？用工具查一下。' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市的天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    },
  ],
  max_tokens: 128,
});

for (const model of MODELS) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(BODY(model)),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    let note = text.slice(0, 140);
    if (r.ok) {
      try {
        const j = JSON.parse(text);
        const msg = j.choices?.[0]?.message ?? {};
        const calls = msg.tool_calls ?? [];
        note = calls.length
          ? `✅ tool_calls: ${calls.map((c) => c.function?.name).join(',')}`
          : `⚠️ 没有 tool_calls（正文前 60 字：${String(msg.content ?? '').slice(0, 60)}）`;
      } catch {
        /* 保留原文 */
      }
    }
    console.log(`${String(r.status).padStart(4)}  ${model.padEnd(32)} ${Date.now() - t0}ms  ${note}`);
  } catch (err) {
    console.log(` ERR  ${model.padEnd(32)} ${err.message.slice(0, 100)}`);
  }
}
