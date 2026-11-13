/**
 * v0.17.0 第三轮 · T2 · 第 12 项：**预览开合时文档宽度变化导致抖动，左屏要平滑**
 *
 * 用户原话：「上一轮的问题12继续修复，编辑模式下进行预览关闭和打开的操作中，
 * 文档的宽度会变宽或变窄，为了文档内容对齐，内容会实时调整，但这带来的是文档会抖动，
 * 要保证左屏尽量平滑，不要抖动。」
 *
 * ## 上一轮为什么误判"基线已良好"（R2 判据选错的复盘）
 * R2 量的是两件事：
 *   ① 开合**往返后**的滚动漂移（稳态两点差）→ 实测 0px
 *   ② 正文**左缘**在 24 种取值下 >12px 的"单帧跳变"次数 → 0 次
 * 这两个都是**稳态/粗粒度**指标，天生看不见用户说的东西：
 * 宽度过渡 420ms 期间，正文列宽**每帧都在变**，于是**每个词的换行位置在变**、
 * 文字在行内来回挤动 —— 那是"内容在重排过程中抖"，而稳态两点差必然为 0
 *（动画结束后回到终态）、12px 阈值对"每帧 1~3px 的持续挤动"也完全免疫。
 *
 * → **判据换成"动画期间的时间序列连续性"**：
 *   逐帧采样「同一段文字（PIxx 段落）的首字符屏幕 X」，看这条曲线的
 *   单调性 / 一阶差分（速度）/ 二阶差分（加速度 / 抖动）。
 *
 * ## 量化口径
 * | 量 | 定义 | 为什么代表用户感受 |
 * |---|---|---|
 * | `xNet` | 动画前后首字符 X 的净变化 | 应 ≈ 宽度变化量的一半（正文居中） |
 * | `maxV` | 相邻帧 X 位移的最大值 | 速度尖峰 = "咯噔一下" |
 * | `maxA` | 二阶差分最大值（速度的变化量） | 加速度尖峰 = 视觉上的"抖/颤" |
 * | `reversals` | X 位移方向反转次数 | 单调收窄是"平滑"，来回挤才是"抖" |
 * | `spikes` | `|a| > 2px/帧²` 的次数 | 两套动画相位不同 / snap 的指纹 |
 *
 * ## 已知线索（要验证，不是照抄）
 * `editor.css` 有「开合预览期间过渡抑制」：
 *   `body.split-resizing ... , .editor-main-area[data-lmd-mode-anim] ... { transition: none }`
 * 若开合预览**不在**抑制范围内 → 正常过渡（可测曲线）；
 * 若**在**范围内 → `transition:none` 会让宽度**一帧跳完**，
 *   反而是"先不变→突变"的两段跳（用户说的"突然抖一下"）。
 * 本探针同时测：过渡是否真的发生了（帧数 > 1）。
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t2" node scripts/v0170-r3-preview-toggle-smooth.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);
const CM = ".cm-scroller";

/**
 * 逐帧采样：正文锚段的「首字符屏幕 X/Y」+ 滚动容器几何 + 正文列宽。
 *
 * ⚠️ 为什么锚在 `PIxx` **段落的首字符**而不是段落元素本身：
 * CM6 的 `.cm-line` 整行宽度 = 视口宽度（不是文字宽度），段落的 left 恒等于
 * padding，量不出"文字在行内被挤"。而 `coordsAtPos` 语义的"首字符 X"才是
 * 用户眼睛跟着走的那个点。这里用 Range 选中该段第一个字符来取真实字形 X。
 */
const START_TRACE = (ms, anchorPi) => `
  window.__TR = [];
  (function () {
    /**
     * ⚠️ 锚点必须**固定成一个 PI 段号**，不能每帧重新选"离中线最近的那行"。
     * 原因（第一版实测）：宽度变化会引起软换行重排，中线附近的行会使锚点在
     * 相邻段落之间跳来跳去 → charY 单帧"跳" 57.6px（≈一个行高），
     * 那是**测量伪影**（锚点换了一行），不是产品抖动。
     * 固定 PI 后，charY 的真实变化才可比。
     */
    const ANCHOR_PI = ${JSON.stringify(String(anchorPi ?? ""))};
    const t0 = performance.now();
    const tick = () => {
      try {
      const sc = document.querySelector(${JSON.stringify(CM)});
      if (!sc) { window.__TR.push({ t: Math.round(performance.now() - t0), miss: 1 }); 
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); return; }
      const scR = sc.getBoundingClientRect();
      const rec = { t: Math.round(performance.now() - t0) };
      // 正文列宽 = scroller 的 content box（扣 padding）→ 宽度动画的直接观测量
      const cs = getComputedStyle(sc);
      rec.padL = Math.round(parseFloat(cs.paddingLeft) * 100) / 100;
      rec.padR = Math.round(parseFloat(cs.paddingRight) * 100) / 100;
      rec.colW = Math.round((sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * 100) / 100;
      rec.st = Math.round(sc.scrollTop * 100) / 100;
      rec.max = Math.round(sc.shadowRoot ? 0 : (sc.scrollHeight - sc.clientHeight));
      // 锚：视口中部含 PIxx 的行里，第一个字符的字形 X
      const midY = scR.top + sc.clientHeight / 2;
      let best = null, bestD = Infinity;
      for (const l of sc.querySelectorAll(".cm-line")) {
        const txt = l.textContent || "";
        if (!/PI\\d{2}/.test(txt)) continue;
        if (ANCHOR_PI && txt.indexOf(ANCHOR_PI) < 0) continue;
        const r = l.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - midY);
        if (d < bestD) { bestD = d; best = l; }
      }
      rec.anchorVisible = !!best;
      if (best) {
        const m = /PI(\\d{2})/.exec(best.textContent || "");
        rec.pi = m ? Number(m[1]) : null;
        // 首字符真实字形 X：Range 选第一个字符
        try {
          /**
           * CM6 的 cm-line 子节点是语法高亮的 span，不是文本节点
           *（第一版只找 nodeType === 3 的直接子节点 → 恒 undefined，
           * 于是「首字符 X」整条判据静默失效，差点被当成"产品不抖"）。
           * 用 TreeWalker 递归找第一个非空文本节点。
           */
          let tn = null;
          const w = document.createTreeWalker(best, NodeFilter.SHOW_TEXT);
          while (w.nextNode()) {
            const n = w.currentNode;
            if ((n.textContent || "").trim()) { tn = n; break; }
          }
          if (tn) {
            const rng = document.createRange();
            rng.setStart(tn, 0);
            rng.setEnd(tn, Math.min(1, tn.textContent.length));
            const rr = rng.getBoundingClientRect();
            rec.charX = Math.round((rr.left - scR.left) * 100) / 100;
            rec.charY = Math.round((rr.top - scR.top) * 100) / 100;
            // 该字符在文档内的绝对 X（扣掉滚动，滚动不变时可比）
            rec.charAbsX = Math.round((rr.left - scR.left + sc.scrollLeft) * 100) / 100;
          }
        } catch (e) {}
        const lr = best.getBoundingClientRect();
        rec.lineTop = Math.round((lr.top - scR.top) * 100) / 100;
      }
      window.__TR.push(rec);
      } catch (e) { window.__TERR = (window.__TERR || []); if (window.__TERR.length < 3) window.__TERR.push(String(e && e.stack || e)); }
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

/** 第一个"非零速度"出现在第几帧（用来判断两套动画是否同步起步） */
function firstMoveIdx(c) {
  if (!c.v) return -1;
  for (let i = 0; i < c.v.length; i++) if (Math.abs(c.v[i]) >= 0.05) return i + 1;
  return -1;
}

/** 一阶/二阶差分分析 */
function curve(samples, field) {
  const seq = samples.map((s) => s[field]).filter((v) => typeof v === "number");
  if (seq.length < 3) return { n: seq.length, insufficient: true };
  const v = [];
  for (let i = 1; i < seq.length; i++) v.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
  const a = [];
  for (let i = 1; i < v.length; i++) a.push(Math.round((v[i] - v[i - 1]) * 100) / 100);
  let maxV = 0, maxA = 0;
  const spikes = [];
  for (const x of v) if (Math.abs(x) > maxV) maxV = Math.abs(x);
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]) > maxA) maxA = Math.abs(a[i]);
    if (Math.abs(a[i]) > 2) spikes.push({ frame: i + 2, a: a[i] });
  }
  // 方向反转（忽略极小速度）
  const runs = [];
  for (const x of v) {
    if (Math.abs(x) < 0.05) continue;
    const s = x > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== s) runs.push(s);
  }
  return {
    n: seq.length,
    first: Math.round(seq[0] * 100) / 100,
    last: Math.round(seq[seq.length - 1] * 100) / 100,
    net: Math.round((seq[seq.length - 1] - seq[0]) * 100) / 100,
    maxV: Math.round(maxV * 100) / 100,
    maxA: Math.round(maxA * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    moveFrames: v.filter((x) => Math.abs(x) >= 0.05).length,
    spikes: spikes.slice(0, 15),
    spikesCount: spikes.length,
    v: v.slice(0, 60),
    a: a.slice(0, 60),
  };
}

await runBrowserProbe({ name: "v0170-r3-preview-toggle", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.command("view.edit");
  await ui.sleep(2000);
  const st0 = await ui.ev(`
    const sc = document.querySelector(${JSON.stringify(CM)});
    const shell = document.querySelector(".split-preview-shell");
    return {
      hasCm: !!sc,
      hasShell: !!shell,
      open: shell ? shell.classList.contains("split-preview-open") : null,
      colW: sc ? Math.round(sc.clientWidth) : 0,
    };
  `);
  ui.log("[setup] = " + JSON.stringify(st0));
  if (!st0.hasCm) {
    ui.add("A0", "编辑模式 + CM6 就绪", "FAIL", JSON.stringify(st0));
    return;
  }
  ui.add("A0", "编辑模式 + CM6 就绪", "PASS", JSON.stringify(st0));

  /* 滚到中部，让锚段稳定在视口内 */
  await ui.focusSource();
  await ui.sleep(300);
  for (let i = 0; i < 40; i++) {
    await ui.wheel(700, 500, 120);
    await ui.sleep(12);
  }
  await ui.sleep(700);
  const mid = await ui.ev(`
    const sc = document.querySelector(${JSON.stringify(CM)});
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const l of sc.querySelectorAll(".cm-line")) {
      if (!/PI\\d{2}/.test(l.textContent || "")) continue;
      const r = l.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = l; }
    }
    return { st: Math.round(sc.scrollTop), pi: best ? (/PI(\\d{2})/.exec(best.textContent || "") || [])[1] : null };
  `);
  ui.log("[setup] 中部锚 = " + JSON.stringify(mid));

  /* ── 测一次开合方向 ─────────────────────────────────────── */
  async function measureToggle(dir) {
    // dir: "close" | "open"
    const isOpen = await ui.ev(`
      const s = document.querySelector(".split-preview-shell");
      return s ? s.classList.contains("split-preview-open") : null;
    `);
    if ((dir === "close" && !isOpen) || (dir === "open" && isOpen)) {
      await ui.command("view.togglePreview");
      await ui.sleep(1300);
    }
    const before = await ui.ev(`
      const sc = document.querySelector(${JSON.stringify(CM)});
      const s = document.querySelector(".split-preview-shell");
      return { colW: Math.round(sc.clientWidth), st: Math.round(sc.scrollTop), open: s ? s.classList.contains("split-preview-open") : null };
    `);
    await ui.ev(`window.__TR = []; return true;`);
    await ui.ev(START_TRACE(1600, 'PI' + String(mid.pi).padStart(2, '0')));
    await ui.sleep(70);
    await ui.command("view.togglePreview");
    await ui.sleep(1800);
    const trace = await ui.ev(`return window.__TR || []`);
    const after = await ui.ev(`
      const sc = document.querySelector(${JSON.stringify(CM)});
      const s = document.querySelector(".split-preview-shell");
      return { colW: Math.round(sc.clientWidth), st: Math.round(sc.scrollTop), open: s ? s.classList.contains("split-preview-open") : null };
    `);
    return {
      dir, before, after, trace,
      col: curve(trace, "colW"),
      padL: curve(trace, "padL"),
      x: curve(trace, "charX"),
      y: curve(trace, "charY"),
      st: curve(trace, "st"),
    };
  }

  let closeT, openT;
  try { closeT = await measureToggle("close"); } catch (e) { ui.log("[ERR close] " + (e && e.stack || e)); throw e; }
  const perr = await ui.ev(`return window.__TERR || []`);
  if (perr.length) ui.log("[pageErr] " + JSON.stringify(perr));
  try { openT = await measureToggle("open"); } catch (e) { ui.log("[ERR open] " + (e && e.stack || e)); throw e; }

  for (const r of [closeT, openT]) {
    ui.log(`[${r.dir}] 列宽 ${r.before.colW} → ${r.after.colW} 净 ${r.col.net}px 动画帧=${r.col.moveFrames}`);
    ui.log(`[${r.dir}] 列宽曲线 v=${JSON.stringify(r.col.v?.slice(0, 40))}`);
    ui.log(`[${r.dir}] paddingLeft 曲线 v=${JSON.stringify(r.padL.v?.slice(0, 40))} 净=${r.padL.net}`);
    ui.log(`[${r.dir}] 首次移动帧：列宽=${firstMoveIdx(r.col)} padding=${firstMoveIdx(r.padL)} 首字符X=${firstMoveIdx(r.x)}`);
    ui.log(`[${r.dir}] 首字符X 净 ${r.x.net}px maxV=${r.x.maxV} maxA=${r.x.maxA} 反转=${r.x.reversals} 峰值=${r.x.spikesCount}`);
    ui.log(`[${r.dir}] 首字符X 速度 v=${JSON.stringify(r.x.v?.slice(0, 45))}`);
    ui.log(`[${r.dir}] 首字符X 加速度 a=${JSON.stringify(r.x.a?.slice(0, 45))}`);
    ui.log(`[${r.dir}] 字符Y 净 ${r.y.net}px maxV=${r.y.maxV} 反转=${r.y.reversals}`);
    ui.log(`[${r.dir}] scrollTop 净 ${r.st.net}px maxV=${r.st.maxV} 反转=${r.st.reversals}`);
  }

  /* ── 判据 ───────────────────────────────────────────────── */
  const dirOk = (r) => r.col.net !== 0 || r.after.colW !== r.before.colW;
  ui.add("A1", "开合确实改变了正文列宽（否则测不到宽度过渡）",
    dirOk(closeT) && dirOk(openT) ? "PASS" : "FAIL",
    `关：${closeT.before.colW}→${closeT.after.colW}；开：${openT.before.colW}→${openT.after.colW}`);

  ui.add("A2", "★ 宽度过渡是**逐帧**发生的（不是一帧 snap，否则用户看到两段跳）",
    closeT.col.moveFrames >= 8 && openT.col.moveFrames >= 8 ? "PASS" : "FAIL",
    `关：${closeT.col.moveFrames} 个移动帧；开：${openT.col.moveFrames} 个移动帧（需 ≥8 帧 ≈ 130ms）`);

  ui.add("B0", "★ 宽度与文字位移**同步起步**（否则用户看到「先不变→突变」两段跳）",
    (() => {
      const a = firstMoveIdx(closeT.col), b = firstMoveIdx(closeT.x);
      const a2 = firstMoveIdx(openT.col), b2 = firstMoveIdx(openT.x);
      if (a < 0 || b < 0 || a2 < 0 || b2 < 0) return "KNOWN";
      return Math.abs(a - b) <= 3 && Math.abs(a2 - b2) <= 3 ? "PASS" : "FAIL";
    })(),
    `关：列宽首动第 ${firstMoveIdx(closeT.col)} 帧 / 首字符X首动第 ${firstMoveIdx(closeT.x)} 帧；` +
    `开：列宽第 ${firstMoveIdx(openT.col)} 帧 / 首字符X第 ${firstMoveIdx(openT.x)} 帧（差 ≤3 帧为同步）`);

  ui.add("B1", "★ 首字符 X 曲线**单调**（无方向反转 = 文字不在行内来回挤）",
    closeT.x.reversals === 0 && openT.x.reversals === 0 ? "PASS" : "FAIL",
    `关：反转 ${closeT.x.reversals} 次（净 ${closeT.x.net}px）；开：反转 ${openT.x.reversals} 次（净 ${openT.x.net}px）；` +
    `关速度序列=${JSON.stringify(closeT.x.v?.slice(0, 30))}；开速度序列=${JSON.stringify(openT.x.v?.slice(0, 30))}`);

  ui.add("B2", "★ 首字符 X 二阶差分无尖峰（|a| ≤ 2px/帧²）",
    closeT.x.spikesCount === 0 && openT.x.spikesCount === 0 ? "PASS" : "FAIL",
    `关：${closeT.x.spikesCount} 个尖峰 maxA=${closeT.x.maxA}；开：${openT.x.spikesCount} 个尖峰 maxA=${openT.x.maxA}；` +
    `关 ${JSON.stringify(closeT.x.spikes.slice(0, 8))}；开 ${JSON.stringify(openT.x.spikes.slice(0, 8))}`);

  ui.add("B3", "★ 首字符 Y 不跳（宽度变化不应让文字纵向跳动）",
    closeT.y.maxV <= 2 && openT.y.maxV <= 2 && closeT.y.reversals === 0 && openT.y.reversals === 0 ? "PASS" : "FAIL",
    `关：maxV=${closeT.y.maxV}px 反转=${closeT.y.reversals} 净=${closeT.y.net}；开：maxV=${openT.y.maxV}px 反转=${openT.y.reversals} 净=${openT.y.net}`);

  ui.add("B4", "左屏 scrollTop 在开合期间不抖（R2 的旧判据，这里作为对照保留）",
    Math.abs(closeT.st.maxV) <= 5 && Math.abs(openT.st.maxV) <= 5 ? "PASS" : "FAIL",
    `关：maxV=${closeT.st.maxV}px 反转=${closeT.st.reversals} 净=${closeT.st.net}；开：maxV=${openT.st.maxV}px 反转=${openT.st.reversals} 净=${openT.st.net}`);

  /* 汇总判据：是否抖 */
  const jitters = (r) => r.x.reversals > 0 || r.x.spikesCount > 0 || r.y.maxV > 2;
  const anyJitter = jitters(closeT) || jitters(openT);
  ui.add("C0", "★★ 结论：#12 左屏内容在开合期间是否抖",
    "KNOWN",
    anyJitter ? "**可复现**（见 B1/B2/B3 哪个中招）" : "**未复现**（X 单调、无加速度尖峰、Y 不跳）");

  ui.log("[SUMMARY] " + JSON.stringify({
    close: { before: closeT.before, after: closeT.after, col: { net: closeT.col.net, frames: closeT.col.moveFrames, v: closeT.col.v?.slice(0, 30) }, x: closeT.x, y: closeT.y, st: closeT.st },
    open: { before: openT.before, after: openT.after, col: { net: openT.col.net, frames: openT.col.moveFrames, v: openT.col.v?.slice(0, 30) }, x: openT.x, y: openT.y, st: openT.st },
  }, null, 1));

  await ui.shot("preview-toggle");
});
