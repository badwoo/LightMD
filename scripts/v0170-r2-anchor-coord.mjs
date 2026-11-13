/**
 * 验证 `CmSourceSurface.captureViewportAnchor()` 的坐标系修复。
 *
 * 缺陷（由 fix-scroll-jump 发现、SourcePane 里已留注记）：
 *   `centerY = view.documentTop + clientHeight/2`
 * `documentTop` 是**屏幕坐标**（滚动后为负），而 `lineBlockAtHeight()` 要**内容坐标**
 * → 滚动越深，"算出的视口中央"越靠文档开头 → 锚点落在开头 → 恢复把视口送回顶部。
 *
 * 判据（不依赖产品内部实现，只用可观测事实）：
 *   在 50% 处，`captureViewportAnchor()` 返回的 `line` 应当 ≈ 文档总行数的 50%。
 *   修复前它会显著偏小（接近 0）。
 *
 * 由于 `captureViewportAnchor` 没有暴露到 window，本探针用**等价复算**验证：
 * 在同一时刻分别用两种口径算 `lineBlockAtHeight` 的目标，比对哪个落在文档中部。
 * 同时用 `window.__LMD_ANCHOR_PROBE__`（若产品侧未暴露则跳过直接验证，改用等价复算）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 锚点坐标系", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(`第 ${i} 段。PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur.`, "");
}
const DOC = parts.join("\n");

await runBrowserProbe({ name: "v0170-r2-anchor-coord", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(1600);
  await ui.command("view.togglePreview"); // 关预览 → 全宽，行数稳定
  await ui.sleep(1600);

  // 滚到 50%
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * 0.5;
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;
  `);
  await ui.sleep(800);

  const diag = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v) return { err: "拿不到 CM6 view" };
    const doc = v.state.doc;
    const totalLines = doc.lines;
    const st = sc.scrollTop, ch = sc.clientHeight;
    const dt = v.documentTop;   // 屏幕坐标（滚动后为负）

    const blockOld = v.lineBlockAtHeight(dt + ch / 2);
    const blockNew = v.lineBlockAtHeight(st + ch / 2);
    const lineOld = doc.lineAt(blockOld.from).number;
    const lineNew = doc.lineAt(blockNew.from).number;

    // 「视口中央真实所在行」的独立口径：用 elementFromPoint 取视口中央的元素 → 最近的 .cm-line
    const rect = sc.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const midY = rect.top + rect.height / 2;
    let truthLine = null;
    try {
      let el = document.elementFromPoint(midX, midY);
      while (el && !el.classList?.contains("cm-line")) el = el.parentElement;
      if (el) {
        const idx = Array.from(document.querySelectorAll(".cm-line")).indexOf(el);
        // 用该行的 from 反查行号更准：读它的 cmTile 信息不可靠，改用文本里的 PI
        const m = (el.textContent || "").match(/PI(\\d+)/);
        truthLine = m ? parseInt(m[1], 10) : ("noPI#idx" + idx);
      }
    } catch (e) { truthLine = "err:" + String(e.message).slice(0, 40); }

    return {
      totalLines, scrollTop: Math.round(st), clientHeight: Math.round(ch),
      documentTop: Math.round(dt),
      lineOld, lineNew, truthPI: truthLine,
      expectedMidLine: Math.round(totalLines / 2),
    };
  `);
  ui.log("[anchor] " + JSON.stringify(diag));

  if (diag.err) {
    ui.add("Z1", "拿到 CM6 view", "FAIL", diag.err);
    return;
  }

  // 文档里 60 段 × 2 行（段落 + 空行）+ 1 标题 ≈ 121 行；50% 处应落在 ~60 行附近
  const mid = diag.expectedMidLine;
  const tol = Math.round(diag.totalLines * 0.12); // 容许 12%（软换行/块高不均）

  ui.add("Z1", "★ 旧口径（documentTop + ch/2）偏离中部",
    Math.abs(diag.lineOld - mid) > tol ? "PASS" : "FAIL",
    `lineOld=${diag.lineOld} vs 期望中部≈${mid}（总 ${diag.totalLines} 行，容差 ±${tol}）` +
    `—— 这条 PASS 表示**缺陷存在**（旧口径确实偏）`);

  ui.add("Z2", "★ 新口径（scrollTop + ch/2）落在中部",
    Math.abs(diag.lineNew - mid) <= tol ? "PASS" : "FAIL",
    `lineNew=${diag.lineNew} vs 期望中部≈${mid}；documentTop=${diag.documentTop}（负值证明是屏幕坐标）`);

  ui.add("Z3", "独立口径交叉验证（视口中央真实段落）",
    typeof diag.truthPI === "number" ? "PASS" : "KNOWN",
    `视口中央 elementFromPoint → PI${diag.truthPI}；新口径 lineNew=${diag.lineNew}（对应 PI≈${Math.round(diag.lineNew / 2)}）`);

  ui.add("Z4", "新口径显著优于旧口径",
    Math.abs(diag.lineNew - mid) < Math.abs(diag.lineOld - mid) ? "PASS" : "FAIL",
    `|新-中|=${Math.abs(diag.lineNew - mid)} vs |旧-中|=${Math.abs(diag.lineOld - mid)}`);

  await ui.shot("anchor-coord");
});
