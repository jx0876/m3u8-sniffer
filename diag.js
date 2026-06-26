// 診斷：載入播放器頁，點擊播放，記錄所有影音類網路請求
// node diag.js <播放器URL> [referer]
const { chromium } = require("playwright");
(async () => {
  const url = process.argv[2];
  const ref = process.argv[3] || "";
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    extraHTTPHeaders: ref ? { referer: ref } : {},
  });
  const page = await ctx.newPage();
  const hits = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/\.(m3u8|mpd|ts|mp4)(\?|$)/i.test(u) || /master|playlist|index\.m3u8|hls|stream/i.test(u)) {
      hits.push(u.slice(0, 120));
    }
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    // 嘗試點畫面中央觸發播放
    try { await page.mouse.click(360, 225); } catch {}
    try { await page.keyboard.press("Space"); } catch {}
    await page.waitForTimeout(8000);
  } catch (e) {
    console.log("goto error:", e.message);
  }
  console.log("title:", await page.title().catch(() => ""));
  console.log("iframes:", page.frames().map(f => f.url()).filter(u => u && u !== url).slice(0, 6));
  console.log("media hits (" + hits.length + "):");
  [...new Set(hits)].forEach(h => console.log("  " + h));
  await browser.close();
})();
