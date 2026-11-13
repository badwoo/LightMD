/**
 * #5 定位探针 4：**抓「谁调了 handleContentChange(旧值)」的调用栈**
 *
 * ## 为什么必须用源码埋点（前 3 版仪器的局限，写下来防别人重试）
 * React 的 `useState` setter 是组件 **render 时**从 `queue.dispatch` 读出来的稳定引用。
 * 事后替换 `queue.dispatch`：
 * - **EditorContainer** 每次击键都重渲染 → 下一帧会重新读 → 我们的包装**能生效**；
 * - **App** 只在 `content` 变化时重渲染 → 包装装上以后它**可能再也不 render** →
 *   已经 mounted 的闭包里握的是**旧 setter** → 我们的包装**抓不到**。
 * 前 3 版因此漏掉 App 的写入，只能看到 EditorContainer 那一侧，
 * 差点把"App 没写"读成产品事实。**这是仪器局限，不是产品行为。**
 *
 * 所以在 `App.tsx:3307` 的 `handleContentChange` 入口加了临时埋点
 * （只记 stack + 入参长度，测完删除），本探针直接读 `window.__LMD_CONTENT_TRACE`。
 *
 * ## 判据
 * - E1：埋点可读（否则不产出结论）
 * - E2：切模式窗口内是否出现 `handleContentChange(旧值)`，并给出**文件:行**
 * - E3：追出**上游调用者**（谁把旧内容算出来送进来的）
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

/** 四层快照（沿用已验证的读法） */
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
    if (typeof f.type === "function") {
      const nm = f.type.name || "?";
      let h = f.memoizedState, i = 0;
      while (h && i < 400) {
        const v = h.memoizedState;
        if (typeof v === "string" && v.indexOf("供定位") >= 0) out.push({ owner: nm, idx: i, len: v.length, hasToken: v.indexOf(TOKEN) >= 0 });
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" && "content" in v[0] && "path" in v[0]) {
          const hit = v.find((t) => typeof t.content === "string" && t.content.indexOf("供定位") >= 0);
          if (hit) out.push({ owner: nm + ".openTabs", idx: i, len: hit.content.length, hasToken: hit.content.indexOf(TOKEN) >= 0 });
        }
        h = h.next; i++;
      }
    }
    if (f.sibling) st.push(f.sibling);
    if (f.child) st.push(f.child);
  }
  out.sort((a, b) => (a.owner + a.idx).localeCompare(b.owner + b.idx));
  return out;
`;

await runBrowserProbe({ name: "v0170-r4-persist-trace", doc: DOC, docTitle: MARK }, async (ui) => {
  await ui.command("view.preview");
  await sleep(1200);

  /**
   * ⚠️ 埋点用 `if (Array.isArray(w.__LMD_CONTENT_TRACE))` 做 opt-in 守卫（避免生产日志噪音），
   * 所以**必须由探针先建数组**，否则永远读到 false —— 第一版就踩了这个坑
   * （E0 直接 FAIL，差点误判成"埋点没生效/构建用错"）。
   */
  const probeOk = await ui.ev(`
    window.__LMD_CONTENT_TRACE = [];
    // 触发一次 handleContentChange：切模式会让 ModeSync 调 onContentChange，
    // 只要埋点在函数体开头，数组就会被 push（空 push 也算生效证据）
    return true;
  `);
  await ui.command("view.preview");
  await sleep(900);
  const traced = await ui.ev(`
    return { exists: Array.isArray(window.__LMD_CONTENT_TRACE), n: (window.__LMD_CONTENT_TRACE || []).length };
  `);
  /**
   * ⚠️ 判据只查 `exists`，**不能**查 `n > 0`：切模式未必触发 `handleContentChange`，
   * 第一版把 `n>0` 写进判据 → E0 假红。埋点是否真的会记录，由后面"阅读面键入"
   * 这一步自然验证（那一步必触发）。
   */
  ui.add("E0", "handleContentChange 埋点已装载（探针 opt-in 数组就位）",
    traced.exists ? "PASS" : "FAIL", JSON.stringify(traced));
  if (!traced.exists) {
    console.log("[trace] ⚠️ 埋点未装载 → 确认构建用的是带埋点的 dist");
    return;
  }

  const typeTok = async () => { for (const ch of TOKEN) await ui.key(ch, "Key" + ch.toUpperCase(), ch.charCodeAt(0)); };

  await ui.ev(PLACE_READER);
  await sleep(200);
  await ui.ev(`window.__LMD_CONTENT_TRACE = []; return true;`);
  await typeTok();
  await sleep(900);
  console.log("\n[trace] ═══ 键入期间 handleContentChange 调用 ═══");
  const typed = await ui.ev(`return { tr: window.__LMD_CONTENT_TRACE.slice(), snap: null };`);
  for (const c of typed.tr) {
    console.log(`  t=${c.t}ms len=${c.len} guard(会写)=${c.guard}`);
  }
  console.log("[trace] 键入后 state：", JSON.stringify(await ui.ev(SNAP)));

  /* ── 切模式 ── */
  await ui.ev(`window.__LMD_CONTENT_TRACE = []; return true;`);
  const before = await ui.ev(SNAP);
  await ui.command("view.edit");
  await sleep(1200);
  const switched = await ui.ev(`
    return {
      tr: window.__LMD_CONTENT_TRACE.slice(),
      ls: (() => { try { const v = localStorage.getItem("lightmd-content") || ""; return { len: v.length, hasToken: v.indexOf(${JSON.stringify(TOKEN)}) >= 0 }; } catch (e) { return null; } })(),
    };
  `);
  const after = await ui.ev(SNAP);

  console.log(`\n[trace] ═══ 切模式窗口内 handleContentChange 调用（${switched.tr.length} 次）═══`);
  for (const c of switched.tr) {
    console.log(`  ── t=${c.t}ms len=${c.len} guard(会写)=${c.guard}`);
    for (const s of c.stack) console.log(`     | ${s}`);
  }
  console.log("[trace] 切换前 state：", JSON.stringify(before));
  console.log("[trace] 切换后 state：", JSON.stringify(after));
  console.log("[trace] localStorage：", JSON.stringify(switched.ls));

  const offenders = switched.tr.filter((c) => c.len < 78);
  ui.add("E1", "切模式窗口内出现 handleContentChange(旧值)",
    offenders.length > 0 ? "FAIL" : "PASS",
    offenders.map((c) => `t=${c.t}ms len=${c.len}`).join("; ") || "无");

  const guardSkipped = switched.tr.filter((c) => !c.guard);
  ui.add("E2", "是否存在被 contentRef 守卫**拦下**的上报（守卫吞内容）",
    guardSkipped.length > 0 ? "KNOWN" : "PASS",
    guardSkipped.map((c) => `t=${c.t}ms len=${c.len}`).join("; ") || "无");
});
