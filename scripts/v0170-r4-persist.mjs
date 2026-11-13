/**
 * #5 验收探针（T1 / fix-persist）—— **修复前基线 + 修复后判据 + 破坏性对照**
 *
 * ## 判据（对应任务卡的三条硬要求）
 * | id | 判据 | 任务卡原文 |
 * |---|---|---|
 * | P1 | 阅读模式键入后 **≤1000ms**，App content 与 PM doc 含同一新字 | 「≤1000ms 内 App content 与 PM doc 一致」 |
 * | P2 | 任意时刻切模式，PM 的编辑**不得丢失**（切过去切回来仍在） | 「任意时刻切换模式，PM 的编辑不得丢失」 |
 * | P3 | 阅读模式 Ctrl+S 后，落盘内容含新字 | 「阅读模式 Ctrl+S 后，磁盘文件必须含新字」 |
 *
 * ## 为什么每个场景用**独立 token**（不复位夹具）
 * 「重新 dispatch openFile 同一路径」不会复位夹具：App 的 handler 对已打开标签
 * **沿用标签内容**（v0.8.0 P11-7 的防丢修复就是这么写的）→ 复位无效；
 * 而换路径会多开标签，`tabs[0]` 指向错的那个 → 整张表假红。
 * 所以：**一个场景一个 token，用 token 的"存在/消失"判断该场景是否丢失**。
 *
 * ## 仪器
 * React fiber 反查四层 + CM6 `.cm-content.cmTile.view.state.doc`（`Text` 类必须走
 * `sliceString`，`toString()` 只给首行 —— 第一版踩过，会把 4 条判据全判假红）。
 * 另读双 doc 长度（cm/pm）用于区分"陈旧的源码面副本"与"PM 事实源"。
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

const TOKENS = {
  p1: "ZQA1",
  p2: "ZQB2",
  p3: "ZQC3",
};

const readScript = (tok) => String.raw`
  const MARK = ${JSON.stringify(MARK)};
  const TOKEN = ${JSON.stringify(tok)};

  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (!start && root._reactRootContainer) start = root._reactRootContainer._internalRoot && root.__reactRootContainer._internalRoot.current;
  if (start && start.current) start = start.current;

  const contentStates = [], tabStates = [], pmViews = [];
  const stack = start ? [start] : [];
  const seen = new Set();
  let guard = 0, fiberCount = 0;
  while (stack.length && guard++ < 60000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f); fiberCount++;
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        if (typeof v === "string" && v.indexOf(MARK) >= 0) contentStates.push({ idx: i, len: v.length, tok: v.indexOf(TOKEN) >= 0 });
        if (v && typeof v === "object" && "current" in v) {
          const cur = v.current;
          if (cur && cur.state && cur.state.doc) {
            const d = cur.state.doc;
            if (d.type !== undefined && d.content !== undefined && typeof d.textBetween === "function") {
              let txt = "";
              try { txt = d.textBetween(0, d.content.size, "\n", "\n"); } catch (e) { txt = d.textContent || ""; }
              pmViews.push({ idx: i, len: txt.length, tok: txt.indexOf(TOKEN) >= 0 });
            }
          }
        }
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "content" in v[0] && "path" in v[0]) {
          tabStates.push(v.map((t) => ({
            len: typeof t.content === "string" ? t.content.length : -1,
            tok: typeof t.content === "string" && t.content.indexOf(TOKEN) >= 0,
            dirty: !!t.isDirty,
          })));
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  contentStates.sort((a, b) => b.len - a.len);
  const app = contentStates[0] || null;
  let tab = null;
  for (const arr of tabStates) {
    const hit = arr.find((t) => t.len > 60);
    if (hit) { tab = hit; break; }
  }

  let cm = null;
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v) { const s = v.state.doc.sliceString(0, v.state.doc.length); cm = { len: s.length, tok: s.indexOf(TOKEN) >= 0 }; }
  } catch (e) {}

  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  return {
    diag: { fiberCount, contentCands: contentStates.length, pmViews: pmViews.length, tabCands: tabStates.length },
    app, tab, pm: pmViews.length ? pmViews[0] : null, cm,
    ls: (() => { try { const v = localStorage.getItem("lightmd-content") || ""; return { len: v.length, tok: v.indexOf(TOKEN) >= 0 }; } catch (e) { return null; } })(),
    pane: { reader: vis(document.querySelector(".ProseMirror")), source: vis(document.querySelector(".cm-scroller")) },
  };
`;

const PLACE_READER = String.raw`
  const pmEl = document.querySelector(".ProseMirror");
  if (!pmEl) return { ok: false, why: "no .ProseMirror" };
  pmEl.focus();
  const anchor = "K02 供定位。";
  const walker = document.createTreeWalker(pmEl, NodeFilter.SHOW_TEXT);
  let hit = null, n;
  while ((n = walker.nextNode())) { if ((n.nodeValue || "").indexOf(anchor) >= 0) { hit = n; break; } }
  if (!hit) return { ok: false, why: "anchor not found" };
  const at = hit.nodeValue.indexOf(anchor) + anchor.length;
  const r = document.createRange(); r.setStart(hit, at); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  return { ok: true };
`;

const fmt = (s) =>
  `pm=${s.pm && s.pm.tok ? 1 : 0} app=${s.app && s.app.tok ? 1 : 0} tab=${s.tab && s.tab.tok ? 1 : 0} ` +
  `ls=${s.ls && s.ls.tok ? 1 : 0} cm=${s.cm && s.cm.tok ? 1 : 0} ` +
  `len(pm=${s.pm && s.pm.len},app=${s.app && s.app.len},cm=${s.cm && s.cm.len}) ` +
  `pane=R${s.pane.reader ? 1 : 0}/S${s.pane.source ? 1 : 0}`;

await runBrowserProbe({ name: "v0170-r4-persist", doc: DOC, docTitle: MARK }, async (ui) => {
  const read = (tok) => ui.ev(readScript(tok));
  const typeTok = async (tok) => { for (const ch of tok) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0)); };
  const toPreview = async () => { await ui.command("view.preview"); await sleep(800); };
  const toEdit = async () => { await ui.command("view.edit"); await sleep(800); };
  const save = async () => { await ui.command("file.save"); await sleep(400); };

  await toPreview();
  const base = await read(TOKENS.p1);
  console.log(`[base] diag=${JSON.stringify(base.diag)}`);
  const okInstrument = base.diag.contentCands > 0 && base.diag.pmViews > 0 && !!base.tab && !!base.cm && base.pane.reader;
  ui.add("I0", "仪器自检（fiber 四层 + CM6 doc + 阅读面可见）", okInstrument ? "PASS" : "FAIL",
    JSON.stringify(base.diag));
  if (!okInstrument) {
    console.log("[probe] ⚠️ 仪器不可用 → 不产出产品结论");
    return;
  }

  /* ═══════════ P1：阅读键入 → ≤1000ms App content 与 PM 一致 ═══════════ */
  await ui.ev(PLACE_READER);
  await sleep(250);
  await typeTok(TOKENS.p1);
  await sleep(60);
  const p1imm = await read(TOKENS.p1);
  await sleep(1000);
  const p1 = await read(TOKENS.p1);
  console.log(`[P1] 立即    ${fmt(p1imm)}`);
  console.log(`[P1] 1000ms  ${fmt(p1)}`);
  ui.add("P1-a", "阅读键入后 PM doc 含新字", p1.pm && p1.pm.tok ? "PASS" : "FAIL", "");
  ui.add("P1-b", "阅读键入后 ≤1000ms App content 含新字", p1.app && p1.app.tok ? "PASS" : "FAIL",
    `app.len=${p1.app && p1.app.len}`);
  ui.add("P1-c", "阅读键入后 ≤1000ms 标签 content 含新字", p1.tab && p1.tab.tok ? "PASS" : "FAIL", "");
  ui.add("P1-d", "阅读键入后 ≤1000ms localStorage 含新字", p1.ls && p1.ls.tok ? "PASS" : "FAIL", "");

  /* ═══════════ P2：切模式往返，编辑不得丢失 ═══════════ */
  await toPreview();
  await ui.ev(PLACE_READER);
  await sleep(250);
  await typeTok(TOKENS.p2);
  await sleep(700);
  const p2a = await read(TOKENS.p2);
  await toEdit();
  const p2b = await read(TOKENS.p2);
  await toPreview();
  await sleep(500);
  const p2c = await read(TOKENS.p2);
  console.log(`[P2] 切前   ${fmt(p2a)}`);
  console.log(`[P2] 编辑面 ${fmt(p2b)}`);
  console.log(`[P2] 切回后 ${fmt(p2c)}`);
  ui.add("P2-a", "阅读键入→切编辑：源码面含新字", p2b.cm && p2b.cm.tok ? "PASS" : "FAIL",
    `cm.len=${p2b.cm && p2b.cm.len} pm.len=${p2b.pm && p2b.pm.len}`);
  ui.add("P2-b", "再切回阅读：PM doc 仍含新字（**不得丢失**）", p2c.pm && p2c.pm.tok ? "PASS" : "FAIL",
    `pm.len=${p2c.pm && p2c.pm.len}`);
  ui.add("P2-c", "再切回阅读：App content 仍含新字", p2c.app && p2c.app.tok ? "PASS" : "FAIL",
    `app.len=${p2c.app && p2c.app.len}`);

  /* ═══════════ P3：阅读模式 Ctrl+S，落盘必须含新字 ═══════════ */
  await toPreview();
  await ui.ev(PLACE_READER);
  await sleep(250);
  await typeTok(TOKENS.p3);
  await sleep(400);
  await save();
  const p3 = await read(TOKENS.p3);
  console.log(`[P3] 阅读面直接保存 ${fmt(p3)}`);
  ui.add("P3", "阅读模式 Ctrl+S：保存内容含新字", p3.ls && p3.ls.tok ? "PASS" : "FAIL",
    `ls.len=${p3.ls && p3.ls.len}`);

  /* ═══════════ P4：编辑面键入 → 切阅读 → 切回编辑（反向，护栏） ═══════════ */
  await toEdit();
  await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v) return { ok: false };
    v.focus();
    v.dispatch({ selection: { anchor: Math.min(20, v.state.doc.length) } });
    return { ok: true };
  `);
  await sleep(250);
  await ui.key("W", "KeyW", 87);
  await sleep(600);
  const e1 = await read(TOKENS.p3);
  await toPreview();
  const e2 = await read(TOKENS.p3);
  await toEdit();
  await sleep(400);
  const e3 = await read(TOKENS.p3);
  console.log(`[P4] 编辑键入 ${fmt(e1)}`);
  console.log(`[P4] 切阅读   ${fmt(e2)}`);
  console.log(`[P4] 切回编辑 ${fmt(e3)}`);
  ui.add("P4", "编辑面键入→切阅读→切回编辑：源码面仍含新字", e3.cm && e3.cm.tok ? "PASS" : "FAIL",
    `cm.len=${e3.cm && e3.cm.len}`);

  /* ── 终态四层一致 ── */
  const fin = await read(TOKENS.p3);
  const consistent = !!fin.app && !!fin.tab && !!fin.cm &&
    fin.app.tok === fin.tab.tok && fin.app.tok === fin.cm.tok;
  ui.add("P5", "四层一致（App / 标签 / CM6 对同一 token 取值相同）", consistent ? "PASS" : "FAIL", fmt(fin));
});
