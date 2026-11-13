/**
 * v0.17.0 R4 · T2 · 敲 `/` 后编辑器消失的**根因取证**
 *
 * ## 已确证的事实（`v0170-r4-remount.mjs`）
 * - 敲 `/` 前：`.cm-editor` / `.cm-content` / `.cm-scroller` 各 1 个，`cmTile.view` 可读；
 * - 敲 `/` 后 **150ms 内**：`.cm-editor` **被从 DOM 移除**（MutationObserver 抓到
 *   `removed-cm-editor`），`.cm-content` 数量 = **0**，且 **1050ms 后仍未恢复**；
 * - 旧 `view` 引用仍存活（`len=8102`，未销毁）→ 说明是 **React 把宿主元素换掉了**，
 *   不是 CM6 自毁。
 *
 * ## 这一步要回答（别再往下推）
 * Q1 编辑器消失后，页面上**还剩什么**？（是整块 `EditorContainer` 没了，还是只换了个 DOM 节点？）
 * Q2 说明里的 `/` **字符有没有真的落进文档**？（旧 view 长 8101→8102，倾向"进了"）
 * Q3 是不是**只有 `/` 这样**？普通字母（`a`）会不会也这样？→ 决定是 slash 专属还是通用重渲染
 * Q4 是否与 `viewMode` / 标签状态变化有关？（读 store 的实时值）
 *
 * ⚠️ Q3 是关键分叉：
 * - 若**只有 `/`** 触发 → 与 `slashCommandOpen` 的渲染路径直接相关；
 * - 若**任意输入**都触发 → 是"每次输入都重建编辑器"那个 **P0-1 老缺陷回归**
 *   （该项目 v0.17.0 修过「用户每敲 1 字符编辑器重建」，会重建整个 CM6）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

const SNAP = `
  const roots = Array.from(document.body.children).map(e => ({
    tag: e.tagName, cls: String((e.className && e.className.baseVal !== undefined) ? e.className.baseVal : (e.className || "")).slice(0, 40),
    kids: e.children.length, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height),
  }));
  const cnt = (s) => document.querySelectorAll(s).length;
  return {
    roots,
    nEditor: cnt(".cm-editor"), nContent: cnt(".cm-content"), nScroller: cnt(".cm-scroller"),
    nEditorContainer: cnt(".editor-container"), nSourcePane: cnt("[class*=source]"),
    nProseMirror: cnt(".ProseMirror"), nTextarea: cnt("textarea.source-editor"),
    nSlashMenu: cnt(".slash-command-menu"), nSlashItem: cnt(".slash-command-item"),
    nFormatToolbar: cnt(".source-format-toolbar"), nSyntaxHelper: cnt(".syntax-helper"),
    nApp: cnt(".app"), nShell: cnt(".app-shell, [class*=shell]"),
    bodyText: (document.body.innerText || "").slice(0, 120).replace(/\\n/g, " | "),
  };
`;

const VIEWLEN = `
  const c = document.querySelector(".cm-content");
  const v = (c && c.cmTile && c.cmTile.view) || window.__V0 || null;
  if (!v) return { ok: false };
  return { ok: true, len: v.state.doc.length, destroyed: !!v.isDestroyed, domHasView: !!(c && c.cmTile && c.cmTile.view) };
`;

await runBrowserProbe({ name: "v0170-r4-slash-root", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  await ui.ev(`
    window.__V0 = (() => { const c = document.querySelector(".cm-content"); return (c && c.cmTile && c.cmTile.view) || null; })();
    window.__EVT = [];
    window.__MO = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n.nodeType !== 1) continue;
          const cls = String(n.className || "");
          if (/cm-editor|cm-content|cm-scroller|editor-container/.test(cls)) window.__EVT.push({ t: "rm", cls: cls.slice(0, 40), at: Math.round(performance.now()) });
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const cls = String(n.className || "");
          if (/cm-editor|cm-content|cm-scroller|editor-container/.test(cls)) window.__EVT.push({ t: "add", cls: cls.slice(0, 40), at: Math.round(performance.now()) });
        }
      }
    });
    window.__MO.observe(document.body, { childList: true, subtree: true });
    return true;
  `);

  ui.log("[t0] " + JSON.stringify(await ui.ev(SNAP), null, 1));
  ui.log("[t0] view = " + JSON.stringify(await ui.ev(VIEWLEN)));

  /* ── Q3-a：普通字母 `a`（对照组）── */
  await ui.ev(`window.__EVT = []; return true;`);
  await ui.key("a", "KeyA", 65);
  await ui.sleep(700);
  ui.log("[a] 敲 'a' 后 " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[a] view = " + JSON.stringify(await ui.ev(VIEWLEN)));
  ui.log("[a] DOM 事件 = " + JSON.stringify(await ui.ev(`return window.__EVT || []`)));

  /* ── Q3-b：敲 `/` ── */
  await ui.ev(`window.__EVT = []; return true;`);
  await ui.key("/", "Slash", 191);
  await ui.sleep(120);
  ui.log("[/] 敲 '/' 后 120ms " + JSON.stringify(await ui.ev(SNAP), null, 1));
  await ui.sleep(1200);
  ui.log("[/] 敲 '/' 后 1320ms " + JSON.stringify(await ui.ev(SNAP), null, 1));
  ui.log("[/] view = " + JSON.stringify(await ui.ev(VIEWLEN)));
  ui.log("[/] DOM 事件 = " + JSON.stringify(await ui.ev(`return window.__EVT || []`)));

  /* ── Q4：store 状态 ── */
  const store = await ui.ev(`
    // React 18 把 store 挂在 fiber 上；这里退一步，从 localStorage / DOM 里的可见信号推断
    const ls = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/view|mode|tab/i.test(k)) ls[k] = String(localStorage.getItem(k)).slice(0, 80); } } catch (e) {}
    return { ls };
  `);
  ui.log("[store] " + JSON.stringify(store, null, 1));

  /* ── Q1：消失后还剩什么 —— 截全屏 ── */
  await ui.shot("slash-root");

  /* ── 补充：用 JS 直接插入文本（不经键盘）看是否也重建 ── */
  const before = await ui.ev(VIEWLEN);
  await ui.ev(`
    // 直接派发一次真实的 beforeinput（CM6 会把它当输入处理）
    const c = document.querySelector(".cm-content");
    if (!c) return false;
    c.focus();
    const ev = new InputEvent("beforeinput", { inputType: "insertText", data: "b", bubbles: true, cancelable: true });
    c.dispatchEvent(ev);
    return true;
  `);
  await ui.sleep(700);
  ui.log("[direct-beforeinput] " + JSON.stringify(await ui.ev(SNAP)));
  ui.log("[direct-beforeinput] viewBefore=" + JSON.stringify(before) + " viewAfter=" + JSON.stringify(await ui.ev(VIEWLEN)));
});
