# 把 llm-router 注册成开机自启的计划任务（可选）
#
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1           # 安装并立即启动
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove   # 卸载
#
# 说明：计划任务在「用户登录时」触发，因为 node 路径与 .env 都是当前用户的。
# 它不会以 SYSTEM 身份运行 —— 那样读不到你的 key，也会让你看不到日志。

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$TaskName = 'llm-router'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已卸载计划任务 $TaskName" -ForegroundColor Yellow
    } else {
        Write-Host "没有找到计划任务 $TaskName" -ForegroundColor Yellow
    }
    exit 0
}

if (-not $Node) { throw '找不到 node，请先把 Node.js 加进 PATH' }
if (-not (Test-Path (Join-Path $Root 'config.json'))) {
    throw '还没有 config.json，请先从 config.example.json 复制一份并填好 key'
}

$action = New-ScheduledTaskAction `
    -Execute $Node `
    -Argument 'src\index.mjs' `
    -WorkingDirectory $Root

# 登录后延迟 30 秒启动（别和系统启动抢资源）；崩了自动重启，最多 3 次
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'llm-router：本地 OpenAI 兼容多渠道路由代理' `
    -Force | Out-Null

Write-Host "已注册计划任务 $TaskName（登录后 30 秒自动启动）" -ForegroundColor Green
Start-ScheduledTask -TaskName $TaskName
Write-Host "已立即启动。查看状态：npm run status" -ForegroundColor Green
