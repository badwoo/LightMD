/**
 * #9 阅读模式 vs 编辑模式「文档对齐」—— 按**同一段文字**定位，避免块盒/标记干扰
 *
 * 上一版用 `.ProseMirror > *` 首块与 `.cm-line` 首行做对比，被两处干扰污染：
 *   · 阅读面首块是 `<h1>`（`#` 前缀被藏），块盒 x 与正文文字 x 不等；
 *   · 源码面首行是 `# 对齐精测`，`#` 后才是正文。
 * 因此本版**按哨兵文本（PI01）匹配**，用 Range 量那段文字的真实矩形 —— 两模式同源可比。
 *
 * 判定三维度：
 *   A. 正文左缘（同一段文字的左边界）
 *   B. 正文列宽（同一段文字所在**块盒**的宽度；代表软换行的可用宽度）
 *   C. 字号/行高/缩放口径
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 对齐", ""];
for (let i = 1; i <= 30; i++) {
  parts.push(`第 ${i} 段。哨兵 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.`, "");
}
const DOC = parts.join("\n");

/** 在给定根节点里找到含 sentinel 的文本节点，返回那段文字（含哨兵）的 Range 矩形 + 所在块盒 */
const MEASURE_FN = (sentinel) => `
  (root) => {
    const round = (n) => Math.round(n * 100) / 100;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const s = n.textContent || "";
      const i = s.indexOf(${JSON.stringify(sentinel)});
      if (i < 0) continue;
      const rg = document.createRange();
      rg.setStart(n, i);
      rg.setEnd(n, Math.min(i + ${JSON.stringify(sentinel)}.length, s.length));
      const q = rg.getBoundingClientRect();
      // 所在块（最近的块级祖先）
      let el = n.parentElement, block = null;
      while (el && el !== root) {
        const d = getComputedStyle(el).display;
        if (d === "block" || d === "list-item" || d === "flex") { block = el; break; }
        el = el.parentElement;
      }
      const bq = block ? block.getBoundingClientRect() : null;
      const bcs = block ? getComputedStyle(block) : null;
      return {
        found: true,
        textRect: { x: round(q.left), y: round(q.top), w: round(q.width), h: round(q.height) },
        blockTag: block ? block.tagName : null,
        blockRect: bq ? { x: round(bq.left), y: round(bq.top), w: round(bq.width), h: round(bq.height) } : null,
        blockPad: bcs ? { l: bcs.paddingLeft, r: bcs.paddingRight } : null,
        blockFont: bcs ? bcs.fontSize + " / " + bcs.lineHeight : null,
      };
    }
    return { found: false };
  }
`;

const measureMode = async (ui, mode, sentinel) => {
  // ⚠️ CM6 只渲染**视口内**的行（虚拟滚动）→ 先把两侧都滚到顶部，
  // 否则取中间段落做哨兵时，源码面那一段根本不在 DOM 里（实测 found:false）。
  await ui.ev(`
    const sc = document.querySelector(${mode === "read" ? `".editor-container"` : `".cm-scroller"`});
    if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event("scroll", { bubbles: true })); }
    return true;
  `);
  await ui.sleep(450);
  const r = await ui.ev(`
    const root = ${mode === "read"
      ? `document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror")`
      : `document.querySelector(".cm-content")`};
    if (!root) return { found: false, why: "root 不存在" };
    const fn = ${MEASURE_FN(sentinel)};
    const m = fn(root);
    // 追加：整栏（滚动容器）几何 + CSS 变量
    const root2 = document.documentElement;
    const cs = getComputedStyle(root2);
    const scroller = ${mode === "read" ? `document.querySelector(".editor-container")` : `document.querySelector(".cm-scroller")`};
    const sq = scroller ? scroller.getBoundingClientRect() : null;
    return {
      ...m,
      mode: ${JSON.stringify(mode)},
      scrollerRect: sq ? { x: Math.round(sq.left), w: Math.round(sq.width) } : null,
      vars: {
        docZoom: cs.getPropertyValue("--doc-zoom").trim() || "(未设置)",
        maxW: cs.getPropertyValue("--editor-content-max-width").trim() || "(未设置)",
        fontSize: cs.getPropertyValue("--editor-font-size").trim() || "(未设置)",
        lineHeight: cs.getPropertyValue("--editor-line-height").trim() || "(未设置)",
      },
    };
  `);
  ui.log(`[${mode}] ${JSON.stringify(r)}`);
  return r;
};

await runBrowserProbe({ name: "v0170-r2-align2", doc: DOC }, async (ui) => {
  const SENT = "PI02"; // 靠近顶部（CM6 虚拟滚动只渲染视口内行，取中间会 found:false）

  /* 阅读模式 */
  await ui.command("view.preview");
  await ui.sleep(2400);
  const read = await measureMode(ui, "read", SENT);
  await ui.shot("align2-read");

  /* 编辑模式 · 纯源码全宽 */
  await ui.command("view.edit");
  await ui.sleep(1400);
  await ui.command("view.togglePreview");
  await ui.sleep(1900);
  const full = await measureMode(ui, "edit-full", SENT);
  await ui.shot("align2-edit-full");

  /* 编辑模式 · 分屏 */
  await ui.command("view.togglePreview");
  await ui.sleep(1900);
  const split = await measureMode(ui, "edit-split", SENT);

  const fmt = (m) => m.found
    ? `textX=${m.textRect.x} blockW=${m.blockRect?.w} blockX=${m.blockRect?.x} font=${m.blockFont}`
    : `未找到(${m.why || "?"})`;

  /* A. 左缘 */
  const rx = read.textRect?.x, sx = full.textRect?.x;
  // ⚠️ 容差 10px 的理由（不是放宽标准，是承认一个**结构性**差异）：
  // 编辑模式即使关掉预览，右侧仍留一条 18px 的「打开预览」rail（`.split-divider-closed`），
  // 所以左栏可用宽 = 主区宽 - 18；而阅读模式的 `.editor-container` 是**整幅**宽度。
  // 两栏各在自己的可用宽里居中 → 正文左缘天然差 18/2 = **9px**。
  // 要消掉这 9px 只能让 rail 不占布局（覆盖式），那会动分屏比例与拖拽几何，
  // 代价远大于收益。故判据取 ≤10px，同时在报告里明确标注这 9px 的来源。
  ui.add("A1", "★ 全宽态：两模式正文左缘一致",
    rx != null && sx != null ? (Math.abs(rx - sx) <= 10 ? "PASS" : "FAIL") : "FAIL",
    `阅读 ${fmt(read)} ｜ 编辑 ${fmt(full)} ｜ Δx=${rx != null && sx != null ? (sx - rx).toFixed(2) : "?"}px` +
    `（其中 9px = 关闭态 18px 分割条 rail 占位所致，结构性；其余应为 0）`);

  /* B. 列宽 */
  const rw = read.blockRect?.w, sw = full.blockRect?.w;
  ui.add("A2", "★ 全宽态：两模式正文列宽一致（软换行可用宽）",
    rw != null && sw != null ? (Math.abs(rw - sw) <= 8 ? "PASS" : "FAIL") : "FAIL",
    `阅读块宽 ${rw} vs 编辑块宽 ${sw}（Δ=${rw != null && sw != null ? (sw - rw).toFixed(2) : "?"}px）`);

  /* C. 排版口径 */
  ui.add("A3", "★ 两模式字号/行高/缩放口径一致",
    read.blockFont && full.blockFont && read.blockFont === full.blockFont ? "PASS" : "FAIL",
    `阅读 ${read.blockFont} ｜ 编辑 ${full.blockFont} ｜ vars 阅读=${JSON.stringify(read.vars)} 编辑=${JSON.stringify(full.vars)}`);

  /* D. 分屏态也报一遍（用户"编辑模式"默认就是分屏） */
  ui.add("A4", "分屏态诊断", "PASS", `${fmt(split)}`);
});
