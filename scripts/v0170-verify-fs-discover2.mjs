/**
 * v0.17.0 复核 B 流 —— 勘察第 2 轮（一次性脚本，不是交付物）
 *
 * 要定死 5 件事：
 *   1. 最可靠的「把文档恢复干净」的办法（重复派发 lightmd:openFile 同 path 是否等价 reload）
 *   2. readSourceText() 与文档字符串是否**逐字符相等**（含末尾空行）
 *   3. 折叠光标（collapsed Range）能否同步进 CM6 state
 *   4. formatPainter 的 armed 态怎么观测；task / mermaid 下拉、link/image/table 对话框的选择器
 *   5. 点按钮时 mousedown 会不会清掉选区（用真实 mouse 事件 vs .click() 的差别）
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# 勘察二",
  "",
  "alpha HELLO beta",
  "",
  "第二段落文字",
  "",
  "- 列表甲",
  "- 列表乙",
  "",
].join("\n");

await runProbe(
  { name: "v0170-verify-fs-discover2", doc: DOC, docTitle: "勘察二", viewMode: "edit" },
  async (ui) => {
    // ── 0. readSourceText 精确性 ──
    const t0 = await ui.readSourceText();
    ui.log(`[d2] readSourceText 是否 === DOC : ${t0 === DOC}（len ${t0?.length} vs ${DOC.length}）`);
    if (t0 !== DOC) {
      ui.log(`[d2] 实测 repr: ${JSON.stringify(t0)}`);
      ui.log(`[d2] 期望 repr: ${JSON.stringify(DOC)}`);
    }

    // ── 1. 折叠光标同步 ──
    const collapsed = await ui.ev(`
      const content = document.querySelector(".cm-content");
      content.focus();
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").includes("第二段落文字"));
      if (!line) return { ok:false, why:"no line" };
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const node = w.nextNode();
      const range = document.createRange();
      range.setStart(node, 2); range.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return { ok:true };
    `);
    ui.log(`[d2] 折叠光标设置: ${JSON.stringify(collapsed)}`);
    await ui.sleep(400);
    const st = await ui.ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
      if (!v) return null;
      const m = v.state.selection.main;
      return { from: m.from, to: m.to, empty: m.empty, text: v.state.doc.toString() };
    `);
    ui.log(`[d2] CM6 state 选区: ${JSON.stringify({ from: st.from, to: st.to, empty: st.empty })}`);
    ui.log(`[d2] CM6 doc === DOC: ${st.text === DOC}`);

    // ── 2. 文档重置：重复派发 openFile（同 path）──
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(ui.docFile)}, name: ${JSON.stringify(ui.path.basename(ui.docFile))}, content: ${JSON.stringify(DOC)} },
      }));
      return true;
    `);
    await ui.sleep(1400);
    const afterReset = await ui.readSourceText();
    ui.log(`[d2] 重置后 === DOC: ${afterReset === DOC}`);

    // ── 2b. 先破坏（输入字符），再重置，确认重置真的回滚 ──
    await ui.ev(`
      const c = document.querySelector(".cm-content");
      c.focus();
      const v = c.cmTile.root.view;
      // 用真实输入路径：全选后 insertText 会替换
      return true;
    `);
    await ui.typeText("ZZZ");
    const dirty = await ui.readSourceText();
    ui.log(`[d2] 输入后含 ZZZ: ${dirty.includes("ZZZ")}（len ${dirty.length}）`);
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(ui.docFile)}, name: ${JSON.stringify(ui.path.basename(ui.docFile))}, content: ${JSON.stringify(DOC)} },
      }));
      return true;
    `);
    await ui.sleep(1400);
    const afterReset2 = await ui.readSourceText();
    ui.log(`[d2] 破坏后重置 === DOC: ${afterReset2 === DOC}  repr=${JSON.stringify((afterReset2 || "").slice(0, 80))}`);

    // ── 3. task 下拉 / mermaid 下拉 / 对话框 ──
    const taskDrop = await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const task = btns.find(b => (b.textContent||"").trim() === "☑");
      if (!task) return { ok:false };
      task.click();
      return { ok:true };
    `);
    await ui.sleep(400);
    const taskMenu = await ui.ev(`
      const d = document.querySelector('[data-testid="task-style-dropdown"]');
      return d ? { el:true, items: d.querySelectorAll(".task-style-option").length,
                   styles: Array.from(d.querySelectorAll(".task-style-option")).map(x=>x.getAttribute("data-style")),
                   visible: (()=>{const r=d.getBoundingClientRect();return r.width>0&&r.height>0;})() } : { el:false };
    `);
    ui.log(`[d2] task 下拉: ${JSON.stringify(taskDrop)} → ${JSON.stringify(taskMenu)}`);

    // 点"方形"选项 → 应插入 - [ ]
    const squareClick = await ui.ev(`
      const b = document.querySelector('[data-testid="task-style-dropdown"] .task-style-option[data-style="square"]');
      if (!b) return { ok:false };
      b.click();
      return { ok:true };
    `);
    await ui.sleep(800);
    const afterSquare = await ui.readSourceText();
    ui.log(`[d2] 方形任务插入: ${JSON.stringify(squareClick)} 文本含"- [ ] "=${afterSquare.includes("- [ ] ")}`);

    // 重置
    await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(ui.docFile)},name:${JSON.stringify(ui.path.basename(ui.docFile))},content:${JSON.stringify(DOC)}}}));return true;`);
    await ui.sleep(1300);

    // mermaid 下拉
    const mMen = await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const m = btns.find(b => (b.textContent||"").trim() === "◈");
      if (!m) return { ok:false };
      m.click();
      return { ok:true };
    `);
    await ui.sleep(400);
    const mMen2 = await ui.ev(`
      const d = document.querySelector(".mermaid-dropdown-menu");
      if (!d) return { el:false };
      const r = d.getBoundingClientRect();
      return { el:true, items: Array.from(d.querySelectorAll(".mermaid-dropdown-item")).map(x=>(x.textContent||"").trim()),
               visible: r.width>0&&r.height>0 };
    `);
    ui.log(`[d2] mermaid 下拉: ${JSON.stringify(mMen)} → ${JSON.stringify(mMen2)}`);

    // ── 4. 三个对话框 ──
    const dlg = {};
    for (const [label, sel] of [["link", ".link-dialog"], ["image", ".image-insert-dialog"], ["table", ".table-dialog"]]) {
      const r = await ui.ev(`
        document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
        return true;
      `);
      await ui.sleep(250);
      const clicked = await ui.ev(`
        const map = { link:"🔗", image:"🖼", table:"⊞" };
        const want = ${JSON.stringify(label === "link" ? "🔗" : label === "image" ? "🖼" : "⊞")};
        const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = btns.find(x => (x.textContent||"").trim() === want);
        if (!b) return { ok:false, want };
        b.click();
        return { ok:true };
      `);
      await ui.sleep(600);
      const found = await ui.ev(`
        // 找出所有 overlay 类
        const ov = Array.from(document.querySelectorAll('[class*="dialog-overlay"], [class*="dialog"]'))
          .filter(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 50; })
          .map(e => e.className);
        return { overlays: ov.slice(0, 8), hasExpected: !!document.querySelector(${JSON.stringify(sel)}) };
      `);
      dlg[label] = { clicked, found };
      ui.log(`[d2] 对话框 ${label}: ${JSON.stringify(clicked)} → ${JSON.stringify(found)}`);
      await ui.ev(`
        const ov = document.querySelector('[class*="dialog-overlay"]');
        if (ov) ov.click();
        document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
        return true;
      `);
      await ui.sleep(400);
    }

    // ── 5. formatPainter armed 观测 ──
    await ui.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(ui.docFile)},name:${JSON.stringify(ui.path.basename(ui.docFile))},content:${JSON.stringify(DOC)}}}));return true;`);
    await ui.sleep(1300);
    // 先真实选中 "HELLO"，再点刷子
    await ui.ev(`
      const content = document.querySelector(".cm-content");
      content.focus();
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").includes("alpha HELLO beta"));
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node; while((node = w.nextNode())) { const i=(node.textContent||"").indexOf("HELLO"); if(i>=0){ break; } }
      const i = (node.textContent||"").indexOf("HELLO");
      const range = document.createRange();
      range.setStart(node, i); range.setEnd(node, i+5);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    `);
    await ui.sleep(400);
    const painterClick = await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = btns.find(x => (x.getAttribute("title")||"").includes("格式刷"));
      if (!b) return { ok:false };
      b.click();
      return { ok:true, before: document.body.className };
    `);
    await ui.sleep(600);
    const armed = await ui.ev(`
      return {
        bodyClass: document.body.className,
        activeBtn: Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
          .filter(b=>b.classList.contains("active")).map(b=>b.getAttribute("title")),
      };
    `);
    ui.log(`[d2] 格式刷 armed: ${JSON.stringify(painterClick)} → ${JSON.stringify(armed)}`);

    // ── 6. 真实 mouse 点击 vs .click() 对选区的影响 ──
    await ui.ev(`
      document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
      return true;
    `);
    await ui.sleep(300);

    const selState = async (tag) => {
      const v = await ui.ev(`
        const c = document.querySelector(".cm-content");
        const view = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
        if (!view) return null;
        const m = view.state.selection.main;
        return { from: m.from, to: m.to, empty: m.empty, focusInCm: document.activeElement === c };
      `);
      ui.log(`[d2] 选区@${tag}: ${JSON.stringify(v)}`);
      return v;
    };

    await ui.ev(`
      const content = document.querySelector(".cm-content");
      content.focus();
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").includes("alpha HELLO beta"));
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node; while((node = w.nextNode())) { if((node.textContent||"").indexOf("HELLO")>=0) break; }
      const i = (node.textContent||"").indexOf("HELLO");
      const range = document.createRange();
      range.setStart(node, i); range.setEnd(node, i+5);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    `);
    await ui.sleep(400);
    await selState("设置后");

    // 用真实 CDP 鼠标点 bold 按钮（不是 .click()）
    const box = await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = btns.find(x => (x.textContent||"").trim() === "B");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    `);
    if (box) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(60);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(900);
      ui.log(`[d2] 真实鼠标点 B @ ${JSON.stringify(box)}`);
      await selState("真实点击后");
      const txt = await ui.readSourceText();
      ui.log(`[d2] 真实点击 B 后含 "**HELLO**": ${txt.includes("**HELLO**")}`);
    } else {
      ui.log(`[d2] 找不到 B 按钮坐标`);
    }

    await ui.shot("discover2-end");
    ui.add("D2", "勘察二完成", "KNOWN", "见日志");
  }
);
