/**
 * #5 修复的**回归护栏**探针（T1 / fix-persist）
 *
 * ## 为什么必须单独一份
 * 本次修法在 `applySourceInput`（**每键热路径**）里加了拦截，改错的典型后果是：
 * - 编辑面正常打字**不再落内容**（最严重：把修复变成更大的数据丢失）
 * - 纯光标移动之后光标/字数/slash 语义失效
 * - T2 刚修的「Esc 关掉斜杠菜单」被短路回弹
 *
 * 所以判据是**双向**的：既要证明"该拦的拦住了"，也要证明"不该拦的照常跑"。
 *
 * | id | 场景 | 期望 |
 * |---|---|---|
 * | R1 | 编辑面真实键入 | 内容落进 App / 标签 / CM6（**不得因拦截而失效**） |
 * | R2 | 编辑面纯光标移动（方向键） | 内容不变、光标跟随、无假内容写入 |
 * | R3 | 回车换行 | 内容正常落库 |
 * | R4 | Ctrl+Z 撤销 | 撤销生效（bridge 事务路径不被误伤） |
 * | R5 | 阅读面打字 → 切编辑 | App 不回滚（本修复的主判据） |
 * | R6 | 阅读面打字 → 切编辑 → 切回阅读 | 新字仍在 |
 *
 * ⚠️ R6 用**独立 token**，其余场景共用 SAME token（不做夹具复位，理由见主探针注释）。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

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

const readScript = (tok) => String.raw`
  const MARK = ${JSON.stringify(MARK)};
  const TOKEN = ${JSON.stringify(tok)};
  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (start && start.current) start = start.current;
  const contentStates = [], tabStates = [], pmViews = [];
  const stack = start ? [start] : []; const seen = new Set(); let g = 0;
  while (stack.length && g++ < 60000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        if (typeof v === "string" && v.indexOf(MARK) >= 0) contentStates.push({ len: v.length, tok: v.indexOf(TOKEN) >= 0 });
        if (v && typeof v === "object" && "current" in v) {
          const cur = v.current;
          if (cur && cur.state && cur.state.doc) {
            const d = cur.state.doc;
            if (d.type !== undefined && d.content !== undefined && typeof d.textBetween === "function") {
              let txt = ""; try { txt = d.textBetween(0, d.content.size, "\n", "\n"); } catch (e) { txt = d.textContent || ""; }
              pmViews.push({ len: txt.length, tok: txt.indexOf(TOKEN) >= 0 });
            }
          }
        }
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "content" in v[0] && "path" in v[0]) {
          tabStates.push(v.map((t) => ({ len: typeof t.content === "string" ? t.content.length : -1, tok: typeof t.content === "string" && t.content.indexOf(TOKEN) >= 0 })));
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  contentStates.sort((a, b) => b.len - a.len);
  let tab = null;
  for (const arr of tabStates) { const hit = arr.find((t) => t.len > 60); if (hit) { tab = hit; break; } }
  let cm = null, cmSel = null;
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v) {
      const s = v.state.doc.sliceString(0, v.state.doc.length);
      cm = { len: s.length, tok: s.indexOf(TOKEN) >= 0 };
      const m = v.state.selection.main;
      cmSel = { from: m.from, to: m.to, head: m.head };
    }
  } catch (e) {}
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  return {
    app: contentStates[0] || null, tab, pm: pmViews[0] || null, cm, cmSel,
    pane: { reader: vis(document.querySelector(".ProseMirror")), source: vis(document.querySelector(".cm-scroller")) },
  };
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

const PLACE_SOURCE = String.raw`
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return { ok: false };
  v.focus();
  v.dispatch({ selection: { anchor: Math.min(20, v.state.doc.length) } });
  return { ok: true, len: v.state.doc.length, sel: v.state.selection.main.head };
`;

await runBrowserProbe({ name: "v0170-r4-persist-regress", doc: DOC, docTitle: MARK }, async (ui) => {
  const read = (tok) => ui.ev(readScript(tok));
  const toPreview = async () => { await ui.command("view.preview"); await sleep(800); };
  const toEdit = async () => { await ui.command("view.edit"); await sleep(800); };

  await toEdit();
  const base = await read("NONE");
  ui.add("I0", "仪器自检（编辑面可见 + CM6 + 标签）",
    base.cm && base.tab && base.pane.source ? "PASS" : "FAIL",
    `cm=${!!base.cm} tab=${!!base.tab} pane=S${base.pane.source ? 1 : 0}`);

  /* ══════ R1：编辑面真实键入 —— 内容必须落库（核心护栏） ══════ */
  await ui.ev(PLACE_SOURCE);
  await sleep(200);
  const before1 = await read("R1AA");
  for (const ch of "R1AA") await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0));
  await sleep(700);
  const r1 = await read("R1AA");
  console.log(`[R1] 键入前 cm.len=${before1.cm && before1.cm.len} 后 cm.len=${r1.cm && r1.cm.len} app.len=${r1.app && r1.app.len} tab.len=${r1.tab && r1.tab.len}`);
  ui.add("R1-a", "编辑面键入：CM6 doc 含新字", r1.cm && r1.cm.tok ? "PASS" : "FAIL", `cm.len=${r1.cm && r1.cm.len}`);
  ui.add("R1-b", "编辑面键入：App content 含新字", r1.app && r1.app.tok ? "PASS" : "FAIL", `app.len=${r1.app && r1.app.len}`);
  ui.add("R1-c", "编辑面键入：标签 content 含新字", r1.tab && r1.tab.tok ? "PASS" : "FAIL", `tab.len=${r1.tab && r1.tab.len}`);

  /* ══════ R2：编辑面纯光标移动 —— 内容不得变、光标须跟随 ══════ */
  const before2 = await read("R1AA");
  await ui.ev(PLACE_SOURCE);
  await sleep(150);
  const sel0 = (await read("R1AA")).cmSel;
  await ui.key("ArrowRight", "ArrowRight", 39);
  await ui.key("ArrowRight", "ArrowRight", 39);
  await sleep(500);
  const r2 = await read("R1AA");
  console.log(`[R2] 光标 ${JSON.stringify(sel0)} → ${JSON.stringify(r2.cmSel)}；cm.len ${before2.cm && before2.cm.len} → ${r2.cm && r2.cm.len}`);
  ui.add("R2-a", "纯光标移动：CM6 doc 长度不变（无假内容写入）",
    before2.cm && r2.cm && before2.cm.len === r2.cm.len ? "PASS" : "FAIL",
    `${before2.cm && before2.cm.len} → ${r2.cm && r2.cm.len}`);
  ui.add("R2-b", "纯光标移动：光标确实跟随（head 变化）",
    sel0 && r2.cmSel && sel0.head !== r2.cmSel.head ? "PASS" : "FAIL",
    `${sel0 && sel0.head} → ${r2.cmSel && r2.cmSel.head}`);

  /* ══════ R3：回车换行 —— 内容正常落库 ══════ */
  const before3 = await read("R1AA");
  await ui.key("Enter", "Enter", 13);
  await sleep(600);
  const r3 = await read("R1AA");
  console.log(`[R3] 回车：cm.len ${before3.cm && before3.cm.len} → ${r3.cm && r3.cm.len}`);
  ui.add("R3", "回车换行：CM6 doc 长度 +1 且 App 同步",
    r3.cm && before3.cm && r3.cm.len === before3.cm.len + 1 && r3.app && r3.app.len === r3.cm.len
      ? "PASS" : "FAIL",
    `cm ${before3.cm && before3.cm.len}→${r3.cm && r3.cm.len}, app.len=${r3.app && r3.app.len}`);

  /* ══════ R4：Ctrl+Z 撤销 —— bridge 路径不被误伤 ══════ */
  const before4 = await read("R1AA");
  await ui.key("z", "KeyZ", 90, 2); // modifiers=2 → Ctrl
  await sleep(900);
  const r4 = await read("R1AA");
  console.log(`[R4] 撤销：cm.len ${before4.cm && before4.cm.len} → ${r4.cm && r4.cm.len}`);
  ui.add("R4", "Ctrl+Z 撤销生效（bridge 事务路径未被拦截误伤）",
    r4.cm && before4.cm && r4.cm.len < before4.cm.len ? "PASS" : "FAIL",
    `cm ${before4.cm && before4.cm.len} → ${r4.cm && r4.cm.len}`);

  /* ══════ R5：主判据 —— 阅读面打字 → 切编辑，App 不得回滚 ══════ */
  await toPreview();
  await ui.ev(PLACE_READER);
  await sleep(250);
  for (const ch of "R5BB") await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0));
  await sleep(800);
  const r5a = await read("R5BB");
  await toEdit();
  await sleep(600);
  const r5b = await read("R5BB");
  console.log(`[R5] 切前 ${JSON.stringify({ app: r5a.app, pm: r5a.pm })}`);
  console.log(`[R5] 切后 ${JSON.stringify({ app: r5b.app, pm: r5b.pm, cm: r5b.cm })}`);
  ui.add("R5-a", "阅读打字→切编辑：App content **不回滚**（含新字）",
    r5b.app && r5b.app.tok ? "PASS" : "FAIL", `app.len=${r5b.app && r5b.app.len}`);
  ui.add("R5-b", "阅读打字→切编辑：源码面含新字",
    r5b.cm && r5b.cm.tok ? "PASS" : "FAIL", `cm.len=${r5b.cm && r5b.cm.len}`);

  /* ══════ R6：切回阅读，新字仍在 ══════ */
  await toPreview();
  await sleep(500);
  const r6 = await read("R5BB");
  ui.add("R6", "再切回阅读：PM doc 仍含新字", r6.pm && r6.pm.tok ? "PASS" : "FAIL",
    `pm.len=${r6.pm && r6.pm.len}`);
});
