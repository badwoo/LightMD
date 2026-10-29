/**
 * LightMD v0.15.3 —— 实机探针：**含异步渲染内容（mermaid / katex / 图片）时，
 * 模式切换后「左右屏文档对齐」是否随时间劣化**（只测不改）。
 *
 * ## 为什么单独测这个
 * `scripts/v0153-probe-edit-then-toggle.mjs` 用的是纯文本长文档，左右对齐实测
 * Δ行 < 1（很好）。但真实用户文档含 `mermaid` / `katex` / 图片 —— 这些在 iframe 里
 * 是**异步渲染**的（语义地图 §4-27c/§4-31：实测到 1427ms 还有几何动作）。
 * 而模式切换（不是预览开合）路径上**没有任何延时重对齐**：
 * `syncPreviewAfterToggleRef` 的 0/160/480/1000ms 重试只挂在「预览开合冻结窗」的
 * `finalize` 里（`EditorContainer.tsx:7770-7779`），模式切换走不到那里。
 * 于是：切进编辑模式 → 右屏先按"渲染前几何"对齐一次 → mermaid/katex 撑高 →
 * 左右错位，且**不会自我修正**（要等用户滚一下左屏触发 syncToPreview）。
 *
 * ## 判定
 *   A1 切进编辑模式后 **0ms**：|右屏首可见块行 − 左屏视口顶行| ≤ 3（初始对齐必须对）
 *   A2 **160 / 480 / 1000 / 1600ms** 各采一次：Δ行 不得随时间**单调变大**，
 *      末次 Δ行 ≤ 3（允许中间帧波动，但不允许"越等越歪"）
 *   A3 用户滚一下左屏后，Δ行 必须 ≤ 3（证明映射本身没问题，问题只在"没人触发"）
 *   A4 编辑后（正文变了）再切进编辑模式，同样满足 A1/A2
 *
 * 用法：node scripts/v0153-probe-align-async.mjs
 * 环境变量：V0153A_PORT（默认 9302）、V0153A_EXE
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0153A_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0153A_PORT || 9302);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0153-probe-align-async.txt");
const OUT_JSON = path.join(OUT_DIR, "v0153-probe-align-async.json");
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";
const MARK = "【对齐取证标记】";

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

/** 含 mermaid + katex + 长段落 + 表格的文档（模拟真实用户文档） */
function makeDoc() {
  const p = ["# 异步渲染对齐取证", ""];
  for (let i = 1; i <= 30; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    p.push(
      `第 ${i} 段：这是一段用于撑长文档的正文，故意写得比较长，让长行在两种排版下产生不同的软换行数。` +
        `继续堆字以拉长该逻辑行，使滚动量足够大。`,
    );
    p.push("");
    if (i % 6 === 1) {
      p.push("```mermaid");
      p.push("graph TD");
      p.push("  A[开始] --> B{判断}");
      p.push("  B -->|是| C[处理]");
      p.push("  B -->|否| D[结束]");
      p.push("```");
      p.push("");
    }
    if (i % 6 === 3) {
      p.push("$$");
      p.push("\\sum_{k=1}^{n} \\frac{1}{k} = \\ln n + \\gamma");
      p.push("$$");
      p.push("");
    }
    if (i % 6 === 5) {
      p.push("| 列A | 列B | 列C |");
      p.push("|---|---|---|");
      p.push("| 1 | 2 | 3 |");
      p.push("| 4 | 5 | 6 |");
      p.push("");
    }
  }
  p.push("## 末段");
  p.push("最后一段。");
  return p.join("\n");
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
    const ls = text.split("\n");
    const markers = [];
    for (let k = 0; k < ls.length; k++) {
      const m = document.createElement("span");
      m.textContent = "\u200b";
      mirror.appendChild(m);
      markers.push(m);
      mirror.appendChild(document.createTextNode(ls[k] + (k < ls.length - 1 ? "\n" : "")));
    }
    const boxTop = mirror.getBoundingClientRect().top;
    return markers.map((m) => m.getBoundingClientRect().top - boxTop);
  } finally { mirror.remove(); }
}
function __lineAtY(tops, y) {
  if (!tops || tops.length < 2) return 0;
  let lo = 0, hi = tops.length - 1;
  if (y <= tops[0]) return 0;
  if (y >= tops[hi]) return hi;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  const span = tops[lo + 1] - tops[lo];
  if (!(span > 0)) return lo;
  return lo + Math.min(1, Math.max(0, (y - tops[lo]) / span));
}
/**
 * 采一次「左右对齐」现场。
 *
 * ⚠️ 右屏必须用元素自身 rect（视口坐标），**不能**减 scrollingElement 的 rect.top
 * （那是 §4-27a 的坑，会恒等于第一个块）。
 */
window.__alignSample = function () {
  const ta = document.querySelector("textarea.source-editor");
  const shell = document.querySelector(".split-preview-shell");
  const ifr = shell && shell.querySelector("iframe");
  const d = ifr && ifr.contentDocument;
  const sc = d ? (d.scrollingElement || d.documentElement) : null;
  if (!ta || !sc) return { ok: false, why: !ta ? "no-textarea" : "no-iframe" };
  const tops = __lineTops(ta);
  const topLine = __lineAtY(tops, ta.scrollTop);
  const anchors = [];
  for (const el of sc.querySelectorAll("[data-src-line]")) {
    const r = el.getBoundingClientRect();
    anchors.push({ line: Number(el.dataset.srcLine), top: r.top, height: r.height });
  }
  let hitIdx = -1;
  for (let i = 0; i < anchors.length; i++) if (anchors[i].top <= 1) hitIdx = i;
  const hit = hitIdx >= 0 ? anchors[hitIdx] : (anchors.length ? anchors[0] : null);
  const tagged = anchors.length;
  /**
   * ★ 正确的 ground truth：与产品 contentScrollMap.regionAtY 同口径的**块内比例**。
   *
   * 第一版拿「左屏视口顶行」直接减「右屏命中块的**起始**行」—— 这是**测错东西**：
   * 右屏视口顶可能落在某个高块（mermaid 图、长段落）的**中间**，此时它落后块起始行
   * 好几行是**完全正确的**（实测 Δ5.1 行就是这么来的，而用户手动滚一下立刻变 0.09，
   * 因为那一滚正好落在块边界上）。
   *
   * 正确算法：块内比例 f = (-hit.top) / hitHeight（hit.top 为负 = 已滚进块内多少 px），
   * 再按「本块起始行 → 下一块起始行」的连续区域插值，得到右屏视口顶对应的源码行。
   * 这正是 restoreContentAnchor / captureContentAnchor 用的同一套口径。
   */
  let expectedLine = null;
  let frac = null;
  if (hit && hit.height > 0) {
    frac = Math.min(1, Math.max(0, -hit.top / hit.height));
    const next = hitIdx + 1 < anchors.length ? anchors[hitIdx + 1] : null;
    const extent = next ? next.line - hit.line : hit.height;
    expectedLine = hit.line + frac * (Math.max(0, extent) || 0);
  }
  return {
    ok: true,
    topLine: +topLine.toFixed(2),
    anchorLine: hit ? hit.line : null,
    anchorFrac: frac === null ? null : +frac.toFixed(3),
    /** 右屏视口顶按块内比例插值得到的"应有的源码行"—— 与左屏 topLine 同口径 */
    expectedLine: expectedLine === null ? null : +expectedLine.toFixed(2),
    /** 真正的对齐误差（行）：左屏视口顶行 vs 右屏插值行 */
    delta: expectedLine === null ? null : +Math.abs(topLine - expectedLine).toFixed(2),
    /** 旧口径（块起始行 vs 左顶行）仅供参考，不作判据 */
    deltaNaive: hit ? +Math.abs(topLine - hit.line).toFixed(2) : null,
    deltaCenter: (() => {
      let c = null;
      for (const a of anchors) if (a.top <= sc.clientHeight / 2) c = a;
      return c ? +Math.abs(topLine + (ta.clientHeight / 2 - 0) * 0 + 0 - c.line).toFixed(2) : null;
    })(),
    tagged,
    taTop: +ta.scrollTop.toFixed(1),
    taMax: Math.max(0, ta.scrollHeight - ta.clientHeight),
    previewTop: +sc.scrollTop.toFixed(1),
    previewMax: Math.max(0, sc.scrollHeight - sc.clientHeight),
    previewSH: sc.scrollHeight,
    mermaidSvgs: d ? d.querySelectorAll("svg").length : 0,
    katexNodes: d ? d.querySelectorAll(".katex, .math-block-preview").length : 0,
  };
};
`;

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

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-align-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpDir, "align-async.md");
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
      for (const type of ["keydown", "keyup"]) {
        window.dispatchEvent(new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      }
      await new Promise((r) => setTimeout(r, 60));
      for (const type of ["keydown", "keyup"]) {
        window.dispatchEvent(new KeyboardEvent(type, { key: "Control", code: "ControlLeft", bubbles: true, cancelable: true }));
      }
      return true;
    `);
  };

  /** 进编辑模式后按时间点采对齐（0/160/480/1000/1600ms） */
  const sampleAlignSeries = async (label, times = [0, 160, 480, 1000, 1600]) => {
    await doubleCtrl();
    const series = [];
    let last = 0;
    for (const t of times) {
      if (t > last) await sleep(t - last);
      last = t;
      const s = await ev(`return window.__alignSample();`);
      series.push({ t, ...s });
      log(
        `  ${label} t=${String(t).padStart(4)}ms 左顶行=${s.topLine ?? "n/a"} 右块起始行=${s.anchorLine}` +
          ` 块内比例=${s.anchorFrac ?? "n/a"} → 应有行=${s.expectedLine ?? "n/a"}` +
          ` **Δ行=${s.delta ?? "n/a"}**（旧口径 ${s.deltaNaive ?? "n/a"}）贴标=${s.tagged}` +
          ` mermaidSVG=${s.mermaidSvgs} katex=${s.katexNodes} 左max=${s.taMax} 右max=${s.previewMax}`,
      );
    }
    await sleep(400);
    return series;
  };

  try {
    const probeMark = JSON.stringify("第 5 段");
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
        const txt = (pm.textContent || "").replace(/\\s+/g, "");
        return txt.indexOf(String(${probeMark}).replace(/\\s+/g, "")) >= 0;
      `);
      if (!loaded) {
        const diag = await ev(`
          const pm = document.querySelector(".editor-container .ProseMirror");
          const ta = document.querySelector("textarea.source-editor");
          return {
            hasPm: !!pm,
            pmText: pm ? (pm.textContent || "").slice(0, 120) : null,
            pmLen: pm ? (pm.textContent || "").length : -1,
            taLen: ta ? ta.value.length : -1,
            taText: ta ? ta.value.slice(0, 80) : null,
          };
        `);
        log(`  [retry ${a + 1}] ${JSON.stringify(diag)}`);
      }
    }
    if (!loaded) throw new Error("文档未装入（判定会失真，中止）");
    log("[probe] 文档已装入（含 mermaid / katex / 表格）");
    // 让阅读面把 mermaid 渲染完
    await sleep(1800);

    // 滚到 50%（阅读面）
    await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      return sc.scrollTop;
    `);
    await sleep(900);

    // ── A1/A2：直接切进编辑模式（未编辑），看对齐是否随时间劣化 ──
    log("");
    log("════════ A1/A2：未编辑时切进编辑模式的对齐时序 ═───────");
    const seriesA = await sampleAlignSeries("A");
    /**
     * A1 在 t=0ms 时右屏必然还没就绪（实测贴标 0 个、scrollHeight=0），
     * 所以"0ms 必须已对齐"是**不可能满足**的伪判据 —— 上一版就是因此恒 FAIL。
     * 真正的要求是：**一旦右屏就绪，第一次采样就必须已经对齐**（≤3 行）。
     */
    const firstReady = seriesA.find((s) => s.tagged > 0 && s.delta !== null);
    check(
      "A1 右屏一就绪就必须已对齐（首个 tagged>0 的采样 |Δ行| ≤ 3）",
      (firstReady?.delta ?? 999) <= 3,
      firstReady ? `t=${firstReady.t}ms Δ行=${firstReady.delta}（贴标 ${firstReady.tagged}）` : "无任何采样可用",
    );
    const deltasA = seriesA.map((s) => s.delta);
    const lastA = deltasA[deltasA.length - 1];
    const maxA = Math.max(...deltasA.filter((d) => d !== null).concat([0]));
    check(
      "A2 右屏就绪后直到 1600ms 都保持对齐（每次采样 |Δ行| ≤ 3）",
      lastA !== null && lastA <= 3 && maxA <= 3,
      `Δ行序列=${deltasA.map((d) => (d === null ? "n/a" : d)).join("→")}，最大=${maxA}`,
    );

    // ── A3：滚一下左屏，看是否立刻纠正（证明映射本身没问题） ──
    log("");
    log("════════ A3：左屏滚动一下后的对齐（映射自证） ═───────");
    await ev(`
      const ta = document.querySelector("textarea.source-editor");
      ta.scrollTop = ta.scrollTop + 120;
      ta.dispatchEvent(new Event("scroll"));
      return ta.scrollTop;
    `);
    await sleep(700);
    const afterScroll = await ev(`return window.__alignSample();`);
    log(
      `  A3 滚动后：左顶行=${afterScroll.topLine} 右块起始行=${afterScroll.anchorLine} ` +
        `块内比例=${afterScroll.anchorFrac} → 应有行=${afterScroll.expectedLine} **Δ行=${afterScroll.delta}**`,
    );
    check("A3 左屏滚动后对齐立即正确（|Δ行| ≤ 3）", (afterScroll.delta ?? 999) <= 3, `Δ行=${afterScroll.delta}`);

    // ── A4：编辑后回阅读再切进编辑，重测 ──
    log("");
    log("════════ A4：编辑后切进编辑模式的对齐时序 ═───────");
    // 先回阅读模式
    await doubleCtrl();
    await sleep(1200);
    // 阅读面在 50% 处编辑（改一段正文）
    const pmEdit = await ev(`
      const sc = document.querySelector(".editor-container");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      const pm = sc.querySelector(".ProseMirror");
      const ps = pm.querySelectorAll("p");
      const target = ps[Math.min(ps.length - 1, Math.floor(ps.length / 2))];
      const r = target.getBoundingClientRect();
      const opt = { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + r.height / 2, button: 0 };
      target.dispatchEvent(new MouseEvent("mousedown", opt));
      target.dispatchEvent(new MouseEvent("mouseup", opt));
      await new Promise((r2) => setTimeout(r2, 150));
      return { ok: true, text: (target.textContent || "").slice(0, 20) };
    `);
    log(`  阅读面落点：${JSON.stringify(pmEdit)}`);
    await cdp.send("Input.insertText", { text: MARK });
    await sleep(1200);
    const seriesB = await sampleAlignSeries("A4");
    /**
     * A4 的口径必须比 A1 宽一档：编辑后 katex/mermaid 会**重新异步渲染**
     * （实测 160ms 时 katex=0、480ms 才 5），渲染完成前几何本来就不定型，
     * 那时对不齐是"还没画完"而不是缺陷。真正的要求是：**异步渲染完成后必须收敛对齐**。
     * 判据 = 「最后一次异步渲染就绪之后的每个采样点」都 ≤3 行（末态对齐）。
     */
    const lastRenderedIdx = (() => {
      for (let i = seriesB.length - 1; i >= 0; i--) {
        if ((seriesB[i].katexNodes ?? 0) > 0 && (seriesB[i].mermaidSvgs ?? 0) > 0) return i;
      }
      return -1;
    })();
    const settledB = lastRenderedIdx >= 0 ? seriesB.slice(lastRenderedIdx) : seriesB.slice(-2);
    const settledMax = Math.max(...settledB.map((s) => (s.delta ?? 999)));
    check(
      "A4 编辑后：异步渲染完成后必须收敛对齐（渲染就绪后每次采样 |Δ行| ≤ 3）",
      settledB.length > 0 && settledMax <= 3,
      `渲染就绪自 t=${lastRenderedIdx >= 0 ? seriesB[lastRenderedIdx].t : "?"}ms 起，` +
        `Δ行=${settledB.map((s) => `${s.t}ms:${s.delta}`).join(" ")}`,
    );
    const deltasB = seriesB.map((s) => s.delta);
    const lastB = deltasB[deltasB.length - 1];
    check(
      "A4 编辑后：末态（1600ms）必须对齐（|Δ行| ≤ 3）",
      lastB !== null && lastB <= 3,
      `Δ行序列=${deltasB.map((d) => (d === null ? "n/a" : d)).join("→")}`,
    );

    // ── A5：异步渲染是否真的发生了（mermaid/katex 存在性）──
    const rendered = await ev(`
      const shell = document.querySelector(".split-preview-shell");
      const ifr = shell && shell.querySelector("iframe");
      const d = ifr && ifr.contentDocument;
      return {
        svg: d ? d.querySelectorAll("svg").length : -1,
        katex: d ? d.querySelectorAll(".katex").length : -1,
        mathBlock: d ? d.querySelectorAll(".math-block-preview").length : -1,
        tagged: d ? d.querySelectorAll("[data-src-line]").length : -1,
      };
    `);
    log(`  异步渲染结果：${JSON.stringify(rendered)}`);
    check(
      "A5 文档确实含异步渲染内容（否则本探针无意义）",
      (rendered?.svg ?? 0) > 0 || (rendered?.katex ?? 0) > 0,
      JSON.stringify(rendered),
    );

    // 内容保真（模式往返不得丢）
    const markerInSource = await ev(`
      const ta = document.querySelector("textarea.source-editor");
      return ta ? { has: ta.value.indexOf(${JSON.stringify(MARK)}) >= 0, len: ta.value.length } : null;
    `);
    check("编辑标记在模式往返后仍在（内容未丢）", !!markerInSource?.has, JSON.stringify(markerInSource));

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify({ seriesA, afterScroll, seriesB, rendered, markerInSource, checks }, null, 2),
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
