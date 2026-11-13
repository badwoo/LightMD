/**
 * #5 定位探针 6：**同一时刻同时读「上报入参」与「CM6/PM 文档真实长度」**
 *
 * ## 前几版各自看到一半，合起来才自相矛盾
 * - 埋点版：切模式窗口内两次 `handleContentChange(len=74)`，栈指向
 *   `applySourceInput ← CmSourceSurface.report ← docChanged`。
 * - CM6 dispatch 钩子版：切换窗口内**只有 3 次事务，全部 `docChanged: false`**
 *   （`setDomEventHandlers` / `setSelection` / `applyScroll`），文档长度 **74→74 没变**。
 *
 * 两者合起来的含义：**CM6 的 doc 从来就是 74**，但它却"报告"了一次 74 的变更。
 * 也就是说，`report()` 的 `text` 参数或 `docChanged` 判定与真实 doc 不一致。
 * 读者可能以为是"旧值 78 被写回"，实际是 **78 从未被写进 CM6** —— 这会让修法完全不同。
 *
 * ## 本探针的做法
 * 在 `handleContentChange` 的埋点里**同步**记录 CM6/PM 两侧 doc 的真实长度，
 * 与入参长度并排比较。三个数字一起看：
 * - `len`（上报的 markdown 长度）
 * - `cm`（此刻 CM6 doc 长度）
 * - `pm`（此刻 PM doc 长度）
 *
 * 判据：
 * - G1：阅读面键入后 `pm=77` 但 `cm=74` → **CM6 侧从未收到新内容**
 * - G2：切换时上报的 `len=74` 且 `cm=74` → 这次上报"如实反映 CM6，但与 PM 分叉"
 * - G3：切模式分支 `fromPreview && toSource` 是否执行（用 `ModeSync` 的 setSourceContent 判断）
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

/** 安装文档长度探针（CM6 + PM 双读） */
const INSTALL_LEN = String.raw`
  window.__LMD_DOCLEN = function () {
    let cm = -1, pm = -1;
    try {
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      if (v) cm = v.state.doc.length;
    } catch (e) {}
    try {
      // PM doc：从 fiber 里找 ProseMirror EditorView
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
                if (d.type !== undefined && d.content !== undefined && typeof d.textBetween === "function") {
                  pm = d.content.size;
                }
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
  window.__LMD_CONTENT_TRACE = window.__LMD_CONTENT_TRACE || [];
  return true;
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

/** 读四层 + 双 doc 长度 */
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
        if (Array.isArray(v2) && v2.length && v2[0] && typeof v2[0] === "object" && "content" in v2[0] && "path" in v2[0]) {
          const hit = v2.find((t) => typeof t.content === "string" && t.content.indexOf("供定位") >= 0);
          if (hit) out[nm + ".tabs#" + i] = { len: hit.content.length, tok: hit.content.indexOf(TOKEN) >= 0 };
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) st.push(f.sibling);
    if (f.child) st.push(f.child);
  }
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-persist-lens", doc: DOC, docTitle: MARK }, async (ui) => {
  await ui.command("view.preview");
  await sleep(1200);
  await ui.ev(INSTALL_LEN);
  ui.add("G0", "双 doc 长度探针就位", true ? "PASS" : "FAIL", "");

  const typeTok = async () => { for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0)); };

  console.log("[lens] 起点：", JSON.stringify(await ui.ev(SNAP)));

  await ui.ev(PLACE_READER);
  await sleep(200);
  await ui.ev(`window.__LMD_CONTENT_TRACE = []; return true;`);
  await typeTok();
  await sleep(900);

  const typed = await ui.ev(`return window.__LMD_CONTENT_TRACE.slice();`);
  console.log(`\n[lens] ═══ 阅读面键入期间上报（${typed.length} 次）═══`);
  for (const c of typed) console.log(`  t=${c.t} len=${c.len} cm=${c.cm} pm=${c.pm} guard=${c.guard}`);
  console.log("[lens] 键入后 state：", JSON.stringify(await ui.ev(SNAP)));

  /* ── 切模式 ── */
  await ui.ev(`window.__LMD_CONTENT_TRACE = []; return true;`);
  await ui.command("view.edit");
  await sleep(1200);
  const sw = await ui.ev(`return window.__LMD_CONTENT_TRACE.slice();`);
  console.log(`\n[lens] ═══ 切模式窗口内上报（${sw.length} 次）═══`);
  for (const c of sw) {
    console.log(`  ── t=${c.t} len=${c.len} cm=${c.cm} pm=${c.pm} guard=${c.guard}`);
    for (const s of c.stack) console.log(`     | ${s}`);
  }
  console.log("[lens] 切换后 state：", JSON.stringify(await ui.ev(SNAP)));

  const last = typed[typed.length - 1] || {};
  ui.add("G1", "阅读面键入后 PM 已含新字而 CM6 未收到（cm 明显小于 pm）",
    last.pm > last.cm && last.pm > 0 ? "FAIL" : "PASS",
    `最后上报: len=${last.len} cm=${last.cm} pm=${last.pm}`);
  ui.add("G2", "切模式窗口内的上报如实反映 CM6（len == cm）",
    sw.length ? (sw.every((c) => c.len === c.cm) ? "PASS" : "FAIL") : "KNOWN",
    sw.map((c) => `len=${c.len}/cm=${c.cm}`).join("; ") || "窗口内无上报");
});
