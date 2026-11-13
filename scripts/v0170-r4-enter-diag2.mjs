/**
 * T3 诊断 2：**打字机开启（ON）时 caretY 读到 4147 的真相**
 *
 * 背景：`v0170-r4-enter.mjs` 的 OFF 组 4 个用例全部 0 抖动 / 0 写入，
 * 但 ON 组的 A3（光标在视口内）全部 FAIL：caretY=4147（视口只有 759）。
 *
 * 两种可能，必须分清（这正是上一轮假数据的教训）：
 * - (a) 探针错：点击/滚动时序没摆好，光标落在文档别处；
 * - (b) 真现象：打字机开启后滚动位置被某个写者拉走（例如被拉到 0），
 *       而光标还留在原内容位置 → 用户看到的就是"页面跳了"。
 *
 * 做法：开 ON 后，按"滚到 50% → 点击 0.15 处"的顺序，**每 150ms 采样一次**
 * `st / caretY / caret内容Y(=caretY+st) / sh / 写入日志`，把时间线打出来。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

const SAMPLE = `
  const round = (n) => Math.round(n * 100) / 100;
  const sc = document.querySelector(".cm-scroller");
  if (!sc) return null;
  const r = sc.getBoundingClientRect();
  const caret = sc.querySelector(".cm-cursor");
  const cr = caret ? caret.getBoundingClientRect() : null;
  let docTop = null, coords = null, pos = null;
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v) {
      docTop = round(v.documentTop);
      pos = v.state.selection.main.head;
      const co = v.coordsAtPos(pos);
      coords = co ? { top: round(co.top), bottom: round(co.bottom) } : null;
    }
  } catch (e) {}
  return {
    st: round(sc.scrollTop), sh: round(sc.scrollHeight), ch: round(sc.clientHeight),
    scTop: round(r.top),
    caretY: cr ? round(cr.top - r.top) : null,
    /** 光标的内容坐标（= 屏幕 Y + scrollTop） */
    caretContentY: cr ? round(cr.top - r.top + sc.scrollTop) : null,
    docTop, pos, coords,
    /** coordsAtPos 给出的内容 Y（surface.offsetToContentY 的口径） */
    posContentY: coords && docTop !== null ? round(coords.top - docTop) : null,
    focused: !!document.querySelector(".cm-focused"),
  };
`;

await runBrowserProbe({ name: "v0170-r4-diag2", doc: DOC }, async (ui) => {
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
  const sample = () => ui.ev(SAMPLE);
  const wheelTo = async (pct) => {
    const box = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2),
               st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
    `);
    let cur = box.st, guard = 0;
    while (cur > 8 && guard++ < 400) {
      await ui.wheel(box.x, box.y, -Math.min(560, cur));
      cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    }
    const target = Math.round(box.max * pct);
    guard = 0;
    while (cur < target - 8 && guard++ < 800) {
      await ui.wheel(box.x, box.y, Math.min(140, target - cur));
      const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
      if (next === cur) break;
      cur = next;
    }
    await ui.sleep(400);
    return ui.ev(`const sc=document.querySelector(".cm-scroller"); return { st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };`);
  };

  /* ── 装写入打桩（带栈）────────────────────────────────────── */
  await ui.ev(`
    if (!window.__ST_SPY) {
      window.__ST_SPY = true; window.__ST_WRITES = [];
      const rec = (el, v, how) => {
        try {
          const cls = String(el.className || el.tagName || "");
          if (!(cls.includes("cm-scroller") || cls.includes("cm-content"))) return;
          const stack = (new Error().stack || "").split("\\n").slice(1, 10).map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 120));
          window.__ST_WRITES.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(el.scrollTop), cls: cls.slice(0, 30), how, stack });
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
    }
    return true;
  `);

  /* ── 场景 ON：开打字机 → 滚 50% → 点击 0.15 → 观察 3s ─────── */
  const cur0 = await readTw();
  if (!cur0) { await ui.command("view.toggleTypewriter"); await ui.sleep(1200); }
  ui.log("[ON] active=" + (await readTw()));

  await ui.ev(`window.__ST_WRITES = []; return true;`);
  const a = await wheelTo(0.5);
  ui.log("[ON] after wheel 50% = " + JSON.stringify(a) + " sample=" + JSON.stringify(await sample()));

  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    const y = Math.round(r.top + sc.clientHeight * 0.15);
    for (const dx of [0.45, 0.55, 0.35]) {
      const x = Math.round(r.left + sc.clientWidth * dx);
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.closest(".cm-content")) return { x, y, hit: String(hit.className || hit.tagName).slice(0, 40) };
    }
    return null;
  `);
  ui.log("[ON] clickpt=" + JSON.stringify(pt));

  await ui.ev(`window.__ST_WRITES = []; return true;`);
  if (pt) await ui.click(pt.x, pt.y);
  for (let i = 0; i < 12; i++) {
    await ui.sleep(150);
    ui.log(`[ON·t+${(i + 1) * 150}ms] ` + JSON.stringify(await sample()));
  }
  const writes = await ui.ev(`return (window.__ST_WRITES || []).slice(0, 30)`);
  ui.log(`[ON] 点击后写入 ${writes.length} 笔`);
  for (const w of writes.slice(0, 12)) {
    ui.log(`   ${w.how} v=${w.v}(from ${w.from}) @${w.t} cls=${w.cls}`);
    for (const s of (w.stack || []).slice(0, 5)) ui.log(`      ${s}`);
  }

  /* ── 再用"滚到 50% 后直接按回车"看有没有同样的现象 ───────── */
  await ui.ev(`window.__ST_WRITES = []; return true;`);
  await ui.key("Enter", "Enter", 13);
  for (let i = 0; i < 8; i++) {
    await ui.sleep(150);
    ui.log(`[ON·enter·t+${(i + 1) * 150}ms] ` + JSON.stringify(await sample()));
  }
  const w2 = await ui.ev(`return (window.__ST_WRITES || []).slice(0, 30)`);
  ui.log(`[ON·enter] 写入 ${w2.length} 笔`);
  for (const w of w2.slice(0, 10)) {
    ui.log(`   ${w.how} v=${w.v}(from ${w.from}) @${w.t} cls=${w.cls}`);
    for (const s of (w.stack || []).slice(0, 5)) ui.log(`      ${s}`);
  }

  await ui.shot("diag2-on");
});
