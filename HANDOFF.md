# 交接文档：QQ 聊天接入

> 这份是给**新会话**看的。目标：让一个上下文为空、能力有限的模型也能接上手。
> **只读这一份 + 它指向的文件就够了，不要通读整个项目。**

## 一句话

token 供给已经彻底做完（llm-router 已发布到 GitHub，`master` 之外的插件仓库在 `dsh-plugin/`），
现在要用它驱动 **QQ 聊天接入**（真机 + ADB）。

## 环境现状（2026-10-10 实测）

代理已跑在 **http://127.0.0.1:8787/v1**（OpenAI 兼容），面板在 **http://127.0.0.1:19387/llm-router**。
渠道池 **12 个**，全部可用：

| 渠道 | 能力 | 额度护栏 | 备注 |
|---|---|---|---|
| `tencent-tokenhub` | text+tools | 100 万/账号，软 80% 硬 90% | 24 个模型各自独立（DeepSeek-V4-Pro / GLM-5.3 / Kimi / MiniMax…），前 7 个已验证 function calling |
| `tencent-vision` | **text+image** | 与上面**共享**同一份额度（`limits.group`） | **混元 T1-Vision，截图识别首选：能识图且 reasoning=0（不烧思考 token）** |
| `ark-endpoints` | text+tools | **每模型每天 200 万**，软 90% 硬 95% | 火山 10 个接入点，`limits.perModel` 各自记账，烧完一个自动换下一个 |
| `dashscope-text` | text+tools | 每模型 100 万 / 90 天 | 百炼，`perModel` |
| `dashscope-vision` | text+image | 未设额度（不熔断） | 百炼视觉 |
| `zhipu-text` / `zhipu-vision` | text / text+image | 未设额度（**限流型，无总量**） | 永久免费 Flash 模型，撞 429 自己恢复 |
| `qianfan-text` / `qianfan-vision` | text / text+image | 100 万（**账号级保守算**） | 官方对"是否按模型独立"说法矛盾，宁可少用 |
| `siliconflow` | text+tools | 未设额度（限流型） | 免费模型 |
| `ark-coding-plan` | text+image+tools | 未设额度 | **订阅制**，`manualOnly`，超额只报 429 不会欠费 |
| `openrouter` | text+image+tools | `balance: true`，平台自报余额 | 需海外网络 |

## 已经做完的（不要重做）

| 资产 | 位置 | 说明 |
|---|---|---|
| 代理内核 | `dsh-plugin/lib/` | 多渠道池、fallback、能力路由、成本排序 |
| **额度熔断** | `dsh-plugin/lib/budget.mjs` | **事前**：软阈值降排序 / 硬阈值停用（兜底也不捞回）；用量存 `~/.dsh/llm-router/usage.json` 跨重启保留 |
| **多模型分账** | `limits.perModel` | 一个渠道下多模型各自记额度，烧完自动换下一个；429/404 只冷那一个模型 |
| **共享额度组** | `limits.group` | 同一账号的多渠道共用一份计数器（腾讯文本+视觉就是） |
| 面板 | `/llm-router` | 渠道状态 / 额度列 / 改 key / 探测 / 重置用量 |
| GitHub | github.com/EiyoV/dsh-free-tier-router | 本地 `dsh-plugin/` 就是它的工作副本，`git push` 即可 |

**不要重做**：额度熔断、模型级切换、腾讯/火山渠道配置、渠道目录（`catalog.json`）。
**不要碰**：`workspace/endless-walk*`、`workspace/pet-idle`（另一个项目）。

## 先验证环境是好的（第一步就跑这个）

```powershell
cd E:\工程\AI\workspace\llm-router
node dsh-plugin\test\smoke.mjs          # 期望「通过 11 项，失败 0 项」
node dsh-plugin\test\run-tests.mjs      # 期望「通过 70 项，失败 0 项」
node dsh-plugin\test\check-secrets.mjs  # 期望「通过 1 项」
```

跑不过就别往下做，先修环境。

## 怎么用它调模型（做 QQ 机器人会用到）

```powershell
# 不带图：让代理自己按优先级挑
curl http://127.0.0.1:8787/v1/chat/completions -H "content-type: application/json" `
  -d '{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'

# 带图（截图识别）：写 auto 就会自动路由到声明了 image 的渠道
#   content 里放 [{type:"text"...},{type:"image_url",image_url:{url:"data:image/png;base64,..."}}]

# 点名渠道/模型：model = "<providerId>::<model>"
#   例：tencent-vision::hunyuan-t1-vision-20250916
```

## 下一步：QQ 接入

**方向已定**：**真机 + ADB**。不用官方机器人 —— 那样只能拿到"机器人"形态，
而用户要的是**普通 QQ 号**。

**风险已告知且用户明确接受**：个人 QQ 挂自动化有封号风险；**必须真机**（模拟器风险高得多）；
验证码/人脸只能人工过。**新会话不要再重复劝说**，但**也不要承诺不封号**。

### 建议的第一步：先做手机自动化底座，别直接上 QQ

1. 连真机：`adb devices` 要能看到设备
2. 截图：`adb exec-out screencap -p > shot.png`
3. 控件树：`adb shell uiautomator dump /sdcard/ui.xml` 然后 `adb pull`
4. 操作：`adb shell input tap X Y` / `adb shell input text "xxx"` / `input swipe`

**先在安全目标上验证闭环**（记事本、计算器），证明"看得懂屏幕 → 点得准 → 能连续多步"，
再考虑 QQ。底座与 QQ 无关，无论最后接不接都用得上，且零风险。

### 还没确认的（开工前先问用户）

- 手机是什么系统？**Android 才能 ADB**，iOS 不行
- 手机能否一直连着电脑并保持唤醒？
- USB 还是无线 ADB？

## 成本提醒（做视觉循环前必看）

手机自动化**每步要送一张截图**。1080×2400 截图估算 **1000~3000 token/张**。

现在的额度比之前宽裕得多（火山 10 个模型 × 每天 200 万；腾讯 24 个模型 × 100 万），
但**截图仍然是最大的开销**，所以：

- **截图前先降分辨率**（1080×2400 → 540×1200，token 约降到 1/4）
- **只在必要时截图**，不要每步都截
- **别把历史截图反复塞进上下文** —— 这是最大的隐形浪费
- 用**不思考**的视觉模型：`hunyuan-t1-vision-20250916`（reasoning=0，实测最快最准）
  或 `qwen-vl-plus` / `ernie-4.5-turbo-vl`
- ⚠️ 火山那批**全是思考模型**，reasoning token 计入总量（实测说一句"你好"花 166 token，
  其中 118 是思考），别拿它们做高频截图循环

## 已知的坑（都踩过，别再踩）

1. **别用 PowerShell 写源码** —— 本机 `pwsh` 实际是 Windows PowerShell 5.1，
   写无 BOM 的 UTF-8 会破坏编码。改文件用编辑工具。
2. **改完插件必须重启 DSH 才生效**（Host 侧代码不会热重载；`panel.html` 例外，刷新即可）。
   配置改动则点面板「重新加载配置」就行。
3. **pnpm 装 `file:` 依赖时旧副本会导致新文件不同步** —— `install.mjs` 已自动先删再装。
4. **`manualOnly: true` 的渠道 auto 模式永不选中** —— 那是付费渠道的保护，别去改。
5. **往纯文本渠道发图片，它会 200 然后瞎编**（实测 `glm-5.3-flash` 对一张红图答"深红色"）。
   所以视觉模型必须单独成渠道并声明 `image`，能力过滤是硬规则。
6. **思考模型 + 小 max_tokens = 空回复**：推理和正文共享同一个 `max_tokens` 预算，
   给 16 个 token 会被思考全吃掉，正文是空的。
7. **火山接入点 ID 里 `rn`/`rm`、数字极易看错**（本项目抄错过一次：`rm9vx` vs `rn9vx`），复制粘贴最稳。
8. **火山欠费是账号级**：一旦欠费所有接入点一律 403（与额度无关）；而且余额 0 时因结算延迟
   仍可能产生欠费 —— 保住余额不为负，比任何插件熔断都硬。
9. **`~/.dsh/llm-router/.env` 里 key 是明文** —— 别复制到任何会被提交的地方。
10. **`fs-observation-policy` 会让编辑失败**（提示"file has not been read"）—— 先 `read` 再 `edit` 即可。

## 相关文件（按需读，别全读）

- `workspace/llm-router/dsh-plugin/docs/CONFIG.md` —— `config.json` 全字段（含 `limits` 熔断字段）
- `workspace/llm-router/dsh-plugin/docs/ARCHITECTURE.md` —— 关键设计决策的来由
- `workspace/llm-router/docs/providers-researched.md` —— 各平台额度调研结论（含"哪些不能当 API 用"）
- `workspace/llm-router/dsh-plugin/README.md` —— 插件安装与开发
- `~/.dsh/llm-router/config.json` —— 当前渠道配置
