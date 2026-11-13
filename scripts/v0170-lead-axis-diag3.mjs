/**
 * Lead 诊断 3：决定性 —— 直接测 `measureBlockTops` 与行轴构建是否成功。
 *
 * 目的：区分三种失败：
 *   (a) measureBlockTops 返回 null（CM6 几何不可用）
 *   (b) measureBlockTops 有值，但 axis.length < totalLines（构建失败 → 纯函数层拒用）
 *   (c) axis 有值且长度够，但消费端没用上（对齐算法问题）
 *
 * 手法：在页面里通过 cm-content.cmTile.view 拿 EditorView，
 * 自己复刻 measureBlockTops 的算法（lineBlockAt + coordsAtPos），看能否量出值。
 * 同时读 `.cm-scroller` 的几何做对照。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const parts = ["# 行轴诊断3", ""];
for (let i = 1; i <= 40; i++) {
  parts.push(`## 第 ${i} 节标题`, "");
  parts.push(`第 ${i} 节的正文段落。这一段用于制造可滚动的行数与均匀的块结构，使左右两侧的「第 N 个顶层块」能够一一对应。长度保持均匀便于对比。`, "");
  parts.push(`- 要点 ${i}.1：对齐测试条目`, `- 要点 ${i}.2：对齐测试条目`, "");
}
const DOC = parts.join("\n");

await runProbe({ name: "v0170-lead-axis-diag3", doc: DOC, docTitle: "第 40 节" }, async (ui) => {
  // 先滚一下
  const box = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);
  for (let i = 0; i < 8; i++) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: 400, modifiers: 0 });
    await ui.sleep(120);
  }
  await ui.sleep(1500);

  const probe = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && (c.cmTile ? c.cmTile.view : null);
    if (!v) return { ok: false, why: "no EditorView" };
    const sc = document.querySelector(".cm-scroller");
    const doc = v.state.doc;
    const totalLines = doc.lines;
    // 取若干行做测量（复刻 measureBlockTops 的核心）
    const sampleLineNos = [1, 5, 10, 20, 40, 80, 120, 160, 200, 240, 280].filter(n => n <= totalLines);
    const tops = [];
    const errs = [];
    for (const ln of sampleLineNos) {
      try {
        const line = doc.line(ln);
        const block = v.lineBlockAt(line.from);
        let top = block.top;
        let src = "lineBlockAt";
        try {
          const co = v.coordsAtPos(line.from);
          if (co && Number.isFinite(co.top)) { top = co.top - v.documentTop; src = "coordsAtPos"; }
        } catch (e) { errs.push(ln + ":coords"); }
        tops.push({ ln, top: Math.round(top), h: Math.round(block.height), src });
      } catch (e) {
        errs.push(ln + ":block:" + String(e.message || e).slice(0, 40));
        tops.push({ ln, top: null, h: null, src: "ERR" });
      }
    }
    return {
      ok: true,
      totalLines,
      docLen: doc.length,
      scroller: sc ? { scrollTop: Math.round(sc.scrollTop), scrollHeight: Math.round(sc.scrollHeight), clientHeight: Math.round(sc.clientHeight) } : null,
      viewDocumentTop: typeof v.documentTop === "number" ? Math.round(v.documentTop) : null,
      tops,
      errs,
      // lineBlockAt 是否可用
      hasLineBlockAt: typeof v.lineBlockAt === "function",
      hasCoordsAtPos: typeof v.coordsAtPos === "function",
    };
  `);
  ui.log("[diag3] " + JSON.stringify(probe, null, 1));

  const okTops = (probe.tops || []).filter((t) => t.top !== null && Number.isFinite(t.top));
  ui.add("F1", "EditorView 可用", probe.ok ? "PASS" : "FAIL", probe.why || "ok");
  ui.add("F2", "lineBlockAt 可用", probe.hasLineBlockAt ? "PASS" : "FAIL", `hasLineBlockAt=${probe.hasLineBlockAt}`);
  ui.add("F3", "coordsAtPos 可用", probe.hasCoordsAtPos ? "PASS" : "FAIL", `hasCoordsAtPos=${probe.hasCoordsAtPos}`);
  ui.add("F4", "★ measureBlockTops 的底层能力能测出行 Y",
    okTops.length === (probe.tops || []).length && okTops.length > 0 ? "PASS" : "FAIL",
    `${okTops.length}/${(probe.tops || []).length} 条有效；样本=${JSON.stringify((probe.tops || []).slice(0, 5))}`);
  ui.add("F5", "行 Y 单调递增（行轴有效性的必要条件）",
    okTops.length > 2 && okTops.every((t, i, a) => i === 0 || t.top >= a[i - 1].top) ? "PASS" : "FAIL",
    `序列=${JSON.stringify(okTops.map(t => t.top))}`);

  await ui.shot("axis-diag3");
});
