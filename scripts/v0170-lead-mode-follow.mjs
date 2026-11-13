/**
 * Lead 复核：P1-4「阅读→编辑」方向的位置跟随（D2 修复验证）。
 *
 * 探针报告 `阅读 88%(PI22) → 编辑 PI21`，只差 1 个段落。
 * 但它的辅助文案里还残留 `≈ 0.5004`（切换前的旧值），容易误读成"完全没跟随"。
 *
 * 本探针用更直接的口径：
 *   1. 阅读模式滚到指定百分比，记录**视口中心段落编号**
 *   2. 切到编辑模式，等稳定，记录**视口中心那一行的文字**
 *   3. 判断：编辑侧中心是否出现在阅读侧中心段落的邻域（±1 段）
 * 再重复多次，看是否稳定。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const parts = ["# 模式位置跟随", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(`第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。Lorem ipsum dolor sit amet, consectetur adipiscing elit.`, "");
}
const DOC = parts.join("\n");

const visible = async (ui, sel) => ui.ev(`
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
`);

await runProbe({ name: "v0170-lead-mode-follow", doc: DOC, docTitle: "PI01" }, async (ui) => {
  const results = [];

  for (const targetPct of [0.3, 0.55, 0.8]) {
    /* ── 1. 进阅读，滚到 targetPct，读中心段落 ── */
    await ui.command("view.preview");
    await ui.sleep(2200);

    await ui.ev(`
      const c = document.querySelector(".editor-container");
      const max = Math.max(0, c.scrollHeight - c.clientHeight);
      c.scrollTop = max * ${targetPct};
      c.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    `);
    await ui.sleep(1200);

    const readCenter = await ui.ev(`
      const c = document.querySelector(".editor-container");
      const mid = c.getBoundingClientRect().top + c.clientHeight / 2;
      const ps = Array.from(c.querySelectorAll(".ProseMirror > *"));
      let best = null;
      for (const p of ps) {
        const r = p.getBoundingClientRect();
        const d = Math.abs((r.top + r.height / 2) - mid);
        if (!best || d < best.d) best = { d, text: (p.textContent || "").trim() };
      }
      const m = best && best.text.match(/PI(\\d+)/);
      return { pi: m ? parseInt(m[1], 10) : null, text: best ? best.text.slice(0, 40) : null,
               pct: Math.round(c.scrollTop / Math.max(1, c.scrollHeight - c.clientHeight) * 1000) / 1000 };
    `);

    /* ── 2. 切编辑，读中心行文字里的 PI ── */
    await ui.command("view.edit");
    await ui.sleep(2600);

    const editCenter = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      if (!sc) return null;
      const scR = sc.getBoundingClientRect();
      const midY = scR.top + scR.height / 2;
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      let best = null;
      for (const l of lines) {
        const r = l.getBoundingClientRect();
        if (r.height === 0) continue;
        const d = Math.abs((r.top + r.height / 2) - midY);
        if (!best || d < best.d) best = { d, text: (l.textContent || "").trim() };
      }
      const m = best && best.text.match(/PI(\\d+)/);
      return { pi: m ? parseInt(m[1], 10) : null, text: best ? best.text.slice(0, 40) : null,
               st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight),
               pct: Math.round(sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight) * 1000) / 1000 };
    `);

    results.push({ targetPct, read: readCenter, edit: editCenter });
    ui.log(`[follow ${targetPct}] 阅读中心 PI${readCenter.pi}(pct=${readCenter.pct}) → 编辑中心 PI${editCenter?.pi}(pct=${editCenter?.pct}, st=${editCenter?.st}/${editCenter?.max})`);
  }

  const withBoth = results.filter((r) => r.read?.pi != null && r.edit?.pi != null);
  const diffs = withBoth.map((r) => Math.abs(r.read.pi - r.edit.pi));
  const worst = diffs.length ? Math.max(...diffs) : null;
  ui.add("S1", "产生有效对照样本", withBoth.length >= 2 ? "PASS" : "FAIL", `${withBoth.length}/${results.length}`);
  ui.add("S2", "★ 阅读→编辑 位置跟随精度（中心段落编号差）",
    worst === null ? "FAIL" : worst <= 1 ? "PASS" : worst <= 3 ? "KNOWN" : "FAIL",
    worst === null ? "无样本" :
      `最差 ${worst} 段（≤1 PASS / 2–3 KNOWN / >3 FAIL）；各点=[${withBoth.map((r) => `阅读PI${r.read.pi}→编辑PI${r.edit.pi}`).join(", ")}]`);

  await ui.shot("mode-follow");
});
