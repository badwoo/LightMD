/**
 * v0.17.0 R4 · T2 · 「怎么稳定读到 CM6 view」的仪器自检
 *
 * 上一版 diag 出现两件必须分开的事：
 * 1. `/` **确实**进了文档（beforeinput/input 的 data 都是 "/"）——
 *    所以探针的按键有效，不是"没敲进去"；
 * 2. 敲完之后 `document.querySelector(".cm-content").cmTile` 变成 null →
 *    读不到 `view.state.doc`。**这只是读数方式失效，不是产品缺陷。**
 *
 * 若把 (2) 当成产品结论（"文档读不到 = 编辑器坏了"）就会得出完全错误的报告 ——
 * 与 R3 #1 探针 1.0 的 1442px 是同一类错误：**仪器坏了却被解读成产品坏了**。
 *
 * 所以先把「读 view 的稳健路径」找出来：CM6 的 `cmTile` 可能挂在
 * `.cm-content` / `.cm-scroller` / `.cm-editor` / 某个祖先 div 上，
 * 且在重渲染后可能换元素。这里枚举一遍，选一条**在输入前后都成立**的。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

/** 页面内：多路尝试找 CM6 view，返回每条路的状态（不抛异常） */
const PROBE_VIEW = `
  const paths = {};
  const tryEl = (label, el) => {
    if (!el) { paths[label] = "no-element"; return; }
    paths[label] = el.cmTile && el.cmTile.view
      ? { ok: true, len: el.cmTile.view.state.doc.length, lines: el.cmTile.view.state.doc.lines }
      : { ok: false, hasTile: !!el.cmTile };
  };
  tryEl("content", document.querySelector(".cm-content"));
  tryEl("scroller", document.querySelector(".cm-scroller"));
  tryEl("editor", document.querySelector(".cm-editor"));
  // 全局扫描：谁身上挂了 cmTile.view
  const hit = [];
  for (const el of document.querySelectorAll(".cm-editor *, .cm-editor")) {
    if (el.cmTile && el.cmTile.view) hit.push({ cls: String(el.className || el.tagName).slice(0, 40), len: el.cmTile.view.state.doc.length });
  }
  paths.scanned = hit.slice(0, 6);
  // 从 selection 反向找：document.getSelection 的 anchorNode 一路向上
  let selPath = null;
  try {
    const s = document.getSelection();
    let n = s && s.anchorNode;
    let guard = 0;
    while (n && guard++ < 30) {
      const el = n.nodeType === 1 ? n : n.parentElement;
      if (el && el.cmTile && el.cmTile.view) { selPath = { cls: String(el.className || el.tagName).slice(0, 40), len: el.cmTile.view.state.doc.length }; break; }
      n = n.parentNode;
    }
  } catch (e) {}
  paths.fromSelection = selPath;
  paths.contentIsConnected = !!document.querySelector(".cm-content") && document.querySelector(".cm-content").isConnected;
  return paths;
`;

await runBrowserProbe({ name: "v0170-r4-viewprobe", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);

  ui.log("[before] " + JSON.stringify(await ui.ev(PROBE_VIEW), null, 1));

  // 敲一个普通字符，看 view 路径是否还成立
  await ui.key("a", "KeyA", 65);
  await ui.sleep(400);
  ui.log("[after 'a'] " + JSON.stringify(await ui.ev(PROBE_VIEW), null, 1));

  // 敲 `/`
  await ui.key("/", "Slash", 191);
  await ui.sleep(700);
  ui.log("[after '/'] " + JSON.stringify(await ui.ev(PROBE_VIEW), null, 1));

  // 看 slash 菜单到底在不在（含 portal 与 display）
  const menuInfo = await ui.ev(`
    const m = document.querySelector(".slash-command-menu");
    const all = Array.from(document.querySelectorAll("[class*=slash]")).map(e => {
      const cs = getComputedStyle(e);
      return { cls: String(e.className).slice(0, 46), display: cs.display, visibility: cs.visibility, opacity: cs.opacity, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), childs: e.children.length };
    });
    const bodyKids = Array.from(document.body.children).map(e => ({ tag: e.tagName, cls: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || "").slice(0, 40), kids: e.children.length, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }));
    return { found: !!m, all, bodyKids };
  `);
  ui.log("[menu] " + JSON.stringify(menuInfo, null, 1));

  await ui.shot("viewprobe");
});
