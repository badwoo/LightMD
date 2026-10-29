/**
 * LightMD v0.15.3 —— 实机探针：**跨模式撤销/恢复「文档抖动」**判别（只测不改）。
 *
 * 用户原话：「跨模式撤销栈修改撤销或恢复文档会抖动。」
 *
 * ## 为什么上一版探针测不出（必须记住这个教训）
 * `scripts/v0153-probe-scrollwriter.mjs` 场景 B 只改了 3 个字符（`SRC改`），
 * `scrollHeight` 几乎不变 → 浏览器**不会钳位** → 什么抖动都不会显形。
 * 本探针改为「**撤销一大块插入**」：整篇 `replaceWith` 后 `scrollHeight` 明显变小，
 * 才会触发 `core/editor.ts:590-594` 的 `savedScrollTop` 恢复被浏览器钳到**新 max**。
 *
 * ## 抖动的最可能机制（源码证据，先读再判）
 * 1. `applyHistoryText` 的阅读分支只设 `addToHistory:false` + `historyBridge:true`
 *    （`EditorContainer.tsx:3073-3074`），**不设 `fileSwitch`**；
 * 2. 于是 `core/editor.ts:590` 的 `isFileSwitch ? -1 : scrollTop` 取到**替换前像素**，
 *    `view.updateState(newState)` 之后 `:592-593` 无条件把它写回；
 * 3. doc 变短 → 新 `max` 更小 → 浏览器把这个旧像素**钳到新 max（= 贴底）**；
 * 4. 随后 `restorePreviewScrollFromAnchor` 的 rAF / 60ms / 160ms 按内容锚拉回
 *    → 采样序列呈现「贴底 → 拉回」，即用户说的"抖动"。
 *
 * ## 判定（每条都是可证伪的）
 *   A1 **不出现钳位中间态**：撤销窗口内不得出现 `(max - top) < 2` 的贴底样本
 *      —— 若出现且最终不在底部，就是 §4 描述的那条机制。
 *   A2 **方向反转 ≤ 2**：显著写入（|Δ|>2px）不得反复换向。
 *   A3 **首末一致**：窗口结束后位置稳定（尾部 200ms 内波动 ≤ 2px），不再被"二次校正"推走。
 *   A4 **撤销后阅读面不得贴底**（最终 `max - top ≥ 2`，除非原本就在底部）。
 *   A5 **redo 对称**：恢复后同样不得出现贴底中间态/反复换向。
 *
 * 采样：`setTimeout(16ms)`（**禁 rAF**：WebView2 窗口不可见时 rAF 会被节流，
 * 语义地图 §4-30 采样陷阱）。同时 hook `Element.prototype.scrollTop` setter
 * 记录每次写入的值/差值/**调用栈**，从而指认"是谁写的"。
 *
 * 用法：node scripts/v0153-probe-undo-big.mjs
 * 环境变量：V0153U_PORT（默认 9301）、V0153U_EXE、
 *          V0153U_ONLY=source|reader（只测一种撤销位置：源码模式撤销 / 阅读模式撤销）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0153U_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0153U_PORT || 9301);
const ONLY = process.env.V0153U_ONLY || "";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0153-probe-undo-big.txt");
const OUT_JSON = path.join(OUT_DIR, "v0153-probe-undo-big.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";

/** 插入的大块：用 multi-line 文本，撤销后 scrollHeight 会明显变小 */
const BIG_BLOCK = [
  "【巨块开始】",
  "",
  ...Array.from({ length: 18 }, (_, i) => `巨块正文第 ${i + 1} 行：用于在撤销时让 scrollHeight 明显变小，从而暴露浏览器钳位。`),
  "",
  "【巨块结束】",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error("找不到 dist/index.html");
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 找不到入口 hash");
  const hash = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hash, "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${hash}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hash}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            setTimeout(() => {
              if (pending.has(msgId)) {
                pending.delete(msgId);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 30000);
          });
        },
        close() {
          ws.close();
        },
      }),
    );
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

function makeDoc() {
  const p = ["# 撤销抖动取证", ""];
  for (let i = 1; i <= 40; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(
        `第 ${i}.${j} 段：这是一段刻意写长的正文，用于让 textarea 的 pre-wrap 在窄宽度下折成更多视觉行。` +
          `继续堆字以拉长该逻辑行，使滚动量足够大、任何一次钳位都能被量化出来。`,
      );
      p.push("");
    }
  }
  p.push("## 末段");
  p.push("最后一段用于确认底部。");
  return p.join("\n");
}

/** 页面内工具（hook + 16ms 采样器） */
const PAGE_TOOLS = String.raw`
window.__uHook = function () {
  if (window.__uInstalled) return "already";
  window.__uInstalled = true;
  window.__uLog = [];
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!desc || !desc.get || !desc.set) return "no-descriptor";
  const origGet = desc.get;
  const origSet = desc.set;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: origGet,
    set(v) {
      const el = this;
      try {
        const isTa = el && el.tagName === "TEXTAREA" && el.classList && el.classList.contains("source-editor");
        const isReader = el && el.classList && el.classList.contains("editor-container");
        if (isTa || isReader) {
          const old = origGet.call(el);
          const st = (new Error().stack || "").split("\n").slice(1, 10).map((s) => s.trim().replace(/^at\s*/, ""));
          window.__uLog.push({
            t: +performance.now().toFixed(1),
            who: isTa ? "textarea" : "reader",
            from: +(+old).toFixed(2),
            to: +(+v).toFixed(2),
            d: +(+v - +old).toFixed(2),
            frames: st.map((s) => s.slice(0, 140)),
          });
        }
      } catch (e) { /* 诊断绝不影响功能 */ }
      return origSet.call(el, v);
    },
  });
  return "installed";
};

window.__uStart = function (ms) {
  window.__uSamples = [];
  window.__uT0 = performance.now();
  const tick = () => {
    const ta = document.querySelector("textarea.source-editor");
    const sc = document.querySelector(".editor-container");
    const srcVisible = !!ta && ta.offsetHeight > 0 && ta.clientHeight > 0;
    const pmVisible = !!sc && sc.offsetHeight > 0 && sc.clientHeight > 0;
    window.__uSamples.push({
      t: +(performance.now() - window.__uT0).toFixed(1),
      src: srcVisible ? { top: +ta.scrollTop.toFixed(2), sh: ta.scrollHeight, ch: ta.clientHeight, sel: ta.selectionStart } : null,
      pm: pmVisible ? { top: +sc.scrollTop.toFixed(2), sh: sc.scrollHeight, ch: sc.clientHeight } : null,
    });
    if (performance.now() - window.__uT0 < ms) setTimeout(tick, 16);
  };
  tick();
  return true;
};

window.__uDump = function () {
  return JSON.stringify({ log: window.__uLog || [], samples: window.__uSamples || [] });
};
window.__uClear = function () { window.__uLog = []; return true; };

window.__uKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

/** 分析一个面的采样序列 */
function analyze(samples, who) {
  const seq = samples.map((s) => (who === "src" ? s.src : s.pm)).filter(Boolean);
  if (seq.length < 3) return { ok: false, why: "too-few-samples", n: seq.length };
  const tops = seq.map((x) => x.top);
  const maxs = seq.map((x) => Math.max(0, x.sh - x.ch));
  const min = Math.min(...tops);
  const max = Math.max(...tops);
  const span = max - min;
  const first = tops[0];
  const final = tops[tops.length - 1];
  // 贴底中间样本：最后 3 帧不算（稳态就该在那儿）
  const clampIdx = [];
  for (let i = 0; i < tops.length - 3; i++) {
    if (maxs[i] > 0 && maxs[i] - tops[i] < 2) clampIdx.push(i);
  }
  // 方向反转
  let rev = 0;
  let lastDir = 0;
  for (let i = 1; i < tops.length; i++) {
    const d = tops[i] - tops[i - 1];
    if (Math.abs(d) < 2) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) rev++;
    lastDir = dir;
  }
  // 尾部稳定性
  const tail = tops.slice(-Math.min(13, tops.length));
  const tailSpan = Math.max(...tail) - Math.min(...tail);
  return {
    ok: true,
    n: seq.length,
    span: +span.toFixed(2),
    first: +first.toFixed(2),
    final: +final.toFixed(2),
    finalMax: +maxs[maxs.length - 1].toFixed(2),
    finalGapToBottom: +(maxs[maxs.length - 1] - final).toFixed(2),
    clampSamples: clampIdx.length,
    clampFirstAt: clampIdx.length ? +seq[clampIdx[0]].t : null,
    reversals: rev,
    tailSpan: +tailSpan.toFixed(2),
    shFirst: seq[0].sh,
    shLast: seq[seq.length - 1].sh,
    topsPreview: tops.slice(0, 24).map((v) => +v.toFixed(1)),
    maxsPreview: maxs.slice(0, 24).map((v) => +v.toFixed(1)),
  };
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-undobig-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "undo-big.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1200);

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  log("[probe] 等待 CDP 端点就绪…");
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }

  let cdp = null;
  for (let i = 0; i < 80 && !cdp; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
      ).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (r.result?.result?.value === true) {
            cdp = c;
            break;
          }
          c.close();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const doubleCtrl = async () => {
    await ev(`
      await new Promise((r) => setTimeout(r, 320));
      __uKey("Control", "ControlLeft", false);
      await new Promise((r) => setTimeout(r, 60));
      __uKey("Control", "ControlLeft", false);
      return true;
    `);
  };

  /** 采样 + 触发一个动作，返回 dump 与两面分析 */
  const measureAction = async (actionBody, ms = 1000) => {
    await ev(`__uClear(); __uStart(${ms}); return true;`);
    await ev(actionBody);
    await sleep(ms + 200);
    const dump = JSON.parse(await ev(`return __uDump();`));
    return { dump, pm: analyze(dump.samples, "pm"), src: analyze(dump.samples, "src") };
  };

  try {
    const hook = await ev(`return __uHook();`);
    log(`[probe] scrollTop hook：${hook}`);

    const probeMark = JSON.stringify("第 5.1 段");
    let loaded = false;
    for (let a = 0; a < 25 && !loaded; a++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        if (!pm) return false;
        const txt = (pm.textContent || "").replace(/\s+/g, "");
        return txt.indexOf(String(${probeMark}).replace(/\s+/g, "")) >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入（判定会失真，中止）");
    log("[probe] 文档已装入");
    await sleep(900);

    const runs = {};

    // ── 场景 R：**阅读模式**撤销（用户最常看到的路径）──
    if (!ONLY || ONLY === "reader") {
      log("");
      log("════════ 场景 R：阅读模式撤销「一大块插入」 ═───────");
      await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        return sc.scrollTop;
      `);
      await sleep(800);
      const baseR = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, sh: sc.scrollHeight };
      `);
      log(`  基线：scrollTop=${baseR.top} max=${baseR.max} sh=${baseR.sh}`);

      // 进编辑模式，在视口中央插「巨块」
      await doubleCtrl();
      await sleep(1300);
      const ins = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return { ok: false, why: "no-textarea" };
        ta.focus();
        const ls = ta.value.split("\\n");
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
        const approx = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
        let pick = Math.max(0, Math.min(ls.length - 1, approx));
        for (let k = 0; k < 60; k++) {
          const cand = pick + (k % 2 === 0 ? k / 2 : -Math.ceil(k / 2));
          if (cand < 0 || cand >= ls.length) continue;
          const t = (ls[cand] || "").trim();
          if (t && t.charAt(0) !== "#" && t.charAt(0) !== "|" && t.charAt(0) !== ">" && t.charAt(0) !== "-" && t.charAt(0) !== ":") { pick = cand; break; }
        }
        let pos = 0;
        for (let i = 0; i < pick; i++) pos += ls[i].length + 1;
        ta.setSelectionRange(pos, pos);
        const beforeLen = ta.value.length;
        document.execCommand("insertText", false, ${JSON.stringify(BIG_BLOCK + "\n\n")});
        return { ok: ta.value.length > beforeLen + 100, pick, pos, beforeLen, afterLen: ta.value.length };
      `);
      log(`  已插入巨块：行 ${ins.pick}，长度 ${ins.beforeLen} → ${ins.afterLen}（+${(ins.afterLen || 0) - (ins.beforeLen || 0)}）`);
      await sleep(1300);

      // 回阅读模式
      await doubleCtrl();
      await sleep(1500);
      const beforeUndoR = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, sh: sc.scrollHeight };
      `);
      log(`  撤销前（阅读面）：scrollTop=${beforeUndoR.top} max=${beforeUndoR.max} sh=${beforeUndoR.sh}`);

      // ① Ctrl+Z（撤掉巨块插入）—— 逐帧
      const undoR = await measureAction(`__uKey("z", "KeyZ", true); return true;`);
      log(`  ① Ctrl+Z 后 reader：${JSON.stringify(undoR.pm)}`);
      log(`     写入者（reader）：`);
      for (const w of undoR.dump.log.filter((x) => x.who === "reader")) {
        log(`       t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
      }
      const afterUndoR = await ev(`
        const sc = document.querySelector(".editor-container");
        const pm = sc.querySelector(".ProseMirror");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, sh: sc.scrollHeight, textLen: pm ? pm.textContent.length : -1 };
      `);
      log(`  ① 撤销后稳态：${JSON.stringify(afterUndoR)}`);

      // ② Ctrl+Y（恢复）—— 逐帧
      const redoR = await measureAction(`__uKey("y", "KeyY", true); return true;`);
      log(`  ② Ctrl+Y 后 reader：${JSON.stringify(redoR.pm)}`);
      for (const w of redoR.dump.log.filter((x) => x.who === "reader")) {
        log(`       t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
      }
      const afterRedoR = await ev(`
        const sc = document.querySelector(".editor-container");
        const pm = sc.querySelector(".ProseMirror");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, sh: sc.scrollHeight, textLen: pm ? pm.textContent.length : -1 };
      `);
      log(`  ② 恢复后稳态：${JSON.stringify(afterRedoR)}`);

      runs.reader = { baseR, ins, beforeUndoR, undoR, afterUndoR, redoR, afterRedoR };

      const wasAtBottom = baseR.max - baseR.top < 2;
      check(
        "R1 撤销：不得出现「贴底中间态」（若出现且最终不在底部 = core/editor.ts 旧像素被钳位的指纹）",
        undoR.pm.clampSamples === 0,
        `贴底样本=${undoR.pm.clampSamples}（首个 t=${undoR.pm.clampFirstAt}），最终距底=${undoR.pm.finalGapToBottom}px`,
      );
      check(
        "R2 撤销：显著写入方向反转 ≤ 2 次（抖动定义）",
        undoR.pm.reversals <= 2,
        `反转=${undoR.pm.reversals}，振幅=${undoR.pm.span}px`,
      );
      check(
        "R3 撤销：窗口尾部 200ms 内位置稳定（≤2px，说明三段校正已收敛、不再被二次推走）",
        undoR.pm.tailSpan <= 2,
        `尾部波动=${undoR.pm.tailSpan}px`,
      );
      check(
        "R4 撤销：最终不得贴底（除非撤销前就在底部）",
        wasAtBottom || undoR.pm.finalGapToBottom >= 2,
        `最终距底=${undoR.pm.finalGapToBottom}px，撤销前距底=${(baseR.max - baseR.top).toFixed(1)}px`,
      );
      check(
        "R5 恢复：不得出现「贴底中间态」",
        redoR.pm.clampSamples === 0,
        `贴底样本=${redoR.pm.clampSamples}，最终距底=${redoR.pm.finalGapToBottom}px`,
      );
      check(
        "R6 时间线真的在动（撤销/恢复后文本长度不同）",
        afterUndoR.textLen !== afterRedoR.textLen || afterUndoR.sh !== afterRedoR.sh,
        `撤销后 len=${afterUndoR.textLen} sh=${afterUndoR.sh}；恢复后 len=${afterRedoR.textLen} sh=${afterRedoR.sh}`,
      );
    }

    // ── 场景 S：**源码模式**撤销（跨模式：在阅读模式改、切源码撤销）──
    if (!ONLY || ONLY === "source") {
      log("");
      log("════════ 场景 S：跨模式（阅读里改 → 切源码撤销） ═───────");
      // 确保回阅读模式
      const mode = await ev(`
        const sc = document.querySelector(".editor-container");
        const ta = document.querySelector("textarea.source-editor");
        return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
      `);
      if (mode !== "preview") {
        await doubleCtrl();
        await sleep(1300);
      }
      // 阅读模式里插巨块：走真实 PM 输入（Input.insertText 需要先聚焦落点）
      const pmFocus = await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        await new Promise((r) => setTimeout(r, 600));
        const pm = sc.querySelector(".ProseMirror");
        const ps = pm.querySelectorAll("p");
        const target = ps[Math.min(ps.length - 1, Math.floor(ps.length / 2))];
        const r = target.getBoundingClientRect();
        const opt = { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height / 2, button: 0 };
        target.dispatchEvent(new MouseEvent("mousedown", opt));
        target.dispatchEvent(new MouseEvent("mouseup", opt));
        await new Promise((r2) => setTimeout(r2, 150));
        return { ok: true, text: (target.textContent || "").slice(0, 20) };
      `);
      log(`  阅读面落点：${JSON.stringify(pmFocus)}`);
      // 用 CDP 真实输入（多行会触发 PM 的 splitBlock，生成多个块）
      await cdp.send("Input.insertText", { text: BIG_BLOCK.replace(/\n/g, " ") });
      await sleep(900);
      // PM 侧不再多插（够长了；PM 段落长文本会软换行，几何变化足够）
      await cdp.send("Input.insertText", { text: " " + BIG_BLOCK.replace(/\n/g, " ") });
      await sleep(1000);
      const pmLenAfter = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return pm ? { len: pm.textContent.length, sh: document.querySelector(".editor-container").scrollHeight } : null;
      `);
      log(`  阅读模式输入后：${JSON.stringify(pmLenAfter)}`);

      // 切源码（此时历史里有 PM 的两步编辑）
      await doubleCtrl();
      await sleep(1400);
      const srcBase = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return null;
        return { top: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, sh: ta.scrollHeight, sel: ta.selectionStart };
      `);
      log(`  切到源码：${JSON.stringify(srcBase)}`);

      /**
       * ── 关键：改动必须发生在**视口上方**（文档 25% 处）──
       *
       * 只有这种布局才能验证用户真正抱怨的形态：「撤销一步，眼前的文档跳走了」。
       * 若改在视口中央/下方（上一版探针那样），文本变短后视口中央那一行**已经不存在**，
       * 变成"贴底"是**语义正确**的结果，断言"不得贴底"就变成了测错东西。
       * 改在视口上方时，视口中央的内容在撤销前后**必然仍然存在**，正确行为是
       * 「它一动不动」—— 这正是内容锚点重映射要保住的东西。
       *
       * 插入到 25% 处（用段落边界，避免插到行中间破坏结构）。
       */
      const insS = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        ta.focus();
        // 先滚到 25%，把光标放到该处段落行首；再滚回 50% 作为"用户正在看的位置"
        const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
        ta.scrollTop = Math.round(max * 0.25);
        await new Promise((r) => setTimeout(r, 260));
        const ls = ta.value.split("\\n");
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
        const approx = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
        let pick = Math.max(0, Math.min(ls.length - 1, approx));
        // 就近找一行"正文段落行"（非空、非标题、非表格/引用），作为插入点
        for (let k = 0; k < 80; k++) {
          const cand = pick + (k % 2 === 0 ? k / 2 : -Math.ceil(k / 2));
          if (cand < 0 || cand >= ls.length) continue;
          const t = (ls[cand] || "").trim();
          if (t && t.charAt(0) !== "#" && t.charAt(0) !== "|" && t.charAt(0) !== ">" && t.charAt(0) !== "-" && t.charAt(0) !== ":") { pick = cand; break; }
        }
        let pos = 0;
        for (let i = 0; i < pick; i++) pos += ls[i].length + 1;
        const beforeLen = ta.value.length;
        const beforeTop = ta.scrollTop;
        ta.setSelectionRange(pos, pos);
        document.execCommand("insertText", false, ${JSON.stringify(BIG_BLOCK + "\n\n")});
        // 立刻滚回 50%（模拟"用户视线在文档中部，改动在上方发生"）
        ta.scrollTop = Math.round(Math.max(0, ta.scrollHeight - ta.clientHeight) * 0.5);
        return {
          pick, pos, beforeLen, afterLen: ta.value.length,
          insertLineRatio: pos / beforeLen,
          viewTopAfter: ta.scrollTop,
          maxAfter: Math.max(0, ta.scrollHeight - ta.clientHeight),
        };
      `);
      log(`  源码插入巨块于 25% 处：${JSON.stringify(insS)}`);
      // 让预览/自动保存通道走完，并确认视口稳定在 50%
      await sleep(1400);
      const viewBefore = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const tops = (function(){
          const cs = getComputedStyle(ta);
          const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
          const mirror = document.createElement("div");
          mirror.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;" +
            "width:" + (ta.clientWidth + bl + br) + "px;padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";" +
            "border-style:solid;border-width:" + cs.borderTopWidth + " " + cs.borderRightWidth + " " + cs.borderBottomWidth + " " + cs.borderLeftWidth + ";" +
            "white-space:pre-wrap;word-break:" + cs.wordBreak + ";font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";" +
            "line-height:" + cs.lineHeight + ";margin:0;overflow:hidden;";
          document.body.appendChild(mirror);
          try {
            const ls = ta.value.split("\\n"); const markers = [];
            for (let k = 0; k < ls.length; k++) {
              const m = document.createElement("span"); m.textContent = "\u200b"; mirror.appendChild(m); markers.push(m);
              mirror.appendChild(document.createTextNode(ls[k] + (k < ls.length - 1 ? "\\n" : "")));
            }
            const boxTop = mirror.getBoundingClientRect().top;
            return markers.map((m) => m.getBoundingClientRect().top - boxTop);
          } finally { mirror.remove(); }
        })();
        const centerY = ta.scrollTop + ta.clientHeight / 2;
        let lo = 0, hi = tops.length - 1;
        if (centerY <= tops[0]) { lo = 0; } else if (centerY >= tops[hi]) { lo = hi; } else {
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= centerY) lo = mid; else hi = mid - 1; }
        }
        const lines = ta.value.split("\\n");
        /**
         * ⚠️ 视口中央行**可能落在空行**上（段落之间本来就有空行）。
         * 拿空行文本比较等于比较两个空串，既测不出"内容跳走"，
         * 也会被 centerText 非空守卫误判（实测：撤销前 194 行 / 撤销后 171 行，
         * 两者都是空行 —— 内容其实**完全没动**，差 23 行只因为上方删掉了 23 行）。
         * 正确做法：从中心行向两侧找**最近的非空行**作内容标识
         * （行号会因上方增删平移，文本不会）。
         */
        let probeLine = lo;
        for (let k = 0; k <= 40; k++) {
          const down = lo + k, up = lo - k;
          if (down < lines.length && (lines[down] || "").trim()) { probeLine = down; break; }
          if (up >= 0 && (lines[up] || "").trim()) { probeLine = up; break; }
        }
        return {
          top: ta.scrollTop, max: Math.max(0, ta.scrollHeight - ta.clientHeight),
          centerLine: lo, centerProbeLine: probeLine,
          centerText: (lines[probeLine] || "").trim().slice(0, 24),
        };
      `);
      log(`  撤销前视口（源码面 50%）：top=${viewBefore.top} max=${viewBefore.max} 中央行=${viewBefore.centerLine} 探针行=${viewBefore.centerProbeLine} "${viewBefore.centerText}"`);

      await ev(`window.__LMD_SCROLL_TRACE = []; return true;`);
      const undo1 = await measureAction(`__uKey("z", "KeyZ", true); return true;`);
      const undo2 = await measureAction(`__uKey("z", "KeyZ", true); return true;`);
      const traceS = await ev(`return JSON.stringify(window.__LMD_SCROLL_TRACE || []);`);
      log(`  [trace] ${traceS}`);
      log(`  Ctrl+Z #1 src：${JSON.stringify(undo1.src)}`);
      log(`  Ctrl+Z #2 src：${JSON.stringify(undo2.src)}`);
      for (const w of [...undo1.dump.log, ...undo2.dump.log].filter((x) => x.who === "textarea")) {
        log(`     t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
      }
      const afterS = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const pm = document.querySelector(".editor-container .ProseMirror");
        return {
          srcLen: ta ? ta.value.length : -1, srcTop: ta ? ta.scrollTop : -1, srcSel: ta ? ta.selectionStart : -1,
          pmLen: pm ? pm.textContent.length : -1,
        };
      `);
      log(`  源码撤销后稳态：${JSON.stringify(afterS)}`);

      /**
       * S1 的核心断言：改动发生在**视口上方**时，撤销后视口中央的**内容必须不动**。
       * 判据用内容（视口中央行文本 + 行号），不用像素 —— 文本长度变了，像素必然变。
       *
       * ⚠️ 必须在**切回阅读模式之前**采：切走后 textarea 是 `display:none`
       * （`clientHeight=0`、`scrollTop=0`），这时采到的全是 0 —— 上一版探针把它放在
       * 切回之后，于是「中央行」读成第 0 行（`# 撤销抖动取证`），判据变成假 FAIL。
       */
      const viewAfter = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const cs = getComputedStyle(ta);
        const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
        const mirror = document.createElement("div");
        mirror.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;" +
          "width:" + (ta.clientWidth + bl + br) + "px;padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";" +
          "border-style:solid;border-width:" + cs.borderTopWidth + " " + cs.borderRightWidth + " " + cs.borderBottomWidth + " " + cs.borderLeftWidth + ";" +
          "white-space:pre-wrap;word-break:" + cs.wordBreak + ";font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";" +
          "line-height:" + cs.lineHeight + ";margin:0;overflow:hidden;";
        document.body.appendChild(mirror);
        let tops = [];
        try {
          const ls = ta.value.split("\\n"); const markers = [];
          for (let k = 0; k < ls.length; k++) {
            const m = document.createElement("span"); m.textContent = "\u200b"; mirror.appendChild(m); markers.push(m);
            mirror.appendChild(document.createTextNode(ls[k] + (k < ls.length - 1 ? "\\n" : "")));
          }
          const boxTop = mirror.getBoundingClientRect().top;
          tops = markers.map((m) => m.getBoundingClientRect().top - boxTop);
        } finally { mirror.remove(); }
        const centerY = ta.scrollTop + ta.clientHeight / 2;
        let lo = 0, hi = tops.length - 1;
        if (centerY <= tops[0]) { lo = 0; } else if (centerY >= tops[hi]) { lo = hi; } else {
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= centerY) lo = mid; else hi = mid - 1; }
        }
        const lines = ta.value.split("\\n");
        /**
         * ⚠️ 视口中央行**可能落在空行**上（段落之间本来就有空行）。
         * 拿空行文本比较等于拿 "" === ""，既测不出"内容跳走"，也会被
         * "centerText !== ''" 守卫误判为失败（实测：撤销前 194 行 / 撤销后 171 行，
         * 两者都是空行 —— 内容其实**完全没动**，差 23 行只是因为上方删掉了 23 行）。
         * 正确做法：从中心行向两侧找**最近的非空行**，用它的文本作内容标识
         * （行号会因上方增删而平移，文本不会）。
         */
        let probeLine = lo;
        for (let k = 0; k <= 40; k++) {
          const up = lo - k, down = lo + k;
          if (down < lines.length && (lines[down] || "").trim()) { probeLine = down; break; }
          if (up >= 0 && (lines[up] || "").trim()) { probeLine = up; break; }
        }
        return {
          top: ta.scrollTop, max: Math.max(0, ta.scrollHeight - ta.clientHeight),
          centerLine: lo,
          centerProbeLine: probeLine,
          centerText: (lines[probeLine] || "").trim().slice(0, 24),
          gapToBottom: Math.max(0, ta.scrollHeight - ta.clientHeight) - ta.scrollTop,
        };
      `);
      log(`  撤销后视口（源码面）：top=${viewAfter.top} max=${viewAfter.max} 中央行=${viewAfter.centerLine} "${viewAfter.centerText}"`);

      // 切回阅读看位置（必须在源码面采样之后 —— 切走后 textarea 不可见）
      await doubleCtrl();
      await sleep(1500);
      const backReading = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, sh: sc.scrollHeight };
      `);
      const backCenter = await ev(`
        const sc = document.querySelector(".editor-container");
        const root = sc.querySelector(".ProseMirror");
        if (!root || !(sc.clientHeight > 0)) return null;
        const sr = sc.getBoundingClientRect();
        const cy = sr.top + sc.clientHeight / 2;
        const kids = Array.from(root.children);
        for (let i = 0; i < kids.length; i++) {
          const r = kids[i].getBoundingClientRect();
          if (r.height > 0 && cy >= r.top && cy <= r.bottom) {
            return { index: i, text: (kids[i].textContent || "").trim().slice(0, 24) };
          }
        }
        return null;
      `);
      log(`  切回阅读：${JSON.stringify(backReading)} 中央块=${JSON.stringify(backCenter)}`);
      runs.source = { pmFocus, pmLenAfter, srcBase, insS, undo1, undo2, afterS, viewBefore, viewAfter, backReading, backCenter };
      check(
        "S1 【核心】改动在视口上方：撤销/恢复后视口中央**内容不变**（不得跳走）",
        viewBefore.centerText === viewAfter.centerText && viewBefore.centerText !== "",
        `撤销前 "${viewBefore.centerText}"（行 ${viewBefore.centerLine}）→ 撤销后 "${viewAfter.centerText}"（行 ${viewAfter.centerLine}）`,
      );
      check(
        "S1b 撤销后不得贴底（改动在上方时，视口应仍在文档中部）",
        viewAfter.gapToBottom >= 2,
        `距底=${viewAfter.gapToBottom}px`,
      );
      check(
        "S1c 撤销窗口内不得出现「先贴底再拉回」（贴底中间态样本 = 0）",
        (undo1.src.clampSamples ?? 0) === 0 && (undo2.src.clampSamples ?? 0) === 0,
        `#1=${undo1.src.clampSamples} #2=${undo2.src.clampSamples}`,
      );
      check(
        "S2 源码撤销：显著写入方向反转 ≤ 2 次",
        (undo1.src.reversals ?? 99) <= 2 && (undo2.src.reversals ?? 99) <= 2,
        `#1=${undo1.src.reversals} #2=${undo2.src.reversals}，振幅 #1=${undo1.src.span}px #2=${undo2.src.span}px`,
      );
      check(
        "S3 源码撤销：窗口尾部 200ms 稳定（≤2px）",
        (undo1.src.tailSpan ?? 99) <= 2 && (undo2.src.tailSpan ?? 99) <= 2,
        `#1=${undo1.src.tailSpan}px #2=${undo2.src.tailSpan}px`,
      );
      check(
        "S4 跨模式撤销真的跨过去了（两次撤销后文本长度 < 插入后）",
        afterS.srcLen < (insS.afterLen ?? 0) && afterS.pmLen > 0,
        `插入后 srcLen=${insS.afterLen}，两次撤销后 srcLen=${afterS.srcLen} pmLen=${afterS.pmLen}`,
      );
      check(
        "S5 撤销后再切回阅读面，阅读面不得贴底（贴底 = 上一步把两边都钳坏了）",
        backReading.max <= 0 || backReading.max - backReading.top >= 2,
        `阅读面 top=${backReading.top} max=${backReading.max}，距底=${(backReading.max - backReading.top).toFixed(1)}px`,
      );
    }

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ runs, checks }, null, 2), "utf-8");
    log(`报告已写入：${OUT_TXT}`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
};

main().catch((e) => {
  console.error("探针失败：", e);
  process.exitCode = 2;
});
