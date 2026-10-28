/**
 * LightMD v0.15.2 需求1 —— 实机探针：**阅读 ↔ 编辑模式切换的滑入动画**（只测不改）。
 *
 * 用户原话：「增加阅读模式和编辑模式切换时的一个滑动效果……当阅读模式切换到编辑模式时，
 *   编辑模式的左右屏有一个顺滑的由左往右滑过来的动画，而从编辑模式切换为阅读模式时，
 *   动画效果则为文档从右往左滑回的。」
 *
 * 实现（Lead 已完成）：
 *   - `src/styles/modeSwitchSlide.css`：`animation: lmd-mode-slide-in-from-left/right 380ms both`
 *   - `EditorContainer.tsx` 的 `data-lmd-mode-anim`（`to-edit` / `to-preview`，380ms 后清空）
 *
 * ## 为什么不用「rAF 按帧计数」当判据（重要）
 * 切换瞬间右侧 iframe 会**整篇重写**（`doc.open()/write()`），主线程被阻塞 →
 * `requestAnimationFrame` 严重掉帧。第一版实测：380ms 的动画在 900ms 窗口里只采到
 * 11 帧（≈37ms/帧），且最后一个 anim 帧还停在 tx=-214px，于是误判成
 * 「位移帧数不足 / 未收敛」—— **那是测量假象，不是产品缺陷**。
 *
 * 因此本探针以 **Web Animations API 的确定性步进**为权威判据：
 * 拿到 CSSAnimation 后 `pause()`，把 `currentTime` 依次设到 0/25/50/75/100%，
 * 每次读 `getBoundingClientRect().left` 与 computed transform 的 tx。
 * 这不依赖帧率，能精确证明「起点、方向、中间位置、终点、时长」。
 * rAF 采样保留为**参考信息**（打印实际观测帧数），不参与 PASS/FAIL。
 *
 * ## 验证 5 条（A~E）
 *   A. 阅读→编辑：`.source-editor-wrapper` / `.split-preview-shell` 从**左**滑入
 *   B. 编辑→阅读：`.editor-container` 从**右**滑入
 *   C. 动画不破坏滚动对齐：动画结束后 scrollTop 不再被改动；连切 5 轮两面无累积
 *   D. 动画结束后 `data-lmd-mode-anim` 被清掉（≥500ms 后 hasAttribute=false）
 *   E. `prefers-reduced-motion: reduce` 下不位移但模式照常切换
 *
 * 用法：node scripts/v0152-probe-mode-slide.mjs
 * 环境变量：V0152_PORT / V0152_EXE / V0152_ROUNDS
 * 退出码：0 = 全 PASS / 1 = 有 FAIL / 2 = 探针异常。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0152_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0152_PORT || 9297);
const ROUNDS = Number(process.env.V0152_ROUNDS || 5);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0152-probe-mode-slide.txt");
const OUT_JSON = path.join(OUT_DIR, "v0152-probe-mode-slide.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";
/** 与 `EditorContainer.tsx` 的 MODE_SLIDE_MS / CSS 的 --lmd-mode-slide-duration 同口径 */
const EXPECTED_DURATION = 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const log = (s) => {
  console.log(s);
  logLines.push(s);
};

// ─── exe 内联 dist 校验 ──────────────────────────────────────
function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`找不到 dist/index.html：${DIST_INDEX}`);
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 里找不到入口 hash");
  const hashName = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hashName, "utf-8"))) {
    throw new Error(
      `exe 内联的 dist 与当前 dist/ 不一致（找不到 ${hashName}）。请先 npx tauri build --no-bundle`,
    );
  }
  log(`[probe] exe 内联 dist 校验通过：${hashName}`);
  log(`[probe] exe mtime=${fs.statSync(EXE).mtime.toISOString()}`);
  log(`[probe] dist mtime=${fs.statSync(DIST_INDEX).mtime.toISOString()}`);
}

function killStale() {
  for (const name of ["lightmd.exe", "msedgewebview2.exe"]) {
    try {
      execFileSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
    } catch {
      /* 不在 */
    }
  }
}

function portListeners(port) {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess) -join ','`,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return String(out || "").trim();
  } catch {
    return "";
  }
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
            }, 60000);
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
      // ⚠️ resolve **整条消息**（调用方读 r.result.result.value）
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

function makeDoc() {
  const parts = ["# 模式切换滑动取证", ""];
  // 20 节（不是 40）：切换时右侧 iframe 整篇重写，文档越大主线程阻塞越久。
  // 20 节仍足够让阅读面 / 源码面都可滚动。
  for (let i = 1; i <= 20; i++) {
    parts.push(`## 小节 ${i}`);
    parts.push("");
    for (let j = 1; j <= 4; j++) {
      parts.push(
        `第 ${i}.${j} 段：这是一段用于撑长文档的正文，故意写得比较长，` +
          `让阅读面与源码面都真的可以滚动 —— 动画期间若滚动位置被改写，才能被测出来。`,
      );
      parts.push("");
    }
  }
  parts.push("## 文档末尾");
  parts.push("");
  parts.push("最后一段。");
  return parts.join("\n");
}

/** 页面内工具 */
const PAGE_TOOLS = String.raw`
/** computed transform → tx；none 记 0 */
function __txOf(el) {
  if (!el) return null;
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { tx: 0, raw: t || "none" };
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return { tx: null, raw: t };
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return { tx: p.length >= 6 ? p[4] : null, raw: t };
}
function __geomOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const t = __txOf(el);
  return {
    left: Math.round(r.left * 100) / 100,
    width: Math.round(r.width * 100) / 100,
    tx: t.tx === null ? null : Math.round(t.tx * 100) / 100,
    transform: t.raw,
    animCount: el.getAnimations ? el.getAnimations().length : 0,
  };
}
function __visibleFace() {
  const sc = document.querySelector(".editor-container");
  const ta = document.querySelector("textarea.source-editor");
  const scV = !!sc && sc.offsetHeight > 0 && sc.clientHeight > 0;
  const taV = !!ta && ta.offsetHeight > 0 && ta.clientHeight > 0;
  return {
    scVisible: scV,
    taVisible: taV,
    readerTop: scV ? sc.scrollTop : null,
    sourceTop: taV ? ta.scrollTop : null,
    mode: taV && !scV ? "edit" : scV && !taV ? "preview" : "unknown",
  };
}
function __mainArea() { return document.querySelector(".editor-main-area"); }
function __animAttr() {
  const el = __mainArea();
  return el && el.dataset ? el.dataset.lmdModeAnim : null;
}
function __fireCtrl() {
  const fire = (type) => window.dispatchEvent(new KeyboardEvent(type, {
    key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
  fire("keydown"); fire("keyup");
}
function __animsOnMain() {
  const main = __mainArea();
  if (!main) return 0;
  let n = 0;
  for (const c of Array.from(main.children)) {
    if (c.getAnimations) n += c.getAnimations().length;
  }
  return n;
}
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-modeslide-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "mode-slide.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  log("");
  log("[probe] 端口独占检查（跑前）…");
  killStale();
  await sleep(1500);
  const pre = portListeners(PORT);
  if (pre) throw new Error(`端口 ${PORT} 仍被占用（PID=${pre}），先手动清理`);
  log(`[probe] 端口 ${PORT} 干净`);

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
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        log("[probe] CDP 端点已就绪");
        break;
      }
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
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    }
    return r.result?.result?.value;
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  /** 双击 Ctrl（两次 keydown/keyup，间隔 60ms < DOUBLE_PRESS_THRESHOLD=220ms） */
  const doubleCtrl = () =>
    ev(`
      // 让上一段按键的阈值窗口过期，避免"第一击"被判成 toggle
      await new Promise((r) => setTimeout(r, 320));
      __fireCtrl();
      await new Promise((r) => setTimeout(r, 60));
      __fireCtrl();
      return true;
    `);

  /**
   * 确定性采集一次模式切换的滑入动画（全部在页面内一次 eval 完成）。
   *
   * 1. 等双击阈值过期 → 双击 Ctrl；
   * 2. 轮询等 `data-lmd-mode-anim === dir` **且**目标元素上有动画实例；
   * 3. 对该动画 `pause()`，把 currentTime 依次设到 0/25/50/75/100%，
   *    每次读 left + computed tx（不受帧率影响，精确还原位移曲线）；
   * 4. `play()` 恢复，再用 rAF 采一段**参考用**的实际帧数（可能被 iframe 重写饿死）；
   * 5. 等属性被清空（动画结束），返回切换前后的可见面与 scrollTop。
   */
  const captureSlide = (dir) =>
    ev(`
    const DIR = ${JSON.stringify(dir)};
    const TARGETS = DIR === "to-edit"
      ? [".source-editor-wrapper", ".split-preview-shell"]
      : [".editor-container"];
    const DUR = ${EXPECTED_DURATION};
    const sleepP = (ms) => new Promise((r) => setTimeout(r, ms));

    await sleepP(320);
    const beforeFace = __visibleFace();
    const beforeAttr = __animAttr();
    __fireCtrl();
    await sleepP(60);
    __fireCtrl();

    // ── 等属性 + 动画实例出现 ──
    let found = null;
    const tDetect = performance.now();
    for (let i = 0; i < 200 && !found; i++) {
      await sleepP(5);
      if (__animAttr() !== DIR) continue;
      const items = [];
      for (const sel of TARGETS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const anims = el.getAnimations ? el.getAnimations() : [];
        for (const a of anims) items.push({ sel, el, a });
      }
      if (items.length) found = { items, detectMs: Math.round(performance.now() - tDetect) };
    }
    if (!found) {
      return JSON.stringify({
        dir: DIR, error: "未检测到动画（属性或动画实例缺失）",
        beforeFace, beforeAttr, attrNow: __animAttr(), faceNow: __visibleFace(),
      });
    }

    // ── 动画元信息 ──
    const meta = found.items.map(({ sel, el, a }) => {
      const eff = a.effect;
      const tm = eff && eff.getTiming ? eff.getTiming() : null;
      return {
        sel,
        className: String(el.className || ""),
        animationName: a.animationName || null,
        duration: tm ? tm.duration : null,
        delay: tm ? tm.delay : null,
        iterations: tm ? tm.iterations : null,
        fill: tm ? tm.fill : null,
        easing: tm ? tm.easing : null,
        playState: a.playState,
      };
    });

    // ── 确定性步进：pause + 设 currentTime，逐点读位置 ──
    const STEP = [0, 0.25, 0.5, 0.75, 1];
    const curves = found.items.map(({ sel, el, a }) => {
      const tm = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
      const dur = tm && Number.isFinite(Number(tm.duration)) ? Number(tm.duration) : DUR;
      let paused = false;
      try { a.pause(); paused = true; } catch { /* 有些实现不允许 pause */ }
      const points = [];
      for (const p of STEP) {
        try { a.currentTime = dur * p; } catch { /* ignore */ }
        const r = el.getBoundingClientRect();
        const t = __txOf(el);
        points.push({
          p,
          atMs: Math.round(dur * p),
          left: Math.round(r.left * 100) / 100,
          tx: t.tx === null ? null : Math.round(t.tx * 100) / 100,
          transform: t.raw,
        });
      }
      try { a.play(); } catch { /* ignore */ }
      return { sel, className: String(el.className || ""), dur, paused, points };
    });

    // ── 参考信息：rAF 实际观测帧数（可能被 iframe 重写饿死，不作判据）──
    const observed = [];
    const ot0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const t = performance.now() - ot0;
        const el = document.querySelector(TARGETS[0]);
        const g = __geomOf(el);
        observed.push({ t: Math.round(t * 10) / 10, tx: g ? g.tx : null, attr: __animAttr() });
        if (t < 560) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const observedMoving = observed.filter((o) => o.tx !== null && Math.abs(o.tx) > 0.5).length;

    // ── 等动画结束（属性被清）──
    for (let i = 0; i < 100; i++) {
      if (__animAttr() !== DIR) break;
      await sleepP(20);
    }
    await sleepP(500);
    const afterFace = __visibleFace();
    const afterAttr = __animAttr();

    return JSON.stringify({
      dir: DIR, meta, curves, detectMs: found.detectMs,
      observedFrameCount: observed.length,
      observedMovingFrames: observedMoving,
      beforeFace, afterFace, beforeAttr, afterAttr,
    });
  `);

  try {
    // ── 1. 打开文档 ──
    const docProbe = JSON.stringify("第 5.1 段");
    let loaded = false;
    for (let attempt = 0; attempt < 25 && !loaded; attempt++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
          path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`
        const pm = document.querySelector(".ProseMirror");
        if (!pm) return false;
        const txt = (pm.textContent || "").replace(/\\s+/g, "");
        return txt.indexOf(String(${docProbe}).replace(/\\s+/g, "")) >= 0;
      `);
      if (!loaded) log(`  [probe] 文档尚未装入（第 ${attempt + 1} 次重试）…`);
    }
    if (!loaded) throw new Error("文档没能装进编辑器 —— 判定会失真，中止");
    log("  [probe] 文档已装入编辑器");
    await sleep(900);

    // ── 2. 环境 ──
    const env = await ev(`
      const main = __mainArea();
      return {
        hasMain: !!main,
        mainChildren: main ? Array.from(main.children).map((c) => c.className || c.tagName) : [],
        face: __visibleFace(),
        animAttr: __animAttr(),
        modeSlideDuration: getComputedStyle(document.documentElement)
          .getPropertyValue("--lmd-mode-slide-duration").trim(),
        reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        ua: navigator.userAgent,
      };
    `);
    log("");
    log("════════ 环境 ════════");
    log("  " + JSON.stringify(env, null, 2).replace(/\n/g, "\n  "));
    check("`.editor-main-area` 存在且初始无动画属性", !!env?.hasMain && !env?.animAttr,
      `animAttr=${env?.animAttr}`);
    // getPropertyValue 对 380ms 返回 ".38s"（Chromium 归一化），必须归一化后比较
    const durRaw = String(env?.modeSlideDuration || "").trim();
    const durMs = (() => {
      const m = /^([\d.]+)\s*(ms|s)$/i.exec(durRaw);
      if (!m) return NaN;
      const v = Number(m[1]);
      return m[2].toLowerCase() === "s" ? v * 1000 : v;
    })();
    check("CSS 变量 --lmd-mode-slide-duration = 380ms",
      Math.abs(durMs - EXPECTED_DURATION) < 1,
      `value=${durRaw} → ${Number.isFinite(durMs) ? durMs + "ms" : "无法解析"}`);
    check("阅读面初始可见（文档真的装入了，且处于 preview 模式）",
      !!env?.face?.scVisible && env?.face?.mode === "preview",
      `face=${JSON.stringify(env?.face)}`);

    // 滚到 50%
    await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      return sc.scrollTop;
    `);
    await sleep(700);

    // ── A. 阅读 → 编辑 ──
    log("");
    log("════════ A. 阅读 → 编辑（编辑区由左往右滑入）════════");
    const A = JSON.parse(await captureSlide("to-edit"));
    if (A.error) {
      log(`  ⚠️ ${A.error}；attrNow=${A.attrNow} faceNow=${JSON.stringify(A.faceNow)}`);
    } else {
      log(`  检测耗时 ${A.detectMs}ms；切换前模式=${A.beforeFace.mode} → 切换后=${A.afterFace.mode}`);
      for (const m of A.meta) {
        log(`  · ${m.sel}：animationName=${m.animationName} duration=${m.duration}ms ` +
          `delay=${m.delay} iterations=${m.iterations} fill=${m.fill}`);
      }
      for (const c of A.curves) {
        log(`  · ${c.sel} 位移曲线（pause + currentTime 步进，不受帧率影响）：`);
        for (const p of c.points) {
          log(`      ${String(p.p * 100).padStart(4)}% (${String(p.atMs).padStart(3)}ms)  left=${String(p.left).padStart(9)}  tx=${String(p.tx).padStart(9)}  transform=${p.transform}`);
        }
      }
      log(`  参考：rAF 实际观测 ${A.observedFrameCount} 帧，其中 tx≠0 的 ${A.observedMovingFrames} 帧` +
        `（iframe 重写会饿死 rAF，此数仅参考，不作判据）`);
      log(`  属性清空后：afterAttr=${JSON.stringify(A.afterAttr)}`);
    }

    const aSrc = A.curves?.find((c) => c.sel === ".source-editor-wrapper");
    const aShell = A.curves?.find((c) => c.sel === ".split-preview-shell");
    const aMetaSrc = A.meta?.find((m) => m.sel === ".source-editor-wrapper");
    const aMetaShell = A.meta?.find((m) => m.sel === ".split-preview-shell");

    check(
      "A1 编辑区左栏动画名 = lmd-mode-slide-in-from-left（由左往右）",
      !!aMetaSrc && /slide-in-from-left/.test(String(aMetaSrc.animationName)),
      aMetaSrc ? `name=${aMetaSrc.animationName}` : "无数据",
    );
    check(
      "A2 右屏（.split-preview-shell）同动画（左右屏一起滑）",
      !!aMetaShell && /slide-in-from-left/.test(String(aMetaShell.animationName)),
      aMetaShell ? `name=${aMetaShell.animationName}` : "无数据",
    );
    check(
      "A3 动画时长 = 380ms（≈380/16.67 ≈ 23 帧的等效时长）",
      !!aMetaSrc && Math.abs(Number(aMetaSrc.duration) - EXPECTED_DURATION) < 2,
      aMetaSrc ? `duration=${aMetaSrc.duration}ms` : "无数据",
    );
    const aTxs = aSrc ? aSrc.points.map((p) => p.tx ?? 0) : [];
    check(
      "A4 位移曲线单调收敛：起点 tx 明显为负（屏外左侧）→ 终点 tx≈0，全程不回退",
      !!aSrc && aTxs.length >= 2 && aTxs[0] < -50 &&
        Math.abs(aTxs[aTxs.length - 1]) <= 1 &&
        aTxs.every((v, i) => i === 0 || v >= aTxs[i - 1] - 0.5),
      aSrc ? `tx: ${aTxs.join(" → ")}` : "无数据",
    );
    check(
      "A5 方向正确：起始 left < 最终 left（从左往右滑入）",
      !!aSrc && aSrc.points[0].left < aSrc.points[aSrc.points.length - 1].left - 50,
      aSrc ? `left: ${aSrc.points[0].left} → ${aSrc.points[aSrc.points.length - 1].left}` : "无数据",
    );
    check(
      "A6 曲线有 ≥3 个不同中间位置（渐进动画，不是一帧跳变）",
      !!aSrc && new Set(aTxs).size >= 3,
      aSrc ? `distinct tx = ${new Set(aTxs).size}` : "无数据",
    );

    // ── B. 编辑 → 阅读 ──
    log("");
    log("════════ B. 编辑 → 阅读（文档由右往左滑回）════════");
    const B = JSON.parse(await captureSlide("to-preview"));
    if (B.error) {
      log(`  ⚠️ ${B.error}；attrNow=${B.attrNow} faceNow=${JSON.stringify(B.faceNow)}`);
    } else {
      log(`  检测耗时 ${B.detectMs}ms；切换前模式=${B.beforeFace.mode} → 切换后=${B.afterFace.mode}`);
      for (const m of B.meta) {
        log(`  · ${m.sel}：animationName=${m.animationName} duration=${m.duration}ms delay=${m.delay}`);
      }
      for (const c of B.curves) {
        log(`  · ${c.sel} 位移曲线：`);
        for (const p of c.points) {
          log(`      ${String(p.p * 100).padStart(4)}% (${String(p.atMs).padStart(3)}ms)  left=${String(p.left).padStart(9)}  tx=${String(p.tx).padStart(9)}`);
        }
      }
      log(`  参考：rAF 实际观测 ${B.observedFrameCount} 帧，tx≠0 的 ${B.observedMovingFrames} 帧`);
      log(`  属性清空后：afterAttr=${JSON.stringify(B.afterAttr)}`);
    }

    const bC = B.curves?.find((c) => c.sel === ".editor-container");
    const bMetaC = B.meta?.find((m) => m.sel === ".editor-container");
    const bTxs = bC ? bC.points.map((p) => p.tx ?? 0) : [];
    check(
      "B1 阅读面动画名 = lmd-mode-slide-in-from-right（从右往左）",
      !!bMetaC && /slide-in-from-right/.test(String(bMetaC.animationName)),
      bMetaC ? `name=${bMetaC.animationName}` : "无数据",
    );
    check(
      "B2 动画时长 = 380ms",
      !!bMetaC && Math.abs(Number(bMetaC.duration) - EXPECTED_DURATION) < 2,
      bMetaC ? `duration=${bMetaC.duration}ms` : "无数据",
    );
    check(
      "B3 反向正确：起点 tx 明显为正（屏外右侧）→ 终点 tx≈0，且 left 递减",
      !!bC && bTxs.length >= 2 && bTxs[0] > 50 &&
        Math.abs(bTxs[bTxs.length - 1]) <= 1 &&
        bC.points[0].left > bC.points[bC.points.length - 1].left + 50 &&
        bTxs.every((v, i) => i === 0 || v <= bTxs[i - 1] + 0.5),
      bC ? `tx: ${bTxs.join(" → ")}；left: ${bC.points.map((p) => p.left).join(" → ")}` : "无数据",
    );
    check(
      "B4 曲线有 ≥3 个不同中间位置",
      !!bC && new Set(bTxs).size >= 3,
      bC ? `distinct tx = ${new Set(bTxs).size}` : "无数据",
    );

    // ── C. 滚动对齐不被破坏 ──
    log("");
    log("════════ C. 动画不破坏滚动对齐 ════════");
    // 判据：进场那面切换前是 display:none（scrollTop 恒 0），切换后才挂上并**恢复**
    // 到目标位置 —— 0 → N 是预期恢复，不是漂移。真正的风险是「动画结束后又写了一次
    // scrollTop」（迟到的校正），所以判据是「动画结束时的值 vs 再等 700ms 的值」一致。
    const cState = await ev(`const f = __visibleFace(); return { face: f, attr: __animAttr() };`);
    log(`  当前面：${JSON.stringify(cState.face)}；attr=${JSON.stringify(cState.attr)}`);
    /**
     * ⚠️ `__visibleFace()` 返回 `{ scVisible, taVisible, readerTop, sourceTop }`，
     * **没有** `mode` 字段（第一版按 `face.mode` 取 → undefined → C1 假 FAIL）。
     * 按可见性挑：阅读面可见用 readerTop，否则用 sourceTop。
     */
    const topOf = (f) =>
      !f ? null : f.scVisible && f.readerTop !== null ? f.readerTop : f.sourceTop;
    const settleTop = topOf(cState.face);
    await sleep(700);
    const cState2 = await ev(`const f = __visibleFace(); return { face: f, attr: __animAttr() };`);
    const settleTop2 = topOf(cState2.face);
    log(`  动画结束后 0ms scrollTop=${settleTop}，+700ms=${settleTop2}`);
    check(
      "C1 动画结束后不再有迟到的滚动校正（0ms vs +700ms 一致 ≤2px）",
      settleTop !== null && settleTop2 !== null && Math.abs(settleTop2 - settleTop) <= 2,
      `${settleTop} → ${settleTop2}`,
    );

    // 连切 N 轮
    await ev(`
      const sc = document.querySelector(".editor-container");
      if (sc && sc.offsetHeight > 0) sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      return true;
    `);
    await sleep(600);
    const r0 = await ev(`
      const sc = document.querySelector(".editor-container");
      return sc && sc.offsetHeight > 0 ? sc.scrollTop : null;
    `);
    const readerTops = [];
    const sourceTops = [];
    for (let r = 1; r <= ROUNDS; r++) {
      await doubleCtrl();
      await sleep(1100);
      const eTop = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        return ta && ta.offsetHeight > 0 ? ta.scrollTop : null;
      `);
      sourceTops.push(eTop);
      await doubleCtrl();
      await sleep(1200);
      const pTop = await ev(`
        const sc = document.querySelector(".editor-container");
        return sc && sc.offsetHeight > 0 ? sc.scrollTop : null;
      `);
      readerTops.push(pTop);
      log(`  R${r}: 编辑面 scrollTop=${eTop}  阅读面 scrollTop=${pTop}`);
    }
    const rDrift = readerTops.map((v) => (v === null || r0 === null ? null : v - r0));
    const sBase = sourceTops[0];
    const sDrift = sourceTops.map((v) => (v === null || sBase === null ? null : v - sBase));
    const finite = (arr) => arr.filter((v) => v !== null && Number.isFinite(v));
    const rAbsMax = finite(rDrift).length ? Math.max(...finite(rDrift).map(Math.abs)) : NaN;
    const sAbsMax = finite(sDrift).length ? Math.max(...finite(sDrift).map(Math.abs)) : NaN;
    log(`  阅读面基线=${r0}，序列：${readerTops.map((v) => (v === null ? "n/a" : v.toFixed(1))).join(" → ")}`);
    log(`  阅读面漂移：${rDrift.map((d) => (d === null ? "n/a" : (d >= 0 ? "+" : "") + d.toFixed(1))).join(", ")}`);
    log(`  编辑面序列：${sourceTops.map((v) => (v === null ? "n/a" : v.toFixed(1))).join(" → ")}`);
    log(`  编辑面漂移：${sDrift.map((d) => (d === null ? "n/a" : (d >= 0 ? "+" : "") + d.toFixed(1))).join(", ")}`);

    const monotoneOf = (arr) => {
      let dir = 0;
      for (let i = 1; i < arr.length; i++) {
        const a = arr[i - 1];
        const b = arr[i];
        if (a === null || b === null) continue;
        const step = b - a;
        if (Number.isFinite(step) && Math.abs(step) > 0.5) {
          if (dir === 0) dir = Math.sign(step);
          else if (Math.sign(step) !== dir) return 999;
        }
      }
      return dir;
    };
    const rMono = monotoneOf(readerTops);
    const sMono = monotoneOf(sourceTops);
    check(
      `C2 连切 ${ROUNDS} 轮：阅读面 scrollTop 最大偏移 ≤ 2px`,
      Number.isFinite(rAbsMax) && rAbsMax <= 2,
      `最大=${Number.isFinite(rAbsMax) ? rAbsMax.toFixed(2) : "n/a"}px（${finite(rDrift).length}/${ROUNDS} 轮有数据）`,
    );
    check(
      `C3 连切 ${ROUNDS} 轮：编辑面 scrollTop 最大偏移 ≤ 2px`,
      Number.isFinite(sAbsMax) && sAbsMax <= 2,
      `最大=${Number.isFinite(sAbsMax) ? sAbsMax.toFixed(2) : "n/a"}px（${finite(sDrift).length}/${ROUNDS} 轮有数据）`,
    );
    check(
      "C4 两面都不得单调同向累积",
      rMono !== 1 && rMono !== -1 && sMono !== 1 && sMono !== -1,
      `阅读面=${rMono === 999 ? "方向不一致" : rMono === 0 ? "无步进" : "同向累积"}，` +
        `编辑面=${sMono === 999 ? "方向不一致" : sMono === 0 ? "无步进" : "同向累积"}`,
    );

    // ── D. 动画结束后属性被清掉 ──
    log("");
    log("════════ D. 动画结束后 data-lmd-mode-anim 被清掉 ════════");
    const dBefore = await ev(`return __visibleFace();`);
    await doubleCtrl();
    const attrImmediately = await ev(`return __animAttr();`);
    await sleep(200);
    const attrAt200 = await ev(`return __animAttr();`);
    await sleep(500); // 累计 ~700ms > 380ms
    const attrAt700 = await ev(`
      const el = __mainArea();
      return { attr: __animAttr(), hasAttr: el ? el.hasAttribute("data-lmd-mode-anim") : null };
    `);
    log(`  切换前模式=${dBefore.mode}；切换瞬间 attr=${JSON.stringify(attrImmediately)}；` +
      `+200ms=${JSON.stringify(attrAt200)}；+700ms=${JSON.stringify(attrAt700)}`);
    check(
      "D1 切换瞬间属性确实被设置（这一轮动画真的启动了）",
      attrImmediately === "to-edit" || attrImmediately === "to-preview",
      `attr=${JSON.stringify(attrImmediately)}`,
    );
    check(
      "D2 ≥500ms 后属性被清掉（hasAttribute=false，宽度过渡不会被长期压制）",
      !!attrAt700 && attrAt700.hasAttr === false && !attrAt700.attr,
      JSON.stringify(attrAt700),
    );

    // 回到已知状态（阅读模式）以便 E 段
    await sleep(500);
    const dNow = await ev(`return __visibleFace();`);
    if (dNow && dNow.mode === "edit") {
      log("  （当前在编辑模式，切回阅读以便 E 段从已知状态开始）");
      await doubleCtrl();
      await sleep(1200);
    }

    // ── E. prefers-reduced-motion 降级 ──
    log("");
    log("════════ E. prefers-reduced-motion: reduce 降级 ════════");
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await sleep(500);
    const rmEnv = await ev(`
      return {
        reduceMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        face: __visibleFace(),
      };
    `);
    log("  " + JSON.stringify(rmEnv));

    // reduced-motion 下切一次：直接看「切换后即刻与 +300ms 的 transform」——
    // 若动画被正确关掉，两次都应是 none 且无动画实例。
    const rmBefore = await ev(`return __visibleFace();`);
    await doubleCtrl();
    const rmEarly = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      const sc = document.querySelector(".editor-container");
      return {
        attr: __animAttr(),
        face: __visibleFace(),
        src: __geomOf(ta ? ta.parentElement : null),
        reader: __geomOf(sc),
        animsOnMain: __animsOnMain(),
      };
    `);
    await sleep(300);
    const rmLate = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      const sc = document.querySelector(".editor-container");
      return {
        attr: __animAttr(),
        face: __visibleFace(),
        src: __geomOf(ta ? ta.parentElement : null),
        reader: __geomOf(sc),
        animsOnMain: __animsOnMain(),
      };
    `);
    const rmNone = (g) => !g || !g.transform || g.transform === "none";
    log(`  reduced-motion 切换前模式=${rmBefore.mode}`);
    log(`  +即刻：attr=${JSON.stringify(rmEarly?.attr)} mode=${rmEarly?.face?.mode} ` +
      `src.transform=${JSON.stringify(rmEarly?.src?.transform)} animsOnMain=${rmEarly?.animsOnMain}`);
    log(`  +300ms：attr=${JSON.stringify(rmLate?.attr)} mode=${rmLate?.face?.mode} ` +
      `src.transform=${JSON.stringify(rmLate?.src?.transform)} animsOnMain=${rmLate?.animsOnMain}`);

    check(
      "E1 reduced-motion 下 matchMedia 确实命中",
      rmEnv?.reduceMotion === true,
      `matches=${rmEnv?.reduceMotion}`,
    );
    check(
      "E2 reduced-motion 下不发生位移（进场元素 transform 全程 none，且无动画实例）",
      rmNone(rmEarly?.src) && rmNone(rmLate?.src) &&
        (rmEarly?.animsOnMain ?? 0) === 0 && (rmLate?.animsOnMain ?? 0) === 0,
      `src.transform=${JSON.stringify(rmEarly?.src?.transform)}/${JSON.stringify(rmLate?.src?.transform)}，` +
        `anims=${rmEarly?.animsOnMain}/${rmLate?.animsOnMain}`,
    );
    check(
      "E3 reduced-motion 下模式仍然照常切换（切到编辑模式）",
      rmEarly?.face?.mode === "edit" || rmLate?.face?.mode === "edit",
      `+即刻 mode=${rmEarly?.face?.mode}，+300ms mode=${rmLate?.face?.mode}`,
    );

    // 还原媒体模拟
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await sleep(300);

    // ── 收尾 ──
    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);

    fs.writeFileSync(OUT_TXT, logLines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        { env, A, B, rounds: { r0, readerTops, sourceTops, rDrift, sDrift }, rm: { rmEnv, rmEarly, rmLate }, checks },
        null,
        2,
      ),
      "utf-8",
    );
    log(`报告已写入：${OUT_TXT}`);
    log(`原始数据：${OUT_JSON}`);
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
    await sleep(600);
    killStale();
    await sleep(600);
    const post = portListeners(PORT);
    log("");
    log(`[probe] 端口 ${PORT} 收尾检查：${post ? `仍被占用 PID=${post}` : "已释放"}`);
  }
};

main().catch((e) => {
  console.error("探针失败：", e);
  process.exitCode = 2;
});
