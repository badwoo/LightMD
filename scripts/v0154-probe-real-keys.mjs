/**
 * LightMD v0.15.4 —— **真实按键探针**：用 CDP `Input.dispatchKeyEvent` 走完整
 * keydown → char → keyup 链路（`Input.insertText` 不触发 keyup，因此前几代探针
 * 漏掉了 keyup 处理器这条写入路径）。
 *
 * 采样：每 8ms 记录
 *  - 阅读面 `.editor-container` 的 scrollTop / scrollHeight（PM 模式）
 *  - 源码面 textarea 的 scrollTop / scrollHeight（源码模式）
 *  - 视口中央"内容坐标"：PM 用「中央块的 data-src-line + 块内比例」，
 *    源码用「scrollTop + clientHeight/2 对应的行号」——这是**内容**坐标，
 *    不受 DOM 重建影响，能直接回答"用户看到的内容有没有跳"。
 *
 * 判据：
 *  - 内容坐标序列出现「偏离 → 回返」（方向反转）= 抖动
 *  - scrollTop 写入次数 & 反转次数
 *
 * 用法：node scripts/v0154-probe-real-keys.mjs
 * 环境变量：V0154K_PORT（默认 9306）、V0154K_EXE、V0154K_ONLY=pm|src|undo
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0154K_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0154K_PORT || 9306);
const ONLY = process.env.V0154K_ONLY || "";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0154-probe-real-keys.txt");
const OUT_JSON = path.join(OUT_DIR, "v0154-probe-real-keys.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";

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
  const p = ["# 真实按键取证", ""];
  for (let i = 1; i <= 40; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(`第 ${i}.${j} 段：这一段刻意写长，让两个面都产生可滚动内容。`);
      p.push("");
    }
  }
  return p.join("\n");
}

const PAGE_TOOLS = String.raw`
/**
 * 采样器（8ms）：记录 scrollTop/vh，并计算**内容坐标**（不受 DOM 重建影响）。
 * 内容坐标定义：
 *  - PM 模式：取 .ProseMirror 顶层块里离视口中心最近的、带 data-src-line 的块的
 *    sourceLine，加上块内比例（0..1）→ 一个单调的"内容位置"数值。
 *  - 源码模式：scrollTop / 行高 → 视口中央的行号（浮点）。
 */
window.__rkStart = function (ms) {
  window.__rkSamples = [];
  window.__rkLog = [];
  window.__rkT0 = performance.now();

  // scrollTop setter hook（只在采样窗口内记录）
  if (!window.__rkHooked) {
    window.__rkHooked = true;
    const sd = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (sd && sd.get && sd.set) {
      const g = sd.get, s = sd.set;
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get: g,
        set(v) {
          try {
            if (window.__rkArmed) {
              const el = this;
              const isTa = el && el.tagName === "TEXTAREA" && el.classList && el.classList.contains("source-editor");
              const isReader = el && el.classList && el.classList.contains("editor-container");
              if (isTa || isReader) {
                const old = g.call(el);
                window.__rkLog.push({
                  t: +(performance.now() - window.__rkT0).toFixed(1),
                  who: isTa ? "textarea" : "reader",
                  from: +(+old).toFixed(2),
                  to: +(+v).toFixed(2),
                  d: +(+v - +old).toFixed(2),
                  frames: (new Error().stack || "").split("\n").slice(1, 7).map((x) => x.trim().slice(0, 130)),
                });
              }
            }
          } catch (e) {}
          return s.call(this, v);
        },
      });
    }
  }
  window.__rkArmed = true;
  setTimeout(() => { window.__rkArmed = false; }, ms);

  const contentPosPm = () => {
    const sc = document.querySelector(".editor-container");
    if (!sc || sc.clientHeight <= 0) return null;
    const pm = sc.querySelector(".ProseMirror");
    if (!pm) return null;
    const rect = sc.getBoundingClientRect();
    const centerY = rect.top + sc.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const child of pm.children) {
      const line = child.getAttribute ? child.getAttribute("data-src-line") : null;
      if (line === null) continue;
      const r = child.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - centerY);
      if (d < bestD) {
        bestD = d;
        best = { line: Number(line), ratio: r.height > 0 ? (centerY - r.top) / r.height : 0 };
      }
    }
    if (!best) return null;
    return +(best.line + Math.max(0, Math.min(1, best.ratio))).toFixed(4);
  };

  const contentPosSrc = () => {
    const ta = document.querySelector("textarea.source-editor");
    if (!ta || ta.clientHeight <= 0) return null;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
    return +(((ta.scrollTop + ta.clientHeight / 2) / lh)).toFixed(4);
  };

  const tick = () => {
    const sc = document.querySelector(".editor-container");
    const ta = document.querySelector("textarea.source-editor");
    const pmVisible = !!sc && sc.clientHeight > 0;
    const srcVisible = !!ta && ta.clientHeight > 0;
    window.__rkSamples.push({
      t: +(performance.now() - window.__rkT0).toFixed(1),
      pm: pmVisible ? { top: +sc.scrollTop.toFixed(2), sh: sc.scrollHeight, ch: sc.clientHeight, pos: contentPosPm() } : null,
      src: srcVisible ? {
        top: +ta.scrollTop.toFixed(2), sh: ta.scrollHeight, ch: ta.clientHeight,
        pos: contentPosSrc(), sel: ta.selectionStart,
      } : null,
    });
    if (performance.now() - window.__rkT0 < ms) setTimeout(tick, 8);
  };
  tick();
  return true;
};

window.__rkDump = function () {
  return JSON.stringify({ samples: window.__rkSamples || [], log: (window.__rkLog || []).slice(0, 80) });
};
window.__rkKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

function analyzeSeries(values, label) {
  const arr = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (arr.length < 4) return { ok: false, n: arr.length };
  let rev = 0;
  let lastDir = 0;
  const flips = [];
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (Math.abs(d) < 0.02) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) {
      rev++;
      flips.push({ i, from: arr[i - 1], to: arr[i] });
    }
    lastDir = dir;
  }
  const span = Math.max(...arr) - Math.min(...arr);
  const tail = arr.slice(-20);
  const tailSpan = Math.max(...tail) - Math.min(...tail);
  return { ok: true, n: arr.length, span: +span.toFixed(4), reversals: rev, flips: flips.slice(0, 6), tailSpan: +tailSpan.toFixed(4), preview: arr.slice(0, 30) };
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-realkeys-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "real-keys.md");
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

  /** 真实按键：keyDown(含 char) → keyUp（走完整链路，触发 keyup 处理器） */
  const realKey = async (text) => {
    const code = "Key" + text.toUpperCase();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      code,
      key: text,
      text,
      unmodifiedText: text,
    });
    await sleep(12);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      code,
      key: text,
    });
  };

  const ctrlZ = async () => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      code: "ControlLeft",
      key: "Control",
      modifiers: 2,
    });
    await sleep(20);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
      code: "KeyZ",
      key: "z",
      modifiers: 2,
    });
    await sleep(20);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 90,
      nativeVirtualKeyCode: 90,
      code: "KeyZ",
      key: "z",
      modifiers: 2,
    });
    await sleep(20);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      code: "ControlLeft",
      key: "Control",
    });
  };

  const doubleCtrl = async () => {
    await ev(`
      await new Promise((r) => setTimeout(r, 320));
      __rkKey("Control", "ControlLeft", false);
      await new Promise((r) => setTimeout(r, 60));
      __rkKey("Control", "ControlLeft", false);
      return true;
    `);
  };

  const modeNow = () =>
    ev(`
      const sc = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
    `);

  const runs = {};

  try {
    const probeMark = "第 5.1 段";
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
        return (pm.textContent || "").indexOf(${JSON.stringify(probeMark)}) >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入");
    log("[probe] 文档已装入");
    await sleep(900);

    // ── PM 阅读模式：真实按键输入 + Ctrl+Z ──
    if (!ONLY || ONLY === "pm") {
      let mode = await modeNow();
      if (mode !== "preview") {
        await doubleCtrl();
        await sleep(1400);
      }
      log("");
      log("════════ 阅读（PM）模式：真实按键 ══════");
      await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.45);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        return sc.scrollTop;
      `);
      await sleep(800);
      const rect = await ev(`
        const sc = document.querySelector(".editor-container");
        const r = sc.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.round(r.height / 2)) };
      `);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await sleep(600);

      // 单键
      await ev(`__rkStart(800); return true;`);
      await sleep(60);
      await realKey("a");
      await sleep(900);
      const k1 = JSON.parse(await ev(`return __rkDump();`));
      const k1pos = analyzeSeries(k1.samples.map((s) => (s.pm ? s.pm.pos : null)), "pm.pos");
      const k1top = analyzeSeries(k1.samples.map((s) => (s.pm ? s.pm.top : null)), "pm.top");
      const k1w = k1.log.filter((x) => x.who === "reader");
      log(`  输入 1 键：内容坐标 振幅=${k1pos.span} 反转=${k1pos.reversals} 尾=${k1pos.tailSpan}`);
      log(`            内容序列：${JSON.stringify(k1pos.preview)}`);
      log(`            scrollTop 振幅=${k1top.span} 反转=${k1top.reversals}`);
      log(`            scrollTop 写入 ${k1w.length} 次：${JSON.stringify(k1w.map((w) => ({ from: w.from, to: w.to, d: w.d })).slice(0, 10))}`);
      check("K1-PM 输入：内容坐标不得反向（反向 = 用户看到内容跳走再回来）", k1pos.reversals === 0, `反转=${k1pos.reversals} ${JSON.stringify(k1pos.flips)}`);
      check("K2-PM 输入：内容坐标振幅 ≤ 1.05 块（跨一块属正常，>1.05 = 跨块跳走）", k1pos.span <= 1.05, `振幅=${k1pos.span} 块`);
      check("K3-PM 输入：scrollTop 写入 ≤ 3 次", k1w.length <= 3, `写入=${k1w.length}`);

      // 连续 6 键（真实打字节奏）
      log("");
      log("  ── 连续 6 键 ──");
      await ev(`__rkStart(1600); return true;`);
      await sleep(60);
      for (const ch of ["b", "c", "d", "e", "f", "g"]) {
        await realKey(ch);
        await sleep(110);
      }
      await sleep(1000);
      const k2 = JSON.parse(await ev(`return __rkDump();`));
      const k2pos = analyzeSeries(k2.samples.map((s) => (s.pm ? s.pm.pos : null)), "pm.pos");
      const k2w = k2.log.filter((x) => x.who === "reader");
      log(`  内容坐标 振幅=${k2pos.span} 反转=${k2pos.reversals}`);
      log(`  内容序列：${JSON.stringify(k2pos.preview)}`);
      log(`  scrollTop 写入 ${k2w.length} 次`);
      for (const w of k2w.slice(0, 14)) {
        log(`    t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
      }
      check("K4-PM 连续输入：内容坐标不得反向", k2pos.reversals === 0, `反转=${k2pos.reversals}`);
      check("K5-PM 连续输入：scrollTop 写入 ≤ 键数 × 1", k2w.length <= 6, `写入=${k2w.length}`);

      // Ctrl+Z（真实按键链路，含 keyup）
      log("");
      log("  ── Ctrl+Z（真实按键）──");
      await sleep(400);
      await ev(`__rkStart(900); return true;`);
      await sleep(60);
      await ctrlZ();
      await sleep(1000);
      const k3 = JSON.parse(await ev(`return __rkDump();`));
      const k3pos = analyzeSeries(k3.samples.map((s) => (s.pm ? s.pm.pos : null)), "pm.pos");
      const k3w = k3.log.filter((x) => x.who === "reader");
      log(`  内容坐标 振幅=${k3pos.span} 反转=${k3pos.reversals}`);
      log(`  内容序列：${JSON.stringify(k3pos.preview)}`);
      log(`  scrollTop 写入 ${k3w.length} 次`);
      for (const w of k3w.slice(0, 14)) {
        log(`    t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
      }
      check("K6-PM 撤销：内容坐标不得反向", k3pos.reversals === 0, `反转=${k3pos.reversals} ${JSON.stringify(k3pos.flips)}`);
      check("K7-PM 撤销：内容坐标振幅 ≤ 1.05 块（跨一块属正常，>1.05 = 跨块跳走）", k3pos.span <= 1.05, `振幅=${k3pos.span} 块`);
      check("K8-PM 撤销：scrollTop 写入 ≤ 3 次", k3w.length <= 3, `写入=${k3w.length}`);
      runs.pm = { k1pos, k1top, k1w: k1w.length, k2pos, k2w: k2w.length, k3pos, k3w: k3w.length };
    }

    // ── 源码模式 ──
    if (!ONLY || ONLY === "src") {
      let mode = await modeNow();
      if (mode !== "edit") {
        await doubleCtrl();
        await sleep(1400);
      }
      log("");
      log("════════ 源码模式：真实按键 ══════");
      await ev(`
        const ta = document.querySelector("textarea.source-editor");
        ta.focus();
        ta.scrollTop = Math.round((ta.scrollHeight - ta.clientHeight) * 0.45);
        ta.dispatchEvent(new Event("scroll", { bubbles: false }));
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
        const approx = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
        const ls = ta.value.split("\\n");
        let pick = Math.max(0, Math.min(ls.length - 1, approx));
        for (let k = 0; k < 80; k++) {
          const cand = pick + (k % 2 === 0 ? k / 2 : -Math.ceil(k / 2));
          if (cand < 0 || cand >= ls.length) continue;
          const t = (ls[cand] || "").trim();
          if (t && !"#|>-:".includes(t.charAt(0))) { pick = cand; break; }
        }
        let pos = 0;
        for (let i = 0; i < pick; i++) pos += ls[i].length + 1;
        pos += Math.min(ls[pick].length, 8);
        ta.setSelectionRange(pos, pos);
        return { pick, pos, top: ta.scrollTop };
      `);
      await sleep(800);
      await ev(`__rkStart(800); return true;`);
      await sleep(60);
      await realKey("a");
      await sleep(900);
      const s1 = JSON.parse(await ev(`return __rkDump();`));
      const s1pos = analyzeSeries(s1.samples.map((s) => (s.src ? s.src.pos : null)), "src.pos");
      const s1top = analyzeSeries(s1.samples.map((s) => (s.src ? s.src.top : null)), "src.top");
      const s1w = s1.log.filter((x) => x.who === "textarea");
      log(`  输入 1 键：内容坐标 振幅=${s1pos.span} 反转=${s1pos.reversals} 尾=${s1pos.tailSpan}`);
      log(`            内容序列：${JSON.stringify(s1pos.preview)}`);
      log(`            scrollTop 写入 ${s1w.length} 次：${JSON.stringify(s1w.map((w) => ({ from: w.from, to: w.to, d: w.d })).slice(0, 10))}`);
      check("K9-SRC 输入：内容坐标不得反向", s1pos.reversals === 0, `反转=${s1pos.reversals} ${JSON.stringify(s1pos.flips)}`);
      check("K10-SRC 输入：scrollTop 写入 ≤ 3 次", s1w.length <= 3, `写入=${s1w.length}`);

      await sleep(400);
      await ev(`__rkStart(900); return true;`);
      await sleep(60);
      await ctrlZ();
      await sleep(1000);
      const s2 = JSON.parse(await ev(`return __rkDump();`));
      const s2pos = analyzeSeries(s2.samples.map((s) => (s.src ? s.src.pos : null)), "src.pos");
      const s2w = s2.log.filter((x) => x.who === "textarea");
      log("");
      log(`  Ctrl+Z：内容坐标 振幅=${s2pos.span} 反转=${s2pos.reversals}`);
      log(`          内容序列：${JSON.stringify(s2pos.preview)}`);
      log(`          scrollTop 写入 ${s2w.length} 次`);
      for (const w of s2w.slice(0, 12)) {
        log(`    t=${w.t} ${w.from} → ${w.to} (Δ${w.d})  ${w.frames.slice(0, 2).join(" // ")}`);
      }
      check("K11-SRC 撤销：内容坐标不得反向", s2pos.reversals === 0, `反转=${s2pos.reversals} ${JSON.stringify(s2pos.flips)}`);
      check("K12-SRC 撤销：scrollTop 写入 ≤ 3 次", s2w.length <= 3, `写入=${s2w.length}`);
      runs.src = { s1pos, s1top, s1w: s1w.length, s2pos, s2w: s2w.length };
    }

    const pass = checks.filter((c) => c.ok).length;
    log("");
    log(`结论：${pass} PASS / ${checks.length - pass} FAIL`);
    log(`报告已写入：${OUT_TXT}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ checks, runs }, null, 2), "utf-8");
    cdp.close();
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  } catch (e) {
    log(`[probe] 失败：${String(e && e.message ? e.message : e)}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw e;
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
