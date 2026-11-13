/**
 * #6 块级映射取证：源码顶层块 ↔ PM 顶层块 的对应关系与"块内文本"形态
 *
 * 目的：
 *  1. 确认 PM 顶层块能不能拿到源码行区间（`parser.ts` 的 B6 `blockSourceMap`，
 *     DOM 上以 `data-src-line` 暴露，探针经 pmViewDesc.node 读属性对照）
 *  2. 打印每个块的 `textContent`（**关键**：PM 文本不含 markdown 语法符，
 *     且嵌套块——列表项/表格单元格——会以什么形态出现在 textContent 里）
 *  3. 量化"源码块文本 vs PM 块文本"的长度差（= 语法符占用）
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const DOC = [
  "# K01 一级标题", "", "K02 纯文本段落，用来量纯文本基线的映射误差。", "",
  "K03 前面有字 **加粗内容在这里** 后面也有字。", "",
  "- K04 列表项第一项", "- 列表项第二项", "",
  "> K05 引用块里的文字", "",
  "```js", "const K06 = 1;", "```", "",
  "| 表头 A | 表头 B |", "| --- | --- |", "| K07 单元格 | 值 |", "",
  "## K08 二级标题", "", "K09 结尾段落。", "",
].join("\n");

const DUMP = `
  const sels = [".code-block-wrapper",".table-wrapper",".mermaid-block-wrapper",".math-block-wrapper","li.task-item",".image-wrapper"];
  let view = null;
  for (const s of sels) {
    for (const el of Array.from(document.querySelectorAll(s))) {
      const spec = el.pmViewDesc && el.pmViewDesc.spec;
      if (spec && spec.view) { view = spec.view; break; }
    }
    if (view) break;
  }
  const pm = document.querySelector(".ProseMirror");
  if (view) {} else if (pm && pm.pmViewDesc && pm.pmViewDesc.view) view = pm.pmViewDesc.view;
  if (!view) return { ok:false };
  const blocks = [];
  view.state.doc.forEach((node, offset, index) => {
    const attrs = node.attrs || {};
    blocks.push({
      index, offset, type: node.type.name, nodeSize: node.nodeSize,
      textLen: node.textContent.length,
      text: node.textContent.slice(0, 70),
      attrs: { emptyLine: attrs.emptyLine, pad: attrs.pad, level: attrs.level },
      // 子块（列表项/表格单元格）—— 决定 textContent 是否可当作"块内文本"
      children: node.childCount,
      childTypes: (() => { const t = []; node.forEach(c => t.push(c.type.name)); return t.slice(0, 6); })(),
      childTexts: (() => { const t = []; node.forEach(c => t.push(c.textContent.slice(0, 30))); return t.slice(0, 6); })(),
    });
  });
  // 源码侧
  const c = document.querySelector(".cm-content");
  const cv = c && c.cmTile && c.cmTile.view;
  const srcLines = [];
  if (cv) { const d = cv.state.doc; for (let i = 1; i <= d.lines; i++) srcLines.push({ n: i - 1, text: d.line(i).text }); }
  // DOM 侧 data-src-line
  const domSrcLine = Array.from(document.querySelectorAll(".ProseMirror > [data-src-line]")).map(el => ({
    tag: el.tagName, srcLine: el.getAttribute("data-src-line"), blockIdx: el.getAttribute("data-lmd-block-index"),
    text: (el.textContent || "").slice(0, 40),
  }));
  return { ok: true, docSize: view.state.doc.content.size, blocks, srcLines, domSrcLine, srcText: cv ? cv.state.doc.toString() : null };
`;

await runBrowserProbe({ name: "v0170-r3-blocks", doc: DOC, docTitle: "K01" }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2800);
  await ui.command("view.preview");
  await ui.sleep(2600);
  const d = await ui.ev(DUMP);
  ui.log(`[blocks] docSize=${d.docSize} blocks=${d.blocks.length}`);
  ui.log("──── PM 顶层块 ────");
  for (const b of d.blocks) {
    ui.log(
      `  #${String(b.index).padStart(2)} @${String(b.offset).padStart(4)} ${b.type.padEnd(12)} ` +
        `textLen=${String(b.textLen).padStart(3)} children=${b.children}[${b.childTypes.join(",")}] ` +
        `emptyLine=${b.attrs.emptyLine ?? ""} pad=${b.attrs.pad ?? ""} level=${b.attrs.level ?? ""} :: ${JSON.stringify(b.text)}`,
    );
    if (b.children > 1 || (b.childTypes[0] && b.childTypes[0] !== "text")) {
      ui.log(`        childTexts=${JSON.stringify(b.childTexts)}`);
    }
  }
  ui.log("──── data-src-line（DOM）────");
  for (const x of d.domSrcLine) ui.log(`  srcLine=${x.srcLine} blockIdx=${x.blockIdx} ${x.tag} :: ${JSON.stringify(x.text)}`);
  ui.log("──── 源码行 ────");
  for (const l of (d.srcLines || [])) ui.log(`  L${String(l.n).padStart(2)} :: ${JSON.stringify(l.text)}`);
  ui.add("BLK", "PM 块结构与源码行对齐取证", d.ok ? "PASS" : "FAIL", `blocks=${d.blocks.length} srcLines=${(d.srcLines||[]).length} domSrcLine=${d.domSrcLine.length}`);
});
