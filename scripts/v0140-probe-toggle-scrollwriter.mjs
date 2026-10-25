/**
 * 诊断探针 #2：**谁在开/关预览时写了 textarea.scrollTop**
 *
 * 已知：文档在底部（左屏 gap=1px）→ 打开预览后 gap 变成 29.667px
 * （scrollTop 7582 → 7553.333，带循环小数的浮点值，明显是 JS 计算写回而非原生滚动）。
 *
 * 本脚本 hook `HTMLTextAreaElement.prototype.scrollTop` 的 getter/setter，
 * 记录每次写入的「值 / 旧值 / 调用栈首行」，从而直接指认写回者：
 *   · syncToSource（右→左联动）
 *   · restoreTextAnchor（宽度变化锚点补偿）
 *   · restoreScrollWithRetry / applyScroll（模式切换恢复）
 *   · 浏览器原生 clamp（无 JS 栈，setter 不被调用）
 *
 * 用法：node scripts/v0140-probe-toggle-scrollwriter.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_SW_PORT || 9289);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0140-probe-toggle-scrollwriter.txt");
const SERVE_DIST = process.env.V0140_SW_SERVE === "1";
const DIST_DIR = "D:\\AI\\markdown view\\lightmd\\dist";
const DIST_PORT = 1420;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".wasm": "application/wasm" };

function startDistServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let file = path.join(DIST_DIR, (urlPath === "/" ? "/index.html" : urlPath).replace(/^\/+/, ""));
      if (!file.startsWith(DIST_DIR)) return res.writeHead(403).end("forbidden");
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, "index.html");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(DIST_PORT, "127.0.0.1", () => resolve(server));
  });
}

const lines = [];
const log = (s = "") => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => resolve({
      ws,
      send(method, params, timeoutMs = 60000) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => {
          const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} 超时`)); }, timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    });
  });
}

function makeDoc() {
  const p = ["# 滚动写入者诊断", ""];
  const long = (i) => `第 ${i} 段：这是一段刻意写长的正文，用于让 textarea 的 pre-wrap 在较窄宽度下折成更多视觉行，从而 scrollHeight 随左栏宽度变化而变化。继续堆字以拉长该逻辑行。`;
  for (let i = 1; i <= 100; i++) { p.push(long(i)); p.push(""); }
  p.push("## 末段");
  p.push("最后一段用于确认底部。");
  return p.join("\n");
}

const HOOK = String.raw`
// 在 window 上挂一个 scrollTop 写入记录器（只在本次诊断里生效）
// 注意：scrollTop 定义在 Element.prototype（不在 HTMLElement.prototype）
if (!window.__swHookInstalled) {
  window.__swHookInstalled = true;
  window.__swLog = [];
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!desc || !desc.get || !desc.set) return "no scrollTop descriptor";
  const origGet = desc.get, origSet = desc.set;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: origGet,
    set(v) {
      const el = this;
      // 只记 textarea（诊断目标）
      const isTa = el && el.tagName === "TEXTAREA" && el.classList.contains("source-editor");
      if (isTa) {
        const old = origGet.call(el);
        const st = new Error().stack || "";
        // 取更多帧（压缩后调用链深），并把 index-*.js 的 (行:列) 一起留着
        const allFrames = st.split("\n").slice(1);
        const frames = allFrames.slice(0, 12).map((s) => s.trim()).join(" | ");
        window.__swLog.push({
          t: +(performance.now()).toFixed(1),
          from: +old.toFixed(3),
          to: +Number(v).toFixed(3),
          delta: +(Number(v) - old).toFixed(3),
          frames: frames.slice(0, 1800),
          deep: allFrames.filter((f) => f.includes("index-")).map((f) => f.trim()).slice(0, 10),
        });
      }
      return origSet.call(el, v);
    },
  });
}
return "hook installed";
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-sw-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "sw-long.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(1200);

  let distServer = null;
  if (SERVE_DIST) { distServer = await startDistServer(); console.log("[probe] dist served"); }

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdio: "ignore",
  });

  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
          if (r.result?.result?.value === true) { cdp = c; break; }
          c.close();
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };

  try {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } })); return true;`);
    await sleep(1500);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
    await sleep(1200);

    // 安装 hook（必须在进入"底部"状态之前，才能抓到后续所有写入）
    await ev(HOOK);

    // 滚到最底部
    await ev(`
      const ta = document.querySelector("textarea.source-editor");
      ta.scrollTop = ta.scrollHeight - ta.clientHeight;
      return ta.scrollTop;`);
    await sleep(900);

    const before = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      window.__swLog.length = 0;
      return { st: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, taW: ta.clientWidth };`);
    log(`准备就绪：scrollTop=${before.st} max=${before.max} 宽=${before.taW}（已清空写入日志）`);

    log("");
    log("════════ 关闭预览 ════════");
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
    await sleep(1200);
    const closeLog = await ev(`return window.__swLog.slice();`);
    const afterClose = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      return { st: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, taW: ta.clientWidth, open: !!document.querySelector(".split-preview-open") };`);
    log(`  关闭后：scrollTop=${afterClose.st} max=${afterClose.max} 宽=${afterClose.taW} open=${afterClose.open}`);
    log(`  scrollTop 被 JS 写入 ${closeLog.length} 次：`);
    for (const e of closeLog) log(`    t=${e.t} ${e.from} → ${e.to} (Δ${e.delta})\n       ${e.frames}`);

    log("");
    log("════════ 打开预览 ════════");
    await ev(`window.__swLog.length = 0; window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
    await sleep(1400);
    const openLog = await ev(`return window.__swLog.slice();`);
    const afterOpen = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      return { st: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, taW: ta.clientWidth, open: !!document.querySelector(".split-preview-open") };`);
    log(`  打开后：scrollTop=${afterOpen.st} max=${afterOpen.max} 宽=${afterOpen.taW} open=${afterOpen.open}`);
    log(`  scrollTop 被 JS 写入 ${openLog.length} 次：`);
    for (const e of openLog) log(`    t=${e.t} ${e.from} → ${e.to} (Δ${e.delta})\n       DEEP: ${JSON.stringify(e.deep)}`);

    log("");
    log("════════ 判定 ════════");
    log(`  关闭态 gap = ${(afterClose.max - afterClose.st).toFixed(3)}px`);
    log(`  打开态 gap = ${(afterOpen.max - afterOpen.st).toFixed(3)}px`);
    log(`  净漂移 = ${((afterOpen.max - afterOpen.st) - (afterClose.max - afterClose.st)).toFixed(3)}px`);
    log(`  打开时 JS 写入次数 = ${openLog.length}（若为 0 → 说明是原生 clamp 或 CSS 布局导致）`);

    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    console.log(`\n报告：${OUT_TXT}`);
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
    distServer?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};

main().catch((e) => {
  console.error("探针失败:", e);
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
  process.exit(2);
});
