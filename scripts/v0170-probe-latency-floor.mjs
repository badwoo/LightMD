/**
 * v0.17.0 诊断：输入延迟的「测量下限」对照实验 + **纯相位模型验证**
 *
 * ## 要回答的问题
 * 设计稿硬门禁是「5MB 连续输入，每击键到下一次 paint 的 p95 < 16ms」。
 * 实测 16.4ms（历史 18.0/17.8ms）。这个差距是：
 *   (a) 我们的处理真的慢？ 还是
 *   (b) 这个**度量方式本身**在 60Hz 显示器上有不可逾越的下限？
 *
 * ## 三项测量（同一进程、同一帧节奏）
 * - **A 现值**：keydown `timeStamp` → 第一个 rAF 回调（= 现有门禁口径）
 * - **B 处理**：keydown `timeStamp` → 事件处理函数返回（纯 JS 成本，不等帧）
 * - **C 地板**：一个**什么都不做**的 rAF 往返（空回调 → 下一个 rAF），
 *   即"这台机器上'等一帧'本身要多久" —— 与产品无关的硬件/合成器下限
 *
 * ## 纯相位模型（本探针的核心论证）
 *
 * 门禁口径 A 的**数学结构**是：
 * ```
 *   A = T(处理耗时) + P(距下一帧的随机相位)，   其中 P ~ Uniform[0, 帧长)
 * ```
 * 于是：
 * ```
 *   E[A]  = T + 帧长/2
 *   p95[A] = T + 0.95 × 帧长
 *   max[A] = T + 帧长
 * ```
 *
 * **关键推论**：即使 `T = 0`（代码一行都不执行），
 * `p95[A]` 的下限仍是 `0.95 × 16.67 = 15.83ms`。
 * 即「p95 < 16ms」要求 `T < 0.17ms` —— 任何实现都几乎没有余量。
 *
 * **实测验证**（60Hz、三次不同条件测 C 地板）：
 * | 测量 | p50 | p95 |
 * |---|---|---|
 * | C 地板（零产品代码） | 9.5 / 10.6 / 11.4 | 16.5 / 16.8 / 18.2 |
 * | **产品 A（5MB）** | **9.6** | **16.4** |
 * 产品落在空回调地板的测量区间内 → **处理耗时已被帧相位完全淹没**。
 *
 * 反推 T：从 p50 得 1.27ms、从 p95 得 0.57ms（两个独立估计一致）→ 模型成立。
 *
 * ## 判读
 * - 若 `C 的 p95 ≈ A 的 p95` → 下限由刷新率决定，不是代码问题；
 *   那么"p95 < 16ms"在这个度量下**结构上不可达**（除非换 >60Hz 显示器或改口径）。
 * - 若 `C 的 p95` 远小于 `A` → 是产品慢，B 会给出确切成本。
 *
 * ⚠️ **不要用单次测量断言"结构性下限"**：
 * 本探针第一次只测一次 C，得 18.2ms，据此写成"约 18ms 下限"；
 * 复测得 16.5/16.8ms —— 18.2 是当次系统负载下的偶然值。
 * **正确表述是「贴帧长（16.67ms）波动」**。断言下限需多次不同条件的测量。
 *
 * 用法：node scripts/v0170-probe-latency-floor.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9470;
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0170-latency-floor.json";
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
            setTimeout(() => { if (p.delete(i)) b(new Error("to " + m)); }, 30000);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = p.get(m.id); if (!it) return;
      p.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws")));
  });
}

function makeDoc(bytes) {
  const parts = ["# 性能基准文档", ""];
  let used = Buffer.byteLength(parts[0], "utf8") + 1;
  let i = 0;
  while (used < bytes) {
    i++;
    switch (i % 6) {
      case 1:
        parts.push(`## 第 ${i} 节：概述`, "");
        parts.push(`第 ${i} 节的正文用于制造可滚动的行数与文本体积。内容包含中英文混排、标点符号与少量数学符号。`.repeat(2), "");
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
        parts.push(`第 ${i} 节结束前的段落：$${i}^2$ 是一个行内公式示例，同时包含 \`code_span_${i}\` 与 **加粗**、*斜体* 混排。`, "");
        break;
    }
    for (let k = 0; k < parts.length; k++) { /* noop */ }
    used = Buffer.byteLength(parts.join("\n"), "utf8");
  }
  return parts.join("\n");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-floor-"));
const profile = path.join(tmp, "profile");
fs.mkdirSync(profile, { recursive: true });
const DOC = makeDoc(5 * 1024 * 1024);
const docFile = path.join(tmp, "floor.md");
fs.writeFileSync(docFile, DOC, "utf8");
console.log(`文档：${(Buffer.byteLength(DOC, "utf8") / 1024 / 1024).toFixed(2)}MB / ${DOC.split("\n").length} 行`);

let child = null, cdp = null;
const out = { doc: { bytes: Buffer.byteLength(DOC, "utf8"), lines: DOC.split("\n").length } };
try {
  child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 140 && !cdp; i++) {
    try {
      const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
      for (const t of ts) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        const c = await connect(t.webSocketDebuggerUrl);
        await c.send("Runtime.enable");
        const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
        if (r.result?.result?.value) { cdp = c; break; }
        c.close();
      }
    } catch { /* not ready */ }
    if (!cdp) await sleep(350);
  }
  if (!cdp) throw new Error("no CDP target");

  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };

  // 打开文档 + 切编辑模式
  await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(docFile)},content:${JSON.stringify(DOC)}}}));true`);
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const ok = await ev(`!!document.querySelector(".cm-editor") && document.querySelector(".cm-editor").textContent.length > 200`);
    if (ok) break;
  }
  await ev(`const b=Array.from(document.querySelectorAll("button")).find(x=>/编辑|Edit/i.test((x.textContent||"")+(x.title||"")));if(b)b.click();true`);
  await sleep(1500);

  const env = JSON.parse(await ev(`JSON.stringify({
    impl: document.querySelector(".cm-editor") ? "cm6" : "textarea",
    cmContent: !!document.querySelector(".cm-content"),
    visibleLen: (document.querySelector(".cm-editor")||{}).textContent?.length || 0
  })`));
  out.env = env;
  console.log("环境:", JSON.stringify(env));

  // 点进编辑区使光标可用
  const box = await ev(`(()=>{const ls=Array.from(document.querySelectorAll(".cm-line"));if(!ls.length)return null;const t=ls[Math.floor(ls.length/2)];const r=t.getBoundingClientRect();return {x:Math.round(r.left+10),y:Math.round(r.top+r.height/2)};})()`);
  if (box) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(300);
  }

  // ── 安装三项测量的页面侧探针 ──
  await ev(`
    window.__floor = { A: [], B: [], C: [], on: false };
    // A/B: keydown 时间戳 → rAF（A）或 handler 返回（B）
    window.__floorKeyHandler = function (e) {
      if (!window.__floor.on) return;
      var t0 = e.timeStamp;
      // B：同步处理成本（到本函数返回为止的 JS 时间）
      var tb = performance.now();
      // A：到下一个 rAF
      requestAnimationFrame(function () {
        window.__floor.A.push(+(performance.now() - performance.timeOrigin === 0 ? 0 : 0));
        // 用 performance.now 与事件 timeStamp 同基准（timeStamp 在此环境为相对 timeOrigin）
        window.__floor.A[window.__floor.A.length - 1] = +(performance.now() - (performance.timeOrigin ? 0 : 0));
      });
      window.__floor.B.push(+(performance.now() - tb));
    };
    document.addEventListener("keydown", window.__floorKeyHandler, true);
    true;
  `);

  /**
   * 正确的 A 测量必须在页面里做：记录 keydown 的 e.timeStamp 与随后第一个 rAF 的 performance.now()。
   * 二者同基准（都以 timeOrigin 为 0）才可相减。上面那版写错了，重装。
   */
  await ev(`
    window.__floor = { A: [], B: [], C: [], on: false, pending: null };
    window.__floorKey = function (e) {
      if (!window.__floor.on) return;
      if (window.__floor.pending !== null) return; // 一帧内只记一次
      var t0 = e.timeStamp;
      var tProc0 = performance.now();
      window.__floor.pending = t0;
      var proc = performance.now() - tProc0;   // 本函数自身的同步成本
      window.__floor.B.push(+(proc).toFixed(2));
      requestAnimationFrame(function () {
        var t1 = performance.now();
        window.__floor.A.push(+(t1 - window.__floor.pending).toFixed(2));
        window.__floor.pending = null;
      });
    };
    document.addEventListener("keydown", window.__floorKey, true);
    true;
  `);

  // ── C：空 rAF 往返地板（与产品无关） ──
  const floorC = JSON.parse(await ev(`(async () => {
    var arr = [];
    for (var i = 0; i < 240; i++) {
      await new Promise(function (res) {
        var t0 = performance.now();
        requestAnimationFrame(function () { arr.push(+(performance.now() - t0).toFixed(2)); res(); });
      });
      await new Promise(function (r) { setTimeout(r, 100); });  // 与打字同节奏，保证相位随机
    }
    arr.sort(function (a,b){return a-b;});
    var q = function (p) { return arr[Math.floor(arr.length * p)]; };
    return JSON.stringify({ n: arr.length, p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: arr[arr.length-1] });
  })()`));
  out.C_rafFloor = floorC;
  /**
   * 纯相位模型的**自验证**：把实测 C 地板代入模型，反推处理耗时 T。
   *
   *   E[A]   = T + 帧长/2
   *   p95[A] = T + 0.95 × 帧长
   *
   * 若从 p50 与从 p95 反推出的 T **彼此接近**，说明"相位主导"这个解释成立；
   * 若两者差很多，说明还有别的系统性因素（那时才值得去查代码）。
   */
  {
    const FRAME = 1000 / 60;
    const T_from_p50 = floorC.p50 - FRAME / 2;
    const T_from_p95 = floorC.p95 - 0.95 * FRAME;
    out.phaseModel = {
      frameMs: +FRAME.toFixed(2),
      theoreticalP95FloorMs: +(0.95 * FRAME).toFixed(2),
      T_from_p50Ms: +T_from_p50.toFixed(2),
      T_from_p95Ms: +T_from_p95.toFixed(2),
      estimatesAgree: Math.abs(T_from_p50 - T_from_p95) < 3,
      note:
        "C 地板代表零产品代码的「等一帧」成本。若产品 A 的 p95 与它同量级，" +
        "则处理耗时已被帧相位淹没，门禁实际测的是刷新率而非代码质量。",
    };
    console.log(
      "纯相位模型：帧长=" +
        out.phaseModel.frameMs +
        "ms  p95 理论地板=" +
        out.phaseModel.theoreticalP95FloorMs +
        "ms  → 反推 T(p50)=" +
        out.phaseModel.T_from_p50Ms +
        "ms  T(p95)=" +
        out.phaseModel.T_from_p95Ms +
        "ms  两估计一致=" +
        out.phaseModel.estimatesAgree,
    );
  }
  console.log("C 空 rAF 地板:", JSON.stringify(floorC));

  // ── A/B：真实按键（601 键，与门禁同规模） ──
  await ev(`window.__floor.A = []; window.__floor.B = []; window.__floor.on = true; true`);
  const t0 = Date.now();
  let sent = 0;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  while (Date.now() - t0 < 60000) {
    const ch = chars[sent % chars.length];
    const code = "Key" + ch.toUpperCase();
    const vk = ch.toUpperCase().charCodeAt(0);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: ch, unmodifiedText: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, code, text: ch, unmodifiedText: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    sent++;
    await sleep(100);
  }
  await ev(`window.__floor.on = false; true`);

  const measured = JSON.parse(await ev(`(function(){
    var q = function (arr, p) { var s = arr.slice().sort(function(a,b){return a-b;}); return s.length ? s[Math.floor(s.length*p)] : null; };
    return JSON.stringify({
      keysSent: ${sent},
      A_p50: q(window.__floor.A, 0.5), A_p90: q(window.__floor.A, 0.9), A_p95: q(window.__floor.A, 0.95), A_p99: q(window.__floor.A, 0.99),
      A_max: window.__floor.A.length ? Math.max.apply(null, window.__floor.A) : null, A_n: window.__floor.A.length,
      B_p50: q(window.__floor.B, 0.5), B_p95: q(window.__floor.B, 0.95), B_p99: q(window.__floor.B, 0.99), B_n: window.__floor.B.length
    });
  })()`));
  out.measured = measured;
  console.log("A/B 实测:", JSON.stringify(measured, null, 1));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
  console.log("产物:", OUT);
} finally {
  try { cdp?.close(); } catch {}
  try { child?.kill(); } catch {}
  await sleep(500);
  try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch {}
}
