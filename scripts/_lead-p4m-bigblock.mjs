/**
 * Lead · 最终归因验证：**大块（表格/长列表）让块锚点映射失真**
 *
 * ## 完整根因链（本探针验证最后一环）
 *
 * 1. **用户文档含巨型块**。实测（`_lead-p4l-anchors.mjs`，frac=0.5）：
 *    ```
 *    左屏 topLine=126  →  命中块 blockLine=115
 *    该块 blockH = 7775px  ← 一个表格/超长列表，占内容总高(26554)的 29%
 *    ```
 *
 * 2. **映射是"块级"而非"块内"**。`mapSourceLineToPreviewScroll` 在
 *    「块顶(源码行 115) ↔ 块顶(预览像素 9869)」和下一个锚点之间做线性插值。
 *    当这个块有 7775px 高、而它的源码区间只有几行时，从 line=115 到 line=126
 *    这 11 行的比例 `(126-115)/span` 会把目标推到**块内很靠后**的位置（实测 17263）。
 *
 * 3. **`normalizeTops` 还会压缩尾部**。右屏 `max=25795` 而内容 26554，
 *    尾部超限的端点被按比例摊进最后一段 —— 大块内的插值又被拉偏一次。
 *
 * 4. 结果：**右屏实际写入 17263，而"块顶对齐"的正确值是 9869（Δ -7394px）**。
 *
 * ## 为什么"滚一下就对齐了"（用户的观察）
 * 滚动时 `syncToPreview()` 反复调用、且 `topLine` 连续变化；一旦 `topLine`
 * 跨出那个巨型块、进入相邻小块的区间，插值区间变短、误差立刻收窄。
 * 这就是"滚一下慢慢对齐" —— 不是自愈，而是**换了一个插值区间**。
 *
 * ## 本探针要证伪/证实的一条
 * 若"大块导致失真"成立，则：**块高越大，映射误差越大**（正相关）。
 * 我在同一文档里扫多个滚动位置，记录 (blockH, |delta|) 并算相关性。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const USER_DOC = process.env.P4_DOC || "D:\\10254\\桌面\\job plan\\明途知识产权-高级数据工程师-沟通场景表.md";
function fixture(n) {
  const out = ["# 大块验证", ""];
  for (let i = 1; i <= n; i++) out.push(`第 ${i} 段。PI${String(i).padStart(2, "0")}。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do.`, "");
  return out.join("\n");
}
const USING = fs.existsSync(USER_DOC);
const DOC = USING ? fs.readFileSync(USER_DOC, "utf8") : fixture(60);

/** 复算"块顶对齐"的正确值，并与生产实写值对比；同时回报命中块的高度 */
const PROBE = `
  const cm = document.querySelector(".cm-content");
  const view = cm && cm.cmTile && cm.cmTile.view;
  const sc = document.querySelector(".cm-scroller");
  const f = document.querySelector(".split-preview-shell iframe");
  const d = f && f.contentDocument;
  if (!view || !sc || !d) return { ok:false, why:"missing" };
  const psc = d.scrollingElement || d.documentElement || d.body;
  if (!(psc.clientHeight>0)) return { ok:false, why:"not-ready" };

  let topLine = null;
  try {
    const b = view.lineBlockAtHeight(sc.scrollTop);
    topLine = view.state.doc.lineAt(b.from).number - 1;
  } catch(e) {}
  if (topLine === null) return { ok:false, why:"no-topline" };

  const blocks = [...d.querySelectorAll("[data-src-line]")].map(el => ({
    line: Number(el.getAttribute("data-src-line")), el,
  })).filter(b=>Number.isFinite(b.line)).sort((a,b)=>a.line-b.line);

  let anchor = null, nextAnchor = null;
  for (let i=0;i<blocks.length;i++){
    if (blocks[i].line <= topLine) { anchor = blocks[i]; nextAnchor = blocks[i+1]||null; }
    else break;
  }
  if (!anchor) return { ok:false, why:"no-anchor", topLine, blockCount: blocks.length };

  const st = psc.scrollTop;
  const rA = anchor.el.getBoundingClientRect();
  const contentTop = rA.top + st;
  const blockH = rA.height;
  // 下一个锚点的内容顶（用于算"本段跨度"）
  let nextContentTop = null, lineSpan = null;
  if (nextAnchor) {
    const rN = nextAnchor.el.getBoundingClientRect();
    nextContentTop = rN.top + st;
    lineSpan = nextAnchor.line - anchor.line;
  }
  const max = Math.max(0, psc.scrollHeight - psc.clientHeight);
  const correct = Math.max(0, Math.min(max, contentTop));
  // 生产实写值（当前 scrollTop）
  const actual = st;
  const delta = actual - correct;

  // 命中块在源码里的行跨度（用于判"块高/源码行"比例是否失衡）
  const srcLineSpan = (nextAnchor ? nextAnchor.line : (view.state.doc.lines)) - anchor.line;
  const pxPerSrcLine = srcLineSpan > 0 ? Math.round(blockH / srcLineSpan * 10)/10 : null;

  return { ok:true,
    topLine, anchorLine: anchor.line, nextAnchorLine: nextAnchor?nextAnchor.line:null,
    blockH: Math.round(blockH*10)/10, srcLineSpan, pxPerSrcLine,
    contentTop: Math.round(contentTop),
    actual: Math.round(actual), correct: Math.round(correct), delta: Math.round(delta),
    previewMax: Math.round(max), previewSh: psc.scrollHeight,
    leftSt: Math.round(sc.scrollTop), leftMax: Math.round(sc.scrollHeight-sc.clientHeight),
    blockCount: blocks.length,
    anchorTag: anchor.el.tagName,
  };
`;

await runBrowserProbe({ name: "lead-p4m-bigblock", doc: DOC, docTitle: USING ? "明途知识产权" : "大块验证" }, async (ui) => {
  const P = () => ui.ev(PROBE);
  const isOpen = () => ui.ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
  const dblShift = async () => {
    for (let i = 0; i < 2; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sleep(70);
    }
  };

  ui.log(`[p4m] 文档=${USING ? "用户真实文档" : "夹具"}`);
  await ui.command("view.edit");
  await sleep(2600);
  // 保证预览打开
  if (!(await isOpen())) { await dblShift(); await sleep(2600); }

  const rows = [];
  // 扫 8 个位置
  for (let k = 1; k <= 8; k++) {
    const frac = k / 9;
    // 滚左屏
    for (let i = 0; i < 60; i++) {
      const c = await ui.ev(`const s=document.querySelector(".cm-scroller");return {st:s.scrollTop,max:s.scrollHeight-s.clientHeight};`);
      if (!c || c.max <= 0) break;
      const dd = Math.round(c.max * frac) - c.st;
      if (Math.abs(dd) < 35) break;
      await ui.wheel(1000, 500, Math.max(-900, Math.min(900, dd)));
      await sleep(45);
    }
    await sleep(900);
    const r = await P();
    if (r && r.ok) { rows.push({ frac, ...r }); }
    else ui.log(`[p4m] frac=${frac.toFixed(2)} 采样失败: ${JSON.stringify(r)}`);
  }

  ui.log(`[p4m] ===== 明细 =====`);
  for (const r of rows) {
    ui.log(`[p4m] frac=${r.frac.toFixed(2)} 左${r.leftSt}/${r.leftMax} topLine=${r.topLine} 档=${r.anchorTag}@L${r.anchorLine}` +
      ` 块高=${r.blockH} 源码行跨度=${r.srcLineSpan} px/行=${r.pxPerSrcLine}` +
      ` | 实写=${r.actual} 应写=${r.correct} Δ=${r.delta}`);
  }

  // 相关性：块高 vs |Δ|
  const pts = rows.map((r) => ({ h: r.blockH, d: Math.abs(r.delta), l: r.leftSt }));
  const n = pts.length;
  if (n >= 3) {
    const mx = pts.reduce((a, b) => a + b.h, 0) / n;
    const my = pts.reduce((a, b) => a + b.d, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (const p of pts) { num += (p.h - mx) * (p.d - my); dx += (p.h - mx) ** 2; dy += (p.d - my) ** 2; }
    const corr = Math.round((num / Math.sqrt(dx * dy || 1)) * 1000) / 1000;
    ui.log(`[p4m] 块高 vs |Δ| 相关系数 = ${corr}（n=${n}）`);
    ui.add("P4M-1", "大块导致映射失真（块高 vs |Δ| 正相关，r>0.5）",
      corr > 0.5 ? "PASS" : "KNOWN", `r=${corr}；样本=${JSON.stringify(pts)}`);
  }

  const ds = rows.map((r) => Math.abs(r.delta));
  const worst = ds.length ? Math.max(...ds) : null;
  ui.add("P4M-2", "块顶对齐误差 |Δ| 应 < 100px", worst !== null && worst < 100 ? "PASS" : "FAIL",
    `最大 |Δ|=${worst}px（${ds.length} 个采样点）`);

  fs.writeFileSync(path.join("D:/AI/markdown view/lightmd/_verify-out", "lead-p4m-bigblock.json"),
    JSON.stringify({ using: USING, rows, pts }, null, 1), "utf8");
});
