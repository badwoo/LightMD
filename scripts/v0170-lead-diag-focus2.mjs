/**
 * Lead 诊断 2：**焦点是否在每次输入后丢失**？
 *
 * 上一轮发现：Input.insertText 之后 document.activeElement 变成 BODY。
 * 必须区分两种情况：
 *   (a) 真实打字（CDP dispatchKeyEvent char）也丢焦点 → **严重缺陷**（用户打一个字就没法继续）
 *   (b) 只有 Input.insertText 丢焦点 → CDP 路径差异，不算产品缺陷
 *
 * 另外验证：丢焦点后能否恢复（再次点击/聚焦），以及文本是否真的落地。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 焦点保持验证", "", "第一段正文。", "", "第二段正文。", ""].join("\n");

const focusState = async (ui) => ui.ev(`
  const a = document.activeElement;
  const content = document.querySelector(".cm-content");
  return {
    activeTag: a ? a.tagName : null,
    activeCls: a ? String(a.className || "").slice(0, 40) : null,
    isContent: a === content,
    isBody: a === document.body,
    textLen: (() => { const cm = document.querySelector(".cm-editor");
      return cm ? Array.from(cm.querySelectorAll(".cm-line")).map(l=>l.textContent||"").join("\\n").length : null; })(),
  };
`);

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

await runProbe({ name: "v0170-lead-diag-focus2", doc: DOC, docTitle: "焦点保持验证" }, async (ui) => {
  await clickContent(ui);

  // ── A. 真实打字路径：连续 5 个 char 事件，每次检查焦点 ──
  const seq = [];
  for (const ch of ["1", "2", "3", "4", "5"]) {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(260);
    const st = await focusState(ui);
    seq.push({ ch, ...st });
  }
  ui.log("[A] char 逐字：" + JSON.stringify(seq));
  const aFocusHeld = seq.every((s) => s.isContent);
  const aTextLanded = (seq[seq.length - 1].textLen || 0) > 23;
  ui.add("A1", "真实打字路径：每次按键后焦点仍在编辑区", aFocusHeld ? "PASS" : "FAIL",
    seq.map((s) => `${s.ch}→${s.activeTag}`).join(" "));
  ui.add("A2", "真实打字路径：文本已落地", aTextLanded ? "PASS" : "FAIL", `末次长度=${seq[seq.length - 1].textLen}`);
  const afterA = await ui.readSourceText();
  ui.log("[A] 文本片段: " + JSON.stringify((afterA || "").slice(0, 40)));

  // ── B. Input.insertText 路径 ──
  await clickContent(ui);
  const beforeB = await focusState(ui);
  await ui.cdp.send("Input.insertText", { text: "XY" });
  await ui.sleep(600);
  const afterB = await focusState(ui);
  ui.log("[B] insertText 前后焦点: " + JSON.stringify({ beforeB, afterB }));
  ui.add("B1", "insertText 路径焦点保持（CDP 专有路径）", afterB.isContent ? "PASS" : "KNOWN",
    `前=${beforeB.activeTag} 后=${afterB.activeTag}`);

  // B2: 丢焦点后能否自愈（再打一个字看是否还被接收）
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Z", text: "Z", unmodifiedText: "Z" });
  await ui.sleep(500);
  const t2 = await ui.readSourceText();
  ui.add("B2", "insertText 丢焦点后，再打字是否被接收", (t2 || "").includes("Z") ? "PASS" : "KNOWN",
    `含Z=${(t2 || "").includes("Z")}`);

  // ── C. 重新点击 → 焦点恢复 → 真实打字 ──
  await clickContent(ui);
  const c0 = await focusState(ui);
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "Q", text: "Q", unmodifiedText: "Q" });
  await ui.sleep(400);
  const t3 = await ui.readSourceText();
  ui.add("C1", "重新点击后焦点恢复且可继续打字", c0.isContent && (t3 || "").includes("Q") ? "PASS" : "FAIL",
    `focus=${c0.activeTag} 含Q=${(t3 || "").includes("Q")}`);

  // ── D. Enter 换行（在焦点正确的前提下）──
  const linesBefore = ((await ui.readSourceText()) || "").split("\n").length;
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(500);
  const linesAfter = ((await ui.readSourceText()) || "").split("\n").length;
  ui.add("D1", "Enter 换行生效", linesAfter > linesBefore ? "PASS" : "FAIL", `行数 ${linesBefore} → ${linesAfter}`);

  // ── E. "/" 行首触发 Slash（焦点正确的真实路径）──
  await focusState(ui);
  const slashBefore = await ui.readSourceText();
  await ui.cdp.send("Input.insertText", { text: "/" });
  await ui.sleep(1000);
  const slashAfter = await ui.readSourceText();
  const menu = await ui.ev(`
    const els = Array.from(document.querySelectorAll("[class*='slash' i]"));
    const vis = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return { total: els.length, visible: vis.length, cls: [...new Set(els.map(e => e.className))].slice(0,5) };
  `);
  ui.add("E1", "“/” 插入后源码含 /", (slashAfter || "").includes("/") ? "PASS" : "FAIL",
    `前末20=${JSON.stringify((slashBefore || "").slice(-20))} 后末20=${JSON.stringify((slashAfter || "").slice(-20))}`);
  ui.add("E2", "Slash 菜单出现", menu.visible > 0 ? "PASS" : "FAIL", JSON.stringify(menu));
  await ui.shot("focus-final");
});
