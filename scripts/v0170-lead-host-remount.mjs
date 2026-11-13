/**
 * Lead 决定性实验 2：**CM6 宿主 DOM 是否在打字后被 React 重新挂载**（夺走焦点）
 *
 * 手法（低干扰）：
 *   1. 在页面里给 .cm-content 打一个 dataset 标记 + 挂被动事件监听（focusin/focusout/input/keydown），
 *      监听器只往数组里 push，不碰 DOM。
 *   2. 然后连续发 5 个字符。
 *   3. 只在最后读一次数组，看：
 *      - 标记是否还在（不在 ⇒ 元素被替换 ⇒ React 重建了宿主 ⇒ 焦点必然丢）
 *      - focusout 是否发生、发生在第几键之后
 *      - input 事件是否只来了 1 次
 *
 * 这是本轮最关键的一条：若宿主被重建，则**用户在真实使用中打一个字就会失去焦点**，
 * 且与 v0.17.0 上一轮缺陷 #1「受控 <textarea> 当 CM6 宿主被 React 抹掉」同类。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 宿主重建检测", "", "正文一。", "", "正文二。", ""].join("\n");

const clickContent = async (ui) => {
  const box = await ui.ev(`
    const c = document.querySelector(".cm-content");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 12) };
  `);
  if (!box) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(350);
  return true;
};

await runProbe({ name: "v0170-lead-host-remount", doc: DOC, docTitle: "宿主重建检测" }, async (ui) => {
  await clickContent(ui);

  // 打标记 + 装被动监听
  const installed = await ui.ev(`
    const cm = document.querySelector(".cm-editor");
    const content = document.querySelector(".cm-content");
    if (!cm || !content) return { ok: false };
    cm.dataset.probeMark = "ALIVE";
    content.dataset.probeMark = "ALIVE-CONTENT";
    window.__EV = [];
    const rec = (t) => (e) => window.__EV.push({ t, at: Date.now(), key: e.key || null, data: e.data || null,
      target: e.target ? (e.target.className || e.target.nodeName) : null });
    document.addEventListener("focusin", rec("focusin"), true);
    document.addEventListener("focusout", rec("focusout"), true);
    content.addEventListener("input", rec("input"), true);
    content.addEventListener("keydown", rec("keydown"), true);
    content.addEventListener("beforeinput", rec("beforeinput"), true);
    // 观察宿主是否被 React 换成新节点：MutationObserver 只看根节点替换
    window.__MUT = [];
    const root = document.querySelector(".source-editor-wrapper") || cm.parentElement;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) {
          if (n.nodeType === 1) window.__MUT.push({ type: "removed", cls: String(n.className || "").slice(0, 60) });
        }
        for (const n of m.addedNodes || []) {
          if (n.nodeType === 1) window.__MUT.push({ type: "added", cls: String(n.className || "").slice(0, 60) });
        }
      }
    });
    mo.observe(root, { childList: true, subtree: false });
    return { ok: true, rootCls: String(root.className || "") };
  `);
  ui.log("[remount] 监听已装: " + JSON.stringify(installed));

  const lenBefore = ((await ui.readSourceText()) || "").length;

  // 连续发 5 个字符
  for (const ch of ["P", "Q", "R", "S", "T"]) {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(200);
  }
  await ui.sleep(700);

  const report = await ui.ev(`
    const cm = document.querySelector(".cm-editor");
    const content = document.querySelector(".cm-content");
    const a = document.activeElement;
    return {
      cmStillMarked: !!(cm && cm.dataset.probeMark === "ALIVE"),
      contentStillMarked: !!(content && content.dataset.probeMark === "ALIVE-CONTENT"),
      events: (window.__EV || []).map(e => e.t + (e.key ? ":" + e.key : "")),
      inputCount: (window.__EV || []).filter(e => e.t === "input").length,
      beforeInputCount: (window.__EV || []).filter(e => e.t === "beforeinput").length,
      keydownCount: (window.__EV || []).filter(e => e.t === "keydown").length,
      focusoutCount: (window.__EV || []).filter(e => e.t === "focusout").length,
      mutations: (window.__MUT || []).slice(0, 10),
      activeTag: a ? a.tagName : null,
    };
  `);
  ui.log("[remount] 报告: " + JSON.stringify(report, null, 1));

  const lenAfter = ((await ui.readSourceText()) || "").length;

  ui.add("1", "打字后 .cm-editor 宿主未被替换",
    report.cmStillMarked ? "PASS" : "FAIL",
    `cm 标记存活=${report.cmStillMarked}；.cm-content 标记存活=${report.contentStillMarked}；DOM 增删=${JSON.stringify(report.mutations)}`);
  ui.add("2", "打字期间收到 5 次 keydown", report.keydownCount >= 5 ? "PASS" : "FAIL", `keydown=${report.keydownCount}`);
  ui.add("3", "打字期间收到 5 次 beforeinput", report.beforeInputCount >= 5 ? "PASS" : "FAIL", `beforeinput=${report.beforeInputCount}`);
  ui.add("4", "打字期间收到 5 次 input", report.inputCount >= 5 ? "PASS" : "FAIL", `input=${report.inputCount}`);
  ui.add("5", "★ 5 个字符全部落地", lenAfter - lenBefore >= 5 ? "PASS" : "FAIL",
    `长度 ${lenBefore} → ${lenAfter}（Δ${lenAfter - lenBefore}）`);
  ui.add("6", "打字期间未发生 focusout", report.focusoutCount === 0 ? "PASS" : "FAIL",
    `focusout=${report.focusoutCount}；当前焦点=${report.activeTag}`);
  ui.log("[remount] 事件序列: " + JSON.stringify(report.events));

  await ui.shot("host-remount");
});
