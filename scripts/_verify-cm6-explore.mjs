/**
 * 探索性探针（v0.17.1 CM6 P0 验证）—— 只为摸清**构建产物**里 DOM 的真实形态，
 * 不承担判定职责。最终判定见 `_verify-cm6-p0.mjs`。
 *
 * 目的（每一项都可能让"想当然的判据"恒真/恒假，必须先看清）：
 *   1. `.cm-content` 上能否拿到 CM6 view（`cmTile.view`）；
 *   2. ```js / ```python 围栏块内到底出现哪些 highlight class（A2 的判据原料）；
 *   3. 双击选词后 `.cm-selectionMatch` 的数量与文本（C1）；
 *   4. Ctrl+D 之后 `selection.ranges.length` 与文本长度（C2 + emacs Ctrl-d 反证）；
 *   5. 空文档（file.new）时 `.cm-placeholder` 是否存在、文案是什么（E4）；
 *   6. 长文档滚到底时末行的 `rect.top` 相对 scroller 的位置（E6 判据原料）。
 *
 * 用法：
 *   npx vite build --outDir _verify-out/dist-cm6 --emptyOutDir
 *   $env:BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-cm6"
 *   node scripts/_verify-cm6-explore.mjs
 */
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const DOC = [
  "# 探索文档 EXP",
  "",
  "普通段落里有重复词 token 供选中高亮试验。token 再次出现 token。",
  "",
  "```js",
  'const alpha = "str-value"; // 注释',
  "function beta(n) { return n + 42; }",
  "```",
  "",
  "```python",
  "def gamma(x):",
  '    # 中文注释',
  '    return "py" + str(x)',
  "```",
  "",
  "```",
  "no language fence line one",
  "```",
  "",
  "- 列表项 alpha",
  "- [ ] 任务项 beta",
  "",
  "> 引用行 gamma",
  "",
  "长文档填充开始。",
  ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段填充内容，用于滚动测试，标记 LN${String(i + 1).padStart(2, "0")}。`),
  "",
].join("\n");

const HELP = `
  window.__V = {
    view() {
      const c = document.querySelector(".cm-content");
      try { return (c && c.cmTile && c.cmTile.view) || null; } catch (e) { return null; }
    },
    doc() { const v = this.view(); return v ? v.state.doc.toString() : null; },
    sel() { const v = this.view(); if (!v) return null; return {
      ranges: v.state.selection.ranges.map(r => ({ from: r.from, to: r.to })),
      count: v.state.selection.ranges.length,
      main: { from: v.state.selection.main.from, to: v.state.selection.main.to },
    }; },
    setSel(from, to) {
      const v = this.view(); if (!v) return false;
      v.dispatch({ selection: { anchor: from, head: to === undefined ? from : to } });
      return true;
    },
    /** 每个 .cm-line 的 highlight class 汇总 */
    lineClasses() {
      return Array.from(document.querySelectorAll(".cm-line")).map(l => {
        const cls = new Set();
        l.querySelectorAll("span").forEach(s => {
          (s.className || "").split(/\\s+/).filter(Boolean).forEach(c => { if (c !== "cm-line") cls.add(c); });
        });
        return { text: (l.textContent || "").slice(0, 46), classes: [...cls] };
      });
    },
    matchCount() {
      const els = Array.from(document.querySelectorAll(".cm-selectionMatch"));
      return { n: els.length, texts: els.map(e => (e.textContent || "").slice(0, 12)) };
    },
    placeholder() {
      const p = document.querySelector(".cm-placeholder");
      return p ? { text: p.textContent, cls: p.className } : null;
    },
    scrollerInfo() {
      const sc = document.querySelector(".cm-scroller");
      if (!sc) return null;
      return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight),
               ch: Math.round(sc.clientHeight), max: Math.round(sc.scrollHeight - sc.clientHeight) };
    },
  };
  return true;
`;

await runBrowserProbe({ name: "_verify-cm6-explore", doc: DOC, docTitle: "探索文档" }, async (ui) => {
  await ui.ev(HELP);

  // 纯源码面（关掉右侧预览，避免 iframe 抢焦点 / 拖慢重渲染）
  const hasSplit = await ui.ev(`return !!document.querySelector("iframe.split-preview");`);
  ui.log(`[explore] 分屏预览存在 = ${hasSplit}`);
  if (hasSplit) {
    await ui.command("view.togglePreview");
    await ui.sleep(1200);
  }
  const split2 = await ui.ev(`return !!document.querySelector("iframe.split-preview");`);
  ui.log(`[explore] 关闭后分屏 = ${split2}`);

  const view = await ui.ev(`return !!window.__V.view()`);
  ui.log(`[explore] CM6 view 可获取 = ${view}`);
  const docLen = await ui.ev(`return (window.__V.doc() || "").length`);
  ui.log(`[explore] state.doc 长度 = ${docLen}`);

  await ui.focusSource();
  await ui.sleep(300);

  // ── 1. 高亮 class 采样（A2 原料）：把代码块滚进视口
  const probeLine = await ui.ev(`
    const v = window.__V.view();
    if (!v) return null;
    const i = v.state.doc.toString().indexOf("const alpha");
    v.dispatch({ selection: { anchor: i }, scrollIntoView: true });
    return i;
  `);
  await ui.sleep(900);
  // 等 language-data 懒加载完成（最多 6s）
  let classes = [];
  for (let i = 0; i < 12; i++) {
    classes = await ui.ev(`return window.__V.lineClasses()`);
    const js = classes.find((l) => l.text.includes("const alpha"));
    const distinct = js ? js.classes.filter((c) => c.startsWith("cm-md") || c.startsWith("tok")) : [];
    if (distinct.length >= 3) break;
    await ui.sleep(500);
  }
  ui.log(`[explore] offset of "const alpha" = ${probeLine}`);
  for (const l of classes.slice(0, 26)) {
    ui.log(`  line ${JSON.stringify(l.text)} → ${JSON.stringify(l.classes)}`);
  }

  // ── 2. 双击选词（C1 原料）
  const box = await ui.ev(`
    const ls = Array.from(document.querySelectorAll(".cm-line"));
    const t = ls.find(l => (l.textContent || "").includes("重复词"));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2), text: t.textContent };
  `);
  ui.log(`[explore] 双击目标 = ${JSON.stringify(box)}`);
  let dbl = null;
  if (box) {
    // 先单击定位，再双击选词
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await ui.sleep(150);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 2 });
    }
    await ui.sleep(500);
    dbl = await ui.ev(`return { sel: window.__V.sel(), match: window.__V.matchCount() }`);
    ui.log(`[explore] 双击后 sel=${JSON.stringify(dbl?.sel)} match=${JSON.stringify(dbl?.match)}`);
    // 选中文本内容
    const selText = await ui.ev(`
      const v = window.__V.view(); const m = v.state.selection.main;
      return v.state.doc.sliceString(m.from, m.to);
    `);
    ui.log(`[explore] 选中文本 = ${JSON.stringify(selText)}`);
  }

  // ── 3. 点别处 → 高亮应消失
  if (box) {
    await ui.click(box.x + 200, box.y);
    await ui.sleep(400);
    const afterClick = await ui.ev(`return { sel: window.__V.sel(), match: window.__V.matchCount() }`);
    ui.log(`[explore] 点别处后 sel=${JSON.stringify(afterClick?.sel)} match=${JSON.stringify(afterClick?.match)}`);
  }

  // ── 4. Ctrl+D（探针手工选中一个词再按）
  const cd = await ui.ev(`
    const v = window.__V.view();
    const i = v.state.doc.toString().indexOf("token");
    v.dispatch({ selection: { anchor: i, head: i + 5 } });
    return { i, len: v.state.doc.length };
  `);
  await ui.sleep(250);
  const beforeCd = await ui.ev(`return { sel: window.__V.sel(), len: (window.__V.doc()||"").length, match: window.__V.matchCount() }`);
  await ui.key("d", "KeyD", 68, 2);
  await ui.sleep(400);
  const afterCd = await ui.ev(`return { sel: window.__V.sel(), len: (window.__V.doc()||"").length, match: window.__V.matchCount() }`);
  ui.log(`[explore] Ctrl+D 目标 offset=${JSON.stringify(cd)}`);
  ui.log(`[explore] Ctrl+D 前 sel.count=${beforeCd?.sel?.count} len=${beforeCd?.len} match=${JSON.stringify(beforeCd?.match)}`);
  ui.log(`[explore] Ctrl+D 后 sel.count=${afterCd?.sel?.count} len=${afterCd?.len} match=${JSON.stringify(afterCd?.match)}`);
  ui.log(`[explore] Ctrl+D 后 ranges=${JSON.stringify(afterCd?.sel?.ranges)}`);

  // ── 5. Enter 智能续行（A1 原料）
  await ui.ev(`
    const v = window.__V.view();
    const i = v.state.doc.toString().indexOf("- 列表项 alpha");
    v.dispatch({ selection: { anchor: i + "- 列表项 alpha".length }, scrollIntoView: true });
    return true;
  `);
  await ui.focusSource();
  await ui.sleep(400);
  const beforeEnter = await ui.ev(`return window.__V.doc()`);
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(500);
  const afterEnter = await ui.ev(`return window.__V.doc()`);
  ui.log(`[explore] Enter 前尾片段 = ${JSON.stringify((beforeEnter || "").slice(-80))}`);
  ui.log(`[explore] Enter 后尾片段 = ${JSON.stringify((afterEnter || "").slice(-80))}`);
  ui.log(`[explore] Enter 长度 ${(beforeEnter || "").length} → ${(afterEnter || "").length}`);

  // Ctrl+Z 一次
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1200);
  const afterUndo = await ui.ev(`return window.__V.doc()`);
  ui.log(`[explore] Ctrl+Z 后长度 = ${(afterUndo || "").length}，与 Enter 前一致 = ${afterUndo === beforeEnter}`);

  // ── 6. 滚动几何（E6 原料）
  await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    sc.scrollTop = sc.scrollHeight;
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;
  `);
  await ui.sleep(900);
  const geom = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const ls = Array.from(document.querySelectorAll(".cm-line"));
    const last = ls[ls.length - 1];
    const scR = sc.getBoundingClientRect(), lR = last ? last.getBoundingClientRect() : null;
    const content = document.querySelector(".cm-content");
    return {
      scroller: { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight) },
      lastText: last ? (last.textContent || "").slice(0, 30) : null,
      lastTopRel: lR ? Math.round(lR.top - scR.top) : null,
      contentPadBottom: content ? content.style.paddingBottom : null,
      lineCount: ls.length,
    };
  `);
  ui.log(`[explore] 滚到底几何 = ${JSON.stringify(geom)}`);

  // ── 7. 空文档占位（E4 原料）
  await ui.ev(`window.confirm = () => true; window.alert = () => {}; return true;`);
  await ui.command("file.new");
  await ui.sleep(1800);
  const emptyState = await ui.ev(`
    return {
      cm: !!document.querySelector(".cm-editor"),
      ph: window.__V.placeholder(),
      docLen: (window.__V.doc() || "").length,
      bodyHasPlaceholderText: (document.body.textContent || "").includes("开始输入 Markdown"),
    };
  `);
  ui.log(`[explore] 新建空文档 = ${JSON.stringify(emptyState)}`);

  await ui.shot("explore-end");
  ui.add("X", "探索完成（无判定职责）", "KNOWN", "见日志中的 DOM 形态采样");
});
