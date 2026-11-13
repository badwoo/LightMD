/**
 * #11 单变量对照：**文件切换时 CM6 scrollTop 是否被重置？**
 *
 * ## 已确证的机制（v0170-r3-diag-ab.mjs 抓到的调用栈）
 * A 滚到底 → 打开 B，`scrollTop` 在首帧就是 `max`。写入栈是：
 * ```
 * at Cn.measure (@codemirror/view:1230:11712)   ← CM6 自己的 measure()
 * ```
 * 对应 CM6 源码 `@codemirror/view/dist/index.js` 的 scroll anchoring 分支：
 * ```js
 * this.scrolledToBottom = elt.scrollTop > Math.max(1, elt.scrollHeight - elt.clientHeight - 4);
 * // ...
 * let scrollAnchor = this.scrolledToBottom ? null : this.scrollAnchorAt(this.scrollOffset);
 * if (scrollAnchor) { this.scrollAnchorPos = ... } else { this.scrollAnchorPos = -1; }
 * // ... 补偿时：
 * else if (scrollAnchorPos < 0) scroll.scrollTop = scroll.scrollHeight;   // ← 到底
 * ```
 * 即：**同一 CM6 实例跨文档保留 scrollDOM.scrollTop**，旧值处于"贴底"状态时
 * → 锚点被判为 null → CM6 把新文档直接推到 scrollHeight。
 *
 * ## 本探针要回答的单一问题
 * 触发条件是「A 在底部」，还是「文件切换没有重置 scrollTop」？
 * 单变量设计：**只改 A 打开前的 scrollTop**，其余全部不变。
 *
 * | 组 | A 的位置 | 期望（正确语义） | 若"继承残留"则 |
 * |---|---|---|---|
 * | G0 | 顶部 st=0        | B: st=0        | B: st=0        |
 * | G1 | 中部 st=50%      | B: st=0        | B: st≈50%      |
 * | G2 | 底部 st=max      | B: st=0        | B: st=max      |
 *
 * 同时测**阅读面**（`.editor-container`）的同三组，以及"无进度文件"这条前提
 * （`fileScrollProgress.get(key) === null` → 现有代码直接 return，不做任何写入）。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function paragraphs(n, tag) {
  const out = [`# 对照 ${tag}`, ""];
  for (let i = 1; i <= n; i++) {
    out.push(
      `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")}。` +
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.",
      "",
    );
  }
  return out.join("\n");
}

const DOC_A = paragraphs(40, "AAA");
const DOC_B = paragraphs(120, "BBB");
const DOC_C = paragraphs(70, "CCC");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-r3-t5-grad-"));

const GEOM = `
  const sc = document.querySelector(".cm-scroller");
  const rs = document.querySelector(".editor-container");
  const pick = (el) => el && el.getClientRects().length > 0 ? {
    st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight),
    h: Math.round(el.clientHeight), max: Math.round(el.scrollHeight - el.clientHeight),
  } : null;
  const c = document.querySelector(".cm-content");
  let doc = null;
  try { const v = c && c.cmTile && c.cmTile.view; if (v) { const d = v.state.doc; doc = { lines: d.lines, len: d.length, first: d.line(1).text.slice(0, 18) }; } } catch (e) {}
  return { src: pick(sc), reader: pick(rs), doc };
`;

await runBrowserProbe({ name: "v0170-r3-grad-ab", doc: DOC_A, docTitle: "PI01" }, async (ui) => {
  const openDoc = async (name, content) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, content, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(p)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} },
      }));
      return true;
    `);
    await sleep(400);
  };

  await ui.command("view.edit");
  await ui.sleep(3000);

  const setSrcPct = (pct) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    sc.scrollTop = Math.round(max * ${pct});
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { st: Math.round(sc.scrollTop), max };
  `);

  const setReaderPct = (pct) => ui.ev(`
    const rs = document.querySelector(".editor-container");
    const max = Math.max(0, rs.scrollHeight - rs.clientHeight);
    rs.scrollTop = Math.round(max * ${pct});
    rs.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { st: Math.round(rs.scrollTop), max };
  `);

  /** 打开 B 并等稳定，采样轨迹 */
  const openAndSample = async (label, name, content) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, content, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(p)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} },
      }));
      return true;
    `);
    const traj = [];
    for (let i = 0; i < 16; i++) {
      await sleep(120);
      const g = await ui.ev(GEOM).catch(() => null);
      if (!g) continue;
      traj.push({ t: i * 120, st: g.src?.st ?? null, max: g.src?.max ?? null, readerSt: g.reader?.st ?? null, max2: g.reader?.max ?? null });
    }
    const g = await ui.ev(GEOM);
    ui.log(`  ${label}: 首帧st=${traj[0]?.st} 稳定st=${g.src?.st}/${g.src?.max} pct=${g.src?.max > 0 ? (g.src.st / g.src.max).toFixed(3) : "0"}` +
      `  阅读面st=${g.reader?.st}/${g.reader?.max}`);
    return { label, first: traj[0], stable: g, traj };
  };

  const groups = [];

  /* ── G0：A 在顶部 ── */
  ui.log("");
  ui.log("──── G0：A 在顶部（st=0）→ 打开 B ────");
  await openDoc("a0.md", DOC_A);
  await ui.sleep(1200);
  await setSrcPct(0);
  await ui.sleep(600);
  ui.log(`  A 位置: ${JSON.stringify(await ui.ev(GEOM).then((g) => g.src))}`);
  groups.push(await openAndSample("G0 A顶部→B", "b0.md", DOC_B));

  /* ── G1：A 在中部 50% ── */
  ui.log("");
  ui.log("──── G1：A 在中部 50% → 打开 B ────");
  await openDoc("a1.md", DOC_A);
  await ui.sleep(1200);
  const g1a = await setSrcPct(0.5);
  await ui.sleep(600);
  ui.log(`  A 位置: ${JSON.stringify(g1a)}（读回 ${JSON.stringify(await ui.ev(GEOM).then((g) => g.src))}）`);
  groups.push(await openAndSample("G1 A中部→B", "b1.md", DOC_B));

  /* ── G2：A 在底部 ── */
  ui.log("");
  ui.log("──── G2：A 在底部（st=max）→ 打开 B ────");
  await openDoc("a2.md", DOC_A);
  await ui.sleep(1200);
  const g2a = await setSrcPct(1);
  await ui.sleep(600);
  ui.log(`  A 位置: ${JSON.stringify(g2a)}（读回 ${JSON.stringify(await ui.ev(GEOM).then((g) => g.src))}）`);
  groups.push(await openAndSample("G2 A底部→B", "b2.md", DOC_B));

  /* ── G3：A 在底部 → 打开更短的 B（钳位效应）── */
  ui.log("");
  ui.log("──── G3：A 在底部 → 打开更短的 B（60段→20段）────");
  await openDoc("a3.md", DOC_B);
  await ui.sleep(1400);
  await setSrcPct(1);
  await ui.sleep(600);
  ui.log(`  A 位置: ${JSON.stringify(await ui.ev(GEOM).then((g) => g.src))}`);
  groups.push(await openAndSample("G3 长底部→更短B", "b3.md", paragraphs(20, "SHORT")));

  /* ── G4：阅读面同三组 ── */
  ui.log("");
  ui.log("──── G4：阅读面（同样单变量）────");
  await ui.command("view.preview");
  await ui.sleep(2200);
  const readerGroups = [];
  const steps = [
    { name: "R0", pct: 0 },
    { name: "R1", pct: 0.5 },
    { name: "R2", pct: 1 },
  ];
  for (const s of steps) {
    await openDoc(`ra_${s.name}.md`, DOC_A);
    await ui.sleep(1400);
    const set = await setReaderPct(s.pct);
    await ui.sleep(800);
    const cur = await ui.ev(GEOM).then((g) => g.reader);
    ui.log(`  ${s.name}: A 阅读面 set=${JSON.stringify(set)} 读回=${JSON.stringify(cur)}`);
    const r = await openAndSample(`${s.name} 阅读面A→新doc`, `rb_${s.name}.md`, DOC_C);
    readerGroups.push(r);
  }

  /* ── 判定 ── */
  ui.log("");
  const srcGroups = groups;
  const bad = srcGroups.filter((g) => (g.stable.src?.st ?? 0) !== 0);
  ui.add(
    "GRAD-1",
    "编辑面：无论 A 停在何处，打开新文档 B 后 scrollTop 必须 == 0",
    bad.length === 0 ? "PASS" : "FAIL",
    srcGroups.map((g) => `${g.label}: st=${g.stable.src?.st}/max=${g.stable.src?.max}`).join("；"),
  );
  ui.add(
    "GRAD-2",
    "★ 单变量归因：B 的落点是否随 A 的位置单调变化（=继承残留的铁证）",
    srcGroups[0].stable.src?.st === srcGroups[2].stable.src?.st ? "PASS" : "FAIL",
    `G0(A顶部)=${srcGroups[0].stable.src?.st} vs G1(A中部)=${srcGroups[1].stable.src?.st} vs G2(A底部)=${srcGroups[2].stable.src?.st}`,
  );
  const rbad = readerGroups.filter((g) => (g.stable.reader?.st ?? 0) !== 0);
  ui.add(
    "GRAD-3",
    "阅读面：打开新文档后 scrollTop 必须 == 0",
    rbad.length === 0 ? "PASS" : "FAIL",
    readerGroups.map((g) => `${g.label}: st=${g.stable.reader?.st}/max=${g.stable.reader?.max}`).join("；"),
  );

  fs.writeFileSync(path.join(os.tmpdir(), "t5-grad-ab.json"), JSON.stringify({ groups, readerGroups }, null, 1), "utf8");
});
