# ══════════════════════════════════════════════════════════════
# 影片下載函式（搭配 m3u8-sniffer userscript）
# 主力指令：vdl  —  貼網址，它自己判斷怎麼下，檔名自動抓網頁標題
# ══════════════════════════════════════════════════════════════

# 從網頁 <title> 抓劇名（取站名分隔符前那段，清非法字元）
_vdl_title() {
  local t
  t="$(curl -sL --max-time 10 -A 'Mozilla/5.0' "$1" 2>/dev/null \
       | perl -0777 -ne 'print $1 if /<title[^>]*>\s*(.*?)\s*<\/title>/si')"
  t="${t%% - *}"   # 砍 " - 站名" 後綴（如 "劇名 第1集 - 中國人線上看 - ChinaQ"）
  t="${t%% | *}"   # 砍 " | 站名"
  t="${t%%｜*}"     # 砍全形分隔
  # 清非法檔名字元 + 去頭尾空白
  t="$(printf '%s' "$t" | tr -d '/\\:*?"<>|' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  printf '%s' "$t"
}

# vdl <網址> [輸出名] [referer]
#   • 影音平台/yt-dlp 支援站 → 自動解析，檔名用 yt-dlp 抓的標題
#   • m3u8 網址 + referer    → 從 referer 頁抓 <title> 當檔名
#   • 不支援的 JS 動態站      → 提示改用 Chrome 嗅探，並先抓好建議檔名
vdl() {
  local url="$1" name="$2" ref="$3"
  if [[ -z "$url" ]]; then
    echo "用法: vdl <網址> [輸出名] [referer網址]"
    echo "  • 一般影音站/平台 → 貼觀看頁網址，檔名自動抓"
    echo "  • m3u8 網址        → 直接下載（帶 referer 可自動抓劇名）"
    return 1
  fi
  local cf=(--concurrent-fragments 8 --no-mtime --impersonate chrome)
  local refArg=()
  [[ -n "$ref" ]] && refArg=(--referer "$ref")

  # 1) 本身就是 m3u8 → 直接下；檔名留空且有 referer 則抓標題
  if [[ "$url" == *.m3u8* ]]; then
    if [[ -z "$name" && -n "$ref" ]]; then
      name="$(_vdl_title "$ref")"
      [[ -n "$name" ]] && echo "✎ 自動檔名：$name"
    fi
    local out="${name:-vdl_$(date +%Y%m%d_%H%M%S)}"
    echo "▶ m3u8 下載"
    [[ -n "$ref" ]] && echo "  referer: $ref"
    yt-dlp "${cf[@]}" "${refArg[@]}" -o "${out}.%(ext)s" "$url" && echo "✓ 完成: ${out}.mp4"
    return
  fi

  # 2) 試 yt-dlp 能不能解析這個頁面
  echo "▶ 檢查 yt-dlp 是否支援此站…"
  if yt-dlp --simulate --no-warnings "$url" >/dev/null 2>&1; then
    echo "✓ 支援，下載中"
    local tmpl
    if [[ -n "$name" ]]; then tmpl="${name}.%(ext)s"; else tmpl="%(title)s.%(ext)s"; fi
    yt-dlp "${cf[@]}" "${refArg[@]}" -o "$tmpl" "$url" && echo "✓ 完成"
  else
    echo "✗ yt-dlp 不支援此站（多半是 JS 動態載入的 m3u8，CLI 看不到）"
    # 先幫忙抓好建議檔名
    local suggest="$(_vdl_title "$url")"
    [[ -z "$suggest" ]] && suggest="$name"
    echo ""
    echo "改用嗅探流程："
    echo "  1. Chrome 開此頁 → 播放影片"
    echo "  2. 點右上紫色藥丸鈕 → 對著 m3u8 那條點「複製」"
    echo "  3. 回來執行（檔名/referer 已幫你填好）："
    echo "       vdl <貼上m3u8網址> '${suggest}' '${url}'"
  fi
}

# m3u8dl = vdl 別名（相容舊用法）
m3u8dl() { vdl "$@"; }

# ══════════════════════════════════════════════════════════════
# seriesdl — 整劇自動下載（JS 動態站，用無頭瀏覽器逐集抓 m3u8）
# 用法: seriesdl <ep1觀看頁網址> <起集> <迄集>
#   例: seriesdl 'https://chinaq.fun/tv-cn/201885042/ep1.html' 1 52
# 下到 ~/Downloads/<劇名>/，已存在的集數自動跳過，失敗最後列出
# ══════════════════════════════════════════════════════════════
seriesdl() {
  local base="$1" start="${2:-1}" end="$3"
  local SDIR="$HOME/Dropbox/AI_agent/600_Project/m3u8-sniffer"
  if [[ -z "$base" || -z "$end" ]]; then
    echo "用法: seriesdl <ep1觀看頁網址> <起集> <迄集>"
    echo "  例: seriesdl 'https://chinaq.fun/tv-cn/201885042/ep1.html' 1 52"
    return 1
  fi
  if [[ ! -f "$SDIR/series_extract.js" ]]; then
    echo "✗ 找不到 series_extract.js（$SDIR）"; return 1
  fi

  local failed=() done=0 skipped=0
  local N page out m3u8 title name epname dir=""

  for N in $(seq "$start" "$end"); do
    page="$(printf '%s' "$base" | sed -E "s/ep[0-9]+\.html/ep${N}.html/")"
    echo "─────────── 第 ${N} 集 ───────────"
    echo "▶ 抓 m3u8: $page"

    out="$(node "$SDIR/series_extract.js" "$page" 2>/dev/null)"
    m3u8="$(printf '%s' "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("m3u8","") if sys.stdin else "")' 2>/dev/null)"
    title="$(printf '%s' "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("title",""))' 2>/dev/null)"

    if [[ -z "$m3u8" ]]; then
      echo "✗ 第 ${N} 集抓不到 m3u8，跳過"; failed+=("$N"); continue
    fi

    # 清標題 → 劇名+集數
    epname="${title%% - *}"; epname="${epname%% | *}"; epname="${epname%%｜*}"
    epname="$(printf '%s' "$epname" | tr -d '/\\:*?"<>|' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$epname" ]] && epname="$(basename "$base" .html)_ep${N}"

    # 劇名（去掉「第N集」）當資料夾名，第一集成功時建好
    if [[ -z "$dir" ]]; then
      local show="$(printf '%s' "$epname" | sed -E 's/[[:space:]]*第[0-9]+集.*//')"
      [[ -z "$show" ]] && show="$epname"
      dir="$HOME/Downloads/$show"
      mkdir -p "$dir"
      echo "📁 下載資料夾：$dir"
    fi

    if [[ -f "$dir/${epname}.mp4" ]]; then
      echo "⏭  已存在，跳過：${epname}.mp4"; skipped=$((skipped+1)); continue
    fi

    echo "↓ 下載：${epname}.mp4"
    if (cd "$dir" && yt-dlp --concurrent-fragments 8 --no-mtime --impersonate chrome --referer "$page" -o "${epname}.%(ext)s" "$m3u8"); then
      done=$((done+1)); echo "✓ 第 ${N} 集完成"
    else
      echo "✗ 第 ${N} 集下載失敗"; failed+=("$N")
    fi
  done

  echo ""
  echo "═══════ 完成 ═══════"
  echo "成功 ${done}　跳過 ${skipped}　失敗 ${#failed[@]}"
  [[ ${#failed[@]} -gt 0 ]] && echo "失敗集數：${failed[*]}（可重跑 seriesdl 補，已下的會自動跳過）"
  [[ -n "$dir" ]] && echo "位置：$dir"
}
