/**
 * LightMD v0.15.4 —— **诊断探针**：「每次文字输入 / Ctrl+Z 文档都刷新抖动一下」到底是谁做的。
 *
 * 用户原话（0.15.4 需求第 10 项）：
 * 「0.15 的前两个子版本进行跨模式撤销栈统一，现在每次进行文字输入和使用 ctrl+z 进行撤销时，
 *   文档还是会自动刷新抖动一下，影响编辑体验。」
 *
 * ## 为什么 v0.15.3 的 `v0153-probe-undo-big.mjs` 全 PASS 却仍有这个问题
 * 那个探针只测**大块**撤销（scrollHeight 明显变化），主张是"贴底 → 拉回"。
 * 用户说的是**每次输入**与**每次 Ctrl+Z** 都抖一下 —— 提示另一条链路：
 * 受控 `content` prop 在每次按键都会 Round-trip 一次
 * （`onContentChange → App.setContent → content prop`），从而可能
 * ①整篇 PM doc 重建、②textarea value 重设、③几处 `[content]` effect 重跑（几何缓存/字数/mask）。
 *
 * ## 本探针测量的是「重渲染/重设」而不是"位置漂移"
 * 1. hook `Element.prototype.scrollTop` setter → 记录每次写入的值/Δ/调用栈；
 * 2. hook `HTMLTextAreaElement.prototype.value` setter → 记录 textarea 受控重写次数；
 * 3. MutationObserver 挂在 `.ProseMirror` 与 `textarea` 与 `.editor-container` 上
 *    （childList+subtree+attributes）→ 记录 DOM 变更规模（大改 = 整篇重建指纹）；
 * 4. 场景：
 *    - T1 阅读（PM）模式：输入 1 个字符 → 采样 600ms
 *    - T2 阅读（PM）模式：Ctrl+Z（撤掉刚输入的那个字符）→ 采样 600ms
 *    - T3 源码模式：输入 1 个字符
 *    - T4 源码模式：Ctrl+Z
 * 5. 判定（每条都要打印实测值，避免"看起来通过"）：
 *    - A1 单次输入/撤销期间 `.ProseMirror` childList 变更条数 ≤ 2（整篇重建 = 数十条）
 *    - A2 单次输入/撤销期间 textarea value setter 调用 ≤ 1（受控 round-trip 应 ≤1）
 *    - A3 单次输入/撤销期间 scrollTop 写入 ≤ 6 且方向反转 ≤ 2
 *    - A4 采样窗口尾 200ms 内 scrollTop 波动 ≤ 2px（收敛）
 *
 * 用法：node scripts/v0154-probe-type-jitter.mjs
 * 环境变量：V0154T_PORT（默认 9302）、V0154T_EXE、V0154T_ONLY=pm|src
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0154T_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0154T_PORT || 9302);
const ONLY = process.env.V0154T_ONLY || "";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0154-probe-type-jitter.txt");
const OUT_JSON = path.join(OUT_DIR, "v0154-probe-type-jitter.json");
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
  const p = ["# 打字抖动取证", ""];
  for (let i = 1; i <= 40; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(
        `第 ${i}.${j} 段：这是一段刻意写长的正文，用于让两个面都产生可滚动内容，` +
          `同时让任何一次"整篇重建"都能在 DOM 变更计数里显形。`,
      );
      p.push("");
    }
  }
  return p.join("\n");
}

const PAGE_TOOLS = String.raw`
/** 安装 scrollTop / textarea value / DOM 变更 三路探针 */
window.__tjHook = function () {
  if (window.__tjInstalled) return "already";
  window.__tjInstalled = true;
  window.__tjLog = [];
  window.__tjDom = [];
  window.__tjObservers = [];
  const push = (rec) => { try { window.__tjLog.push(rec); } catch (e) {} };

  // ① scrollTop setter
  const sd = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (sd && sd.get && sd.set) {
    const g = sd.get, s = sd.set;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: g,
      set(v) {
        try {
          const el = this;
          const isTa = el && el.tagName === "TEXTAREA" && el.classList && el.classList.contains("source-editor");
          const isReader = el && el.classList && el.classList.contains("editor-container");
          if (isTa || isReader) {
            const old = g.call(el);
            push({
              kind: "scroll",
              t: +performance.now().toFixed(1),
              who: isTa ? "textarea" : "reader",
              from: +(+old).toFixed(2),
              to: +(+v).toFixed(2),
              d: +(+v - +old).toFixed(2),
              frames: (new Error().stack || "").split("\n").slice(1, 6).map((x) => x.trim().slice(0, 110)),
            });
          }
        } catch (e) {}
        return s.call(this, v);
      },
    });
  }

  // ② textarea value setter（受控组件每次重设 value 都会走这里）
  const vd = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (vd && vd.set) {
    const setter = vd.set;
    Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
      configurable: true,
      get: vd.get,
      set(v) {
        try {
          const el = this;
          if (el.classList && el.classList.contains("source-editor")) {
            push({
              kind: "value",
              t: +performance.now().toFixed(1),
              len: String(v == null ? "" : v).length,
              frames: (new Error().stack || "").split("\n").slice(1, 6).map((x) => x.trim().slice(0, 110)),
            });
          }
        } catch (e) {}
        return setter.call(this, v);
      },
    });
  }

  // ③ DOM 变更观测：PM 内容树 / textarea / 阅读面容器
  window.__tjWatch = function () {
    window.__tjDom = [];
    const targets = [
      [document.querySelector(".editor-container .ProseMirror"), "pm"],
      [document.querySelector("textarea.source-editor"), "textarea"],
      [document.querySelector(".editor-container"), "reader"],
    ];
    for (const obs of window.__tjObservers) { try { obs.disconnect(); } catch (e) {} }
    window.__tjObservers = [];
    for (const [el, name] of targets) {
      if (!el) continue;
      const ob = new MutationObserver((records) => {
        for (const r of records) {
          window.__tjDom.push({
            t: +performance.now().toFixed(1),
            who: name,
            type: r.type,
            added: r.addedNodes ? r.addedNodes.length : 0,
            removed: r.removedNodes ? r.removedNodes.length : 0,
            attr: r.attributeName || null,
          });
        }
      });
      ob.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
      window.__tjObservers.push(ob);
    }
    window.__tjObservers.push(new MutationObserver(() => {}));
    return targets.filter((x) => !!x[0]).map((x) => x[1]);
  };

  window.__tjClear = function () { window.__tjLog = []; window.__tjDom = []; return true; };
  window.__tjDump = function () {
    return JSON.stringify({ log: window.__tjLog, dom: window.__tjDom.slice(0, 400) });
  };
  window.__tjKey = function (key, code, ctrl) {
    const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
    window.dispatchEvent(new KeyboardEvent("keydown", init));
    window.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  };
  return "installed";
};
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-typejitter-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "type-jitter.md");
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
      __tjKey("Control", "ControlLeft", false);
      await new Promise((r) => setTimeout(r, 60));
      __tjKey("Control", "ControlLeft", false);
      return true;
    `);
  };

  const modeNow = () =>
    ev(`
      const sc = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
    `);

  const analyzeDom = (dom, who) => {
    const recs = dom.filter((d) => d.who === who);
    const childList = recs.filter((r) => r.type === "childList");
    const added = childList.reduce((a, b) => a + b.added, 0);
    const removed = childList.reduce((a, b) => a + b.removed, 0);
    const attr = recs.filter((r) => r.type === "attributes").length;
    const chars = recs.filter((r) => r.type === "characterData").length;
    return { total: recs.length, childList: childList.length, added, removed, attr, chars };
  };

  const analyzeWrites = (log2, who) => {
    const w = log2.filter((x) => x.kind === "scroll" && x.who === who);
    const tops = w.map((x) => x.to);
    let rev = 0;
    let lastDir = 0;
    for (let i = 1; i < tops.length; i++) {
      const d = tops[i] - tops[i - 1];
      if (Math.abs(d) < 2) continue;
      const dir = Math.sign(d);
      if (lastDir !== 0 && dir !== lastDir) rev++;
      lastDir = dir;
    }
    const span = tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
    return { count: w.length, span: +span.toFixed(2), reversals: rev, writes: w.map((x) => ({ from: x.from, to: x.to, d: x.d })) };
  };

  /** 触发一个动作并采样 600ms（保留给扩展场景；当前 T1~T4 直接各自计时） */
  const measure = async (actionBody, ms = 600) => {
    await ev(`__tjHook(); __tjWatch(); window.__tjClear(); return true;`);
    await ev(actionBody);
    await sleep(ms);
    return JSON.parse(await ev(`return __tjDump();`));
  };
  void measure;

  try {
    const hook = await ev(`return __tjHook();`);
    log(`[probe] 探针安装：${hook}`);

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
    if (!loaded) throw new Error("文档未装入（判定会失真，中止）");
    log("[probe] 文档已装入");
    await sleep(900);

    const runs = {};

    // ── T1/T2：阅读（PM）模式 ──
    if (!ONLY || ONLY === "pm") {
      let mode = await modeNow();
      if (mode !== "preview") {
        await doubleCtrl();
        await sleep(1300);
        mode = await modeNow();
      }
      log(`[probe] 当前模式：${mode}`);

      // 滚到中部，光标落在正文段落
      await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.45);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        const view = window.__lmdView || null;
        return sc.scrollTop;
      `);
      await sleep(700);

      // 用 CDP 真实点击落点（点击视口中央）后输入
      const rect = await ev(`
        const sc = document.querySelector(".editor-container");
        const r = sc.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await sleep(500);

      log("");
      log("════════ T1 阅读模式：输入 1 个字符 ═───────");
      await ev(`__tjHook(); __tjWatch(); window.__tjClear(); return true;`);
      await cdp.send("Input.insertText", { text: "字" });
      await sleep(600);
      const t1dump = JSON.parse(await ev(`return __tjDump();`));
      const t1pm = analyzeDom(t1dump.dom, "pm");
      const t1ta = analyzeDom(t1dump.dom, "textarea");
      const t1w = analyzeWrites(t1dump.log, "reader");
      const t1vals = t1dump.log.filter((x) => x.kind === "value").length;
      log(`  PM DOM 变更：${JSON.stringify(t1pm)}`);
      log(`  reader scrollTop 写入：${t1w.count}（span=${t1w.span}px 反转=${t1w.reversals}）`);
      log(`  textarea value 重设：${t1vals} 次`);
      const t1Pos = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
      `);
      log(`  输入后：top=${t1Pos.top} max=${t1Pos.max}`);

      check(
        "T1-A1 单次输入：PM 内容树 childList 变更 ≤ 2（整篇重建 = 数十条）",
        t1pm.childList <= 2,
        `childList=${t1pm.childList} added=${t1pm.added} removed=${t1pm.removed}`,
      );
      check(
        "T1-A2 单次输入：textarea value 重设 ≤ 1 次（受控 round-trip）",
        t1vals <= 1,
        `重设=${t1vals} 次`,
      );
      check(
        "T1-A3 单次输入：reader scrollTop 写入 ≤ 6 次且方向反转 ≤ 2",
        t1w.count <= 6 && t1w.reversals <= 2,
        `写入=${t1w.count} 反转=${t1w.reversals} 振幅=${t1w.span}px`,
      );

      log("");
      log("════════ T2 阅读模式：Ctrl+Z 撤销刚输入的字符 ═───────");
      await ev(`__tjWatch(); __tjClear(); return true;`);
      await ev(`__tjKey("z", "KeyZ", true); return true;`);
      await sleep(600);
      const t2dump = JSON.parse(await ev(`return __tjDump();`));
      const t2pm = analyzeDom(t2dump.dom, "pm");
      const t2w = analyzeWrites(t2dump.log, "reader");
      const t2vals = t2dump.log.filter((x) => x.kind === "value").length;
      log(`  PM DOM 变更：${JSON.stringify(t2pm)}`);
      log(`  reader scrollTop 写入：${t2w.count}（span=${t2w.span}px 反转=${t2w.reversals}）`);
      log(`    ${JSON.stringify(t2w.writes.slice(0, 20))}`);
      log(`  textarea value 重设：${t2vals} 次`);
      const t2Pos = await ev(`
        const sc = document.querySelector(".editor-container");
        return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
      `);
      log(`  撤销后：top=${t2Pos.top} max=${t2Pos.max}`);
      check(
        "T2-A1 单次撤销：PM 内容树 childList 变更 ≤ 2",
        t2pm.childList <= 2,
        `childList=${t2pm.childList} added=${t2pm.added} removed=${t2pm.removed}`,
      );
      check(
        "T2-A3 单次撤销：reader scrollTop 写入 ≤ 6 次且方向反转 ≤ 2",
        t2w.count <= 6 && t2w.reversals <= 2,
        `写入=${t2w.count} 反转=${t2w.reversals} 振幅=${t2w.span}px`,
      );
      runs.pmTyping = { t1pm, t1w, t1vals, t1Pos, t2pm, t2w, t2vals, t2Pos };
    }

    // ── T3/T4：源码模式 ──
    if (!ONLY || ONLY === "src") {
      let mode = await modeNow();
      if (mode !== "edit") {
        await doubleCtrl();
        await sleep(1400);
      }
      log("");
      log("════════ T3 源码模式：输入 1 个字符 ═───────");
      await ev(`
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return false;
        ta.focus();
        ta.scrollTop = Math.round((ta.scrollHeight - ta.clientHeight) * 0.45);
        ta.dispatchEvent(new Event("scroll", { bubbles: false }));
        return true;
      `);
      await sleep(700);
      // 把光标放在视口中央行
      await ev(`
        const ta = document.querySelector("textarea.source-editor");
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
        pos += Math.min(ls[pick].length, 6);
        ta.setSelectionRange(pos, pos);
        ta.scrollTop = Math.round((ta.scrollHeight - ta.clientHeight) * 0.45);
        return { pick, pos, top: ta.scrollTop };
      `);
      await sleep(600);

      await ev(`__tjHook(); __tjWatch(); __tjClear(); return true;`);
      await cdp.send("Input.insertText", { text: "字" });
      await sleep(600);
      const t3dump = JSON.parse(await ev(`return __tjDump();`));
      const t3ta = analyzeDom(t3dump.dom, "textarea");
      const t3w = analyzeWrites(t3dump.log, "textarea");
      const t3vals = t3dump.log.filter((x) => x.kind === "value").length;
      log(`  textarea DOM 变更：${JSON.stringify(t3ta)}`);
      log(`  textarea scrollTop 写入：${t3w.count}（span=${t3w.span}px 反转=${t3w.reversals}）`);
      log(`    ${JSON.stringify(t3w.writes.slice(0, 20))}`);
      log(`  textarea value 重设：${t3vals} 次`);
      const t3Pos = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        return { top: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, sel: ta.selectionStart };
      `);
      log(`  输入后：top=${t3Pos.top} max=${t3Pos.max} sel=${t3Pos.sel}`);
      check(
        "T3-A2 源码输入：textarea value 重设 ≤ 1 次",
        t3vals <= 1,
        `重设=${t3vals} 次`,
      );
      check(
        "T3-A3 源码输入：textarea scrollTop 写入 ≤ 6 次且方向反转 ≤ 2",
        t3w.count <= 6 && t3w.reversals <= 2,
        `写入=${t3w.count} 反转=${t3w.reversals} 振幅=${t3w.span}px`,
      );

      log("");
      log("════════ T4 源码模式：Ctrl+Z ═───────");
      await ev(`__tjWatch(); __tjClear(); return true;`);
      await ev(`__tjKey("z", "KeyZ", true); return true;`);
      await sleep(600);
      const t4dump = JSON.parse(await ev(`return __tjDump();`));
      const t4ta = analyzeDom(t4dump.dom, "textarea");
      const t4w = analyzeWrites(t4dump.log, "textarea");
      const t4vals = t4dump.log.filter((x) => x.kind === "value").length;
      log(`  textarea DOM 变更：${JSON.stringify(t4ta)}`);
      log(`  textarea scrollTop 写入：${t4w.count}（span=${t4w.span}px 反转=${t4w.reversals}）`);
      log(`    ${JSON.stringify(t4w.writes.slice(0, 20))}`);
      log(`  textarea value 重设：${t4vals} 次`);
      const t4Pos = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        return { top: ta.scrollTop, max: ta.scrollHeight - ta.clientHeight, sel: ta.selectionStart };
      `);
      log(`  撤销后：top=${t4Pos.top} max=${t4Pos.max} sel=${t4Pos.sel}`);
      check(
        "T4-A2 源码撤销：textarea value 重设 ≤ 2 次（撤销含一次受控回灌）",
        t4vals <= 2,
        `重设=${t4vals} 次`,
      );
      check(
        "T4-A3 源码撤销：textarea scrollTop 写入 ≤ 6 次且方向反转 ≤ 2",
        t4w.count <= 6 && t4w.reversals <= 2,
        `写入=${t4w.count} 反转=${t4w.reversals} 振幅=${t4w.span}px`,
      );
      runs.srcTyping = { t3ta, t3w, t3vals, t3Pos, t4ta, t4w, t4vals, t4Pos };
    }

    // ── T5/T6：编辑模式 + 右侧预览打开（双击 Shift 的场景）──
    if (!ONLY || ONLY === "split") {
      let mode = await modeNow();
      if (mode !== "edit") {
        await doubleCtrl();
        await sleep(1400);
      }
      // 双击 Shift 打开预览
      const hasPreview = await ev(`return !!document.querySelector("iframe.preview-iframe, .preview-panel iframe, iframe");`);
      if (!hasPreview) {
        await ev(`
          await new Promise((r) => setTimeout(r, 320));
          __tjKey("Shift", "ShiftLeft", false);
          await new Promise((r) => setTimeout(r, 60));
          __tjKey("Shift", "ShiftLeft", false);
          return true;
        `);
        await sleep(1600);
      }
      const splitState = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const ifr = document.querySelector("iframe");
        return {
          taVisible: !!ta && ta.clientHeight > 0,
          iframe: !!ifr,
          iframeW: ifr ? ifr.clientWidth : 0,
        };
      `);
      log("");
      log(`════════ T5 编辑+预览：输入 1 个字符 ═───────`);
      log(`  状态：${JSON.stringify(splitState)}`);
      if (!splitState.iframe) {
        log("  [skip] 预览面板未打开，跳过 T5/T6");
      } else {
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
          pos += Math.min(ls[pick].length, 6);
          ta.setSelectionRange(pos, pos);
          return { pick, pos, top: ta.scrollTop };
        `);
        await sleep(800);

        // 挂 iframe 的观察器（独立 document）
        await ev(`
          __tjHook(); __tjWatch(); window.__tjClear();
          window.__tjIframe = [];
          const ifr = document.querySelector("iframe");
          if (ifr && ifr.contentDocument && ifr.contentDocument.body) {
            const ob = new MutationObserver((recs) => {
              for (const r of recs) window.__tjIframe.push({
                t: +performance.now().toFixed(1),
                type: r.type,
                added: r.addedNodes ? r.addedNodes.length : 0,
                removed: r.removedNodes ? r.removedNodes.length : 0,
              });
            });
            ob.observe(ifr.contentDocument.body, { childList: true, subtree: true });
            window.__tjIframeObs = ob;
          }
          return true;
        `);
        await cdp.send("Input.insertText", { text: "字" });
        await sleep(900);
        const t5dump = JSON.parse(await ev(`return __tjDump();`));
        const t5ifr = JSON.parse(await ev(`return JSON.stringify(window.__tjIframe || []);`));
        const t5w = analyzeWrites(t5dump.log, "textarea");
        const t5IfrTop = await ev(`
          const ifr = document.querySelector("iframe");
          const d = ifr && ifr.contentDocument;
          const s = d ? (d.scrollingElement || d.documentElement || d.body) : null;
          return s ? { top: s.scrollTop, max: s.scrollHeight - s.clientHeight, sh: s.scrollHeight } : null;
        `);
        log(`  textarea scrollTop 写入：${t5w.count}（span=${t5w.span}px 反转=${t5w.reversals}）`);
        log(`    ${JSON.stringify(t5w.writes.slice(0, 12))}`);
        log(`  iframe body DOM 变更：${t5ifr.length} 条（childList 大改 = 预览整篇重写）`);
        log(`    added=${t5ifr.reduce((a, b) => a + b.added, 0)} removed=${t5ifr.reduce((a, b) => a + b.removed, 0)}`);
        log(`  iframe 滚动：${t5IfrTop ? JSON.stringify(t5IfrTop) : "null"}`);
        check(
          "T5-A3 编辑+预览输入：textarea scrollTop 写入 ≤ 6 且方向反转 ≤ 2",
          t5w.count <= 6 && t5w.reversals <= 2,
          `写入=${t5w.count} 反转=${t5w.reversals} 振幅=${t5w.span}px`,
        );

        log("");
        log(`════════ T6 编辑+预览：Ctrl+Z ═───────`);
        await ev(`
          __tjWatch(); window.__tjClear(); window.__tjIframe = [];
          return true;
        `);
        await ev(`__tjKey("z", "KeyZ", true); return true;`);
        await sleep(900);
        const t6dump = JSON.parse(await ev(`return __tjDump();`));
        const t6ifr = JSON.parse(await ev(`return JSON.stringify(window.__tjIframe || []);`));
        const t6w = analyzeWrites(t6dump.log, "textarea");
        const t6vals = t6dump.log.filter((x) => x.kind === "value").length;
        const t6IfrTop = await ev(`
          const ifr = document.querySelector("iframe");
          const d = ifr && ifr.contentDocument;
          const s = d ? (d.scrollingElement || d.documentElement || d.body) : null;
          return s ? { top: s.scrollTop, max: s.scrollHeight - s.clientHeight, sh: s.scrollHeight } : null;
        `);
        log(`  textarea scrollTop 写入：${t6w.count}（span=${t6w.span}px 反转=${t6w.reversals}）`);
        log(`    ${JSON.stringify(t6w.writes.slice(0, 12))}`);
        log(`  textarea value 重设：${t6vals} 次`);
        log(`  iframe body DOM 变更：${t6ifr.length} 条`);
        log(`    added=${t6ifr.reduce((a, b) => a + b.added, 0)} removed=${t6ifr.reduce((a, b) => a + b.removed, 0)}`);
        log(`  iframe 滚动：${t6IfrTop ? JSON.stringify(t6IfrTop) : "null"}`);
        check(
          "T6-A3 编辑+预览撤销：textarea scrollTop 写入 ≤ 6 且方向反转 ≤ 2",
          t6w.count <= 6 && t6w.reversals <= 2,
          `写入=${t6w.count} 反转=${t6w.reversals} 振幅=${t6w.span}px`,
        );
        runs.splitTyping = { t5w, t5ifr: t5ifr.length, t5IfrTop, t6w, t6vals, t6ifr: t6ifr.length, t6IfrTop };
      }
    }

    const pass = checks.filter((c) => c.ok).length;    log("");
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
