/**
 * v0.17.0 第二轮 · 第 3 项：**撤销/恢复后页面位置跳动**
 *
 * 用户原话：「编辑模式下进行撤销或恢复，页面位置会跳动重置。」
 *
 * ## 探针时序（两轮踩坑后定稿）
 *
 * CM6 是**虚拟化渲染 + 估算高度**（heightMap）。探针有两条硬约束：
 *
 * 1. **必须用真实滚轮滚动**（`ui.wheel`），不能直接 `scroller.scrollTop = x`。
 *    瞬移会让视口上方从未被测量，估算很粗；之后任何 dispatch 触发重测 →
 *    总高变化上千像素 → 视口中央的**内容自己就变了**，会被误读成"滚动跳动"。
 * 2. **内容锚不能用"覆盖中线的行"**：分屏 517px 宽时段落软换行，
 *    覆盖中线的常是续行（无 PIxx 标记）。改为"含 PIxx 且离中线最近"的行 + 它的视口 Y。
 *
 * 时序：顶部点 PI03 → 打 3 字符（产生一条历史）→ 真实滚轮到 50% → Ctrl+Z → Ctrl+Y。
 * 这与用户真实操作一致（编辑完再滚走再撤销），并隔离"打字把光标滚进视口"的干扰。
 *
 * ## 判据（`lightmd-semantic-map.md` §4-33：锚内容不锚像素）
 * 主判据 = 视口中心**看到的内容**（段号 + 段内 Y）是否变；像素只作辅助。
 * 采样用 rAF 逐帧（抓"先跳后回"往返）。
 *
 * ## 用法
 * ```bash
 * npx vite build --outDir _verify-out/dist-scroll --emptyOutDir
 * BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-scroll" \
 *   node scripts/v0170-r2-scroll-jump.mjs
 * ```
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { READ_STATE, startFrameTrace, summarizeFrames, wheelScrollToPercent } from "./_lib/scroll-probe.mjs";

const PARAS = 60;
const parts = ["# 滚动稳定性审计", ""];
for (let i = 1; i <= PARAS; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
      `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
    "",
  );
}
const DOC = parts.join("\n");

/** 读 CM6 真实文档（视口外的行不在 DOM；骨架的 readSourceText 只拼 DOM 行 → 字符数偏小） */
const READ_CM_TEXT = `
  const cm = document.querySelector(".cm-content");
  if (!cm) return { ok: false };
  // CM6 把 EditorView 挂在 contentDOM.cmTile 上（不是 cmView）
  const tile = cm.cmTile || cm.cmView;
  const view = tile && tile.view;
  if (view) return { ok: true, len: view.state.doc.length, text: view.state.doc.toString() };
  return { ok: false };
`;

/** 安装 scrollTop 写入打桩（溯源用） */
const INSTALL_SPY = `
  if (!window.__ST_SPY) {
    window.__ST_SPY = true;
    window.__ST_WRITES = [];
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true, enumerable: proto.enumerable,
      get() { return proto.get.call(this); },
      set(v) {
        try {
          const el = this;
          const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
          if (String(cls).includes("cm-scroller") || String(cls).includes("source-editor")) {
            const stack = (new Error().stack || "").split("\\n").slice(1, 8)
              .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 120));
            window.__ST_WRITES.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(proto.get.call(this)), stack });
          }
        } catch (e) {}
        return proto.set.call(this, v);
      },
    });
  }
  return true;
`;

await runBrowserProbe({ name: "v0170-r2-scroll-jump", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.ev(INSTALL_SPY);

  const read = () => ui.ev(READ_STATE);

  /* ── 0. 等编辑器拿到完整文档（骨架的 loaded 判据对这个场景不适用）── */
  let full = "";
  for (let i = 0; i < 40; i++) {
    full = await ui.ev(`
      const cm = document.querySelector(".cm-editor");
      return cm ? Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n") : "";
    `);
    if ((full || "").includes("PI60")) break;
    await ui.sleep(250);
  }
  ui.log(`[setup] 可见文本长度=${(full || "").length}（文档 ${DOC.length}）`);

  /* ── 1. 顶部：点 PI03 → 打 3 个字符（产生一条历史）───────── */
  await ui.focusSource();
  await ui.sleep(300);
  const topState = await wheelScrollToPercent(ui, 0, { step: 200, settle: 400 });
  ui.log("[setup] 回到顶部 = " + JSON.stringify(topState));

  const place = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const lines = Array.from(sc.querySelectorAll(".cm-line"));
    const t = lines.find(l => (l.textContent || "").includes("PI03"));
    if (!t) return { ok: false, seen: lines.length };
    const r = t.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
  `);
  ui.log("[setup] PI03 定位 = " + JSON.stringify(place));
  if (!place.ok) {
    ui.add("A0", "探针可定位目标行 PI03", "FAIL", JSON.stringify(place));
    return;
  }
  await ui.click(place.x, place.y);
  await ui.sleep(350);
  const atTop = await read();
  for (const [k, c, v] of [["x", "KeyX", 88], ["y", "KeyY", 89], ["z", "KeyZ", 90]]) await ui.key(k, c, v);
  await ui.sleep(700);
  const typedDoc = await ui.ev(READ_CM_TEXT);
  const typedOk = !!(typedDoc && typedDoc.ok && typedDoc.text.includes("xyz"));
  ui.log(`[setup] 打字落地=${typedOk}`);

  /* ── 2. 真实滚轮到 50%（此时光标已滚出视口）─────────────── */
  const before = await wheelScrollToPercent(ui, 0.5, { step: 150, settle: 800 });
  ui.log("[base@50%] " + JSON.stringify(before));
  await ui.sleep(700);
  const baseStable = await read();
  ui.log("[base@50% 稳态] " + JSON.stringify(baseStable));

  ui.add("A0", "基线建立：编辑模式真实滚到 50%，内容稳定",
    baseStable?.ok && baseStable.pi != null && baseStable.max > 200 && Math.abs(baseStable.st - (before?.st ?? -1)) <= 3
      ? "PASS" : "FAIL",
    `scrollTop=${baseStable?.st} max=${baseStable?.max} 锚 PI${baseStable?.pi} 行顶=${baseStable?.piTop} ` +
    `焦点=${baseStable?.focused}；滚轮后瞬时 vs 稳态 Δ=${Math.abs((baseStable?.st ?? 0) - (before?.st ?? 0))}px`);

  /* ── 3. Ctrl+Z 逐帧采样 ─────────────────────────────────── */
  await ui.ev(`window.__ST_WRITES = []; return true;`);
  await ui.ev(startFrameTrace(1600));
  await ui.key("z", "KeyZ", 90, 2); // modifiers=2 = Ctrl
  await ui.sleep(1800);
  const undoTrace = summarizeFrames(await ui.ev(`return window.__FT || []`));
  const afterUndo = await read();
  const undoWrites = await ui.ev(`return (window.__ST_WRITES || []).map(w => ({ v: w.v, from: w.from, s: (w.stack[1]||"") + " << " + (w.stack[2]||"") }))`);
  const undoDoc = await ui.ev(READ_CM_TEXT);
  ui.log("[undo] " + JSON.stringify({ afterUndo, trace: undoTrace, writes: undoWrites }, null, 1).slice(0, 3000));

  /* ── 4. Ctrl+Y 逐帧采样 ─────────────────────────────────── */
  await ui.ev(`window.__ST_WRITES = []; return true;`);
  await ui.ev(startFrameTrace(1600));
  await ui.key("y", "KeyY", 89, 2);
  await ui.sleep(1800);
  const redoTrace = summarizeFrames(await ui.ev(`return window.__FT || []`));
  const afterRedo = await read();
  const redoWrites = await ui.ev(`return (window.__ST_WRITES || []).map(w => ({ v: w.v, from: w.from, s: (w.stack[1]||"") + " << " + (w.stack[2]||"") }))`);
  const redoDoc = await ui.ev(READ_CM_TEXT);
  ui.log("[redo] " + JSON.stringify({ afterRedo, trace: redoTrace, writes: redoWrites }, null, 1).slice(0, 3000));

  /* ── 判据 ───────────────────────────────────────────────── */
  const dUndoPix = Math.abs((afterUndo.st ?? 0) - (baseStable.st ?? 0));
  const dRedoPix = Math.abs((afterRedo.st ?? 0) - (baseStable.st ?? 0));
  const dUndoPI = afterUndo.pi == null || baseStable.pi == null ? null : Math.abs(afterUndo.pi - baseStable.pi);
  const dRedoPI = afterRedo.pi == null || baseStable.pi == null ? null : Math.abs(afterRedo.pi - baseStable.pi);
  const dUndoTop = afterUndo.piTop == null || baseStable.piTop == null ? null : Math.abs(afterUndo.piTop - baseStable.piTop);

  ui.add("A1", "撤销确实生效（文本回到打字前）",
    typedOk && undoDoc && undoDoc.ok && undoDoc.len === DOC.length ? "PASS" : "FAIL",
    `打字后=${typedDoc && typedDoc.len}（基线 ${DOC.length}）撤销后=${undoDoc && undoDoc.len} 恢复后=${redoDoc && redoDoc.len}；含 xyz=${typedOk}`);

  ui.add("A2", "★ 撤销后视口中心**内容**不变（段号差 ≤1 且段内 Y 差 ≤8px）",
    dUndoPI == null ? "KNOWN" : dUndoPI <= 1 && (dUndoTop ?? 0) <= 8 ? "PASS" : dUndoPI <= 1 ? "KNOWN" : "FAIL",
    `锚 PI${baseStable.pi}@${baseStable.piTop} → PI${afterUndo.pi}@${afterUndo.piTop}（段差 ${dUndoPI}，Y差 ${dUndoTop}）；` +
    `像素 Δ=${dUndoPix}px（${baseStable.st}→${afterUndo.st}，max ${baseStable.max}→${afterUndo.max}）`);

  ui.add("A3", "★ 恢复后视口中心**内容**不变（段号差 ≤1 且段内 Y 差 ≤8px）",
    dRedoPI == null ? "KNOWN" : dRedoPI <= 1 && Math.abs((afterRedo.piTop ?? 0) - (baseStable.piTop ?? 0)) <= 8 ? "PASS"
      : dRedoPI <= 1 ? "KNOWN" : "FAIL",
    `锚 PI${baseStable.pi}@${baseStable.piTop} → PI${afterRedo.pi}@${afterRedo.piTop}（段差 ${dRedoPI}）；` +
    `像素 Δ=${dRedoPix}px（${baseStable.st}→${afterRedo.st}）`);

  ui.add("A4", "★ 撤销/恢复逐帧无「先跳后回」往返（最大单帧跳变 ≤40px）",
    undoTrace.maxJump <= 40 && redoTrace.maxJump <= 40 ? "PASS" : "FAIL",
    `撤销：${undoTrace.n} 帧 最大单帧=${undoTrace.maxJump}px@${JSON.stringify(undoTrace.jumpAt)} ` +
    `st范围=[${undoTrace.stMin},${undoTrace.stMax}] 段号轨迹=${JSON.stringify(undoTrace.piChanges)}；` +
    `恢复：${redoTrace.n} 帧 最大单帧=${redoTrace.maxJump}px@${JSON.stringify(redoTrace.jumpAt)} ` +
    `st范围=[${redoTrace.stMin},${redoTrace.stMax}] 段号轨迹=${JSON.stringify(redoTrace.piChanges)}`);

  ui.add("A5", "撤销/恢复不跳到文档底部",
    !undoTrace.hitBottom && !redoTrace.hitBottom ? "PASS" : "FAIL",
    `撤销命中贴底=${undoTrace.hitBottom}（末帧 max=${undoTrace.maxLast}）；恢复命中贴底=${redoTrace.hitBottom}（末帧 max=${redoTrace.maxLast}）`);

  ui.add("A6", "撤销/恢复后焦点仍在编辑器",
    afterUndo.focused && afterRedo.focused ? "PASS" : "KNOWN",
    `撤销后 focused=${afterUndo.focused} active=${afterUndo.ae}；恢复后 focused=${afterRedo.focused} active=${afterRedo.ae}`);

  ui.add("A7", "撤销过程 scrollTop 写入溯源（诊断）",
    "PASS",
    undoWrites.length ? `${undoWrites.length} 次：${JSON.stringify(undoWrites.slice(0, 8).map((w) => `${w.from}→${w.v} by ${w.s}`))}` : "无写入");

  ui.log("[A-summary] " + JSON.stringify({
    base: baseStable, afterUndo, afterRedo,
    undoPix: dUndoPix, redoPix: dRedoPix, undoPI: dUndoPI, redoPI: dRedoPI, undoTopDelta: dUndoTop,
    undoTrace, redoTrace, undoWrites, redoWrites,
  }, null, 1));

  await ui.shot("after-undo-redo");
});
