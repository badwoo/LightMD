/**
 * v0.17.0 诊断：5MB 大文件下 CM6 文档为何为空
 *
 * ## 已确认（Lead 的 perf-bench，量具已修成双实现）
 * ```
 * round 2: {impl:"cm6", ready:true, len:0, sh:1170, ch:1170, pmLen:3640376}
 * ```
 * - `impl=cm6`、`ready=true` → CM6 建起来了；
 * - `len=0`、`sh=1170`（几乎等于视口高）→ **文档确实是空的**；
 * - `pmLen=3640376` → PM 阅读面渲染了全文。
 *
 * ## 本探针要回答的三个问题
 * 1. 5MB 文件打开后，**`sourceContent` 是否有值**？（决定是"内容未到达"还是"到达了但没写进 CM6"）
 * 2. 内容同步 effect 是否执行过？（用 `getText()` 长度侧面判断）
 * 3. 是否存在**主线程阻塞**导致的 effect 未及时执行？
 *
 * 用法：node scripts/v0170-diag-5mb-empty.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9461;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const p = new Map();
    ws.addEventListener("open", () =>
      res({
        send(m, q) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: q }));
          return new Promise((a, b) => {
            p.set(i, { a, b });
            setTimeout(() => { if (p.delete(i)) b(new Error("timeout " + m)); }, 40000);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.method === "Runtime.consoleAPICalled") {
        console.log("[console]", m.params.args.map((a)=>a.value??a.description??"").join(" "));
      }
      const it = p.get(m.id);
      if (!it) return;
      p.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws")));
  });
}

// 造一个 >5MB 的 md
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd5-"));
const profile = path.join(tmp, "profile");
fs.mkdirSync(profile, { recursive: true });
const line = "This is a benchmark line with some **markdown** content and `code` here.\n";
const count = Math.ceil((5.2 * 1024 * 1024) / line.length);
const DOC = "# Big\n\n" + line.repeat(count);
const docFile = path.join(tmp, "big.md");
fs.writeFileSync(docFile, DOC, "utf8");
const bytes = Buffer.byteLength(DOC, "utf8");
console.log(`文档：${(bytes / 1024 / 1024).toFixed(2)}MB / ${DOC.split("\n").length} 行`);

let child = null;
let cdp = null;
try {
  child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 200 && !cdp; i++) {
    try {
      const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
      for (const t of ts) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        const c = await connect(t.webSocketDebuggerUrl);
        await c.send("Runtime.enable");
        const r = await c.send("Runtime.evaluate", {
          expression: `typeof window.__TAURI_INTERNALS__!=="undefined"`,
          returnByValue: true,
        });
        if (r.result?.result?.value) { cdp = c; break; }
        c.close();
      }
    } catch { /* ignore */ }
    if (!cdp) await sleep(350);
  }
  if (!cdp) throw new Error("no target");

  const ev = async (e, timeout = 40000) => {
    const r = await Promise.race([
      cdp.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result?.result?.value;
  };

  const probe = () => ev(`
    (function(){
      var ed = document.querySelector(".cm-editor");
      var ta = document.querySelector("textarea.source-editor");
      var scroller = ed && ed.querySelector(".cm-scroller");
      var lines = ed ? ed.querySelectorAll(".cm-line") : [];
      var text = Array.prototype.slice.call(lines).map(function(l){return l.textContent||"";}).join("\\n");
      return {
        impl: ed ? "cm6" : (ta ? "textarea" : "none"),
        cmEditor: !!ed,
        textarea: !!ta,
        renderedLines: lines.length,
        renderedTextLen: text.length,
        scrollerH: scroller ? scroller.scrollHeight : 0,
        scrollerCh: scroller ? scroller.clientHeight : 0,
        bodyTextLen: document.body ? document.body.innerText.length : 0,
        tabs: document.querySelectorAll("[role=tab], .tab-item, .editor-tab, [data-tab-id]").length,
        titleBarText: (document.querySelector(".title-bar") || {}).innerText || "",
        bodyPreview: document.body ? document.body.innerText.slice(0, 200) : "",
      };
    })()
  `);

  // 打开大文件（用 openFile 通道）
  console.log("→ 发送 openFile ...");
  const t0 = Date.now();
  const openResult = await ev(
    `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(docFile)},content:${JSON.stringify(DOC)},skipConflictCheck:true}}));"sent"`,
    60000,
  );
  console.log("openFile 结果:", JSON.stringify(openResult), `耗时 ${Date.now() - t0}ms`);

  // 轮询观察（大文件装载慢）
  for (let round = 0; round < 12; round++) {
    await sleep(2500);
    const st = await probe();
    console.log(`t=${((round + 1) * 2.5).toFixed(1)}s`, JSON.stringify(st));
    if (st && !st.__timeout && st.renderedLines > 3) {
      console.log("→ CM6 已有内容，停止轮询");
      break;
    }
  }

  console.log("=== 最终状态 ===");
  console.log(JSON.stringify(await probe()));
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }
}
