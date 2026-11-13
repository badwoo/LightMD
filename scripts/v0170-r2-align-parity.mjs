/**
 * #9 阅读模式 vs 编辑模式「文档对齐」精测
 *
 * 用户报告：「阅读模式和编辑模式文档没有对齐。」
 *
 * 判定口径（三条独立维度，任一坏了都算"没对齐"）：
 *   A. 正文列**左缘**是否一致（视觉上最直观）
 *   B. 正文列**宽度**是否一致（决定软换行位置 → 决定阅读进度映射精度）
 *   C. 同一段落能否映射到两侧同一处（结构对齐；本探针只看几何，结构对齐另有探针）
 *
 * 前提：两模式都必须有内容、且窗口尺寸相同。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 对齐精测", ""];
for (let i = 1; i <= 30; i++) {
  parts.push(`第 ${i} 段。PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.`, "");
}
const DOC = parts.join("\n");

const measure = async (ui, mode) => {
  const r = await ui.ev(`
    const round = (n) => Math.round(n);
    const R = (el) => { if (!el) return null; const q = el.getBoundingClientRect();
      return { x: round(q.left), y: round(q.top), w: round(q.width), h: round(q.height) }; };
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const out = {
      mode: ${JSON.stringify(mode)},
      docZoom: cs.getPropertyValue("--doc-zoom").trim(),
      contentMaxW: cs.getPropertyValue("--editor-content-max-width").trim(),
      fontSize: cs.getPropertyValue("--editor-font-size").trim(),
      lineHeight: cs.getPropertyValue("--editor-line-height").trim(),
    };
    // 阅读面
    const ec = document.querySelector(".editor-container");
    const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
    out.editorContainer = R(ec);
    out.pm = R(pm);
    if (pm) {
      const pmCs = getComputedStyle(pm);
      out.pmStyle = { padL: pmCs.paddingLeft, padR: pmCs.paddingRight, padT: pmCs.paddingTop,
                      maxW: pmCs.maxWidth, margin: pmCs.margin, zoom: pmCs.zoom, width: pmCs.width };
      // 阅读面第一段文字左缘
      const p = pm.querySelector("p, h1, h2, h3, li");
      if (p) {
        try {
          const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
          let n, rect = null;
          while ((n = walker.nextNode())) {
            const s = n.textContent || "";
            if (s.trim().length === 0) continue;
            const lead = s.length - s.trimStart().length;
            const rg = document.createRange(); rg.setStart(n, lead); rg.setEnd(n, Math.min(lead + 3, s.length));
            const q = rg.getBoundingClientRect();
            if (q.width > 0) { rect = { x: round(q.left), y: round(q.top) }; break; }
          }
          out.pmTextX = rect;
        } catch (e) { out.pmTextX = { err: String(e.message).slice(0,50) }; }
        out.pmFirstBlock = R(p);
      }
    }
    // 源码面
    const host = document.querySelector(".source-editor-cm6");
    const sc = document.querySelector(".cm-scroller");
    const line = document.querySelector(".cm-line");
    const gut = document.querySelector(".cm-gutters");
    out.host = R(host); out.scroller = R(sc); out.gutter = R(gut); out.line = R(line);
    if (sc) {
      const scCs = getComputedStyle(sc);
      out.scStyle = { padL: scCs.paddingLeft, padR: scCs.paddingRight, padT: scCs.paddingTop };
    }
    if (line) {
      try {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let n, rect = null;
        while ((n = walker.nextNode())) {
          const s = n.textContent || "";
          if (s.trim().length === 0) continue;
          const lead = s.length - s.trimStart().length;
          const rg = document.createRange(); rg.setStart(n, lead); rg.setEnd(n, Math.min(lead + 3, s.length));
          const q = rg.getBoundingClientRect();
          if (q.width > 0) { rect = { x: round(q.left), y: round(q.top) }; break; }
        }
        out.srcTextX = rect;
      } catch (e) { out.srcTextX = { err: String(e.message).slice(0,50) }; }
    }
    return out;
  `);
  ui.log(`[${mode}] ${JSON.stringify(r)}`);
  return r;
};

await runBrowserProbe({ name: "v0170-r2-align-parity", doc: DOC }, async (ui) => {
  /* 阅读模式 */
  await ui.command("view.preview");
  await ui.sleep(2400);
  const read = await measure(ui, "read");
  await ui.shot("align-read");

  /* 编辑模式（关闭预览 = 纯源码全宽，才与阅读模式同为"整栏"） */
  await ui.command("view.edit");
  await ui.sleep(1200);
  await ui.command("view.togglePreview");
  await ui.sleep(1800);
  const srcFull = await measure(ui, "edit-full");
  await ui.shot("align-edit-full");

  /* 编辑模式（开预览 = 分屏） */
  await ui.command("view.togglePreview");
  await ui.sleep(1800);
  const srcSplit = await measure(ui, "edit-split");
  await ui.shot("align-edit-split");

  /* ── 判定：全宽态下两模式对齐（这才是"同一版面"的可比状态） ── */
  // ⚠️ 口径修正：不能拿 `.ProseMirror` 的盒宽对比 `.cm-scroller` 的盒宽 ——
  // 前者带 max-width:860 + 两侧 60px 内边距，后者是整栏 + 内边距居中，
  // 两者**盒宽天然不同**。真正该比的是「正文列（文字可用宽度）」。
  const rx = read.pmTextX?.x, sx = srcFull.srcTextX?.x;
  // 正文列宽 = 首段文字的横向可用宽度
  //   阅读：pm 盒宽 860 - 左右各 60 内边距 = 740
  //   编辑：scroller 宽 - 左右内边距 - 行号槽宽
  const parsePx = (s) => { const m = /([\d.]+)px/.exec(String(s || "")); return m ? Number(m[1]) : null; };
  const readPad = read.pmStyle ? parsePx(read.pmStyle.padL) : null;
  const readColW = read.pm && readPad != null ? Math.round(read.pm.w - readPad * 2) : null;
  const srcPad = srcFull.scStyle ? parsePx(srcFull.scStyle.padL) : null;
  const gutterW = srcFull.gutter?.w ?? 0;
  const srcColW = srcFull.scroller && srcPad != null ? Math.round(srcFull.scroller.w - srcPad * 2 - gutterW) : null;

  ui.add("A1", "★ 全宽态：两模式正文左缘一致",
    rx != null && sx != null ? (Math.abs(rx - sx) <= 6 ? "PASS" : "FAIL") : "FAIL",
    `阅读文字 x=${rx} vs 编辑文字 x=${sx}（差 ${rx != null && sx != null ? rx - sx : "?"}px）`);
  ui.add("A2", "★ 全宽态：两模式正文列宽一致",
    readColW != null && srcColW != null ? (Math.abs(readColW - srcColW) <= 12 ? "PASS" : "FAIL") : "FAIL",
    `阅读正文列 ${readColW}（盒 ${read.pm?.w} - 内边距 ${readPad}×2）vs 编辑正文列 ${srcColW}（盒 ${srcFull.scroller?.w} - 内边距 ${srcPad}×2 - 行号槽 ${gutterW}）（差 ${readColW != null && srcColW != null ? readColW - srcColW : "?"}px）`);
  ui.add("A3", "诊断：内容最大宽口径",
    "PASS", `阅读 CSS 兜底 860 / 源码 CSS 兜底 960；运行时变量="${read.contentMaxW || "(未设置→走各自兜底)"}"`);
  ui.add("A4", "诊断：阅读面 pmStyle", "PASS", JSON.stringify(read.pmStyle));
  ui.add("A5", "诊断：编辑面 scStyle", "PASS", JSON.stringify(srcFull.scStyle));
  ui.add("A6", "诊断：分屏态",
    "PASS", `host=${JSON.stringify(srcSplit.host)} scroller=${JSON.stringify(srcSplit.scroller)} gutter=${JSON.stringify(srcSplit.gutter)}`);
});
