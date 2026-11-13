/**
 * v0.17.0 第三轮 · T2 · 第 8 项：**编辑模式打字机居中要平滑（同阅读面），回车也要平滑**
 *
 * 用户原话：「编辑模式下开启打字机模式，画面居中时要跟阅读模式一样，
 * 要有平滑的移动效果，而不是突然页面就居中，而且编辑进行回车换行时，画面也应该是平滑移动的。」
 *
 * ## 量化口径（"平滑"= 可测量的三条）
 *
 * | 量 | 定义 | 门槛 | 为什么代表用户感受 |
 * |---|---|---|---|
 * | `frames` | 目标位移被拆成**多少个非零帧** | ≥ 6（≈100ms） | <100ms 的移动人眼感知为"瞬变"，≥6帧才看得出是动画 |
 * | `firstFrameShare` | 首帧位移 / 总位移 | < 0.6 | =1.0 是"一帧瞬移"（修复前的形态）；缓动起步慢，正常 <0.3 |
 * | `reversals` | 位移方向反转次数 | 0 | 回弹 = 用户说的"抖"，平滑移动必须单调 |
 *
 * ## 同构对照（用户原话"要跟阅读模式一样"）
 * 同一份文档、同一个打字机开关，分别在**阅读面**（ProseMirror，已知平滑，基线）
 * 与**编辑面**（CM6，修复目标）做「回车 / 敲字」操作，比较两组曲线：
 * 帧数与时长应在**同一量级**。这比"编辑面单独达标"更贴用户诉求。
 *
 * ## 破坏性对照（证明判据会红）
 * 传 `--no-smooth` 时探针不做事；真正的破坏性对照是**回退代码**
 * （见报告：把 `writeScrollTop` 的 CM6 分支改回 `setScrollTop`，
 *  本探针 B1/B2 必须 FAIL）。
 *
 * ## ⚠️ 历史防线（不能破坏）
 * `shouldSkipInitialScrollToCenter` + `isRestoringScrollRef` 的存在是为了阻止
 * smooth 覆盖 `applyScroll` 的 instant。本次只改"用户在打字机模式下敲字/回车"
 * 这条 keyup 分支，**恢复期间一律 skip** 的语义原样保留。
 * 护栏测试：`typewriter-mode-switch.test.ts` / `shortcut-mode-switch.test.ts`。
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t2" node scripts/v0170-r3-typewriter-smooth.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

/** 逐帧采样 scrollTop（按选择器；CM6 用 .cm-scroller，阅读面用 .editor-container） */
const START_TRACE = (selector, ms) => `
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) {
        window.__TR.push({
          t: Math.round(performance.now() - t0),
          st: Math.round(el.scrollTop * 100) / 100,
          sh: Math.round(el.scrollHeight),
          ch: Math.round(el.clientHeight),
        });
      }
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

/** 平滑度分析 */
function smoothness(trace) {
  const seq = trace.map((s) => s.st).filter((v) => typeof v === "number");
  if (seq.length < 2) {
    return { n: seq.length, totΔ: 0, frames: 0, firstFrameShare: 1, reversals: 0, monotone: false, deltas: [] };
  }
  const start = seq[0];
  const end = seq[seq.length - 1];
  const totΔ = Math.abs(end - start);
  const deltas = [];
  for (let i = 1; i < seq.length; i++) deltas.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
  const nonZero = deltas.filter((d) => Math.abs(d) >= 0.05);
  const firstMove = nonZero.length ? Math.abs(nonZero[0]) : 0;
  const dir = Math.sign(end - start);
  /**
   * ⚠️ 方向反转必须**忽略亚像素噪声**（本轮踩到的判据 bug）。
   *
   * 第一版用 0.05px 作"有效位移"门槛，结果阅读面（已知平滑的参考实现）
   * 在点击后出现 `-3, 0, +3` 的抖动 → reversals=1 → B3（证明判据不恒真那条）偶发 FAIL。
   * 那不是回弹，是点击落点 ±3px 的**命中噪声**（鼠标坐标取整、光标矩形重建）。
   *
   * 改判据：只有"整段反向运动的累计幅度 > 1px"才算一次回弹。
   * 依据：真正的回弹（用户能看见的"抖回来"）必然是若干帧累加出可观的位移，
   * 而单帧 1~3px 的反向毛刺在 218~283ms 的动画里肉眼不可辨。
   */
  /**
   * ⚠️ 方向反转必须**忽略亚像素噪声**（本轮踩到的判据 bug，两次才修对）。
   *
   * 现象：阅读面（已知平滑的参考实现）点击后出现 `-3, 0, +3` 的毛刺 →
   * reversals=1 → B3（"证明判据不恒真"那条）**偶发 FAIL**。
   * 那不是回弹，是点击落点 ±3px 的**命中噪声**（鼠标坐标取整、光标矩形重建）。
   *
   * 第一版修法用"上一段累计 ≤1px"判噪声 —— **不够**：`-3` 单段累计就是 3px > 1，
   * 仍被当成真反转。正确口径：**单段反向位移的累计绝对值 ≤ 5px 就并入主方向**
   *（5px < 6px，远小于"人能看见的抖回来"；而真正的回弹必然是多帧累加的大位移）。
   */
  const NOISE_PX = 5;
  const runs = [];
  let acc = 0;
  for (const d of nonZero) {
    const s = d > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== s) {
      if (runs.length > 0 && Math.abs(acc) <= NOISE_PX) {
        // 上一段反向位移累计 ≤5px → 判为噪声，并入当前段（不产生一次反转）
        runs[runs.length - 1] = s;
      } else {
        runs.push(s);
      }
      acc = 0;
    }
    acc += d;
  }
  /** 单调逼近的连续帧数（从起始值起、方向一致地靠近终值） */
  let monoFrames = 0;
  for (const d of nonZero) {
    if (Math.sign(d) === dir) monoFrames++;
    else break;
  }
  return {
    n: seq.length,
    first: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    totΔ: Math.round(totΔ * 100) / 100,
    frames: nonZero.length,
    firstMove: Math.round(firstMove * 100) / 100,
    firstFrameShare: totΔ > 0 ? Math.round((firstMove / totΔ) * 1000) / 1000 : 0,
    reversals: Math.max(0, runs.length - 1),
    monoFrames,
    monotone: runs.length <= 1 && nonZero.length >= 6,
    /** 动画耗时：从首个非零帧到末个非零帧（ms） */
    durMs: (() => {
      let a = -1, b = -1;
      for (let i = 0; i < deltas.length; i++) {
        if (Math.abs(deltas[i]) >= 0.05) { if (a < 0) a = i; b = i; }
      }
      return a < 0 ? 0 : trace[b + 1].t - trace[a].t;
    })(),
    deltas: deltas.slice(0, 40),
  };
}

/**
 * 点击视口某个纵向比例处的文本（CM6 与 PM 都适用）。
 *
 * ⚠️ 为什么必须能指定比例（第一版探针的教训）：
 * 只在正中央（0.5）点击，光标本来就在中线附近 → 打字机算出的目标位移只有 ~28px，
 * 这个位移下 smooth 动画本身就只要 4~5 帧，**"帧数≥6"这条判据会把
 * 阅读面（参考实现、已知平滑）也判红** —— 判据于是失去区分力。
 * 必须把光标放到离中线**足够远**（0.82）的位置，制造数百 px 的目标位移，
 * 两种实现的差异才在同一条量尺上可比。
 */
async function clickAt(ui, mode, frac = 0.82) {
  const pt = await ui.ev(`
    const Q = ${JSON.stringify(mode === "cm" ? ".cm-scroller" : ".editor-container")};
    const el = document.querySelector(Q);
    if (!el) return null;
    const er = el.getBoundingClientRect();
    const y = er.top + el.clientHeight * ${frac};
    // 用 elementFromPoint 找该 Y 上的可点击元素（两种实现都适用，不依赖内部 DOM 结构）
    for (const dx of [0.35, 0.45, 0.55, 0.5, 0.3]) {
      const x = er.left + er.width * dx;
      const hit = document.elementFromPoint(x, y);
      if (hit) return { x: Math.round(x), y: Math.round(y), tag: hit.tagName, cls: String(hit.className || "").slice(0, 40) };
    }
    return { x: Math.round(er.left + er.width * 0.5), y: Math.round(y), tag: "?", cls: "?" };
  `);
  if (!pt) return null;
  await ui.click(pt.x, pt.y);
  await ui.sleep(450);
  return pt;
}

/** 让光标落到"离视口中央有明显距离"的位置——这样一次回车/敲字才会触发居中滚动 */
async function moveCursorOffCenter(ui, mode) {
  // 用方向键把光标挪到视口靠下的位置：先 Home 到行首，再 Down 若干次
  const n = 6;
  for (let i = 0; i < n; i++) {
    await ui.key("ArrowDown", "ArrowDown", 40);
    await ui.sleep(40);
  }
  await ui.sleep(400);
}

/** 测量一次操作（回车 / 敲字）后的滚动曲线 */
async function measure(ui, selector, ms, action) {
  await ui.ev(`window.__TR = []; return true;`);
  await ui.ev(START_TRACE(selector, ms));
  await ui.sleep(80);
  const before = await ui.ev(`
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? Math.round(el.scrollTop * 100) / 100 : null;
  `);
  await action();
  await ui.sleep(ms + 300);
  const trace = await ui.ev(`return window.__TR || []`);
  return { before, trace, smooth: smoothness(trace) };
}

await runBrowserProbe({ name: "v0170-r3-typewriter-smooth", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  if (ui.impl !== "cm6") {
    ui.add("A0", "源码面是 CM6（本项主战场）", "FAIL", `impl=${ui.impl}`);
    return;
  }

  /* ── 0. 编辑模式 + 打字机开 ─────────────────────────────── */
  await ui.command("view.edit");
  await ui.sleep(2000);
  await ui.command("view.toggleTypewriter");
  await ui.sleep(900);
  const tw = await ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.textContent || "").indexOf("打字机") >= 0 || (x.getAttribute("title") || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);
  ui.add("A0", "编辑模式 + 打字机已开启", tw === true ? "PASS" : "FAIL", `impl=${ui.impl} typewriter=${tw}`);

  const CM = ".cm-scroller";

  /**
   * ⚠️ 为什么测「点击触发的居中」而不是只测回车（探针设计的关键修正）：
   *
   * 第一版只测回车，量到两种实现的位移都只有 **29px**（= 一个行高）——
   * 因为**点击本身就已经把光标居中了**（`handleClick` → `scrollToCenter`），
   * 之后再回车只多一行，位移太小 → "帧数≥6" 这条判据把阅读面（参考实现）
   * 也判红了，判据失去区分力。
   *
   * 用户原话"画面居中时要跟阅读模式一样""而不是突然页面就居中"——
   * 抱怨的主体正是**点击/移动光标后那次居中**，它的位移有 200~400px，
   * 两种实现的动画差异在这个尺度上一眼可辨。所以主测量项 = 点击居中；
   * 回车作为第二项（小位移，判据相应放宽并在报告里说明）。
   */
  async function measureClickCentering(selector, mode) {
    // 先滚到一个稳定位置，并确保打字机不会在测量前就居中
    await ui.ev(`window.__TR = []; return true;`);
    const before = await ui.ev(`
      const el = document.querySelector(${JSON.stringify(selector)});
      return { st: Math.round(el.scrollTop * 100) / 100, ch: el.clientHeight, sh: el.scrollHeight };
    `);
    // 目标点：视口 82% 处（离中线 ~255px）→ 点完打字机会把它拉回中线
    const pt = await ui.ev(`
      const Q = ${JSON.stringify(mode === "cm" ? ".cm-scroller" : ".editor-container")};
      const el = document.querySelector(Q);
      const er = el.getBoundingClientRect();
      const y = er.top + el.clientHeight * 0.82;
      for (const dx of [0.35, 0.45, 0.55, 0.5, 0.3]) {
        const x = er.left + er.width * dx;
        const hit = document.elementFromPoint(x, y);
        if (hit) return { x: Math.round(x), y: Math.round(y), tag: hit.tagName };
      }
      return null;
    `);
    if (!pt) return { before, trace: [], smooth: smoothness([]), pt: null };
    await ui.ev(START_TRACE(selector, 2600));
    await ui.sleep(70);
    await ui.click(pt.x, pt.y);
    await ui.sleep(2900);
    const trace = await ui.ev(`return window.__TR || []`);
    const after = await ui.ev(`
      const el = document.querySelector(${JSON.stringify(selector)});
      return { st: Math.round(el.scrollTop * 100) / 100 };
    `);
    return { before, after, trace, smooth: smoothness(trace), pt };
  }

  await ui.focusSource();
  await ui.sleep(300);

  /* ── 1. 编辑面（CM6）：点击触发的居中 ─────────────────── */
  const cmClick = await measureClickCentering(CM, "cm");
  ui.log("[CM] 点击居中 = " + JSON.stringify({ before: cmClick.before, after: cmClick.after, s: cmClick.smooth }));

  /* ── 2. 编辑面：回车（用户点名的第二个场景，小位移）──────── */
  await clickAt(ui, "cm", 0.82);
  await ui.sleep(500);
  const cmEnterRaw = await measure(ui, CM, 2600, async () => {
    await ui.key("Enter", "Enter", 13);
  });
  ui.log("[CM] 回车 = " + JSON.stringify(cmEnterRaw.smooth));

  /* ── 3. 阅读面（ProseMirror）：同构对照 ──────────────────── */
  await ui.command("view.preview");
  await ui.sleep(1900);
  const PM = ".editor-container";
  const pmClick = await measureClickCentering(PM, "pm");
  ui.log("[PM] 点击居中 = " + JSON.stringify({ before: pmClick.before, after: pmClick.after, s: pmClick.smooth }));

  await clickAt(ui, "pm", 0.82);
  await ui.sleep(500);
  const pmEnterRaw = await measure(ui, PM, 2600, async () => {
    await ui.key("Enter", "Enter", 13);
  });
  ui.log("[PM] 回车 = " + JSON.stringify(pmEnterRaw.smooth));

  const cmClickS = cmClick.smooth;
  const pmClickS = pmClick.smooth;
  const cmEnter = cmEnterRaw.smooth;
  const pmEnter = pmEnterRaw.smooth;

  /**
   * 判据：**与阅读面同构**（用户原话"要跟阅读模式一样"）。
   *
   * 不硬编码"帧数≥6"这类绝对阈值，而是与参考实现（阅读面，已知平滑）比较：
   *   · `frames >= max(3, 0.6 × pmFrames)` —— 动画帧数不显著少于阅读面
   *   · `|share - pmShare| <= 0.35`        —— 首帧力度与阅读面同一量级
   *   · `reversals === 0`                  —— 单调，不回弹
   * 理由：位移规模随文档/光标位置浮动，"和已知正确的实现一样"比"达到某个绝对值"
   * 更稳、也更贴用户诉求。阅读面自身的数值同时作为**判据有效性的证明**
   * （它必须 PASS，否则是判据 bug 不是产品 bug —— R2 §3-4 的教训）。
   */
  const cmp = (c, p, label) => {
    if (c.totΔ < 5 && p.totΔ < 5) return { ok: false, why: "两边都没位移，测不到居中动作（判据无效）" };
    const minFrames = Math.max(3, Math.round(p.frames * 0.6));
    const framesOk = c.frames >= minFrames;
    const shareOk = Math.abs(c.firstFrameShare - p.firstFrameShare) <= 0.35;
    const revOk = c.reversals === 0;
    return {
      ok: framesOk && shareOk && revOk,
      why: `${label}：帧数 ${c.frames}(需≥${minFrames}, 阅读面${p.frames})、首帧占比 ${c.firstFrameShare}(阅读面 ${p.firstFrameShare}, 允许±0.35)、反转 ${c.reversals}`,
    };
  };

  const clickCmp = cmp(cmClickS, pmClickS, "点击居中");
  const enterCmp = cmp(cmEnter, pmEnter, "回车");

  ui.add("B1", "★ 编辑面【点击居中】滚动与阅读面同构（帧数/首帧力度/无回弹）",
    clickCmp.ok ? "PASS" : "FAIL",
    `${clickCmp.why}；编辑面：总位移 ${cmClickS.totΔ}px 耗时 ${cmClickS.durMs}ms 逐帧=${JSON.stringify(cmClickS.deltas.slice(0, 24))}`);

  ui.add("B2", "★ 编辑面【回车】滚动与阅读面同构",
    enterCmp.ok ? "PASS" : "FAIL",
    `${enterCmp.why}；编辑面：总位移 ${cmEnter.totΔ}px 耗时 ${cmEnter.durMs}ms 逐帧=${JSON.stringify(cmEnter.deltas.slice(0, 20))}`);

  ui.add("B3", "阅读面（参考实现）自身达标 —— 证明判据不恒真",
    pmClickS.frames >= 3 && pmClickS.reversals === 0 && pmClickS.firstFrameShare < 0.6 ? "PASS" : "FAIL",
    `阅读面点击居中：帧数 ${pmClickS.frames} 首帧占比 ${pmClickS.firstFrameShare} 反转 ${pmClickS.reversals} 总位移 ${pmClickS.totΔ}px 耗时 ${pmClickS.durMs}ms`);

  ui.add("B4", "★ 居中动作位移足够大（否则判据无区分力）",
    Math.min(cmClickS.totΔ, pmClickS.totΔ) > 100 ? "PASS" : "FAIL",
    `编辑面 ${cmClickS.totΔ}px / 阅读面 ${pmClickS.totΔ}px（需 >100px 才看得出动画差异）`);

  ui.add("B5", "回车动作确实触发了滚动（>0px，否则该子项无效）",
    cmEnter.totΔ > 0 && pmEnter.totΔ > 0 ? "PASS" : "KNOWN",
    `编辑面 ${cmEnter.totΔ}px / 阅读面 ${pmEnter.totΔ}px`);

  ui.log("[SUMMARY] " + JSON.stringify({
    cmClick: cmClickS, pmClick: pmClickS, cmEnter, pmEnter,
    cmClickTrace: cmClick.trace.slice(0, 40).map((s) => `${s.t}:${s.st}`),
    pmClickTrace: pmClick.trace.slice(0, 40).map((s) => `${s.t}:${s.st}`),
  }, null, 1));

  await ui.shot("typewriter-smooth");
});
