// ==UserScript==
// @name         M3U8 嗅探下載器（本地版）
// @name:zh-TW   M3U8 嗅探下載器（本地版）
// @name:en      M3U8 Sniffer & Downloader (Local)
// @namespace    https://github.com/jx0876/m3u8-sniffer
// @version      1.3.1
// @updateURL    https://raw.githubusercontent.com/jx0876/m3u8-sniffer/main/m3u8-sniffer.user.js
// @downloadURL  https://raw.githubusercontent.com/jx0876/m3u8-sniffer/main/m3u8-sniffer.user.js
// @description  純本地嗅探並下載頁面 m3u8 / mp4 影音。雙嗅探（攔 XHR/fetch + PerformanceObserver），WebCrypto AES-128 解密，並發下載合併，玻璃感介面。無廣告、無導流、不外送任何網址。
// @description:en Pure-local m3u8/mp4 sniffer & downloader. Dual sniffing, WebCrypto AES-128 decrypt, concurrent merge. No ads, no tracking, nothing sent out.
// @author       justin
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// 注意：不可加 @noframes —— 跨域 iframe 播放器（如 playmogo）的 m3u8 要靠腳本進 iframe 嗅探後 postMessage 回頂層
// ==/UserScript==

/*
 * 設計原則（避開市面腳本的雷）：
 *   - 不把 GM API 掛上 unsafeWindow（不開跨域後門）
 *   - 不外送任何 URL / referer / 標題到第三方
 *   - 無廣告、無導流
 *   - IV 正確 hex 解析（修正常見腳本的 IV bug）
 *   - 解密用瀏覽器原生 WebCrypto，免 CryptoJS 依賴
 */

(function () {
    "use strict";

    // ───────────────────────── 設定 ─────────────────────────
    const CONCURRENCY = 6;   // ts 並發數
    const MP4_THREADS = 8;   // mp4 Range 分塊線程數

    // ─────────────────────── 小工具 ───────────────────────
    const uw = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    const isTop = (window.self === window.top);   // 頂層頁才畫 UI；iframe 只嗅探後回傳
    const RELAY_TAG = "__m3u8sniff_relay__";

    function gmXhr(opts) {
        return new Promise((resolve, reject) => {
            const req = GM_xmlhttpRequest(Object.assign({
                method: "GET",
                onload: (r) => resolve(r),
                onerror: (e) => reject(e),
                ontimeout: () => reject(new Error("timeout")),
            }, opts));
            opts._req = req;
        });
    }

    // 多級 header fallback（應對防盜鏈 403）
    function headVariants(href) {
        const origin = (() => { try { return new URL(href).origin; } catch { return location.origin; } })();
        return [
            {},
            { Referer: location.href },
            { Referer: location.href, Origin: location.origin },
            { Referer: href, Origin: origin },
        ];
    }

    // 解析 m3u8 中相對 URL → 絕對
    function absUrl(u, base) {
        try { return new URL(u, base).href; } catch { return u; }
    }

    function hexToBytes(hex) {
        hex = hex.replace(/^0x/i, "").trim();
        if (hex.length % 2) hex = "0" + hex;
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    // 由序號產生預設 IV（HLS 規範：無 IV 時用 media sequence，16-byte big-endian）
    function seqToIV(seq) {
        const iv = new Uint8Array(16);
        for (let i = 15; i >= 0 && seq > 0; i--) { iv[i] = seq & 0xff; seq = Math.floor(seq / 256); }
        return iv;
    }

    // ─────────────────── m3u8 精簡解析 ───────────────────
    // 回傳 { master:bool, variants:[{url,resolution,bandwidth}], segments:[{url,seq}], key:{method,uri,iv} | null, mapUri }
    function parseM3U8(text, baseUrl) {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
        const variants = [];
        const segments = [];
        let key = null;
        let mapUri = null;
        let pendingInf = null;       // 上一個 #EXTINF（媒體切片）
        let pendingStreamInf = null; // 上一個 #EXT-X-STREAM-INF（主清單）
        let mediaSeq = 0;
        let seq = 0;

        for (const line of lines) {
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                mediaSeq = parseInt(line.split(":")[1], 10) || 0;
                seq = mediaSeq;
            } else if (line.startsWith("#EXT-X-KEY:")) {
                const method = (line.match(/METHOD=([\w-]+)/i) || [])[1] || "NONE";
                if (/^NONE$/i.test(method)) { key = null; }
                else {
                    const uri = (line.match(/URI="([^"]*)"/i) || [])[1] || "";
                    const ivM = (line.match(/IV=([0-9A-Fa-fx]+)/i) || [])[1];
                    key = {
                        method,
                        uri: absUrl(uri, baseUrl),
                        iv: ivM ? hexToBytes(ivM) : null,
                    };
                }
            } else if (line.startsWith("#EXT-X-MAP:")) {
                const uri = (line.match(/URI="([^"]*)"/i) || [])[1];
                if (uri) mapUri = absUrl(uri, baseUrl);
            } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
                const res = (line.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || "";
                const bw = parseInt((line.match(/BANDWIDTH=(\d+)/i) || [])[1] || "0", 10);
                pendingStreamInf = { resolution: res, bandwidth: bw };
            } else if (line.startsWith("#EXTINF:")) {
                const dur = parseFloat(line.split(":")[1]) || 0;
                pendingInf = { duration: dur };
            } else if (line.startsWith("#")) {
                // 其他標籤忽略
            } else {
                // URL 行
                if (pendingStreamInf) {
                    variants.push(Object.assign({ url: absUrl(line, baseUrl) }, pendingStreamInf));
                    pendingStreamInf = null;
                } else {
                    segments.push({ url: absUrl(line, baseUrl), seq, duration: pendingInf ? pendingInf.duration : 0 });
                    seq++;
                    pendingInf = null;
                }
            }
        }
        return { master: variants.length > 0 && segments.length === 0, variants, segments, key, mapUri, mediaSeq };
    }

    // 抓 m3u8 文字（多級 header 重試）
    async function fetchText(url) {
        let lastErr;
        for (const h of headVariants(url)) {
            try {
                const r = await gmXhr({ url, headers: h });
                if (r.status >= 200 && r.status < 400 && r.responseText) return { text: r.responseText, headers: h };
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error("fetch failed");
    }

    async function fetchBuf(url, headers) {
        let lastErr;
        for (const h of headers ? [headers] : headVariants(url)) {
            try {
                const r = await gmXhr({ url, headers: h, responseType: "arraybuffer" });
                if (r.status >= 200 && r.status < 400 && r.response) return r.response;
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error("buf fetch failed");
    }

    // ─────────────────── AES-128 解密（WebCrypto）───────────────────
    async function decryptSegment(buf, keyBytes, iv) {
        try {
            const ck = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
            return await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, buf);
        } catch (e) {
            // WebCrypto 對非 PKCS7 對齊的串會丟錯 → 退回原始 buf（少數站）
            console.warn("[m3u8] decrypt fail, raw fallback", e);
            return buf;
        }
    }

    // ─────────────────── 下載引擎 ───────────────────
    // task: { id, type:'m3u8'|'mp4'|'video', url, name, onProgress, onDone, onError }
    // 回傳 controller { abort() }
    function downloadM3U8(task) {
        let aborted = false;
        const reqs = [];
        const ctrl = { abort() { aborted = true; reqs.forEach(r => { try { r.abort(); } catch {} }); } };

        (async () => {
            try {
                let { text } = await fetchText(task.url);
                let parsed = parseM3U8(text, task.url);

                // 主清單 → 選最高解析度子清單
                if (parsed.master) {
                    const best = parsed.variants.slice().sort((a, b) =>
                        (b.bandwidth - a.bandwidth) || (resPixels(b.resolution) - resPixels(a.resolution)))[0];
                    task.url = best.url;
                    ({ text } = await fetchText(best.url));
                    parsed = parseM3U8(text, best.url);
                }

                const segs = parsed.segments;
                if (!segs.length) throw new Error("無切片");

                // 取金鑰
                let keyBytes = null;
                if (parsed.key && /AES-128/i.test(parsed.key.method)) {
                    keyBytes = new Uint8Array(await fetchBuf(parsed.key.uri));
                }

                // MAP（fMP4 初始化段）
                const buffers = new Array(segs.length + (parsed.mapUri ? 1 : 0));
                let mapOffset = 0;
                if (parsed.mapUri) {
                    buffers[0] = await fetchBuf(parsed.mapUri);
                    mapOffset = 1;
                }

                let done = 0;
                let queue = segs.map((s, i) => ({ s, i }));

                async function worker() {
                    while (queue.length && !aborted) {
                        const { s, i } = queue.shift();
                        let buf = await fetchBuf(s.url);
                        if (keyBytes) {
                            const iv = parsed.key.iv || seqToIV(s.seq);
                            buf = await decryptSegment(buf, keyBytes, iv);
                        }
                        buffers[i + mapOffset] = buf;
                        done++;
                        task.onProgress(done / segs.length, `${done}/${segs.length}`);
                    }
                }

                await Promise.all(Array.from({ length: CONCURRENCY }, worker));
                if (aborted) return;

                const blob = new Blob(buffers.filter(Boolean), { type: "video/mp2t" });
                triggerDownload(blob, ensureExt(task.name, "ts"));
                task.onDone();
            } catch (e) {
                if (!aborted) task.onError(e);
            }
        })();

        return ctrl;
    }

    function resPixels(res) {
        if (!res) return 0;
        const m = res.match(/(\d+)x(\d+)/);
        return m ? parseInt(m[1]) * parseInt(m[2]) : 0;
    }

    // mp4 多線程 Range 下載
    function downloadMP4(task) {
        let aborted = false;
        const reqs = [];
        const ctrl = { abort() { aborted = true; reqs.forEach(r => { try { r.abort(); } catch {} }); } };

        (async () => {
            try {
                // 先探長度
                let total = 0, headers = {};
                for (const h of headVariants(task.url)) {
                    try {
                        const r = await gmXhr({ url: task.url, headers: Object.assign({ Range: "bytes=0-1" }, h), responseType: "arraybuffer" });
                        const cr = (r.responseHeaders || "").match(/content-range:\s*bytes\s*\d+-\d+\/(\d+)/i);
                        if (cr) { total = parseInt(cr[1], 10); headers = h; break; }
                    } catch {}
                }

                if (!total) { // 不支援 Range → 單線程
                    const buf = await fetchBuf(task.url);
                    triggerDownload(new Blob([buf], { type: "video/mp4" }), ensureExt(task.name, "mp4"));
                    task.onDone(); return;
                }

                const chunkSize = Math.ceil(total / MP4_THREADS);
                const parts = new Array(MP4_THREADS);
                const loaded = new Array(MP4_THREADS).fill(0);
                let queue = [];
                for (let i = 0; i < MP4_THREADS; i++) {
                    const start = i * chunkSize;
                    const end = Math.min(start + chunkSize - 1, total - 1);
                    if (start <= end) queue.push({ i, start, end });
                }

                async function worker() {
                    while (queue.length && !aborted) {
                        const { i, start, end } = queue.shift();
                        const r = await gmXhr({
                            url: task.url, responseType: "arraybuffer",
                            headers: Object.assign({ Range: `bytes=${start}-${end}` }, headers),
                            onprogress: (e) => {
                                loaded[i] = e.loaded;
                                const sum = loaded.reduce((a, b) => a + b, 0);
                                task.onProgress(sum / total, `${(sum / 1048576).toFixed(1)}MB`);
                            },
                        });
                        parts[i] = r.response;
                    }
                }

                await Promise.all(Array.from({ length: MP4_THREADS }, worker));
                if (aborted) return;
                triggerDownload(new Blob(parts.filter(Boolean), { type: "video/mp4" }), ensureExt(task.name, "mp4"));
                task.onDone();
            } catch (e) {
                if (!aborted) task.onError(e);
            }
        })();

        return ctrl;
    }

    function ensureExt(name, ext) {
        name = (name || "video").replace(/[\\/:*?"<>|]+/g, "_").trim();
        if (!new RegExp(`\\.${ext}$`, "i").test(name)) name += "." + ext;
        return name;
    }

    function triggerDownload(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // ─────────────────── 嗅探 ───────────────────
    const seen = new Set();
    const resources = []; // {type, url, label, name}

    function addResource(type, url, label) {
        try { url = new URL(url, location.href).href; } catch { return; }
        if (seen.has(url)) return;
        if (/^blob:|^data:/i.test(url)) return;
        seen.add(url);

        // 在跨域 iframe（播放器）內嗅到 → 中繼回頂層頁顯示
        if (!isTop) {
            try {
                window.top.postMessage({ tag: RELAY_TAG, type, url, label: label || type, frameTitle: document.title }, "*");
            } catch {}
            return;
        }

        let name = "";
        try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch {}
        name = name.replace(/\.(m3u8?|ts)$/i, "") || (document.title || "video");
        const res = { type, url, label: label || type, name };
        resources.push(res);
        UI.addItem(res);
    }

    // 頂層頁：接收 iframe 中繼來的資源
    if (isTop) {
        window.addEventListener("message", (e) => {
            const d = e.data;
            if (!d || d.tag !== RELAY_TAG || !d.url) return;
            if (seen.has(d.url)) return;
            seen.add(d.url);
            let name = "";
            try { name = decodeURIComponent(new URL(d.url).pathname.split("/").pop() || ""); } catch {}
            name = name.replace(/\.(m3u8?|ts)$/i, "") || d.frameTitle || (document.title || "video");
            const res = { type: d.type, url: d.url, label: d.label || d.type, name };
            resources.push(res);
            UI.addItem(res);
        });
    }

    function isM3U8Url(u) {
        try { const p = new URL(u, location.href).pathname; return /\.m3u8?(\?|$)/i.test(p); } catch { return false; }
    }
    function isMP4Url(u) {
        try { const p = new URL(u, location.href).pathname; return /\.mp4(\?|$)/i.test(p); } catch { return false; }
    }

    // 1) 攔 fetch（透過 Response.prototype.text 攔內容，抓 blob/動態 m3u8）
    const _Rtext = uw.Response && uw.Response.prototype.text;
    if (_Rtext) {
        uw.Response.prototype.text = function () {
            return _Rtext.call(this).then((text) => {
                try {
                    if (typeof text === "string" && text.trim().startsWith("#EXTM3U")) {
                        addResource("m3u8", this.url || location.href, "m3u8");
                    }
                } catch {}
                return text;
            });
        };
    }

    // 2) 攔 XHR
    const _open = uw.XMLHttpRequest.prototype.open;
    uw.XMLHttpRequest.prototype.open = function (method, url) {
        this.addEventListener("load", () => {
            try {
                if (isM3U8Url(url)) addResource("m3u8", url, "m3u8");
                else if (this.responseText && this.responseText.trim().startsWith("#EXTM3U")) addResource("m3u8", url, "m3u8");
            } catch {}
        });
        return _open.apply(this, arguments);
    };

    // 2b) 攔 fetch（複製 response 讀內容，抓任何載入法/副檔名的 m3u8，含 .txt 偽裝）
    const _fetch = uw.fetch;
    if (_fetch) {
        uw.fetch = function (...args) {
            return _fetch.apply(this, args).then((resp) => {
                try {
                    const url = (resp && resp.url) || (typeof args[0] === "string" ? args[0] : (args[0] && args[0].url)) || "";
                    if (isM3U8Url(url)) { addResource("m3u8", url, "m3u8"); return resp; }
                    const ct = (resp.headers && resp.headers.get && (resp.headers.get("content-type") || "")) || "";
                    const clen = parseInt((resp.headers && resp.headers.get && resp.headers.get("content-length")) || "0", 10);
                    const looksPlaylist = /mpegurl/i.test(ct)
                        || /\.(m3u8|txt)(\?|$)/i.test(url)
                        || (/text\/plain|octet-stream/i.test(ct) && (!clen || clen < 300000));
                    if (looksPlaylist && (!clen || clen < 500000)) {
                        resp.clone().text().then((t) => {
                            if (t && t.trim().startsWith("#EXTM3U")) addResource("m3u8", url || location.href, "m3u8");
                        }).catch(() => {});
                    }
                } catch {}
                return resp;
            });
        };
    }

    // 3) PerformanceObserver（補漏：直接看網路 URL）
    try {
        const po = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                const u = e.name;
                if (isM3U8Url(u)) addResource("m3u8", u, "m3u8");
                else if (isMP4Url(u)) addResource("mp4", u, "mp4");
            }
        });
        po.observe({ entryTypes: ["resource"] });
        // 開場補掃既有：移到 startDomWatch（須等 UI 定義後才能 addResource）
    } catch {}

    // 4) 掃 DOM video/source（即時：MutationObserver + 兜底輪詢）
    function scanDom() {
        document.querySelectorAll("video, source").forEach((el) => {
            const src = el.currentSrc || el.src || el.getAttribute("src") || "";
            if (src && /^https?:/i.test(src)) {
                if (isM3U8Url(src)) addResource("m3u8", src, "m3u8");
                else if (isMP4Url(src)) addResource("mp4", src, "mp4");
                else addResource("video", src, el.tagName.toLowerCase());
            }
        });
    }

    // MutationObserver：DOM 一變動（含 src 屬性）立即掃，不等輪詢
    function startDomWatch() {
        if (isTop) UI.ensure();  // 只頂層頁顯示藥丸鈕（iframe 內不畫 UI，只嗅探回傳）
        scanDom(); // 開場即掃一次
        // 開場補掃既有網路請求（此時 UI 已就緒）
        try {
            performance.getEntriesByType("resource").forEach((e) => {
                if (isM3U8Url(e.name)) addResource("m3u8", e.name, "m3u8");
                else if (isMP4Url(e.name)) addResource("mp4", e.name, "mp4");
            });
        } catch {}
        try {
            const mo = new MutationObserver(scanDom);
            mo.observe(document.documentElement, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ["src"],
            });
        } catch {}
        // 兜底：前 10 秒每秒補掃（應對 property-set src 不觸發 MutationObserver 的情況）
        let n = 0;
        const t = setInterval(() => { scanDom(); if (++n >= 10) clearInterval(t); }, 1000);
    }
    // 注意：startDomWatch() 會用到 UI，必須等 UI 定義後才呼叫（見檔尾）

    // ─────────────────── 介面（Shadow DOM）───────────────────
    const UI = (function () {
        let root, shadow, panel, list, badge, pill;
        let open = false;
        let count = 0;

        function ensure() {
            if (root) return;
            root = document.createElement("div");
            root.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
            shadow = root.attachShadow({ mode: "open" });

            const css = document.createElement("style");
            css.textContent = STYLE;
            shadow.appendChild(css);

            // 浮動藥丸鈕
            pill = document.createElement("div");
            pill.className = "pill";
            pill.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg><span class="badge">0</span>`;
            shadow.appendChild(pill);

            // 面板
            panel = document.createElement("div");
            panel.className = "panel hidden";
            panel.innerHTML = `
                <div class="head">
                    <span class="title">嗅探資源</span>
                    <span class="closeBtn" title="收起">×</span>
                </div>
                <div class="manual">
                    <input class="mInput" placeholder="貼 m3u8 網址手動下載（自動漏抓時用）">
                    <button class="mBtn">加入</button>
                </div>
                <div class="list"></div>
                <div class="foot">純本地 · 不外送任何網址</div>`;
            shadow.appendChild(panel);

            list = panel.querySelector(".list");
            badge = pill.querySelector(".badge");

            // 手動貼網址 → 加進列表（之後按該項「下載」用瀏覽器 session 下，可過 CF）
            const mInput = panel.querySelector(".mInput");
            const mBtn = panel.querySelector(".mBtn");
            const addManual = () => {
                const v = (mInput.value || "").trim();
                if (!v) return;
                const t = /\.mp4(\?|$)/i.test(v) ? "mp4" : "m3u8";
                addResource(t, v, "手動");
                mInput.value = "";
                open = true; render();
            };
            mBtn.addEventListener("click", addManual);
            mInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addManual(); });

            // 拖曳 + 點擊切換
            makeDraggable(pill, () => { open = !open; render(); });
            panel.querySelector(".closeBtn").addEventListener("click", () => { open = false; render(); });

            // 掛到 <html>（比 body 不易被 SPA 重繪洗掉）
            (document.documentElement || document.body).appendChild(root);
            restorePos();
            render();

            // 防護：頁面若把藥丸節點移除（SPA 重繪），自動重新掛回
            setInterval(() => {
                if (root && !root.isConnected) {
                    (document.documentElement || document.body).appendChild(root);
                }
            }, 3000);
        }

        function render() {
            badge.textContent = count;
            panel.classList.toggle("hidden", !open);
            pill.classList.toggle("active", count > 0);
        }

        function addItem(res) {
            ensure();
            count++;
            const row = document.createElement("div");
            row.className = "item";
            row.innerHTML = `
                <span class="tag tag-${res.type}">${res.label}</span>
                <span class="path" title="${escapeHtml(res.url)}">${escapeHtml(shortPath(res.url))}</span>
                <input class="fname" value="${escapeHtml(res.name)}" />
                <button class="btn copy">複製</button>
                <button class="btn dl">下載</button>
                <button class="btn stop hidden">中斷</button>
                <span class="prog"></span>`;

            const fname = row.querySelector(".fname");
            const dlBtn = row.querySelector(".dl");
            const stopBtn = row.querySelector(".stop");
            const prog = row.querySelector(".prog");

            row.querySelector(".copy").addEventListener("click", () => {
                GM_setClipboard(res.url);
                flash(prog, "已複製");
            });

            let controller = null;
            dlBtn.addEventListener("click", () => {
                const task = {
                    url: res.url,
                    name: fname.value || res.name,
                    onProgress: (r, txt) => { prog.textContent = txt || Math.round(r * 100) + "%"; },
                    onDone: () => { prog.textContent = "完成 ✓"; dlBtn.classList.remove("hidden"); stopBtn.classList.add("hidden"); controller = null; },
                    onError: (e) => { prog.textContent = "錯誤"; prog.title = String(e && e.message || e); dlBtn.classList.remove("hidden"); stopBtn.classList.add("hidden"); controller = null; },
                };
                dlBtn.classList.add("hidden");
                stopBtn.classList.remove("hidden");
                prog.textContent = "解析中…";
                controller = (res.type === "m3u8") ? downloadM3U8(task) : downloadMP4(task);
            });
            stopBtn.addEventListener("click", () => {
                if (controller) controller.abort();
                prog.textContent = "已中斷";
                dlBtn.classList.remove("hidden");
                stopBtn.classList.add("hidden");
            });

            list.appendChild(row);
            render();
        }

        // 拖曳，區分點擊 vs 拖動
        function makeDraggable(el, onClick) {
            let sx, sy, moved, startRight, startTop;
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                moved = false;
                sx = e.clientX; sy = e.clientY;
                const r = root.getBoundingClientRect();
                startRight = parseInt(root.dataset.right || "16", 10);
                startTop = parseInt(root.dataset.top || "120", 10);
                const mm = (ev) => {
                    const dx = ev.clientX - sx, dy = ev.clientY - sy;
                    if (!moved && Math.abs(dx) + Math.abs(dy) > 5) moved = true;
                    if (moved) setPos(startRight - dx, startTop + dy);
                };
                const mu = () => {
                    document.removeEventListener("mousemove", mm);
                    document.removeEventListener("mouseup", mu);
                    if (!moved) onClick();
                    else savePos();
                };
                document.addEventListener("mousemove", mm);
                document.addEventListener("mouseup", mu);
            });
        }

        function setPos(right, top) {
            right = Math.max(0, Math.min(innerWidth - 50, right));
            top = Math.max(0, Math.min(innerHeight - 50, top));
            root.dataset.right = right; root.dataset.top = top;
            pill.style.right = right + "px"; pill.style.top = top + "px";
            panel.style.right = right + "px"; panel.style.top = (top + 56) + "px";
        }
        function savePos() { GM_setValue("pos", { right: +root.dataset.right, top: +root.dataset.top }); }
        function restorePos() {
            const p = GM_getValue("pos", { right: 16, top: 120 });
            setPos(p.right, p.top);
        }

        return { addItem, ensure };
    })();

    // 頂層頁：立刻顯示藥丸鈕（documentElement 一定存在，不等 body / 不靠嗅探觸發）
    if (isTop) { try { UI.ensure(); } catch (e) { console.error("[m3u8] UI.ensure", e); } }

    // 啟動 DOM 嗅探（UI 已定義，可安全呼叫）
    if (document.body) startDomWatch();
    else document.addEventListener("DOMContentLoaded", startDomWatch);

    function shortPath(url) {
        try { const u = new URL(url); return (u.pathname.split("/").pop() || u.pathname) + (u.search ? "?…" : ""); }
        catch { return url.slice(0, 40); }
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function flash(el, txt) { const old = el.textContent; el.textContent = txt; setTimeout(() => { if (el.textContent === txt) el.textContent = old; }, 1500); }

    const STYLE = `
    :host { all: initial; }
    .pill {
        position: fixed; width: 44px; height: 44px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        color: #fff; cursor: pointer; user-select: none;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        box-shadow: 0 4px 16px rgba(99,102,241,.5);
        backdrop-filter: blur(8px); transition: transform .15s, box-shadow .15s;
        font-family: -apple-system, "Segoe UI", sans-serif;
    }
    .pill:hover { transform: scale(1.08); box-shadow: 0 6px 22px rgba(139,92,246,.6); }
    .pill.active { animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{box-shadow:0 4px 16px rgba(99,102,241,.5);} 50%{box-shadow:0 4px 24px rgba(139,92,246,.85);} }
    .badge {
        position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
        padding: 0 4px; border-radius: 9px; background: #ef4444; color: #fff;
        font-size: 11px; line-height: 18px; text-align: center; font-weight: 700;
        box-sizing: border-box;
    }
    .panel {
        position: fixed; width: 380px; max-height: 70vh; overflow: hidden;
        display: flex; flex-direction: column;
        background: rgba(20,20,28,.82); backdrop-filter: blur(18px);
        border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
        box-shadow: 0 12px 48px rgba(0,0,0,.5); color: #e5e7eb;
        font-family: -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
        font-size: 13px;
    }
    .panel.hidden { display: none; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .title { font-weight: 700; font-size: 14px; }
    .closeBtn { cursor: pointer; font-size: 20px; line-height: 1; opacity: .6; }
    .closeBtn:hover { opacity: 1; }
    .manual { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.06); }
    .manual .mInput { flex: 1; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: #e5e7eb; padding: 6px 9px; font-size: 12px; outline: none; }
    .manual .mInput:focus { border-color: #8b5cf6; }
    .manual .mBtn { border: none; border-radius: 8px; padding: 0 12px; font-size: 12px; font-weight: 600; cursor: pointer; color: #fff; background: linear-gradient(135deg,#6366f1,#8b5cf6); }
    .list { overflow-y: auto; padding: 8px; gap: 6px; display: flex; flex-direction: column; }
    .list::-webkit-scrollbar { width: 7px; } .list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 4px; }
    .item { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px; border-radius: 9px; background: rgba(255,255,255,.05); }
    .item:hover { background: rgba(255,255,255,.09); }
    .tag { padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .tag-m3u8 { background: rgba(139,92,246,.25); color: #c4b5fd; }
    .tag-mp4 { background: rgba(34,197,94,.22); color: #86efac; }
    .tag-video, .tag-source { background: rgba(59,130,246,.22); color: #93c5fd; }
    .path { flex: 1 1 120px; min-width: 80px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .75; font-size: 12px; }
    .fname { flex: 1 1 90px; min-width: 70px; background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; color: #e5e7eb; padding: 3px 6px; font-size: 12px; outline: none; }
    .fname:focus { border-color: #8b5cf6; }
    .btn { border: none; border-radius: 6px; padding: 4px 9px; font-size: 12px; cursor: pointer; color: #fff; background: rgba(255,255,255,.14); transition: background .12s; }
    .btn:hover { background: rgba(255,255,255,.26); }
    .btn.dl { background: linear-gradient(135deg,#6366f1,#8b5cf6); }
    .btn.dl:hover { filter: brightness(1.12); }
    .btn.stop { background: #ef4444; }
    .btn.hidden { display: none; }
    .prog { font-size: 11px; opacity: .85; min-width: 36px; }
    .foot { padding: 7px 14px; font-size: 11px; opacity: .45; text-align: center; border-top: 1px solid rgba(255,255,255,.06); }
    `;

    console.log("[m3u8-sniffer] loaded");
})();
