/**
 * #11 决定性诊断：**A 文档滚到底 → 打开 B 文档**，谁把 B 的 scrollTop 写成 max？
 *
 * 现象（v0170-r3-mode-memory A2）：A(med) 滚到底 st=max=3735 →
 * 打开 B(long) 后 **首帧 st=max=11539**（不是"逐帧爬到底"，是一步到位）。
 *
 * 本探针在页面内打桩记录**写入者调用栈**：
 *   1. Element.prototype.scrollTop setter（CM6 真实滚动容器 .cm-scroller 也走这条）
 *   2. Element.prototype.scrollIntoView / scrollTo / scrollBy
 *   3. HTMLElement.prototype.focus（抓 preventScroll 缺失导致的"聚焦滚动"）
 *   4. 同时记录 fileScrollProgress 相关时机：记录每次写入时的 doc 长度/首行，
 *      判断"新文档内容何时到位"与"写入何时发生"的先后。
 *
 * 判读：
 *   - 若写入栈里有 `atBottom`/`setScrollTop(max)` → 是"贴底语义"被错误继承；
 *   - 若栈里有 PreviewPane 的 syncToSource / verifyAfterFinalize → 是右屏→左屏联动；
 *   - 若栈里有 ModeSync 的恢复链 → 是进度恢复读到残留 percent。
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function paragraphs(n, tag) {
  const out = [`# 文档 ${tag}`, ""];
  for (let i = 1; i <= n; i++) {
    out.push(
      `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")}。` +
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.",
      "",
    );
  }
  return out.join("\n");
}

const DOC_MED = paragraphs(40, "MED");
const DOC_LONG = paragraphs(120, "LONG");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-r3-t5-diag-"));

const INSTALL = `
  if (window.__W) return true;
  window.__W = { log: [], on: false };
  const push = (o) => {
    if (!window.__W.on) return;
    if (window.__W.log.length > 400) return;
    try { window.__W.log.push(Object.assign({ t: Math.round(performance.now()) }, o)); } catch (e) {}
  };
  const shorten = (n) => (new Error().stack || "").split("\\n").slice(2, n || 9)
    .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 150));
  const desc = (el) => {
    const c = (el && el.className && typeof el.className === "string") ? el.className : (el && el.tagName || "");
    return String(c).slice(0, 40);
  };
  const isTarget = (el) => {
    const c = desc(el);
    return c.includes("cm-scroller") || c.includes("cm-content") || c.includes("source-editor") || c.includes("editor-container");
  };
  const docInfo = () => {
    const c = document.querySelector(".cm-content");
    try {
      const v = c && c.cmTile && c.cmTile.view;
      if (v) { const d = v.state.doc; return { len: d.length, first: d.line(1).text.slice(0, 14) }; }
    } catch (e) {}
    return null;
  };
  const p = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true, enumerable: p.enumerable,
    get() { return p.get.call(this); },
    set(v) {
      try {
        if (isTarget(this)) {
          push({ k: "set(scrollTop)", cls: desc(this), v: Math.round(v), from: Math.round(p.get.call(this)),
                 doc: docInfo(), stack: shorten(9) });
        }
      } catch (e) {}
      return p.set.call(this, v);
    },
  });
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    try { if (isTarget(this)) push({ k: "scrollIntoView", cls: desc(this), arg: JSON.stringify(arg || null), stack: shorten(7) }); } catch (e) {}
    return siv.apply(this, arguments);
  };
  for (const n of ["scrollTo", "scrollBy"]) {
    const o = Element.prototype[n];
    if (typeof o !== "function") continue;
    Element.prototype[n] = function () {
      try { if (isTarget(this)) push({ k: n, cls: desc(this), arg: JSON.stringify(Array.from(arguments)).slice(0, 100), stack: shorten(7) }); } catch (e) {}
      return o.apply(this, arguments);
    };
  }
  const fo = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (opts) {
    try { if (isTarget(this) || desc(this).includes("cm-")) push({ k: "focus", cls: desc(this), preventScroll: !!(opts && opts.preventScroll), stack: shorten(6) }); } catch (e) {}
    return fo.apply(this, arguments);
  };
  return true;
`;

const READ = `
  const sc = document.querySelector(".cm-scroller");
  const rs = document.querySelector(".editor-container");
  const pick = (el) => el ? { st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), h: Math.round(el.clientHeight), max: Math.round(el.scrollHeight - el.clientHeight) } : null;
  const c = document.querySelector(".cm-content");
  let doc = null;
  try { const v = c && c.cmTile && c.cmTile.view; if (v) { const d = v.state.doc; doc = { len: d.length, first: d.line(1).text.slice(0, 16), lines: d.lines }; } } catch (e) {}
  return { src: pick(sc), reader: pick(rs), doc, log: (window.__W.log || []).length };
`;

await runBrowserProbe({ name: "v0170-r3-diag-ab", doc: DOC_MED, docTitle: "PI01" }, async (ui) => {
  const openDoc = async (name, content) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, content, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(p)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} },
      }));
      return true;
    `);
  };

  await ui.ev(INSTALL);
  ui.log("[diag] 桩已安装");

  // 进编辑模式（带分屏预览）
  await ui.command("view.edit");
  await ui.sleep(3000);
  ui.log("[diag] 初始 " + JSON.stringify(await ui.ev(READ)));

  // A 滚到底
  await ui.ev(`
    window.__W.on = true; window.__W.log = [];
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = sc.scrollHeight;
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return Math.round(sc.scrollTop);
  `);
  await ui.sleep(1200);
  const beforeA = await ui.ev(READ);
  ui.log(`[diag] A 滚到底后 ${JSON.stringify(beforeA.src)} doc=${beforeA.doc && beforeA.doc.first}`);

  // 清空日志，然后打开 B
  await ui.ev(`window.__W.log = []; return true;`);
  await openDoc("long.md", DOC_LONG);
  const samples = [];
  for (let i = 0; i < 24; i++) {
    await ui.sleep(120);
    samples.push(await ui.ev(READ).catch(() => null));
  }
  ui.log("[diag] 打开 B 后的 st 轨迹：");
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s) continue;
    ui.log(`  t+${(i * 120).toString().padStart(4)}ms st=${String(s.src && s.src.st).padStart(6)} max=${String(s.src && s.src.max).padStart(6)} sh=${String(s.src && s.src.sh).padStart(6)} doc=(${s.doc ? s.doc.lines + "行 " + s.doc.first : "?"}) writes=${s.log}`);
  }

  const writes = await ui.ev(`return (window.__W.log || []).filter(e => e.k === "set(scrollTop)" || e.k === "scrollIntoView" || e.k === "focus" || e.k === "scrollTo")`);
  ui.log("");
  ui.log(`[diag] 共 ${writes.length} 条写入/滚动事件：`);
  for (const w of writes) {
    ui.log(`  ${w.k} cls=${w.cls} v=${w.v} from=${w.from} doc=${w.doc ? w.doc.lines + "行:" + w.doc.first : "?"} preventScroll=${w.preventScroll}`);
    for (const line of (w.stack || [])) ui.log(`      ${line}`);
    ui.log("      ----");
  }
  fs.writeFileSync(path.join(os.tmpdir(), "t5-diag-ab.json"), JSON.stringify({ samples, writes, beforeA }, null, 1), "utf8");
});
