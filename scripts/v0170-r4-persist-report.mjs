/**
 * #5 定位探针 7（**决定性**）：记录 CM6 `report()` 的 `docChanged` / `origin` / `text`
 *
 * ## 已有完整矛盾数据（前 6 版探针逐步收窄）
 *
 * ```
 * 阅读面键入 ZQXK 期间（4 次上报）：
 *   len=75 cm=74 pm=74
 *   len=78 cm=74 pm=77     ← App content 变 78（正确），但 **CM6 doc 始终 74**
 * 切到编辑模式窗口内（2 次上报）：
 *   len=74 cm=74 pm=77     ← 上报的 74 就是 CM6 的陈旧 doc
 *   切完：App/tab/localStorage 全变 74，PM 仍 77
 * ```
 *
 * → 结论方向：**CM6 从来没有收到含新字的文本**（`cm` 恒为 74），
 *   切换时它把自己那份陈旧 doc 当成"内容变更"上报，把 App 回滚成 74。
 *   这是「**陈旧来源覆盖**」，不是"旧值被主动写回"。
 *
 * ## 本探针要钉死最后一环：那次上报到底是不是"纯选区/聚焦"事件
 *
 * `CmSourceSurface` 的 `updateListener`：
 * ```ts
 * if (!u.docChanged) {
 *   if (u.selectionSet || u.focusChanged) v.report("typing", undefined, "dom", false);  // ← 纯选区/聚焦
 *   ...
 * }
 * ```
 * 而 `EditorContainer` 把 `docChanged` 只用于"清 ghost"，**没有用它阻止内容回写**：
 * ```ts
 * applySourceInput.current(ev.text, ev.selection.start, { composing, origin, docChanged });
 * ```
 * → 一次**纯 focus/selection** 事件就会带着陈旧全文回写 `sourceContent` 并 `onContentChange`。
 *
 * ## 做法
 * 从 fiber 的 ref 槽找到 `CmSourceSurface` 实例（有 `report` / `emit` 方法），
 * 包一层 `report`，记录 (kind, origin, docChanged, text.length, 当时 doc.length)。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const MARK = "持久化诊断夹具";
const TOKEN = "ZQXK";

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

/** 安装：包装 report，并保留双向 doc 长度 */
const INSTALL = String.raw`
  const T = (window.__T7 = window.__T7 || { ev: [], t0: performance.now(), ok: false });

  // 1) 文档长度双读（CM6 / PM）
  window.__LMD_DOCLEN = function () {
    let cm = -1, pm = -1;
    try {
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      if (v) cm = v.state.doc.length;
    } catch (e) {}
    try {
      const root = document.querySelector("#root") || document.body;
      const k = Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
      let s = k ? root[k] : null;
      if (s && s.current) s = s.current;
      const st = s ? [s] : []; const seen = new Set(); let g = 0;
      while (st.length && g++ < 60000) {
        const f = st.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        if (typeof f.type === "function") {
          let h = f.memoizedState, i = 0;
          while (h && i < 400) {
            const val = h.memoizedState;
            if (val && typeof val === "object" && "current" in val) {
              const cur = val.current;
              if (cur && cur.state && cur.state.doc) {
                const d = cur.state.doc;
                if (d.type !== undefined && d.content !== undefined && typeof d.textBetween === "function") pm = d.content.size;
              }
            }
            h = h.next; i++;
          }
        }
        if (f.sibling) st.push(f.sibling);
        if (f.child) st.push(f.child);
      }
    } catch (e) {}
    return { cm, pm };
  };

  // 2) 包 CmSourceSurface.report（从 fiber ref 槽找实例）
  const findSurface = () => {
    const root = document.querySelector("#root") || document.body;
    const k = Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
    let s = k ? root[k] : null;
    if (s && s.current) s = s.current;
    const st = s ? [s] : []; const seen = new Set(); let g = 0;
    while (st.length && g++ < 60000) {
      const f = st.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      if (typeof f.type === "function") {
        let h = f.memoizedState, i = 0;
        while (h && i < 400) {
          const val = h.memoizedState;
          if (val && typeof val === "object" && "current" in val) {
            const cur = val.current;
            if (cur && typeof cur.report === "function" && typeof cur.emit === "function") return cur;
          }
          h = h.next; i++;
        }
      }
      if (f.sibling) st.push(f.sibling);
      if (f.child) st.push(f.child);
    }
    return null;
  };

  const surface = findSurface();
  if (surface && !surface.__w7) {
    const orig = surface.report;
    surface.report = function (kind, groupId, origin, docChanged, textArg) {
      try {
        const f = (textArg != null) ? textArg : (this.getText ? this.getText() : "");
        const lens = window.__LMD_DOCLEN ? window.__LMD_DOCLEN() : { cm: -1, pm: -1 };
        T.ev.push({
          at: Math.round(performance.now() - T.t0),
          kind, origin, docChanged: !!docChanged,
          textLen: f.length,
          liveDocLen: this.view ? this.view.state.doc.length : -1,
          cm: lens.cm, pm: lens.pm,
          hasTok: f.indexOf(${JSON.stringify(TOKEN)}) >= 0,
        });
      } catch (e) {}
      return orig.call(this, kind, groupId, origin, docChanged, textArg);
    };
    surface.__w7 = true;
    T.ok = true;
  }
  window.__LMD_CONTENT_TRACE = window.__LMD_CONTENT_TRACE || [];
  return { ok: T.ok, found: !!surface };
`;

const PLACE_READER = String.raw`
  const pmEl = document.querySelector(".ProseMirror");
  if (!pmEl) return { ok: false };
  pmEl.focus();
  const anchor = "K02 供定位。";
  const walker = document.createTreeWalker(pmEl, NodeFilter.SHOW_TEXT);
  let hit = null, n;
  while ((n = walker.nextNode())) { if ((n.nodeValue || "").indexOf(anchor) >= 0) { hit = n; break; } }
  if (!hit) return { ok: false };
  const at = hit.nodeValue.indexOf(anchor) + anchor.length;
  const r = document.createRange(); r.setStart(hit, at); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  return { ok: true };
`;

const SNAP = String.raw`
  const TOKEN = ${JSON.stringify(TOKEN)};
  const lens = window.__LMD_DOCLEN ? window.__LMD_DOCLEN() : { cm: -1, pm: -1 };
  const root = document.querySelector("#root") || document.body;
  const k = Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
  let s = k ? root[k] : null;
  if (s && s.current) s = s.current;
  const out = { cm: lens.cm, pm: lens.pm };
  const st = s ? [s] : []; const seen = new Set(); let g = 0;
  while (st.length && g++ < 60000) {
    const f = st.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function") {
      const nm = f.type.name || "?";
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v2 = h.memoizedState;
        if (typeof v2 === "string" && v2.indexOf("供定位") >= 0) out[nm + "#" + i] = { len: v2.length, tok: v2.indexOf(TOKEN) >= 0 };
        h = h.next; i++;
      }
    }
    if (f.sibling) st.push(f.sibling);
    if (f.child) st.push(f.child);
  }
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-persist-report", doc: DOC, docTitle: MARK }, async (ui) => {
  await ui.command("view.preview");
  await sleep(1200);
  const inst = await ui.ev(INSTALL);
  console.log("[report] 仪器:", JSON.stringify(inst));
  ui.add("H0", "CmSourceSurface.report 包装成功", inst && inst.ok ? "PASS" : "FAIL", JSON.stringify(inst));
  if (!inst || !inst.ok) return;

  const typeTok = async () => { for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0)); };

  await ui.ev(PLACE_READER);
  await sleep(200);
  await ui.ev(`window.__T7.ev = []; window.__T7.t0 = performance.now(); return true;`);
  await typeTok();
  await sleep(900);
  const t1 = await ui.ev(`return window.__T7.ev.slice();`);
  console.log(`\n[report] ═══ 阅读面键入期间 report（${t1.length} 次）═══`);
  for (const e of t1) {
    console.log(`  t=${e.at}ms kind=${e.kind} origin=${e.origin} docChanged=${e.docChanged} textLen=${e.textLen} liveDocLen=${e.liveDocLen} cm=${e.cm} pm=${e.pm} hasTok=${e.hasTok}`);
  }
  console.log("[report] 键入后 state：", JSON.stringify(await ui.ev(SNAP)));

  await ui.ev(`window.__T7.ev = []; window.__T7.t0 = performance.now(); return true;`);
  await ui.command("view.edit");
  await sleep(1200);
  const t2 = await ui.ev(`return window.__T7.ev.slice();`);
  console.log(`\n[report] ═══ 切模式窗口内 report（${t2.length} 次）═══`);
  for (const e of t2) {
    console.log(`  t=${e.at}ms kind=${e.kind} origin=${e.origin} docChanged=${e.docChanged} textLen=${e.textLen} liveDocLen=${e.liveDocLen} cm=${e.cm} pm=${e.pm} hasTok=${e.hasTok}`);
  }
  console.log("[report] 切换后 state：", JSON.stringify(await ui.ev(SNAP)));

  const selOnly = t2.filter((e) => !e.docChanged);
  ui.add("H1", "切模式窗口内存在 **docChanged=false 的纯选区/聚焦上报**",
    selOnly.length > 0 ? "FAIL" : "PASS",
    selOnly.map((e) => `t=${e.at} kind=${e.kind} textLen=${e.textLen}`).join("; ") || "无");
  const stale = t2.filter((e) => e.textLen < e.pm);
  ui.add("H2", "该上报携带的文本短于 PM doc（陈旧来源）",
    stale.length > 0 ? "FAIL" : "PASS",
    stale.map((e) => `t=${e.at} textLen=${e.textLen} pm=${e.pm}`).join("; ") || "无");
});
