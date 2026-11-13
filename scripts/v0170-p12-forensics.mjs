/**
 * P1-2 取证：交替 undo/redo 每两次只有一次生效 —— 到底哪一步错了？
 *
 * ## 为什么不能只靠黑盒
 *
 * 黑盒只能观察到「文本长度没变」，而长度没变有**至少 5 种互斥成因**：
 * 1. `peekUndo/peekRedo` 返回 null（游标已到底 → 发边界提示）
 * 2. `peek` 拿到条目，但 ③ `applyText` 没真的改宿主文本
 * 3. ③ 改了宿主，但 ④ 消费游标时拿到**另一条**（peek/consume 错位）
 * 4. ③ 之后时间线被新增一条 / `truncateRedo` 推平 → 下一次 peek 拿到错的条目
 * 5. 文本确实改了，但随后被另一条异步路径（`content` prop 回流 / `setText`）推回原值
 *
 * 本探针在**每个决策点**（coordinator 内的 histTrace 埋点）记录
 * `{条目数 n, 游标 cur, known 文本长度, peek/consume 的条目 id}`，
 * 因此可以逐条判定是上面哪一种。
 *
 * ## 埋点开关
 *
 * 源码里的 `histTrace` 只在 `window.__LMD_HIST_TRACE` 是数组时才记录
 * （生产环境不装 → 零开销）。本探针在跑动作前把它装上。
 *
 * ## 判定纪律
 *
 * - 每个断言都必须能**失败**（不做 `<=` 之类的恒真兜底）。
 * - 「埋点是否真的工作」单独一条（H0），否则"没事件"可能只是埋点坏了。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 取证交替撤销", "", "正文一。", "", "正文二。", ""].join("\n");

const clickContent = async (ui) => {
  await ui.ev(`window.__CB = (() => { const c = document.querySelector(".cm-content");
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 12) }; })(); return true;`);
  const b = await ui.ev(`return window.__CB`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(250);
};

const pressMod = async (ui, key, code, vk, mods) => {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await ui.sleep(40);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await ui.sleep(700);
};

const readDoc = async (ui) => ui.ev(`
  const c = document.querySelector(".cm-content");
  const v = c && (c.cmTile ? c.cmTile.view : null);
  if (v) return v.state.doc.toString();
  const ed = document.querySelector(".cm-editor");
  return ed ? Array.from(ed.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n") : null;
`);

/** 装/清埋点接收器 */
const traceInstall = async (ui) => ui.ev(`window.__LMD_HIST_TRACE = []; return true;`);
const traceClear = async (ui) => ui.ev(`window.__LMD_HIST_TRACE = []; return true;`);
const traceDump = async (ui) => (await ui.ev(`return window.__LMD_HIST_TRACE || []`)) ?? [];

const toolbarClick = async (ui, which) => {
  const ok = await ui.ev(`
    const btns = document.querySelectorAll(".source-format-toolbar .format-btn");
    if (btns.length < 2) return "no-btn";
    const target = btns[${which === "undo" ? 0 : 1}];
    if (!target) return "no-target";
    const want = ${JSON.stringify(which === "undo" ? "撤销" : "恢复")};
    target.click();
    return (target.title || "").startsWith(want) ? true : "wrong-btn:" + target.title;
  `);
  await ui.sleep(700);
  return ok;
};

/** 只挑 apply.* / commit.* 事件，压成一行行可读日志 */
const fmt = (events) =>
  events.map((e) => {
    const s = e.snap || e.pre || e.post;
    const core = s ? `n=${s.n} cur=${s.cur} known=${s.known}` : "";
    const extra = [];
    if (e.dir) extra.push(e.dir);
    if (e.got !== undefined) extra.push(`peek=${e.got}`);
    if (e.peekId !== undefined) extra.push(`peek=${e.peekId}`);
    if (e.consumedId !== undefined) extra.push(`cons=${e.consumedId}`);
    if (e.match !== undefined) extra.push(`match=${e.match}`);
    if (e.beforeLen !== undefined && e.beforeLen >= 0) extra.push(`b=${e.beforeLen}`);
    if (e.afterLen !== undefined && e.afterLen >= 0) extra.push(`a=${e.afterLen}`);
    if (e.targetLen !== undefined) extra.push(`tgt=${e.targetLen}`);
    if (e.hostTextLen !== undefined) extra.push(`host=${e.hostTextLen}`);
    if (e.entryId !== undefined) extra.push(`entry=${e.entryId}`);
    if (e.knownLen !== undefined) extra.push(`knownLen=${e.knownLen}`);
    return `      ${e.event} ${extra.join(" ")} ${core}`.trimEnd();
  });

await runProbe({ name: "v0170-p12-forensics", doc: DOC, docTitle: "取证交替撤销" }, async (ui) => {
  await clickContent(ui);
  const base = await readDoc(ui);

  /* ── 装埋点 → 造一步历史 ── */
  await traceInstall(ui);
  await clickContent(ui);
  await ui.cdp.send("Input.insertText", { text: "AAA" });
  await ui.sleep(900);
  const edit = await readDoc(ui);

  ui.add("P", "前置：一步历史就绪（base→edit）", edit === base + "AAA" ? "PASS" : "FAIL",
    `base=${base.length} edit=${edit.length}`);

  const afterInsert = await traceDump(ui);
  const commitEvents = afterInsert.filter((e) => String(e.event).startsWith("commit."));
  ui.log(`[P] 造历史期间 commit 事件 ${commitEvents.length} 条`);
  ui.log(fmt(commitEvents).join("\n"));
  /** 打印提交调用栈（证明"变更上报是谁发出来的"） */
  const dumpStacks = (events, label) => {
    const withStack = events.filter((e) => e.event === "commit.source.enter" && Array.isArray(e.stack));
    if (!withStack.length) { ui.log(`[${label}] 无 commit.source.enter 栈数据`); return; }
    withStack.forEach((e, i) => {
      ui.log(`[${label}] commit#${i + 1} b=${e.beforeLen} a=${e.afterLen} 调用栈：`);
      e.stack.forEach((s) => ui.log(`          ${s}`));
    });
  };
  dumpStacks(afterInsert, "P");

  /* ── H0 埋点自检：必须真的收到事件 ── */
  ui.add("H0", "★ 埋点自检：造历史确实产生了 commit 事件（否则「没事件」不可信）",
    commitEvents.length > 0 ? "PASS" : "FAIL",
    `commit 事件=${commitEvents.length} 条；总事件=${afterInsert.length}`);

  const afterCommit = commitEvents.filter((e) => e.event === "commit.source.result");
  const st = afterCommit.length ? afterCommit[afterCommit.length - 1].snap : null;
  ui.log(`[P] 造历史后时间线: ${st ? `n=${st.n} cur=${st.cur} known=${st.known}` : "null"}`);
  ui.add("P2", "前置：时间线恰有 1 条且游标在 1（即 base→edit 一步）",
    st && st.n === 1 && st.cur === 1 ? "PASS" : "FAIL",
    st ? `n=${st.n} cur=${st.cur} known=${st.known}` : "无快照");

  /* ── 实验 C：u, u, r, r（缺陷详报 §1.4 的关键判别）── */
  await traceClear(ui);
  const seqC = [];
  for (const act of ["undo", "undo", "redo", "redo"]) {
    if (act === "undo") await pressMod(ui, "z", "KeyZ", 90, 2);
    else await pressMod(ui, "y", "KeyY", 89, 2);
    seqC.push((await readDoc(ui)).length);
  }
  const traceC = await traceDump(ui);
  ui.log(`[C] u,u,r,r 长度: ${JSON.stringify(seqC)}  （base=${base.length} edit=${edit.length}）`);
  ui.log("[C] 决策层事件：");
  ui.log(fmt(traceC).join("\n"));
  dumpStacks(traceC, "C");

  /* ── 实验 D：工具栏按钮交替（不经键盘/焦点）── */
  // 先归位到 edit
  for (let i = 0; i < 6 && (await readDoc(ui)) !== edit; i++) await pressMod(ui, "y", "KeyY", 89, 2);
  await traceClear(ui);
  const btnOk = await toolbarClick(ui, "undo");
  const seqD = [];
  seqD.push((await readDoc(ui)).length);
  await toolbarClick(ui, "redo"); seqD.push((await readDoc(ui)).length);
  await toolbarClick(ui, "undo"); seqD.push((await readDoc(ui)).length);
  await toolbarClick(ui, "redo"); seqD.push((await readDoc(ui)).length);
  const traceD = await traceDump(ui);
  ui.log(`[D] 工具栏交替: ${JSON.stringify(seqD)}  期望=[${base.length},${edit.length},${base.length},${edit.length}]`);
  ui.log(`[D] 工具栏按钮可定位: ${btnOk}`);
  ui.log("[D] 决策层事件：");
  ui.log(fmt(traceD).join("\n"));

  /* ── 汇总判定：从埋点直接判"每步是哪种失败" ── */
  const applies = [...traceC, ...traceD].filter((e) => String(e.event).startsWith("apply."));
  const enters = applies.filter((e) => e.event === "apply.enter");
  const peeks = applies.filter((e) => e.event === "apply.peek");
  const consumes = applies.filter((e) => e.event === "apply.consume");
  const afterApply = applies.filter((e) => e.event === "apply.afterApplyText");

  // ① peek 为空的次数（边界）
  const nullPeeks = peeks.filter((e) => e.got === null).length;
  // ② peek 与 consume 的 id 是否每步一致
  const mismatch = consumes.filter((e) => e.match === false);
  // ③ ③ 之后时间线条目数有没有变化（新增条目 / truncateRedo）
  const nChanged = afterApply.filter((e) => {
    const pre = enters.find((x) => x.dir === e.dir);
    return false; // 由下面的逐对比较代替
  });

  ui.add("H1", "埋点覆盖：每次 undo/redo 都留下 enter/peek/consume 三类事件",
    enters.length > 0 && peeks.length === enters.length && consumes.length >= enters.length - nullPeeks
      ? "PASS" : "FAIL",
    `enter=${enters.length} peek=${peeks.length} consume=${consumes.length} 空peek=${nullPeeks}`);

  ui.add("H2", "★ peek 与 consume 拿到的条目 id 始终一致（游标没被抢跑）",
    mismatch.length === 0 ? "PASS" : "FAIL",
    mismatch.length === 0
      ? `${consumes.length} 步全部一致`
      : `不一致 ${mismatch.length} 步: ${JSON.stringify(mismatch.map((e) => ({ peek: e.peekId, cons: e.consumedId })))}`);

  /* ── 最关键的判定：③ 之后时间线有没有多出条目 ── */
  // 逐次 apply 配对：enter.snap(pre) 与 afterApplyText.snap/post 比较
  const expanded = [];
  for (let i = 0; i < enters.length; i++) {
    const en = enters[i];
    const post = afterApply.find((e) => e.t >= en.t && e.dir === en.dir);
    if (en.pre && post && post.snap) {
      if (post.snap.n !== en.pre.n) {
        expanded.push({ dir: en.dir, preN: en.pre.n, postN: post.snap.n, preCur: en.pre.cur, postCur: post.snap.cur });
      }
    }
  }
  ui.add("H3", "★ ③ applyText 之后时间线条目数不变（不产生新条目 / 不被 truncateRedo）",
    expanded.length === 0 ? "PASS" : "FAIL",
    expanded.length === 0
      ? "所有步骤 n 恒定"
      : `发现 ${expanded.length} 次变化: ${JSON.stringify(expanded)}`);

  /* ── 行为判定（黑盒，与埋点独立） ── */
  ui.add("C", "u,u,r,r：第 1 次 undo 就应回 base",
    seqC[0] === base.length ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(seqC)} base=${base.length} edit=${edit.length}`);

  const dOk = seqD[0] === base.length && seqD[1] === edit.length
           && seqD[2] === base.length && seqD[3] === edit.length;
  ui.add("D", "★ 工具栏交替 undo/redo 2 轮",
    dOk ? "PASS" : "FAIL",
    `轨迹=${JSON.stringify(seqD)} 期望=[${base.length},${edit.length},${base.length},${edit.length}]`);

  await ui.shot("forensics");
});
