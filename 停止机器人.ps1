# 停止后台运行的 QQ 机器人（只杀 qq-snowluma-bot.mjs，不动 SnowLuma / llm-router）
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root 'qq-snowluma-bot.mjs'

$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*qq-snowluma-bot.mjs*" }

if (-not $procs) {
  Write-Host "没有检测到正在运行的 QQ 机器人。" -ForegroundColor Yellow
  exit 0
}

foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "已停止 PID $($p.ProcessId)" -ForegroundColor Green
}
Write-Host "QQ 机器人已停止（SnowLuma 不受影响）。" -ForegroundColor Green
