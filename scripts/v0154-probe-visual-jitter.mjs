/**
 * LightMD v0.15.4 —— **视觉抖动探针**：打字 / Ctrl+Z 时文档画面是否"跳一下再回来"。
 *
 * ## 为什么不能只量 scrollTop
 * 前两代探针（`v0153-probe-undo-big.mjs` / `v0154-probe-type-jitter.mjs`）量的是
 * `scrollTop` 的写入序列，结论都是"没有方向反转"。但用户的描述是**画面刷新/抖动**，
 * 那可能来自：
 * - `scrollTop` 没变但**内容重排**（行高变化、软换行增减）→ 屏幕上正文整体位移；
 * - 一帧内先写 A 再写 B（16ms 采样可能正好跨过两次写入，只见稳态）；
 * - DOM 重建导致元素重新挂载（视觉上闪一下）。
 *
 * 因此本探针直接量**屏幕坐标**：每 16ms 记录「视口中央某一段落」的
 * `getBoundingClientRect().top`，以及该段落是否仍是同一个 DOM 节点
 * （`isSameNode` 检测重建）。判据是这条**屏幕 Y 序列**是否出现「偏离 → 回返」。
 *
 * ## 判据
 * - J1 屏幕 Y 序列的方向反转 ≤ 0（严格：一次反转就是一次"跳过去再跳回来"）
 * - J2 屏幕 Y 窗口内总位移 ≤ 3px（正常输入/撤销只应让内容**单向**位移，
 *        幅度由行数变化决定；≥ 一整行且回返 = 抖动）
 * - J3 中央标记的 DOM 节点身份保持不变（换了 = 整篇/整块重建）
 * - J4 尾部 200ms 稳定 ≤ 2px
 *
 * 用法：node scripts/v0154-probe-visual-jitter.mjs
 * 环境变量：V0154V_PORT（默认 9303）、V0154V_EXE、V0154V_ONLY=read|source|split
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0154V_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0154V_PORT || 9303);
const ONLY = process.env.V0154V_ONLY || "";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0154-probe-visual-jitter.txt");
const OUT_JSON = path.join(OUT_DIR, "v0154-probe-visual-jitter.json");
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
  const p = ["# 视觉抖动取证", ""];
  for (let i = 1; i <= 40; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(`第 ${i}.${j} 段：这一段刻意写长，让两个面都产生可滚动内容，并使任何一次重排都能在屏幕坐标上显形。`);
      p.push("");
    }
  }
  return p.join("\n");
}

const PAGE_TOOLS = String.raw`
/**
 * 屏幕坐标采样器：每 16ms 记录「视口中央标记」的 rect.top 与节点身份。
 * PM 面：取 .editor-container 里视口中央的顶层块；源码面：取 textarea 中央行的行号
 * （textarea 无法按块测 rect，故用 scrollTop + 行高换算成"中央行顶屏幕 Y"）。
 */
window.__vjStart = function (ms, kind) {
  window.__vjSamples = [];
  window.__vjT0 = performance.now();
  window.__vjKind = kind;
  window.__vjNode = null;
  window.__vjNodeTag = "";

  const pickPmMarker = () => {
    const sc = document.querySelector(".editor-container");
    if (!sc || sc.clientHeight <= 0) return null;
    const pm = sc.querySelector(".ProseMirror");
    if (!pm) return null;
    const scRect = sc.getBoundingClientRect();
    const centerY = scRect.top + sc.clientHeight / 2;
    let best = null;
    let bestD = Infinity;
    for (const child of pm.children) {
      const r = child.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - centerY);
      if (d < bestD) { bestD = d; best = child; }
    }
    return best;
  };

  const tick = () => {
    if (window.__vjKind === "pm") {
      const marker = window.__vjNode || pickPmMarker();
      if (!window.__vjNode && marker) {
        window.__vjNode = marker;
        window.__vjNodeTag = (marker.textContent || "").replace(/\s+/g, "").slice(0, 24);
      }
      if (marker) {
        const r = marker.getBoundingClientRect();
        const still = marker.isConnected ? (window.__vjNode ? window.__vjNode.isSameNode(marker) : true) : false;
        window.__vjSamples.push({
          t: +(performance.now() - window.__vjT0).toFixed(1),
          y: +r.top.toFixed(2),
          h: +r.height.toFixed(2),
          same: still,
        });
      }
    } else {
      const ta = document.querySelector("textarea.source-editor");
      if (ta && ta.clientHeight > 0) {
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
        const scrollY = (ta.scrollTop + ta.clientHeight / 2) / lh;
        window.__vjSamples.push({
          t: +(performance.now() - window.__vjT0).toFixed(1),
          // "中央行号"（浮点）→ 屏幕中心对应的内容坐标；变化即内容在动
          line: +scrollY.toFixed(3),
          top: +ta.scrollTop.toFixed(2),
          sh: ta.scrollHeight,
          lh: +lh.toFixed(2),
        });
      }
    }
    if (performance.now() - window.__vjT0 < ms) setTimeout(tick, 16);
  };
  tick();
  return true;
};

window.__vjDump = function () {
  return JSON.stringify({ samples: window.__vjSamples || [], tag: window.__vjNodeTag || "", kind: window.__vjKind || "" });
};
window.__vjKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

/** 分析屏幕 Y 序列：方向反转 / 总位移 / 尾部稳定性 */
function analyzePm(samples) {
  if (!samples || samples.length < 5) return { ok: false, n: samples ? samples.length : 0 };
  const ys = samples.map((s) => s.y);
  let rev = 0;
  let lastDir = 0;
  const moves = [];
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i] - ys[i - 1];
    if (Math.abs(d) < 0.5) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) {
      rev++;
      moves.push({ i, d: +d.toFixed(2) });
    }
    lastDir = dir;
  }
  const span = Math.max(...ys) - Math.min(...ys);
  const tail = ys.slice(-13);
  const tailSpan = Math.max(...tail) - Math.min(...tail);
  const sameAll = samples.every((s) => s.same !== false);
  return {
    ok: true,
    n: samples.length,
    span: +span.toFixed(2),
    reversals: rev,
    reversalDetail: moves.slice(0, 8),
    tailSpan: +tailSpan.toFixed(2),
    sameNode: sameAll,
    preview: ys.slice(0, 26).map((v) => +v.toFixed(1)),
  };
}

/** 分析 textarea：中央行号序列（内容坐标，用于判断"内容是否在动"）+ scrollTop 序列 */
function analyzeSource(samples) {
  if (!samples || samples.length < 5) return { ok: false, n: samples ? samples.length : 0 };
  const tops = samples.map((s) => s.top);
  let rev = 0;
  let lastDir = 0;
  for (let i = 1; i < tops.length; i++) {
    const d = tops[i] - tops[i - 1];
    if (Math.abs(d) < 0.5) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) rev++;
    lastDir = dir;
  }
  const span = Math.max(...tops) - Math.min(...tops);
  const tail = tops.slice(-13);
  const tailSpan = Math.max(...tail) - Math.min(...tail);
  const shs = samples.map((s) => s.sh);
  const shChanges = shs.filter((v, i) => i > 0 && v !== shs[i - 1]).length;
  return {
    ok: true,
    n: samples.length,
    span: +span.toFixed(2),
    reversals: rev,
    tailSpan: +tailSpan.toFixed(2),
    scrollHeightChanges: shChanges,
    preview: tops.slice(0, 26).map((v) => +v.toFixed(1)),
  };
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-visualjitter-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "visual-jitter.md");
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
      __vjKey("Control", "ControlLeft", false);
      await new Promise((r) => setTimeout(r, 60));
      __vjKey("Control", "ControlLeft", false);
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

  /** 采样窗口 + 触发动作 + 分析 */
  const runCase = async (kind, actionBody, ms = 700) => {
    await ev(`__vjStart(${ms}, "${kind === "source" ? "source" : "pm"}"); return true;`);
    await sleep(60);
    await ev(actionBody);
    await sleep(ms + 120);
    const dump = JSON.parse(await ev(`return __vjDump();`));
    return kind === "source" ? analyzeSource(dump.samples) : analyzePm(dump.samples);
  };

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
    if (!loaded) throw new Error("文档未装入（判定会失真，中止）");
    log("[probe] 文档已装入");
    await sleep(900);

    // ── 阅读模式：输入 / 撤销 ──
    if (!ONLY || ONLY === "read") {
      let mode = await modeNow();
      if (mode !== "preview") {
        await doubleCtrl();
        await sleep(1400);
      }
      log("");
      log("════════ 阅读模式（PM）══════");
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
      await sleep(500);

      const pmIn = await runCase("pm", `return true;`, 1);
      void pmIn;
      await ev(`__vjStart(700, "pm"); return true;`);
      await sleep(60);
      await cdp.send("Input.insertText", { text: "字" });
      await sleep(820);
      const inDump = JSON.parse(await ev(`return __vjDump();`));
      const inPm = analyzePm(inDump.samples);
      log(`  输入 1 字：中央块=${inDump.tag} 屏幕Y 振幅=${inPm.span}px 反转=${inPm.reversals} 尾=${inPm.tailSpan}px 同节点=${inPm.sameNode}`);
      log(`    Y 序列：${JSON.stringify(inPm.preview)}`);
      check(
        "J1-PM 输入：屏幕中央块 Y 不得反向（一次反转 = 跳走再回来）",
        inPm.reversals === 0,
        `反转=${inPm.reversals} ${JSON.stringify(inPm.reversalDetail)}`,
      );
      check("J2-PM 输入：屏幕 Y 总位移 ≤ 3px", inPm.span <= 3, `振幅=${inPm.span}px`);
      check("J3-PM 输入：中央块 DOM 节点身份不变", inPm.sameNode, `sameNode=${inPm.sameNode}`);

      await sleep(400);
      await ev(`__vjStart(700, "pm"); return true;`);
      await sleep(60);
      await ev(`__vjKey("z", "KeyZ", true); return true;`);
      await sleep(820);
      const unDump = JSON.parse(await ev(`return __vjDump();`));
      const unPm = analyzePm(unDump.samples);
      log(`  撤销 1 字：中央块=${unDump.tag} 屏幕Y 振幅=${unPm.span}px 反转=${unPm.reversals} 尾=${unPm.tailSpan}px 同节点=${unPm.sameNode}`);
      log(`    Y 序列：${JSON.stringify(unPm.preview)}`);
      check(
        "J1-PM 撤销：屏幕中央块 Y 不得反向",
        unPm.reversals === 0,
        `反转=${unPm.reversals} ${JSON.stringify(unPm.reversalDetail)}`,
      );
      check("J2-PM 撤销：屏幕 Y 总位移 ≤ 3px", unPm.span <= 3, `振幅=${unPm.span}px`);
      check("J3-PM 撤销：中央块 DOM 节点身份不变", unPm.sameNode, `sameNode=${unPm.sameNode}`);
      runs.pmRead = { inPm, unPm };
    }

    // ── 源码模式：输入 / 撤销 ──
    if (!ONLY || ONLY === "source") {
      let mode = await modeNow();
      if (mode !== "edit") {
        await doubleCtrl();
        await sleep(1400);
      }
      log("");
      log("════════ 源码模式 ══════");
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

      await ev(`__vjStart(700, "source"); return true;`);
      await sleep(60);
      await cdp.send("Input.insertText", { text: "字" });
      await sleep(820);
      const sIn = analyzeSource(JSON.parse(await ev(`return __vjDump();`)).samples);
      log(`  输入 1 字：scrollTop 振幅=${sIn.span}px 反转=${sIn.reversals} 尾=${sIn.tailSpan}px sh变化=${sIn.scrollHeightChanges}`);
      log(`    top 序列：${JSON.stringify(sIn.preview)}`);
      check("J1-SRC 输入：scrollTop 不得反向", sIn.reversals === 0, `反转=${sIn.reversals}`);
      check("J2-SRC 输入：scrollTop 总位移 ≤ 3px", sIn.span <= 3, `振幅=${sIn.span}px`);

      await sleep(400);
      await ev(`__vjStart(700, "source"); return true;`);
      await sleep(60);
      await ev(`__vjKey("z", "KeyZ", true); return true;`);
      await sleep(820);
      const sUn = analyzeSource(JSON.parse(await ev(`return __vjDump();`)).samples);
      log(`  撤销 1 字：scrollTop 振幅=${sUn.span}px 反转=${sUn.reversals} 尾=${sUn.tailSpan}px sh变化=${sUn.scrollHeightChanges}`);
      log(`    top 序列：${JSON.stringify(sUn.preview)}`);
      check("J1-SRC 撤销：scrollTop 不得反向", sUn.reversals === 0, `反转=${sUn.reversals}`);
      check("J2-SRC 撤销：scrollTop 总位移 ≤ 3px", sUn.span <= 3, `振幅=${sUn.span}px`);
      runs.source = { sIn, sUn };
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
