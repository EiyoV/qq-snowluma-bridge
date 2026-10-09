@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist config.json (
  echo [i] 没有 config.json，从 config.example.json 复制一份
  copy config.example.json config.json >nul
)

if not exist logs mkdir logs

echo.
echo  llm-router 启动中…
echo   端点   http://127.0.0.1:8787/v1
echo   日志   logs\router.log
echo   停止   Ctrl+C
echo.

node src\index.mjs >> logs\router.log 2>&1
