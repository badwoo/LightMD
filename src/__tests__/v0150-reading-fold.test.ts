// @vitest-environment jsdom
/**
 * v0.15.0 需求2（R2 阅读区标题折叠）：纯逻辑层 + 渲染适配层测试。
 *
 * 设计冻结稿 §2.5 的测试矩阵逐条对应：
 * 1. 嵌套标题 / 连续标题 / 文末收尾；
 * 2. 代码围栏内 `#`、Setext 标题、表格内 `#` 文本、块引用内标题；
 * 3. 折叠后搜索/TOC 跳转前展开祖先（`expandAncestors`）；
 * 4. 两个预览面（PM 阅读区 / iframe）状态一致（同一 headingId 集合）；
 * 5. 导出完整（折叠不改 Markdown —— 断言 `docToMarkdown` 往返不变）；
 * 6. 文档修改后按 id 复算、标题删除清理；
 * 7. iframe 注入幂等 + `body` 未就绪时重试。
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undoDepth, redoDepth } from "prosemirror-history";
import { markdownToDoc } from "../core/markdown/parser";
import { createEditor } from "../core/editor";
import { docToMarkdown } from "../core/markdown/serializer";
import { getMarkdownIt } from "../core/markdown/parser";
import { topLevelBlockStartLines } from "../core/renderPipeline";
import {
  blocksFromTokens,
  collectDocChildBlocks,
  collectHeadings,
  collapseAll,
  expandAll,
  expandAncestors,
  expandAncestorsForHeadingId,
  fallbackHeadingId,
  foldableHeadingIds,
  headingById,
  hiddenBlockIndexes,
  isBlockHidden,
  nearestVisibleAncestorHeading,
  reconcileFoldState,
  toggleFold,
  type FoldBlock,
  type HeadingInfo,
  type FoldState,
} from "../utils/headingFold";
import {
  createIframeFoldBridge,
  createReadingFoldPlugin,
  expandBeforeJumpToBlockIndex,
  expandBeforeJumpToDocPos,
  expandBeforeJumpToHeadingId,
  readingFold,
  FOLD_BTN_CLASS,
  FOLD_HEADING_ATTR,
  FOLD_HIDDEN_ATTR,
  FOLD_HIDDEN_CLASS,
  FOLD_HEADING_CLASS,
  applyReadingFoldToIframe,
  applyReadingFoldToIframeWhenReady,
  buildIframeFoldModel,
  buildPmFoldModel,
  computePmFoldDecorations,
  createFoldButton,
  createReadingFoldController,
  defaultReadingFoldLabels,
  ensureIframeFoldStyle,
  sameCollapsedSet,
  syncFoldButtonState,
  FOLD_COLLAPSED_ATTR,
  FOLD_IFRAME_CSS,
} from "../components/editor/readingFold";

/**
 * v0.15.1 需求2：折叠文案（与生产默认值同源）。
 * 抽成小助手让新用例只关心"状态/元素"，不必重复写文案。
 */
const labels = () => defaultReadingFoldLabels();

// ─── 工具 ──────────────────────────────────────────────────

/** 用真实 markdown-it（与 renderPipeline 同源）解析 markdown → 顶层块描述 */
function blocksOf(markdown: string): FoldBlock[] {
  const env: Record<string, unknown> = {};
  const tokens = getMarkdownIt(true).parse(markdown, env) as never[];
  return blocksFromTokens(tokens as never);
}

/** 便捷构造块描述数组（不含 markdown 解析，纯结构） */
function mk(types: Array<string | [string, number, string]>): FoldBlock[] {
  return types.map((item) =>
    typeof item === "string"
      ? { type: item, text: "" }
      : { type: item[0], level: item[1], text: item[2] },
  );
}

/** iframe 里的一份最小 HTML 文档（h1/h2/p/# 标题 + 代码块 + 表格） */
const SAMPLE_MD = [
  "# 一级标题",
  "",
  "正文一",
  "",
  "## 二级 A",
  "",
  "正文 A",
  "",
  "### 三级 A1",
  "",
  "正文 A1",
  "",
  "## 二级 B",
  "",
  "正文 B",
].join("\n");

function renderSampleHtml(markdown: string): string {
  return getMarkdownIt(true).render(markdown);
}

/** 建一个 iframe 文档：head + body（内容和真实预览一样） */
function makeIframeDoc(markdown: string): { doc: Document; iframe: HTMLIFrameElement } {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body>${renderSampleHtml(markdown)}</body></html>`);
  doc.close();
  return { doc, iframe };
}

function idsOf(headings: HeadingInfo[]): string[] {
  return headings.map((h) => h.id);
}

// ═════════════ ① collectHeadings：四种标题形态 + 排除项 ═════════════

describe("collectHeadings · 只认顶层 heading 块", () => {
  it("ATX 标题：级别与顺序正确", () => {
    const blocks = mk([
      ["heading", 1, "一"],
      "paragraph",
      ["heading", 2, "二"],
    ]);
    const headings = collectHeadings(blocks);
    expect(headings.map((h) => [h.level, h.blockIndex])).toEqual([
      [1, 0],
      [2, 2],
    ]);
  });

  it("真实 markdown：ATX + Setext 都被识别（Setext 由 markdown-it 归一为 heading 块）", () => {
    const md = ["# ATX 一", "", "Setext 二", "---", "", "正文"].join("\n");
    const blocks = blocksOf(md);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "paragraph"]);
    expect(blocks[1].level).toBe(2);
    expect(blocks[1].text).toBe("Setext 二");
    expect(collectHeadings(blocks).length).toBe(2);
  });

  it("Setext 的 === 归为 H1", () => {
    const blocks = blocksOf(["Setext 一", "===", "", "正文"].join("\n"));
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].level).toBe(1);
  });

  it("代码围栏内的 `#` **不是**标题（围栏整体是一个 fence 顶层块）", () => {
    const md = ["```sh", "# 这是注释不是标题", "## 也不是", "```", "", "# 真标题"].join("\n");
    const blocks = blocksOf(md);
    expect(blocks.map((b) => b.type)).toEqual(["fence", "heading"]);
    expect(idsOf(collectHeadings(blocks))).toHaveLength(1);
    expect(blocks[1].text).toBe("真标题");
    expect(collectHeadings(blocks)[0].id).toBe("真标题");
  });

  it("缩进代码块里的 `#` 不是标题", () => {
    const md = ["    # 缩进代码里的井号", "", "# 真标题"].join("\n");
    const blocks = blocksOf(md);
    expect(blocks.map((b) => b.type)).toEqual(["code_block", "heading"]);
    expect(collectHeadings(blocks)).toHaveLength(1);
  });

  it("表格单元格里的 `#` 文本不是标题（表格是单个 table 块）", () => {
    const md = ["| A | B |", "| --- | --- |", "| # 井号 | # 又一个 |", "", "# 真标题"].join("\n");
    const blocks = blocksOf(md);
    expect(blocks.map((b) => b.type)).toEqual(["table", "heading"]);
    expect(collectHeadings(blocks)).toHaveLength(1);
  });

  it("块引用内的标题不算顶层标题（设计稿口径：只认顶层块）", () => {
    const md = ["> # 引用里的标题", ">", "> 正文", "", "# 顶层标题"].join("\n");
    const blocks = blocksOf(md);
    expect(blocks.map((b) => b.type)).toEqual(["blockquote", "heading"]);
    expect(blocks[1].text).toBe("顶层标题");
    expect(collectHeadings(blocks).map((h) => h.blockIndex)).toEqual([1]);
  });

  it("列表项内的标题不算顶层标题", () => {
    const md = ["- # 项内标题", "- 普通项", "", "# 顶层标题"].join("\n");
    const blocks = blocksOf(md);
    expect(blocks.map((b) => b.type)).toEqual(["bullet_list", "heading"]);
    expect(collectHeadings(blocks)).toHaveLength(1);
  });

  it("blockIndex 与 renderPipeline 的顶层块行号表**同长**（贴标/折叠下标一致的前提）", () => {
    const docs = [
      SAMPLE_MD,
      ["```js", "const a = 1;", "```", "", "| A |", "| - |", "| 1 |"].join("\n"),
      ["> 引用", "", "---", "", "    indented"].join("\n"),
      ["- 一", "- 二", "- 三"].join("\n"),
      ["Setext", "---", "", "# ATX"].join("\n"),
    ];
    for (const md of docs) {
      expect(blocksOf(md).length).toBe(topLevelBlockStartLines(md).length);
    }
  });

  it("优先使用现成 headingId；缺失时 fallback = h<level>:<blockIndex>:<slug>", () => {
    const blocks: FoldBlock[] = [
      { type: "heading", level: 1, text: "Hello World", headingId: "hello-world" },
      { type: "heading", level: 2, text: "另一个 标题" },
    ];
    const headings = collectHeadings(blocks);
    expect(headings[0].id).toBe("hello-world");
    expect(headings[1].id).toBe(fallbackHeadingId(2, 1, "另一个 标题"));
    expect(headings[1].id.startsWith("h2:1:")).toBe(true);
  });

  it("重复 id 兜底去重（防御上层拼装错误）", () => {
    const blocks: FoldBlock[] = [
      { type: "heading", level: 1, text: "同", headingId: "same" },
      { type: "heading", level: 1, text: "同", headingId: "same" },
    ];
    expect(idsOf(collectHeadings(blocks))).toEqual(["same", "same-1"]);
  });

  it("空数组 / 无标题 → 空结果", () => {
    expect(collectHeadings([])).toEqual([]);
    expect(collectHeadings(mk(["paragraph", "fence"]))).toEqual([]);
  });
});

// ═════════════ ② hiddenBlockIndexes：折叠区间真值表 ═════════════

describe("hiddenBlockIndexes · 折叠区间", () => {
  /**
   * 结构（下标）：
   * 0 H1 一
   * 1 p
   * 2 H2 A
   * 3 p
   * 4 H3 A1
   * 5 p
   * 6 H2 B
   * 7 p
   * 8 H1 二
   * 9 p
   */
  const blocks = mk([
    ["heading", 1, "一"],
    "paragraph",
    ["heading", 2, "A"],
    "paragraph",
    ["heading", 3, "A1"],
    "paragraph",
    ["heading", 2, "B"],
    "paragraph",
    ["heading", 1, "二"],
    "paragraph",
  ]);
  const headings = collectHeadings(blocks);

  it("全展开 → 空集合", () => {
    expect(hiddenBlockIndexes(headings, blocks.length, new Set()).size).toBe(0);
  });

  it("折叠 H1#0 → 隐藏到下一个 level ≤ 1 的标题之前（文末无 H2 时收尾）", () => {
    const hidden = hiddenBlockIndexes(headings, blocks.length, new Set([headings[0].id]));
    // H1#0 → 隐藏 1..7，直到 H1#8
    expect(Array.from(hidden).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("折叠 H2 A#2 → 只影响其区间（下一个 level ≤ 2 的是 H2 B#6）", () => {
    const hidden = hiddenBlockIndexes(headings, blocks.length, new Set([headings[1].id]));
    expect(Array.from(hidden).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });

  it("折叠 H3 A1#4 → 到下一个 level ≤ 3 即 H2 B#6，只藏 1 个块", () => {
    const hidden = hiddenBlockIndexes(headings, blocks.length, new Set([headings[2].id]));
    expect(Array.from(hidden)).toEqual([5]);
  });

  it("嵌套折叠（H1#0 + H2 B#6）取并集", () => {
    const hidden = hiddenBlockIndexes(
      headings,
      blocks.length,
      new Set([headings[0].id, headings[3].id]),
    );
    expect(Array.from(hidden).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("连续标题：折叠 H1#0 隐藏中间的标题行本身", () => {
    // 0 H1, 1 H2, 2 H2, 3 H2（连续三个同级）
    const consec = mk([
      ["heading", 1, "一"],
      ["heading", 2, "a"],
      ["heading", 2, "b"],
      ["heading", 2, "c"],
      "paragraph",
    ]);
    const hs = collectHeadings(consec);
    const hidden = hiddenBlockIndexes(hs, consec.length, new Set([hs[0].id]));
    expect(Array.from(hidden).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("文末收尾：最后一个标题折叠 → 隐藏其后全部块", () => {
    const tail = mk([["heading", 1, "一"], "paragraph", ["heading", 2, "尾"], "paragraph", "paragraph"]);
    const hs = collectHeadings(tail);
    const hidden = hiddenBlockIndexes(hs, tail.length, new Set([hs[1].id]));
    expect(Array.from(hidden).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("被外层折叠隐藏的标题，其自身折叠态**不生效**（不收窄外层区间）", () => {
    // 隐藏 H2 A(#2) 后其区间已被 H1 的折叠覆盖；若它也生效，区间会收窄
    const hidden = hiddenBlockIndexes(
      headings,
      blocks.length,
      new Set([headings[0].id, headings[1].id]),
    );
    expect(Array.from(hidden).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("折叠一个不存在的 id → 无影响", () => {
    expect(hiddenBlockIndexes(headings, blocks.length, new Set(["不存在"])).size).toBe(0);
  });

  it("totalBlocks = 0 / 负数 → 空集合；越界下标不产生空洞", () => {
    expect(hiddenBlockIndexes(headings, 0, new Set([headings[0].id])).size).toBe(0);
    expect(hiddenBlockIndexes(headings, -3, new Set([headings[0].id])).size).toBe(0);
    const only = hiddenBlockIndexes(headings, 2, new Set([headings[0].id]));
    expect(Array.from(only)).toEqual([1]);
  });
});

// ═════════════ ③ foldable / toggle / 展开祖先 / 复算 ═════════════

describe("可折叠判定与状态迁移", () => {
  const blocks = mk([
    ["heading", 1, "一"],
    "paragraph",
    ["heading", 2, "A"],
    "paragraph",
    ["heading", 1, "二"],
    "paragraph",
  ]);
  const headings = collectHeadings(blocks);
  const h1 = headings[0].id;
  const h2 = headings[1].id;
  const h1b = headings[2].id;

  it("foldableHeadingIds：无子内容的标题不显示三角", () => {
    const ids = foldableHeadingIds(headings, blocks.length);
    expect(ids.has(h1)).toBe(true); // 后面有 p + A + p
    expect(ids.has(h2)).toBe(true); // 后面有 p
    expect(ids.has(h1b)).toBe(true); // 后面有 p
  });

  it("末标题之后没有任何块 → 不可折叠", () => {
    const tail = mk([["heading", 1, "一"], "paragraph", ["heading", 2, "尾"]]);
    const hs = collectHeadings(tail);
    expect(foldableHeadingIds(hs, tail.length).has(hs[1].id)).toBe(false);
  });

  it("标题后面紧跟同级/更高级标题 → 不可折叠（区间内没有任何块）", () => {
    const consec = mk([["heading", 2, "a"], ["heading", 1, "b"], "paragraph"]);
    const hs = collectHeadings(consec);
    // H2#0 的下一个 level ≤ 2 的标题就在 block 1 → 区间为空（藏不到内容）
    expect(foldableHeadingIds(hs, consec.length).has(hs[0].id)).toBe(false);
    expect(foldableHeadingIds(hs, consec.length).has(hs[1].id)).toBe(true);
  });

  it("toggleFold：切换两次回到原态，且不改入参", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set() };
    const a = toggleFold(s, h1);
    expect(a.collapsed.has(h1)).toBe(true);
    expect(s.collapsed.size).toBe(0); // 入参未被修改
    const b = toggleFold(a, h1);
    expect(b.collapsed.size).toBe(0);
  });

  it("toggleFold：空 id 返回原对象", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set() };
    expect(toggleFold(s, "")).toBe(s);
  });

  it("expandAll：无折叠时返回原对象；有折叠时清空", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set([h1]) };
    expect(expandAll(s).collapsed.size).toBe(0);
    const empty: FoldState = { docKey: "k", collapsed: new Set() };
    expect(expandAll(empty)).toBe(empty);
  });

  it("collapseAll：把全部可折叠标题一次性折叠", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set() };
    const all = collapseAll(s, headings, blocks.length);
    expect(all.collapsed.size).toBe(3);
  });

  it("expandAncestors：搜索命中深层块 → 只展开覆盖它的祖先链", () => {
    // 折叠 H1#0 与 H2 A#2；目标块 = 4（A 区间内的段落）
    const s: FoldState = { docKey: "k", collapsed: new Set([h1, h2, h1b]) };
    const next = expandAncestors(s, headings, 4);
    expect(next.collapsed.has(h1)).toBe(false);
    expect(next.collapsed.has(h2)).toBe(false);
    expect(next.collapsed.has(h1b)).toBe(true); // 与该目标无关的折叠保留
  });

  it("expandAncestors：目标是标题自身时不展开它自己的折叠（标题行可见）", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set([h2]) };
    const next = expandAncestors(s, headings, 2);
    expect(next.collapsed.has(h2)).toBe(true);
  });

  it("expandAncestors：无折叠 / 无标题覆盖 → 返回原对象", () => {
    const empty: FoldState = { docKey: "k", collapsed: new Set() };
    expect(expandAncestors(empty, headings, 4)).toBe(empty);
    const s: FoldState = { docKey: "k", collapsed: new Set([h1b]) };
    // 目标块 1 只被 H1#0 覆盖，而 H1#0 未折叠 → 不变
    expect(expandAncestors(s, headings, 1)).toBe(s);
  });

  it("expandAncestorsForHeadingId：按 id 展开祖先（TOC / 锚点跳转）", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set([h1]) };
    const next = expandAncestorsForHeadingId(s, headings, h2);
    expect(next.collapsed.size).toBe(0);
    expect(expandAncestorsForHeadingId(s, headings, "不存在")).toBe(s);
  });

  it("headingById：命中与未命中", () => {
    expect(headingById(headings, h2)?.level).toBe(2);
    expect(headingById(headings, "x")).toBeNull();
  });
});

describe("reconcileFoldState · 文档修改后按 id 复算", () => {
  const before = mk([
    ["heading", 1, "保留"],
    "paragraph",
    ["heading", 2, "被删"],
    "paragraph",
  ]);
  const hsBefore = collectHeadings(before);

  it("标题删除 → 其折叠态被清理", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set([hsBefore[0].id, hsBefore[1].id]) };
    const after = mk([["heading", 1, "保留"], "paragraph", "paragraph"]);
    const hsAfter = collectHeadings(after);
    const next = reconcileFoldState(s, hsAfter);
    expect(Array.from(next.collapsed)).toEqual([hsBefore[0].id]);
  });

  it("标题文本改动 → id 变化 → 旧折叠态丢弃（该节回到展开）", () => {
    const s: FoldState = { docKey: "k", collapsed: new Set([hsBefore[1].id]) };
    const after = mk([["heading", 1, "保留"], "paragraph", ["heading", 2, "改过的文本"], "paragraph"]);
    const hsAfter = collectHeadings(after);
    expect(reconcileFoldState(s, hsAfter).collapsed.size).toBe(0);
  });

  it("无折叠 / 全部有效 → 返回原对象（React 浅比较友好）", () => {
    const empty: FoldState = { docKey: "k", collapsed: new Set() };
    expect(reconcileFoldState(empty, hsBefore)).toBe(empty);
    const s: FoldState = { docKey: "k", collapsed: new Set([hsBefore[0].id]) };
    expect(reconcileFoldState(s, hsBefore)).toBe(s);
  });
});

describe("滚动映射辅助（设计稿 §2.4）", () => {
  const blocks = mk([
    ["heading", 1, "一"],
    "paragraph",
    ["heading", 2, "A"],
    "paragraph",
    ["heading", 1, "二"],
  ]);
  const headings = collectHeadings(blocks);
  const h1 = headings[0].id;
  const h2 = headings[1].id;

  it("isBlockHidden：折叠 H2 A 时其区间内的块隐藏，标题自身可见", () => {
    const collapsed = new Set([h2]);
    expect(isBlockHidden(3, headings, blocks.length, collapsed)).toBe(true);
    expect(isBlockHidden(2, headings, blocks.length, collapsed)).toBe(false);
  });

  it("nearestVisibleAncestorHeading：隐藏块 → 最近的可见祖先标题", () => {
    const collapsed = new Set([h1]);
    expect(nearestVisibleAncestorHeading(3, headings, blocks.length, collapsed)?.id).toBe(
      headings[0].id,
    );
    // 可见块 → null（无需落点）
    expect(nearestVisibleAncestorHeading(0, headings, blocks.length, collapsed)).toBeNull();
  });
});

// ═════════════ ④ 两个渲染面：PM 阅读区 + iframe ═════════════

describe("PM 阅读区模型（buildPmFoldModel）", () => {
  it("块下标 = doc 子节点下标；标题 id 与 parser 写入的 attrs.id 一致", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    expect(model.blocks.length).toBe(doc.childCount);
    expect(model.positions.length).toBe(doc.childCount);
    const headings = model.headings;
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 2]);
    // 与 parser 写的 id 逐一对齐（heading-anchor slug + 去重）
    const ids: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === "heading") ids.push(String(node.attrs.id));
      return true;
    });
    expect(idsOf(headings)).toEqual(ids);
  });

  it("空行还原的空段落也在块数组里（所以块下标不能跨面共享）", () => {
    // 每两个块之间留 **2 个空行** → parser 会把多出的那 1 行还原成空段落
    const md = ["# A", "", "", "正文", "", "", "## B"].join("\n");
    const doc = markdownToDoc(md);
    const model = buildPmFoldModel(doc);
    expect(model.blocks.some((b) => b.type === "paragraph" && b.text === "")).toBe(true);
    expect(model.blocks.length).toBeGreaterThan(topLevelBlockStartLines(md).length);
  });

  it("collectDocChildBlocks：结构化假对象也能工作（便于纯 Node 单测）", () => {
    const fakeDoc = {
      childCount: 2,
      child: (i: number) =>
        i === 0
          ? { type: { name: "heading" }, attrs: { level: 2, id: "x" }, textContent: "标题" }
          : { type: { name: "paragraph" }, attrs: {}, textContent: "正文" },
    };
    const blocks = collectDocChildBlocks(fakeDoc);
    // 非标题块不读 textContent（每次事务的 O(全文) 读文本会拖垮长文档输入）：
    // 折叠只需要标题的 id/level，正文块的文本完全用不到。
    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "", headingId: "x" },
      { type: "paragraph", text: "" },
    ]);
  });
});

describe("computePmFoldDecorations", () => {
  it("折叠 H2 A：给区间内块加隐藏装饰，并给可折叠标题加按钮 widget", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    const h2 = model.headings.find((h) => h.level === 2)!;
    const decos = computePmFoldDecorations(
      model,
      new Set([h2.id]),
      { collapse: "折叠", expand: "展开" },
      { toggle: () => undefined },
    );
    // 有 node 装饰（隐藏块）+ widget 装饰（按钮）
    expect(decos.some((d) => d.from === d.to)).toBe(true); // 有按钮 widget
    expect(decos.some((d) => d.from !== d.to)).toBe(true); // 有隐藏块 node 装饰
    const hidden = hiddenBlockIndexes(model.headings, model.blocks.length, new Set([h2.id]));
    expect(hidden.size).toBeGreaterThan(0);
  });

  it("无折叠时：只有标题定位 class + 按钮 widget，没有隐藏块装饰", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    const decos = computePmFoldDecorations(
      model,
      new Set(),
      { collapse: "折叠", expand: "展开" },
      { toggle: () => undefined },
    );
    expect(decos.length).toBeGreaterThan(0);
    const foldable = foldableHeadingIds(model.headings, model.blocks.length);
    // 无折叠态：跨块的 node 装饰**只有标题定位 class**（数量 = 可折叠标题数），
    // 没有任何隐藏块的装饰；widget（from === to）数量同为可折叠标题数。
    expect(decos.filter((d) => d.from !== d.to).length).toBe(foldable.size);
    expect(decos.filter((d) => d.from === d.to).length).toBe(foldable.size);
  });

  it("折叠不改文档：装饰计算前后 markdown 往返逐字节一致（导出完整）", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const before = docToMarkdown(doc);
    const model = buildPmFoldModel(doc);
    computePmFoldDecorations(
      model,
      new Set(model.headings.map((h) => h.id)),
      { collapse: "折叠", expand: "展开" },
      { toggle: () => undefined },
    );
    expect(docToMarkdown(doc)).toBe(before);
    expect(docToMarkdown(doc)).toContain("正文 A1");
  });
});

describe("折叠按钮（createFoldButton）", () => {
  it("aria-expanded 反映折叠态，带 data-fold-id，含 contenteditable=false", () => {
    const open = createFoldButton("h", false, { collapse: "折叠", expand: "展开" }, { toggle: () => undefined });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.dataset.foldId).toBe("h");
    expect(open.getAttribute("contenteditable")).toBe("false");
    expect(open.className).toBe(FOLD_BTN_CLASS);
    expect(open.getAttribute("aria-label")).toBe("折叠");

    const shut = createFoldButton("h", true, { collapse: "折叠", expand: "展开" }, { toggle: () => undefined });
    expect(shut.getAttribute("aria-expanded")).toBe("false");
    expect(shut.getAttribute("aria-label")).toBe("展开");
  });

  it("点击 / Enter / Space 都切换；mousedown 阻止选区移动；事件不冒泡", () => {
    let toggled = 0;
    let captured = 0;
    const btn = createFoldButton("h", false, { collapse: "c", expand: "e" }, {
      toggle: () => {
        toggled++;
      },
    });
    const host = document.createElement("div");
    host.appendChild(btn);
    document.body.appendChild(host);
    host.addEventListener("click", () => captured++);
    host.addEventListener("mousedown", () => captured++);
    host.addEventListener("keydown", () => captured++);

    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    btn.click();
    expect(toggled).toBe(1);
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(toggled).toBe(3);
    // 全部 stopPropagation → 宿主一个都没收到
    expect(captured).toBe(0);
  });

  it("非 Enter/Space 的按键不切换", () => {
    let toggled = 0;
    const btn = createFoldButton("h", false, { collapse: "c", expand: "e" }, {
      toggle: () => {
        toggled++;
      },
    });
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(toggled).toBe(0);
  });
});

// ═════════════ ⑤ iframe 注入：幂等 + body 未就绪重试 ═════════════

describe("iframe 注入（applyReadingFoldToIframe）", () => {
  it("折叠 H2 A → 其后块加 .lmd-fold-hidden + data 属性；标题加按钮", () => {
    const { doc } = makeIframeDoc(SAMPLE_MD);
    const model = buildIframeFoldModel(doc.body);
    const h2 = model.headings.find((h) => h.level === 2)!;
    const result = applyReadingFoldToIframe(doc, {
      collapsed: new Set([h2.id]),
      labels: { collapse: "折叠", expand: "展开" },
    });
    expect(result.applied).toBe(true);
    expect(result.hidden).toBeGreaterThan(0);
    const hiddenEls = doc.body.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`);
    expect(hiddenEls.length).toBe(result.hidden);
    for (const el of Array.from(hiddenEls)) {
      expect(el.getAttribute(FOLD_HIDDEN_ATTR)).toBe("true");
    }
    const btns = doc.body.querySelectorAll(`.${FOLD_BTN_CLASS}`);
    expect(btns.length).toBeGreaterThan(0);
  });

  it("幂等：连续调用两次，DOM 结构与按钮数完全一致（不泄漏、不叠加）", () => {
    const { doc } = makeIframeDoc(SAMPLE_MD);
    const model = buildIframeFoldModel(doc.body);
    const h1 = model.headings[0].id;
    const opts = { collapsed: new Set([h1]), labels: { collapse: "折叠", expand: "展开" } };
    const first = applyReadingFoldToIframe(doc, opts);
    const html1 = doc.body.innerHTML;
    const second = applyReadingFoldToIframe(doc, opts);
    const html2 = doc.body.innerHTML;
    expect(second.hidden).toBe(first.hidden);
    expect(second.buttons).toBe(first.buttons);
    expect(second.model.blocks.length).toBe(first.model.blocks.length);
    expect(html2).toBe(html1);
    expect(doc.body.querySelectorAll(`style[data-lmd-fold-style]`).length).toBe(0); // style 在 head
    expect(doc.head.querySelectorAll("style[data-lmd-fold-style]").length).toBe(1);
  });

  it("展开态调用 → 清掉上一次的隐藏 class / data / 按钮（状态可逆）", () => {
    const { doc } = makeIframeDoc(SAMPLE_MD);
    const model = buildIframeFoldModel(doc.body);
    const h1 = model.headings[0].id;
    applyReadingFoldToIframe(doc, { collapsed: new Set([h1]) });
    expect(doc.body.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBeGreaterThan(0);

    const expanded = applyReadingFoldToIframe(doc, { collapsed: new Set() });
    expect(expanded.hidden).toBe(0);
    expect(doc.body.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBe(0);
    expect(doc.body.querySelectorAll(`[${FOLD_HIDDEN_ATTR}]`).length).toBe(0);
    // 按钮仍在（可折叠标题始终有三角），但 aria-expanded 全为 true
    const btns = Array.from(doc.body.querySelectorAll(`.${FOLD_BTN_CLASS}`));
    expect(btns.length).toBeGreaterThan(0);
    expect(btns.every((b) => b.getAttribute("aria-expanded") === "true")).toBe(true);
    // 标题上的 lmd-fold-heading 标记在展开态保留（position:relative 定位需要）
    expect(doc.body.querySelectorAll(`.${FOLD_HEADING_CLASS}`).length).toBeGreaterThan(0);
  });

  it("点击按钮 → 回调带 headingId（调用方据此 toggle 后重新应用）", () => {
    const { doc } = makeIframeDoc(SAMPLE_MD);
    const model = buildIframeFoldModel(doc.body);
    const h1 = model.headings[0].id;
    let hit: string | null = null;
    applyReadingFoldToIframe(doc, { collapsed: new Set(), onToggle: (id) => (hit = id) });
    const btn = doc.body.querySelector<HTMLButtonElement>(`.${FOLD_BTN_CLASS}[data-fold-id="${h1}"]`);
    expect(btn).not.toBeNull();
    btn!.click();
    expect(hit).toBe(h1);
  });

  it("按钮只有可折叠标题才有（无子内容的标题不显示三角）", () => {
    const md = ["# 尾标题", "", "正文"].join("\n");
    const { doc } = makeIframeDoc(md);
    const result = applyReadingFoldToIframe(doc, { collapsed: new Set() });
    // 唯一标题后面有段落 → 可折叠
    expect(result.buttons).toBe(1);

    const md2 = ["正文", "", "# 尾标题"].join("\n");
    const second = makeIframeDoc(md2);
    const r2 = applyReadingFoldToIframe(second.doc, { collapsed: new Set() });
    expect(r2.buttons).toBe(0);
  });

  it("iframe 内注入的样式表在 head，且**不依赖父文档 CSS 变量**（全部带兜底值）", () => {
    const { doc } = makeIframeDoc(SAMPLE_MD);
    applyReadingFoldToIframe(doc, { collapsed: new Set() });
    const style = doc.head.querySelector("style[data-lmd-fold-style]");
    expect(style).not.toBeNull();
    const css = style!.textContent ?? "";
    expect(css).toContain(`.${FOLD_HIDDEN_CLASS} { display: none; }`);
    // 每个 var() 都带 fallback（iframe 不继承父 CSS 变量 —— 语义地图 §4 陷阱）
    expect(/var\(--[\w-]+\)/.test(css)).toBe(false);
    expect(/var\(--[\w-]+,\s*[^)]+\)/.test(css)).toBe(true);
  });

  it("非内容元素（script / mermaid 工具层）不参与折叠下标", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head></head><body>
      <h1 id="a">一</h1>
      <p>正文</p>
      <script>window.x=1</script>
      <div class="mermaidTooltip">tooltip</div>
      <h2 id="b">二</h2>
      <p>正文二</p>
    </body></html>`);
    doc.close();
    const result = applyReadingFoldToIframe(doc, { collapsed: new Set(["a"]) });
    expect(result.headings.map((h) => h.id)).toEqual(["a", "b"]);
    // 折叠 a（H1，文末无更高级标题）→ 隐藏其后全部内容块：p + h2(b) + p
    expect(result.hidden).toBe(3);
    expect(doc.body.querySelector(`script`)!.classList.contains(FOLD_HIDDEN_CLASS)).toBe(false);
    expect(
      doc.body.querySelector(`.mermaidTooltip`)!.classList.contains(FOLD_HIDDEN_CLASS),
    ).toBe(false);
  });

  it("body 未就绪（doc.body=null）→ applied:false，不抛错", () => {
    const doc = document.implementation.createHTMLDocument("t");
    // 新建空文档的 body 一定存在；用 null 文档与 detached 文档模拟未就绪
    expect(applyReadingFoldToIframe(null, { collapsed: new Set() }).applied).toBe(false);
    const fakeDoc = {
      head: null,
      body: null,
      querySelector: () => null,
      createElement: () => document.createElement("div"),
    } as unknown as Document;
    expect(() => applyReadingFoldToIframe(fakeDoc, { collapsed: new Set() })).not.toThrow();
    expect(applyReadingFoldToIframe(fakeDoc, { collapsed: new Set() }).applied).toBe(false);
    void doc;
  });

  it("applyReadingFoldToIframeWhenReady：body 未就绪时重试，就绪后自动应用", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head></head><body></body></html>`);
    doc.close();

    // 前两次拿到的 doc.body 为 null（模拟 doc.close() 后解析器仍在等脚本）
    let attempts = 0;
    const getDoc = () => {
      attempts++;
      if (attempts <= 2) return { head: doc.head, body: null } as unknown as Document;
      return doc;
    };
    doc.body!.innerHTML = `<h1 id="a">一</h1><p>正文</p>`;
    const cancel = applyReadingFoldToIframeWhenReady(getDoc, { collapsed: new Set(["a"]) });
    expect(attempts).toBe(1); // 首次同步尝试

    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(attempts).toBeGreaterThan(1);
    const btns = doc.body!.querySelectorAll(`.${FOLD_BTN_CLASS}`);
    expect(btns.length).toBe(1);
    expect(doc.body!.querySelector(`.${FOLD_HIDDEN_CLASS}`)).not.toBeNull();
    cancel();
  });

  it("whenReady 的取消函数能阻止后续重试（卸载/切文档安全）", async () => {
    let calls = 0;
    const cancel = applyReadingFoldToIframeWhenReady(
      () => {
        calls++;
        return null;
      },
      { collapsed: new Set() },
    );
    expect(calls).toBe(1);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(calls).toBe(1);
  });
});

describe("iframe 面 · 复杂文档不崩且标题能认出", () => {
  const CASES: Array<[string, string]> = [
    ["脚注定义块", ["# 一", "", "正文[^1]", "", "[^1]: 脚注内容", "", "## 二", "", "正文二"].join("\n")],
    ["[toc] 目录", ["# 一", "", "[toc]", "", "## 二", "", "正文"].join("\n")],
    ["定义列表", ["# 一", "", "术语", ": 定义", "", "## 二", "", "正文"].join("\n")],
    ["嵌套列表", ["# 一", "", "- a", "  - b", "  - c", "", "## 二"].join("\n")],
    ["HTML 注释块", ["# 一", "", "<!-- 注释 -->", "", "正文", "", "## 二"].join("\n")],
    ["mermaid 代码块", ["# 一", "", "```mermaid", "graph TD;A-->B;", "```", "", "## 二"].join("\n")],
  ];

  for (const [name, md] of CASES) {
    it(`${name}：折叠首标题 → 生效且标题 id 两两成对`, () => {
      const { doc } = makeIframeDoc(md);
      const model = buildIframeFoldModel(doc.body);
      expect(model.headings.length).toBeGreaterThan(0);
      const first = model.headings[0];
      const result = applyReadingFoldToIframe(doc, { collapsed: new Set([first.id]) });
      expect(result.applied).toBe(true);
      expect(result.hidden).toBeGreaterThan(0);
      // 幂等
      const html1 = doc.body.innerHTML;
      applyReadingFoldToIframe(doc, { collapsed: new Set([first.id]) });
      expect(doc.body.innerHTML).toBe(html1);
    });
  }

  it("重复 apply 不会把按钮文案混进标题文本（幂等顺序：先复位再取文本）", () => {
    const { doc } = makeIframeDoc(["# 一", "", "正文", "", "## 二", "", "正文二"].join("\n"));
    const first = buildIframeFoldModel(doc.body).headings.map((h) => h.id);
    applyReadingFoldToIframe(doc, {
      collapsed: new Set(),
      labels: { collapse: "折叠子标题", expand: "展开子标题" },
    });
    // 第二次（增量重贴）必须算出同一批标题 id，不能被按钮文本污染出 fallback id
    const second = buildIframeFoldModel(doc.body).headings.map((h) => h.id);
    expect(second).toEqual(first);
  });
});

describe("ensureIframeFoldStyle", () => {
  it("同一 document 只注入一份；内容被篡改时刷新", () => {
    const { doc } = makeIframeDoc(SAMPLE_MD);
    expect(ensureIframeFoldStyle(doc)).toBe(true);
    expect(doc.head.querySelectorAll("style[data-lmd-fold-style]").length).toBe(1);
    ensureIframeFoldStyle(doc);
    expect(doc.head.querySelectorAll("style[data-lmd-fold-style]").length).toBe(1);
    doc.head.querySelector("style[data-lmd-fold-style]")!.textContent = "stale";
    ensureIframeFoldStyle(doc);
    expect(doc.head.querySelector("style[data-lmd-fold-style]")!.textContent).toContain(
      FOLD_HIDDEN_CLASS,
    );
  });

  it("null / 无 head → false（不抛错）", () => {
    expect(ensureIframeFoldStyle(null)).toBe(false);
    const fakeDoc = { head: null } as unknown as Document;
    expect(ensureIframeFoldStyle(fakeDoc)).toBe(false);
  });
});

// ═════════════ ⑥ 控制器：两预览面共享同一 headingId 集合 ═════════════

describe("ReadingFoldController（状态源）", () => {
  it("toggle / expandAll / collapseAll / 快照版本号递增", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    const c = createReadingFoldController({ docKey: "d.md" });
    c.setModel(model);
    const v0 = c.getSnapshot().version;
    c.toggle(model.headings[1].id);
    expect(c.getSnapshot().collapsed).toEqual([model.headings[1].id]);
    expect(c.getSnapshot().version).toBe(v0 + 1);
    c.expandAll();
    expect(c.getSnapshot().collapsed).toEqual([]);
    c.collapseAll();
    expect(c.getSnapshot().collapsed.length).toBeGreaterThan(0);
    expect(c.hasState()).toBe(true);
  });

  it("setDocKey 变化 → 清空折叠态；同 key 不重复清", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    const c = createReadingFoldController({ docKey: "a.md" });
    c.setModel(model);
    c.toggle(model.headings[0].id);
    c.setDocKey("a.md"); // 同一文档
    expect(c.getSnapshot().collapsed.length).toBe(1);
    c.setDocKey("b.md");
    expect(c.getSnapshot().collapsed.length).toBe(0);
  });

  it("订阅者收到通知；取消订阅后不再收到；单个订阅者异常不影响其他", () => {
    const c = createReadingFoldController();
    let a = 0;
    let b = 0;
    const un1 = c.subscribe(() => {
      a++;
      throw new Error("boom");
    });
    c.subscribe(() => {
      b++;
    });
    c.toggle("x");
    expect(a).toBe(1);
    expect(b).toBe(1);
    un1();
    c.toggle("y");
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("expandAncestorsForBlockIndex / expandForHeadingId 走当前模型", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    const c = createReadingFoldController({ docKey: "z" });
    c.setModel(model);
    const h1 = model.headings[0].id;
    const h2b = model.headings[3].id;
    c.toggle(h1);
    c.toggle(h2b);
    // 目标块 = 二级 B 之后的段落 → 展开 H1（祖先）与 H2 B（祖先）
    const targetBlock = model.headings[3].blockIndex + 1;
    c.expandAncestorsForBlockIndex(targetBlock);
    expect(c.getSnapshot().collapsed).toEqual([]);
  });

  it("setEnabled / setLabels：仅在真的变化时通知（避免无谓重渲染）", () => {
    const c = createReadingFoldController();
    let calls = 0;
    c.subscribe(() => calls++);
    c.setEnabled(false);
    expect(calls).toBe(0);
    c.setEnabled(true);
    expect(calls).toBe(1);
    expect(c.isEnabled()).toBe(true);
    c.setLabels({ collapse: "c", expand: "e" });
    expect(calls).toBe(2);
    c.setLabels({ collapse: "c", expand: "e" });
    expect(calls).toBe(2);
  });

  it("两预览面共享同一 id 集合：PM 模型与 iframe 模型用同一 collapsed 集各自算隐藏块", () => {
    // 含双空行：PM 侧会多出空段落块，iframe 侧不会 → 块下标不同，只能靠 headingId 对齐
    const md = ["# 一", "", "", "正文", "", "", "## 二", "", "", "正文二"].join("\n");
    const doc = markdownToDoc(md);
    const pmModel = buildPmFoldModel(doc);
    const { doc: iframeDoc } = makeIframeDoc(md);
    const iframeModel = buildIframeFoldModel(iframeDoc.body);
    // 两个面的 blocks 数不同（PM 含空段落/末尾 pad），但**标题 id 必须一致**
    expect(pmModel.blocks.length).not.toBe(iframeModel.blocks.length);
    expect(idsOf(pmModel.headings)).toEqual(idsOf(iframeModel.headings));

    const collapsed = new Set([pmModel.headings[1].id]);
    const pmHidden = hiddenBlockIndexes(pmModel.headings, pmModel.blocks.length, collapsed);
    const iframeHidden = hiddenBlockIndexes(
      iframeModel.headings,
      iframeModel.blocks.length,
      collapsed,
    );
    // 隐藏的**标题数量**一致（块数因空段落不同而不同，语义一致即可）
    const pmHiddenHeadings = pmModel.headings.filter((h) => pmHidden.has(h.blockIndex)).length;
    const iframeHiddenHeadings = iframeModel.headings.filter((h) =>
      iframeHidden.has(h.blockIndex),
    ).length;
    expect(pmHiddenHeadings).toBe(iframeHiddenHeadings);
  });

  it("getSnapshot 返回**稳定引用**（useSyncExternalStore 不会死循环）", () => {
    const c = createReadingFoldController({ docKey: "z" });
    const a = c.getSnapshot();
    const b = c.getSnapshot();
    expect(b).toBe(a); // 未变化 → 同一对象
    c.toggle("x");
    const d = c.getSnapshot();
    expect(d).not.toBe(a);
    expect(d.version).toBe(a.version + 1);
    expect(c.getSnapshot()).toBe(d);
  });

  it("sameCollapsedSet：集合比较", () => {
    expect(sameCollapsedSet(new Set(["a"]), new Set(["a"]))).toBe(true);
    expect(sameCollapsedSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
    expect(sameCollapsedSet(new Set(), new Set())).toBe(true);
  });
});

// ═════════════ ⑦ 真实 PM 视图集成：装饰生效 + **不进撤销历史** ═════════════

describe("PM 视图集成（真实 EditorView）", () => {
  const hosts: HTMLElement[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.remove();
  });

  function mount(md: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const controller = createReadingFoldController({ enabled: true });
    const plugin = createReadingFoldPlugin({ controller });
    const doc = markdownToDoc(md);
    const state = EditorState.create({ doc, plugins: [history(), plugin] });
    const view = new EditorView(host, { state });
    return { view, controller, host };
  }

  it("折叠后：隐藏块 DOM 带 class+data，标题 DOM 内有折叠按钮（ProseMirror-widget）", () => {
    const { view, controller } = mount(SAMPLE_MD);
    const h1 = view.state.doc.child(0);
    expect(h1.type.name).toBe("heading");
    // 初始全展开：无隐藏块，但按钮已就位
    expect(view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBe(0);
    expect(view.dom.querySelectorAll(`.${FOLD_BTN_CLASS}`).length).toBeGreaterThan(0);

    const h1Id = String(h1.attrs.id);
    controller.toggle(h1Id);
    expect(view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBeGreaterThan(0);
    // data 属性也写上了（PM 的 node decoration 属性通道）
    expect(view.dom.querySelectorAll(`[${FOLD_HIDDEN_ATTR}="true"]`).length).toBeGreaterThan(0);
    // 标题块带上稳定 headingId（跨渲染面 / 测试定位用）
    const headingEl = view.dom.querySelector(`[${FOLD_HEADING_ATTR}="${h1Id}"]`);
    expect(headingEl).not.toBeNull();
    expect(headingEl!.classList.contains(FOLD_HEADING_CLASS)).toBe(true);
    // 按钮是 PM widget（PM 会自动加 ProseMirror-widget + contenteditable=false）
    const btn = view.dom.querySelector(`.${FOLD_BTN_CLASS}`) as HTMLElement;
    expect(btn.classList.contains("ProseMirror-widget")).toBe(true);
    expect(btn.getAttribute("contenteditable")).toBe("false");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("**折叠不产生撤销历史**：toggle / expandAll 前后 undoDepth、redoDepth、doc 均不变", () => {
    const { view, controller } = mount(SAMPLE_MD);
    const mdBefore = docToMarkdown(view.state.doc);
    const undo0 = undoDepth(view.state);
    const redo0 = redoDepth(view.state);

    const h1Id = String(view.state.doc.child(0).attrs.id);
    controller.toggle(h1Id);
    expect(undoDepth(view.state)).toBe(undo0);
    expect(redoDepth(view.state)).toBe(redo0);
    expect(docToMarkdown(view.state.doc)).toBe(mdBefore);

    controller.toggle(h1Id); // 展开
    controller.collapseAll();
    controller.expandAll();
    expect(undoDepth(view.state)).toBe(undo0);
    expect(redoDepth(view.state)).toBe(redo0);
    expect(docToMarkdown(view.state.doc)).toBe(mdBefore);

    // 折叠后导出仍完整（renderPipeline 走 Markdown，天然不受影响）
    expect(docToMarkdown(view.state.doc)).toContain("正文 A1");
  });

  it("点按钮（真实 click）→ 折叠生效，且不改 doc（真实事件路径不吞输入）", () => {
    const { view, controller } = mount(SAMPLE_MD);
    const undo0 = undoDepth(view.state);
    const btn = view.dom.querySelector(`.${FOLD_BTN_CLASS}`) as HTMLButtonElement;
    const id = btn.dataset.foldId!;
    btn.click();
    expect(controller.getSnapshot().collapsed).toEqual([id]);
    expect(view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBeGreaterThan(0);
    expect(undoDepth(view.state)).toBe(undo0);
  });

  it("enabled=false 时（编辑 WYSIWYG 面）零装饰：没有按钮、没有隐藏", () => {
    const { view, controller } = mount(SAMPLE_MD);
    controller.setEnabled(false);
    expect(view.dom.querySelectorAll(`.${FOLD_BTN_CLASS}`).length).toBe(0);
    expect(view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBe(0);
  });

  it("文档编辑后按 headingId 复算：删掉被折叠的标题 → 折叠态自动清理", () => {
    const md = ["# 一", "", "正文", "", "## 二", "", "正文二"].join("\n");
    const { view, controller } = mount(md);
    const h2Pos = 0;
    let h2PosReal = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading" && Number(node.attrs.level) === 2) h2PosReal = pos;
      return true;
    });
    expect(h2PosReal).toBeGreaterThanOrEqual(0);
    const h2Id = String(view.state.doc.nodeAt(h2PosReal)!.attrs.id);
    controller.toggle(h2Id);
    expect(controller.getSnapshot().collapsed).toEqual([h2Id]);
    // 删掉整个 "## 二" 标题块（从标题起点到该块结束）
    const node = view.state.doc.nodeAt(h2PosReal)!;
    view.dispatch(view.state.tr.delete(h2PosReal, h2PosReal + node.nodeSize));
    // 装饰重算时 syncFromHeadings 静默清理 → 折叠集合为空
    expect(controller.getSnapshot().collapsed).toEqual([]);
    expect(view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBe(0);
    void h2Pos;
  });

  it("插图/改块后装饰仍与块区间对齐（位置基于当前 doc，不残留旧坐标）", () => {
    const { view, controller } = mount(SAMPLE_MD);
    const h1Id = String(view.state.doc.child(0).attrs.id);
    controller.toggle(h1Id);
    const hiddenBefore = view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length;
    expect(hiddenBefore).toBeGreaterThan(0);
    // 在文档开头插一个段落（所有块下标整体位移）
    view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.paragraph.create(null, [view.state.schema.text("新增")])));
    const hiddenAfter = view.dom.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length;
    // 折叠仍生效（按 headingId 复算，不依赖旧下标）；隐藏块数因新增段落而 +1 左右
    expect(hiddenAfter).toBeGreaterThan(0);
  });
});

// ═════════════ ⑧ 接线辅助：iframe 桥 + 跳转前展开 ═════════════

describe("createIframeFoldBridge（EditorContainer 接线辅助）", () => {
  function mountIframe(md: string) {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head></head><body>${renderSampleHtml(md)}</body></html>`);
    doc.close();
    return { iframe, doc };
  }

  it("isActive=false → 不注入任何折叠痕迹（避免污染编辑 WYSIWYG 面）", () => {
    const { doc } = mountIframe(SAMPLE_MD);
    const c = createReadingFoldController({ enabled: true });
    const bridge = createIframeFoldBridge({
      getIframeDocument: () => doc,
      isActive: () => false,
      controller: c,
    });
    bridge.apply();
    expect(doc.body.querySelectorAll(`.${FOLD_BTN_CLASS}`).length).toBe(0);
    expect(doc.body.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBe(0);
    bridge.dispose();
  });

  it("isActive=true → 注入按钮；再次 apply 幂等", () => {
    const { doc } = mountIframe(SAMPLE_MD);
    const c = createReadingFoldController({ enabled: true, docKey: "k" });
    const bridge = createIframeFoldBridge({
      getIframeDocument: () => doc,
      isActive: () => true,
      controller: c,
    });
    bridge.apply();
    const n1 = doc.body.querySelectorAll(`.${FOLD_BTN_CLASS}`).length;
    expect(n1).toBeGreaterThan(0);
    const html1 = doc.body.innerHTML;
    bridge.apply();
    expect(doc.body.querySelectorAll(`.${FOLD_BTN_CLASS}`).length).toBe(n1);
    expect(doc.body.innerHTML).toBe(html1);
    bridge.dispose();
  });

  it("iframe 内按钮点击 → 控制器状态真的变化（桥的 onToggle 生效）", () => {
    const { doc } = mountIframe(SAMPLE_MD);
    const c = createReadingFoldController({ enabled: true, docKey: "k" });
    const bridge = createIframeFoldBridge({
      getIframeDocument: () => doc,
      isActive: () => true,
      controller: c,
    });
    bridge.apply();
    const btn = doc.body.querySelector(`.${FOLD_BTN_CLASS}`) as HTMLButtonElement;
    const id = btn.dataset.foldId!;
    btn.click();
    expect(c.getSnapshot().collapsed).toEqual([id]);
    // 桥内的同步兜底已经把折叠画上去了（不依赖 React 渲染）
    expect(doc.body.querySelectorAll(`.${FOLD_HIDDEN_CLASS}`).length).toBeGreaterThan(0);
    bridge.dispose();
  });

  it("dispose 后不再有任何等待中的重试（切文档安全）", async () => {
    let calls = 0;
    const c = createReadingFoldController();
    const bridge = createIframeFoldBridge({
      getIframeDocument: () => {
        calls++;
        return null;
      },
      isActive: () => true,
      controller: c,
    });
    bridge.apply();
    const afterApply = calls;
    bridge.dispose();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(calls).toBe(afterApply);
  });
});

describe("跳转前展开祖先（搜索 / TOC / 锚点）", () => {
  it("expandBeforeJumpToBlockIndex / ...HeadingId 返回是否变化，并真的展开", () => {
    const doc = markdownToDoc(SAMPLE_MD);
    const model = buildPmFoldModel(doc);
    const c = createReadingFoldController({ enabled: true, docKey: "k" });
    // 注意：这两个便捷函数操作的是**模块单例** readingFold（Lead 接线用的那份）
    readingFold.setDocKey("fixture.md");
    readingFold.setModel(model);
    readingFold.expandAll();

    const h1 = model.headings[0].id;
    const h2b = model.headings[3].id;
    readingFold.toggle(h1);
    readingFold.toggle(h2b);
    expect(readingFold.getSnapshot().collapsed.length).toBe(2);

    const target = model.headings[3].blockIndex + 1;
    expect(expandBeforeJumpToBlockIndex(target)).toBe(true);
    expect(readingFold.getSnapshot().collapsed.length).toBe(0);

    // 已是全展开 → 再展开返回 false（调用方据此可跳过重算）
    expect(expandBeforeJumpToBlockIndex(target)).toBe(false);

    readingFold.toggle(h1);
    expect(expandBeforeJumpToHeadingId(h1)).toBe(false); // 目标是标题自身，不动它自己的折叠
    expect(expandBeforeJumpToHeadingId(h2b)).toBe(true);
    expect(readingFold.getSnapshot().collapsed.length).toBe(0);
    void c;
  });

  it("expandBeforeJumpToDocPos：把 PM 位置换算成顶层块下标再展开祖先", () => {
    // 大纲点击给的是 doc pos；这里用真实 doc 的位置验证换算正确
    const md = ["# 一", "", "正文", "", "## 二", "", "正文二"].join("\n");
    const doc = markdownToDoc(md);
    const model = buildPmFoldModel(doc);
    readingFold.setDocKey("fixture-pos.md");
    readingFold.setModel(model);
    readingFold.expandAll();
    readingFold.toggle(model.headings[0].id); // 折叠 H1

    // "## 二" 之后的段落位置（model.positions[3].from + 1）
    const pos = model.positions[3].from + 1;
    expect(expandBeforeJumpToDocPos(doc, pos)).toBe(true);
    expect(readingFold.getSnapshot().collapsed).toEqual([]);

    // 非法输入 → false 且不改状态
    expect(expandBeforeJumpToDocPos(doc, Number.NaN)).toBe(false);
    expect(expandBeforeJumpToDocPos(null as never, 3)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// v0.15.1 需求2：折叠 / 展开的**顺滑动效**
//
// 用户原话：「阅读区标题折叠。增加折叠收起打开的顺滑动效。」
//
// v0.15.0 的折叠终态是 `display: none` —— 一帧跳变，没有动画。
// v0.15.1 改成「height: 0 + 裁切 + 不可见」的终态，配合
// `interpolate-size: allow-keywords` 让 `height: auto ↔ 0` 可插值，
// 才能真的过渡。本组用例锁住四件事：
//   ① CSS 关键声明存在（两个阅读面同口径）；
//   ② 三角朝向用「固定字符 + transform 旋转」而非 content 切换；
//   ③ 按钮元素在折叠态变化时**被复用**（不重建才有过渡）；
//   ④ 不支持 allow-keywords 时的退化路径（display:none）仍在。
// ═══════════════════════════════════════════════════════════════════════


/** v0.15.1 需求2：读 node decoration 的属性（PM 把它们挂在 Decoration.type.attrs 上） */
function nodeDecoAttrs(d: unknown): Record<string, string> {
  const t = (d as { type?: { attrs?: Record<string, string> } }).type;
  return t?.attrs ?? {};
}
/** v0.15.1 需求2：读 widget decoration 的 spec（key 等挂在 Decoration.type.spec） */
function widgetSpec(d: unknown): { key?: string } {
  const t = (d as { type?: { spec?: { key?: string } } }).type;
  return t?.spec ?? {};
}

describe("v0.15.1 需求2：折叠动效 · CSS 关键声明", () => {
  const readCss = (): string => readFileSync("src/styles/readingFold.css", "utf-8");

  it("PM 面：插值开关存在（否则 height:auto 不可过渡）", () => {
    const css = readCss();
    expect(css).toContain("interpolate-size: allow-keywords");
    // 刻意只写在 .ProseMirror 上（可继承），不写 :root —— 那会把全应用的 auto
    // 高度都变成可插值，越界。
    expect(css).toMatch(/\.ProseMirror\s*\{[\s\S]*?interpolate-size:\s*allow-keywords/);
    expect(css).not.toMatch(/:root\s*\{[\s\S]*?interpolate-size/);
  });

  it("PM 面：折叠终态是「高度 0 + 裁切 + 不可见」，且各属性带 !important", () => {
    const css = readCss();
    // 取出 .lmd-fold-hidden 规则块（到下一个 } 为止足够；块内没有嵌套花括号）
    const m = /\.ProseMirror \.lmd-fold-hidden\s*\{([\s\S]*?)\}/.exec(css);
    expect(m, "缺少 .ProseMirror .lmd-fold-hidden 规则").toBeTruthy();
    const body = m![1];
    expect(body).toContain("height: 0 !important");
    expect(body).toContain("overflow: hidden !important");
    expect(body).toContain("visibility: hidden !important");
    // 间距/内边距/边框都要归零，否则即使 height:0 也会占位
    for (const prop of ["margin-top", "margin-bottom", "padding-top", "padding-bottom"]) {
      expect(body, `${prop} 未归零`).toMatch(
        new RegExp(`${prop}:\\s*0\\s*!important`),
      );
    }
    // 不再依赖 display:none 作为主路径（退化分支里才出现）
    expect(body).not.toContain("display: none");
  });

  it("PM 面：折叠 / 展开两个方向都有 height 与 opacity 过渡", () => {
    const css = readCss();
    // 展开方向（.ProseMirror > * 基态）
    expect(css).toMatch(/\.ProseMirror > \*\s*\{[\s\S]*?height 220ms/);
    expect(css).toMatch(/\.ProseMirror > \*\s*\{[\s\S]*?opacity 220ms/);
    // 折叠方向（.lmd-fold-hidden 自身）
    const hiddenRule = /\.ProseMirror \.lmd-fold-hidden\s*\{([\s\S]*?)\}/.exec(css)![1];
    expect(hiddenRule).toMatch(/height 220ms/);
    expect(hiddenRule).toMatch(/opacity 220ms/);
  });

  it("PM 面：overflow / visibility 用「0s 时长 + delay」做延迟翻转", () => {
    const css = readCss();
    const hiddenRule = /\.ProseMirror \.lmd-fold-hidden\s*\{([\s\S]*?)\}/.exec(css)![1];
    // 折叠：立刻裁切、收完才隐藏
    expect(hiddenRule).toMatch(/overflow\s+0s\s+linear\s+0s/);
    expect(hiddenRule).toMatch(/visibility\s+0s\s+linear\s+220ms/);
    // 展开（基态）：先保持裁切，长完再放开；立刻可见
    const baseRule = /\.ProseMirror > :not\([^{]*\{([\s\S]*?)\}/.exec(css);
    expect(baseRule, "缺少展开方向的 overflow/visibility 延迟规则").toBeTruthy();
    expect(baseRule![1]).toMatch(/overflow\s+0s\s+linear\s+220ms/);
    expect(baseRule![1]).toMatch(/visibility\s+0s\s+linear\s+0s/);
  });

  it("两个阅读面（PM 面 CSS 文件 / iframe 注入 CSS）关键声明一致", () => {
    const css = readCss();
    // 同口径的六个关键点，两处都必须出现（改一处忘另一处 = 两面观感不一致）
    const keys: Array<[string, string]> = [
      ["插值开关", "interpolate-size: allow-keywords"],
      ["折叠高度归零", "height: 0 !important"],
      ["折叠裁切", "overflow: hidden !important"],
      ["折叠隐藏", "visibility: hidden !important"],
      ["三角固定字符", 'content: "▾"'],
      ["三角旋转", "transform: rotate(-90deg)"],
    ];
    for (const [label, needle] of keys) {
      expect(css, `PM 面缺少「${label}」`).toContain(needle);
      expect(FOLD_IFRAME_CSS, `iframe 面缺少「${label}」`).toContain(needle);
    }
    // 两面都必须声明 height 过渡时长一致（这里写死 220ms，两处同值）
    expect(css).toContain("height 220ms");
    expect(FOLD_IFRAME_CSS).toContain("height 220ms");
  });

  it("退化路径：不支持 allow-keywords 时退回 display:none（功能不失效）", () => {
    for (const source of [readCss(), FOLD_IFRAME_CSS]) {
      expect(source).toContain("@supports not (interpolate-size: allow-keywords)");
      expect(source).toMatch(
        /@supports not \(interpolate-size: allow-keywords\)[\s\S]*?display: none/,
      );
    }
  });

  it("三角朝向：固定字符 + transform 旋转，不再切换 content 字符", () => {
    const css = readCss();
    // 只允许出现一个固定字符（▾），不再有 ▸ 的 content 切换
    expect(css).toContain('content: "▾"');
    expect(css).not.toContain('content: "▸"');
    expect(css).not.toContain('content: "▾";\n}\n\n.ProseMirror .lmd-fold-toggle[aria-expanded');
    // 必须有 rotate 过渡声明
    expect(css).toMatch(/\.lmd-fold-toggle::before\s*\{[\s\S]*?transform:\s*rotate\(0deg\)/);
    expect(css).toMatch(/transform\s+180ms/);
    // iframe 面同口径
    expect(FOLD_IFRAME_CSS).toContain('content: "▾"');
    expect(FOLD_IFRAME_CSS).not.toContain('content: "▸"');
    expect(FOLD_IFRAME_CSS).toContain("transform: rotate(-90deg)");
  });

  it("减少动效偏好：过渡归零（无障碍约定）", () => {
    for (const source of [readCss(), FOLD_IFRAME_CSS]) {
      expect(source).toContain("@media (prefers-reduced-motion: reduce)");
      expect(source).toMatch(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/,
      );
    }
  });
});

describe("v0.15.1 需求2：折叠动效 · 按钮元素复用与状态属性", () => {
  function mountPm(markdown: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: markdownToDoc(markdown),
      plugins: [history()],
    });
    return new EditorView(parent, { state });
  }

  const FOLD_MD = ["# 一", "", "正文一", "", "## 二", "", "正文二"].join("\n");

  it("标题节点带折叠态属性（三角旋转的状态来源）", () => {
    const doc = markdownToDoc(FOLD_MD);
    const model = buildPmFoldModel(doc);
    const h1 = model.headings[0].id;

    // 未折叠：标题节点装饰里没有 data-lmd-fold-collapsed
    const open = computePmFoldDecorations(model, new Set(), labels(), { toggle: () => {} });
    const openHeadingAttrs = open
      .map(nodeDecoAttrs)
      .filter((a) => a[FOLD_HEADING_ATTR])
      .map((a) => a[FOLD_COLLAPSED_ATTR]);
    expect(openHeadingAttrs.length).toBeGreaterThan(0);
    expect(openHeadingAttrs.every((v) => v === undefined)).toBe(true);

    // 折叠后：被折叠的标题节点必须带 "true"
    const folded = computePmFoldDecorations(model, new Set([h1]), labels(), { toggle: () => {} });
    const withAttr = folded
      .map(nodeDecoAttrs)
      .filter((a) => a[FOLD_COLLAPSED_ATTR] === "true")
      .map((a) => a[FOLD_HEADING_ATTR]);
    expect(withAttr).toContain(h1);
  });

  it("widget key 不含折叠态 → 折叠时按钮元素被复用（不重建才有过渡）", () => {
    const doc = markdownToDoc(FOLD_MD);
    const model = buildPmFoldModel(doc);
    const h1 = model.headings[0].id;

    const keysOf = (collapsed: Set<string>): string[] =>
      computePmFoldDecorations(model, collapsed, labels(), { toggle: () => {} })
        .map(widgetSpec)
        .filter((s) => typeof s.key === "string")
        .map((s) => String(s.key));

    const openKeys = keysOf(new Set());
    const foldedKeys = keysOf(new Set([h1]));
    // ⚠️ 折叠 H1 会把它**下面的 H2 一起隐藏**（hiddenBlockIndexes 的口径），
    // 被隐藏的标题不显示按钮 → foldedKeys 天然比 openKeys 少，这是正确行为。
    // 本用例要锁的是「**仍然存在**的按钮的 key 不变」：
    // 折叠后剩下的 key 必须是折叠前 key 的子集，且**没有任何 key 因折叠态而改变编码**。
    expect(foldedKeys.length).toBeLessThanOrEqual(openKeys.length);
    for (const k of foldedKeys) expect(openKeys).toContain(k);
    // H1 自己的按钮在折叠后仍然存在、且 key 与折叠前完全一致（← 这才是复用的前提）
    expect(foldedKeys).toContain(h1);
    expect(openKeys).toContain(h1);
    // 且 key 里不含折叠标志位（旧实现是 `<id>:<1|0>:<labels>`，切换就重建 DOM）
    for (const k of openKeys) expect(k).not.toMatch(/:1:/);
    for (const k of foldedKeys) expect(k).not.toMatch(/:1:/);
  });

  it("createFoldButton 登记进复用表，syncFoldButtonState 原地改状态（幂等）", () => {
    const btn = createFoldButton("h-x", false, labels(), { toggle: () => {} }) as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    syncFoldButtonState(btn, "h-x", true, labels());
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // 幂等：再同步一次结果不变、不抛错
    syncFoldButtonState(btn, "h-x", true, labels());
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    syncFoldButtonState(btn, "h-x", false, labels());
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("折叠状态变化后，已渲染的真实按钮 DOM 被原地更新（不换元素）", () => {
    // 用**真实 createEditor**（含 readingFold 插件）驱动：装饰由插件的
    // props.decorations 提供，折叠态变化经 controller 订阅 → 空事务 → 重算。
    // 这样才真的测到「PM 里按钮元素有没有被复用」，而不是只测纯函数入参。
    const host = document.createElement("div");
    document.body.appendChild(host);
    const controller = createReadingFoldController({
      docKey: "fixture-anim.md",
      enabled: true,
    });
    controller.setModel(buildPmFoldModel(markdownToDoc(FOLD_MD)));
    controller.setEnabled(true);
    const view = createEditor({
      parent: host,
      initialContent: FOLD_MD,
      foldController: controller,
    } as never);
    expect(view).toBeTruthy();
    try {
      const pm = view!;
      const model = buildPmFoldModel(pm.state.doc);
      const h1 = model.headings[0].id;
      controller.setModel(model);
      pm.dispatch(pm.state.tr);

      const headingEl = (): HTMLElement | null =>
        (Array.from(pm.dom.children) as HTMLElement[]).find(
          (el) => el.getAttribute(FOLD_HEADING_ATTR) === h1,
        ) ?? null;

      const el0 = headingEl();
      expect(el0, "H1 标题元素应已渲染").toBeTruthy();
      const sel = "." + FOLD_BTN_CLASS;
      const btnBefore = el0!.querySelector(sel) as HTMLButtonElement | null;
      expect(btnBefore, "H1 上应有折叠按钮").toBeTruthy();
      expect(btnBefore!.getAttribute("aria-expanded")).toBe("true");

      // 折叠：controller 变化 → 订阅回调 dispatch 空事务 → 装饰重算
      controller.toggle(h1);
      const el1 = headingEl();
      expect(el1, "折叠后 H1 元素仍在（它自己是可见的）").toBeTruthy();
      const btnAfter = el1!.querySelector(sel) as HTMLButtonElement | null;
      // ⭐ 关键断言：同一个元素（复用 → 三角 transform 可过渡）
      expect(btnAfter).toBe(btnBefore);
      expect(btnAfter!.getAttribute("aria-expanded")).toBe("false");
      // 标题节点也被标上折叠态（CSS 旋转的状态来源）
      expect(el1!.getAttribute(FOLD_COLLAPSED_ATTR)).toBe("true");

      // 展开：恢复
      controller.toggle(h1);
      const el2 = headingEl();
      expect(el2!.querySelector(sel)).toBe(btnBefore);
      expect(el2!.getAttribute(FOLD_COLLAPSED_ATTR)).toBeNull();
      expect(btnBefore!.getAttribute("aria-expanded")).toBe("true");
    } finally {
      view?.destroy();
      host.remove();
    }
  });

  it("iframe 面：按钮元素在折叠态变化时被复用（与 PM 面同口径）", () => {
    const doc = document.implementation.createHTMLDocument("preview");
    doc.body.innerHTML = '<h1 id="h1">一</h1><p>正文一</p><h2 id="h2">二</h2><p>正文二</p>';

    const r1 = applyReadingFoldToIframe(doc, { collapsed: new Set(), labels: labels() });
    expect(r1.buttons).toBe(2);
    const h1El = doc.getElementById("h1")!;
    const btnBefore = h1El.querySelector(`.${FOLD_BTN_CLASS}`) as HTMLButtonElement;
    expect(btnBefore.getAttribute("aria-expanded")).toBe("true");

    // 折叠 h1 → 按钮复用、属性变、标题带折叠态
    applyReadingFoldToIframe(doc, { collapsed: new Set(["h1"]), labels: labels() });
    const btnAfter = h1El.querySelector(`.${FOLD_BTN_CLASS}`) as HTMLButtonElement;
    expect(btnAfter, "按钮应被复用而不是重建").toBe(btnBefore);
    expect(btnAfter.getAttribute("aria-expanded")).toBe("false");
    expect(h1El.getAttribute(FOLD_COLLAPSED_ATTR)).toBe("true");

    // 展开 → 属性清掉
    applyReadingFoldToIframe(doc, { collapsed: new Set(), labels: labels() });
    expect(h1El.querySelector(`.${FOLD_BTN_CLASS}`)).toBe(btnBefore);
    expect(btnAfter.getAttribute("aria-expanded")).toBe("true");
    expect(h1El.getAttribute(FOLD_COLLAPSED_ATTR)).toBeNull();
  });

  it("幂等：连续切换 N 次后 DOM 终态 = 只切一次（无中间残留）", () => {
    const doc = document.implementation.createHTMLDocument("preview");
    doc.body.innerHTML = '<h1 id="h1">一</h1><p>正文一</p><h2 id="h2">二</h2><p>正文二</p>';
    const h1El = doc.getElementById("h1")!;

    // 抖动切换：折叠 → 展开 → 折叠 → 展开 ...（模拟动画期间反复点击）
    for (let i = 0; i < 5; i++) {
      applyReadingFoldToIframe(doc, { collapsed: new Set(["h1"]), labels: labels() });
      applyReadingFoldToIframe(doc, { collapsed: new Set(), labels: labels() });
    }
    // 终态 = 全展开
    expect(h1El.hasAttribute(FOLD_COLLAPSED_ATTR)).toBe(false);
    expect(h1El.querySelector(`.${FOLD_BTN_CLASS}`)!.getAttribute("aria-expanded")).toBe("true");
    // 隐藏块为 0（终态是全展开，不能有残留 hidden）
    const hiddenEls = Array.from(doc.body.children).filter((el) =>
      el.classList.contains(FOLD_HIDDEN_CLASS),
    );
    expect(hiddenEls).toHaveLength(0);

    // 再连续折叠 5 次 → 终态 = 全折叠
    for (let i = 0; i < 5; i++) {
      applyReadingFoldToIframe(doc, { collapsed: new Set(), labels: labels() });
      applyReadingFoldToIframe(doc, { collapsed: new Set(["h1"]), labels: labels() });
    }
    expect(h1El.getAttribute(FOLD_COLLAPSED_ATTR)).toBe("true");
    expect(h1El.querySelector(`.${FOLD_BTN_CLASS}`)!.getAttribute("aria-expanded")).toBe("false");
    // 按钮不重复累积
    expect(doc.querySelectorAll(`.${FOLD_BTN_CLASS}`)).toHaveLength(2);
  });

  it("折叠不碰文档：doc 身份不变、撤销栈不变（折叠只是渲染层）", () => {
    const view = mountPm(FOLD_MD);
    try {
      const docBefore = view.state.doc;
      const undoBefore = undoDepth(view.state);
      const mdBefore = docToMarkdown(docBefore);

      // 空事务（插件刷新装饰用的就是这种）：不改 doc、不进历史
      view.dispatch(view.state.tr.setMeta("addToHistory", false));

      expect(view.state.doc).toBe(docBefore);
      expect(undoDepth(view.state)).toBe(undoBefore);
      expect(redoDepth(view.state)).toBe(0);
      expect(docToMarkdown(view.state.doc)).toBe(mdBefore);
    } finally {
      view.destroy();
    }
  });
});
