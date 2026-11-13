/**
 * v0.17.0 R4 · T2 · 斜杠命令路径（P4）的入口侦察
 *
 * P4 第一次跑出 INVALID（`prepare` 返回 null），但"返回 null"有两个完全不同的原因：
 * (a) 视口里找不到空行；(b) 找到了、点了、`/` 也敲了，但菜单没弹。
 * 两者对后续修法的意义完全不同，所以必须分开取证 —— 不能笼统写"斜杠路径没测"。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-slash-diag", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  const scan = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const scR = sc.getBoundingClientRect();
    const lines = Array.from(sc.querySelectorAll(".cm-line"));
    const rows = lines.map((l, i) => {
      const r = l.getBoundingClientRect();
      return { i, txt: (l.textContent || "").slice(0, 18), top: Math.round(r.top - scR.top), h: Math.round(r.height), empty: (l.textContent || "").trim() === "" };
    });
    return { n: lines.length, ch: sc.clientHeight, empties: rows.filter(r => r.empty), inView: rows.filter(r => r.top > 20 && r.top + r.h < sc.clientHeight - 20).length };
  `);
  ui.log("[scan] " + JSON.stringify({ n: scan.n, ch: scan.ch, inView: scan.inView, emptyCount: scan.empties.length }));
  ui.log("[scan] 空行样本 = " + JSON.stringify(scan.empties.slice(0, 8)));

  // 方案 A：直接点空行
  let clicked = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const l of sc.querySelectorAll(".cm-line")) {
      if ((l.textContent || "").trim() !== "") continue;
      const r = l.getBoundingClientRect();
      if (r.height <= 0 || r.top < scR.top + 20 || r.bottom > scR.bottom - 20) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = l; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2), dist: Math.round(bestD) };
  `);
  ui.log("[A] 空行点击点 = " + JSON.stringify(clicked));
  if (clicked) {
    await ui.click(clicked.x, clicked.y);
    await ui.sleep(400);
    const sel = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      if (!v) return null;
      const m = v.state.selection.main;
      const line = v.state.doc.lineAt(m.head);
      return { head: m.head, lineFrom: line.from, lineTo: line.to, lineText: line.text, col: m.head - line.from };
    `);
    ui.log("[A] 点击后选区 = " + JSON.stringify(sel));
    await ui.key("/", "Slash", 191);
    await ui.sleep(600);
    const menu = await ui.ev(`return { open: !!document.querySelector(".slash-command-menu"), n: document.querySelectorAll(".slash-command-item").length, head: (document.querySelector(".slash-command-menu") || {}).textContent ? document.querySelector(".slash-command-menu").textContent.slice(0, 80) : null };`);
    ui.log("[A] slash menu = " + JSON.stringify(menu));
  }

  // 方案 B：点一个普通行 → End → Enter 造一个空行 → 敲 /
  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const scR = sc.getBoundingClientRect();
    const midY = scR.top + sc.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const l of sc.querySelectorAll(".cm-line")) {
      const txt = l.textContent || "";
      if (!/PI\\d{2}/.test(txt)) continue;
      const r = l.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = l; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2), txt: (best.textContent || "").slice(0, 20) };
  `);
  ui.log("[B] 目标行 = " + JSON.stringify(pt));
  if (pt) {
    await ui.click(pt.x, pt.y);
    await ui.sleep(350);
    await ui.key("End", "End", 35);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(400);
    const sel2 = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      if (!v) return null;
      const m = v.state.selection.main;
      const line = v.state.doc.lineAt(m.head);
      return { head: m.head, col: m.head - line.from, lineText: line.text, docLen: v.state.doc.length };
    `);
    ui.log("[B] Enter 后 = " + JSON.stringify(sel2));
    await ui.key("/", "Slash", 191);
    await ui.sleep(700);
    const menu2 = await ui.ev(`return { open: !!document.querySelector(".slash-command-menu"), n: document.querySelectorAll(".slash-command-item").length, first: Array.from(document.querySelectorAll(".slash-command-item")).slice(0,6).map(e => (e.textContent||"").trim().slice(0,16)) };`);
    ui.log("[B] slash menu = " + JSON.stringify(menu2));
  }

  // 方案 C：直接派发真实的 keydown/keypress 组合？先看 input 事件链路是否依赖 beforeinput
  const listenerProbe = await ui.ev(`
    window.__EV = [];
    const c = document.querySelector(".cm-content");
    if (c) {
      for (const t of ["beforeinput", "input", "keydown"]) {
        c.addEventListener(t, (e) => { window.__EV.push({ t, key: e.key || null, data: e.data || null, it: e.inputType || null }); }, true);
      }
    }
    return true;
  `);
  ui.log("[C] 已挂事件监听 = " + JSON.stringify(listenerProbe));

  await ui.shot("slash-diag");
});
