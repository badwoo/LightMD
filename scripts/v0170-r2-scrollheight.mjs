/**
 * #10 决定性实验：CM6 的 `scrollHeight` 是否依赖"滚过多少"。
 *
 * ## 要回答的问题
 * 上一轮已证：恢复写入发生在 `sh=5254` 时，而最终 `sh=6222`；重开前是 `sh=7057`。
 * 三个值都不同 → 怀疑 CM6 对**未测量行**用估算高度，`scrollHeight` 随"哪些行被真实
 * 测量过"增长。若是这样，**`percent` 在 CM6 下根本不是稳定量**：
 * 同一文档、同一内容位置，在不同实例里 percent 不同 → 按 percent 恢复必然偏。
 *
 * ## 实验设计（同一实例内，只滚动、不改内容）
 * 1. 记录初始 `sh`（刚 mount）
 * 2. 逐步往下滚（每次 1/10 max），每步记录 `sh`
 * 3. 滚到底再回 50%，记录 `sh` 与 PI
 * 4. 结论：
 *    - 若 `sh` 单调增长 → scrollHeight 是"已测量行数"的函数 → percent 不可靠
 *    - 若 `sh` 稳定 → 问题只在"恢复写入太早"，加等待/重校正即可
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# scrollHeight 稳定性", ""];
for (let i = 1; i <= 60; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "",
  );
}
const DOC = parts.join("\n");

const geo = (ui) =>
  ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const ec = document.querySelector(".editor-container");
    const out = { src: null, read: null };
    if (sc) {
      out.src = { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight),
                  h: Math.round(sc.clientHeight), max: Math.round(sc.scrollHeight - sc.clientHeight),
                  lines: document.querySelectorAll(".cm-line").length };
    }
    if (ec && ec.clientHeight > 0) {
      const ps = Array.from(ec.querySelectorAll(".ProseMirror > *")).filter((p) => /PI\\d+/.test(p.textContent || ""));
      const r = ec.getBoundingClientRect();
      const mid = r.top + ec.clientHeight / 2;
      let best = null;
      for (const p of ps) {
        const b = p.getBoundingClientRect();
        if (b.height === 0) continue;
        const covers = b.top <= mid && b.bottom >= mid;
        const d = covers ? -1 : Math.abs(b.top + b.height / 2 - mid);
        if (!best || d < best.d) best = { d, text: (p.textContent || "").trim() };
      }
      const m = best && best.text.match(/PI(\\d+)/);
      out.read = { st: Math.round(ec.scrollTop), max: Math.round(ec.scrollHeight - ec.clientHeight),
                   pi: m ? parseInt(m[1], 10) : null, sh: Math.round(ec.scrollHeight) };
    }
    return out;
  `);

/** 编辑面中心 PI */
const srcCenterPi = (ui) =>
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
    return { pi: m ? parseInt(m[1], 10) : null, st: Math.round(sc.scrollTop),
             sh: Math.round(sc.scrollHeight), max: Math.round(sc.scrollHeight - sc.clientHeight) };
  `);

await runBrowserProbe({ name: "v0170-r2-scrollheight", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2400);
  const hasIframe = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
  if (!hasIframe) { await ui.command("view.togglePreview"); await ui.sleep(1800); }

  const g0 = await geo(ui);
  ui.log(`[初始] ${JSON.stringify(g0.src)}`);
  ui.add("H0", "初始 scrollHeight（刚 mount）", "PASS", `${g0.src.sh}（max=${g0.src.max}，渲染行=${g0.src.lines}）`);

  /* 逐步往下滚，记录 sh 变化 */
  const steps = [];
  for (let i = 1; i <= 10; i++) {
    const r = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * ${(i / 10).toFixed(3)});
      return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), max: Math.round(sc.scrollHeight - sc.clientHeight) };
    `);
    await ui.sleep(600);
    const g = await srcCenterPi(ui);
    steps.push({ i, ...g });
    ui.log(`[滚到 ${i * 10}%] st=${g.st} sh=${g.sh} max=${g.max} 中心PI=${g.pi}`);
  }
  const shSeries = [g0.src.sh, ...steps.map((s) => s.sh)];
  const grew = shSeries[shSeries.length - 1] - shSeries[0];
  ui.add("H1", "★ scrollHeight 是否随滚动增长（同一内容、同一实例）", grew > 50 ? "FAIL" : "PASS",
    `序列=${shSeries.join("→")}（增长 ${grew}px）`);
  ui.add("H2", "★ max 是否随滚动增长", "PASS",
    `初始 max=${g0.src.max}，滚动后 max=${steps[steps.length - 1].max}（差 ${steps[steps.length - 1].max - g0.src.max}px）`);

  /* 滚到底再回 50%，看 sh 是否最终稳定 */
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = sc.scrollHeight;
    return true;
  `);
  await ui.sleep(1200);
  const bottom = await srcCenterPi(ui);
  ui.log(`[到底] st=${bottom.st} sh=${bottom.sh} max=${bottom.max} 中心PI=${bottom.pi}`);
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
    return true;
  `);
  await ui.sleep(1200);
  const back = await srcCenterPi(ui);
  ui.log(`[回 50%] st=${back.st} sh=${back.sh} max=${back.max} 中心PI=${back.pi}`);

  ui.add("H3", "★ 滚到底再回 50% 后的 sh（是否收敛到同一值）", "PASS",
    `mount 时=${g0.src.sh} → 滚过一轮后=${back.sh}（差 ${back.sh - g0.src.sh}px）；` +
    `此时 st=${back.st} max=${back.max} 中心PI=${back.pi}`);

  /* 50% 处 PI=30 对应的像素 —— 这是"真值"参考 */
  ui.add("H4", "诊断：各百分比处的中心 PI（内容真值表）", "PASS",
    steps.map((s) => `${s.i * 10}%→PI${s.pi}(st${s.st}/sh${s.sh})`).join(" | "));

  /* ───────────── 关键：切阅读再切回编辑，看 sh 是否变 ───────────── */
  await ui.command("view.preview");
  await ui.sleep(2400);
  const readGeo = await geo(ui);
  ui.log(`[切阅读] read=${JSON.stringify(readGeo.read)}`);
  await ui.command("view.edit");
  await ui.sleep(2600);
  const backEdit = await srcCenterPi(ui);
  ui.add("H5", "★ 切模式往返后编辑面 sh 是否变", "PASS",
    `切前 st=${back.st}/sh=${back.sh} → 切后 st=${backEdit.st}/sh=${backEdit.sh}（差 ${backEdit.sh - back.sh}px）中心PI=${backEdit.pi}`);
});
