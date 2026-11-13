/**
 * #3 / #6 决定性诊断：**谁写了 scrollTop？谁触发了 scrollIntoView？**
 *
 * ## 背景（已确证）
 * `v0170-r2-scroll-jump` 实测：编辑 → 滚到 50%（scrollTop 4019 / 视口中心 PI38）
 * → Ctrl+Z → **scrollTop 102、视口中心 PI03**（跳了 3917px，几乎到顶）。
 * 而 `SourcePane.applyHistoryTextRef` 的 CM6 分支里：
 *   - `histAnchor = isRealTextarea ? ... : null` → **null**
 *   - `applyScrollRestore` 首行 `if (!isRealTextarea) return` → **整段不执行**
 *   - `decideSourceScrollRestore` 因 textLengthChanged → `kind = "none"`
 * 即 **源码面撤销路径在 CM6 下没有任何滚动恢复**，所以那个跳变是**别人**写的。
 *
 * ## 本探针的做法（因果实验，不靠读代码推断）
 * 在页面内打三个桩，记录**调用栈**：
 * 1. `Element.prototype.scrollTop` setter（谁写、写多少、从哪来）
 * 2. `Element.prototype.scrollIntoView`（谁调、参数）
 * 3. `Element.prototype.scrollTo` / `scrollBy`
 * 4. `HTMLElement.prototype.focus`（焦点切换 + 参数，抓 preventScroll 缺失）
 * 并记录 `selectionchange` / `focusin` 时序。
 *
 * 然后：滚到 50% → Ctrl+Z → 打印全部写入与栈，**钉死真凶**。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const PARAS = 60;
const parts = ["# 滚动写入取证", ""];
for (let i = 1; i <= PARAS; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
      `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
    "",
  );
}
const DOC = parts.join("\n");

const INSTALL = `
  if (!window.__INSTR) {
    window.__INSTR = true;
    window.__LOG = [];
    const push = (o) => { try { window.__LOG.push(Object.assign({ t: Math.round(performance.now()) }, o)); } catch (e) {} };
    const shorten = (stack, n) => (stack || "").split("\\n").slice(1, n || 8)
      .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 130));

    // 1) scrollTop setter
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true, enumerable: proto.enumerable,
      get() { return proto.get.call(this); },
      set(v) {
        try {
          const el = this;
          const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
          if (String(cls).includes("cm-scroller") || String(cls).includes("source-editor") || String(cls).includes("cm-content")) {
            push({ k: "set:scrollTop", cls: String(cls).slice(0, 34), v: Math.round(v), from: Math.round(proto.get.call(this)), stack: shorten(new Error().stack) });
          }
        } catch (e) {}
        return proto.set.call(this, v);
      },
    });

    // 2) scrollIntoView
    const siv = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg) {
      try {
        const cls = (this.className && typeof this.className === "string") ? this.className : (this.tagName || "");
        push({ k: "scrollIntoView", cls: String(cls).slice(0, 34), arg: JSON.stringify(arg || null), stack: shorten(new Error().stack) });
      } catch (e) {}
      return siv.apply(this, arguments);
    };

    // 3) scrollTo / scrollBy
    for (const name of ["scrollTo", "scrollBy"]) {
      const orig = Element.prototype[name];
      if (typeof orig !== "function") continue;
      Element.prototype[name] = function () {
        try {
          const cls = (this.className && typeof this.className === "string") ? this.className : (this.tagName || "");
          if (String(cls).includes("cm-scroller") || String(cls).includes("source-editor")) {
            push({ k: name, cls: String(cls).slice(0, 34), arg: JSON.stringify(Array.from(arguments)).slice(0, 120), stack: shorten(new Error().stack) });
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    }

    // 4) focus（抓 preventScroll 缺失）
    const focusOrig = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (opts) {
      try {
        const cls = (this.className && typeof this.className === "string") ? this.className : (this.tagName || "");
        push({ k: "focus", cls: String(cls).slice(0, 34), preventScroll: !!(opts && opts.preventScroll), stack: shorten(new Error().stack, 6) });
      } catch (e) {}
      return focusOrig.apply(this, arguments);
    };

    document.addEventListener("selectionchange", () => {
      try {
        const sel = document.getSelection();
        push({ k: "selectionchange", anchor: sel && sel.anchorNode ? (sel.anchorNode.nodeName || "") : null, off: sel ? sel.anchorOffset : null, text: sel ? String(sel).slice(0, 20) : null });
      } catch (e) {}
    }, true);
    return true;
  }
  return true;
`;

const READ = `
  const round = (n) => Math.round(n);
  const sc = document.querySelector(".cm-scroller");
  if (!sc) return { ok: false };
  const scR = sc.getBoundingClientRect();
  const midY = scR.top + sc.clientHeight / 2;
  const lines = Array.from(sc.querySelectorAll(".cm-line"));
  let cl = null;
  for (const l of lines) { const r = l.getBoundingClientRect(); if (r.top <= midY && r.bottom >= midY) { cl = l; break; } }
  const txt = cl ? (cl.textContent || "") : "";
  const m = /PI(\\d{2})/.exec(txt);
  const ae = document.activeElement;
  return {
    ok: true, st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight),
    sh: round(sc.scrollHeight), pi: m ? Number(m[1]) : null,
    ae: ae ? ((ae.className || ae.tagName) + "").slice(0, 40) : "none",
    focused: !!document.querySelector(".cm-focused"),
  };
`;

await runBrowserProbe({ name: "v0170-r2-scroll-writer", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.ev(INSTALL);

  const read = () => ui.ev(READ);

  /* ── 让文档/布局先完全稳定（CM6 的 scrollHeight 是估算值，会收敛）── */
  await ui.focusSource();
  await ui.sleep(400);
  await ui.ev(`const sc=document.querySelector(".cm-scroller"); sc.scrollTop=0; return true;`);
  await ui.sleep(800);
  let prevSh = -1, stable = 0;
  for (let i = 0; i < 30 && stable < 3; i++) {
    const r = await read();
    if (r.sh === prevSh) stable++;
    else { stable = 0; prevSh = r.sh; }
    await ui.sleep(200);
  }
  ui.log(`[setup] scrollHeight 稳定于 ${prevSh}`);

  /* ── 复现：顶部光标打字 → 滚到 50% → Ctrl+Z ── */
  await ui.ev(`const sc=document.querySelector(".cm-scroller"); sc.scrollTop=0; return true;`);
  await ui.sleep(500);
  const place = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const lines = Array.from(sc.querySelectorAll(".cm-line"));
    const t = lines.find(l => (l.textContent || "").includes("PI03"));
    if (!t) return { ok: false };
    const r = t.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
  `);
  if (!place.ok) { ui.add("W0", "定位 PI03", "FAIL", "找不到"); return; }
  await ui.click(place.x, place.y);
  await ui.sleep(300);
  for (const [k, c, v] of [["x", "KeyX", 88], ["y", "KeyY", 89], ["z", "KeyZ", 90]]) await ui.key(k, c, v);
  await ui.sleep(600);

  await ui.ev(`const sc=document.querySelector(".cm-scroller"); sc.scrollTop=(sc.scrollHeight-sc.clientHeight)*0.5; return true;`);
  await ui.sleep(900);
  const before = await read();
  ui.log("[before-undo] " + JSON.stringify(before));

  // 清空日志，只留撤销过程
  await ui.ev(`window.__LOG = []; return true;`);
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1600);
  const after = await read();
  const log = await ui.ev(`return window.__LOG || []`);

  ui.log("[after-undo] " + JSON.stringify(after));
  ui.log(`[undo-log] ${log.length} 条`);
  for (const e of log.slice(0, 40)) {
    const head = `${e.k} ${e.cls || ""} ${e.v !== undefined ? "v=" + e.v : ""} ${e.arg || ""} ${e.preventScroll !== undefined ? "preventScroll=" + e.preventScroll : ""}`;
    ui.log(`  ${head}`);
    if (e.stack) for (const s of e.stack.slice(0, 6)) ui.log(`      ${s}`);
  }

  const dPix = Math.abs((after.st ?? 0) - (before.st ?? 0));
  ui.add("W1", "★ 撤销后 scrollTop 不变（复现 #3）",
    dPix <= 8 ? "PASS" : dPix <= 40 ? "KNOWN" : "FAIL",
    `Δ=${dPix}px（${before.st}→${after.st}）；视口中心 PI${before.pi}→PI${after.pi}；scrollHeight=${before.sh}→${after.sh}`);

  const stWrites = log.filter((e) => e.k === "set:scrollTop");
  const siv = log.filter((e) => e.k === "scrollIntoView" || e.k === "scrollTo" || e.k === "scrollBy");
  const focus = log.filter((e) => e.k === "focus");
  ui.add("W2", "撤销过程中的 scrollTop 写入溯源",
    stWrites.length ? "PASS" : "KNOWN",
    `写入 ${stWrites.length} 次：${JSON.stringify(stWrites.map((w) => `${w.v}(from ${w.from})`))}`);
  ui.add("W3", "撤销过程中是否有 scrollIntoView / scrollTo",
    siv.length === 0 ? "PASS" : "FAIL",
    siv.length ? `${siv.length} 次：${JSON.stringify(siv.map((s) => s.k + "@" + s.cls))}` : "无");
  ui.add("W4", "撤销过程中 focus 调用是否都带 preventScroll",
    focus.every((f) => f.preventScroll) ? "PASS" : "KNOWN",
    focus.length ? `${focus.length} 次，缺 preventScroll ${focus.filter((f) => !f.preventScroll).length} 次：` +
      JSON.stringify(focus.slice(0, 6).map((f) => `${f.cls}(${f.preventScroll})`)) : "无 focus 调用");

  ui.log("[W-summary] " + JSON.stringify({ before, after, dPix,
    stWrites: stWrites.map((w) => ({ v: w.v, from: w.from, t: w.t, s2: (w.stack || [])[1] || "", s3: (w.stack || [])[2] || "" })),
    siv: siv.map((s) => ({ k: s.k, cls: s.cls, arg: s.arg, s2: (s.stack || [])[1] || "", s3: (s.stack || [])[2] || "" })),
  }, null, 1));

  await ui.shot("undo-writer");
});
