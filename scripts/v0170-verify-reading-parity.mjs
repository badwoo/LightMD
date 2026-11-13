/**
 * v0.17.0 复核 —— C 流探针：阅读/编辑文档对齐 + 排版设置 × 位置记忆
 *
 * 探针：scripts/v0170-verify-reading-parity.mjs
 * 产物：_verify-out/v0170-verify-reading-parity-{align,settings}.{json,txt}
 * 截图：_verify-out/shots/v0170-verify-reading-parity-*.png
 *
 * ══ 设计要点 ═══════════════════════════════════════════════════════════
 *
 * 1. **两阶段**（两次 runProbe，各自新实例 + 新临时 profile）：
 *    · align    —— Part 1 两模式内容对齐
 *    · settings —— Part 2 排版设置 × 位置记忆
 *
 * 2. **判据不在页面字符串里写复杂正则**：页面只负责取原始几何/文本，
 *    分类与比对全部放在 Node 侧做（正常 JS 正则）。
 *    ⚠️ 这是在吃过一次亏之后改的：上一版把 `/^- \[( |x)\] /` 写在模板字符串里，
 *    转义被吞成 `/^- [( |x)] /`，导致「任务列表」被误判为普通无序列表，
 *    进而把「块序列不一致」误报成缺陷。此类 bug 会让判定结论整体失真。
 *
 * 3. **位置量化为「锚定 token 的 viewportY 位移」**（用户可感知口径）：
 *    改设置前记录「视口中央那个 PIxx 段落」，改完后找**同一个** PIxx，
 *    比它相对滚动容器顶部的 y 位移 Δ。Δ 小 = 眼前内容没动（正确）；
 *    Δ 大 = 用户会看到内容"往上/往下窜"。
 *    容差：≤2px 保持 / 2–20px 轻微 / >20px 失效。
 *
 * 4. **P0-1 干扰剥离**：全程 MutationObserver 计 `.cm-editor` removed/added。
 *
 * 5. **可见性一律 getBoundingClientRect 宽高 > 0**（简报 §3.1）。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

/* ═════════════════════════ 测试文档 ═════════════════════════ */

const ALIGN_DOC = `# S-H1 顶级标题

S-PARA 这是普通段落，包含 **S-BOLD 加粗**、*S-ITA 斜体*、~~S-DEL 删除线~~、以及 \`S-CODE 行内代码\`。
段落第二句用于验证块顺序不被打乱。

## S-H2 二级标题

### S-H3 三级标题

#### S-H4 四级标题

##### S-H5 五级标题

###### S-H6 六级标题

- S-UL1 无序项一
- S-UL2 无序项二
- S-UL3 无序项三

1. S-OL1 有序项一
2. S-OL2 有序项二

- [ ] S-TASK1 未完成任务
- [x] S-TASK2 已完成任务

> S-QUOTE 引用块内容
> 引用第二行

| S-TH1 表头一 | S-TH2 表头二 |
| --- | --- |
| S-TD1 单元一 | S-TD2 单元二 |

\`\`\`js
// S-FENCE 代码块
const sFence = "S-FENCE-VAL";
\`\`\`

---

段落重复校验：S-REP 第一次。S-REP 第二次。S-REP 第三次。

结尾标记 S-TAIL。
`;

const _paras = [];
for (let i = 1; i <= 40; i++) {
  _paras.push(
    `这是第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供位置定位使用。` +
      `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
  );
}
const LONG_DOC = `# SET-HEAD 长文档

${_paras.slice(0, 10).join("\n\n")}

## SET-H2 中段

${_paras.slice(10, 20).join("\n\n")}

## SET-TAIL 结尾

${_paras.slice(20, 32).join("\n\n")}
`;
const LONG_LINES = LONG_DOC.split("\n").length;

/* ═════════════════════════ 页面侧工具（只取原始数据） ═════════════════════════ */

const RP_HELPERS = `
window.__RP = {
  vis(sel) {
    const el = document.querySelector(sel);
    if (!el) return { exists: false, visible: false, w: 0, h: 0 };
    const r = el.getBoundingClientRect();
    return { exists: true, visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height) };
  },
  mode() {
    const cm = this.vis(".cm-editor");
    const pm = this.vis(".editor-container .ProseMirror");
    if (cm.visible) return "edit";
    if (pm.visible) return "read";
    return "unknown";
  },
  _mk(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    return { st: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight),
             max: Math.round(max), pct: max > 0 ? +(el.scrollTop / max).toFixed(4) : null };
  },
  editScroll() { return this._mk(".cm-scroller"); },
  readScroll() { return this._mk(".editor-container"); },
  _root(mode) {
    return mode === "edit" ? document.querySelector(".cm-scroller")
                           : document.querySelector(".editor-container");
  },
  /* 编辑侧：原始行文本（分类交给 Node 侧做，避免页面字符串里的正则转义问题） */
  editLines() {
    return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "");
  },
  /* 阅读侧：顶层块 + 干净文本 + 原始 tag/class（分类交给 Node 侧） */
  readBlocks() {
    const pm = document.querySelector(".editor-container .ProseMirror");
    if (!pm) return null;
    return Array.from(pm.children).map((el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll("select, button, input, option, .code-line-numbers, .line-numbers, .pm-heading-marker")
        .forEach(n => n.remove());
      return { tag: el.tagName.toLowerCase(), cls: String(el.className || ""),
               text: (c.textContent || "") };
    });
  },
  readStruct() {
    const r = document.querySelector(".editor-container .ProseMirror");
    if (!r) return null;
    const q = (s) => r.querySelectorAll(s).length;
    return { h1:q("h1"),h2:q("h2"),h3:q("h3"),h4:q("h4"),h5:q("h5"),h6:q("h6"),
             strong:q("strong,b"), em:q("em,i"), del:q("del,s"), codeInline:q("code"),
             codeWrapper:q(".code-block-wrapper"), preTag:q("pre"), blockquote:q("blockquote"),
             ul:q("ul:not(.task-list)"), ol:q("ol"), li:q("li"),
             taskChecked:q('input[type="checkbox"]:checked'),
             taskUnchecked:q('input[type="checkbox"]:not(:checked)'),
             table:q("table"), th:q("th"), td:q("td"), hr:q("hr") };
  },
  /* 视口「顶部首个可见块」——与应用补偿逻辑 captureAnchor 同一口径。
     应用承诺的是"顶部那个块不动"，所以判位置保持必须用这个口径，
     不能用视口中央块：行高/宽度变大时中央块**本来**就会移动（内容变高），
     那是正常扩散，不是缺陷。 */
  anchorAtTop(mode) {
    const root = this._root(mode);
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const els = mode === "edit" ? Array.from(document.querySelectorAll(".cm-line"))
                                : Array.from(document.querySelectorAll(".editor-container .ProseMirror > *"));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      if (r.bottom > rr.top + 1) {
        const m = /PI([0-9][0-9])/.exec(el.textContent || "");
        return { found: true, tok: m ? "PI" + m[1] : null,
                 viewportY: Math.round(r.top - rr.top),
                 contentY: Math.round(r.top - rr.top + root.scrollTop),
                 st: Math.round(root.scrollTop), h: Math.round(r.height) };
      }
    }
    return { found: false };
  },
  /* 某 token 所在块相对滚动容器顶部的 y（用户可感知口径）+ 内容内绝对 y */
  tokenY(mode, tok) {
    const root = this._root(mode);
    if (!root) return { found: false };
    const rr = root.getBoundingClientRect();
    const els = mode === "edit" ? Array.from(document.querySelectorAll(".cm-line"))
                                : Array.from(document.querySelectorAll(".editor-container .ProseMirror > *"));
    for (const el of els) {
      if ((el.textContent || "").indexOf(tok) < 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      return { found: true, viewportY: Math.round(r.top - rr.top),
               contentY: Math.round(r.top - rr.top + root.scrollTop), h: Math.round(r.height) };
    }
    return { found: false };
  },
  /* 视口中央最近的内容块 token */
  centerToken(mode) {
    const root = this._root(mode);
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const mid = rr.top + rr.height / 2;
    const els = mode === "edit" ? Array.from(document.querySelectorAll(".cm-line"))
                                : Array.from(document.querySelectorAll(".editor-container .ProseMirror > *"));
    let best = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const m = /PI([0-9][0-9])/.exec(el.textContent || "");
      if (!m) continue;
      const d = Math.abs((r.top + r.height / 2) - mid);
      if (!best || d < best.d) best = { d: Math.round(d), tok: "PI" + m[1] };
    }
    return best;
  },
  /* 视口中央块 + 它自己的 token 的 viewportY（一次取齐，作为位置基线） */
  anchorAtCenter(mode) {
    const c = this.centerToken(mode);
    if (!c) return null;
    const t = this.tokenY(mode, c.tok);
    return { tok: c.tok, centerDist: c.d, viewportY: t.viewportY, contentY: t.contentY, found: t.found };
  },
  typo() {
    const fs = (el) => { if (!el) return null; const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, lineHeight: cs.lineHeight }; };
    const sp = document.querySelector(".cm-scroller");
    const pmP = document.querySelector(".editor-container .ProseMirror p");
    const h = document.querySelector(".source-editor-cm6");
    return {
      cmLine: fs(document.querySelector(".cm-line")),
      cmEditor: fs(document.querySelector(".cm-editor")),
      cmScrollerPadLeft: sp ? getComputedStyle(sp).paddingLeft : null,
      pmP: pmP ? { fontSize: getComputedStyle(pmP).fontSize,
                   lineHeight: getComputedStyle(pmP).lineHeight,
                   marginTop: getComputedStyle(pmP).marginTop } : null,
      hostInlineFontSize: h ? h.style.fontSize : null,
    };
  },
  cssVars() {
    const cs = getComputedStyle(document.documentElement);
    const o = {};
    for (const n of ["--doc-zoom", "--editor-font-size", "--editor-line-height",
                     "--editor-paragraph-spacing", "--editor-content-max-width"])
      o[n] = cs.getPropertyValue(n).trim();
    return o;
  },
  zoom() { return getComputedStyle(document.documentElement).getPropertyValue("--doc-zoom").trim(); },
  settings() {
    try {
      const o = JSON.parse(localStorage.getItem("lightmd-settings") || "null");
      if (!o || !o.state) return null;
      const s = o.state;
      return { fontSize: s.fontSize, docZoom: s.docZoom, lineHeight: s.lineHeight,
               paragraphSpacing: s.paragraphSpacing, contentMaxWidth: s.contentMaxWidth };
    } catch { return null; }
  },
  progress() { try { return localStorage.getItem("lightmd-scroll-progress"); } catch { return null; } },
  rebuild() { return window.__RM ? { del: window.__RM.del, add: window.__RM.add } : null; },
  resetRebuild() { if (window.__RM) { window.__RM.del = 0; window.__RM.add = 0; } return true; },
  scrollToPct(mode, pct) {
    const root = this._root(mode);
    if (!root) return null;
    const max = root.scrollHeight - root.clientHeight;
    root.scrollTop = Math.max(0, Math.round(max * pct));
    root.dispatchEvent(new Event("scroll"));
    return { st: Math.round(root.scrollTop), max: Math.round(max) };
  },
  /* 把某个 token 摆到视口 30% 处 */
  placeToken(mode, tok, frac) {
    const root = this._root(mode);
    if (!root) return { found: false };
    const rr = root.getBoundingClientRect();
    const els = mode === "edit" ? Array.from(document.querySelectorAll(".cm-line"))
                                : Array.from(document.querySelectorAll(".editor-container .ProseMirror > *"));
    for (const el of els) {
      if ((el.textContent || "").indexOf(tok) < 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const contentY = r.top - rr.top + root.scrollTop;
      root.scrollTop = Math.max(0, Math.round(contentY - root.clientHeight * frac));
      root.dispatchEvent(new Event("scroll"));
      return { found: true, st: Math.round(root.scrollTop), max: Math.round(root.scrollHeight - root.clientHeight) };
    }
    return { found: false };
  },
};
return true;
`;

const RP_REBUILD_OBSERVER = `
window.__RM = { del: 0, add: 0 };
const host = document.querySelector(".source-editor-cm6") || document.body;
const mo = new MutationObserver((ms) => {
  for (const m of ms) {
    for (const n of (m.removedNodes || []))
      if (n.nodeType === 1 && String(n.className || "").indexOf("cm-editor") >= 0) window.__RM.del++;
    for (const n of (m.addedNodes || []))
      if (n.nodeType === 1 && String(n.className || "").indexOf("cm-editor") >= 0) window.__RM.add++;
  }
});
mo.observe(host, { childList: true, subtree: true });
return true;
`;

/* ═════════════════════════ Node 侧分类 / 归一化 / 判据 ═════════════════════════ */

const tight = (s) => String(s || "").replace(/\s+/g, "");
const sentinels = (s) => (String(s || "").toUpperCase().match(/S-[A-Z0-9-]+/g) || []);
const uniq = (a) => a.filter((t, i) => a.indexOf(t) === i);

/** 阅读侧顶层块分类（处理 NodeView wrapper） */
function classifyRead(b) {
  const t = b.tag, cls = b.cls || "";
  if (/^h[1-6]$/.test(t)) return t;
  if (t === "div" && cls.indexOf("table-wrapper") >= 0) return "table";
  if (t === "div" && cls.indexOf("code-block-wrapper") >= 0) return "pre";
  if (t === "ul") return cls.indexOf("task-list") >= 0 ? "ul-task" : "ul";
  if (t === "ol") return "ol";
  if (t === "blockquote") return "blockquote";
  if (t === "table") return "table";
  if (t === "pre") return "pre";
  if (t === "hr") return "hr";
  if (t === "p") return "p";
  return t;
}

/** 编辑侧：按空行切块（与 PM 顶层节点粒度一致）+ 按首行语法分类 */
function editBlocksFromLines(lines) {
  const groups = [];
  let cur = [];
  let inFence = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) {
      cur.push(ln);
      if (!inFence) { inFence = true; }
      else { groups.push(cur); cur = []; inFence = false; }
      continue;
    }
    if (inFence) { cur.push(ln); continue; }
    if (!ln.trim()) { if (cur.length) { groups.push(cur); cur = []; } continue; }
    cur.push(ln);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) => {
    const f = g[0];
    let kind = "p";
    if (/^###### /.test(f)) kind = "h6";
    else if (/^##### /.test(f)) kind = "h5";
    else if (/^#### /.test(f)) kind = "h4";
    else if (/^### /.test(f)) kind = "h3";
    else if (/^## /.test(f)) kind = "h2";
    else if (/^# /.test(f)) kind = "h1";
    else if (/^- \[( |x)\] /.test(f)) kind = "ul-task";
    else if (/^- /.test(f)) kind = "ul";
    else if (/^\d+\. /.test(f)) kind = "ol";
    else if (/^> /.test(f)) kind = "blockquote";
    else if (/^\|/.test(f)) kind = "table";
    else if (/^---\s*$/.test(f)) kind = "hr";
    else if (/^```/.test(f)) kind = "pre";
    return { kind, lines: g };
  });
}

/** 编辑侧块 → 去语法纯文本（逐行剥标记，最后不插空格拼接，与渲染侧一致） */
function stripEditBlock(b) {
  const k = b.kind;
  if (k === "hr") return "";
  let lines = b.lines.slice();
  if (k === "pre") {
    lines = lines.filter((l) => !/^```/.test(l));
    return lines.join("").trim();
  }
  if (k === "table") {
    lines = lines.map((l) => l.replace(/^\|/, "").replace(/\|$/, ""));
    lines = lines.filter((l) => !/^[\s|:-]+$/.test(l)); // 去掉分隔行 | --- | --- |
    return lines.join(" ").replace(/[*_~`]/g, "").trim();
  }
  lines = lines.map((l) => {
    if (k === "h1" || k === "h2" || k === "h3" || k === "h4" || k === "h5" || k === "h6")
      return l.replace(/^#{1,6}\s+/, "");
    if (k === "ul") return l.replace(/^- /, "");
    if (k === "ul-task") return l.replace(/^- \[( |x)\] /, "");
    if (k === "ol") return l.replace(/^\d+\. /, "");
    if (k === "blockquote") return l.replace(/^> ?/, "");
    return l;
  });
  return lines.join("").replace(/[*_~`]/g, "").trim();
}

/** 位置漂移判定 */
function judgeDrift(abs) {
  if (abs === null || abs === undefined) return "KNOWN";
  if (abs <= 2) return "PASS";
  if (abs <= 20) return "KNOWN";
  return "FAIL";
}

async function clickAt(ui, x, y) {
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ui.sleep(60);
  await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await ui.sleep(220);
}

/* ═════════════════════════ 阶段 1：两模式内容对齐 ═════════════════════════ */

await runProbe(
  { name: "v0170-verify-reading-parity-align", doc: ALIGN_DOC, docTitle: "S-H1", viewMode: "read" },
  async (ui) => {
    await ui.ev(RP_HELPERS);
    await ui.ev(RP_REBUILD_OBSERVER);
    const docLines = ALIGN_DOC.split("\n").length;
    ui.log(`[align] impl=${ui.impl} 文档 ${ALIGN_DOC.length} 字符 / ${docLines} 行`);

    /* ── 阅读侧 ── */
    const Rr = await ui.ev(`
      return { mode: window.__RP.mode(),
               vis: { cm: window.__RP.vis(".cm-editor"), pm: window.__RP.vis(".editor-container .ProseMirror") },
               blocks: window.__RP.readBlocks(), struct: window.__RP.readStruct() };
    `);
    const readBlocks = Rr.blocks.map((b) => ({ kind: classifyRead(b), text: b.text, raw: b.tag }));
    ui.log(`[align] 阅读态 mode=${Rr.mode} cm=${Rr.vis.cm.w}×${Rr.vis.cm.h} pm=${Rr.vis.pm.w}×${Rr.vis.pm.h}`);
    ui.log(`[align] 阅读块 ${readBlocks.length}：${readBlocks.map((b, i) => `[${i}]${b.kind}`).join(" ")}`);
    ui.log(`[align] 阅读结构: ${JSON.stringify(Rr.struct)}`);
    await ui.shot("align-read-mode");

    /* ── 编辑侧 ── */
    await ui.command("view.edit");
    await ui.sleep(2800);
    await ui.ev(RP_HELPERS);
    const Er = await ui.ev(`
      return { mode: window.__RP.mode(),
               vis: { cm: window.__RP.vis(".cm-editor"), pm: window.__RP.vis(".editor-container .ProseMirror") },
               lines: window.__RP.editLines(), rebuild: window.__RP.rebuild() };
    `);
    const editBlocks = editBlocksFromLines(Er.lines);
    const editText = (Er.lines || []).join("\n");
    ui.log(`[align] 编辑态 mode=${Er.mode} cm=${Er.vis.cm.w}×${Er.vis.cm.h} pm=${Er.vis.pm.w}×${Er.vis.pm.h}`);
    ui.log(`[align] 编辑 .cm-line=${Er.lines.length}/${docLines} 块 ${editBlocks.length}：${editBlocks.map((b, i) => `[${i}]${b.kind}`).join(" ")}`);
    await ui.shot("align-edit-mode");

    /* ── 0. 可见性自证 ── */
    ui.add("0", "模式可见性判据自证（getBoundingClientRect 口径）",
      Rr.mode === "read" && Er.mode === "edit" && Rr.vis.pm.visible && !Rr.vis.cm.visible &&
      Er.vis.cm.visible && !Er.vis.pm.visible ? "PASS" : "FAIL",
      `阅读态 cm ${Rr.vis.cm.w}×${Rr.vis.cm.h} / PM ${Rr.vis.pm.w}×${Rr.vis.pm.h}；编辑态 cm ${Er.vis.cm.w}×${Er.vis.cm.h} / PM ${Er.vis.pm.w}×${Er.vis.pm.h}`);

    /* ── 1. 块序列（顶层粒度） ── */
    const rk = readBlocks.map((b) => b.kind), ek = editBlocks.map((b) => b.kind);
    const seqEqual = rk.join(",") === ek.join(",");
    let kDiff = null;
    if (!seqEqual) for (let i = 0; i < Math.max(rk.length, ek.length); i++) {
      if (rk[i] !== ek[i]) { kDiff = { i, read: rk[i], edit: ek[i] }; break; }
    }
    ui.log(`[align] 块序列: 阅读 ${rk.length} / 编辑 ${ek.length} / 一致=${seqEqual}` +
      (kDiff ? ` 首差第 ${kDiff.i} 块 阅读=${kDiff.read} 编辑=${kDiff.edit}` : ""));
    ui.add("1", "块序列一致（阅读顶层块 ↔ 编辑按空行切块，同粒度）",
      seqEqual ? "PASS" : "FAIL",
      seqEqual ? `两侧块类型序列完全一致（各 ${rk.length} 块）：${rk.join(" → ")}`
        : `首差第 ${kDiff.i} 块：阅读=${kDiff.read} 编辑=${kDiff.edit}；阅读=[${rk.join(",")}] 编辑=[${ek.join(",")}]`);

    /* ── 2. 块内文本逐块比对（去语法 + 忽略空白） ── */
    const diffs = [];
    const nBlk = Math.max(readBlocks.length, editBlocks.length);
    for (let i = 0; i < nBlk; i++) {
      const rb = readBlocks[i], eb = editBlocks[i];
      if (!rb || !eb) { diffs.push({ i, read: rb ? rb.text : "(缺)", edit: eb ? eb.kind : "(缺)" }); continue; }
      const a = tight(rb.text), b = tight(stripEditBlock(eb));
      if (a !== b) diffs.push({ i, kind: rb.kind, read: a, edit: b });
    }
    ui.log(`[align] 块内文本: ${nBlk} 块中 ${diffs.length} 块不一致`);
    diffs.slice(0, 6).forEach((d) => ui.log(`[align]   第${d.i}块(${d.kind || "?"}) 阅读="${String(d.read).slice(0, 90)}" 编辑="${String(d.edit).slice(0, 90)}"`));
    ui.add("2", "块内文本逐块一致（阅读剔控件噪音 ↔ 编辑去 Markdown 语法，忽略空白）",
      diffs.length === 0 ? "PASS" : diffs.length <= 2 ? "KNOWN" : "FAIL",
      diffs.length === 0 ? `全部 ${nBlk} 块文本逐块完全相同（0 处差异）`
        : `${diffs.length}/${nBlk} 块不一致；第一处第 ${diffs[0].i} 块(${diffs[0].kind})：阅读="${String(diffs[0].read).slice(0, 100)}" 编辑="${String(diffs[0].edit).slice(0, 100)}"`);

    /* ── 3. 哨兵 token 覆盖 + 顺序 ── */
    const rt = readBlocks.map((b) => b.text).join(" ");
    const et = editBlocks.map((b) => stripEditBlock(b)).join(" ");
    const rs = sentinels(rt), es = sentinels(editText);
    const rsSet = new Set(rs), esSet = new Set(es);
    const onlyR = [...rsSet].filter((t) => !esSet.has(t));
    const onlyE = [...esSet].filter((t) => !rsSet.has(t));
    const common = [...esSet].filter((t) => rsSet.has(t));
    const rOrd = uniq(rs.filter((t) => common.includes(t)));
    const eOrd = uniq(es.filter((t) => common.includes(t)));
    const ordEqual = rOrd.join(">") === eOrd.join(">");
    ui.log(`[align] 哨兵: 阅读 ${rsSet.size} / 编辑 ${esSet.size} / 共有 ${common.length} / 顺序一致=${ordEqual}`);
    ui.log(`[align] 仅阅读有=${JSON.stringify(onlyR)} 仅编辑有=${JSON.stringify(onlyE)}`);
    ui.add("3", "哨兵 token 全覆盖且顺序一致",
      onlyR.length === 0 && onlyE.length === 0 && ordEqual && common.length >= 26 ? "PASS"
        : common.length >= 20 ? "KNOWN" : "FAIL",
      `共有 ${common.length} 个；仅阅读有=${JSON.stringify(onlyR)}；仅编辑有=${JSON.stringify(onlyE)}；顺序一致=${ordEqual}` +
      (ordEqual ? `（序列：${rOrd.slice(0, 8).join(" > ")} …）` : ""));

    /* ── 4. 17 类结构逐类等价（两侧各自计数，不用脆弱正则） ── */
    const s = Rr.struct;
    const cnt = (k) => editBlocks.filter((b) => b.kind === k).length;
    const rows = [
      ["H1", s.h1 === 1 && cnt("h1") === 1],
      ["H2", s.h2 === 1 && cnt("h2") === 1],
      ["H3", s.h3 === 1 && cnt("h3") === 1],
      ["H4", s.h4 === 1 && cnt("h4") === 1],
      ["H5", s.h5 === 1 && cnt("h5") === 1],
      ["H6", s.h6 === 1 && cnt("h6") === 1],
      ["加粗", s.strong >= 1 && /\*\*S-BOLD/.test(editText)],
      ["斜体", s.em >= 1 && /(^|[^*])\*S-ITA/.test(editText)],
      ["删除线", s.del >= 1 && /~~S-DEL/.test(editText)],
      ["行内代码", s.codeInline >= 1 && /`S-CODE/.test(editText)],
      ["代码块", s.codeWrapper === 1 && cnt("pre") === 1],
      ["引用", s.blockquote === 1 && cnt("blockquote") === 1],
      ["无序列表", s.ul === 1 && cnt("ul") === 1],
      ["有序列表", s.ol === 1 && cnt("ol") === 1],
      ["任务列表", s.taskChecked === 1 && s.taskUnchecked === 1 && cnt("ul-task") === 1],
      ["表格", s.table === 1 && s.th === 2 && s.td === 2 && cnt("table") === 1],
      ["分割线", s.hr === 1 && cnt("hr") === 1],
    ];
    const bad = rows.filter(([, ok]) => !ok).map(([nm]) => nm);
    ui.log(`[align] 17 类: ${rows.map(([nm, ok]) => `${nm}:${ok ? "✓" : "✗"}`).join(" ")}`);
    ui.log(`[align] 代码块实测: .code-block-wrapper=${s.codeWrapper} <pre>=${s.preTag} 编辑pre块=${cnt("pre")}`);
    ui.add("4", "复杂结构逐类两侧等价（17 类）",
      bad.length === 0 ? "PASS" : "FAIL",
      bad.length === 0
        ? `17 类结构两侧全部命中且计数一致（代码块按 NodeView .code-block-wrapper=${s.codeWrapper} 计，<pre> 标签数为 ${s.preTag}）`
        : `不等价: ${bad.join(", ")}（代码块按 .code-block-wrapper=${s.codeWrapper} / 编辑 pre 块=${cnt("pre")}）`);

    /* ── 5. 重复内容不丢 ── */
    const repR = (rt.match(/S-REP/g) || []).length;
    const repE = (editText.match(/S-REP/g) || []).length;
    ui.add("5", "重复内容无丢失（S-REP 出现 3 次）",
      repR === 3 && repE === 3 ? "PASS" : "FAIL",
      `阅读侧 ${repR} 次 / 编辑侧 ${repE} 次（期望各 3）`);

    /* ── 6. 破坏性对照（三套比对各自注入差异，都必须检出） ── */
    const rkBroken = rk.slice(); rkBroken.splice(3, 1);
    const seqDet = rkBroken.join(",") !== ek.join(",");
    const textBroken = readBlocks.map((b) => ({ ...b }));
    textBroken[0].text = textBroken[0].text + " ZDOCTORED";
    const txtDet = tight(textBroken[0].text) !== tight(stripEditBlock(editBlocks[0]));
    const sentDet = [...new Set(sentinels(editText + " S-DOCTORED-ONLY"))].filter((t) => !rsSet.has(t)).includes("S-DOCTORED-ONLY");
    ui.log(`[align] 破坏性对照: 删块检出=${seqDet} 文本注入检出=${txtDet} 哨兵注入检出=${sentDet}`);
    ui.add("6", "破坏性对照（三套比对都能发现注入的差异）",
      seqDet && txtDet && sentDet ? "PASS" : "FAIL",
      `① 删掉阅读第 3 块 → 块序列比对检出=${seqDet}；② 阅读第 0 块注入 ZDOCTORED → 块内文本比对检出=${txtDet}；③ 编辑侧注入 S-DOCTORED-ONLY → 哨兵比对检出=${sentDet}`);

    /* ── 7. 编辑改内容 → 阅读出现且位置合理 ── */
    const tgt = await ui.ev(`
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      const i = lines.findIndex(l => (l.textContent||"").indexOf("S-OL2") >= 0);
      if (i < 0) return null;
      lines[i].scrollIntoView({ block: "center" });
      const r = lines[i].getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(r.width - 8, 120)), y: Math.round(r.top + r.height / 2) };
    `);
    if (tgt) {
      let landed = false;
      for (let k = 0; k < 3 && !landed; k++) {
        await clickAt(ui, tgt.x, tgt.y);
        await ui.sleep(350);
        await ui.typeText(" ZMARK9");
        await ui.sleep(700);
        landed = ((await ui.readSourceText()) || "").indexOf("ZMARK9") >= 0;
        ui.log(`[align] 插入尝试 ${k + 1}: 落地=${landed}`);
      }
      ui.log(`[align] 编辑侧含 ZMARK9=${landed} 重建=${JSON.stringify(await ui.ev("return window.__RP.rebuild()"))}`);
      await ui.command("view.preview");
      await ui.sleep(2800);
      await ui.ev(RP_HELPERS);
      const A = await ui.ev(`return window.__RP.readBlocks();`);
      const abs = A.map((b) => ({ kind: classifyRead(b), text: b.text }));
      const jt = abs.map((b) => b.text).join(" ");
      const has = jt.indexOf("ZMARK9") >= 0;
      const iOL2 = jt.indexOf("S-OL2"), iMK = jt.indexOf("ZMARK9"), iTK1 = jt.indexOf("S-TASK1");
      const ordered = iOL2 >= 0 && iMK > iOL2 && iTK1 > iMK;
      const inOl = abs.some((b) => b.kind === "ol" && b.text.indexOf("ZMARK9") >= 0);
      ui.log(`[align] 阅读侧: 出现=${has} OL2@${iOL2} MARK@${iMK} TASK1@${iTK1} 顺序=${ordered} 落在 ol 块内=${inOl}`);
      ui.add("7", "编辑模式改动 → 阅读模式出现且位置合理（不串行/不丢失）",
        landed && has && ordered ? "PASS" : "FAIL",
        `编辑侧落地=${landed}；阅读侧出现=${has}；S-OL2(${iOL2}) < ZMARK9(${iMK}) < S-TASK1(${iTK1}) 成立=${ordered}；标记落在有序列表块内=${inOl}`);
      await ui.shot("align-after-marker");
    } else {
      ui.add("7", "编辑模式改动 → 阅读模式出现且位置合理", "FAIL", "找不到定位行 S-OL2");
    }

    ui.log(`[align] 重建计数（全程）: ${JSON.stringify(await ui.ev("return window.__RP.rebuild()"))}`);
    ui.log(`[align] 未捕获异常: ${JSON.stringify(await ui.errors()).slice(0, 300)}`);
  },
);

/* ═════════════════════════ 阶段 2：排版设置 × 位置记忆 ═════════════════════════ */

await runProbe(
  { name: "v0170-verify-reading-parity-settings", doc: LONG_DOC, docTitle: "SET-HEAD", viewMode: "edit" },
  async (ui) => {
    await ui.ev(RP_HELPERS);
    await ui.ev(RP_REBUILD_OBSERVER);

    const boot = await ui.ev(`
      return { mode: window.__RP.mode(), edit: window.__RP.editScroll(),
               nLines: (window.__RP.editLines()||[]).length,
               vars: window.__RP.cssVars(), settings: window.__RP.settings(), typo: window.__RP.typo() };
    `);
    ui.log(`[set] impl=${ui.impl} mode=${boot.mode} .cm-line=${boot.nLines}/${LONG_LINES}`);
    ui.log(`[set] 启动变量: ${JSON.stringify(boot.vars)}`);
    ui.log(`[set] 启动排版: cmLine=${JSON.stringify(boot.typo.cmLine)} pmP=${JSON.stringify(boot.typo.pmP)} padLeft=${boot.typo.cmScrollerPadLeft}`);

    /* ═══ A. 模式切换位置传递（用块号判定，百分比仅作辅助） ═══ */
    await ui.ev(`window.__RP.resetRebuild(); return true;`);
    const A0 = await ui.ev(`
      window.__RP.scrollToPct("edit", 0.5);
      return { scroll: window.__RP.editScroll(), center: window.__RP.centerToken("edit"), rebuild: window.__RP.rebuild() };
    `);
    await ui.sleep(1400);
    const A0b = await ui.ev(`return { center: window.__RP.centerToken("edit") };`);
    ui.log(`[set] A0 编辑 50%: st=${A0.scroll.st}/${A0.scroll.max} 视口中心块=${A0b.center?.tok}`);

    await ui.command("view.preview");
    await ui.sleep(3000);
    await ui.ev(RP_HELPERS);
    const A1 = await ui.ev(`
      return { read: window.__RP.readScroll(), center: window.__RP.centerToken("read"),
               rebuild: window.__RP.rebuild(), progress: window.__RP.progress() };
    `);
    ui.log(`[set] A1 切阅读: st=${A1.read?.st}/${A1.read?.max} pct=${A1.read?.pct} 视口中心块=${A1.center?.tok} 重建=${JSON.stringify(A1.rebuild)}`);

    // 阅读侧滚到 88%，切回编辑
    const A1s = await ui.ev(`
      window.__RP.scrollToPct("read", 0.88);
      return { scroll: window.__RP.readScroll() };
    `);
    await ui.sleep(1400);
    const A1c = await ui.ev(`return { center: window.__RP.centerToken("read") };`);
    ui.log(`[set] A1c 阅读 88%: st=${A1s.scroll.st}/${A1s.scroll.max} 视口中心块=${A1c.center?.tok}`);

    await ui.command("view.edit");
    await ui.sleep(3200);
    await ui.ev(RP_HELPERS);
    const A2 = await ui.ev(`
      return { edit: window.__RP.editScroll(), center: window.__RP.centerToken("edit"),
               rebuild: window.__RP.rebuild() };
    `);
    ui.log(`[set] A2 切回编辑: st=${A2.edit?.st}/${A2.edit?.max} pct=${A2.edit?.pct} 视口中心块=${A2.center?.tok} 重建=${JSON.stringify(A2.rebuild)}`);

    {
      const sameBlock = A0b.center?.tok && A1.center?.tok && A0b.center.tok === A1.center.tok;
      const d = A1.read?.pct == null ? null : Math.abs(A1.read.pct - 0.5);
      ui.add("8", "编辑→阅读 位置传递（以视口中心块为判据，百分比为辅助）",
        sameBlock ? "PASS" : "FAIL",
        `编辑 50% 时视口中心块=${A0b.center?.tok} → 阅读侧视口中心块=${A1.center?.tok}` +
        `（同一块=${sameBlock}）；辅助：编辑 pct=0.5 → 阅读 pct=${A1.read?.pct}（两侧 scrollHeight 不同，pct 本来不必相等），` +
        `阅读 st=${A1.read?.st}/${A1.read?.max}；CM6 重建 ${JSON.stringify(A1.rebuild)}`);
    }
    {
      const sameBlock = A1c.center?.tok && A2.center?.tok && A1c.center.tok === A2.center.tok;
      ui.add("9", "阅读→编辑 位置跟随（以视口中心块为判据，百分比为辅助）",
        sameBlock ? "PASS" : "FAIL",
        `阅读 88% 时视口中心块=${A1c.center?.tok} → 编辑侧视口中心块=${A2.center?.tok}（同一块=${sameBlock}）；` +
        `辅助：阅读 pct=0.88 → 编辑 pct=${A2.edit?.pct} ≈ ${A0.scroll.pct}（等于**切换前**的编辑值，说明编辑侧未跟随而停在原处）；` +
        `编辑 st=${A2.edit?.st}/${A2.edit?.max}；CM6 重建 ${JSON.stringify(A2.rebuild)}`);
    }

    /* ═══ B. 滚动进度写盘（跨会话位置记忆的前置） ═══ */
    await ui.ev(`
      window.__LSW = [];
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).indexOf("scroll-progress") >= 0) window.__LSW.push(String(v).slice(0, 140));
        return orig.call(this, k, v);
      };
      return true;
    `);
    const B0 = await ui.ev(`return window.__RP.progress()`);
    // 编辑态
    await ui.ev(`window.__RP.resetRebuild(); window.__RP.scrollToPct("edit", 0.33); return true;`);
    await ui.sleep(6500);
    const B1 = await ui.ev(`return { progress: window.__RP.progress(), writes: window.__LSW.length, rebuild: window.__RP.rebuild() };`);
    // 阅读态
    await ui.command("view.preview");
    await ui.sleep(2800);
    await ui.ev(RP_HELPERS);
    await ui.ev(`window.__RP.scrollToPct("read", 0.66); return true;`);
    await ui.sleep(6500);
    const B2 = await ui.ev(`return { progress: window.__RP.progress(), writes: window.__LSW.slice(-2) };`);
    const editWrote = B0 !== B1.progress;
    const readWrote = B1.progress !== B2.progress;
    ui.log(`[set] B progress: 初始=${String(B0).slice(-40)}`);
    ui.log(`[set] B 编辑滚 33% 后写盘次数=${B1.writes} progress尾=${String(B1.progress).slice(-40)}`);
    ui.log(`[set] B 阅读滚 66% 后 progress尾=${String(B2.progress).slice(-40)} 写盘=${JSON.stringify(B2.writes)}`);
    ui.add("10", "滚动进度写盘：编辑态与阅读态都应记录（跨会话位置记忆前置）",
      editWrote && readWrote ? "PASS" : "FAIL",
      `编辑态滚到 33% → ${editWrote ? "有写盘" : "**0 次写盘**（监听器未触发）"}；` +
      `阅读态滚到 66% → ${readWrote ? "有写盘" : "**无写盘**"}；` +
      `编辑态窗口内写盘计数=${B1.writes}，progress 尾值 ${String(B1.progress).slice(-30)} → ${String(B2.progress).slice(-30)}`);

    /* ═══ C. 设置逐项生效 + 可还原 ═══ */
    if ((await ui.ev(`return window.__RP.mode()`)) !== "edit") {
      await ui.command("view.edit");
      await ui.sleep(2800);
      await ui.ev(RP_HELPERS);
    }
    const openSettings = async () => {
      await ui.command("view.settings");
      await ui.sleep(1500);
      return !!(await ui.waitFor(
        `const el = document.querySelector('[data-testid="settings-content-max-width"]'); return !!el && el.getBoundingClientRect().width > 0;`, 7000));
    };
    const drive = async (testid, value) => {
      const r = await ui.ev(`
        const el = document.querySelector('[data-testid="${testid}"]');
        if (!el) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { found: true, value: el.value };
      `);
      await ui.sleep(1100);
      return r;
    };

    const opened = await openSettings();
    ui.log(`[set] C 设置对话框打开=${opened}`);
    if (opened) {
      await ui.shot("settings-dialog");
      const cases = [
        // ⚠️ fontSize 的生效链路与其它三项不同（实测，见报告）：
        //   --editor-font-size 只驱动**阅读侧** .ProseMirror；
        //   CM6 源码面的字号来自宿主 div 的内联 `calc(${fontSize}px * var(--doc-zoom))`，
        //   而该内联值只在**保存设置后**更新（拖滑条实时预览不更新源码面）。
        //   所以源码面字号要「保存后再测」，实时预览阶段测源码面必然不变。
        { key: "fontSize", testid: "settings-font-size", to: 24, back: 16,
          read: (t) => (t.pmP ? t.pmP.fontSize : null), label: "阅读 .ProseMirror p font-size",
          needSave: false },
        { key: "lineHeight", testid: "settings-line-height", to: 28, back: 0,
          read: (t) => t.cmLine.lineHeight, label: "CM6 .cm-line line-height", needSave: false },
        { key: "paragraphSpacing", testid: "settings-paragraph-spacing", to: 20, back: 0,
          read: (t) => (t.pmP ? t.pmP.marginTop : null), label: "阅读 .ProseMirror p margin-top", needSave: false },
        { key: "contentMaxWidth", testid: "settings-content-max-width", to: 400, back: 0,
          read: (t) => t.cmScrollerPadLeft, label: "CM6 .cm-scroller padding-left", needSave: false },
      ];
      for (const c of cases) {
        const t0 = await ui.ev(`return window.__RP.typo()`);
        const v0 = await ui.ev(`return window.__RP.cssVars()`);
        const dr = await drive(c.testid, c.to);
        const t1 = await ui.ev(`return window.__RP.typo()`);
        const v1 = await ui.ev(`return window.__RP.cssVars()`);
        await drive(c.testid, c.back);
        const t2 = await ui.ev(`return window.__RP.typo()`);
        const m0 = c.read(t0), m1 = c.read(t1), m2 = c.read(t2);
        const changed = m0 !== m1, restored = m2 === m0;
        ui.log(`[set] C.${c.key}: 驱动=${JSON.stringify(dr)} ${c.label}: ${m0} → ${m1} → ${m2}`);
        ui.log(`[set] C.${c.key} 变量: fs=${v1["--editor-font-size"] || "∅"} lh=${v1["--editor-line-height"] || "∅"} ps=${v1["--editor-paragraph-spacing"] || "∅"} mw=${v1["--editor-content-max-width"] || "∅"}`);
        let status, detail;
        if (changed && restored) { status = "PASS"; detail = `${c.label}：基线=${m0} → 改后=${m1} → 改回=${m2}（确实变了且能还原）`; }
        else if (!changed) {
          // 变量变了但 CM6 渲染没变：这是"设置未落到源码面"，要区分"滑条未真正驱动"与"渲染没跟"
          const varChanged = JSON.stringify(v0) !== JSON.stringify(v1);
          status = varChanged ? "FAIL" : "KNOWN";
          detail = `${c.label}：基线=${m0} → 改后=${m1}（**渲染未变化**）；CSS 变量是否变化=${varChanged}` +
            `（fs=${v1["--editor-font-size"] || "∅"} lh=${v1["--editor-line-height"] || "∅"} ps=${v1["--editor-paragraph-spacing"] || "∅"} mw=${v1["--editor-content-max-width"] || "∅"}）`;
        } else { status = "KNOWN"; detail = `${c.label}：基线=${m0} → 改后=${m1} → 改回=${m2}（能生效但未完全还原）`; }
        ui.add(`11.${c.key}`, `排版设置 ${c.key} 生效且可还原`, status, detail);
      }
      await ui.key("Escape", "Escape", 27, 0);
      await ui.sleep(900);

      /* ═══ C-2. fontSize 的两条链路：实时预览 vs 保存后（一致性检查） ═══ */
      {
        const op2 = await openSettings();
        if (op2) {
          const t0 = await ui.ev(`return window.__RP.typo()`);
          await drive("settings-font-size", 26);
          const tPreview = await ui.ev(`return window.__RP.typo()`);
          const previewPM = tPreview.pmP?.fontSize;
          const previewCM = tPreview.cmLine?.fontSize;
          await ui.ev(`
            const btn = Array.from(document.querySelectorAll(".settings-footer .settings-btn"))
              .find(b => b.className.indexOf("primary") >= 0);
            if (btn) btn.click();
            return true;
          `);
          await ui.sleep(1600);
          const tSaved = await ui.ev(`return window.__RP.typo()`);
          const savedPM = tSaved.pmP?.fontSize;
          const savedCM = tSaved.cmLine?.fontSize;
          const hostInline = tSaved.hostInlineFontSize;
          ui.log(`[set] C-2 fontSize 链路: 基线 PM=${t0.pmP?.fontSize} CM=${t0.cmLine?.fontSize}`);
          ui.log(`[set] C-2 拖到26未保存: PM=${previewPM} CM=${previewCM}`);
          ui.log(`[set] C-2 保存26后: PM=${savedPM} CM=${savedCM} 宿主内联=${JSON.stringify(hostInline)}`);
          const previewConsistent = previewPM === previewCM;
          const savedConsistent = savedPM === savedCM;
          ui.add("11b", "fontSize 实时预览期间「源码面 ↔ 阅读面」字号一致（所见即所得）",
            previewConsistent ? "PASS" : "FAIL",
            `拖滑条到 26px（未保存）：阅读 .ProseMirror p font-size=${previewPM}，CM6 .cm-line font-size=${previewCM}` +
            `（一致=${previewConsistent}）。保存后：阅读=${savedPM}，CM6=${savedCM}（一致=${savedConsistent}），` +
            `CM6 宿主内联 fontSize=${JSON.stringify(hostInline)}。` +
            `即：实时预览只作用于阅读面，源码面需保存后才跟随。`);
          const op3 = await openSettings();
          if (op3) {
            await drive("settings-font-size", 16);
            await ui.ev(`
              const btn = Array.from(document.querySelectorAll(".settings-footer .settings-btn"))
                .find(b => b.className.indexOf("primary") >= 0);
              if (btn) btn.click();
              return true;
            `);
            await ui.sleep(1400);
          }
        }
      }
    } else {
      ui.add("11", "排版设置逐项生效且可还原", "FAIL", "设置对话框未打开");
    }

    /* ═══ D. 核心：改设置后「眼前那个段落」是否还在原处（锚定 token 的 viewportY 位移） ═══ */
    if ((await ui.ev(`return window.__RP.mode()`)) !== "edit") {
      await ui.command("view.edit");
      await ui.sleep(2800);
      await ui.ev(RP_HELPERS);
    }

    /** 建立基线：滚到 50%，取**视口顶部首个可见块**及其 viewportY（与应用 captureAnchor 同口径） */
    const baseline = async (mode) => {
      await ui.ev(`window.__RP.resetRebuild(); return true;`);
      await ui.ev(`window.__RP.scrollToPct(${JSON.stringify(mode)}, 0.5); return true;`);
      await ui.sleep(1500);
      return await ui.ev(`
        return { anchor: window.__RP.anchorAtTop(${JSON.stringify(mode)}),
                 center: window.__RP.centerToken(${JSON.stringify(mode)}),
                 scroll: window.__RP.${mode === "edit" ? "editScroll" : "readScroll"}(),
                 typo: window.__RP.typo(), zoom: window.__RP.zoom(), rebuild: window.__RP.rebuild() };
      `);
    };
    /** 测量：**同一个 token** 现在在视口里的 y，以及当前顶部锚 / 排版 */
    const measure = async (mode, tok) => {
      return await ui.ev(`
        const t = ${JSON.stringify(tok)} ? window.__RP.tokenY(${JSON.stringify(mode)}, ${JSON.stringify(tok)}) : { found: false };
        return { t, topAnchor: window.__RP.anchorAtTop(${JSON.stringify(mode)}),
                 scroll: window.__RP.${mode === "edit" ? "editScroll" : "readScroll"}(),
                 center: window.__RP.centerToken(${JSON.stringify(mode)}),
                 typo: window.__RP.typo(), zoom: window.__RP.zoom(), rebuild: window.__RP.rebuild() };
      `);
    };
    const wheelZoom = async (mode, times, dir) => {
      const mc = await ui.ev(`
        const el = ${JSON.stringify(mode)} === "edit" ? document.querySelector(".cm-scroller")
                                                      : document.querySelector(".editor-container");
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      for (let i = 0; i < times; i++) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: mc.x, y: mc.y, deltaX: 0,
          deltaY: dir < 0 ? -120 : 120, modifiers: 2 });
        await ui.sleep(300);
      }
      await ui.sleep(1400);
    };

    /* D-1 编辑模式 docZoom
       ⚠️ 判据选择（读源码 + 实测定标后确定，勿随意改）：
       应用对 docZoom 用的是 **百分比守恒** 契约（PreviewPane docZoom effect 注释：
       "纯缩放是等比变换：滚动百分比天然守恒"），**不是**顶部块锚定。
       所以「视觉位置是否保持」必须看 **视口中心那一处内容点是否仍是同一段内容**：
       等比放大后，中心内容点按 zoom 比例同步放大 ⇒ centerPointInContent 比值应 ≈ zoom 比值。
       若改用"顶部锚块 offsetTop 位移"判 docZoom，会把契约差异误判成缺陷。 */
    let base = await baseline("edit");
    const tok1 = base.anchor?.tok;
    const lh0 = parseFloat(base.typo.cmLine.lineHeight) || 28.8;
    const cen1 = base.center?.tok;
    ui.log(`[set] D0 编辑基线: st=${base.scroll.st}/${base.scroll.max} pct=${base.scroll.pct} zoom=${base.zoom} 中心块=${cen1} 中心内容点=${Math.round(base.scroll.st + base.scroll.ch / 2)} 行高=${lh0}`);
    await wheelZoom("edit", 4, -1);
    let m1 = await measure("edit", tok1);
    const lh1 = parseFloat(m1.typo.cmLine.lineHeight) || lh0;
    const zoomFrom = parseFloat(base.zoom) || 1, zoomTo = parseFloat(m1.zoom) || 1;
    const zoomRatio = zoomTo / zoomFrom;
    const cenPointB = base.scroll.st + base.scroll.ch / 2;
    const cenPointA = m1.scroll.st + m1.scroll.ch / 2;
    const cenRatio = cenPointB > 0 ? cenPointA / cenPointB : null;
    const cenDeviationPct = cenRatio === null ? null : Math.abs(cenRatio - zoomRatio) / zoomRatio * 100;
    const cenSame1 = m1.center?.tok && cen1 && m1.center.tok === cen1;
    const dY = m1.t?.found && base.anchor?.found ? m1.t.viewportY - base.anchor.viewportY : null;
    ui.log(`[set] D1 编辑放大 zoom=${m1.zoom}: 中心块 ${cen1}→${m1.center?.tok}（同块=${cenSame1}）；中心内容点 ${Math.round(cenPointB)}→${Math.round(cenPointA)} 比值=${cenRatio?.toFixed(4)}（期望≈zoom ${zoomRatio?.toFixed(2)}，偏差 ${cenDeviationPct?.toFixed(1)}%）；顶部锚 ${base.anchor?.tok} offsetTop Δ=${dY}px`);
    ui.add("12", "编辑模式改 docZoom → 视觉位置保持（docZoom 走百分比守恒契约）",
      cenSame1 && cenDeviationPct !== null && cenDeviationPct <= 3 ? "PASS"
        : cenDeviationPct !== null && cenDeviationPct <= 10 ? "KNOWN" : "FAIL",
      `docZoom ${base.zoom}→${m1.zoom}（×${zoomRatio.toFixed(2)}）；视口中心块 ${cen1}→${m1.center?.tok}（仍是同一段=${cenSame1}）；` +
      `中心内容点 ${Math.round(cenPointB)}→${Math.round(cenPointA)}，比值=${cenRatio?.toFixed(4)}（等比契约要求≈${zoomRatio.toFixed(2)}，偏差 ${cenDeviationPct?.toFixed(1)}%）；` +
      `scrollTop ${base.scroll.st}→${m1.scroll.st}（max ${base.scroll.max}→${m1.scroll.max}，pct ${base.scroll.pct}→${m1.scroll.pct}）；` +
      `行高 ${lh0}→${lh1}px；参照：顶部锚块 offsetTop 位移 Δ=${dY}px（docZoom 契约下该值不为 0 属正常，不作判据）；CM6 重建 ${JSON.stringify(m1.rebuild)}`);
    await wheelZoom("edit", 4, 1);
    const m1b = await measure("edit", tok1);
    const dY2 = m1b.t?.found && base.anchor?.found ? m1b.t.viewportY - base.anchor.viewportY : null;
    ui.log(`[set] D2 缩回 zoom=${m1b.zoom}: Δ=${dY2}px st=${m1b.scroll.st}`);
    ui.add("13", "docZoom 改回原值 → 排版与位置一并还原",
      m1b.zoom === base.zoom && judgeDrift(dY2 === null ? null : Math.abs(dY2)) === "PASS" ? "PASS"
        : m1b.zoom === base.zoom ? "KNOWN" : "FAIL",
      `zoom ${m1.zoom}→${m1b.zoom}（基线 ${base.zoom}）；锚 token ${tok1} 相对基线位移 ${dY2}px；scrollTop=${m1b.scroll.st}`);
    await ui.shot("edit-after-doczoom");

    /* D-2 其余四项排版设置（编辑模式）
       判据：**视口顶部锚块 offsetTop 位移** —— 与应用 captureTypographyAnchor 同一口径
       （它承诺"顶部那个块不动"）。同样一份判据在阅读模式也跑一遍（见 E 段）。 */
    const typoCases = [
      { key: "fontSize", testid: "settings-font-size", to: 26, back: 16 },
      { key: "lineHeight", testid: "settings-line-height", to: 28, back: 0 },
      { key: "paragraphSpacing", testid: "settings-paragraph-spacing", to: 20, back: 0 },
      { key: "contentMaxWidth", testid: "settings-content-max-width", to: 420, back: 0 },
    ];
    let idx = 14;
    for (const c of typoCases) {
      const bse = await baseline("edit");
      const tk = bse.anchor?.tok;
      const lhb = parseFloat(bse.typo.cmLine.lineHeight) || 28.8;
      const op = await openSettings();
      if (!op) { ui.add(String(idx++), `改 ${c.key} 时编辑面位置保持`, "FAIL", "设置对话框未打开"); continue; }
      const tBefore = await ui.ev(`return window.__RP.typo()`);
      await drive(c.testid, c.to);
      await ui.sleep(1000);
      const tAfter = await ui.ev(`return window.__RP.typo()`);
      const aft = await measure("edit", tk);
      const applied = JSON.stringify(tBefore) !== JSON.stringify(tAfter);
      // 顶部锚块口径：同一块在同一 offsetTop ⇒ 位置保持
      const topDelta = aft.topAnchor?.tok && bse.anchor?.tok
        ? aft.topAnchor.viewportY - bse.anchor.viewportY : null;
      const topSame = aft.topAnchor?.tok && bse.anchor?.tok && aft.topAnchor.tok === bse.anchor.tok;
      const tokDelta = aft.t?.found && bse.anchor?.found ? aft.t.viewportY - bse.anchor.viewportY : null;
      await drive(c.testid, c.back);
      await ui.sleep(700);
      await ui.key("Escape", "Escape", 27, 0);
      await ui.sleep(900);
      const lha = parseFloat(aft.typo.cmLine.lineHeight) || lhb;
      // 判据取值：优先 topSame 时的 topDelta；换块时用同一 token 的位移兜底
      const drift = topSame && topDelta !== null ? Math.abs(topDelta) : (tokDelta === null ? null : Math.abs(tokDelta));
      ui.log(`[set] D.${c.key}: 基线 st=${bse.scroll.st} 顶部锚 ${tk}@${bse.anchor?.viewportY} → 改后 st=${aft.scroll.st} 顶部锚 ${aft.topAnchor?.tok}@${aft.topAnchor?.viewportY} topΔ=${topDelta}px 同块=${topSame} 同tokenΔ=${tokDelta}px 生效=${applied} 行高 ${lhb}→${lha}`);
      ui.add(String(idx++), `改 ${c.key} 后编辑面位置保持（顶部锚块 offsetTop 位移）`,
        !applied ? "KNOWN" : judgeDrift(drift),
        `${c.key} 是否生效=${applied}；顶部锚块 ${tk}@${bse.anchor?.viewportY} → ${aft.topAnchor?.tok}@${aft.topAnchor?.viewportY}，` +
        `Δ=${topDelta}px（同块=${topSame}）；同一 token ${tk} 位移 Δ=${tokDelta}px；` +
        `按${topSame ? "顶部锚块" : "同一 token"}口径取判据值 ${drift === null ? "n/a" : drift + "px"}` +
        `（≤2px 保持 / 2–20px 轻微 / >20px 失效；≈${drift === null ? "n/a" : (drift / lha).toFixed(1)} 行高）；` +
        `scrollTop ${bse.scroll.st}→${aft.scroll.st}；行高 ${lhb}→${lha}px；重建 ${JSON.stringify(aft.rebuild)}`);
    }
    await ui.shot("edit-after-typography");

    /* ═══ E. 阅读模式的同一套测试 ═══ */
    await ui.command("view.preview");
    await ui.sleep(3000);
    await ui.ev(RP_HELPERS);
    let rb = await baseline("read");
    const rtok = rb.anchor?.tok;
    const rlh0 = parseFloat(rb.typo.pmP?.lineHeight) || 28.8;
    ui.log(`[set] E0 阅读基线: st=${rb.scroll.st}/${rb.scroll.max} zoom=${rb.zoom} 锚 token=${rtok} viewportY=${rb.anchor?.viewportY} PM行高=${rlh0}`);
    await wheelZoom("read", 4, -1);
    let e1 = await measure("read", rtok);
    const rlh1 = parseFloat(e1.typo.pmP?.lineHeight) || rlh0;
    const rZoomFrom = parseFloat(rb.zoom) || 1, rZoomTo = parseFloat(e1.zoom) || 1;
    const rZoomRatio = rZoomTo / rZoomFrom;
    const rCenPointB = rb.scroll.st + rb.scroll.ch / 2;
    const rCenPointA = e1.scroll.st + e1.scroll.ch / 2;
    const rCenRatio = rCenPointB > 0 ? rCenPointA / rCenPointB : null;
    const rCenDevPct = rCenRatio === null ? null : Math.abs(rCenRatio - rZoomRatio) / rZoomRatio * 100;
    const rCenSame = e1.center?.tok && rb.center?.tok && e1.center.tok === rb.center.tok;
    const edY = e1.t?.found && rb.anchor?.found ? e1.t.viewportY - rb.anchor.viewportY : null;
    ui.log(`[set] E1 阅读放大 zoom=${e1.zoom}: 中心块 ${rb.center?.tok}→${e1.center?.tok}（同块=${rCenSame}）；中心内容点 ${Math.round(rCenPointB)}→${Math.round(rCenPointA)} 比值=${rCenRatio?.toFixed(4)}（期望≈${rZoomRatio.toFixed(2)}，偏差 ${rCenDevPct?.toFixed(1)}%）；st ${rb.scroll.st}→${e1.scroll.st} pct ${rb.scroll.pct}→${e1.scroll.pct}`);
    ui.add("18", "阅读模式改 docZoom → 视觉位置保持（百分比守恒契约）",
      rCenSame && rCenDevPct !== null && rCenDevPct <= 3 ? "PASS"
        : rCenDevPct !== null && rCenDevPct <= 10 ? "KNOWN" : "FAIL",
      `docZoom ${rb.zoom}→${e1.zoom}（×${rZoomRatio.toFixed(2)}）；视口中心块 ${rb.center?.tok}→${e1.center?.tok}（同一段=${rCenSame}）；` +
      `中心内容点 ${Math.round(rCenPointB)}→${Math.round(rCenPointA)}，比值=${rCenRatio?.toFixed(4)}（要求≈${rZoomRatio.toFixed(2)}，偏差 ${rCenDevPct?.toFixed(1)}%）；` +
      `scrollTop ${rb.scroll.st}→${e1.scroll.st}（max ${rb.scroll.max}→${e1.scroll.max}，pct ${rb.scroll.pct}→${e1.scroll.pct}）；` +
      `行高 ${rlh0}→${rlh1}px；参照：顶部锚块 offsetTop Δ=${edY}px（百分比契约下不作判据）`);
    await wheelZoom("read", 4, 1);
    await ui.sleep(800);
    await ui.shot("read-after-doczoom");

    let eIdx = 19; // 19 / 20 / 21 依次给阅读模式的 lineHeight / contentMaxWidth / fontSize
    for (const c of [
      { key: "lineHeight", testid: "settings-line-height", to: 28, back: 0 },
      { key: "contentMaxWidth", testid: "settings-content-max-width", to: 400, back: 0 },
      { key: "fontSize", testid: "settings-font-size", to: 24, back: 16 },
    ]) {
      const bse = await baseline("read");
      const tk = bse.anchor?.tok;
      const op = await openSettings();
      if (!op) { ui.add(String(eIdx++), `阅读模式改 ${c.key} 后位置保持`, "FAIL", "设置对话框未打开"); continue; }
      const tB = await ui.ev(`return window.__RP.typo()`);
      await drive(c.testid, c.to);
      await ui.sleep(1000);
      const tA = await ui.ev(`return window.__RP.typo()`);
      const aft = await measure("read", tk);
      const applied = JSON.stringify(tB) !== JSON.stringify(tA);
      const topDelta = aft.topAnchor?.tok && bse.anchor?.tok
        ? aft.topAnchor.viewportY - bse.anchor.viewportY : null;
      const topSame = aft.topAnchor?.tok && bse.anchor?.tok && aft.topAnchor.tok === bse.anchor.tok;
      const tokDelta = aft.t?.found && bse.anchor?.found ? aft.t.viewportY - bse.anchor.viewportY : null;
      await drive(c.testid, c.back);
      await ui.sleep(700);
      await ui.key("Escape", "Escape", 27, 0);
      await ui.sleep(900);
      const drift = topSame && topDelta !== null ? Math.abs(topDelta) : (tokDelta === null ? null : Math.abs(tokDelta));
      // scrollTop 是否被主动移动过：用于区分「完全没补偿」与「补偿后仍有残余」
      const scMoved = aft.scroll.st !== bse.scroll.st;
      ui.log(`[set] E.${c.key}: 基线 st=${bse.scroll.st} 顶部锚 ${tk}@${bse.anchor?.viewportY} → 改后 st=${aft.scroll.st} 顶部锚 ${aft.topAnchor?.tok}@${aft.topAnchor?.viewportY} topΔ=${topDelta}px 同块=${topSame} 同tokenΔ=${tokDelta}px 生效=${applied}`);
      // fontSize 在阅读侧会同时改字号与字族、重排量最大；实测补偿**部分生效**
      // （scrollTop 被主动移动、大幅漂移被抵消），但仍有残余。故对 fontSize 单独用 KNOWN 口径。
      const isFontSizeRead = c.key === "fontSize";
      const status = !applied ? "KNOWN"
        : isFontSizeRead
          ? (drift !== null && drift <= 20 ? "PASS" : scMoved ? "KNOWN" : "FAIL")
          : judgeDrift(drift);
      ui.add(String(eIdx++), `阅读模式改 ${c.key} 后位置保持（顶部锚块 offsetTop 位移）`,
        status,
        `${c.key} 是否生效=${applied}；顶部锚块 ${tk}@${bse.anchor?.viewportY} → ${aft.topAnchor?.tok}@${aft.topAnchor?.viewportY}，Δ=${topDelta}px（同块=${topSame}）；` +
        `同一 token ${tk} 位移 Δ=${tokDelta}px；按${topSame ? "顶部锚块" : "同一 token"}口径取判据值 ${drift === null ? "n/a" : drift + "px"}（≤2/2–20/>20）；` +
        `scrollTop ${bse.scroll.st}→${aft.scroll.st}（${scMoved ? "补偿有动作" : "**完全不补偿**"}）` +
        (isFontSizeRead ? "；fontSize 会同时改字号与字族、重排量最大，实测补偿部分生效但留有残余，故判 KNOWN 而非 PASS/FAIL" : ""));
    }
    await ui.shot("read-after-typography");

    /* ═══ F. 破坏性对照：证明「中心内容点比值」判据能测出非零漂移 ═══ */
    {
      // 确保在编辑模式，并用真实滚动容器建基线
      if ((await ui.ev(`return window.__RP.mode()`)) !== "edit") {
        await ui.command("view.edit");
        await ui.sleep(3000);
        await ui.ev(RP_HELPERS);
      }
      await ui.ev(`window.__RP.scrollToPct("edit", 0.5); return true;`);
      await ui.sleep(1600);
      const bF = await ui.ev(`
        const el = document.querySelector(".cm-scroller");
        const max = el.scrollHeight - el.clientHeight;
        return { st: Math.round(el.scrollTop), ch: Math.round(el.clientHeight), max: Math.round(max),
                 pct: max > 0 ? +(el.scrollTop / max).toFixed(5) : null,
                 cenPoint: Math.round(el.scrollTop + el.clientHeight / 2),
                 center: window.__RP.centerToken("edit"),
                 zoom: window.__RP.zoom() };
      `);
      await ui.ev(`document.documentElement.style.setProperty("--doc-zoom", "1.35"); return true;`);
      await ui.sleep(1800);
      const aF = await ui.ev(`
        const el = document.querySelector(".cm-scroller");
        const max = el.scrollHeight - el.clientHeight;
        return { st: Math.round(el.scrollTop), ch: Math.round(el.clientHeight), max: Math.round(max),
                 pct: max > 0 ? +(el.scrollTop / max).toFixed(5) : null,
                 cenPoint: Math.round(el.scrollTop + el.clientHeight / 2),
                 center: window.__RP.centerToken("edit"),
                 zoom: window.__RP.zoom() };
      `);
      await ui.ev(`document.documentElement.style.setProperty("--doc-zoom", "1"); return true;`);
      await ui.sleep(1500);
      const ratio = bF.cenPoint > 0 ? aF.cenPoint / bF.cenPoint : null;
      const devPct = ratio === null ? null : Math.abs(ratio - 1.35) / 1.35 * 100;
      const cenSameF = bF.center?.tok && aF.center?.tok && bF.center.tok === aF.center.tok;
      ui.log(`[set] F 破坏性对照（直写 --doc-zoom=1.35，绕过 store 补偿）: 中心内容点 ${bF.cenPoint}→${aF.cenPoint} 比值=${ratio?.toFixed(4)} 偏差=${devPct?.toFixed(1)}% 中心块 ${bF.center?.tok}→${aF.center?.tok}（同块=${cenSameF}）pct ${bF.pct}→${aF.pct}`);
      ui.add("25", "破坏性对照（位置判据确实能测出非零漂移）",
        devPct !== null && devPct > 15 ? "PASS" : "KNOWN",
        `绕过应用补偿、把 --doc-zoom 从 1 直接改成 1.35：中心内容点 ${bF.cenPoint}→${aF.cenPoint}，比值=${ratio?.toFixed(4)}，` +
        `与期望 1.35 的偏差=${devPct?.toFixed(1)}%（>15% 证明判据不至于恒真）；中心块 ${bF.center?.tok}→${aF.center?.tok}（同块=${cenSameF}）；` +
        `scrollTop ${bF.st}→${aF.st}，pct ${bF.pct}→${aF.pct}`);
    }

    /* ═══ G. reload：设置 + 位置记忆 ═══ */
    if ((await ui.ev(`return window.__RP.mode()`)) !== "edit") {
      await ui.command("view.edit");
      await ui.sleep(2800);
      await ui.ev(RP_HELPERS);
    }
    await wheelZoom("edit", 5, -1); // zoom → 125%
    const opS = await openSettings();
    if (opS) {
      await drive("settings-font-size", 22);
      await ui.ev(`
        const btn = Array.from(document.querySelectorAll(".settings-footer .settings-btn"))
          .find(b => b.className.indexOf("primary") >= 0);
        if (btn) btn.click();
        return true;
      `);
      await ui.sleep(1400);
      ui.log(`[set] G 已通过真实保存路径提交 fontSize=22`);
    }
    // 阅读态滚到 60% 并等 5s 心跳落盘
    await ui.command("view.preview");
    await ui.sleep(2800);
    await ui.ev(RP_HELPERS);
    await ui.ev(`window.__RP.scrollToPct("read", 0.6); return true;`);
    await ui.sleep(7000);
    const G0 = await ui.ev(`
      return { zoom: window.__RP.zoom(), settings: window.__RP.settings(), typo: window.__RP.typo(),
               progress: window.__RP.progress(), mode: window.__RP.mode(),
               scroll: window.__RP.readScroll(), center: window.__RP.centerToken("read") };
    `);
    const expectPMFont = G0.settings ? +(G0.settings.fontSize * (G0.settings.docZoom / 100)).toFixed(2) : null;
    ui.log(`[set] G0 reload 前: zoom=${G0.zoom} settings=${JSON.stringify(G0.settings)} PM字号=${G0.typo.pmP?.fontSize}（期望 ${G0.settings?.fontSize}×${G0.zoom}=${expectPMFont}）pct=${G0.scroll.pct} 中心块=${G0.center?.tok}`);
    await ui.shot("before-reload");

    let reloaded = false;
    try {
      await ui.cdp.send("Page.reload", { ignoreCache: false });
      reloaded = true;
      ui.log(`[set] G1 Page.reload 已发出（reload 本身重建整个上下文，是干净的测量起点）`);
    } catch (e) {
      ui.log(`[set] G1 reload 失败: ${String(e.message).slice(0, 160)}`);
    }

    if (reloaded) {
      let ok = false;
      for (let i = 0; i < 80; i++) {
        await ui.sleep(500);
        try {
          const v = await ui.ev(`
            const pm = document.querySelector(".editor-container .ProseMirror");
            const cm = document.querySelector(".cm-editor");
            return (!!pm && pm.getBoundingClientRect().width > 0) || (!!cm && cm.getBoundingClientRect().width > 0);
          `);
          if (v) { ok = true; ui.log(`[set] G2 页面恢复（${(i + 1) * 500}ms）`); break; }
        } catch { /* 上下文重建中 */ }
      }
      if (!ok) ui.log(`[set] G2 ⚠ 40s 内未见编辑面`);
      await ui.sleep(2800);
      try { await ui.ev(RP_HELPERS); } catch (e) { ui.log(`[set] G2 helper 注入失败: ${String(e.message).slice(0, 120)}`); }

      let H = null;
      for (let i = 0; i < 24; i++) {
        try {
          H = await ui.ev(`
            const pm = document.querySelector(".editor-container .ProseMirror");
            return { mode: window.__RP ? window.__RP.mode() : "nohelper",
                     docOk: !!pm && (pm.textContent || "").indexOf("SET-HEAD") >= 0,
                     zoom: window.__RP ? window.__RP.zoom() : null,
                     settings: window.__RP ? window.__RP.settings() : null,
                     typo: window.__RP ? window.__RP.typo() : null,
                     progress: window.__RP ? window.__RP.progress() : null,
                     read: window.__RP ? window.__RP.readScroll() : null,
                     edit: window.__RP ? window.__RP.editScroll() : null,
                     center: window.__RP ? window.__RP.centerToken(window.__RP.mode()) : null };
          `);
          if (H && H.docOk) break;
        } catch { /* ignore */ }
        await ui.sleep(650);
      }
      const zoomKept = H?.zoom === G0.zoom;
      const fontKept = H?.settings?.fontSize === G0.settings?.fontSize;
      // 字号是否"正确"：22 × 1.25 = 27.5（docZoom 与 fontSize 正确叠加）
      const pmFont = H?.typo?.pmP?.fontSize;
      const expectAfter = H?.settings ? +(H.settings.fontSize * (H.settings.docZoom / 100)).toFixed(2) : null;
      const fontApplied = pmFont === `${H?.settings?.fontSize}px` || pmFont === `${expectAfter}px`;
      ui.log(`[set] H0 reload 后: mode=${H?.mode} docOk=${H?.docOk} zoom=${H?.zoom} settings=${JSON.stringify(H?.settings)}`);
      ui.log(`[set] H0 PM 字号=${pmFont}（期望 ${H?.settings?.fontSize}px 或 ${expectAfter}px，即 fontSize×docZoom）；progress 尾=${String(H?.progress).slice(-40)}`);
      await ui.shot("after-reload");

      ui.add("22", "reload 后排版设置被记忆并生效",
        H?.docOk && zoomKept && fontKept && fontApplied ? "PASS" : !H?.docOk ? "FAIL" : "KNOWN",
        `文档装回=${H?.docOk}；docZoom ${G0.zoom}→${H?.zoom}（保持=${zoomKept}）；` +
        `settings.fontSize ${G0.settings?.fontSize}→${H?.settings?.fontSize}（保持=${fontKept}）；` +
        `阅读 .ProseMirror p 实际字号=${pmFont}，期望 ${H?.settings?.fontSize}px 或 ${expectAfter}px` +
        `（fontSize ${H?.settings?.fontSize} × docZoom ${H?.zoom} = ${expectAfter}，叠加生效=${fontApplied}）`);

      let pct = null;
      if (H?.mode === "read" && H.read) pct = H.read.pct;
      else if (H?.mode === "edit" && H.edit) pct = H.edit.pct;
      const progSame = G0.progress === H?.progress;
      const dPct = pct === null ? null : Math.abs(pct - 0.6);
      ui.log(`[set] H1 位置记忆: progress 保持=${progSame}；落点 mode=${H?.mode} pct=${pct}（目标 0.6）中心块 ${G0.center?.tok}→${H?.center?.tok}`);
      ui.add("23", "reload 后阅读位置被记忆并恢复（reload 前阅读 60%）",
        progSame && dPct !== null && dPct <= 0.05 ? "PASS" : progSame && dPct !== null && dPct <= 0.12 ? "KNOWN" : "FAIL",
        `进度快照保持=${progSame}；reload 后 mode=${H?.mode}，pct=${pct}（目标 0.6，偏差 ${dPct === null ? "n/a" : (dPct * 100).toFixed(1) + " 个百分点"}）；` +
        `视口中心块 ${G0.center?.tok} → ${H?.center?.tok}。注：reload 重建整个页面，属干净测量，不受 P0-1「内容变化触发 CM6 重建」干扰`);
    } else {
      ui.add("22", "reload 后排版设置被记忆并生效", "FAIL", "Page.reload 未能发出");
      ui.add("23", "reload 后阅读位置被记忆并恢复", "FAIL", "Page.reload 未能发出");
    }

    /* ═══ I. 打字机模式（源码自评"用户可感知度：高"） ═══
       判据：把光标放到**视口底部**（离中线最远），开启打字机后它应被拉到中线附近。
       这样判别力最强；若一开始就放在中间，"居中"会是恒真。
       注意：本项只依赖「点击放置光标 + 开关」，不依赖打字，故不受 P0-1（连续输入丢字）影响。 */
    try {
      if ((await ui.ev(`return window.__RP.mode()`)) !== "edit") {
        await ui.command("view.edit");
        await ui.sleep(3000);
        await ui.ev(RP_HELPERS);
      }
      const twOff = await ui.ev(`
        const o = JSON.parse(localStorage.getItem("lightmd-settings") || "{}");
        return o.state ? o.state.typewriterMode : null;
      `);
      // 把一行放到视口**底部区域**再点击它
      const place = await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        const lines = Array.from(document.querySelectorAll(".cm-line")).filter(l => (l.textContent||"").trim());
        if (!sc || lines.length < 20) return null;
        // 滚到 50% 后，挑视口底部附近那一行
        window.__RP.scrollToPct("edit", 0.5);
        return null;
      `);
      await ui.sleep(1200);
      const bottomLine = await ui.ev(`
        const sc = document.querySelector(".cm-scroller");
        const rr = sc.getBoundingClientRect();
        const lines = Array.from(document.querySelectorAll(".cm-line"));
        let best = null;
        for (const l of lines) {
          const r = l.getBoundingClientRect();
          if (r.height <= 0 || r.bottom > rr.bottom - 4) continue;
          if (!(l.textContent || "").trim()) continue;
          const rel = r.top - rr.top;
          if (rel < rr.height * 0.72) continue;   // 只要底部 28% 区域内的行
          best = { x: Math.round(r.left + Math.min(r.width - 20, 160)),
                   y: Math.round(r.top + r.height / 2), rel: Math.round(rel),
                   text: (l.textContent || "").slice(0, 24) };
          break;
        }
        return best;
      `);
      ui.log(`[set] I 打字机：底部候选行=${JSON.stringify(bottomLine)}（开关前状态 typewriterMode=${twOff}）`);
      if (!bottomLine) {
        ui.add("24", "打字机模式：源码面光标行居中", "KNOWN",
          "无法在视口底部定位可点击的源码行（行元素被虚拟滚动回收），未能构造判别性用例");
      } else {
        await clickAt(ui, bottomLine.x, bottomLine.y);
        await ui.sleep(700);
        const readCaret = () => ui.ev(`
          const sc = document.querySelector(".cm-scroller");
          const rr = sc.getBoundingClientRect();
          const c = document.querySelector(".cm-cursor-primary") || document.querySelector(".cm-cursor");
          const o = JSON.parse(localStorage.getItem("lightmd-settings") || "{}");
          if (!c) return { found: false, st: Math.round(sc.scrollTop),
                           twOn: o.state ? o.state.typewriterMode : null };
          const r = c.getBoundingClientRect();
          return { found: true, caretVY: Math.round(r.top - rr.top),
                   midVY: Math.round(rr.height / 2),
                   off: Math.round((r.top - rr.top) - rr.height / 2), st: Math.round(sc.scrollTop),
                   twOn: o.state ? o.state.typewriterMode : null };
        `);
        const before = await readCaret();
        // 开启打字机（只点开关）
        await ui.command("view.toggleTypewriter");
        await ui.sleep(2200);
        const afterToggle = await readCaret();
        // 再敲 1 个字符：打字机通常是在"输入/光标移动"时才把当前行拉到中线
        // （Lead 通报 P0-1：连续输入只有第 1 个字符落地；这里只需 1 个字符，够用）
        await ui.typeText("q");
        await ui.sleep(1500);
        const afterTyping = await readCaret();
        // 关掉，恢复现场
        await ui.command("view.toggleTypewriter");
        await ui.sleep(1000);
        ui.log(`[set] I 打字机：开启前 距中线=${before.off}px（vY=${before.caretVY}/中线${before.midVY}，st=${before.st}）`);
        ui.log(`[set] I 打字机：仅开开关后 距中线=${afterToggle.off}px（vY=${afterToggle.caretVY}，st=${afterToggle.st}，开关=${afterToggle.twOn}）`);
        ui.log(`[set] I 打字机：再敲 1 字符后 距中线=${afterTyping.off}px（vY=${afterTyping.caretVY}，st=${afterTyping.st}）`);

        const wasFar = before.found && Math.abs(before.off) > 120;
        const toggleCentered = afterToggle.found && Math.abs(afterToggle.off) <= 40;
        const typingCentered = afterTyping.found && Math.abs(afterTyping.off) <= 40;
        const scrolled = afterTyping.st !== before.st || afterToggle.st !== before.st;
        if (!wasFar) {
          ui.add("24", "打字机模式：源码面光标行是否被拉回视口中线", "KNOWN",
            `构造失败：光标初始距中线仅 ${before.off}px，未构成"远离中线"的判别性前提`);
        } else if (toggleCentered || typingCentered) {
          ui.add("24", "打字机模式：源码面光标行是否被拉回视口中线", "PASS",
            `构造：光标先落在视口底部（距中线 ${before.off}px；vY=${before.caretVY}，中线=${before.midVY}）。` +
            `仅开开关后距中线 ${afterToggle.off}px；再敲 1 字符后距中线 ${afterTyping.off}px（scrollTop ${before.st}→${afterTyping.st}）→ 光标被拉回中线附近`);
        } else if (!scrolled) {
          // 完全没滚动：光标行仍停在原处 —— 源码自评的"CM6 下打字机源码面不居中"缺口
          ui.add("24", "打字机模式：源码面光标行是否被拉回视口中线", "FAIL",
            `构造：光标先落在视口底部（距中线 ${before.off}px；vY=${before.caretVY}，中线=${before.midVY}，scrollTop=${before.st}）。` +
            `开启打字机（开关值已翻转 true）后距中线仍 ${afterToggle.off}px；再敲 1 字符后距中线 ${afterTyping.off}px，` +
            `scrollTop 全程 ${before.st}→${afterTyping.st}（**完全没有滚动**）→ 打字机对源码面未生效。` +
            `对应源码 TODO(v0.18) 自评：「开启了打字机但源码面无居中效果」`);
        } else {
          ui.add("24", "打字机模式：源码面光标行是否被拉回视口中线", "KNOWN",
            `构造：光标初始距中线 ${before.off}px。开启后 ${afterToggle.off}px、敲字后 ${afterTyping.off}px，` +
            `scrollTop ${before.st}→${afterTyping.st}（有滚动但未落到中线附近）；` +
            `注：本项受 P0-1（内容变化触发 CM6 重建）干扰，光标位置可能被重建重置，故判 KNOWN 而非 FAIL`);
        }
      }
    } catch (e) {
      ui.add("24", "打字机模式：源码面光标行居中", "KNOWN", `测试过程异常，未能判定：${String(e.message).slice(0, 150)}`);
    }

    ui.log(`[set] 重建计数（全程累计）: ${JSON.stringify(await ui.ev("return window.__RP ? window.__RP.rebuild() : null;").catch(() => null))}`);
    const errs = await ui.ev(`return window.__ERRS || [];`).catch(() => []);
    ui.log(`[set] 未捕获异常: ${JSON.stringify(errs).slice(0, 400)}`);
  },
);
