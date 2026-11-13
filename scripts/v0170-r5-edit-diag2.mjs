/**
 * v0.17.0 第五轮 · V2 诊断：**R4#4 回车抖动的两处"脱同步"到底是真缺陷还是判据假象？**
 *
 * ## 背景（`v0170-r5-edit.mjs` 第四轮的真机数据）
 * ```
 * 左屏 st : 2477.33 → 2478.67 → 2484.67 → … → 2902.67   （25 帧 / 425px / 反转 0，平滑 ✓）
 * 右屏 deST: 2470.67 → 2499.33 → 2505.33 → … → 2899.33
 *                    ↑ +28.66（左屏才 +1.34）        ↑ −5.33（左屏 +7.33）
 * 逐帧比值 右Δ/左Δ: [21.39, 1.00, 0.95, 0.97, 0.97, … , 1.00, **−0.73**, 1.00, …]
 * ```
 * 中间 18 帧比值恒在 **0.94~1.00** ⇒ 主体跟随完全正确。
 * 只有 **首帧 +28.66** 与 **第 16 帧 −5.33** 两处异常。
 *
 * ## 本诊断要定位的
 * ### 疑点 A：首帧 +28.66px
 * 左屏动画才走 1.34px，右屏已跳 28.66px。三种可能：
 * - **A1 内容还在变高**：回车 → iframe 重渲染 → 块高变化 → 右屏被"重对齐"一次
 *   → 判据应为「**tags / scrollHeight 在首帧前后是否变化**」
 * - **A2 我们的窗口未覆盖**：`syncToPreview` 在动画开始前就写了一次
 * - **A3 动画开始前的一次 normal 吸附**（R4 已认定 ≤60px 的吸附不算抖）
 *
 * ### 疑点 B：第 16 帧 −5.33px
 * 左屏继续 +7.33，右屏却退 −5.33。可能：
 * - **B1 `realignLayoutNow` 的收尾校正**（R4 已认定"左屏停止后的吸附"不算抖，
 *   但这里左屏**还在动**）
 * - **B2 内容撑高（tags 7→8、scrollHeight 6180→6193）后的重对齐** —— 这是**正确行为**，
 *   因为内容变高了，同一 scrollTop 指向不同内容，必须重算
 *
 * ## 判据（本诊断用）
 * 对每一处异常帧，记录其**前后 3 帧**的 `tags` / `scrollHeight` / `contentHeight`：
 * - 若异常帧同时伴随 `tags` 或 `scrollHeight` 变化 ⇒ **内容驱动**（正确行为）
 * - 若三者完全不变却出现跳变 ⇒ **纯滚动错写**（真缺陷）
 *
 * 用法：
 *   node scripts/v0170-r5-edit-diag2.mjs
 */
import { runProbe, sleep, ROOT } from "./_lib/probe-harness.mjs";

const FIXTURE_MARK = "V2诊断2夹具";
const LINES = ["", `# ${FIXTURE_MARK}`, "正文二 V20。", "", "正文四 V21。", "", ""];
for (let i = 0; i < 200; i++) LINES.push(`填充行${String(i + 30).padStart(3, "0")} V2fill`);
const DOC = LINES.join("\n");

/** 逐帧采样：左屏 / 右屏 / tags / 右屏 scrollHeight / iframe body 高度 / 锚点数 */
const START_TRACE = (ms) => String.raw`
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const rec = { t: Math.round(performance.now() - t0) };
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
      }
      const f = document.querySelector("iframe.split-preview");
      if (f) {
        try {
          const d = f.contentDocument;
          const se = d && (d.scrollingElement || d.documentElement);
          if (se) {
            rec.deST = Math.round(se.scrollTop * 100) / 100;
            rec.deSH = Math.round(se.scrollHeight);
            rec.tags = d.querySelectorAll("[data-src-line]").length;
            rec.bodyH = d.body ? Math.round(d.body.getBoundingClientRect().height * 100) / 100 : null;
            /** 首/末锚点的 srcLine —— 能看出锚点表是否被整体重建 */
            const tg = d.querySelectorAll("[data-src-line]");
            if (tg.length) {
              rec.firstLine = Number(tg[0].dataset.srcLine);
              rec.lastLine = Number(tg[tg.length - 1].dataset.srcLine);
            }
          }
        } catch (e) { rec.err = String(e).slice(0, 30); }
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < MS_P) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`.replace("MS_P", String(ms));

await runProbe(
  { name: "v0170-r5-edit-diag2", doc: DOC, docTitle: FIXTURE_MARK, viewMode: "edit" },
  async (ui) => {
    ui.__shotDir = ui.path.join(ROOT, "_verify-out", "shots");
    await ui.fs.mkdirSync(ui.__shotDir, { recursive: true });
    await ui.focusSource();
    await sleep(600);

    // 确保分屏预览在
    const hasIframe = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
    if (!hasIframe) { await ui.command("view.togglePreview"); await sleep(1600); }

    // 打字机开
    const tw = await ui.ev(`
      const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
        .find((x) => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
      return b ? b.classList.contains("active") : null;
    `);
    if (tw !== true) { await ui.command("view.toggleTypewriter"); await sleep(900); }
    const twAfter = await ui.ev(`
      const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
        .find((x) => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
      return b ? b.classList.contains("active") : null;
    `);
    ui.add("I0", "打字机已开启 + 分屏存在", twAfter === true ? "PASS" : "FAIL", `tw=${twAfter}`);

    const wheel = async (x, y, d) => {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: d, pointerType: "mouse" });
      await sleep(16);
    };
    const box = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2),
               st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
    `);
    // 滚到中部
    let cur = box.st, guard = 0;
    while (cur > 8 && guard++ < 400) { await wheel(box.x, box.y, -Math.min(560, cur)); cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`); }
    guard = 0;
    const target = Math.round(box.max * 0.5);
    while (cur < target - 8 && guard++ < 800) {
      await wheel(box.x, box.y, Math.min(140, target - cur));
      const nx = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
      if (nx === cur) break;
      cur = nx;
    }
    await sleep(500);

    // 光标放到视口 0.85
    const pt = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      const y = Math.round(r.top + sc.clientHeight * 0.85);
      for (const dx of [0.45, 0.55, 0.35]) {
        const x = Math.round(r.left + sc.clientWidth * dx);
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit.closest(".cm-content") || hit.classList.contains("cm-line"))) return { x, y };
      }
      return null;
    `);
    if (pt) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      }
      await sleep(400);
    }
    await sleep(900);

    const pre = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const f = document.querySelector("iframe.split-preview");
      let de = null;
      try { const d = f && f.contentDocument; const se = d && (d.scrollingElement || d.documentElement);
            if (se) de = { st: Math.round(se.scrollTop), sh: Math.round(se.scrollHeight), tags: d.querySelectorAll("[data-src-line]").length }; } catch (e) {}
      return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: sc.clientHeight, de };
    `);
    ui.log("[pre] " + JSON.stringify(pre));

    /* ── 跑两次回车，看两处异常是否稳定复现 ── */
    for (let round = 0; round < 2; round++) {
      await ui.ev(START_TRACE(2000));
      await sleep(120);
      await ui.key("Enter", "Enter", 13);
      await sleep(2400);
      const trace = await ui.ev(`return window.__TR || []`);
      ui.log(`\n════ 第 ${round + 1} 次回车：逐帧（t:左st/右st/tags/右sh/bodyH）════`);
      for (const s of trace.slice(0, 40)) {
        ui.log(`  ${String(s.t).padStart(4)}: ${s.st}/${s.deST}/T${s.tags}/sh${s.deSH}/b${s.bodyH}`);
      }

      // 找异常帧
      const rows = [];
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1], b = trace[i];
        if (typeof a.st !== "number" || typeof b.st !== "number") continue;
        if (typeof a.deST !== "number" || typeof b.deST !== "number") continue;
        const dl = b.st - a.st, dr = b.deST - a.deST;
        if (Math.abs(dl) < 1) continue;
        const ratio = dr / dl;
        if (ratio < 0.3 || ratio > 3) {
          rows.push({
            i, t: b.t, dl: Math.round(dl * 100) / 100, dr: Math.round(dr * 100) / 100, ratio: Math.round(ratio * 100) / 100,
            /** ★ 内容是否在这一帧变化 */
            tagsBefore: a.tags, tagsAfter: b.tags,
            deSHBefore: a.deSH, deSHAfter: b.deSH,
            bodyHBefore: a.bodyH, bodyHAfter: b.bodyH,
            contentChanged: a.tags !== b.tags || a.deSH !== b.deSH || a.bodyH !== b.bodyH,
          });
        }
      }
      ui.log(`\n[异常帧 ${rows.length} 处]`);
      for (const r of rows) {
        ui.log(`  t=${r.t}ms 左Δ=${r.dl} 右Δ=${r.dr} 比值=${r.ratio} | ` +
          `tags ${r.tagsBefore}→${r.tagsAfter} | 右sh ${r.deSHBefore}→${r.deSHAfter} | bodyH ${r.bodyHBefore}→${r.bodyHAfter} | ` +
          `**内容变化=${r.contentChanged}**`);
      }
      ui.add(`R${round + 1}-A`, `第${round + 1}次回车：异常帧是否由**内容变化**驱动（正确）而非纯滚动错写`,
        rows.length === 0 ? "PASS" : (rows.every((r) => r.contentChanged) ? "PASS" : "FAIL"),
        rows.length === 0
          ? "无脱同步帧"
          : rows.map((r) => `t=${r.t} 比值${r.ratio} 内容变化=${r.contentChanged}`).join("；"));

      // 记录整段的 tags/sh 变化点
      const changePoints = [];
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1], b = trace[i];
        if (a.tags !== b.tags || a.deSH !== b.deSH) changePoints.push({ t: b.t, tags: [a.tags, b.tags], sh: [a.deSH, b.deSH], left: b.st, right: b.deST });
      }
      ui.log(`[内容变化点 ${changePoints.length} 处] ` + JSON.stringify(changePoints.slice(0, 8)));
    }

    await ui.shot("diag2");
    ui.log("[done]");
  },
);
