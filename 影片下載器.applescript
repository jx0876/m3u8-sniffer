-- 影片下載器（GUI 版）
-- 雙擊：啟動本地伺服器 + 用預設瀏覽器開介面

on run
	set d to (system attribute "HOME") & "/Dropbox/AI_agent/600_Project/m3u8-sniffer"
	set u to "http://127.0.0.1:7654"
	-- 沒在跑就啟動 server，並等它起來（最多 ~6 秒）
	do shell script "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; " & ¬
		"if ! /usr/bin/curl -s " & u & " >/dev/null 2>&1; then " & ¬
		"cd " & quoted form of d & "; /usr/bin/nohup node server.js >/tmp/m3u8gui.log 2>&1 & " & ¬
		"for i in $(seq 1 15); do /usr/bin/curl -s " & u & " >/dev/null 2>&1 && break; sleep 0.4; done; fi"
	open location u
end run
