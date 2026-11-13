/**
 * v0.17.0 第四轮 · T2 · 用户第 3 项：
 * **「阅读模式下在有序列表上加任务待办再按 Ctrl+Z 撤销会出现明显页面跳动。」**
 *
 * 用户还要求「**请检查和修复类似问题**」→ 不只 Ctrl+T，
 * **所有阅读模式的结构性编辑 + 撤销**都要查，并给出"哪些会跳"的清单。
 *
 * ## 为什么这一项和 #1 完全不同（主战场是 PM，不是 CM6）
 *
 * #1 的病根是 CM6 的 heightMap 整篇重估。
 * 阅读面（ProseMirror）的滚动在 `.editor-container` 上（`.ProseMirror` 本身
 * `overflow: visible`，探针已实测确认），撤销走
 * `applyHistoryTextRef` → `replaceWith`（**整篇终稿替换**）+ 内容锚恢复。
 *
 * ⇒ 嫌疑链条（来自上一轮 R2/R3 的既有实证）：
 * 1. `Cmd/Ctrl+T` 走 `pmCommands.liftListItemToTaskList` 的 `replaceWith`
 *    （前段列表 + task_list + 后段列表 三节点）→ PM 重排 → 块几何变；
 * 2. `Ctrl+Z` 走 `applyHistoryTextRef` → 再 `replaceWith` 整篇 → **块几何再变一次**；
 * 3. 两条路径各自排了 `rAF / 60ms / 160ms` 三轮回写 `container.scrollTop`
 *    → 与 PM 自己的 `tr.scrollIntoView()` 抢帧 → 用户看到抖。
 *
 * ## 判据（与 #1 同口径，这样两项数字可直接横向比较）
 *
 * | 量 | 阈值 | 判据类型 |
 * |---|---|---|
 * | 视口中心 PI 段号只出现 1 种 | 不变 | **主判据**（内容跑没跑） |
 * | **不可解释的跳变** `|Δst| - |Δsh|` | ≤ 3px | 主判据（跳没跳，且排除"内容变高导致的正常补偿"） |
 * | **反拉**（方向反转且幅度 >3px） | = 0 | 主判据（抖的字面定义） |
 * | `caretY` | — | **只诊断，不判**（同 #1 的订正理由） |
 *
 * ## 前置断言（不过 → INVALID，不产出产品结论）
 * A1 文档可滚动 / A2 光标在视口内 / A3 采样前滚动稳定 / A4 编辑真的改变了文档 /
 * A5 视口中心能读到 PI 段号 / **A6 当前确实是阅读模式**。
 *
 * ⚠️ A4 对撤销场景要特别处理：撤销会让文档**变短**，不能用"变长"判断；
 * 判据是"文本与撤销前不同"（且应回到编辑前的值）。
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t2" node scripts/v0170-r4-undo.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import {
  INSTALL_SPY, startTrace, readState, analyze, track,
  wheelTo, waitStableScroll, centerOf,
} from "./v0170-r4-scroll-lib.mjs";

/**
 * #3 需要一份**含有序列表**的文档（用户场景）：
 * 60 段正文里插入几组有序列表，保证滚到中部就能看到列表项。
 */
function makeDocWithLists(paras = 60) {
  const parts = ["# 撤销跳动审计", ""];
  for (let i = 1; i <= paras; i++) {
    parts.push(
      `PI${String(i).padStart(2, "0")} 第 ${i} 段。Lorem ipsum dolor sit amet ` +
        `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.`,
      "",
    );
    // 每 10 段插一组有序列表（滚到 45% 时大约能看到第 27 段附近的那组）
    if (i % 10 === 0) {
      parts.push(`1. 甲项 PI${String(i).padStart(2, "0")}A`, `2. 乙项 PI${String(i).padStart(2, "0")}B`, `3. 丙项 PI${String(i).padStart(2, "0")}C`, "");
    }
  }
  return parts.join("\n");
}

const DOC = makeDocWithLists(60);
const PM_SCROLLER = ".editor-container";

/** 阅读面读状态（PM 的块元素，不是 .cm-line） */
const READ_PM = readState({ kind: "pm", scroller: PM_SCROLLER });

await runBrowserProbe({ name: "v0170-r4-undo", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);

  /* ── 切阅读模式 ── */
  await ui.command("view.preview");
  await ui.sleep(2200);
  const modeCheck = await ui.ev(`
    const pm = document.querySelector(".ProseMirror");
    const sc = document.querySelector(".editor-container");
    return {
      hasPm: !!pm, hasCm: !!document.querySelector(".cm-editor"),
      scrollerOverflow: sc ? getComputedStyle(sc).overflowY : null,
      pmOverflow: pm ? getComputedStyle(pm).overflowY : null,
      pmEditable: pm ? pm.getAttribute("contenteditable") : null,
      sh: sc ? Math.round(sc.scrollHeight) : 0, ch: sc ? Math.round(sc.clientHeight) : 0,
    };
  `);
  ui.log("[mode] " + JSON.stringify(modeCheck));
  /**
   * ⚠️ A6 的判据不能写成 `!hasCm`：编辑模式是**分屏**，右侧本来就有 PM（实测 hasCm=true
   * 时 hasPm 也为 true）。真正的"阅读模式"标志是：
   * 源码面**不可见**（`.cm-editor` 的 host 被 display:none）+ 滚动在 `.editor-container` 上。
   */
  const modeReal = await ui.ev(`
    const host = document.querySelector(".source-editor");
    const cm = document.querySelector(".cm-editor");
    const pm = document.querySelector(".ProseMirror");
    const sc = document.querySelector(".editor-container");
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    let storeMode = null;
    try { storeMode = JSON.parse(localStorage.getItem("lightmd-view-mode") || "{}").viewMode || null; } catch (e) {}
    return {
      storeMode,
      cmVisible: vis(cm), pmVisible: vis(pm), scrollerVisible: vis(sc),
      scrollerSh: sc ? Math.round(sc.scrollHeight) : 0, scrollerCh: sc ? Math.round(sc.clientHeight) : 0,
    };
  `);
  ui.log("[mode-real] " + JSON.stringify(modeReal));
  ui.add("A6", "当前是阅读模式（源码面不可见 + PM 可见 + 滚动在 .editor-container 上）",
    modeReal.storeMode === "preview" && !modeReal.cmVisible && modeReal.pmVisible
      && modeReal.scrollerSh > modeReal.scrollerCh ? "PASS" : "FAIL",
    JSON.stringify(modeReal));

  await ui.ev(INSTALL_SPY);

  /**
   * 跑一个"结构性编辑 → 撤销"场景。
   *
   * @param cfg.doEdit   执行编辑的异步回调
   * @param cfg.tag      场景名
   * @param cfg.expectPmContains  编辑后文档文本应包含（用于 A4 断言"编辑真的生效"）
   */
  async function runUndoScenario(cfg) {
    const tag = cfg.tag;

    // 滚到指定位置（默认 45%）
    await wheelTo(ui, cfg.pct ?? 0.45, PM_SCROLLER, { settle: cfg.settle ?? 700 });

    // 放光标：点视口中央附近一个含 PIxx 的 PM 块
    if (cfg.prepare) {
      const ok = await cfg.prepare(ui);
      if (!ok) return { invalid: true, tag, why: "A2 prepare 失败（找不到可点元素）" };
    } else {
      const pt = await ui.ev(`
        const sc = document.querySelector(${JSON.stringify(PM_SCROLLER)});
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        let best = null, bestD = Infinity;
        for (const el of sc.querySelectorAll("p, li, h1, h2, h3")) {
          const txt = el.textContent || "";
          if (!/PI\\d{2}/.test(txt)) continue;
          const r = el.getBoundingClientRect();
          if (r.height <= 0) continue;
          const d = Math.abs((r.top + r.bottom) / 2 - midY);
          if (d < bestD) { bestD = d; best = el; }
        }
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.left + 30), y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))), text: (best.textContent||"").slice(0,30) };
      `);
      if (!pt) return { invalid: true, tag, why: "A2 找不到视口中央的 PI 块" };
      await ui.click(pt.x, pt.y);
      await ui.sleep(400);
    }

    // A3 等滚动稳定
    const stable = await waitStableScroll(ui, PM_SCROLLER, { need: 4, gap: 110 });
    const before = await ui.ev(READ_PM);
    // A1 / A2 / A5
    const a1 = before.ok && before.max > 200;
    const a2 = before.caretY !== null && before.caretY !== undefined
      && before.caretY >= -2 && before.caretY <= before.ch + 2;
    const a5 = before.pi !== null && before.pi !== undefined;
    if (!a1 || !a5 || !stable.ok) {
      return { invalid: true, tag, why: [ !a1 && `A1 不可滚动(max=${before.max})`, !a5 && "A5 无 PI 锚", !stable.ok && "A3 滚动不稳定" ].filter(Boolean).join("；"), before };
    }

    // ── 编辑阶段 ──
    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(startTrace({ ms: cfg.editMs ?? 2200, kind: "pm", scroller: PM_SCROLLER }));
    await ui.sleep(90);
    const edited = await cfg.doEdit(ui);
    await ui.sleep(cfg.editAfter ?? 2000);
    const editTrace = await ui.ev(`return window.__R4_TR || []`);
    const afterEdit = await ui.ev(READ_PM);
    const editWrites = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,how:w.how,k:w.k,s:(w.stack||[]).slice(0,4)}))`);

    /**
     * ⚠️ A4 的判据**不能是 `textContent` 变化**（本轮踩到的探针坑）：
     * 「加粗 / 标题 / 列表 / 引用」这些结构性编辑**完全不改变 textContent** ——
     * 加粗只是加 mark、标题只是换 node 类型、列表只是包一层 list。
     * 用文本比对会把**成功的编辑**判成"未生效"→ 整个矩阵 INVALID（第一版 4/6 就这样）。
     *
     * 正确判据是**结构签名**：把 PM doc 的「节点类型 + mark 类型」序列化成一个串，
     * 任何结构性编辑都会改变它，而纯文本编辑也会（因为文本在 node 里）。
     */
    const a4edit = (afterEdit.sig || "") !== (before.sig || "");
    if (!a4edit) {
      return { invalid: true, tag: tag + "（编辑未生效）", why: `A4 编辑前后文本相同 len=${(before.text||"").length}；edit=${JSON.stringify(edited)}`, before };
    }

    // ── 撤销阶段 ──
    await waitStableScroll(ui, PM_SCROLLER, { need: 3, gap: 110 });
    const beforeUndo = await ui.ev(READ_PM);
    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(startTrace({ ms: cfg.undoMs ?? 2600, kind: "pm", scroller: PM_SCROLLER }));
    await ui.sleep(90);
    // 焦点必须在 PM 上，Ctrl+Z 才会进 dynamicShortcuts
    await ui.ev(`const pm=document.querySelector(".ProseMirror"); if(pm) pm.focus(); return true;`);
    await ui.sleep(150);
    await ui.key("z", "KeyZ", 90, 2);
    await ui.sleep(cfg.undoAfter ?? 2400);
    const undoTrace = await ui.ev(`return window.__R4_TR || []`);
    const afterUndo = await ui.ev(READ_PM);
    const undoWrites = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,how:w.how,k:w.k,s:(w.stack||[]).slice(0,4)}))`);

    const a4undo = (afterUndo.sig || "") !== (beforeUndo.sig || "");
    // 撤销应当回到编辑前（严格判据：文本 == before）
    const backToOriginal = (afterUndo.sig || "") === (before.sig || "");

    return {
      tag, before, afterEdit, beforeUndo, afterUndo,
      editTrace, undoTrace, editWrites, undoWrites,
      a4edit, a4undo, backToOriginal,
      invalid: false,
      edited,
    };
  }

  /** 分析一段轨迹（编辑或撤销） */
  function analyzePhase(rec, phase) {
    const trace = phase === "edit" ? rec.editTrace : rec.undoTrace;
    const writes = phase === "edit" ? rec.editWrites : rec.undoWrites;
    const stArr = trace.map((s) => s.st);
    const shArr = trace.map((s) => s.sh);
    const piSet = [...new Set(trace.map((s) => s.pi).filter((v) => v !== null && v !== undefined))];
    const caret = analyze(trace.map((s) => s.caretY), trace.map((s) => s.t));

    // 不可解释跳变 + 反拉（同 #1 的口径，便于横向比较）
    let maxUnexplained = 0;
    const unexplainedFrames = [];
    for (let i = 1; i < trace.length; i++) {
      const dst = (stArr[i] ?? 0) - (stArr[i - 1] ?? 0);
      const dsh = (shArr[i] ?? 0) - (shArr[i - 1] ?? 0);
      const u = Math.abs(dst) - Math.abs(dsh);
      if (Math.abs(dst) > 3 && u > 3) {
        if (u > maxUnexplained) maxUnexplained = u;
        unexplainedFrames.push({ t: trace[i].t, dst: Math.round(dst * 100) / 100, dsh: Math.round(dsh * 100) / 100, u: Math.round(u * 100) / 100 });
      }
    }
    const runs = [];
    for (let i = 1; i < trace.length; i++) {
      const d = (stArr[i] ?? 0) - (stArr[i - 1] ?? 0);
      if (!Number.isFinite(d) || Math.abs(d) < 0.5) continue;
      const sign = d > 0 ? 1 : -1;
      if (!runs.length || runs[runs.length - 1].sign !== sign) runs.push({ sign, sum: 0 });
      runs[runs.length - 1].sum += d;
    }
    const counterMoves = [];
    for (let k = 1; k < runs.length; k++) {
      if (Math.abs(runs[k].sum) > 3) counterMoves.push({ prev: Math.round(runs[k - 1].sum * 100) / 100, cur: Math.round(runs[k].sum * 100) / 100 });
    }
    /**
     * ⚠️ PI 从 29 变 28 有两种完全不同的含义，必须分开（本轮实测踩到）：
     * (a) **真的漂移**：视口内容跑了（用户看到"页面跳一下"）；
     * (b) **邻近块换了个锚**：`piTop` 只变化几像素 —— 视口中线恰好压在两块交界，
     *     块高只差几 px 就会让"离中线最近的块"从 29 换成 28。这是**测量伪影**。
     *
     * 判据：看 `piTop` 的**极差**。若 PI 变了但 `piTop` 极差很小（< 1/2 行高），
     * 说明锚块的位置几乎没动 → 是 (b)。只有 `piTop` 也跟着大动才是 (a)。
     */
    const tops = trace.map((x) => x.piTop).filter((v) => v !== null && v !== undefined);
    const piTopRange = tops.length ? Math.round((Math.max(...tops) - Math.min(...tops)) * 100) / 100 : null;
    return {
      frames: trace.length,
      piSet,
      piTopRange,
      maxUnexplained: Math.round(maxUnexplained * 100) / 100,
      unexplainedFrames: unexplainedFrames.slice(0, 6),
      counterMoves,
      stNet: Math.round(((stArr[stArr.length - 1] ?? 0) - (stArr[0] ?? 0)) * 100) / 100,
      shNet: Math.round(((shArr[shArr.length - 1] ?? 0) - (shArr[0] ?? 0)) * 100) / 100,
      caret: { net: caret.net, maxJump: caret.maxJump, gaps: caret.gapCount ?? 0 },
      writeCount: writes.length,
      writes: writes.slice(0, 10),
    };
  }

  function judge(id, rec, name) {
    if (!rec) { ui.add(id, name, "FAIL", "未执行"); return null; }
    if (rec.invalid) { ui.add(id, name + "（前置断言不通过 → INVALID）", "KNOWN", rec.why); return null; }
    const e = analyzePhase(rec, "edit");
    const u = analyzePhase(rec, "undo");

    /**
     * 合并判据：编辑段与撤销段**都要**满足
     * - 内容不变（PI 只有一种取值）
     * - 无不可解释跳变（≤3px）
     * - 无反拉（=0）
     */
    /**
     * 内容锚稳定性 —— **两级判据**（第一版只看"PI 取值个数"，把邻近块换锚判成了漂移）
     *
     * 1. `piSet` 只有 1 种 → 完全稳定，PASS；
     * 2. `piSet` 有 2 种但 **`piTop` 极差 < 半个行高（14px）** → 是"视口中线压在两块交界、
     *    块高差几像素就换锚"的**测量伪影**，按 PASS 处理（并在详情里标明）；
     * 3. 否则 → 真的漂移，FAIL。
     *
     * 行高约 29px（正文），半行高 14px 的来由：小于半行高的位移用户无法分辨
     * "换了块"还是"同一块里挪了半行"，那就不构成"页面跳一下"。
     */
    const piAll = [...new Set([...e.piSet, ...u.piSet])];
    const topRanges = [e.piTopRange, u.piTopRange].filter((v) => v !== null && v !== undefined);
    const maxTopRange = topRanges.length ? Math.max(...topRanges) : null;
    const piStable = piAll.length <= 1;
    const piAdjacentOnly = !piStable && maxTopRange !== null && maxTopRange < 14;
    const jumpOk = e.maxUnexplained <= 3 && u.maxUnexplained <= 3;
    const noReverse = e.counterMoves.length === 0 && u.counterMoves.length === 0;
    const pass = (piStable || piAdjacentOnly) && jumpOk && noReverse;

    rec.phase = { edit: e, undo: u };
    rec.verdict = { piStable, piAdjacentOnly, maxTopRange, jumpOk, noReverse, backToOriginal: rec.backToOriginal };
    rec.pass = pass;
    rec.reason = [
      !piStable && !piAdjacentOnly && `内容锚真的变了（piTop 极差 ${maxTopRange}px）`,
      !jumpOk && "有不可解释跳变",
      !noReverse && "有反拉",
    ].filter(Boolean).join("、");

    ui.add(id, name, pass ? "PASS" : "FAIL",
      `编辑段：不可解释跳变=${e.maxUnexplained}px 反拉=${e.counterMoves.length} 写入=${e.writeCount} ` +
      `Δst=${e.stNet} Δsh=${e.shNet}；` +
      `撤销段：不可解释跳变=${u.maxUnexplained}px 反拉=${u.counterMoves.length} 写入=${u.writeCount} ` +
      `Δst=${u.stNet} Δsh=${u.shNet}；` +
      `PI 轨迹=${JSON.stringify(piAll)}（不变=${piStable}` +
      (piAdjacentOnly ? `，**仅邻近块换锚**：piTop 极差 ${maxTopRange}px < 14px → 测量伪影，按稳定计` : "") + `）；` +
      `撤销回到编辑前=${rec.backToOriginal}` +
      (pass ? "" : ` ← **${rec.reason}**`));
    ui.log(`[${rec.tag}] editWrites=${JSON.stringify(e.writes.map((w) => `${w.from}->${w.v}@${w.how}`))}`);
    ui.log(`[${rec.tag}] undoWrites=${JSON.stringify(u.writes.map((w) => `${w.from}->${w.v}@${w.how}`))}`);
    ui.log(`[${rec.tag}] editUnexplained=${JSON.stringify(e.unexplainedFrames)} undoUnexplained=${JSON.stringify(u.unexplainedFrames)}`);
    return rec;
  }

  /* ══════════════════════════════════════════════════════════════════
   * S1：用户报的原始场景 —— 有序列表项上 Ctrl+T → Ctrl+Z
   * ══════════════════════════════════════════════════════════════════ */
  const s1 = await runUndoScenario({
    tag: "S1-CtrlT 加待办→撤销",
    pct: 0.45,
    async prepare(u) {
      // 找一个**有序列表项**（用户场景：在有序列表上加待办）
      const pt = await u.ev(`
        const sc = document.querySelector(".editor-container");
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        const items = [];
        // ordered_list 的 li：父节点是 ol
        for (const li of sc.querySelectorAll("ol > li")) {
          const r = li.getBoundingClientRect();
          if (r.height <= 0) continue;
          items.push({ el: li, d: Math.abs((r.top + r.bottom) / 2 - midY), r, txt: (li.textContent||"").slice(0, 24) });
        }
        if (!items.length) return null;
        items.sort((a, b) => a.d - b.d);
        const best = items[0];
        return { x: Math.round(best.r.left + 24), y: Math.round(best.r.top + best.r.height / 2), text: best.txt, nOl: document.querySelectorAll("ol").length };
      `);
      if (!pt) { u.log("[S1] 视口内没有有序列表项"); return false; }
      u.log("[S1] 有序列表项 = " + JSON.stringify(pt));
      await u.click(pt.x, pt.y);
      await u.sleep(400);
      return true;
    },
    async doEdit(u) {
      // 真正按 Ctrl+T（KeyT=84），走 global 命令 → runPreviewCommand → liftListItemToTaskList
      await u.key("t", "KeyT", 84, 2);
      return { how: "Ctrl+T" };
    },
  });
  judge("U1", s1, "★ S1 有序列表 Ctrl+T 加待办 → Ctrl+Z 撤销：内容不变 + 无跳变 + 无反拉");

  /* ══════════════════════════════════════════════════════════════════
   * 「类似问题」矩阵：所有阅读模式的结构性编辑 + 撤销
   *
   * 用**工具栏/快捷键**触发（与用户真实操作一致），每项都做 编辑→撤销 两段分析。
   * 清单来自任务卡：「加粗/列表/标题/删除块/拖拽块」。
   * ══════════════════════════════════════════════════════════════════ */

  /** 通用场景：放光标到视口中央正文段落 → 触发 → 撤销 */
  function makeSimpleScenario(tag, trigger, opts = {}) {
    return runUndoScenario({
      tag,
      pct: opts.pct ?? 0.45,
      async prepare(u) {
        const pt = await u.ev(`
          const sc = document.querySelector(".editor-container");
          const scR = sc.getBoundingClientRect();
          const midY = scR.top + sc.clientHeight / 2;
          let best = null, bestD = Infinity;
          for (const el of sc.querySelectorAll("p, h1, h2, h3, li")) {
            const txt = el.textContent || "";
            if (!/PI\\d{2}/.test(txt)) continue;
            const r = el.getBoundingClientRect();
            if (r.height <= 0) continue;
            const d = Math.abs((r.top + r.bottom) / 2 - midY);
            if (d < bestD) { bestD = d; best = el; }
          }
          if (!best) return null;
          const r = best.getBoundingClientRect();
          return { x: Math.round(r.left + 24), y: Math.round(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2))), text: (best.textContent||"").slice(0, 26) };
        `);
        if (!pt) return false;
        u.log(`[${tag}] 目标 = ${JSON.stringify(pt)}`);
        await u.click(pt.x, pt.y);
        await u.sleep(350);
        // 选中一段文字（行内格式需要选区才有可见效果）
        if (opts.selectText) {
          await u.ev(`
            const pm = document.querySelector(".ProseMirror");
            const s = window.getSelection();
            const sel = s;
            if (!sel || !sel.rangeCount) return false;
            const r = sel.getRangeAt(0);
            const node = r.startContainer;
            if (!node || node.nodeType !== 3) return false;
            const start = r.startOffset;
            const end = Math.min(node.textContent.length, start + 12);
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
          `);
          await u.sleep(250);
        }
        return true;
      },
      async doEdit(u) { return await trigger(u); },
    });
  }

  // S2 加粗（Ctrl+B）
  const s2 = await makeSimpleScenario("S2-加粗→撤销", async (u) => {
    await u.key("b", "KeyB", 66, 2);
    return { how: "Ctrl+B" };
  }, { selectText: true });
  judge("U2", s2, "S2 加粗 Ctrl+B → 撤销");

  // S3 标题（Ctrl+2）
  const s3 = await makeSimpleScenario("S3-标题→撤销", async (u) => {
    await u.key("2", "Digit2", 50, 2);
    return { how: "Ctrl+2" };
  });
  judge("U3", s3, "S3 标题 H2 Ctrl+2 → 撤销");

  // S4 无序列表（Ctrl+Shift+8）
  const s4 = await makeSimpleScenario("S4-无序列表→撤销", async (u) => {
    await u.key("8", "Digit8", 56, 2 | 8); // ctrl=2 shift=8
    return { how: "Ctrl+Shift+8" };
  });
  judge("U4", s4, "S4 无序列表 Ctrl+Shift+8 → 撤销");

  // S5 引用（Ctrl+Shift+.）
  const s5 = await makeSimpleScenario("S5-引用→撤销", async (u) => {
    await u.key(".", "Period", 190, 2 | 8);
    return { how: "Ctrl+Shift+." };
  });
  judge("U5", s5, "S5 引用 Ctrl+Shift+. → 撤销");

  // S6 删除块（用 Ctrl+T 在普通段落上 → 制造 task_list 再撤销；换个"删除"语义的：
  //    选中整段文本删除 → 撤销）。这里用 Backspace 删掉整段第一行不足以跨块，
  //    改用 Ctrl+A 会选全篇（太大）。所以用「选中一段文字 + Delete」+ 撤销。
  const s6 = await makeSimpleScenario("S6-删除文字→撤销", async (u) => {
    await u.key("Delete", "Delete", 46);
    return { how: "Delete" };
  }, { selectText: true });
  judge("U6", s6, "S6 删除选中文字 Delete → 撤销");

  /* ── 汇总矩阵 ── */
  const rows = [s1, s2, s3, s4, s5, s6];
  const matrix = rows.map((r) => {
    if (!r) return { tag: "?", status: "未执行" };
    if (r.invalid) return { tag: r.tag, status: "INVALID", why: r.why };
    return {
      tag: r.tag,
      status: r.pass ? "PASS" : "FAIL",
      reason: r.reason || "",
      editMaxUnexplained: r.phase.edit.maxUnexplained,
      editCounterMoves: r.phase.edit.counterMoves.length,
      editWrites: r.phase.edit.writeCount,
      undoMaxUnexplained: r.phase.undo.maxUnexplained,
      undoCounterMoves: r.phase.undo.counterMoves.length,
      undoWrites: r.phase.undo.writeCount,
      piSet: [...new Set([...r.phase.edit.piSet, ...r.phase.undo.piSet])],
      backToOriginal: r.backToOriginal,
    };
  });
  ui.log("[MATRIX] " + JSON.stringify(matrix, null, 1));

  const measured = rows.filter((r) => r && !r.invalid);
  const passCount = measured.filter((r) => r.pass).length;
  ui.add("U0", "★ #3 总判定：阅读面「结构性编辑 + 撤销」全矩阵无跳动",
    measured.length > 0 && passCount === measured.length ? "PASS" : "FAIL",
    `测到 ${measured.length}/${rows.length} 项（INVALID=${rows.length - measured.length}）；` +
    `通过 ${passCount}/${measured.length}；` +
    `失败项=${JSON.stringify(measured.filter((r) => !r.pass).map((r) => `${r.tag}(${r.reason})`))}`);

  await ui.shot("undo");
});
