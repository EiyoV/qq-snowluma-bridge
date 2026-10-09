/**
 * 查看正在运行的 llm-router 的池状态：
 *   npm run status
 *   npm run status -- --port 8787
 */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const host = arg('host', '127.0.0.1');
const port = arg('port', '8787');
const url = `http://${host}:${port}/healthz`;

function fmtMs(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

try {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`GET ${url} → HTTP ${res.status}`);
    process.exit(1);
  }
  const j = await res.json();
  console.log(`llm-router @ http://${host}:${port}   总状态: ${j.ok ? '可用' : '全部不可用'}   ${j.now}\n`);

  const rows = j.providers.map((p) => ({
    渠道: p.id,
    优先级: p.priority,
    可用: p.available ? (p.coolingMs ? '是' : '是') : `冷却 ${fmtMs(p.coolingMs)}`,
    能力: p.capabilities.join('+'),
    模型: p.models[0] ?? '-',
    请求: p.requests,
    成功: p.ok,
    失败: p.failures,
    token: p.tokens,
    最近错误: (p.lastError ?? '').slice(0, 40),
  }));
  console.table(rows);

  const cooling = j.providers.filter((p) => !p.available);
  if (cooling.length > 0) {
    console.log('\n冷却中的渠道：');
    for (const p of cooling) console.log(`  · ${p.id}  还需 ${fmtMs(p.coolingMs)}  ${p.lastError ?? ''}`);
  }
  const unconfigured = j.providers.filter((p) => !p.configured);
  if (unconfigured.length > 0) {
    console.log(`\n未配置（缺 key）的渠道：${unconfigured.map((p) => p.id).join(', ')}`);
  }
} catch (err) {
  console.error(`连不上 llm-router（${url}）：${err?.message ?? err}`);
  console.error('先确认它已经在跑：npm start');
  process.exit(1);
}
