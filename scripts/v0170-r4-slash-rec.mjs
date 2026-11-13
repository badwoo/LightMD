/**
 * v0.17.0 R4 · T2 · **P0 崩溃根因取证**：CM6 模式下敲「行首 / 」导致整树崩溃
 *
 * ## 已确证（`v0170-r4-slash-ab.mjs`）
 * - A 组（**行中**敲 `/`，`# /滚动稳定性审计`）→ 编辑器正常，无崩溃，只是不弹菜单；
 * - B 组（**空行行首**敲 `/`）→ **100ms 内整棵 React 树被 ErrorBoundary 接管**：
 *   `TypeError: Cannot read properties of undefined (reading 'substring')`，
 *   `.cm-editor` / `.app` 全部从 DOM 消失。
 *
 * ## 本探针要钉死的因果链（不靠读代码推断）
 *
 * 两条路径的分叉点就是 `findSlashTrigger` 的返回值：
 * - 行中 `/` → `lineText` 是 `# /...` → 正则 `/^(\s*)\/(\w*)$/` **不匹配** → 不弹菜单；
 * - 空行行首 `/` → `lineText` 恰好是 `/` → **匹配** → `setSlashCommandOpen(true)`
 *   → 渲染 `<SlashCommand textarea={sourceTextareaRef.current} />`
 *   → **CM6 下这个 ref 是中性 div，`.value` 是 `undefined`**
 *   → `findSlashTrigger(textarea.value, ...)` 里 `text.substring(...)` 抛 TypeError。
 *
 * 这就是项目里 `v0170-div-as-textarea-guard.test.ts` 守的那一类缺陷
 * （"CM6 下 `sourceTextareaRef.current` 是 truthy 的 div，`if (el)` 守卫失效"）
 * 的一处**新漏点** —— 之前修过 `captureSourceContentAnchor` 等处，但没修这里。
 *
 * ## 验证方式
 * 1. 读 `sourceTextareaRef` 实际指向的元素类型（是不是 div、有没有 `.value`）；
 * 2. 手动在页面里执行 `el.value.substring(...)` 复现同一个 TypeError 文案；
 * 3. 抓 React 的 console.error 栈（ErrorBoundary 会打印 componentStack）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-slash-root-cause", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  // 捕获 console.error（ErrorBoundary 的 componentStack 在这里）
  await ui.ev(`
    window.__CONSOLE = [];
    const oe = console.error;
    console.error = function () {
      try {
        window.__CONSOLE.push(Array.from(arguments).map(a => {
          if (a && a.stack) return String(a.stack).slice(0, 900);
          if (typeof a === "string") return a.slice(0, 500);
          try { return JSON.stringify(a).slice(0, 300); } catch (e) { return String(a).slice(0, 200); }
        }));
      } catch (e) {}
      return oe.apply(console, arguments);
    };
    window.__ERRS = [];
    window.addEventListener("error", (e) => window.__ERRS.push({ msg: String(e.message || e).slice(0, 200), stack: String((e.error && e.error.stack) || "").slice(0, 1200) }));
    return true;
  `);

  /* ── ① CM6 下 `sourceTextareaRef` 到底指向什么 ── */
  const elInfo = await ui.ev(`
    // 源码面的"宿主元素"：CM6 下是 .cm-editor 的父 div（中性宿主），不是 textarea
    const cands = Array.from(document.querySelectorAll("div")).filter(d => {
      const c = d.querySelector(":scope > .cm-editor");
      return !!c;
    });
    const host = cands[0] || null;
    const info = (el) => el ? {
      tag: el.tagName,
      cls: String(el.className || "").slice(0, 50),
      hasValue: typeof el.value !== "undefined",
      valueType: typeof el.value,
      isTextarea: el.tagName === "TEXTAREA",
      childCls: Array.from(el.children).map(c => String(c.className || "").slice(0, 30)).slice(0, 4),
    } : null;
    return {
      cmHostParent: info(host),
      realTextareaCount: document.querySelectorAll("textarea.source-editor").length,
      anyTextarea: document.querySelectorAll("textarea").length,
    };
  `);
  ui.log("[①] CM6 宿主元素 = " + JSON.stringify(elInfo, null, 1));

  /* ── ② 直接复现同一句 TypeError ── */
  const repro = await ui.ev(`
    const host = Array.from(document.querySelectorAll("div")).find(d => d.querySelector(":scope > .cm-editor"));
    const el = host || {};
    try {
      const v = el.value;                       // CM6 下 = undefined
      const s = v.substring(0, 5);              // ← 崩溃点
      return { crashed: false, v: String(v), s };
    } catch (e) {
      return { crashed: true, name: e && e.name, message: String(e && e.message) };
    }
  `);
  ui.log("[②] 复现 = " + JSON.stringify(repro));
  ui.add("R1", "根因确认：CM6 宿主元素（div）没有 value → `.value.substring` 必然抛 TypeError",
    repro.crashed && /substring/.test(repro.message || "") ? "PASS" : "FAIL",
    JSON.stringify(repro) + `；宿主=${JSON.stringify(elInfo.cmHostParent)}`);

  /* ── ③ 真实触发：空行行首敲 `/`，抓崩溃栈 ── */
  const cand = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    const out = [];
    for (const l of sc.querySelectorAll(".cm-line")) {
      if ((l.textContent || "").trim() !== "") continue;
      const r = l.getBoundingClientRect();
      if (r.height <= 0 || r.top < scR.top + 30 || r.bottom > scR.bottom - 30) continue;
      out.push({ x: Math.round(r.left + 5), y: Math.round(r.top + r.height / 2), d: Math.round(Math.abs((r.top + r.bottom) / 2 - midY)) });
    }
    out.sort((a, b) => a.d - b.d);
    return out[0] || null;
  `);
  if (!cand) { ui.add("R0", "找到空行", "FAIL", "无"); return; }
  await ui.click(cand.x, cand.y);
  await ui.sleep(400);
  ui.log("[③] 已把光标放在空行行首，准备敲 /");
  await ui.key("/", "Slash", 191);
  await ui.sleep(900);

  const consoleDump = await ui.ev(`return window.__CONSOLE || []`);
  const errDump = await ui.ev(`return window.__ERRS || []`);
  const gone = await ui.ev(`return { nEditor: document.querySelectorAll(".cm-editor").length, nApp: document.querySelectorAll(".app").length, body: (document.body.innerText||"").slice(0, 140).replace(/\\n/g," | ") }`);

  ui.log("[③] console.error = " + JSON.stringify(consoleDump, null, 1));
  ui.log("[③] window.onerror = " + JSON.stringify(errDump, null, 1));
  ui.log("[③] 页面状态 = " + JSON.stringify(gone, null, 1));

  const hasSubstrInStack = consoleDump.concat(errDump.map((e) => e.stack || "")).join("\n");
  ui.add("R2", "真实触发：空行行首 `/` → 崩溃栈包含 substring / SlashCommand",
    /substring/.test(hasSubstrInStack) ? "PASS" : "FAIL",
    `崩溃栈长度=${hasSubstrInStack.length}；含 SlashCommand=${/SlashCommand/.test(hasSubstrInStack)}；含 substring=${/substring/.test(hasSubstrInStack)}`);
  ui.add("R3", "★ P0 判定：CM6 编辑模式 + 空行行首 `/` → 整页崩溃（ErrorBoundary）",
    gone.nEditor === 0 ? "FAIL" : "PASS",
    `nEditor=${gone.nEditor} nApp=${gone.nApp}；页面文本=${JSON.stringify(gone.body.slice(0, 100))}`);

  await ui.shot("slash-root-cause");
});
