/**
 * v0.17.0 第四轮 · T5 · 第 7 项：格式刷 **10 行矩阵**端到端取证
 *
 * ## 仪器三条铁律（每条都是本项目踩过的坑）
 * 1. **绝不裸用 `.ProseMirror`**：分屏时右侧预览面也是 `.ProseMirror`（实测**文本长度 0**），
 *    裸 `querySelector` 会命中它 → 读到空文档 → 得出"格式刷没生效"的**假结论**。
 *    一律 `.editor-container .ProseMirror` 限定。
 * 2. **PM state 拿法**：`pmViewDesc` **没有** `view`（实测 keys 只有 parent/children/
 *    dom/contentDOM/dirty/node/outerDeco/innerDeco/nodeDOM），但**有 `node`** → 用 `node` 读结构；
 *    另用 DOM（`<strong>/<em>/<s>/<code>`）做**双向交叉验证**。
 * 3. **CM6 必须走 `state.doc`**：虚拟化渲染，拼 `.cm-line` 只拿到视口内几行。
 *
 * ## 入口矩阵（实测，不是猜）
 * - **阅读面**：工具栏**不渲染**（`EditorContainer.tsx:1704` 是 `isSourceMode && isMdFile`）
 *   → 唯一入口是**右键菜单**（`PmContextMenu.buildPmMenuItems`，需有文本选区）
 * - **编辑面**：工具栏「格式刷」按钮 + 右键菜单
 *
 * ## 用法
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t5" node scripts/v0170-r4-painter-matrix.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = [
  "# 格式刷测试文档",
  "",
  "源一：**粗体源** 供采集。",
  "",
  "源二：*斜体源* 供采集。",
  "",
  "源三：**粗体加斜体源** 供采集。",
  "",
  "源四：~~删除线源~~ 供采集。",
  "",
  "源五：`行内代码源` 供采集。",
  "",
  "## 标题二级源",
  "",
  "目标甲：这是一段纯文本没有任何格式。",
  "",
  "目标乙：另一段纯文本目标。",
  "",
  "目标丙：第三段纯文本目标。",
  "",
  "目标丁：第四段纯文本目标。",
  "",
  "结尾撑高段落。".repeat(6),
  "",
].join("\n");

/* ══════════ 页面内读取器 ══════════ */

const PM_STATE = `
  const pm = document.querySelector(".editor-container .ProseMirror");
  if (!pm) return { ok: false, reason: "no main PM (must scope .editor-container)" };
  const dv = pm.pmViewDesc;
  const out = { ok: true, blocks: [], dom: {} };
  if (dv && dv.node) {
    dv.node.forEach((n) => {
      const marks = [];
      n.descendants((c) => { if (c.isText) c.marks.forEach(m => { if (!marks.includes(m.type.name)) marks.push(m.type.name); }); return true; });
      out.blocks.push({ type: n.type.name, level: n.attrs.level ?? null, marks, text: n.textContent.slice(0, 60) });
    });
    out.docLen = dv.node.content.size;
  }
  out.dom = {
    strong: pm.querySelectorAll("strong").length,
    em: pm.querySelectorAll("em").length,
    del: pm.querySelectorAll("s,del").length,
    code: pm.querySelectorAll("code").length,
    h1: pm.querySelectorAll("h1").length,
    h2: pm.querySelectorAll("h2").length,
    h3: pm.querySelectorAll("h3").length,
    blockquote: pm.querySelectorAll("blockquote").length,
    li: pm.querySelectorAll("li").length,
  };
  return out;
`;

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

/**
 * 格式刷状态。
 *
 * ⚠️ 第一版 hint 选择器写成"任何以『格式刷』开头的叶子节点"→ **误抓到了文档标题
 * 「# 格式刷测试文档」**（它的 textContent 也以"格式刷"开头），
 * 导致 M1-d「应用后自动退出」恒 FAIL（因为标题一直在）。
 * 修正：只在**状态栏容器**内找，且必须含提示语特征（"单击目标"/"持续应用"）。
 */
const PAINTER = `
  const bodyClass = document.body.classList.contains("format-painter-armed");
  let hint = null;
  // 状态栏：优先用已知容器；找不到就退化为"含格式刷提示特征词"的叶子
  const scope = document.querySelector(".statusbar, .status-bar, footer") || document.body;
  for (const e of scope.querySelectorAll("span,div,button")) {
    const t = (e.textContent || "").trim();
    if (/格式刷/.test(t) && /(单击目标|持续应用|剩余)/.test(t) && e.children.length === 0) {
      hint = t.slice(0, 80);
      break;
    }
  }
  return { bodyClass, hint };
`;

/** 在 PM 中选中文本（DOM Range + selectionchange 事件让 PM 同步） */
const SELECT_PM = (needle) => `
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
  return { ok: false, reason: "needle not found: " + ${JSON.stringify(needle)} };
`;

/** 找 PM 中某段文字的屏幕坐标（用于右键/点击） */
const PM_POINT = (needle) => `
  const pm = document.querySelector(".editor-container .ProseMirror");
  if (!pm) return { ok: false };
  const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const t = w.currentNode.textContent || "";
    const i = t.indexOf(${JSON.stringify(needle)});
    if (i >= 0) {
      const rng = document.createRange();
      rng.setStart(w.currentNode, i);
      rng.setEnd(w.currentNode, i + Math.min(2, t.length - i));
      const r = rng.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2) };
    }
  }
  return { ok: false, reason: "needle not found" };
`;

/** CM6 中某段文字的屏幕坐标 */
const CM_POINT = (needle) => `
  for (const l of document.querySelectorAll(".cm-line")) {
    const t = l.textContent || "";
    const i = t.indexOf(${JSON.stringify(needle)});
    if (i >= 0) {
      const r = l.getBoundingClientRect();
      const cw = r.width / Math.max(1, t.length);
      return { ok: true, x: Math.round(r.left + (i + ${JSON.stringify(needle)}.length / 2) * cw),
               y: Math.round(r.top + r.height / 2), line: t.slice(0, 50) };
    }
  }
  return { ok: false, reason: "needle not in viewport: " + ${JSON.stringify(needle)} };
`;

await runBrowserProbe({ name: "v0170-r4-painter-matrix", doc: DOC }, async (ui) => {
  const readPm = () => ui.ev(PM_STATE);
  const readCm = () => ui.ev(CM_TEXT);
  const readPainter = () => ui.ev(PAINTER);

  /** 右键菜单：返回菜单项列表 */
  const menuItems = () => ui.ev(`
    const menus = Array.from(document.querySelectorAll(".editor-context-menu"));
    const open = menus.filter(m => m.offsetParent !== null || m.getBoundingClientRect().width > 0);
    if (!open.length) return { open: false };
    const m = open[open.length - 1];
    return { open: true, items: Array.from(m.querySelectorAll(".context-menu-item"))
      .map((el, i) => ({ i, label: (el.textContent || "").trim().slice(0, 30),
                         disabled: el.classList.contains("disabled") })) };
  `);

  /** 点右键菜单里某个 label 包含 needle 的项 */
  const clickMenuItem = (needle) => ui.ev(`
    const menus = Array.from(document.querySelectorAll(".editor-context-menu"))
      .filter(m => m.getBoundingClientRect().width > 0);
    if (!menus.length) return { ok: false, reason: "no open menu" };
    const m = menus[menus.length - 1];
    const el = Array.from(m.querySelectorAll(".context-menu-item"))
      .find(x => (x.textContent || "").includes(${JSON.stringify(needle)}));
    if (!el) return { ok: false, reason: "item not found: " + ${JSON.stringify(needle)} };
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);

  const rightClick = async (x, y) => {
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
    await ui.sleep(400);
  };

  ui.log("[setup] impl = " + ui.impl);

  /* ══════ F 组：两面归属（Lead 点名的高风险点）══════ */
  await ui.command("view.edit");
  await ui.sleep(2200);
  const fEdit = await ui.ev(`
    const pms = Array.from(document.querySelectorAll(".ProseMirror"));
    return {
      active: (document.activeElement ? String(document.activeElement.className || "").slice(0,50) : "none"),
      splitPmCount: pms.filter(p => p.closest(".split-preview-shell")).length,
      mainPmCount: pms.filter(p => p.closest(".editor-container")).length,
      hasCm: !!document.querySelector(".cm-content"),
      splitPmTextLen: (() => { const p = pms.find(x => x.closest(".split-preview-shell")); return p ? (p.textContent||"").length : null; })(),
      toolbarVisible: !!document.querySelector(".source-format-toolbar"),
    };
  `);
  ui.log("[F-edit] " + JSON.stringify(fEdit));
  ui.add("F1", "编辑模式有 CM6 源码面", fEdit.hasCm ? "PASS" : "FAIL", JSON.stringify(fEdit));
  ui.add("F2", "★ 分屏右侧预览面也是 .ProseMirror 且文本为空（裸选择器必误命中）",
    fEdit.splitPmCount > 0 ? "PASS" : "KNOWN",
    `主=${fEdit.mainPmCount} 分割=${fEdit.splitPmCount}，分割面文本长度=${fEdit.splitPmTextLen}`);

  await ui.command("view.preview");
  await ui.sleep(1900);
  const fPv = await ui.ev(`
    const pms = Array.from(document.querySelectorAll(".ProseMirror"));
    return { mainPmCount: pms.filter(p => p.closest(".editor-container")).length,
             splitPmCount: pms.filter(p => p.closest(".split-preview-shell")).length,
             toolbarVisible: !!document.querySelector(".source-format-toolbar") };
  `);
  ui.log("[F-preview] " + JSON.stringify(fPv));
  ui.add("F3", "★ 阅读面**没有**格式刷工具栏（入口只有右键菜单）",
    fPv.toolbarVisible === false ? "PASS" : "FAIL",
    `toolbarVisible=${fPv.toolbarVisible}（EditorContainer.tsx:1704 条件 isSourceMode && isMdFile）`);
  const pmBase = await readPm();
  ui.add("F4", "阅读面 PM 结构可读（仪器自检）",
    pmBase.ok && pmBase.blocks.length > 5 ? "PASS" : "FAIL",
    pmBase.ok ? `块数=${pmBase.blocks.length} DOM strong=${pmBase.dom.strong} em=${pmBase.dom.em}` : JSON.stringify(pmBase));

  /* ══════ 矩阵 M1：阅读面 单击采集 → 单击应用 → 自动退出 ══════ */
  ui.log("");
  ui.log("═══ M1：阅读面 单击采集→单击应用→自动退出 ═══");
  const m1sel = await ui.ev(SELECT_PM("粗体源"));
  ui.log("[M1] 选中采集源 = " + JSON.stringify(m1sel));
  if (m1sel.ok) {
    const pt = await ui.ev(PM_POINT("粗体源"));
    await rightClick(pt.x, pt.y);
    const menu = await menuItems();
    ui.log("[M1] 右键菜单 = " + JSON.stringify(menu));
    ui.add("M1-a", "阅读面右键菜单打开且含「格式刷」项",
      menu.open && menu.items.some(i => i.label.includes("格式刷")) ? "PASS" : "FAIL",
      JSON.stringify(menu.items?.map(i => i.label)));
    if (menu.open && menu.items.some(i => i.label.includes("格式刷"))) {
      // 选中的是"粗体源"，PM 采集需要 PM 自己的 selection；DOM Range 不一定同步到 PM state
      const mi = await clickMenuItem("格式刷");
      if (mi.ok) {
        await ui.click(mi.x, mi.y);
        await ui.sleep(600);
        const armed = await readPainter();
        ui.log("[M1] arm 后 = " + JSON.stringify(armed));
        ui.add("M1-b", "★ 阅读面单击格式刷 → 进入待刷态",
          armed.bodyClass || armed.hint ? "PASS" : "FAIL",
          `bodyClass=${armed.bodyClass} hint=${JSON.stringify(armed.hint)}`);

        // 应用目标：点"目标甲"
        const tp = await ui.ev(PM_POINT("目标甲"));
        ui.log("[M1] 应用目标 = " + JSON.stringify(tp));
        if (tp.ok) {
          await ui.click(tp.x, tp.y);
          await ui.sleep(800);
          const after = await readPm();
          const afterP = await readPainter();
          const tgtBlock = after.blocks.find(b => (b.text || "").includes("目标甲"));
          ui.log("[M1] 目标块 = " + JSON.stringify(tgtBlock));
          ui.add("M1-c", "★ 阅读面【应用粗体到目标甲】",
            tgtBlock && tgtBlock.marks.includes("strong") ? "PASS" : "FAIL",
            `目标甲 marks=${JSON.stringify(tgtBlock?.marks)}；DOM strong ${pmBase.dom.strong}→${after.dom.strong}`);
          ui.add("M1-d", "★ 单击应用后自动退出待刷态",
            !afterP.bodyClass && !afterP.hint ? "PASS" : "FAIL",
            `bodyClass=${afterP.bodyClass} hint=${JSON.stringify(afterP.hint)}`);
        }
      }
    }
  }

  await ui.shot("matrix-m1");

  /* ══════ 矩阵 M2：编辑面（CM6）单击采集 → 单击应用 → 自动退出 ══════ */
  ui.log("");
  ui.log("═══ M2：编辑面 CM6 单击采集→单击应用→自动退出 ═══");
  await ui.command("view.edit");
  await ui.sleep(2200);

  const cmBase = await readCm();
  ui.add("M2-0", "编辑面 CM6 全文可读（仪器自检）",
    cmBase.ok ? "PASS" : "FAIL", cmBase.ok ? `len=${cmBase.text.length}` : JSON.stringify(cmBase));

  // 选中 CM6 中的 "粗体源"：用真实鼠标拖选（最贴近用户）
  const srcPt = await ui.ev(CM_POINT("粗体源"));
  ui.log("[M2] 采集源坐标 = " + JSON.stringify(srcPt));
  if (srcPt.ok) {
    // 先滚到该行可见（已可见才能拿到坐标）；用双击选中"粗体源"这个词
    await ui.click(srcPt.x, srcPt.y);
    await ui.sleep(200);
    // 用 shift+点击 或用键盘选中：更稳的是 Home 后 shift+Right ×N
    // 简化：双击选中词（CM6 支持 double-click 选词）
    /**
     * ⚠️ 第一版用 double-click 选词 —— 实测选中的是 "供采集"（点偏了）
     * 而 "供采集" **没有**任何格式 → 采集到空快照 → 应用必然无变化，
     * 会被误读成"格式刷坏了"。必须精确选中 `**粗体源**`（含语法符号的整段）。
     *
     * 改用**键盘选区**：点进该行 → Home → Shift+End（选中整行含语法符号）。
     * 用户真实操作里"选中带格式的整段"也正是这样做的。
     */
    /**
     * ⚠️⚠️ 这里踩过一个**会导致误判产品缺陷**的坑，务必记住：
     *
     * `collectSourceSnapshot(text, start, end)` 的语义是
     * 「**选中文本本身就是** `**abc**` 这种含符号形态」——
     * 它靠 `body.startsWith("**") && body.endsWith("**")` 判 mark。
     *
     * 第一版我 `Home` + `Shift+End` 选了**整行** `源一：**粗体源** 供采集。`，
     * 首字符是"源"、尾字符是"。" → 剥离失败 → `marks=[]` →
     * 应用时 `next === text` → 返回 false → **看起来"格式刷完全坏了"**。
     * 实测确认：精确选中 `**粗体源**`（from=14,to=21）后，
     * 编辑面刷出 `**目标乙：另一段纯文本目标。**`，功能**完全正常**。
     *
     * 结论：这是**产品对用户操作的要求**（要选含格式符的那段），不是缺陷；
     * 但**探针必须按产品语义操作**，否则会把"我没选对"记成"产品坏了"。
     */
    await ui.click(srcPt.x, srcPt.y);
    await ui.sleep(250);
    await ui.key("Home", "Home", 36);
    await ui.sleep(120);
    // 越过 `源一：`（3 个字符）到第一个 `*`
    for (let i = 0; i < 3; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(30); }
    // Shift+ArrowRight × 7 覆盖 `**粗体源**`
    for (let i = 0; i < 7; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(40);
    }
    await ui.sleep(400);
    const selNow = await readCm();
    ui.log("[M2] 双击后选区 = " + JSON.stringify(selNow.sel) + " 选中文本=" +
      JSON.stringify(selNow.text.slice(selNow.sel.from, selNow.sel.to)));

    // 点工具栏"格式刷"按钮
    const fbtn = await ui.ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
        .find(x => (x.getAttribute("title") || "").includes("格式刷"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width };
    `);
    ui.add("M2-a", "编辑面工具栏有「格式刷」按钮", fbtn && fbtn.w > 0 ? "PASS" : "FAIL", JSON.stringify(fbtn));
    if (fbtn) {
      const beforeArm = await readCm();
      await ui.click(fbtn.x, fbtn.y);
      await ui.sleep(600);
      const armed = await readPainter();
      ui.log("[M2] 单击格式刷后 = " + JSON.stringify(armed));
      ui.add("M2-b", "★ 编辑面单击格式刷 → 进入待刷态",
        armed.bodyClass || armed.hint ? "PASS" : "FAIL",
        `bodyClass=${armed.bodyClass} hint=${JSON.stringify(armed.hint)}`);

      // 点"目标乙"行应用
      const tp2 = await ui.ev(CM_POINT("目标乙"));
      ui.log("[M2] 应用目标 = " + JSON.stringify(tp2));
      if (tp2.ok) {
        const beforeApply = await readCm();
        await ui.click(tp2.x, tp2.y);
        await ui.sleep(900);
        const afterApply = await readCm();
        const changed = beforeApply.text !== afterApply.text;
        ui.log("[M2] 应用后文本变化 = " + changed);
        ui.log("  前: " + JSON.stringify(beforeApply.text.split("\n").find(l => l.includes("目标乙"))));
        ui.log("  后: " + JSON.stringify(afterApply.text.split("\n").find(l => l.includes("目标乙"))));
        ui.add("M2-c", "★ 编辑面【单击采集→单击应用】源码文本被改写",
          changed ? "PASS" : "FAIL",
          `目标乙行: ${JSON.stringify((beforeApply.text.split("\n").find(l=>l.includes("目标乙"))||"").slice(0,50))} → ` +
          `${JSON.stringify((afterApply.text.split("\n").find(l=>l.includes("目标乙"))||"").slice(0,50))}`);
        const afterP = await readPainter();
        ui.add("M2-d", "★ 编辑面单击应用后自动退出待刷态",
          !afterP.bodyClass && !afterP.hint ? "PASS" : "FAIL",
          `bodyClass=${afterP.bodyClass} hint=${JSON.stringify(afterP.hint)}`);
      }
    }
  }

  await ui.shot("matrix-m2");

  /* ══════ 通用工具：在 CM6 里精确选中某段（含符号形态）══════ */
  /**
   * 选中 CM6 中 `needle` 的精确文本（不选整行）。
   * ⚠️ 必须精确 —— `collectSourceSnapshot` 靠首尾符号判 mark（见 M2 的注释）。
   */
  async function selectCmExact(needle) {
    const pt = await ui.ev(CM_POINT(needle));
    if (!pt.ok) return null;
    await ui.click(pt.x, pt.y);
    await ui.sleep(220);
    // 用 Ctrl+A 不行；改用 Home + 右移到 needle 起点 + Shift 右移 len
    await ui.key("Home", "Home", 36);
    await ui.sleep(100);
    const lineInfo = await ui.ev(`
      for (const l of document.querySelectorAll(".cm-line")) {
        const t = l.textContent || "";
        const i = t.indexOf(${JSON.stringify(needle)});
        if (i >= 0) return { i, len: ${JSON.stringify(needle)}.length, line: t.slice(0, 60) };
      }
      return null;
    `);
    if (!lineInfo) return null;
    for (let i = 0; i < lineInfo.i; i++) { await ui.key("ArrowRight", "ArrowRight", 39); await ui.sleep(12); }
    await ui.sleep(80);
    for (let i = 0; i < lineInfo.len; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 8 });
      await ui.sleep(14);
    }
    await ui.sleep(300);
    const cm = await readCm();
    return { ok: true, sel: cm.sel, text: cm.text.slice(cm.sel.from, cm.sel.to), lineInfo };
  }

  /** 点工具栏格式刷（persistent=true 用双击） */
  async function clickPainter(btnEl, persistent) {
    if (!btnEl) return false;
    const detail = persistent ? 2 : 1;
    // 双击需要真实 clickCount=2
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btnEl.x, y: btnEl.y, button: "left", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btnEl.x, y: btnEl.y, button: "left", clickCount: 1 });
    if (persistent) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btnEl.x, y: btnEl.y, button: "left", clickCount: 2 });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btnEl.x, y: btnEl.y, button: "left", clickCount: 2 });
    }
    await ui.sleep(600);
    return true;
  }

  const getPainterBtn = () => ui.ev(`
    const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
      .find(x => (x.getAttribute("title") || "").includes("格式刷"));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width };
  `);

  const clickCmLine = async (needle) => {
    const p = await ui.ev(CM_POINT(needle));
    if (!p.ok) return false;
    await ui.click(p.x, p.y);
    await ui.sleep(700);
    return true;
  };

  /* ══════ M3：编辑面 双击 → 连续应用 N 次 → 手动退出 ══════ */
  ui.log("");
  ui.log("═══ M3：编辑面 双击持续刷 ═══");
  await ui.command("view.edit");
  await ui.sleep(1800);
  // 重置文档（重新装入，避免前面测试污染）
  await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
    path: "probe-m3.md", name: "probe-m3.md", content: ${JSON.stringify(DOC)} } })); return true;`);
  await ui.sleep(1500);

  const pbtn3 = await getPainterBtn();
  const sel3 = await selectCmExact("**粗体源**");
  ui.log("[M3] 采集选区 = " + JSON.stringify(sel3 && { sel: sel3.sel, text: sel3.text }));

  if (sel3 && sel3.text === "**粗体源**" && pbtn3) {
    await clickPainter(pbtn3, true); // 双击 = persistent
    const armed3 = await readPainter();
    ui.log("[M3] 双击后 = " + JSON.stringify(armed3));
    ui.add("M3-a", "★ 编辑面双击格式刷 → 进入持续模式（提示含「持续」/「剩余」）",
      armed3.bodyClass && /持续|剩余/.test(armed3.hint || "") ? "PASS" : "FAIL",
      `bodyClass=${armed3.bodyClass} hint=${JSON.stringify(armed3.hint)}`);

    // 连续刷 3 个目标
    const targets = ["目标甲", "目标乙", "目标丙"];
    const results = [];
    for (const tname of targets) {
      const ok = await clickCmLine(tname);
      if (!ok) { results.push({ tname, ok: false }); continue; }
      const cm = await readCm();
      const line = cm.text.split("\n").find(l => l.includes(tname)) || "";
      results.push({ tname, ok: true, line: line.slice(0, 50), wrapped: line.trim().startsWith("**") && line.trim().endsWith("**") });
    }
    ui.log("[M3] 连续应用 = " + JSON.stringify(results));
    const allWrapped = results.filter(r => r.ok).every(r => r.wrapped);
    ui.add("M3-b", "★ 双击后连续应用 3 次都生效",
      results.filter(r => r.ok).length === 3 && allWrapped ? "PASS" : "FAIL",
      JSON.stringify(results));

    const stillArmed = await readPainter();
    ui.add("M3-c", "★ 连续应用后仍在持续模式（未自动退出）",
      stillArmed.bodyClass ? "PASS" : "FAIL",
      `bodyClass=${stillArmed.bodyClass} hint=${JSON.stringify(stillArmed.hint)}`);

    // 手动退出：再次双击按钮
    await clickPainter(await getPainterBtn(), true);
    const exited = await readPainter();
    ui.add("M3-d", "★ 再次双击 → 退出持续模式",
      !exited.bodyClass && !exited.hint ? "PASS" : "FAIL",
      `bodyClass=${exited.bodyClass} hint=${JSON.stringify(exited.hint)}`);
  } else {
    ui.add("M3-a", "编辑面双击持续刷（前置：精确选中含格式符的源）", "FAIL",
      `sel3=${JSON.stringify(sel3 && sel3.text)} btn=${!!pbtn3}`);
  }

  await ui.shot("matrix-m3");

  /* ══════ M4：块级格式（H2）编辑面 ══════ */
  ui.log("");
  ui.log("═══ M4：编辑面 块级格式（H2 标题）═══");
  await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
    path: "probe-m4.md", name: "probe-m4.md", content: ${JSON.stringify(DOC)} } })); return true;`);
  await ui.sleep(1500);

  const sel4 = await selectCmExact("## 标题二级源");
  ui.log("[M4] 采集选区 = " + JSON.stringify(sel4 && { sel: sel4.sel, text: sel4.text }));
  const pbtn4 = await getPainterBtn();
  if (sel4 && pbtn4) {
    await clickPainter(pbtn4, false);
    const a4 = await readPainter();
    ui.log("[M4] arm = " + JSON.stringify(a4));
    const ok4 = await clickCmLine("目标丁");
    if (ok4) {
      const cm4 = await readCm();
      const line4 = cm4.text.split("\n").find(l => l.includes("目标丁")) || "";
      ui.log("[M4] 目标丁行 = " + JSON.stringify(line4));
      ui.add("M4-a", "★ 编辑面【块级采集 H2 → 刷成 H2】",
        /^#{1,6}\s/.test(line4.trim()) ? "PASS" : "FAIL",
        `目标丁行: ${JSON.stringify(line4.slice(0, 50))}`);
    }
  } else {
    ui.add("M4-a", "编辑面块级格式刷（前置）", "FAIL", `sel=${JSON.stringify(sel4 && sel4.text)} btn=${!!pbtn4}`);
  }

  await ui.shot("matrix-m4");
});
