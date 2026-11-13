/**
 * #10 诊断：CM6 的 scrollHeight 在 mount 之后如何变化（"恢复写太早"假设的验证）。
 *
 * 假设：`fileScrollProgress` 恢复是**一次性**写入（`computeRestoreScrollTop` 非 null
 * 就不再重试），而 CM6 的 `scrollHeight` 在 mount 后仍会持续增长（视口外行按需测量/估算）
 * → 写入时 max 偏小 → 恢复出的绝对像素偏小 → 用户看到"进度回去了一点"。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 诊断", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "",
  );
}
const DOC = parts.join("\n");
const DOC_PATH = "D:/tmp/v0170-r2-diag.md";

const openDoc = (ui) =>
  ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:openFile", {
      detail: { path: ${JSON.stringify(DOC_PATH)}, name: "diag.md", content: ${JSON.stringify(DOC)} },
    }));
    return true;
  `);

const geo = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    return {
      t: Math.round(performance.now()),
      st: Math.round(sc.scrollTop),
      sh: Math.round(sc.scrollHeight),
      h: Math.round(sc.clientHeight),
      max: Math.round(sc.scrollHeight - sc.clientHeight),
      lines: document.querySelectorAll(".cm-line").length,
      docLines: (window.__cmDocLines ?? null),
    };
  `);

const sampleFor = async (ui, label, ms, everyMs = 250) => {
  const t0 = Date.now();
  const out = [];
  while (Date.now() - t0 < ms) {
    out.push(await geo(ui));
    await ui.sleep(everyMs);
  }
  ui.log(`[${label}] ${out.map((g) => `${g ? `st${g.st}/sh${g.sh}/max${g.max}/L${g.lines}` : "null"}`).join(" | ")}`);
  return out;
};

await runBrowserProbe({ name: "v0170-r2-diag-layout", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2600);
  await openDoc(ui);

  ui.log("[阶段1] openDoc 之后立刻连续采样 8s");
  const phase1 = await sampleFor(ui, "phase1", 8000);
  const firstSh = phase1.find(Boolean)?.sh;
  const lastSh = [...phase1].reverse().find(Boolean)?.sh;
  ui.add("G1", "openDoc 后 scrollHeight 是否在长（首末差）", "PASS",
    `首=${firstSh} 末=${lastSh} 差=${(lastSh ?? 0) - (firstSh ?? 0)}px`);

  ui.log("[阶段2] 再多等 8s，看是否继续长");
  const phase2 = await sampleFor(ui, "phase2", 8000, 500);
  const p2last = [...phase2].reverse().find(Boolean)?.sh;
  ui.add("G2", "再等 8s 后是否继续长", "PASS", `此时 sh=${p2last}（阶段1末=${lastSh}，差=${(p2last ?? 0) - (lastSh ?? 0)}）`);

  /* 滚到 50%，等落盘 */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(sc.scrollTop);
  `);
  await ui.sleep(7000);
  const before = await geo(ui);
  const beforePct = before.st / Math.max(1, before.max);
  ui.log(`[before] st=${before.st} max=${before.max} pct=${beforePct.toFixed(4)} sh=${before.sh} L=${before.lines}`);

  /* reload */
  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(1200);
  for (let i = 0; i < 60; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(300);
  }
  await ui.sleep(1500);
  await openDoc(ui);

  ui.log("[阶段3] reload+openDoc 之后立刻连续采样 12s（看恢复写入后的几何变化）");
  const phase3 = await sampleFor(ui, "phase3", 12000, 250);
  const p3 = phase3.filter(Boolean);
  const afterLast = p3[p3.length - 1];
  const afterPct = afterLast.st / Math.max(1, afterLast.max);

  ui.add("G3", "恢复后 percent 与重启前是否一致（一次性写入的代价）", "PASS",
    `前 pct=${beforePct.toFixed(4)}（st=${before.st}/max=${before.max}） 后 pct=${afterPct.toFixed(4)}（st=${afterLast.st}/max=${afterLast.max}） 差=${Math.abs(afterPct - beforePct).toFixed(4)}`);
  ui.add("G4", "恢复写入时刻的 max（推测）", "PASS",
    `若一次性写入：写入时 max ≈ st恢复 / pct = ${Math.round(afterLast.st / beforePct)}；最终 max=${afterLast.max}；差=${afterLast.max - Math.round(afterLast.st / beforePct)}px`);
  ui.add("G5", "sh 序列（前 20 个采样）", "PASS", p3.slice(0, 20).map((g) => `st${g.st}/sh${g.sh}`).join(" | "));
});
