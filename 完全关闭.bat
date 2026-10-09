@echo off
cd /d "%~dp0"
title Close Everything - QQ Bot + SnowLuma
echo.
echo   Closing QQ bot and SnowLuma ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ids = @(); $l = Get-NetTCPConnection -State Listen -LocalPort 5099 -ErrorAction SilentlyContinue; if ($l) { $ids += $l.OwningProcess }; $ids += @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine -like '*qq-snowluma-bot.mjs*' -or $_.CommandLine -like '*setup.mjs*' -or $_.CommandLine -like '* index.mjs') } | ForEach-Object { $_.ProcessId }); $ids = @($ids | Sort-Object -Unique); if ($ids.Count -eq 0) { Write-Host '  [--] nothing was running.' } else { foreach ($x in $ids) { Stop-Process -Id $x -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] stopped PID ' + $x) }; Write-Host ''; Write-Host '  [OK] all closed.' }"
echo.
echo   Note: llm-router is managed by DSH and is NOT touched.
echo   Next time you start the bot, SnowLuma will be relaunched and you
echo   may need to scan the QQ QR code again.
echo.
echo   Press any key to close this window ...
pause >nul
