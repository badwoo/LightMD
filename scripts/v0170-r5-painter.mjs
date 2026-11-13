/**
 * v0.17.0 第五轮 · V5 实机验证：**格式刷 / 斜杠 / 菜单**（8 项）
 *
 * 载体：**真机 Tauri exe + WebView2**（`src-tauri/target/release/lightmd.exe`，
 * identifier=`com.lightmd.probe`），**不是浏览器 dist**。
 *
 * ## 本轮定位：**只验证，不修复**
 * 按 Lead 纪律：不改任何源码；FAIL → 只记录 + 上报。
 *
 * ## 仪器铁律（全部来自前几轮血泪，违反会产出假结论）
 * 1. **绝不裸用 `.ProseMirror`**：分屏右侧预览面也是 `.ProseMirror`（实测文本长度 0），
 *    裸选择器会命中它 → 读到空文档 → 假 FAIL。一律 `.editor-container .ProseMirror`。
 * 2. **PM 结构走 `pmViewDesc.node`**：`pmViewDesc` **没有** `view` 字段（实测 keys 只有
 *    parent/children/dom/contentDOM/dirty/node/outerDeco/innerDeco/nodeDOM）。
 * 3. **CM6 必须走 `state.doc`**：虚拟化渲染，拼 `.cm-line` 只拿到视口内几行。
 * 4. **编辑面采集必须精确选中含符号形态的文本**（`collectSourceSnapshot` 的语义：
 *    `startsWith("**") && endsWith("**")`）。选整行 → 剥离失败 → marks=[] →
 *    会把"我没选对"误判成"产品坏了"（R4 踩过，见 `_plan/v0170-r4-t5-painter.md` §2）。
 * 5. **任何 `undefined`/空数组 metric → 先当探针 bug 排查**，不解读为产品结论。
 *
 * ## 真机右键菜单的关键手法（R4 已验证可行）
 * 1. 用 DOM Range 设选区 + `pm.focus()` + 派发 `selectionchange`，**让 PM 的 state.selection 同步**；
 * 2. 再用 CDP 真实右键（`mousePressed`/`mouseReleased` + `button:"right"`）。
 *    ⚠️ 只派发 `new MouseEvent("contextmenu")` 不够 —— PM 的 `posAtCoords` 需要真实坐标，
 *    且菜单的 `hasSelection` 判定读的是 **PM state.selection**（不是 window.getSelection）。
 *
 * 用法：
 *   node scripts/v0170-r5-painter.mjs
 *   （探针会自己排队等 `.lmd-probe.lock`，最多 20 分钟）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# V5 格式刷验证文档",
  "",
  "**粗体源**",
  "",
  "*斜体源*",
  "",
  "普通文字段落甲。",
  "",
  "普通文字段落乙。",
  "",
  "普通文字段落丙。",
  "",
  "*已斜体目标*。",
  "",
  "结尾撑高段落。".repeat(6),
  "",
].join("\n");

/* ═════════ 页面内读取器（全部限定容器，见铁律 1） ═════════ */

const CM_TEXT = `
  const c = document.querySelector(".cm-content");
  if (!c) return { ok: false };
  try {
    const v = c.cmTile && c.cmTile.view;
    if (v && v.state && v.state.doc) {
      return { ok: true, text: v.state.doc.toString(),
               sel: { from: v.state.selection.main.from, to: v.state.selection.main.to } };
    }
  } catch (e) { return { ok: false, err: String(e) }; }
  return { ok: false };
`;

const PM_STATE = `
  const pm = document.querySelector(".editor-container .ProseMirror");
  if (!pm) return { ok: false, reason: "no main PM (务必限定 .editor-container)" };
  const dv = pm.pmViewDesc;
  const out = { ok: true, blocks: [], dom: {} };
  if (dv && dv.node) {
    dv.node.forEach((n) => {
      const marks = [];
      n.descendants((c) => { if (c.isText) c.marks.forEach(m => { if (!marks.includes(m.type.name)) marks.push(m.type.name); }); return true; });
      out.blocks.push({ type: n.type.name, level: n.attrs.level ?? null, marks, text: n.textContent.slice(0, 60) });
    });
  }
  out.dom = {
    strong: pm.querySelectorAll("strong").length,
    em: pm.querySelectorAll("em").length,
    del: pm.querySelectorAll("s,del").length,
    code: pm.querySelectorAll("code").length,
    li: pm.querySelectorAll("li").length,
  };
  return out;
`;

/** 格式刷状态（body class + 状态栏提示 + toast 文案） */
const PAINTER = `
  const bodyClass = document.body.classList.contains("format-painter-armed");
  let hint = null;
  const scope = document.querySelector(".statusbar, .status-bar, footer") || document.body;
  for (const e of scope.querySelectorAll("span,div,button")) {
    const t = (e.textContent || "").trim();
    if (/格式刷/.test(t) && /(单击目标|持续应用|剩余)/.test(t) && e.children.length === 0) { hint = t.slice(0, 100); break; }
  }
  const toasts = Array.from(document.querySelectorAll(
    "[class*='notification'],[class*='toast'],[role='alert']"
  )).map(e => (e.textContent || "").trim().slice(0, 120)).filter(Boolean);
  return { bodyClass, hint, toasts: [...new Set(toasts)] };
`;

/** 打开中的右键菜单项 */
const MENU_ITEMS = `
  const menus = Array.from(document.querySelectorAll(".editor-context-menu"))
    .filter(m => m.getBoundingClientRect().width > 0);
  if (!menus.length) return { open: false };
  const m = menus[menus.length - 1];
  return {
    open: true,
    items: Array.from(m.querySelectorAll(".context-menu-item")).map((el, i) => ({
      i, label: (el.textContent || "").trim().slice(0, 40),
      disabled: el.classList.contains("disabled"),
    })),
  };
`;

await runProbe({
  name: "v0170-r5-painter",
  doc: DOC,
  docTitle: "V5 格式刷验证文档",
  viewMode: "edit",
}, async (ui) => {
  /**
   * ## 自建 click / wheel（骨架不提供，不是产品问题）
   *
   * `probe-harness.mjs` 只给了 `key` / `typeText` / `ev` / `shot` 等，**没有**
   * 鼠标点击与滚轮。浏览器版骨架（`_lib/browser-probe.mjs`）有，实机版没有 ——
   * 这是两个骨架的能力差异，不是产品缺陷。
   *
   * ⚠️ 第一次跑就在这里崩了：`ui.click is not a function` → 若当成产品问题
   * 就会误报"V5-1 崩溃"。**任何 `xxx is not a function` 一律先当探针 bug。**
   */
  const mouseClick = async (x, y, button = "left") => {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    await ui.sleep(50);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
    await ui.sleep(120);
  };
  const mouseWheel = async (x, y, deltaY) => {
    await ui.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY, pointerType: "mouse",
    });
    await ui.sleep(16);
  };

  const readCm = () => ui.ev(CM_TEXT);
  const readPm = () => ui.ev(PM_STATE);
  const readPainter = () => ui.ev(PAINTER);
  const reloadDoc = async (name, content) => {
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
        path: ${JSON.stringify(name)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} } }));
      return true;
    `);
    await ui.sleep(1500);
  };

  /* ══════════ F 组：焦点与两面归属（铁律 1 的前置验证） ══════════ */
  const fEdit = await ui.ev(`
    const pms = Array.from(document.querySelectorAll(".ProseMirror"));
    return {
      active: (document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : "none").slice(0, 60),
      hasCm: !!document.querySelector(".cm-content"),
      splitPmCount: pms.filter(p => p.closest(".split-preview-shell")).length,
      mainPmCount: pms.filter(p => p.closest(".editor-container")).length,
      splitPmTextLen: (() => { const p = pms.find(x => x.closest(".split-preview-shell")); return p ? (p.textContent || "").length : null; })(),
      impl: document.querySelector(".cm-editor") ? "cm6" : "textarea",
    };
  `);
  ui.log("[F-edit] " + JSON.stringify(fEdit));
  ui.add("F1", "真机编辑模式有 CM6 源码面", fEdit.hasCm ? "PASS" : "FAIL", JSON.stringify(fEdit));
  ui.add("F2", "★ 分屏右侧预览面也是 .ProseMirror（裸选择器会误命中）",
    fEdit.splitPmCount > 0 ? "PASS" : "KNOWN",
    `主=${fEdit.mainPmCount} 分割=${fEdit.splitPmCount}，分割面文本长度=${fEdit.splitPmTextLen}` +
    `（为空 → 裸 querySelector('.ProseMirror') 命中的是空文档）`);

  /* ═══════════════════════════════════════════════════════════
   * V5-1：R4 P0 斜杠崩溃 —— 编辑模式空行行首敲 `/` → 不崩溃
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-1：斜杠命令不崩溃（R4 P0）═══");
  await reloadDoc("v5-1.md", "# 斜杠测试\n\n\n\n结尾段落。\n");
  await ui.focusSource();
  await ui.sleep(400);

  // 把光标放到**空行**行首：点第 3 行（空行）→ Home
  const emptyLine = await ui.ev(`
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].textContent || "";
      if (t.trim() === "") {
        const r = lines[i].getBoundingClientRect();
        if (r.height > 0) return { ok: true, x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2), idx: i };
      }
    }
    return { ok: false, lineCount: lines.length };
  `);
  ui.log("[V5-1] 空行定位 = " + JSON.stringify(emptyLine));
  if (emptyLine.ok) {
    await mouseClick(emptyLine.x, emptyLine.y);
    await ui.sleep(300);
    await ui.key("Home", "Home", 36);
    await ui.sleep(200);
  }
  const errBefore = (await ui.errors()).length;
  await ui.key("/", "Slash", 191);
  await ui.sleep(1200);

  const slashState = await ui.ev(`
    const menu = document.querySelector(".slash-command-menu");
    const items = menu ? menu.querySelectorAll(".slash-command-item") : [];
    const cm = document.querySelector(".cm-editor");
    return {
      menuOpen: !!menu,
      itemCount: items.length,
      firstItems: Array.from(items).slice(0, 4).map(e => (e.textContent || "").trim().slice(0, 20)),
      cmAlive: !!cm,
      cmContentAlive: !!document.querySelector(".cm-content"),
      bodyHasError: !!document.querySelector(".error-boundary"),
    };
  `);
  const errAfter = await ui.errors();
  ui.log("[V5-1] 敲 / 后 = " + JSON.stringify(slashState));
  ui.log("[V5-1] 未捕获异常 = " + JSON.stringify(errAfter.slice(0, 3)));

  ui.add("V5-1a", "★ 空行行首敲 `/` 后 **CM6 仍存活**（不崩溃）",
    slashState.cmAlive && slashState.cmContentAlive ? "PASS" : "FAIL",
    `cm.editor=${slashState.cmAlive} cm.content=${slashState.cmContentAlive} errorBoundary=${slashState.bodyHasError}`);
  ui.add("V5-1b", "★ 斜杠菜单出现", slashState.menuOpen ? "PASS" : "FAIL",
    `menuOpen=${slashState.menuOpen} 项数=${slashState.itemCount}`);
  ui.add("V5-1c", "菜单项数 ≥ 15", slashState.itemCount >= 15 ? "PASS" : "FAIL",
    `实际 ${slashState.itemCount} 项；前 4 项=${JSON.stringify(slashState.firstItems)}`);
  ui.add("V5-1d", "敲 `/` 期间无新增未捕获异常",
    errAfter.length <= errBefore ? "PASS" : "FAIL",
    `前=${errBefore} 后=${errAfter.length}；${JSON.stringify(errAfter.slice(0, 2))}`);

  await ui.shot("v5-1-slash");

  /* ═══════════════════════════════════════════════════════════
   * V5-2：R4 Esc 自噬环路 —— 菜单打开 → Esc → 关闭且不弹回
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-2：Esc 关闭斜杠菜单且不弹回（R4 自噬环路）═══");
  const menuBeforeEsc = await ui.ev(`return { open: !!document.querySelector(".slash-command-menu") };`);
  await ui.key("Escape", "Escape", 27);
  await ui.sleep(500);
  const menuAfter1 = await ui.ev(`return { open: !!document.querySelector(".slash-command-menu") };`);
  // 再等 1.5s 看是否"弹回"（自噬环路的典型表现）
  await ui.sleep(1500);
  const menuAfter2 = await ui.ev(`return { open: !!document.querySelector(".slash-command-menu") };`);
  ui.log(`[V5-2] Esc 前=${JSON.stringify(menuBeforeEsc)} Esc 后=${JSON.stringify(menuAfter1)} 等 1.5s 后=${JSON.stringify(menuAfter2)}`);

  ui.add("V5-2a", "Esc 前菜单确实打开（前置）", menuBeforeEsc.open ? "PASS" : "FAIL", JSON.stringify(menuBeforeEsc));
  ui.add("V5-2b", "★ Esc 后菜单关闭", !menuAfter1.open ? "PASS" : "FAIL", JSON.stringify(menuAfter1));
  ui.add("V5-2c", "★ Esc 后**不弹回**（自噬环路判定：等 1.5s 仍关闭）",
    !menuAfter2.open ? "PASS" : "FAIL", JSON.stringify(menuAfter2));
  const slashText = await readCm();
  ui.add("V5-2d", "Esc 后源码面仍正常（未丢内容）",
    slashText.ok && slashText.text.length > 5 ? "PASS" : "FAIL",
    `len=${slashText.ok ? slashText.text.length : "?"}`);

  /* ═══════════════════════════════════════════════════════════
   * V5-3：D1 空快照静默失败（编辑面 + 阅读面）
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-3：D1 空快照 → 不 arm + 有提示 ═══");
  await reloadDoc("v5-3.md", DOC);
  await ui.focusSource();
  await ui.sleep(400);

  // 精确选中「普通文字段落甲」（无任何格式）
  const selPlain = await ui.ev(`
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    for (const l of lines) {
      const t = l.textContent || "";
      const i = t.indexOf("普通文字段落甲");
      if (i >= 0) {
        const r = l.getBoundingClientRect();
        const cw = r.width / Math.max(1, t.length);
        return { ok: true, x: Math.round(r.left + (i + 3) * cw), y: Math.round(r.top + r.height / 2), idx: i };
      }
    }
    return { ok: false };
  `);
  let cmPlainSel = null;
  if (selPlain.ok) {
    await mouseClick(selPlain.x, selPlain.y);
    await ui.sleep(250);
    await ui.key("Home", "Home", 36);
    await ui.sleep(120);
    for (let i = 0; i < selPlain.idx; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(10); }
    for (let i = 0; i < "普通文字段落甲".length; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(12);
    }
    await ui.sleep(300);
    const cm = await readCm();
    cmPlainSel = cm.ok ? cm.text.slice(cm.sel.from, cm.sel.to) : null;
  }
  ui.log("[V5-3] 编辑面选区 = " + JSON.stringify(cmPlainSel));

  const painterBtn = await ui.ev(`
    const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
      .find(x => (x.getAttribute("title") || "").includes("格式刷"));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), visible: r.width > 0 };
  `);
  ui.add("V5-3-0", "编辑面有格式刷工具栏按钮（前置）",
    painterBtn && painterBtn.visible ? "PASS" : "FAIL", JSON.stringify(painterBtn));

  if (cmPlainSel === "普通文字段落甲" && painterBtn) {
    const bt = await readPainter();
    await mouseClick(painterBtn.x, painterBtn.y);
    await ui.sleep(800);
    const at = await readPainter();
    const newToasts = at.toasts.filter(t => !bt.toasts.includes(t));
    ui.log("[V5-3] arm 后 = " + JSON.stringify(at));
    ui.add("V5-3a", "★★ 编辑面选普通文字 → **不进入**待刷态（D1 主判据）",
      at.bodyClass === false ? "PASS" : "FAIL",
      `bodyClass=${at.bodyClass}（修复前 true）hint=${JSON.stringify(at.hint)}`);
    ui.add("V5-3b", "★ 且有明确提示（不是静默拒绝）",
      newToasts.length > 0 || at.toasts.length > 0 ? "PASS" : "FAIL",
      `toasts=${JSON.stringify(at.toasts.slice(0, 2))}`);
    ui.add("V5-3c", "提示文案说清「为什么+该怎么做」",
      /没有可复制的格式|带格式|加粗|标题|列表|请先选中/.test(JSON.stringify(at.toasts)) ? "PASS" : "FAIL",
      JSON.stringify(at.toasts.slice(0, 1)));
  } else {
    ui.add("V5-3a", "编辑面普通文字 arm（前置：精确选中）", "FAIL",
      `选区=${JSON.stringify(cmPlainSel)} btn=${!!painterBtn}`);
  }

  /* ═══════════════════════════════════════════════════════════
   * V5-4：D2 覆盖式语义（采集 **粗体** → 刷到 *斜体*。→ 期望 **斜体。**）
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-4：D2 覆盖式语义 ═══");
  await reloadDoc("v5-4.md", "# D2\n\n**粗体源**\n\n*已斜体目标*。\n\n结尾。\n");
  await ui.focusSource();
  await ui.sleep(400);

  // 精确选中 **粗体源**
  const selBold = await ui.ev(`
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    for (const l of lines) {
      const t = l.textContent || "";
      const i = t.indexOf("**粗体源**");
      if (i >= 0) {
        const r = l.getBoundingClientRect();
        const cw = r.width / Math.max(1, t.length);
        return { ok: true, x: Math.round(r.left + (i + 2) * cw), y: Math.round(r.top + r.height / 2), idx: i };
      }
    }
    return { ok: false };
  `);
  let boldSelOk = false;
  if (selBold.ok) {
    await mouseClick(selBold.x, selBold.y);
    await ui.sleep(250);
    await ui.key("Home", "Home", 36);
    await ui.sleep(120);
    for (let i = 0; i < selBold.idx; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(10); }
    for (let i = 0; i < "**粗体源**".length; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(12);
    }
    await ui.sleep(300);
    const cm = await readCm();
    boldSelOk = cm.ok && cm.text.slice(cm.sel.from, cm.sel.to) === "**粗体源**";
    ui.log("[V5-4] 采集选区 = " + JSON.stringify(cm.ok ? cm.text.slice(cm.sel.from, cm.sel.to) : null));
  }
  ui.add("V5-4-0", "精确选中 `**粗体源**`（前置，铁律 4）", boldSelOk ? "PASS" : "FAIL",
    `说明：选整行会导致 collectSourceSnapshot 剥离失败 → marks=[] → 假 FAIL`);

  if (boldSelOk && painterBtn) {
    await mouseClick(painterBtn.x, painterBtn.y);
    await ui.sleep(700);
    const armed4 = await readPainter();
    ui.add("V5-4-1", "采集后进入待刷态", armed4.bodyClass ? "PASS" : "FAIL", JSON.stringify({ bodyClass: armed4.bodyClass, hint: armed4.hint }));

    // 点目标行「*已斜体目标*。」
    const tgt = await ui.ev(`
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      for (const l of lines) {
        const t = l.textContent || "";
        if (t.indexOf("已斜体目标") >= 0) {
          const r = l.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2), line: t };
        }
      }
      return { ok: false };
    `);
    ui.log("[V5-4] 目标行 = " + JSON.stringify(tgt));
    if (tgt.ok) {
      await mouseClick(tgt.x, tgt.y);
      await ui.sleep(1000);
      const after = await readCm();
      const applied = after.ok ? (after.text.split("\n").find(l => l.includes("已斜体目标")) || "") : "";
      ui.log("[V5-4] 应用后 = " + JSON.stringify(applied));
      const isMalformed = applied.includes("***") || /^\*\*\*|\*。\*\*$/.test(applied.trim());
      ui.add("V5-4a", "★★ D2：目标行应为 `**已斜体目标。**`（覆盖式，斜体被清除）",
        applied.trim() === "**已斜体目标。**" ? "PASS" : "FAIL",
        `实际=${JSON.stringify(applied.trim())}；期望="**已斜体目标。"；修复前="***已斜体目标*。**"`);
      ui.add("V5-4b", "★ 无畸形嵌套（不含 `***` 且不是 `*X。**` 形态）",
        !isMalformed ? "PASS" : "FAIL", `畸形判定=${isMalformed} 实际=${JSON.stringify(applied.trim())}`);
    } else {
      ui.add("V5-4a", "D2 目标行定位（前置）", "FAIL", JSON.stringify(tgt));
    }
  }

  /* ═══════════════════════════════════════════════════════════
   * V5-5：单击一次流程（采集 → 应用 → 自动退出）
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-5：单击一次流程（应用后自动退出）═══");
  await reloadDoc("v5-5.md", "# V5-5\n\n**粗体源**\n\n普通目标甲。\n\n结尾。\n");
  await ui.focusSource();
  await ui.sleep(400);

  const sel5 = await ui.ev(`
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    for (const l of lines) {
      const t = l.textContent || "";
      const i = t.indexOf("**粗体源**");
      if (i >= 0) {
        const r = l.getBoundingClientRect();
        const cw = r.width / Math.max(1, t.length);
        return { ok: true, x: Math.round(r.left + (i + 2) * cw), y: Math.round(r.top + r.height / 2), idx: i };
      }
    }
    return { ok: false };
  `);
  let sel5ok = false;
  if (sel5.ok) {
    await mouseClick(sel5.x, sel5.y);
    await ui.sleep(250);
    await ui.key("Home", "Home", 36);
    await ui.sleep(120);
    for (let i = 0; i < sel5.idx; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(10); }
    for (let i = 0; i < 7; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(12);
    }
    await ui.sleep(300);
    const cm = await readCm();
    sel5ok = cm.ok && cm.text.slice(cm.sel.from, cm.sel.to) === "**粗体源**";
  }
  if (sel5ok && painterBtn) {
    await mouseClick(painterBtn.x, painterBtn.y);
    await ui.sleep(700);
    const a5 = await readPainter();
    ui.add("V5-5a", "单击格式刷 → 待刷态且提示为「单击目标应用」",
      a5.bodyClass && /单击目标/.test(a5.hint || "") ? "PASS" : "FAIL",
      `bodyClass=${a5.bodyClass} hint=${JSON.stringify(a5.hint)}`);

    const t5 = await ui.ev(`
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      for (const l of lines) {
        if ((l.textContent || "").indexOf("普通目标甲") >= 0) {
          const r = l.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
        }
      }
      return { ok: false };
    `);
    if (t5.ok) {
      await mouseClick(t5.x, t5.y);
      await ui.sleep(1000);
      const cm5 = await readCm();
      const line5 = cm5.ok ? (cm5.text.split("\n").find(l => l.includes("普通目标甲")) || "") : "";
      const a5b = await readPainter();
      ui.log("[V5-5] 应用后行 = " + JSON.stringify(line5) + " 状态=" + JSON.stringify(a5b));
      ui.add("V5-5b", "★ 应用成功（目标行被 ** 包裹）",
        line5.trim() === "**普通目标甲。**" ? "PASS" : "FAIL", `实际=${JSON.stringify(line5.trim())}`);
      ui.add("V5-5c", "★ 应用后**自动退出**待刷态（once 语义）",
        !a5b.bodyClass && !a5b.hint ? "PASS" : "FAIL",
        `bodyClass=${a5b.bodyClass} hint=${JSON.stringify(a5b.hint)}`);
    }
  } else {
    ui.add("V5-5a", "V5-5 前置（精确选中采集源）", "FAIL", `sel5ok=${sel5ok}`);
  }

  await ui.shot("v5-5-once");

  /* ═══════════════════════════════════════════════════════════
   * V5-6：★ 新功能 —— 阅读模式右键「格式刷（连续刷）」
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-6：★ 阅读模式右键「格式刷（连续刷）」新功能 ═══");
  await ui.command("view.preview");
  await ui.sleep(2000);
  await reloadDoc("v5-6.md", DOC);
  await ui.sleep(300);

  const fRead = await ui.ev(`
    const pms = Array.from(document.querySelectorAll(".ProseMirror"));
    return {
      mainPm: pms.filter(p => p.closest(".editor-container")).length,
      splitPm: pms.filter(p => p.closest(".split-preview-shell")).length,
      toolbar: !!document.querySelector(".source-format-toolbar"),
      pmText: (() => { const p = document.querySelector(".editor-container .ProseMirror"); return p ? (p.textContent||"").slice(0, 40) : null; })(),
    };
  `);
  ui.log("[V5-6] 阅读面 = " + JSON.stringify(fRead));
  ui.add("V5-6-0", "进入阅读模式（主 PM 存在，工具栏不渲染）",
    fRead.mainPm > 0 && fRead.toolbar === false ? "PASS" : "FAIL", JSON.stringify(fRead));

  /** 在 PM 里精确选中 needle（DOM Range + focus + selectionchange，让 PM state 同步） */
  const selectPmExact = async (needle) => {
    const r = await ui.ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      if (!pm) return { ok: false, reason: "no main PM" };
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
    await ui.sleep(300);
    return r;
  };

  /** 真实右键某个坐标（CDP 完整鼠标序列） */
  const rightClickAt = async (x, y) => {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
    await ui.sleep(60);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
    await ui.sleep(600);
  };

  /** 取 PM 中某段文字的屏幕坐标 */
  const pmPoint = async (needle) => ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror");
    if (!pm) return { ok: false };
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

  const sel6 = await selectPmExact("粗体源");
  ui.log("[V5-6] 阅读面选区 = " + JSON.stringify(sel6));
  const pt6 = await pmPoint("粗体源");
  ui.log("[V5-6] 右键点 = " + JSON.stringify(pt6));
  let menu6 = { open: false };
  if (sel6.ok && pt6.ok) {
    await rightClickAt(pt6.x, pt6.y);
    menu6 = await ui.ev(MENU_ITEMS);
    ui.log("[V5-6] 菜单 = " + JSON.stringify(menu6));
  }

  const labels6 = (menu6.items || []).map(i => i.label);
  const hasOnce = labels6.some(l => /^格式刷$/.test(l));
  const hasCont = labels6.some(l => /连续刷/.test(l));
  ui.add("V5-6a", "阅读面右键菜单打开且含**两项**格式刷（格式刷 / 格式刷（连续刷））",
    menu6.open && hasOnce && hasCont ? "PASS" : "FAIL",
    `菜单项=${JSON.stringify(labels6)}；hasOnce=${hasOnce} hasContinuous=${hasCont}`);

  /** 点菜单里 label 匹配 re 的项 */
  const clickMenuItem = async (re) => {
    const mi = await ui.ev(`
      const menus = Array.from(document.querySelectorAll(".editor-context-menu"))
        .filter(m => m.getBoundingClientRect().width > 0);
      if (!menus.length) return { ok: false, reason: "no open menu" };
      const m = menus[menus.length - 1];
      const items = Array.from(m.querySelectorAll(".context-menu-item"));
      const re = new RegExp(${JSON.stringify(re)});
      const el = items.find(x => re.test((x.textContent || "").trim()));
      if (!el) return { ok: false, reason: "item not found: " + ${JSON.stringify(re)}, all: items.map(i => (i.textContent||"").trim()) };
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               label: (el.textContent || "").trim() };
    `);
    if (!mi.ok) return mi;
    await mouseClick(mi.x, mi.y);
    await ui.sleep(700);
    return mi;
  };

  if (menu6.open && hasCont) {
    // ★ 点「格式刷（连续刷）」
    const clicked = await clickMenuItem("连续刷");
    ui.log("[V5-6] 点连续刷 = " + JSON.stringify(clicked));
    const armed6 = await readPainter();
    ui.log("[V5-6] arm 后 = " + JSON.stringify(armed6));
    ui.add("V5-6b", "★★ 点「格式刷（连续刷）」→ 进入 **persistent 态**（提示含「持续应用」）",
      armed6.bodyClass && /持续应用|剩余/.test(armed6.hint || "") ? "PASS" : "FAIL",
      `bodyClass=${armed6.bodyClass} hint=${JSON.stringify(armed6.hint)}`);

    // ★ 依次点 3 个不同目标
    const targets6 = ["普通文字段落甲", "普通文字段落乙", "普通文字段落丙"];
    const results6 = [];
    for (const tname of targets6) {
      const p = await pmPoint(tname);
      if (!p.ok) { results6.push({ tname, ok: false, reason: "point not found" }); continue; }
      await mouseClick(p.x, p.y);
      await ui.sleep(900);
      const pm = await readPm();
      const blk = (pm.blocks || []).find(b => (b.text || "").includes(tname));
      results6.push({ tname, ok: !!blk && blk.marks.includes("strong"), marks: blk ? blk.marks : null });
    }
    ui.log("[V5-6] 连刷 3 次 = " + JSON.stringify(results6));
    const appliedCount = results6.filter(r => r.ok).length;
    ui.add("V5-6c", "★★ 连续应用 **3 个**目标全部成功",
      appliedCount === 3 ? "PASS" : "FAIL",
      `成功 ${appliedCount}/3：${JSON.stringify(results6)}`);

    const stillArmed = await readPainter();
    ui.add("V5-6d", "★★ 连刷 3 次后**仍在** persistent 态（不自动退出）",
      stillArmed.bodyClass ? "PASS" : "FAIL",
      `bodyClass=${stillArmed.bodyClass} hint=${JSON.stringify(stillArmed.hint)}`);

    await ui.shot("v5-6-continuous");

    // ★ Esc 退出
    await ui.key("Escape", "Escape", 27);
    await ui.sleep(600);
    const afterEsc = await readPainter();
    ui.add("V5-6e", "★ Esc 退出 persistent 态",
      !afterEsc.bodyClass && !afterEsc.hint ? "PASS" : "FAIL",
      `bodyClass=${afterEsc.bodyClass} hint=${JSON.stringify(afterEsc.hint)}`);

    // ★ 对比：单击档只应用 1 次就自动退出
    const sel6b = await selectPmExact("粗体源");
    const pt6b = await pmPoint("粗体源");
    if (sel6b.ok && pt6b.ok) {
      await rightClickAt(pt6b.x, pt6b.y);
      const m6b = await ui.ev(MENU_ITEMS);
      if (m6b.open) {
        await clickMenuItem("^格式刷$");
        const a6b = await readPainter();
        ui.log("[V5-6] 单击档 arm = " + JSON.stringify(a6b));
        const pt6c = await pmPoint("普通文字段落甲");
        if (pt6c.ok) {
          await mouseClick(pt6c.x, pt6c.y);
          await ui.sleep(900);
          const after6b = await readPainter();
          ui.add("V5-6f", "★ 单击档对比：应用 1 次后**自动退出**（与连续档形成对比）",
            !after6b.bodyClass && !after6b.hint ? "PASS" : "FAIL",
            `bodyClass=${after6b.bodyClass}（连续档此时仍是 true）hint=${JSON.stringify(after6b.hint)}`);
        }
      }
    }

    // ★ 兼作"结束"：persistent 态下再点「连续刷」应收起
    const s6d = await selectPmExact("粗体源");
    const p6d = await pmPoint("粗体源");
    if (s6d.ok && p6d.ok) {
      await rightClickAt(p6d.x, p6d.y);
      const m6d = await ui.ev(MENU_ITEMS);
      if (m6d.open) {
        await clickMenuItem("连续刷"); // 第一次：进入 persistent
        const armedAgain = await readPainter();
        // 再开菜单点一次
        const s6e = await selectPmExact("粗体源");
        const p6e = await pmPoint("粗体源");
        if (s6e.ok && p6e.ok) {
          await rightClickAt(p6e.x, p6e.y);
          const m6e = await ui.ev(MENU_ITEMS);
          if (m6e.open) {
            await clickMenuItem("连续刷"); // 第二次：应 exit
            const afterToggle = await readPainter();
            ui.add("V5-6g", "★ persistent 态下再点「连续刷」→ 兼作「结束」（store.exit）",
              armedAgain.bodyClass && !afterToggle.bodyClass ? "PASS" : "FAIL",
              `第一次 arm=${armedAgain.bodyClass} → 第二次后=${afterToggle.bodyClass}（期望 true → false）`);
          }
        }
      }
    }
  } else if (!menu6.open) {
    ui.add("V5-6b", "V5-6 前置：阅读面右键菜单能打开", "FAIL",
      `菜单未打开。选区=${JSON.stringify(sel6)} 右键点=${JSON.stringify(pt6)}`);
  }

  /* ═══════════════════════════════════════════════════════════
   * V5-7：R3#3 语法栏 ghost 可见性（编辑面）
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-7：语法栏 ghost 可见性 ═══");
  await ui.command("view.edit");
  await ui.sleep(2000);
  await reloadDoc("v5-7.md", "# ghost\n\n\n\n结尾。\n");
  await ui.focusSource();
  await ui.sleep(400);

  const syntaxBar = await ui.ev(`
    const bar = document.querySelector(".syntax-helper");
    if (!bar) return { ok: false, reason: "no .syntax-helper" };
    const items = Array.from(bar.querySelectorAll(".syntax-helper-item"));
    return {
      ok: true, count: items.length,
      names: items.slice(0, 12).map(e => (e.querySelector(".syntax-helper-item-name") || e).textContent.trim().slice(0, 14)),
    };
  `);
  ui.log("[V5-7] 语法栏 = " + JSON.stringify(syntaxBar));
  ui.add("V5-7-0", "语法辅助栏存在（前置）", syntaxBar.ok ? "PASS" : "FAIL", JSON.stringify({ count: syntaxBar.count, names: syntaxBar.names }));

  if (syntaxBar.ok) {
    // 找「代码块」项（按 name 匹配）
    const codeItem = await ui.ev(`
      const bar = document.querySelector(".syntax-helper");
      const items = Array.from(bar.querySelectorAll(".syntax-helper-item"));
      const el = items.find(x => {
        const n = (x.querySelector(".syntax-helper-item-name") || x).textContent || "";
        return /代码块/.test(n);
      });
      if (!el) return { ok: false, all: items.map(i => ((i.querySelector(".syntax-helper-item-name")||i).textContent||"").trim().slice(0,14)) };
      const r = el.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
               name: ((el.querySelector(".syntax-helper-item-name")||el).textContent||"").trim() };
    `);
    ui.log("[V5-7] 代码块项 = " + JSON.stringify(codeItem));
    if (codeItem.ok) {
      // 先把光标放到空行
      const el7 = await ui.ev(`
        const lines = Array.from(document.querySelectorAll(".cm-line"));
        for (const l of lines) {
          if ((l.textContent || "").trim() === "") {
            const r = l.getBoundingClientRect();
            if (r.height > 0) return { ok: true, x: Math.round(r.left + 8), y: Math.round(r.top + r.height/2) };
          }
        }
        return { ok: false };
      `);
      if (el7.ok) { await mouseClick(el7.x, el7.y); await ui.sleep(300); }

      // 逐帧采样 ghost 可见性（真机合成层可能与浏览器不同）
      await ui.ev(`
        window.__GHOST = [];
        (function () {
          const t0 = performance.now();
          const tick = () => {
            const g = document.querySelector(".cm-source-ghost");
            const rec = { t: Math.round(performance.now() - t0) };
            if (g) {
              const r = g.getBoundingClientRect();
              const cs = getComputedStyle(g);
              rec.found = true;
              rec.w = Math.round(r.width); rec.h = Math.round(r.height);
              rec.text = (g.textContent || "").slice(0, 30);
              rec.display = cs.display; rec.visibility = cs.visibility; rec.opacity = cs.opacity;
              rec.inViewport = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
            } else rec.found = false;
            window.__GHOST.push(rec);
            if (performance.now() - t0 < 2200) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })();
        return true;
      `);
      await mouseClick(codeItem.x, codeItem.y);
      await ui.sleep(2400);
      const ghostTrace = await ui.ev(`return window.__GHOST || []`);
      const foundFrames = ghostTrace.filter(f => f.found).length;
      const visibleFrames = ghostTrace.filter(f => f.found && f.inViewport && f.display !== "none" && f.visibility !== "hidden" && Number(f.opacity) > 0).length;
      const sample = ghostTrace.find(f => f.found && f.inViewport) || null;
      ui.log(`[V5-7] ghost 轨迹：${ghostTrace.length} 帧，found=${foundFrames}，visible=${visibleFrames}`);
      ui.log("[V5-7] 样本 = " + JSON.stringify(sample));
      ui.add("V5-7a", "★ 点「代码块」后 ghost 元素出现在 DOM",
        foundFrames > 0 ? "PASS" : "FAIL",
        `${foundFrames}/${ghostTrace.length} 帧存在 .cm-source-ghost`);
      ui.add("V5-7b", "★★ ghost **可见**（真机合成层：有尺寸 + 在视口内 + 未隐藏）",
        visibleFrames > 0 ? "PASS" : "FAIL",
        `${visibleFrames}/${ghostTrace.length} 帧可见；样本=${JSON.stringify(sample)}`);
      await ui.shot("v5-7-ghost");
    } else {
      ui.add("V5-7a", "语法栏「代码块」项定位", "FAIL", JSON.stringify(codeItem));
    }
  }

  /* ═══════════════════════════════════════════════════════════
   * V5-8：（交叉项）预览开合无硬跳 —— 简版
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-8（交叉项）：预览开合无硬跳 ═══");
  /**
   * ⚠️ **必须用长文档**（第一版用 113 字符的 DOC → 判据恒真）。
   *
   * 实测过程：滚轮滚了 25×150=3750px，但 `scrollTop` 仍为 0 ——
   * 因为文档 `scrollHeight` 只有 1250，**根本没有可滚动空间**。
   * 于是"开合期间 maxJump=0"是必然结果，**证明不了任何东西**。
   *
   * 这与 R2 的教训同类：**判据恒真比判据错更危险**（它看起来像 PASS）。
   * 现在改用 ~60 段长文档，并**断言"确实可滚动"**（前置），
   * 否则该项标 KNOWN 而不是 PASS。
   */
  const LONG_DOC = ["# V5-8 长文档", ""];
  for (let i = 1; i <= 60; i++) {
    LONG_DOC.push(`第 ${i} 段：用于把文档撑长以便预览开合时真的有滚动量。Lorem ipsum dolor sit amet consectetur.`, "");
  }
  await reloadDoc("v5-8.md", LONG_DOC.join("\n"));
  await ui.sleep(900);

  const pvBefore = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    return sc ? { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight) } : { st: null };
  `);
  // 滚到中部
  await ui.focusSource();
  for (let i = 0; i < 25; i++) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 500, deltaX: 0, deltaY: 150, pointerType: "mouse" });
    await ui.sleep(20);
  }
  await ui.sleep(600);
  const pvMid = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    return sc ? { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight) } : { st: null };
  `);
  await ui.ev(`
    window.__PV = [];
    (function () {
      const t0 = performance.now();
      const tick = () => {
        const sc = document.querySelector(".cm-scroller");
        if (sc) window.__PV.push({ t: Math.round(performance.now() - t0), st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight) });
        if (performance.now() - t0 < 1800) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
    return true;
  `);
  await ui.command("view.togglePreview");
  await ui.sleep(2000);
  const pvTrace = await ui.ev(`return window.__PV || []`);
  const pvAfter = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    return sc ? { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight) } : { st: null };
  `);
  let maxJump = 0, shChanges = 0;
  for (let i = 1; i < pvTrace.length; i++) {
    const d = Math.abs(pvTrace[i].st - pvTrace[i - 1].st);
    if (d > maxJump) maxJump = d;
    if (pvTrace[i].sh !== pvTrace[i - 1].sh) shChanges++;
  }
  ui.log(`[V5-8] 滚到 ${JSON.stringify(pvMid)} → 开合后 ${JSON.stringify(pvAfter)}；${pvTrace.length} 帧 maxJump=${maxJump} sh跃变=${shChanges}`);

  // ★ 前置：必须真的可滚动，否则判据恒真（第一版踩过）
  const scrollable = (pvMid.st ?? 0) > 100;
  ui.add("V5-8-0", "★ 前置：文档确实可滚动且已滚到中部（防判据恒真）",
    scrollable ? "PASS" : "FAIL",
    `开合前 scrollTop=${pvMid.st}（需 >100 才有滚动量可测）；scrollHeight=${pvMid.sh}。` +
    `若为 0 说明文档太短滚不动 → 该项无法证明任何东西`);

  ui.add("V5-8a", "（交叉项）预览开合期间 scrollTop 单帧跳变 ≤ 300px",
    scrollable ? (maxJump <= 300 ? "PASS" : "FAIL") : "KNOWN",
    scrollable
      ? `maxJump=${maxJump}px；scrollHeight 跃变 ${shChanges} 次；` +
        `注：宽度变化必然引起 heightMap 重估（R3 已证明），此项只看不出现**量级异常**的硬跳`
      : `**判据恒真**：文档不可滚动（scrollTop=0），maxJump=0 无意义 → 标 KNOWN 而非 PASS`);

  /* ═══════════════════════════════════════════════════════════
   * V5-9（补测 1）：**阅读面 D1** —— 选普通文字点格式刷 → 不 arm + 提示
   *
   * R4 浏览器版测过（C3-a PASS），本轮补真机。阅读面没有工具栏，
   * 唯一入口是右键菜单（见 V5-6），所以必须先用真实右键唤出菜单。
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-9（补测 1）：阅读面 D1 空快照 ═══");
  await ui.command("view.preview");
  await ui.sleep(2000);
  await reloadDoc("v5-9.md", DOC);
  await ui.sleep(400);

  // 精确选中「普通文字段落甲」（PM 里无任何 mark）
  const selPlainPm = await ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror");
    if (!pm) return { ok: false, reason: "no main PM" };
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = w.currentNode.textContent || "";
      const i = t.indexOf("普通文字段落甲");
      if (i >= 0) {
        const rng = document.createRange();
        rng.setStart(w.currentNode, i);
        rng.setEnd(w.currentNode, i + 7);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(rng);
        pm.focus();
        document.dispatchEvent(new Event("selectionchange"));
        return { ok: true, got: s.toString() };
      }
    }
    return { ok: false, reason: "needle not found" };
  `);
  await ui.sleep(350);
  ui.log("[V5-9] 阅读面选区 = " + JSON.stringify(selPlainPm));

  // 前置：确认这段文字在 PM 里**确实没有 mark**（否则 D1 场景不成立）
  const plainMarks = await ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror");
    const dv = pm && pm.pmViewDesc;
    if (!dv || !dv.node) return null;
    let found = null;
    dv.node.forEach((n) => {
      if (found) return;
      if ((n.textContent || "").includes("普通文字段落甲")) {
        const marks = [];
        n.descendants((c) => { if (c.isText) c.marks.forEach(m => { if (!marks.includes(m.type.name)) marks.push(m.type.name); }); return true; });
        found = { type: n.type.name, marks };
      }
    });
    return found;
  `);
  ui.add("V5-9-0", "★ 前置：目标段落**确实没有任何 mark**（否则不是 D1 场景）",
    plainMarks && plainMarks.marks.length === 0 ? "PASS" : "FAIL",
    `段落=${JSON.stringify(plainMarks)}（marks 必须为空数组）`);

  const ptPlain = await pmPoint("普通文字段落甲");
  if (selPlainPm.ok && ptPlain.ok) {
    await rightClickAt(ptPlain.x, ptPlain.y);
    const menuPlain = await ui.ev(MENU_ITEMS);
    ui.log("[V5-9] 右键菜单 = " + JSON.stringify((menuPlain.items || []).map(i => i.label)));
    const bt9 = await readPainter();
    const clickRes = await clickMenuItem("^格式刷$");
    await ui.sleep(700);
    const at9 = await readPainter();
    const newToasts9 = at9.toasts.filter(t => !bt9.toasts.includes(t));
    ui.log("[V5-9] 点格式刷后 = " + JSON.stringify(at9));

    ui.add("V5-9a", "★★ 阅读面选普通文字 → **不进入**待刷态（阅读面 D1 主判据）",
      at9.bodyClass === false ? "PASS" : "FAIL",
      `bodyClass=${at9.bodyClass}（修复前 true）hint=${JSON.stringify(at9.hint)}；` +
      `菜单点击=${JSON.stringify(clickRes)}`);
    ui.add("V5-9b", "★ 且有明确提示（不是静默拒绝）",
      newToasts9.length > 0 || at9.toasts.length > 0 ? "PASS" : "FAIL",
      `新增 toasts=${JSON.stringify(newToasts9.slice(0, 2))}；全部=${JSON.stringify(at9.toasts.slice(0, 2))}`);
    ui.add("V5-9c", "阅读面 D1 提示文案与编辑面一致（说清为什么+该怎么做）",
      /没有可复制的格式|带格式|加粗|标题|列表/.test(JSON.stringify(at9.toasts)) ? "PASS" : "FAIL",
      JSON.stringify(at9.toasts.slice(0, 1)));
  } else {
    ui.add("V5-9a", "V5-9 前置（选区+右键点）", "FAIL",
      `sel=${JSON.stringify(selPlainPm)} pt=${JSON.stringify(ptPlain)}`);
  }

  await ui.shot("v5-9-reader-d1");

  /* ═══════════════════════════════════════════════════════════
   * V5-10（补测 2）：**块级格式刷真机复测** —— 采集 H2 → 目标行变 `## ...`
   *
   * 块级走 `applyPmBlockSnapshot`（PM 命令管线）/ `applyBlockTypeToLine`（源码前缀）。
   * R4 浏览器版测过（M4 PASS），本轮补真机。
   * ⚠️ 阅读面与编辑面都要测：两条实现路径不同（铁律：别用一面推断另一面）。
   * ═══════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("═══ V5-10（补测 2）：块级格式刷真机复测 ═══");

  /* ── V5-10A：编辑面（源码前缀路径 applyBlockTypeToLine）── */
  await ui.command("view.edit");
  await ui.sleep(2000);
  const BLOCK_DOC = "# 块级测试\n\n## 二级标题源\n\n普通目标行甲。\n\n普通目标行乙。\n";
  await reloadDoc("v5-10a.md", BLOCK_DOC);
  await ui.focusSource();
  await ui.sleep(500);

  // 采集源：精确选中含 `## ` 前缀的整行（块级采集看"首行行首前缀"）
  const selH2 = await ui.ev(`
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    for (const l of lines) {
      const t = l.textContent || "";
      if (t.indexOf("二级标题源") >= 0) {
        const r = l.getBoundingClientRect();
        const cw = r.width / Math.max(1, t.length);
        return { ok: true, x: Math.round(r.left + 6 * cw), y: Math.round(r.top + r.height / 2), idx: 0, line: t };
      }
    }
    return { ok: false };
  `);
  let h2SelOk = false;
  if (selH2.ok) {
    await mouseClick(selH2.x, selH2.y);
    await ui.sleep(250);
    await ui.key("Home", "Home", 36);
    await ui.sleep(120);
    // Shift+End 选中整行（块级采集只看首行前缀，整行选没问题）
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 8 });
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 8 });
    await ui.sleep(350);
    const cm = await readCm();
    const selTxt = cm.ok ? cm.text.slice(cm.sel.from, cm.sel.to) : null;
    h2SelOk = !!selTxt && selTxt.includes("二级标题源");
    ui.log("[V5-10A] 采集选区 = " + JSON.stringify(selTxt));
  }
  if (h2SelOk && painterBtn) {
    await mouseClick(painterBtn.x, painterBtn.y);
    await ui.sleep(700);
    const a10a = await readPainter();
    ui.add("V5-10A-1", "编辑面采集 H2 → 进入待刷态", a10a.bodyClass ? "PASS" : "FAIL",
      `bodyClass=${a10a.bodyClass} hint=${JSON.stringify(a10a.hint)}`);

    const t10a = await ui.ev(`
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      for (const l of lines) {
        if ((l.textContent || "").indexOf("普通目标行甲") >= 0) {
          const r = l.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2), line: l.textContent };
        }
      }
      return { ok: false };
    `);
    ui.log("[V5-10A] 目标行 = " + JSON.stringify(t10a));
    if (t10a.ok) {
      await mouseClick(t10a.x, t10a.y);
      await ui.sleep(1000);
      const cmA = await readCm();
      const lineA = cmA.ok ? (cmA.text.split("\n").find(l => l.includes("普通目标行甲")) || "") : "";
      ui.log("[V5-10A] 应用后行 = " + JSON.stringify(lineA));
      ui.add("V5-10A-2", "★★ 编辑面块级：目标行变 `## 普通目标行甲。`",
        /^##\s/.test(lineA.trim()) ? "PASS" : "FAIL",
        `实际=${JSON.stringify(lineA)}（期望以 "## " 开头）`);
    }
  } else {
    ui.add("V5-10A-1", "V5-10A 前置（H2 采集选区）", "FAIL", `h2SelOk=${h2SelOk} btn=${!!painterBtn}`);
  }

  /* ── V5-10B：阅读面（PM 命令管线 applyPmBlockSnapshot）── */
  ui.log("");
  ui.log("═══ V5-10B：阅读面块级 ═══");
  await ui.command("view.preview");
  await ui.sleep(2000);
  await reloadDoc("v5-10b.md", BLOCK_DOC);
  await ui.sleep(400);

  // 阅读面采集源：选中 H2 标题文字（PM 里是 heading 节点）
  const selH2pm = await ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror");
    if (!pm) return { ok: false, reason: "no main PM" };
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = w.currentNode.textContent || "";
      const i = t.indexOf("二级标题源");
      if (i >= 0) {
        const rng = document.createRange();
        rng.setStart(w.currentNode, i);
        rng.setEnd(w.currentNode, i + 5);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(rng);
        pm.focus();
        document.dispatchEvent(new Event("selectionchange"));
        return { ok: true, got: s.toString() };
      }
    }
    return { ok: false };
  `);
  await ui.sleep(350);
  ui.log("[V5-10B] 阅读面选区 = " + JSON.stringify(selH2pm));

  // 前置：确认这段在 PM 里是 heading level=2
  const h2Block = await ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror");
    const dv = pm && pm.pmViewDesc;
    if (!dv || !dv.node) return null;
    let found = null;
    dv.node.forEach((n) => {
      if (found) return;
      if ((n.textContent || "").includes("二级标题源")) found = { type: n.type.name, level: n.attrs.level ?? null };
    });
    return found;
  `);
  ui.add("V5-10B-0", "★ 前置：采集源在 PM 里确实是 heading(level=2)",
    h2Block && h2Block.type === "heading" && h2Block.level === 2 ? "PASS" : "FAIL",
    JSON.stringify(h2Block));

  const ptH2 = await pmPoint("二级标题源");
  if (selH2pm.ok && ptH2.ok) {
    await rightClickAt(ptH2.x, ptH2.y);
    const m10b = await ui.ev(MENU_ITEMS);
    if (m10b.open) {
      await clickMenuItem("^格式刷$");
      const a10b = await readPainter();
      ui.add("V5-10B-1", "阅读面采集 H2 → 进入待刷态", a10b.bodyClass ? "PASS" : "FAIL",
        `bodyClass=${a10b.bodyClass} hint=${JSON.stringify(a10b.hint)}`);

      const ptTgt = await pmPoint("普通目标行乙");
      if (ptTgt.ok) {
        await mouseClick(ptTgt.x, ptTgt.y);
        await ui.sleep(1100);
        const pmAfter = await readPm();
        const blk = (pmAfter.blocks || []).find(b => (b.text || "").includes("普通目标行乙"));
        ui.log("[V5-10B] 目标块 = " + JSON.stringify(blk));
        ui.add("V5-10B-2", "★★ 阅读面块级：目标段落变 heading(level=2)",
          blk && blk.type === "heading" && blk.level === 2 ? "PASS" : "FAIL",
          `目标块=${JSON.stringify(blk)}（期望 type="heading" level=2）`);
      }
    } else {
      ui.add("V5-10B-1", "V5-10B 前置（右键菜单）", "FAIL", JSON.stringify(m10b));
    }
  } else {
    ui.add("V5-10B-1", "V5-10B 前置（选区+右键点）", "FAIL",
      `sel=${JSON.stringify(selH2pm)} pt=${JSON.stringify(ptH2)}`);
  }

  await ui.shot("v5-10-block");
});
