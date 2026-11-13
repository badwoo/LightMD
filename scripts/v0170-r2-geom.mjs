/**
 * #5 / #9 几何精测：左栏框线与右屏篇幅、两屏正文列起止
 *
 * 只在**分屏（编辑+预览）**与**纯源码（关预览）**两种状态下量，
 * 每种状态都输出：宿主 / CM6 编辑器 / scroller / gutter / 首行文字 / 右屏文档正文 的几何。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 几何精测", ""];
for (let i = 1; i <= 30; i++) {
  parts.push(`第 ${i} 段。PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do.`, "");
}
const DOC = parts.join("\n");

const geom = async (ui, tag) => {
  const r = await ui.ev(`
    const round = (n) => Math.round(n);
    const R = (el) => { if (!el) return null; const q = el.getBoundingClientRect();
      return { x: round(q.left), y: round(q.top), w: round(q.width), h: round(q.height), r: round(q.right), b: round(q.bottom) }; };
    const host = document.querySelector(".source-editor-cm6");
    const ed = document.querySelector(".cm-editor");
    const edCs = ed ? getComputedStyle(ed) : null;
    const hostCs = host ? getComputedStyle(host) : null;
    const sc = document.querySelector(".cm-scroller");
    const scCs = sc ? getComputedStyle(sc) : null;
    const gut = document.querySelector(".cm-gutters");
    const line = document.querySelector(".cm-line");
    const lineCs = line ? getComputedStyle(line) : null;
    const shell = document.querySelector(".split-preview-shell");
    const iframe = document.querySelector("iframe.split-preview");
    const area = document.querySelector(".editor-main-area");

    let iframeText = null, iframeBody = null;
    try {
      const d = iframe && iframe.contentDocument;
      if (d && d.body) {
        const bodyCs = getComputedStyle(d.body);
        iframeBody = { padL: bodyCs.paddingLeft, padT: bodyCs.paddingTop, w: d.documentElement.scrollWidth };
        // 右屏第一个文本节点的起始 x（相对 iframe 视口）
        const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
        let n, rect = null;
        while ((n = walker.nextNode())) {
          if ((n.textContent || "").trim().length < 3) continue;
          const rg = d.createRange(); rg.selectNodeContents(n);
          const q = rg.getBoundingClientRect();
          if (q.width > 0) { rect = { x: round(q.left), y: round(q.top), w: round(q.width) }; break; }
        }
        iframeText = rect;
      }
    } catch (e) { iframeText = { err: String(e.message).slice(0, 60) }; }

    // 左屏首行文字的真实起点：找该行内**第一个非空白文本节点**，用 Range 量头几个字符
    let srcTextX = null;
    if (line) {
      try {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let n, rect = null;
        while ((n = walker.nextNode())) {
          const s = (n.textContent || "");
          if (s.trim().length === 0) continue;
          const lead = s.length - s.trimStart().length;
          const rg = document.createRange();
          rg.setStart(n, lead);
          rg.setEnd(n, Math.min(lead + 3, s.length));
          const q = rg.getBoundingClientRect();
          if (q.width > 0) { rect = { x: round(q.left), y: round(q.top) }; break; }
        }
        srcTextX = rect;
      } catch (e) { srcTextX = { err: String(e.message).slice(0, 60) }; }
    }

    return {
      area: R(area), host: R(host), editor: R(ed), scroller: R(sc), gutter: R(gut), line: R(line),
      shell: R(shell),
      hostPad: hostCs ? { t: hostCs.paddingTop, l: hostCs.paddingLeft, r: hostCs.paddingRight, b: hostCs.paddingBottom } : null,
      scPad: scCs ? { t: scCs.paddingTop, l: scCs.paddingLeft, r: scCs.paddingRight, b: scCs.paddingBottom } : null,
      edOutline: edCs ? edCs.outlineStyle + " " + edCs.outlineWidth + " " + edCs.outlineColor : null,
      // v0.17.0 第二轮修复后：框线画在**宿主**上（.source-editor-cm6:focus-within）
      hostOutline: hostCs ? hostCs.outlineStyle + " " + hostCs.outlineWidth + " " + hostCs.outlineColor : null,
      edMargin: edCs ? edCs.margin : null,
      srcTextX,
      iframeBody, iframeText,
      gutterW: gut ? gut.clientWidth : null,
    };
  `);
  ui.log(`[${tag}] ${JSON.stringify(r)}`);
  return r;
};

await runBrowserProbe({ name: "v0170-r2-geom", doc: DOC }, async (ui) => {
  /* 状态 1：分屏（编辑 + 预览展开） */
  await ui.sleep(400);
  const split = await geom(ui, "split");
  await ui.shot("geom-split");

  /* 状态 2：关预览（纯源码全宽） */
  await ui.command("view.togglePreview");
  await ui.sleep(1500);
  const full = await geom(ui, "full");
  await ui.shot("geom-full");

  /* ── 判定（分屏态）── */
  const S = split;
  // 用户要的是：框线范围 ≈ 右屏篇幅。
  // v0.17.0 第二轮修复后，框线画在**宿主** `.source-editor-cm6` 上（不是 .cm-editor）。
  const fw = S.host?.w, fh = S.host?.h;
  const sw = S.shell?.w, sh = S.shell?.h;
  ui.add("G1", "★ 框线宽 vs 右屏宽",
    fw && sw ? (Math.abs(fw - sw) <= 8 ? "PASS" : "FAIL") : "FAIL",
    `框线(宿主) ${fw} vs 右屏 ${sw}（差 ${fw && sw ? fw - sw : "?"}px）`);
  ui.add("G2", "★ 框线高 vs 右屏高",
    fh && sh ? (Math.abs(fh - sh) <= 8 ? "PASS" : "FAIL") : "FAIL",
    `框线(宿主) ${fh} vs 右屏 ${sh}（差 ${fh && sh ? fh - sh : "?"}px）`);
  ui.add("G3", "框线起止与右屏对齐（左上角）",
    S.host && S.shell && Math.abs(S.host.y - S.shell.y) <= 2 ? "PASS" : "FAIL",
    `框线(宿主) y=${S.host?.y} vs 右屏 y=${S.shell?.y}；x=${S.host?.x} vs ${S.shell?.x}（左右两栏 x 本就不同，只校验 y）`);
  ui.add("G3b", "框线确实画在宿主上（不是 .cm-editor）",
    String(S.hostOutline || "").includes("dotted") && String(S.edOutline || "").includes("none") ? "PASS" : "FAIL",
    `宿主 outline=${S.hostOutline}；.cm-editor outline=${S.edOutline}`);

  // 两屏「正文内缩量」对比（#9 对齐的正确口径）
  //
  // ⚠️ 不能比**绝对** x：左右两栏本来就在屏幕的不同列上（左栏 279~796、右屏 802~1319），
  // 比绝对坐标恒差约一屏宽，那是探针口径错误，不是缺陷。
  // 正确的口径是「各自正文相对自己分栏左缘的内缩量」—— 它决定视觉对齐。
  const srcX = S.srcTextX?.x ?? null;
  const srcInset = srcX != null && S.host ? srcX - S.host.x : null;
  const dstInset = S.iframeText?.x ?? null; // iframe 内文档坐标本就相对右栏左缘
  // 左栏独有的行号槽（33px）必须计入：正文内缩 = 行号槽 + scroller 左内边距
  ui.add("G4", "★ 左右两屏正文内缩量一致（扣除左栏行号槽后）",
    srcInset != null && dstInset != null
      ? (Math.abs((srcInset - (S.gutter?.w ?? 0)) - dstInset) <= 8 ? "PASS" : "FAIL")
      : "FAIL",
    `左屏内缩 ${srcInset}（含行号槽 ${S.gutter?.w}）→ 正文相对分栏内缩 ${srcInset != null ? srcInset - (S.gutter?.w ?? 0) : "?"}；` +
    `右屏内缩 ${dstInset}；差 ${srcInset != null && dstInset != null ? (srcInset - (S.gutter?.w ?? 0) - dstInset).toFixed(2) : "?"}px`);

  // 双内边距诊断
  const dupV = S.hostPad && S.scPad && S.hostPad.t !== "0px" && S.scPad.t !== "0px";
  const dupH = S.hostPad && S.scPad && S.hostPad.l !== "0px" && S.scPad.l !== "0px";
  ui.add("G5", "★ 无「宿主 + scroller」双重内边距",
    !dupV && !dupH ? "PASS" : "FAIL",
    `宿主 padding=${JSON.stringify(S.hostPad)}；scroller padding=${JSON.stringify(S.scPad)}`);

  /* 全宽态：正文列应仍在内容最大宽内居中 */
  const F = full;
  ui.add("G6", "关预览后框线仍贴满整栏",
    F.host && F.area && Math.abs(F.host.w - F.area.w) <= 40 ? "PASS" : "FAIL",
    `框线(宿主)宽 ${F.host?.w} vs 主区宽 ${F.area?.w}（差 ${F.host && F.area ? F.host.w - F.area.w : "?"}px；右侧有 18px 关闭态分割条，允许 ≤40）`);
});
