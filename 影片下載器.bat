@echo off
chcp 65001 >nul
rem 影片下載器 GUI（Windows）：雙擊啟動本地伺服器 + 開瀏覽器
rem 需求：先裝 Node.js、yt-dlp、ffmpeg，且都在 PATH 中
cd /d "%~dp0"

echo 啟動影片下載器 GUI...
start "m3u8-gui" /min cmd /c "node server.js"
timeout /t 2 >nul
start "" "http://127.0.0.1:7654"
exit
