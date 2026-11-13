/**
 * #2 浏览器侧取证：「第一次打开软件切到编辑模式偶发崩溃（ErrorBoundary）」。
 *
 * ## 与真机版的分工
 * - 本文件：**纯前端渲染路径**的崩溃取证。能覆盖 React 渲染期抛错、
 *   iframe `contentDocument` 为 null、`doc.body` 为 null（§4-27d 记过的坑）等。
 * - `v0170-r2-coldstart.mjs`（真机）：进程级冷启动 + WebView2 特有行为。
 *
 * ## 为什么要多轮
 * 用户说"偶尔"。单轮跑过不代表没问题 → 必须 ≥5 轮，每轮**全新 Chrome profile**
 * （空 localStorage = 真冷启动的等价物），统计复现率。
 *
 * ## 采集口径（四条独立证据，缺一条都不算复现）
 * 1. `window.__ERRS`：未捕获异常 + unhandledrejection
 * 2. **CDP `Runtime.exceptionThrown`**：React 错误边界**吞掉**的渲染错误也在这里
 *    （`window.onerror` 抓不到 React 的 throw，这是关键补充）
 * 3. `.error-boundary` DOM 是否出现（用户唯一能看到的症状）
 * 4. `console.error` 里的 `[ErrorBoundary] 渲染出错:`（ErrorBoundary 自己打的带 componentStack）
 *
 * ## 触发动作（按用户描述逐步加压）
 * A. 冷启动 → **立即**切编辑（不等文档装载完）
 * B. 冷启动 → 装文档 → 立即切编辑
 * C. 冷启动 → 装文档 → 切编辑 → 切阅读 → 切编辑（往返）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const DIST = process.env.BROWSER_PROBE_DIST
  ? path.resolve(process.env.BROWSER_PROBE_DIST)
  : path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "_verify-out");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROUNDS = Number(process.env.COLD_ROUNDS || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".map": "application/json",
};

const portFree = (port) => new Promise((res) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(false); });
  s.on("error", () => res(true));
  s.setTimeout(500, () => { s.destroy(); res(true); });
});
const pickPort = async (base) => {
  for (let i = 0; i < 80; i++) {
    const p = base + Math.floor(Math.random() * 160);
    if (await portFree(p)) return p;
  }
  throw new Error("no free port");
};

function serveStatic(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        const file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404); res.end("nf"); return;
        }
        res.writeHead(200, {
          "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "cache-control": "no-store",
        });
        fs.createReadStream(file).pipe(res);
      } catch { res.writeHead(500); res.end("e"); }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function wsConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    /** v0.17.0 第二轮：#2 需要 CDP 事件流（Runtime.exceptionThrown），骨架原有的 send-only 不够 */
    const eventHandlers = new Map();
    ws.addEventListener("open", () => res({
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((a, b) => {
          pending.set(i, { a, b });
          setTimeout(() => { if (pending.delete(i)) b(new Error("CDP timeout: " + method)); }, 30000);
        });
      },
      on(method, fn) { eventHandlers.set(method, fn); },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.method) { const fn = eventHandlers.get(m.method); if (fn) { try { fn(m.params); } catch { /* ignore */ } } return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error).slice(0, 300))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws err")));
    setTimeout(() => rej(new Error("ws timeout")), 30000);
  });
}

const DOC = (() => {
  const parts = ["# 冷启动崩溃复现", ""];
  for (let i = 1; i <= 40; i++) {
    parts.push(`第 ${i} 段。PI${String(i).padStart(2, "0")}。Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`, "");
    if (i === 5) parts.push("- 列表 A", "- 列表 B", "");
    if (i === 10) parts.push("```js", "const a = 1;", "```", "");
    if (i === 15) parts.push("| 列1 | 列2 |", "| --- | --- |", "| a | b |", "");
    if (i === 20) parts.push("### 三级标题", "");
    if (i === 25) parts.push("> 引用块", "");
  }
  return parts.join("\n");
})();

const summary = [];

for (let round = 1; round <= ROUNDS; round++) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `lmd-cold-${round}-`));
  const { server, port: httpPort } = await serveStatic(DIST);
  const cdpPort = await pickPort(9100);
  let child = null;
  let cdp = null;
  const rec = {
    round, boundary: null, uncaught: [], exceptionThrown: [], consoleErrs: [],
    stack: null, layout: null, scenario: null,
  };

  try {
    child = spawn(CHROME, [
      `--remote-debugging-port=${cdpPort}`, `--remote-allow-origins=*`,
      `--user-data-dir=${profile}`, "--headless=new", "--no-first-run",
      "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1600,1000", "--force-device-scale-factor=1",
      `http://127.0.0.1:${httpPort}/index.html`,
    ], { stdio: "ignore" });

    const t0 = Date.now();
    for (let i = 0; i < 250 && !cdp; i++) {
      if (Date.now() - t0 > 45000) throw new Error("chrome 启动超时");
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          if (!String(t.url || "").includes("127.0.0.1")) continue;
          const c = await wsConnect(t.webSocketDebuggerUrl).catch(() => null);
          if (c) { cdp = c; break; }
        }
      } catch { /* not ready */ }
      if (!cdp) await sleep(250);
    }
    if (!cdp) throw new Error("找不到 CDP target");

    /* ⚠️ 关键：必须在页面脚本执行前开 Runtime，才能收到 exceptionThrown。
       即便晚了一步，后续 React 渲染期抛错仍会到这里。 */
    await cdp.send("Runtime.enable").catch(() => {});
    await cdp.send("Page.enable").catch(() => {});
    // 先装 CDP 事件监听（刷新后仍然有效）
    cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p?.exceptionDetails;
      if (!d) return;
      const ex = d.exception;
      rec.exceptionThrown.push({
        text: d.text,
        desc: ex?.description ? String(ex.description).slice(0, 1500) : null,
        url: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
      });
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p?.type !== "error") return;
      try {
        const s = (p.args || []).map((a) => a?.value ?? a?.description ?? "").join(" ");
        if (/ErrorBoundary|渲染出错|Something went wrong|Cannot read|undefined is not/.test(s)) {
          rec.consoleErrs.push(String(s).slice(0, 1500));
        }
      } catch { /* ignore */ }
    });
    // 收到事件后重新 enable 一次，确保 listener 已生效
    await cdp.send("Runtime.enable").catch(() => {});

    const ev = async (bodyRaw) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${bodyRaw} })()`, returnByValue: true, awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        rec.uncaught.push(JSON.stringify(r.result.exceptionDetails).slice(0, 1200));
      }
      return r.result?.result?.value;
    };

    /* 等 React 挂载 */
    let mounted = false;
    for (let i = 0; i < 120; i++) {
      mounted = await ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
      if (mounted) break;
      await sleep(200);
    }
    if (!mounted) throw new Error("React 未挂载");

    /* 页面侧采集器 */
    await ev(`
      window.__ERRS = window.__ERRS || [];
      window.__BOUNDARY_HITS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
      window.addEventListener("unhandledrejection", (e) =>
        window.__ERRS.push("rejection:" + String((e.reason && e.reason.message) || e.reason)));
      if (!window.__BOUNDARY_MO) {
        window.__BOUNDARY_MO = new MutationObserver(() => {
          const el = document.querySelector(".error-boundary, [data-testid='error-boundary']");
          if (el && window.__BOUNDARY_HITS.length < 20) {
            window.__BOUNDARY_HITS.push({ t: Math.round(performance.now()), text: (el.textContent || "").slice(0, 300) });
          }
        });
        window.__BOUNDARY_MO.observe(document.documentElement, { childList: true, subtree: true });
      }
      return true;
    `);

    /**
     * 三轮场景加压。每轮都从**未进过编辑模式**的初始态开始（这正是"第一次"的语义）：
     *  A：立即切编辑（不等文档）
     *  B：装文档后立即切
     *  C：装文档 → 切编辑 → 切阅读 → 切编辑
     */
    const runScenario = async (label, fn) => {
      rec.scenario = label;
      await fn();
      await ev(`
        return { errs: (window.__ERRS || []).slice(), hits: (window.__BOUNDARY_HITS || []).slice() };
      `);
    };

    // 场景 A：冷启动立即切编辑
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
    await sleep(700);
    await sleep(2600);

    // 场景 B：装文档
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: "D:/tmp/v0170-cold.md", name: "v0170-cold.md", content: ${JSON.stringify(DOC)} },
      }));
      return true;
    `);
    await sleep(2600);

    // 场景 C：再往返一次
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.preview" } })); return true;`);
    await sleep(2200);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
    await sleep(2600);

    const final = await ev(`
      const el = document.querySelector(".error-boundary, [data-testid='error-boundary']");
      const f = document.querySelector("iframe.split-preview");
      const d = f && f.contentDocument;
      const sc = document.querySelector(".cm-scroller");
      return {
        boundary: !!el,
        boundaryText: el ? (el.textContent || "").slice(0, 400) : null,
        boundaryDetail: (() => { const p = document.querySelector("[data-testid='error-boundary-detail']"); return p ? (p.textContent || "").slice(0, 800) : null; })(),
        errs: (window.__ERRS || []).slice(),
        hits: (window.__BOUNDARY_HITS || []).slice(),
        hasCm: !!document.querySelector(".cm-editor"),
        cmLines: document.querySelectorAll(".cm-line").length,
        hasIframe: !!f,
        iframeDoc: d ? { hasBody: !!d.body, bodyChildren: d.body ? d.body.children.length : -1, readyState: d.readyState } : null,
        splitW: (() => { const s = document.querySelector(".split-preview-shell"); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
        scrollerH: sc ? sc.clientHeight : 0,
      };
    `);

    rec.boundary = final.boundary;
    rec.layout = final;
    if (final.boundaryDetail) rec.stack = final.boundaryDetail;
    if (!rec.stack && rec.exceptionThrown.length) rec.stack = rec.exceptionThrown[0].desc;
    if (!rec.stack && final.errs?.length) rec.stack = String(final.errs[0]);

    console.log(`[轮 ${round}] boundary=${final.boundary} errs=${(final.errs || []).length} ` +
      `cdpExceptions=${rec.exceptionThrown.length} consoleErrs=${rec.consoleErrs.length} ` +
      `cm=${final.hasCm}/${final.cmLines} iframe=${final.hasIframe}/${JSON.stringify(final.iframeDoc)}`);
    if (final.boundaryText) console.log(`  边界文案：${final.boundaryText.slice(0, 200)}`);
    if (rec.stack) console.log(`  首个堆栈：${String(rec.stack).split("\n").slice(0, 6).join("\n    ")}`);
    if (rec.exceptionThrown.length) console.log(`  CDP 异常：${JSON.stringify(rec.exceptionThrown[0]).slice(0, 600)}`);
  } catch (err) {
    console.log(`[轮 ${round}] 探针异常：${err?.message || String(err)}`);
    rec.boundary = `probe-error: ${err?.message || String(err)}`;
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    await sleep(400);
  }
  summary.push(rec);
}

/* ═══ 汇总 ═══ */
const failed = summary.filter((r) => r.boundary === true);
const lines = [
  `#2 冷启动切编辑·浏览器侧复现统计（${ROUNDS} 轮，每轮全新 profile = 空 localStorage）`,
  ``,
  `复现率（错误边界出现）：${failed.length}/${ROUNDS}`,
  `有 CDP 异常抛出的轮次：${summary.filter((r) => r.exceptionThrown.length > 0).length}/${ROUNDS}`,
  `有未捕获异常的轮次：${summary.filter((r) => (r.layout?.errs || []).length > 0).length}/${ROUNDS}`,
  ``,
];
for (const r of summary) {
  lines.push(`轮 ${r.round}: boundary=${r.boundary} errs=${(r.layout?.errs || []).length} ` +
    `cdpExceptions=${r.exceptionThrown.length} consoleErrs=${r.consoleErrs.length} ` +
    `cm=${r.layout?.hasCm}/${r.layout?.cmLines} iframe=${r.layout?.hasIframe} iframeDoc=${JSON.stringify(r.layout?.iframeDoc)}`);
  for (const e of r.exceptionThrown.slice(0, 2)) {
    lines.push(`  [CDP] ${e.text} @ ${e.url}:${e.line}:${e.col}`);
    if (e.desc) lines.push(`        ${String(e.desc).split("\n").slice(0, 8).join("\n        ")}`);
  }
  for (const e of r.consoleErrs.slice(0, 2)) lines.push(`  [console] ${String(e).slice(0, 600)}`);
  for (const e of (r.layout?.errs || []).slice(0, 2)) lines.push(`  [page] ${String(e).slice(0, 400)}`);
  if (r.layout?.boundaryDetail) lines.push(`  [boundary] ${String(r.layout.boundaryDetail).slice(0, 600)}`);
  if (r.layout?.boundaryText) lines.push(`  [boundaryText] ${String(r.layout.boundaryText).slice(0, 300)}`);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "v0170-r2-crash-browser-summary.txt");
fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
console.log("\n" + lines.join("\n"));
console.log(`[summary] ${outPath}`);
if (failed.length > 0 || summary.some((r) => r.exceptionThrown.length > 0)) process.exitCode = 1;
