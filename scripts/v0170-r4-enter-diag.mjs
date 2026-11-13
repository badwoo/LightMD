/**
 * T3 诊断：两组问题一次回答
 * 1. ON 组 `.cm-cursor` 的 caretY 读到 4147（视口只有 759）—— 是探针读法错还是真现象？
 * 2. "页面抖"是否发生在**右侧预览**（iframe 每次 docChanged 重写 → 滚动/高度跳）
 *    或**布局层**（mainW/mainH）而非左屏滚动？
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-diag", doc: DOC }, async (ui) => {
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

  /* ── 结构侦察：右屏是什么，滚谁 ─────────────────────────── */
  const struct = await ui.ev(`
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).map(el => {
      const r = el.getBoundingClientRect();
      return { sel, cls: String(el.className || "").slice(0, 50), w: Math.round(r.width), h: Math.round(r.height),
               st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight) };
    });
    return {
      iframes: Array.from(document.querySelectorAll("iframe")).map(f => {
        const r = f.getBoundingClientRect();
        let inner = null;
        try {
          const d = f.contentDocument;
          const de = d && d.documentElement;
          const b = d && d.body;
          inner = de ? { deST: Math.round(de.scrollTop), deSH: Math.round(de.scrollHeight), deCH: Math.round(de.clientHeight),
                         bodySH: b ? Math.round(b.scrollHeight) : null, bodyH: b ? Math.round(b.getBoundingClientRect().height) : null } : null;
        } catch (e) { inner = { err: String(e).slice(0, 60) }; }
        return { id: f.id, cls: String(f.className || ""), top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), inner };
      }),
      scrollers: pick(".cm-scroller"),
      previews: pick(".preview-scroll, .preview-content, .preview-pane, .split-preview"),
      main: pick(".editor-main-area"),
      container: pick(".editor-container"),
      panelToggle: !!document.querySelector(".preview-panel, .preview-pane, iframe"),
    };
  `);
  ui.log("[struct] " + JSON.stringify(struct, null, 1));

  /* ── ON 的 caretY 之谜 ─────────────────────────────────── */
  await ui.command("view.toggleTypewriter");
  await ui.sleep(1200);
  const tw1 = await readTw();
  ui.log("[tw] active=" + tw1);

  const caretDbg = async (tag) => {
    const d = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const scR = sc.getBoundingClientRect();
      const curs = Array.from(document.querySelectorAll(".cm-cursor")).map(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { cls: String(el.className || ""), top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
                 disp: cs.display, vis: cs.visibility, op: cs.opacity, parent: String(el.parentElement && el.parentElement.className || "").slice(0, 40) };
      });
      const selLayer = document.querySelector(".cm-selectionLayer");
      const selR = selLayer ? selLayer.getBoundingClientRect() : null;
      const content = document.querySelector(".cm-content");
      const cR = content ? content.getBoundingClientRect() : null;
      const ae = document.activeElement;
      let docInfo = null;
      try { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view;
        if (v) { const p = v.state.selection.main.head; docInfo = { pos: p, coords: v.coordsAtPos(p) }; } } catch (e) {}
      return {
        sc: { top: Math.round(scR.top), st: Math.round(sc.scrollTop), ch: Math.round(sc.clientHeight), sh: Math.round(sc.scrollHeight) },
        content: cR ? { top: Math.round(cR.top), left: Math.round(cR.left), h: Math.round(cR.height) } : null,
        selLayer: selR ? { top: Math.round(selR.top), h: Math.round(selR.height) } : null,
        curs,
        ae: ae ? ((ae.className || ae.tagName) + "").slice(0, 40) : "none",
        focused: !!document.querySelector(".cm-focused"),
        docInfo,
      };
    `);
    ui.log(`[caret·${tag}] ` + JSON.stringify(d, null, 1));
    return d;
  };

  // 点击视口 82% 处（打字机应当居中）
  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    const y = Math.round(r.top + sc.clientHeight * 0.82);
    for (const dx of [0.45, 0.55, 0.35]) {
      const x = Math.round(r.left + sc.clientWidth * dx);
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.closest(".cm-content")) return { x, y, hit: String(hit.className || hit.tagName).slice(0, 40) };
    }
    return null;
  `);
  ui.log("[clickpt] " + JSON.stringify(pt));
  await caretDbg("before-click");
  if (pt) { await ui.click(pt.x, pt.y); await ui.sleep(1400); }
  await caretDbg("after-click-on");

  /* ── 右屏是否在回车时抖 —— 逐帧采左右两屏 + iframe 内部 ── */
  await ui.command("view.toggleTypewriter");
  await ui.sleep(1000);
  ui.log("[tw] back to " + (await readTw()));

  await ui.ev(`
    window.__TR = []; window.__T0 = performance.now();
    (function () {
      const t0 = performance.now();
      const tick = () => {
        const rec = { t: Math.round(performance.now() - t0) };
        const sc = document.querySelector(".cm-scroller");
        if (sc) { rec.st = Math.round(sc.scrollTop * 100) / 100; rec.sh = Math.round(sc.scrollHeight); }
        const f = document.querySelector("iframe");
        if (f) {
          const r = f.getBoundingClientRect();
          rec.ifTop = Math.round(r.top * 100) / 100;
          rec.ifH = Math.round(r.height * 100) / 100;
          try {
            const d = f.contentDocument;
            if (d && d.documentElement) {
              rec.deST = Math.round(d.documentElement.scrollTop * 100) / 100;
              rec.deSH = Math.round(d.documentElement.scrollHeight);
              rec.bodyH = d.body ? Math.round(d.body.getBoundingClientRect().height * 100) / 100 : null;
            }
          } catch (e) {}
        }
        const main = document.querySelector(".editor-main-area");
        if (main) { const mr = main.getBoundingClientRect(); rec.mainW = Math.round(mr.width * 100) / 100; rec.mainH = Math.round(mr.height * 100) / 100; rec.mainT = Math.round(mr.top * 100) / 100; }
        window.__TR.push(rec);
        if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
    return true;
  `);
  await ui.sleep(120);
  const before = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const f = document.querySelector("iframe");
    let deST = null, deSH = null;
    try { const d = f && f.contentDocument; if (d && d.documentElement) { deST = Math.round(d.documentElement.scrollTop); deSH = Math.round(d.documentElement.scrollHeight); } } catch (e) {}
    return { st: Math.round(sc.scrollTop), deST, deSH };
  `);
  ui.log("[enter-before] " + JSON.stringify(before));
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(2000);
  const trace = await ui.ev(`return window.__TR || []`);
  const after = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const f = document.querySelector("iframe");
    let deST = null, deSH = null, bodyH = null;
    try { const d = f && f.contentDocument; if (d && d.documentElement) { deST = Math.round(d.documentElement.scrollTop); deSH = Math.round(d.documentElement.scrollHeight); bodyH = d.body ? Math.round(d.body.getBoundingClientRect().height) : null; } } catch (e) {}
    return { st: Math.round(sc.scrollTop), deST, deSH, bodyH };
  `);
  ui.log("[enter-after] " + JSON.stringify(after));

  const seqOf = (f) => trace.map((s) => s[f]).filter((v) => typeof v === "number");
  const stat = (name, field) => {
    const seq = seqOf(field);
    if (seq.length < 2) { ui.log(`[stat·${name}] 无数据`); return null; }
    const d = [];
    for (let i = 1; i < seq.length; i++) d.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
    const maxJump = d.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    const nz = d.filter((x) => Math.abs(x) >= 0.05);
    const runs = [];
    for (const x of nz) { const s = x > 0 ? 1 : -1; if (!runs.length || runs[runs.length - 1] !== s) runs.push(s); }
    const out = { n: seq.length, first: seq[0], last: seq[seq.length - 1], net: Math.round((seq[seq.length - 1] - seq[0]) * 100) / 100,
                  maxJump: Math.round(maxJump * 100) / 100, reversals: Math.max(0, runs.length - 1), frames: nz.length,
                  deltas: nz.slice(0, 24) };
    ui.log(`[stat·${name}] ` + JSON.stringify(out));
    return out;
  };
  stat("左屏 scrollTop", "st");
  stat("右屏 iframe 内部 scrollTop", "deST");
  stat("右屏 iframe scrollHeight", "deSH");
  stat("右屏 iframe bodyH", "bodyH");
  stat("右屏 iframe top", "ifTop");
  stat("右屏 iframe h", "ifH");
  stat("mainW", "mainW");
  stat("mainH", "mainH");
  stat("mainT", "mainT");

  ui.log("[trace-head] " + JSON.stringify(trace.slice(0, 14)));

  await ui.shot("diag-enter");
});
