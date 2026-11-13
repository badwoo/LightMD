/**
 * Lead 决定性实验：**用户可见症状 + 机制确认**
 *
 * 假设：`EditorContainer` 里
 *     const sourceHostRef = useCallback((el) => { … mount/destroy … },
 *                                       [sourceSurface, content]);
 *   依赖含 `content`，而 `content` 每次内容变化都会变
 *   → callback ref 函数标识变化 → React 用 null 调旧 ref（destroy）+ 用元素调新 ref（mount）
 *   → **内容每变一次就重建一次 CM6**，焦点随之丢失。
 *
 * 三条独立证据要一次拿齐：
 *   E1 用户流程：打字 →（不点击）再打字 → 第二个字是否丢失
 *   E2 每次重聚焦后打字：每个字符都应落地，且每次内容变化恰对应 1 次重挂载
 *   E3 非打字路径也触发：用「撤销」改内容（不经键盘）是否同样重挂载
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# 用户可见症状", "", "正文一。", "", "正文二。", ""].join("\n");

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

const typeChar = async (ui, ch) => {
  await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, unmodifiedText: ch });
  await ui.sleep(320);
};

await runProbe({ name: "v0170-lead-user-symptom", doc: DOC, docTitle: "用户可见症状" }, async (ui) => {
  // ── E1：用户流程（打字后不点击，继续打字）──
  await clickContent(ui);
  await installCounter(ui);
  const l0 = ((await ui.readSourceText()) || "").length;
  await typeChar(ui, "1");
  const l1 = ((await ui.readSourceText()) || "").length;
  await typeChar(ui, "2");
  await ui.sleep(500);
  const l2 = ((await ui.readSourceText()) || "").length;
  const focusNow = await ui.ev(`return document.activeElement ? document.activeElement.tagName : null`);
  ui.log(`[E1] 长度 ${l0} →(打1) ${l1} →(不点击再打2) ${l2}；焦点=${focusNow}`);
  ui.add("E1.1", "打第 1 个字符后落地", l1 > l0 ? "PASS" : "FAIL", `${l0} → ${l1}`);
  ui.add("E1.2", "★ 不点击直接打第 2 个字符是否落地", l2 > l1 ? "PASS" : "FAIL",
    `${l1} → ${l2}；打完后焦点=${focusNow}（BODY 说明焦点已离开编辑区）`);
  const c1 = await readCount(ui);
  ui.log("[E1] 重挂载累计: " + JSON.stringify(c1));
  ui.add("E1.3", "内容变化触发 CM6 重挂载", c1.del === 0 ? "PASS" : "FAIL", `del=${c1.del} add=${c1.add}`);

  // ── E2：每次重聚焦后打字，验证"内容变化 ⇔ 一次重挂载" ──
  await installCounter(ui); // 重置计数
  const before2 = ((await ui.readSourceText()) || "").length;
  const lands = [];
  for (const ch of ["A", "B", "C", "D"]) {
    await clickContent(ui);          // 每次都重新点进编辑区（模拟用户被迫点击）
    const b = ((await ui.readSourceText()) || "").length;
    await typeChar(ui, ch);
    await ui.sleep(400);
    const a = ((await ui.readSourceText()) || "").length;
    lands.push({ ch, b, a, landed: a > b });
  }
  const after2 = ((await ui.readSourceText()) || "").length;
  const c2 = await readCount(ui);
  ui.log(`[E2] 每字符落地: ${JSON.stringify(lands)}；重挂载=${JSON.stringify(c2)}；总长度 ${before2} → ${after2}`);
  ui.add("E2.1", "★ 每次重新点击后可输入（被迫逐个点击）", lands.every((x) => x.landed) ? "PASS" : "FAIL",
    lands.map((x) => `${x.ch}:${x.landed ? "ok" : "lost"}`).join(" "));
  ui.add("E2.2", "★ 4 次内容变化 → 几次 CM6 重挂载", c2.del === 0 ? "PASS" : "FAIL",
    `del=${c2.del} add=${c2.add}（若 =4 则「内容每变一次重建一次」成立）`);

  // ── E3：非键盘路径（撤销）是否也重挂载 ──
  await installCounter(ui);
  await clickContent(ui);
  await ui.key("z", "KeyZ", 90, 2); // Ctrl+Z
  await ui.sleep(900);
  const c3 = await readCount(ui);
  ui.log("[E3] 撤销后重挂载: " + JSON.stringify(c3));
  ui.add("E3.1", "撤销（非键盘输入路径）也触发重挂载", c3.del === 0 ? "PASS" : "KNOWN",
    `del=${c3.del} add=${c3.add}`);

  await ui.shot("user-symptom");
});
