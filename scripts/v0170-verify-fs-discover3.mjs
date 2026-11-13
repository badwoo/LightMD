/**
 * v0.17.0 复核 B 流 —— 勘察第 3 轮（一次性脚本，不是交付物）
 *
 * 要定死：
 *   1. 「每项之间把文档恢复干净」的**可靠**办法（openFile 去重不重置内容，需另找）
 *   2. 语法栏条目的实际插入结果（ghost 项不落盘 → doc = DOC[:p] + insert + DOC[p:]）
 *   3. undo/redo 按钮真改文档后能否撤销/恢复
 *   4. task 下拉的 circle 选项、mermaid 模板选项点击结果
 *   5. link 对话框「插入」按钮能否落地到源码面
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# 勘察三",
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
  { name: "v0170-verify-fs-discover3", doc: DOC, docTitle: "勘察三", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;
    const base = ui.path.basename(ui.docFile);

    const docNow = async (tag) => {
      const t = await ui.readSourceText();
      ui.log(`[d3] doc@${tag} === DOC: ${t === DOC}  repr=${JSON.stringify((t || "").slice(0, 60))}`);
      return t;
    };

    // ── 方法 A：Ctrl+A + insertText 全文替换 ──
    await ui.focusSource();
    await ui.key("a", "KeyA", 65, 2); // Ctrl+A
    await ui.sleep(200);
    await ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
      return v ? { from: v.state.selection.main.from, to: v.state.selection.main.to } : null;
    `).then((r) => ui.log(`[d3] Ctrl+A 后选区: ${JSON.stringify(r)}`));
    await ui.typeText("XXX");
    await ui.sleep(500);
    await docNow("替换成XXX后");
    // 恢复
    await ui.key("a", "KeyA", 65, 2);
    await ui.sleep(200);
    await ui.typeText(DOC);
    await ui.sleep(600);
    const restored = await docNow("Ctrl+A+insertText 恢复");
    ui.log(`[d3] 方法A可用: ${restored === DOC}`);

    // ── 方法 B：tab.close 再 openFile ──
    await ui.focusSource();
    await ui.typeText("YYY");
    await ui.sleep(400);
    await ui.command("tab.close");
    await ui.sleep(900);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(ui.docFile)},name:${JSON.stringify(base)},content:${JSON.stringify(DOC)}}}));return true;`);
    await ui.sleep(1600);
    ui.log(`[d3] tab.close 后 cm-editor 存在: ${await ev(`return !!document.querySelector(".cm-editor")`)}`);
    await docNow("tab.close + openFile");

    // 回到编辑模式（确保）
    await ui.command("view.edit");
    await ui.sleep(1800);

    // ── 语法栏：几个代表项 ──
    const setCaret = async (needle, offset = 0) => {
      const r = await ev(`
        const c = document.querySelector(".cm-content");
        c.focus();
        const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").includes(${JSON.stringify(needle)}));
        if (!line) return { ok:false, why:"line not found" };
        const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node; while((node = w.nextNode())) { if((node.textContent||"").includes(${JSON.stringify(needle)})) break; }
        if (!node) return { ok:false, why:"node" };
        const i = (node.textContent||"").indexOf(${JSON.stringify(needle)}) + ${offset};
        const range = document.createRange();
        range.setStart(node, i); range.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return { ok:true };
      `);
      await ui.sleep(350);
      const v = await ev(`
        const c = document.querySelector(".cm-content");
        const view = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
        return view ? { from: view.state.selection.main.from, to: view.state.selection.main.to } : null;
      `);
      ui.log(`[d3] setCaret(${needle},${offset}) → ${JSON.stringify(r)} state=${JSON.stringify(v)}`);
      return v ? v.from : null;
    };

    const clickItem = async (idx) => {
      const r = await ev(`
        const items = Array.from(document.querySelectorAll(".syntax-helper .syntax-helper-item"));
        const it = items[${idx}];
        if (!it) return { ok:false, count: items.length };
        it.click();
        return { ok:true, name: (it.querySelector(".syntax-helper-item-name")||{}).textContent };
      `);
      await ui.sleep(700);
      return r;
    };

    const testItem = async (idx, expectInsert, name) => {
      await ui.focusSource();
      // 恢复干净
      await ui.key("a", "KeyA", 65, 2);
      await ui.sleep(150);
      await ui.typeText(DOC);
      await ui.sleep(500);
      const pos = await setCaret("第二段落文字", 0);
      const before = await ui.readSourceText();
      const c = await clickItem(idx);
      const after = await ui.readSourceText();
      const expect = before === null || pos === null ? null : before.slice(0, pos) + expectInsert + before.slice(pos);
      ui.log(`[d3] 语法项#${idx} ${name} click=${JSON.stringify(c)} 匹配期望=${after === expect}`);
      if (after !== expect) {
        ui.log(`     实测 repr: ${JSON.stringify((after || "").slice(0, 90))}`);
        ui.log(`     期望 repr: ${JSON.stringify((expect || "").slice(0, 90))}`);
      }
      return after === expect;
    };

    // #0 一级标题 insert "# " ghost 标题一
    await testItem(0, "# ", "一级标题");
    // #3 粗体 insert "****"
    await testItem(3, "****", "粗体");
    // #8 代码块 insert "\n```\n\n```\n"
    await testItem(8, "\n```\n\n```\n", "代码块");
    // #31 表格 insert "\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n"
    await testItem(31, "\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n", "表格");
    // #30 分割线 insert "\n---\n"
    await testItem(30, "\n---\n", "分割线");

    // ── undo / redo 按钮 ──
    await ui.key("a", "KeyA", 65, 2);
    await ui.sleep(150);
    await ui.typeText(DOC);
    await ui.sleep(500);
    await setCaret("第二段落文字", 0);
    await ui.typeText("UNDOME");
    await ui.sleep(600);
    const withType = await ui.readSourceText();
    ui.log(`[d3] 打字后含 UNDOME: ${withType.includes("UNDOME")}`);
    const undoClick = await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "↩");
      if (!b) return { ok:false };
      b.click(); return { ok:true };
    `);
    await ui.sleep(800);
    const afterUndo = await ui.readSourceText();
    ui.log(`[d3] undo click=${JSON.stringify(undoClick)} 撤销后含 UNDOME: ${afterUndo.includes("UNDOME")}  === DOC: ${afterUndo === DOC}`);
    const redoClick = await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "↪");
      if (!b) return { ok:false };
      b.click(); return { ok:true };
    `);
    await ui.sleep(800);
    const afterRedo = await ui.readSourceText();
    ui.log(`[d3] redo click=${JSON.stringify(redoClick)} 恢复后含 UNDOME: ${afterRedo.includes("UNDOME")}  === before: ${afterRedo === withType}`);

    // ── task 下拉 circle ──
    await ui.key("a", "KeyA", 65, 2);
    await ui.sleep(150);
    await ui.typeText(DOC);
    await ui.sleep(500);
    await setCaret("第二段落文字", 0);
    await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "☑");
      b.click(); return true;
    `);
    await ui.sleep(400);
    const circleClicked = await ev(`
      const b = document.querySelector('[data-testid="task-style-dropdown"] .task-style-option[data-style="circle"]');
      if (!b) return { ok:false };
      b.click(); return { ok:true };
    `);
    await ui.sleep(800);
    const afterCircle = await ui.readSourceText();
    ui.log(`[d3] circle 选项 click=${JSON.stringify(circleClicked)} 含 "* [ ] "=${afterCircle.includes("* [ ] ")}`);

    // ── mermaid 模板 ──
    await ui.key("a", "KeyA", 65, 2);
    await ui.sleep(150);
    await ui.typeText(DOC);
    await ui.sleep(500);
    await setCaret("第二段落文字", 0);
    await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "◈");
      b.click(); return true;
    `);
    await ui.sleep(400);
    const tplClicked = await ev(`
      const bs = Array.from(document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item"));
      const b = bs.find(x => (x.textContent||"").trim() === "Flowchart");
      if (!b) return { ok:false, labels: bs.map(x=>x.textContent.trim()) };
      b.click(); return { ok:true };
    `);
    await ui.sleep(900);
    const afterTpl = await ui.readSourceText();
    ui.log(`[d3] mermaid Flowchart click=${JSON.stringify(tplClicked)} 含 "graph TD"=${afterTpl.includes("graph TD")} 含 "\`\`\`mermaid"=${afterTpl.includes("\`\`\`mermaid")}`);

    // ── link 对话框落地 ──
    await ui.key("a", "KeyA", 65, 2);
    await ui.sleep(150);
    await ui.typeText(DOC);
    await ui.sleep(500);
    await setCaret("第二段落文字", 0);
    await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "🔗");
      b.click(); return true;
    `);
    await ui.sleep(600);
    const dlgInfo = await ev(`
      const d = document.querySelector(".link-dialog");
      if (!d) return { ok:false };
      const inputs = Array.from(d.querySelectorAll("input")).map(i => ({ ph: i.placeholder, val: i.value, cls: i.className }));
      const btns = Array.from(d.querySelectorAll("button")).map(b => (b.textContent||"").trim());
      return { ok:true, inputs, btns };
    `);
    ui.log(`[d3] link 对话框: ${JSON.stringify(dlgInfo)}`);
    const inserted = await ev(`
      const d = document.querySelector(".link-dialog");
      if (!d) return { ok:false };
      const btn = Array.from(d.querySelectorAll("button")).find(b => b.className.includes("primary"));
      if (!btn) return { ok:false, why:"no primary" };
      btn.click();
      return { ok:true };
    `);
    await ui.sleep(900);
    const afterLink = await ui.readSourceText();
    ui.log(`[d3] link 插入 click=${JSON.stringify(inserted)} 含 "](url)"=${afterLink.includes("](url)")} repr=${JSON.stringify((afterLink||"").slice(0,80))}`);

    await ui.shot("discover3-end");
    ui.add("D3", "勘察三完成", "KNOWN", "见日志");
  }
);
