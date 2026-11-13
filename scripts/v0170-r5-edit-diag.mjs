/**
 * v0.17.0 第五轮 · V2 诊断：#46 行文档为何只报 max=174px？
 *
 * ## 问题（`v0170-r5-edit.mjs` 第二轮的 V2-6/V2-7 前置断言失败）
 * ```
 * A2: 左屏已滚到中部 st=87
 * A6: 文档可滚动 max=174
 * A3(第二轮): 测量后 max=174，测量前 174   ← 滚到底也没变
 * ```
 * 按 46 行 × 28.79px + padding 80 ≈ 1404 内容高、视口 759 推算，`max` 应 ≈ 645。
 * 实测只有 **174**，且"先滚到底强制测量"**完全没让它增长**。
 *
 * ## 必须分清的三类原因（判据完全不同）
 * | 类 | 机制 | 判据 |
 * |---|---|---|
 * | **A 探针 bug** | 我的夹具文档没真正装入 / 被前面用例改短了 / 取错滚容器 | `docLines` ≠ 46 或 `scrollHeight` 与行数不匹配 |
 * | **B CM6 heightMap 未测量** | 视口外区块用估算高度，滚到底应触发测量 → `max` **应变大** | 滚到底后 `max` 显著变大 |
 * | **C 真实布局问题** | `.cm-scroller` 的 `clientHeight` 异常大（把内容区挤没了） | `clientHeight` ≫ 视口 | 
 *
 * ## 本诊断要打的量（全只读）
 * - `docLines` / `doc.length`（确认夹具完整）
 * - `scrollHeight` / `clientHeight` / `scrollTop` / `max`
 * - `.cm-content` 的实测高度、`.cm-line` 数量与首个/末个行盒 Y
 * - `.cm-scroller` 与 `.editor-main-area` 的 rect（找出"谁把高度吃掉了"）
 * - 滚到底**前后**的 `scrollHeight`（判定 B vs C）
 *
 * 用法：
 *   node scripts/v0170-r5-edit-diag.mjs
 */
import { runProbe, sleep, ROOT } from "./_lib/probe-harness.mjs";

const FIXTURE_MARK = "V2诊断夹具";
const DOC_LINES = ["", `# ${FIXTURE_MARK}`, "正文二 V20。", "", "正文四 V21。", "", ""];
for (let i = 0; i < 34; i++) DOC_LINES.push(`填充行${String(i + 30).padStart(2, "0")} V2fill`);
const DOC = DOC_LINES.join("\n");

const READ_GEOM = String.raw`
  const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  const sc = document.querySelector(".cm-scroller");
  const content = document.querySelector(".cm-content");
  const ed = document.querySelector(".cm-editor");
  const main = document.querySelector(".editor-main-area");
  const host = document.querySelector(".source-editor-cm6") || document.querySelector("[class*='source-editor']");
  const c = document.querySelector(".cm-content");
  let view = null;
  try { view = c && c.cmTile && c.cmTile.view; } catch (e) {}
  const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: round(r.top), h: round(r.height), w: round(r.width) }; };
  const lines = sc ? Array.from(sc.querySelectorAll(".cm-line")) : [];
  return {
    docLines: view ? view.state.doc.lines : null,
    docLen: view ? view.state.doc.length : null,
    docTail: view ? view.state.doc.toString().slice(-60) : null,
    sc: sc ? { sh: round(sc.scrollHeight), ch: round(sc.clientHeight), st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight), rect: rectOf(sc), overflowY: getComputedStyle(sc).overflowY, padTop: getComputedStyle(sc).paddingTop, padBottom: getComputedStyle(sc).paddingBottom } : null,
    contentRect: rectOf(content),
    contentSh: content ? round(content.scrollHeight) : null,
    editorRect: rectOf(ed),
    mainRect: rectOf(main),
    hostRect: rectOf(host),
    /** 视口内 .cm-line 的数量与首末 Y（CM6 虚拟化：只有视口内的行在 DOM） */
    domLineCount: lines.length,
    firstLineTop: lines.length ? round(lines[0].getBoundingClientRect().top) : null,
    lastLineTop: lines.length ? round(lines[lines.length - 1].getBoundingClientRect().top) : null,
    firstLineH: lines.length ? round(lines[0].getBoundingClientRect().height) : null,
    /** CM6 的 heightMap 内部视图口径（只读） */
    viewportFrom: view ? round(view.viewport.from) : null,
    viewportTo: view ? round(view.viewport.to) : null,
    contentHeightCached: view && view.contentHeight !== undefined ? round(view.contentHeight) : null,
    docHeightCached: view && view.docHeight !== undefined ? round(view.docHeight) : null,
    /** body / 主区是否被前面用例改过 */
    bodyClass: document.body.className,
    htmlClass: document.documentElement.className,
    theme: document.documentElement.getAttribute("data-theme"),
    winH: window.innerHeight, winW: window.innerWidth,
  };
`;

await runProbe(
  { name: "v0170-r5-edit-diag", doc: DOC, docTitle: FIXTURE_MARK, viewMode: "edit" },
  async (ui) => {
    await ui.focusSource();
    await sleep(600);

    const A = await ui.ev(READ_GEOM);
    ui.log("[diag] 初始几何 = " + JSON.stringify(A, null, 1));
    ui.add("D1", "夹具完整（46 行 / 560 字符）", A.docLines === 46 && A.docLen === 560 ? "PASS" : "FAIL",
      `docLines=${A.docLines}（期望 46）docLen=${A.docLen}（期望 560）`);

    const wheel = async (x, y, deltaY) => {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, pointerType: "mouse" });
      await sleep(20);
    };
    const box = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2) };
    `);
    ui.log("[diag] 滚轮坐标 = " + JSON.stringify(box));

    /* ── 逐次滚到底，每步记录 scrollHeight（判定 heightMap 是否在被修正）── */
    const steps = [];
    for (let i = 0; i < 60; i++) {
      await wheel(box.x, box.y, 400);
      const g = await ui.ev(READ_GEOM);
      steps.push({ i, st: g.sc && g.sc.st, sh: g.sc && g.sc.sh, max: g.sc && g.sc.max, dom: g.domLineCount, vpTo: g.viewportTo });
      if (i > 2 && steps[i].st === steps[i - 1].st) break;
    }
    ui.log("[diag] 滚到底过程（st / sh / max / DOM行数 / viewportTo）：");
    for (const s of steps) ui.log(`  #${s.i} st=${s.st} sh=${s.sh} max=${s.max} domLines=${s.dom} vpTo=${s.vpTo}`);

    const B = await ui.ev(READ_GEOM);
    ui.log("[diag] 到底后几何 = " + JSON.stringify(B.sc) + " contentRect=" + JSON.stringify(B.contentRect) + " contentSh=" + B.contentSh);
    ui.add("D2", "滚到底能把 scrollHeight 修正到真值（判定 heightMap vs 真实布局）",
      B.sc && B.sc.sh > A.sc.sh + 50 ? "PASS" : "FAIL",
      `scrollHeight ${A.sc && A.sc.sh} → ${B.sc && B.sc.sh}（差 ${B.sc && A.sc ? Math.round(B.sc.sh - A.sc.sh) : "?"}px）；` +
      `若差≈0 说明**不是 heightMap 估算问题**，是内容真的只有这么高`);

    /* ── 与理论值对比（46 行 × 行高 + padding）── */
    const theory = {
      lineH: A.firstLineH,
      pad: A.sc ? (parseFloat(A.sc.padTop) + parseFloat(A.sc.padBottom)) : null,
    };
    theory.expectContentH = theory.lineH && theory.pad !== null ? Math.round(46 * theory.lineH + theory.pad) : null;
    theory.expectMax = theory.expectContentH && A.sc ? Math.round(theory.expectContentH - A.sc.ch) : null;
    ui.log("[diag] 理论值 = " + JSON.stringify(theory));
    ui.add("D3", "实测 scrollHeight 与理论值一致（46 行全部计入）",
      B.sc && theory.expectContentH && Math.abs(B.sc.sh - theory.expectContentH) <= 30 ? "PASS" : "FAIL",
      `实测 sh=${B.sc && B.sc.sh}，理论 ${theory.expectContentH}（46 行 × ${theory.lineH}px + padding ${theory.pad}px）` +
      `；差 ${B.sc && theory.expectContentH ? Math.round(B.sc.sh - theory.expectContentH) : "?"}px`);

    /* ── 关键：谁把视口高度吃掉了？── */
    ui.log("[diag] 各层高度：window.innerHeight=" + A.winH +
      " main=" + JSON.stringify(A.mainRect) +
      " editor=" + JSON.stringify(A.editorRect) +
      " host=" + JSON.stringify(A.hostRect) +
      " scroller=" + JSON.stringify(A.sc && A.sc.rect) +
      " content=" + JSON.stringify(A.contentRect));
    ui.add("D4", "滚动器视口高度合理（不被上层压缩）",
      A.sc && A.sc.ch > 300 ? "PASS" : "FAIL",
      `.cm-scroller clientHeight=${A.sc && A.sc.ch}（window=${A.winH}、main=${A.mainRect && A.mainRect.h}、host=${A.hostRect && A.hostRect.h}）` +
      `；content 实测高=${A.contentRect && A.contentRect.h}`);

    /* ── 内容是否被折叠/隐藏（.cm-line 的 DOM 行数 vs 文档行数）── */
    ui.log(`[diag] DOM 行=${A.domLineCount} vs 文档行=${A.docLines}；viewport=[${A.viewportFrom},${A.viewportTo}]`);
    const cachedH = A.contentHeightCached !== null ? A.contentHeightCached : A.docHeightCached;
    ui.add("D5", "CM6 内部 contentHeight 与实测 scrollHeight 一致",
      cachedH !== null && A.sc && Math.abs(cachedH + theory.pad - A.sc.sh) <= 40 ? "PASS" : "KNOWN",
      `view.contentHeight=${A.contentHeightCached} / view.docHeight=${A.docHeightCached}（+padding ${theory.pad} 应≈ scrollHeight ${A.sc && A.sc.sh}）`);

    // 回顶，留一张图便于人工核对
    for (let i = 0; i < 40; i++) {
      const st = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
      if (st <= 4) break;
      await wheel(box.x, box.y, -560);
    }
    await sleep(400);
    await ui.shot("diag-geom");

    ui.log("[diag] 环境 = " + JSON.stringify({
      ua: await ui.ev(`return navigator.userAgent.slice(0, 80)`),
      dpr: await ui.ev(`return window.devicePixelRatio`),
      impl: ui.impl,
    }));
  },
);
