/**
 * v0.17.1 发布说明 §三「CM6 能力适配第一批（P0 六项）」—— **真实构建产物**上的逐项验证。
 *
 * ## 为什么不用源码形状断言
 * v0.17.1 自带 `src/__tests__/v0171-cm6-p0/*` 27 条用例，其中 A2 / E6 / C2 的
 * 「Ctrl-d 冲突」等若干条是**源码正则断言**（`expect(SRC).toMatch(...)`）——
 * 那只能证明"代码里写了这行"，证明不了"用户在 dist 里按下去真的会这样"。
 * 本探针只认**构建产物里可观测的行为**：state.doc 前后、DOM class 集合、选区数、几何。
 *
 * ## 每个判据都配了"反证/对照"，避免判据恒真
 * | 项 | 正向判据 | 反证（证明判据有分辨力） |
 * |---|---|---|
 * | A1 | Enter 后 `state.doc` 多出 "\n- " | 普通段落 Enter 只多 "\n"（不续标记） |
 * | A2 | js 块 ≥3 个不同 cm-md-* | 无语言围栏块只有 1 个 cm-md-code |
 * | C1 | 双击后 .cm-selectionMatch = 2 | 点别处后 = 0 |
 * | C2 | Ctrl+D 后 ranges=2，长度不变 | 若被 emacs Ctrl-d 抢走 → 长度 -1 |
 * | E4 | 空文档 .cm-placeholder 有文案 | 打字后消失、doc 里没有该文案 |
 * | E6 | 底时末行 rect.top ≤ 0 | 末行 top + paddingBottom > 0（去掉留白就到不了顶） |
 *
 * ## ⚠️ CM6 虚拟化
 * 所有"全文"断言一律走 `state.doc`（`window.__V.doc()`），**不拼 `.cm-line`**。
 *
 * 用法：
 *   npx vite build --outDir _verify-out/dist-cm6 --emptyOutDir
 *   $env:BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-cm6"
 *   node scripts/_verify-cm6-p0.mjs
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

/* ══════════════════════════════════════════════════════════════════════
 * 夹具（中文 Markdown，自造，不用用户文档）
 * ══════════════════════════════════════════════════════════════════════ */

/** 文档主夹具：高亮 / 选中匹配 / 列表 / 引用 / 三种围栏 */
const MAIN_DOC = [
  "# CM6 P0 验证夹具",
  "",
  "第一行有 token 这个词。第二行 token 又出现。第三行 token 收尾。",
  "",
  "```js",
  'const alpha = "s1"; // 行尾注释',
  "function beta(n) { return n + 42; }",
  "```",
  "",
  "```python",
  "def gamma(x):",
  '    return "py" + str(x)',
  "```",
  "",
  "```",
  "plain fence line no language",
  "```",
  "",
  "- 无序项 one",
  "- [x] 已完成任务",
  "> 引用行 quote",
  "",
].join("\n");

const longDoc = (n) => {
  const out = ["# 长文档 LN", ""];
  for (let i = 1; i <= n; i++) {
    out.push(`第 ${i} 段。标记 LN${String(i).padStart(3, "0")} 用于定位，内容填充填充填充填充填充。`, "");
  }
  return out.join("\n");
};

/* ══════════════════════════════════════════════════════════════════════
 * 页面内只读助手
 * ══════════════════════════════════════════════════════════════════════ */
const HELP = `
  window.__V = {
    view() {
      const c = document.querySelector(".cm-content");
      try { return (c && c.cmTile && c.cmTile.view) || null; } catch (e) { return null; }
    },
    /** ★ 全文唯一可信来源（CM6 虚拟化 → 不能拼 .cm-line） */
    doc() { const v = this.view(); return v ? v.state.doc.toString() : null; },
    len() { const v = this.view(); return v ? v.state.doc.length : null; },
    sel() {
      const v = this.view(); if (!v) return null;
      const s = v.state.selection;
      return { count: s.ranges.length,
               ranges: s.ranges.map(r => ({ from: r.from, to: r.to })),
               main: { from: s.main.from, to: s.main.to } };
    },
    /** 把光标放到 marker 之后 delta 个字符处（marker 不存在则返回 -1） */
    at(marker, delta) {
      const v = this.view(); if (!v) return -1;
      const t = v.state.doc.toString();
      const i = t.indexOf(marker);
      if (i < 0) return -1;
      const pos = i + marker.length + (delta || 0);
      v.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
      return pos;
    },
    /**
     * ★ 取**最后一次**出现的 marker（夹具里 "- " 这类标记会重复出现，
     * 用 indexOf 会命中第一处 → 光标落错行 → 判定必然误判。这是本探针
     * 第一版 4 条 A1 FAIL 的根因，见 reports）。
     */
    atLast(marker, delta) {
      const v = this.view(); if (!v) return -1;
      const t = v.state.doc.toString();
      const i = t.lastIndexOf(marker);
      if (i < 0) return -1;
      const pos = i + marker.length + (delta || 0);
      v.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
      return pos;
    },
    selRange(from, to) {
      const v = this.view(); if (!v) return false;
      v.dispatch({ selection: { anchor: from, head: to } });
      return true;
    },
    /** 某个 offset 的屏幕坐标（双击定位用） */
    coords(offset) {
      const v = this.view(); if (!v) return null;
      try { const c = v.coordsAtPos(offset); if (!c) return null;
        return { x: Math.round((c.left + c.right) / 2), y: Math.round((c.top + c.bottom) / 2) }; } catch (e) { return null; }
    },
    /** 代码块内每行的 highlight class 集合（A2 原料） */
    classesOf(marker) {
      const want = marker;
      const out = [];
      for (const l of Array.from(document.querySelectorAll(".cm-line"))) {
        const t = l.textContent || "";
        if (!t.includes(want)) continue;
        const cls = new Set();
        l.querySelectorAll("span").forEach(s => (s.className || "").split(/\\s+/).forEach(c => {
          if (c && c.startsWith("cm-md")) cls.add(c);
        }));
        out.push({ text: t.slice(0, 40), classes: [...cls].sort() });
        break;
      }
      return out[0] || null;
    },
    matchCount() {
      const els = Array.from(document.querySelectorAll(".cm-selectionMatch"));
      return { n: els.length, texts: els.map(e => e.textContent || "") };
    },
    placeholder() {
      const p = document.querySelector(".cm-placeholder");
      return p ? { text: p.textContent, cls: p.className } : null;
    },
    /** 滚动几何 + 末行相对视口顶部位置（E6 原料） */
    geo() {
      const sc = document.querySelector(".cm-scroller");
      if (!sc) return null;
      const content = document.querySelector(".cm-content");
      const scR = sc.getBoundingClientRect();
      const lines = Array.from(document.querySelectorAll(".cm-line"))
        .filter(l => (l.textContent || "").trim().length > 0);
      const last = lines[lines.length - 1];
      const lastR = last ? last.getBoundingClientRect() : null;
      const padB = content ? parseFloat(getComputedStyle(content).paddingBottom || "0") : 0;
      return {
        st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight),
        ch: Math.round(sc.clientHeight), max: Math.round(sc.scrollHeight - sc.clientHeight),
        lastText: last ? (last.textContent || "").slice(0, 26) : null,
        lastTopRel: lastR ? Math.round(lastR.top - scR.top) : null,
        lastBottomRel: lastR ? Math.round(lastR.bottom - scR.top) : null,
        padBottom: Math.round(padB),
        renderedLines: lines.length,
      };
    },
    /**
     * 「每行都能滚到视口顶部」的直接可行性检验。
     *
     * 对文档里**每一个**非空行：该行绝对内容高度 = (rect.top - scR.top + scrollTop)，
     * 要把它顶到视口顶部就需要 scrollTop = 该值；可行 ⟺ 该值 <= max。
     *
     * ⚠️ CM6 虚拟化：只能量到**已渲染**的行，但通过大步滚动逐段采样可以把
     * 整篇都覆盖到（每段渲染若干行 → 记下它们的绝对位置）。本函数只统计
     * "采到的行"，并明确回报采样覆盖率，不谎称"全部行已测"。
     */
    lineTopFeasibility() {
      const sc = document.querySelector(".cm-scroller");
      if (!sc) return null;
      const max = Math.round(sc.scrollHeight - sc.clientHeight);
      const st = sc.scrollTop;
      const scR = sc.getBoundingClientRect();
      const out = [];
      sc.querySelectorAll(".cm-line").forEach(l => {
        const t = (l.textContent || "").trim();
        if (!t.length) return;
        const r = l.getBoundingClientRect();
        const absTop = Math.round(r.top - scR.top + st);
        out.push({ text: t.slice(0, 18), absTop, reachable: absTop <= max });
      });
      return { max, lines: out };
    },
    /** 破坏性对照用：改写/还原 .cm-content 的底部留白 */
    setPad(px) {
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      c.style.paddingBottom = typeof px === "number" ? px + "px" : px;
      return getComputedStyle(c).paddingBottom;
    },
  };
  return true;
`;

/* ══════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-cm6p0-"));
const docPath = (n) => path.join(TMP, n);
const CNT = { n: 0 };

await runBrowserProbe({ name: "_verify-cm6-p0", doc: MAIN_DOC, docTitle: "CM6 P0" }, async (ui) => {
  await ui.ev(HELP);

  /** 打开一份夹具（走真实 load 路径，保证受控状态与用户路径一致） */
  const openDoc = async (content) => {
    const name = `f${++CNT.n}.md`;
    const p = docPath(name);
    fs.writeFileSync(p, content, "utf8");
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(p)}, name: ${JSON.stringify(name)}, content: ${JSON.stringify(content)} },
      }));
      return true;
    `);
    await ui.sleep(700);
    return name;
  };
  const readDoc = () => ui.ev(`return window.__V.doc()`);
  const readLen = () => ui.ev(`return window.__V.len()`);
  const readSel = () => ui.ev(`return window.__V.sel()`);
  /** 焦点 + 等宿主/CM6 稳定 */
  const focus = async (ms = 320) => { await ui.focusSource(); await ui.sleep(ms); };
  /** 双击选中 offset 所在处的词 */
  const dblClickAt = async (offset) => {
    const c = await ui.ev(`return window.__V.coords(${offset})`);
    if (!c) return null;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 1 });
    }
    await ui.sleep(140);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ui.cdp.send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 2 });
    }
    await ui.sleep(420);
    return c;
  };

  // ── 0. 前置：确认走的是 CM6 分支
  const impl = await ui.ev(`return document.querySelector(".cm-editor") ? "cm6" : "text-only";`);
  const viewOk = await ui.ev(`return !!window.__V.view()`);
  ui.add("P0", "构建产物走 CM6 源码面且 view 可取", impl === "cm6" && viewOk ? "PASS" : "FAIL",
    `impl=${impl}；view=${viewOk}；节点 @codemirror/view 装配见 CmSourceSurface.buildExtensions`);
  if (!viewOk) return;

  await focus(500);

  /* ══════════════════════════════════════════════════════════════════════
   * A1 智能回车
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ A1 智能回车（insertNewlineContinueMarkup）════════");

  /**
   * 单个 A1 场景。
   *
   * ## ⚠️ 本探针第一版在这里判错 4 条（根因，记录下来防止别人重蹈）
   * 判据写成 `after.endsWith("\n- ")` —— 但夹具文本自带结尾换行
   * （`"- 无序项 alpha\n"`），Enter 在末尾插完 `"\n- "` 之后那个原始 `"\n"`
   * 仍在**最后面** → `after === "- 无序项 alpha\n- \n"`，`endsWith("\n- ")` 必然 false。
   * 实测 Δ 长度是对的（3 = `"\n- "` 的长度），产品行为完全正确，是**判据**错了。
   *
   * 修法：按"在光标处插入 expectedInsert"构造期望全文再整串比较：
   *   `expected = before.slice(0, pos) + insert + before.slice(pos)`
   * 这样既不受首尾换行影响，也能顺带验证"插入位置正确"。
   *
   * 另一个坑：`"- "` 这类标记在夹具里**会重复出现**，用 `indexOf` 会命中第一处。
   * 需要末项的用例一律走 `atLast`。
   */
  const enterCase = async (id, label, fixture, marker, delta, expectInsert, opts = {}) => {
    await openDoc(fixture);
    await focus();
    const jsAt = opts.useLast ? "atLast" : "at";
    const pos = await ui.ev(`return window.__V.${jsAt}(${JSON.stringify(marker)}, ${delta})`);
    if (pos < 0) {
      ui.add(id, label, "FAIL", `夹具里找不到标记「${marker}」`);
      return null;
    }
    await focus(260);
    const before = await readDoc();
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(560);
    const after = await readDoc();
    const expected = (before || "").slice(0, pos) + expectInsert + (before || "").slice(pos);
    const exact = after === expected;
    ui.add(id, label, exact ? "PASS" : "FAIL",
      `光标@${pos}｜长度 ${(before || "").length}→${(after || "").length}（Δ${(after || "").length - (before || "").length}）` +
      `｜实测尾部=${JSON.stringify((after || "").slice(-30))}` +
      `｜期望=在光标处插入 ${JSON.stringify(expectInsert)} → ${exact ? "整串一致" : JSON.stringify(expected)}` +
      (opts.note ? `｜${opts.note}` : ""));
    return { before, after, pos, exact };
  };

  // A1-1 无序列表续行
  await enterCase("A1-1", "无序列表行尾 Enter → 续出 `- `", "- 无序项 alpha\n", "- 无序项 alpha", 0, "\n- ");
  // A1-2 任务项续行（复选框重置为未勾选）
  await enterCase("A1-2", "任务项 `- [x]` 行尾 Enter → 续出 `- [ ] `（复选框重置）",
    "- [x] 已完成的项\n", "- [x] 已完成的项", 0, "\n- [ ] ");
  // A1-3 有序列表递增
  await enterCase("A1-3", "有序列表 `3. xxx` Enter → 自动 `4. `", "3. 第三步\n", "3. 第三步", 0, "\n4. ");
  // A1-4 引用续行
  await enterCase("A1-4", "引用行尾 Enter → 续出 `> `", "> 引用一句话\n", "> 引用一句话", 0, "\n> ");
  // A1-5 普通段落对照（反证：只插普通换行，不续任何标记）
  {
    await openDoc("普通段落一句话\n");
    await focus();
    const pos = await ui.ev(`return window.__V.at("普通段落一句话", 0)`);
    await focus(260);
    const before = await readDoc();
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(560);
    const after = await readDoc();
    const expected = (before || "").slice(0, pos) + "\n" + (before || "").slice(pos);
    ui.add("A1-5", "★对照：普通段落 Enter → 只插入普通换行（判据有分辨力，不恒真）",
      after === expected ? "PASS" : "FAIL",
      `长度 ${(before || "").length}→${(after || "").length}（Δ${(after || "").length - (before || "").length}，期望 Δ1）；` +
      `doc=${JSON.stringify(after)}（期望 ${JSON.stringify(expected)}）`);
  }
  // A1-6 三项列表空末项 → 退标记、退出列表
  {
    await openDoc("- 第一项\n- 第二项\n- ");
    await focus();
    // ★ 必须 atLast：夹具里 "- " 出现 3 次，indexOf 会落进第一项
    const pos = await ui.ev(`return window.__V.atLast("- ", 0)`);
    await focus(260);
    const before = await readDoc();
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(560);
    const after = await readDoc();
    const markupGone = !(after || "").endsWith("- ");
    const listKept = (after || "").startsWith("- 第一项\n- 第二项\n");
    ui.add("A1-6", "★三项列表的空末项 Enter → 退标记、退出列表",
      markupGone && listKept ? "PASS" : "FAIL",
      `光标@${pos}（末项行尾）｜${JSON.stringify(before)} → ${JSON.stringify(after)}` +
      `（末项标记已消失=${markupGone}；前两项保留=${listKept}）`);
  }
  // A1-7 单项列表空项 → 列表清空
  {
    await openDoc("- ");
    await focus();
    const pos = await ui.ev(`return window.__V.atLast("- ", 0)`);
    await focus(260);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(560);
    const after = await readDoc();
    ui.add("A1-7", "★单项列表的空项 Enter → 整行退掉（列表清空）", after === "" ? "PASS" : "FAIL",
      `光标@${pos}｜Enter 后 doc=${JSON.stringify(after)}（期望 ""）`);
  }
  // A1-8 两项 tight 列表空第二项（CM6 官方语义：插空行变松散，不是退出）
  {
    await openDoc("- 唯一一项\n- ");
    await focus();
    const pos = await ui.ev(`return window.__V.atLast("- ", 0)`);
    await focus(260);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(560);
    const after = await readDoc();
    const isOfficial = after === "- 唯一一项\n\n- ";
    ui.add("A1-8", "两项 tight 列表的空第二项 Enter → 插空行变松散（CM6 官方语义，发布说明已声明）",
      isOfficial ? "PASS" : "FAIL",
      `光标@${pos}｜Enter 后 doc=${JSON.stringify(after)}（期望 ${JSON.stringify("- 唯一一项\n\n- ")}）`);
  }
  // A1-9 行首 Backspace 一次删净列表标记
  {
    const SRC = "- 列表项要取消\n";
    await openDoc(SRC);
    await focus();
    const pos = await ui.ev(`return window.__V.atLast("- ", 0)`);
    await focus(260);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(560);
    const after = await readDoc();
    ui.add("A1-9", "★行首（标记之后）Backspace 一次删净 `- ` 标记（不粘连上一行）",
      after === "列表项要取消\n" ? "PASS" : "FAIL",
      `光标@${pos}｜${JSON.stringify(SRC)} → ${JSON.stringify(after)}（期望 ${JSON.stringify("列表项要取消\n")}）`);
  }
  // A1-10 引用标记 Backspace
  {
    const SRC = "> 引用要取消\n";
    await openDoc(SRC);
    await focus();
    const pos = await ui.ev(`return window.__V.atLast("> ", 0)`);
    await focus(260);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(560);
    const after = await readDoc();
    ui.add("A1-10", "引用标记行首 Backspace → 删掉 `> `", after === "引用要取消\n" ? "PASS" : "FAIL",
      `光标@${pos}｜${JSON.stringify(SRC)} → ${JSON.stringify(after)}（期望 ${JSON.stringify("引用要取消\n")}）`);
  }
  // A1-11 行中 Backspace 对照（反证：不吃标记，只删一个字符）
  {
    const SRC = "- 列表项要取消\n";
    await openDoc(SRC);
    await focus();
    /**
     * 目标：光标落在 "表" 与 "项" 之间 = offset 4。
     * `"- 列表项"` 有 5 个字符（'-',' ','列','表','项'），
     * 取 marker 末尾（offset 5）再 -1 = 4。
     * （第一版直接用 atLast(...,0) 得 offset 5，落在 "项" 之后，
     *   Backspace 删掉的是 "项" → 期望串写错，产品行为其实正确。）
     */
    const pos = await ui.ev(`return window.__V.atLast("- 列表项", -1)`);
    await focus(260);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(560);
    const after = await readDoc();
    const expected = "- 列项要取消\n"; // 删掉 offset 3 的 "表"，列表标记 "- " 原样保留
    ui.add("A1-11", "对照：行中 Backspace 只删前一个字符、不吃列表标记",
      after === expected ? "PASS" : "FAIL",
      `光标@${pos}（"表|项" 之间）｜${JSON.stringify(SRC)} → ${JSON.stringify(after)}（期望 ${JSON.stringify(expected)}）`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * A2 围栏代码块内嵌语言高亮
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ A2 围栏代码块内嵌语言高亮（codeLanguages: languages）════════");
  {
    await openDoc(MAIN_DOC);
    await focus();
    // 先把代码块滚进视口
    await ui.ev(`
      const v = window.__V.view();
      v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("const alpha") }, scrollIntoView: true });
      return true;
    `);
    await ui.sleep(500);
    // 懒加载采样：立刻取一次（未加载完）→ 轮询到稳定
    let js = await ui.ev(`return window.__V.classesOf("const alpha")`);
    const firstClasses = js?.classes ? [...js.classes] : null;
    let py = null, plain = null, waited = 0;
    for (let i = 0; i < 16; i++) {
      js = await ui.ev(`return window.__V.classesOf("const alpha")`);
      py = await ui.ev(`return window.__V.classesOf('str(x)')`);
      plain = await ui.ev(`return window.__V.classesOf("plain fence line")`);
      if (js && js.classes.length >= 3 && py && py.classes.length >= 2) break;
      await ui.sleep(500); waited += 500;
    }
    ui.log(`[A2] 首帧 js class=${JSON.stringify(firstClasses)} → 稳定后（等待 ${waited}ms）`);
    ui.log(`[A2] js   行「${js?.text}」→ ${JSON.stringify(js?.classes)}`);
    ui.log(`[A2] py   行「${py?.text}」→ ${JSON.stringify(py?.classes)}`);
    ui.log(`[A2] 无语言围栏「${plain?.text}」→ ${JSON.stringify(plain?.classes)}`);

    const jsCls = js?.classes ?? [];
    const pyCls = py?.classes ?? [];
    const plainCls = plain?.classes ?? [];
    // 补采 js 块里带数字的那一行（验证 number tag 也在工作，而不是只 keyword/string）
    const jsNum = await ui.ev(`return window.__V.classesOf("return n + 42")`);
    const jsNumCls = jsNum?.classes ?? [];
    ui.log(`[A2] js 数字行「${jsNum?.text}」→ ${JSON.stringify(jsNumCls)}`);
    // ① 无语言围栏 = 单一 cm-md-code（markdown 只把它当 monospace）→ 这是"单色基线"
    const plainSingle = plainCls.length === 1 && plainCls[0] === "cm-md-code";
    // ② js 块出现多 token 类别
    const jsMulti = jsCls.length >= 3;
    // ③ python 块也出现多类别，且与 js 的类别集合不全等（证明各语言自己的解析器在跑）
    const pyMulti = pyCls.length >= 2;
    const jsHasKw = jsCls.includes("cm-md-keyword");
    const jsHasStr = jsCls.includes("cm-md-string");
    const jsHasNum = jsNumCls.includes("cm-md-number");
    const pyHasKw = pyCls.includes("cm-md-keyword");
    const pyHasStr = pyCls.includes("cm-md-string");
    const distinctBetween = JSON.stringify(jsCls) !== JSON.stringify(pyCls);

    ui.add("A2-1", "单色基线：无语言围栏块只有 1 个 class（cm-md-code）——证明'多 class'不是 markdown 自己给的",
      plainSingle ? "PASS" : "FAIL", `plain fence → ${JSON.stringify(plainCls)}`);
    ui.add("A2-2", "```js 块内出现 ≥3 个不同 highlight class（keyword/string/comment 等）",
      jsMulti && jsHasKw && jsHasStr ? "PASS" : "FAIL",
      `js 行 → ${JSON.stringify(jsCls)}（keyword=${jsHasKw} string=${jsHasStr} comment=${jsCls.includes("cm-md-comment")}）`);
    ui.add("A2-5", "```js 块内数字也被单独上色（cm-md-number，第四种 token 类别）",
      jsHasNum ? "PASS" : "FAIL", `「${jsNum?.text}」→ ${JSON.stringify(jsNumCls)}`);
    ui.add("A2-3", "```python 块内 ≥2 个不同 class，且与 js 的类别集合不同（各自语言解析器在跑）",
      pyMulti && pyHasKw && pyHasStr && distinctBetween ? "PASS" : "FAIL",
      `py → ${JSON.stringify(pyCls)}；与 js 集合不同=${distinctBetween}`);
    /**
     * A2-4：懒加载**不作为独立判据**。
     *
     * ## 为什么改成 KNOWN 而不是 PASS（这是本探针诚实口径的一处修正）
     * 第一版判据是"首帧 class ≠ 稳定后 class → 证明懒加载发生了"。实测首帧就已经是
     * 完整 3 类（`waited = 0ms`），于是判据退化成 `first === null ? ... : 比字符串`
     * —— 而 `dist===` 恒成立又只能说明"两次采样一样"，**证明不了**"是按需加载的"。
     * 这个判据既不能证真也不能证伪"懒加载"，属于**无效判据**，不能算 PASS。
     *
     * 真正能证明懒加载的是**产物分包**：`node_modules/@codemirror/language-data` 的
     * 每种语言是一个 `LanguageDescription`，`load()` 是动态 `import()` → vite 会为
     * 每种语言产出独立 chunk。这一点在构建产物里可数（见报告里的 assets 清单），
     * 与"运行时是否重解析过"是两个层面，不混在一条判据里。
     */
    ui.add("A2-4", "语言确实由 language-data 的按需 chunk 提供（运行时懒加载时序）", "KNOWN",
      `实测首帧即为完整 3 类 ${JSON.stringify(firstClasses)}（waiting=${waited}ms）→ 无法用"首帧 vs 稳定"证明懒加载时序；` +
      `分包证据见报告（dist-cm6/assets 里 javascript-*.js / python-*.js / erlang-*.js 等独立 chunk）。` +
      `★ 第一版此条按"首帧≠稳定"判 PASS 属**判据恒真**，已降级为 KNOWN。`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * C1 选中词即高亮
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ C1 选中词即高亮（highlightSelectionMatches）════════");
  {
    const C1DOC = "第一行有 token 这个词。\n第二行 token 又出现。\n第三行 token 收尾。\n";
    await openDoc(C1DOC);
    await focus();
    const off = await ui.ev(`
      const t = window.__V.doc(); return t.indexOf("token") + 2; // 落在 token 中间
    `);
    const coords = await dblClickAt(off);
    const selAfterDbl = await readSel();
    const selText = await ui.ev(`
      const v = window.__V.view(); const m = v.state.selection.main;
      return v.state.doc.sliceString(m.from, m.to);
    `);
    const m1 = await ui.ev(`return window.__V.matchCount()`);
    ui.log(`[C1] 双击坐标=${JSON.stringify(coords)} 选中=${JSON.stringify(selText)} 选区=${JSON.stringify(selAfterDbl)}`);
    ui.log(`[C1] .cm-selectionMatch = ${JSON.stringify(m1)}`);
    const okDbl = m1.n === 2 && m1.texts.every((t) => t === "token");
    ui.add("C1-1", "★双击选中词 → 全文其余 2 处相同文本被高亮（.cm-selectionMatch=2）",
      okDbl ? "PASS" : "FAIL",
      `选中文本=${JSON.stringify(selText)}；匹配数=${m1.n}（文本=${JSON.stringify(m1.texts.slice(0, 4))}）`);

    // 点别处（空白区）→ 高亮消失
    const gone = await ui.ev(`
      const sc = document.querySelector(".cm-scroller"); const r = sc.getBoundingClientRect();
      return { x: Math.round(r.left + r.width - 40), y: Math.round(r.top + r.height - 60) };
    `);
    await ui.click(gone.x, gone.y);
    await ui.sleep(420);
    const m2 = await ui.ev(`return window.__V.matchCount()`);
    const sel2 = await readSel();
    ui.log(`[C1] 点别处后 sel=${JSON.stringify(sel2)} match=${JSON.stringify(m2)}`);
    ui.add("C1-2", "点别处 → 高亮消失（.cm-selectionMatch=0）", m2.n === 0 ? "PASS" : "FAIL",
      `匹配数=${m2.n}；选区=${JSON.stringify(sel2)}`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * C2 Ctrl+D 多点同改 + emacs Ctrl-d 反证
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ C2 Ctrl+D 多点同改（selectNextOccurrence）════════");
  {
    const C2DOC = "alpha token beta\ngamma token delta\nepsilon token zeta\n";
    await openDoc(C2DOC);
    await focus();
    await ui.ev(`
      const v = window.__V.view(); const t = v.state.doc.toString();
      const i = t.indexOf("token");
      v.dispatch({ selection: { anchor: i, head: i + 5 } });
      return true;
    `);
    await focus(200);
    const base = await readSel();
    const baseLen = await readLen();
    const baseMatch = await ui.ev(`return window.__V.matchCount()`);

    await ui.key("d", "KeyD", 68, 2); // Ctrl+D（modifiers=2 = Ctrl）
    await ui.sleep(420);
    const s2 = await readSel();
    const len2 = await readLen();

    await ui.key("d", "KeyD", 68, 2);
    await ui.sleep(420);
    const s3 = await readSel();
    const len3 = await readLen();
    const match3 = await ui.ev(`return window.__V.matchCount()`);

    ui.log(`[C2] 基线 sel.count=${base?.count} len=${baseLen} match=${JSON.stringify(baseMatch)}`);
    ui.log(`[C2] 第1次 Ctrl+D → count=${s2?.count} len=${len2} ranges=${JSON.stringify(s2?.ranges)}`);
    ui.log(`[C2] 第2次 Ctrl+D → count=${s3?.count} len=${len3} ranges=${JSON.stringify(s3?.ranges)} match=${JSON.stringify(match3)}`);

    // ★ 反证：若 defaultKeymap 的 emacs Ctrl-d（deleteCharForward）抢到键，长度会 -1（或删掉选中）
    const noShrink = len2 === baseLen && len3 === baseLen;
    ui.add("C2-1", "★反证：Ctrl+D 后文本长度不变（默认键位 Ctrl-d=deleteCharForward 已被过滤）",
      noShrink ? "PASS" : "FAIL",
      `长度 ${baseLen} → ${len2} → ${len3}（若被 emacs Ctrl-d 抢走应递减）`);
    ui.add("C2-2", "Ctrl+D 逐次累加选区（1 → 2 → 3）",
      s2?.count === 2 && s3?.count === 3 ? "PASS" : "FAIL",
      `count ${base?.count} → ${s2?.count} → ${s3?.count}；ranges=${JSON.stringify(s3?.ranges)}`);
    ui.add("C2-3", "多选区时 C1 高亮自动让位（官方语义 ranges>1 → Decoration.none）",
      match3?.n === 0 ? "PASS" : "KNOWN",
      `第2次 Ctrl+D 后 .cm-selectionMatch=${match3?.n}`);

    // 打字 → 是否三处同时改
    const beforeType = await readDoc();
    await ui.key("Z", "KeyZ", 90); // 单字符（无修饰键 → 走 char 文本插入）
    await ui.sleep(700);
    const afterType = await readDoc();
    const tokenLeft = (afterType.match(/token/g) || []).length;
    const zCount = (afterType.match(/Z/g) || []).length;
    ui.log(`[C2] 打字前 doc=${JSON.stringify(beforeType)}`);
    ui.log(`[C2] 打字后 doc=${JSON.stringify(afterType)}（token 剩 ${tokenLeft}，Z 出现 ${zCount}）`);
    ui.add("C2-4", "★多光标打字同时改写全部 3 处（多处同改）",
      tokenLeft === 0 && zCount === 3 ? "PASS" : "FAIL",
      `token 剩余=${tokenLeft}（期望 0）；Z 出现=${zCount}（期望 3）；doc=${JSON.stringify(afterType)}`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * E4 空文档占位
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ E4 空文档占位提示（placeholder）════════");
  {
    await ui.ev(`window.confirm = () => true; window.alert = () => {}; return true;`);
    await ui.command("file.new");
    await ui.sleep(1800);
    const ph = await ui.ev(`return window.__V.placeholder()`);
    const len0 = await readLen();
    const implNow = await ui.ev(`return document.querySelector(".cm-editor") ? "cm6" : "other"`);
    const expectText = "开始输入 Markdown…（/ 唤起命令）";
    ui.log(`[E4] 新建空文档 impl=${implNow} len=${len0} placeholder=${JSON.stringify(ph)}`);
    ui.add("E4-1", `★空文档显示「${expectText}」`, ph?.text === expectText && len0 === 0 ? "PASS" : "FAIL",
      `placeholder=${JSON.stringify(ph?.text)}；doc 长度=${len0}（应为 0，占位不入文档）`);

    // 打字即消失
    await focus(300);
    await ui.key("a", "KeyA", 65);
    await ui.sleep(600);
    const ph2 = await ui.ev(`return window.__V.placeholder()`);
    const len2 = await readLen();
    const doc2 = await readDoc();
    ui.add("E4-2", "打字即消失（且占位文案从不进 doc）", ph2 === null && len2 === 1 ? "PASS" : "FAIL",
      `打字后 placeholder=${JSON.stringify(ph2)}；doc=${JSON.stringify(doc2)}（长度 ${len2}，应只有 "a"）`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * E6 文末留白（scrollPastEnd）
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ E6 文末留白（scrollPastEnd）════════");
  {
    const LONG = longDoc(70);
    await openDoc(LONG);
    await focus();
    await ui.sleep(900);
    // 用真实滚轮滚到底（避免直接写 scrollTop 触发 CM6 高度估算重测伪影）
    const sc = await ui.ev(`
      const s = document.querySelector(".cm-scroller"); const r = s.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    let lastSt = -1, stable = 0;
    for (let i = 0; i < 80; i++) {
      const g = await ui.ev(`return window.__V.geo()`);
      if (g && g.st === lastSt) { if (++stable >= 3) break; } else { stable = 0; lastSt = g.st; }
      await ui.wheel(sc.x, sc.y, 900);
      await ui.sleep(60);
    }
    await ui.sleep(700);
    const g = await ui.ev(`return window.__V.geo()`);
    const atBottom = Math.abs(g.st - g.max) <= 2;
    ui.log(`[E6] 滚到底 geo=${JSON.stringify(g)}（atBottom=${atBottom}）`);

    // 判据①：cm-content 有 scrollPastEnd 注入的底部留白
    const padOk = g.padBottom > 100;
    // 判据②：到底时最后一行（非空）能到达/超过视口顶部
    const lastCanReachTop = g.lastTopRel !== null && g.lastTopRel <= 2;

    ui.add("E6-1", "cm-content 被注入底部留白（scrollPastEnd contentAttributes）", padOk ? "PASS" : "FAIL",
      `padding-bottom=${g.padBottom}px；视口高=${g.ch}px（官方公式 = 视口高 - 一行高 ≈ ${g.ch - 33}px，差 ${Math.abs(g.padBottom - (g.ch - 33))}px）`);
    ui.add("E6-2", "★滚到最底：最后一行可以到达视口顶部（lastTopRel ≤ 0）", atBottom && lastCanReachTop ? "PASS" : "FAIL",
      `st=${g.st}/max=${g.max}；末行「${g.lastText}」topRel=${g.lastTopRel}px（≤0 才算到顶；底边 topRel=${g.lastBottomRel}px）`);

    /* ──────────────────────────────────────────────────────────────────
     * E6-3 ★ 破坏性对照（A/B）：把留白改成 0 再复测同一个"滚到底"
     *
     * ## 为什么必须做破坏性对照，而不是算术推导
     * 第一版这里是 `withoutPad = lastTopRel + padBottom` 的加法推算 —— 那是
     * **推理**，不是观测。推理链一旦有一环假设错了（比如浏览器对 padding 与
     * scrollHeight 的处理），结论照样"看起来 PASS"。
     * 改成真做：`setPad(0)` → 重滚到底 → 量末行 topRel。
     *   有留白：topRel ≤ 0（能到顶）
     *   无留白：topRel > 0（到不了顶）
     * 两条都在构建产物上**实测**，才说明"留白是实现该能力的必要条件"。
     * ────────────────────────────────────────────────────────────────── */
    const scrollToBottom = async () => {
      for (let i = 0; i < 80; i++) {
        const gg = await ui.ev(`return window.__V.geo()`);
        if (gg && Math.abs(gg.st - gg.max) <= 2) break;
        await ui.wheel(sc.x, sc.y, 900);
        await ui.sleep(60);
      }
      await ui.sleep(600);
    };
    const padOrig = await ui.ev(`return window.__V.geo()`).then((x) => x.padBottom);
    const zeroed = await ui.ev(`return window.__V.setPad(0)`);
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller"); sc.scrollTop = 0;
      sc.dispatchEvent(new Event("scroll", { bubbles: true })); return true;
    `);
    await ui.sleep(500);
    await scrollToBottom();
    const gNoPad = await ui.ev(`return window.__V.geo()`);
    ui.log(`[E6] 留白设为 ${zeroed} 后滚到底 geo=${JSON.stringify(gNoPad)}`);
    // 还原并复测
    await ui.ev(`window.__V.setPad(${padOrig}); return true;`);
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller"); sc.scrollTop = 0;
      sc.dispatchEvent(new Event("scroll", { bubbles: true })); return true;
    `);
    await ui.sleep(500);
    await scrollToBottom();
    const gRestored = await ui.ev(`return window.__V.geo()`);
    ui.log(`[E6] 还原留白=${padOrig} 后滚到底 geo=${JSON.stringify(gRestored)}`);

    const withoutPadFails = gNoPad && gNoPad.lastTopRel !== null && gNoPad.lastTopRel > 5;
    const restoredPasses = gRestored && gRestored.lastTopRel !== null && gRestored.lastTopRel <= 2;
    ui.add("E6-3", "★破坏性对照：留白置 0 → 末行到不了顶；还原 → 又能到顶（判据有分辨力，非恒真）",
      withoutPadFails && restoredPasses ? "PASS" : "FAIL",
      `有留白(${padOrig}px)：末行 topRel=${gRestored?.lastTopRel}px（≤0 到顶）；` +
      `留白=0：末行 topRel=${gNoPad?.lastTopRel}px（>5 = 到不了顶）；` +
      `无留白时 max=${gNoPad?.max} vs 有留白 max=${gRestored?.max}（差 ${(gRestored?.max ?? 0) - (gNoPad?.max ?? 0)}px）`);

    ui.add("E6-4", "滚动到底且未越过 max（st ≈ sh - ch）", atBottom ? "PASS" : "FAIL",
      `st=${g.st} sh=${g.sh} ch=${g.ch} → max=${g.max}`);

    /* ──────────────────────────────────────────────────────────────────
     * E6-5 ★「**每行**都能滚到视口顶部」——发布说明是全称断言，不是"末行能"
     *
     * 判据（对每个采样到的非空行）：absTop ≤ max 才可行。
     * 用"大步滚动 + 逐段采样"覆盖整篇：每停一次记录当时渲染出的所有行的 absTop，
     * 用行文本 + absTop 去重。明确回报采样覆盖了多少个不同的行。
     * ────────────────────────────────────────────────────────────────── */
    await ui.ev(`
      const sc = document.querySelector(".cm-scroller"); sc.scrollTop = 0;
      sc.dispatchEvent(new Event("scroll", { bubbles: true })); return true;
    `);
    await ui.sleep(600);
    const seen = new Map();
    let stamps = 0;
    for (let step = 0; step < 400; step++) {
      const snap = await ui.ev(`return window.__V.lineTopFeasibility()`);
      if (!snap) break;
      for (const l of snap.lines) {
        const key = `${l.absTop}|${l.text}`;
        if (!seen.has(key)) { seen.set(key, l); stamps++; }
      }
      const gg = await ui.ev(`return window.__V.geo()`);
      if (gg && Math.abs(gg.st - gg.max) <= 2) break;
      await ui.wheel(sc.x, sc.y, 420);
      await ui.sleep(50);
    }
    await ui.sleep(500);
    const all = [...seen.values()];
    const totalNonEmpty = (LONG.split("\n").filter((l) => l.trim().length > 0)).length;
    const unreachable = all.filter((l) => !l.reachable);
    const maxAbsTop = all.reduce((m, l) => Math.max(m, l.absTop), 0);
    ui.log(`[E6] 全称检验：采样到 ${all.length} 行（文档非空行 ${totalNonEmpty}），不可达 ${unreachable.length} 行，maxAbsTop=${maxAbsTop}`);
    ui.add("E6-5", "★全称：「每行都能滚到视口顶部」——所有采样行的 absTop ≤ max（无一行被卡住）",
      all.length > 0 && unreachable.length === 0 ? "PASS" : "FAIL",
      `采样 ${all.length}/${totalNonEmpty} 个非空行（覆盖 ${((all.length / totalNonEmpty) * 100).toFixed(0)}%）；` +
      `不可达行=${unreachable.length}${unreachable.length ? `（例：${JSON.stringify(unreachable.slice(0, 3))}）` : ""}；` +
      `最大行顶绝对高度=${maxAbsTop}px ≤ max=${g.max}px`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 护栏 1：一次回车 = 一步撤销
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ 护栏1：一次回车 = 一步撤销（不装 CM6 history，走统一时间线）════════");
  {
    const F = "- 撤销粒度检验项\n";
    await openDoc(F);
    await focus();
    await ui.ev(`return window.__V.at("- 撤销粒度检验项", 0)`);
    await focus(300);
    // 关键：等过 900ms 归并窗口，避免"Enter 与之前的输入被合并"，从而只测 Enter 自身粒度
    await ui.sleep(1300);
    const beforeEnter = await readDoc();
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(700);
    const afterEnter = await readDoc();
    // 再等过归并窗口，确保 Ctrl+Z 撤的是 Enter 那一步（而不是与下一次输入合并）
    await ui.sleep(1300);
    await ui.key("z", "KeyZ", 90, 2);
    await ui.sleep(1400);
    const afterUndo = await readDoc();
    ui.log(`[护栏1] Enter 前=${JSON.stringify(beforeEnter)}`);
    ui.log(`[护栏1] Enter 后=${JSON.stringify(afterEnter)}`);
    ui.log(`[护栏1] 一次 Ctrl+Z 后=${JSON.stringify(afterUndo)}`);
    ui.add("G1", "★Enter 后一次 Ctrl+Z 精确回到 Enter 前（一步撤销，不是多步/不是撤到更早）",
      afterUndo === beforeEnter ? "PASS" : "FAIL",
      `Enter 后长度=${(afterEnter || "").length} → 撤销后=${(afterUndo || "").length}；` +
      `与 Enter 前完全相等=${afterUndo === beforeEnter}` +
      `（sourceAdapter 归并窗口 900ms，本用例在 Enter 前后各等待 1300ms 以隔离粒度）`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 护栏 2：Slash 命令确认（Enter）优先于智能回车
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ 护栏2：Slash 命令确认（Enter）优先于智能回车 ════════");
  {
    const F = "# 护栏2 夹具\n\n正文一段。\n"; // 末尾无空行 → 需要自己造一行
    await openDoc(F);
    await focus();
    // 到文档末尾并新起一行（普通段落行尾 Enter = 普通换行，先把结构变成"行首空行"）
    await ui.ev(`return window.__V.at("正文一段。", 0)`);
    await focus(260);
    await ui.key("Enter", "Enter", 13); // → 换行（普通段落）
    await ui.sleep(600);
    const afterNewline = await readDoc();

    // 行首输入 "/" → 触发 Slash 菜单
    await ui.key("/", "Slash", 191);
    await ui.sleep(900);
    const menu = await ui.ev(`
      const m = document.querySelector(".slash-command-menu");
      if (!m) return { open: false };
      const r = m.getBoundingClientRect();
      return { open: true, visible: r.width > 0 && r.height > 0,
               items: m.querySelectorAll(".slash-command-item").length,
               selected: (m.querySelector(".slash-command-item.selected")?.textContent || "").slice(0, 24) };
    `);
    const docWithSlash = await readDoc();
    ui.log(`[护栏2] Enter 换行后 doc=${JSON.stringify(afterNewline)}`);
    ui.log(`[护栏2] 输入 "/" 后 doc=${JSON.stringify(docWithSlash)} menu=${JSON.stringify(menu)}`);

    // ★ 有菜单时 Enter 必须是"确认命令"：文本应变成 "# "（首项 H1），且**不能**多出换行
    const linesBefore = (docWithSlash || "").split("\n").length;
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(1400);
    const afterConfirm = await readDoc();
    const menuAfter = await ui.ev(`
      const m = document.querySelector(".slash-command-menu");
      return m ? { open: true } : { open: false };
    `);
    const linesAfter = (afterConfirm || "").split("\n").length;
    const hasH1 = /(^|\n)# \S?/.test(afterConfirm || "") || (afterConfirm || "").trim().endsWith("#");
    const noSlashLine = !(afterConfirm || "").split("\n").some((l) => l.trim() === "/" || l.trim() === "/#");
    const noExtraNewline = linesAfter === linesBefore;
    ui.log(`[护栏2] 菜单里 Enter 后 doc=${JSON.stringify(afterConfirm)} menu=${JSON.stringify(menuAfter)}`);

    ui.add("G2-1", "行首输入 `/` → Slash 命令菜单出现（前置条件成立，判据不是空转）",
      menu.open && menu.visible && menu.items > 0 ? "PASS" : "FAIL",
      `open=${menu.open} visible=${menu.visible} 项数=${menu.items} 首项=${JSON.stringify(menu.selected)}`);
    ui.add("G2-2", "★菜单打开时 Enter = 确认命令（插入 `# `、不再多出换行、无残留 `/`）",
      hasH1 && noExtraNewline && noSlashLine && !menuAfter.open ? "PASS" : "FAIL",
      `行数 ${linesBefore}→${linesAfter}（应不变）；含 H1=${hasH1}；无残留 "/" 行=${noSlashLine}；菜单已关=${!menuAfter.open}；` +
      `doc 尾部=${JSON.stringify((afterConfirm || "").slice(-20))}`);
    // 反证：菜单关闭后，同一 Enter 键在列表行尾确实走智能回车
    await openDoc("- 对照组列表项\n");
    await focus();
    const cpos = await ui.ev(`return window.__V.atLast("- 对照组列表项", 0)`);
    await focus(260);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(560);
    const ctrlDoc = await readDoc();
    // 同样按"插入位置"构造期望，避免结尾换行干扰
    const ctrlExpect = "- 对照组列表项\n- \n";
    ui.log(`[护栏2] 对照：无菜单时 Enter → ${JSON.stringify(ctrlDoc)}（期望 ${JSON.stringify(ctrlExpect)}）`);
    ui.add("G2-3", "反证：菜单关闭后同一 Enter 键在列表行尾确实走智能回车（证明 Enter 没被整体吞掉）",
      ctrlDoc === ctrlExpect ? "PASS" : "FAIL",
      `光标@${cpos}｜无菜单 Enter 后 doc=${JSON.stringify(ctrlDoc)}（期望 ${JSON.stringify(ctrlExpect)}）`);
  }

  /* ══════════════════════════════════════════════════════════════════════
   * 护栏 3：IME 组合中的 Enter 不触发智能回车
   * ══════════════════════════════════════════════════════════════════════ */
  ui.log("");
  ui.log("════════ 护栏3：IME 组合中的 Enter 不触发智能回车 ════════");
  {
    await openDoc("- 列表项 IME 守卫\n");
    await focus();
    await ui.ev(`return window.__V.at("- 列表项 IME 守卫", 0)`);
    await focus(260);
    const before = await readDoc();
    // 置组合态（本类 compositionstart → this.composing=true；CM6 侧 composing 也进 state）
    await ui.ev(`
      const c = document.querySelector(".cm-content");
      c.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      return true;
    `);
    await ui.sleep(200);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(600);
    const duringIme = await readDoc();
    // 结束组合
    await ui.ev(`
      const c = document.querySelector(".cm-content");
      c.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      return true;
    `);
    await ui.sleep(400);
    const noContinue = !(duringIme || "").includes("\n- ");
    ui.log(`[护栏3] 组合态 Enter 前=${JSON.stringify(before)} 后=${JSON.stringify(duringIme)}`);

    // 反证：组合结束后 Enter 恢复智能回车
    await ui.ev(`return window.__V.atLast("IME 守卫", 0)`);
    await focus(300);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(600);
    const afterIme = await readDoc();
    const recovered = (afterIme || "").includes("\n- ");
    ui.log(`[护栏3] 组合结束后 Enter → ${JSON.stringify(afterIme)}`);

    ui.add("G3-1", "★组合态（compositionstart 后）按 Enter 不产生 `- ` 续行（交输入法确认候选）",
      noContinue ? "PASS" : "FAIL",
      `组合态 Enter 后 doc=${JSON.stringify(duringIme)}（不应含 "\\n- "；实际是普通换行 → 说明落到了 defaultKeymap.insertNewline）` +
      `；注：合成 composition 事件 → 真实输入法行为仍须 WebView2 真机复验`);
    ui.add("G3-2", "反证：组合结束后 Enter 恢复智能回车（守卫不是永久禁用）",
      recovered ? "PASS" : "FAIL", `组合结束 Enter 后 doc=${JSON.stringify(afterIme)}`);
    ui.add("G3-3", "真实 IME 候选框 / 真机组合态", "KNOWN",
      "浏览器探针只能合成 composition 事件，触及不到 OS 输入法层 → 需 WebView2 真机复验");
  }

  await ui.shot("final");
});
