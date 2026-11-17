/**
 * Lead · 问题2 + 问题3 端到端探针（真实构建产物 / 浏览器）
 *
 * ## 问题2（用户原话）
 * > 「当前对没有格式的文本使用格式刷会提示：'所选内容没有可复制的格式…'，
 * >  但有种情形是，我希望将没格式的文本应用到有格式的文本，是有格式文本变没格式。
 * >  所以基于这个场景，对没格式文本进行格式刷应该是要生效的。」
 *
 * 判据：
 *  - P2-1 选中**无格式纯文本**点格式刷 → **不得**出现 emptySelection 提示，
 *         且必须进入 armed 态（状态栏有"格式刷"提示 / body 有 format-painter-armed）；
 *  - P2-2 把它刷到**有格式**目标 → 目标格式被清除（`**x**` → `x`）；
 *  - P2-3 阅读面同样成立（PM mark 被 remove）。
 *
 * ## 问题3（用户原话）
 * > 「格式刷要支持对选中的文本进行应用，而不是整个段落去应用，
 * >  例如加粗、下划线这些格式。」
 *
 * 判据：
 *  - P3-1 源码面：选中**行内一段** → 刷粗体 → 只有那段被 `**` 包裹，整行其余部分不变；
 *  - P3-2 源码面：`## 标题正文部分` 选中"正文"刷粗体 → 前缀 `## ` 保留、只包"正文"；
 *  - P3-3 阅读面：选中一段纯文本刷粗体 → 只有该段变粗体（不是整段）；
 *  - P3-4 无选区（仅光标）→ 仍是旧语义「整行/整段」（防回归）。
 *
 * 用法：
 *   $env:BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-lead-fix"
 *   node scripts/_lead-i23-painter.mjs
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

/** 夹具：一段无格式文字 + 一段粗体 + 一个标题 */
const DOC = [
  "# PAINT 夹具",
  "",
  "普通无格式目标段落 ALPHA 位于此处。",
  "",
  "**已加粗目标** BETA 在第二段。",
  "",
  "## 标题前缀 正文部分 GAMMA。",
  "",
  "第四段纯文本 DELTA 供选区级测试使用。",
  "",
].join("\n");

/** 读源码面全文（走 state.doc，CM6 虚拟化下唯一可靠） */
const READ_SRC = `
  const c = document.querySelector(".cm-content");
  try {
    const v = c && c.cmTile && c.cmTile.view;
    if (v && v.state && v.state.doc) return v.state.doc.toString();
  } catch {}
  const cm = document.querySelector(".cm-editor");
  if (cm) return Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n");
  const ta = document.querySelector("textarea.source-editor");
  return ta ? ta.value : null;
`;

/** 格式刷状态：armed body class + 状态栏提示 + toast 文案 */
const PAINTER = `
  const bodyClass = document.body.classList.contains("format-painter-armed");
  let hint = null;
  for (const e of document.body.querySelectorAll("span,div,button")) {
    const t = (e.textContent || "").trim();
    if (/格式刷/.test(t) && /(单击目标|持续应用|剩余|选区格式)/.test(t) && e.children.length === 0) {
      hint = t.slice(0, 90);
      break;
    }
  }
  const toasts = Array.from(document.querySelectorAll(
    ".notification,.toast,[class*='notification'],[class*='toast'],[role='alert']"
  )).map(e => (e.textContent || "").trim().slice(0, 140)).filter(Boolean);
  return { bodyClass, hint, toasts };
`;

/** 在 CM6 里精确选中 needle（按 state.doc 偏移，然后 dispatch 选区） */
const selectSrcExact = (needle) => `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return { ok: false, why: "no-cm6-view" };
  const text = v.state.doc.toString();
  const i = text.indexOf(${JSON.stringify(needle)});
  if (i < 0) return { ok: false, why: "needle-not-found", len: text.length };
  v.focus();
  v.dispatch({ selection: { anchor: i, head: i + ${JSON.stringify(needle)}.length }, scrollIntoView: true });
  return { ok: true, from: i, to: i + ${JSON.stringify(needle)}.length, text };
`;

/** 在 CM6 里把光标放到 needle 中间（只光标，不选区） */
const caretSrcAt = (needle) => `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return { ok: false, why: "no-cm6-view" };
  const text = v.state.doc.toString();
  const i = text.indexOf(${JSON.stringify(needle)});
  if (i < 0) return { ok: false, why: "needle-not-found" };
  const p = i + Math.floor(${JSON.stringify(needle)}.length / 2);
  v.focus();
  v.dispatch({ selection: { anchor: p, head: p }, scrollIntoView: true });
  return { ok: true, pos: p };
`;

/** 取当前 CM6 选区 */
const SRC_SEL = `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return null;
  const m = v.state.selection.main;
  return { from: Math.min(m.from, m.to), to: Math.max(m.from, m.to) };
`;

/** 点格式栏的「格式刷」按钮（isBrushIcon 那枚） */
const CLICK_PAINTER_BTN = `
  const btns = Array.from(document.querySelectorAll("button"));
  for (const b of btns) {
    const title = (b.getAttribute("title") || "") + "|" + (b.getAttribute("aria-label") || "");
    if (/格式刷/.test(title)) { b.click(); return { ok: true, title: title.slice(0, 40) }; }
    if (b.querySelector("svg") && b.closest(".format-bar, .format-toolbar, .format-buttons")) {
      // 刷子按钮无文本，退化为按 data-action
      if (b.getAttribute("data-action") === "formatPainter") { b.click(); return { ok: true, byAction: true }; }
    }
  }
  return { ok: false, why: "no-painter-button", count: btns.length };
`;

/**
 * 取 needle 在屏幕上的坐标（供**真实 CDP 鼠标事件**用）。
 *
 * ## 为什么必须用真实 CDP 鼠标（v0.17.2 探针教训）
 * 合成 `el.dispatchEvent(new MouseEvent("click"))` **不会让 CM6 移动光标**：
 * 实测埋点 `selStart=22 selEnd=27`（还是源选区），于是应用落到"源自己"上。
 * `Input.dispatchMouseEvent` 走浏览器真实输入路径 → CM6 的 mousedown/selection
 * 逻辑正常执行 → 光标真的落到目标处。这才是用户实际发生的动作。
 */
const coordsOf = (needle) => `
  const c = document.querySelector(".cm-content");
  const v = c && c.cmTile && c.cmTile.view;
  if (!v) return { ok: false, why: "no-cm6-view" };
  const t = v.state.doc.toString();
  const i = t.indexOf(${JSON.stringify(needle)});
  if (i < 0) return { ok: false, why: "needle-not-found" };
  const coords = v.coordsAtPos(Math.min(i + 1, v.state.doc.length));
  if (!coords) return { ok: false, why: "no-coords" };
  return { ok: true, x: coords.left + 2, y: (coords.top + coords.bottom) / 2 };
`;

/** 真实鼠标单击（CDP）：mousedown → mouseup，浏览器会自己派发 click */
async function realClick(ui, x, y) {
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(40);
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(80);
}

await runBrowserProbe({ name: "lead-i23-painter", doc: DOC, docTitle: "PAINT 夹具" }, async (ui) => {
  const readSrc = () => ui.ev(READ_SRC);
  const readPainter = () => ui.ev(PAINTER);
  /** 读 painter-apply-source 埋点（确认这一跳走的是选区级还是整行级） */
  const readApplyTrace = async () => {
    const t = await ui.ev(`
      const a = window.__LMD_SCROLL_TRACE || [];
      return a.filter(e => e.event === "painter-apply-source").slice(-3).map(e => JSON.stringify(e));
    `);
    return t || [];
  };
  await ui.ev(`window.__LMD_SCROLL_TRACE = []; return true;`);

  // 确保在编辑面（CM6）
  await ui.command("view.edit");
  await sleep(1800);
  const impl = await ui.ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea"`);
  ui.log(`[i23] 源码面实现 = ${impl}`);

  /**
   * 重置夹具。
   *
   * ⚠️ 必须用**每次不同的路径**：`lightmd:openFile` 对"同一路径已打开"的场景
   * 走的是"激活已有标签"，**不会**用 detail.content 覆盖它 ——
   * 实测复用同一路径时，上一用例改过的文本仍留在编辑器里，
   * 导致后续 needle 找不到 / 断错基准（这是探针陷阱，不是产品缺陷）。
   */
  let resetSeq = 0;
  const reset = async () => {
    resetSeq++;
    await ui.ev(`document.body.classList.remove("format-painter-armed"); return true;`);
    const p = ui.docFile.replace(/\.md$/, `-r${resetSeq}.md`);
    await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
      path: ${JSON.stringify(ui.docFile)}.replace(/\\.md$/, "-r${resetSeq}.md"),
      name: "lead-i23-painter-r${resetSeq}.md", content: ${JSON.stringify(DOC)} } })); return true;`);
    await sleep(1500);
    await ui.command("view.edit");
    await sleep(900);
    await ui.ev(`window.__LMD_SCROLL_TRACE = []; return true;`);
    // 自检：夹具文本必须已就位（否则后续断言会"对着错误基准"跑）
    const cur = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.view;
      return v && v.state ? v.state.doc.toString() : null;
    `);
    const ok = !!cur && cur.includes("**已加粗目标**") && cur.includes("DELTA") && cur.includes("正文部分");
    if (!ok) ui.log(`[i23] ⚠️ 夹具重置后文本不符预期 seq=${resetSeq}: ${JSON.stringify(cur)}`);
    return { path: p, ok, text: cur };
  };

  /**
   * 进入 armed 态：选中 needle 作为**源**，然后点格式刷按钮。
   * @param persistent true = 双击入口（持续刷），避免一次应用后自动退出
   */
  const armWith = async (needle, persistent = false) => {
    const s = await ui.ev(selectSrcExact(needle));
    if (!s || !s.ok) return { ok: false, why: s && s.why };
    await ui.ev(CLICK_PAINTER_BTN);
    if (persistent) {
      // 第二次点击 = 双击语义 → persistent（可连续刷 10 次）
      await sleep(120);
      await ui.ev(CLICK_PAINTER_BTN);
    }
    await sleep(600);
    const st = await readPainter();
    return { ok: st.bodyClass, hint: st.hint, toasts: st.toasts, sel: s };
  };

  /* ══════════════════ 问题2：无格式源可用 ============================== */
  ui.log("");
  ui.log("══════ 问题2：无格式源（纯文本）格式刷必须生效 ══════");
  await reset();

  // ① 选中无格式纯文本「ALPHA」（段内一小段，不含任何语法符）
  const selPlain = await ui.ev(selectSrcExact("ALPHA"));
  ui.log(`[i23] 选中无格式文本 ALPHA = ${JSON.stringify(selPlain && { ok: selPlain.ok, from: selPlain.from, to: selPlain.to })}`);

  // ② 点格式刷按钮
  const btn = await ui.ev(CLICK_PAINTER_BTN);
  await sleep(700);
  const p1 = await readPainter();
  ui.log(`[i23] 点格式刷后 = ${JSON.stringify(p1)}`);

  const emptyToast = (p1.toasts || []).some((t) => /没有可复制的格式/.test(t));
  ui.add(
    "P2-1",
    "★ 无格式源不再提示「没有可复制的格式」且进入待刷态",
    !emptyToast && p1.bodyClass ? "PASS" : "FAIL",
    `armed=${p1.bodyClass} emptyToast=${emptyToast} toasts=${JSON.stringify((p1.toasts || []).slice(0, 2))} hint=${JSON.stringify(p1.hint)}`,
  );

  // ③ 刷到有格式目标「BETA 段」（该段含 **已加粗目标**）
  //    注意：无格式源 + 整行语义 → 应清除目标行的行内符号
  if (p1.bodyClass) {
    const c22 = await ui.ev(coordsOf("已加粗目标"));
    if (c22 && c22.ok) await realClick(ui, c22.x, c22.y);
    await sleep(1400);
    const clickRes = c22;
    const after = await readSrc();
    const applyTrace = await readApplyTrace();
    ui.log(`[i23] P2-2 应用埋点 = ${JSON.stringify(applyTrace)}`);
    const cleared = after && !after.includes("**已加粗目标**");
    ui.add(
      "P2-2",
      "★ 把「无格式」刷到有格式目标 → 目标格式被清除",
      cleared ? "PASS" : "FAIL",
      `click=${JSON.stringify(clickRes && { ok: clickRes.ok, why: clickRes.why })} 命中清除=${cleared}｜片段=${JSON.stringify((after || "").split("\n").filter((l) => l.includes("BETA")))}｜埋点=${JSON.stringify(applyTrace[applyTrace.length - 1] || null)}`,
    );
  } else {
    ui.add("P2-2", "★ 把「无格式」刷到有格式目标 → 目标格式被清除", "FAIL", "未进入待刷态，无法应用");
  }

  /* ══════════════════ 问题3：选区级应用 ============================== */
  ui.log("");
  ui.log("══════ 问题3：格式刷作用于选中的文本（不是整段）══════");

  // P3-1：先采集一个粗体源，再选中行内一小段刷
  await reset();
  // 采集源：选中 **已加粗目标**（含符号）→ 持续刷模式（避免一次应用后自动退出）
  const armed3 = await armWith("**已加粗目标**", true);
  ui.log(`[i23] 采集粗体源后 = ${JSON.stringify({ armed: armed3.ok, hint: armed3.hint })}`);

  // 目标：在「第四段纯文本 DELTA 供选区级测试使用。」里选中「DELTA」三个字母
  const targetSel = await ui.ev(selectSrcExact("DELTA"));
  ui.log(`[i23] 目标选区 DELTA = ${JSON.stringify(targetSel && { ok: targetSel.ok, from: targetSel.from, to: targetSel.to })}`);

  // 用 mousedown 捕获 + click 触发应用（探针要模拟真实手势顺序）
  const scrollTopBefore = await ui.ev(`return document.querySelector(".cm-scroller")?.scrollTop ?? 0`);
  if (armed3.ok) {
    // 先恢复选区（上面 selectSrcExact 已被 click 前的 mousedown 覆盖风险）
    await ui.ev(selectSrcExact("DELTA"));
    await sleep(120);
    // 在 DELTA 上派发 mousedown(捕获) → mouseup → click
    const c31 = await ui.ev(coordsOf("DELTA"));
    if (c31 && c31.ok) await realClick(ui, c31.x, c31.y);
    await sleep(1500);
    const clicked = c31;
    const after3 = await readSrc();
    const lines = (after3 || "").split("\n");
    const line = lines.find((l) => l.includes("DELTA")) || "";
    // 期望：只有 DELTA 被包成 **DELTA**，同行的"第四段纯文本""供选区级测试使用"都不带符号
    const onlyDelta =
      line.includes("**DELTA**") &&
      !line.startsWith("**") &&
      line.includes("第四段纯文本") &&
      !line.includes("**第四段");
    ui.add(
      "P3-1",
      "★ 源码面选区级：只有选中的 DELTA 被加粗，整行其余部分不变",
      onlyDelta ? "PASS" : "FAIL",
      `点击=${JSON.stringify(clicked && { ok: clicked.ok, why: clicked.why })}｜目标行=${JSON.stringify(line)}`,
    );
    // P3-4 防回归：无选区（仅光标）仍应刷整行
    await reset();
    const armedCaret = await armWith("**已加粗目标**", true);
    if (armedCaret.ok) {
      await ui.ev(caretSrcAt("GAMMA"));
      await sleep(120);
      const c34 = await ui.ev(coordsOf("GAMMA"));
      if (c34 && c34.ok) await realClick(ui, c34.x, c34.y);
      await sleep(1400);
      const after4 = await readSrc();
      const gLine = (after4 || "").split("\n").find((l) => l.includes("GAMMA")) || "";
      // 整行语义：`## 标题前缀 正文部分 GAMMA。` → 整行正文被 ** 包裹（前缀保留）
      const wholeLine = /\*\*.+GAMMA/.test(gLine) || gLine.includes("**标题前缀");
      ui.add(
        "P3-4",
        "旧语义不回归：仅光标（无选区）→ 仍刷整行正文",
        wholeLine ? "PASS" : "FAIL",
        `目标行=${JSON.stringify(gLine)}`,
      );
    } else {
      ui.add("P3-4", "旧语义不回归：仅光标（无选区）→ 仍刷整行正文", "FAIL", "未 armed");
    }
  } else {
    ui.add("P3-1", "★ 源码面选区级：只有选中的 DELTA 被加粗", "FAIL", "采集粗体源后未 armed");
    ui.add("P3-4", "旧语义不回归（仅光标刷整行）", "FAIL", "前置失败");
  }

  // P3-2：前缀保留（选中"正文"，刷粗体后 `## ` 不动）
  await reset();
  const armed32 = await armWith("**已加粗目标**", true);
  if (armed32.ok) {
    await ui.ev(selectSrcExact("正文部分"));
    await sleep(120);
    const c32 = await ui.ev(coordsOf("正文部分"));
    if (c32 && c32.ok) await realClick(ui, c32.x, c32.y);
    await sleep(1400);
    const after32 = await readSrc();
    const hLine = (after32 || "").split("\n").find((l) => l.includes("GAMMA")) || "";
    const ok32 = hLine.startsWith("## ") && hLine.includes("**正文部分**");
    ui.add(
      "P3-2",
      "★ 前缀（## ）保留不动，只把选中的「正文部分」加粗",
      ok32 ? "PASS" : "FAIL",
      `目标行=${JSON.stringify(hLine)}`,
    );
  } else {
    ui.add("P3-2", "★ 前缀保留、只包选中正文", "FAIL", "未 armed");
  }

  // P3-3：阅读面选区级（PM mark 只加在选区）
  //
  // ## 路径说明
  // 阅读面没有工具栏，格式刷入口在**右键菜单**（`PmContextMenu`）。
  // 探针直接派发 `lightmd` 无关的事件是绕不过去的，所以这里走
  // **菜单 action 分发**这条真实路径：构造 contextmenu → 点「格式刷」菜单项。
  await reset();
  await ui.command("view.preview");
  await sleep(1800);

  /** 在 PM 里用 DOM Range 选中 needle（PM 通过 selectionchange 同步） */
  const selectPm = (needle) => ui.ev(`
    const pm = document.querySelector(".ProseMirror");
    if (!pm) return { ok: false, why: "no-pm" };
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    let node = null, n;
    while ((n = w.nextNode())) { if ((n.textContent || "").includes(${JSON.stringify(needle)})) { node = n; break; } }
    if (!node) return { ok: false, why: "no-node" };
    const i = node.textContent.indexOf(${JSON.stringify(needle)});
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + ${JSON.stringify(needle)}.length);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
    pm.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
    return { ok: true, nodeText: node.textContent };
  `);

  /** 选中 needle 后右键 → 点菜单里的「格式刷」（once 档） */
  const armPmViaMenu = async (needle) => {
    const sel = await selectPm(needle);
    if (!sel.ok) return { ok: false, why: sel.why };
    await sleep(300);
    // 取 needle 屏幕坐标 → contextmenu
    const c = await ui.ev(`
      const pm = document.querySelector(".ProseMirror");
      if (!pm) return { ok: false };
      const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
      let node = null, n;
      while ((n = w.nextNode())) { if ((n.textContent || "").includes(${JSON.stringify(needle)})) { node = n; break; } }
      if (!node) return { ok: false };
      const i = node.textContent.indexOf(${JSON.stringify(needle)});
      const r = document.createRange();
      r.setStart(node, i); r.setEnd(node, i + 1);
      const rect = r.getBoundingClientRect();
      return { ok: true, x: rect.left + 2, y: (rect.top + rect.bottom) / 2 };
    `);
    if (!c.ok) return { ok: false, why: "no-coords" };
    await ui.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: c.x, y: c.y, button: "right", clickCount: 1,
    });
    await ui.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: c.x, y: c.y, button: "right", clickCount: 1,
    });
    await sleep(700);
    // 找菜单里的「格式刷」项并点击
    const hit = await ui.ev(`
      const items = Array.from(document.querySelectorAll("div,button,li,span"));
      for (const e of items) {
        const t = (e.textContent || "").trim();
        if (t === "格式刷" && e.children.length === 0) { e.click(); return { ok: true, t }; }
      }
      const labels = items.map(e => (e.textContent || "").trim()).filter(t => t && t.length < 20).slice(0, 20);
      return { ok: false, labels };
    `);
    await sleep(700);
    const st = await readPainter();
    return { ok: st.bodyClass, menuClick: hit, hint: st.hint };
  };

  /**
   * ## P3-3 的源必须是**有格式**的
   *
   * 第一版用 ALPHA（无格式）当源、DELTA（无格式）当目标 → 埋点显示
   * `inlineOnly:true, from:77,to:82`（选区级**正确生效**），
   * 但"无格式刷到无格式"本来就无变化，`<strong>` 里当然看不到 DELTA
   * —— 是**断言写错了**，不是功能缺陷。
   * 现在改为：源 = `已加粗目标`（strong），目标 = DELTA 的一小段。
   */
  const pmArm = await armPmViaMenu("已加粗目标");
  ui.log(`[i23] PM 右键菜单格式刷（源=已加粗目标）= ${JSON.stringify(pmArm)}`);

  let pmP33 = { status: "FAIL", detail: "未能进入 armed 态" };
  if (pmArm.ok) {
    // 目标：在阅读面选中 DELTA 一小段 → 单击应用
    const beforePm = await ui.ev(`return document.querySelector(".ProseMirror")?.innerHTML || ""`);
    const selTarget = await selectPm("DELTA");
    if (selTarget.ok) {
      const c2 = await ui.ev(`
        const pm = document.querySelector(".ProseMirror");
        const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
        let node = null, n;
        while ((n = w.nextNode())) { if ((n.textContent || "").includes("DELTA")) { node = n; break; } }
        const i = node.textContent.indexOf("DELTA");
        const r = document.createRange();
        r.setStart(node, i + 1); r.setEnd(node, i + 2);
        const rect = r.getBoundingClientRect();
        return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
      `);
      await realClick(ui, c2.x, c2.y);
      await sleep(1400);
      const pmTrace = await ui.ev(`
        const a = window.__LMD_SCROLL_TRACE || [];
        return a.filter(e => e.event === "painter-apply-pm").map(e => JSON.stringify(e));
      `);
      ui.log(`[i23] P3-3 PM 应用埋点 = ${JSON.stringify(pmTrace)}`);
      const html = await ui.ev(`return document.querySelector(".ProseMirror")?.innerHTML || ""`);
      // 期望：只有 DELTA 被 <strong> 包裹，"第四段纯文本"与"供选区级测试使用"不在 strong 内
      const m = /<strong>([^<]*)<\/strong>/g;
      const strongs = [];
      let mm;
      while ((mm = m.exec(html)) !== null) strongs.push(mm[1]);
      const onlyDelta = strongs.some((t) => t === "DELTA");
      const leaked = strongs.some((t) => /第四段纯文本|供选区级测试使用/.test(t));
      pmP33 = {
        status: onlyDelta && !leaked ? "PASS" : "FAIL",
        detail: `PM <strong> 内容=${JSON.stringify(strongs)}；只含 DELTA=${onlyDelta}；整段泄漏=${leaked}；changed=${beforePm !== html}`,
      };
    } else {
      pmP33 = { status: "FAIL", detail: "目标选区建立失败" };
    }
  }
  ui.add("P3-3", "★ 阅读面（PM）选区级：只有选中的 DELTA 加粗，整段不泄漏", pmP33.status, pmP33.detail);

  const errs = await ui.errors();
  ui.log(`[i23] 页面异常 = ${JSON.stringify(errs)}`);
  fs.writeFileSync(path.join(os.tmpdir(), "lead-i23-detail.json"),
    JSON.stringify({ impl, results: ui.results }, null, 1), "utf8");
});
