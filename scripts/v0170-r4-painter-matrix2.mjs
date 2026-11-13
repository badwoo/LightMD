/**
 * v0.17.0 第四轮 · T5 · 第 7 项：格式刷 **矩阵剩余行**（M5~M10）
 *
 * 与 `v0170-r4-painter-matrix.mjs`（M1~M4）互补，本文件覆盖：
 *   M5 多格式组合（粗体+斜体）
 *   M6 应用到**已有多格式**文本（覆盖 vs 合并语义）
 *   M7 **跨模式**（阅读面采集 → 编辑面应用 / 反向）
 *   M8 空选区（无选区时点格式刷）
 *   M9 撤销（应用后一次 Ctrl+Z 能否整体撤销）
 *   M10 双击持续 + persistent 模式应用无效**不**退出
 *
 * ## 仪器铁律（沿用 M1~M4）
 * - 绝不裸用 `.ProseMirror`（分屏右侧也是它且文本为空）
 * - PM 结构走 `pmViewDesc.node`（`pmViewDesc` 没有 `view`）
 * - CM6 必须 `state.doc`（虚拟化）
 * - **编辑面采集必须精确选中含符号形态的文本**（`collectSourceSnapshot` 的语义），
 *   否则采集为空 → 会被误判成"功能坏了"（D1 的教训）
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t5" node scripts/v0170-r4-painter-matrix2.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = [
  "# 矩阵剩余行文档",
  "",
  "**粗体源**",
  "",
  "*斜体源*",
  "",
  "~~删除线源~~",
  "",
  "## 标题源",
  "",
  "普通目标甲。",
  "",
  "普通目标乙。",
  "",
  "**已加粗目标**。",
  "",
  "*已斜体目标*。",
  "",
  "结尾撑高段落。".repeat(5),
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
    out.blocks.push({ type: n.type.name, level: n.attrs.level ?? null, marks, text: n.textContent.slice(0, 45) });
  });
  out.dom = { strong: pm.querySelectorAll("strong").length, em: pm.querySelectorAll("em").length,
              del: pm.querySelectorAll("s,del").length, code: pm.querySelectorAll("code").length,
              h1: pm.querySelectorAll("h1").length, h2: pm.querySelectorAll("h2").length,
              li: pm.querySelectorAll("li").length, blockquote: pm.querySelectorAll("blockquote").length };
  return out;
`;

const PAINTER = `
  const bodyClass = document.body.classList.contains("format-painter-armed");
  let hint = null;
  const scope = document.querySelector(".statusbar, .status-bar, footer") || document.body;
  for (const e of scope.querySelectorAll("span,div,button")) {
    const t = (e.textContent || "").trim();
    if (/格式刷/.test(t) && /(单击目标|持续应用|剩余)/.test(t) && e.children.length === 0) { hint = t.slice(0, 90); break; }
  }
  return { bodyClass, hint };
`;

/** CM6 精确选中（Home + 右移 + Shift 右移），必须精确以保留符号形态 */
const selectCmExact = async (ui, needle) => {
  const pt = await ui.ev(`
    for (const l of document.querySelectorAll(".cm-line")) {
      const t = l.textContent || "";
      const i = t.indexOf(${JSON.stringify(needle)});
      if (i >= 0) {
        const r = l.getBoundingClientRect();
        const cw = r.width / Math.max(1, t.length);
        return { ok: true, x: Math.round(r.left + (i + ${JSON.stringify(needle)}.length / 2) * cw),
                 y: Math.round(r.top + r.height / 2), idx: i };
      }
    }
    return { ok: false };
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
    await ui.sleep(13);
  }
  await ui.sleep(300);
  const cm = await ui.ev(CM_TEXT);
  return { ok: true, sel: cm.sel, text: cm.text.slice(cm.sel.from, cm.sel.to) };
};

const clickCmLine = async (ui, needle) => {
  const p = await ui.ev(`
    for (const l of document.querySelectorAll(".cm-line")) {
      const t = l.textContent || "";
      if (t.indexOf(${JSON.stringify(needle)}) >= 0) {
        const r = l.getBoundingClientRect();
        return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
      }
    }
    return { ok: false };
  `);
  if (!p.ok) return false;
  await ui.click(p.x, p.y);
  await ui.sleep(850);
  return true;
};

/** 点工具栏格式刷按钮（可双击） */
const clickPainterBtn = async (ui, persistent) => {
  const b = await ui.ev(`
    const el = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
      .find(x => (x.getAttribute("title") || "").includes("格式刷"));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width };
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
};

/** 在 PM 中精确选中文本（DOM Range + selectionchange） */
const selectPmExact = async (ui, needle) => {
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
    return { ok: false, reason: "not found" };
  `);
  await ui.sleep(280);
  return r;
};

/** 阅读面右键 → 格式刷 */
const rightClickPainterInPm = async (ui, needle) => {
  const pt = await ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror");
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = w.currentNode.textContent || "";
      const i = t.indexOf(${JSON.stringify(needle)});
      if (i >= 0) {
        const rng = document.createRange();
        rng.setStart(w.currentNode, i); rng.setEnd(w.currentNode, i + Math.min(2, t.length - i));
        const r = rng.getBoundingClientRect();
        return { ok: true, x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return { ok: false };
  `);
  if (!pt.ok) return { ok: false, reason: "point not found" };
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
  if (!mi.ok) return mi;
  await ui.click(mi.x, mi.y);
  await ui.sleep(650);
  return { ok: true };
};

await runBrowserProbe({ name: "v0170-r4-painter-matrix2", doc: DOC }, async (ui) => {
  const readCm = () => ui.ev(CM_TEXT);
  const readPm = () => ui.ev(PM_STATE);
  const readPainter = () => ui.ev(PAINTER);
  const reload = async (name) => {
    await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
      path: ${JSON.stringify(name)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(DOC)} } })); return true;`);
    await ui.sleep(1400);
  };

  /* ══════ M5：多格式组合（粗体 + 斜体）══════ */
  ui.log("═══ M5：多格式组合（***粗斜体***）═══");
  await ui.command("view.edit");
  await ui.sleep(2200);
  await reload("m5.md");
  // 先造出 ***粗斜体源***：选中"**粗体源**"再刷斜体太绕；直接用含两种符号的文本
  const docM5 = DOC.replace("**粗体源**", "***粗斜体源***");
  await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
    path: "m5b.md", name: "m5b.md", content: ${JSON.stringify(docM5)} } })); return true;`);
  await ui.sleep(1500);
  const s5 = await selectCmExact(ui, "***粗斜体源***");
  ui.log("[M5] 采集选区 = " + JSON.stringify(s5 && { text: s5.text }));
  if (s5 && s5.text === "***粗斜体源***") {
    const btn = await clickPainterBtn(ui, false);
    const a5 = await readPainter();
    ui.add("M5-a", "多格式源（***粗斜体***）可 arm", a5.bodyClass ? "PASS" : "FAIL",
      `bodyClass=${a5.bodyClass} hint=${JSON.stringify(a5.hint)}`);
    if (await clickCmLine(ui, "普通目标甲")) {
      const cm5 = await readCm();
      const line5 = cm5.text.split("\n").find(l => l.includes("普通目标甲")) || "";
      // 期望：同时含 ** 与 * （嵌套包裹）
      const hasBold = line5.includes("**");
      const hasItalic = /(^|[^*])\*[^*]/.test(line5) || line5.includes("***");
      ui.add("M5-b", "★ 多格式应用到目标（粗体+斜体同时出现）",
        hasBold && hasItalic ? "PASS" : "FAIL",
        `目标行=${JSON.stringify(line5.slice(0, 60))} hasBold=${hasBold} hasItalic=${hasItalic}`);
    }
  } else {
    ui.add("M5-a", "多格式源 arm（前置）", "FAIL", JSON.stringify(s5));
  }

  /* ══════ M6：应用到**已有多格式**文本（覆盖语义）══════ */
  ui.log("");
  ui.log("═══ M6：覆盖 vs 合并（刷粗体到已是斜体的目标）═══");
  await reload("m6.md");
  const s6 = await selectCmExact(ui, "**粗体源**");
  ui.log("[M6] 采集 = " + JSON.stringify(s6 && s6.text));
  if (s6 && s6.text === "**粗体源**") {
    await clickPainterBtn(ui, false);
    if (await clickCmLine(ui, "已斜体目标")) {
      const cm6 = await readCm();
      const line6 = cm6.text.split("\n").find(l => l.includes("已斜体目标")) || "";
      // wrapRangeWithMarks 会先剥离已有符号再套快照 → 期望结果只有 **，斜体被清除（覆盖式）
      const onlyBold = /^\s*\*\*[^*]+\*\*\s*[。.]?\s*$/.test(line6.trim()) || (line6.includes("**") && !/(^|[^*])\*[^*]/.test(line6.replace(/\*\*/g, "")));
      ui.add("M6-a", "★ 覆盖语义：目标原有斜体被清除，只剩粗体（Word 语义）",
        onlyBold ? "PASS" : "FAIL",
        `目标行=${JSON.stringify(line6.slice(0, 60))}（期望形如 "**已斜体目标。**"，不含残留 *）`);
    }
  }

  /* ══════ M7：跨模式 ══════ */
  ui.log("");
  ui.log("═══ M7：跨模式（阅读面采集 → 编辑面应用）═══");
  await ui.command("view.preview");
  await ui.sleep(1800);
  await reload("m7.md");
  // 阅读面采集：选中粗体文字 → 右键格式刷
  const pmSel = await selectPmExact(ui, "粗体源");
  ui.log("[M7] 阅读面选区 = " + JSON.stringify(pmSel));
  let armedAcross = false;
  if (pmSel.ok) {
    const rc = await rightClickPainterInPm(ui, "粗体源");
    ui.log("[M7] 右键 arm = " + JSON.stringify(rc));
    const pv = await readPainter();
    armedAcross = pv.bodyClass;
    ui.log("[M7] arm 状态 = " + JSON.stringify(pv));
    if (armedAcross) {
      // 切到编辑面（切模式会 exit 格式刷！这是既有设计：切文件/切模式自动退出）
      await ui.command("view.edit");
      await ui.sleep(2000);
      const afterSwitch = await readPainter();
      ui.add("M7-a", "★ 跨模式：切模式后格式刷是否仍 armed",
        "KNOWN",
        `切换前 armed=true → 切换后 bodyClass=${afterSwitch.bodyClass} ` +
        `（**若是 false = 设计如此**：FormatMenuHost 的 useEffect 显式在 filePath/viewMode 变化时 exit，` +
        `防快照跨文档误用。所以"跨模式"在**当前实现下是"未支持"而非"坏了"**）`);
      // 如实记录：切模式后无法继续 → 跨模式不可用（设计限制）
      ui.add("M7-b", "跨模式格式刷可用性结论", "KNOWN",
        afterSwitch.bodyClass === false
          ? "**未实现（设计限制）**：`FormatMenuHost.tsx` 的 `useEffect([filePath, viewMode])` 调 `store.exit()`，" +
            "切模式必然清空快照。中间表示 `FormatSnapshot` 本身两侧通用，**理论上可实现**，" +
            "但需产品决策（是否允许跨模式携带格式）。"
          : "跨模式意外可用，需进一步验证语义");
    }
  }

  /* ══════ M8：空选区 ══════ */
  ui.log("");
  ui.log("═══ M8：空选区（无选区点格式刷）═══");
  await ui.command("view.edit");
  await ui.sleep(1800);
  await reload("m8.md");
  // 点空白处收起选区
  await ui.ev(`
    const c = document.querySelector(".cm-content");
    if (c) c.focus();
    return true;
  `);
  await ui.sleep(200);
  await ui.key("Escape", "Escape", 27);
  await ui.sleep(300);
  const emptySel = await readCm();
  ui.log("[M8] 当前选区 = " + JSON.stringify(emptySel.sel));
  const before8 = await readPainter();
  await clickPainterBtn(ui, false);
  const after8 = await readPainter();
  const toasts8 = await ui.ev(`
    return Array.from(document.querySelectorAll("[class*='notification'],[class*='toast'],[role='alert']"))
      .map(e => (e.textContent || "").trim().slice(0, 100)).filter(Boolean);
  `);
  ui.add("M8-a", "★ 空选区点格式刷 → 不 arm 且提示「请先选中」",
    after8.bodyClass === false && (toasts8.length > 0 || after8.hint) ? "PASS" : "FAIL",
    `选区=${JSON.stringify(emptySel.sel)} bodyClass=${after8.bodyClass} toasts=${JSON.stringify(toasts8.slice(0, 2))}`);

  /* ══════ M9：撤销（应用后一次 Ctrl+Z 整体撤销）══════ */
  ui.log("");
  ui.log("═══ M9：撤销（格式刷应用后 Ctrl+Z）═══");
  await reload("m9.md");
  const s9 = await selectCmExact(ui, "**粗体源**");
  if (s9 && s9.text === "**粗体源**") {
    await clickPainterBtn(ui, false);
    if (await clickCmLine(ui, "普通目标甲")) {
      const applied = await readCm();
      const lineApplied = applied.text.split("\n").find(l => l.includes("普通目标甲")) || "";
      await ui.ev(`
        const c = document.querySelector(".cm-content");
        if (c) c.focus();
        return true;
      `);
      await ui.sleep(200);
      await ui.key("z", "KeyZ", 90, 2); // Ctrl+Z
      await ui.sleep(900);
      const undone = await readCm();
      const lineUndone = undone.text.split("\n").find(l => l.includes("普通目标甲")) || "";
      // 注意：若"普通目标甲"本身含"目标"字样变化，用整行比对
      const restored = lineUndone.trim() === "普通目标甲。";
      ui.add("M9-a", "★ 格式刷应用后一次 Ctrl+Z 整体撤销",
        restored ? "PASS" : "FAIL",
        `应用后=${JSON.stringify(lineApplied.slice(0, 50))} → 撤销后=${JSON.stringify(lineUndone.slice(0, 50))}` +
        `（期望回到 "普通目标甲。"）`);
    }
  }

  /* ══════ M10：persistent 模式应用无效**不**退出 ══════ */
  ui.log("");
  ui.log("═══ M10：persistent 模式应用无效不退出 ═══");
  await reload("m10.md");
  const s10 = await selectCmExact(ui, "**粗体源**");
  if (s10 && s10.text === "**粗体源**") {
    await clickPainterBtn(ui, true); // 双击 = persistent
    const p10 = await readPainter();
    ui.add("M10-a", "双击进入持续模式", /持续|剩余/.test(p10.hint || "") ? "PASS" : "FAIL",
      `hint=${JSON.stringify(p10.hint)}`);
    // 点一个**已经是粗体**的目标（应用无效）
    if (await clickCmLine(ui, "已加粗目标")) {
      const after10 = await readPainter();
      ui.add("M10-b", "★ persistent 模式应用无效 → **保持**待刷态（修法 B 的模式区分）",
        after10.bodyClass ? "PASS" : "FAIL",
        `bodyClass=${after10.bodyClass} hint=${JSON.stringify(after10.hint)}（期望仍 true）`);
      // 再点一个普通目标，证明还能继续用
      if (await clickCmLine(ui, "普通目标乙")) {
        const cm10 = await readCm();
        const line10 = cm10.text.split("\n").find(l => l.includes("普通目标乙")) || "";
        ui.add("M10-c", "★ persistent 模式无效后仍可继续应用",
          line10.trim().startsWith("**") ? "PASS" : "FAIL",
          `后续目标=${JSON.stringify(line10.slice(0, 50))}`);
      }
    }
  }

  await ui.shot("matrix2");
});
