/**
 * Lead 诊断：CM6 下键盘输入 / 焦点 / 光标定位 / 状态栏行列 到底怎么表现。
 * 目的：把「/ 没插入」这件事定位到具体环节（焦点？insertText？Enter？）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 焦点诊断", "", "第一段正文。", "", "第二段正文。", ""].join("\n");

const state = async (ui, label) => {
  const s = await ui.ev(`
    const cm = document.querySelector(".cm-editor");
    const content = document.querySelector(".cm-content");
    const status = document.querySelector("[class*='status']");
    const sel = window.getSelection();
    return {
      active: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
      contentFocus: document.activeElement === content,
      cmTextLen: cm ? Array.from(cm.querySelectorAll(".cm-line")).map(l=>l.textContent||"").join("\\n").length : null,
      cmLines: cm ? cm.querySelectorAll(".cm-line").length : null,
      selectionAnchor: sel && sel.anchorNode ? (sel.anchorNode.nodeName + ":" + sel.anchorOffset) : null,
      hasSelection: !!(sel && sel.rangeCount),
      statusText: status ? (status.textContent || "").replace(/\\s+/g, " ").slice(0, 120) : null,
      bodyStatus: (document.body.textContent || "").match(/\\d+\\s*字[^|]{0,30}/)?.[0] || null,
    };
  `);
  ui.log(`[state] ${label}: ` + JSON.stringify(s));
  return s;
};

await runProbe({ name: "v0170-lead-diag-focus", doc: DOC, docTitle: "焦点诊断" }, async (ui) => {
  await state(ui, "装入后（未聚焦）");

  // 方法A：纯 DOM focus()
  await ui.ev(`const c = document.querySelector(".cm-content"); if (c) c.focus(); return true;`);
  await ui.sleep(400);
  await state(ui, "DOM focus() 后");

  // 方法B：真实鼠标点击内容区
  const box = await ui.ev(`
    const c = document.querySelector(".cm-content");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) };
  `);
  if (box) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  }
  await ui.sleep(500);
  await state(ui, "鼠标点击后");

  // 尝试 insertText "AB"
  await ui.cdp.send("Input.insertText", { text: "AB" });
  await ui.sleep(600);
  const t1 = await ui.readSourceText();
  ui.log("[diag] insertText 后文本长度=" + (t1 || "").length);
  ui.add("1", "Input.insertText 能写入 CM6", (t1 || "").includes("AB") ? "PASS" : "FAIL",
    `含AB=${(t1 || "").includes("AB")}`);
  await state(ui, "insertText 后");

  // 尝试逐字符 char 事件
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "C", text: "C", unmodifiedText: "C" });
  await ui.sleep(500);
  const t2 = await ui.readSourceText();
  ui.add("2", "char 事件能写入 CM6", (t2 || "").includes("C") ? "PASS" : "FAIL",
    `含C=${(t2 || "").includes("C")}；长度=${(t2 || "").length}`);

  // Enter
  const beforeEnter = (t2 || "").split("\n").length;
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(500);
  const t3 = await ui.readSourceText();
  ui.add("3", "Enter 能换行", (t3 || "").split("\n").length > beforeEnter ? "PASS" : "FAIL",
    `行数 ${beforeEnter} → ${(t3 || "").split("\n").length}`);

  // "/" 字符
  const beforeSlash = (t3 || "");
  await ui.cdp.send("Input.insertText", { text: "/" });
  await ui.sleep(800);
  const t4 = await ui.readSourceText();
  ui.log("[diag] 插入 / 后: " + JSON.stringify((t4 || "").slice(-30)));
  ui.add("4", "“/” 能写入 CM6", (t4 || "").length > beforeSlash.length ? "PASS" : "FAIL",
    `前=${beforeSlash.length} 后=${(t4 || "").length}`);
  await state(ui, "插入 / 后");
  await ui.shot("after-slash");

  // 状态栏行列是否随光标更新（用户可见）
  const pos = await ui.ev(`
    const txt = document.body.textContent || "";
    const m = txt.match(/行\\s*(\\d+)\\s*列\\s*(\\d+)/);
    return { match: m ? m[0] : null };
  `);
  ui.add("5", "状态栏显示光标行列（用户可见）", pos && pos.match ? "PASS" : "FAIL", JSON.stringify(pos));
});
