/**
 * v0.17.0 第二轮 —— 第 7 项用户缺陷：**ghost 状态下退格无法整段删除格式符**
 *
 * ## 用户原话
 * > 「格式栏或语法栏的 ghost 文本功能，如果插入某个格式符在没有任何输入情况下
 * >   再按退格键是可以把整个格式符删掉的，但现在这个功能失效了。」
 *
 * ## 这个探针要回答的问题（按因果链顺序，逐环节取证）
 *
 * 1. **ghost 到 Backspace 那一刻还活着吗**？（`formatGhostRef.current !== null`）
 *    —— 若已被别处提前清掉，`remove()` 会直接 return false，功能必然失效。
 * 2. **宿主的 `handleSourceKeyDown` 到底有没有被调用**（Backspace）？
 *    —— CM6 的 `defaultKeymap` 里 `{key:"Backspace", run:deleteCharBackward,
 *       preventDefault:true}` 在 **keymap facet** 里，而 `keymap` facet 的
 *       `enables` 会产生 `handleKeyEvents`（`Prec.default(domEventHandlers(…))`）。
 *       若它先于宿主的 domEventHandlers 跑，就会消费掉 Backspace 并 preventDefault，
 *       **宿主那段"退格整段删除"分支根本不会被执行** —— 这才是"逐字符删除"的直接原因。
 * 3. **坐标是否一致**：`ghost.pos` vs `sourceSurface.getSelection()` vs `ghost.start/end`。
 * 4. **快照是否最新**：`sourceContentRef.current` 与 `sourceSurface.getText()` 是否相等。
 * 5. **`remove()` 的真实返回值**以及它内部是哪一条判据失败的。
 *
 * ## 仪器纪律（本项目踩过的坑，逐条遵守）
 *
 * - 采集器只装一次；重装前先断开/复位（P0-1 的"重装观察器虚高计数"教训）。
 * - **破坏性自检**：探针必须能看见"如果宿主 handler 被调用"，至少要有一条
 *   正对照证明采集器工作（用 Ctrl+Z 之外的、CM6 keymap **不**接管的键，
 *   或直接手工调用一次被包装的 handler）。
 * - 不修改产品源码（除本探针在页内挂的临时钩子），不改 dist/。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const DOC = ["# Ghost 退格", "", "第二段落文字", "", "第三段落", ""].join("\n");

/* ══════════════════ 页内仪器 ══════════════════ */
const INSTALL = `
  if (window.__GB && window.__GB.mo) { try { window.__GB.mo.disconnect(); } catch (e) {} }
  const GB = {
    ghostRef: null, handlersRef: null, surface: null,
    keydowns: [],      // 每次 Backspace 的"事件前快照"
    after: [],         // 事件后的结果
    handlerCalls: [],  // 宿主 onKeyDown 被调用的键
    removes: [],       // formatGhostHandlers.remove() 的调用与返回值
    clears: [],        // clear(kind) 调用
    tx: [],            // view.dispatch 事务
    errs: [],
  };
  window.__GB = GB;

  /* ── fiber 遍历（同 P1-6 探针）── */
  function fiberRoot() {
    const el = document.querySelector(".source-format-toolbar")
            || document.querySelector(".editor-container") || document.body;
    const k = Object.keys(el).find((n) => n.startsWith("__reactFiber$"));
    if (!k) return null;
    let f = el[k]; let g = 0;
    while (f.return && g++ < 5000) f = f.return;
    return f;
  }
  function collectRefs() {
    const root = fiberRoot(); if (!root) return [];
    const out = []; const seen = new Set();
    const v = (f) => {
      let g = 0; let h = f.memoizedState;
      while (h && typeof h === "object" && "next" in h && g++ < 800) {
        const s = h.memoizedState;
        if (s && typeof s === "object" && "current" in s && !seen.has(s)) { seen.add(s); out.push(s); }
        h = h.next;
      }
      if (f.child) v(f.child);
      if (f.sibling) v(f.sibling);
    };
    v(root); return out;
  }
  GB.collectRefs = collectRefs;
  const refs = collectRefs();
  GB.refCount = refs.length;

  // formatGhostHandlersRef：{render, clear, remove}
  GB.handlersRef = refs.find((x) => {
    const c = x.current;
    return c && typeof c === "object"
      && typeof c.render === "function" && typeof c.clear === "function" && typeof c.remove === "function";
  }) || null;

  // 包装 handlers（含破坏性自检入口）
  if (GB.handlersRef) {
    let inner = GB.handlersRef.current;
    const wrap = (v) => {
      if (!v || typeof v !== "object") return v;
      return {
        render: (...a) => { GB.clears.push({ t: performance.now(), fn: "render" }); return v.render(...a); },
        clear: (...a) => { GB.clears.push({ t: performance.now(), fn: "clear", kind: a[0] }); return v.clear(...a); },
        remove: (...a) => {
          const rec = { t: performance.now(), ret: null, ghostBefore: null, sel: null, sliceOk: null, textEq: null };
          try {
            const g = GB.ghostRef && GB.ghostRef.current;
            if (g) {
              rec.ghostBefore = { pos: g.pos, start: g.start, end: g.end, text: g.text };
              const s = GB.surface;
              if (s) {
                const sel = s.getSelection();
                rec.sel = sel;
                const cur = s.getText();
                rec.textEq = cur === g.content;
                rec.sliceOk = cur.slice(g.start, g.end) === g.content.slice(g.start, g.end);
                rec.selAtPos = sel.start === g.pos && sel.start === sel.end;
              }
            }
          } catch (e) { rec.err = String(e && e.message || e); }
          const r = v.remove(...a);
          rec.ret = !!r;
          GB.removes.push(rec);
          return r;
        },
      };
    };
    inner = wrap(inner);
    Object.defineProperty(GB.handlersRef, "current", {
      configurable: true,
      get() { return inner; },
      set(v) { inner = wrap(v); },
    });
  }

  // SourceSurface（impl === "cm6"）
  GB.surface = refs.map((x) => x.current).find(
    (c) => c && typeof c === "object" && c.impl === "cm6" && typeof c.setSelection === "function",
  ) || null;

  // 包 surface.domHandlers.onKeyDown（宿主 handler 是否被调用 / 被调用时看到什么）
  if (GB.surface) {
    try {
      const dh = GB.surface.domHandlers;
      if (dh && typeof dh.onKeyDown === "function") {
        const orig = dh.onKeyDown;
        dh.onKeyDown = (e) => {
          GB.handlerCalls.push({ t: performance.now(), key: e.key, prevented0: false });
          return orig(e);
        };
        GB.handlerPatched = true;
      } else {
        GB.handlerPatched = false;
      }
    } catch (e) { GB.errs.push("patch-domHandlers:" + (e && e.message)); }
  }

  // 事务记录（每次重建 view 后要重装 → ensureView）
  GB.ensureView = () => {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
    if (!v) return false;
    GB.view = v;
    if (!v.__gbHooked) {
      const orig = v.dispatch.bind(v);
      v.dispatch = (...a) => {
        const trs = Array.isArray(a[0]) ? a[0] : [a[0]];
        const rec = {
          t: performance.now(),
          doc: trs.some((t) => t && t.docChanged),
          sel: trs.some((t) => t && t.selection && !t.docChanged),
        };
        GB.tx.push(rec);
        try { return orig(...a); } finally {
          if (GB.tx[GB.tx.length - 1] === rec) GB.tx.pop();
        }
      };
      v.__gbHooked = true;
    }
    return true;
  };

  /* ── 事件前快照：document 捕获阶段（早于 CM6 的 .cm-content 监听）── */
  GB.snap = () => {
    const out = {
      t: performance.now(),
      ghost: null, sel: null, text: null, textLen: null,
      activeEl: (document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || null,
      viewSel: null,
    };
    try {
      if (GB.view) {
        out.text = GB.view.state.doc.toString();
        out.textLen = out.text.length;
        const m = GB.view.state.selection.main;
        out.viewSel = { from: m.from, to: m.to, empty: m.empty };
      }
    } catch (e) { out.viewErr = String(e && e.message || e); }
    try {
      if (GB.surface) out.sel = GB.surface.getSelection();
    } catch (e) { out.selErr = String(e && e.message || e); }
    try {
      const g = GB.ghostRef && GB.ghostRef.current;
      if (g) out.ghost = { pos: g.pos, start: g.start, end: g.end, text: g.text, contentLen: g.content.length };
    } catch (e) { out.ghostErr = String(e && e.message || e); }
    return out;
  };

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace") return;
    const before = GB.snap();
    GB.keydowns.push({ ...before, preventedAtCapture: e.defaultPrevented, trusted: !!e.isTrusted });
    // 事件分发结束后再看文本
    setTimeout(() => {
      const after = GB.snap();
      const rec = GB.keydowns[GB.keydowns.length - 1];
      GB.after.push({
        pairIndex: GB.keydowns.length - 1,
        beforeLen: before.textLen, afterLen: after.textLen,
        beforeText: before.text, afterText: after.text,
        ghostAfter: after.ghost, selAfter: after.sel, viewSelAfter: after.viewSel,
        t0: before.t,
      });
    }, 260);
  }, true);

  /**
   * ★ 破坏性自检：手动触发一次宿主 handler 包装器 + 一次 remove()，
   * 证明"采集器能看见调用"（否则后面的"没被调用"可能是仪器坏了）。
   */
  GB.selfTest = () => {
    const a = GB.handlerCalls.length, b = GB.removes.length;
    try { if (GB.surface && GB.surface.domHandlers && GB.surface.domHandlers.onKeyDown)
      GB.surface.domHandlers.onKeyDown({ key: "F13", preventDefault(){}, stopPropagation(){},
        shiftKey:false, ctrlKey:false, metaKey:false, altKey:false, isComposing:false, keyCode:0, nativeEvent:{} }); } catch (e) {}
    let removeThrew = null;
    try { if (GB.handlersRef) GB.handlersRef.current.remove(); } catch (e) { removeThrew = String(e && e.message || e); }
    return {
      handlerGained: GB.handlerCalls.length - a,
      removeGained: GB.removes.length - b,
      removeThrew,
    };
  };

  GB.reset = () => { GB.keydowns = []; GB.after = []; GB.handlerCalls = []; GB.removes = []; GB.clears = []; GB.tx = []; return true; };

  /** 等 ghostRef 出现（点按钮后由 React 渲染，可能下一帧才有） */
  GB.findGhostRef = () => {
    const rs = collectRefs();
    const hit = rs.find((x) => {
      const c = x.current;
      return c && typeof c === "object"
        && typeof c.pos === "number" && typeof c.start === "number"
        && typeof c.end === "number" && typeof c.content === "string";
    });
    if (hit) GB.ghostRef = hit;
    return !!hit;
  };

  return {
    refCount: GB.refCount,
    handlersRef: !!GB.handlersRef,
    surface: !!GB.surface,
    handlerPatched: !!GB.handlerPatched,
    errs: GB.errs,
  };
`;

/* ══════════════════ 探针主体 ══════════════════ */
await runBrowserProbe({ name: "v0170-r2-ghost-backspace", doc: DOC, docTitle: "Ghost 退格" }, async (ui) => {
  const ev = ui.ev;

  /* ── 0. 环境 + 仪器 ─────────────────────────────────────── */
  const env = await ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
    return {
      impl: v ? "cm6" : "other",
      doc: v ? v.state.doc.toString() : null,
      formatBtns: document.querySelectorAll(".source-format-toolbar .format-btn").length,
      syntaxItems: document.querySelectorAll(".syntax-helper-item").length,
    };
  `);
  ui.log(`[gb] 环境 impl=${env.impl} 按钮=${env.formatBtns} 语法项=${env.syntaxItems}`);

  const inst = await ev(`${INSTALL} return {
    refCount: GB.refCount, handlersRef: !!GB.handlersRef, surface: !!GB.surface,
    handlerPatched: !!GB.handlerPatched, errs: GB.errs };
  `);
  ui.log(`[gb] 仪器 ${JSON.stringify(inst)}`);
  ui.add("I0", "仪器安装（formatGhostHandlersRef / SourceSurface / 宿主 onKeyDown 均已拿到）",
    inst.handlersRef && inst.surface && inst.handlerPatched ? "PASS" : "FAIL", JSON.stringify(inst));
  await ev(`window.__GB.ensureView(); return true;`);

  /* ── 1. ★ 破坏性自检：采集器能看见"宿主管道被调用" ────── */
  const st = await ev(`return window.__GB.selfTest();`);
  ui.add("N1", "★ 破坏性自检：手工调用宿主 onKeyDown / remove() 采集器必须看见",
    st.handlerGained >= 1 && st.removeGained >= 1 ? "PASS" : "FAIL", JSON.stringify(st));
  await ev(`window.__GB.reset(); return true;`);

  /* ── 工具函数 ───────────────────────────────────────────── */
  const VIEW = `
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
  `;

  /** 复位文档 + 光标到指定行（真实鼠标点击） */
  const resetTo = async (lineIdx) => {
    for (let i = 0; i < 3; i++) {
      await ev(`
        ${VIEW}
        if (!v) return false;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} } });
        v.dispatch({ selection: { anchor: 0, head: 0 }, scrollIntoView: false });
        return true;
      `);
      await ui.sleep(420);
      const t = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
      if (t === DOC) break;
    }
    await ev(`window.__GB.findGhostRef(); window.__GB.reset(); return true;`);
    // 真实鼠标把光标放到第 lineIdx 行
    const box = await ev(`
      const ed = document.querySelector(".cm-editor");
      const lines = Array.from(ed.querySelectorAll(".cm-line"));
      const t = lines[${lineIdx}];
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) };
    `);
    if (box) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await ui.sleep(320);
    }
    return await ev(`${VIEW} if (!v) return null;
      const m = v.state.selection.main;
      return { from: m.from, to: m.to, line: v.state.doc.lineAt(m.from).text };`);
  };

  /** 点格式栏（title 前缀） */
  const clickFormat = async (prefix) => {
    const box = await ev(`
      const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = bs.find(x => (x.getAttribute("title") || "").startsWith(${JSON.stringify(prefix)}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: b.getAttribute("title") };
    `);
    if (!box) return { ok: false, why: "按钮未找到 " + prefix };
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await ui.sleep(45);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await ui.sleep(420);
    return { ok: true, title: box.title };
  };

  /** 点语法栏（文本含 name） */
  const clickSyntax = async (name) => {
    const box = await ev(`
      const items = Array.from(document.querySelectorAll(".syntax-helper-item"));
      const it = items.find(x => (x.textContent || "").includes(${JSON.stringify(name)}));
      if (!it) return null;
      it.scrollIntoView({ block: "center" });
      const r = it.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), txt: (it.textContent||"").trim().slice(0,20) };
    `);
    if (!box) return { ok: false, why: "语法项未找到 " + name };
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await ui.sleep(45);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await ui.sleep(420);
    return { ok: true, txt: box.txt };
  };

  /** 点按钮之后的完整状态（ghost / 选区 / 文本 / DOM ghost 可见性） */
  const state = async () => {
    await ev(`window.__GB.findGhostRef(); window.__GB.ensureView(); return true;`);
    return await ev(`
      const GB = window.__GB;
      ${VIEW}
      const out = { doc: v ? v.state.doc.toString() : null };
      out.viewSel = v ? (() => { const m = v.state.selection.main; return { from: m.from, to: m.to, empty: m.empty }; })() : null;
      out.surfaceSel = GB.surface ? GB.surface.getSelection() : null;
      out.surfaceText = GB.surface ? GB.surface.getText() : null;
      const g = GB.ghostRef && GB.ghostRef.current;
      out.ghost = g ? { pos: g.pos, start: g.start, end: g.end, text: g.text, tail: g.tail, maskTail: g.maskTail,
                        slice: g.content.slice(g.start, g.end) } : null;
      out.ghostDom = Array.from(document.querySelectorAll(".cm-source-ghost")).map(e => e.textContent);
      out.clears = GB.clears.slice(-8);
      return out;
    `);
  };

  /* ── 1b. ★ 正向对照：宿主 handler 的**接线**是否通（用 keymap 不管辖的键） ──
   *
   * 这是把"handler 没被调用"从"可能是仪器/接线坏了"升级成"这个键被更早的
   * 处理器吃掉了"的关键一步。CM6 的 defaultKeymap 里没有 F13，
   * 所以 F13 一定能落到宿主 handler；若 F13 也没到，说明接线本身断了（另一类缺陷）。
   */
  {
    await resetTo(1);
    await ev(`window.__GB.reset(); return true;`);
    await ui.key("F13", "F13", 124);
    await ui.sleep(300);
    const calls = await ev(`return window.__GB.handlerCalls.slice();`);
    ui.log(`[gb] F13 正向对照 handlerCalls=${JSON.stringify(calls)}`);
    ui.add("N2", "★ 正向对照：F13（CM6 keymap 不管辖）能落到宿主 handler → 接线本身是通的",
      calls.some((c) => c.key === "F13") ? "PASS" : "FAIL",
      `handlerCalls=${JSON.stringify(calls.map((c) => c.key))}`);

    // 顺带取证：Backspace 在同一套仪器下是否到宿主（与 F13 形成对照）
    await ev(`window.__GB.reset(); return true;`);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(300);
    const calls2 = await ev(`return window.__GB.handlerCalls.slice();`);
    ui.add("N3", "对照：Backspace **不**落到宿主 handler（被 CM6 keymap 先消费）",
      calls2.some((c) => c.key === "Backspace") ? "FAIL" : "PASS",
      `handlerCalls=${JSON.stringify(calls2.map((c) => c.key))}`);
  }

  /* ── 1c. 隔离实验：绕过键盘，直接调 formatGhostHandlers.remove() ──
   *
   * 用来排除 Lead 疑点 1/2/3（坐标不一致 / 快照过期 / setText 重置光标）：
   * 若直接调 remove() 能整段删净，说明 remove() 内部逻辑**是好的**，
   * 缺陷只在"它没被调用"这一层 —— 修法就不该动坐标判据。
   */
  {
    await resetTo(1);
    await ev(`window.__GB.findGhostRef(); window.__GB.reset(); return true;`);
    await clickFormat("粗体");
    await ui.sleep(260);
    const before = await ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
      return v ? v.state.doc.toString() : null;
    `);
    const r = await ev(`
      const GB = window.__GB;
      GB.findGhostRef();
      const g = GB.ghostRef && GB.ghostRef.current;
      const sel = GB.surface && GB.surface.getSelection();
      const ret = GB.handlersRef.current.remove();
      return { ret, ghostBefore: g ? { pos: g.pos, start: g.start, end: g.end } : null, sel };
    `);
    await ui.sleep(500);
    const after = await ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
      return v ? { doc: v.state.doc.toString(), sel: (() => { const m = v.state.selection.main; return { from: m.from, to: m.to }; })() } : null;
    `);
    ui.log(`[gb] 直接 remove()：${JSON.stringify(r)}`);
    ui.log(`[gb]   before=${JSON.stringify((before || "").slice(0, 40))} after=${JSON.stringify((after && after.doc || "").slice(0, 40))} sel=${JSON.stringify(after && after.sel)}`);
    ui.add("N4", "★ 隔离实验：直接调用 remove() 能整段删净（证明坐标/快照判据本身是好的，缺陷只在'没被调用'）",
      r.ret === true && after && after.doc === DOC ? "PASS" : "FAIL",
      `remove()=${r.ret} ghost=${JSON.stringify(r.ghostBefore)} sel=${JSON.stringify(r.sel)} 退格后=${JSON.stringify((after && after.doc || "").slice(0, 40))}`);

    /* 这条只报告光标是否回到插入前位置（若为 FALSE 属'删了但光标不对'的二手缺陷） */
    const caretOk = after && r.ghostBefore && after.sel && after.sel.from === r.ghostBefore.start && after.sel.to === r.ghostBefore.start;
    ui.add("N5", "直接 remove() 后光标回到插入前位置（ghost.start）",
      caretOk ? "PASS" : "FAIL",
      `ghost.start=${r.ghostBefore && r.ghostBefore.start} 实际光标=${JSON.stringify(after && after.sel)}`);
  }

  /* ── 2. 基线：格式栏「粗体」→ 立刻 Backspace ──────────── */
  const scenario = async (label, clickFn, lineIdx = 1) => {
    const pre = await resetTo(lineIdx);
    await ev(`window.__GB.findGhostRef(); window.__GB.reset(); return true;`);
    const click = await clickFn();
    await ui.sleep(260);
    const s1 = await state();
    // 按 Backspace（功能键，不带 text）
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(500);
    const s2 = await state();
    const trace = await ev(`
      const GB = window.__GB;
      return {
        keydowns: GB.keydowns.map(k => ({ ghost: k.ghost, sel: k.sel, viewSel: k.viewSel, len: k.textLen, activeEl: k.activeEl, preventedAtCapture: k.preventedAtCapture, trusted: k.trusted })),
        after: GB.after.map(a => ({ beforeLen: a.beforeLen, afterLen: a.afterLen, afterText: a.afterText, ghostAfter: a.ghostAfter, viewSelAfter: a.viewSelAfter })),
        handlerCalls: GB.handlerCalls,
        removes: GB.removes,
        clears: GB.clears,
        tx: GB.tx,
      };
    `);
    ui.log(`[gb] ── ${label} ──`);
    ui.log(`[gb]   点击前光标=${JSON.stringify(pre)}`);
    ui.log(`[gb]   点击=${JSON.stringify(click)}`);
    ui.log(`[gb]   点击后 doc=${JSON.stringify((s1.doc || "").slice(0, 40))}`);
    ui.log(`[gb]   点击后 ghost=${JSON.stringify(s1.ghost)} sel=${JSON.stringify(s1.surfaceSel)} viewSel=${JSON.stringify(s1.viewSel)} ghostDom=${JSON.stringify(s1.ghostDom)}`);
    ui.log(`[gb]   Backspace 调用链=${JSON.stringify(trace.keydowns)}`);
    ui.log(`[gb]   事务=${JSON.stringify(trace.tx)}`);
    ui.log(`[gb]   handlerCalls=${JSON.stringify(trace.handlerCalls)}`);
    ui.log(`[gb]   removes=${JSON.stringify(trace.removes)}`);
    ui.log(`[gb]   clears=${JSON.stringify(trace.clears)}`);
    ui.log(`[gb]   ⚠️ 残留：${JSON.stringify((s2.doc || "").slice(0, 60))}  ghost=${JSON.stringify(s2.ghost)} ghostDom=${JSON.stringify(s2.ghostDom)}`);
    return { label, pre, click, s1, s2, trace };
  };

  const rBold = await scenario("格式栏 粗体（空行）", () => clickFormat("粗体"));
  {
    const exactly = rBold.s2.doc === DOC;
    ui.add("G1", "★ 格式栏「粗体」→ 空输入直接 Backspace → 文本完全退回点击前",
      exactly ? "PASS" : "FAIL",
      `点击后=${JSON.stringify((rBold.s1.doc || "").slice(0, 40))} 退格后=${JSON.stringify((rBold.s2.doc || "").slice(0, 40))}`);

    /* 光标必须回到插入前位置（ghost.start = 点击前光标） */
    ui.add("G1b", "★ 退格后光标回到点击前位置（= ghost.start）",
      rBold.s1.ghost && rBold.s2.viewSel
        ? (rBold.s2.viewSel.from === rBold.s1.ghost.start && rBold.s2.viewSel.empty ? "PASS" : "FAIL")
        : "FAIL",
      `ghost.start=${rBold.s1.ghost && rBold.s1.ghost.start} 退格后光标=${JSON.stringify(rBold.s2.viewSel)}`);

    /**
     * ⚠️ G2 的判据在**修复后已改口径**（原判据断言的是修复前的机制）。
     *
     * 修复前：ghost 存活到 keydown 那一刻 —— 但那时候**没人接这个键**（死代码）。
     * 修复后：任意一个"keydown 时刻"的快照取决于监听注册顺序（document 捕获阶段
     * 可能已被宿主的 capture 监听消费），所以**不能**用 keydown 快照判存活。
     * 正确判据：**按下按键的这一瞬间，ghost 是活的** = 点完按钮后的状态快照（s1）。
     */
    ui.add("G2", "格式 ghost 在按 Backspace 之前仍存活（点击按钮后立即取样）",
      !!rBold.s1.ghost ? "PASS" : "FAIL",
      `ghost=${JSON.stringify(rBold.s1.ghost)} ghostDom=${JSON.stringify(rBold.s1.ghostDom)}`);

    /**
     * G3 同样改口径：修复后 Backspace 由**宿主新增的 document 捕获监听**接管，
     * `handleSourceKeyDown`（`setDomEventHandlers` 那条链）**故意不再承担这个键**
     * （CM6 的 keymap 会先消费它，见报告根因）。因此这里断言的是"捕获阶段拦下"。
     */
    ui.add("G3", "★ Backspace 在捕获阶段被拦下（preventedAtCapture=true）且 remove() 被调用一次",
      rBold.trace.removes.length >= 1 && rBold.trace.keydowns.length >= 1 && rBold.trace.keydowns[0].preventedAtCapture === true
        ? "PASS" : "FAIL",
      `removes=${rBold.trace.removes.length} preventedAtCapture=${rBold.trace.keydowns[0] && rBold.trace.keydowns[0].preventedAtCapture} handlerCalls(宿主旧链)=${JSON.stringify(rBold.trace.handlerCalls.map((c) => c.key))}`);

    ui.add("G4", "ghost 坐标与 CM6 选区一致（ghost.pos === sel.start === sel.end）",
      rBold.s1.ghost && rBold.s1.surfaceSel
        ? (rBold.s1.surfaceSel.start === rBold.s1.ghost.pos && rBold.s1.surfaceSel.start === rBold.s1.surfaceSel.end ? "PASS" : "FAIL")
        : "FAIL",
      `ghost.pos=${rBold.s1.ghost && rBold.s1.ghost.pos} sel=${JSON.stringify(rBold.s1.surfaceSel)}`);

    ui.add("G5", "sourceContentRef / surface 快照与 ghost.content 一致（slice 判据可过）",
      rBold.trace.removes.length > 0 ? (rBold.trace.removes[rBold.trace.removes.length - 1].sliceOk ? "PASS" : "FAIL")
        : (rBold.s1.surfaceText === DOC ? "PASS" : "FAIL"),
      `removes=${JSON.stringify(rBold.trace.removes)}`);
  }

  /* ── 3. 语法栏「粗体」 ──────────────────────────────────── */
  await ui.command("toggleSyntaxHelper").catch(() => {});
  await ui.sleep(300);
  const hasSyntax = await ev(`return document.querySelectorAll(".syntax-helper-item").length;`);
  ui.log(`[gb] 语法栏项数=${hasSyntax}`);
  const rSyntax = await scenario("语法栏 粗体（空行）", () => clickSyntax("粗体"));
  ui.add("G6", "★ 语法栏「粗体」→ 空输入 Backspace → 文本完全退回",
    rSyntax.s2.doc === DOC ? "PASS" : "FAIL",
    `点击后=${JSON.stringify((rSyntax.s1.doc || "").slice(0, 40))} 退格后=${JSON.stringify((rSyntax.s2.doc || "").slice(0, 40))}`);

  /* ── 4. 格式栏 H1（行首前缀类） ─────────────────────────── */
  const rH1 = await scenario("格式栏 标题一（空行）", () => clickFormat("标题一"));
  ui.add("G7", "★ 格式栏「标题一」→ 空输入 Backspace → 文本完全退回",
    rH1.s2.doc === DOC ? "PASS" : "FAIL",
    `点击后=${JSON.stringify((rH1.s1.doc || "").slice(0, 40))} 退格后=${JSON.stringify((rH1.s2.doc || "").slice(0, 40))}`);

  /* ── 5. 负对照①：已输入字符后 → Backspace 只删 1 字符 ───── */
  {
    await resetTo(2);
    await ev(`window.__GB.reset(); return true;`);
    await clickFormat("粗体");
    await ui.sleep(200);
    await ui.key("x", "KeyX", 88);
    await ui.sleep(300);
    const mid = await ev(`${VIEW} return { doc: v ? v.state.doc.toString() : null, sel: (() => { const m = v.state.selection.main; return { from: m.from, to: m.to }; })() };`);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(400);
    const after = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
    const expect = mid.doc.slice(0, mid.sel.from - 1) + mid.doc.slice(mid.sel.from);
    ui.add("G8", "负对照：已键入字符后 Backspace 只删 1 字符（不能误删整段格式符）",
      after === expect ? "PASS" : "FAIL",
      `键入后=${JSON.stringify((mid.doc || "").slice(0, 40))} → 退格后=${JSON.stringify((after || "").slice(0, 40))} 期望=${JSON.stringify((expect || "").slice(0, 40))}`);
  }

  /* ── 6. 负对照②：光标移开插入点后 Backspace 走默认 ─────── */
  {
    await resetTo(2);
    await ev(`window.__GB.reset(); return true;`);
    await clickFormat("粗体");
    await ui.sleep(200);
    // 光标移到行尾（离开 ghost.pos）
    await ev(`${VIEW} if (!v) return false;
      const line = v.state.doc.lineAt(0);
      v.dispatch({ selection: { anchor: line.to }, scrollIntoView: false }); return true;`);
    await ui.sleep(250);
    const mid = await ev(`${VIEW} return { doc: v ? v.state.doc.toString() : null, sel: (() => { const m = v.state.selection.main; return { from: m.from, to: m.to }; })() };`);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(400);
    const after = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
    const expect = mid.doc.slice(0, mid.sel.from - 1) + mid.doc.slice(mid.sel.from);
    ui.add("G9", "负对照：光标已离开插入点 → Backspace 走默认逐字符删除",
      after === expect ? "PASS" : "FAIL",
      `移动后=${JSON.stringify((mid.doc || "").slice(0, 40))} → 退格后=${JSON.stringify((after || "").slice(0, 40))}`);
  }

  /* ── 7. 撤销/重做：整段删除必须是"一步" ─────────────────── */
  {
    await resetTo(2);
    await ev(`window.__GB.reset(); return true;`);
    await clickFormat("粗体");
    await ui.sleep(200);
    const inserted = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(500);
    const afterDel = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
    // Ctrl+Z
    await ui.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2,
    });
    await ui.sleep(60);
    await ui.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2,
    });
    await ui.sleep(600);
    const afterUndo = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
    // Ctrl+Y
    await ui.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "y", code: "KeyY", windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers: 2,
    });
    await ui.sleep(60);
    await ui.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "y", code: "KeyY", windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89, modifiers: 2,
    });
    await ui.sleep(600);
    const afterRedo = await ev(`${VIEW} return v ? v.state.doc.toString() : null;`);
    ui.add("U1", "撤销：Ctrl+Z 一次即恢复被删的整段格式符（= 一步撤销）",
      afterDel === DOC && afterUndo === inserted ? "PASS" : "FAIL",
      `插入后=${JSON.stringify((inserted || "").slice(0, 30))} 删除后=${JSON.stringify((afterDel || "").slice(0, 30))} 撤销后=${JSON.stringify((afterUndo || "").slice(0, 30))}`);
    ui.add("U2", "重做：Ctrl+Y 一次即重新删净",
      afterRedo === afterDel ? "PASS" : "FAIL",
      `重做后=${JSON.stringify((afterRedo || "").slice(0, 30))}`);
  }
});
