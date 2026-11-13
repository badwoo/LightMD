/**
 * Lead 独立复核：**交替 undo/redo 是否真的失效？**
 *
 * D 流报告 [U4c]/[U4d]：交替 6 轮，undo 只命中 3/6，redo 只命中 3/6，
 * 且 u2=60（未回退）、r2=56（未恢复）—— 呈「偶数次失效」的规律。
 *
 * 这是用户核心关切（「统一撤销栈是否还能在双模式下生效」），必须独立确认。
 *
 * 本探针刻意**不用** D 流的 `focusEditor()`（它会 dispatch 一个 selection 事务，
 * 有可能是干扰源）。改为：
 *   - 用真实鼠标点击聚焦
 *   - 只用**单次 insertText** 造历史（绕开 P0-1 逐字丢字）
 *   - 每次按键前用真实鼠标点击重新聚焦（不 dispatch 任何事务）
 *
 * 对照组：
 *   V1 交替 undo/redo（点击聚焦）
 *   V2 交替 undo/redo（dispatch 聚焦，复现 D 流手法）—— 若 V1 好而 V2 坏，说明是探针手法问题
 *   V3 连续 undo（不回退间隔）—— 看 undo 本身是否单调
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 交替撤销验证", "", "正文一。", "", "正文二。", ""].join("\n");

const clickContent = async (ui) => {
  const box = await ui.ev(`
    const c = document.querySelector(".cm-content");
    if (!c) return false;
    const r = c.getBoundingClientRect();
    window.__CB = { x: Math.round(r.left + 30), y: Math.round(r.top + 12) };
    return true;
  `);
  if (!box) return false;
  const b = await ui.ev(`return window.__CB`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(280);
};

const focusByDispatch = async (ui) => {
  await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && (c.cmTile ? c.cmTile.view : null);
    if (!v) return false;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.length, head: v.state.doc.length }, scrollIntoView: false });
    return true;
  `);
  await ui.sleep(230);
};

const press = async (ui, key, code, vk, mods) => {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await ui.sleep(40);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await ui.sleep(750);
};

/** 用权威通道读全文（CM6 虚拟渲染下 .cm-line 只含视口，短文档两者一致） */
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
  await ui.sleep(800);
};

await runProbe({ name: "v0170-lead-undo-alternate", doc: DOC, docTitle: "交替撤销验证" }, async (ui) => {
  /* ── V1：点击聚焦 + 交替 undo/redo ── */
  await clickContent(ui);
  const base = await readDoc(ui);
  await insertWhole(ui, "AAA");
  const edit = await readDoc(ui);
  ui.add("V1a", "前置：单次 insertText 完整落地", edit === base + "AAA" ? "PASS" : "FAIL",
    `base=${base.length} edit=${edit.length} 精确=${edit === base + "AAA"}`);

  const trace = [];
  for (let i = 1; i <= 6; i++) {
    await clickContent(ui);
    await press(ui, "z", "KeyZ", 90, 2);
    const u = await readDoc(ui);
    await clickContent(ui);
    await press(ui, "y", "KeyY", 89, 2);
    const r = await readDoc(ui);
    const uOk = u === base, rOk = r === edit;
    trace.push({ i, u: u.length, uOk, r: r.length, rOk });
  }
  ui.log("[V1] 交替轨迹: " + JSON.stringify(trace));
  const uHit = trace.filter((x) => x.uOk).length;
  const rHit = trace.filter((x) => x.rOk).length;
  ui.add("V1b", "★ 交替 undo/redo 6 轮（点击聚焦，不 dispatch 事务）",
    uHit === 6 && rHit === 6 ? "PASS" : "FAIL",
    `undo 命中 ${uHit}/6；redo 命中 ${rHit}/6｜轨迹=${trace.map((x) => `u${x.i}=${x.u}${x.uOk ? "✓" : "✗"} r${x.i}=${x.r}${x.rOk ? "✓" : "✗"}`).join(" ")}`);

  /* ── V2：dispatch 聚焦 + 交替（复现 D 流手法）── */
  const trace2 = [];
  for (let i = 1; i <= 6; i++) {
    await focusByDispatch(ui);
    await press(ui, "z", "KeyZ", 90, 2);
    const u = await readDoc(ui);
    await focusByDispatch(ui);
    await press(ui, "y", "KeyY", 89, 2);
    const r = await readDoc(ui);
    trace2.push({ i, u: u.length, uOk: u === base, r: r.length, rOk: r === edit });
  }
  ui.log("[V2] dispatch 聚焦轨迹: " + JSON.stringify(trace2));
  const uHit2 = trace2.filter((x) => x.uOk).length;
  const rHit2 = trace2.filter((x) => x.rOk).length;
  ui.add("V2", "对照：dispatch 聚焦下的交替 undo/redo",
    uHit2 === 6 && rHit2 === 6 ? "PASS" : "FAIL",
    `undo 命中 ${uHit2}/6；redo 命中 ${rHit2}/6｜轨迹=${trace2.map((x) => `u${x.i}=${x.u}${x.uOk ? "✓" : "✗"} r${x.i}=${x.r}${x.rOk ? "✓" : "✗"}`).join(" ")}`);

  /* ── V3：连续 undo（不回退间隔）── */
  await clickContent(ui);
  // 归位：若当前不是 edit，先 redo 回来
  for (let i = 0; i < 6 && (await readDoc(ui)) !== edit; i++) { await clickContent(ui); await press(ui, "y", "KeyY", 89, 2); }
  await clickContent(ui);
  const seq = [];
  for (let i = 1; i <= 4; i++) {
    await clickContent(ui);
    await press(ui, "z", "KeyZ", 90, 2);
    seq.push(((await readDoc(ui)) || "").length);
  }
  ui.log("[V3] 连续 undo 长度轨迹: " + JSON.stringify(seq));
  // 历史只有一步（单次插入），所以第一次 undo 应回 base，之后应保持在 base
  ui.add("V3", "连续 undo：第 1 次回 base，之后保持 base（不反弹）",
    seq[0] === base.length && seq.slice(1).every((n) => n === base.length) ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(seq)} 期望=[${base.length},${base.length},${base.length},${base.length}]`);

  await ui.shot("undo-alternate");
});
