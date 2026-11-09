/**
 * v0.17.0 B1 —— UnifiedDoc 树构建（`core/unified/parse.ts`）测试。
 *
 * 三个重点（都是"错了会让别处整体错位"的量级）：
 *
 * 1. **行区间口径**：`token.map` 是 `[start, end)`，`MdNode.lines` 规定 end 是
 *    "末行（含）"。口径混用会让 `data-src-line` 贴标整体偏移一行。
 * 2. **spm.blockStartLines 与旧 `topLevelBlockStartLines` 逐项一致**：
 *    那是 iframe 贴标的来源。模型层若自己另算一套，数量/顺序差一个就整体错位 ——
 *    这比"退回百分比映射"严重得多（模型注释里写明）。
 * 3. **绝不静默丢内容**：unknownTokens 上报机制要保留（沿用 exportBlocks 口径）。
 */
import { describe, it, expect } from "vitest";
import { parseUnified, buildLineStarts, topLevelBlockStartLinesFromSource } from "../../core/unified/parse";
import { topLevelBlockStartLines } from "../../core/renderPipeline";
import type { MdNode } from "../../core/unified/model";

/** 递归展平树（便于断言"共 N 个节点、kind 序列是…"） */
function flatten(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  const walk = (ns: MdNode[]) => {
    for (const n of ns) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

const kindsOf = (nodes: MdNode[]) => flatten(nodes).map((n) => n.kind);

describe("行区间口径：token.map[1] 是「末行+1」，lines.end 必须转成「末行含」", () => {
  it("单行 ATX 标题：lines = {0,0}（不是 {0,1}）", () => {
    const r = parseUnified("# h\n");
    expect(r.tree[0]!.kind).toBe("heading");
    expect(r.tree[0]!.lines).toEqual({ start: 0, end: 0 });
  });

  it("两行 Setext 标题：lines = {0,1}（下划线行并入标题 span）", () => {
    const r = parseUnified("Title\n===\n");
    expect(r.tree[0]!.kind).toBe("heading");
    expect(r.tree[0]!.lines).toEqual({ start: 0, end: 1 });
    // setext 标记必须记下来（保真四项 §6.1）
    expect(r.tree[0]!.raw?.setext).toBe(true);
  });

  it("三行 fence：lines = {0,2}", () => {
    const r = parseUnified("```js\nx\n```\n");
    expect(r.tree[0]!.kind).toBe("codeBlock");
    expect(r.tree[0]!.lines).toEqual({ start: 0, end: 2 });
  });

  it("块间空行不影响行区间（第二块从自己的首行算起）", () => {
    const r = parseUnified("# a\n\n\n# b\n");
    expect(r.tree[0]!.lines).toEqual({ start: 0, end: 0 });
    expect(r.tree[1]!.lines).toEqual({ start: 3, end: 3 });
  });
});

describe("span：字符区间必须与 lines 一致（同一行首 offset 表推导）", () => {
  it("标题 span 覆盖标题文本", () => {
    const src = "# abc\n";
    const r = parseUnified(src);
    const n = r.tree[0]!;
    expect(src.slice(n.span.start, n.span.end)).toBe("# abc");
  });

  it("多行 span 覆盖到末行尾（不含末尾换行符）", () => {
    const src = "```js\nx\ny\n```\n";
    const r = parseUnified(src);
    const n = r.tree[0]!;
    expect(src.slice(n.span.start, n.span.end)).toBe("```js\nx\ny\n```");
  });

  it("空文档：tree 为空、spm 为空，不炸", () => {
    const r = parseUnified("");
    expect(r.tree).toEqual([]);
    expect(r.spm.blockStartLines).toEqual([]);
  });

  it("buildLineStarts：\n 计数正确", () => {
    expect(buildLineStarts("")).toEqual([0]);
    expect(buildLineStarts("a")).toEqual([0]);
    expect(buildLineStarts("a\n")).toEqual([0, 2]);
    expect(buildLineStarts("a\nb")).toEqual([0, 2]);
  });
});

describe("spm.blockStartLines：必须与旧 topLevelBlockStartLines 逐项一致（贴标不偏移的前提）", () => {
  /**
   * ⚠️ 这是 B1 最关键的断言。
   *
   * 旧 `topLevelBlockStartLines`（renderPipeline.ts:282）是 `data-src-line` 贴标的
   * 唯一来源，它按 **token 口径**统计（level===0 && (nesting===1||===0) && map）。
   * 模型的 tree 可能包含更多节点（如 blockquote 内部的嵌套块、列表项）。
   * 若模型层按 tree 算 blockStartLines，两者数量就会不一致 →
   * `shouldTagPreview` 的数量自校验失败 → 退回百分比映射（保真度下降）。
   *
   * 故模型层**必须复刻 token 口径**，这里用真实 renderPipeline 做对照。
   */
  const CASES = [
    "# h1\n\n## h2\n",
    "- a\n- b\n  - c\n",
    "1. a\n2. b\n",
    "| a | b |\n|---|---|\n| 1 | 2 |\n",
    "> q1\n>\n> q2\n",
    "```js\nx\n```\n\npara\n",
    "Term\n: def\n",
    "$$\nx\n$$\n",
    "# h\n\n---\n\n[a](b)\n",
    "- a\n\n- b\n\n- c\n",
    "<!-- c -->\n\npara\n",
    "para **bold** and *ital*\n",
  ];

  it.each(CASES)("case %#：spm.blockStartLines === topLevelBlockStartLines", (src) => {
    expect(parseUnified(src).spm.blockStartLines).toEqual(topLevelBlockStartLines(src));
  });

  it("包装函数 topLevelBlockStartLinesFromSource 与旧实现一致（B3 切换前的等价性证明）", () => {
    for (const src of CASES) {
      expect(topLevelBlockStartLinesFromSource(src)).toEqual(topLevelBlockStartLines(src));
    }
  });
});

describe("spm 双向索引", () => {
  const src = "# h\n\npara\n\n- a\n- b\n";
  const r = parseUnified(src);

  it("offsetOfLine / lineAtOffset 互逆（对每个行首）", () => {
    for (let line = 0; line < r.lineCount; line++) {
      const off = r.spm.offsetOfLine(line);
      expect(r.spm.lineAtOffset(off)).toBe(line);
    }
  });

  it("offsetOfLine 越界钳到 [0, len]", () => {
    expect(r.spm.offsetOfLine(-5)).toBe(0);
    expect(r.spm.offsetOfLine(99999)).toBe(src.length);
  });

  it("blockAtOffset：落在块内返回该块；首个块之前返回 -1", () => {
    // blockStartLines 应含 0(标题) / 2(段落) / 4(列表)
    expect(r.spm.blockStartLines).toEqual([0, 2, 4]);
    expect(r.spm.blockAtOffset(0)).toBe(0);
    expect(r.spm.blockAtOffset(-1)).toBe(-1);
    // 段落行首
    expect(r.spm.blockAtOffset(r.spm.offsetOfLine(2))).toBe(1);
    // 列表行首
    expect(r.spm.blockAtOffset(r.spm.offsetOfLine(4))).toBe(2);
  });
});

describe("§7.2 覆盖表：每种语法都要产出正确 kind", () => {
  it("标题 1-6 级", () => {
    for (let lv = 1; lv <= 6; lv++) {
      const r = parseUnified(`${"#".repeat(lv)} h\n`);
      expect(r.tree[0]!.kind).toBe("heading");
      expect(r.tree[0]!.attrs.level).toBe(lv);
    }
  });

  it("Setext 两种（= 是 H1、- 是 H2）", () => {
    expect(parseUnified("T\n=\n").tree[0]!.attrs.level).toBe(1);
    expect(parseUnified("T\n-\n").tree[0]!.attrs.level).toBe(2);
    expect(parseUnified("T\n=\n").tree[0]!.raw?.setext).toBe(true);
    expect(parseUnified("T\n-\n").tree[0]!.raw?.setext).toBe(true);
  });

  it("列表三类 × 嵌套", () => {
    const bullet = parseUnified("- a\n  - b\n");
    expect(bullet.tree[0]!.kind).toBe("bulletList");
    const ordered = parseUnified("1. a\n   1. b\n");
    expect(ordered.tree[0]!.kind).toBe("orderedList");
    expect(ordered.tree[0]!.attrs.order).toBe(1);
    const task = parseUnified("- [ ] a\n- [x] b\n");
    expect(task.tree[0]!.kind).toBe("taskList");
    const items = task.tree[0]!.children || [];
    expect(items).toHaveLength(2);
    expect(items[0]!.attrs.checked).toBe(false);
    expect(items[1]!.attrs.checked).toBe(true);
  });

  it("有序列表 1) 与 1. 的 delim 必须区分（保真四项 §6.4）", () => {
    expect(parseUnified("1) a\n2) b\n").tree[0]!.attrs.delim).toBe(")");
    expect(parseUnified("1. a\n2. b\n").tree[0]!.attrs.delim).toBe(".");
    // 嵌套层同样
    expect(parseUnified("- x\n    1) a\n").tree[0]!.attrs.delim).toBe("-");
  });

  it("引用 × 嵌套 × 空行", () => {
    const r = parseUnified("> > a\n> > b\n");
    expect(r.tree[0]!.kind).toBe("blockquote");
    const inner = r.tree[0]!.children![0]!;
    expect(inner.kind).toBe("blockquote");
  });

  it("表格 × 对齐", () => {
    const r = parseUnified("| a | b |\n|:--|--:|\n| 1 | 2 |\n");
    expect(r.tree[0]!.kind).toBe("table");
    expect((r.tree[0]!.attrs.aligns as string[]).slice(0, 2)).toEqual(["left", "right"]);
    const rows = r.tree[0]!.attrs.rows as Array<Array<{ header: boolean }>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]!.header).toBe(true);
    expect(rows[1]![0]!.header).toBe(false);
  });

  it("dd 内块：children 是**完整块级树**（不拍平成 inline，§6.3 方案乙）", () => {
    const r = parseUnified("Term\n: def\n\n    ```js\n    x\n    ```\n");
    expect(r.tree[0]!.kind).toBe("defList");
    const flat = flatten(r.tree);
    const dd = flat.find((n) => n.kind === "definition_description")!;
    expect(dd.children).toBeDefined();
    const ddKinds = dd.children!.map((n) => n.kind);
    // 关键：代码块作为**独立子节点**存在，而不是被塞进 inline text
    expect(ddKinds).toContain("codeBlock");
  });

  it("dd 内表格/列表同样是块级子树", () => {
    const tbl = parseUnified("T\n: d\n\n    | a |\n    |---|\n    | 1 |\n");
    const tdd = flatten(tbl.tree).find((n) => n.kind === "definition_description")!;
    expect(tdd.children!.map((n) => n.kind)).toContain("table");
    const lst = parseUnified("T\n: d\n\n    - a\n    - b\n");
    const ldd = flatten(lst.tree).find((n) => n.kind === "definition_description")!;
    expect(ldd.children!.map((n) => n.kind)).toContain("bulletList");
  });

  it("多 dd：一个 term 下多个 definition_description", () => {
    const r = parseUnified("T\n: d1\n: d2\n");
    const dds = flatten(r.tree).filter((n) => n.kind === "definition_description");
    expect(dds).toHaveLength(2);
  });

  it("脚注：定义产出 footnote 节点并带正确 label", () => {
    const r = parseUnified("use[^x]\n\n[^x]: p1\n");
    const fn = flatten(r.tree).find((n) => n.kind === "footnote");
    expect(fn).toBeDefined();
    expect(fn!.attrs.label).toBe("x");
    expect(fn!.children!.some((n) => n.kind === "paragraph")).toBe(true);
  });

  it("多段脚注定义：内部是多个 paragraph 子节点", () => {
    const r = parseUnified("use[^x]\n\n[^x]: p1\n\n    p2\n");
    const fn = flatten(r.tree).find((n) => n.kind === "footnote")!;
    const paras = fn.children!.filter((n) => n.kind === "paragraph");
    expect(paras).toHaveLength(2);
  });

  it("[toc] 的 headings 来自 env.__headings（不自己重算）", () => {
    const src = "# one\n\n## two\n\n[toc]\n";
    const r = parseUnified(src);
    expect(r.headings.length).toBeGreaterThanOrEqual(2);
    const toc = flatten(r.tree).find((n) => n.kind === "toc")!;
    expect(Array.isArray(toc.attrs.headings)).toBe(true);
    expect((toc.attrs.headings as unknown[]).length).toBe(r.headings.length);
  });

  it("代码围栏：info / fenceChar / fenceLen 都记下（保真用）", () => {
    const bt = parseUnified("```js\nx\n```\n").tree[0]!;
    expect(bt.attrs.info).toBe("js");
    expect(bt.attrs.language).toBe("js");
    expect(bt.attrs.fenceChar).toBe("`");
    expect(bt.attrs.fenceLen).toBe(3);
    const tilde = parseUnified("~~~~py\nx\n~~~~\n").tree[0]!;
    expect(tilde.attrs.fenceChar).toBe("~");
    expect(tilde.attrs.fenceLen).toBe(4);
  });

  it("数学块 / 行内 / 图片后缀 / HTML 白名单 都不丢内容", () => {
    const mathB = parseUnified("$$\nx^2\n$$\n").tree[0]!;
    expect(mathB.kind).toBe("mathBlock");
    expect(mathB.attrs.latex).toBe("x^2");

    const inl = parseUnified("a $x$ b\n").tree[0]!;
    expect(inl.inline!.some((n) => n.kind === "mathInline")).toBe(true);

    const img = parseUnified("![alt|300|center](a.png)\n").tree[0]!;
    const imgNode = img.inline!.find((n) => n.kind === "image")!;
    expect(imgNode.text).toBe("alt|300|center"); // 原始 content 保留（可原样写回）
    expect(imgNode.payload).toBe("a.png");

    const html = parseUnified("a <u>u</u> b\n").tree[0]!;
    expect(html.inline!.map((n) => n.text).join("")).toContain("<u>");
  });
});

describe("unknownTokens：绝不静默丢内容（沿用 exportBlocks 机制）", () => {
  it("正常文档无 unknown", () => {
    expect(parseUnified("# h\n\npara\n\n- a\n").unknownTokens).toEqual([]);
  });

  it("脚注/结构 token 不计入 unknown（否则每次带脚注都误报）", () => {
    const r = parseUnified("use[^a]\n\n[^a]: d\n");
    expect(r.unknownTokens).toEqual([]);
  });
});
