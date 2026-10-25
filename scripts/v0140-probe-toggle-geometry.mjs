/**
 * 诊断探针：预览开/关时左栏 textarea 的**宽度 / scrollHeight / max / scrollTop** 如何变化。
 *
 * 假设（待验证）：预览开合会改变左栏宽度 → 软换行重排 → scrollHeight 变化 → max 变化。
 * 若文档正好在**底部**，scrollTop 会被单向 clamp（关预览时 max 变小，scrollTop 被压低，
 * 且这个差值不可逆），于是每次 关→开 循环都净损失一点 → 累积上漂。
 *
 * 本脚本逐帧（rAF）采样整个开合过程，落盘完整时间线。
 *
 * 用法：node scripts/v0140-probe-toggle-geometry.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_GEO_PORT || 9288);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0140-probe-toggle-geometry.txt");
const SERVE_DIST = process.env.V0140_GEO_SERVE === "1";
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

/** 长文档：含大量长行（保证软换行随宽度变化而重排） */
function makeDoc() {
  const p = ["# 宽度变化诊断文档", ""];
  const long = (i) => `第 ${i} 段：这是一段刻意写长的正文，用于让 textarea 的 white-space: pre-wrap 在较窄宽度下折成更多视觉行，从而 scrollHeight 随左栏宽度变化而变化。继续堆字以拉长该逻辑行，确保在不同宽度下折行数明显不同。`;
  for (let i = 1; i <= 100; i++) {
    p.push(long(i));
    p.push("");
  }
  p.push("## 末段");
  p.push("最后一段用于确认底部。");
  return p.join("\n");
}

const PAGE_TOOLS = String.raw`
function __mirrorFor(ta) {
  const cs = getComputedStyle(ta);
  const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
  const mirror = document.createElement("div");
  mirror.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;" +
    "box-sizing:border-box;width:" + (ta.clientWidth + bl + br) + "px;" +
    "padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";" +
    "border-style:solid;border-width:" + cs.borderTopWidth + " " + cs.borderRightWidth + " " + cs.borderBottomWidth + " " + cs.borderLeftWidth + ";" +
    "white-space:pre-wrap;word-break:" + cs.wordBreak + ";" +
    "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";font-weight:" + cs.fontWeight + ";" +
    "font-style:" + cs.fontStyle + ";line-height:" + cs.lineHeight + ";letter-spacing:" + cs.letterSpacing + ";" +
    "tab-size:" + cs.tabSize + ";margin:0;overflow:hidden;";
  document.body.appendChild(mirror);
  return mirror;
}
function __lineTops(ta) {
  const text = ta.value, mirror = __mirrorFor(ta);
  try {
    const lns = text.split("\n"), markers = [];
    for (let k = 0; k < lns.length; k++) {
      const m = document.createElement("span"); m.textContent = "\u200b";
      mirror.appendChild(m); markers.push(m);
      mirror.appendChild(document.createTextNode(lns[k] + (k < lns.length - 1 ? "\n" : "")));
    }
    const boxTop = mirror.getBoundingClientRect().top;
    return markers.map((m) => m.getBoundingClientRect().top - boxTop);
  } finally { mirror.remove(); }
}
function __topLine(tops, scrollTop) {
  if (!tops || tops.length < 2) return 0;
  let lo = 0, hi = tops.length - 1;
  if (scrollTop <= tops[0]) return 0;
  if (scrollTop >= tops[hi]) return hi;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= scrollTop) lo = mid; else hi = mid - 1; }
  const span = tops[lo + 1] - tops[lo];
  if (!(span > 0)) return lo;
  return lo + Math.min(1, Math.max(0, (scrollTop - tops[lo]) / span));
}
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-geo-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "geo-long.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
  await sleep(1200);

  let distServer = null;
  if (SERVE_DIST) { distServer = await startDistServer(); console.log("[probe] dist served"); }

  /**
   * ⚠️ 关键前置校验：**exe 内联的 dist 必须与当前 dist/ 一致**。
   *
   * 本轮踩过的坑：`cargo build --release` / 旧一次 `npx tauri build` 产出的 exe 内联的是
   * **当时**的 dist hash；改完源码只跑 `npx vite build` 只更新 `dist/`，exe 里仍是旧 JS。
   * 于是探针观测的一直是**修复前**的代码，白跑了十几轮，还反过来让人怀疑修复无效。
   * `V0140_GEO_SERVE=1` 起的 1420 服务对 release exe **完全无效**（它不走 devUrl）。
   * 所以这里直接读 exe 字节流做 hash 比对，不匹配就中止并给出正确命令。
   */
  {
    const html = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
    const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
    const wantHash = m ? m[0] : null;
    if (!wantHash) throw new Error("dist/index.html 里找不到 index-*.js，请先 npx vite build");
    const exeBuf = fs.readFileSync(EXE);
    if (!exeBuf.includes(Buffer.from(wantHash))) {
      throw new Error(
        `exe 内联的 dist 已过期（dist 是 ${wantHash}，exe 里没有）。\n` +
        `必须先执行：npx tauri build --no-bundle\n` +
        `（注意：只跑 npx vite build 不够；cargo build --release 会产出 dev 二进制，也不行）`
      );
    }
    console.log("[probe] exe 内联 dist 校验通过：" + wantHash);
  }

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

  const ev = async (body, awaitPromise = true) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true, awaitPromise,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };

  try {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } })); return true;`);
    await sleep(1500);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
    await sleep(1200);

    // 守卫：确认文档真的加载进了 textarea（否则后面测的是空文档，数据无意义）
    // WebView2 冷启动偶发首帧丢事件 → 每轮重试都**重新派发** openFile + view.edit
    for (let attempt = 0; attempt < 8; attempt++) {
      const ready = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        return ta ? { len: ta.value.length, sh: ta.scrollHeight, ch: ta.clientHeight,
                      max: Math.max(0, ta.scrollHeight - ta.clientHeight) } : null;`);
      if (ready && ready.len === docText.length && ready.max > 100) { log("文档就绪：" + JSON.stringify(ready)); break; }
      if (attempt === 7) throw new Error("文档未加载成功，探针中止：" + JSON.stringify(ready));
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } })); return true;`);
      await sleep(1000);
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
      await sleep(900);
    }

    // 滚到最底部
    await ev(`
      const ta = document.querySelector("textarea.source-editor");
      ta.scrollTop = ta.scrollHeight - ta.clientHeight;
      ta.dispatchEvent(new Event("scroll", { bubbles: false }));
      return ta.scrollTop;`);
    await sleep(800);

    /**
     * 把文档稳定地滚到底并等待布局/联动彻底静止。
     *
     * 为什么每个场景都要重做一次：场景 A 结束在"关闭态"、场景 B 从"关闭态"开始，
     * 中间若沿用旧基线，会被上一场景残留的异步同步（iframe 重排、百分比恢复）
     * 带偏几像素，测出来的"漂移"其实是基线不干净。
     * 这里反复写到底直到连续两次读数一致（最多 6 轮），才算真正静止。
     */
    const settleToBottom = async () => {
      await ev(`
        return new Promise((resolve) => {
          const ta = document.querySelector("textarea.source-editor");
          let last = -1, same = 0, n = 0;
          const step = () => {
            const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
            ta.scrollTop = max;
            const st = +ta.scrollTop.toFixed(2);
            same = (st === last) ? same + 1 : 0;
            last = st;
            if (++n >= 18 || same >= 3) return resolve({ st, max: +max.toFixed(2), gap: +(max - st).toFixed(2) });
            setTimeout(step, 80);
          };
          step();
        });`);
      await sleep(300);
      return ev(`const ta=document.querySelector("textarea.source-editor");
        const max=Math.max(0,ta.scrollHeight-ta.clientHeight);
        return {st:+ta.scrollTop.toFixed(2), max:+max.toFixed(2), gap:+(max-ta.scrollTop).toFixed(2), open:!!document.querySelector(".split-preview-open")};`);
    };

    log("════════ 关键几何关系 ════════");

    /**
     * 采样：在页面里起一个**定时**采样循环（用 setTimeout 而非 rAF ——
     * WebView2 在窗口不可见/后台时 rAF 会被节流甚至暂停，实测只跑到 44 帧就停，
     * 于是还原窗口（1.3s）还没到采样就结束了，误判"修复无效"）。
     * 每 16ms 一帧，共 actionIdx + 250 帧（≈4s，完整覆盖冻结窗口）。
     */
    const runTimeline = async (label, actionIdx) =>
      ev(`
        return new Promise((resolve) => {
          const ta = document.querySelector("textarea.source-editor");
          const shell = document.querySelector(".split-preview-shell");
          const frames = [];
          let f = 0;
          let toggled = false;
          const t0 = performance.now();
          const tick = () => {
            const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
            frames.push({
              f, dt: +(performance.now() - t0).toFixed(1),
              w: +ta.clientWidth.toFixed(2),
              sw: +ta.scrollWidth.toFixed(2),
              sh: +ta.scrollHeight.toFixed(2),
              ch: +ta.clientHeight.toFixed(2),
              max: +max.toFixed(2),
              st: +ta.scrollTop.toFixed(3),
              // 底部"剩余量"：scrollTop 到 max 的距离
              gap: +(max - ta.scrollTop).toFixed(3),
              open: !!shell && shell.classList.contains("split-preview-open"),
              shellW: shell ? +shell.getBoundingClientRect().width.toFixed(2) : -1,
              pct: max > 0 ? +(ta.scrollTop / max * 100).toFixed(3) : 100,
            });
            f++;
            if (!toggled && f >= ${actionIdx}) {
              toggled = true;
              window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } }));
            }
            if (f < ${actionIdx} + 250) setTimeout(tick, 16);
            else resolve(frames);
          };
          setTimeout(tick, 16);
        });
      `);

    log("");
    log("── 场景 A：文档在底部 → 关闭预览（逐帧）──");
    // 场景 A 起点：预览必须是**打开**态，且文档稳定贴底
    {
      const s = await ev(`return {open:!!document.querySelector(".split-preview-open")}`);
      if (!s.open) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.togglePreview"}}));return 1`);
        await sleep(2200);
      }
      log("  基线（settle 后）：" + JSON.stringify(await settleToBottom()));
    }
    const closeTl = await runTimeline("close", 5);
    log("  f | dt | taW | shellW | sh | max | st | gap | pct | open");
    let prevSt = null;
    for (const r of closeTl) {
      if (prevSt !== null && Math.abs(r.st - prevSt) > 0.01) log(`  ${String(r.f).padStart(2)} | ${String(r.dt).padStart(6)} | ${String(r.w).padStart(7)} | ${String(r.shellW).padStart(7)} | ${String(r.sh).padStart(8)} | ${String(r.max).padStart(8)} | ${String(r.st).padStart(9)} | ${String(r.gap).padStart(6)} | ${String(r.pct).padStart(6)} | ${r.open}`);
      prevSt = r.st;
    }
    await sleep(600);

    log("");
    log("── 场景 B：关闭态（稳态）→ 打开预览（逐帧）──");
    // 场景 B 起点：预览必须是**关闭**态，重新建立干净基线（否则会拿上一场景的残留当基准）
    {
      const s = await ev(`return {open:!!document.querySelector(".split-preview-open")}`);
      if (s.open) {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.togglePreview"}}));return 1`);
        await sleep(2200);
      }
      log("  基线（settle 后）：" + JSON.stringify(await settleToBottom()));
    }
    const openTl = await runTimeline("open", 5);
    log("  f | dt | taW | shellW | sh | max | st | gap | pct | open");
    let prevSt2 = null;
    for (const r of openTl) {
      if (prevSt2 !== null && Math.abs(r.st - prevSt2) > 0.01) log(`  ${String(r.f).padStart(2)} | ${String(r.dt).padStart(6)} | ${String(r.w).padStart(7)} | ${String(r.shellW).padStart(7)} | ${String(r.sh).padStart(8)} | ${String(r.max).padStart(8)} | ${String(r.st).padStart(9)} | ${String(r.gap).padStart(6)} | ${String(r.pct).padStart(6)} | ${r.open}`);
      prevSt2 = r.st;
    }
    await sleep(800);

    log("");
    log("════════ 稳态对照：宽度 → max 的关系 ════════");
    const closedSteady = closeTl[closeTl.length - 1];
    const openedSteady = openTl[openTl.length - 1];
    log("  采样帧数：close=" + closeTl.length + " open=" + openTl.length);
    log(`  关闭态：宽度=${closedSteady.w} max=${closedSteady.max} scrollTop=${closedSteady.st} gap=${closedSteady.gap}`);
    log(`  打开态：宽度=${openedSteady.w} max=${openedSteady.max} scrollTop=${openedSteady.st} gap=${openedSteady.gap}`);
    log(`  ⚠️ max 差值（开 - 关）= ${(openedSteady.max - closedSteady.max).toFixed(2)}px`);
    log(`  ⚠️ scrollTop 差值（开 - 关）= ${(openedSteady.st - closedSteady.st).toFixed(2)}px`);
    log(`  ⚠️ 净漂移（gap 差）= ${(openedSteady.gap - closedSteady.gap).toFixed(3)}px`);

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
