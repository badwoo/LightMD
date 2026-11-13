/**
 * T1 一次性诊断探针（第二版）：**只验观测手段 + 抓基线**，不产出产品结论。
 *
 * ## 第一版为什么 FAIL（记下来防重蹈）
 * 第一版靠 `fiber.type.name === "App"` 找 App 组件 → **恒 false**：
 * 生产构建里组件名被压缩/包成 memo，`type` 上拿不到 "App"。
 * 同版还想靠 `pmEl.pmViewDesc.view` 取 PM 的 EditorView → 也恒 null
 * （`pmViewDesc` 是文档级 NodeViewDesc，**没有 view 字段**，R3 的自检探针已实测）。
 * 这两条都是**判据 bug**，不是产品缺陷 —— 第三轮 §1 的教训。
 *
 * ## 第二版的找法：从 fiber 的 hooks 链反查，不认名字
 * - **App 的 `content`**：某个函数组件的 `useState` 槽里是**含夹具 marker 的字符串**；
 * - **PM view / CM6 view**：某个 `useRef` 槽是 `{current: EditorView}`，
 *   用 `state.doc.type !== undefined` 区分 PM（PM doc 是 Node，带 type）与
 *   CM6（`state.doc` 是 Text，**不带** type、有 `toString`）；
 * - **openTabs**：某个 state 槽是数组且元素带 `content` 字段。
 * 三条都有"自检"输出，自检不过就**不产出产品结论**。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const TOKEN = "ZQXK";
const MARK = "持久化诊断夹具";

const DOC = [
  `# ${MARK}`,
  "",
  "第一段内容。K01 供定位。",
  "",
  "第二段内容。K02 供定位。",
  "",
  "第三段内容。K03 供定位。",
  "",
  "第四段内容。K04 供定位。",
  "",
].join("\n");

const INSTALL = String.raw`
  if (!window.__T1) {
    const S = (window.__T1 = { writes: [], hookOk: false });
    try {
      const proto = Storage.prototype;
      const orig = proto.setItem;
      proto.setItem = function (k, v) {
        try {
          if (k === "lightmd-content") S.writes.push({ len: String(v).length, at: Math.round(performance.now()) });
        } catch (e) {}
        return orig.call(this, k, v);
      };
      S.hookOk = proto.setItem !== orig;
    } catch (e) { S.hookOk = false; }
  }
  return window.__T1.hookOk;
`;

const READ = String.raw`
  const MARK = ${JSON.stringify(MARK)};
  const TOKEN = ${JSON.stringify(TOKEN)};

  // ── 从 #root 挖 fiber 树 ──
  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (!start && root._reactRootContainer) start = root._reactRootContainer._internalRoot && root._reactRootContainer._internalRoot.current;
  if (start && start.current) start = start.current;

  let fiberCount = 0;
  const contentStates = [];   // { fiberName, idx, len, hasToken, tail }
  const tabStates = [];       // { fiberName, idx, tabs: [...] }
  const pmViews = [];
  const cmViews = [];

  const hookChain = (fiber) => {
    const out = [];
    let h = fiber.memoizedState, i = 0;
    while (h && i < 300) { out.push(h); h = h.next; i++; }
    return out;
  };

  const stack = start ? [start] : [];
  const seen = new Set();
  let guard = 0;
  while (stack.length && guard++ < 50000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    fiberCount++;
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      const hooks = hookChain(f);
      for (let i = 0; i < hooks.length; i++) {
        const v = hooks[i].memoizedState;
        // (a) 含 marker 的字符串 state → App 的 content
        if (typeof v === "string" && v.indexOf(MARK) >= 0) {
          contentStates.push({ idx: i, len: v.length, hasToken: v.indexOf(TOKEN) >= 0, tail: v.slice(-80) });
        }
        // (b) ref 槽 → EditorView
        if (v && typeof v === "object" && "current" in v) {
          const cur = v.current;
          if (cur && cur.state && cur.state.doc) {
            const d = cur.state.doc;
            const isPM = d.type !== undefined && d.content !== undefined && typeof d.textBetween === "function";
            if (isPM) {
              let txt = "";
              try { txt = d.textBetween(0, d.content.size, "\n", "\n"); } catch (e) { txt = d.textContent || ""; }
              pmViews.push({ idx: i, len: txt.length, hasToken: txt.indexOf(TOKEN) >= 0, tail: txt.slice(-80) });
            } else if (typeof d.toString === "function") {
              const txt = d.toString();
              cmViews.push({ idx: i, len: txt.length, hasToken: txt.indexOf(TOKEN) >= 0, tail: txt.slice(-80) });
            }
          }
        }
        // (c) 数组且元素带 content → openTabs
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "content" in v[0]) {
          tabStates.push({ idx: i, tabs: v.map((t) => ({
            name: t.name || null,
            isDirty: !!t.isDirty,
            len: typeof t.content === "string" ? t.content.length : -1,
            hasToken: typeof t.content === "string" && t.content.indexOf(TOKEN) >= 0,
            tail: typeof t.content === "string" ? t.content.slice(-60) : null,
          })) });
        }
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }

  // contentStates 可能有多个（App 的 content + 别处缓存），取**最长**的那条
  contentStates.sort((a, b) => b.len - a.len);
  const app = contentStates[0] || null;
  const tabs = tabStates.length ? tabStates[0].tabs : null;

  const S = window.__T1 || {};
  return {
    diag: {
      startFiber: !!start, fiberCount,
      appContentCandidates: contentStates.length,
      pmViews: pmViews.length, cmViews: cmViews.length,
      tabCandidates: tabStates.length,
      hookOk: !!S.hookOk,
    },
    app,
    tabs,
    pm: pmViews.length ? pmViews[0] : null,
    src: cmViews.length ? cmViews[0] : null,
    srcVisible: (() => { const sc = document.querySelector(".cm-scroller"); return !!sc && sc.getClientRects().length > 0; })(),
    readerVisible: (() => { const el = document.querySelector(".editor-container"); return !!el && el.getClientRects().length > 0; })(),
    ls: (() => { try { const v = localStorage.getItem("lightmd-content") || ""; return { len: v.length, hasToken: v.indexOf(TOKEN) >= 0 }; } catch (e) { return null; } })(),
    writes: (window.__T1 && window.__T1.writes || []).slice(-10),
    pmDomTextHasToken: (() => { const el = document.querySelector(".ProseMirror"); return !!el && (el.textContent || "").indexOf(TOKEN) >= 0; })(),
  };
`;

/** 在阅读面按"文本层锚点"落光标（不依赖任何内部 view 落点） */
const PLACE = String.raw`
  const pmEl = document.querySelector(".ProseMirror");
  if (!pmEl) return { ok: false, why: "no .ProseMirror" };
  pmEl.focus();
  const sel = window.getSelection();
  // 在 DOM 里找含锚点文本的文本节点，把光标放到该文本末尾
  const anchor = "K02 供定位。";
  const walker = document.createTreeWalker(pmEl, NodeFilter.SHOW_TEXT);
  let hit = null, n;
  while ((n = walker.nextNode())) {
    if ((n.nodeValue || "").indexOf(anchor) >= 0) { hit = n; break; }
  }
  if (!hit) return { ok: false, why: "anchor text node not found" };
  const at = hit.nodeValue.indexOf(anchor) + anchor.length;
  const r = document.createRange();
  r.setStart(hit, at); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  // 让 ProseMirror 把 DOM 选区同步成 PM 选区
  document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  return { ok: true, text: hit.nodeValue, at };
`;

await runBrowserProbe({ name: "v0170-r4-persist-diag", doc: DOC, docTitle: MARK }, async (ui) => {
  const read = () => ui.ev(READ);

  await ui.command("view.preview");
  await sleep(1200);
  console.log("[diag] 装桩 =", await ui.ev(INSTALL));

  let st = await read();
  console.log("[diag] 仪器自检 =", JSON.stringify(st.diag));
  const instrumentOk =
    st.diag.startFiber && st.diag.appContentCandidates > 0 && st.diag.pmViews > 0 && st.diag.hookOk;
  ui.add("I0", "仪器自检（fiber 反查 content / PM view / Storage 打桩）",
    instrumentOk ? "PASS" : "FAIL", JSON.stringify(st.diag));
  if (!instrumentOk) {
    console.log("[diag] ⚠️ 仪器不可用，本探针不产出产品结论");
    return;
  }

  console.log("[diag] 基线 app =", JSON.stringify(st.app));
  console.log("[diag] 基线 pm  =", JSON.stringify(st.pm));
  console.log("[diag] 基线 tabs=", JSON.stringify(st.tabs));

  const placed = await ui.ev(PLACE);
  console.log("[diag] 光标落点 =", JSON.stringify(placed));
  await sleep(350);

  for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0));
  await sleep(80);

  const imm = await read();
  await sleep(1000);
  const at1s = await read();

  const line = (label, s) =>
    `${label}: pm=${s.pm && s.pm.hasToken} app=${s.app && s.app.hasToken} ` +
    `tab=${s.tabs && s.tabs[0] && s.tabs[0].hasToken} ls=${s.ls && s.ls.hasToken} ` +
    `src=${s.src && s.src.hasToken}`;
  console.log("[diag] 立即  " + line("", imm));
  console.log("[diag] 1000ms" + line("", at1s));
  console.log("[diag] writes =", JSON.stringify(at1s.writes));

  ui.add("I1", "阅读面键入后 PM doc 含新字（仪器正向证明）", at1s.pm && at1s.pm.hasToken ? "PASS" : "FAIL", "");
  ui.add("I2", "阅读面键入后 立即 App content 是否含新字", imm.app && imm.app.hasToken ? "PASS" : "FAIL",
    `app.len=${imm.app && imm.app.len}`);
  ui.add("I3", "阅读面键入后 ≤1000ms App content 含新字", at1s.app && at1s.app.hasToken ? "PASS" : "FAIL",
    `app.len=${at1s.app && at1s.app.len} tab.len=${at1s.tabs && at1s.tabs[0] && at1s.tabs[0].len}`);
  ui.add("I4", "阅读面键入后 ≤1000ms 标签 content 含新字", at1s.tabs && at1s.tabs[0] && at1s.tabs[0].hasToken ? "PASS" : "FAIL", "");
  ui.add("I5", "阅读面键入后 ≤1000ms localStorage 含新字", at1s.ls && at1s.ls.hasToken ? "PASS" : "FAIL", "");
});
