# 取消 QQ 机器人的开机自启
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'QQ机器人.lnk'

if (Test-Path $link) {
  Remove-Item $link -Force
  Write-Host "已关闭开机自启。" -ForegroundColor Green
} else {
  Write-Host "当前没有开启开机自启。" -ForegroundColor Yellow
}
