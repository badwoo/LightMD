/**
 * T3 诊断 4：**打字机开启时点击 → scrollTop 4019→0，无 JS 写入，单变量归因**
 *
 * 已确证（`v0170-r4-enter-diag3.mjs`）：
 * - scroller DOM 身份**不变**（无重建）→ 排除 H1
 * - rAF 采样里 `scrollHeight` 恒为 8796（无可见塌陷帧）→ H2 只能发生在两帧之间
 * - 唯一 JS 写入 = `scrollTo({top:3695, behavior:"smooth"})`（打字机居中）
 * - 归 0 **不经过任何 setter** ⇒ 浏览器内部行为
 *
 * 浏览器把 `scrollTop` 钳到 0 的唯一机制：**某一刻内容高度 ≤ clientHeight**
 * （`overflow-anchor` 抑制、`display:none`、或滚动容器临时失去滚动能力）。
 * rAF 采样抓不到同帧内的塌陷-恢复，所以改用 **ResizeObserver + 帧内高频采样**。
 *
 * 本探针做 5 组单变量（每组先复位到 st≈4019）：
 * | 组 | 操作 | 若归 0 说明 |
 * |---|---|---|
 * | E1 | 页面内直接 `sc.scrollTo({top:3695, behavior:"smooth"})` | 与 handleClick 无关，是 smooth 本身 |
 * | E2 | 直接 `sc.scrollTo({top:3695, behavior:"instant"})` | instant 也塌 → 与 behavior 无关 |
 * | E3 | 直接 `sc.scrollTop = 3695` | 裸赋值也塌 → 更底层 |
 * | E4 | **真实点击**（打字机开） | 基线（已确证会归 0） |
 * | E5 | 真实点击 + 捕获阶段 `stopPropagation`（屏蔽 handleClick） | 仍归 0 → 与打字机 handleClick 无关 |
 *
 * 同时记录 `sh/ch/contentH/lines/gaps` 与 `scroll` 事件时间线，抓塌陷那一刻。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-diag4", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);

  const readTw = () => ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);

  /* ── 装：写入打桩 + scroll 事件时间线 + ResizeObserver ───── */
  await ui.ev(`
    if (!window.__D4) {
      window.__D4 = true;
      window.__W = []; window.__SE = []; window.__RO = [];
      const rec = (el, v, how) => {
        try {
          const cls = String(el.className || el.tagName || "");
          if (!cls.includes("cm-")) return;
          const stack = (new Error().stack || "").split("\\n").slice(1, 8).map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));
          window.__W.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(el.scrollTop), how, stack });
        } catch (e) {}
      };
      const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true, enumerable: proto.enumerable,
        get() { return proto.get.call(this); }, set(v) { rec(this, v, "scrollTop="); return proto.set.call(this, v); },
      });
      for (const m of ["scrollTo", "scrollBy"]) {
        const o = Element.prototype[m]; if (!o) continue;
        Element.prototype[m] = function (a, b) {
          const top = (typeof a === "object" && a) ? a.top : b;
          rec(this, typeof top === "number" ? top : this.scrollTop, m + "()" + (typeof a === "object" && a && a.behavior ? ":" + a.behavior : ""));
          return o.call(this, a, b);
        };
      }
      const siv = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (a) { rec(this, this.scrollTop, "scrollIntoView(" + JSON.stringify(a || null) + ")"); return siv.apply(this, arguments); };

      // scroll 事件时间线（浏览器内部钳位也会派发）
      document.addEventListener("scroll", (e) => {
        const t = e.target;
        try {
          const cls = String(t.className || t.tagName || "");
          if (!cls.includes("cm-scroller")) return;
          window.__SE.push({ t: Math.round(performance.now()), st: Math.round(t.scrollTop * 100) / 100, sh: Math.round(t.scrollHeight), ch: t.clientHeight });
        } catch (err) {}
      }, true);

      // ResizeObserver：抓"内容高度塌陷"（rAF 采不到的同帧事件可能被它捕获）
      const startRO = () => {
        try {
          const c = document.querySelector(".cm-content");
          const ro = new ResizeObserver((entries) => {
            for (const en of entries) {
              const r = en.contentRect;
              window.__RO.push({ t: Math.round(performance.now()), h: Math.round(r.height), w: Math.round(r.width) });
            }
          });
          if (c) { ro.observe(c); window.__RO_OBJ = ro; }
          window.__RO.push({ t: Math.round(performance.now()), note: "RO attached", h: c ? Math.round(c.getBoundingClientRect().height) : null });
        } catch (e) { window.__RO.push({ t: Math.round(performance.now()), note: "RO fail " + String(e).slice(0, 60) }); }
      };
      window.__START_RO = startRO;
    }
    return true;
  `);

  const sampleTimer = `(function(){
    window.__S = [];
    const t0 = performance.now();
    // 双通道：rAF + setTimeout(0)，1ms 级更细
    const tick = () => {
      const sc = document.querySelector(".cm-scroller");
      const c = document.querySelector(".cm-content");
      const rec = { t: Math.round(performance.now() - t0) };
      if (sc) { rec.st = Math.round(sc.scrollTop * 100) / 100; rec.sh = Math.round(sc.scrollHeight); rec.ch = sc.clientHeight; }
      if (c) { rec.cH = Math.round(c.getBoundingClientRect().height); rec.lines = c.querySelectorAll(".cm-line").length; rec.gaps = c.querySelectorAll(".cm-gap").length; }
      window.__S.push(rec);
      window.__S_RAF = requestAnimationFrame(tick);
    };
    window.__S_RAF = requestAnimationFrame(tick);
  })(); return true;`;

  const stopSample = `if (window.__S_RAF) cancelAnimationFrame(window.__S_RAF); return true;`;

  const reset = async () => {
    const box = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2) };
    `);
    // 先回顶再滚到 50%（真实滚轮）
    let cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    let guard = 0;
    while (cur > 8 && guard++ < 400) {
      await ui.wheel(box.x, box.y, -Math.min(560, cur));
      cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    }
    const max = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return Math.round(sc.scrollHeight-sc.clientHeight);`);
    const target = Math.round(max * 0.5);
    guard = 0;
    while (cur < target - 8 && guard++ < 800) {
      await ui.wheel(box.x, box.y, Math.min(140, target - cur));
      const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
      if (next === cur) break;
      cur = next;
    }
    await ui.sleep(500);
    return await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight),
               x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight * 0.15) };
    `);
  };

  const runGroup = async (tag, action) => {
    const base = await reset();
    ui.log(`[${tag}] reset st=${base.st} max=${base.max}`);
    if (base.st < 1000) { ui.add(`E-${tag}`, "基线复位失败（st<1000）", "FAIL", `st=${base.st}`); return null; }
    await ui.ev(`window.__W = []; window.__SE = []; window.__RO = []; window.__START_RO(); return true;`);
    await ui.ev(sampleTimer);
    await ui.sleep(80);
    await action(base);
    await ui.sleep(1600);
    await ui.ev(stopSample);

    const S = await ui.ev(`return window.__S || []`);
    const W = await ui.ev(`return window.__W || []`);
    const SE = await ui.ev(`return window.__SE || []`);
    const RO = await ui.ev(`return window.__RO || []`);

    const stSeq = S.map((s) => s.st).filter((v) => typeof v === "number");
    const minSt = stSeq.length ? Math.min(...stSeq) : null;
    const maxSt = stSeq.length ? Math.max(...stSeq) : null;
    const minCH = S.map((s) => s.cH).filter((v) => typeof v === "number").reduce((m, v) => Math.min(m, v), Infinity);
    const maxCH = S.map((s) => s.cH).filter((v) => typeof v === "number").reduce((m, v) => Math.max(m, v), -Infinity);
    const minLines = S.map((s) => s.lines).filter((v) => typeof v === "number").reduce((m, v) => Math.min(m, v), Infinity);
    const maxGaps = S.map((s) => s.gaps).filter((v) => typeof v === "number").reduce((m, v) => Math.max(m, v), -Infinity);
    const collapsed = stSeq.some((v) => v < base.st * 0.5);

    ui.log(`[${tag}] st ${base.st} → 区间[${minSt}, ${maxSt}] 归0=${minSt !== null && minSt < 100}`);
    ui.log(`[${tag}] contentH [${minCH === Infinity ? "?" : minCH}, ${maxCH === -Infinity ? "?" : maxCH}]（终值应≈8716）lines min=${minLines} gaps max=${maxGaps}`);
    ui.log(`[${tag}] W=${W.length} ` + JSON.stringify(W.map((w) => `${w.how}:${w.v}(from ${w.from})`)));
    for (const w of W.slice(0, 6)) for (const s of (w.stack || []).slice(0, 4)) ui.log(`      ${w.how} ${s}`);
    ui.log(`[${tag}] scroll 事件 ${SE.length} 条: ` + JSON.stringify(SE.slice(0, 18).map((s) => `${s.t}:${s.st}`)));
    ui.log(`[${tag}] RO ${RO.length} 条: ` + JSON.stringify(RO.slice(0, 18)));
    // 找归 0 那一帧的上下文
    const idx = S.findIndex((s) => typeof s.st === "number" && s.st < 100);
    if (idx >= 0) ui.log(`[${tag}] 归0帧上下文: ` + JSON.stringify(S.slice(Math.max(0, idx - 3), idx + 3)));
    return { tag, base, minSt, maxSt, collapsed, W, SE, RO, minCH, maxCH, minLines, maxGaps, S };
  };

  /** 页面内执行 smooth 写入（等价于打字机 writeScrollTop） */
  const doSmoothWrite = (top) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const t = Math.max(0, Math.min(max, ${top}));
    sc.scrollTo({ top: t, behavior: "smooth" });
    return { wrote: t, st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: sc.clientHeight };
  `);
  const doInstantTo = (top) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const t = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, ${top}));
    sc.scrollTo({ top: t, behavior: "instant" }); return Math.round(sc.scrollTop);
  `);
  const doBare = (top) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const t = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, ${top}));
    sc.scrollTop = t; return Math.round(sc.scrollTop);
  `);
  const clickAt15 = (base) => ui.click(base.x, base.y);

  /* ── 保证打字机开（本项主场景）── */
  if (!(await readTw())) { await ui.command("view.toggleTypewriter"); await ui.sleep(1200); }
  ui.log("[tw] active=" + (await readTw()));

  const r1 = await runGroup("E1-smooth-write", async (b) => {
    const tgt = Math.max(0, b.st - 324);
    ui.log("[E1] 写入目标 " + tgt);
    ui.log("[E1] ret=" + JSON.stringify(await doSmoothWrite(tgt)));
  });
  const r2 = await runGroup("E2-instant-write", async (b) => {
    const tgt = Math.max(0, b.st - 324);
    ui.log("[E2] 写入目标 " + tgt + " ret=" + (await doInstantTo(tgt)));
  });
  const r3 = await runGroup("E3-bare-write", async (b) => {
    const tgt = Math.max(0, b.st - 324);
    ui.log("[E3] 写入目标 " + tgt + " ret=" + (await doBare(tgt)));
  });
  const r4 = await runGroup("E4-click", async (b) => { await clickAt15(b); });
  /** E5：捕获阶段吞掉 click，屏蔽 handleClick（打字机的点击居中入口） */
  await ui.ev(`
    if (!window.__BLOCK) {
      window.__BLOCK = true;
      window.__onBlock = (e) => { if (e.target && e.target.closest && e.target.closest(".cm-content")) { e.stopPropagation(); window.__BLOCKED = (window.__BLOCKED || 0) + 1; } };
      document.addEventListener("click", window.__onBlock, true);
    }
    window.__BLOCKED = 0; return true;
  `);
  const r5 = await runGroup("E5-click-blocked", async (b) => { await clickAt15(b); });
  ui.log("[E5] 被拦下的 click 数 = " + (await ui.ev(`return window.__BLOCKED || 0`)));

  /* ── 汇总判定 ─────────────────────────────────────────── */
  const rows = [r1, r2, r3, r4, r5].filter(Boolean);
  ui.log("[SUMMARY] " + JSON.stringify(rows.map((r) => ({
    tag: r.tag, baseSt: r.base.st, minSt: r.minSt, maxSt: r.maxSt, collapsed: r.collapsed,
    writes: r.W.length, scrollEvents: r.SE.length,
    minEffContentH: r.minCH === Infinity ? null : r.minCH, maxGap: r.maxGaps === -Infinity ? null : r.maxGaps,
  })), null, 1));

  const anyCollapse = rows.some((r) => r.collapsed);
  ui.add("E0", "★ 打字机开启时，哪些操作会让 scrollTop 从 4019 归 0",
    anyCollapse ? "FAIL" : "PASS",
    rows.map((r) => `${r.tag}: min=${r.minSt} 归0=${r.collapsed ? "是" : "否"} 写入${r.W.length}笔`).join("；"));

  await ui.shot("diag4");
});
