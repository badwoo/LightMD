/**
 * Lead 深挖：交替 undo/redo 呈「周期 2 失败」——定位到游标层还是桥接层。
 *
 * 观测点（尽量不侵入产品逻辑）：
 *   1. 每次按键后，读 documentHistory 的**游标状态**（canUndo/canRedo、条目数）
 *      —— 但 documentHistory 是 ESM 导出，页面里拿不到。
 *      替代：用 `__TAURI__` 无关的 DOM 观察 + 直接读 CM6 doc 文本。
 *   2. 关键判别实验：**undo, undo, undo**（连按 3 次不回退）
 *      vs **undo, redo, undo, redo** —— 若前者单调、后者振荡，则问题在 redo 分支。
 *   3. **undo, undo, redo, redo** —— 检查 redo 是否能连做两步。
 *   4. 换用工具栏按钮（不走键盘/焦点）做同样的交替，若同样失败 ⇒ 在决策层，与键盘无关。
 *
 * 判定：把"非法态"（既不是 base 也不是 edit）单独统计。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 深挖撤销", "", "正文一。", "", "正文二。", ""].join("\n");

const clickContent = async (ui) => {
  await ui.ev(`window.__CB = (() => { const c = document.querySelector(".cm-content");
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 12) }; })(); return true;`);
  const b = await ui.ev(`return window.__CB`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(300);
};

const pressMod = async (ui, key, code, vk, mods) => {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await ui.sleep(40);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await ui.sleep(800);
};

const readDoc = async (ui) => ui.ev(`
  const c = document.querySelector(".cm-content");
  const v = c && (c.cmTile ? c.cmTile.view : null);
  if (v) return v.state.doc.toString();
  const ed = document.querySelector(".cm-editor");
  return ed ? Array.from(ed.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n") : null;
`);

const insertWhole = async (ui, text) => {
  await clickContent(ui);
  await ui.cdp.send("Input.insertText", { text });
  await ui.sleep(900);
};

const clickToolbarBtn = async (ui, idx) => {
  const ok = await ui.ev(`
    const btns = document.querySelectorAll(".source-format-toolbar .format-btn");
    if (btns.length <= ${idx}) return false;
    btns[${idx}].click();
    return true;
  `);
  await ui.sleep(900);
  return ok;
};

await runProbe({ name: "v0170-lead-undo-deep", doc: DOC, docTitle: "深挖撤销" }, async (ui) => {
  await clickContent(ui);
  const base = await readDoc(ui);
  await insertWhole(ui, "AAA");
  const edit = await readDoc(ui);

  // 只造**一步**历史：base → edit
  ui.add("P", "前置：一步历史就绪（base→edit）", edit === base + "AAA" ? "PASS" : "FAIL",
    `base=${base.length} edit=${edit.length}`);

  /* ── 实验 A：undo 连按 3 次 ── */
  const A = [];
  for (let i = 0; i < 3; i++) { await clickContent(ui); await pressMod(ui, "z", "KeyZ", 90, 2); A.push((await readDoc(ui)).length); }
  ui.log("[A] undo×3 长度: " + JSON.stringify(A));
  ui.add("A", "undo 连按 3 次：第 1 次回 base 后保持不变",
    A[0] === base.length && A[1] === base.length && A[2] === base.length ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(A)} 期望=[${base.length},${base.length},${base.length}]`);

  /* ── 实验 B：回到 edit，然后 redo 连按 3 次 ── */
  // 先归位到 edit
  for (let i = 0; i < 4 && (await readDoc(ui)) !== edit; i++) { await clickContent(ui); await pressMod(ui, "y", "KeyY", 89, 2); }
  const atEdit = (await readDoc(ui)) === edit;
  ui.add("B0", "前置：可用 redo 回到 edit", atEdit ? "PASS" : "KNOWN", `当前=${((await readDoc(ui)) || "").length}`);
  const B = [];
  for (let i = 0; i < 3; i++) { await clickContent(ui); await pressMod(ui, "y", "KeyY", 89, 2); B.push((await readDoc(ui)).length); }
  ui.log("[B] redo×3 长度（已在 edit，应全部保持 edit）: " + JSON.stringify(B));
  ui.add("B", "redo 在已到顶后连按 3 次：保持 edit 不变",
    B.every((n) => n === edit.length) ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(B)} 期望=[${edit.length},${edit.length},${edit.length}]`);

  /* ── 实验 C：undo, undo, redo, redo（检查 redo 能否连做两步）── */
  // 归位到 edit
  for (let i = 0; i < 4 && (await readDoc(ui)) !== edit; i++) { await clickContent(ui); await pressMod(ui, "y", "KeyY", 89, 2); }
  const seqC = [];
  await clickContent(ui); await pressMod(ui, "z", "KeyZ", 90, 2); seqC.push((await readDoc(ui)).length);
  await clickContent(ui); await pressMod(ui, "z", "KeyZ", 90, 2); seqC.push((await readDoc(ui)).length);
  await clickContent(ui); await pressMod(ui, "y", "KeyY", 89, 2); seqC.push((await readDoc(ui)).length);
  await clickContent(ui); await pressMod(ui, "y", "KeyY", 89, 2); seqC.push((await readDoc(ui)).length);
  ui.log("[C] u,u,r,r 长度: " + JSON.stringify(seqC));
  ui.add("C", "u,u,r,r 轨迹：应 [base,base,base?] 或 [base,base,edit,edit]",
    seqC[0] === base.length ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(seqC)}（base=${base.length} edit=${edit.length}）`);

  /* ── 实验 D：用工具栏按钮（不经键盘）做交替 ── */
  // 归位
  for (let i = 0; i < 6 && (await readDoc(ui)) !== edit; i++) { await clickContent(ui); await pressMod(ui, "y", "KeyY", 89, 2); }
  const seqD = [];
  for (let i = 0; i < 3; i++) {
    await clickToolbarBtn(ui, 0);  // ↩ undo
    seqD.push((await readDoc(ui)).length);
    await clickToolbarBtn(ui, 1);  // ↪ redo
    seqD.push((await readDoc(ui)).length);
  }
  ui.log("[D] 工具栏交替: " + JSON.stringify(seqD));
  const dOk = seqD[0] === base.length && seqD[1] === edit.length
           && seqD[2] === base.length && seqD[3] === edit.length;
  ui.add("D", "★ 工具栏按钮交替 undo/redo 3 轮（完全不经键盘/焦点）",
    dOk ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(seqD)} 期望=[base,edit,base,edit]=[${base.length},${edit.length},${base.length},${edit.length}]`);

  await ui.shot("undo-deep");
});
