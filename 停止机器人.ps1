# Stop the background QQ bot (qq-snowluma-bot.mjs) plus its config wizard.
# SnowLuma (the QQ gateway) and llm-router are NOT touched.
#
# Easier: double-click 停止机器人.bat instead of running this file directly.

$ErrorActionPreference = 'SilentlyContinue'

$procs = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and (
      $_.CommandLine -like '*qq-snowluma-bot.mjs*' -or
      $_.CommandLine -like '*setup.mjs*'
    )
  }

if (-not $procs) {
  Write-Host '[--] QQ bot is not running.' -ForegroundColor Yellow
  exit 0
}

foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force
  Write-Host "[OK] stopped PID $($p.ProcessId)" -ForegroundColor Green
}
Write-Host '[OK] QQ bot stopped. SnowLuma is still running.' -ForegroundColor Green
