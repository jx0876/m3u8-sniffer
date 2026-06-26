#!/bin/zsh
# 雙擊啟動影片下載器 GUI：起本地伺服器 + 開瀏覽器
DIR="$HOME/Dropbox/AI_agent/600_Project/m3u8-sniffer"
URL="http://127.0.0.1:7654"

# 找 node（GUI 啟動時 PATH 可能不全）
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 伺服器沒在跑就啟動
if ! curl -s "$URL" >/dev/null 2>&1; then
  echo "啟動伺服器…"
  (cd "$DIR" && nohup node server.js >/tmp/m3u8gui.log 2>&1 &)
  for i in {1..15}; do
    curl -s "$URL" >/dev/null 2>&1 && break
    sleep 0.4
  done
fi

echo "開啟介面：$URL"
open "$URL"
sleep 1
