// @vitest-environment jsdom
/**
 * v0.17.0 P0 数据保真：normalizeOrderedLists 范围收窄后的内容往返测试
 *
 * ## 缺陷背景（用户报告）
 * 阅读→编辑时 ModeSync.tsx 调用 `getMarkdownFromDoc(doc, { normalizeOrderedLists: true })`，
 * 该选项此前在 serializer.ts 里**一刀切跳过**两处原文保真机制：
 * 1. 整篇 B6 快路径（全部块命中且行号连续 → 逐字节返回原文）
 * 2. 逐块 `getBlockSource` 原文行区间切片
 *
 * 于是**所有**块（含完全未编辑的段落/公式/Setext/代码块）都走规范序列化，
 * 实测 `\sum_{i=1}^{n}` 被改写为 `\\sum\_{i=1}^{n}`（落盘 +7 字节，公式语义被破坏）。
 *
 * ## 修复（serializer.ts，范围收窄）
 * - 整篇快路径：仅当 `normalizeOrderedLists && 存在顶层 ordered_list` 时才跳过；
 *   无有序列表时快路径照常生效 → 与不传选项逐字节一致。
 * - 每块切片：仅 `ordered_list` 在归一化模式下跳过原文保真（必须走 listToMarkdown
 *   递增重编号）；其余块继续 `getBlockSource` 原文切片。
 * - 归一化语义不变：有序列表跳过原文 → 递增输出 `1. 2. 3.`（编号递增；
 *   `1)` 分隔符按 v0.11.0 B3-6 契约保留，见 v0170-r4-list.test.ts）。
 *
 * ## 本文件验收点（逐字节往返 `markdownToDoc` → `docToMarkdown(doc, NORM)`）
 * 1. 畸形公式（`$$` 与 LaTeX 同行、块形式单/双反斜杠）往返逐字节不变
 * 2. 含反斜杠文本 `C:\path\to\file` 不变
 * 3. 词内下划线 `hello_world_test` 与非词内字面下划线不变
 * 4. Setext 标题 `Title\n===` 不变（规范序列化会改写成 ATX `# Title`）
 * 5. `1)` 分隔符有序列表归一化后编号递增（`1)` `2)`）
 * 6. 混合文档（列表+公式+段落+Setext）：列表递增、其余块逐字节不变
 * 7. 无有序列表的文档：整篇快路径生效，带选项结果与不传选项一致
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

const NORM = { normalizeOrderedLists: true } as const;

/** 便捷：解析 → 归一化序列化 */
function norm(md: string): string {
  return docToMarkdown(markdownToDoc(md), NORM);
}

/** 便捷：解析 → 默认序列化（不传选项） */
function plain(md: string): string {
  return docToMarkdown(markdownToDoc(md));
}

describe("P0 保真 · 畸形公式往返逐字节不变", () => {
  it("★ 块形式（单反斜杠 LaTeX）：`$$\\n\\sum_{i=1}^{n} x_i\\n$$` 往返不变", () => {
    const md = "$$\n\\sum_{i=1}^{n} x_i\n$$\n";
    expect(norm(md)).toBe(md);
  });

  it("块形式（双反斜杠字面量）同样逐字节不变", () => {
    const md = "$$\n\\\\sum_{i=1}^{n} x_i\n$$\n";
    expect(norm(md)).toBe(md);
  });

  it("★ 同行畸形公式：`$$ \\sum_{i=1}^{n} $$` 往返不变", () => {
    const md = "$$ \\sum_{i=1}^{n} $$\n";
    expect(norm(md)).toBe(md);
  });

  it("回归锚：公式不再被改写成 `\\\\sum\\_{...}`（+7 字节缺陷不得复发）", () => {
    const md = "$$\n\\sum_{i=1}^{n} x_i\n$$\n";
    const out = norm(md);
    expect(out).not.toContain("\\\\sum\\_{");
    expect(out.length).toBe(md.length);
  });
});

describe("P0 保真 · 反斜杠与下划线文本往返不变", () => {
  it("★ 含反斜杠路径 `C:\\path\\to\\file` 往返不变", () => {
    const md = "路径：C:\\path\\to\\file\n";
    expect(norm(md)).toBe(md);
  });

  it("★ 词内下划线 `hello_world_test` 往返不变", () => {
    const md = "标识符 hello_world_test 保持原样\n";
    expect(norm(md)).toBe(md);
  });

  it("★ 非词内字面下划线往返不变（原文切片保真，不被转义成 `\\_`）", () => {
    const md = "1 _ 2 _ 3\n";
    expect(norm(md)).toBe(md);
    expect(norm(md)).not.toContain("\\_");
  });
});

describe("P0 保真 · Setext 标题往返不变", () => {
  it("★ `Title\\n===` 往返不变（不得被改写成 ATX `# Title`）", () => {
    const md = "Title\n===\n";
    expect(norm(md)).toBe(md);
    expect(norm(md)).not.toContain("# Title");
  });

  it("Setext 二级（`---` 下划线）往返不变", () => {
    const md = "Sub\n---\n";
    expect(norm(md)).toBe(md);
  });
});

describe("P0 保真 · 有序列表归一化语义不变（编号递增）", () => {
  it("★ `1)` 分隔符有序列表归一化后编号递增：`1) 甲/1) 乙` → `1) 甲/2) 乙`", () => {
    // 编号 1、2 递增；`)` 分隔符按 v0.11.0 B3-6 契约保留（与 v0170-r4-list 一致）
    expect(norm("1) 甲\n1) 乙\n")).toBe("1) 甲\n2) 乙\n");
  });

  it("三个 `1)` 项 → `1) 2) 3)` 递增", () => {
    expect(norm("1) 甲\n1) 乙\n1) 丙\n")).toBe("1) 甲\n2) 乙\n3) 丙\n");
  });

  it("`1.` 分隔符同理递增（既有语义不变）", () => {
    expect(norm("1. 甲\n1. 乙\n")).toBe("1. 甲\n2. 乙\n");
  });
});

describe("P0 保真 · 混合文档：各块独立保真（列表递增、其余逐字节不变）", () => {
  /**
   * 块构成：畸形公式 / 有序列表 / Setext 标题 / 反斜杠+下划线段落。
   * 期望：**只有列表编号** 1→2 变化，其余每个块（含块间空行）逐字节不变。
   */
  const MIXED_IN = "$$ \\sum_{i=1}^{n} $$\n\n1. 甲\n1. 乙\n\nTitle\n===\n\nC:\\path\\to\\file 与 hello_world_test\n";
  const MIXED_OUT = "$$ \\sum_{i=1}^{n} $$\n\n1. 甲\n2. 乙\n\nTitle\n===\n\nC:\\path\\to\\file 与 hello_world_test\n";

  it("★ 混合文档：列表递增为 1./2.，公式/Setext/段落逐字节保真", () => {
    expect(norm(MIXED_IN)).toBe(MIXED_OUT);
  });

  it("逐块独立保真：除了列表编号，输出与输入逐字节相等（长度差 0）", () => {
    const out = norm(MIXED_IN);
    expect(out.length).toBe(MIXED_IN.length);
    // 唯一差异是第 4 行（索引 3）的编号：`1. 乙` → `2. 乙`
    const inLines = MIXED_IN.split("\n");
    const outLines = out.split("\n");
    const diff = inLines.map((l, i) => (l === outLines[i] ? null : i)).filter((v) => v !== null);
    expect(diff).toEqual([3]);
  });

  it("幂等：归一化后再归一化不再累积改写", () => {
    expect(norm(MIXED_OUT)).toBe(MIXED_OUT);
  });
});

describe("P0 保真 · 无有序列表时整篇快路径生效", () => {
  const NO_LIST = "# ATX 标题\n\n$$ \\sum_{i=1}^{n} $$\n\nC:\\path\\to\\file\n\n> 引用\n\n```\ncode_block()\n```\n";

  it("★ 无有序列表：带选项结果与不传选项逐字节一致", () => {
    expect(norm(NO_LIST)).toBe(plain(NO_LIST));
  });

  it("★ 无有序列表：两者都逐字节等于原文（B6 快路径在归一化模式下仍生效）", () => {
    expect(norm(NO_LIST)).toBe(NO_LIST);
    expect(plain(NO_LIST)).toBe(NO_LIST);
  });
});
