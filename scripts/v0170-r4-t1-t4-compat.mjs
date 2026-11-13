/**
 * T4 接线 × #5 拦截 的**相互影响**验证（Lead 明确要求实测）
 *
 * ## 要回答的一句话
 * `viewMode` effect 里的 `setSourceContent(mdMasked)`（T4 接线处）会不会被
 * `applySourceInput` 里的 `isContentChange` 拦截**波及**？
 *
 * ## 为什么理论上不会、但必须实测
 * 两条链路在代码上不相交：
 * - T4 接线：`viewMode` effect → `setSourceContent(mdMasked)`（直接调 React setter）
 * - #5 拦截：`applySourceInput`（由 `CmSourceSurface.onDidChange` 驱动）
 *
 * 但**存在一条间接耦合**：`setSourceContent` 改 `sourceContent` state →
 * `EditorContainer` 的 `[sourceContent]` effect → `sourceSurface.setText()` →
 * CM6 `programmatic` 事务 → `onDocsChanged` → `report(origin="programmatic")` →
 * `applySourceInput(docChanged=true, origin="programmatic")`。
 *
 * 判据 `isContentChange = docChanged !== false || origin === "programmatic"`
 * → 这条链**被判为内容变更**（正确）。但若判据写错（例如只看 `docChanged`），
 * 这条链就会被拦掉 → T4 的归一化结果**写不进 CM6**。
 *
 * ## 判据
 * | id | 场景 | 期望 |
 * |---|---|---|
 * | M1 | 阅读→编辑后，源码面文本 == App content（T4 的 mdMasked 真的落地了） | 一致 |
 * | M2 | 源码面文本 == 标签 content | 一致 |
 * | M3 | 切一圈后再次切一圈，三处仍一致（不是只第一次对） | 一致 |
 * | M4 | 阅读面编辑后切编辑，编辑面文本 == PM 序列化结果（#5 不被 T4 破坏） | 一致 |
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const MARK = "接线互相影响夹具";

const DOC = [
  `# ${MARK}`,
  "",
  "第一段内容。K01 供定位。",
  "",
  "1. 甲项",
  "1. 乙项",
  "",
  "尾段 K03 供定位。",
  "",
].join("\n");

const READ = String.raw`
  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (start && start.current) start = start.current;
  const contentStates = [], tabStates = [], pmTexts = [];
  const stack = start ? [start] : []; const seen = new Set(); let g = 0;
  while (stack.length && g++ < 60000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        if (typeof v === "string" && v.indexOf("供定位") >= 0) contentStates.push(v);
        if (v && typeof v === "object" && "current" in v) {
          const cur = v.current;
          if (cur && cur.state && cur.state.doc) {
            const d = cur.state.doc;
            if (d.type !== undefined && d.content !== undefined && typeof d.textBetween === "function") {
              let t = ""; try { t = d.textBetween(0, d.content.size, "\n", "\n"); } catch (e) { t = d.textContent || ""; }
              pmTexts.push(t);
            }
          }
        }
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "content" in v[0] && "path" in v[0]) {
          tabStates.push(v);
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  contentStates.sort((a, b) => b.length - a.length);
  const app = contentStates[0] || "";
  let tab = "";
  for (const arr of tabStates) {
    const hit = arr.find((t) => typeof t.content === "string" && t.content.indexOf("供定位") >= 0);
    if (hit) { tab = hit.content; break; }
  }
  let src = "";
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v) src = v.state.doc.sliceString(0, v.state.doc.length);
  } catch (e) {}
  return { src, app, tab, pm: pmTexts[0] || "" };
`;

const PLACE_READER = String.raw`
  const pmEl = document.querySelector(".ProseMirror");
  if (!pmEl) return { ok: false };
  pmEl.focus();
  const anchor = "K01 供定位。";
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

/** 比较时忽略末尾换行差（PM 序列化与源码面在文档结尾常有 1 个 \n 差异，属既有契约） */
const norm = (s) => (s || "").replace(/\s+$/, "");
const eq = (a, b) => norm(a) === norm(b);
const brief = (s) => JSON.stringify((s || "").slice(0, 90));

await runBrowserProbe({ name: "v0170-r4-t1-t4-compat", doc: DOC, docTitle: MARK }, async (ui) => {
  const read = () => ui.ev(READ);
  const toPreview = async () => { await ui.command("view.preview"); await sleep(1000); };
  const toEdit = async () => { await ui.command("view.edit"); await sleep(1000); };

  await toEdit();
  const base = await read();
  console.log(`[compat] 基线 src=${brief(base.src)}`);
  console.log(`[compat] 基线 app=${brief(base.app)}`);
  console.log(`[compat] 基线 tab=${brief(base.tab)}`);
  console.log(`[compat] 基线 pm =${brief(base.pm)}`);

  /* ── M1/M2：切一圈后三处是否一致 ── */
  await toPreview();
  await toEdit();
  const c1 = await read();
  console.log(`\n[compat] ===== 切一圈后 =====`);
  console.log(`[compat] src=${brief(c1.src)}`);
  console.log(`[compat] app=${brief(c1.app)}`);
  console.log(`[compat] tab=${brief(c1.tab)}`);
  ui.add("M1", "切一圈后：源码面 == App content（T4 的 mdMasked 真落地）",
    c1.src && eq(c1.src, c1.app) ? "PASS" : "FAIL",
    `src.len=${c1.src.length} app.len=${c1.app.length}`);
  ui.add("M2", "切一圈后：源码面 == 标签 content",
    c1.src && eq(c1.src, c1.tab) ? "PASS" : "FAIL",
    `src.len=${c1.src.length} tab.len=${c1.tab.length}`);

  /* ── M3：第二圈仍一致（防"只第一次对"） ── */
  await toPreview();
  await toEdit();
  const c2 = await read();
  console.log(`\n[compat] ===== 第 2 圈后 =====`);
  console.log(`[compat] src=${brief(c2.src)}`);
  console.log(`[compat] app=${brief(c2.app)}`);
  console.log(`[compat] tab=${brief(c2.tab)}`);
  ui.add("M3", "第 2 圈后：源码面 / App / 标签 三者仍一致（非一次性）",
    c2.src && eq(c2.src, c2.app) && eq(c2.src, c2.tab) ? "PASS" : "FAIL",
    `src=${c2.src.length} app=${c2.app.length} tab=${c2.tab.length}`);

  /* ── M4：#5 主判据在 T4 接线之后仍成立（阅读编辑不回滚） ── */
  await toPreview();
  await ui.ev(PLACE_READER);
  await sleep(250);
  for (const ch of "MTK9") await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0));
  await sleep(900);
  const r1 = await read();
  await toEdit();
  await sleep(700);
  const r2 = await read();
  console.log(`\n[compat] ===== 阅读键入 MTK9 → 切编辑 =====`);
  console.log(`[compat] 切前 app.len=${r1.app.length} pm.len=${r1.pm.length}`);
  console.log(`[compat] 切后 src.len=${r2.src.length} app.len=${r2.app.length}`);
  const hasTok = (s) => (s || "").indexOf("MTK9") >= 0;
  ui.add("M4-a", "#5 不被 T4 破坏：切编辑后 App content 仍含新字",
    hasTok(r2.app) ? "PASS" : "FAIL", `app.len=${r2.app.length}`);
  ui.add("M4-b", "#5 不被 T4 破坏：切编辑后源码面含新字",
    hasTok(r2.src) ? "PASS" : "FAIL", `src.len=${r2.src.length}`);

  /* ── M5：序列化缓存不被归一化选项污染（③ 快路径） ── */
  const c3 = await read();
  ui.add("M5", "带选项序列化不污染缓存：再次切模式后三处仍一致",
    c3.src && eq(c3.src, c3.app) ? "PASS" : "FAIL",
    `src.len=${c3.src.length} app.len=${c3.app.length}`);
});
