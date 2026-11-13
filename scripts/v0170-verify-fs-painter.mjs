/**
 * v0.17.0 复核 B 流 —— B4（格式刷「应用」）专项复核（一次性脚本，非交付物）
 *
 * 背景：正式探针里 B4 FAIL 了，但**先把责任搞清**：
 *   - 我的原用例是从裸 `HELLO`（无任何包裹符号）采集快照 → collectSourceSnapshot
 *     返回 { marks: [], blockType: "paragraph" } → 套用到另一个普通段落时
 *     applyBlockTypeToLine 返回 null、marks 为空 → **本来就不该有任何变化**。
 *     所以「无变化」是**正确行为**，我的原预期写错了。
 *   - 正确用例：先造 `**HELLO**`，选中**带符号的整段** `**HELLO**` 采集，
 *     再应用到目标段落 → 应变 `**第二段落文字**`。
 *
 * 本脚本同时确认「点击正文应用」这条手势在 CM6 下是否可用
 * （源码里 FormatMenuHost 的 onClick 绑在 `sourceTextareaRef.current` 上，
 *  而 CM6 下它是中性 div `sourceHostElRef`）。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# 标题行原有内容",
  "",
  "alpha HELLO beta",
  "",
  "第二段落文字",
  "",
  "末行",
].join("\n");
const HELLO_FROM = DOC.indexOf("HELLO");
const HELLO_TO = HELLO_FROM + 5;
const LINE2_FROM = DOC.indexOf("第二段落文字");
const LINE2_TO = LINE2_FROM + "第二段落文字".length;

await runProbe(
  { name: "v0170-verify-fs-painter", doc: DOC, docTitle: "第二段落文字", viewMode: "edit" },
  async (ui) => {
    const ev = ui.ev;
    await ev(`
      window.__FS = {
        view(){ const c=document.querySelector(".cm-content"); return (c&&c.cmTile&&c.cmTile.root&&c.cmTile.root.view)||null; },
        doc(){ const v=this.view(); return v?v.state.doc.toString():null; },
        reset(t){ const v=this.view(); if(!v) return {ok:false}; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:t}}); return {ok:true}; },
        sel(f,t){ const v=this.view(); if(!v) return {ok:false};
          v.focus(); v.dispatch({selection:{anchor:f,head:t}});
          const m=v.state.selection.main; return {ok:true, from:Math.min(m.from,m.to), to:Math.max(m.from,m.to)}; },
      }; return true;
    `);
    const $doc = () => ev(`return window.__FS.doc();`);
    const resetDoc = async () => { await ev(`return window.__FS.reset(${JSON.stringify(DOC)});`); await ui.sleep(520); return (await $doc()) === DOC; };

    const mouse = async (x, y) => {
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    };
    const clickBtn = async (titlePrefix) => {
      const box = await ev(`
        const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = bs.find(x => (x.getAttribute("title")||"").startsWith(${JSON.stringify(titlePrefix)}));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
      `);
      if (!box) return false;
      await mouse(box.x, box.y);
      return true;
    };

    // ── step 1: 造 **HELLO** ──
    await resetDoc();
    await ev(`return window.__FS.sel(${HELLO_FROM}, ${HELLO_TO});`);
    await clickBtn("粗体 (");
    await ui.sleep(900);
    const withBold = await $doc();
    ui.log(`[painter] step1 造粗体: doc=${JSON.stringify((withBold||"").slice(0, 45))}`);
    // 注意：加粗后文档长度变了，**HELLO** 起于 HELLO_FROM
    const W_FROM = HELLO_FROM;
    const W_TO = HELLO_FROM + "**HELLO**".length;
    ui.log(`[painter] 带符号区间 [${W_FROM},${W_TO}) = ${JSON.stringify((withBold||"").slice(W_FROM, W_TO))}`);

    // ── step 2: 选中带符号整段，点格式刷 → armed ──
    const selRes = await ev(`return window.__FS.sel(${W_FROM}, ${W_TO});`);
    ui.log(`[painter] step2 选区: ${JSON.stringify(selRes)}`);
    const armedOk = await clickBtn("格式刷（");
    await ui.sleep(700);
    const armed = await ev(`
      return { body: document.body.classList.contains("format-painter-armed"),
               active: Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
                 .filter(b=>b.classList.contains("active")).length };
    `);
    ui.log(`[painter] step2 armed: click=${armedOk} state=${JSON.stringify(armed)}`);

    // ── step 3: 点目标行 → 应变 **第二段落文字** ──
    // 目标行在加粗后位置要重算
    const targetBox = await ev(`
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").trim() === "第二段落文字");
      if (!line) return null;
      const r = line.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height/2), w: Math.round(r.width) };
    `);
    ui.log(`[painter] step3 目标行坐标: ${JSON.stringify(targetBox)}`);
    if (targetBox) {
      // 记录点击前 selection
      const beforeClickSel = await ev(`const s=window.__FS.view().state.selection.main; return {from:s.from,to:s.to};`);
      await mouse(targetBox.x, targetBox.y);
      await ui.sleep(1100);
      const afterClickSel = await ev(`const s=window.__FS.view().state.selection.main; return {from:s.from,to:s.to};`);
      const t = await $doc();
      const expect = withBold.replace("第二段落文字", "**第二段落文字**");
      ui.log(`[painter] step3 点击前选区=${JSON.stringify(beforeClickSel)} 点击后选区=${JSON.stringify(afterClickSel)}`);
      ui.log(`[painter] step3 结果 doc=${JSON.stringify((t||"").slice(0, 70))}`);
      ui.log(`[painter] step3 期望    =${JSON.stringify((expect||"").slice(0, 70))}`);
      ui.log(`[painter] step3 精确匹配=${t === expect}`);
      const stillArmed = await ev(`return document.body.classList.contains("format-painter-armed");`);
      ui.log(`[painter] step3 应用后仍 armed（once 模式应已退出）=${stillArmed}`);

      ui.add("P1", "格式刷：从 **HELLO** 采集 → 点目标行 → 该行被加粗", t === expect ? "PASS" : "FAIL",
        t === expect ? "精确匹配 **第二段落文字**" : `实测 ${JSON.stringify((t||"").slice(0,70))}`);
      ui.add("P2", "格式刷：单击模式（once）应用一次后自动退出 armed",
        stillArmed === false ? "PASS" : "FAIL", `仍 armed=${stillArmed}`);
    } else {
      ui.add("P1", "格式刷：点击目标行应用", "KNOWN", "找不到目标行坐标 → 测不出来");
      ui.add("P2", "格式刷：once 后退出 armed", "KNOWN", "前置未建立");
    }

    // ── 反证：不 armed 时点同一行，不该有任何变化 ──
    await resetDoc();
    await ev(`return window.__FS.sel(${LINE2_FROM}, ${LINE2_FROM});`);
    await ui.sleep(200);
    const before2 = await $doc();
    const box2 = await ev(`
      const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").trim() === "第二段落文字");
      if (!line) return null;
      const r = line.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height/2) };
    `);
    if (box2) { await mouse(box2.x, box2.y); await ui.sleep(900); }
    const after2 = await $doc();
    ui.add("P3", "破坏性对照：未 armed 时点正文 → 文档不该被改动",
      after2 === before2 ? "PASS" : "FAIL", after2 === before2 ? "文本未变" : "文本被改动了（格式刷误触发）");

    await ui.shot("painter-end");
    ui.add("Z", "专项复核完成", "KNOWN", "见日志");
  }
);
