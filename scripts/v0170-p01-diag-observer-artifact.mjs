/**
 * P0-1 修复侧诊断③：**验证「单次内容变化重建 2~3 次」是否是探针本身的重叠观察器假象**
 *
 * ## 怀疑来源
 *
 * `scripts/v0170-lead-rootcause.mjs` 与 `v0170-lead-user-symptom.mjs` 里有一个
 * `installCounter()`，它每次都：
 * ```js
 * window.__RM = { del: 0, add: 0 };          // 重置计数
 * const mo = new MutationObserver(...);      // 新建观察器
 * mo.observe(host, {...});                   // ← 挂在同一个 host 上
 * window.__MO = mo;                          // ← 旧观察器只是被"忘掉"，从未 disconnect
 * ```
 * → **旧观察器仍然存活且仍然在 `window.__RM` 上累加**。
 *
 * 于是第 N 次 `installCounter()` 之后，单个 `.cm-editor` 替换会被
 * **N 个观察器各计一次** → 计数 = 真实次数 × N。
 *
 * 这正好对上 Lead 报告里的数字：
 * | 探针阶段 | installCounter 累计次数 | 报告值 | 真实值（差值） |
 * |---|---|---|---|
 * | rootcause [A] 光标移动 | 1 | del=0 | 0 ✔ |
 * | rootcause [B] 输入 1 字符 | 2 | del=2 | **1** |
 * | rootcause [C] 撤销 | 3 | del=3 | **1** |
 * | rootcause [D] 滚动 | 4 | del=0 | 0 ✔ |
 * | user-symptom [E2] 4 字符 | 2 | del=8 | **4** |
 *
 * 本探针用**受控实验**证明这件事：
 *   1. 装 1 个观察器 → 输入 1 字符 → 记 `del`；
 *   2. 再装 2 个（共 3 个，模拟重复调用）→ 输入 1 字符 → 记 `del`；
 *   3. 全部 disconnect 后装 1 个干净观察器 → 输入 1 字符 → 记 `del`。
 *
 * 若 (1)=1、(2)=3、(3)=1，则「重建 N 次」纯属观察器叠加，**不存在第二处重建源**。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 观察器叠加验证", "", "正文一。", "", "正文二。", ""].join("\n");

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

/** 干净重装：先 disconnect 所有旧观察器，再装 count 个 */
const reinstall = async (ui, count) => ui.ev(`
  (window.__MOS || []).forEach((mo) => { try { mo.disconnect(); } catch (e) {} });
  window.__MOS = [];
  window.__RM = { del: 0, add: 0, events: [] };
  const host = document.querySelector(".source-editor-cm6");
  if (!host) return false;
  for (let i = 0; i < ${count}; i++) {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) { window.__RM.del++; window.__RM.events.push("del"); }
        for (const n of m.addedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) { window.__RM.add++; window.__RM.events.push("add"); }
      }
    });
    mo.observe(host, { childList: true, subtree: false });
    window.__MOS.push(mo);
  }
  return window.__MOS.length;
`);

const readCnt = async (ui) => ui.ev(`return window.__RM`);

/**
 * 输入 1 个字符并确保它真的落地。
 *
 * ⚠️ 必须先点击：上一发实测证明"内容变化 → 重建 → 焦点掉到 BODY → 下一个字符不落地
 * → 内容没变 → 不再重建"。若不在每字符前点击，第 2 个字符根本不会改变内容，
 * 于是计数为 0（那不是"没有重建"，而是"没有输入"）。
 */
const typeOneLanded = async (ui, ch) => {
  await clickContent(ui);
  const before = ((await ui.readSourceText()) || "").length;
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
  await ui.sleep(850);
  const after = ((await ui.readSourceText()) || "").length;
  return { before, after, landed: after > before };
};

await runProbe({ name: "v0170-p01-diag-observer-artifact", doc: DOC, docTitle: "观察器叠加验证" }, async (ui) => {
  await clickContent(ui);

  /* ── ① 1 个观察器 ── */
  const n1 = await reinstall(ui, 1);
  const t1 = await typeOneLanded(ui, "A");
  const c1 = await readCnt(ui);
  ui.log(`[①] 观察器=${n1}，输入 1 字符 → 落地=${t1.landed}(${t1.before}→${t1.after}) del=${c1.del} add=${c1.add} events=${JSON.stringify(c1.events)}`);

  /* ── ② 3 个观察器（模拟 installCounter 被调用 3 次）── */
  const n2 = await reinstall(ui, 3);
  const t2 = await typeOneLanded(ui, "B");
  const c2 = await readCnt(ui);
  ui.log(`[②] 观察器=${n2}，输入 1 字符 → 落地=${t2.landed}(${t2.before}→${t2.after}) del=${c2.del} add=${c2.add} events=${JSON.stringify(c2.events)}`);

  /* ── ③ 回到 1 个干净观察器 ── */
  const n3 = await reinstall(ui, 1);
  const t3 = await typeOneLanded(ui, "C");
  const c3 = await readCnt(ui);
  ui.log(`[③] 观察器=${n3}，输入 1 字符 → 落地=${t3.landed}(${t3.before}→${t3.after}) del=${c3.del} add=${c3.add} events=${JSON.stringify(c3.events)}`);

  /* ── ④ 0 个观察器（对照：无测量）── */
  await reinstall(ui, 0);
  const t4 = await typeOneLanded(ui, "D");
  const c4 = await readCnt(ui);
  ui.log(`[④] 观察器=0，输入 1 字符 → 落地=${t4.landed}(${t4.before}→${t4.after}) del=${c4.del} add=${c4.add}`);

  ui.add("O1", "1 个观察器：输入 1 字符的真实重建次数",
    c1.del === 1 ? "PASS" : "KNOWN", `落地=${t1.landed}；del=${c1.del} add=${c1.add}`);
  ui.add("O2", "★ 3 个重叠观察器：同一事件被计 3 倍",
    c2.del === 3 ? "PASS" : "KNOWN",
    `del=${c2.del}（= 真实 1 次 × 3 个观察器）→ 若 =3 则证实「N 次重建」是探针假象`);
  ui.add("O3", "disconnect 后回到 1 个观察器：恢复 1 次",
    c3.del === 1 ? "PASS" : "KNOWN", `del=${c3.del} add=${c3.add}`);
  ui.add("O4", "0 观察器对照（不可能有计数）", c4.del === 0 ? "PASS" : "FAIL", `del=${c4.del}`);
  ui.add("O5", "★ 结论：是否存在「第二处重建源」",
    c1.del === 1 && c2.del === 3 && c3.del === 1 ? "PASS" : "KNOWN",
    c1.del === 1 && c2.del === 3 && c3.del === 1
      ? "不存在。单次内容变化精确重建 1 次；「2~3 次」= 重叠 MutationObserver 重复计数（测量假象）"
      : `不符合叠加假说：${c1.del}/${c2.del}/${c3.del}`);

  await ui.shot("observer-artifact");
});
