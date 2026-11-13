/**
 * #5 定位探针 3：**按组件名分别拦截**，抓"谁把旧值写回 App.content"
 *
 * ## 已有结论（本探针前两版已证实，不需要重新证）
 * 阅读面键入后**四层全对**：PM doc=77 含新字、App.content=78 含新字、
 * 标签 content=78 含新字、localStorage=78 含新字。
 * → `onDocChange`（`ModeSync:325`）→ `EditorContainer:465` → `App.handleContentChange`
 *   这条链**是通的**。T5 猜的「阅读→编辑方向缺 onContentChange 上报」**不是**本症状的成因
 *   （那条链在**编辑时**就已经把新内容送上去了）。
 *
 * 但**切到编辑模式后** App.content 与标签 content 双双掉回旧值 74，
 * 而 localStorage 随后也被写成 74 → 说明有一次 `handleContentChange(旧值)` 被调用
 * （它内部正是 setContent + updateTabContent + 500ms 落盘 三件事一起做）。
 *
 * ## 本版仪器修正（前版为什么漏抓 App 的 setState）
 * React 的 `useState` 返回的 setter 是 **render 时从 `queue.dispatch` 读出来的**。
 * 已经 mounted 的组件，其闭包里握的是**旧函数引用** —— 事后替换 `queue.dispatch`
 * 对"下一次 render 之前"的调用无效。前版因此只抓到 EditorContainer（它每次击键都重渲染），
 * 漏掉 App（App 只在 content 变化时重渲染）。
 *
 * 修法：**同时**包 `queue.dispatch` **和** 在每次 fiber 扫描时把当前 fiber 上
 * 所有 `typeof memoizedState === "string"` 的 hook 的 dispatch 再包一次
 * （新 render 出来的组件会重新读 queue.dispatch → 我们的包装生效）。
 * 另外补抓 `setState(fn)` 函数式更新（前版整类跳过）。
 *
 * ## 判据
 * - D1：App.content 与 EditorContainer.sourceContent 都被拦截到
 * - D2：切模式窗口内出现"写入不含新字的旧值"，并给出**栈**（文件:行）
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

/** 反复调用：既安装新 hook 的包装，也给已 mounted 的 hook 换新包装 */
const INSTALL = String.raw`
  const MARK = ${JSON.stringify(MARK)};
  const TOKEN = ${JSON.stringify(TOKEN)};
  const T = (window.__T3 = window.__T3 || { calls: [], hooks: {}, t0: performance.now() });

  const root = document.querySelector("#root") || document.body;
  const contKey = Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  let start = contKey ? root[contKey] : null;
  if (!start && root._reactRootContainer) start = root._reactRootContainer._internalRoot && root._reactRootContainer._internalRoot.current;
  if (start && start.current) start = start.current;

  const nameOf = (f) => {
    const t = f.type;
    if (typeof t === "function") return t.name || t.displayName || "(anon)";
    if (t && typeof t === "object") return t.displayName || (t.type && (t.type.name || String(t.type))) || "(obj)";
    return String(t);
  };

  const wrap = (hook, owner, idx) => {
    const q = hook && hook.queue;
    if (!q || typeof q.dispatch !== "function") return false;
    if (q.__w3 === q.dispatch) return false;       // 已经包的就是当前这个函数
    const hookId = owner + "#" + idx;
    const orig = q.dispatch;
    const patched = function (action) {
      try {
        const isFn = typeof action === "function";
        const s = isFn ? null : (typeof action === "string" ? action : null);
        T.calls.push({
          at: Math.round(performance.now() - T.t0), hookId, owner, isFn,
          len: s === null ? -1 : s.length,
          hasToken: s === null ? null : s.indexOf(TOKEN) >= 0,
          head: s === null ? null : s.slice(0, 26),
          stack: (new Error().stack || "").split("\n").slice(2, 10)
            .map((x) => x.trim().replace(/https?:\/\/[^/]+\//, "").slice(0, 130)),
        });
      } catch (e) {}
      return orig(action);
    };
    q.dispatch = patched;
    q.__w3 = patched;
    return true;
  };

  const stack = start ? [start] : [];
  const seen = new Set();
  let guard = 0, n = 0;
  while (stack.length && guard++ < 60000) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      const owner = nameOf(f);
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        // 拦截所有"字符串 state"（不只看含 marker 的：App 回滚后就不含 marker 了，
        // 只按 marker 识别会在回滚之后"丢hook"，正是前版的坑）
        if (typeof v === "string" && v.length > 8) {
          if (wrap(h, owner, i)) n++;
          T.hooks[owner + "#" + i] = { owner, idx: i, len: v.length, hasToken: v.indexOf(TOKEN) >= 0 };
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return { wrappedNow: n, hooks: T.hooks };
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

/** 当前所有字符串 state 的实际值（按组件名分组） */
const SNAP = String.raw`
  const TOKEN = ${JSON.stringify(TOKEN)};
  const root = document.querySelector("#root") || document.body;
  const k = Object.keys(root).find((x) => x.startsWith("__reactContainer$"));
  let s = k ? root[k] : null;
  if (s && s.current) s = s.current;
  const out = [];
  const st = s ? [s] : []; const seen = new Set(); let g = 0;
  while (st.length && g++ < 60000) {
    const f = st.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (typeof f.type === "function" || (f.type && typeof f.type === "object")) {
      const nm = typeof f.type === "function" ? (f.type.name || "?") : "obj";
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        // 只关心含"供定位"的（= 文档文本），排除一堆无关字符串 state
        if (typeof v === "string" && v.indexOf("供定位") >= 0) {
          out.push({ owner: nm, idx: i, len: v.length, hasToken: v.indexOf(TOKEN) >= 0 });
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) st.push(f.sibling);
    if (f.child) st.push(f.child);
  }
  out.sort((a, b) => a.owner.localeCompare(b.owner) || a.idx - b.idx);
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-persist-stack", doc: DOC, docTitle: MARK }, async (ui) => {
  await ui.command("view.preview");
  await sleep(1200);

  const inst = await ui.ev(INSTALL);
  const hookNames = Object.keys((inst && inst.hooks) || {});
  console.log(`[stack] 本轮新装 ${inst && inst.wrappedNow} 个；已知字符串 state：`);
  for (const k of hookNames) console.log(`  ${k} len=${inst.hooks[k].len}`);
  ui.add("D0", "拦截器覆盖 App 与 EditorContainer 的文档字符串 state",
    hookNames.some((k) => /^App#/.test(k)) && hookNames.some((k) => /^EditorContainer#/.test(k)) ? "PASS" : "FAIL",
    hookNames.join(", "));

  const typeTok = async () => { for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0)); };

  await ui.ev(PLACE_READER);
  await sleep(200);
  await ui.ev(`window.__T3.calls = []; window.__T3.t0 = performance.now(); return true;`);
  await typeTok();
  await sleep(900);
  // 每次采样前重新包一轮（新 render 的组件会重新读 queue.dispatch）
  await ui.ev(INSTALL);
  const afterType = await ui.ev(`return { calls: window.__T3.calls.slice() };`);
  console.log(`\n[stack] ═══ 键入期间写入（${afterType.calls.length} 次）═══`);
  for (const c of afterType.calls) console.log(`  t=${c.at}ms ${c.hookId} len=${c.len} hasToken=${c.hasToken} fn=${c.isFn}`);
  console.log("[stack] 键入后 state：", JSON.stringify(await ui.ev(SNAP)));

  /* ── 切模式 ── */
  await ui.ev(`window.__T3.calls = []; window.__T3.t0 = performance.now(); return true;`);
  await ui.ev(INSTALL);
  await ui.command("view.edit");
  await sleep(300);
  await ui.ev(INSTALL);
  await sleep(900);
  await ui.ev(INSTALL);
  const afterSwitch = await ui.ev(`return { calls: window.__T3.calls.slice() };`);
  console.log(`\n[stack] ═══ 切模式窗口内写入（${afterSwitch.calls.length} 次）═══`);
  for (const c of afterSwitch.calls) {
    console.log(`  ── t=${c.at}ms ${c.hookId} len=${c.len} hasToken=${c.hasToken} isFn=${c.isFn}`);
    for (const s of c.stack) console.log(`     | ${s}`);
  }
  console.log("[stack] 切换后 state：", JSON.stringify(await ui.ev(SNAP)));

  const bad = afterSwitch.calls.filter((c) => c.hasToken === false && c.len > 0);
  ui.add("D1", "切模式窗口内存在「写入不含新字的旧值」",
    bad.length > 0 ? "FAIL" : "PASS",
    bad.map((c) => `${c.hookId} t=${c.at}ms len=${c.len}`).join("; ") || "无");
});
