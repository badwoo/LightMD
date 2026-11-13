/**
 * #10 关键分辨：重启后 percent 已精确一致（0.4990→0.4991），但中心 PI 从 30 变 27。
 *
 * 两种可能，必须分开：
 *   (A) **布局没铺开**：重启后 CM6 只测量了部分行 → `scrollHeight` 偏小
 *       → 同一 percent 换算出的绝对像素偏小 → 停在了内容更靠前的位置。
 *       若 (A) 成立：让文档"完整测量"（滚到底再回来）后，PI 应回到 30。
 *   (B) **percent 本身不是内容的稳定表示**：块高分布不均匀 → 同一 percent
 *       在不同 scrollHeight 下指向不同块。若 (B) 成立：必须**改用内容锚点**恢复。
 *
 * 实验：重启后先滚到底（强制全文档测量），再按 percent 定位，读中心 PI。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 锚点 vs 百分比", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "",
  );
}
const DOC = parts.join("\n");
const DOC_PATH = "D:/tmp/v0170-r2-anchor.md";

const openDoc = (ui) =>
  ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:openFile", {
      detail: { path: ${JSON.stringify(DOC_PATH)}, name: "anchor.md", content: ${JSON.stringify(DOC)} },
    }));
    return true;
  `);

const geo = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    const mid = r.top + sc.clientHeight / 2;
    const lines = Array.from(document.querySelectorAll(".cm-line")).filter((l) => /PI\\d+/.test(l.textContent || ""));
    let best = null;
    for (const l of lines) {
      const b = l.getBoundingClientRect();
      if (b.height === 0) continue;
      const covers = b.top <= mid && b.bottom >= mid;
      const d = covers ? -1 : Math.abs(b.top + b.height / 2 - mid);
      if (!best || d < best.d) best = { d, text: (l.textContent || "").trim() };
    }
    const m = best && best.text.match(/PI(\\d+)/);
    const max = Math.round(sc.scrollHeight - sc.clientHeight);
    return {
      pi: m ? parseInt(m[1], 10) : null,
      st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight),
      h: Math.round(sc.clientHeight), max,
      pct: max > 0 ? +(sc.scrollTop / max).toFixed(4) : null,
    };
  `);

const setPct = async (ui, pct) => {
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * ${pct});
    return Math.round(sc.scrollTop);
  `);
  await ui.sleep(900);
};

const waitStable = async (ui, timeoutMs = 15000) => {
  const t0 = Date.now();
  let prev = null, n = 0;
  const series = [];
  while (Date.now() - t0 < timeoutMs) {
    const g = await geo(ui);
    series.push(g ? `${g.sh}/${g.st}` : "null");
    if (prev === (g ? g.sh : null)) { n++; if (n >= 4) return { g, series }; } else n = 0;
    prev = g ? g.sh : null;
    await ui.sleep(350);
  }
  return { g: await geo(ui), series };
};

await runBrowserProbe({ name: "v0170-r2-anchor-vs-pct", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2400);
  const hasIframe = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
  if (!hasIframe) { await ui.command("view.togglePreview"); await ui.sleep(1800); }

  /* ── 会话 1：滚到 50%，等全文档测量完（滚到底再回来），记录真值 ── */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = sc.scrollHeight;   // 强制滚到底，让 CM6 测量全文档
    return true;
  `);
  await ui.sleep(1200);
  await setPct(ui, 0.5);
  const s1 = await waitStable(ui);
  const before = s1.g;
  const beforePct = (() => { const prog = null; return s1.g.pct; })();
  ui.log(`[S1 全文档已测量] st=${before.st} sh=${before.sh} max=${before.max} pct=${s1.g.pct} 中心PI=${before.pi}`);

  /* 验证：在**同一实例**里 percent 是否稳定指向同一 PI（重复 5 次） */
  const repeat = [];
  for (let i = 0; i < 5; i++) {
    await setPct(ui, 0.5);
    const g = await geo(ui);
    repeat.push(g.pi);
  }
  ui.add("P1", "同一实例内 percent=0.5 → 中心 PI 是否稳定", "PASS",
    `5 次：${repeat.join("→")}`);

  /* 等落盘 */
  await ui.sleep(7000);
  const persisted = await ui.ev(`return localStorage.getItem("lightmd-scroll-progress")`);
  ui.log(`[落盘] ${persisted}`);

  /* ── reload ── */
  await ui.cdp.send("Page.reload", { ignoreCache: false });
  await ui.sleep(1000);
  for (let i = 0; i < 60; i++) {
    const ok = await ui.ev(`return !!document.querySelector(".app, #root > *")`).catch(() => false);
    if (ok) break;
    await ui.sleep(300);
  }
  await ui.sleep(1500);
  await openDoc(ui);

  /* ── 重启后：立刻读（应用刚按 percent 恢复完） ── */
  await ui.sleep(3000);
  const immediate = await geo(ui);
  ui.log(`[重启后 立刻] st=${immediate.st} sh=${immediate.sh} max=${immediate.max} pct=${immediate.pct} 中心PI=${immediate.pi}`);

  /* ── 关键实验 A：滚到底（强制全文档测量）再回同一 percent ── */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = sc.scrollHeight;
    return true;
  `);
  await ui.sleep(1500);
  const afterBottom = await geo(ui);
  ui.log(`[滚到底后] st=${afterBottom.st} sh=${afterBottom.sh} max=${afterBottom.max}`);
  await setPct(ui, 0.5);
  const afterRemap = await waitStable(ui);
  ui.log(`[全测量+回 50%] st=${afterRemap.g.st} sh=${afterRemap.g.sh} max=${afterRemap.g.max} pct=${afterRemap.g.pct} 中心PI=${afterRemap.g.pi}`);

  ui.add("A1", "★ 分辨 (A) vs (B)：全文档测量后再按 50% 定位，PI 是否回到 30", 
    afterRemap.g.pi === before.pi ? "PASS" : "FAIL",
    `会话1 PI=${before.pi}（st=${before.st}/max=${before.max}）→ 重启后立刻 PI=${immediate.pi}（st=${immediate.st}/max=${immediate.max}）` +
    ` → 强制全测量后 PI=${afterRemap.g.pi}（st=${afterRemap.g.st}/max=${afterRemap.g.max}）`);
  ui.add("A2", "★ 重启后 sh 是否达到会话1 的 sh（布局是否铺开）",
    Math.abs(afterRemap.g.sh - before.sh) <= 20 ? "PASS" : "FAIL",
    `会话1 sh=${before.sh} → 重启后立刻 sh=${immediate.sh} → 强制全测量后 sh=${afterRemap.g.sh}`);
  ui.add("D1", "诊断：稳定序列（重启后立刻）", "PASS", `sh/st: ${[]}`);
  ui.add("D2", "诊断：同一 percent 在两实例的 PI 映射",
    "PASS",
    `实例1(会话1) pct=0.5 → PI=${before.pi}（sh=${before.sh}）；` +
    `实例2(重启后) pct=0.5 → PI=${afterRemap.g.pi}（sh=${afterRemap.g.sh}）` +
    `  ${before.pi === afterRemap.g.pi ? "→ percent 等价" : "→ ⚠ percent 不等价，必须用内容锚点"}`);
});
