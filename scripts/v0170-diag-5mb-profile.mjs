/**
 * v0.17.0 诊断：5MB 复杂文档装载时**主线程时间花在哪**
 *
 * ## 已知（上一轮诊断结论）
 * | 文档 | 行数 | 可用耗时 |
 * |---|---|---|
 * | plain | 102,881 | 2.83s |
 * | math | 181,755 | 5.14s |
 * | table | 253,612 | 16.57s |
 * | complex（六类轮转） | 160,811 | **31.79s** |
 * | fence | 654,314 | 卡死 |
 *
 * **高亮不是根因**：同一份复杂文档，高亮开 31.79s、关 32.37s（几乎无差）。
 *
 * ## 本脚本要定位
 * 用 CDP `Profiler` 采 CPU profile，把耗时按函数归并，看是：
 * - `CmSourceSurface.setText` 里的 `tr` 构造；
 * - CM6 的 `measure`/`layout`；
 * - `@lezer/markdown` 解析；
 * - 还是 `getText()` 的 `doc.toString()`（每次 O(n)）。
 *
 * 用法：node scripts/v0170-diag-5mb-profile.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9465;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeComplexDoc(targetBytes) {
  const parts = ["# 性能基准文档（COMPLEX）", ""];
  let used = Buffer.byteLength(parts[0], "utf8") + 1;
  let i = 0;
  while (used < targetBytes) {
    i++;
    const before = parts.length;
    switch (i % 6) {
      case 1:
        parts.push(`## 第 ${i} 节：概述`, "", `第 ${i} 节的正文用于制造可滚动的行数与文本体积。内容包含中英文混排、标点符号与少量数学符号。`, "");
        break;
      case 2:
        parts.push(`### ${i}.1 要点清单`, "");
        for (let k = 1; k <= 4; k++) parts.push(`- 要点 ${i}.${k}：benchmark 采样条目，长度适中`);
        parts.push("");
        break;
      case 3:
        parts.push(`### ${i}.2 表格示例`, "", "| 指标 | 目标 | 实测 |", "|---|---|---|");
        for (let k = 1; k <= 3; k++) parts.push(`| 指标-${i}-${k} | p95 < 16ms | 待采样 |`);
        parts.push("");
        break;
      case 4:
        parts.push(`### ${i}.3 代码片段`, "", "```ts", `const section${i} = { id: ${i}, bytes: ${i * 48} };`, "```", "");
        break;
      case 5:
        parts.push(`> 第 ${i} 节的引用块：用于验证渲染管线在大量块下的表现。`, "");
        break;
      default:
        parts.push(`第 ${i} 节结束前的段落：$${i}^2$ 是一个行内公式示例，同时包含 \`code_span_${i}\` 与 **加粗**、*斜体* 混排。`, "");
    }
    for (let k = before; k < parts.length; k++) used += Buffer.byteLength(parts[k], "utf8") + 1;
  }
  return parts.join("\n");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const p = new Map();
    const events = [];
    ws.addEventListener("open", () =>
      res({
        events,
        send(m, q, timeoutMs = 60000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: q }));
          return new Promise((a, b) => {
            p.set(i, { a, b });
            setTimeout(() => { if (p.delete(i)) b(new Error("timeout " + m)); }, timeoutMs);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.method) events.push(m);
      const it = p.get(m.id);
      if (!it) return;
      p.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws")));
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmdp-"));
const profile = path.join(tmp, "profile");
fs.mkdirSync(profile, { recursive: true });
const DOC = makeComplexDoc(5.2 * 1024 * 1024);
const docFile = path.join(tmp, "prof.md");
fs.writeFileSync(docFile, DOC, "utf8");
console.log(`文档：${(Buffer.byteLength(DOC) / 1024 / 1024).toFixed(2)}MB / ${DOC.split("\n").length} 行`);

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

  const ev = async (expr, timeout = 60000) => {
    const r = await Promise.race([
      cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
    return r.result?.result?.value;
  };

  // 启动 CPU profiler
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); // 0.5ms，足够细
  await cdp.send("Profiler.start");

  console.log("→ 打开文档并开始采样 ...");
  const t0 = Date.now();
  await ev(
    `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(docFile)},content:${JSON.stringify(DOC)},skipConflictCheck:true}}));"sent"`,
    30000,
  );

  // 等到可用（或超时）
  let ok = false;
  for (let i = 0; i < 25; i++) {
    await sleep(1500);
    const st = await ev(
      `(function(){var ed=document.querySelector(".cm-editor");var c=ed&&ed.querySelector(".cm-content");return {lines: ed?ed.querySelectorAll(".cm-line").length:0, len: c?(c.textContent||"").length:0};})()`,
      8000,
    );
    if (st.__timeout) continue;
    if (st.lines > 10 && st.len > 1000) { ok = true; break; }
  }
  const elapsed = Date.now() - t0;
  console.log(ok ? `→ 可用，耗时 ${(elapsed / 1000).toFixed(2)}s` : "→ 未按时可用");

  const prof = await cdp.send("Profiler.stop");
  const p = prof.result.profile;
  fs.writeFileSync(path.join(ROOT, "_verify-out", "v0170-cm6-cpu-profile.json"), JSON.stringify(p));

  // ── 按函数归并 self time ──
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const selfTime = new Map(); // key = url:line:funcName
  const total = p.timeDeltas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < p.samples.length; i++) {
    const node = byId.get(p.samples[i]);
    if (!node) continue;
    const cf = node.callFrame;
    const name = `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").pop()}:${cf.lineNumber}`;
    selfTime.set(name, (selfTime.get(name) || 0) + (p.timeDeltas[i] || 0));
  }
  const sorted = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`\n=== CPU 采样总时长 ${(total / 1000).toFixed(1)}ms，Top 25 self time ===`);
  for (const [name, us] of sorted) {
    const pct = ((us / total) * 100).toFixed(1);
    console.log(`  ${(us / 1000).toFixed(0).padStart(7)}ms  ${pct.padStart(5)}%  ${name}`);
  }
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }
}
