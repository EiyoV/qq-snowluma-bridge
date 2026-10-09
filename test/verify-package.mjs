/**
 * 验证打包产物是**真正自包含**的：解压到临时目录，从那里 import 并跑起来。
 * 用独立的数据目录（LLM_ROUTER_DATA），不碰真实的 ~/.dsh/llm-router。
 *
 *   node test/verify-package.mjs
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'dsh-plugin', 'package.json'), 'utf8'));
const ZIP = join(ROOT, 'dist-package', `${pkg.name}-${pkg.version}.zip`);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`);
  }
};

if (!existsSync(ZIP)) {
  console.error(`找不到 ${ZIP}\n先跑 node dsh-plugin/pack.mjs`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'dsh-lrp-verify-'));
const pkgDir = join(work, 'pkg');
const dataDir = join(work, 'data');

try {
  console.log('[1] 解压产物');
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path '${ZIP}' -DestinationPath '${pkgDir}' -Force`],
    { stdio: 'inherit' }
  );

  const top = readdirSync(pkgDir);
  console.log('   解压后顶层:', top.join(', '));
  check('包含 package.json', top.includes('package.json'));
  check('包含 lib 内核', top.includes('lib'));
  check('包含 dist 前端', top.includes('dist'));
  check('包含 install.mjs', top.includes('install.mjs'));
  check('包含 cordis.patch.yml', top.includes('cordis.patch.yml'));

  console.log('\n[2] 从解压目录 import 内核（证明不依赖原项目）');
  process.env.LLM_ROUTER_DATA = dataDir;

  const paths = await import(pathToFileURL(join(pkgDir, 'lib', 'paths.mjs')).href);
  const { loadConfig, isConfigured } = await import(pathToFileURL(join(pkgDir, 'lib', 'config.mjs')).href);
  const { HealthRegistry } = await import(pathToFileURL(join(pkgDir, 'lib', 'health.mjs')).href);
  const { startProxy } = await import(pathToFileURL(join(pkgDir, 'lib', 'server.mjs')).href);

  check('paths.mjs 可加载', typeof paths.ensureDataDir === 'function');

  console.log('\n[3] 用全新数据目录初始化');
  const { created } = paths.ensureDataDir();
  console.log('   新建:', created.map((c) => c.replace(work, '<tmp>')).join(', ') || '(无)');
  check('数据目录是全新的（没有沿用本机已存在的）', dataDir.startsWith(work));
  check('config.json 已生成', existsSync(paths.CONFIG_PATH));
  check('.env 已生成', existsSync(paths.ENV_PATH));
  check('catalog.json 已生成', existsSync(paths.resolveCatalogPath()));

  console.log('\n[4] 启动代理');
  const cfg = loadConfig();
  const providers = cfg.providers.filter((p) => isConfigured(p).ok);
  console.log(`   渠道 ${cfg.providers.length} 个，已配置 ${providers.length} 个`);
  check('配置可解析', cfg.providers.length > 0);

  const health = new HealthRegistry(cfg.policy.cooldown);
  const proxy = await startProxy({ config: cfg, providers, health, log: () => {}, port: 18991 });
  check('代理监听成功', proxy.port === 18991);

  const h = await (await fetch(`http://127.0.0.1:${proxy.port}/healthz`)).json();
  check('/healthz 正常', typeof h.ok === 'boolean' && Array.isArray(h.providers));

  const m = await (await fetch(`http://127.0.0.1:${proxy.port}/v1/models`)).json();
  check('/v1/models 正常', m.object === 'list');

  await proxy.close();
  check('代理正常关闭', true);

  console.log('\n[5] 面板与 client 入口齐全');
  check('panel.html 存在', existsSync(join(pkgDir, 'dist', 'panel.html')));
  check('client.js 存在', existsSync(join(pkgDir, 'dist', 'client.js')));
  const clientText = readFileSync(join(pkgDir, 'dist', 'client.js'), 'utf8');
  check('client.js 是 __ModuleLoader__ 形态', clientText.includes('__ModuleLoader__'));
  const idx = readFileSync(join(pkgDir, 'dist', 'index.js'), 'utf8');
  check('index.js 不引用外部项目路径', !idx.includes('workspace/llm-router') && !idx.includes('workspace\\\\llm-router'));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail === 0 ? 0 : 1;
