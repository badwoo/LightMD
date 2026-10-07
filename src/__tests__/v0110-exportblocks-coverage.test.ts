/**
 * v0.11.0 B2-4：DOCX/EPUB/LaTeX 导出不得静默丢失内容。
 *
 * 缺陷背景（P0）：
 *   `exportBlocks.parseBlockTokens` 的 switch 只覆盖 heading/paragraph/lists/
 *   fence/code_block/math/hr/table/blockquote，其余 token 走
 *   `default: i++`（注释自述「忽略未识别的 token」）→
 *   实测 `parseBlockTokens("- [ ] task one")` 返回 `[]`（任务列表整体消失）、
 *   `"Term\n: Definition"` 只剩 `Definition`（术语丢失）。
 *
 * 修复口径：
 *   ① switch 补齐 task_list / defList / footnote / toc；
 *   ② **default 分支不再静默丢弃** —— 收集到 unknownTokens 并由调用方上报，
 *      即使未来再漏新语法，用户也会收到「导出结果可能不完整」提示，
 *      而不是拿到一个悄悄缺内容的文件（这是本项的核心价值）。
 */
import { describe, it, expect } from "vitest";
import {
  createDefaultMarkdownIt,
  parseBlockTokensDetailed,
  type Block,
} from "../utils/exportBlocks";

/** 便捷：markdown → { blocks, unknownTokens } */
function parse(md: string): { blocks: Block[]; unknownTokens: string[] } {
  const inst = createDefaultMarkdownIt();
  const tokens = inst.parse(md, {});
  return parseBlockTokensDetailed(tokens, 0, tokens.length);
}

describe("v0.11.0 B2-4 导出 token 覆盖（不再静默丢内容）", () => {
  it("【复现 P0】任务列表此前返回空数组，现须保留内容", () => {
    const { blocks: bs } = parse("- [ ] task one\n- [x] task two\n");
    expect(bs.length).toBeGreaterThan(0);
    const kinds = bs.map((b) => b.kind);
    expect(kinds).toContain("taskList");
  });

  it("任务列表保留勾选状态与文本", () => {
    const { blocks: bs } = parse("- [ ] 未完成\n- [x] 已完成\n");
    const task = bs.find((b) => b.kind === "taskList") as
      | { kind: "taskList"; items: { runs: { text: string }[]; checked: boolean }[] }
      | undefined;
    expect(task).toBeDefined();
    expect(task!.items.length).toBe(2);
    expect(task!.items[0].checked).toBe(false);
    expect(task!.items[1].checked).toBe(true);
    expect(task!.items[0].runs[0].text).toContain("未完成");
    expect(task!.items[1].runs[0].text).toContain("已完成");
  });

  it("定义列表保留术语与定义（此前术语丢失）", () => {
    const { blocks: bs } = parse("Term\n: Definition\n");
    const kinds = bs.map((b) => b.kind);
    expect(kinds).toContain("defList");
    const dl = bs.find((b) => b.kind === "defList") as
      | { kind: "defList"; items: { term: { text: string }[]; descriptions: { text: string }[][] }[] }
      | undefined;
    expect(dl).toBeDefined();
    expect(dl!.items.length).toBeGreaterThan(0);
    // 术语与定义都在
    expect(JSON.stringify(dl!.items)).toContain("Term");
    expect(JSON.stringify(dl!.items)).toContain("Definition");
  });

  it("多术语定义列表逐项保留", () => {
    const { blocks: bs } = parse("A\n: desc A\n\nB\n: desc B\n");
    const dl = bs.find((b) => b.kind === "defList") as
      | { kind: "defList"; items: unknown[] }
      | undefined;
    expect(dl).toBeDefined();
    expect(dl!.items.length).toBe(2);
  });

  it("无未识别 token 时 unknownTokens 为空（不误报）", () => {
    const { unknownTokens } = parse("# 标题\n\n普通段落\n\n- 列表\n\n```js\ncode\n```\n");
    expect(unknownTokens).toEqual([]);
  });

  it("既有语法无回归：标题/段落/列表/代码/表格/引用/公式仍在", () => {
    const { blocks: bs } = parse(
      "# H1\n\npara\n\n- a\n- b\n\n1. x\n\n```js\ncode\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> quote\n\n---\n\n$$E=mc^2$$\n"
    );
    const kinds = new Set<string>(bs.map((b) => b.kind));
    for (const k of [
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "codeBlock",
      "table",
      "blockquote",
      "hr",
      "mathBlock",
    ]) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it("脚注定义不再整体丢失（内容以某种 block 形态保留）", () => {
    const { blocks: bs } = parse("Text[^1]\n\n[^1]: 脚注内容\n");
    const dumped = JSON.stringify(bs);
    expect(dumped).toContain("脚注内容");
  });

  it("[toc] 目录不导致崩溃且不丢正文", () => {
    const { blocks: bs } = parse("[toc]\n\n# 标题\n\n正文\n");
    const dumped = JSON.stringify(bs);
    expect(dumped).toContain("标题");
    expect(dumped).toContain("正文");
  });
});
