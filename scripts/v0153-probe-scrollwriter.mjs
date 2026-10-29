/**
 * LightMD v0.15.3 返修 —— **诊断探针**：编辑后双击 Ctrl 的滚动"抖动/漂移"到底是谁写的。
 *
 * 用户原话：「我在进行文档编辑后，发现双击 Ctrl 漂移和文档对齐的问题又出现了。」
 * 另有：「跨模式撤销栈修改撤销或恢复文档会抖动。」
 *
 * ## 为什么还要这个探针
 * `scripts/v0153-probe-edit-then-toggle.mjs` 的**稳态**采样式判定在 v0.15.2 打包产物上
 * 已经全 PASS（20 轮往返 0.00px、左右对齐 Δ行 < 1、内容保真）。也就是说稳态没问题，
 * 用户看到的更可能是**瞬态**：动画窗口 / 恢复链前 400ms 内的"先写成 X、再拉回 Y"
 * 的两次写入 —— 稳态采样（每轮等 1.1s）恰好跳过了它。
 *
 * 语义地图 §4-31 的教训：**"是谁写的"一律用 scrollTop setter hook 抓调用栈**，
 * 读代码猜不出来（有损映射的写入藏在右→左同步里，而原生钳位根本没有 JS 栈）。
 *
 * ## 本探针做什么
 * 1. 在页面内 hook `Element.prototype.scrollTop` 的 setter（记录 值/旧值/Δ/调用栈帧，
 *    并区分「JS 写入」与「浏览器原生钳位」——后者 setter 根本不被调用）；
 * 2. 采样器用 `setTimeout(16ms)`（**不用 rAF**：WebView2 窗口不可见时 rAF 会被节流）；
 * 3. 场景 A：编辑后「编辑→阅读」与「阅读→编辑」各切一次，逐帧记录
 *    阅读面 `.editor-container` 与源码面 `textarea.source-editor` 的
 *    `scrollTop / scrollHeight / clientHeight`；
 * 4. 场景 B：跨模式撤销 —— 阅读模式编辑 → 切源码 → 编辑 → 切回阅读 → Ctrl+Z ×N →
 *    Ctrl+Y ×N，每步逐帧记录两面 scrollTop + textarea.selectionStart；
 * 5. 判定：
 *    - **抖动的定义**：同一面上出现 ≥2 次方向相反的显著写入（|Δ|>2px，方向反转）
 *      且总位移 > 4px，即"先跳走再拉回"；
 *    - **漂移的定义**：切换完成后 1.2s 内的最终值相对"切换前基准"偏移 > 12px，
 *      或连续多轮单向累积；
 *    - **原生钳位**：采样序列里出现「scrollHeight 变小 + scrollTop 随之变小」且
 *      setter 未被调用 → 说明确实发生了浏览器钳位（属于可解释的中间态，但若之后
 *      没有拉回，就是真漂移）。
 *
 * 用法：
 *   node scripts/v0153-probe-scrollwriter.mjs
 * 环境变量：V0153W_PORT（默认 9299）、V0153W_EXE
 *   V0153W_ONLY=edit | undo   只跑一个场景
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0153W_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0153W_PORT || 9299);
const ONLY = process.env.V0153W_ONLY || "";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0153-probe-scrollwriter.txt");
const OUT_JSON = path.join(OUT_DIR, "v0153-probe-scrollwriter.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";
const EDIT_MARK = "【抖动取证标记】";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`找不到 dist/index.html`);
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
            pending.set(msgId, {
              res,
              rej,
            });
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
  const p = ["# 抖动取证", ""];
  for (let i = 1; i <= 45; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(
        `第 ${i}.${j} 段：这是一段刻意写长的正文，用于让 textarea 的 pre-wrap 在窄宽度下折成更多视觉行。` +
          `继续堆字以拉长该逻辑行，使滚动量足够大、任何一次锚点误差都能被量化出来。`,
      );
      p.push("");
    }
  }
  p.push("## 末段");
  p.push("最后一段用于确认底部。");
  return p.join("\n");
}

/** 页面内工具：scrollTop setter hook + 逐帧采样器（setTimeout，不用 rAF） */
const PAGE_TOOLS = String.raw`
/**
 * 安装 scrollTop setter hook。
 * scrollTop 定义在 Element.prototype（不在 HTMLElement.prototype）。
 * 只记录 TEXTAREA.source-editor 与 .editor-container 两类目标。
 */
window.__wHook = function () {
  if (window.__wInstall) return "already";
  window.__wInstall = true;
  window.__wLog = [];
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (!desc || !desc.get || !desc.set) return "no-descriptor";
  const origGet = desc.get;
  const origSet = desc.set;
  window.__wWriteCount = 0;
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
          const st = (new Error().stack || "").split("\n").slice(1, 8).map((s) => s.trim());
          window.__wLog.push({
            t: +performance.now().toFixed(1),
            who: isTa ? "textarea" : "reader",
            from: +(+old).toFixed(2),
            to: +(+v).toFixed(2),
            d: +(+v - +old).toFixed(2),
            native: false,
            frames: st.map((s) => s.replace(/^at\s*/, "").slice(0, 120)),
          });
          window.__wWriteCount++;
        }
      } catch (e) { /* 诊断绝不影响功能 */ }
      return origSet.call(el, v);
    },
  });
  return "installed";
};

/** 逐帧采样器：setTimeout(16ms)，记录两面 scrollTop/scrollHeight/clientHeight */
window.__wStart = function (ms) {
  window.__wSamples = [];
  window.__wT0 = performance.now();
  const tick = () => {
    const ta = document.querySelector("textarea.source-editor");
    const sc = document.querySelector(".editor-container");
    const srcVisible = !!ta && ta.offsetHeight > 0 && ta.clientHeight > 0;
    const pmVisible = !!sc && sc.offsetHeight > 0 && sc.clientHeight > 0;
    window.__wSamples.push({
      t: +(performance.now() - window.__wT0).toFixed(1),
      src: srcVisible ? { top: +ta.scrollTop.toFixed(2), sh: ta.scrollHeight, ch: ta.clientHeight, sel: ta.selectionStart } : null,
      pm: pmVisible ? { top: +sc.scrollTop.toFixed(2), sh: sc.scrollHeight, ch: sc.clientHeight } : null,
      anim: (document.querySelector(".editor-main-area") || {}).dataset
        ? document.querySelector(".editor-main-area").dataset.lmdModeAnim || null
        : null,
    });
    if (performance.now() - window.__wT0 < ms) setTimeout(tick, 16);
  };
  tick();
  return true;
};

window.__wDump = function () {
  return JSON.stringify({
    log: window.__wLog || [],
    samples: window.__wSamples || [],
    writes: window.__wWriteCount || 0,
  });
};
window.__wClear = function () { window.__wLog = []; window.__wWriteCount = 0; return true; };

/** 真实键事件（走 App 的 window keydown 路径） */
window.__wKey = function (key, code, mods) {
  const init = Object.assign({ key, code, bubbles: true, cancelable: true }, mods || {});
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

/** 分析一段采样：判断抖动（方向反转的显著写入）与钳位 */
function analyzeSamples(samples, who, baseTop) {
  const seq = samples.map((s) => (who === "src" ? s.src : s.pm)).filter(Boolean);
  if (seq.length < 2) return { ok: false, why: "no-samples" };
  const tops = seq.map((x) => x.top);
  const shs = seq.map((x) => x.sh);
  const min = Math.min(...tops);
  const max = Math.max(...tops);
  const span = max - min;
  const final = tops[tops.length - 1];
  const base = Number.isFinite(baseTop) ? baseTop : tops[0];
  const finalDrift = final - base;
  // 方向反转计数（|Δ|>2px 换向）
  let reversals = 0;
  let lastDir = 0;
  for (let i = 1; i < tops.length; i++) {
    const d = tops[i] - tops[i - 1];
    if (Math.abs(d) <= 2) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) reversals++;
    lastDir = dir;
  }
  const shChanged = Math.max(...shs) - Math.min(...shs);
  return {
    ok: true,
    span: +span.toFixed(2),
    final: +final.toFixed(2),
    base: +base.toFixed(2),
    finalDrift: +finalDrift.toFixed(2),
    reversals,
    shSpan: shChanged,
    firstTop: tops[0],
    maxTop: max,
    minTop: min,
    seqLen: seq.length,
  };
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-jitter-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "jitter.md");
  fs.writeFileSync(docFile, makeDoc(), "utf-8");

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
      window.__wKey("Control", "ControlLeft");
      await new Promise((r) => setTimeout(r, 60));
      window.__wKey("Control", "ControlLeft");
      return true;
    `);
  };

  try {
    // ─── 0. 装 hook + 打开文档 ───
    const hook = await ev(`return window.__wHook();`);
    log(`[probe] scrollTop hook：${hook}`);

    const docText = makeDoc();
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

    // ─── 场景 A：编辑后切模式，逐帧看谁写了什么 ───
    if (!ONLY || ONLY === "edit") {
      log("");
      log("════════ 场景 A：编辑后「编辑→阅读」逐帧写入 ────────");
      // A1 基线：阅读面滚到 50%
      await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        return sc.scrollTop;
      `);
      await sleep(900);
      const baseA = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight, sh: sc.scrollHeight, ch: sc.clientHeight };
      `);
      log(`  A1 基线（阅读面）：scrollTop=${baseA.top} max=${baseA.max} sh=${baseA.sh} ch=${baseA.ch}`);

      // A2 进编辑模式（关键：此时右侧预览会同时被打开 → 左栏宽度突变）
      await doubleCtrl();
      await ev(`__wClear(); __wStart(1400); return true;`);
      await sleep(1500);
      const dumpA2 = JSON.parse(await ev(`return __wDump();`));
      const anaA2 = analyzeSamples(dumpA2.samples, "src", NaN);
      log(`  A2 进编辑（逐帧 ${dumpA2.samples.length} 帧，JS 写入 ${dumpA2.writes} 次）`);
      log(`     textarea: ${JSON.stringify(anaA2)}`);
      log(`     写入者：`);
      for (const w of dumpA2.log.filter((x) => x.who === "textarea")) {
        log(`       t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames[0]}`);
      }
      check(
        "A2 进入编辑模式：textarea 不得出现「先跳走再拉回」（方向反转 ≤1 次且总位移 ≤ 24px）",
        anaA2.ok && anaA2.reversals <= 1 && anaA2.span <= 24,
        `反转=${anaA2.reversals}，振幅=${anaA2.span}px，scrollHeight 变化=${anaA2.shSpan}px`,
      );

      // ── A2b：进编辑后 **2 秒内**所有 textarea 写入的调用栈（找"右→左有损写"）──
      log(`  A2b 逐帧抓 textarea 写入栈（2.1s）`);
      log(`     文本面 scrollTop=${await ev(`const t=document.querySelector("textarea.source-editor"); return t? t.scrollTop : -1;`)}` +
          ` max=${await ev(`const t=document.querySelector("textarea.source-editor"); return t? Math.max(0,t.scrollHeight-t.clientHeight) : -1;`)}`);
      {
        // 右屏是否在写左屏：等 iframe 重渲染后再滚它一下，看左屏是否被改
        const before = await ev(`const t=document.querySelector("textarea.source-editor"); return t? t.scrollTop : -1;`);
        await sleep(1200);
        const after = await ev(`const t=document.querySelector("textarea.source-editor"); return t? t.scrollTop : -1;`);
        log(`     1.2s 后 textarea：${before} → ${after}`);
        // 主动滚右屏 200px，看左屏是否被"有损写"
        await ev(`
          const ifr = document.querySelector(".split-preview-shell iframe");
          const d = ifr && ifr.contentDocument;
          const sc = d ? (d.scrollingElement || d.documentElement) : null;
          if (sc) { sc.scrollTop = sc.scrollTop + 240; sc.dispatchEvent(new Event("scroll")); }
          return sc ? sc.scrollTop : -1;
        `);
        await sleep(900);
        const afterScrollRight = await ev(`const t=document.querySelector("textarea.source-editor"); return t? t.scrollTop : -1;`);
        log(`     滚右屏 +240px 后 textarea：${after} → ${afterScrollRight}（若变化 = syncToSource 有损右→左写）`);
      }

      // A3 在编辑模式**视口中央那一段正文**里插入标记（不插空行：空行会新建块，
      //    那属于结构性编辑，几何变化本就大；用户日常是改正文）
      const a3 = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        ta.focus();
        const lines = ta.value.split("\\n");
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
        const approxLine = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
        let pick = Math.max(0, Math.min(lines.length - 1, approxLine));
        for (let i = 0; i < 40; i++) {
          const cand = pick + (i % 2 === 0 ? i / 2 : -Math.ceil(i / 2));
          if (cand < 0 || cand >= lines.length) continue;
          const t = lines[cand];
          const isBody = t && t.trim() && t.trim().charAt(0) !== "#" && t.trim().charAt(0) !== "|"
            && t.trim().charAt(0) !== ">" && t.trim().charAt(0) !== "-" && t.trim().charAt(0) !== ":";
          if (isBody) { pick = cand; break; }
        }
        let pos = 0;
        for (let i = 0; i < pick; i++) pos += lines[i].length + 1;
        ta.setSelectionRange(pos, pos);
        document.execCommand("insertText", false, ${JSON.stringify(EDIT_MARK)});
        return { pick, pos, len: ta.value.length, lineText: (lines[pick] || "").slice(0, 30) };
      `);
      log(`  A3 已编辑：行 ${a3.pick}，pos=${a3.pos}，len=${a3.len}，原文="${a3.lineText}"`);
      await sleep(1300);

      // A4 切回阅读：逐帧记录，看是否出现钳位/回拉
      const beforeA4 = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, sh: sc.scrollHeight };
      `);
      await doubleCtrl();
      await ev(`__wClear(); __wStart(1400); return true;`);
      await sleep(1500);
      const dumpA4 = JSON.parse(await ev(`return __wDump();`));
      const anaA4 = analyzeSamples(dumpA4.samples, "pm", NaN);
      log(`  A4 回阅读（逐帧 ${dumpA4.samples.length} 帧，JS 写入 ${dumpA4.writes} 次）`);
      log(`     切走前阅读面 scrollTop=${beforeA4.top} sh=${beforeA4.sh}（该面当时是隐藏的，仅作参考）`);
      log(`     reader: ${JSON.stringify(anaA4)}`);
      log(`     写入者：`);
      for (const w of dumpA4.log.filter((x) => x.who === "reader")) {
        log(`       t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames[0]}`);
      }
      // 关键：动画窗口内的 scrollHeight 是否突变（= padding-inline 瞬变的指纹）
      const shSeries = dumpA4.samples.filter((s) => s.pm).map((s) => s.pm.sh);
      log(`     reader.scrollHeight 序列（去重）：${[...new Set(shSeries)].slice(0, 8).join(" → ")}`);
      check(
        "A4 阅读面：scrollHeight 不得在切换窗口中突变超过 30%（宽度过渡被禁用 = 瞬时重排的指纹）",
        (() => {
          if (!shSeries.length) return false;
          const lo = Math.min(...shSeries);
          const hi = Math.max(...shSeries);
          return lo > 0 && hi / lo <= 1.3;
        })(),
        `sh min/max = ${Math.min(...shSeries)}/${Math.max(...shSeries)}`,
      );
      check(
        "A4 阅读面：不得出现「先跳走再拉回」（方向反转 ≤1 次）",
        anaA4.ok && anaA4.reversals <= 1,
        `反转=${anaA4.reversals}，振幅=${anaA4.span}px，末值=${anaA4.final}`,
      );
      check(
        "A4 阅读面：最终位置不得相对「进入编辑前」偏移 > 12px（编辑引起的合法位移除外）",
        anaA4.ok && Math.abs(anaA4.final - baseA.top) <= 12 + 0,
        `final=${anaA4.final}，baseline=${baseA.top}，Δ=${(anaA4.final - (baseA.top || 0)).toFixed(2)}`,
      );
      fs.writeFileSync(
        path.join(OUT_DIR, "v0153-scrollwriter-sceneA.json"),
        JSON.stringify({ baseA, a2: dumpA2, a4: dumpA4, anaA2, anaA4 }, null, 2),
        "utf-8",
      );
    }

    // ─── 场景 B：跨模式撤销/恢复逐帧 ───
    if (!ONLY || ONLY === "undo") {
      log("");
      log("════════ 场景 B：跨模式撤销 / 恢复逐帧 ────────");
      /**
       * 构造跨模式历史：
       *  ① 阅读模式（PM）里改一处 → 切源码；
       *  ② 源码里再改一处 → 切回阅读；
       *  ③ Ctrl+Z ×2（应逐步跨模式撤回到最早）→ 逐帧采样；
       *  ④ Ctrl+Y ×2 → 逐帧采样。
       */
      // 确保在阅读模式
      const curMode = await ev(`
        const sc = document.querySelector(".editor-container");
        const ta = document.querySelector("textarea.source-editor");
        return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
      `);
      log(`  当前模式：${curMode}`);
      if (curMode !== "preview") {
        await doubleCtrl();
        await sleep(1200);
      }

      // ① 阅读模式里在视口中央块里打字（走 PM → pmAdapter）
      const pmEdit = await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.4);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        await new Promise((r) => setTimeout(r, 600));
        const pm = sc.querySelector(".ProseMirror");
        const p = pm.querySelectorAll("p");
        const target = p[Math.min(p.length - 1, 2)];
        if (!target) return { ok: false };
        // 点进该段落中间，再插字（走真实 PM 输入路径）
        const r = target.getBoundingClientRect();
        const cx = r.left + 20, cy = r.top + r.height / 2;
        const evOpt = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
        target.dispatchEvent(new MouseEvent("mousedown", evOpt));
        target.dispatchEvent(new MouseEvent("mouseup", evOpt));
        await new Promise((r2) => setTimeout(r2, 120));
        // PM 的输入必须走 Input.insertText（由外部 CDP 做），这里只回传落点
        return { ok: true, x: cx, y: cy, text: (target.textContent || "").slice(0, 24) };
      `);
      log(`  ① 阅读面准备：${JSON.stringify(pmEdit)}`);
      if (pmEdit?.ok) {
        await cdp.send("Input.insertText", { text: "PM改" });
        await sleep(600);
      }
      const pmLen1 = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return pm ? pm.textContent.length : -1;
      `);
      log(`  ① 阅读模式输入后 textContent.len=${pmLen1}`);

      // ② 切源码再改一处
      await doubleCtrl();
      await sleep(1300);
      const srcBefore = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return null;
        const lines = ta.value.split("\\n");
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
        const pick = Math.max(0, Math.min(lines.length - 1, Math.round((ta.scrollTop + ta.clientHeight / 2) / lh)));
        let pos = 0;
        for (let i = 0; i < pick; i++) pos += lines[i].length + 1;
        ta.setSelectionRange(pos, pos);
        return { pick, pos, top: ta.scrollTop, sel: ta.selectionStart };
      `);
      log(`  ② 源码面落点：${JSON.stringify(srcBefore)}`);
      await ev(`
        const ta = document.querySelector("textarea.source-editor");
        ta.focus();
        document.execCommand("insertText", false, "SRC改");
        return ta.value.length;
      `).then((n) => log(`  ② 源码输入后 len=${n}`));
      await sleep(900);

      // ③ 切回阅读，然后 Ctrl+Z ×2 逐帧
      await doubleCtrl();
      await sleep(1400);
      const beforeUndo = await ev(`
        const sc = document.querySelector(".editor-container");
        const ta = document.querySelector("textarea.source-editor");
        return {
          readerTop: sc ? sc.scrollTop : null,
          readerSh: sc ? sc.scrollHeight : null,
          srcTop: ta ? ta.scrollTop : null,
          srcSel: ta ? ta.selectionStart : null,
          pmLen: sc && sc.querySelector(".ProseMirror") ? sc.querySelector(".ProseMirror").textContent.length : null,
        };
      `);
      log(`  ③ 撤销前：${JSON.stringify(beforeUndo)}`);

      const undoRuns = [];
      for (let k = 1; k <= 3; k++) {
        await ev(`__wClear(); __wStart(1200); return true;`);
        await ev(`window.__wKey("z", "KeyZ", { ctrlKey: true }); return true;`);
        await sleep(1400);
        const dump = JSON.parse(await ev(`return __wDump();`));
        const anaPm = analyzeSamples(dump.samples, "pm", NaN);
        const anaSrc = analyzeSamples(dump.samples, "src", NaN);
        const pmLens = dump.samples.filter((s) => s.pm).map((s) => s.pm.sh);
        // 文本长度：直接读当前 DOM
        const nowLen = await ev(`
          const pm = document.querySelector(".editor-container .ProseMirror");
          const ta = document.querySelector("textarea.source-editor");
          return { pmLen: pm ? pm.textContent.length : null, srcLen: ta ? ta.value.length : null };
        `);
        log(`  Ctrl+Z #${k}：pmLen=${nowLen.pmLen} srcLen=${nowLen.srcLen}`);
        log(`     reader: ${JSON.stringify(anaPm)}`);
        log(`     textarea: ${JSON.stringify(anaSrc)}`);
        for (const w of dump.log) {
          log(
            `       t=${w.t} ${w.who} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`,
          );
        }
        undoRuns.push({ k, dump, anaPm, anaSrc, nowLen });
      }

      // ④ Ctrl+Y ×3
      const redoRuns = [];
      for (let k = 1; k <= 3; k++) {
        await ev(`__wClear(); __wStart(1200); return true;`);
        await ev(`window.__wKey("y", "KeyY", { ctrlKey: true }); return true;`);
        await sleep(1400);
        const dump = JSON.parse(await ev(`return __wDump();`));
        const anaPm = analyzeSamples(dump.samples, "pm", NaN);
        const anaSrc = analyzeSamples(dump.samples, "src", NaN);
        const nowLen = await ev(`
          const pm = document.querySelector(".editor-container .ProseMirror");
          const ta = document.querySelector("textarea.source-editor");
          return { pmLen: pm ? pm.textContent.length : null, srcLen: ta ? ta.value.length : null };
        `);
        log(`  Ctrl+Y #${k}：pmLen=${nowLen.pmLen} srcLen=${nowLen.srcLen}`);
        log(`     reader: ${JSON.stringify(anaPm)}`);
        log(`     textarea: ${JSON.stringify(anaSrc)}`);
        for (const w of dump.log) {
          log(`       t=${w.t} ${w.who} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
        }
        redoRuns.push({ k, dump, anaPm, anaSrc, nowLen });
      }

      // 判定：撤销/恢复期间不得有"方向反转的显著写入"（= 抖动），且光标不得跳回
      const allRuns = [...undoRuns, ...redoRuns];
      const worstPmRev = Math.max(...allRuns.map((r) => r.anaPm.reversals ?? 0));
      const worstSrcRev = Math.max(...allRuns.map((r) => r.anaSrc.reversals ?? 0));
      const worstPmSpan = Math.max(...allRuns.map((r) => r.anaPm.span ?? 0));
      const worstSrcSpan = Math.max(...allRuns.map((r) => r.anaSrc.span ?? 0));
      check(
        "撤销/恢复：阅读面不得出现方向反转的显著写入（抖动定义）",
        worstPmRev <= 1,
        `最多反转 ${worstPmRev} 次，最大振幅 ${worstPmSpan}px`,
      );
      check(
        "撤销/恢复：源码面不得出现方向反转的显著写入（抖动定义）",
        worstSrcRev <= 1,
        `最多反转 ${worstSrcRev} 次，最大振幅 ${worstSrcSpan}px`,
      );
      check(
        "撤销/恢复：文本长度必须逐步变化（说明跨模式时间线真的在动）",
        (() => {
          const lens = allRuns.map((r) => r.nowLen.pmLen ?? r.nowLen.srcLen ?? -1);
          return new Set(lens).size >= 2;
        })(),
        `长度序列=${allRuns.map((r) => r.nowLen.pmLen ?? r.nowLen.srcLen).join(",")}`,
      );

      fs.writeFileSync(
        path.join(OUT_DIR, "v0153-scrollwriter-sceneB.json"),
        JSON.stringify({ beforeUndo, undoRuns, redoRuns }, null, 2),
        "utf-8",
      );
    }

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ checks }, null, 2), "utf-8");
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
