/**
 * v0.17.0 R4 · T2 · 探针 DOM 侦察（一次性的选择器确认，不是产品判据）
 *
 * 目的：在主探针写死选择器之前，先确认
 *  - 编辑面滚动容器是不是 `.cm-scroller`
 *  - 阅读面滚动容器是 `.editor-container` 还是 `.ProseMirror`
 *  - 语法辅助栏（SyntaxHelper）在编辑模式下怎么打开、条目选择器是什么
 *  - 右键菜单 / 斜杠菜单的条目选择器与文案
 * 任何一个猜错都会让主探针静默 FAIL（上一轮踩过 5 个这样的坑）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

const DUMP = `
  const out = { url: location.href };
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
  out.cmScroller = !!q(".cm-scroller");
  out.cmScrollerBox = box(q(".cm-scroller"));
  out.cmScrollerGeom = q(".cm-scroller") ? { st: Math.round(q(".cm-scroller").scrollTop), sh: Math.round(q(".cm-scroller").scrollHeight), ch: Math.round(q(".cm-scroller").clientHeight) } : null;
  out.editorContainer = !!q(".editor-container");
  out.editorContainerGeom = q(".editor-container") ? { st: Math.round(q(".editor-container").scrollTop), sh: Math.round(q(".editor-container").scrollHeight), ch: Math.round(q(".editor-container").clientHeight), oy: getComputedStyle(q(".editor-container")).overflowY } : null;
  out.proseMirror = !!q(".ProseMirror");
  out.proseMirrorGeom = q(".ProseMirror") ? { st: Math.round(q(".ProseMirror").scrollTop), sh: Math.round(q(".ProseMirror").scrollHeight), ch: Math.round(q(".ProseMirror").clientHeight), oy: getComputedStyle(q(".ProseMirror")).overflowY } : null;
  out.mode = q(".cm-editor") ? "source" : (q(".ProseMirror") ? "preview" : "none");
  out.toolbarBtns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).map(b => b.getAttribute("title")).slice(0, 30);
  out.syntaxHelper = !!q(".syntax-helper");
  out.syntaxItems = Array.from(document.querySelectorAll(".syntax-helper-item")).map(e => (e.textContent || "").trim().slice(0, 24)).slice(0, 40);
  out.outline = !!q(".outline-panel, .outline");
  out.sideHint = Array.from(document.querySelectorAll("[class*=outline],[class*=syntax]")).map(e => e.className && String(e.className).slice(0, 50)).slice(0, 12);
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-scroll-diag", doc: DOC }, async (ui) => {
  ui.log("[diag] impl = " + ui.impl);
  ui.log("[mode=edit] " + JSON.stringify(await ui.ev(DUMP), null, 1));

  // 打开大纲/语法栏（AppShell 的 outline 槽位）
  await ui.command("view.toggleOutline");
  await ui.sleep(800);
  ui.log("[after toggleOutline] " + JSON.stringify(await ui.ev(DUMP), null, 1));

  // 找一个语法栏条目点击，看有没有反应
  const clickInfo = await ui.ev(`
    const items = Array.from(document.querySelectorAll(".syntax-helper-item"));
    const target = items.find(e => (e.textContent || "").indexOf("粗体") >= 0);
    if (!target) return { ok: false, n: items.length };
    const r = target.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (target.textContent||"").trim().slice(0,30) };
  `);
  ui.log("[syntax click target] " + JSON.stringify(clickInfo));
  if (clickInfo.ok) {
    const before = await ui.readSourceTextEx();
    await ui.click(clickInfo.x, clickInfo.y);
    await ui.sleep(700);
    const after = await ui.readSourceTextEx();
    ui.log(`[syntax click effect] len ${before?.len} -> ${after?.len}`);
    ui.log("[after syntax click dump] " + JSON.stringify(await ui.ev(DUMP), null, 1));
  }

  // 切阅读模式，看滚动容器
  await ui.command("view.preview");
  await ui.sleep(1600);
  ui.log("[mode=preview] " + JSON.stringify(await ui.ev(DUMP), null, 1));

  await ui.shot("diag");
});
