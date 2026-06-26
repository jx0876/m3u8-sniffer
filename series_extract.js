// series_extract.js — 用無頭 Chromium 載入觀看頁，抓 m3u8 + 標題
// 用法: node series_extract.js <觀看頁網址>
// 輸出: JSON { ok, m3u8, title, page }  (一行，給 zsh 解析)

const { chromium } = require("playwright");

(async () => {
  const page_url = process.argv[2];
  if (!page_url) { console.log(JSON.stringify({ ok: false, error: "no url" })); process.exit(1); }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    const page = await ctx.newPage();

    // 邊載邊攔網路，逮到 .m3u8 就記
    let netM3u8 = null;
    page.on("request", (req) => {
      const u = req.url();
      if (/\.m3u8(\?|$)/i.test(u) && !netM3u8) netM3u8 = u;
    });

    await page.goto(page_url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // 輪詢最多 12 秒：video.src 或網路攔到的 m3u8
    let m3u8 = null;
    for (let i = 0; i < 24; i++) {
      if (netM3u8) { m3u8 = netM3u8; break; }
      m3u8 = await page.evaluate(() => {
        const v = document.querySelector("video");
        if (v && v.src && /^https?:/.test(v.src) && /\.m3u8/i.test(v.src)) return v.src;
        const r = performance.getEntriesByType("resource").map(e => e.name).find(n => /\.m3u8/i.test(n));
        return r || null;
      });
      if (m3u8) break;
      await page.waitForTimeout(500);
    }

    const title = await page.title();
    await browser.close();

    if (!m3u8) { console.log(JSON.stringify({ ok: false, error: "no m3u8 found", title, page: page_url })); process.exit(2); }
    console.log(JSON.stringify({ ok: true, m3u8, title, page: page_url }));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.log(JSON.stringify({ ok: false, error: String(e && e.message || e), page: page_url }));
    process.exit(3);
  }
})();
