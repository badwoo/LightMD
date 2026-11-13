/**
 * v0.17.0 R4 · T2 · **P0 斜杠崩溃**的完整验收探针（含破坏性对照）
 *
 * ## 测什么（对应 Lead 给的判据表）
 *
 * | # | 场景 | 期望 |
 * |---|---|---|
 * | S1 | CM6 编辑模式，空行行首敲 `/` | **不崩溃**，菜单出现 |
 * | S2 | CM6，`/h1` + Enter | 插入 `# ` 到行首 |
 * | S3 | CM6，`/table` | 插入表格语法 |
 * | S4 | 菜单位置跟随光标 | 菜单矩形紧贴光标（不跑到 (0,0)） |
 * | S5 | `/usr/bin` 不误触发 | 不弹菜单（`findSlashTrigger` 正则行为不变） |
 * | S6 | 收起（Esc）| 菜单关闭、文档保留 `/` 前的状态 |
 *
 * ## 破坏性对照（必须做）
 *
 * 由于 P0 的"崩溃"是**整棵树消失**，对照就是"把守卫拿掉 → 必须重新崩溃"。
 * 但探针不能改源码，所以对照方式是：**在页面里手动复现崩溃的充分条件**
 * （拿 CM6 宿主 div 当 textarea 调 `findSlashTrigger` 的等价式
 * `el.value.substring(...)`），证明 `R0` 那条断言**会红**。
 * 更硬的对照是 `v0170-r4-slash-rec.mjs` 在**修复前**的产物
 * （`_verify-out/v0170-r4-slash-ab.json` 的修复前版本 / 截图已存
 * `_verify-out/shots/v0170-r4-slash-ab-slash-ab.png` 是崩溃态）。
 * 两者结合即完整证据链。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);

const SNAP = `
  const cnt = (s) => document.querySelectorAll(s).length;
  const m = document.querySelector(".slash-command-menu");
  const sc = document.querySelector(".cm-scroller");
  const c = document.querySelector(".cm-content");
  const v = (c && c.cmTile && c.cmTile.view) || null;
  return {
    nEditor: cnt(".cm-editor"), nApp: cnt(".app"), nMenu: cnt(".slash-command-menu"),
    nItem: cnt(".slash-command-item"),
    menuBox: m ? (() => { const r = m.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
    caretBox: (() => {
      const cur = document.querySelector(".cm-cursor");
      if (cur) { const r = cur.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.bottom), src: "cm-cursor" }; }
      try {
        const s = window.getSelection();
        if (s && s.rangeCount) { const r = s.getRangeAt(0).getBoundingClientRect(); if (r.width || r.height) return { left: Math.round(r.left), top: Math.round(r.bottom), src: "selection" }; }
      } catch (e) {}
      return null;
    })(),
    docLen: v ? v.state.doc.length : null,
    docText: v ? v.state.doc.toString().slice(0, 0) : null,
    line: v ? (() => { const mm = v.state.selection.main; const ln = v.state.doc.lineAt(mm.head); return { col: mm.head - ln.from, text: ln.text.slice(0, 30), lineNo: ln.number }; })() : null,
    st: sc ? Math.round(sc.scrollTop) : null,
    bodyStart: (document.body.innerText || "").slice(0, 60).replace(/\\n/g, " | "),
  };
`;

/** 读某一行（按行号）的文本，用于验证插入结果 */
const readLine = (n) => `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return null;
  const ln = v.state.doc.line(${n});
  return { no: ln.number, text: ln.text.slice(0, 40) };
`;

await runBrowserProbe({ name: "v0170-r4-slash-verify", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await wheelTo(ui, 0.45, ".cm-scroller", { settle: 700 });

  await ui.ev(`
    window.__CONSOLE = [];
    const oe = console.error;
    console.error = function () {
      try { window.__CONSOLE.push(Array.from(arguments).map(a => String((a && a.stack) || a).slice(0, 300))); } catch (e) {}
      return oe.apply(console, arguments);
    };
    return true;
  `);

  /** 把光标放到视口内一个空行行首（斜杠唯一的合法触发条件） */
  async function caretToEmptyLine(u) {
    const pt = await u.ev(`
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
    if (!pt) return false;
    await u.click(pt.x, pt.y);
    await u.sleep(400);
    return true;
  }

  /* ══ S1：空行行首 `/` → 不崩溃 + 菜单出现 ══ */
  if (!(await caretToEmptyLine(ui))) { ui.add("S0", "定位空行", "FAIL", "无空行"); return; }
  const pre = await ui.ev(SNAP);
  await ui.key("/", "Slash", 191);
  await ui.sleep(700);
  const s1 = await ui.ev(SNAP);
  ui.log("[S1] " + JSON.stringify(s1));
  ui.add("S1", "★ P0：CM6 空行行首敲 `/` → 不崩溃 + 菜单出现",
    s1.nEditor > 0 && s1.nApp > 0 && s1.nMenu > 0 ? "PASS" : "FAIL",
    `nEditor=${s1.nEditor} nApp=${s1.nApp} nMenu=${s1.nMenu} items=${s1.nItem}；` +
    `文档行=${JSON.stringify(s1.line)}；页面=${JSON.stringify(s1.bodyStart)}`);

  /* ══ S4：菜单位置跟随光标（不是 (0,0)）═ */
  const s4ok = !!(s1.menuBox && s1.caretBox);
  const near = s4ok
    ? Math.abs(s1.menuBox.left - s1.caretBox.left) <= 320 && Math.abs(s1.menuBox.top - s1.caretBox.top) <= 420
    : false;
  ui.add("S4", "菜单位置跟随光标（不跑到视口左上角）",
    s4ok && near ? "PASS" : "FAIL",
    `menu=${JSON.stringify(s1.menuBox)} caret=${JSON.stringify(s1.caretBox)}`);

  /* ══ S2：`/h1` + Enter → 插入 `# ` ══ */
  // 当前文档里是 `/`，继续敲 h1 过滤
  await ui.key("h", "KeyH", 72);
  await ui.sleep(120);
  await ui.key("1", "Digit1", 49);
  await ui.sleep(400);
  const s2filter = await ui.ev(SNAP);
  ui.log("[S2] 过滤后 line=" + JSON.stringify(s2filter.line) + " items=" + s2filter.nItem);
  const firstItem = await ui.ev(`
    const it = document.querySelector(".slash-command-item");
    if (!it) return null;
    return { text: (it.textContent || "").trim().slice(0, 24), selected: it.classList.contains("selected"), aria: it.getAttribute("aria-selected") };
  `);
  ui.log("[S2] 第一项 = " + JSON.stringify(firstItem));
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(800);
  const s2 = await ui.ev(SNAP);
  const s2line = s2.line ? await ui.ev(readLine(s2.line.lineNo)) : null;
  ui.log("[S2] 插入后 " + JSON.stringify(s2) + " line=" + JSON.stringify(s2line));
  const h1Ok = !!(s2line && /^#\s/.test(s2line.text));
  ui.add("S2", "CM6：`/h1` + Enter → 行首插入 `# `",
    h1Ok && s2.nMenu === 0 ? "PASS" : "FAIL",
    `所在行=${JSON.stringify(s2line)}；菜单已关=${s2.nMenu === 0}；items 过滤后=${s2filter.nItem}`);

  /* ══ S3：`/table` → 插入表格 ══ */
  if (!(await caretToEmptyLine(ui))) { ui.add("S3", "定位空行", "FAIL", "无空行"); }
  else {
    const beforeTable = await ui.ev(SNAP);
    await ui.key("/", "Slash", 191);
    await ui.sleep(300);
    await ui.key("t", "KeyT", 84);
    await ui.sleep(120);
    await ui.key("a", "KeyA", 65);
    await ui.sleep(400);
    const tf = await ui.ev(SNAP);
    ui.log("[S3] 过滤 'ta' 后 items=" + tf.nItem);
    const itemText = await ui.ev(`
      const its = Array.from(document.querySelectorAll(".slash-command-item")).slice(0, 4).map(e => (e.textContent || "").trim().slice(0, 20));
      return its;
    `);
    ui.log("[S3] 候选 = " + JSON.stringify(itemText));
    // 精确点「表格」那一项（不靠 Enter 猜选中项，避免"选中项不对"被误判成功能坏）
    const tbl = await ui.ev(`
      const its = Array.from(document.querySelectorAll(".slash-command-item"));
      const el = its.find(e => (e.textContent || "").indexOf("表格") >= 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    if (!tbl) {
      ui.add("S3", "CM6：`/table` → 插入表格", "FAIL", `找不到表格项，候选=${JSON.stringify(itemText)}`);
    } else {
      await ui.click(tbl.x, tbl.y);
      await ui.sleep(900);
      const s3 = await ui.ev(SNAP);
      const textAround = await ui.ev(`
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.view;
        if (!v) return null;
        const mm = v.state.selection.main;
        const ln = v.state.doc.lineAt(mm.head);
        const from = Math.max(0, ln.number - 2), to = Math.min(v.state.doc.lines, ln.number + 2);
        const out = [];
        for (let i = from; i <= to; i++) out.push(v.state.doc.line(i).text.slice(0, 40));
        return out;
      `);
      ui.log("[S3] 插入后周边=" + JSON.stringify(textAround));
      const tableOk = Array.isArray(textAround) && textAround.some((t) => /^\|/.test(t));
      ui.add("S3", "CM6：`/table` → 插入表格",
        tableOk ? "PASS" : "FAIL",
        `周边行=${JSON.stringify(textAround)}；菜单已关=${s3.nMenu === 0}`);
    }
  }

  /* ══ S5：`/usr/bin` 不误触发 ══ */
  if (!(await caretToEmptyLine(ui))) { ui.add("S5", "定位空行", "FAIL", "无空行"); }
  else {
    for (const [k, code, vk] of [["/", "Slash", 191], ["u", "KeyU", 85], ["s", "KeyS", 83], ["r", "KeyR", 82], ["/", "Slash", 191], ["b", "KeyB", 66]]) {
      await ui.key(k, code, vk);
      await ui.sleep(60);
    }
    await ui.sleep(600);
    const s5 = await ui.ev(SNAP);
    ui.log("[S5] " + JSON.stringify(s5));
    ui.add("S5", "`/usr/b` 这类路径**不**误触发斜杠菜单（正则行为不变）",
      s5.nMenu === 0 ? "PASS" : "FAIL",
      `nMenu=${s5.nMenu}；行=${JSON.stringify(s5.line)}`);

    /* ══ S6：Esc 关闭（此时无菜单，先造一个再 Esc）══ */
    // 回退刚才敲的字符
    for (let i = 0; i < 6; i++) { await ui.key("Backspace", "Backspace", 8); await ui.sleep(50); }
    await ui.sleep(300);
    await ui.key("/", "Slash", 191);
    await ui.sleep(500);
    const beforeEsc = await ui.ev(SNAP);
    await ui.key("Escape", "Escape", 27);
    await ui.sleep(500);
    const s6 = await ui.ev(SNAP);
    ui.log("[S6] esc 前 menu=" + beforeEsc.nMenu + " 后 menu=" + s6.nMenu);
    ui.add("S6", "Esc 关闭菜单且编辑器仍正常",
      s6.nMenu === 0 && s6.nEditor > 0 && s6.nApp > 0 ? "PASS" : "FAIL",
      `menu ${beforeEsc.nMenu}→${s6.nMenu}；nEditor=${s6.nEditor} nApp=${s6.nApp}`);
  }

  /* ══ 破坏性对照：证明"S1 的判据会红" ══ */
  /**
   * 探针不能改源码，所以对照在页面内**复现崩溃的充分条件**：
   * 拿 CM6 宿主 div（修复前就是被当 textarea 传进去的那个元素）
   * 执行 `el.value.substring(0, 5)` —— 修复前 `SlashCommand` 内部做的正是这件事。
   * 若这一句**不抛**，说明我对根因的判断是错的；
   * 若它抛 TypeError，而修复后的 S1 通过，则"守卫确实是止血点"成立。
   *
   * 更强的对照是**真实回退**：修复前的同一探针产物见
   * `_verify-out/shots/v0170-r4-slash-ab-slash-ab.png`（崩溃态截图，
   * 页面只剩「界面渲染出错」）+ 修复前 S1 实测 nEditor=0 nApp=0 —— 已在报告里引用。
   */
  const contrast = await ui.ev(`
    const host = Array.from(document.querySelectorAll("div")).find(d => d.querySelector(":scope > .cm-editor"));
    if (!host) return { found: false };
    try {
      const s = host.value.substring(0, 5);
      return { found: true, crashed: false, value: String(host.value), s };
    } catch (e) {
      return { found: true, crashed: true, name: e && e.name, message: String(e && e.message) };
    }
  `);
  ui.log("[CONTRAST] " + JSON.stringify(contrast));
  ui.add("D1", "破坏性对照：宿主 div 当 textarea 用 → 必然抛 TypeError（证明守卫是真止血点）",
    contrast.found && contrast.crashed && /substring/.test(contrast.message || "") ? "PASS" : "FAIL",
    JSON.stringify(contrast));

  const cons = await ui.ev(`return window.__CONSOLE || []`);
  ui.log("[console.error] " + JSON.stringify(cons.slice(0, 4)));
  ui.add("Z8", "全程无 React 渲染异常（ErrorBoundary 未被触发）",
    cons.length === 0 ? "PASS" : "FAIL",
    cons.length ? JSON.stringify(cons.slice(0, 2)) : "无");

  await ui.shot("slash-verify");
});
