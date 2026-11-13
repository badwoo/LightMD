/**
 * v0.17.0 第三轮 T5：模式切换的位置/状态记忆（用户第 6、11 项）—— 实测探针
 *
 * ═══════════════════════════════════════════════════════════════════════
 * #6 「编辑符号的记忆」= **光标（caret）位置的跨模式记忆**
 * ═══════════════════════════════════════════════════════════════════════
 * 用户原话：「我在编辑模式下编辑符号在哪，切换到阅读模式编辑符号就应该在哪。」
 *
 * 判据（两层）：
 *   ① **往返一致性**（唯一的硬判据）：把源码面光标放到 offset=P → 切阅读 → 切回编辑
 *      → 源码面选区 offset 必须 == P。这是用户能直接感知的契约，且不依赖任何
 *      "参考映射"实现（不存在"自己实现一遍再自证"的循环论证）。
 *   ② **映射误差表**：对每类语法块记录「源码列 → PM 块内文本偏移」的差
 *      （= markdown 语法符占用的字符数），用于说明 ① 的误差来源与可达到的精度。
 *
 * ⚠️ 为什么必须两层都测：只测 ① 通过也可能"同块内偏了几字符但恰好落回"，
 *    只测 ② 则说明不了用户可见行为。① 是判据，② 是归因。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * #11 新打开文档自动跳到底部
 * ═══════════════════════════════════════════════════════════════════════
 * 判据：打开文档后（等布局稳定）`scrollTop` 必须 == 0，
 * 除非该文件**自己**有正确的进度快照且恢复值与内容锚一致。
 * 关键对照：A 文档滚到底 → 打开 B（短/中/长）→ 读 B 的 scrollTop。
 *
 * 采样口径：
 *   编辑面 = `.cm-scroller`（CM6 真实滚动容器）
 *   阅读面 = `.editor-container`
 * 两面的 scrollTop/scrollHeight/clientHeight 全部**现读**，不用缓存。
 *
 * 用法：
 *   npx vite build --outDir _verify-out/dist-t5 --emptyOutDir
 *   BROWSER_PROBE_DIST="D:\AI\markdown view\lightmd\_verify-out\dist-t5" node scripts/v0170-r3-mode-memory.mjs
 *   ONLY=11 ...（只跑 #11） / ONLY=6 ...（只跑 #6）
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

/* ══════════════════════════════════════════════════════════════════════
 * 夹具文档
 * ══════════════════════════════════════════════════════════════════════ */

/** 纯段落文档：每段带 PIxx 标记，供"视口中心段落"判据使用 */
function paragraphs(n, tag) {
  const out = [`# 文档 ${tag}`, ""];
  for (let i = 1; i <= n; i++) {
    out.push(
      `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。` +
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.",
      "",
    );
  }
  return out.join("\n");
}

/** #6 专用：覆盖 7 类语法块，每块都带可定位标记（K01..K07） */
const CARET_DOC = [
  "# K01 一级标题", //                       L0  标题
  "",
  "K02 纯文本段落，用来量纯文本基线的映射误差。", //  L2  纯文本
  "",
  "K03 前面有字 **加粗内容在这里** 后面也有字。", //  L4  加粗中间
  "",
  "- K04 列表项第一项", //                    L6  列表
  "- 列表项第二项",
  "",
  "> K05 引用块里的文字", //                  L10 引用
  "",
  "```js", //                               L12 代码块（围栏 + lang）
  "const K06 = 1;",
  "```",
  "",
  "| 表头 A | 表头 B |", //                   L17 表格
  "| --- | --- |",
  "| K07 单元格 | 值 |",
  "",
  "## K08 二级标题", //                       L21 标题
  "",
  "K09 结尾段落。",
  "",
].join("\n");

/* ══════════════════════════════════════════════════════════════════════
 * #6 测试点：源码 offset（**运行时**由标记串在源码里的位置算出，
 * 不硬编码，避免文档一改测试悄悄指向别的字符）
 * ══════════════════════════════════════════════════════════════════════ */
const CARET_POINTS = [
  { id: "C1", kind: "标题", marker: "K01", at: "marker", note: "标题文字起始（`# ` 之后）" },
  { id: "C2", kind: "纯文本", marker: "K02 纯文本段落", at: 6, note: "段内第 7 个字符" },
  { id: "C3", kind: "加粗中间", marker: "加粗内容在这里", at: 4, note: "`**` 包裹的加粗文字内部" },
  { id: "C4", kind: "列表项", marker: "K04 列表项", at: 6, note: "列表项内文字中部" },
  { id: "C5", kind: "引用", marker: "K05 引用", at: 8, note: "引用块内文字中部" },
  { id: "C6", kind: "代码块", marker: "const K06", at: 6, note: "代码块正文内" },
  { id: "C7", kind: "表格", marker: "K07 单元格", at: 5, note: "表格单元格内" },
  { id: "C8", kind: "标题2", marker: "K08 二级标题", at: 4, note: "`## ` 之后的标题文字内" },
];

/* ══════════════════════════════════════════════════════════════════════
 * 页面内工具（注入到 window，只读/无副作用）
 * ══════════════════════════════════════════════════════════════════════ */
const HELPERS = `
  window.__T5 = {
    /** CM6 view 句柄（内部字段 cmTile，本项目探针既有用法） */
    cmView() {
      const c = document.querySelector(".cm-content");
      try { return (c && c.cmTile && c.cmTile.view) || null; } catch (e) { return null; }
    },
    pmView() {
      /**
       * ⚠️ 探针自检踩到的坑（别重蹈）：.ProseMirror 元素的 pmViewDesc 是**文档的
       * NodeViewDesc**，它内部**没有** view 字段（只有 parent/children/dom/… 见
       * v0170-r3-selfcheck.mjs 实测）。真正带 view 的是**自定义 NodeView 的 desc**：
       * pmViewDesc.spec.view（本项目既有探针 v0160-probe-tab-indent 的落点）。
       * 所以必须从挂了 NodeView 的块（代码块/表格/…）反查；文档里没有这类块时
       * 走 docView.view 兜底。
       */
      const viaNodeView = () => {
        const sels = [".code-block-wrapper", ".table-wrapper", ".mermaid-block-wrapper",
                      ".math-block-wrapper", "li.task-item", ".image-wrapper"];
        for (const s of sels) {
          for (const el of Array.from(document.querySelectorAll(s))) {
            const spec = el.pmViewDesc && el.pmViewDesc.spec;
            if (spec && spec.view) return spec.view;
          }
        }
        return null;
      };
      try { const v = viaNodeView(); if (v) return v; } catch (e) {}
      const pm = document.querySelector(".ProseMirror");
      try {
        const d = pm && pm.pmViewDesc;
        if (d && d.view) return d.view;
      } catch (e) {}
      return null;
    },
    /** 当前可见的是编辑面还是阅读面（按 DOM 显示状态判定，不靠 store） */
    activePane() {
      const src = document.querySelector(".source-editor-cm6") || document.querySelector("textarea.source-editor");
      const rd = document.querySelector(".editor-container");
      const vis = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
      return { source: vis(src), reader: vis(rd) };
    },
    /** 两面的滚动几何（只读） */
    geom() {
      const sc = document.querySelector(".cm-scroller");
      const rs = document.querySelector(".editor-container");
      const pick = (el) => el ? {
        st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight),
        h: Math.round(el.clientHeight), max: Math.round(el.scrollHeight - el.clientHeight),
      } : null;
      return { source: pick(sc), reader: pick(rs) };
    },
    /** 源码面光标（CM6 主选区） */
    srcSel() {
      const v = this.cmView();
      if (!v) return null;
      const m = v.state.selection.main;
      return { from: m.from, to: m.to, head: m.head };
    },
    /** 阅读面光标（PM 主选区）+ 其所在块信息 */
    pmSel() {
      const v = this.pmView();
      if (!v) return null;
      const sel = v.state.selection;
      const $f = sel.$from;
      const parent = $f.parent;
      return {
        from: sel.from, to: sel.to,
        parentType: parent.type.name,
        offsetInParent: $f.parentOffset,
        parentText: parent.textContent.slice(0, 40),
        parentSize: parent.content.size,
        docSize: v.state.doc.content.size,
        textBeforeLen: v.state.doc.textBetween(0, sel.from, "\\n", "\\n").length,
      };
    },
    /** 视口中心命中的行/块标记（PIxx / Kxx），用于"滚动没被滚飞"判据 */
    /**
     * 视口中心命中的**标记**（Kxx / PIxx）。
     *
     * ## ⚠️ 两个判据坑（本探针第一版都踩了）
     * 1. **只看"覆盖中点的那一行"→ 恒 null**：段落之间有空行，'.cm-line' 的空行文本是空串，
     *    而 Kxx/PIxx 只在有内容的行上。中心点很容易正好落在空行。
     * 2. **reading pane 的 '.ProseMirror > *' 也含结构空段落**（'emptyLine'），同理。
     *
     * 正确做法：在可见区域内挑「**带标记**且与视口中心距离最近」的那一个，
     * 并把命中的文本一起返回，便于人眼复核是不是同一段。
     */
    centerMark() {
      const pickNearest = (els, mid) => {
        const cands = [];
        for (const el of els) {
          const b = el.getBoundingClientRect();
          if (b.height === 0) continue;
          const text = el.textContent || "";
          const m = /(PI\\d{2}|K\\d{2})/.exec(text);
          if (!m) continue;
          const covers = b.top <= mid && b.bottom >= mid;
          cands.push({ mark: m[1], d: covers ? -1 : Math.abs(b.top + b.height / 2 - mid), text: text.slice(0, 30) });
        }
        cands.sort((a, b2) => a.d - b2.d);
        return cands[0] || null;
      };
      const sc = document.querySelector(".cm-scroller");
      const rs = document.querySelector(".editor-container");
      if (sc && sc.getClientRects().length > 0) {
        const r = sc.getBoundingClientRect();
        const hit = pickNearest(Array.from(sc.querySelectorAll(".cm-line")), r.top + sc.clientHeight / 2);
        return { pane: "source", mark: hit ? hit.mark : null, text: hit ? hit.text : null };
      }
      if (rs && rs.getClientRects().length > 0) {
        const r = rs.getBoundingClientRect();
        const hit = pickNearest(Array.from(rs.querySelectorAll(".ProseMirror > *")), r.top + rs.clientHeight / 2);
        return { pane: "reader", mark: hit ? hit.mark : null, text: hit ? hit.text : null };
      }
      return { pane: "none", mark: null, text: null };
    },
    /** 设源码面光标（等价于 surface.setSelection，走 CM6 真实 dispatch） */
    setSrcSel(offset) {
      const v = this.cmView();
      if (!v) return false;
      const n = Math.max(0, Math.min(v.state.doc.length, offset));
      v.dispatch({ selection: { anchor: n, head: n }, scrollIntoView: false, userEvent: "select" });
      return true;
    },
    /** 设阅读面光标（PM TextSelection，走真实 dispatch） */
    setPmSel(pos) {
      const v = this.pmView();
      if (!v) return false;
      const n = Math.max(1, Math.min(v.state.doc.content.size - 1, pos));
      const Sel = v.state.selection.constructor;
      const tr = v.state.tr.setSelection(Sel.near(v.state.doc.resolve(n)));
      v.dispatch(tr);
      return true;
    },
    /** 源码面块结构（每行的 offset / 文本），用于映射误差表 */
    srcLines() {
      const v = this.cmView();
      if (!v) return null;
      const doc = v.state.doc;
      const out = [];
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        out.push({ n: i, from: line.from, to: line.to, text: line.text });
      }
      return out;
    },
    /** 源码 offset → 行号 + 行内列（0 基） */
    offsetToLineCol(offset) {
      const v = this.cmView();
      if (!v) return null;
      const doc = v.state.doc;
      const n = Math.max(0, Math.min(doc.length, offset));
      const line = doc.lineAt(n);
      return { line: line.number - 1, col: n - line.from, lineText: line.text };
    },
    /** 源码全文（走 state.doc，不受 CM6 虚拟化影响） */
    srcText() {
      const v = this.cmView();
      return v ? v.state.doc.toString() : null;
    },
    /**
     * 权威块表：PM 顶层块 ↔ 源码行区间。
     *
     * 'data-src-line' 由 'core/plugins/src-line-tag.ts' 从 'blockSourceMap'
     *（parser 解析期记录的原文行号）贴到 DOM 上 —— 这是**跨面唯一同源坐标**，
     * 也是本探针判定"落错块"的权威依据。
     *
     * 同时带上块内**可见文本**（不是 textContent：textContent 会带 "\\n" 分隔符
     * 与 leaf 文本，会污染对齐）。
     */
    pmBlocks() {
      const v = this.pmView();
      if (!v) return null;
      const root = document.querySelector(".ProseMirror");
      if (!root) return null;
      const kids = Array.from(root.children);
      const out = [];
      v.state.doc.forEach((node, offset, index) => {
        const el = kids[index];
        const srcLine = el ? el.getAttribute("data-src-line") : null;
        out.push({
          index, pos: offset, type: node.type.name,
          nodeSize: node.nodeSize,
          srcLine: srcLine === null ? null : Number(srcLine),
          attrs: { emptyLine: node.attrs.emptyLine, pad: node.attrs.pad, level: node.attrs.level },
          textContentLen: node.textContent.length,
          textContent: node.textContent.slice(0, 60),
        });
      });
      return out;
    },
    /**
     * PM 选区当前所在**顶层块下标**（按 doc 深度判断）。
     *
     * 为什么不能只看 '$from.parent.type.name'：列表项/表格单元格的 parent 是
     * 'paragraph' / 'table_cell'，都不是顶层块 —— 用户体验上"光标在哪个块"看的是顶层块。
     */
    pmSelectionBlock() {
      const v = this.pmView();
      if (!v) return null;
      const sel = v.state.selection;
      const $from = sel.$from;
      const top = $from.depth >= 1 ? $from.node(1) : $from.parent;
      let idx = -1;
      let start = 0;
      v.state.doc.forEach((node, offset, index) => {
        if (idx !== -1) return;
        // 顶层块占据 [offset, offset + nodeSize]，光标位置落在其中即命中
        if (sel.from >= offset && sel.from <= offset + node.nodeSize) {
          idx = index;
          start = offset;
        }
      });
      return {
        from: sel.from, to: sel.to,
        topIndex: idx,
        topType: top.type.name,
        topText: top.textContent.slice(0, 50),
        offsetInTop: sel.from - start,
        parentType: $from.parent.type.name,
        offsetInParent: $from.parentOffset,
      };
    },
    /** 把 PM 光标设到「第 blockIndex 个顶层块内，可见文本第 visibleIdx 个字符」 */
    setPmSelByBlock(blockIndex, visibleIdx) {
      const v = this.pmView();
      if (!v) return false;
      // 收集该块的文本节点（只取文本节点，与 alignBlockText 口径一致）
      const segs = [];
      let bi = -1;
      v.state.doc.forEach((node, offset, index) => {
        if (index !== blockIndex) return;
        bi = index;
        node.descendants((child, pos) => {
          if (child.isText && child.text) {
            segs.push({ pos: offset + 1 + pos, text: child.text });
          }
          return true;
        });
      });
      if (bi < 0) return false;
      let acc = 0;
      let target = null;
      for (let i = 0; i < segs.length; i++) {
        const len = segs[i].text.length;
        if (visibleIdx < acc + len) { target = segs[i].pos + (visibleIdx - acc); break; }
        if (visibleIdx === acc + len && i + 1 < segs.length) { target = segs[i + 1].pos; break; }
        acc += len;
      }
      if (target === null && segs.length) {
        const last = segs[segs.length - 1];
        target = last.pos + last.text.length;
      }
      if (target === null) return false;
      const Sel = v.state.selection.constructor;
      const tr = v.state.tr.setSelection(Sel.near(v.state.doc.resolve(target)));
      v.dispatch(tr);
      return true;
    },
    /** PM 块的可见文本分段（给 alignBlockText 用） */
    pmBlockSegments(blockIndex) {
      const v = this.pmView();
      if (!v) return null;
      const segs = [];
      let found = false;
      v.state.doc.forEach((node, offset, index) => {
        if (index !== blockIndex) return;
        found = true;
        node.descendants((child, pos) => {
          if (child.isText && child.text) segs.push({ pos: offset + 1 + pos, text: child.text });
          return true;
        });
      });
      return found ? segs : null;
    },
  };
  return true;
`;

/* ══════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════ */
const ONLY = process.env.ONLY || "all";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-r3-t5-"));
const docPath = (name) => path.join(TMP, name);

const DOC_MED = paragraphs(40, "MED");
const DOC_LONG = paragraphs(120, "LONG");
const DOC_SHORT = paragraphs(6, "SHORT");

await runBrowserProbe(
  { name: "v0170-r3-mode-memory", doc: CARET_DOC, docTitle: "K01" },
  async (ui) => {
    await ui.ev(HELPERS);

    /* ── 公共助手 ───────────────────────────────────────────── */
    const openDoc = async (name, content) => {
      const p = docPath(name);
      fs.writeFileSync(p, content, "utf8");
      await ui.ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(p)}, name: ${JSON.stringify(path.basename(p))}, content: ${JSON.stringify(content)} },
        }));
        return true;
      `);
      await ui.sleep(600);
    };
    const switchMode = async (mode) => {
      await ui.command(mode === "preview" ? "view.preview" : "view.edit");
      await ui.sleep(2000);
    };
    /** 等 scrollTop 稳定（连续 3 次采样不变或超时） */
    const waitStable = async (pane, tries = 8) => {
      let last = null;
      for (let i = 0; i < tries; i++) {
        const g = await ui.ev(`return window.__T5.geom()`);
        const cur = g?.[pane]?.st ?? null;
        if (last !== null && cur === last) return { g, stableAt: i };
        last = cur;
        await ui.sleep(160);
      }
      return { g: await ui.ev(`return window.__T5.geom()`), stableAt: -1 };
    };

    /* ══════════════════════════════════════════════════════════
     * #11 新打开文档自动跳到底部
     * ══════════════════════════════════════════════════════════ */
    if (ONLY === "all" || ONLY === "11") {
      ui.log("");
      ui.log("════════ #11 新打开文档是否跳到底部 ════════");

      // 基准：编辑模式（CM6）
      await openDoc("med.md", DOC_MED);
      await switchMode("edit");
      const rows = [];

      /** 记录一次"打开文档后的落点" */
      const measureOpen = async (label, name, content, extraWait = 900) => {
        await openDoc(name, content);
        const first = await ui.ev(`return window.__T5.geom()`);
        await ui.sleep(extraWait);
        const { g } = await waitStable("source");
        const pane = await ui.ev(`return window.__T5.activePane()`);
        const g2 = await ui.ev(`return window.__T5.geom()`);
        const s = g2.source;
        const r = {
          label, name,
          firstSt: first?.source?.st ?? null,
          st: s?.st ?? null, sh: s?.sh ?? null, h: s?.h ?? null, max: s?.max ?? null,
          pct: s && s.max > 0 ? +(s.st / s.max).toFixed(4) : 0,
          atBottom: !!(s && s.max > 0 && Math.abs(s.st - s.max) <= 2),
          readerSt: g2.reader?.st ?? null,
          pane,
        };
        rows.push(r);
        ui.log(
          `  ${label.padEnd(26)} st=${String(r.st).padStart(5)} / max=${String(r.max).padStart(5)} ` +
            `sh=${String(r.sh).padStart(6)} pct=${String(r.pct).padStart(7)} ${r.atBottom ? "★AT_BOTTOM" : ""} ` +
            `首帧st=${r.firstSt}`,
        );
        return r;
      };

      // A1 基线：打开中档文档（无历史进度）→ 应 0
      await measureOpen("A1 首次打开 med", "med.md", DOC_MED);

      // A2 核心对照：把 med 滚到底 → 再打开 long（滚动残留是否污染）
      await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        sc.scrollTop = sc.scrollHeight;
        sc.dispatchEvent(new Event("scroll", { bubbles: true }));
        return Math.round(sc.scrollTop);
      `);
      await ui.sleep(900);
      const a2before = await ui.ev(`return window.__T5.geom()`);
      ui.log(`  [A 文档滚到底] st=${a2before.source.st} / max=${a2before.source.max}`);
      const A2 = await measureOpen("A2 A滚到底→打开 long", "long.md", DOC_LONG);

      // A3 A 滚到底 → 打开 short（短文档：残留值会被钳到自身 max → 表现为"到底"）
      await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        sc.scrollTop = sc.scrollHeight;
        sc.dispatchEvent(new Event("scroll", { bubbles: true }));
        return Math.round(sc.scrollTop);
      `);
      await ui.sleep(900);
      ui.log(`  [long 滚到底] st=${(await ui.ev(`return window.__T5.geom()`)).source.st}`);
      const A3 = await measureOpen("A3 long到底→打开 short", "short.md", DOC_SHORT);

      // A4 新建空文档（file.new）
      // ⚠️ 探针坑：`handleNewFile` 在 `isDirty && filePath` 时会 `window.confirm(...)`，
      // 而 **headless Chrome 的 confirm 会阻塞页面主线程** → 后续 `Runtime.evaluate`
      // 直接 45s 超时（实测）。这里必须在**页面内**覆盖掉 confirm，不能靠 CDP 事件。
      await ui.ev(`window.confirm = () => true; window.alert = () => {}; return true;`);
      await ui.command("file.new");
      await ui.sleep(1600);
      const a4 = await ui.ev(`return window.__T5.geom()`);
      const a4pane = await ui.ev(`return window.__T5.activePane()`);
      const a4r = {
        label: "A4 新建空文档", name: "(untitled)",
        st: a4?.source?.st ?? null, sh: a4?.source?.sh ?? null, h: a4?.source?.h ?? null,
        max: a4?.source?.max ?? null, pct: 0, atBottom: false, pane: a4pane,
      };
      rows.push(a4r);
      ui.log(`  ${a4r.label.padEnd(26)} st=${a4r.st} / max=${a4r.max} sh=${a4r.sh}`);

      // A5 同一文件重复打开（自己滚动过 → 是否恢复自己进度，而不是跳到别处）
      await openDoc("med.md", DOC_MED);
      await ui.sleep(700);
      await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.5);
        sc.dispatchEvent(new Event("scroll", { bubbles: true }));
        return Math.round(sc.scrollTop);
      `);
      await ui.sleep(800);
      const a5saved = (await ui.ev(`return window.__T5.geom()`)).source;
      const A5 = await measureOpen("A5 重开 med（自身50%）", "med.md", DOC_MED);

      // A6 多标签来回切：med → long → med（med 用自己的 50% 进度）
      await openDoc("long.md", DOC_LONG);
      await ui.sleep(700);
      const A6 = await measureOpen("A6 long→ med（标签来回）", "med.md", DOC_MED);

      // A7 阅读模式下的同一组对照（切换模式后重复核心两条）
      await switchMode("preview");
      await ui.sleep(600);
      await ui.ev(`
        const rs = document.querySelector(".editor-container");
        if (rs) rs.scrollTop = rs.scrollHeight;
        return true;
      `);
      await ui.sleep(900);
      const a7before = await ui.ev(`return window.__T5.geom()`);
      ui.log(`  [阅读面滚到底] st=${a7before.reader?.st} / max=${a7before.reader?.max}`);
      await openDoc("fresh_read.md", DOC_MED.replace(/MED/g, "RD"));
      await ui.sleep(1400);
      const a7 = await ui.ev(`return window.__T5.geom()`);
      const a7r = {
        label: "A7 阅读面A到底→打开新doc", name: "fresh_read.md",
        st: a7?.reader?.st ?? null, sh: a7?.reader?.sh ?? null, h: a7?.reader?.h ?? null,
        max: a7?.reader?.max ?? null,
        pct: a7?.reader?.max > 0 ? +(a7.reader.st / a7.reader.max).toFixed(4) : 0,
        atBottom: !!(a7?.reader?.max > 0 && Math.abs(a7.reader.st - a7.reader.max) <= 2),
        pane: await ui.ev(`return window.__T5.activePane()`),
      };
      rows.push(a7r);
      ui.log(`  ${a7r.label.padEnd(26)} st=${a7r.st} / max=${a7r.max} pct=${a7r.pct} ${a7r.atBottom ? "★AT_BOTTOM" : ""}`);

      // ── 判定 ──
      const fresh = rows.filter((r) => r.label.startsWith("A1") || r.label.startsWith("A2") || r.label.startsWith("A3") || r.label.startsWith("A4") || r.label.startsWith("A7"));
      const freshBad = fresh.filter((r) => r.max > 0 && r.st !== 0);
      ui.add(
        "11-1",
        "全新打开（无该文件进度）后 scrollTop 必须 == 0",
        freshBad.length === 0 ? "PASS" : "FAIL",
        freshBad.length === 0
          ? `${fresh.length} 个全新打开场景全部 st=0`
          : freshBad.map((r) => `${r.label}: st=${r.st}/max=${r.max}${r.atBottom ? "(★到底)" : ""}`).join("；"),
      );
      ui.add(
        "11-2",
        "A 文档滚到底 → 打开 B 不继承 A 的滚动残留（核心对照）",
        (A2.st ?? 0) === 0 && (A3.st ?? 0) === 0 ? "PASS" : "FAIL",
        `A滚到底→long: st=${A2.st}/max=${A2.max}${A2.atBottom ? "(★到底)" : ""}；` +
          `long滚到底→short: st=${A3.st}/max=${A3.max}${A3.atBottom ? "(★到底)" : ""}`,
      );
      ui.add(
        "11-3",
        "同一文件重复打开 → 恢复**自己**的进度（不是跳到别处）",
        A5.st !== null && A5.max > 0 && A5.pct > 0.3 && A5.pct < 0.7 ? "PASS" : "FAIL",
        `打开前自身 pct=${a5saved.max > 0 ? (a5saved.st / a5saved.max).toFixed(4) : "-"} → 重开后 st=${A5.st}/max=${A5.max} pct=${A5.pct}`,
      );

      fs.writeFileSync(
        path.join(os.tmpdir(), "t5-r11.json"),
        JSON.stringify({ rows, a5saved }, null, 1),
        "utf8",
      );
    }

    /* ══════════════════════════════════════════════════════════
     * #6 光标位置的跨模式记忆
     * ══════════════════════════════════════════════════════════ */
    if (ONLY === "all" || ONLY === "6") {
      ui.log("");
      ui.log("════════ #6 光标（编辑符号）跨模式记忆 ════════");

      await openDoc("caret.md", CARET_DOC);
      await switchMode("edit");
      await ui.sleep(600);

      const src = await ui.ev(`return window.__T5.srcLines()`);
      if (!src) {
        ui.add("6-0", "CM6 就绪", "FAIL", "拿不到 CM6 view");
      } else {
        /** 解析测试点 → 源码 offset（在源码里找 marker 再按 at 偏移） */
        const points = [];
        for (const p of CARET_POINTS) {
          const hit = src.filter((l) => l.text.includes(p.marker));
          if (!hit.length) {
            ui.log(`  [跳过] ${p.id} 找不到 marker「${p.marker}」`);
            continue;
          }
          const line = hit[0];
          const col = line.text.indexOf(p.marker) + (p.at === "marker" ? 0 : p.at);
          points.push({ ...p, offset: line.from + col, lineNo: line.n - 1, col, lineText: line.text });
        }

        const table = [];
        for (const p of points) {
          // ① 设光标（编辑面）
          await ui.ev(`window.__T5.setSrcSel(${p.offset}); return true;`);
          await ui.sleep(220);
          const centerBefore = await ui.ev(`return window.__T5.centerMark()`);
          const set = await ui.ev(`return window.__T5.srcSel()`);

          // ② 切阅读面 → 读 PM 选区
          await switchMode("preview");
          const pm = await ui.ev(`return window.__T5.pmSel()`);
          const centerReader = await ui.ev(`return window.__T5.centerMark()`);

          // ③ 切回编辑面 → 读 CM6 选区
          await switchMode("edit");
          await ui.sleep(500);
          const back = await ui.ev(`return window.__T5.srcSel()`);
          const backLC = await ui.ev(`return window.__T5.offsetToLineCol(${back ? back.from : 0})`);
          const centerAfter = await ui.ev(`return window.__T5.centerMark()`);
          const geomAfter = await ui.ev(`return window.__T5.geom()`);

          const err = back ? back.from - p.offset : null;
          // 语法符占用 = 源码行内列 - PM 块内文本偏移（仅当落在同一块时可比）
          const row = {
            id: p.id, kind: p.kind, note: p.note,
            srcOffset: p.offset, line: p.lineNo, col: p.col,
            lineText: p.lineText,
            applied: set ? set.from : null,
            pmFrom: pm ? pm.from : null,
            pmParentType: pm ? pm.parentType : null,
            pmOffsetInParent: pm ? pm.offsetInParent : null,
            pmParentText: pm ? pm.parentText : null,
            backOffset: back ? back.from : null,
            backLine: backLC ? backLC.line : null,
            backCol: backLC ? backLC.col : null,
            err,
            syntaxDelta: pm && p.col != null && pm.offsetInParent != null ? p.col - pm.offsetInParent : null,
            centerBefore: centerBefore?.mark ?? null,
            centerReader: centerReader?.mark ?? null,
            centerAfter: centerAfter?.mark ?? null,
            sourceSt: geomAfter?.source?.st ?? null,
          };
          table.push(row);
          ui.log(
            `  ${p.id} ${p.kind.padEnd(6)} 源码@${String(p.offset).padStart(4)}(L${row.line}C${row.col})` +
              ` → PM from=${String(row.pmFrom).padStart(4)} [${row.pmParentType} +${row.pmOffsetInParent}]` +
              ` 语法Δ=${String(row.syntaxDelta).padStart(3)}` +
              ` → 回到源码@${String(row.backOffset).padStart(4)}(L${row.backLine}C${row.backCol})` +
              ` 误差=${row.err === null ? "-" : row.err >= 0 ? "+" + row.err : row.err}` +
              ` 中心 ${row.centerBefore}→${row.centerReader}→${row.centerAfter}`,
          );
        }

        const exact = table.filter((r) => r.err === 0);
        const within2 = table.filter((r) => r.err !== null && Math.abs(r.err) <= 2);
        const sameLine = table.filter((r) => r.err !== null && r.backLine === r.line);
        const centerKept = table.filter((r) => r.centerBefore && r.centerAfter && r.centerBefore === r.centerAfter);

        ui.add(
          "6-1",
          "往返精度：编辑→阅读→编辑 后源码 offset **完全一致**",
          exact.length === table.length ? "PASS" : "FAIL",
          `${exact.length}/${table.length} 精确一致；≤2 字符 ${within2.length}/${table.length}；同块同相对位置 ${sameLine.length}/${table.length}`,
        );
        ui.add(
          "6-2",
          "误差分布（判定「已知限制」用）",
          exact.length === table.length ? "PASS" : "KNOWN",
          `误差(字符)：${table.map((r) => `${r.id}:${r.err === null ? "?" : r.err}`).join(" ")}`,
        );
        /**
         * 6-3：切换是否把视口滚飞。
         *
         * ## ⚠️ 第一版判据恒真（本探针自检抓出来的）
         * 用 23 行的夹具测"视口中心标记切换前后一致"，8/8 全 PASS —— 但**这是假绿**：
         * 夹具内容不足一屏（`scrollHeight === clientHeight`），视口根本滚不动，
         * 中心永远命中同一行 `K06`。即使我把映射改成"恒落块首"（破坏性对照），
         * 这条判据**依然 8/8 PASS**。判据对缺陷不敏感 = 装饰品。
         *
         * ## 修法：换长文档 + 先自检判据自身有分辨力
         * 1. 用 40 段文档（可滚动），视口中心才真的是"当前看到的位置"；
         * 2. **先自检**：滚动到 0 / 50% / 100% 三处，中心标记必须**互不相同**
         *    —— 否则说明判据仍然恒真，直接判 FAIL 而不是 PASS；
         * 3. 再做"切模式往返后中心标记是否保持"。
         */
        await openDoc("caret-long.md", paragraphs(40, "LONG"));
        await switchMode("edit");
        await ui.sleep(1400);

        const setPct = (pct) => ui.ev(`
          const sc = document.querySelector(".cm-scroller");
          const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
          sc.scrollTop = Math.round(max * ${pct});
          sc.dispatchEvent(new Event("scroll", { bubbles: true }));
          return Math.round(sc.scrollTop);
        `);

        // ① 判据自检：三处中心的标记必须互不相同（有分辨力）
        const marks = [];
        for (const pct of [0, 0.5, 1]) {
          await setPct(pct);
          await ui.sleep(900);
          marks.push((await ui.ev(`return window.__T5.centerMark()`))?.mark ?? null);
        }
        const discriminative = new Set(marks.filter(Boolean)).size >= 2;
        ui.log(`  [6-3 自检] 0%/50%/100% 中心标记 = ${JSON.stringify(marks)} → 分辨力=${discriminative}`);

        // ② 往返：从中部位置开始，切阅读再切回，比较中心标记
        await setPct(0.5);
        await ui.sleep(900);
        const c0 = await ui.ev(`return window.__T5.centerMark()`);
        await switchMode("preview");
        const c1 = await ui.ev(`return window.__T5.centerMark()`);
        await switchMode("edit");
        await ui.sleep(700);
        const c2 = await ui.ev(`return window.__T5.centerMark()`);
        ui.log(`  [6-3] 中心标记 编辑 ${c0?.mark} → 阅读 ${c1?.mark} → 编辑 ${c2?.mark}`);

        const keptBack = c0?.mark && c2?.mark && c0.mark === c2.mark;
        const keptAcross = c0?.mark && c1?.mark && c0.mark === c1.mark;

        ui.add(
          "6-3a",
          "★ 判据自检：视口中心标记随滚动变化（防恒真 —— 三条全 PASS 才是真判据）",
          discriminative ? "PASS" : "FAIL",
          `0%/50%/100% → ${JSON.stringify(marks)}`,
        );
        ui.add(
          "6-3b",
          "切换往返后视口中心标记回到原处（编辑→阅读→编辑）",
          discriminative && keptBack ? "PASS" : "FAIL",
          `编辑 ${c0?.mark} → 阅读 ${c1?.mark} → 编辑 ${c2?.mark}`,
        );
        ui.add(
          "6-3c",
          "编辑→阅读 方向视口中心内容一致（切换不滚飞）",
          discriminative && keptAcross ? "PASS" : "KNOWN",
          `编辑 ${c0?.mark} → 阅读 ${c1?.mark}`,
        );

        fs.writeFileSync(
          path.join(os.tmpdir(), "t5-r6.json"),
          JSON.stringify({ table }, null, 1),
          "utf8",
        );
      }
    }
  },
);
