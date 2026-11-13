/**
 * v0.17.0 R4 · T2 · **CM6 实例是否被重建**（决定 P4 的读数为什么失效，以及是不是产品缺陷）
 *
 * ## 为什么必须查这一步
 *
 * diag3 里出现了非常可疑的一件事：在空行行首敲 `/` 之后，
 * `document.querySelector(".cm-content").cmTile` 变成 `null`，
 * 而在此之前它一直是好的。两种解释**方向完全相反**：
 *
 * - (a) 读数方式失效（CM6 内部字段在某些更新后短暂为 null）→ 探针问题，产品没事；
 * - (b) **CM6 的 `.cm-content` 元素被换掉了 / 整个编辑器被重建** →
 *   这是产品缺陷，而且**恰好能解释用户报的"瞬间往下跳"**
 *   （重建 = 新 view 的 scrollTop 从头算，再由恢复逻辑拉回 = 一帧硬跳）。
 *
 * 判据用**元素身份**（`===`）而不是任何内部字段：把 `.cm-content` / `.cm-editor`
 * 打上标记属性，之后看标记还在不在。标记消失 ⇔ 元素被替换 ⇔ 重建。
 *
 * ## 顺带查清的另一件事
 *
 * 如果确实重建，就要找出**是谁**触发的：本轮 P2（语法栏插入）也走 `setSourceContent`，
 * 若它同样引起重建，那 P2 的 174px 跳变就有了统一的机制解释，
 * 而不是"两条互不相关的 bug"。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

/** 页面内：给关键元素打标记，并报告"标记是否还在" */
const MARK = `
  const c = document.querySelector(".cm-content");
  const e = document.querySelector(".cm-editor");
  const sc = document.querySelector(".cm-scroller");
  if (c) c.setAttribute("data-probe-c", "1");
  if (e) e.setAttribute("data-probe-e", "1");
  if (sc) sc.setAttribute("data-probe-sc", "1");
  return { marked: { c: !!c, e: !!e, sc: !!sc } };
`;

const CHECK = `
  const c = document.querySelector(".cm-content");
  const e = document.querySelector(".cm-editor");
  const sc = document.querySelector(".cm-scroller");
  return {
    sameC: !!c && c.getAttribute("data-probe-c") === "1",
    sameE: !!e && e.getAttribute("data-probe-e") === "1",
    sameSc: !!sc && sc.getAttribute("data-probe-sc") === "1",
    cTileOk: !!(c && c.cmTile && c.cmTile.view),
    cTileExists: !!(c && c.cmTile),
    // 文档里出现过的 cm-content 数量（>1 说明旧元素还在但被换下）
    nContent: document.querySelectorAll(".cm-content").length,
    nEditor: document.querySelectorAll(".cm-editor").length,
    st: sc ? Math.round(sc.scrollTop) : null,
    sh: sc ? Math.round(sc.scrollHeight) : null,
    slash: !!document.querySelector(".slash-command-menu"),
  };
`;

await runBrowserProbe({ name: "v0170-r4-remount", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  // 装一个**全局**的 view 引用兜底（React 侧若重建，旧 view 会被丢弃，这个也会失效）
  await ui.ev(`
    window.__V0 = (() => { const c = document.querySelector(".cm-content"); return (c && c.cmTile && c.cmTile.view) || null; })();
    window.__EVT = [];
    // 监听 DOM 变化：cm-content 被移除/新增是最直接的证据
    const root = document.querySelector(".cm-editor") ? document.querySelector(".cm-editor").parentElement : document.body;
    window.__MO = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && (n.classList && n.classList.contains("cm-content"))) window.__EVT.push({ t: "removed-cm-content", at: Math.round(performance.now()) });
          if (n.nodeType === 1 && (n.classList && n.classList.contains("cm-editor"))) window.__EVT.push({ t: "removed-cm-editor", at: Math.round(performance.now()) });
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && (n.classList && n.classList.contains("cm-content"))) window.__EVT.push({ t: "added-cm-content", at: Math.round(performance.now()) });
          if (n.nodeType === 1 && (n.classList && n.classList.contains("cm-editor"))) window.__EVT.push({ t: "added-cm-editor", at: Math.round(performance.now()) });
        }
      }
    });
    window.__MO.observe(root || document.body, { childList: true, subtree: true });
    return true;
  `);

  await ui.ev(MARK);
  ui.log("[t0] " + JSON.stringify(await ui.ev(CHECK)));

  // ── 场景 A：点空行 → 敲 `/`（P4 的触发前缀）──
  const cand = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
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
  if (!cand) { ui.add("M0", "找到空行", "FAIL", "无"); return; }
  await ui.click(cand.x, cand.y);
  await ui.sleep(400);
  ui.log("[A] 点击空行后 " + JSON.stringify(await ui.ev(CHECK)));

  await ui.key("/", "Slash", 191);
  await ui.sleep(150);
  ui.log("[A] 敲 / 后 150ms " + JSON.stringify(await ui.ev(CHECK)));
  await ui.sleep(900);
  const aAfter = await ui.ev(CHECK);
  ui.log("[A] 敲 / 后 1050ms " + JSON.stringify(aAfter));

  // 用旧的 view 引用读文档（若它还有效，说明 view 没被销毁）
  const oldViewAlive = await ui.ev(`
    if (!window.__V0) return { has: false };
    try {
      return { has: true, len: window.__V0.state.doc.length, destroyed: window.__V0.isDestroyed };
    } catch (e) { return { has: true, err: String(e).slice(0, 80) }; }
  `);
  ui.log("[A] 旧 view 引用 = " + JSON.stringify(oldViewAlive));

  const evts = await ui.ev(`return window.__EVT || []`);
  ui.log("[A] DOM 事件 = " + JSON.stringify(evts));

  ui.add("M1", "★ 敲 `/` 后 CM6 的 .cm-content 是否被替换（元素身份）",
    aAfter.sameC && aAfter.sameE ? "PASS" : "FAIL",
    `sameContent=${aAfter.sameC} sameEditor=${aAfter.sameE} sameScroller=${aAfter.sameSc}；` +
    `cm-content 节点数=${aAfter.nContent}；DOM 事件=${JSON.stringify(evts.slice(0, 8))}；` +
    `旧 view 存活=${JSON.stringify(oldViewAlive)}；scrollTop=${aAfter.st}/${aAfter.sh}`);
  ui.add("M2", "敲 `/` 后 `.cm-content.cmTile.view` 是否仍可读（探针读数路径）",
    aAfter.cTileOk ? "PASS" : "FAIL",
    `cTileOk=${aAfter.cTileOk} cTileExists=${aAfter.cTileExists}`);

  // ── 场景 B：语法栏插入（P2 的触发），看它是否也引起重建 ──
  await ui.ev(MARK);
  const beforeB = await ui.ev(CHECK);
  ui.log("[B] 插前 " + JSON.stringify(beforeB));
  const it = await ui.ev(`
    const all = Array.from(document.querySelectorAll(".syntax-helper-item"));
    const el = all.find(e => (e.textContent || "").indexOf("粗体") >= 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  if (it) {
    await ui.click(it.x, it.y);
    await ui.sleep(250);
    ui.log("[B] 语法栏插入后 250ms " + JSON.stringify(await ui.ev(CHECK)));
    await ui.sleep(900);
    const bAfter = await ui.ev(CHECK);
    ui.log("[B] 语法栏插入后 1150ms " + JSON.stringify(bAfter));
    const evtsB = await ui.ev(`return window.__EVT || []`);
    ui.log("[B] DOM 事件 = " + JSON.stringify(evtsB));
    ui.add("M3", "★ 语法栏插入是否重建 CM6（`.cm-content` 元素身份）",
      bAfter.sameC && bAfter.sameE ? "PASS" : "FAIL",
      `sameContent=${bAfter.sameC} sameEditor=${bAfter.sameE}；节点数=${bAfter.nContent}；` +
      `DOM 事件=${JSON.stringify(evtsB.slice(0, 8))}；scrollTop ${beforeB.st}→${bAfter.st}；scrollHeight ${beforeB.sh}→${bAfter.sh}`);
  }

  await ui.shot("remount");
});
