/**
 * #5 定位探针 5：**逐事务记录 CM6 doc 的写入**，钉死"谁把 74 写回编辑器"
 *
 * ## 已经确证的事实链（前几版探针实测，本探针在此基础上再收窄一层）
 *
 * 1. 阅读面键入 → 四层全对：`PM doc=77/含新字`、`App.content=78/含新字`、
 *    `tab.content=78`、`localStorage=78`。→ `onDocChange` 上报链**是通的**。
 * 2. 切到编辑模式的那一瞬间，`App.content` 与 `tab.content` **同时掉回 74**，
 *    而 `PM doc` 仍是 77（新字还在）。
 * 3. 源码埋点抓到窗口内两次 `handleContentChange(len=74)`，栈为：
 *    `handleContentChange ← EditorContainer.onContentChangeRef ← applySourceInput
 *     ← CmSourceSurface.report/emit ← CM6 docChanged`
 *    → 也就是说：**有人把 CM6 的文档写成了 74**，CM6 如实上报，于是 App 被回滚。
 *
 * ## 本探针要回答的最后一问
 * CM6 的 `dispatch` 上装了钩子，记录**每次事务**的：
 * doc 长度前/后、是否 `programmatic`（`setText` 造成的整篇替换）、调用栈。
 * 于是能区分：
 * - **W1**：`setText(74)` —— 受控写入把旧值推进 CM6（EditorContainer 的 `[sourceContent]` effect）
 * - **W2**：`setText(78)` —— 正确的同步（ModeSync:1299 的结果）
 * 两者谁先谁后一目了然。
 *
 * ⚠️ 只在 dev 构建可用（需要 `cmTile.view` 这类非公开字段，且栈里的函数名要可读）。
 *    这是**仪器**依赖，不是产品依赖。
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

/**
 * 给 CM6 的 `dispatch` 装钩子 —— **必须逐实例装，且要反复装**。
 *
 * ## 两次仪器失败（都记下来，别重蹈）
 * ① 打在实例上（`v.dispatch = …`）只装一次 → 切模式窗口内 **0 次事务**：
 *    切换时源码面宿主重挂载 → `sourceSurface.mount()` 新建 EditorView → 包装随旧实例失效。
 * ② 改打在原型上 → **仍然 0 次**：CM6 的 `EditorView` 构造函数里有
 *    `this.dispatch = this.dispatch.bind(this);`（`@codemirror/view/dist/index.js:7980`）
 *    —— dispatch 是**实例自有属性**，原型上的包装被自有属性遮住。
 *
 * → 正确做法：**每 15ms 扫一次** `.cm-content.cmTile.view`，给还没装过的实例装包装。
 *    这样跨重建也能抓住所有事务。
 */
const HOOK_CM = String.raw`
  const T = (window.__T5 = window.__T5 || { tx: [], t0: performance.now(), hooked: 0 });
  const hookOne = () => {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v || v.__hooked5) return false;
    const orig = v.dispatch;
    v.dispatch = function (tr) {
      try {
        T.tx.push({
          at: Math.round(performance.now() - T.t0),
          before: this.state.doc.length,
          after: (tr && tr.state) ? tr.state.doc.length : -1,
          hasChanges: !!(tr && tr.docChanged),
          stack: (new Error().stack || "").split("\n").slice(2, 10)
            .map((x) => x.trim().replace(/https?:\/\/[^/]+\//, "").slice(0, 130)),
        });
      } catch (e) {}
      return orig.call(this, tr);
    };
    v.__hooked5 = true;
    T.hooked++;
    return true;
  };
  hookOne();
  if (!T.__iv) T.__iv = setInterval(hookOne, 15);
  return { ok: true, hooked: T.hooked, len: (() => { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view; return v ? v.state.doc.length : -1; })() };
`;

/** 四层快照（简化） */
const SNAP = String.raw`
  const TOKEN = ${JSON.stringify(TOKEN)};
  const root = document.querySelector("#root") || document.body;
  const k = Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
  let s = k ? root[k] : null;
  if (s && s.current) s = s.current;
  const out = {};
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
        if (typeof v2 === "string" && v2.indexOf("供定位") >= 0) {
          const key = nm + "#" + i;
          out[key] = { len: v2.length, hasToken: v2.indexOf(TOKEN) >= 0 };
        }
        if (Array.isArray(v2) && v2.length && v2[0] && typeof v2[0] === "object" && "content" in v2[0] && "path" in v2[0]) {
          const hit = v2.find((t) => typeof t.content === "string" && t.content.indexOf("供定位") >= 0);
          if (hit) out[nm + ".openTabs#" + i] = { len: hit.content.length, hasToken: hit.content.indexOf(TOKEN) >= 0 };
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) st.push(f.sibling);
    if (f.child) st.push(f.child);
  }
  let cmLen = -1;
  try { const c2 = document.querySelector(".cm-content"); const v3 = c2 && c2.cmTile && c2.cmTile.view; if (v3) cmLen = v3.state.doc.length; } catch (e) {}
  out.cmDoc = { len: cmLen, hasToken: false };
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-persist-cmtx", doc: DOC, docTitle: MARK }, async (ui) => {
  await ui.command("view.preview");
  await sleep(1200);

  const hooked = await ui.ev(HOOK_CM);
  console.log("[cmtx] CM6 dispatch 钩子:", JSON.stringify(hooked));
  ui.add("F0", "CM6 dispatch 钩子安装成功", hooked && hooked.ok ? "PASS" : "FAIL", JSON.stringify(hooked));
  if (!hooked || !hooked.ok) return;

  const typeTok = async () => { for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0)); };

  await ui.ev(PLACE_READER);
  await sleep(200);
  await typeTok();
  await sleep(900);
  console.log("[cmtx] 键入后（阅读面，源码面不可见）：", JSON.stringify(await ui.ev(SNAP)));

  /* ── 切模式：抓这一窗口内所有 CM6 事务 ── */
  await ui.ev(`window.__T5.tx = []; window.__T5.t0 = performance.now(); return true;`);
  await ui.command("view.edit");
  await sleep(200);
  await ui.ev(HOOK_CM);
  await sleep(900);

  const res = await ui.ev(`return { tx: window.__T5.tx.slice() };`);
  console.log(`\n[cmtx] ═══ 切模式窗口内 CM6 事务（${res.tx.length} 次）═══`);
  for (const tx of res.tx) {
    console.log(`  ── t=${tx.at}ms docLen ${tx.before} → ${tx.after} hasChanges=${tx.hasChanges}`);
    for (const s of tx.stack) console.log(`     | ${s}`);
  }
  console.log("[cmtx] 切换后：", JSON.stringify(await ui.ev(SNAP)));

  const shrink = res.tx.filter((tx) => tx.hasChanges && tx.after < tx.before);
  ui.add("F1", "CM6 文档被**缩短**（旧值写回 CM6）",
    shrink.length > 0 ? "FAIL" : "PASS",
    shrink.map((tx) => `t=${tx.at}ms ${tx.before}→${tx.after}`).join("; ") || "无");
});
