# 影片下載工具組（m3u8-sniffer）

自製、全本地、不外送任何網址。一套搞定 m3u8 / mp4 影音的「找網址 + 下載」。

## 元件總覽

| 檔案 | 用途 | 平台 |
| :--- | :--- | :--- |
| `影片下載器.app` / `.command` | 雙擊啟動 GUI 下載器 | Mac |
| `影片下載器.bat` | 雙擊啟動 GUI 下載器 | Windows |
| `server.js` + `gui.html` | GUI 後端 + 介面（被上面啟動器呼叫） | 跨平台 |
| `m3u8-sniffer.user.js` | 瀏覽器內嗅探 userscript（Tampermonkey） | 跨平台 |
| `m3u8dl.zsh` | CLI 函式 `vdl` / `seriesdl` | Mac（zsh） |
| `series_extract.js` | Playwright 無頭抓 m3u8（`seriesdl` 用） | 跨平台（需各機裝 playwright） |

---

## 三種下載方式

### 1. GUI 下載器（主力）
- Mac：雙擊 `影片下載器.app`（桌面有捷徑）
- Windows：雙擊 `影片下載器.bat`
- 介面在 `http://127.0.0.1:7654`：貼網址 → 解析畫質 → 下載，即時進度（✕取消 / 清除完成 / 全部清除）
- 下到 `~/Downloads`

### 2. CLI（Mac）
```bash
vdl <網址>                 # 萬用：支援站直解 / m3u8 直下 / 不支援給提示
vdl <網址> 檔名 <referer>   # 防盜鏈帶 referer
seriesdl <ep1網址> 起 迄    # 整劇自動下（JS 動態站，用無頭瀏覽器逐集抓）
```

### 3. userscript（瀏覽器內）
- Tampermonkey 裝 `m3u8-sniffer.user.js`
- 藥丸鈕面板：自動嗅到的資源 + 「貼 m3u8 網址」手動欄
- 下載走瀏覽器 session（cookie 自動帶）→ 能過 cookie 鎖的 CF 站

---

## 找網址：DevTools 最可靠

自動嗅探（userscript）對 iframe / 反爬蟲 / 偽裝副檔名的站時靈時不靈。**找不到時用 DevTools，一定看得到**：

```
F12 → Network → 篩 "master" 或 "m3u8" → 按播放 → 右鍵那條 → Copy link address
```
Content-Type 是 `application/vnd.apple.mpegurl` 或內容開頭 `#EXTM3U` 的就是 playlist。

---

## 站點分四類，對應工具

| 站類型 | 找網址 | 下載 |
| :--- | :--- | :--- |
| yt-dlp 支援站（主流平台約1800個） | 直接貼觀看頁 | GUI / vdl |
| JS 動態注入 m3u8 | userscript / DevTools | GUI / vdl / seriesdl |
| 純 Cloudflare 反爬蟲（無 cookie 鎖） | DevTools | GUI（已內建 `--impersonate chrome`） |
| **CF + cookie/session 鎖** | DevTools | **userscript 手動欄**（瀏覽器 session 才過，外部工具必 403） |
| **token 綁 IP/時間** | DevTools | GUI（同一台機、趁未過期即可） |

---

## 安裝

### Mac
```bash
brew install yt-dlp ffmpeg
pip install curl_cffi          # 給 yt-dlp --impersonate（過 CF）
# seriesdl 要 playwright：
cd 此資料夾 && npm install playwright && npx playwright install chromium
```
`~/.zshrc` 已加：`source ~/Dropbox/AI_agent/600_Project/m3u8-sniffer/m3u8dl.zsh`

### Windows
```powershell
winget install OpenJS.NodeJS
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
pip install curl_cffi          # 過 CF（需先有 Python）
```
裝完重開終端機讓 PATH 生效 → 雙擊 `影片下載器.bat`。
（`vdl`/`seriesdl` 是 zsh，Windows 要 git-bash/WSL 才能用；GUI 不受影響。）

### userscript（兩台共用）
Tampermonkey 貼 `m3u8-sniffer.user.js` 存檔。兩台同步建議用 **TM 內建雲端同步**（工具→雲端同步→Google Drive/Dropbox，兩台登同帳號）。

---

## 設計原則（避開市面腳本的雷）
- 全本地，不外送任何 URL / referer / 標題到第三方
- 不把 GM API 掛 `unsafeWindow`（不開跨域後門）
- 無廣告、無導流
- AES-128 用 WebCrypto，IV 正確 hex 解析

## 版本
- GUI / userscript v1.2.1（2026-06）
