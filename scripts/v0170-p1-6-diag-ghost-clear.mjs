/**
 * P1-6 诊断：**ghost 是被谁、在什么时刻清掉的**（零重建的页内仪器）
 *
 * ## 为什么必须先做这个诊断，不能照抄假设
 *
 * 「ghost 0/211 帧不可见」有两条互斥的候选链路，修法完全不同：
 *
 * - **候选 A（Lead 假设）**：格式按钮自己造成的内容变更经
 *   `onDidChange(origin:"programmatic")` → `applySourceInput` 首行
 *   `formatGhostHandlersRef.current.clear("input")` → `formatGhostRef = null`
 *   → 紧随其后的 rAF `render()` 因 `!ghost` 提前返回。
 *   **修法**：programmatic 变更不再当作"用户输入"清 ghost。
 *
 * - **候选 B**：rAF `render()` 跑在 `setText` 程序化同步**之前** ——
 *   此时 `sourceSurface.getText()` 还是旧文档 ≠ `ghost.content`
 *   → `renderFormatGhost` 里那道自清除护栏（**不许删**）把 ghost 判成失效并清掉。
 *   **修法**：护栏不能删，但要在"宿主状态已等于快照、只是同步还没落地"时
 *   延后重试渲染，而不是判定失效。
 *
 * 两者外部表现**完全相同**（都是"从来没有 DOM"），所以必须看内部调用顺序。
 *
 * ## 手法：React fiber 里把 formatGhostHandlersRef 包一层记录器
 *
 * 不重新打包、不改产品代码，直接从 DOM 节点的 `__reactFiber$*` 键爬到根，
 * 深度遍历 hook 链找到 `{render, clear, remove}` 那个 ref 对象
 * （它在整个树里唯一），然后在它上面装 `Object.defineProperty` 拦截**每次渲染的重新赋值**，
 * 把三个方法换成会记录 `(时间戳, 方法名, 参数)` 的包装。
 *
 * → 于是"谁在什么时候调了 clear/render、参数是什么"变成可直接观测的事实。
 *
 * ## 探针纪律（Lead 两次踩坑的教训）
 * 1. 累加型计数器重装观察器前 `disconnect()` —— 本探针**只装一次**，并在装前清掉旧的。
 * 2. 判定要有**破坏性验证**：手动调一次 `handlers.clear("probe-manual")`，
 *    必须被记录器捕获；观察器必须先人为 add+remove 一个 `.cm-source-ghost` 并计入。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = [
  "# Ghost 诊断",
  "",
  "第二段落文字",
  "",
  "第三段落",
  "",
].join("\n");

/** 安装页内仪器：fiber 找 ref + 包装 recorder + MutationObserver（只装一次） */
const INSTALL = `
  // ── 0. 幂等：重复安装前先拆旧的 ──
  if (window.__D && window.__D.mo) { try { window.__D.mo.disconnect(); } catch (e) {} }
  const D = { log: [], muts: [], wrapped: false, refFound: false, errs: [] };
  window.__D = D;

  // ── 1. 爬到 React fiber 根 ──
  function fiberRoot() {
    const el = document.querySelector(".source-format-toolbar")
            || document.querySelector(".editor-container")
            || document.body;
    const k = Object.keys(el).find((n) => n.startsWith("__reactFiber$"));
    if (!k) return null;
    let f = el[k];
    let guard = 0;
    while (f.return && guard++ < 5000) f = f.return;
    return f;
  }

  // ── 2. 遍历 hook 链，收集所有 ref 对象 ──
  function collectRefs() {
    const root = fiberRoot();
    if (!root) return [];
    const refs = [];
    const seen = new Set();
    const visit = (f) => {
      let guard = 0;
      let h = f.memoizedState;
      while (h && typeof h === "object" && "next" in h && guard++ < 500) {
        const s = h.memoizedState;
        if (s && typeof s === "object" && "current" in s && !seen.has(s)) {
          seen.add(s);
          refs.push({ ref: s, comp: (f.type && (f.type.name || f.type.displayName)) || String(f.tag) });
        }
        h = h.next;
      }
      if (f.child) visit(f.child);
      if (f.sibling) visit(f.sibling);
    };
    visit(root);
    return refs;
  }

  function findHandlers() {
    for (const r of collectRefs()) {
      const c = r.ref.current;
      if (c && typeof c === "object"
        && typeof c.render === "function" && typeof c.clear === "function" && typeof c.remove === "function") {
        return r;
      }
    }
    return null;
  }

  // ── 3. 把 handlers ref 的 current 换成记录器（对每次重新赋值都生效）──
  const found = findHandlers();
  D.refFound = !!found;
  if (!found) return D;

  const refObj = found.ref;
  D.hostComp = found.comp;
  let inner = refObj.current;
  let seq = 0;
  const wrap = (v) => {
    if (!v || typeof v !== "object" || typeof v.clear !== "function") return v;
    const id = ++seq;
    const mk = (name) => (...args) => {
      D.log.push({ t: Math.round(performance.now() * 10) / 10, fn: name, arg: args[0], id });
      return v[name](...args);
    };
    return { render: mk("render"), clear: mk("clear"), remove: mk("remove") };
  };
  try { refObj.current = wrap(inner); } catch (e) { D.errs.push("initial wrap: " + e); }
  Object.defineProperty(refObj, "current", {
    configurable: true,
    get() { return inner; },
    set(v) { inner = wrap(v); },
  });
  D.wrapped = true;

  // ── 4. ghost DOM 出现/消失（含时刻）──
  D.mo = new MutationObserver((ms) => {
    for (const m of ms) {
      for (const n of m.addedNodes || []) {
        if (n.nodeType === 1 && n.classList && n.classList.contains("cm-source-ghost")) {
          D.muts.push({ t: Math.round(performance.now() * 10) / 10, ev: "add", txt: n.textContent });
        }
      }
      for (const n of m.removedNodes || []) {
        if (n.nodeType === 1 && n.classList && n.classList.contains("cm-source-ghost")) {
          D.muts.push({ t: Math.round(performance.now() * 10) / 10, ev: "remove", txt: n.textContent });
        }
      }
    }
  });
  D.mo.observe(document.body, { childList: true, subtree: true });

  // ── 5. 记录 ghost ref 的状态快照（按 key 形态认出 formatGhostRef）──
  D.snapshotGhostRefs = () => {
    const out = [];
    for (const r of collectRefs()) {
      const c = r.ref.current;
      if (c && typeof c === "object" && "pos" in c && "content" in c) {
        out.push({ comp: r.comp, text: c.text, pos: c.pos, contentLen: (c.content || "").length });
      }
    }
    return out;
  };
  return D;
`;

await runProbe(
  { name: "v0170-p1-6-diag-ghost-clear", doc: DOC, docTitle: "Ghost 诊断" },
  async (ui) => {
    const ev = ui.ev;

    /* ── 0. 仪器安装 + **破坏性验证**（证明记录器真的在记） ── */
    const inst = await ev(`${INSTALL}
      return { refFound: D.refFound, wrapped: D.wrapped, errs: D.errs, hostComp: D.hostComp || null };
    `);
    ui.log(`[diag] 仪器：${JSON.stringify(inst)}`);
    ui.add("I1", "fiber 里找到了 formatGhostHandlersRef 并装上记录器",
      inst.refFound && inst.wrapped ? "PASS" : "FAIL",
      `refFound=${inst.refFound} wrapped=${inst.wrapped} 宿主组件=${inst.hostComp} errs=${JSON.stringify(inst.errs)}`);

    // 破坏性验证 1：手动 clear 必须被记录
    const manual = await ev(`
      const r = window.__D;
      const before = r.log.length;
      // 直接经 ref 取到记录器再调用
      const dummy = null;
      // 用 observe 到的真实 handlers 触发一次 clear
      const refEl = document.querySelector(".source-format-toolbar") || document.body;
      // 从 log 外部无法直接拿 handlers，故借"按钮真实点击"之外的路径：调用 clear 包装器
      // —— 通过 ref 对象 current（记录器）：
      // 重新找一次 ref 对象
      function root(){ const el=document.querySelector(".source-format-toolbar")||document.body;
        const k=Object.keys(el).find(n=>n.startsWith("__reactFiber$")); if(!k) return null;
        let f=el[k]; let g=0; while(f.return&&g++<5000) f=f.return; return f; }
      function refs(){ const rr=root(); if(!rr) return []; const o=[]; const seen=new Set();
        const v=(f)=>{ let g=0; let h=f.memoizedState;
          while(h&&typeof h==="object"&&"next" in h&&g++<500){ const s=h.memoizedState;
            if(s&&typeof s==="object"&&"current" in s&&!seen.has(s)){seen.add(s);o.push(s);} h=h.next; }
          if(f.child)v(f.child); if(f.sibling)v(f.sibling); };
        v(rr); return o; }
      const hs = refs().find(x => { const c = x.current;
        return c && typeof c.render==="function" && typeof c.clear==="function" && typeof c.remove==="function"; });
      if (!hs) return { ok:false, why:"handlers ref 丢失" };
      hs.current.clear("probe-manual");
      return { ok:true, gained: r.log.length - before, last: r.log[r.log.length-1] };
    `);
    ui.log(`[diag] 破坏性验证（手动 clear）：${JSON.stringify(manual)}`);
    ui.add("I2", "★ 破坏性验证：手动调 clear 能被记录器捕获（否则后面读到 0 次是仪器坏了）",
      manual.ok && manual.gained >= 1 && manual.last && manual.last.arg === "probe-manual" ? "PASS" : "FAIL",
      JSON.stringify(manual));

    // 破坏性验证 2：MutationObserver 能看到人为 add + remove
    const moCheck = await ev(`
      const r = window.__D;
      const base = r.muts.length;
      const sp = document.createElement("span");
      sp.className = "cm-source-ghost";
      sp.textContent = "probe-synthetic";
      const host = document.querySelector(".cm-content") || document.body;
      host.appendChild(sp);
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      sp.remove();
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      return { gained: r.muts.length - base, got: r.muts.slice(base) };
    `);
    ui.add("I3", "★ 破坏性验证：人为 add+remove 一个 .cm-source-ghost 能被观察器计入",
      moCheck.gained >= 2 ? "PASS" : "FAIL", JSON.stringify(moCheck.got));

    // 清掉刚才的人为痕迹与日志
    await ev(`window.__D.log = []; window.__D.muts = []; return true;`);

    /* ── 1. 准备干净基线：光标放到一个**空行**（H1 ghost 的唯一触发条件） ── */
    const info = await ev(`
      const v = (() => { const c = document.querySelector(".cm-content");
        return c && c.cmTile && c.cmTile.root && c.cmTile.root.view; })();
      const out = { hasView: !!v, lines: [] };
      const ed = document.querySelector(".cm-editor");
      if (ed) out.lines = Array.from(ed.querySelectorAll(".cm-line"))
        .map((l, i) => ({ i, t: l.textContent || "" }));
      return out;
    `);
    ui.log(`[diag] 行：${JSON.stringify(info.lines)}`);

    // 找空行（DOC 第 2 行 == 索引 1，空串）
    const empty = info.lines.find((l) => l.t === "") ?? info.lines[1];
    const caret = await ev(`
      const ed = document.querySelector(".cm-editor");
      const lines = Array.from(ed.querySelectorAll(".cm-line"));
      const t = lines[${empty.i}];
      if (!t) return { ok: false };
      const r = t.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: caret.x, y: caret.y, button: "left", clickCount: 1 });
    }
    await ui.sleep(400);
    const beforeSel = await ev(`
      const c = document.querySelector(".cm-content");
      const v = c && c.cmTile && c.cmTile.root && c.cmTile.root.view;
      if (!v) return null;
      const m = v.state.selection.main;
      return { from: m.from, to: m.to, empty: m.empty, docLen: v.state.doc.length };
    `);
    ui.log(`[diag] 光标：${JSON.stringify(beforeSel)}  （在空行 ${empty.i} 上）`);
    ui.add("I4", "光标已落在空行（H1 ghost 的触发前提）",
      beforeSel && beforeSel.empty ? "PASS" : "FAIL", JSON.stringify(beforeSel));

    // 清日志，开始记录一次"H1 点击"
    await ev(`window.__D.log = []; window.__D.muts = []; window.__D.mark = performance.now(); return true;`);

    /* ── 2. 点格式栏「标题一」 ── */
    const box = await ev(`
      const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = bs.find(x => (x.getAttribute("title") || "").startsWith("标题一"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    if (!box) { ui.add("I5", "格式栏「标题一」按钮存在", "FAIL", "找不到按钮"); return; }
    for (const type of ["mouseMoved", "mousePressed"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await ui.sleep(45);
    await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });

    // 给 rAF / effect / setText 足够的帧
    await ui.sleep(1200);

    const after = await ev(`
      const D = window.__D;
      return {
        mark: D.mark,
        log: D.log.map(x => ({ dt: Math.round((x.t - D.mark) * 10) / 10, fn: x.fn, arg: x.arg })),
        muts: D.muts.map(x => ({ dt: Math.round((x.t - D.mark) * 10) / 10, ev: x.ev, txt: x.txt })),
        ghostNow: document.querySelectorAll(".cm-source-ghost").length,
        ghostRefs: D.snapshotGhostRefs(),
        docLen: (function(){ const c=document.querySelector(".cm-content");
          const v=c&&c.cmTile&&c.cmTile.root&&c.cmTile.root.view; return v? v.state.doc.length : null; })(),
      };
    `);
    ui.log(`[diag] 点击后 handler 调用序列：${JSON.stringify(after.log)}`);
    ui.log(`[diag] ghost DOM add/remove：${JSON.stringify(after.muts)}`);
    ui.log(`[diag] 现在 ghost 数=${after.ghostNow}；ghostRef=${JSON.stringify(after.ghostRefs)}；docLen=${after.docLen}`);

    /* ── 3. 归因判定 ── */
    const hasClear = after.log.some((x) => x.fn === "clear" && x.arg === "input");
    const hasRender = after.log.some((x) => x.fn === "render");
    const clearIdx = after.log.findIndex((x) => x.fn === "clear" && x.arg === "input");
    const renderIdx = after.log.findIndex((x) => x.fn === "render");

    ui.add("A1", "候选 A：clear(\"input\") 在 ghost 设置之后被触发（programmatic 变更被当成用户输入）",
      hasClear ? "PASS" : "FAIL",
      hasClear
        ? `clear("input") 在 t=${after.log[clearIdx].dt}ms 被调用；render 在 t=${hasRender ? after.log[renderIdx].dt : "—"}ms` +
          `${hasRender && clearIdx < renderIdx ? " ⇒ **clear 先于 render**，render 因 formatGhostRef=null 提前返回" : ""}`
        : "本路径未触发 clear(\"input\")");

    ui.add("A2", "候选 B：render() 被调用了（若它自己把 ghost 判成失效，就是自清除护栏干的）",
      hasRender ? "KNOWN" : "FAIL",
      hasRender
        ? `render 在 t=${after.log[renderIdx].dt}ms 被调用；期间 clear("input")=${hasClear}` +
          `${!hasClear ? " ⇒ 无 clear 调用，ghost 仍消失 ⇒ **归因于 renderFormatGhost 的自清除护栏**" : ""}`
        : "render 一次都没被调用（rAF 没跑？）");

    ui.add("A3", "ghost DOM 是否出现过（哪怕瞬时）",
      after.muts.some((m) => m.ev === "add") ? "KNOWN" : "KNOWN",
      `add 事件 ${after.muts.filter((m) => m.ev === "add").length} 次，remove ${after.muts.filter((m) => m.ev === "remove").length} 次：` +
      JSON.stringify(after.muts));

    ui.add("A4", "★ 归因结论（供修复方案选择）",
      hasClear && hasRender && clearIdx < renderIdx ? "PASS" : (hasRender && !hasClear ? "PASS" : "FAIL"),
      hasClear && hasRender && clearIdx < renderIdx
        ? "候选 A 成立：programmatic 变更触发 clear(\"input\") → formatGhostRef=null → render 提前返回"
        : hasRender && !hasClear
          ? "候选 B 成立：无 clear(\"input\")，但 ghost 仍不可见 → 自清除护栏（getText()!==content）在同步落地前误判"
          : `两者都不成立，需重看序列：${JSON.stringify(after.log)}`);

    await ui.shot("diag-after-h1");
  },
);
