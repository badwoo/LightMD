/**
 * Lead：**验证 P0-1 的根因假设**（不改源码，用运行时证据）
 *
 * 思路：如果不能改源码，就用「间接但决定性」的证据链：
 *   1. 确认 `content` prop 每次击键都变化（这是 React 层的事实）
 *   2. 确认 callback ref 的函数标识随之变化（用 React DevTools 拿不到，改用行为反证）
 *   3. 反证：**如果内容不变，就不应重建** ——
 *      a) 只移动光标（不改内容）→ 不应重建
 *      b) 内容变化 → 应重建
 *      c) 内容变回原值（撤销）→ 应重建
 *   若 (a) 不重建、(b)/(c) 重建，则「重建由内容变化驱动」成立，
 *   而内容变化 → callback ref 依赖变化是唯一符合 React 语义的解释。
 *
 * 另外测一个**关键推论**：既然每次内容变化都重建，那么
 *   「连续输入 N 字符」在理想修复后应产生 0 次重建且 N 字符全落地。
 *   本探针给出修复前的完整基线数据，供修复后对比。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 根因反证", "", "正文一。", "", "正文二。", ""].join("\n");

const installCounter = async (ui) => {
  await ui.ev(`
    window.__RM = { del: 0, add: 0 };
    const host = document.querySelector(".source-editor-cm6");
    if (!host) return false;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) window.__RM.del++;
        for (const n of m.addedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) window.__RM.add++;
      }
    });
    mo.observe(host, { childList: true, subtree: false });
    window.__MO = mo;
    return true;
  `);
};
const readCount = async (ui) => ui.ev(`return window.__RM || { del: -1, add: -1 }`);

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
  await ui.sleep(400);
  return true;
};

await runProbe({ name: "v0170-lead-rootcause", doc: DOC, docTitle: "根因反证" }, async (ui) => {
  /* ── 反证 a：只移动光标（不改内容）→ 不应重建 ── */
  await clickContent(ui);
  await installCounter(ui);
  const lenA0 = ((await ui.readSourceText()) || "").length;
  await ui.key("ArrowDown", "ArrowDown", 40);
  await ui.key("ArrowRight", "ArrowRight", 39);
  await ui.key("End", "End", 35);
  await ui.key("Home", "Home", 36);
  await ui.sleep(600);
  const cA = await readCount(ui);
  const lenA1 = ((await ui.readSourceText()) || "").length;
  ui.log(`[a] 只移动光标：重建=${JSON.stringify(cA)}，长度 ${lenA0}→${lenA1}`);
  ui.add("A", "反证：只移动光标（内容不变）→ 不重建",
    cA.del === 0 && cA.add === 0 ? "PASS" : "FAIL",
    `del=${cA.del} add=${cA.add}；长度未变=${lenA1 === lenA0}`);

  /* ── 反证 b：内容变化（1 个字符）→ 应重建 ── */
  await installCounter(ui);
  await clickContent(ui);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "X", text: "X", unmodifiedText: "X" });
  await ui.sleep(900);
  const cB = await readCount(ui);
  ui.log(`[b] 输入 1 字符：重建=${JSON.stringify(cB)}`);
  ui.add("B", "反证：内容变化 1 字符 → 发生重建",
    cB.del > 0 ? "PASS" : "FAIL",
    `del=${cB.del} add=${cB.add}（>0 说明"内容变化 → 重建"成立）`);

  /* ── 反证 c：撤销（内容变回去）→ 应重建 ── */
  await installCounter(ui);
  await clickContent(ui);
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1000);
  const cC = await readCount(ui);
  ui.log(`[c] 撤销：重建=${JSON.stringify(cC)}`);
  ui.add("C", "反证：撤销（内容变化）→ 发生重建", cC.del > 0 ? "PASS" : "FAIL", `del=${cC.del} add=${cC.add}`);

  /* ── 反证 d：滚动（不改内容）→ 不应重建 ── */
  await installCounter(ui);
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (sc) { sc.scrollTop = 40; sc.dispatchEvent(new Event("scroll", { bubbles: false })); }
    return true;
  `);
  await ui.sleep(800);
  const cD = await readCount(ui);
  ui.log(`[d] 滚动：重建=${JSON.stringify(cD)}`);
  ui.add("D", "反证：仅滚动（内容不变）→ 不重建", cD.del === 0 ? "PASS" : "FAIL", `del=${cD.del} add=${cD.add}`);

  /* ── 综合推论 ── */
  const sameContentNoRebuild = cA.del === 0 && cD.del === 0;
  const contentChangeRebuild = cB.del > 0 && cC.del > 0;
  ui.add("E", "★ 结论：「重建」严格由「内容变化」驱动，与光标/滚动无关",
    sameContentNoRebuild && contentChangeRebuild ? "PASS" : "KNOWN",
    `内容不变时重建=${cA.del + cD.del} 次；内容变化时重建=${cB.del + cC.del} 次 → ` +
    (sameContentNoRebuild && contentChangeRebuild
      ? "符合「callback ref 依赖含 content」的预测"
      : "与预测不符，需重新定位"));

  await ui.shot("rootcause");
});
