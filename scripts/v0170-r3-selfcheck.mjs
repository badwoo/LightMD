/**
 * #6 探针自检：确认页面内句柄与 DOM 形态（避免探针 bug 被误当产品缺陷）
 *
 * R2 的教训（triage §2）：探针判据 bug 造成过多次假 FAIL。
 * 因此 #6 动手前必须自证：
 *   1. `.ProseMirror` / `.editor-container` / `.cm-scroller` 在两种模式下各自是否存在、可见
 *   2. PM 的 EditorView 句柄怎么拿（pmViewDesc？）—— 拿不到就不能断言选区
 *   3. CM6 的 EditorView 句柄（cmTile）是否稳定
 *   4. 视口中心行的 mark 提取在两种模式下是否有效
 *   5. 设光标后 sourceSelection 是否真的变了（自检 A8：防恒真）
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const CARET_DOC = [
  "# K01 一级标题", "", "K02 纯文本段落，用来量纯文本基线的映射误差。", "",
  "K03 前面有字 **加粗内容在这里** 后面也有字。", "",
  "- K04 列表项第一项", "- 列表项第二项", "",
  "> K05 引用块里的文字", "",
  "```js", "const K06 = 1;", "```", "",
  "| 表头 A | 表头 B |", "| --- | --- |", "| K07 单元格 | 值 |", "",
  "## K08 二级标题", "", "K09 结尾段落。", "",
].join("\n");

const PROBE = `
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const q = (s) => document.querySelector(s);
  const pm = q(".ProseMirror");
  const rs = q(".editor-container");
  const sc = q(".cm-scroller");
  const cmc = q(".cm-content");
  let cmView = null, pmView = null, pmDescKeys = null, pmDescView = null;
  try { cmView = cmc && cmc.cmTile && cmc.cmTile.view || null; } catch (e) {}
  try {
    if (pm && pm.pmViewDesc) {
      pmDescKeys = Object.keys(pm.pmViewDesc).slice(0, 12);
      pmDescView = !!pm.pmViewDesc.view;
      pmView = pm.pmViewDesc.view || null;
    }
  } catch (e) {}
  // 兜底：从 .editor-container 往上/往下找任何带 pmViewDesc 的元素
  let anyDesc = null;
  const all = document.querySelectorAll("*");
  for (const el of all) { if (el.pmViewDesc && el.pmViewDesc.view) { anyDesc = { tag: el.tagName, cls: String(el.className || "").slice(0, 40), childCount: el.children.length }; break; } }
  return {
    hasPm: !!pm, pmVisible: vis(pm), pmChildCount: pm ? pm.children.length : 0,
    hasReader: !!rs, readerVisible: vis(rs),
    readerSt: rs ? Math.round(rs.scrollTop) : null,
    hasScroller: !!sc, scrollerVisible: vis(sc),
    scrollerSt: sc ? Math.round(sc.scrollTop) : null,
    scrollerMax: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : null,
    cmLines: sc ? sc.querySelectorAll(".cm-line").length : 0,
    cmView: !!cmView, cmDocLen: cmView ? cmView.state.doc.length : null,
    cmSel: cmView ? { from: cmView.state.selection.main.from, to: cmView.state.selection.main.to } : null,
    pmView: !!pmView, pmDescKeys, pmDescView, anyDesc,
    pmSel: pmView ? { from: pmView.state.selection.from, type: pmView.state.selection.$from.parent.type.name } : null,
    activeEl: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
  };
`;

await runBrowserProbe({ name: "v0170-r3-selfcheck", doc: CARET_DOC, docTitle: "K01" }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(3000);
  const inEdit = await ui.ev(PROBE);
  ui.log("[自检] 编辑模式：" + JSON.stringify(inEdit, null, 1));

  await ui.command("view.preview");
  await ui.sleep(2600);
  const inPrev = await ui.ev(PROBE);
  ui.log("[自检] 阅读模式：" + JSON.stringify(inPrev, null, 1));

  await ui.command("view.edit");
  await ui.sleep(2600);
  const back = await ui.ev(PROBE);
  ui.log("[自检] 回编辑：" + JSON.stringify(back, null, 1));

  /* 自检 A8：设光标是否真的生效（防探针恒真） */
  const v = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const view = c && c.cmTile && c.cmTile.view;
    if (!view) return { ok: false };
    const before = view.state.selection.main.from;
    view.dispatch({ selection: { anchor: 42, head: 42 }, scrollIntoView: false, userEvent: "select" });
    const after = view.state.selection.main.from;
    return { ok: true, before, after, docLen: view.state.doc.length };
  `);
  ui.log("[自检 A8] 设置光标 42：" + JSON.stringify(v));
  ui.add("SC1", "CM6 view 句柄可达且 setSelection 生效（防恒真）",
    v.ok && v.after === 42 && v.before !== 42 ? "PASS" : "FAIL", JSON.stringify(v));

  ui.add("SC2", "阅读面 PM view 句柄可达（#6 判据的前提）",
    inPrev.pmView ? "PASS" : "FAIL",
    `pmView=${inPrev.pmView} pmDescKeys=${JSON.stringify(inPrev.pmDescKeys)} anyDesc=${JSON.stringify(inPrev.anyDesc)} pmVisible=${inPrev.pmVisible} childCount=${inPrev.pmChildCount}`);

  ui.add("SC3", "编辑面 .cm-scroller 可见且行已渲染", inEdit.scrollerVisible && inEdit.cmLines > 0 ? "PASS" : "FAIL",
    `visible=${inEdit.scrollerVisible} lines=${inEdit.cmLines} st=${inEdit.scrollerSt}/${inEdit.scrollerMax}`);

  /* 视口中心 mark 自检 */
  const marks = await ui.ev(`
    const pick = (t) => { const m = /(PI\\d{2}|K\\d{2})/.exec(t || ""); return m ? m[1] : null; };
    const sc = document.querySelector(".cm-scroller");
    const out = [];
    if (sc && sc.getClientRects().length) {
      const r = sc.getBoundingClientRect();
      const mid = r.top + sc.clientHeight / 2;
      const lines = Array.from(sc.querySelectorAll(".cm-line"));
      for (const l of lines) {
        const b = l.getBoundingClientRect();
        out.push({ t: (l.textContent || "").slice(0, 24), top: Math.round(b.top - r.top), h: Math.round(b.height), mark: pick(l.textContent), covers: b.top <= mid && b.bottom >= mid });
      }
      return { mid: Math.round(mid - r.top), n: lines.length, out: out.slice(0, 40) };
    }
    return { none: true };
  `);
  ui.log("[自检] 编辑面行几何：" + JSON.stringify(marks).slice(0, 1500));
});
