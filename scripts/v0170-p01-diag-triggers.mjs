/**
 * P0-1 修复侧诊断②：**「重建」的第二个触发源到底是什么**
 *
 * Lead 报告实测 `4 次输入 → del=8`（每次内容变化重建 2 次）。上一发诊断
 * （v0170-p01-diag-layers）在"点击后再输入"的分解里只看到 1 次，说明
 * 第二个 1 次很可能来自**点击本身**（焦点变化）而不是内容变化。
 *
 * 本探针按事件类型逐项隔离计数：
 *   A. 纯点击编辑区（不改内容）
 *   B. 纯打字（已聚焦，不点击）
 *   C. 点击 + 打字（Lead 的 E2 复合动作）
 *   D. 纯内容程序化变化（不走键盘）
 *
 * 判定依据：**.cm-editor 在宿主内的 del/add**。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 触发源分解", "", "正文一。", "", "正文二。", ""].join("\n");

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

const install = async (ui) => ui.ev(`
  window.__CNT = { del: 0, add: 0, log: [] };
  const host = document.querySelector(".source-editor-cm6");
  if (!host) return false;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.removedNodes || []) {
        if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) { window.__CNT.del++; window.__CNT.log.push("del"); }
      }
      for (const n of m.addedNodes || []) {
        if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) { window.__CNT.add++; window.__CNT.log.push("add"); }
      }
    }
  });
  mo.observe(host, { childList: true, subtree: false });
  return true;
`);
const reset = async (ui) => ui.ev(`window.__CNT = { del: 0, add: 0, log: [] }; return true;`);
const readCnt = async (ui) => ui.ev(`return window.__CNT`);
const activeTag = async (ui) => ui.ev(`return document.activeElement ? document.activeElement.tagName + "." + String(document.activeElement.className||"").split(" ")[0] : null`);

await runProbe({ name: "v0170-p01-diag-triggers", doc: DOC, docTitle: "触发源分解" }, async (ui) => {
  await install(ui);

  /* ── A：纯点击（内容不变）── */
  await reset(ui);
  const beforeA = await activeTag(ui);
  await clickContent(ui);
  await ui.sleep(700);
  const a = await readCnt(ui);
  const afterA = await activeTag(ui);
  ui.log(`[A] 纯点击：重建=${JSON.stringify(a)}；焦点 ${beforeA} → ${afterA}`);
  ui.add("A", "纯点击编辑区（内容不变）→ 重建次数", a.del === 0 ? "PASS" : "KNOWN",
    `del=${a.del} add=${a.add}；焦点 ${beforeA} → ${afterA}`);

  /* ── B：纯打字（已聚焦，不点击）── */
  await reset(ui);
  const lenB0 = ((await ui.readSourceText()) || "").length;
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "P", text: "P", unmodifiedText: "P" });
  await ui.sleep(900);
  const b = await readCnt(ui);
  const lenB1 = ((await ui.readSourceText()) || "").length;
  ui.log(`[B] 纯打字：重建=${JSON.stringify(b)}；长度 ${lenB0}→${lenB1}`);
  ui.add("B", "纯打字 1 字符（内容变化 1 次）→ 重建次数", "KNOWN",
    `del=${b.del} add=${b.add}；长度 ${lenB0}→${lenB1}`);

  /* ── C：点击 + 打字（Lead E2 的复合动作）── */
  await reset(ui);
  await clickContent(ui);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Q", text: "Q", unmodifiedText: "Q" });
  await ui.sleep(1200);
  const c = await readCnt(ui);
  ui.log(`[C] 点击+打字：重建=${JSON.stringify(c)}`);
  ui.add("C", "★ 点击 + 打字（一次复合动作）→ 重建次数", "KNOWN",
    `del=${c.del} add=${c.add} → ${c.del === 1 ? "只由内容变化贡献 1 次" : c.del === 2 ? "点击与内容各贡献 1 次（第二源 = 焦点/点击）" : "其它"}`);

  /* ── C2：再点一次（不输入），确认点击是否真的每次都贡献 ── */
  await reset(ui);
  await clickContent(ui);
  await ui.sleep(700);
  const c2 = await readCnt(ui);
  ui.add("C2", "第二次纯点击 → 重建次数", c2.del === 0 ? "PASS" : "KNOWN", `del=${c2.del} add=${c2.add}`);

  /* ── D：滚轮/滚动（不改内容）── */
  await reset(ui);
  await ui.ev(`const sc = document.querySelector(".cm-scroller"); if (sc) sc.scrollTop = 30; return true;`);
  await ui.sleep(700);
  const d = await readCnt(ui);
  ui.add("D", "仅滚动（内容不变）→ 重建次数", d.del === 0 ? "PASS" : "KNOWN", `del=${d.del} add=${d.add}`);

  /* ── 汇总 ── */
  ui.add("E", "★ 结论：第二个重建触发源", "KNOWN",
    `点击=${a.del}+${c2.del} 打字=${b.del} 点击+打字=${c.del} → ` +
    (a.del === 0 && c2.del === 0
      ? "点击不重建；Lead 的 del=8 中第二个来源不是点击，需继续查"
      : "点击本身也触发重建（焦点/点击路径）"));

  await ui.shot("triggers");
});
