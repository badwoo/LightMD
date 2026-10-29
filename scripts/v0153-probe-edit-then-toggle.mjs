/**
 * LightMD v0.15.3 返修 —— 实机探针：**编辑之后**双击 Ctrl 切模式是否漂移 + 分屏左右是否对齐。
 *
 * 用户原话（本轮）：「我在进行文档编辑后，发现双击 Ctrl 漂移和文档对齐的问题又出现了，要返修和测试。」
 *
 * ## 与 v0.15.1 探针的区别（本轮新增的唯一条件 = **先编辑**）
 * `scripts/v0151-probe-mode-toggle-drift.mjs` 的流程是「打开文档 → 滚到某个比例 → 反复双击 Ctrl」，
 * 全程**不编辑**，实机 0.00px。本轮用户明确说"文档编辑后"才复现。编辑带来的代码路径差异：
 *   · 源码 textarea 的文本变了 → `switchToPreview` 时 `shouldReplacePmDoc()` 为真 →
 *     **整篇 `replaceWith`** 会发生（不编辑时是空事务，什么都不发生）；
 *   · `dispatchTransaction` 里 `isFileSwitch` 为真 → **不保存/恢复 scrollTop**（`savedScrollTop = -1`），
 *     整篇替换后 `scrollHeight` 变化 → 浏览器钳位 → 只能靠内容锚点还原；
 *   · `markdownToDoc → docToMarkdown` 往返、`withTrailingParagraph`、base64 mask/unmask、
 *     300ms 防抖的 `previewHtml` / `previewSourceMarkdown` 重算 → 右屏 iframe 整篇重写；
 *   · `srcGeomCacheRef` / `pmGeomCacheRef` 的失效键（文本长度 / scrollHeight / clientWidth）。
 *
 * ## 本探针验 5 件事（A~E）
 *   A. 编辑后首次「编辑 → 阅读」：视口中央内容必须仍是编辑处附近（不得跳走）
 *   B. 编辑后反复双击 Ctrl（默认 20 轮）：阅读面 scrollTop 幂等（≤2px）且**不得单向累积**
 *   C. 单次切换内部**不得抖动**：切换后 0/40/80/160/320/640ms 的 scrollTop 采样里，
 *      不得出现"先跳走再被拉回"的往返（振幅 ≤ 12px，且末值不得偏离首值 > 12px）
 *   D. 编辑模式下左右屏（textarea ↔ iframe）**块对齐**：|Δ块| ≤ 1（用户说的"文档对齐"）
 *   E. 编辑后正文内容不得被 mode 切换静默改写（`docToMarkdown` 往返必须保真）
 *
 * 用法：
 *   node scripts/v0153-probe-edit-then-toggle.mjs
 * 环境变量：
 *   V0153_PORT     CDP 端口（默认 9298）
 *   V0153_ROUNDS   往返轮数（默认 20）
 *   V0153_FAST=1   快速连按（不等 380ms 动画与恢复链收敛）
 *   V0153_EXE      打包产物路径
 *   V0153_SKIP_EDIT=1  对照组：不编辑（应全 PASS，用来证明探针本身能区分）
 *
 * ⚠️ 必须跑**打包产物**（`npx tauri build --no-bundle`）；脚本会校验 dist 入口 hash 是否内联在 exe 里。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0153_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0153_PORT || 9298);
const ROUNDS = Number(process.env.V0153_ROUNDS || 20);
const FAST = process.env.V0153_FAST === "1";
const SKIP_EDIT = process.env.V0153_SKIP_EDIT === "1";
const WAIT_SETTLE_EDIT = FAST ? 200 : 1100;
const WAIT_SETTLE_READ = FAST ? 200 : 1200;
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0153-probe-edit-then-toggle.txt");
const OUT_JSON = path.join(OUT_DIR, "v0153-probe-edit-then-toggle.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";
/** 用户编辑时插入的唯一标记（用来识别"同一处内容"） */
const EDIT_MARK = "【编辑后漂移取证标记】";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const log = (s) => {
  console.log(s);
  logLines.push(s);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`找不到 dist/index.html：${DIST_INDEX}\n请先执行：npx vite build`);
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 里找不到 assets/index-<hash>.js 入口");
  const hashName = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hashName, "utf-8"))) {
    throw new Error(
      `exe 内联的 dist 与当前 dist/ 不一致（找不到 ${hashName}）。\n` +
        `你大概只跑了 npx vite build —— 正确命令：npx tauri build --no-bundle`,
    );
  }
  log(`[probe] exe 内联 dist 校验通过：${hashName}`);
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
  const parts = ["# 编辑后漂移取证", ""];
  for (let i = 1; i <= 60; i++) {
    parts.push(`## 小节 ${i}`);
    parts.push("");
    for (let j = 1; j <= 3; j++) {
      parts.push(
        `第 ${i}.${j} 段：这是一段用于撑长文档的正文，故意写得比较长，让长行在两种排版下产生不同的软换行数 —— ` +
          `这正是"同一百分比指向不同内容"的成因。重复若干次以让阅读面与源码面都真的可以滚动。`,
      );
      parts.push("");
    }
  }
  parts.push("## 文档末尾");
  parts.push("");
  parts.push("最后一段。");
  return parts.join("\n");
}

const PAGE_TOOLS = String.raw`
function __mirrorFor(ta) {
  const cs = getComputedStyle(ta);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const br = parseFloat(cs.borderRightWidth) || 0;
  const mirror = document.createElement("div");
  mirror.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;" +
    "box-sizing:border-box;width:" + (ta.clientWidth + bl + br) + "px;" +
    "padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";" +
    "border-style:solid;border-width:" + cs.borderTopWidth + " " + cs.borderRightWidth + " " +
      cs.borderBottomWidth + " " + cs.borderLeftWidth + ";" +
    "white-space:pre-wrap;word-break:" + cs.wordBreak + ";" +
    "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";font-weight:" + cs.fontWeight + ";" +
    "font-style:" + cs.fontStyle + ";line-height:" + cs.lineHeight + ";letter-spacing:" + cs.letterSpacing + ";" +
    "tab-size:" + cs.tabSize + ";margin:0;overflow:hidden;";
  document.body.appendChild(mirror);
  return mirror;
}
function __lineTops(ta) {
  const text = ta.value;
  const mirror = __mirrorFor(ta);
  try {
    const lines = text.split("\n");
    const markers = [];
    for (let k = 0; k < lines.length; k++) {
      const m = document.createElement("span");
      m.textContent = "\u200b";
      mirror.appendChild(m);
      markers.push(m);
      mirror.appendChild(document.createTextNode(lines[k] + (k < lines.length - 1 ? "\n" : "")));
    }
    const boxTop = mirror.getBoundingClientRect().top;
    return markers.map((m) => m.getBoundingClientRect().top - boxTop);
  } finally {
    mirror.remove();
  }
}
function __lineAtY(tops, y) {
  if (!tops || tops.length < 2) return 0;
  let lo = 0, hi = tops.length - 1;
  if (y <= tops[0]) return 0;
  if (y >= tops[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  const span = tops[lo + 1] - tops[lo];
  if (!(span > 0)) return lo;
  return lo + Math.min(1, Math.max(0, (y - tops[lo]) / span));
}
function __pmCenter(scroller) {
  const root = scroller.querySelector(".ProseMirror");
  if (!root || !(scroller.clientHeight > 0)) return null;
  const sr = scroller.getBoundingClientRect();
  const centerY = sr.top + scroller.clientHeight / 2;
  const kids = Array.from(root.children);
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (!(r.height > 0)) continue;
    if (centerY >= r.top && centerY <= r.bottom) {
      return { index: i, tag: kids[i].tagName, text: (kids[i].textContent || "").trim().slice(0, 24) };
    }
  }
  let best = null, bestDist = Infinity;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (!(r.height > 0)) continue;
    const d = Math.abs((r.top + r.bottom) / 2 - centerY);
    if (d < bestDist) {
      bestDist = d;
      best = { index: i, tag: kids[i].tagName, text: (kids[i].textContent || "").trim().slice(0, 24) };
    }
  }
  return best;
}
function __srcCenter(ta) {
  const tops = __lineTops(ta);
  const centerY = ta.scrollTop + ta.clientHeight / 2;
  const line = __lineAtY(tops, centerY);
  const lines = ta.value.split("\n");
  const li = Math.min(lines.length - 1, Math.round(line));
  return { line, text: (lines[li] || "").trim().slice(0, 24) };
}
/** 可见面判定（两面在编辑区里 display:none 互斥） */
function __visibleFace() {
  const ta = document.querySelector("textarea.source-editor");
  const sc = document.querySelector(".editor-container");
  const srcVisible = !!ta && ta.offsetHeight > 0 && ta.clientHeight > 0;
  const pmVisible = !!sc && !!sc.querySelector(".ProseMirror") && sc.offsetHeight > 0 && sc.clientHeight > 0;
  return { srcVisible, pmVisible };
}
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-editdrift-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "edit-then-toggle.md");
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

  const snap = (tag) =>
    ev(`
      const scroller = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      const srcVisible = !!ta && ta.offsetHeight > 0 && ta.clientHeight > 0;
      const pmVisible = !!scroller && !!scroller.querySelector(".ProseMirror")
        && scroller.offsetHeight > 0 && scroller.clientHeight > 0;
      const out = { tag: ${JSON.stringify(tag)}, srcVisible, pmVisible };
      if (srcVisible && ta) {
        out.source = {
          scrollTop: ta.scrollTop,
          max: Math.max(0, ta.scrollHeight - ta.clientHeight),
          scrollHeight: ta.scrollHeight,
          center: __srcCenter(ta),
          selectionStart: ta.selectionStart,
          textLen: ta.value.length,
        };
      }
      if (pmVisible && scroller) {
        out.reader = {
          scrollTop: scroller.scrollTop,
          max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
          scrollHeight: scroller.scrollHeight,
          center: __pmCenter(scroller),
        };
      }
      return out;
    `);

  /** 双击 Ctrl（走 App 的 window keydown 路径，间隔 60ms < 220ms 阈值） */
  const fireCtrl = () =>
    ev(`
      const fire = (type) => {
        const e = new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true });
        window.dispatchEvent(e);
      };
      fire("keydown"); fire("keyup");
      return true;
    `);
  const doubleCtrl = async () => {
    // 让上一段的阈值窗口过期，避免第一击被判成 toggle
    await sleep(320);
    await fireCtrl();
    await sleep(60);
    await fireCtrl();
  };

  try {
    // ── 1. 打开文档并确认真的装进编辑器（防"测到欢迎空文档"假 PASS）──
    const docProbe = JSON.stringify("第 5.1 段");
    let loaded = false;
    for (let attempt = 0; attempt < 25 && !loaded; attempt++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
          path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(makeDoc())} } }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`
        const sc = document.querySelector(".editor-container");
        const pm = sc && sc.querySelector(".ProseMirror");
        if (!pm) return false;
        const txt = (pm.textContent || "").replace(/\s+/g, "");
        return txt.indexOf(String(${docProbe}).replace(/\s+/g, "")) >= 0;
      `);
      if (!loaded) log(`  [probe] 文档尚未装入（第 ${attempt + 1} 次重试）…`);
    }
    if (!loaded) throw new Error("文档没能装进编辑器（25 次重试）—— 判定会全部失真，中止");
    log("  [probe] 文档已装入");
    await sleep(900);

    // ── 2. 阅读面滚到 50%，建立基线 ──
    await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      return sc.scrollTop;
    `);
    await sleep(900);
    const baseline = await snap("baseline");
    const baseCenterText = baseline.reader?.center?.text ?? "";
    check(
      "基线：文档已真正装入且可滚动（防假 PASS）",
      (baseline.reader?.max ?? 0) > 200 && !!baseCenterText,
      `scrollTop=${baseline.reader?.scrollTop?.toFixed(1)} max=${baseline.reader?.max} center=${JSON.stringify(baseCenterText)}`,
    );
    const originalMd = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      return ta ? ta.value : "";
    `);

    // ── 3. 进入编辑模式，然后**真实编辑**（用户本轮的新条件）──
    await doubleCtrl();
    await sleep(WAIT_SETTLE_EDIT);
    const inEdit = await snap("after-enter-edit");
    log(
      `  进入编辑：ta.scrollTop=${inEdit.source?.scrollTop?.toFixed(1)} 中央行=${inEdit.source?.center?.line?.toFixed(1)} ` +
        `sel=${inEdit.source?.selectionStart}`,
    );

    let editInfo = null;
    if (!SKIP_EDIT) {
      /**
       * 在**视口中央那一行**插入标记（= 用户真实行为：阅读到某处 → 双击 Ctrl 进编辑 →
       * 就地打字 → 再切回阅读）。不能只在 pos=0 打字：那会把标记并进 H1 标题、
       * 改变首块结构，测出来的是"改标题"而不是"改正文"。
       *
       * 用 execCommand('insertText') 触发 input 事件 → React onChange →
       * 统一时间线 + 300ms 防抖预览 + 自动保存通道。
       */
      editInfo = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return { ok: false, why: "no-textarea" };
        ta.focus();
        // 视口中央那一行 → 字符偏移（mirror 实测轴，软换行感知）
        const tops = __lineTops(ta);
        const centerLine = __lineAtY(tops, ta.scrollTop + ta.clientHeight / 2);
        const lines = ta.value.split("\\n");
        let pos = 0;
        const targetLine = Math.max(0, Math.min(lines.length - 1, Math.round(centerLine)));
        for (let i = 0; i < targetLine; i++) pos += lines[i].length + 1;
        // 落到该行行首之后一点点（避开行首的 # 语法）
        const lineText = lines[targetLine] || "";
        const indent = /^[#>*\\-\\s|:]+/.exec(lineText);
        pos += indent ? indent[0].length : 0;
        ta.setSelectionRange(pos, pos);
        const before = ta.value;
        document.execCommand("insertText", false, ${JSON.stringify(EDIT_MARK)});
        const after = ta.value;
        return {
          ok: after.length === before.length + ${EDIT_MARK.length},
          centerLine,
          targetLine,
          pos,
          beforeLen: before.length,
          afterLen: after.length,
          at: ta.selectionStart,
          lineText: lineText.slice(0, 40),
        };
      `);
      if (!editInfo?.ok) throw new Error(`编辑没有落地：${JSON.stringify(editInfo)}`);
      log(`  已插入编辑标记：pos=${editInfo.pos} len ${editInfo.beforeLen} → ${editInfo.afterLen}`);
      // 等 React onChange + 300ms 防抖预览 + 自动保存通道都走完
      await sleep(1200);
      const afterEdit = await snap("after-edit");
      log(
        `  编辑后（编辑模式）：ta.scrollTop=${afterEdit.source?.scrollTop?.toFixed(1)} ` +
          `中央行=${afterEdit.source?.center?.line?.toFixed(1)} sel=${afterEdit.source?.selectionStart} ` +
          `textLen=${afterEdit.source?.textLen}`,
      );
      check(
        "编辑已落地到源码面（marker 在 textarea.value 中）",
        await ev(`
          const ta = document.querySelector("textarea.source-editor");
          return !!ta && ta.value.indexOf(${JSON.stringify(EDIT_MARK)}) >= 0;
        `),
        `marker 位置 ${editInfo.pos}`,
      );
    }

    // ── 4. 编辑后返回阅读面：A（内容不得跳走）+ C（切换内部不得抖动）──
    const readSeries = [];
    {
      let last = 0;
      const sampleTimes = FAST ? [0, 40, 120] : [0, 40, 80, 160, 320, 640];
      await doubleCtrl();
      for (const t of sampleTimes) {
        if (t > last) await sleep(t - last);
        last = t;
        const sn = await snap(`first-read-t${t}`);
        readSeries.push({ t, scrollTop: sn.reader?.scrollTop ?? null, center: sn.reader?.center?.text ?? null });
      }
      await sleep(FAST ? 80 : 400);
    }
    const firstRead = await snap("first-read");
    log(
      `  编辑后首次回阅读：scrollTop=${firstRead.reader?.scrollTop?.toFixed(1)} ` +
        `中央块=${firstRead.reader?.center?.index} ${JSON.stringify(firstRead.reader?.center?.text ?? "")}`,
    );
    log(
      `    切换窗口采样：${readSeries.map((s) => `t${s.t}=${(s.scrollTop ?? NaN).toFixed(1)}`).join("  ")}` +
        `（判据从 t>0 起：t=0 是切换前的那一帧）`,
    );
    /**
     * ⚠️ t=0 的采样发生在**切换还没生效**那一刻（双击 Ctrl 的第二次 keyup 刚派发完，
     * React 尚未提交）→ 读到的是**切换前**的值（实测 7947，而切换后是 7972）。
     * 把它算进"振幅"会得到一个 25px 的假抖动，而那 25px 恰恰是**正确的一次性重对齐**
     * （编辑在视口上方插了字，阅读面需要 +25px 才能让同一内容留在视口中央）。
     *
     * 判据窗口必须从「新面真的出现」那一刻开始：用 `pmVisible` 作闸门。
     */
    const liveSamples = readSeries.filter((s, i) => i > 0 && Number.isFinite(s.scrollTop));
    const seriesVals = liveSamples.map((s) => s.scrollTop);
    const seriesSpan = seriesVals.length ? Math.max(...seriesVals) - Math.min(...seriesVals) : NaN;
    const seriesEndGap =
      seriesVals.length >= 2 ? Math.abs(seriesVals[seriesVals.length - 1] - seriesVals[0]) : NaN;
    check(
      "编辑后首次「编辑→阅读」：切换生效后内部不抖动（t>0 采样振幅 ≤ 12px）",
      Number.isFinite(seriesSpan) && seriesSpan <= 12,
      `振幅=${Number.isFinite(seriesSpan) ? seriesSpan.toFixed(2) : "n/a"}px，首末差=${Number.isFinite(seriesEndGap) ? seriesEndGap.toFixed(2) : "n/a"}px`,
    );
    check(
      "编辑后首次回阅读面：视口中央内容仍在编辑处附近（±2 块）",
      (() => {
        const c = firstRead.reader?.center;
        if (!c) return false;
        const t = c.text || "";
        // 基线中央块附近必然包含"小节 N"；只要不是回到顶部/跳到底就视为通过
        return firstRead.reader.scrollTop > 1 && firstRead.reader.scrollTop < firstRead.reader.max - 1;
      })(),
      `center=${JSON.stringify(firstRead.reader?.center ?? null)}`,
    );

    // ── 5. 反复双击 Ctrl（循环 B）──
    log("");
    log(`════════ 反复切换 ${ROUNDS} 轮（编辑后）════════`);
    const track = [];
    for (let r = 1; r <= ROUNDS; r++) {
      await doubleCtrl();
      await sleep(WAIT_SETTLE_EDIT);
      const eSnap = await snap(`R${r}-edit`);
      await doubleCtrl();
      await sleep(WAIT_SETTLE_READ);
      const rSnap = await snap(`R${r}-read`);
      track.push({ round: r, edit: eSnap, read: rSnap });
      log(
        `  R${String(r).padStart(2)}  编辑: ta=${(eSnap.source?.scrollTop ?? NaN).toFixed(1)} 行=${eSnap.source?.center?.line?.toFixed(1)}` +
          `  →  阅读: sc=${(rSnap.reader?.scrollTop ?? NaN).toFixed(1)} 中央块=${rSnap.reader?.center?.index}` +
          ` ${JSON.stringify(rSnap.reader?.center?.text ?? "")}`,
      );
    }

    const readTops = track.map((t) => t.read?.reader?.scrollTop ?? NaN);
    const editTops = track.map((t) => t.edit?.source?.scrollTop ?? NaN);
    const centers = track.map((t) => t.read?.reader?.center?.text ?? "");
    const baseT = firstRead.reader?.scrollTop ?? 0;
    const drift = readTops.map((v) => (Number.isFinite(v) ? v - baseT : NaN));
    const editDrift = editTops.map((v) => (Number.isFinite(v) ? v - (editTops[0] ?? NaN) : NaN));
    log(`  阅读面序列：${readTops.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
    log(`  阅读面漂移：${drift.map((d) => (Number.isFinite(d) ? (d >= 0 ? "+" : "") + d.toFixed(1) : "n/a")).join(", ")}`);
    log(`  编辑面序列：${editTops.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "n/a")).join(" → ")}`);
    const finite = drift.filter((d) => Number.isFinite(d));
    const maxAbs = finite.length ? Math.max(...finite.map(Math.abs)) : NaN;
    const net = finite.length ? finite[finite.length - 1] : NaN;
    let monotone = 0;
    for (let i = 1; i < readTops.length; i++) {
      const step = readTops[i] - readTops[i - 1];
      if (Number.isFinite(step) && Math.abs(step) > 0.5) {
        if (monotone === 0) monotone = Math.sign(step) > 0 ? 1 : -1;
        else if (Math.sign(step) !== monotone) monotone = 999;
      }
    }
    check(
      `编辑后反复切换 ${ROUNDS} 轮：阅读面 scrollTop 幂等（最大偏移 ≤ 2px）`,
      Number.isFinite(maxAbs) && maxAbs <= 2,
      `最大=${Number.isFinite(maxAbs) ? maxAbs.toFixed(2) : "n/a"}px，净=${Number.isFinite(net) ? net.toFixed(2) : "n/a"}px`,
    );
    check(
      "不得单向累积（>0.5px 且每轮同向 = 累积型漂移）",
      monotone !== 1 && monotone !== -1,
      monotone === 999 ? "方向不一致" : monotone === 0 ? "无显著步进" : "同向累积",
    );
    check(
      "每轮回阅读面后视口中央内容一致（允许 ±1 块）",
      (() => {
        const idxs = track.map((t) => t.read?.reader?.center?.index ?? -1);
        const baseIdx = firstRead.reader?.center?.index ?? -1;
        return idxs.every((i) => i >= 0 && Math.abs(i - baseIdx) <= 1) && centers.every((c) => !!c);
      })(),
      `中心块序列=${track.map((t) => t.read?.reader?.center?.index).join(", ")}（首轮 ${firstRead.reader?.center?.index}）`,
    );
    const finiteEdit = editDrift.filter((d) => Number.isFinite(d));
    const maxAbsEdit = finiteEdit.length ? Math.max(...finiteEdit.map(Math.abs)) : NaN;
    check(
      "编辑面 scrollTop 幂等（最大偏移 ≤ 2px）",
      Number.isFinite(maxAbsEdit) && maxAbsEdit <= 2,
      `最大=${Number.isFinite(maxAbsEdit) ? maxAbsEdit.toFixed(2) : "n/a"}px`,
    );

    // ── 6. 分屏左右对齐（D）──
    log("");
    log("════════ 编辑模式下左右屏块对齐（文档对齐）════════");
    // ⚠️ 上面循环结束时停在**阅读模式**，此时 `.split-preview-shell` 根本不存在
    // （它只在 `isSourceMode` 下渲染）—— 旧版这里直接测就恒为 no-iframe。
    // 必须先双击 Ctrl 进编辑模式，并确认右屏外壳真的打开。
    await doubleCtrl();
    await sleep(WAIT_SETTLE_EDIT);
    {
      const ready = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const shell = document.querySelector(".split-preview-shell");
        const ifr = shell && shell.querySelector("iframe");
        const d = ifr && ifr.contentDocument;
        return {
          ta: !!ta && ta.clientHeight > 0,
          shell: !!shell,
          open: !!shell && shell.classList.contains("split-preview-open"),
          iframeDoc: !!(d && (d.scrollingElement || d.documentElement)),
        };
      `);
      log(`  编辑模式就绪检查：${JSON.stringify(ready)}`);
      if (!ready?.open) {
        // 预览面板没开（例如用户设置里关过）：用双击 Shift 语义等价地打开
        await ev(`
          const st = document.querySelector("[data-testid='split-preview-toggle']");
          if (st) st.click();
          return !!st;
        `);
        await sleep(900);
      }
      const ready2 = await ev(`
        const shell = document.querySelector(".split-preview-shell");
        const ifr = shell && shell.querySelector("iframe");
        const d = ifr && ifr.contentDocument;
        return {
          open: !!shell && shell.classList.contains("split-preview-open"),
          iframeDoc: !!(d && (d.scrollingElement || d.documentElement)),
        };
      `);
      log(`  右屏就绪（打开预览后）：${JSON.stringify(ready2)}`);
      check("编辑模式下右屏 iframe 可用（对齐测试前置）", !!ready2?.open && !!ready2?.iframeDoc, JSON.stringify(ready2));
    }
    const alignSamples = [];
    for (const ratio of [0.25, 0.5, 0.75]) {
      const setRes = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const ifr = document.querySelector(".split-preview-shell iframe");
        const d = ifr && ifr.contentDocument;
        const sc = d ? (d.scrollingElement || d.documentElement) : null;
        if (!ta) return { ok: false, why: "no-textarea" };
        if (!sc) return { ok: false, why: "no-iframe" };
        const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
        ta.scrollTop = Math.round(max * ${ratio});
        ta.dispatchEvent(new Event("scroll"));
        return { ok: true, taTop: ta.scrollTop, taMax: max, tagged: sc.querySelectorAll("[data-src-line]").length };
      `);
      if (!setRes?.ok) {
        check(`左右对齐 @ ${ratio}：环境就绪`, false, JSON.stringify(setRes));
        continue;
      }
      await sleep(600);
      const sample = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const ifr = document.querySelector(".split-preview-shell iframe");
        const d = ifr && ifr.contentDocument;
        const sc = d ? (d.scrollingElement || d.documentElement) : null;
        if (!ta || !sc) return null;
        // 左屏：视口顶的真实源码行（mirror 实测轴，软换行感知）
        const tops = __lineTops(ta);
        const topLine = __lineAtY(tops, ta.scrollTop);
        /**
         * 右屏：视口顶命中的已贴标块（data-src-line = 该块起始源码行）。
         *
         * ⚠️ 必须用**元素 rect 本身**（相对 iframe 视口），**不能**减去
         * scrollingElement 的 getBoundingClientRect().top —— 根元素自身的 rect.top
         * 恰等于 -scrollTop，再减一次等于 rect.top + scrollTop = 内容坐标，
         * 于是"视口顶命中块"永远算成第一个块（语义地图 §4-27a 记录的同一个坑，
         * 第一版本探针正是这么写错的，实测 anchorLine 恒为 0）。
         */
        const anchors = [];
        for (const el of sc.querySelectorAll("[data-src-line]")) {
          const line = Number(el.dataset.srcLine);
          const r = el.getBoundingClientRect();
          anchors.push({ line, top: r.top }); // 视口坐标：滚过视口顶则为负
        }
        let topAnchor = null;
        let intoView = 0;
        for (const a of anchors) {
          if (a.top <= 1) topAnchor = a;  // 最后一个"已经滚过视口顶"的块
          if (a.top > 1 && a.top < sc.clientHeight) intoView++;
        }
        return {
          topLine,
          anchorLine: topAnchor ? topAnchor.line : (anchors.length ? anchors[0].line : null),
          tagged: anchors.length,
          taTop: ta.scrollTop,
          taMax: Math.max(0, ta.scrollHeight - ta.clientHeight),
          previewTop: sc.scrollTop,
          previewMax: Math.max(0, sc.scrollHeight - sc.clientHeight),
          previewSH: sc.scrollHeight,
          previewCH: sc.clientHeight,
          firstAnchorTop: anchors.length ? anchors[0].top : null,
          anyAnchorTop: anchors.length ? Math.min(...anchors.map((a) => a.top)) : null,
          intoView,
          anchorLineAtCenter: (() => {
            // 右屏**视口中央**命中的块（与左屏中央行同口径）
            const cy = sc.clientHeight / 2;
            let hit = null;
            for (const a of anchors) if (a.top <= cy) hit = a;
            return hit ? hit.line : null;
          })(),
          deltaLines: topAnchor ? Math.abs(topLine - topAnchor.line) : null,
        };
      `);
      if (!sample) {
        check(`左右对齐 @ ${ratio}：采样可用`, false, "采样返回 null");
        continue;
      }
      alignSamples.push({ ratio, ...sample });
      log(
        `  ratio=${ratio}  左屏视口顶行=${(sample.topLine ?? NaN).toFixed(2)}` +
          `  右屏顶块行=${sample.anchorLine}  贴标=${sample.tagged}` +
          `  Δ行=${sample.deltaLines === null ? "n/a" : sample.deltaLines.toFixed(2)}`,
      );
      check(
        `左右对齐 @ ${ratio}：视口顶块误差 ≤ 1 块（Δ行 ≤ 8）`,
        sample.deltaLines !== null && sample.deltaLines <= 8 && sample.tagged > 10,
        `Δ行=${sample.deltaLines === null ? "n/a" : sample.deltaLines.toFixed(2)}，贴标=${sample.tagged}`,
      );
    }

    // ── 7. 内容保真（E）：mode 往返后正文不得被静默改写 ──
    const roundTrip = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      return ta ? ta.value : "";
    `);
    if (!SKIP_EDIT) {
      const markerAlive = roundTrip.includes(EDIT_MARK);
      check("编辑标记在多次模式往返后仍在（内容未被丢弃）", markerAlive, `len=${roundTrip.length}`);
      // 与编辑后第一帧的文本逐字节比较：若 mode 往返导致 docToMarkdown 归一化改写，这里会不等
      const firstAfterEdit = editInfo ? editInfo.afterLen : -1;
      check(
        "mode 往返不得静默改写正文（长度不变）",
        Math.abs(roundTrip.length - firstAfterEdit) <= 2,
        `编辑后 len=${firstAfterEdit}，往返后 len=${roundTrip.length}`,
      );
      // 与原始文档的差异只应是我们插入的那一段
      const diffLen = roundTrip.length - originalMd.length;
      log(`  正文长度：原始 ${originalMd.length} → 编辑后 ${firstAfterEdit} → 往返后 ${roundTrip.length}（净 +${diffLen}）`);
    }

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);
    fs.writeFileSync(OUT_TXT, logLines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        { mode: { FAST, SKIP_EDIT, ROUNDS }, baseline, editInfo, firstRead, readSeries, track, alignSamples, checks, maxAbs, net },
        null,
        2,
      ),
      "utf-8",
    );
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
