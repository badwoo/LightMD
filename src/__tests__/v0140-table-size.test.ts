/**
 * v0.14.0 需求7：表格列宽/行高持久化（重开文档仍生效）
 *
 * ## 用户原话
 * 「表格拖拽调整行高或列宽后，关闭文档重新打开后会失效。」
 *
 * ## 根因（本测试锁定的契约）
 * 拖拽只把尺寸写进 PM 节点 attrs（`table.attrs.columnWidths` / `rowHeights`），
 * 而 GFM 管道表格语法无法表达尺寸 → 序列化时这两个 attrs 被整体丢弃 →
 * 存盘后 markdown 里没有尺寸 → 重开解析回 null → 尺寸失效。
 *
 * ## 修复
 * 旁路注释指令，写在**表格之后空一行**的位置（实测位置结论见
 * `core/markdown/tableSizeDirective.ts` 文件头）：
 *
 * ```markdown
 * | A | B |
 * | --- | --- |
 * | 1 | 2 |
 *
 * <!-- lightmd-table-size: {"columnWidths":[120,240],"rowHeights":[40,40,60]} -->
 * ```
 *
 * ## 本文件锁定的硬约束
 * ① **纯管道表格零 diff**：无尺寸时一个字节都不多（v0.9.0 B6 契约）；
 * ② **有尺寸时往返稳定**：md → doc → md 第二次与第一次逐字节相同；
 * ③ 指令行**不进正文**（不变成段落/文本），坏 JSON 静默忽略且不影响表格；
 * ④ 长度不匹配（比列数短/长）不崩，attrs 长度被校正；
 * ⑤ 含 colspan/rowspan 的表格同样支持（`tableToMarkdownMerged` 分支）；
 * ⑥ 「拖拽 → 存盘 → 重开」端到端：setNodeMarkup 写入 attrs 的**新**表格节点
 *    （B6 WeakMap 不命中）→ docToMarkdown 输出指令 → markdownToDoc 还原 attrs。
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import {
  encodeTableSizeDirective,
  isTableSizeDirectiveLine,
  parseTableSizeDirective,
  sanitizeSizeArray,
} from "../core/markdown/tableSizeDirective";

// ─── 辅助 ────────────────────────────────────────────────

function roundtrip(src: string): string {
  return docToMarkdown(markdownToDoc(src));
}

function findTable(doc: PmNode): PmNode | null {
  let found: PmNode | null = null;
  doc.descendants((n) => {
    if (n.type.name === "table" && !found) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

function tableAttrs(src: string): { columnWidths: unknown; rowHeights: unknown } {
  const table = findTable(markdownToDoc(src));
  if (!table) throw new Error("没有解析出表格");
  return { columnWidths: table.attrs.columnWidths, rowHeights: table.attrs.rowHeights };
}

/** 把 doc 里第一个表格替换为带尺寸的新节点（等价于拖拽后的 setNodeMarkup） */
function withTableSize(
  doc: PmNode,
  columnWidths: number[] | null,
  rowHeights: number[] | null,
): PmNode {
  let tablePos = -1;
  let tableNode: PmNode | null = null;
  doc.descendants((n, pos) => {
    if (n.type.name === "table" && !tableNode) {
      tablePos = pos;
      tableNode = n;
      return false;
    }
    return true;
  });
  if (!tableNode || tablePos < 0) throw new Error("没有表格");
  const tr = EditorState.create({ doc }).tr.setNodeMarkup(tablePos, undefined, {
    ...(tableNode as PmNode).attrs,
    columnWidths,
    rowHeights,
  });
  return tr.doc;
}

// ─── ① 纯函数层 ──────────────────────────────────────────

describe("tableSizeDirective 纯函数", () => {
  it("encode：无尺寸返回空串（零 diff 的唯一开关）", () => {
    expect(encodeTableSizeDirective(null, null)).toBe("");
    expect(encodeTableSizeDirective([], [])).toBe("");
    // 全是非法值 → 归一化后为空 → 同样不输出
    expect(encodeTableSizeDirective([0, -5, NaN] as number[], null)).toBe("");
  });

  it("encode：只输出有值的一侧，JSON 单行紧凑", () => {
    expect(encodeTableSizeDirective([120, 240], null)).toBe(
      '<!-- lightmd-table-size: {"columnWidths":[120,240]} -->',
    );
    expect(encodeTableSizeDirective(null, [40, 60])).toBe(
      '<!-- lightmd-table-size: {"rowHeights":[40,60]} -->',
    );
    expect(encodeTableSizeDirective([120], [40])).toBe(
      '<!-- lightmd-table-size: {"columnWidths":[120],"rowHeights":[40]} -->',
    );
  });

  it("parse：与 encode 互逆", () => {
    const line = encodeTableSizeDirective([120, 240], [40, 40, 60]);
    expect(parseTableSizeDirective(line)).toEqual({
      columnWidths: [120, 240],
      rowHeights: [40, 40, 60],
    });
  });

  it("parse：坏 JSON / 非对象 / 非指令行 → null（不抛）", () => {
    expect(parseTableSizeDirective("<!-- lightmd-table-size: {bad json} -->")).toBeNull();
    expect(parseTableSizeDirective("<!-- lightmd-table-size: [1,2] -->")).toBeNull();
    expect(parseTableSizeDirective("<!-- lightmd-table-size: {} -->")).toBeNull();
    expect(parseTableSizeDirective('<!-- lightmd-table-size: {"foo":1} -->')).toBeNull();
    expect(parseTableSizeDirective("<!-- 普通注释 -->")).toBeNull();
    expect(parseTableSizeDirective("| A | B |")).toBeNull();
  });

  it("isTableSizeDirectiveLine：坏 JSON 也算指令行（必须吞掉，不能进正文）", () => {
    expect(isTableSizeDirectiveLine('<!-- lightmd-table-size: {"columnWidths":[1]} -->')).toBe(true);
    expect(isTableSizeDirectiveLine("<!-- lightmd-table-size: {bad json} -->")).toBe(true);
    expect(isTableSizeDirectiveLine("  <!-- lightmd-table-size: x -->  ")).toBe(true);
    expect(isTableSizeDirectiveLine("<!-- other -->")).toBe(false);
  });

  it("sanitizeSizeArray：正整数、四舍五入、丢弃非法、长度校正", () => {
    expect(sanitizeSizeArray([120.4, 240.6])).toEqual([120, 241]);
    expect(sanitizeSizeArray([0, -3, 12])).toEqual([12]);
    expect(sanitizeSizeArray([NaN, Infinity, 5])).toEqual([5]);
    expect(sanitizeSizeArray(["120", 240])).toEqual([120, 240]);
    expect(sanitizeSizeArray(null)).toBeNull();
    expect(sanitizeSizeArray("x")).toBeNull();
    expect(sanitizeSizeArray([])).toBeNull();
    // 超长截断
    expect(sanitizeSizeArray([1, 2, 3, 4], 2)).toEqual([1, 2]);
    // 不足补齐（给了 padValue 才补）
    expect(sanitizeSizeArray([100], 3, 100)).toEqual([100, 100, 100]);
    expect(sanitizeSizeArray([100], 3)).toEqual([100]);
  });
});

// ─── ② 纯管道表格零 diff（回归锁） ────────────────────────

describe("零 diff 回归锁：无尺寸的纯管道表格逐字节不变", () => {
  const samples: Record<string, string> = {
    "2×2 简单表格": "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    "3 列含对齐": "| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n",
    "多行 + 空单元格": "| H1 | H2 |\n| --- | --- |\n| a | b |\n|  | 2 |\n| c | d |\n",
    "单元格含行内格式": "| **粗** | *斜* | `code` |\n| --- | --- | --- |\n| [链接](a.md) | ~~删~~ | 普通 |\n",
  };

  for (const [name, src] of Object.entries(samples)) {
    it(`${name}：markdownToDoc → docToMarkdown 恒等`, () => {
      const out = roundtrip(src);
      expect(out).toBe(src);
      // 一个字节都不能多：绝不能出现指令
      expect(out).not.toContain("lightmd-table-size");
    });
  }

  it("表格前后有段落时仍零 diff", () => {
    const src = "before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n";
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── ③ columnWidths 往返 ─────────────────────────────────

describe("columnWidths：序列化含指令 → 解析还原 attrs → 再序列化稳定", () => {
  const BASE = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
  const WIDTHS = [120, 240];

  it("序列化输出带指令（表格后空一行）", () => {
    const md = docToMarkdown(withTableSize(markdownToDoc(BASE), WIDTHS, null));
    expect(md).toBe(
      `${BASE}\n<!-- lightmd-table-size: {"columnWidths":[120,240]} -->\n`,
    );
    // 指令行与表格之间恰好一个空行
    expect(md.split("\n")).toEqual([
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      '<!-- lightmd-table-size: {"columnWidths":[120,240]} -->',
      "",
    ]);
  });

  it("重开解析：attrs 还原，指令行不进正文", () => {
    const md = docToMarkdown(withTableSize(markdownToDoc(BASE), WIDTHS, null));
    const doc = markdownToDoc(md);
    expect(tableAttrs(md)).toEqual({ columnWidths: WIDTHS, rowHeights: null });
    // 正文只有表格内容，没有注释文本
    expect(doc.textContent).toBe("AB12");
    expect(doc.textContent).not.toContain("lightmd-table-size");
    // 顶层只有表格一个块（指令被吞掉，不是独立段落）
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type.name).toBe("table");
  });

  it("往返稳定：第二次序列化与第一次逐字节相同", () => {
    const md1 = docToMarkdown(withTableSize(markdownToDoc(BASE), WIDTHS, null));
    const md2 = docToMarkdown(markdownToDoc(md1));
    const md3 = docToMarkdown(markdownToDoc(md2));
    expect(md2).toBe(md1);
    expect(md3).toBe(md1);
    // 指令只出现一次（不会每次多输出一条）
    expect(md1.split("lightmd-table-size").length - 1).toBe(1);
  });

  it("未编辑的表格（B6 原文切片）也完整保留指令", () => {
    const src = `${BASE}\n<!-- lightmd-table-size: {"columnWidths":[120,240]} -->\n`;
    // 解析 → 序列化：表格块命中原文切片，指令在块的行区间内 → 原样输出
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── ④ rowHeights 往返 ───────────────────────────────────

describe("rowHeights：序列化 → 解析 → 稳定", () => {
  const BASE = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
  const HEIGHTS = [40, 40, 60];

  it("序列化含 rowHeights 指令", () => {
    const md = docToMarkdown(withTableSize(markdownToDoc(BASE), null, HEIGHTS));
    expect(md).toContain('<!-- lightmd-table-size: {"rowHeights":[40,40,60]} -->');
    expect(md).not.toContain("columnWidths");
  });

  it("重开解析：attrs 还原 + 往返稳定", () => {
    const md1 = docToMarkdown(withTableSize(markdownToDoc(BASE), null, HEIGHTS));
    const doc2 = markdownToDoc(md1);
    expect(findTable(doc2)!.attrs.rowHeights).toEqual(HEIGHTS);
    expect(findTable(doc2)!.attrs.columnWidths).toBeNull();
    expect(docToMarkdown(doc2)).toBe(md1);
  });
});

// ─── ⑤ 两者都有 ──────────────────────────────────────────

describe("columnWidths + rowHeights 同时存在", () => {
  const BASE = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";

  it("同一条指令内携带两个数组，键顺序固定", () => {
    const md = docToMarkdown(
      withTableSize(markdownToDoc(BASE), [120, 240, 160], [40, 40, 60]),
    );
    expect(md).toContain(
      '<!-- lightmd-table-size: {"columnWidths":[120,240,160],"rowHeights":[40,40,60]} -->',
    );
  });

  it("重开解析 + 往返稳定", () => {
    const md1 = docToMarkdown(
      withTableSize(markdownToDoc(BASE), [120, 240, 160], [40, 40, 60]),
    );
    const doc2 = markdownToDoc(md1);
    expect(findTable(doc2)!.attrs.columnWidths).toEqual([120, 240, 160]);
    expect(findTable(doc2)!.attrs.rowHeights).toEqual([40, 40, 60]);
    expect(docToMarkdown(doc2)).toBe(md1);
  });
});

// ─── ⑥ 含合并单元格的表格 ────────────────────────────────

describe("含 colspan/rowspan 的表格 + 尺寸（走 tableToMarkdownMerged 分支）", () => {
  it("colspan 表格：指令照常输出、往返稳定", () => {
    const base =
      '| A | B | C |\n| --- | --- | --- |\n| <td colspan="2">M</td> | C |\n';
    const md1 = docToMarkdown(withTableSize(markdownToDoc(base), [100, 200, 300], null));
    expect(md1).toContain('<td colspan="2">M</td>');
    expect(md1).toContain('<!-- lightmd-table-size: {"columnWidths":[100,200,300]} -->');
    const doc2 = markdownToDoc(md1);
    expect(findTable(doc2)!.attrs.columnWidths).toEqual([100, 200, 300]);
    expect(docToMarkdown(doc2)).toBe(md1);
  });

  it("rowspan 表格 + 两个尺寸数组：往返稳定", () => {
    const base =
      '| A | B |\n| --- | --- |\n| <td rowspan="2">R</td> | 1 |\n| 2 |\n';
    const md1 = docToMarkdown(withTableSize(markdownToDoc(base), [150, 250], [30, 30, 30]));
    expect(md1).toContain('rowspan="2"');
    expect(md1).toContain('"columnWidths":[150,250]');
    expect(md1).toContain('"rowHeights":[30,30,30]');
    const doc2 = markdownToDoc(md1);
    expect(findTable(doc2)!.attrs.columnWidths).toEqual([150, 250]);
    expect(findTable(doc2)!.attrs.rowHeights).toEqual([30, 30, 30]);
    expect(docToMarkdown(doc2)).toBe(md1);
  });
});

// ─── ⑦ 损坏指令 ─────────────────────────────────────────

describe("指令损坏：表格正常、尺寸为 null、正文不含该行", () => {
  const BASE = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";

  it("坏 JSON → 静默忽略（不抛、不影响表格）", () => {
    const src = `${BASE}\n<!-- lightmd-table-size: {bad json} -->\n`;
    const doc = markdownToDoc(src);
    const table = findTable(doc);
    expect(table).toBeTruthy();
    expect(table!.attrs.columnWidths).toBeNull();
    expect(table!.attrs.rowHeights).toBeNull();
    expect(doc.textContent).toBe("AB12");
    expect(doc.childCount).toBe(1);
  });

  it("坏 JSON 的指令行不会被当成正文回写（不产生段落）+ 往返稳定", () => {
    const src = `${BASE}\n<!-- lightmd-table-size: {bad json} -->\n`;
    const doc = markdownToDoc(src);
    // 核心契约：指令行被吞掉，**不产生段落节点**（正文里没有这行可见文字）
    expect(doc.childCount).toBe(1);
    const out = docToMarkdown(doc);
    // B6 原文切片快路径会把"完全未编辑"的文档逐字节返回（含这行注释）——
    // 这是**刻意**的：我们不清洗用户文件，且注释在任何渲染路径都不可见。
    // 因此这里断言的是「稳定」而不是「被删除」。
    expect(docToMarkdown(markdownToDoc(out))).toBe(out);
    expect(out).not.toMatch(/^\s*bad json/m);
  });

  it("键名不对 / 值不是数组 → 静默忽略", () => {
    const src1 = `${BASE}\n<!-- lightmd-table-size: {"foo":[1,2]} -->\n`;
    expect(tableAttrs(src1)).toEqual({ columnWidths: null, rowHeights: null });
    const src2 = `${BASE}\n<!-- lightmd-table-size: {"columnWidths":"120,240"} -->\n`;
    expect(tableAttrs(src2)).toEqual({ columnWidths: null, rowHeights: null });
    // 正文都不含指令行（且不产生段落节点）
    expect(markdownToDoc(src1).childCount).toBe(1);
    expect(markdownToDoc(src2).childCount).toBe(1);
    const out1 = docToMarkdown(markdownToDoc(src1));
    // 未编辑文档走 B6 原文切片 → 原样返回（不清洗用户文件），关键是稳定、且
    // 注释行不会被"重新序列化"成普通段落文本
    expect(docToMarkdown(markdownToDoc(out1))).toBe(out1);
    expect(out1).not.toMatch(/^\s*\{"foo"/m);
  });

  it("指令行紧跟正文段落时不会被误吞（只认表格之后）", () => {
    const src = 'para\n\n<!-- lightmd-table-size: {"columnWidths":[10,20]} -->\n';
    const doc = markdownToDoc(src);
    // 没有表格 → 该注释按普通注释内容留在文档里（HTML 注释是合法内容）
    expect(doc.textContent).toContain("lightmd-table-size");
  });
});

// ─── ⑧ 长度不匹配 ───────────────────────────────────────

describe("指令长度与表格列/行数不匹配：不崩、attrs 长度被校正", () => {
  it("columnWidths 只有 2 个但表格 4 列 → 补齐到 4（缺省列 100px）", () => {
    const src =
      "| A | B | C | D |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n\n" +
      '<!-- lightmd-table-size: {"columnWidths":[120,240]} -->\n';
    const attrs = tableAttrs(src);
    expect(attrs.columnWidths).toEqual([120, 240, 100, 100]);
  });

  it("columnWidths 比列数多 → 截断到列数", () => {
    const src =
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n" +
      '<!-- lightmd-table-size: {"columnWidths":[120,240,300,400]} -->\n';
    expect(tableAttrs(src).columnWidths).toEqual([120, 240]);
  });

  it("rowHeights 不足行数 → 补齐到行数（缺省行 30px）", () => {
    const src =
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n" +
      '<!-- lightmd-table-size: {"rowHeights":[50]} -->\n';
    // 表头 1 行 + 数据 2 行 = 3 行
    expect(tableAttrs(src).rowHeights).toEqual([50, 30, 30]);
  });

  it("校正后的 attrs 再序列化仍稳定（不反复补/截）", () => {
    const src =
      "| A | B | C | D |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n\n" +
      '<!-- lightmd-table-size: {"columnWidths":[120,240]} -->\n';
    const doc1 = markdownToDoc(src);
    // parser 读回即已补齐到 4 列（attrs 契约：长度恒等于列数）
    expect(findTable(doc1)!.attrs.columnWidths).toEqual([120, 240, 100, 100]);
    const md1 = docToMarkdown(doc1);
    const md2 = docToMarkdown(markdownToDoc(md1));
    // 关键：两次序列化**逐字节相同**（收敛）。
    // ⚠️ 注意这里**未编辑**，走的是 B6 原文切片快路径 → md1 就是原文（指令仍是
    // 用户写的 [120,240]，不被改写）。这是刻意的：不编辑就不改文件。
    expect(md2).toBe(md1);
    // 而一旦表格节点被编辑（新节点 → WeakMap 不命中），serializer 就按**实际列数**
    // 归一化输出，写到终态，从而避免"每次保存都改写文件"。
    const edited = withTableSize(markdownToDoc(src), [120, 240, 100, 100], null);
    expect(docToMarkdown(edited)).toContain('"columnWidths":[120,240,100,100]');
  });
});

// ─── ⑨ 端到端：拖拽 → 存盘 → 重开 ─────────────────────────

describe("端到端：拖拽改尺寸 → 存盘 → 重开 → 尺寸仍在", () => {
  const SOURCE = "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |\n";

  it("columnWidths：setNodeMarkup 写入 → docToMarkdown → markdownToDoc → attrs 仍在", () => {
    // ① 打开文档（真实解析，表格块带 B6 原文记录）
    const opened = markdownToDoc(SOURCE);
    expect(findTable(opened)!.attrs.columnWidths).toBeNull();

    // ② 拖拽列宽（table-editor 的 onMouseUp 就是 tr.setNodeMarkup → 新节点）
    const dragged = withTableSize(opened, [180, 220], null);

    // ③ 存盘
    const saved = docToMarkdown(dragged);
    expect(saved).toContain('<!-- lightmd-table-size: {"columnWidths":[180,220]} -->');

    // ④ 关闭 + 重开（重新解析存盘内容）
    const reopened = markdownToDoc(saved);

    // ⑤ 尺寸仍在
    const table = findTable(reopened);
    expect(table!.attrs.columnWidths).toEqual([180, 220]);
    // 正文干净（指令没变成可见文字）
    expect(reopened.textContent).toBe("姓名年龄张三30");
  });

  it("rowHeights：同样的端到端链路", () => {
    // SOURCE 实际是 **2 行**（表头 1 行 + 数据 1 行）—— 早先这里写成 3 个值是把行数
    // 算错了（与 table-editor 的 rowCount 口径不一致）。长度必须等于真实行数，
    // 否则序列化端会按行数归一化、看起来"尺寸自己变了"。
    const opened = markdownToDoc(SOURCE);
    expect(findTable(opened)).toBeTruthy();
    let rowCount = 0;
    findTable(opened)!.forEach((section) => {
      if (section.type.name === "table_head" || section.type.name === "table_body") {
        section.forEach(() => rowCount++);
      }
    });
    expect(rowCount).toBe(2);

    const dragged = withTableSize(opened, null, [48, 72]);
    const saved = docToMarkdown(dragged);
    expect(saved).toContain('<!-- lightmd-table-size: {"rowHeights":[48,72]} -->');
    const reopened = markdownToDoc(saved);
    expect(findTable(reopened)!.attrs.rowHeights).toEqual([48, 72]);
    expect(reopened.textContent).toBe("姓名年龄张三30");
  });

  it("rowHeights 个数多于行数 → 截断到行数（不把表格撑高）", () => {
    const opened = markdownToDoc(SOURCE);
    const dragged = withTableSize(opened, null, [48, 48, 72]);
    const saved = docToMarkdown(dragged);
    // 序列化端按实际行数（2）归一化 → 只写 2 个
    expect(saved).toContain('<!-- lightmd-table-size: {"rowHeights":[48,48]} -->');
    expect(saved).not.toContain("72");
    expect(findTable(markdownToDoc(saved))!.attrs.rowHeights).toEqual([48, 48]);
  });

  it("两个尺寸都拖过：一次存盘同时带上两个数组", () => {
    const opened = markdownToDoc(SOURCE);
    const dragged = withTableSize(opened, [180, 220], [48, 72]);
    const saved = docToMarkdown(dragged);
    expect(saved).toContain(
      '<!-- lightmd-table-size: {"columnWidths":[180,220],"rowHeights":[48,72]} -->',
    );
    const reopened = markdownToDoc(saved);
    expect(findTable(reopened)!.attrs).toMatchObject({
      columnWidths: [180, 220],
      rowHeights: [48, 72],
    });
  });

  it("重开后继续编辑其它块：尺寸指令不丢、不重复", () => {
    const opened = markdownToDoc(SOURCE);
    const dragged = withTableSize(opened, [180, 220], null);
    const saved = docToMarkdown(dragged);
    // 重开后在**文档末尾**追加一个段落（模拟继续编辑其它块）。
    // ⚠️ 不能用 insertText(pos=1)：那个位置在表格内部（表格从 0 开始，1 是首格），
    // 会把表格改坏成"一格表"（早先版本就是这么写的，导致断言出 2 条指令）。
    const reopened = markdownToDoc(saved);
    const tr = EditorState.create({ doc: reopened }).tr;
    const end = reopened.content.size;
    tr.insert(end, reopened.type.schema.nodes.paragraph.create(null, reopened.type.schema.text("追加")));
    const appended = tr.doc;
    const saved2 = docToMarkdown(appended);
    // 指令仍只有一条
    expect(saved2.split("lightmd-table-size").length - 1).toBe(1);
    // 再重开尺寸仍在
    expect(findTable(markdownToDoc(saved2))!.attrs.columnWidths).toEqual([180, 220]);
  });

  it("重开后把尺寸重置为 null → 指令消失（回到零 diff）", () => {
    const opened = markdownToDoc(SOURCE);
    const dragged = withTableSize(opened, [180, 220], null);
    const reopened = markdownToDoc(docToMarkdown(dragged));
    const cleared = withTableSize(reopened, null, null);
    expect(docToMarkdown(cleared)).toBe(SOURCE);
  });
});
