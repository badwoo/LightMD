/**
 * P1-6 诊断 2：**因果实验** —— 压制 `clear("input")` 后 ghost 是否就能存活？
 *
 * ## 为什么要做因果实验（而不是继续看调用序列）
 *
 * 诊断 1 已经看到：鼠标点「标题一」期间出现 **4 次 `clear("input")` + 1 次 `render`**，
 * 且 `formatGhostRef.current` 最终为 `null`、DOM 中 `.cm-source-ghost` **0 次 add**。
 * 但「有关联」不等于「是原因」。所以这里做**唯一能定因果的实验**：
 * 不动产品源码，只把记录器里的 `clear` 包装成"遇到 `input` 就吞掉"，
 * 然后重新点一次「标题一」，看 ghost 是否出现并存活。
 *
 *   - 若出现且存活 ≥1000ms  → **根因是 clear("input")**，修法就该在这一层；
 *   - 若仍不出现          → 另有原因（例如 renderFormatGhost 的自清除护栏），需重新定位。
 *
 * ## 本轮同时修掉诊断 1 的仪器缺陷
 *
 * 诊断 1 的 `wrap()` 首次安装写成：
 *     let inner = refObj.current;
 *     refObj.current = wrap(inner);        // 属性被换成 wrapper
 *     Object.defineProperty(..., get(){ return inner; });   // ← 但 inner 仍是原始值！
 * 于是**第一次 React 重渲染之前**读到的 `current` 是未包装的原对象 → 手动 `clear` 不计入
 * （诊断 1 的 I2 FAIL 就是这个原因，不是产品缺陷）。本轮改为 `inner = wrap(inner)`。
 *
 * ## 本轮的三个观测面
 *
 * 1. **谁在清**：`{render, clear, remove}` 三个方法全部记录（含参数、相对时刻）。
 * 2. **变更的性质**：包装 `view.dispatch`，记录每次事务是「改文档」还是「只改选区」。
 *    这一步用来验证一个更根本的怀疑 —— `CmSourceSurface` 的 updateListener 在
 *    **只改选区/焦点改变**时也会 `report("typing")` → `emit` → 宿主 `onDidChange`
 *    → `applySourceInput` → `clear("input")`。若成立，则"用户只是点了一下/光标动了"
 *    也会被当成"用户输入"，这比 programmatic 那条更宽。
 * 3. **是否真的没有用户输入**：监听 `beforeinput` / `input` / `keydown`（含 isTrusted），
 *    证明这条链路里**没有任何真实键入**，因此任何 clear("input") 都是误判。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# Ghost 诊断2", "", "第二段落文字", "", "第三段落", ""].join("\n");

const INSTALL = `
  if (window.__D && window.__D.mo) { try { window.__D.mo.disconnect(); } catch (e) {} }
  const D = {
    log: [], muts: [], userEvents: [], tx: [],
    mode: "observe",        // "observe" | "suppress-input"
    wrapped: false, refFound: false, errs: [],
  };
  window.__D = D;

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
      while (h && typeof h === "object" && "next" in h && g++ < 600) {
        const s = h.memoizedState;
        if (s && typeof s === "object" && "current" in s && !seen.has(s)) { seen.add(s); out.push(s); }
        h = h.next;
      }
      if (f.child) v(f.child);
      if (f.sibling) v(f.sibling);
    };
    v(root); return out;
  }
  function findHandlersRef() {
    return collectRefs().find((x) => {
      const c = x.current;
      return c && typeof c === "object"
        && typeof c.render === "function" && typeof c.clear === "function" && typeof c.remove === "function";
    }) || null;
  }

  const refObj = findHandlersRef();
  D.refFound = !!refObj;
  if (!refObj) return D;

  let inner = refObj.current;
  const wrap = (v) => {
    if (!v || typeof v !== "object" || typeof v.clear !== "function") return v;
    const mk = (name) => (...args) => {
      const swallow = name === "clear" && args[0] === "input" && D.mode === "suppress-input";
      D.log.push({
        t: performance.now(), fn: name, arg: args[0],
        swallow,
        inTx: D.tx.length ? D.tx[D.tx.length - 1].kind : null,
      });
      if (swallow) return undefined;      // ★ 因果实验：吞掉这次清除
      return v[name](...args);
    };
    return { render: mk("render"), clear: mk("clear"), remove: mk("remove") };
  };
  inner = wrap(inner);                     // ← 诊断 1 的仪器缺陷：这里曾是 refObj.current = wrap(inner)
  Object.defineProperty(refObj, "current", {
    configurable: true,
    get() { return inner; },
    set(v) { inner = wrap(v); },
  });
  D.wrapped = true;

  // ── 变更性质：包装当前 view 的 dispatch（每次重建后需重装，见 ensureDispatchHook）──
  D.ensureDispatchHook = () => {
    const c = document.querySelector(".cm-content");
    const view = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
    if (!view || view.__probeHooked) return !!view;
    const orig = view.dispatch.bind(view);
    view.dispatch = (...args) => {
      const trs = Array.isArray(args[0]) ? args[0] : [args[0]];
      const docChanged = trs.some((t) => t && t.docChanged);
      const selOnly = trs.some((t) => t && t.selection && !t.docChanged);
      const rec = {
        t: performance.now(),
        kind: docChanged ? "doc" : selOnly ? "selection-only" : "other",
        len: trs.length,
      };
      D.tx.push(rec);
      try {
        return orig(...args);
      } finally {
        // 事务同步传播完毕即出栈：后续异步调用不应再被归到这次事务
        if (D.tx[D.tx.length - 1] === rec) D.tx.pop();
      }
    };
    view.__probeHooked = true;
    return true;
  };

  // ── 用户输入事实：这条链路里到底有没有真实键入 ──
  for (const name of ["beforeinput", "input", "keydown", "paste"]) {
    document.addEventListener(name, (e) => {
      D.userEvents.push({ t: performance.now(), name, trusted: !!e.isTrusted, it: e.inputType || e.key || "" });
    }, true);
  }

  // ── ghost DOM 生命周期 ──
  D.mo = new MutationObserver((ms) => {
    for (const m of ms) {
      for (const n of m.addedNodes || [])
        if (n.nodeType === 1 && n.classList && n.classList.contains("cm-source-ghost"))
          D.muts.push({ t: performance.now(), ev: "add", txt: n.textContent });
      for (const n of m.removedNodes || [])
        if (n.nodeType === 1 && n.classList && n.classList.contains("cm-source-ghost"))
          D.muts.push({ t: performance.now(), ev: "remove", txt: n.textContent });
    }
  });
  D.mo.observe(document.body, { childList: true, subtree: true });

  /** rAF 采样 ghost 可见性（与正式探针同口径） */
  D.startSampling = (frames) => {
    D.samples = [];
    const tick = () => {
      D.samples.push({ t: performance.now(), n: document.querySelectorAll(".cm-source-ghost").length });
      if (D.samples.length < frames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  D.reset = () => { D.log = []; D.muts = []; D.userEvents = []; D.tx = []; D.samples = []; return true; };

  return D;
`;

/** 把结果里的绝对时间换算成相对基准的毫秒 */
const rel = (arr, baseMs) => arr.map((x) => ({ ...x, dt: Math.round((x.t - baseMs) * 10) / 10 }));

await runProbe(
  { name: "v0170-p1-6-diag-causal", doc: DOC, docTitle: "Ghost 诊断2" },
  async (ui) => {
    const ev = ui.ev;

    /* ────────────── 0. 安装 + 破坏性验证 ────────────── */
    const inst = await ev(`${INSTALL}
      return { refFound: D.refFound, wrapped: D.wrapped, errs: D.errs };
    `);
    ui.add("I1", "仪器安装（fiber 找到 formatGhostHandlersRef 并包装）",
      inst.refFound && inst.wrapped ? "PASS" : "FAIL", JSON.stringify(inst));

    // 破坏性验证：手动 clear 必须被记录
    const manual = await ev(`
      const refs = (function(){ const el=document.querySelector(".source-format-toolbar")||document.body;
        const k=Object.keys(el).find(n=>n.startsWith("__reactFiber$")); if(!k) return [];
        let f=el[k]; let g=0; while(f.return&&g++<5000) f=f.return;
        const out=[]; const seen=new Set();
        const v=(x)=>{ let g2=0; let h=x.memoizedState;
          while(h&&typeof h==="object"&&"next" in h&&g2++<600){ const s=h.memoizedState;
            if(s&&typeof s==="object"&&"current" in s&&!seen.has(s)){seen.add(s);out.push(s);} h=h.next; }
          if(x.child)v(x.child); if(x.sibling)v(x.sibling); };
        v(f); return out; })();
      const hs = refs.find(x => { const c = x.current;
        return c && typeof c.render==="function" && typeof c.clear==="function" && typeof c.remove==="function"; });
      if (!hs) return { ok: false, why: "handlers ref 丢失" };
      const before = window.__D.log.length;
      hs.current.clear("probe-manual");
      return { ok: true, gained: window.__D.log.length - before, last: window.__D.log[window.__D.log.length-1] };
    `);
    ui.add("I2", "★ 破坏性验证：手动 clear 能被记录器捕获（证明仪器在工作）",
      manual.ok && manual.gained >= 1 ? "PASS" : "FAIL", JSON.stringify(manual));
    await ev(`window.__D.reset(); return true;`);

    /* ────────────── 1. 定标：空行 + 点「标题一」 ────────────── */
    /** 把光标点到第 idx 行（真实鼠标）；返回落点校验 */
    const caretToLine = async (idx) => {
      const box = await ev(`
        const ed = document.querySelector(".cm-editor");
        const lines = Array.from(ed.querySelectorAll(".cm-line"));
        const t = lines[${idx}];
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return null;
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await ui.sleep(320);
      return await ev(`
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
        if (!v) return null;
        const m = v.state.selection.main;
        const line = v.state.doc.lineAt(m.from).text;
        return { from: m.from, to: m.to, empty: m.empty, line, docLen: v.state.doc.length };
      `);
    };

    /** 真实鼠标点格式栏按钮（title 前缀） */
    const clickBtn = async (prefix) => {
      const box = await ev(`
        const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = bs.find(x => (x.getAttribute("title") || "").startsWith(${JSON.stringify(prefix)}));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return { ok: false, why: "按钮未找到" };
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return { ok: true };
    };

    /** 一次"H1 点击"实验：返回完整时序 */
    const runCase = async ({ label, mode, frames = 170 }) => {
      // 复位文档到基线（dispatch 会重建程序化同步，但 P0-1 已修 → 不重建 view）
      await ev(`
        const c = document.querySelector(".cm-content");
        const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
        if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} } });
        return true;
      `);
      await ui.sleep(700);
      await ev(`window.__D.mode = ${JSON.stringify(mode)}; window.__D.ensureDispatchHook(); return window.__D.mode;`);

      const caret = await caretToLine(1);                 // index 1 = 空行
      await ev(`window.__D.reset(); window.__D.ensureDispatchHook(); window.__D.base = performance.now(); return true;`);
      await ev(`window.__D.startSampling(${frames}); return true;`);

      const c = await clickBtn("标题一");
      await ui.sleep(3100);                               // rAF ≈16ms × 170 ≈ 2.7s

      const r = await ev(`
        const D = window.__D;
        const s = D.samples || [];
        const vis = s.filter(x => x.n > 0);
        const first = s.find(x => x.n > 0);
        const last = [...s].reverse().find(x => x.n > 0);
        return {
          mode: D.mode,
          base: D.base,
          samples: s.length, visibleSamples: vis.length,
          appeared: !!first,
          firstAtMs: first ? Math.round(first.t - D.base) : null,
          lifetimeMs: first && last ? Math.round(last.t - D.base - (first.t - D.base)) : 0,
          lastAtMs: last ? Math.round(last.t - D.base) : null,
          log: D.log.map(x => ({ dt: Math.round((x.t - D.base)*10)/10, fn: x.fn, arg: x.arg, swallow: x.swallow, inTx: x.inTx })),
          muts: D.muts.map(x => ({ dt: Math.round((x.t - D.base)*10)/10, ev: x.ev, txt: x.txt })),
          tx: D.tx.map(x => ({ dt: Math.round((x.t - D.base)*10)/10, kind: x.kind })),
          userEvents: D.userEvents.map(x => ({ dt: Math.round((x.t - D.base)*10)/10, name: x.name, trusted: x.trusted, it: x.it })),
        };
      `);
      ui.log(`[${label}] caret=${JSON.stringify(caret)} click=${JSON.stringify(c)}`);
      ui.log(`[${label}] handler 序列: ${JSON.stringify(r.log)}`);
      ui.log(`[${label}] ghost DOM: ${JSON.stringify(r.muts)}`);
      ui.log(`[${label}] 事务性质: ${JSON.stringify(r.tx)}`);
      ui.log(`[${label}] 用户输入事件: ${JSON.stringify(r.userEvents)}`);
      ui.log(`[${label}] 采样: appeared=${r.appeared} firstAt=${r.firstAtMs}ms lifetime=${r.lifetimeMs}ms visible=${r.visibleSamples}/${r.samples}`);
      return r;
    };

    /* ────────────── 实验 ①：观测模式（基线） ────────────── */
    const baseCase = await runCase({ label: "①观测", mode: "observe" });

    ui.add("E1", "基线（未干预）：点「标题一」→ ghost 是否出现",
      baseCase.appeared ? "KNOWN" : "FAIL",
      `appeared=${baseCase.appeared} 可见采样 ${baseCase.visibleSamples}/${baseCase.samples} 存活 ${baseCase.lifetimeMs}ms`);

    // 关键事实：这条链路里有没有真实用户输入？
    const realInputs = baseCase.userEvents.filter((x) => x.trusted);
    ui.add("E2", "★ 这条链路里是否存在真实用户键入（决定 clear(\"input\") 是不是误判）",
      realInputs.length === 0 ? "PASS" : "KNOWN",
      realInputs.length === 0
        ? "零个 isTrusted 的 beforeinput/input/keydown ⇒ 任何 clear(\"input\") 都是**误判**，不是用户输入"
        : `有 ${realInputs.length} 个真实输入事件：${JSON.stringify(realInputs.slice(0, 4))}`);

    // 变更性质：是不是 programmatic 的整篇同步？
    const docTx = baseCase.tx.filter((x) => x.kind === "doc");
    const selTx = baseCase.tx.filter((x) => x.kind === "selection-only");
    ui.add("E3", "触发 clear 的变更性质（改文档 / 只改选区 / 两者都有）",
      "KNOWN",
      `改文档事务 ${docTx.length} 次、纯选区事务 ${selTx.length} 次 → ` +
      `${selTx.length > 0 ? "**存在「只改选区」也会走到 applySourceInput 并 clear(\"input\")」**；" : ""}` +
      `clear 次数=${baseCase.log.filter((x) => x.fn === "clear").length}`);

    /* ────────────── 实验 ②：因果干预（压制 clear("input")） ────────────── */
    const causal = await runCase({ label: "②压制", mode: "suppress-input" });

    ui.add("E4", "★ 因果实验：压制 clear(\"input\") 后点「标题一」→ ghost 是否出现",
      causal.appeared ? "PASS" : "FAIL",
      `appeared=${causal.appeared} firstAt=${causal.firstAtMs}ms 存活=${causal.lifetimeMs}ms ` +
      `可见采样=${causal.visibleSamples}/${causal.samples}；期间被吞掉的 clear("input") ` +
      `${causal.log.filter((x) => x.swallow).length} 次`);

    ui.add("E5", "★ 归因结论：ghost 不可见的原因是否就是 clear(\"input\") 在程序化/选区事务中被误调用",
      causal.appeared && causal.lifetimeMs >= 1000 ? "PASS" : (causal.appeared ? "KNOWN" : "FAIL"),
      causal.appeared && causal.lifetimeMs >= 1000
        ? `是。压制后 ghost 存活 ${causal.lifetimeMs}ms（≥1000ms），DOM add=${causal.muts.filter(m=>m.ev==="add").length} 次` +
          ` ⇒ 根因 = 宿主把"非用户输入引起的内容/选区变更"当成 input，清掉了刚设置的格式 ghost`
        : causal.appeared
          ? `部分成立：ghost 出现了但只存活 ${causal.lifetimeMs}ms，还有第二种清除源（见 handler 序列）`
          : `不成立：压制 clear 仍不出现 → 需继续查 renderFormatGhost 的自清除护栏`);

    await ui.shot("causal-after-h1");
  },
);
