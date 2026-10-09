@echo off
cd /d "%~dp0"
title Stop QQ Bot
echo.
echo   Stopping QQ bot ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine -like '*qq-snowluma-bot.mjs*' -or $_.CommandLine -like '*setup.mjs*') }); if ($p.Count -eq 0) { Write-Host '  [--] QQ bot is not running.' } else { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('  [OK] stopped PID ' + $_.ProcessId) }; Write-Host ''; Write-Host '  [OK] QQ bot stopped.' }"
echo.
echo   SnowLuma (the QQ gateway) is still running.
echo.
echo   Press any key to close this window ...
pause >nul
