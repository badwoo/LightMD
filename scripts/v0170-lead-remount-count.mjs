/**
 * Lead：确证「每打一个字 CM6 是否被 destroy + 重新 mount」。
 *
 * 线索链：
 *   - 打字后 .cm-content / .cm-editor 上的自定义 dataset 标记消失 → 节点被换成了新节点
 *   - 同一时机发生 focusout，焦点落到 BODY
 *   - 5 个字符只落地 1 个
 *
 * 可疑代码（EditorContainer.tsx）：
 *   const sourceHostRef = useCallback((el) => { ... sourceSurface.mount(el, ...) },
 *                                      [sourceSurface, content]);   // ← 依赖里有 content
 *   `content` 每次击键都会变（onContentChange → App.setContent → prop 回流），
 *   callback ref 的**函数标识变化**会让 React 先以 null 调用旧 ref（→ destroy），
 *   再以元素调用新 ref（→ mount）。
 *
 * 本探针在宿主 div 自身挂 MutationObserver（subtree:true），直接数 .cm-editor 的增删次数。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 重挂载计数", "", "正文一。", "", "正文二。", ""].join("\n");

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

await runProbe({ name: "v0170-lead-remount-count", doc: DOC, docTitle: "重挂载计数" }, async (ui) => {
  await clickContent(ui);

  await ui.ev(`
    window.__RM = { removed: 0, added: 0, log: [] };
    const host = document.querySelector(".source-editor-cm6");
    if (!host) return { err: "no host" };
    window.__HOST = host;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes || []) {
          if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) { window.__RM.removed++; window.__RM.log.push("removed cm-editor"); }
        }
        for (const n of m.addedNodes || []) {
          if (n.nodeType === 1 && String(n.className||"").indexOf("cm-editor") >= 0) { window.__RM.added++; window.__RM.log.push("added cm-editor"); }
        }
      }
    });
    mo.observe(host, { childList: true, subtree: true });
    window.__MO = mo;
    return { hostChildren: host.children.length, hostCls: String(host.className) };
  `);

  const before = await ui.ev(`
    return { cmCount: document.querySelectorAll(".cm-editor").length,
             hostChildCount: window.__HOST ? window.__HOST.children.length : -1 };
  `);
  ui.log("[rm] 初始: " + JSON.stringify(before));

  const lenBefore = ((await ui.readSourceText()) || "").length;

  // 打 3 个字符
  for (const ch of ["A", "B", "C"]) {
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
    await ui.sleep(350);
  }
  await ui.sleep(900);

  const after = await ui.ev(`
    return {
      removed: window.__RM.removed,
      added: window.__RM.added,
      log: window.__RM.log.slice(0, 12),
      cmCountNow: document.querySelectorAll(".cm-editor").length,
      hostChildCount: window.__HOST ? window.__HOST.children.length : -1,
      hostStillInDoc: !!document.querySelector(".source-editor-cm6"),
    };
  `);
  const lenAfter = ((await ui.readSourceText()) || "").length;

  ui.log("[rm] 结果: " + JSON.stringify(after, null, 1));
  ui.add("1", "打字 3 字符期间 .cm-editor 未被移除重建",
    after.removed === 0 && after.added === 0 ? "PASS" : "FAIL",
    `removed=${after.removed} added=${after.added}；宿主子节点 ${before.hostChildCount} → ${after.hostChildCount}`);
  ui.add("2", "文档中始终只有 1 个 .cm-editor（无泄漏）", after.cmCountNow === 1 ? "PASS" : "FAIL", `count=${after.cmCountNow}`);
  ui.add("3", "★ 3 个字符全部落地", lenAfter - lenBefore >= 3 ? "PASS" : "FAIL",
    `长度 ${lenBefore} → ${lenAfter}（Δ${lenAfter - lenBefore}）`);

  await ui.shot("remount-count");
});
