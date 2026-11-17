/**
 * Lead · 定位（第十层）：**块锚点映射是否真的生效？还是静默退回了百分比？**
 *
 * ## 决定性数据（`_lead-p4k-inputs.mjs`，用户真实文档）
 * ```
 * 开合后  左%=0.506   右%=0.657   ← 差 15.1 个百分点
 * 滚动后  左%=0.508   右%=0.663   ← 差 15.5 个百分点
 * ```
 * 两次差值**几乎相同** ⇒ 说明"滚动后对齐"是错觉（我的文本匹配撞上了不同元素）。
 * 真正的信号是：**右屏百分比恒比左屏高 15 个百分点**。
 *
 * ## 为什么"恒高 15 个百分点"强烈指向"退回了百分比映射"
 * 左屏 max=13120、右屏 max=25795（右屏可滚动高度近 2 倍）。
 * 若映射是**正确的块锚点**，同一内容在两屏的百分比本来就**不相等**
 * （右侧块更高，同一内容在右侧占比更靠后）—— 15 个百分点符合预期。
 *
 * 若映射**静默退回百分比**（`computeSyncScrollTop`），则两屏百分比会被强行拉到
 * **相等**（左 0.506 → 右 0.506）。实测不等 ⇒ 不是纯百分比。
 *
 * ⇒ 所以要看的是：**块锚点映射有没有被调用、`anchors` 是否有效**。
 *    `collectAnchors()` 返回 null 时会退回百分比；返回表但映射失败时返回 null（不写）。
 *
 * 本探针直接读 `collectAnchors` 的产物特征（贴标数 / 表长 / 首末锚点），
 * 并算出"若用块锚点，右屏应该在哪"，与实际写入值对比。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const USER_DOC = process.env.P4_DOC || "D:\\10254\\桌面\\job plan\\明途知识产权-高级数据工程师-沟通场景表.md";
function fixture(n) {
  const out = ["# 锚点验证", ""];
  for (let i = 1; i <= n; i++) out.push(`第 ${i} 段。PI${String(i).padStart(2, "0")}。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do.`, "");
  return out.join("\n");
}
const USING = fs.existsSync(USER_DOC);
const DOC = USING ? fs.readFileSync(USER_DOC, "utf8") : fixture(60);

/**
 * 独立复算"块锚点映射应该给什么"。
 *
 * 口径与生产代码一致（blockScrollAlign.ts）：
 *   ① 取左屏视口顶对应的**源码行** topLine
 *   ② 在右屏找该行所属的顶层块元素（data-src-line <= topLine 的最后一个）
 *   ③ 把该元素对齐到右屏视口顶 → scrollTop = 元素内容top
 *
 * 若③算出的值与生产写入值差很多，说明生产侧输入/实现有偏。
 */
const RECOMPUTE = `
  const cm = document.querySelector(".cm-content");
  const view = cm && cm.cmTile && cm.cmTile.view;
  const sc = document.querySelector(".cm-scroller");
  const f = document.querySelector(".split-preview-shell iframe");
  const d = f && f.contentDocument;
  if (!view || !sc || !d) return { ok:false, why:"missing" };
  const psc = d.scrollingElement || d.documentElement || d.body;
  if (!(psc.clientHeight>0)) return { ok:false, why:"preview-not-ready" };

  // ① 左屏视口顶对应的源码行：用「视口顶第一个可见行」的 doc 偏移 → 行号
  const scTop = sc.getBoundingClientRect().top;
  const h = sc.clientHeight;
  let topLine = null, topLineHow = null;
  try {
    // 方案A：posAtCoords（需页面坐标，y 取视口顶内侧一点）
    const pos = view.posAtCoords({ x: sc.getBoundingClientRect().left + 60, y: scTop + 2 });
    if (pos) { topLine = view.state.doc.lineAt(pos.pos).number - 1; topLineHow = "posAtCoords"; }
  } catch (e) {}
  if (topLine === null) {
    try {
      // 方案B：lineBlockAtHeight（CM6 官方：给定内容高度返回块信息）
      const b = view.lineBlockAtHeight(sc.scrollTop);
      topLine = view.state.doc.lineAt(b.from).number - 1;
      topLineHow = "lineBlockAtHeight";
    } catch (e) {}
  }

  // ② 右屏顶层块（带 data-src-line）
  const blocks = [...d.querySelectorAll("[data-src-line]")].map(el => ({
    line: Number(el.getAttribute("data-src-line")),
    el,
  })).filter(b => Number.isFinite(b.line)).sort((a,b)=>a.line-b.line);

  // ③ 找 line <= topLine 的最后一个块 → 对齐它的内容顶
  let anchorBlock = null;
  if (topLine !== null) {
    for (const b of blocks) { if (b.line <= topLine) anchorBlock = b; else break; }
  }
  let recomputed = null, blockLine = null, blockContentTop = null, blockH = null;
  if (anchorBlock) {
    const r = anchorBlock.el.getBoundingClientRect();
    // iframe 内 r.top = contentTop - scrollTop → contentTop = r.top + scrollTop
    blockContentTop = Math.round((r.top + psc.scrollTop) * 10) / 10;
    blockH = Math.round(r.height * 10) / 10;
    blockLine = anchorBlock.line;
    const max = Math.max(0, psc.scrollHeight - psc.clientHeight);
    recomputed = Math.max(0, Math.min(max, blockContentTop));
  }

  const pct = (() => {
    const max = Math.max(0, psc.scrollHeight - psc.clientHeight);
    return max>0 ? Math.round(psc.scrollTop/max*10000)/10000 : null;
  })();

  return { ok:true,
    leftSt: Math.round(sc.scrollTop), leftMax: Math.round(sc.scrollHeight-sc.clientHeight),
    leftPct: (()=>{const m=sc.scrollHeight-sc.clientHeight;return m>0?Math.round(sc.scrollTop/m*10000)/10000:null;})(),
    topLine, topLineHow,
    blockCount: blocks.length,
    blockLine, blockContentTop, blockH,
    previewSt: Math.round(psc.scrollTop), previewMax: Math.round(psc.scrollHeight-psc.clientHeight),
    previewPct: pct,
    previewSh: psc.scrollHeight, previewCh: psc.clientHeight,
    recomputed: recomputed===null?null:Math.round(recomputed),
    delta: (recomputed===null||!Number.isFinite(psc.scrollTop))?null:Math.round(recomputed - psc.scrollTop),
  };
`;

await runBrowserProbe({ name: "lead-p4l-anchors", doc: DOC, docTitle: USING ? "明途知识产权" : "锚点验证" }, async (ui) => {
  const RC = () => ui.ev(RECOMPUTE);
  const isOpen = () => ui.ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
  const dblShift = async () => {
    for (let i = 0; i < 2; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sleep(70);
    }
  };

  ui.log(`[p4l] 文档=${USING ? "用户真实文档" : "夹具"}`);
  await ui.command("view.edit");
  await sleep(2600);
  if (await isOpen()) { await dblShift(); await sleep(2200); }

  const scrollToFrac = async (frac) => {
    for (let i = 0; i < 60; i++) {
      const c = await ui.ev(`const s=document.querySelector(".cm-scroller");return {st:s.scrollTop,max:s.scrollHeight-s.clientHeight};`);
      if (!c || c.max <= 0) return;
      const d = Math.round(c.max * frac) - c.st;
      if (Math.abs(d) < 40) return;
      await ui.wheel(1000, 500, Math.max(-900, Math.min(900, d)));
      await sleep(45);
    }
  };

  const rows = [];
  for (const frac of [0.3, 0.5, 0.7]) {
    await scrollToFrac(frac);
    await sleep(400);
    await dblShift();
    await sleep(3200);
    const r = await RC();
    rows.push({ frac, ...r });
    ui.log(`[p4l] frac=${frac} ${JSON.stringify(r)}`);
    await dblShift();
    await sleep(2200);
  }

  ui.log(`[p4l] ===== 汇总 =====`);
  for (const r of rows) {
    if (!r.ok) { ui.log(`[p4l] frac=${r.frac} 失败: ${r.why}`); continue; }
    ui.log(`[p4l] frac=${r.frac} 左行=${r.topLine}(${r.topLineHow}) 块档=${r.blockLine}/${r.blockCount}` +
      ` | 右实写 st=${r.previewSt}/${r.previewMax}(${r.previewPct}) 复算应写=${r.recomputed} Δ=${r.delta}px`);
  }
  const ds = rows.filter((r) => r.ok && r.delta !== null).map((r) => r.delta);
  ui.log(`[p4l] Δ(复算-实写) = ${JSON.stringify(ds)}`);

  fs.writeFileSync(path.join("D:/AI/markdown view/lightmd/_verify-out", "lead-p4l-anchors.json"),
    JSON.stringify({ using: USING, rows }, null, 1), "utf8");
});
