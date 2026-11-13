/**
 * v0.17.0 R4 · T2 · 斜杠命令（P4）触发链的最小取证
 *
 * 上一版 diag 已确认：视口里**有空行**、点击后光标确实落在空行行首（col=0），
 * 但敲 `/` 之后 `.slash-command-menu` **没有出现**。
 *
 * 这有两种可能，必须分开：
 * (a) `/` 根本没进文档（按键没被 CM6 吃下）→ 那是探针的问题；
 * (b) `/` 进了文档但菜单没弹 → 那是**产品缺陷**（与滚动跳动无关，但必须报告）。
 *
 * 判据：读 `view.state.doc` 的行文本。只有 (b) 才是产品结论。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-slash-diag2", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  // 点视口中间的一个**非空**行 → End → Enter（造一个真正的空行，光标在行首）
  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return { err: "no-scroller" };
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const l of sc.querySelectorAll(".cm-line")) {
      if (!/PI\\d{2}/.test(l.textContent || "")) continue;
      const r = l.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = l; }
    }
    if (!best) return { err: "no-anchor-line" };
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2), txt: (best.textContent||"").slice(0,16) };
  `);
  ui.log("[target] " + JSON.stringify(pt));
  if (!pt || pt.err) { ui.add("S0", "定位目标行", "FAIL", JSON.stringify(pt)); return; }

  await ui.click(pt.x, pt.y);
  await ui.sleep(400);

  const readSel = `
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v) return { ok: false };
    const m = v.state.selection.main;
    const line = v.state.doc.lineAt(m.head);
    return { ok: true, head: m.head, col: m.head - line.from, lineText: line.text, docLen: v.state.doc.length, docLines: v.state.doc.lines };
  `;
  ui.log("[A] 点击后 = " + JSON.stringify(await ui.ev(readSel)));

  await ui.key("End", "End", 35);
  await ui.sleep(150);
  ui.log("[A] End 后 = " + JSON.stringify(await ui.ev(readSel)));

  await ui.key("Enter", "Enter", 13);
  await ui.sleep(450);
  const st1 = await ui.ev(readSel);
  ui.log("[A] Enter 后 = " + JSON.stringify(st1));

  // 装事件监听，然后再敲 `/`
  await ui.ev(`
    window.__EV = [];
    const c = document.querySelector(".cm-content");
    for (const t of ["keydown", "beforeinput", "input"]) {
      c.addEventListener(t, (e) => window.__EV.push({ t, key: e.key || null, data: e.data || null, it: e.inputType || null, defaultPrevented: e.defaultPrevented }), true);
    }
    return true;
  `);

  await ui.key("/", "Slash", 191);
  await ui.sleep(800);

  const st2 = await ui.ev(readSel);
  const evs = await ui.ev(`return window.__EV || []`);
  const menu = await ui.ev(`
    return {
      slashOpen: !!document.querySelector(".slash-command-menu"),
      slashItems: document.querySelectorAll(".slash-command-item").length,
      portalAny: Array.from(document.body.children).map(e => e.className && String(e.className).slice(0,40)).slice(0, 20),
    };
  `);
  ui.log("[A] 敲 / 后 = " + JSON.stringify(st2));
  ui.log("[A] 事件 = " + JSON.stringify(evs));
  ui.log("[A] 菜单 = " + JSON.stringify(menu));

  const inserted = st2.ok && st2.docLen === st1.docLen + 1;
  ui.add("S1", "/ 确实进了文档（探针有效性断言，否则不能判菜单）",
    inserted ? "PASS" : "FAIL", `docLen ${st1.docLen}→${st2.ok ? st2.docLen : "?"}；事件=${JSON.stringify(evs.map(e => e.t + ":" + (e.key ?? e.data ?? e.it)))}`);
  ui.add("S2", "行首 `/` 弹出斜杠菜单（P4 这条路径是否可达）",
    menu.slashOpen ? "PASS" : "FAIL",
    `slashOpen=${menu.slashOpen} items=${menu.slashItems}；当前行文本=${JSON.stringify(st2.ok ? st2.lineText : null)} col=${st2.ok ? st2.col : "?"}`);

  // 若菜单确实没弹，再验一次"直接派发 lightmd 命令"的等价路径是否存在
  const alt = await ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "insert.taskList" } }));
    return true;
  `);
  await ui.sleep(700);
  const st3 = await ui.ev(readSel);
  ui.log("[alt] 直接派发 insert.taskList 后 = " + JSON.stringify(st3));

  await ui.shot("slash-diag2");
});
