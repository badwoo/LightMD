/**
 * Lead 排查 2：**精确区分 ghost 从未被设置 vs 被重建冲掉**
 *
 * 上一轮 G1 得到 0/40，但存在口径问题：
 *   - H1 的 ghost 只在「当前行除前缀外为空」时设置；
 *   - 我上一轮用 End+Enter 造空行，但 P0-1 会让 Enter 后焦点丢失 → 后续按键无效
 *     → 可能根本没走到「空行」条件。
 *
 * 本轮改为四条独立触发路径，并**在页面内埋观测点**（不依赖轮询采样时机）：
 *   路径 A：行内粗体（选中文本 → 点 B）—— ghost 条件是 result.ghostText 存在
 *   路径 B：H1（光标放在**已知空行**的行首，用行索引定位）
 *   路径 C：语法栏 S04 粗体（insert "****"）
 *   路径 D：直接观测 `formatGhostRef` 是否有值（若能读到）
 *
 * 关键：在页面里挂钩 `MutationObserver` 观察 `.cm-source-ghost` 的**任何**出现，
 * 而不是靠 60ms 轮询（可能错过瞬时出现）。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# Ghost 排查2", "", "alpha HELLO beta", "", "第二段落文字", ""].join("\n");

const clickContent = async (ui, dx = 40, dy = 12) => {
  await ui.ev(`window.__CB = (() => { const c = document.querySelector(".cm-content");
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + ${dx}), y: Math.round(r.top + ${dy}) }; })(); return true;`);
  const b = await ui.ev(`return window.__CB`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(320);
};

const installGhostWatch = async (ui) => {
  await ui.ev(`
    window.__GHOST = { seen: [], rebuild: { del: 0, add: 0 } };
    // 任何 .cm-source-ghost 出现都记下来（含瞬时）
    const mo = new MutationObserver(() => {
      const els = document.querySelectorAll(".cm-source-ghost");
      if (els.length) {
        const txt = els[0].textContent || "";
        const last = window.__GHOST.seen[window.__GHOST.seen.length - 1];
        if (!last || last.txt !== txt || last.n !== els.length) {
          window.__GHOST.seen.push({ t: Date.now(), n: els.length, txt, html: els[0].outerHTML.slice(0, 200) });
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    window.__GHOST.mo = mo;
    // 同时监听宿主重建
    const host = document.querySelector(".source-editor-cm6");
    if (host) {
      const mo2 = new MutationObserver((ms) => {
        for (const m of ms) {
          for (const n of m.removedNodes || []) if (n.nodeType === 1 && String(n.className||"").includes("cm-editor")) window.__GHOST.rebuild.del++;
          for (const n of m.addedNodes || []) if (n.nodeType === 1 && String(n.className||"").includes("cm-editor")) window.__GHOST.rebuild.add++;
        }
      });
      mo2.observe(host, { childList: true, subtree: false });
    }
    return true;
  `);
};

const readGhostLog = async (ui) => ui.ev(`
  return { seen: (window.__GHOST.seen || []).map(x => ({ n: x.n, txt: x.txt, html: x.html })), rebuild: window.__GHOST.rebuild };
`);

const resetLog = async (ui) => ui.ev(`window.__GHOST.seen = []; return true;`);

/** 用状态栏行列把光标精确放到某一行行首（不依赖点击坐标猜测） */
const caretToLine = async (ui, lineText, atStart = true) => {
  const r = await ui.ev(`
    const ed = document.querySelector(".cm-editor");
    const lines = Array.from(ed.querySelectorAll(".cm-line"));
    const target = lines.find(l => (l.textContent || "").includes(${JSON.stringify(lineText)}));
    if (!target) return { ok: false, texts: lines.map(l => (l.textContent||"").slice(0,20)) };
    const rect = target.getBoundingClientRect();
    const x = ${atStart} ? Math.round(rect.left + 2) : Math.round(rect.left + rect.width / 2);
    window.__T = { x, y: Math.round(rect.top + rect.height / 2) };
    return { ok: true, x, y: window.__T.y, text: (target.textContent||"").slice(0,30) };
  `);
  if (!r?.ok) return r;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ui.cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  await ui.sleep(320);
  return r;
};

await runProbe({ name: "v0170-lead-ghost-check2", doc: DOC, docTitle: "Ghost 排查2" }, async (ui) => {
  await installGhostWatch(ui);

  /* ═══ 路径 B：H1 在已知空行 ═══ */
  await resetLog(ui);
  // 「第二段落文字」行 → 点行首 → 点 H1（该行非空 → 不显示 ghost，这是负对照）
  const b1 = await caretToLine(ui, "第二段落文字", true);
  ui.log("[B1] 定位: " + JSON.stringify(b1));
  await ui.ev(`
    const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
    const b = btns.find(x => (x.textContent || "").trim() === "H1");
    if (b) b.click();
    return !!b;
  `);
  await ui.sleep(700);
  const lb1 = await readGhostLog(ui);
  ui.log("[B1] 非空行点 H1（负对照）ghost: " + JSON.stringify(lb1.seen));
  ui.add("B1", "负对照：非空行点 H1 不该出 ghost", lb1.seen.length === 0 ? "PASS" : "KNOWN",
    `seen=${lb1.seen.length}`);

  /* ═══ 路径 A：行内粗体（选中 HELLO → 点 B）═══ */
  await resetLog(ui);
  // 双击选中 HELLO
  const hello = await ui.ev(`
    const ed = document.querySelector(".cm-editor");
    const lines = Array.from(ed.querySelectorAll(".cm-line"));
    const t = lines.find(l => (l.textContent || "").includes("HELLO"));
    if (!t) return { ok: false };
    // 找 HELLO 的文本节点范围
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    let node, found = null;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf("HELLO");
      if (i >= 0) { found = { node, i }; break; }
    }
    if (!found) return { ok: false, reason: "no text node" };
    const range = document.createRange();
    range.setStart(found.node, found.i);
    range.setEnd(found.node, found.i + 5);
    const rect = range.getBoundingClientRect();
    window.__S = { x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2) };
    return { ok: true, x: window.__S.x, y: window.__S.y, rect: { l: Math.round(rect.left), w: Math.round(rect.width) } };
  `);
  ui.log("[A] HELLO 定位: " + JSON.stringify(hello));

  if (hello?.ok) {
    // 拖选 HELLO
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: hello.x - 12, y: hello.y, button: "left", clickCount: 1 });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hello.x + 12, y: hello.y, button: "left" });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hello.x + 12, y: hello.y, button: "left", clickCount: 1 });
    await ui.sleep(300);
    const sel = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && (c.cmTile ? c.cmTile.view : null);
      return v ? { from: v.state.selection.main.from, to: v.state.selection.main.to,
                   text: v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) } : null;
    `);
    ui.log("[A] 选区: " + JSON.stringify(sel));

    // 点 B 按钮
    await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = btns.find(x => (x.textContent || "").trim() === "B");
      if (b) b.click();
      return !!b;
    `);
    await ui.sleep(900);
    const la = await readGhostLog(ui);
    ui.log("[A] 点 B 后 ghost 记录: " + JSON.stringify(la.seen));
    const docAfter = await ui.readSourceText();
    ui.log("[A] 文档: " + JSON.stringify(docAfter));
    ui.add("A1", "★ 行内粗体（有选区）后是否出现 ghost",
      la.seen.length > 0 ? "PASS" : "FAIL",
      la.seen.length > 0
        ? `出现 ${la.seen.length} 次；文本=${JSON.stringify(la.seen[0].txt)}；html=${la.seen[0].html}`
        : `从未出现；重建 del=${la.rebuild.del}；文档=${JSON.stringify((docAfter||"").slice(0,60))}`);
  }

  /* ═══ 路径 C：语法栏粗体（insert "****"）═══ */
  await resetLog(ui);
  const c1 = await caretToLine(ui, "第二段落文字", true);
  ui.log("[C] 定位: " + JSON.stringify(c1));
  await ui.ev(`
    const items = Array.from(document.querySelectorAll(".syntax-helper-item"));
    const it = items.find(x => (x.textContent || "").includes("粗体") && !(x.textContent||"").includes("粗斜"));
    if (it) it.click();
    return !!it;
  `);
  await ui.sleep(900);
  const lc = await readGhostLog(ui);
  ui.log("[C] 语法栏粗体后 ghost: " + JSON.stringify(lc.seen));
  ui.add("C1", "★ 语法栏粗体后是否出现 ghost",
    lc.seen.length > 0 ? "PASS" : "FAIL",
    lc.seen.length > 0 ? `出现 ${lc.seen.length} 次；文本=${JSON.stringify(lc.seen[0].txt)}`
      : `从未出现；重建 del=${lc.rebuild.del}`);

  await ui.shot("ghost-check2");
});
