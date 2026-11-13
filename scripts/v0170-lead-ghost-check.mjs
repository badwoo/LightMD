/**
 * Lead 排查：**格式 ghost 占位提示是否丢失**（用户新报告）
 *
 * 假设链：
 *   1. 点格式栏/语法栏按钮 → `handleFormatAction` 设置 `formatGhostRef` →
 *      `requestAnimationFrame(renderFormatGhost)` → `sourceSurface.showGhost(...)`
 *      → CM6 用 `ghostField` Decoration 渲染 `.cm-source-ghost`
 *   2. **P0-1**：内容变化 → callback ref 依赖含 content → React destroy + mount
 *      → `new EditorView({state})` **不含 ghostField 的 ghost 值**（`this.ghost` 未恢复）
 *      → ghost 消失
 *   3. 且重建后 `this.ghost` 仍是非 null，`renderFormatGhost` 的护栏
 *      `getText() !== ghost.content` 可能不成立（内容确实等于快照）→ 但没人再调 render
 *
 * 判定：
 *   G1 ghost 元素是否出现（.cm-source-ghost）
 *   G2 出现后能存活多久（轮询，看是否被重建冲掉）
 *   G3 重建计数与 ghost 消失的时间关系
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# Ghost 排查", "", "第一段正文。", "", "第二段正文。", ""].join("\n");

const clickContent = async (ui) => {
  await ui.ev(`window.__CB = (() => { const c = document.querySelector(".cm-content");
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) }; })(); return true;`);
  const b = await ui.ev(`return window.__CB`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(300);
};

const ghostState = async (ui) => ui.ev(`
  const els = document.querySelectorAll(".cm-source-ghost");
  const ov = document.querySelector(".source-ghost-overlay");
  return {
    cmGhostCount: els.length,
    cmGhostText: els.length ? (els[0].textContent || "") : null,
    cmGhostVisible: els.length ? (() => { const r = els[0].getBoundingClientRect(); return r.width > 0 || r.height > 0; })() : false,
    overlayHtmlLen: ov ? (ov.innerHTML || "").length : -1,
  };
`);

const installRebuildCounter = async (ui) => {
  await ui.ev(`
    window.__RM = { del: 0, add: 0 };
    const host = document.querySelector(".source-editor-cm6");
    if (!host) return false;
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        for (const n of m.removedNodes || []) if (n.nodeType === 1 && String(n.className||"").includes("cm-editor")) window.__RM.del++;
        for (const n of m.addedNodes || []) if (n.nodeType === 1 && String(n.className||"").includes("cm-editor")) window.__RM.add++;
      }
    });
    mo.observe(host, { childList: true, subtree: false });
    return true;
  `);
};

await runProbe({ name: "v0170-lead-ghost-check", doc: DOC, docTitle: "Ghost 排查" }, async (ui) => {
  await installRebuildCounter(ui);

  /* ── G0：基线，无 ghost ── */
  const g0 = await ghostState(ui);
  ui.log("[ghost] 基线: " + JSON.stringify(g0));
  ui.add("G0", "基线：无 ghost 元素（防误报）", g0.cmGhostCount === 0 && g0.overlayHtmlLen === 0 ? "PASS" : "KNOWN",
    JSON.stringify(g0));

  /* ── G1：点 H1 按钮（格式栏 action=h1），光标在空行 ── */
  await clickContent(ui);
  // 光标移到文末空行
  await ui.key("End", "End", 35, 2);
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(300);

  const h1Btn = await ui.ev(`
    const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
    const b = btns.find(x => (x.textContent || "").trim() === "H1");
    if (!b) return { ok: false, count: btns.length, labels: btns.map(x => (x.textContent||"").trim()).slice(0,30) };
    b.click();
    return { ok: true };
  `);
  ui.log("[ghost] H1 点击: " + JSON.stringify(h1Btn));

  /* ── G2：点击后立即密集轮询 ghost（每 60ms 一次，共 40 次 ≈ 2.4s）── */
  const timeline = [];
  for (let i = 0; i < 40; i++) {
    const st = await ghostState(ui);
    const rm = await ui.ev(`return window.__RM`);
    timeline.push({ t: i * 60, n: st.cmGhostCount, txt: st.cmGhostText, ov: st.overlayHtmlLen, del: rm.del });
    await ui.sleep(60);
  }
  const seen = timeline.filter((x) => x.n > 0);
  ui.log("[ghost] 时间线（前20）: " + JSON.stringify(timeline.slice(0, 20)));
  ui.log("[ghost] 出现过 ghost 的采样数: " + seen.length + "/40");
  if (seen.length) {
    ui.log(`[ghost] 首次出现 t=${seen[0].t}ms 文本=${JSON.stringify(seen[0].txt)}；最后出现 t=${seen[seen.length - 1].t}ms`);
  }

  ui.add("G1", "★ 点 H1 后出现 ghost 占位提示（.cm-source-ghost）",
    seen.length > 0 ? "PASS" : "FAIL",
    seen.length > 0
      ? `出现 ${seen.length}/40 次采样；首次 t=${seen[0].t}ms 文本=${JSON.stringify(seen[0].txt)}；最后 t=${seen[seen.length - 1].t}ms`
      : `从未出现；40 次采样内 .cm-source-ghost 恒为 0；overlay 长度=${timeline[0].ov}`);

  ui.add("G2", "★ ghost 是否持续存在（未被重建冲掉）",
    seen.length >= 35 ? "PASS" : seen.length > 0 ? "FAIL" : "FAIL",
    `存活 ${seen.length}/40 采样（≈${Math.round(seen.length * 60)}ms）；同期 CM6 重建 del=${timeline[timeline.length - 1].del}`);

  await ui.shot("ghost-check");

  /* ── G3：直接调 surface.showGhost 绕开触发链，验证 CM6 渲染能力本身是否可用 ── */
  const direct = await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && (c.cmTile ? c.cmTile.view : null);
    if (!v) return { ok: false, reason: "no view" };
    // 试着从 view 找到 surface 不可得；改为直接派发 decoration 不可行。
    // 退而求其次：检查 ghost widget 的 CSS 是否存在于样式表
    let found = false;
    try {
      for (const ss of document.styleSheets) {
        for (const r of ss.cssRules || []) {
          if (r.selectorText && r.selectorText.indexOf("cm-source-ghost") >= 0) { found = true; break; }
        }
      }
    } catch (e) { /* 跨源样式表跳过 */ }
    return { ok: true, cssPresent: found, docLen: v.state.doc.length };
  `);
  ui.add("G3", "CM6 ghost 的 CSS 规则存在（证明样式层已接）", direct?.cssPresent ? "PASS" : "KNOWN", JSON.stringify(direct));
});
