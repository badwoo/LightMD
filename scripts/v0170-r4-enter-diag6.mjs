/**
 * T3 诊断 6：**`.cm-scroller` 上 `scrollTo()` 归 0 的机制 + 修法候选**
 *
 * ## 已确证（diag4 / diag5，各自独立可复现）
 * | 组 | 打字机 | 写入方式 | scrollTop 4019 → | 结论 |
 * |---|---|---|---|---|
 * | E1 | ON  | `scrollTo({top:3695, behavior:"smooth"})` | **0** | 归 0 |
 * | E2 | ON  | `scrollTo({top:3695, behavior:"instant"})` | **0** | 归 0 |
 * | E3 | ON  | `sc.scrollTop = 3695` | 3695 | 正常 |
 * | G0 | **OFF** | `scrollTo({behavior:"smooth"})` | **0** | 与打字机无关 |
 * | G1 | OFF | `sc.scrollTop =` | 3719 | 正常 |
 * | G2 | ON  | `scrollTo({behavior:"smooth"})` | **0** | — |
 * | G3 | ON  | `sc.scrollTop =` | 3719 | 正常 |
 *
 * ⇒ **不是打字机逻辑的错，是「用 `scrollTo()` 写 CM6 的 `.cm-scroller`」这条路本身有问题。**
 * R3 #8 给编辑面加 smooth 时选了 `el.scrollTo({behavior})`（从 textarea 分支照搬），
 * 而 `.cm-scroller` 与 textarea 不是同一类滚动宿主。
 *
 * ## 本探针要钉死的两件事
 * ### (1) 机制：为什么 `scrollTo` 归 0、裸赋值不归 0？
 * 两个假说，判据不同：
 * - **H-A「measure 重估期塌陷」**：`scrollTo` 派发 scroll 事件 → CM6 `onScrollChanged` → `measure()`
 *   → heightMap 重估期间 `.cm-scroller` 可滚动高度瞬间塌到 < clientHeight
 *   → 浏览器把 scrollTop **钳到 0**（钳位不经过 `scrollTop` setter，所以打桩看不到写入）
 * - **H-B「scrollTo 本身被吞」**：`scrollTo` 在这个元素上根本没生效（Compositor 路径不适用），
 *   随后某次 measure 把 scrollTop 归 0
 * 判据：H-A 会在归 0 那一帧之前/同时观察到 `scrollHeight` 远小于终值；H-B 不会。
 *
 * 用三通道同时采：rAF、`setTimeout(0)`、**MutationObserver**（微任务，能抓同任务内的 DOM 变更）
 * 以及 scroll 事件（在事件里立刻读 `scrollHeight`）。
 *
 * ### (2) 修法候选（每组都从 st≈4019 复位；目标是找到"既不归 0 又能平滑"的写法）
 * | 组 | 写法 | 期望 |
 * |---|---|---|
 * | F1 | `scrollTo({top, behavior:"instant"})` | 归 0（复现） |
 * | F2 | `scrollTo(0, top)` 两参数（旧式） | 若正常 → 是 options 形式的问题 |
 * | F3 | `scrollTo({top})` 不带 behavior | ？ |
 * | F4 | **rAF 缓动**：逐帧 `scrollTop += 步长`（12 帧） | 期望正常 + 平滑 ← 首选修法 |
 * | F5 | 目标 = 当前值（无位移）的 `scrollTo` | 若仍归 0 → 一调用就出事，与位移无关 |
 * | F6 | `scrollTop = X` 裸赋值（基线） | 正常 |
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-diag6", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);

  /* ── 打桩：写入 + scroll 事件（含 sh）+ MutationObserver ──── */
  await ui.ev(`
    if (!window.__D6) {
      window.__D6 = true;
      window.__W = []; window.__SE = []; window.__MO = [];
      const rec = (el, v, how) => {
        try {
          const cls = String(el.className || el.tagName || "");
          if (!cls.includes("cm-")) return;
          window.__W.push({ t: Math.round(performance.now() * 10) / 10, v: Math.round(v), from: Math.round(el.scrollTop), how });
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
          rec(this, typeof top === "number" ? top : this.scrollTop, m + "(" + (typeof a === "object" ? JSON.stringify(a) : a + "," + b) + ")");
          return o.call(this, a, b);
        };
      }
      // scroll 事件里**立刻**读 scrollHeight —— 抓"钳位那一刻"的可滚动高度
      document.addEventListener("scroll", (e) => {
        try {
          const t = e.target;
          const cls = String(t.className || "");
          if (!cls.includes("cm-scroller")) return;
          window.__SE.push({
            t: Math.round(performance.now() * 10) / 10,
            st: Math.round(t.scrollTop * 100) / 100,
            sh: Math.round(t.scrollHeight),
            ch: t.clientHeight,
            max: Math.round(t.scrollHeight - t.clientHeight),
          });
        } catch (err) {}
      }, true);
      // MutationObserver：抓 measure 期间的 DOM/属性变更（含 .cm-gap 高度、style、class）
      window.__START_MO = () => {
        window.__MO = [];
        const sc = document.querySelector(".cm-scroller");
        if (!sc) return false;
        const read = () => {
          const c = sc.querySelector(".cm-content");
          const sizer = sc.querySelector(".cm-sizer");
          const gaps = Array.from(sc.querySelectorAll(".cm-gap"));
          return {
            st: Math.round(sc.scrollTop * 100) / 100,
            sh: Math.round(sc.scrollHeight),
            cH: c ? Math.round(c.getBoundingClientRect().height) : null,
            szH: sizer ? Math.round(sizer.getBoundingClientRect().height) : null,
            nGap: gaps.length,
            gapH: gaps.map(g => Math.round(g.getBoundingClientRect().height)),
            nLines: sc.querySelectorAll(".cm-line").length,
          };
        };
        const mo = new MutationObserver((muts) => {
          const kinds = {};
          for (const m of muts) {
            const key = m.type + ":" + (m.target.className ? String(m.target.className).slice(0, 22) : m.target.nodeName);
            kinds[key] = (kinds[key] || 0) + 1;
          }
          window.__MO.push(Object.assign({ t: Math.round(performance.now() * 10) / 10, kinds }, read()));
        });
        mo.observe(sc, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
        window.__MO_OBJ = mo;
        return true;
      };
      window.__STOP_MO = () => { try { window.__MO_OBJ && window.__MO_OBJ.disconnect(); } catch (e) {} return true; };
      // 双通道采样
      window.__SAMPLE = (ms) => {
        window.__S = [];
        const t0 = performance.now();
        const read = () => {
          const sc = document.querySelector(".cm-scroller");
          if (!sc) return null;
          return {
            t: Math.round(performance.now() * 10) / 10,
            st: Math.round(sc.scrollTop * 100) / 100,
            sh: Math.round(sc.scrollHeight),
            max: Math.round(sc.scrollHeight - sc.clientHeight),
            nLines: sc.querySelectorAll(".cm-line").length,
          };
        };
        const raf = () => { const r = read(); if (r) window.__S.push(r); if (performance.now() - t0 < ms) requestAnimationFrame(raf); };
        requestAnimationFrame(raf);
        const tm = () => { const r = read(); if (r) window.__S.push(r); if (performance.now() - t0 < ms) setTimeout(tm, 0); };
        setTimeout(tm, 0);
      };
    }
    return true;
  `);

  const wheelTo50 = async () => {
    const box = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2) };
    `);
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

  /** 读滚动曲线（判定"平滑"） */
  const curve = (S) => {
    const seq = S.map((s) => s.st);
    if (seq.length < 3) return { n: seq.length };
    const d = [];
    for (let i = 1; i < seq.length; i++) d.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
    const nz = d.filter((x) => Math.abs(x) >= 0.05);
    return {
      n: seq.length, from: seq[0], to: seq[seq.length - 1],
      frames: nz.length,
      maxJump: Math.round(nz.reduce((m, x) => Math.max(m, Math.abs(x)), 0) * 100) / 100,
      deltas: nz.slice(0, 20),
    };
  };

  const runGroup = async (tag, action) => {
    const base = await wheelTo50();
    if (base.st < 1000) { ui.add(`F-${tag}`, "基线复位失败", "FAIL", `st=${base.st}`); return null; }
    await ui.ev(`window.__W = []; window.__SE = []; return true;`);
    await ui.ev(`window.__START_MO(); window.__SAMPLE(1100); return true;`);
    await ui.sleep(50);
    const ret = await action(base);
    await ui.sleep(1400);
    await ui.ev(`window.__STOP_MO(); return true;`);

    const S = await ui.ev(`return window.__S || []`);
    const W = await ui.ev(`return window.__W || []`);
    const SE = await ui.ev(`return window.__SE || []`);
    const MO = await ui.ev(`return (window.__MO || []).slice(0, 40)`);

    const c = curve(S);
    const minSt = S.length ? Math.min(...S.map((s) => s.st)) : null;
    const collapseFrames = S.filter((s) => typeof s.max === "number" && s.max < base.st * 0.5);
    const seMinSh = SE.length ? Math.min(...SE.map((s) => s.sh)) : null;

    ui.log(`[${tag}] base=${base.st} ret=${JSON.stringify(ret)}`);
    ui.log(`[${tag}] 曲线 ` + JSON.stringify({ ...c, minSt }));
    ui.log(`[${tag}] W=${JSON.stringify(W.map((w) => `${w.how}:${w.v}(from ${w.from})`))}`);
    ui.log(`[${tag}] SE=${JSON.stringify(SE.slice(0, 8))}`);
    ui.log(`[${tag}] 塌陷帧(max<50%起点) = ${collapseFrames.length}` + (collapseFrames.length ? ` 首个=${JSON.stringify(collapseFrames[0])}` : ""));
    ui.log(`[${tag}] MO 条数=${MO.length}；样例=${JSON.stringify(MO.slice(0, 5))}`);
    if (MO.length) {
      const minMax = MO.reduce((m, r) => Math.min(m, r.sh - 759), Infinity);
      ui.log(`[${tag}] MO 期间最小可滚动高度=${minMax === Infinity ? "?" : minMax}`);
    }
    return { tag, base, ret, curve: c, minSt, W, SE, MO, collapseFrames: collapseFrames.length, seMinSh, S };
  };

  /* ── 各组 ──────────────────────────────────────────────── */
  const X = (b) => Math.max(0, b.st - 320);

  const r1 = await runGroup("F1-scrollTo-instant", (b) => ui.ev(`
    const sc=document.querySelector(".cm-scroller");
    sc.scrollTo({ top: ${X(0)} , behavior:"instant" }); return Math.round(sc.scrollTop);
  `.replace("${X(0)}", String(Math.max(0, 4019 - 320)))));

  const r2 = await runGroup("F2-scrollTo-2arg", (b) => ui.ev(`
    const sc=document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const t = Math.max(0, Math.min(max, Math.round(sc.scrollTop) - 320));
    sc.scrollTo(0, t);
    return { wrote: t, r1: Math.round(sc.scrollTop) };
  `));

  const r3 = await runGroup("F3-scrollTo-nobehavior", (b) => ui.ev(`
    const sc=document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const t = Math.max(0, Math.min(max, Math.round(sc.scrollTop) - 320));
    sc.scrollTo({ top: t });
    return { wrote: t, r1: Math.round(sc.scrollTop) };
  `));

  /** F4：**rAF 逐帧裸赋值缓动**（首选修法候选） */
  const r4 = await runGroup("F4-raf-easing", (b) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const from = Math.round(sc.scrollTop);
    const to = Math.max(0, Math.min(max, from - 320));
    const N = 12;
    let i = 0;
    const ease = (t) => 1 - Math.pow(1 - t, 3);   // easeOutCubic，与浏览器 smooth 观感接近
    const step = () => {
      i++;
      const p = Math.min(1, i / N);
      // 每帧**裸赋值**（已验证不归 0），钳到合法区间
      const cur = document.querySelector(".cm-scroller");
      const m = Math.max(0, cur.scrollHeight - cur.clientHeight);
      cur.scrollTop = Math.max(0, Math.min(m, from + (to - from) * ease(p)));
      if (i < N) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return { from, to, N };
  `));

  /** F5：目标 = 当前值（零位移）的 scrollTo */
  const r5 = await runGroup("F5-scrollTo-nowhere", (b) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const t = Math.round(sc.scrollTop);
    sc.scrollTo({ top: t, behavior: "instant" });
    return { wrote: t, r1: Math.round(sc.scrollTop) };
  `));

  const r6 = await runGroup("F6-bare-baseline", (b) => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const t = Math.max(0, Math.min(max, Math.round(sc.scrollTop) - 320));
    sc.scrollTop = t;
    return { wrote: t, r1: Math.round(sc.scrollTop) };
  `));

  const rows = [r1, r2, r3, r4, r5, r6].filter(Boolean);
  ui.log("[SUMMARY] " + JSON.stringify(rows.map((r) => ({
    tag: r.tag, base: r.base.st, minSt: r.minSt,归0: r.minSt !== null && r.minSt < 100,
    写入: r.W.length, scroll事件: r.SE.length, MO条数: r.MO.length,
    塌陷帧: r.collapseFrames, 帧数: r.curve.frames, 单帧最大: r.curve.maxJump,
  })), null, 1));

  ui.add("F0", "★ 归 0 只发生在 scrollTo()，裸赋值与 rAF 逐帧赋值正常",
    (r1 && r1.minSt < 100) && (r6 && r6.minSt > 1000) && (r4 && r4.minSt > 1000) ? "PASS" : "FAIL",
    `scrollTo(instant) min=${r1?.minSt}；裸赋值 min=${r6?.minSt}；rAF 缓动 min=${r4?.minSt}`);
  ui.add("F1", "rAF 逐帧裸赋值可达平滑（≥6 帧、单帧 ≤总位移 40%）",
    r4 && r4.curve.frames >= 6 && (r4.curve.maxJump / Math.max(1, Math.abs(r4.base.st - (r4.base.st - 320)))) <= 0.4 ? "PASS" : "FAIL",
    r4 ? `帧数=${r4.curve.frames} 单帧最大=${r4.curve.maxJump}px 逐帧=${JSON.stringify(r4.curve.deltas)}` : "无数据");
  ui.add("F2", "scrollTo 两参数形式是否也归 0（定位是 options 形式还是 API 本身）",
    r2 ? (r2.minSt < 100 ? "FAIL" : "PASS") : "FAIL",
    r2 ? `min=${r2.minSt}（起点 ${r2.base.st}）` : "无数据");
  ui.add("F3", "零位移 scrollTo 是否也归 0（定位是否与位移/动画有关）",
    r5 ? (r5.minSt < 100 ? "FAIL" : "PASS") : "FAIL",
    r5 ? `min=${r5.minSt}（起点 ${r5.base.st}）` : "无数据");

  await ui.shot("diag6");
});
