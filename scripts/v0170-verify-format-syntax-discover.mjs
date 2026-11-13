/**
 * v0.17.0 复核 B 流（format-syntax）—— **一次性勘察脚本**（不是交付物）
 *
 * 目的：在写 57 项正式探针之前，先把以下 4 件事在真机上确证清楚（不猜）：
 *   1. 能不能只靠 DOM 拿到 CM6 的 `EditorView` 实例（用来读 state.selection）；
 *   2. 「DOM Range 选区」能否同步进 CM6 的 state.selection（这决定我能不能用
 *      "模拟用户拖选"的方式设选区，而不是用内部 API 硬塞）；
 *   3. 格式栏按钮点击后，选区是否被保住（按钮 mousedown 会不会先把编辑器清空选择）；
 *   4. 语法栏的 32 个条目、格式栏的 25 个按钮在 DOM 里的真实顺序与文案（用于建映射表）。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# 勘察文档",
  "",
  "第一段 HELLO 文本，用于选区测试。",
  "",
  "第二段普通文字。",
  "",
  "- 列表项甲",
  "- 列表项乙",
  "",
].join("\n");

await runProbe(
  {
    name: "v0170-verify-format-syntax-discover",
    doc: DOC,
    docTitle: "勘察文档",
    viewMode: "edit",
  },
  async (ui) => {
    ui.log(`[discover] impl=${ui.impl}`);

    // ── 1. 能否从 DOM 拿到 EditorView ──
    const viewProbe = await ui.ev(`
      const content = document.querySelector(".cm-content");
      if (!content) return { ok: false, why: "no .cm-content" };
      const tile = content.cmTile;
      const root = tile && tile.root;
      const view = root && root.view;
      return {
        ok: !!view,
        hasTile: !!tile,
        rootCtor: root ? root.constructor.name : null,
        viewKeys: view ? Object.keys(view).slice(0, 12) : null,
        docLen: view ? view.state.doc.length : null,
        sel: view ? { from: view.state.selection.main.from, to: view.state.selection.main.to } : null,
      };
    `);
    ui.log(`[discover] EditorView via DOM: ${JSON.stringify(viewProbe)}`);

    // ── 2. DOM Range 选区是否同步进 state.selection ──
    const domSelSync = await ui.ev(`
      const content = document.querySelector(".cm-content");
      content.focus();
      // 找到包含 HELLO 的行，在该行的文本节点上建 Range 选中 HELLO
      const line = Array.from(document.querySelectorAll(".cm-line"))
        .find(l => (l.textContent || "").includes("HELLO"));
      if (!line) return { ok: false, why: "no HELLO line" };
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node, hit = null, offset = -1;
      while ((node = walker.nextNode())) {
        const i = (node.textContent || "").indexOf("HELLO");
        if (i >= 0) { hit = node; offset = i; break; }
      }
      if (!hit) return { ok: false, why: "no text node with HELLO" };
      const range = document.createRange();
      range.setStart(hit, offset);
      range.setEnd(hit, offset + 5);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return { ok: true, domSel: String(sel), text: hit.textContent };
    `);
    ui.log(`[discover] DOM Range 设置: ${JSON.stringify(domSelSync)}`);
    await ui.sleep(500);

    const stateAfterDomSel = await ui.ev(`
      const content = document.querySelector(".cm-content");
      const view = content && content.cmTile && content.cmTile.root && content.cmTile.root.view;
      if (!view) return { ok: false };
      const main = view.state.selection.main;
      return { from: main.from, to: main.to, empty: main.empty, selected: view.state.doc.sliceString(main.from, main.to) };
    `);
    ui.log(`[discover] DOM 选区同步进 CM6 state: ${JSON.stringify(stateAfterDomSel)}`);

    // ── 3. 点按钮后选区是否还在（先探一次 bold）──
    const boldProbe = await ui.ev(`
      const before = (() => {
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
        if (!v) return null;
        const m = v.state.selection.main;
        return { from: m.from, to: m.to, empty: m.empty };
      })();
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const bold = btns.find(b => (b.textContent || "").trim() === "B");
      if (!bold) return { ok: false, why: "no bold btn", btnCount: btns.length };
      bold.click();
      return { ok: true, before, btnCount: btns.length };
    `);
    ui.log(`[discover] 点 bold: ${JSON.stringify(boldProbe)}`);
    await ui.sleep(700);
    ui.log(`[discover] 点 bold 后源码文本:\n${(await ui.readSourceText())}`);
    await ui.shot("after-bold");

    // ── 4. 25 个按钮 / 32 个条目的真实清单 ──
    const buttons = await ui.ev(`
      return Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).map((b, i) => ({
        i, label: (b.textContent || "").trim(), title: b.getAttribute("title"), active: b.classList.contains("active"),
      }));
    `);
    ui.log(`[discover] 按钮数=${buttons.length}`);
    buttons.forEach((b) => ui.log(`  #${b.i} label="${b.label}" title="${b.title}"`));

    const items = await ui.ev(`
      return Array.from(document.querySelectorAll(".syntax-helper .syntax-helper-item")).map((el, i) => ({
        i,
        name: (el.querySelector(".syntax-helper-item-name") || {}).textContent,
        code: (el.querySelector(".syntax-helper-item-code") || {}).textContent,
        title: el.getAttribute("title"),
      }));
    `);
    ui.log(`[discover] 语法栏条目数=${items.length}`);
    items.forEach((it) => ui.log(`  #${it.i} name="${it.name}" code="${it.code}"`));

    // ── 5. 语法栏容器是否可见（getBoundingClientRect 判据）──
    const vis = await ui.ev(`
      const f = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return { cmEditor: f(".cm-editor"), toolbar: f(".source-format-toolbar"), syntax: f(".syntax-helper") };
    `);
    ui.log(`[discover] 可见性: ${JSON.stringify(vis)}`);

    // ── 6. ghost 相关 DOM（判断 ghost 是否落盘）──
    const ghost = await ui.ev(`
      return {
        ghostEls: document.querySelectorAll(".ai-ghost-text, .format-ghost-tail").length,
        bodyClass: document.body.className,
      };
    `);
    ui.log(`[discover] ghost/body: ${JSON.stringify(ghost)}`);

    ui.add("D", "勘察完成（本脚本不是交付判定）", "KNOWN", "见日志");
  }
);
