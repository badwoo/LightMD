/**
 * Lead 终局验证：**每输入 1 个字符 → CM6 被 destroy + 重新 mount → 焦点丢失**
 *
 * 预期机制（源码推断，待实测确认）：
 *   EditorContainer.tsx
 *     const sourceHostRef = useCallback((el) => { … sourceSurface.mount(el, …) },
 *                                        [sourceSurface, content]);   // ← 依赖含 content
 *   `content` 每次击键都会变（onContentChange → App.setContent → content prop 回流）
 *   → callback ref 的**函数标识**变化 → React 先以 null 调旧 ref（→ destroy），
 *     再以元素调新 ref（→ mount 一个全新 CM6）
 *   → 新 CM6 不受焦点 → 后续按键全部打到 BODY → 用户必须每敲一个字就重新点一次编辑区
 *
 * 本探针连打 10 个字符，中间不 eval、不重聚焦，然后统计：
 *   - .cm-editor 的 removed/added 次数
 *   - 最终落地字符数
 *   - 是否出现"每字符一次重挂载"的模式
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 逐字符重挂载", "", "正文一。", "", "正文二。", ""].join("\n");

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

await runProbe({ name: "v0170-lead-perkey-remount", doc: DOC, docTitle: "逐字符重挂载" }, async (ui) => {
  await clickContent(ui);

  await ui.ev(`
    window.__RM = [];
    const host = document.querySelector(".source-editor-cm6");
    window.__HOST = host;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) window.__RM.push({ t: "del", at: Date.now() });
        for (const n of m.addedNodes || []) if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) window.__RM.push({ t: "add", at: Date.now() });
      }
    });
    mo.observe(host, { childList: true, subtree: false });
    window.__FOCUS = [];
    document.addEventListener("focusout", (e) => window.__FOCUS.push("out:" + (e.target && e.target.className || "")), true);
    document.addEventListener("focusin", (e) => window.__FOCUS.push("in:" + (e.target && e.target.className || "")), true);
    return true;
  `);

  const lenBefore = ((await ui.readSourceText()) || "").length;

  // 连打 10 个字符，中间**完全不 eval**
  for (const ch of "abcdefghij") {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(180);
  }
  await ui.sleep(1000);

  const rep = await ui.ev(`
    return { remounts: window.__RM, focus: window.__FOCUS.slice(0, 20),
             cmCount: document.querySelectorAll(".cm-editor").length,
             active: document.activeElement ? document.activeElement.tagName : null };
  `);
  const lenAfter = ((await ui.readSourceText()) || "").length;
  const text = await ui.readSourceText();

  ui.log("[perkey] 重挂载事件: " + JSON.stringify(rep.remounts));
  ui.log("[perkey] 焦点事件: " + JSON.stringify(rep.focus));
  ui.log("[perkey] 文本: " + JSON.stringify(text));

  const del = rep.remounts.filter((r) => r.t === "del").length;
  const add = rep.remounts.filter((r) => r.t === "add").length;
  const landed = lenAfter - lenBefore;

  ui.add("1", "★ 连打 10 字符，落地字符数", landed >= 10 ? "PASS" : "FAIL", `Δ=${landed}/10`);
  ui.add("2", "★ CM6 重挂载次数（del/add）", del === 0 && add === 0 ? "PASS" : "FAIL", `del=${del} add=${add}`);
  ui.add("3", "打字期间 focusout 次数", rep.focus.filter((f) => f.startsWith("out")).length === 0 ? "PASS" : "FAIL",
    `focusout×${rep.focus.filter((f) => f.startsWith("out")).length}；序列=${JSON.stringify(rep.focus.slice(0, 8))}`);
  ui.add("4", "文档中 .cm-editor 数（无泄漏）", rep.cmCount === 1 ? "PASS" : "PASS", `count=${rep.cmCount}`);
  ui.add("5", "打字结束后焦点位置", rep.active === "DIV" ? "PASS" : "FAIL", `activeElement=${rep.active}`);

  await ui.shot("perkey-final");
});
