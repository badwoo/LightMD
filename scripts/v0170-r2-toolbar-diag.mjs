/**
 * #6 诊断：点格式栏按钮后**到底发生了什么**（逐帧全量快照）
 *
 * 已有初步数据（`v0170-r2-toolbar-jump`）：
 * - 点「粗体」后 `scrollHeight` 8785 → 7345（**掉了 1440px**）、max 8026 → 6586
 * - 视口中心 PI30 → PI37（内容位置变了）
 * - `.cm-scroller` 上出现「我们的 setScrollTop(4007) → CM6 measure 写 4207 → 我们再次写 4007」三段
 *
 * "scrollHeight 掉 1440px" 在「只插入 4 个字符」下是**不可能的** —— 说明有别的东西
 * 在改变布局。本探针逐帧记录：编辑器宽度、行数、文本长度、字体、pane 状态、焦点事件，
 * 把"谁让文档变短了"钉死。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const PARAS = 60;
const parts = ["# 工具栏诊断", ""];
for (let i = 1; i <= PARAS; i++) {
  parts.push(
    `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
      `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
    "",
  );
}
const DOC = parts.join("\n");

const FRAME_SNAP = `
  const round = (n) => (n == null ? null : Math.round(n));
  const sc = document.querySelector(".cm-scroller");
  const ed = document.querySelector(".cm-editor");
  const content = document.querySelector(".cm-content");
  const host = document.querySelector(".source-editor-cm6");
  const shell = document.querySelector(".split-preview-shell");
  const syn = document.querySelector(".syntax-helper");
  const outl = document.querySelector(".outline, .outline-panel");
  if (!sc) return null;
  const scR = sc.getBoundingClientRect();
  return {
    st: round(sc.scrollTop),
    sh: round(sc.scrollHeight),
    ch: round(sc.clientHeight),
    cw: round(sc.clientWidth),
    lineCount: sc.querySelectorAll(".cm-line").length,
    contentW: content ? round(content.getBoundingClientRect().width) : null,
    edW: ed ? round(ed.getBoundingClientRect().width) : null,
    hostW: host ? round(host.getBoundingClientRect().width) : null,
    shellW: shell ? round(shell.getBoundingClientRect().width) : null,
    hasSyntax: !!syn,
    hasOutline: !!outl,
    fontSize: content ? getComputedStyle(content).fontSize : null,
    lineHeight: content ? getComputedStyle(content).lineHeight : null,
    ae: (document.activeElement && ((document.activeElement.className || document.activeElement.tagName) + "").slice(0, 20)) || "none",
    focused: !!document.querySelector(".cm-focused"),
  };
`;

await runBrowserProbe({ name: "v0170-r2-toolbar-diag", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);

  /* ── 0. 等文档真正装好（上一版 loaded 判据失效，改看 .cm-line 文本）── */
  let cmText = "";
  for (let i = 0; i < 40; i++) {
    cmText = await ui.ev(`
      const cm = document.querySelector(".cm-editor");
      if (!cm) return "";
      return Array.from(cm.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("\\n");
    `);
    if ((cmText || "").includes("PI60")) break;
    await ui.sleep(250);
  }
  ui.log(`[setup] 编辑器文本长度=${(cmText || "").length} 含PI60=${(cmText || "").includes("PI60")}`);

  /* ── 1. 结构化基线：把 CM6 的 doc 长度与 DOM 行都记下来 ── */
  const docState = await ui.ev(`
    const cm = document.querySelector(".cm-editor");
    const lines = cm ? Array.from(cm.querySelectorAll(".cm-line")) : [];
    return {
      domLines: lines.length,
      domTextLen: lines.map(l => l.textContent || "").join("\\n").length,
    };
  `);
  ui.log("[setup] " + JSON.stringify(docState));

  /* ── 2. 跟踪焦点/失焦事件（CM6 blur 行为是本轮怀疑点之一）── */
  await ui.ev(`
    window.__FOCUS = [];
    const cm = document.querySelector(".cm-content");
    if (cm) {
      cm.addEventListener("blur", () => window.__FOCUS.push({ t: Math.round(performance.now()), ev: "cm-blur", to: (document.activeElement && (document.activeElement.className || document.activeElement.tagName) || "?").toString().slice(0,30) }), true);
      cm.addEventListener("focus", () => window.__FOCUS.push({ t: Math.round(performance.now()), ev: "cm-focus" }), true);
    }
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      window.__FOCUS.push({ t: Math.round(performance.now()), ev: "focusin", el: ((t.className || t.tagName) + "").slice(0, 32) });
    }, true);
    document.addEventListener("scroll", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("cm-scroller")) {
        window.__FOCUS.push({ t: Math.round(performance.now()), ev: "scroll", st: Math.round(t.scrollTop) });
      }
    }, true);
    return true;
  `);

  /* ── 3. scrollTop 写入打桩 ── */
  await ui.ev(`
    if (!window.__ST_SPY) {
      window.__ST_WRITES = [];
      window.__ST_SPY = true;
      const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true, enumerable: proto.enumerable,
        get() { return proto.get.call(this); },
        set(v) {
          try {
            const el = this;
            const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
            if (String(cls).includes("cm-scroller")) {
              const stack = (new Error().stack || "").split("\\n").slice(1, 8).map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));
              window.__ST_WRITES.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(proto.get.call(this)), stack });
            }
          } catch (e) {}
          return proto.set.call(this, v);
        },
      });
    }
    return true;
  `);

  /* ── 4. 逐帧全量快照 ── */
  const startTrace = async (ms) => ui.ev(`
    window.__FR = [];
    (function () {
      const t0 = performance.now();
      const snapBody = () => { ${FRAME_SNAP} };
      const tick = () => {
        const s = snapBody();
        if (s) { s.t = Math.round(performance.now() - t0); window.__FR.push(s); }
        if (performance.now() - t0 < ${ms}) setTimeout(tick, 16);
      };
      setTimeout(tick, 16);
    })();
    return true;
  `);

  const runCase = async (label, btnLabel, prep) => {
    // 复位：滚到 50%
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * 0.5;
      return true;
    `);
    await ui.sleep(500);
    // 光标放进视口中央
    const clickInfo = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const scR = sc.getBoundingClientRect();
      const lines = Array.from(sc.querySelectorAll(".cm-line"));
      const target = lines.find(l => { const r = l.getBoundingClientRect(); return r.top > scR.top + 150 && r.bottom < scR.bottom - 150; });
      if (!target) return { ok: false };
      const r = target.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2), text: (target.textContent || "").slice(0, 26) };
    `);
    if (!clickInfo.ok) return null;
    await ui.click(clickInfo.x, clickInfo.y);
    await ui.sleep(400);
    if (prep) await prep();

    const btn = await ui.ev(`
      const all = Array.from(document.querySelectorAll(${JSON.stringify(btnLabel.selector)}));
      const b = all.find(e => (e.getAttribute("title") || "").includes(${JSON.stringify(btnLabel.match)}) ||
                                (e.textContent || "").trim() === ${JSON.stringify(btnLabel.match)});
      if (!b) return { ok: false, seen: all.map(e => (e.getAttribute("title") || "") + "|" + (e.textContent||"").trim().slice(0,3)).slice(0, 30) };
      const r = b.getBoundingClientRect();
      return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: b.getAttribute("title") };
    `);
    if (!btn.ok) { ui.log(`[${label}] 按钮找不到: ` + JSON.stringify(btn.seen)); return null; }

    await ui.ev(`window.__FOCUS = []; window.__ST_WRITES = []; return true;`);
    await startTrace(1800);
    // 先点 mousedown（不 release），给 120ms，再 release —— 分离"mousedown 失焦"与"click handler"
    const before = await ui.ev(`{ ${FRAME_SNAP} }`);
    await ui.click(btn.x, btn.y);
    await ui.sleep(1900);

    const frames = await ui.ev(`return window.__FR || []`);
    const events = await ui.ev(`return window.__FOCUS || []`);
    const writes = await ui.ev(`return window.__ST_WRITES || []`);
    const after = await ui.ev(`{ ${FRAME_SNAP} }`);

    const uniq = (k) => [...new Set(frames.map((f) => f[k]))];
    ui.log(`\n===== ${label}（按钮 ${btn.title}）=====`);
    ui.log(`  点前: ${JSON.stringify(before)}`);
    ui.log(`  点后: ${JSON.stringify(after)}`);
    ui.log(`  逐帧取值变化: sh=${JSON.stringify(uniq("sh"))} st=${JSON.stringify(uniq("st"))}`);
    ui.log(`  contentW=${JSON.stringify(uniq("contentW"))} freq 行数=${JSON.stringify(uniq("lineCount"))}`);
    ui.log(`  fontSize=${JSON.stringify(uniq("fontSize"))} lineHeight=${JSON.stringify(uniq("lineHeight"))}`);
    ui.log(`  syntax面板=${JSON.stringify(uniq("hasSyntax"))} 焦点=${JSON.stringify(uniq("focused"))}`);
    ui.log(`  事件: ${JSON.stringify(events.slice(0, 24))}`);
    ui.log(`  scrollTop 写入: ${JSON.stringify(writes.map((w) => ({ t: w.t, v: w.v, from: w.from, top: w.stack[1] || "", top2: w.stack[2] || "" })).slice(0, 12))}`);
    // 打印第一条写入的完整栈（定位真凶）
    if (writes.length) {
      ui.log(`  首条写入栈:\n    ` + (writes[0].stack || []).join("\n    "));
    }
    return { label, before, after, frames, events, writes, uniq: { sh: uniq("sh"), st: uniq("st"), contentW: uniq("contentW"), lineCount: uniq("lineCount") } };
  };

  const r1 = await runCase("点「粗体」", { selector: ".format-btn", match: "粗体" });
  const r2 = await runCase("点「H1」", { selector: ".format-btn", match: "标题一" });
  const r3 = await runCase("点语法栏「粗体」", { selector: ".syntax-helper-item", match: "粗体" });

  ui.add("D1", "点「粗体」后布局无变化（scrollHeight 不变）",
    r1 && new Set(r1.frames.map((f) => f.sh)).size <= 1 ? "PASS" : "FAIL",
    r1 ? `scrollHeight 取值=${JSON.stringify(r1.uniq.sh)}；contentW=${JSON.stringify(r1.uniq.contentW)}；行数=${JSON.stringify(r1.uniq.lineCount)}` : "缺数据");
  ui.add("D2", "点「H1」后布局无变化",
    r2 && new Set(r2.frames.map((f) => f.sh)).size <= 1 ? "PASS" : "FAIL",
    r2 ? `scrollHeight 取值=${JSON.stringify(r2.uniq.sh)}；contentW=${JSON.stringify(r2.uniq.contentW)}` : "缺数据");
  ui.add("D3", "点语法栏后布局无变化",
    r3 && new Set(r3.frames.map((f) => f.sh)).size <= 1 ? "PASS" : "FAIL",
    r3 ? `scrollHeight 取值=${JSON.stringify(r3.uniq.sh)}；contentW=${JSON.stringify(r3.uniq.contentW)}` : "缺数据");

  await ui.shot("diag-toolbar");
});
