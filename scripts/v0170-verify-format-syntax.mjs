/**
 * LightMD v0.17.0 复核 —— **B 流：格式工具栏 25 键 + 语法辅助栏 32 项** 逐项实测
 *
 * 探针：scripts/v0170-verify-format-syntax.mjs
 * 产物：_verify-out/v0170-verify-format-syntax.{json,txt} + shots/
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## 本探针的判定口径（为什么不"点了没报错"就算 PASS）
 *
 * 每一项都要求 **源码面全文 === 精确预期文本**（逐字符相等），
 * 不用「文本变长了」「包含某个标记」这类宽松判据。
 *
 * 依据：本项目上一轮 `v0170-probe-cm6.mjs:571` 就是因为用了
 * `text.includes("XYZ") || text.length > 178` 的兜底 OR，而 DOC 恰好 178 字符，
 * 于是把「只落地 1 个字符」判成了 PASS（见 Lead 通报的方法论教训）。
 * 本探针所有断言都是 `actual === expected` 的**精确相等**，无 OR 兜底。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## 对 Lead 通报 P0-1（每输入 1 字符焦点丢失 / CM6 被整体重建）的规避
 *
 * 机制（已复读源码确认）：`EditorContainer.tsx` 的 callback ref
 *   const sourceHostRef = useCallback((el) => {...mount/destroy...}, [sourceSurface, content]);
 * 的依赖含 `content` → 每次内容变化都 destroy + mount 一次 CM6 → **旧 EditorView 实例被丢弃**。
 *
 * 对本探针的影响与对策：
 * 1. 每个用例前都用 `view.dispatch(全文替换)` 复位文档 —— 这本身会触发一次重建。
 *    因此**复位之后必须重新取 view 实例**（不能缓存），否则拿到的 selection 来自已销毁实例。
 * 2. 「设选区 → 点按钮」必须在**同一次页面求值内原子完成**：
 *    `queryView() → dispatch(selection) → 读回校验 → .click()`。
 *    中间不留任何 await，避免被别处的 debounce 重建把实例换掉。
 * 3. 每个用例都断言两件事：复位成功（doc === DOC）与选区设置成功（state.selection 命中预期区间）；
 *    任一不成立就重试，重试仍失败记为 INVALID 而**不记 FAIL** —— 以免把 P0 的干扰
 *    误判成"按钮失效"。
 * 4. 工具栏按钮用**真实 CDP 鼠标点击**（含 mouseMoved/Pressed/Released），
 *    不用 `.click()`：真实点击会经历 mousedown→blur 链路，与用户操作等价。
 *    （实测：blur 不会清掉 CM6 的 state.selection，所以按钮仍能读到点击前选区。）
 *
 * ## 不修改 src/、不 commit、不 taskkill /IM lightmd.exe
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { runProbe } from "./_lib/probe-harness.mjs";

/* ───────────────── 测试文档（每个用例前都会复位成它） ───────────────── */

/**
 * 选材说明：
 * - 第 1 行带 `# ` 前缀 → 供「标题按钮作用于已标题行」的破坏性对照（DC2）；
 * - `alpha HELLO beta` → 行内格式的选区目标（HELLO 是唯一出现，索引可精确算）；
 * - `候选段落丙` 独占一行 → 块级前缀类（ul/ol/quote/codeblock）的整段选区目标；
 * - `第二段落文字` 独占一行 → 光标定位目标（标题/插入类）；
 * - 末尾 `末行` → 追加类（math/hr/table）的光标落点（DOC.length）。
 */
const DOC = [
  "# 标题行原有内容",
  "",
  "alpha HELLO beta",
  "",
  "候选段落丙",
  "",
  "第二段落文字",
  "",
  "- 列表甲",
  "- 列表乙",
  "",
  "末行",
].join("\n");

const NL = "\n";
const idx = (s) => {
  const i = DOC.indexOf(s);
  if (i < 0) throw new Error(`探针自检失败：DOC 里找不到「${s}」`);
  return i;
};
/** 把 DOC 的 [from,to) 换成 repl */
const replaceIn = (from, to, repl) => DOC.slice(0, from) + repl + DOC.slice(to);
/** 在 pos 处插入 */
const insertAt = (pos, s) => DOC.slice(0, pos) + s + DOC.slice(pos);

// 关键锚点（全部来自 DOC 实测索引，不手数）
const HELLO_FROM = idx("HELLO");
const HELLO_TO = HELLO_FROM + 5;
const PARA_FROM = idx("候选段落丙");
const PARA_TO = PARA_FROM + "候选段落丙".length;
const LINE2_FROM = idx("第二段落文字");
const LINE2_TO = LINE2_FROM + "第二段落文字".length;
const HEAD_FROM = idx("# 标题行原有内容");
const HEAD_TO = HEAD_FROM + "# 标题行原有内容".length;
const DOC_END = DOC.length;

/* ───────────────── 32 个语法栏条目的 insert 串（来自 SyntaxHelper.tsx） ───────────────── */
/**
 * ⚠️ 必须与 `src/components/editor/SyntaxHelper.tsx` 的 `insert` 字段逐字符一致。
 * DOM 里只有 `code`（展示用样例，如 `**...**`），**不是**实际插入串（`****`）——
 * 所以不能从 DOM 反推，只能按源码建表。顺序与 DOM 中 `.syntax-helper-item` 顺序一致。
 */
const SYNTAX_INSERTS = [
  /* 0  一级标题   */ "# ",
  /* 1  二级标题   */ "## ",
  /* 2  三级标题   */ "### ",
  /* 3  粗体       */ "****",
  /* 4  斜体       */ "**",
  /* 5  粗斜体     */ "******",
  /* 6  删除线     */ "~~~~",
  /* 7  行内代码   */ "``",
  /* 8  代码块     */ NL + "```" + NL + NL + "```" + NL,
  /* 9  JS 代码块  */ NL + "```javascript" + NL + NL + "```" + NL,
  /* 10 Python     */ NL + "```python" + NL + NL + "```" + NL,
  /* 11 HTML       */ NL + "```html" + NL + NL + "```" + NL,
  /* 12 TypeScript */ NL + "```typescript" + NL + NL + "```" + NL,
  /* 13 Go         */ NL + "```go" + NL + NL + "```" + NL,
  /* 14 Rust       */ NL + "```rust" + NL + NL + "```" + NL,
  /* 15 Java       */ NL + "```java" + NL + NL + "```" + NL,
  /* 16 C++        */ NL + "```cpp" + NL + NL + "```" + NL,
  /* 17 SQL        */ NL + "```sql" + NL + NL + "```" + NL,
  /* 18 JSON       */ NL + "```json" + NL + NL + "```" + NL,
  /* 19 YAML       */ NL + "```yaml" + NL + NL + "```" + NL,
  /* 20 Bash       */ NL + "```bash" + NL + NL + "```" + NL,
  /* 21 Markdown   */ NL + "```markdown" + NL + NL + "```" + NL,
  /* 22 PHP        */ NL + "```php" + NL + NL + "```" + NL,
  /* 23 无序列表   */ "- ",
  /* 24 有序列表   */ "1. ",
  /* 25 任务列表   */ "- [ ] ",
  /* 26 已完成任务 */ "- [x] ",
  /* 27 引用       */ "> ",
  /* 28 链接       */ "[](url)",
  /* 29 图片       */ "![](url)",
  /* 30 分割线     */ NL + "---" + NL,
  /* 31 表格       */ NL + "| 列1 | 列2 | 列3 |" + NL + "|------|------|------|" + NL + "| 内容 | 内容 | 内容 |" + NL,
];

await runProbe(
  {
    name: "v0170-verify-format-syntax",
    doc: DOC,
    docTitle: "候选段落丙",
    viewMode: "edit",
  },
  async (ui) => {
    const ev = ui.ev;

    /* ══════════════════════ 基础工具 ══════════════════════ */

    /** 页内安装工具集（每次重建后仍可用，因为全部现取 view） */
    await ev(`
      window.__FS = {
        view() {
          const c = document.querySelector(".cm-content");
          return (c && c.cmTile && c.cmTile.root && c.cmTile.root.view) || null;
        },
        doc() { const v = this.view(); return v ? v.state.doc.toString() : null; },
        sel() {
          const v = this.view(); if (!v) return null;
          const m = v.state.selection.main;
          return { from: m.from, to: m.to, empty: m.empty };
        },
        /** 全文复位（会触发一次 CM6 重建，调用方必须重新取 view） */
        reset(text) {
          const v = this.view(); if (!v) return { ok: false, why: "no view" };
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
          return { ok: true, len: v.state.doc.length };
        },
        /** 按 title 前缀找格式栏按钮 */
        btn(prefix) {
          const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
          return bs.find(b => (b.getAttribute("title") || "").startsWith(prefix)) || null;
        },
        ghostCount() { return document.querySelectorAll(".cm-source-ghost").length; },
        ghostText() {
          const g = document.querySelector(".cm-source-ghost");
          return g ? (g.textContent || "") : null;
        },
      };
      return true;
    `);

    const $doc = () => ev(`return window.__FS.doc();`);
    const $ghost = () => ev(`return { n: window.__FS.ghostCount(), t: window.__FS.ghostText() };`);

    /** 复位文档；同时校验复位真的成功（不满足就重试） */
    const resetDoc = async () => {
      for (let i = 0; i < 3; i++) {
        await ev(`return window.__FS.reset(${JSON.stringify(DOC)});`);
        await ui.sleep(520);
        const t = await $doc();
        if (t === DOC) return true;
      }
      return false;
    };

    /**
     * ⚠️ 原子操作：取 view → 设选区 → 读回校验 → 点按钮。**中间无 await**。
     * 这是规避 P0-1 重建竞态的唯一可靠方式。
     *
     * @param from/to CM6 文档偏移
     * @param clicker 页内表达式，返回 true 表示"点击已派发"
     */
    const selectAndRun = async (from, to, clickerBody) =>
      await ev(`
        const v = window.__FS.view();
        if (!v) return { ok: false, why: "no view" };
        v.focus();
        v.dispatch({ selection: { anchor: ${from}, head: ${to} }, scrollIntoView: false });
        const m = v.state.selection.main;
        const got = { from: Math.min(m.from, m.to), to: Math.max(m.from, m.to) };
        if (got.from !== ${from} || got.to !== ${to}) {
          return { ok: false, why: "selection mismatch", got, want: { from: ${from}, to: ${to} } };
        }
        ${clickerBody}
        return { ok: true, got };
      `);

    /** 真实鼠标点击某个元素（按选择器，每次重新量坐标） */
    const mouseClickSel = async (selector, label) => {
      const box = await ev(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { zero: true, w: r.width, h: r.height };
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box || box.zero) return { ok: false, why: box ? "zero-size" : "not found", box };
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return { ok: true, box, label };
    };

    /** 真实鼠标点击格式栏某按钮（title 前缀） */
    const clickFormatBtn = async (titlePrefix) => {
      const box = await ev(`
        const b = window.__FS.btn(${JSON.stringify(titlePrefix)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { zero: true };
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box) return { ok: false, why: `按钮未找到: ${titlePrefix}` };
      if (box.zero) return { ok: false, why: `按钮不可见（0 尺寸）: ${titlePrefix}` };
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      return { ok: true, box };
    };

    /** 通用断言：actual === expected 才算 PASS；否则把差异位置报出来 */
    const assertExact = (actual, expected) => {
      if (actual === expected) return { pass: true };
      let at = -1;
      const n = Math.min((actual || "").length, expected.length);
      for (let i = 0; i < n; i++) if (actual[i] !== expected[i]) { at = i; break; }
      if (at === -1) at = n;
      return {
        pass: false,
        at,
        got: JSON.stringify((actual || "").slice(Math.max(0, at - 25), at + 45)),
        want: JSON.stringify(expected.slice(Math.max(0, at - 25), at + 45)),
        lenGot: (actual || "").length,
        lenWant: expected.length,
      };
    };

    /** 执行一个"点击格式栏按钮"用例 */
    const formatCase = async ({ id, name, title, from, to, expected, settle = 900 }) => {
      const reset = await resetDoc();
      if (!reset) { ui.add(id, name, "KNOWN", "文档复位失败（未能进入干净基线）→ 本项测不出来"); return; }
      // 先记录"点击前"的精确基线，确保复位真的干净
      const before = await $doc();
      if (before !== DOC) { ui.add(id, name, "KNOWN", `复位后基线不等于 DOC → 本项测不出来`); return; }

      /**
       * 选区建立最多重试 2 次。
       * 原因：P0-1 下每次内容变更都会重建 CM6，若在「取 view」与「校验选区」之间
       * 恰好发生一次重建，校验会失败。这类失败是**环境干扰**，不是按钮失效，
       * 所以重试；重试仍不成才记 KNOWN（测不出来），绝不记 FAIL。
       */
      let run = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        run = await selectAndRun(from, to, "");
        if (run.ok) break;
        ui.log(`[fs] ${id} 选区建立失败（第 ${attempt + 1} 次）：${JSON.stringify(run)}`);
        await ui.sleep(300);
      }
      if (!run || !run.ok) { ui.add(id, name, "KNOWN", `选区未能建立（${JSON.stringify(run)}）→ 本项测不出来`); return; }

      // 选区建立并校验通过后，立刻真实点击（不加额外 sleep，避免被重建换掉实例）
      const click = await clickFormatBtn(title);
      if (!click.ok) {
        // 按钮找不到/不可见属于产品侧可见问题
        ui.add(id, name, "FAIL", `点击失败：${click.why}`);
        return;
      }
      await ui.sleep(settle);

      const actual = await $doc();
      const r = assertExact(actual, expected);
      if (r.pass) ui.add(id, name, "PASS", `源码精确匹配预期（${expected.length} 字符）`);
      else ui.add(id, name, "FAIL", `第 ${r.at} 字符起不同；实测 ${r.got}（len ${r.lenGot}）vs 预期 ${r.want}（len ${r.lenWant}）`);
    };

    /** 执行一个"点击语法栏第 N 项"用例 */
    const syntaxCase = async ({ id, name, index, insert }) => {
      const reset = await resetDoc();
      if (!reset) { ui.add(id, name, "KNOWN", "文档复位失败 → 本项测不出来"); return; }
      const before = await $doc();
      if (before !== DOC) { ui.add(id, name, "KNOWN", "复位后基线不等于 DOC → 本项测不出来"); return; }

      // 选区：光标放在「第二段落文字」行首（插入类最自然的落点）
      let run = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        run = await selectAndRun(LINE2_FROM, LINE2_FROM, "");
        if (run.ok) break;
        ui.log(`[fs] ${id} 光标建立失败（第 ${attempt + 1} 次）：${JSON.stringify(run)}`);
        await ui.sleep(300);
      }
      if (!run || !run.ok) { ui.add(id, name, "KNOWN", `光标未能建立（${JSON.stringify(run)}）→ 本项测不出来`); return; }

      // 真实鼠标点击该条目
      const box = await ev(`
        const items = Array.from(document.querySelectorAll(".syntax-helper .syntax-helper-item"));
        const el = items[${index}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { zero: true };
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (!box || box.zero) { ui.add(id, name, "KNOWN", "语法栏条目不可见（可能被滚动出视口）→ 本项测不出来"); return; }
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(45);
      await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await ui.sleep(800);

      const actual = await $doc();
      const expected = insertAt(LINE2_FROM, insert);
      const r = assertExact(actual, expected);
      if (r.pass) ui.add(id, name, "PASS", `插入串精确匹配（${insert.length} 字符）`);
      else ui.add(id, name, "FAIL", `第 ${r.at} 字符起不同；实测 ${r.got}（len ${r.lenGot}）vs 预期 ${r.want}（len ${r.lenWant}）`);
    };

    /* ══════════════════ 0. 环境与基线自检 ══════════════════ */

    ui.log(`[fs] impl=${ui.impl}`);
    const env = await ev(`
      const vis = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        cm: vis(".cm-editor"), toolbar: vis(".source-format-toolbar"), syntax: vis(".syntax-helper"),
        btnCount: document.querySelectorAll(".source-format-toolbar .format-btn").length,
        itemCount: document.querySelectorAll(".syntax-helper .syntax-helper-item").length,
        viewOk: !!window.__FS.view(),
      };
    `);
    ui.log(`[fs] 环境: ${JSON.stringify(env)}`);
    ui.add("A0", "CM6 装配 + 25 按钮 / 32 条目齐备",
      env.cm && env.toolbar && env.syntax && env.btnCount === 25 && env.itemCount === 32 && env.viewOk ? "PASS" : "FAIL",
      `cm=${JSON.stringify(env.cm)} 按钮=${env.btnCount} 条目=${env.itemCount} view=${env.viewOk}`);

    const baseDoc = await $doc();
    ui.add("A1", "基线：源码面全文 === 测试文档（逐字符）", baseDoc === DOC ? "PASS" : "FAIL",
      baseDoc === DOC ? `${DOC.length} 字符完全一致` : `len ${baseDoc?.length} vs ${DOC.length}`);

    /* ══════════════════ 0b. 运行环境说明：CM6 实例是否会被重建（A2） ══════════════════
     *
     * ## 本条不是缺陷上报，是**测试条件说明**
     * P0-1（每次内容变更 → callback ref 依赖含 content → destroy+mount 重建 CM6 → 焦点丢失）
     * 已由 Lead 用 MutationObserver 独立确证（`_plan/v0170-p0-1-cm6-remount-focus.md`，
     * 实测 del/add=1），**不由本流重复上报**。
     *
     * 本条的唯一目的是说明：我下面 57 项是在什么环境下测出来的、以及为什么它们仍然可信。
     *
     * ## 判定手法（不依赖输入、不受骨架 `ui.key()` 影响）
     * 给当前 EditorView 实例挂一个 symbol 标记 → 做**一次内容变更**（dispatch）→ 再取 view。
     *   - 标记还在 ⇒ 同一个实例；
     *   - 标记没了 ⇒ 新实例 ⇒ 必然经历过 destroy + mount。
     * 这条与"打字落地几个字符"完全解耦，因此**不会重蹈 `ui.key()` 旧 bug 的覆辙**
     * （旧 bug：keyDown 不带 text → 一个字符都没落地 → 内容没变 → 自然不重建 →
     *  得出"实例未重建"的错误结论）。
     */
    {
      await resetDoc();
      // 未做任何变更时：实例身份应稳定（自校验，证明标记手法本身有效）
      const selfCheck = await ev(`
        const v = window.__FS.view();
        if (!v) return { ok: false };
        v.__FS_ID = "probe-" + Date.now();
        const v2 = window.__FS.view();
        return { ok: true, same: !!(v2 && v2.__FS_ID) };
      `);

      // 一次内容变更（等价于点一次格式按钮后宿主 setSourceContent 的效果）
      const changeRes = await ev(`
        const v = window.__FS.view();
        if (!v) return { ok: false };
        v.dispatch({ changes: { from: 0, to: 0, insert: "Z" } });
        return { ok: true };
      `);
      await ui.sleep(800);
      const afterChange = await ev(`
        const v = window.__FS.view();
        return { alive: !!v, kept: !!(v && v.__FS_ID) };
      `);

      ui.log(`[fs] A2 标记自校验=${JSON.stringify(selfCheck)} 变更=${JSON.stringify(changeRes)} → ${JSON.stringify(afterChange)}`);
      ui.add("A2", "（环境说明）一次内容变更后 CM6 实例是否被整体重建",
        "KNOWN",
        `未变更时标记稳定=${selfCheck.same}；一次 dispatch 变更后标记保留=${afterChange.kept}` +
        `（${afterChange.kept ? "同一实例" : "实例已被替换 ⇒ 每次内容变更都 destroy+mount，即 P0-1 机制"}）。` +
        `据此本探针全部用例采用「dispatch 复位 + 原子设选区 + 每次现取 view + 选区校验失败则重试」规避该干扰；` +
        `57 项判定因此不依赖跨重建的实例状态。P0-1 本体由 Lead 独立确证，本流不重复上报。`);
    }

    /* ══════════════════ 1. 撤销 / 恢复（按钮 #0 #1） ══════════════════ */
    {
      // 用 bold 造一次可撤销的编辑（不靠打字，避开 P0-1 的输入丢失）
      await resetDoc();
      await selectAndRun(HELLO_FROM, HELLO_TO, "");
      const boldClick = await clickFormatBtn("粗体 (");
      await ui.sleep(900);
      const withBold = await $doc();
      const expectedBold = replaceIn(HELLO_FROM, HELLO_TO, "**HELLO**");
      const boldOk = withBold === expectedBold;
      ui.log(`[fs] undo 前置：bold 生效=${boldOk}`);

      if (!boldOk) {
        ui.add("B1", "撤销按钮：真改文档后可撤销回原状", "KNOWN", `前置 bold 未生效（${JSON.stringify((withBold || "").slice(0, 50))}）→ 本项测不出来`);
        ui.add("B2", "恢复按钮：撤销后可恢复", "KNOWN", "前置条件未建立 → 本项测不出来");
      } else {
        // 点撤销
        await clickFormatBtn("撤销 (");
        await ui.sleep(900);
        const afterUndo = await $doc();
        const r1 = assertExact(afterUndo, DOC);
        ui.add("B1", "撤销按钮：真改文档后可撤销回原状", r1.pass ? "PASS" : "FAIL",
          r1.pass ? "撤销后 === 原文档（逐字符）" : `撤销后 != 原文档；实测 ${r1.got} vs 预期 ${r1.want}`);

        // 点恢复
        await clickFormatBtn("恢复 (");
        await ui.sleep(900);
        const afterRedo = await $doc();
        const r2 = assertExact(afterRedo, expectedBold);
        ui.add("B2", "恢复按钮：撤销后可恢复到撤销前", r2.pass ? "PASS" : "FAIL",
          r2.pass ? "恢复后 === 撤销前文本（逐字符）" : `恢复后 != 撤销前；实测 ${r2.got} vs 预期 ${r2.want}`);
      }
    }

    /* ══════════════════ 2. 格式刷（按钮 #2） ══════════════════
     *
     * ⚠️ 用例设计教训（本探针第一版在这里踩过一次，记录以免他人重蹈）：
     *   `collectSourceSnapshot` 采集的是**选中文本自身的包裹符号**（`**abc**` → marks:["strong"]），
     *   而不是"这段文字在渲染后看起来是不是粗体"。所以从**裸 `HELLO`**（无任何符号）采集
     *   得到的是 `{ marks: [], blockType: "paragraph" }` → 套用到另一个普通段落时
     *   `applyBlockTypeToLine` 返回 null、marks 为空 → **本来就不该有任何变化**。
     *   第一版因此判 FAIL，实为**预期写错**，不是产品缺陷。
     *
     * 正确链路（与 Word 语义一致，也与源码注释"选中范围含符号形态"一致）：
     *   造 `**HELLO**` → 选中**带符号整段** `**HELLO**` → 采集到 strong
     *   → 点目标行 → 目标行被 `**…**` 包裹。
     */
    {
      // ── (a) 有选区时点击 → 必须进入 armed 态 ──
      await resetDoc();
      // 先造 `**HELLO**`，这样采集才有内容可取
      await selectAndRun(HELLO_FROM, HELLO_TO, "");
      await clickFormatBtn("粗体 (");
      await ui.sleep(900);
      const withBold = await $doc();
      const W_FROM = HELLO_FROM;                       // "**HELLO**" 起始
      const W_TO = HELLO_FROM + "**HELLO**".length;    // 含尾部 **
      const boldReady = withBold === replaceIn(HELLO_FROM, HELLO_TO, "**HELLO**");
      ui.log(`[fs] 格式刷前置：**HELLO** 就绪=${boldReady}`);

      if (!boldReady) {
        ui.add("B3", "格式刷：有选区时点击 → 进入 armed 态", "KNOWN", "前置粗体未建立 → 测不出来");
        ui.add("B4", "格式刷：armed 后点目标行 → 套用采到的格式", "KNOWN", "前置未建立 → 测不出来");
        ui.add("B5", "格式刷：once 应用一次后自动退出 armed", "KNOWN", "前置未建立 → 测不出来");
      } else {
        await selectAndRun(W_FROM, W_TO, "");
        await clickFormatBtn("格式刷（");
        await ui.sleep(700);
        const armed = await ev(`
          return {
            body: document.body.classList.contains("format-painter-armed"),
            active: Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"))
              .filter(b => b.classList.contains("active")).length,
          };
        `);
        ui.log(`[fs] 格式刷 armed: ${JSON.stringify(armed)}`);
        ui.add("B3", "格式刷：有选区时点击 → 进入 armed 态（body.format-painter-armed + 按钮 active）",
          armed.body && armed.active === 1 ? "PASS" : "FAIL",
          `body.format-painter-armed=${armed.body} active=${armed.active}`);

        // ── (b) armed 后点目标行 → 套用格式（效果验证）──
        const targetBox = await ev(`
          const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").trim() === "第二段落文字");
          if (!line) return null;
          const r = line.getBoundingClientRect();
          return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height/2) };
        `);
        let painterApplied = false;
        let painterDetail = "找不到目标行坐标";
        let stillArmed = null;
        if (targetBox) {
          await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: targetBox.x, y: targetBox.y });
          await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: targetBox.x, y: targetBox.y, button: "left", clickCount: 1 });
          await ui.sleep(45);
          await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: targetBox.x, y: targetBox.y, button: "left", clickCount: 1 });
          await ui.sleep(1000);
          const t = await $doc();
          const expected = withBold.replace("第二段落文字", "**第二段落文字**");
          painterApplied = t === expected;
          painterDetail = painterApplied
            ? "目标行精确变为 **第二段落文字**"
            : `实测 ${JSON.stringify((t || "").slice(0, 80))} vs 预期 ${JSON.stringify((expected || "").slice(0, 80))}`;
          stillArmed = await ev(`return document.body.classList.contains("format-painter-armed");`);
        }
        ui.add("B4", "格式刷：armed 后点目标行 → 该行被套用采到的格式（逐字符精确匹配）",
          painterApplied ? "PASS" : "FAIL", painterDetail);
        ui.add("B5", "格式刷：单击（once）应用一次后自动退出 armed",
          stillArmed === false ? "PASS" : (stillArmed === null ? "KNOWN" : "FAIL"),
          stillArmed === null ? "未建立 armed 前置" : `仍 armed=${stillArmed}`);

        // ── (c) 破坏性对照：未 armed 时点正文 → 不得改动文档 ──
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;`);
        await ui.sleep(400);
        const beforeCasual = await $doc();
        const box2 = await ev(`
          const line = Array.from(document.querySelectorAll(".cm-line")).find(l => (l.textContent||"").trim() === "第二段落文字");
          if (!line) return null;
          const r = line.getBoundingClientRect();
          return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height/2) };
        `);
        if (box2) {
          await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box2.x, y: box2.y });
          await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box2.x, y: box2.y, button: "left", clickCount: 1 });
          await ui.sleep(45);
          await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box2.x, y: box2.y, button: "left", clickCount: 1 });
          await ui.sleep(900);
        }
        const afterCasual = await $doc();
        ui.add("B6", "破坏性对照：未 armed 时点正文 → 文档不得被改动（证明 B4 的差异来自格式刷）",
          afterCasual === beforeCasual ? "PASS" : "FAIL",
          afterCasual === beforeCasual ? "文本未变" : "文本被改动（格式刷误触发）");
      }

      // 清理 armed 态
      await ev(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;`);
      await ui.sleep(400);
    }

    /* ══════════════════ 3. 标题 H1~H6（按钮 #3~#8） ══════════════════ */
    // 语义：h1~h6 在 handleFormatAction 里被归一化为 heading1~6 → 走 setLinePrefix，
    //       即「作用于光标所在行的行首」，不是把选区替换成 "# 选区"。
    for (let lv = 1; lv <= 6; lv++) {
      const title = ["一", "二", "三", "四", "五", "六"][lv - 1];
      const prefix = "#".repeat(lv) + " ";
      const expected = replaceIn(LINE2_FROM, LINE2_TO, prefix + "第二段落文字");
      await formatCase({
        id: `C${lv}`,
        name: `H${lv}：光标在该行 → 行首变成 ${prefix.trim()}（共 ${lv} 个 #）`,
        title: `标题${title} (`,
        from: LINE2_FROM,
        to: LINE2_FROM,
        expected,
      });
    }

    /* ══════════════════ 4. 行内格式（按钮 #9~#13） ══════════════════ */
    const inline = [
      ["C7", "B（粗体）：选中 HELLO → **HELLO**", "粗体 (", "**HELLO**"],
      ["C8", "I（斜体）：选中 HELLO → *HELLO*", "斜体 (", "*HELLO*"],
      ["C9", "BI（粗斜体）：选中 HELLO → ***HELLO***", "粗斜体", "***HELLO***"],
      ["C10", "S（删除线）：选中 HELLO → ~~HELLO~~", "删除线 (", "~~HELLO~~"],
      ["C11", "行内代码：选中 HELLO → `HELLO`", "行内代码 (", "`HELLO`"],
    ];
    for (const [id, name, title, wrapped] of inline) {
      await formatCase({
        id, name, title,
        from: HELLO_FROM, to: HELLO_TO,
        expected: replaceIn(HELLO_FROM, HELLO_TO, wrapped),
      });
    }

    /* ══════════════════ 5. 块级插入（按钮 #14~#18） ══════════════════ */
    // 代码块：选中 HELLO → \n```\nHELLO\n```\n
    await formatCase({
      id: "C12",
      name: "代码块：选中 HELLO → 出现 ``` 围栏 + 内容",
      title: "代码块",
      from: HELLO_FROM, to: HELLO_TO,
      expected: replaceIn(HELLO_FROM, HELLO_TO, "\n```\nHELLO\n```\n"),
    });
    // 无序列表 / 有序列表 / 引用：整段选中「候选段落丙」→ 加前缀
    await formatCase({
      id: "C13",
      name: "无序列表 •：选中整段 → 「- 候选段落丙」",
      title: "无序列表 (",
      from: PARA_FROM, to: PARA_TO,
      expected: replaceIn(PARA_FROM, PARA_TO, "- 候选段落丙"),
    });
    await formatCase({
      id: "C15",
      name: "有序列表 1.：选中整段 → 「1. 候选段落丙」",
      title: "有序列表 (",
      from: PARA_FROM, to: PARA_TO,
      expected: replaceIn(PARA_FROM, PARA_TO, "1. 候选段落丙"),
    });
    await formatCase({
      id: "C16",
      name: "引用 ❝：选中整段 → 「> 候选段落丙」",
      title: "引用 (",
      from: PARA_FROM, to: PARA_TO,
      expected: replaceIn(PARA_FROM, PARA_TO, "> 候选段落丙"),
    });

    /* ══════════════════ 6. 任务列表下拉（按钮 #14 in DOM = title「任务列表…」） ══════════════════ */
    {
      // (a) 点击按钮 → 下拉出现，两个选项可点
      await resetDoc();
      await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      const taskBtn = await ev(`
        const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = bs.find(x => (x.getAttribute("title")||"").startsWith("任务列表"));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      `);
      let dropOk = false, dropDetail = "按钮未找到";
      if (taskBtn) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: taskBtn.x, y: taskBtn.y });
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: taskBtn.x, y: taskBtn.y, button: "left", clickCount: 1 });
        await ui.sleep(45);
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: taskBtn.x, y: taskBtn.y, button: "left", clickCount: 1 });
        await ui.sleep(500);
        const d = await ev(`
          const el = document.querySelector('[data-testid="task-style-dropdown"]');
          if (!el) return { el: false };
          const r = el.getBoundingClientRect();
          return { el: true, visible: r.width > 0 && r.height > 0,
            opts: Array.from(el.querySelectorAll(".task-style-option")).map(x => x.getAttribute("data-style")) };
        `);
        dropOk = d.el && d.visible && d.opts.length === 2 && d.opts.includes("square") && d.opts.includes("circle");
        dropDetail = JSON.stringify(d);
      }
      ui.add("C14a", "任务列表：点击按钮 → 展开 2 个样式选项（方形/圆形）", dropOk ? "PASS" : "FAIL", dropDetail);

      // (b) 选「方形」→ 插入 "- [ ] "
      const sq = await ev(`
        const b = document.querySelector('[data-testid="task-style-dropdown"] .task-style-option[data-style="square"]');
        if (!b) return false; b.click(); return true;
      `);
      await ui.sleep(900);
      const afterSq = await $doc();
      const rSq = assertExact(afterSq, insertAt(LINE2_FROM, "- [ ] "));
      ui.add("C14b", "任务列表·方形：选择后插入「- [ ] 」", rSq.pass && sq ? "PASS" : "FAIL",
        rSq.pass ? "精确匹配" : `实测 ${rSq.got} vs 预期 ${rSq.want}`);

      // (c) 选「圆形」→ 插入 "* [ ] "
      await resetDoc();
      await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      const tb2 = await ev(`
        const bs = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
        const b = bs.find(x => (x.getAttribute("title")||"").startsWith("任务列表"));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      `);
      if (tb2) {
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tb2.x, y: tb2.y });
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tb2.x, y: tb2.y, button: "left", clickCount: 1 });
        await ui.sleep(45);
        await ui.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tb2.x, y: tb2.y, button: "left", clickCount: 1 });
        await ui.sleep(500);
      }
      const ci = await ev(`
        const b = document.querySelector('[data-testid="task-style-dropdown"] .task-style-option[data-style="circle"]');
        if (!b) return false; b.click(); return true;
      `);
      await ui.sleep(900);
      const afterCi = await $doc();
      const rCi = assertExact(afterCi, insertAt(LINE2_FROM, "* [ ] "));
      ui.add("C14c", "任务列表·圆形：选择后插入「* [ ] 」", rCi.pass && ci ? "PASS" : "FAIL",
        rCi.pass ? "精确匹配" : `实测 ${rCi.got} vs 预期 ${rCi.want}`);

      // 清掉可能残留的下拉
      await ev(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return true;`);
      await ui.sleep(300);
    }

    /* ══════════════════ 7. 三个对话框（按钮 #19 #20 #21） ══════════════════ */
    // 判据按简报 §3.3：link/image/table 看「对话框是否出现」，不是看文档是否变。
    const dialogs = [
      ["D1", "链接 🔗：点击 → 弹出 .link-dialog", "链接", ".link-dialog"],
      ["D2", "图片 🖼：点击 → 弹出 .image-insert-dialog", "图片", ".image-insert-dialog"],
      ["D3", "表格 ⊞：点击 → 弹出 .table-dialog", "表格 (", ".table-dialog"],
    ];
    for (const [id, name, title, sel] of dialogs) {
      await resetDoc();
      await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      const c = await clickFormatBtn(title);
      await ui.sleep(700);
      const found = await ev(`
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        return { found: true, visible: r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height) };
      `);
      ui.add(id, name, c.ok && found.found && found.visible ? "PASS" : "FAIL",
        c.ok ? JSON.stringify(found) : `点击失败：${c.why}`);
      // 关掉
      await ev(`
        const ov = document.querySelector('[class*="dialog-overlay"]');
        if (ov) ov.click();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return true;
      `);
      await ui.sleep(450);
    }

    // 链接对话框「插入」→ 源码面真的出现链接（效果验证，非仅弹窗）
    {
      await resetDoc();
      await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      await clickFormatBtn("链接");
      await ui.sleep(700);
      const filled = await ev(`
        const d = document.querySelector(".link-dialog");
        if (!d) return { ok: false };
        const inputs = Array.from(d.querySelectorAll("input"));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const set = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
        set(inputs[0], "链接文字");
        set(inputs[1], "https://example.com");
        return { ok: true, vals: inputs.map(i => i.value) };
      `);
      await ui.sleep(400);
      const ins = await ev(`
        const d = document.querySelector(".link-dialog");
        if (!d) return { ok: false };
        const b = Array.from(d.querySelectorAll("button")).find(x => x.className.includes("primary"));
        if (!b || b.disabled) return { ok: false, disabled: !!(b && b.disabled) };
        b.click(); return { ok: true };
      `);
      await ui.sleep(1000);
      const after = await $doc();
      const expected = insertAt(LINE2_FROM, "[链接文字](https://example.com)");
      const r = assertExact(after, expected);
      ui.add("D4", "链接对话框：填 URL 后点「插入」→ 源码面出现链接 Markdown",
        r.pass ? "PASS" : "FAIL",
        r.pass ? "精确匹配 [链接文字](https://example.com)" : `实测 ${r.got} vs 预期 ${r.want}（填表 ${JSON.stringify(filled)} 插入 ${JSON.stringify(ins)}）`);
    }

    /* ══════════════════ 8. Mermaid 下拉（按钮 #22） ══════════════════ */
    {
      await resetDoc();
      await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      await clickFormatBtn("Mermaid 图表");
      await ui.sleep(600);
      const menu = await ev(`
        const el = document.querySelector(".mermaid-dropdown-menu");
        if (!el) return { el: false };
        const r = el.getBoundingClientRect();
        return { el: true, visible: r.width > 0 && r.height > 0,
          items: Array.from(el.querySelectorAll(".mermaid-dropdown-item")).map(x => (x.textContent||"").trim()) };
      `);
      const menuOk = menu.el && menu.visible && menu.items.length === 7;
      ui.add("E1", "Mermaid：点击 → 展开 7 个模板项", menuOk ? "PASS" : "FAIL", JSON.stringify(menu));

      const pick = await ev(`
        const bs = Array.from(document.querySelectorAll(".mermaid-dropdown-menu .mermaid-dropdown-item"));
        const b = bs.find(x => (x.textContent||"").trim() === "Flowchart");
        if (!b) return false; b.click(); return true;
      `);
      await ui.sleep(1000);
      const after = await $doc();
      const expected = insertAt(LINE2_FROM, "\n```mermaid\ngraph TD\n    A[开始] --> B[结束]\n```\n");
      const r = assertExact(after, expected);
      ui.add("E2", "Mermaid：选 Flowchart 模板 → 源码出现 ```mermaid 围栏 + graph TD",
        r.pass && pick ? "PASS" : "FAIL",
        r.pass ? "精确匹配" : `实测 ${r.got} vs 预期 ${r.want}`);
    }

    /* ══════════════════ 9. 数学公式 / 分割线 / 表格按钮（#23 #24 #21） ══════════════════ */
    // 这三者是固定模板，插入在光标处。光标放到文档末尾（末行行尾）便于精确断言。
    const fixed = [
      ["F1", "数学公式 ∑：光标处插入 $$ 块", "数学公式 (", "\n$$\n\\sum_{i=1}^{n} x_i\n$$\n"],
      ["F2", "分割线 —：光标处插入 ---", "分割线", "\n---\n"],
    ];
    for (const [id, name, title, insert] of fixed) {
      const reset = await resetDoc();
      if (!reset) { ui.add(id, name, "KNOWN", "复位失败 → 测不出来"); continue; }
      const run = await selectAndRun(DOC_END, DOC_END, "");
      if (!run.ok) { ui.add(id, name, "KNOWN", `光标未能建立 ${JSON.stringify(run)}`); continue; }
      const c = await clickFormatBtn(title);
      await ui.sleep(900);
      const after = await $doc();
      const r = assertExact(after, insertAt(DOC_END, insert));
      ui.add(id, name, c.ok && r.pass ? "PASS" : "FAIL",
        r.pass ? "精确匹配" : (c.ok ? `实测 ${r.got} vs 预期 ${r.want}` : `点击失败 ${c.why}`));
    }

    /* ══════════════════ 10. 破坏性对照（3 项，证明探针能测出「差异」） ══════════════════ */
    // DC1：bold 无选区（仅光标）→ 只插 "****"，且 ghost 提示存在但**不落盘**
    {
      await resetDoc();
      const run = await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      await clickFormatBtn("粗体 (");
      await ui.sleep(900);
      const t = await $doc();
      const g = await $ghost();
      const expect = insertAt(LINE2_FROM, "****");
      const docOk = t === expect;
      // 关键：文档里**不能**出现占位文字
      const noPlaceholder = t !== null && !t.includes("粗体文本");
      ui.add("G1", "破坏性对照①：粗体无选区 → 只插 ****（占位「粗体文本」不落盘）",
        docOk && noPlaceholder ? "PASS" : "FAIL",
        `doc 精确匹配=${docOk} 无占位文字=${noPlaceholder} ghost装饰=${JSON.stringify(g)}`);
    }
    // DC2：H1 作用于「已经是 H1」的行 → 不应叠加成「# # 」
    {
      await resetDoc();
      const run = await selectAndRun(HEAD_FROM, HEAD_FROM, "");
      await clickFormatBtn("标题一 (");
      await ui.sleep(900);
      const t = await $doc();
      const noDouble = t === DOC; // 同级别 → setLinePrefix 剥旧前缀再加回，文本应完全不变
      const hasDouble = t !== null && t.includes("# # ");
      ui.add("G2", "破坏性对照②：H1 作用于已是 H1 的行 → 不叠加（不出现「# # 」）",
        noDouble && !hasDouble ? "PASS" : "FAIL",
        `文本不变=${noDouble} 出现双前缀=${hasDouble} 实测=${JSON.stringify((t || "").slice(0, 40))}`);
    }
    // DC3：ul 无选区 → 只插 "- "，不落盘「列表项」
    {
      await resetDoc();
      const run = await selectAndRun(LINE2_FROM, LINE2_FROM, "");
      await clickFormatBtn("无序列表 (");
      await ui.sleep(900);
      const t = await $doc();
      const expect = insertAt(LINE2_FROM, "- ");
      const docOk = t === expect;
      const noPlaceholder = t !== null && !t.includes("列表项");
      ui.add("G3", "破坏性对照③：无序列表无选区 → 只插「- 」（占位「列表项」不落盘）",
        docOk && noPlaceholder ? "PASS" : "FAIL",
        `doc 精确匹配=${docOk} 无占位文字=${noPlaceholder}`);
    }

    /* ══════════════════ 11. 语法辅助栏 32 项（逐项，不抽样） ══════════════════ */
    // 名称表：与 DOM 顺序对应（探针内部会再读一次 DOM 名字，用于报告可读性）
    const SYNTAX_NAMES = [
      "一级标题", "二级标题", "三级标题",
      "粗体", "斜体", "粗斜体", "删除线", "行内代码",
      "代码块", "JS 代码块", "Python 代码块", "HTML 代码块",
      "TypeScript", "Go", "Rust", "Java", "C++", "SQL", "JSON", "YAML", "Bash", "Markdown", "PHP",
      "无序列表", "有序列表", "任务列表", "已完成任务",
      "引用", "链接", "图片", "分割线", "表格",
    ];
    const domNames = await ev(`
      return Array.from(document.querySelectorAll(".syntax-helper .syntax-helper-item"))
        .map(el => (el.querySelector(".syntax-helper-item-name") || {}).textContent || "");
    `);
    ui.log(`[fs] DOM 条目名（${domNames.length}）: ${JSON.stringify(domNames)}`);

    for (let i = 0; i < SYNTAX_INSERTS.length; i++) {
      await syntaxCase({
        id: `S${String(i + 1).padStart(2, "0")}`,
        name: `语法栏 #${i + 1}「${SYNTAX_NAMES[i]}」→ 插入 ${JSON.stringify(SYNTAX_INSERTS[i])}`,
        index: i,
        insert: SYNTAX_INSERTS[i],
      });
    }

    /* ══════════════════ 12. 收尾：全文一致性 + 截图 ══════════════════ */
    await resetDoc();
    const finalDoc = await $doc();
    ui.add("H1", "收尾全文一致性：所有用例跑完后源码面 === 测试文档", finalDoc === DOC ? "PASS" : "FAIL",
      finalDoc === DOC ? `${DOC.length} 字符完全一致` : `len ${finalDoc?.length} vs ${DOC.length}；实测 ${JSON.stringify((finalDoc || "").slice(0, 60))}`);

    await ui.shot("final");
    ui.log(`[fs] 完成，结果见 _verify-out/v0170-verify-format-syntax.json`);
  }
);
