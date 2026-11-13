/**
 * v0.17.0 第四轮 · T5 · 第 7 项 **D1 修复验证**（6 条判据 + 破坏性对照）
 *
 * ## D1 缺陷回顾
 * 用户选中**普通文字**（无任何格式）→ 点格式刷 → **仍然进入待刷态**
 * （bodyClass=true、状态栏"单击目标应用"）→ 点目标 → 什么都不发生 →
 * **不退出待刷态**。
 * 用户视角：**"点了没反应，而且退不出去"**。
 *
 * ## 修法（两条）
 * A. `armFormatPainter` 前用 `isSnapshotEmpty(snapshot)` 判定 → 空则**不 arm** + `notifyWarning`
 * B. 应用无效时：once 模式**退出**、persistent 模式**保持**
 *
 * ## 判据（Lead 指定，逐条实测）
 * | 场景 | 期望 |
 * |---|---|
 * | 编辑面选**普通文字** arm | **不进入待刷态** + 有提示 |
 * | 编辑面选 `**粗体**` arm | 进入待刷态 + 应用成功 + 自动退出 |
 * | 阅读面选**普通文字** arm | 同上（不 arm + 提示） |
 * | 阅读面选**粗体文字** arm | 同上（成功） |
 * | arm 成功但应用到**已是同格式**目标 | once 模式退出；persistent 模式保持 |
 * | **破坏性对照** | 回退修复 → "普通文字 arm" 应重新进入待刷态 |
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t5" node scripts/v0170-r4-painter-d1.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = [
  "# D1 验证文档",
  "",
  "**粗体源**",
  "",
  "普通文字段落甲。",
  "",
  "普通文字段落乙。",
  "",
  "**已有粗体** 的段落丙。",
  "",
  "结尾撑高。".repeat(4),
  "",
].join("\n");

const CM_TEXT = `
  const c = document.querySelector(".cm-content");
  if (!c) return { ok: false };
  const v = c.cmTile && c.cmTile.view;
  if (v && v.state && v.state.doc) return { ok: true, text: v.state.doc.toString(), sel: { from: v.state.selection.main.from, to: v.state.selection.main.to } };
  return { ok: false };
`;

const PM_STATE = `
  const pm = document.querySelector(".editor-container .ProseMirror");
  if (!pm) return { ok: false };
  const dv = pm.pmViewDesc;
  const out = { ok: true, blocks: [], dom: {} };
  if (dv && dv.node) dv.node.forEach((n) => {
    const marks = [];
    n.descendants((c) => { if (c.isText) c.marks.forEach(m => { if (!marks.includes(m.type.name)) marks.push(m.type.name); }); return true; });
    out.blocks.push({ type: n.type.name, level: n.attrs.level ?? null, marks, text: n.textContent.slice(0, 40) });
  });
  out.dom = { strong: pm.querySelectorAll("strong").length };
  return out;
`;

/**
 * 格式刷状态 + **toast 提示捕获**。
 * toast 是异步 DOM，本探针在点击前后各读一次，并记录"期间出现的警告文案"。
 */
const PAINTER = `
  const bodyClass = document.body.classList.contains("format-painter-armed");
  let hint = null;
  const scope = document.querySelector(".statusbar, .status-bar, footer") || document.body;
  for (const e of scope.querySelectorAll("span,div,button")) {
    const t = (e.textContent || "").trim();
    if (/格式刷/.test(t) && /(单击目标|持续应用|剩余)/.test(t) && e.children.length === 0) { hint = t.slice(0, 90); break; }
  }
  // toast：既有 notificationService 的容器
  const toasts = Array.from(document.querySelectorAll(
    ".notification, .toast, [class*='notification'], [class*='toast'], [role='alert']"
  )).map(e => (e.textContent || "").trim().slice(0, 120)).filter(Boolean);
  return { bodyClass, hint, toasts };
`;

await runBrowserProbe({ name: "v0170-r4-painter-d1", doc: DOC }, async (ui) => {
  const readCm = () => ui.ev(CM_TEXT);
  const readPm = () => ui.ev(PM_STATE);
  const readPainter = () => ui.ev(PAINTER);

  /** 精确选中 CM6 中 needle 文本（不选整行） */
  async function selectCmExact(needle) {
    const pt = await ui.ev(`
      for (const l of document.querySelectorAll(".cm-line")) {
        const t = l.textContent || "";
        const i = t.indexOf(${JSON.stringify(needle)});
        if (i >= 0) {
          const r = l.getBoundingClientRect();
          const cw = r.width / Math.max(1, t.length);
          return { ok: true, x: Math.round(r.left + (i + ${JSON.stringify(needle)}.length / 2) * cw),
                   y: Math.round(r.top + r.height / 2), line: t.slice(0, 50), idx: i };
        }
      }
      return { ok: false, reason: "not in viewport" };
    `);
    if (!pt.ok) return null;
    await ui.click(pt.x, pt.y);
    await ui.sleep(230);
    await ui.key("Home", "Home", 36);
    await ui.sleep(100);
    for (let i = 0; i < pt.idx; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(12); }
    await ui.sleep(80);
    for (let i = 0; i < needle.length; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(14);
    }
    await ui.sleep(280);
    const cm = await readCm();
    return { ok: true, sel: cm.sel, text: cm.text.slice(cm.sel.from, cm.sel.to) };
  }

  /** 点工具栏格式刷（persistent 用双击） */
  async function clickPainterBtn(persistent, externalBtn) {
    const b = externalBtn || await ui.ev(`
      const el = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
        .find(x => (x.getAttribute("title") || "").includes("格式刷"));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    `);
    if (!b) return null;
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
    if (persistent) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 2 });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 2 });
    }
    await ui.sleep(700);
    return b;
  }

  const reloadDoc = async (name) => {
    await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
      path: ${JSON.stringify(name)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(DOC)} } })); return true;`);
    await ui.sleep(1400);
  };

  /* ══════ 0. 进入编辑模式 ══════ */
  await ui.command("view.edit");
  await ui.sleep(2200);
  await reloadDoc("d1-probe.md");

  /* ══════ C1：编辑面选**普通文字** → 不应 arm，且应有提示 ══════ */
  ui.log("═══ C1：编辑面选普通文字 arm（应被拒绝）═══");
  const sel1 = await selectCmExact("普通文字段落甲");
  ui.log("[C1] 选区 = " + JSON.stringify(sel1 && { sel: sel1.sel, text: sel1.text }));
  if (sel1 && sel1.text === "普通文字段落甲") {
    const beforeToast = await readPainter();
    await clickPainterBtn(false);
    const afterToast = await readPainter();
    ui.log("[C1] arm 后 = " + JSON.stringify(afterToast));
    const newToasts = afterToast.toasts.filter(t => !beforeToast.toasts.includes(t));
    ui.add("C1-a", "★★ 编辑面选普通文字 → **不进入**待刷态（D1 主判据）",
      afterToast.bodyClass === false ? "PASS" : "FAIL",
      `bodyClass=${afterToast.bodyClass}（修复前会是 true）hint=${JSON.stringify(afterToast.hint)}`);
    ui.add("C1-b", "★ 且有**明确提示**（不是静默拒绝）",
      newToasts.length > 0 || afterToast.toasts.length > 0 ? "PASS" : "FAIL",
      `toasts=${JSON.stringify(afterToast.toasts)}（修复前无任何提示）`);
    ui.add("C1-c", "提示文案说清「为什么 + 该怎么做」",
      (afterToast.toasts.join(" ") + (afterToast.hint || "")).match(/没有可复制的格式|带格式|加粗|标题|列表/) ? "PASS" : "FAIL",
      `捕获文案=${JSON.stringify(afterToast.toasts)}`);
  } else {
    ui.add("C1-a", "编辑面普通文字 arm（前置：精确选中）", "FAIL", JSON.stringify(sel1));
  }

  /* ══════ C2：编辑面选 `**粗体源**` → 应 arm + 应用成功 + 自动退出 ══════ */
  ui.log("");
  ui.log("═══ C2：编辑面选含格式符的源（应成功）═══");
  await reloadDoc("d1-probe2.md");
  const sel2 = await selectCmExact("**粗体源**");
  ui.log("[C2] 选区 = " + JSON.stringify(sel2 && { sel: sel2.sel, text: sel2.text }));
  if (sel2 && sel2.text === "**粗体源**") {
    await clickPainterBtn(false);
    const a2 = await readPainter();
    ui.add("C2-a", "编辑面选 `**粗体源**` → 进入待刷态（空快照判定不误伤）",
      a2.bodyClass ? "PASS" : "FAIL", `bodyClass=${a2.bodyClass} hint=${JSON.stringify(a2.hint)}`);
    // 应用到"普通文字段落乙"
    const tp = await ui.ev(`
      for (const l of document.querySelectorAll(".cm-line")) {
        const t = l.textContent || "";
        if (t.indexOf("普通文字段落乙") >= 0) {
          const r = l.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height/2) };
        }
      }
      return { ok: false };
    `);
    if (tp.ok) {
      const b = await readCm();
      await ui.click(tp.x, tp.y);
      await ui.sleep(900);
      const af = await readCm();
      const line = af.text.split("\n").find(l => l.includes("普通文字段落乙")) || "";
      ui.add("C2-b", "编辑面应用成功（目标行被 ** 包裹）",
        line.trim().startsWith("**") && line.trim().endsWith("**") ? "PASS" : "FAIL",
        `${JSON.stringify(line.slice(0, 50))}；文本变化=${b.text !== af.text}`);
      const a2b = await readPainter();
      ui.add("C2-c", "once 应用成功后自动退出",
        !a2b.bodyClass && !a2b.hint ? "PASS" : "FAIL",
        `bodyClass=${a2b.bodyClass} hint=${JSON.stringify(a2b.hint)}`);
    }
  } else {
    ui.add("C2-a", "编辑面含格式符源 arm（前置）", "FAIL", JSON.stringify(sel2));
  }

  /* ══════ C3：阅读面选普通文字 → 不应 arm + 提示 ══════ */
  ui.log("");
  ui.log("═══ C3：阅读面选普通文字 arm（应被拒绝）═══");
  await ui.command("view.preview");
  await ui.sleep(1900);

  async function selectPmExact(needle) {
    const r = await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      if (!pm) return { ok: false };
      const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode.textContent || "";
        const i = t.indexOf(${JSON.stringify(needle)});
        if (i >= 0) {
          const rng = document.createRange();
          rng.setStart(w.currentNode, i);
          rng.setEnd(w.currentNode, i + ${JSON.stringify(needle)}.length);
          const s = window.getSelection();
          s.removeAllRanges(); s.addRange(rng);
          pm.focus();
          document.dispatchEvent(new Event("selectionchange"));
          return { ok: true, got: s.toString() };
        }
      }
      return { ok: false, reason: "needle not found" };
    `);
    await ui.sleep(250);
    return r;
  }

  const pmSel1 = await selectPmExact("普通文字段落甲");
  ui.log("[C3] 选区 = " + JSON.stringify(pmSel1));
  if (pmSel1.ok) {
    // 阅读面唯一入口：右键菜单
    const pt = await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode.textContent || "";
        const i = t.indexOf("普通文字段落甲");
        if (i >= 0) {
          const rng = document.createRange();
          rng.setStart(w.currentNode, i); rng.setEnd(w.currentNode, i + 2);
          const r = rng.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 2), y: Math.round(r.top + r.height/2) };
        }
      }
      return { ok: false };
    `);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "right", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "right", clickCount: 1 });
    await ui.sleep(450);
    const mi = await ui.ev(`
      const menus = Array.from(document.querySelectorAll(".editor-context-menu")).filter(m => m.getBoundingClientRect().width > 0);
      if (!menus.length) return { ok: false, reason: "no menu" };
      const el = Array.from(menus[menus.length-1].querySelectorAll(".context-menu-item"))
        .find(x => (x.textContent || "").includes("格式刷"));
      if (!el) return { ok: false, reason: "no painter item" };
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    `);
    if (mi.ok) {
      const bt = await readPainter();
      await ui.click(mi.x, mi.y);
      await ui.sleep(700);
      const at = await readPainter();
      const newT = at.toasts.filter(t => !bt.toasts.includes(t));
      ui.log("[C3] arm 后 = " + JSON.stringify(at));
      ui.add("C3-a", "★★ 阅读面选普通文字 → **不进入**待刷态",
        at.bodyClass === false ? "PASS" : "FAIL",
        `bodyClass=${at.bodyClass} hint=${JSON.stringify(at.hint)}`);
      ui.add("C3-b", "★ 且有明确提示",
        newT.length > 0 || at.toasts.length > 0 ? "PASS" : "FAIL",
        `toasts=${JSON.stringify(at.toasts)}`);
    } else {
      ui.add("C3-a", "阅读面普通文字 arm（前置：右键菜单）", "FAIL", JSON.stringify(mi));
    }
  } else {
    ui.add("C3-a", "阅读面普通文字 arm（前置：选中）", "FAIL", JSON.stringify(pmSel1));
  }

  /* ══════ C4：阅读面选**粗体**（PM mark）→ 应 arm + 成功 ══════ */
  ui.log("");
  ui.log("═══ C4：阅读面选带 mark 的文字（应成功）═══");
  await ui.command("view.preview");
  await ui.sleep(1200);
  const pmSel2 = await selectPmExact("粗体源");
  ui.log("[C4] 选区 = " + JSON.stringify(pmSel2));
  if (pmSel2.ok) {
    const pt2 = await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      const el = pm.querySelector("strong");
      if (!el) return { ok: false };
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    `);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt2.x, y: pt2.y, button: "right", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt2.x, y: pt2.y, button: "right", clickCount: 1 });
    await ui.sleep(450);
    const mi2 = await ui.ev(`
      const menus = Array.from(document.querySelectorAll(".editor-context-menu")).filter(m => m.getBoundingClientRect().width > 0);
      if (!menus.length) return { ok: false };
      const el = Array.from(menus[menus.length-1].querySelectorAll(".context-menu-item"))
        .find(x => (x.textContent || "").includes("格式刷"));
      if (!el) return { ok: false };
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    `);
    if (mi2.ok) {
      await ui.click(mi2.x, mi2.y);
      await ui.sleep(650);
      const a4 = await readPainter();
      ui.add("C4-a", "阅读面选带 mark 的文字 → 进入待刷态（空快照判定不误伤）",
        a4.bodyClass ? "PASS" : "FAIL", `bodyClass=${a4.bodyClass} hint=${JSON.stringify(a4.hint)}`);
      // 应用到"普通文字段落乙"
      const p4 = await ui.ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) {
          const t = w.currentNode.textContent || "";
          const i = t.indexOf("普通文字段落乙");
          if (i >= 0) {
            const rng = document.createRange();
            rng.setStart(w.currentNode, i); rng.setEnd(w.currentNode, i + 2);
            const r = rng.getBoundingClientRect();
            return { ok: true, x: Math.round(r.left + 2), y: Math.round(r.top + r.height/2) };
          }
        }
        return { ok: false };
      `);
      if (p4.ok) {
        const b4 = await readPm();
        await ui.click(p4.x, p4.y);
        await ui.sleep(800);
        const a4b = await readPm();
        const blk = a4b.blocks.find(x => (x.text || "").includes("普通文字段落乙"));
        ui.add("C4-b", "阅读面应用成功（目标块获得 strong mark）",
          blk && blk.marks.includes("strong") ? "PASS" : "FAIL",
          `目标块 marks=${JSON.stringify(blk?.marks)}；DOM strong ${b4.dom.strong}→${a4b.dom.strong}`);
        const p4s = await readPainter();
        ui.add("C4-c", "once 应用成功后自动退出",
          !p4s.bodyClass && !p4s.hint ? "PASS" : "FAIL", `bodyClass=${p4s.bodyClass}`);
      }
    } else {
      ui.add("C4-a", "阅读面带 mark arm（前置：右键菜单）", "FAIL", JSON.stringify(mi2));
    }
  } else {
    ui.add("C4-a", "阅读面带 mark arm（前置：选中）", "FAIL", JSON.stringify(pmSel2));
  }

  /* ══════ C5：应用到**已是同格式**目标 → once 应退出（修法 B）══════ */
  ui.log("");
  ui.log("═══ C5：应用无效（目标是同格式）→ once 应退出 ═══");
  await ui.command("view.edit");
  await ui.sleep(1800);
  await reloadDoc("d1-probe3.md");
  // 先给"普通文字段落乙"加粗（成为同格式目标）
  await ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
      path: "d1-probe4.md", name: "d1-probe4.md",
      content: "# D1\\n\\n**粗体源**\\n\\n**已经是粗体的目标**\\n\\n结尾。" } }));
    return true;
  `);
  await ui.sleep(1500);
  const sel5 = await selectCmExact("**粗体源**");
  ui.log("[C5] 采集选区 = " + JSON.stringify(sel5 && sel5.text));
  if (sel5 && sel5.text === "**粗体源**") {
    await clickPainterBtn(false);
    const a5 = await readPainter();
    ui.log("[C5] arm = " + JSON.stringify(a5));
    // 点"已经是粗体的目标"行（它已经是 **...** → 应用后 next === text → 返回 false）
    const t5 = await ui.ev(`
      for (const l of document.querySelectorAll(".cm-line")) {
        const t = l.textContent || "";
        if (t.indexOf("已经是粗体的目标") >= 0) {
          const r = l.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height/2), line: t.slice(0, 40) };
        }
      }
      return { ok: false };
    `);
    ui.log("[C5] 目标 = " + JSON.stringify(t5));
    if (t5.ok) {
      const b5 = await readCm();
      await ui.click(t5.x, t5.y);
      await ui.sleep(900);
      const af5 = await readCm();
      const after5 = await readPainter();
      const line5 = af5.text.split("\n").find(l => l.includes("已经是粗体的目标")) || "";
      ui.log("[C5] 目标行 = " + JSON.stringify(line5) + " 变化=" + (b5.text !== af5.text));
      ui.add("C5-a", "★ once 模式应用无效时**退出**待刷态（修法 B）",
        !after5.bodyClass && !after5.hint ? "PASS" : "FAIL",
        `bodyClass=${after5.bodyClass} hint=${JSON.stringify(after5.hint)}（修复前会卡在 true）`);
    }
  }

  /* ══════ C6：稳定性（可检查的重试，Lead 要求）══════ */
  /**
   * ## 为什么"重试"必须留下证据（Lead 要求，另一名成员的做法）
   *
   * 探针里的重试是必要的工程手段（浏览器/React 时序有抖动），
   * 但**只看最终 PASS 会把"产品坏 + 探针重试蒙对了"和"产品好"混为一谈**。
   * 所以每条判据都记录**每一轮的结果**，并按形态分类：
   * ```
   * 各轮=[true]              → PASS（无抖动无竞态）
   * 各轮=[true,true,true]    → PASS（多轮一致）
   * 各轮=[false,true,...]    → PASS 但标 ⚠️ flaky（可能时序竞态，需连跑确认）
   * 各轮=[false,false,false] → FAIL（产品坏）
   * ```
   * 这里对 D1 主判据（普通文字不 arm）连测 3 轮。
   */
  ui.log("");
  ui.log("═══ C6：D1 主判据稳定性（3 轮）═══");
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    await reloadDoc("d1-stab-" + i + ".md");
    const s6 = await selectCmExact("普通文字段落乙");
    if (!s6) { rounds.push(null); continue; }
    await clickPainterBtn(false);
    const p6 = await readPainter();
    rounds.push(p6.bodyClass === false);
    ui.log(`[C6] 第 ${i + 1} 轮：选区="${s6.text}" → bodyClass=${p6.bodyClass}`);
    await ui.sleep(300);
  }
  const allTrue = rounds.every(r => r === true);
  const allFalse = rounds.every(r => r === false);
  const flaky = !allTrue && !allFalse;
  ui.add("C6-a", "★★ D1 主判据 3 轮稳定（普通文字不 arm）",
    allTrue ? "PASS" : "FAIL",
    `各轮=${JSON.stringify(rounds)}` +
    (flaky ? " → ⚠️ **flaky**（部分轮成功，可能是时序竞态，需单轮连跑 10 次确认）"
      : allTrue ? " → 无抖动无竞态" : " → **产品坏**（全轮失败）"));

  await ui.shot("painter-d1");
});
