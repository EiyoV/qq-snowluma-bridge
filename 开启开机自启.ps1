# 把「启动机器人(静默).vbs」加入 Windows 开机自启（当前用户，无需管理员）
# 注意：开机自启只负责启动桥接；SnowLuma 仍需你手动启动并登录 QQ。
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root '启动机器人(静默).vbs'

if (-not (Test-Path $vbs)) {
  Write-Host "找不到 $vbs" -ForegroundColor Red
  exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'QQ机器人.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($link)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = "`"$vbs`""
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7
$sc.Description = 'QQ 机器人静默桥接'
$sc.Save()

Write-Host "已开启开机自启：$link" -ForegroundColor Green
Write-Host "取消用「关闭开机自启.ps1」。" -ForegroundColor Gray
