/**
 * v0.17.0 R4 · T2 · 用户第 3 项 **最终验收矩阵**
 *
 * 「阅读模式下在有序列表上加任务待办再按 ctrl+z 撤销会出现明显页面跳动，
 *   **请检查和修复类似问题**。」
 *
 * ## 判据演进（本文件是第三代，前两代都被自己证伪 —— 必须记下来）
 *
 * | 代 | 判据 | 为什么错 |
 * |---|---|---|
 * | 1 | `textContent` 变化判"编辑生效" | **加粗/标题/列表完全不改变文本** → 4/6 场景误判 INVALID |
 * | 2 | 视口中心 PI 段号不变 | PI 是**离散量**：中线跨块边界就翻转，即使所有内容像素级没动也报"漂移"。实测 3/6 假红 |
 * | **3** | **锁定段落的屏幕 Y（连续量）+ 分段反转 + 零滚动写入** | 正确：连续量不受块边界影响；反转必须**分段**算（"先 Ctrl+2 再 Ctrl+Z"不是回摆）；零写入才能排除"我们主动挪视口" |
 *
 * ## 最终判据（四项全成立才 PASS）
 * 1. **段内无回摆**：编辑段、撤销段**各自内部**的锚段 Y 方向反转 = 0
 *    （"抖"= 同一次操作内部来回摆；跨操作的方向差是正常的）
 * 2. **零滚动写入**：撤销期 `scrollTop` 写入次数 = 0（我们的补偿不主动挪视口）
 * 3. **单帧 ≤3px** 或 **编辑↔撤销成对抵消**（`|Δedit + Δundo| ≤ 3`）：
 *    后者覆盖"标题↔正文换行高"这类**内容形状变化**（+16px 然后 −16px，对称且成对 = 正确还原）
 * 4. **撤销回到编辑前的结构签名**（`sig` 相等）
 *
 * ## 矩阵覆盖（用户/Lead 要求「类似问题」清单）
 * S1 有序列表 Ctrl+T 加待办 → 撤销（**用户报的原始场景**）
 * S2 加粗 / S3 标题 H2 / S4 无序列表 / S5 引用 / S6 删除选中文字
 * S7 删除块（三点菜单 delete）/ S8 移动块（moveUp）—— 覆盖"删除块/拖拽块"
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { INSTALL_SPY, wheelTo, waitStableScroll, analyze } from "./v0170-r4-scroll-lib.mjs";

function makeDocWithLists(paras = 60) {
  const parts = ["# 撤销跳动审计", ""];
  for (let i = 1; i <= paras; i++) {
    parts.push(`PI${String(i).padStart(2, "0")} 第 ${i} 段。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`, "");
    if (i % 10 === 0) parts.push(`1. 甲项 PI${String(i).padStart(2, "0")}A`, `2. 乙项 PI${String(i).padStart(2, "0")}B`, `3. 丙项 PI${String(i).padStart(2, "0")}C`, "");
  }
  return parts.join("\n");
}

const DOC = makeDocWithLists(60);
const SC = ".editor-container";

/** 逐帧：锚段屏幕 Y（连续主判据）+ scrollTop/scrollHeight + 结构签名只在首末读 */
const TRACE = (ms, anchorText) => `
  window.__T = [];
  (function () {
    const T0 = performance.now();
    const AP = ${JSON.stringify(anchorText)};
    const tick = () => {
      const sc = document.querySelector(${JSON.stringify(SC)});
      const rec = { t: Math.round(performance.now() - T0) };
      if (sc) {
        const scR = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        for (const n of sc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote")) {
          if ((n.textContent || "").indexOf(AP) >= 0) {
            rec.anchorY = Math.round((n.getBoundingClientRect().top - scR.top) * 100) / 100;
            break;
          }
        }
      }
      window.__T.push(rec);
      if (performance.now() - T0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

/** 读 PM 结构签名（判"编辑是否生效"与"撤销是否回到原样"） */
const READ_SIG = `
  const pm = document.querySelector(".ProseMirror");
  const desc = pm && pm.pmViewDesc;
  const doc = desc && desc.node;
  if (!doc || typeof doc.descendants !== "function") return null;
  const parts = [];
  doc.descendants((node) => {
    if (node.isText) { parts.push("t" + node.text.length + "[" + node.marks.map((m) => m.type.name).join(",") + "]"); return false; }
    parts.push(node.type.name + (node.attrs ? "(" + Object.entries(node.attrs).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => k + "=" + String(v)).join(",") + ")" : ""));
    return true;
  });
  return parts.join("|");
`;

await runBrowserProbe({ name: "v0170-r4-undo-matrix", doc: DOC }, async (ui) => {
  await ui.command("view.preview");
  await ui.sleep(2200);
  await ui.ev(INSTALL_SPY);

  const modeOk = await ui.ev(`
    const host = document.querySelector(".source-editor");
    const cm = document.querySelector(".cm-editor");
    const pm = document.querySelector(".ProseMirror");
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none"; };
    let m = null; try { m = JSON.parse(localStorage.getItem("lightmd-view-mode") || "{}").viewMode; } catch (e) {}
    return { m, cmVis: vis(cm), pmVis: vis(pm) };
  `);
  ui.add("A0", "前置：处于阅读模式", modeOk.m === "preview" && !modeOk.cmVis && modeOk.pmVis ? "PASS" : "FAIL", JSON.stringify(modeOk));

  /**
   * 跑一个完整场景。
   * @param cfg.pick      'ordered' | 'para' | 'any'  选目标块
   * @param cfg.select    true = 选中 12 个字符（行内格式需要）
   * @param cfg.doEdit    触发编辑
   * @param cfg.undoKey   撤销键（默认 Ctrl+Z）
   */
  async function run(cfg) {
    await wheelTo(ui, cfg.pct ?? 0.45, SC, { settle: 700 });

    const picker = cfg.pick === "ordered"
      ? `for (const li of sc.querySelectorAll("ol > li")) { const r = li.getBoundingClientRect(); if (r.height<=0) continue; const d=Math.abs((r.top+r.bottom)/2-midY); if(d<bestD){bestD=d;best=li;} }`
      : `for (const el of sc.querySelectorAll("p, h1, h2, h3, li")) { const t=el.textContent||""; if(!/PI\\d{2}/.test(t)) continue; const r=el.getBoundingClientRect(); if(r.height<=0) continue; const d=Math.abs((r.top+r.bottom)/2-midY); if(d<bestD){bestD=d;best=el;} }`;

    const pt = await ui.ev(`
      const sc = document.querySelector(${JSON.stringify(SC)});
      const scR = sc.getBoundingClientRect();
      const midY = scR.top + sc.clientHeight / 2;
      let best = null, bestD = Infinity;
      ${picker}
      if (!best) return null;
      const r = best.getBoundingClientRect();
      const m = /PI(\\d{2})/.exec(best.textContent || "");
      return { x: Math.round(r.left + 24), y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))), anchorText: "PI" + (m ? m[1] : "29"), tag: best.tagName, text: (best.textContent || "").slice(0, 26) };
    `);
    if (!pt) { ui.add(cfg.id, cfg.name, "FAIL", "找不到目标块"); return null; }

    await ui.click(pt.x, pt.y);
    await ui.sleep(380);

    if (cfg.select) {
      await ui.ev(`
        const s = window.getSelection();
        if (!s || !s.rangeCount) return false;
        const r = s.getRangeAt(0); const n = r.startContainer;
        if (!n || n.nodeType !== 3) return false;
        const a = r.startOffset, b = Math.min(n.textContent.length, a + 12);
        const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, b);
        s.removeAllRanges(); s.addRange(rg); return true;
      `);
      await ui.sleep(240);
    }

    await waitStableScroll(ui, SC, { need: 4 });
    const sigBefore = await ui.ev(READ_SIG);
    const before = await ui.ev(`const sc=document.querySelector(".editor-container"); return {st:Math.round(sc.scrollTop),sh:Math.round(sc.scrollHeight),ch:Math.round(sc.clientHeight)};`);

    // 全程采样（编辑 + 静置 + 撤销）
    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(TRACE(cfg.ms ?? 5400, pt.anchorText));
    await ui.sleep(120);

    const editOk = await cfg.doEdit(ui);
    await ui.sleep(cfg.mid ?? 1800);
    const midIdx = await ui.ev(`return (window.__T||[]).length`);
    const sigAfterEdit = await ui.ev(READ_SIG);

    // 撤销：焦点必须回到 PM
    await ui.ev(`const pm=document.querySelector(".ProseMirror"); if(pm) pm.focus(); return true;`);
    await ui.sleep(150);
    const undoT0 = await ui.ev(`return Math.round(performance.now())`);
    await ui.key("z", "KeyZ", 90, 2);
    await ui.sleep(cfg.tail ?? 2400);

    const sigAfterUndo = await ui.ev(READ_SIG);
    const trace = await ui.ev(`return window.__T || []`);
    const writes = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,how:w.how}))`);
    const undoWrites = writes.filter((w) => w.t >= undoT0 - 60);

    const editSeg = trace.slice(0, midIdx).filter((f) => typeof f.anchorY === "number");
    const undoSeg = trace.slice(midIdx).filter((f) => typeof f.anchorY === "number");
    const editA = analyze(editSeg.map((f) => f.anchorY), editSeg.map((f) => f.t), "anchorY");
    const undoA = analyze(undoSeg.map((f) => f.anchorY), undoSeg.map((f) => f.t), "anchorY");

    return {
      ...cfg, pt, sigBefore, sigAfterEdit, sigAfterUndo,
      editA, undoA, undoWrites, allWrites: writes, trace, midIdx, before,
      editApplied: sigBefore !== sigAfterEdit,
      restored: sigBefore === sigAfterUndo,
    };
  }

  /** 统一判定（四项判据） */
  function judge(rec) {
    if (!rec) return null;
    const segReversals = Math.max(rec.editA.reversals, rec.undoA.reversals);
    const noReverse = segReversals === 0;
    const noWrite = rec.undoWrites.length === 0;
    const maxJump = Math.max(rec.editA.maxJump, rec.undoA.maxJump);
    const smallJump = maxJump <= 3;
    const pairedCancel = Math.abs((rec.editA.net ?? 0) + (rec.undoA.net ?? 0)) <= 3;
    const jumpOk = smallJump || pairedCancel;
    /**
     * ⚠️ 第四处判据订正：**"块移动"不改变结构签名**（`sig` 只编码节点类型+mark+文本长度，
     * 而 moveUp 只是**换了顺序**，类型序列可以完全一样 —— 例如两个都是 paragraph 的块互换）。
     *
     * S8 实测就是这样：`sigBefore === sigAfterEdit` 但锚段 Y 净移动 **70.39px**
     * （恰好一个块高），撤销后又回到 0。那是**编辑确实生效**，只是签名看不出来。
     *
     * 所以"编辑生效"的判据要**两个来源取或**：
     * - 结构签名变了（加粗/标题/列表/删除…），**或**
     * - 锚段 Y 发生了可观测位移（块顺序变化/块高变化）。
     */
    const movedOrChanged = Math.abs(rec.editA.net ?? 0) > 0.5
      || (rec.editA.maxJump ?? 0) > 3
      || rec.editA.reversals > 0;
    const editApplied = rec.editApplied || movedOrChanged;
    const restored = rec.restored;
    const pass = editApplied && restored && noReverse && noWrite && jumpOk;

    rec.metrics = { segReversals, noWrite, maxJump, smallJump, pairedCancel, editApplied, restored };
    rec.pass = pass;

    const reason = [
      !editApplied && "编辑未生效(INVALID)",
      !restored && "撤销未回到原结构",
      !noReverse && `段内有回摆(${segReversals})`,
      !noWrite && `撤销期有 ${rec.undoWrites.length} 次滚动写入`,
      !jumpOk && `单帧 ${maxJump}px 且未成对抵消`,
    ].filter(Boolean).join("、");

    ui.add(rec.id, rec.name, pass ? "PASS" : "FAIL",
      `锚段「${rec.pt.anchorText}」Y：编辑段 maxJump=${rec.editA.maxJump}px 反转=${rec.editA.reversals} 净=${rec.editA.net}；` +
      `撤销段 maxJump=${rec.undoA.maxJump}px 反转=${rec.undoA.reversals} 净=${rec.undoA.net}；` +
      `撤销期滚动写入=${rec.undoWrites.length} 次；撤销后结构还原=${restored}` +
      (pass ? "" : ` ← ${reason}`));
    return rec;
  }

  const recs = [];

  /* S1 用户报的原始场景 */
  recs.push(judge(await run({
    id: "M1", name: "★ S1 有序列表 Ctrl+T 加待办 → Ctrl+Z", pick: "ordered",
    async doEdit(u) {
      await u.key("t", "KeyT", 84, 2);
      return true;
    },
  })));

  /* S2 加粗 */
  recs.push(judge(await run({
    id: "M2", name: "S2 加粗 Ctrl+B → 撤销", pick: "para", select: true,
    async doEdit(u) { await u.key("b", "KeyB", 66, 2); return true; },
  })));

  /* S3 标题 */
  recs.push(judge(await run({
    id: "M3", name: "S3 标题 H2 Ctrl+2 → 撤销", pick: "para",
    async doEdit(u) { await u.key("2", "Digit2", 50, 2); return true; },
  })));

  /* S4 无序列表 */
  recs.push(judge(await run({
    id: "M4", name: "S4 无序列表 Ctrl+Shift+8 → 撤销", pick: "para",
    async doEdit(u) { await u.key("8", "Digit8", 56, 2 | 8); return true; },
  })));

  /* S5 引用 */
  recs.push(judge(await run({
    id: "M5", name: "S5 引用 Ctrl+Shift+. → 撤销", pick: "para",
    async doEdit(u) { await u.key(".", "Period", 190, 2 | 8); return true; },
  })));

  /* S6 删除选中文字 */
  recs.push(judge(await run({
    id: "M6", name: "S6 删除选中文字 Delete → 撤销", pick: "para", select: true,
    async doEdit(u) { await u.key("Delete", "Delete", 46); return true; },
  })));

  /* S7 删除块（行内代码块这种"可删除节点"不好造；用"选中整段 + 剪切"等价于删除块）*/
  recs.push(judge(await run({
    id: "M7", name: "S7 删除整段（选中整段 → Delete）→ 撤销", pick: "para",
    async doEdit(u) {
      // 双击选中整段
      await u.ev(`
        const pm = document.querySelector(".ProseMirror");
        const s = window.getSelection();
        const sel = s;
        if (!sel || !sel.rangeCount) return false;
        // 扩到整个段落：找到起点所在 p 元素
        let n = sel.anchorNode;
        while (n && n.nodeType === 3) n = n.parentNode;
        while (n && n.tagName !== "P" && n.parentNode) n = n.parentNode;
        if (!n || n.tagName !== "P") return false;
        const rg = document.createRange(); rg.selectNodeContents(n);
        sel.removeAllRanges(); sel.addRange(rg); return true;
      `);
      await u.sleep(220);
      await u.key("Delete", "Delete", 46);
      return true;
    },
  })));

  /* S8 移动块（拖拽等价物：选中块 → moveUp，用键盘 Alt+↑ 或工具栏）
     ⚠️ 若 moveUp 无键位，用三点菜单里的 moveUp 走 UI。这里先试 Alt+ArrowUp。 */
  recs.push(judge(await run({
    id: "M8", name: "S8 上传块 Alt+↑ → 撤销", pick: "para",
    async doEdit(u) { await u.key("ArrowUp", "ArrowUp", 38, 1); return true; },
  })));

  const measured = recs.filter(Boolean);
  const passCount = measured.filter((r) => r.pass).length;

  /* 归类分析：找出规律（比逐条清单更有价值） */
  const byJump = measured.map((r) => ({
    tag: r.name,
    editJump: r.editA.maxJump,
    undoJump: r.undoA.maxJump,
    writes: r.undoWrites.length,
    pass: r.pass,
    // 该场景是否改变了块高（编辑期净位移 ≠ 0 通常意味着块高变了）
    blockHeightChanged: Math.abs(r.editA.net ?? 0) > 0.5,
  }));
  ui.log("[MATRIX-CLASSIFY] " + JSON.stringify(byJump, null, 1));

  ui.add("M0", "★ #3 总判定：阅读面「结构性编辑 + 撤销」全矩阵无跳动",
    measured.length === 8 && passCount === 8 ? "PASS" : "FAIL",
    `通过 ${passCount}/${measured.length}；失败=${JSON.stringify(measured.filter((r) => !r.pass).map((r) => r.name))}`);

  await ui.shot("undo-matrix");
});
