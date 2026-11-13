/**
 * T3 诊断 5：**`scrollTo()` 让 scrollTop 归 0 —— 与打字机开/关有关吗？**
 *
 * ## 已确证（`v0170-r4-enter-diag4.mjs`，打字机 ON）
 * | 组 | 操作（纯页面内，绕过所有宿主代码） | st 4019 后 | 说明 |
 * |---|---|---|---|
 * | E1 | `sc.scrollTo({top:3695, behavior:"smooth"})` | **归 0** | 1 笔写入、1 条 scroll 事件 |
 * | E2 | `sc.scrollTo({top:3695, behavior:"instant"})` | **归 0** | 同上 |
 * | E3 | `sc.scrollTop = 3695` | 正常到 3695 | — |
 * | E4 | 真实点击（打字机 handleClick → setScrollTopSmooth smooth） | **归 0** | — |
 * | E5 | 真实点击 + 捕获阶段 stopPropagation | 不动 | 证明归 0 来自 handleClick 那条 smooth 写入 |
 *
 * 且归 0 那一刻同时出现：`sh 8785→8796`、`contentH 8705→8716`、`gaps 2→1`、
 * `lines 27→19` —— **CM6 重新测量（heightMap 从估算变精确）**。
 *
 * ## 本探针要回答的关键单变量（决定缺陷归属）
 * **这个"scrollTo → 归 0"是不是打字机独有的？**（= 是不是 `typewriterMode` 相关代码）
 * 还是**所有 scrollTo 写入都有**（= R3 #8 的 smooth 通道本身有隐患）？
 *
 * | 组 | 打字机 | 写入方式 | 若归 0 说明 |
 * |---|---|---|---|
 * | G1 | OFF | `scrollTo({behavior:"smooth"})` | 与打字机无关 → R3 #8 smooth 通道的隐患 |
 * | G2 | OFF | `sc.scrollTop =` | 基线（预期不归 0） |
 * | G3 | ON  | `scrollTo({behavior:"smooth"})` | 打字机路径（已知归 0） |
 * | G4 | ON  | `sc.scrollTop =` | 基线（预期不归 0） |
 *
 * 另外补一组 G5：**OFF + 从顶部 0 处 smooth 到 3695** ——
 * 若"归 0"其实是"scrollTo 被忽略/从未生效"，表现应该不同（从 0 出发就看不出来），
 * 所以 G5 必须从**非 0 起点**出发（= 就是 G1）。
 * 加 G6：OFF + `scrollTo` 到**更小**的合法值（3695 → 3000），看是否任何 scrollTo 都归 0。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-diag5", doc: DOC }, async (ui) => {
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
  const setTw = async (want) => {
    if ((await readTw()) !== want) { await ui.command("view.toggleTypewriter"); await ui.sleep(1200); }
    return await readTw();
  };

  /* ── 打桩：写入 + scroll 事件 + 细粒度帧采样（setTimeout(0)）── */
  await ui.ev(`
    if (!window.__D5) {
      window.__D5 = true;
      window.__W = []; window.__SE = [];
      const rec = (el, v, how) => {
        try {
          const cls = String(el.className || el.tagName || "");
          if (!cls.includes("cm-")) return;
          const stack = (new Error().stack || "").split("\\n").slice(1, 8).map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));
          window.__W.push({ t: Math.round(performance.now() * 10) / 10, v: Math.round(v), from: Math.round(el.scrollTop), how, stack });
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
      document.addEventListener("scroll", (e) => {
        try {
          const cls = String(e.target.className || "");
          if (!cls.includes("cm-scroller")) return;
          window.__SE.push({ t: Math.round(performance.now() * 10) / 10, st: Math.round(e.target.scrollTop * 100) / 100, sh: Math.round(e.target.scrollHeight) });
        } catch (err) {}
      }, true);
      window.__SAMPLE = (ms) => {
        window.__S = [];
        const t0 = performance.now();
        const tick = () => {
          const sc = document.querySelector(".cm-scroller");
          if (sc) {
            window.__S.push({
              t: Math.round(performance.now() * 10) / 10,
              st: Math.round(sc.scrollTop * 100) / 100,
              sh: Math.round(sc.scrollHeight),
              lines: sc.querySelectorAll(".cm-line").length,
              gaps: sc.querySelectorAll(".cm-gap").length,
            });
          }
          if (performance.now() - t0 < ms) setTimeout(tick, 0);
        };
        tick();
      };
    }
    return true;
  `);

  const wheelBox = async () => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2) };
  `);
  const resetTo50 = async () => {
    const box = await wheelBox();
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
    await ui.sleep(600);
    return await ui.ev(`const sc=document.querySelector(".cm-scroller"); return { st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight-sc.clientHeight), sh: Math.round(sc.scrollHeight) };`);
  };

  const runGroup = async (tag, action) => {
    const base = await resetTo50();
    if (base.st < 1000) { ui.add(`G-${tag}`, "基线复位失败", "FAIL", `st=${base.st}`); return null; }
    await ui.ev(`window.__W = []; window.__SE = []; return true;`);
    await ui.ev(`window.__SAMPLE(900); return true;`);
    await ui.sleep(60);
    const ret = await action(base);
    await ui.sleep(1200);
    const S = await ui.ev(`return window.__S || []`);
    const W = await ui.ev(`return window.__W || []`);
    const SE = await ui.ev(`return window.__SE || []`);
    const stSeq = S.map((s) => s.st).filter((v) => typeof v === "number");
    const minSt = stSeq.length ? Math.min(...stSeq) : null;
    const collapsed = minSt !== null && minSt < base.st * 0.5;
    ui.log(`[${tag}] base=${base.st} ret=${JSON.stringify(ret)} → min=${minSt} 归0=${collapsed} 写入=${W.length} scroll事件=${SE.length}`);
    ui.log(`[${tag}] W=${JSON.stringify(W.map((w) => `${w.how}@${w.t}:${w.v}(from ${w.from})`))}`);
    ui.log(`[${tag}] SE=${JSON.stringify(SE.slice(0, 10).map((s) => `${s.t}:${s.st}`))}`);
    ui.log(`[${tag}] 轨迹=${JSON.stringify(S.slice(0, 22).map((s) => `${s.t}:${s.st}/sh${s.sh}/L${s.lines}`))}`);
    return { tag, base, minSt, collapsed, W, SE, S };
  };

  const doSmooth = (top) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const t = Math.max(0, Math.min(max, ${top}));
    sc.scrollTo({ top: t, behavior: "smooth" });
    return { wrote: t, r1: Math.round(sc.scrollTop) };
  `);
  const doBare = (top) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const t = Math.max(0, Math.min(max, ${top}));
    sc.scrollTop = t;
    return { wrote: t, r1: Math.round(sc.scrollTop) };
  `);

  const rows = [];
  for (const [tw, label] of [[false, "OFF"], [true, "ON"]]) {
    const s = await setTw(tw);
    ui.log(`[setup] 打字机 ${label} active=${s}`);
    rows.push(await runGroup(`${label}-smooth`, (b) => doSmooth(Math.max(0, b.st - 300))));
    rows.push(await runGroup(`${label}-bare`, (b) => doBare(Math.max(0, b.st - 300))));
  }

  const valid = rows.filter(Boolean);
  ui.log("[SUMMARY] " + JSON.stringify(valid.map((r) => ({
    tag: r.tag, base: r.base.st, min: r.minSt, collapsed: r.collapsed, writers: r.W.length, scrollEvents: r.SE.length,
    firstWrites: r.W.slice(0, 4).map((w) => `${w.how}:${w.v}(from ${w.from})`),
  })), null, 1));

  const offSmooth = valid.find((r) => r.tag === "OFF-smooth");
  const offBare = valid.find((r) => r.tag === "OFF-bare");
  const onSmooth = valid.find((r) => r.tag === "ON-smooth");
  const onBare = valid.find((r) => r.tag === "ON-bare");

  ui.add("G0", "打字机 OFF：scrollTo(smooth) 是否也会归 0（决定缺陷是否打字机独有）",
    offSmooth ? (offSmooth.collapsed ? "FAIL" : "PASS") : "FAIL",
    offSmooth ? `min=${offSmooth.minSt}（起点 ${offSmooth.base.st}）` : "无数据");
  ui.add("G1", "打字机 OFF：裸赋值 scrollTop=（基线对照）",
    offBare ? (offBare.collapsed ? "FAIL" : "PASS") : "FAIL",
    offBare ? `min=${offBare.minSt}（起点 ${offBare.base.st}）` : "无数据");
  ui.add("G2", "打字机 ON：scrollTo(smooth) 是否归 0",
    onSmooth ? (onSmooth.collapsed ? "FAIL" : "PASS") : "FAIL",
    onSmooth ? `min=${onSmooth.minSt}（起点 ${onSmooth.base.st}）` : "无数据");
  ui.add("G3", "打字机 ON：裸赋值 scrollTop=（基线对照）",
    onBare ? (onBare.collapsed ? "FAIL" : "PASS") : "FAIL",
    onBare ? `min=${onBare.minSt}（起点 ${onBare.base.st}）` : "无数据");

  await ui.shot("diag5");
});
