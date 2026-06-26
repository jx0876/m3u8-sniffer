// 影片下載器 — 本地網頁 GUI 後端
// 起伺服器：node server.js   →   瀏覽器開 http://127.0.0.1:7654
// 無外部套件，全用 Node 內建模組 + 系統 yt-dlp/ffmpeg

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = 7654;
const DLDIR = path.join(os.homedir(), "Downloads");
// 確保找得到 yt-dlp / ffmpeg（GUI 啟動時 PATH 可能不全）
// 只在 macOS 補 Mac 常見路徑；Windows 沿用系統 PATH（yt-dlp/ffmpeg 需在 PATH 中）
const ENV = Object.assign({}, process.env);
if (process.platform === "darwin") {
  ENV.PATH = "/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/3.14/bin:" + (process.env.PATH || "");
}

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

// 解析畫質：yt-dlp -J
function probe(url, referer) {
  return new Promise((resolve) => {
    const args = ["-J", "--no-warnings", "--no-playlist", "--impersonate", "chrome"];
    if (referer) args.push("--referer", referer);
    args.push(url);
    let out = "", err = "";
    const p = spawn("yt-dlp", args, { env: ENV });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) { resolve({ ok: false, error: (err.trim().split("\n").pop() || "解析失敗") }); return; }
      try {
        const j = JSON.parse(out);
        const fmts = (j.formats || [])
          .filter((f) => f.vcodec && f.vcodec !== "none") // 有畫面的
          .map((f) => ({
            id: f.format_id,
            height: f.height || 0,
            ext: f.ext,
            note: f.format_note || "",
            tbr: f.tbr || 0,
            size: f.filesize || f.filesize_approx || 0,
          }))
          .sort((a, b) => (b.height - a.height) || (b.tbr - a.tbr));
        resolve({ ok: true, title: j.title || "", formats: fmts });
      } catch (e) { resolve({ ok: false, error: "解析輸出異常" }); }
    });
    p.on("error", () => resolve({ ok: false, error: "找不到 yt-dlp" }));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 首頁
  if (u.pathname === "/" || u.pathname === "/index.html") {
    const html = fs.readFileSync(path.join(__dirname, "gui.html"), "utf8");
    send(res, 200, "text/html; charset=utf-8", html);
    return;
  }

  // 解析畫質
  if (u.pathname === "/probe" && req.method === "POST") {
    const b = await readBody(req);
    if (!b.url) { send(res, 200, "application/json", JSON.stringify({ ok: false, error: "沒有網址" })); return; }
    const r = await probe(b.url, b.referer);
    send(res, 200, "application/json", JSON.stringify(r));
    return;
  }

  // 下載（SSE 即時進度）
  if (u.pathname === "/download" && req.method === "GET") {
    const url = u.searchParams.get("url");
    const fmt = u.searchParams.get("format") || "";
    const name = u.searchParams.get("name") || "";
    const referer = u.searchParams.get("referer") || "";
    if (!url) { send(res, 400, "text/plain", "no url"); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const ev = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const args = ["--newline", "--no-warnings", "--concurrent-fragments", "8", "--no-mtime", "--impersonate", "chrome"];
    if (fmt) args.push("-f", fmt);
    if (referer) args.push("--referer", referer);
    args.push("-o", path.join(DLDIR, (name ? name : "%(title)s") + ".%(ext)s"), url);

    ev({ type: "log", line: "yt-dlp " + args.join(" ") });
    const p = spawn("yt-dlp", args, { env: ENV });

    const onLine = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) ev({ type: "progress", pct: parseFloat(m[1]), line });
        else ev({ type: "log", line });
      }
    };
    p.stdout.on("data", onLine);
    p.stderr.on("data", onLine);
    p.on("close", (code) => { ev({ type: code === 0 ? "done" : "error", code }); res.end(); });
    p.on("error", (e) => { ev({ type: "error", line: String(e.message) }); res.end(); });

    req.on("close", () => { try { p.kill(); } catch {} });
    return;
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`影片下載器 GUI: http://127.0.0.1:${PORT}  (下載到 ${DLDIR})`);
});
