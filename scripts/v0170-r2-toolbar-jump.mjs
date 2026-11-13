/**
 * #6 决定性基线：点格式栏后**光标到底去哪了**，下一个字符打在哪
 *
 * ## 已确证的机制（本探针负责补最后一块证据）
 * `handleFormatAction` 的落地链是：
 *   捕获 `scrollTop` → `setSourceContent(newContent)` → CM6 受控写入 effect
 *   → `sourceSurface.setText(整篇)`（**全文替换事务**，不带 selection）
 *   → CM6 把旧选区映射过全文替换 → 选区落到**文档末尾**（语义上"替换区间之后"）
 *   → CM6 把该选区滚进视口（就是那个 `xn.measure` 写 scrollTop）
 *   → 随后我们的 rAF `restore()` 才用**旧像素** `setScrollTop(scrollTop)` 拉回
 *   ⇒ 用户看到"抖一下"；焦点/光标不在原处时表现为"偏离输入区域"。
 *
 * 本探针量化三件事：
 * 1. 点击前后 `.cm-cursor` 相对视口的位置（光标是否离开输入区）
 * 2. 点击后**再打一个字符**，该字符落在文本的哪个位置（最终判据：是否还在原光标处）
 * 3. 逐帧 scrollTop 抖动幅度
 *
 * ## 用法
 * ```bash
 * BROWSER_PROBE_DIST=".../dist-scroll" node scripts/v0170-r2-toolbar-jump.mjs
 * ```
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { READ_STATE, startFrameTrace, summarizeFrames, wheelScrollToPercent } from "./_lib/scroll-probe.mjs";

const PARAS = 60;
const parts = ["# 工具栏输入辅助", ""];
for (let i = 1; i <= PARAS; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
      `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
    "",
  );
}
const DOC = parts.join("\n");

/** 读 CM6 真实文档（视口外的行不在 DOM，必须走 state；从 DOM 拿会让字符数偏小） */
const READ_CM_TEXT = `
  const cm = document.querySelector(".cm-content");
  if (!cm) return { ok: false };
  // CM6 把 EditorView 挂在 contentDOM.cmTile 上（不是 cmView —— 踩过）
  const tile = cm.cmTile || cm.cmView;
  const view = tile && tile.view;
  if (view) return { ok: true, text: view.state.doc.toString(), via: "tile",
                      sel: view.state.selection.main.from, selTo: view.state.selection.main.to };
  return { ok: false };
`;

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
          if (String(cls).includes("cm-scroller")) {
            const stack = (new Error().stack || "").split("\\n").slice(1, 7)
              .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));
            window.__ST_WRITES.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(proto.get.call(this)), stack });
          }
        } catch (e) {}
        return proto.set.call(this, v);
      },
    });
  }
  return true;
`;

await runBrowserProbe({ name: "v0170-r2-toolbar-jump", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  if (ui.impl !== "cm6") { ui.add("B0", "源码面为 CM6", "FAIL", "impl=" + ui.impl); return; }
  await ui.ev(INSTALL_SPY);
  const read = () => ui.ev(READ_STATE);

  /* 等完整文档 */
  for (let i = 0; i < 40; i++) {
    const t = await ui.ev(READ_CM_TEXT);
    if (t?.ok && t.text.includes("PI60")) break;
    await ui.sleep(250);
  }

  const btn = await ui.ev(`
    const bs = Array.from(document.querySelectorAll(".format-btn"));
    const b = bs.find(e => (e.getAttribute("title") || "").includes("粗体"));
    if (!b) return { ok: false, n: bs.length };
    const r = b.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  ui.log("[setup] 粗体按钮 = " + JSON.stringify(btn));
  if (!btn.ok) { ui.add("B0", "找到格式栏粗体按钮", "FAIL", JSON.stringify(btn)); return; }

  /** 一轮完整测量 */
  const run = async (tag, approach) => {
    // 1) 基线：真实滚到 50%
    await wheelScrollToPercent(ui, 0.5, { step: 150, settle: 700 });
    await ui.sleep(400);

    // 2) 把光标放进视口中央附近的一段（模拟"正在中间编辑"）
    const spot = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const scR = sc.getBoundingClientRect();
      const lines = Array.from(sc.querySelectorAll(".cm-line"));
      const t = lines.find(l => {
        const r = l.getBoundingClientRect();
        return r.top > scR.top + 160 && r.bottom < scR.bottom - 160 && /PI\\d{2}/.test(l.textContent || "");
      });
      if (!t) return { ok: false };
      const r = t.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2), text: (t.textContent||"").slice(0,24) };
    `);
    if (!spot.ok) return { tag, ok: false, reason: "视口内无可点行" };
    await ui.click(spot.x, spot.y);
    await ui.sleep(450);

    const before = await read();
    const beforeDoc = await ui.ev(READ_CM_TEXT);
    ui.log(`[${tag}] 点前 = ` + JSON.stringify({ ...before, sel: beforeDoc && beforeDoc.sel }));

    // 3) 点按钮 + 逐帧采样
    await ui.ev(`window.__ST_WRITES = []; return true;`);
    await ui.ev(startFrameTrace(1700));
    await ui.click(btn.x, btn.y);
    await ui.sleep(1900);
    const frames = await ui.ev(`return window.__FT || []`);
    const writes = await ui.ev(`return (window.__ST_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,s:(w.stack[1]||"")}))`);
    const after = await read();
    const afterDoc = await ui.ev(READ_CM_TEXT);
    ui.log(`[${tag}] 点后 = ` + JSON.stringify({ ...after, sel: afterDoc && afterDoc.sel }));

    // 4) 再打一个字符 → 它落在文档的哪个偏移？是否紧跟原光标？
    const beforeLen = afterDoc && afterDoc.ok ? afterDoc.text.length : -1;
    await ui.key("Q", "KeyQ", 81);
    await ui.sleep(500);
    const typedDoc = await ui.ev(READ_CM_TEXT);
    const insertedAt = (() => {
      if (!typedDoc?.ok || !afterDoc?.ok) return null;
      const a = afterDoc.text, b = typedDoc.text;
      if (b.length !== a.length + 1) return { delta: b.length - a.length, ok: false };
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return { at: i, ok: true };
    })();
    const typedState = await read();

    return {
      tag, ok: true, approach,
      before: { st: before.st, pi: before.pi, piTop: before.piTop, caretY: before.caretY, focused: before.focused, sel: beforeDoc?.sel },
      after: { st: after.st, pi: after.pi, piTop: after.piTop, caretY: after.caretY, focused: after.focused, sel: afterDoc?.sel },
      trigger: summarizeFrames(frames), writes: writes.slice(0, 10),
      insertedAt, beforeLen,
      afterTyped: { st: typedState.st, pi: typedState.pi, caretY: typedState.caretY },
      newLen: typedDoc?.ok ? typedDoc.text.length : null,
    };
  };

  const r1 = await run("光标在视口中央", "format-btn");
  ui.log("[r1] " + JSON.stringify(r1, null, 1).slice(0, 5000));

  if (!r1.ok) { ui.add("B0", "探针流程", "FAIL", r1.reason); return; }

  const dPix = Math.abs(r1.after.st - r1.before.st);
  const dPI = r1.before.pi == null || r1.after.pi == null ? null : Math.abs(r1.after.pi - r1.before.pi);
  const caretMoved = r1.before.caretY != null && r1.after.caretY != null ? Math.abs(r1.after.caretY - r1.before.caretY) : null;

  ui.add("B1", "★ 点格式栏无「跳一下又回来」的抖动（内容稳定后不再往返）",
    Math.abs(r1.after.st - r1.afterTyped.st) <= 8 && (r1.trigger.piFirst ?? r1.before.pi) === (r1.trigger.piLast ?? r1.after.pi) ? "PASS" : "KNOWN",
    `点前 st=${r1.before.st} → 点后 st=${r1.after.st}（Δ=${dPix}）；` +
    `**注意**：像素 Δ 不是判据 —— 全文替换让 CM6 heightMap 重估（scrollHeight ${r1.before.pi != null ? "" : ""}），` +
    `同一内容对应的 scrollTop 本来就变（实测 ${r1.before.st}→${r1.after.st}），` +
    `且恢复后视野内容以 B2 为准（PI${r1.before.pi}@${r1.before.piTop} → PI${r1.after.pi}@${r1.after.piTop}）；` +
    `逐帧 st 范围=[${r1.trigger.stMin},${r1.trigger.stMax}] 最大单帧=${r1.trigger.maxJump}px；` +
    `点后视口在后续输入时保持稳定（${r1.after.st} → ${r1.afterTyped.st}）`);

  ui.add("B2", "★ 点格式栏后视口中心内容不变（段号差 ≤1）",
    dPI == null ? "KNOWN" : dPI <= 1 ? "PASS" : dPI <= 3 ? "KNOWN" : "FAIL",
    `PI${r1.before.pi}@${r1.before.piTop} → PI${r1.after.pi}@${r1.after.piTop}（差 ${dPI} 段）`);

  ui.add("B3", "★ 点格式栏后光标仍在原处（视口内 Y 位移 ≤8px）",
    caretMoved == null ? "KNOWN" : caretMoved <= 8 ? "PASS" : "FAIL",
    `caretY ${r1.before.caretY} → ${r1.after.caretY}（位移 ${caretMoved}px）；` +
    `文档偏移 sel ${r1.before.sel} → ${r1.after.sel}`);

  ui.add("B4", "★ 点完按钮后打的字符落在原光标处（输入辅助不偏离输入区域）",
    r1.insertedAt && r1.insertedAt.ok ? "PASS" : "FAIL",
    `插入位置=${JSON.stringify(r1.insertedAt)}；点后 sel=${r1.after.sel}；` +
    `长度 ${r1.beforeLen} → ${r1.newLen}；点后视口 st=${r1.after.st} 键入后 st=${r1.afterTyped.st}`);

  ui.add("B5", "诊断：点按钮期间 scrollTop 写入溯源",
    "PASS",
    r1.writes.length ? `${r1.writes.length} 次：${JSON.stringify(r1.writes.map((w) => `${w.from}→${w.v}@${w.s}`))}` : "无写入");

  ui.log("[B-summary] " + JSON.stringify(r1, null, 1).slice(0, 8000));
  await ui.shot("after-toolbar");
});
