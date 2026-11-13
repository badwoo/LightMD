/**
 * v0.17.0 复核 B 流 —— P0-1 影响面专项测量（一次性脚本，非交付物）
 *
 * 目的：把「P0-1 到底影响哪些操作」测准，避免我自己在报告里给出错误归因。
 *
 * 必须先排除一个**探针自身造成的假象**：
 *   共享骨架 `ui.key()` 发的 `Input.dispatchKeyEvent` **只带 keyUp/keyDown、没有 `text` 字段**。
 *   CDP 下 keyDown 不带 text 时浏览器**不会插入字符** —— 所以「逐键输入 5 字符落地 0 个」
 *   可能纯粹是我的发键方式不对，而不是应用的 P0-1。
 *   本脚本用**带 text 的字符事件**（等价真人敲键）重测，并给出对照。
 *
 * 另测：CM6 实例在「内容变更后」是否被重建（给 view 打 symbol 标记，变更后看标记还在不在）。
 *   —— 这条与我的 57 项验证直接相关：如果每次内容变更都换实例，那么「设选区 → 点按钮」
 *      之间一旦有别的变更，选区就会落到已销毁的实例上。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = "# 标题\n\n锚点行ANCHOR\n\n第二段文字\n\n末行";
const ANCHOR_END = DOC.indexOf("锚点行ANCHOR") + "锚点行ANCHOR".length;

await runProbe(
  { name: "v0170-verify-fs-p0scope", doc: DOC, docTitle: "锚点行", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;
    await ev(`
      window.__T = {
        view(){ const c=document.querySelector(".cm-content"); return (c&&c.cmTile&&c.cmTile.root&&c.cmTile.root.view)||null; },
        doc(){ const v=this.view(); return v?v.state.doc.toString():null; },
        reset(t){ const v=this.view(); if(!v) return {ok:false}; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t}}); return {ok:true}; },
        caret(p){ const v=this.view(); if(!v) return {ok:false};
          v.focus(); v.dispatch({selection:{anchor:p,head:p}});
          const m=v.state.selection.main; return {ok:true, from:m.from}; },
        mark(){ const v=this.view(); if(!v) return {ok:false};
          v.__MARK = "M" + Math.random(); return {ok:true, mark:v.__MARK}; },
        marked(){ const v=this.view();
          return { alive: !!v, mark: v ? (v.__MARK || null) : null, focused: document.activeElement === (v && v.contentDOM) }; },
      }; return true;
    `);
    const $doc = () => ev(`return window.__T.doc();`);
    const reset = async () => { await ev(`return window.__T.reset(${JSON.stringify(DOC)});`); await ui.sleep(520); return (await $doc()) === DOC; };

    /* ── 1. 带 text 的真实字符输入（等价真人敲键） ── */
    await reset();
    await ev(`return window.__T.caret(${ANCHOR_END});`);
    await ui.sleep(250);
    const pre = await $doc();
    await ev(`return window.__T.mark();`);
    const types = "abcde";
    for (const ch of types) {
      // type:"char" 会走"插入文本"路径，是 CDP 里最接近真人敲键的方式
      await ui.cdp.send("Input.dispatchKeyEvent", {
        type: "char", key: ch, text: ch, unmodifiedText: ch,
        windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
      });
      await ui.sleep(170);
    }
    await ui.sleep(700);
    const post = await $doc();
    // 精确统计：ANCHOR 之后**连续**匹配 "abcde" 前缀的字符数（不是切片长度）
    const seg = post ? post.slice(ANCHOR_END, ANCHOR_END + 10) : "";
    let matched = 0;
    for (let i = 0; i < "abcde".length; i++) {
      if (seg[i] === "abcde"[i]) matched++;
      else break;
    }
    const markedAfterTyping = await ev(`return window.__T.marked();`);
    ui.log(`[p0] 打字(带text)：ANCHOR 之后可见段=${JSON.stringify(seg)}  连续命中前缀=${matched}/5 全部落地=${matched === 5}`);
    ui.log(`[p0] 打字后实例标记: ${JSON.stringify(markedAfterTyping)}`);
    ui.add("Q1", "带 text 的真实字符输入 5 个 → 是否有字符丢失",
      matched === 5 ? "PASS" : "FAIL",
      `期望 "abcde"，实际只在 ANCHOR 后连续落地 ${matched}/5 个字符（可见段=${JSON.stringify(seg)}）；` +
      `打字后实例标记保留=${!!markedAfterTyping.mark}`);

    /* ── 2. 内容变更是否重建 CM6 实例（用 dispatch，与我 57 项的手法一致） ── */
    await reset();
    await ev(`return window.__T.caret(${ANCHOR_END});`);
    await ui.sleep(200);
    const m1 = await ev(`return window.__T.mark();`);
    ui.log(`[p0] 标记已打: ${JSON.stringify(m1)}`);
    // 用 dispatch 做一次内容变更（= 点一次格式按钮后宿主 setSourceContent 的等效效果）
    await ev(`
      const v = window.__T.view();
      v.dispatch({ changes: { from: ${ANCHOR_END}, to: ${ANCHOR_END}, insert: "ZZ" } });
      return true;
    `);
    await ui.sleep(900);
    const m2 = await ev(`return window.__T.marked();`);
    const docAfterDispatch = await $doc();
    ui.log(`[p0] dispatch 变更后实例: ${JSON.stringify(m2)}  doc 含 ZZ=${(docAfterDispatch||"").includes("ZZ")}`);
    ui.add("Q2", "内容变更后 CM6 实例是否被整体重建（symbol 标记是否随实例消失）",
      m2.mark && m2.mark === m1.mark ? "PASS" : "KNOWN",
      m2.mark === m1.mark
        ? `实例未被替换（标记 ${m1.mark.slice(0,6)} 仍在）`
        : `实例已被替换：变更前标记=${m1.mark && m1.mark.slice(0,6)} 变更后标记=${m2.mark ? m2.mark.slice(0,6) : "无（新实例）"} ⇒ 每次内容变更都 destroy+mount`);

    /* ── 3. 格式化操作本身是否导致选区/光标丢失 ── */
    // 这是 B 流真正关心的：点完按钮后，光标是否还在合理位置（能继续输入）
    await reset();
    await ev(`return window.__T.caret(${ANCHOR_END});`);
    await ui.sleep(250);
    const caretBefore = await ev(`
      const v = window.__T.view(); const m = v.state.selection.main;
      return { from: m.from, focusInCm: document.activeElement === v.contentDOM };
    `);
    const boldBox = await ev(`
      const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = bs.find(x => (x.getAttribute("title")||"").startsWith("粗体 ("));
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
    `);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: boldBox.x, y: boldBox.y });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: boldBox.x, y: boldBox.y, button: "left", clickCount: 1 });
    await ui.sleep(45);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: boldBox.x, y: boldBox.y, button: "left", clickCount: 1 });
    await ui.sleep(1000);
    const caretAfter = await ev(`
      const v = window.__T.view(); const m = v.state.selection.main;
      return { from: m.from, focusInCm: document.activeElement === v.contentDOM };
    `);
    const docAfterBold = await $doc();
    ui.log(`[p0] 点粗体前后光标: ${JSON.stringify(caretBefore)} → ${JSON.stringify(caretAfter)}`);
    ui.log(`[p0] 点粗体后 doc: ${JSON.stringify((docAfterBold||"").slice(0, 50))}`);

    // 紧接一次打字，验证"点完按钮后能否继续输入"（这才是用户真实体验）
    const beforeTyping2 = await $doc();
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "x", text: "x", unmodifiedText: "x", windowsVirtualKeyCode: 88 });
    await ui.sleep(200);
    await ui.cdp.send("Input.dispatchKeyEvent", { type: "char", key: "y", text: "y", unmodifiedText: "y", windowsVirtualKeyCode: 89 });
    await ui.sleep(700);
    const afterTyping2 = await $doc();
    const addedXY = (afterTyping2 || "").includes("x") && (afterTyping2 || "").includes("y");
    ui.log(`[p0] 点粗体后连打 "xy"：都落地=${addedXY}  doc=${JSON.stringify((afterTyping2||"").slice(0,60))}`);
    ui.add("Q3", "点完格式按钮后能否立即继续输入（焦点是否留在编辑区）",
      addedXY && caretAfter.focusInCm ? "PASS" : "FAIL",
      `点后焦点在CM6=${caretAfter.focusInCm} 点后连打 xy 都落地=${addedXY}`);

    /* ── 4. 同一次会话里重复「设选区→点按钮」10 次，统计成功率（我的 57 项就是靠这个） ── */
    let okCount = 0;
    const fails = [];
    for (let i = 0; i < 10; i++) {
      await ev(`return window.__T.reset(${JSON.stringify(DOC)});`);
      await ui.sleep(420);
      const r = await ev(`
        const v = window.__T.view();
        if (!v) return {ok:false, why:"no view"};
        v.focus();
        v.dispatch({ selection: { anchor: ${ANCHOR_END}, head: ${ANCHOR_END} } });
        const m = v.state.selection.main;
        if (m.from !== ${ANCHOR_END}) return {ok:false, why:"sel mismatch", got:m.from};
        return {ok:true};
      `);
      if (!r.ok) { fails.push(`#${i} 选区:${r.why}`); continue; }
      const box = await ev(`
        const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = bs.find(x => (x.getAttribute("title")||"").startsWith("粗体 ("));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
      `);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(40);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(750);
      const t = await $doc();
      if (t === DOC.slice(0, ANCHOR_END) + "****" + DOC.slice(ANCHOR_END)) okCount++;
      else fails.push(`#${i} 结果=${JSON.stringify((t||"").slice(ANCHOR_END-5, ANCHOR_END+8))}`);
    }
    ui.log(`[p0] 10 次「设选区→点粗体」成功 ${okCount}/10；失败明细: ${JSON.stringify(fails.slice(0,4))}`);
    ui.add("Q4", "连续 10 次「原子设选区 → 点格式按钮」成功率（验证我的 57 项手法是否稳定）",
      okCount === 10 ? "PASS" : (okCount >= 8 ? "KNOWN" : "FAIL"),
      `${okCount}/10 精确命中；失败样例 ${JSON.stringify(fails.slice(0, 3))}`);

    await ui.shot("p0scope-end");
    ui.add("Z", "P0 影响面测量完成", "KNOWN", "见日志");
  }
);
