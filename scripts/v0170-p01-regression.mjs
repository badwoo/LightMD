/**
 * P0-1 **回归守卫**：去掉 `content` 依赖后，那些"以前靠重建掩盖"的同步路径
 * 是否仍然正确。
 *
 * ## 为什么必须单独测这件事
 *
 * 修复前 `content` 进依赖 → 每次内容变化都重建 CM6 → **新实例以最新 `initialText`
 * 建 doc**。换句话说，"内容同步"这件事**当时是被"重建"顺带实现的**，
 * `setText` 那条受控同步路径在真机上**几乎没被走到过**（它每次都被紧跟的重建覆盖）。
 *
 * 去掉依赖后重建消失了，内容同步**只能**靠：
 *   `useEffect([sourceContent]) → sourceSurface.setText(sourceContent)`
 * 因此必须实测三条最容易暴露该路径缺陷的场景：
 *
 * | # | 场景 | 期望 |
 * |---|---|---|
 * | R1 | 打开**另一个**文档 | 源码面显示新文档内容（不是旧的、不是空白） |
 * | R2 | 切到阅读模式再切回编辑 | 内容保持，且仍只有一个 `.cm-editor` |
 * | R3 | 同一文档内连续输入后立即切换文档 | 新文档内容完整、无残留字符 |
 * | R4 | 程序化整篇替换（`lightmd:openFile`）后打字 | 输入落点正确、不丢失 |
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC_A = ["# 回归守卫A", "", "A 文档第一段。", "", "A 文档第二段。", ""].join("\n");
const DOC_B = ["# 回归守卫B", "", "B 文档内容，与 A 完全不同。", ""].join("\n");

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
  await ui.sleep(300);
  return true;
};

const openDoc = async (ui, name, content) => {
  await ui.ev(`
    window.dispatchEvent(new CustomEvent("lightmd:openFile", {
      detail: { path: "D:\\\\AI\\\\markdown view\\\\lightmd\\\\_verify-out\\\\tmp\\\\" + ${JSON.stringify(name)} + ".md",
                name: ${JSON.stringify(name)} + ".md", content: ${JSON.stringify(content)} },
    }));
    return true;
  `);
  await ui.sleep(1600);
};

const cmState = async (ui) => ui.ev(`
  const cm = document.querySelector(".cm-editor");
  if (!cm) return { cmCount: document.querySelectorAll(".cm-editor").length, text: null };
  const ls = Array.from(cm.querySelectorAll(".cm-line")).map((l) => l.textContent || "");
  return { cmCount: document.querySelectorAll(".cm-editor").length, text: ls.join("\\n"),
           lines: ls.length, active: document.activeElement ? document.activeElement.tagName : null };
`);

await runProbe({ name: "v0170-p01-regression", doc: DOC_A, docTitle: "回归守卫A" }, async (ui) => {
  /* ══ R0：初始文档正确 ══ */
  const s0 = await cmState(ui);
  ui.log(`[R0] 初始：${JSON.stringify({ cmCount: s0.cmCount, lines: s0.lines })} / text=${JSON.stringify((s0.text || "").slice(0, 40))}`);
  ui.add("R0", "初始文档 A 已正确装入源码面",
    (s0.text || "").includes("回归守卫A") && s0.cmCount === 1 ? "PASS" : "FAIL",
    `cmCount=${s0.cmCount}；含标题A=${(s0.text || "").includes("回归守卫A")}`);

  /* ══ R1：切到另一个文档（内容同步只能靠 setText 路径）══ */
  await openDoc(ui, "regB", DOC_B);
  const s1 = await cmState(ui);
  const hasB = (s1.text || "").includes("回归守卫B");
  const stillA = (s1.text || "").includes("回归守卫A");
  ui.log(`[R1] 切到 B：cmCount=${s1.cmCount} 含B=${hasB} 残留A=${stillA} / text=${JSON.stringify((s1.text || "").slice(0, 60))}`);
  ui.add("R1", "★ 打开另一文档后源码面显示新内容（不残留旧文档 / 不空白）",
    hasB && !stillA && s1.cmCount === 1 ? "PASS" : "FAIL",
    `含B=${hasB} 残留A=${stillA} cmCount=${s1.cmCount}`);

  /* ══ R2：在 B 上打字 → 必须落地且不重建 ══ */
  await clickContent(ui);
  await ui.ev(`(window.__MOS||[]).forEach(m=>{try{m.disconnect()}catch(e){}}); window.__MOS=[];
    window.__RM={del:0,add:0};
    const h=document.querySelector(".source-editor-cm6");
    const mo=new MutationObserver(ms=>{for(const m of ms){for(const n of m.removedNodes||[])if(n.nodeType===1&&String(n.className||"").indexOf("cm-editor")>=0)window.__RM.del++;for(const n of m.addedNodes||[])if(n.nodeType===1&&String(n.className||"").indexOf("cm-editor")>=0)window.__RM.add++;}});
    mo.observe(h,{childList:true,subtree:false}); window.__MOS.push(mo); return true;`);
  const b2 = ((await ui.readSourceText()) || "").length;
  for (const ch of "abc") {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(200);
  }
  await ui.sleep(700);
  const a2 = ((await ui.readSourceText()) || "").length;
  const rm2 = await ui.ev(`return window.__RM`);
  ui.log(`[R2] B 文档连打 3 字符：长度 ${b2}→${a2}；重建=${JSON.stringify(rm2)}`);
  ui.add("R2", "★ 切换文档后连打 3 字符，全部落地且不重建",
    a2 - b2 === 3 && rm2.del === 0 && rm2.add === 0 ? "PASS" : "FAIL",
    `Δ=${a2 - b2}/3；del=${rm2.del} add=${rm2.add}`);

  /* ══ R3：切到阅读模式再切回编辑 ══ */
  await ui.command("view.read");
  await ui.sleep(2000);
  const pmOk = await ui.ev(`
    const pm = document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
    return pm ? (pm.textContent || "").indexOf("回归守卫B") >= 0 : false;
  `);
  await ui.command("view.edit");
  await ui.sleep(2400);
  const split = await ui.ev(`return !!document.querySelector("iframe.split-preview")`);
  if (!split) { await ui.command("view.togglePreview"); await ui.sleep(1800); }
  const s3 = await cmState(ui);
  const hasB3 = (s3.text || "").includes("回归守卫B");
  ui.log(`[R3] 阅读↔编辑：PM含B=${pmOk}；回到编辑 cmCount=${s3.cmCount} 含B=${hasB3}`);
  ui.add("R3", "★ 切阅读模式再切回编辑：内容保持且只有一个 CM6",
    pmOk && hasB3 && s3.cmCount === 1 ? "PASS" : "FAIL",
    `阅读面含B=${pmOk}；编辑面含B=${hasB3}；cmCount=${s3.cmCount}`);

  /* ══ R4：程序化整篇替换后立即打字（替换走 setText，打字走 CM6 原生）══ */
  const DOC_C = "# 回归守卫C\n\nC 文档。\n";
  await openDoc(ui, "regC", DOC_C);
  await clickContent(ui);
  const b4 = ((await ui.readSourceText()) || "").length;
  for (const ch of "XY") {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(220);
  }
  await ui.sleep(700);
  const t4 = await ui.readSourceText();
  const a4 = (t4 || "").length;
  const hasC = (t4 || "").includes("回归守卫C");
  ui.log(`[R4] 整篇替换后打字：长度 ${b4}→${a4}；含C=${hasC} / text=${JSON.stringify((t4 || "").slice(0, 40))}`);
  ui.add("R4", "★ 程序化整篇替换（setText 路径）后立即打字，字符全部落地",
    hasC && a4 - b4 === 2 ? "PASS" : "FAIL",
    `含C=${hasC}；Δ=${a4 - b4}/2`);

  /* ══ R5：确认没有 CM6 实例泄漏 ══ */
  const leak = await cmState(ui);
  ui.add("R5", "全程无 .cm-editor 泄漏", leak.cmCount === 1 ? "PASS" : "FAIL", `cmCount=${leak.cmCount}`);

  await ui.ev(`(window.__MOS||[]).forEach(m=>{try{m.disconnect()}catch(e){}}); window.__MOS=[]; return true;`);
  await ui.shot("regression");
});
