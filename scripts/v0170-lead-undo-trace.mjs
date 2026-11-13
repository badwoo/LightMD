/**
 * Lead 取证：P1-2 交替 undo/redo 滞后的**根因**
 *
 * 用修复者已铺好的 `historyTrace` 通道（`window.__LMD_HIST_TRACE`），
 * 逐次按键记录时间线游标状态，定位「哪一步没推进 / 哪一步多推进」。
 *
 * 关键观测：
 *   - apply.enter / afterFlush / peek / applyText / consume / after 各步骤的 {n, cur, known, topId}
 *   - commit.* 事件（是否产生了新条目 → truncateRedo）
 *   - forceRebase 事件（syncBaseline 推平 redo 的证据）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 撤销取证", "", "正文一。", "", "正文二。", ""].join("\n");

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

const press = async (ui, key, code, vk, mods) => {
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

await runProbe({ name: "v0170-lead-undo-trace", doc: DOC, docTitle: "撤销取证" }, async (ui) => {
  // 安装 trace 接收器
  const installed = await ui.ev(`window.__LMD_HIST_TRACE = []; return true;`);
  ui.add("T0", "trace 接收器已安装", installed ? "PASS" : "FAIL", `__LMD_HIST_TRACE=[]`);

  // 造一步历史
  await clickContent(ui);
  const base = await readDoc(ui);
  await ui.cdp.send("Input.insertText", { text: "AAA" });
  await ui.sleep(900);
  const edit = await readDoc(ui);
  ui.add("T1", "前置：一步历史就绪", edit === base + "AAA" ? "PASS" : "FAIL",
    `base=${base.length} edit=${edit.length}`);

  const mark = async (label) => {
    const n = await ui.ev(`return (window.__LMD_HIST_TRACE || []).length`);
    return { label, n };
  };

  const traceAll = [];
  // 交替 3 轮
  const rounds = [];
  for (let i = 1; i <= 3; i++) {
    await clickContent(ui);
    const beforeU = ((await readDoc(ui)) || "").length;
    await press(ui, "z", "KeyZ", 90, 2);
    const afterU = ((await readDoc(ui)) || "").length;

    await clickContent(ui);
    const beforeR = ((await readDoc(ui)) || "").length;
    await press(ui, "y", "KeyY", 89, 2);
    const afterR = ((await readDoc(ui)) || "").length;

    rounds.push({ i, u: { beforeU, afterU }, r: { beforeR, afterR } });
  }
  ui.log("[rounds] " + JSON.stringify(rounds));

  // 读全部 trace
  const tr = await ui.ev(`return (window.__LMD_HIST_TRACE || []).slice(0, 400)`);
  ui.log(`[trace] 共 ${tr.length} 条`);
  for (const e of tr) {
    // 只打印与 apply/commit 相关、且带 snap 的
    const parts = [];
    parts.push(e.event);
    if (e.dir) parts.push(`dir=${e.dir}`);
    const s = (o) => o ? `n=${o.n},cur=${o.cur},known=${o.known},top=${o.topId}` : "null";
    if (e.pre) parts.push(`pre{${s(e.pre)}}`);
    if (e.post) parts.push(`post{${s(e.post)}}`);
    if (e.snap) parts.push(`snap{${s(e.snap)}}`);
    if (e.snapBefore) parts.push(`snapBefore{${s(e.snapBefore)}}`);
    if (e.entryId !== undefined) parts.push(`entryId=${e.entryId}`);
    if (e.origin) parts.push(`origin=${e.origin}`);
    if (e.note) parts.push(`note=${e.note}`);
    ui.log(`  t=${e.t} ${parts.join(" ")}`);
  }

  // 判定：找 apply.enter 与 consume 的游标推进
  const applies = tr.filter((e) => e.event && e.event.startsWith("apply."));
  ui.add("T2", "trace 抓到 apply.* 事件", applies.length > 0 ? "PASS" : "FAIL",
    `${applies.length} 条 apply.*；总 ${tr.length} 条`);

  const commits = tr.filter((e) => e.event && e.event.startsWith("commit."));
  ui.add("T3", "★ 交替期间是否产生了新 commit（→ truncateRedo）",
    commits.length === 0 ? "PASS" : "FAIL",
    `commit.* 共 ${commits.length} 条${commits.length ? "：" + JSON.stringify(commits.map(c => c.event)) : "（无新条目）"}`);

  const rebases = tr.filter((e) => e.event && String(e.event).indexOf("forceRebase") >= 0);
  ui.add("T4", "★ 是否触发 forceRebase（推平 redo 分支）",
    rebases.length === 0 ? "PASS" : "FAIL",
    `forceRebase 共 ${rebases.length} 条`);

  await ui.shot("undo-trace");
});
