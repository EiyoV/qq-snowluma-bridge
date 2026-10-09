# llm-router

零依赖的 **OpenAI 兼容多 provider 自动 fallback 代理**：把一堆免费额度 + 本地模型合成一个"看起来用不完"的 token 池，对外只暴露一个标准端点。

```
                    ┌──────────────────────────────────────────┐
  你的程序  ──────►  │  llm-router  (127.0.0.1:8787/v1)         │
  (手机自动化循环、  │                                          │
   QQ bot、DSH…)    │  1. 看请求要什么能力(文字/图片/工具)     │
                    │  2. 按优先级排队，跳过正在冷却的渠道      │
                    │  3. 上游 429/5xx/超时/空流 → 换下一个     │
                    │  4. 标记冷却，到期自动放回               │
                    └───────────────┬──────────────────────────┘
                                    │
        ┌───────────┬───────────┬───┴───────┬───────────┬──────────┐
        ▼           ▼           ▼           ▼           ▼          ▼
     智谱GLM     硅基流动    Gemini      Groq      OpenRouter   本机Ollama
     (免费)      (免费)      (免费层)   (免费层)    (:free)     (真·无限兜底)
```

## 它解决什么

免费额度单独用都很快撞墙：每个渠道各有 RPM/TPM/日限额，而 agent 循环（尤其**每步都要送一张截图**的视觉循环）烧 token 极快，单个免费渠道跑不了几轮就 429。
llm-router 把多个渠道合成一个池子：谁限流了自动换下一个，全都在冷却就走本地模型。

## 它**不**解决什么（重要，别误解）

- **不产生 token。** 免费额度仍然要你本人去各家注册领取 —— 每个渠道都要手机号/实名，有些要绑卡。没有任何工具能"一键接入"你没有的额度。
- **不绕过任何平台限制。** 它只在你**合法拥有的多个渠道**之间调度。**不做多账号轮换薅免费额度** —— 那违反各家服务商条款，结局是 key 批量封禁，不是"永远白嫖"。
- **免费层是有限的。** 真正"永远够用"的那一层是**本地模型**；云端免费额度只负责提高质量，不是主力。
- **不做风控对抗。** 不伪造设备指纹、不模拟触摸轨迹。

## 快速开始

```powershell
cd E:\工程\AI\workspace\llm-router
Copy-Item config.example.json config.json
Copy-Item .env.example .env          # 然后把各渠道 key 填进去
npm run probe                        # 先核实哪些渠道真能用（不用它也能跳过这步）
npm start                            # 起代理，监听 127.0.0.1:8787
```

另开一个终端：

```powershell
npm run status                       # 看池子状态：谁可用、谁冷却、烧了多少 token
npm run discover                     # 看还该注册哪些渠道（含注册地址、需要的材料、核实到的坑）
npm run discover -- --openrouter     # 实时发现新的零价模型（唯一能全自动发现的渠道）
npm run discover -- --openrouter --update   # 发现并写入 config.json（自动备份）
```

### 自测（不需要任何 key）

```powershell
node test/run-tests.mjs
```

用假上游验证 fallback / 能力路由 / 冷却 / 流式接管等 27 项断言，不消耗任何真实额度。

## 怎么调用

任何 OpenAI 兼容客户端，`base_url` 指向 `http://127.0.0.1:8787/v1`。

`model` 字段的三种用法：

| 写法 | 含义 |
|---|---|
| `auto` | 自动排队（默认）。给负载均衡用 |
| `auto:vision` | 自动排队，但**强制要求图片能力** |
| `auto:tools` | 自动排队，但强制要求工具调用能力 |
| `groq-free::llama-3.3-70b-versatile` | 锁定某个渠道的某个模型，不走 fallback |
| `<某个已声明的模型名>` | 在所有声明了它的渠道里排队 |

**能力路由是刚需，不是优化**：往纯文本渠道发图片，火山/通义这类会返回 **200 然后开始瞎编**，比直接报错危险得多。所以请求里带 `image_url` 时，代理只会选 `capabilities` 含 `image` 的渠道。

## 管理端点

| 路径 | 说明 |
|---|---|
| `GET /healthz` | 池子状态 JSON（可用性、冷却剩余、请求数、token 用量） |
| `GET /v1/models` | 列出所有渠道的模型，id 形如 `providerId::model` |
| `GET /admin/clear?id=<providerId>` | 手动解除某渠道冷却 |

## 冷却策略

失败按类型区分退避，连续失败指数放大，成功一次立刻清零：

| 失败类型 | 初始冷却 | 理由 |
|---|---|---|
| `429` 限流 | 60s（上游给了 `Retry-After` 就听它的） | 免费额度窗口型，到点即恢复 |
| `5xx` / 网络 / 超时 / 空流 | 20s | 多数是瞬时抖动 |
| `401/402/403` key 失效或余额耗尽 | 30min | 别让它每个请求都白等一轮超时 |
| `400/404` 模型名不对 | 5s | 不放大——这是配置问题，不是渠道挂了 |

全部渠道都在冷却时，`policy.onAllCooling` 决定行为：`force-local`（默认，硬用本地模型顶住）、`force-any`（挑冷却最短的硬试）、`fail`（直接报错）。

## DSH 面板（图形界面）

配套插件在 `dsh-plugin/`，把渠道池挂到 DSH 自己的 web 服务上：

**http://127.0.0.1:19387/llm-router**

面板能看：每个渠道是否可用 / 冷却剩多久 / 请求·成功·失败次数 / 累计 token / 最近错误，
以及**还该注册哪个渠道**（注册地址、需要的材料、我核实到的坑）。
还能一键：解除全部冷却、探测渠道、发现新免费模型并写入配置。

安装 / 更新：

```powershell
powershell -ExecutionPolicy Bypass -File .\dsh-plugin\install.ps1
```

它放在 profile 的安装级 fallback（`$DSH_HOME/profiles/node_modules`），
**不需要 pnpm、也不需要改 profile 的 `package.json`** —— 挂载靠 `cordis.patch.yml` 里的 `insert`。
详见 [dsh-plugin/README.md](dsh-plugin/README.md)。

## 接到别的程序上

**接到 DSH**：在 profile 的 `cordis.patch.yml` 里加一条路由，`baseURL` 指 `http://127.0.0.1:8787/v1`、`api: openai-completions`。注意手写模型必须同时给 `contextWindow`/`maxTokens`，且**不能瞎猜**（猜小了输出会被钳成 1 个 token）。

**接到手机自动化循环**：直接对 `http://127.0.0.1:8787/v1/chat/completions` 发请求，`model` 用 `auto:vision`。

## 目录

```
src/config.mjs   配置加载（config.json + .env，零依赖）
src/health.mjs   冷却与健康状态
src/pool.mjs     候选选择：能力过滤 + 优先级 + 冷却跳过
src/index.mjs    HTTP 服务与 fallback 主循环
src/probe.mjs    渠道自检探针（真实发请求，核实模型名和能力声明）
src/status.mjs   池子状态查看
test/            假上游 + 27 项自测
```

## 安全

- `config.json` 和 `.env` 已在 `.gitignore` 里，**不要**把 key 提交进 git。
- 代理默认只监听 `127.0.0.1`，不对外暴露。要改 `server.host` 之前先想清楚：它会把你的所有 key 变成一个对内网开放的入口。
- `GET /admin/clear` 没有鉴权，但只监听本机；如果改了监听地址，请自行加一层。

---

## QQ 机器人一键部署（新电脑从零开始）

整套链路：**QQ 客户端 → SnowLuma（协议网关）→ `qq-snowluma-bot.mjs`（桥）→ llm-router（AI 大脑）**

```
npm run start-all
```

一个命令完成：检测/自动下载安装 SnowLuma → 启动 → 等你扫码登录 → 自动读取 WS token → 启动桥接 bot（自动拉起 llm-router）。

### 首次使用（新电脑）

```powershell
git clone <你的 llm-router 仓库>
cd llm-router
npm install
npm run start-all
```

`npm run start-all` 会自动完成全部步骤：
1. **配置 API key**（自动选最优路径，见下方）
2. 自动下载安装 SnowLuma（首次）
3. 启动 SnowLuma
4. 等你扫码登录 QQ
5. 自动读取 token，启动机器人

### API key 怎么填（全自动）

`npm run start-all` 启动时会自动检测，**三选一**：

| 你的情况 | 自动行为 | 你要做什么 |
|---|---|---|
| **装了 DSH 且在 DSH 配过 key** | 自动从 DSH 凭据库导入全部 key | 什么都不用做 ✅ |
| **没装 DSH / DSH 没配 key** | 启动交互式配置向导 | 按提示逐个粘贴 key |
| **已经配过了** | 直接跳过 | 什么都不用做 ✅ |

交互向导长这样：
```
🤖 llm-router 配置向导

── 国内直连 ──
  硅基流动 [SILICONFLOW_API_KEY]
  注册地址: api.siliconflow.cn
  粘贴 key（回车跳过）: sk-xxxx
  ✅ 已保存
```

也可以单独运行：
```powershell
npm run setup          # 手动调出交互向导
npm run import-dsh -- --write   # 手动从 DSH 导入
```

### 日常启动

```powershell
npm run start-all        # 全部拉起（SnowLuma 已装则直接启动）
npm run setup            # 重新配置 API key
npm run qq-bot2          # 只跑桥接（SnowLuma 已在别的终端跑着时）
```

### 无窗口静默运行（推荐）

不想留个黑终端窗口时：

1. 先启动 SnowLuma 并登录 QQ（这步必须手动）
2. **双击 `启动机器人(静默).vbs`** —— 桥接在后台运行，没有任何窗口
3. 停止：右键 `停止机器人.ps1` → 使用 PowerShell 运行

桥接会**自动读取** SnowLuma 的 WS 地址和 token（从 `snowluma-pkg/app/config/onebot_*.json`），无需手动配置。

想开机就自动上线：运行一次 `开启开机自启.ps1`（取消用 `关闭开机自启.ps1`）。
注意开机自启只拉起桥接，SnowLuma 仍需手动开。

### 更新 SnowLuma

```powershell
npm run update-snowluma  # 强制重下最新版，自动保留登录配置
```

### 人格模板（怎么改机器人性格）

编辑 `qq-snowluma-bot.mjs` 里的 `buildSystemPrompt()`：

- **【你是谁】** —— 名字、身份、背景故事
- **【说话方式】** —— 口语/短句/是否带 emoji、群聊规则
- **【管理员规则】** —— 通过环境变量 `OWNER_QQ` 指定（如 `OWNER_QQ=1234567 npm run qq-bot2`），管理员消息必回、群里也一样

只改这一处，重启即生效（`npm run start-all` 或重启 `qq-bot2`）。

### 可选环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SNOWLUMA_WS_URL` | `ws://127.0.0.1:3001` | SnowLuma WS 地址（一键启动会自动填） |
| `SNOWLUMA_TOKEN` | 空 | OneBot WS accessToken（一键启动会自动填） |
| `OWNER_QQ` | 未设置 | 管理员 QQ 号，消息必回 |
| `LLM_ROUTER_URL` | 从 config.json 读 | 覆盖 llm-router 端点 |
