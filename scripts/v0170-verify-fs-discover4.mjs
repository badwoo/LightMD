/**
 * v0.17.0 复核 B 流 —— 勘察第 4 轮（一次性脚本，不是交付物）
 *
 * 前几轮已确认的事实：
 *   - 从 DOM 能拿到 CM6 EditorView（`content.cmTile.root.view`）✅
 *   - DOM Range 选区（含折叠光标）能同步进 `state.selection` ✅
 *   - 真实鼠标点格式按钮后选区被清空（collapsed 到 28），但文本仍被正确包裹
 *     → 说明点击时宿主读的是"点击前"的选区
 *   - 同 path 重复 openFile **不会**重置文档（标签去重，沿用标签内容）
 *   - `Input.insertText` 塞多行文本不可靠（实测只剩 "XXX"，多行丢失）
 *
 * 本轮要定死：
 *   1. 「用 view.dispatch 全文替换」能否作为**可靠的每项之间复位**手法
 *      （且能否被宿主状态接受：复位后再点按钮仍生效 = 宿主 sourceContent 已同步）
 *   2. React 受控 input 的 value 怎么设才生效（link 对话框"插入"需要 URL 非空）
 *   3. link 对话框填 URL 后点插入 → 源码面是否出现链接 Markdown
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# 勘察四",
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
  { name: "v0170-verify-fs-discover4", doc: DOC, docTitle: "勘察四", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;

    /** 通过 CM6 view 直接全文替换（走 updateListener → 宿主 onContentChange，等同一次用户编辑） */
    const resetDoc = async () => {
      const r = await ev(`
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
        if (!v) return { ok:false, why:"no view" };
        const text = ${JSON.stringify(DOC)};
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        return { ok:true, docLen: v.state.doc.length };
      `);
      await ui.sleep(500);
      const t = await ui.readSourceText();
      return { ...r, matches: t === DOC, repr: r.ok ? undefined : JSON.stringify((t || "").slice(0, 60)) };
    };

    // ── 1. dispatch 复位 ──
    const r1 = await resetDoc();
    ui.log(`[d4] dispatch 复位: ${JSON.stringify(r1)}`);

    // 破坏一下，再复位
    await ui.focusSource();
    await ui.typeText("QQQ");
    await ui.sleep(400);
    const broken = await ui.readSourceText();
    ui.log(`[d4] 破坏后含 QQQ: ${broken.includes("QQQ")}`);
    const r2 = await resetDoc();
    ui.log(`[d4] 二次 dispatch 复位: ${JSON.stringify(r2)}`);

    // 复位后立刻点 bold（验证宿主 sourceContent 已同步，不是"只有 CM6 变了"）
    await ev(`
      const c = document.querySelector(".cm-content");
      c.focus();
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
    await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "B");
      b.click(); return true;
    `);
    await ui.sleep(800);
    const afterBold = await ui.readSourceText();
    ui.log(`[d4] 复位后点 bold 生效: ${afterBold.includes("**HELLO**")}  repr=${JSON.stringify((afterBold||"").slice(0, 70))}`);
    ui.log(`[d4] 复位后 bold 结果是否 === DOC.replace("HELLO","**HELLO**"): ${afterBold === DOC.replace("HELLO", "**HELLO**")}`);

    // ── 2. React 受控 input 写入 ──
    const r3 = await resetDoc();
    ui.log(`[d4] 三次复位: ${JSON.stringify(r3)}`);
    // 先把光标放到空行再开 link 对话框
    await ev(`
      const c = document.querySelector(".cm-content");
      c.focus();
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").includes("第二段落文字"));
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const node = w.nextNode();
      const range = document.createRange(); range.setStart(node, 0); range.collapse(true);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    `);
    await ui.sleep(350);
    await ev(`
      const b = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn")).find(x => (x.textContent||"").trim() === "🔗");
      b.click(); return true;
    `);
    await ui.sleep(600);

    // React 受控 input：必须用原型 setter + input 事件
    const setInput = await ev(`
      const d = document.querySelector(".link-dialog");
      if (!d) return { ok:false };
      const inputs = Array.from(d.querySelectorAll("input"));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const set = (el, val) => { setter.call(el, val); el.dispatchEvent(new Event("input", { bubbles: true })); };
      set(inputs[0], "链接文字");
      set(inputs[1], "https://example.com");
      return { ok:true, vals: inputs.map(i => i.value) };
    `);
    await ui.sleep(400);
    ui.log(`[d4] 设 input: ${JSON.stringify(setInput)}`);

    const btnState = await ev(`
      const d = document.querySelector(".link-dialog");
      const btn = Array.from(d.querySelectorAll("button")).find(b => b.className.includes("primary"));
      return btn ? { disabled: btn.disabled, text: (btn.textContent||"").trim() } : null;
    `);
    ui.log(`[d4] 插入按钮: ${JSON.stringify(btnState)}`);

    const clickInsert = await ev(`
      const d = document.querySelector(".link-dialog");
      const btn = Array.from(d.querySelectorAll("button")).find(b => b.className.includes("primary"));
      if (!btn) return { ok:false };
      btn.click();
      return { ok:true };
    `);
    await ui.sleep(900);
    const afterLink = await ui.readSourceText();
    ui.log(`[d4] link 插入: ${JSON.stringify(clickInsert)} 含 "[链接文字](https://example.com)": ${afterLink.includes("[链接文字](https://example.com)")}`);
    ui.log(`[d4] link 后 repr: ${JSON.stringify((afterLink||"").slice(0, 100))}`);
    const dlgGone = await ev(`return !document.querySelector(".link-dialog")`);
    ui.log(`[d4] 对话框已关闭: ${dlgGone}`);

    // ── 3. 复位可靠性 × 连续 3 次 ──
    for (let i = 0; i < 3; i++) {
      const rr = await resetDoc();
      ui.log(`[d4] 连测复位 ${i + 1}: matches=${rr.matches}`);
    }

    await ui.shot("discover4-end");
    ui.add("D4", "勘察四完成", "KNOWN", "见日志");
  }
);
