/**
 * #2 定向取证：「首次切编辑」时 HistoryHost 的 **render 期** 锚点采集路径。
 *
 * ## 为什么盯这条路径（静态分析结论）
 * `src/components/editor/panes/historyhost/HistoryHost.tsx` 在 **render 期**（不是 effect）
 * 直接读 DOM 并做几何测量：
 * ```ts
 * if (prevViewModeRef.current !== viewMode && anchorCapturedForModeRef.current !== viewMode) {
 *   const anchor = prevViewModeRef.current === "preview"
 *     ? captureReaderContentAnchor()      // ← render 期读 .editor-container + collectPmBlockGeometry
 *     : captureSourceContentAnchor();     // ← render 期读 surface metrics + measureSourceBlocks
 *   modeSwitchAnchorRef.current = anchor ?? null;
 * }
 * ```
 * **render 期抛错 = ErrorBoundary 接管 = 用户看到 "Something went wrong"**。
 * 而且点「重试」后 `ErrorBoundary` 重置 state 重新挂载子树，此时
 * `prevViewModeRef` 已与 `viewMode` 相同 → 不再走这段 → **不再抛 → 恢复正常**。
 * 这与用户描述"偶尔崩溃 + 点重试才能正常"高度吻合。
 *
 * ## 本探针要回答的三件事
 * 1. 首次切编辑时，render 期采集路径**是否真的被走到**（trace 的 `cap-reader` / `cap-source`）
 * 2. 走到的那些调用**是否抛错**（CDP `Runtime.exceptionThrown` + `window.__ERRS`）
 * 3. 采集函数返回什么（`ok` / `live` / `fresh` / 块数）—— 若在这里拿到异常数据，
 *    后续 `restoreContentAnchor` 也可能抛出（它没有全包 try）
 *
 * ## 加压手段
 * - 场景 A：空文档 + 立即切编辑
 * - 场景 B：大文档（含表格/代码/列表）+ 立即切编辑
 * - 场景 C：阅读模式滚到中间 + 切编辑（`captureReaderContentAnchor` 现量块几何，最重）
 * - 场景 D：编辑模式滚到中间 + 切阅读（`captureSourceContentAnchor` 现量行轴，最重）
 * 每个场景各 3 轮，每轮全新 profile。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const DIST = process.env.BROWSER_PROBE_DIST ? path.resolve(process.env.BROWSER_PROBE_DIST) : path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "_verify-out");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROUNDS = Number(process.env.ROUNDS || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".map": "application/json",
};
const portFree = (port) => new Promise((res) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(false); });
  s.on("error", () => res(true)); s.setTimeout(500, () => { s.destroy(); res(true); });
});
const pickPort = async (base) => {
  for (let i = 0; i < 80; i++) { const p = base + Math.floor(Math.random() * 160); if (await portFree(p)) return p; }
  throw new Error("no free port");
};
function serveStatic(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        const u = decodeURIComponent((req.url || "/").split("?")[0]);
        const f = path.join(root, u === "/" ? "index.html" : u);
        if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
        fs.createReadStream(f).pipe(res);
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
function wsConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map(); const handlers = new Map();
    ws.addEventListener("open", () => res({
      send(m, p) { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 30000); }); },
      on(m, fn) { handlers.set(m, fn); },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.method) { const fn = handlers.get(m.method); if (fn) { try { fn(m.params); } catch { /* ignore */ } } return; }
      const it = pending.get(m.id); if (!it) return; pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error).slice(0, 300))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws err")));
    setTimeout(() => rej(new Error("ws timeout")), 30000);
  });
}

const DOC_BIG = (() => {
  const p = ["# render 期采集加压", ""];
  for (let i = 1; i <= 80; i++) {
    p.push(`第 ${i} 段。PI${String(i).padStart(2, "0")}。Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore.`, "");
    if (i % 7 === 0) p.push("```js", "const x = 1;", "```", "");
    if (i % 11 === 0) p.push("| A | B |", "| --- | --- |", "| 1 | 2 |", "");
    if (i % 13 === 0) p.push("- 项 A", "- 项 B", "- 项 C", "");
    if (i % 17 === 0) p.push("### 小节", "");
  }
  return p.join("\n");
})();
const DOC_SMALL = ["# 小文档", "", "唯一一段。", ""].join("\n");

const results = [];

for (let round = 1; round <= ROUNDS; round++) {
  for (const scenario of ["A", "B", "C", "D"]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `lmd-render-${scenario}${round}-`));
    const { server, port: httpPort } = await serveStatic(DIST);
    const cdpPort = await pickPort(9200);
    let child = null, cdp = null;
    const rec = { round, scenario, exceptions: [], pageErrs: [], caps: [], boundary: null, note: "" };

    try {
      child = spawn(CHROME, [
        `--remote-debugging-port=${cdpPort}`, `--remote-allow-origins=*`, `--user-data-dir=${profile}`,
        "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
        "--hide-scrollbars", "--window-size=1600,1000", "--force-device-scale-factor=1",
        `http://127.0.0.1:${httpPort}/index.html`,
      ], { stdio: "ignore" });

      const t0 = Date.now();
      for (let i = 0; i < 250 && !cdp; i++) {
        if (Date.now() - t0 > 45000) throw new Error("chrome timeout");
        try {
          const ts = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
          for (const t of ts) {
            if (t.type !== "page" || !t.webSocketDebuggerUrl || !String(t.url || "").includes("127.0.0.1")) continue;
            const c = await wsConnect(t.webSocketDebuggerUrl).catch(() => null);
            if (c) { cdp = c; break; }
          }
        } catch { /* not ready */ }
        if (!cdp) await sleep(250);
      }
      if (!cdp) throw new Error("no cdp");

      await cdp.send("Runtime.enable").catch(() => {});
      await cdp.send("Page.enable").catch(() => {});
      cdp.on("Runtime.exceptionThrown", (p) => {
        const d = p?.exceptionDetails; if (!d) return;
        rec.exceptions.push({ text: d.text, desc: d.exception?.description ? String(d.exception.description).slice(0, 1200) : null });
      });
      await cdp.send("Runtime.enable").catch(() => {});

      const ev = async (body) => {
        const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, returnByValue: true, awaitPromise: true });
        if (r.result?.exceptionDetails) rec.pageErrs.push(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
        return r.result?.result?.value;
      };

      for (let i = 0; i < 120; i++) {
        if (await ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false)) break;
        await sleep(200);
      }

      /* 装 trace 收集器 —— 这是"路径是否被走到"的唯一证据 */
      await ev(`
        window.__LMD_SCROLL_TRACE = [];
        window.__ERRS = [];
        window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
        window.addEventListener("unhandledrejection", (e) =>
          window.__ERRS.push("rejection:" + String((e.reason && e.reason.message) || e.reason)));
        return true;
      `);

      const doc = scenario === "A" || scenario === "C" ? DOC_BIG : DOC_BIG;
      if (scenario === "A") {
        // 空文档 + 立即切编辑（用户"第一次打开软件"的最裸形态：还没有任何文档）
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
        await sleep(2600);
        rec.note = "空文档/无文档 → 立即切编辑";
      } else if (scenario === "B") {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: "D:/tmp/r1.md", name: "r1.md", content: ${JSON.stringify(doc)} } })); return true;`);
        await sleep(2600);
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
        await sleep(2600);
        rec.note = "大文档装入 → 立即切编辑";
      } else if (scenario === "C") {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: "D:/tmp/r2.md", name: "r2.md", content: ${JSON.stringify(doc)} } })); return true;`);
        await sleep(2600);
        // 阅读模式滚到中间，再切编辑（captureReaderContentAnchor 现量块几何，最重）
        await ev(`
          const c = document.querySelector(".editor-container");
          if (c) { c.scrollTop = (c.scrollHeight - c.clientHeight) * 0.5; c.dispatchEvent(new Event("scroll", { bubbles: true })); }
          return true;
        `);
        await sleep(1400);
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
        await sleep(2600);
        rec.note = "阅读滚到 50% → 切编辑（render 期现量 PM 块几何）";
      } else {
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: "D:/tmp/r3.md", name: "r3.md", content: ${JSON.stringify(doc)} } })); return true;`);
        await sleep(2600);
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
        await sleep(2400);
        await ev(`
          const sc = document.querySelector(".cm-scroller");
          if (sc) { sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * 0.5; sc.dispatchEvent(new Event("scroll", { bubbles: true })); }
          return true;
        `);
        await sleep(1400);
        await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.preview" } })); return true;`);
        await sleep(2600);
        rec.note = "编辑滚到 50% → 切阅读（render 期现量源码行轴）";
      }

      const final = await ev(`
        const tr = (window.__LMD_SCROLL_TRACE || []).filter((e) => /^(cap-)/.test(String(e.event)));
        const b = document.querySelector(".error-boundary, [data-testid='error-boundary']");
        return {
          caps: tr.slice(-12),
          capCount: tr.length,
          errs: (window.__ERRS || []).slice(),
          boundary: !!b,
          boundaryText: b ? (b.textContent || "").slice(0, 300) : null,
        };
      `);
      rec.caps = final.caps;
      rec.pageErrs.push(...(final.errs || []));
      rec.boundary = final.boundary;
      if (final.boundaryText) rec.note += ` | 边界:${final.boundaryText.slice(0, 150)}`;

      const capKinds = [...new Set(rec.caps.map((c) => c.event))].join(",");
      console.log(`[${scenario} 轮${round}] capCount=${final.capCount} kinds=${capKinds || "(无)"} ` +
        `okFlags=${rec.caps.map((c) => `${c.event}:${c.ok}`).join(" ")} ` +
        `exceptions=${rec.exceptions.length} pageErrs=${rec.pageErrs.length} boundary=${rec.boundary}`);
    } catch (err) {
      rec.note += ` 探针异常:${err?.message || String(err)}`;
      console.log(`[${scenario} 轮${round}] 异常 ${err?.message || String(err)}`);
    } finally {
      try { cdp?.close(); } catch { /* ignore */ }
      try { child?.kill(); } catch { /* ignore */ }
      try { server.close(); } catch { /* ignore */ }
      await sleep(350);
    }
    results.push(rec);
  }
}

/* ═══ 汇总 ═══ */
const lines = [
  `#2 定向取证：render 期锚点采集路径（${ROUNDS} 轮 × 4 场景）`,
  ``,
  `## 路径是否被走到`,
];
const anyCap = results.filter((r) => r.caps.length > 0);
lines.push(`有 cap-* 埋点的场景数：${anyCap.length}/${results.length}`);
for (const r of results) {
  lines.push(`- [${r.scenario} 轮${r.round}] ${r.note}`);
  lines.push(`  capCount=${r.caps.length} kinds=${[...new Set(r.caps.map((c) => c.event))].join(",") || "(无)"}`);
  for (const c of r.caps.slice(0, 6)) {
    lines.push(`    ${JSON.stringify(c)}`);
  }
  lines.push(`  exceptions=${r.exceptions.length} pageErrs=${r.pageErrs.length} boundary=${r.boundary}`);
  for (const e of r.exceptions.slice(0, 2)) {
    lines.push(`    [CDP] ${e.text}`);
    if (e.desc) lines.push(`          ${String(e.desc).split("\n").slice(0, 6).join("\n          ")}`);
  }
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "v0170-r2-render-capture-summary.txt");
fs.writeFileSync(out, lines.join("\n") + "\n", "utf8");
console.log("\n" + lines.slice(0, 40).join("\n"));
console.log(`[summary] ${out}`);
