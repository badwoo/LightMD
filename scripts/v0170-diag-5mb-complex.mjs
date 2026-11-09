/**
 * v0.17.0 诊断：5MB **复杂** Markdown（表格/围栏/公式）下 CM6 主线程卡死 —— 隔离根因
 *
 * ## 现象（Lead perf-bench，量具已修）
 * ```
 * round 0: {impl:"cm6", ready:false, len:3741669}   ← 内容进来了
 * round 1: 5007ms TIMEOUT
 * round 2: 5007ms TIMEOUT                          → 判定"不可用"
 * ```
 * 而我的旧诊断（**同一行重复**的 5MB）2.5s 内正常渲染 74697 行。
 *
 * ## 本脚本要回答的问题
 * 1. 复杂文档是否真的卡死？（复现）
 * 2. 卡在哪个阶段：**装载** / **语法解析** / **高亮渲染** / **measure**？
 * 3. **隔离高亮**：同一份复杂文档，开启 vs 关闭 `syntaxHighlighting`，耗时差多少？
 *
 * ## 做法
 * 用 `?nohl` 查询参数驱动一个调试开关（仅本诊断用，通过 window 钩子注入），
 * 分两轮测同一份文档：
 * - 默认（高亮开）；
 * - 通过 `window.__LMD_DISABLE_HIGHLIGHT__` 让 `CmSourceSurface` 跳过 syntaxHighlighting。
 *
 * 同时用 CDP `Performance` 域采主线程耗时分布（script vs layout vs style）。
 *
 * 用法：node scripts/v0170-diag-5mb-complex.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9463;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 perf-bench.mjs 的 makeLargeDoc 同构：六类块轮转 */
function makeComplexDoc(targetBytes) {
  const parts = ["# 性能基准文档（COMPLEX）", ""];
  let used = Buffer.byteLength(parts[0], "utf8") + 1;
  let i = 0;
  while (used < targetBytes) {
    i++;
    const before = parts.length;
    switch (i % 6) {
      case 1:
        parts.push(`## 第 ${i} 节：概述`, "");
        parts.push(
          `第 ${i} 节的正文用于制造可滚动的行数与文本体积。内容包含中英文混排、` +
            `标点符号与少量数学符号，长度刻意保持均匀以便与不同档位对比。`,
          "",
        );
        break;
      case 2:
        parts.push(`### ${i}.1 要点清单`, "");
        for (let k = 1; k <= 4; k++) parts.push(`- 要点 ${i}.${k}：benchmark 采样条目，长度适中`);
        parts.push("");
        break;
      case 3:
        parts.push(`### ${i}.2 表格示例`, "");
        parts.push("| 指标 | 目标 | 实测 |", "|---|---|---|");
        for (let k = 1; k <= 3; k++) parts.push(`| 指标-${i}-${k} | p95 < 16ms | 待采样 |`);
        parts.push("");
        break;
      case 4:
        parts.push(`### ${i}.3 代码片段`, "");
        parts.push("```ts", `const section${i} = { id: ${i}, bytes: ${i * 48} };`, "```", "");
        break;
      case 5:
        parts.push(`> 第 ${i} 节的引用块：用于验证渲染管线在大量块下的表现。`, "");
        break;
      default:
        parts.push(
          `第 ${i} 节结束前的段落：$${i}^2$ 是一个行内公式示例，` +
            `同时包含 \`code_span_${i}\` 与 **加粗**、*斜体* 混排。`,
          "",
        );
    }
    for (let k = before; k < parts.length; k++) used += Buffer.byteLength(parts[k], "utf8") + 1;
  }
  return parts.join("\n");
}

/** 单一结构文档（隔离"是否特定块型触发"） */
function makeOneKind(kind, targetBytes) {
  const line = {
    table: "| 指标 | 目标 | 实测 |",
    fence: "`const x = 1;`",
    math: "公式 $x^2$ 与 $y^2$ 混排",
    heading: "## 一个标题行",
    plain: "普通段落文本，没有任何 Markdown 结构。",
  }[kind];
  const parts = [`# ${kind}`, ""];
  let used = 20;
  while (used < targetBytes) {
    // ⚠️ 必须累加**本次新 push 的每一行**，不能只累加最后一行
    // （table/fence 分支一次 push 多行，只算最后一行会让实际大小超标数倍）
    const before = parts.length;
    if (kind === "table") {
      parts.push(line, "|---|---|---|");
    } else if (kind === "fence") {
      parts.push("```ts", line, "```");
    } else {
      parts.push(line);
    }
    for (let k = before; k < parts.length; k++) {
      used += Buffer.byteLength(parts[k], "utf8") + 1;
    }
  }
  return parts.join("\n");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const p = new Map();
    ws.addEventListener("open", () =>
      res({
        send(m, q, timeoutMs = 40000) {
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
      if (m.method === "Runtime.consoleAPICalled") {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
        if (/EXPDIAG|DIAG/.test(txt)) console.log("  [console]", txt);
      }
      const it = p.get(m.id);
      if (!it) return;
      p.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws")));
  });
}

async function launch(profileSuffix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lmdx-${profileSuffix}-`));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  let cdp = null;
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
  return { child, cdp, tmp };
}

async function close(child, cdp) {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }
}

/** 跑一轮：打开指定文档，返回装载耗时与最终状态 */
async function runOnce(label, DOC, opts = {}) {
  const { child, cdp, tmp } = await launch(label);
  const docFile = path.join(tmp, "doc.md");
  fs.writeFileSync(docFile, DOC, "utf8");
  const bytes = Buffer.byteLength(DOC, "utf8");
  const lines = DOC.split("\n").length;

  const ev = async (expr, timeout = 40000) => {
    const r = await Promise.race([
      cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => ({ __timeout: true })),
    ]);
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
    return r.result?.result?.value;
  };

  // 高亮开关钩子（必须在打开文件前注入）
  if (opts.disableHighlight) {
    await ev(`window.__LMD_DISABLE_HIGHLIGHT__ = true; true`);
  }

  const probe = () => ev(`
    (function(){
      var ed = document.querySelector(".cm-editor");
      var scroller = ed && ed.querySelector(".cm-scroller");
      var content = ed && ed.querySelector(".cm-content");
      return {
        impl: ed ? "cm6" : (document.querySelector("textarea.source-editor") ? "textarea" : "none"),
        lines: ed ? ed.querySelectorAll(".cm-line").length : 0,
        textLen: content ? (content.textContent || "").length : 0,
        scrollerH: scroller ? scroller.scrollHeight : 0,
      };
    })()
  `, 8000);

  console.log(`\n=== ${label}｜${(bytes / 1024 / 1024).toFixed(2)}MB / ${lines} 行${opts.disableHighlight ? "（高亮关闭）" : ""} ===`);
  const t0 = Date.now();
  await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(docFile)},content:${JSON.stringify(DOC)},skipConflictCheck:true}}));"sent"`, 30000);
  console.log(`openFile 分发耗时 ${Date.now() - t0}ms`);

  // 轮询：观察何时可用（或卡死）
  let firstOk = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const st = await probe();
    const ms = Date.now() - t0;
    if (st.__timeout) {
      console.log(`  t=${(ms / 1000).toFixed(1)}s  CDP TIMEOUT（主线程阻塞）`);
      continue;
    }
    console.log(`  t=${(ms / 1000).toFixed(1)}s  lines=${st.lines} textLen=${st.textLen} scrollerH=${st.scrollerH}`);
    if (st.lines > 10 && st.textLen > 1000) { firstOk = ms; break; }
  }
  console.log(firstOk ? `→ 可用耗时 ${(firstOk / 1000).toFixed(2)}s` : "→ 10 轮内未可用（判定卡死）");
  await close(child, cdp);
  return { label, bytes, lines, firstOk, disableHighlight: !!opts.disableHighlight };
}

const MB = 1024 * 1024;
const results = [];
try {
  // ① 复杂文档（六类块轮转）= perf-bench 的形态
  results.push(await runOnce("复杂文档·高亮开", makeComplexDoc(5.2 * MB)));
  // ② 同一份，高亮关
  results.push(await runOnce("复杂文档·高亮关", makeComplexDoc(5.2 * MB), { disableHighlight: true }));
  // ③ 单一结构隔离
  for (const kind of ["table", "fence", "math"]) {
    results.push(await runOnce(`单一结构·${kind}`, makeOneKind(kind, 5.2 * MB)));
  }
  // ④ 纯文本对照
  results.push(await runOnce("单一结构·plain", makeOneKind("plain", 5.2 * MB)));
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }
}

console.log("\n\n========== 汇总 ==========");
for (const r of results) {
  console.log(
    `${r.label.padEnd(22)} ${(r.bytes / MB).toFixed(1)}MB  ` +
      (r.firstOk ? `可用 ${(r.firstOk / 1000).toFixed(2)}s` : "**卡死/未可用**"),
  );
}
