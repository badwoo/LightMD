/**
 * v0.7.0 修复5：文档末尾空段落往返（序列化/解析一致性）
 *
 * 背景：文档末尾输入多个回车（空段落），保存后切换标签再切回，空段落丢失。
 * 根因：serializer 未编码末尾空段落（往返吞行）+ parser 尾部空行还原数与序列化不对称。
 * 修复：末尾连续空段落每个编码为单个换行；解析时末尾 t 个换行还原 t 个空段落。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import type { Node as PMNode } from "prosemirror-model";

/** 构建 abc + n 个末尾空段落的 doc */
function docWithTrailingEmpty(n: number): PMNode {
  const nodes: PMNode[] = [schema.nodes.paragraph.create(null, schema.text("abc"))];
  for (let i = 0; i < n; i++) nodes.push(schema.nodes.paragraph.create());
  return schema.topNodeType.create(null, nodes);
}

/** 统计 doc 中空段落数 */
function countTrailingEmptyDoc(doc: PMNode): number {
  let c = 0;
  doc.forEach((node) => {
    if (node.type.name === "paragraph" && node.content.size === 0) c++;
  });
  return c;
}

describe("v0.7.0 修复5：末尾空段落 doc→md→doc 往返", () => {
  for (const n of [1, 2, 3, 4]) {
    it(`PM abc + ${n} 空段落 → 序列化 → 解析 → ${n} 空段落`, () => {
      expect(countTrailingEmptyDoc(markdownToDoc(docToMarkdown(docWithTrailingEmpty(n))))).toBe(n);
    });
  }
});

describe("v0.7.0 修复5：源码文本往返稳定（textarea 末尾回车不丢）", () => {
  for (const k of [1, 2, 3, 4, 5]) {
    it(`abc + ${k} 个换行 → md→doc→md 与源一致`, () => {
      const src = "abc" + "\n".repeat(k);
      expect(docToMarkdown(markdownToDoc(src))).toBe(src);
    });
  }

  it("中间空段落往返（回归 v0.6.6 空行修复）", () => {
    const src = "A\n\n\n\nB\n"; // A + 2 空段 + B
    expect(docToMarkdown(markdownToDoc(src))).toBe(src);
  });

  it("全空文档往返", () => {
    const src = "\n\n\n";
    expect(docToMarkdown(markdownToDoc(src))).toBe(src);
  });

  it("标准结尾（abc\\n）不产生末尾空段落", () => {
    expect(countTrailingEmptyDoc(markdownToDoc("abc\n"))).toBe(0);
  });

  it("旧版编码文件（末尾 6 换行）一次迁移后往返稳定", () => {
    const legacy = "abc\n\n\n\n\n\n";
    const out1 = docToMarkdown(markdownToDoc(legacy));
    expect(docToMarkdown(markdownToDoc(out1))).toBe(out1);
  });
});

describe("v0.7.0 修复1b：列表/代码块等块类型的末尾空行往返", () => {
  // 根因1：markdown-it 列表类 token map 吞掉块后连续空行（如 bullet_list map=[0,3]
  // 并入了末尾空行），导致 tail 计算为 0，空段落未还原。
  // 根因2：fence content 含最后行换行符（"x\n"），序列化时 close 前多出空行。
  // 根因3：katex-plugin 多行 $$ 块首行为空时 content 带前导 \n。
  const cases: Array<[string, string]> = [
    ["无序列表+1空行", "- a\n- b\n\n"],
    ["无序列表+2空行", "- a\n- b\n\n\n"],
    ["无序列表+3空行", "- a\n- b\n\n\n\n"],
    ["无序列表标准结尾", "- a\n- b\n"],
    ["任务列表+1空行", "- [ ] a\n- [ ] b\n\n"],
    ["代码块+1空行", "```js\nx\n```\n\n"],
    ["代码块+2空行", "```js\nx\n```\n\n\n"],
    ["代码块标准结尾", "```js\nx\n```\n"],
    ["代码块内部空行保留", "```\na\n\nb\n```\n"],
    ["数学块+1空行", "$$\nx\n$$\n\n"],
    ["数学块多行内容", "$$\na\nb\n$$\n"],
    ["分割线+1空行", "---\n\n"],
    ["引用+1空行", "> q\n\n"],
    ["表格+1空行", "| A |\n| --- |\n| 1 |\n\n"],
    ["标题+1空行", "## h\n\n"],
    ["段落+列表+末尾空行", "abc\n\n- a\n- b\n\n"],
    ["列表1空行间隔+标题", "- a\n\n# h\n"],
    ["列表3空行间隔+标题", "- a\n\n\n\n# h\n"],
    ["代码块1空行+段落", "```\nx\n```\n\np\n"],
    ["开头空行+列表", "\n- a\n- b\n"],
  ];

  for (const [label, src] of cases) {
    it(`${label}：md→doc→md 与源一致`, () => {
      expect(docToMarkdown(markdownToDoc(src))).toBe(src);
    });
  }

  it("列表末尾空段落计数正确（防 map 吞空行回归）", () => {
    // "- a\n- b\n\n"：末尾 1 换行 → 1 个空段落
    const doc = markdownToDoc("- a\n- b\n\n");
    const types: string[] = [];
    doc.forEach((n) => types.push(n.type.name));
    expect(types).toEqual(["bullet_list", "paragraph"]);
    expect(countTrailingEmptyDoc(doc)).toBe(1);
  });

  it("代码块内容不含尾随换行（防 fence content 回归）", () => {
    const doc = markdownToDoc("```js\nx\n```\n");
    let codeText: string | null = null;
    doc.forEach((n) => {
      if (n.type.name === "code_block") codeText = n.textContent;
    });
    expect(codeText).toBe("x");
  });
});

describe("v0.7.0 修复1c：task item 内多段落内容不丢失", () => {
  // 根因：task 项在 markdown 中只能单行表达（task-list-plugin 逐行解析），
  // 序列化 item 内非首段落为 4 空格缩进续行时，解析端不认可（- [ ] 内容列
  // 为 6 > 4），列表断裂且续行内容彻底丢失。
  // 修复：后续块级内容取文本合并追加到首行，保证内容不丢失。
  const P = schema.nodes.paragraph;
  const taskItem = (checked: boolean, ...kids: PMNode[]) => schema.nodes.task_item.create({ checked }, kids);
  const taskList = (...items: PMNode[]) => schema.nodes.task_list.create(null, items);

  /** doc 全文文本 */
  function docText(doc: PMNode): string {
    let s = "";
    doc.forEach((n) => { s += n.textContent; });
    return s;
  }

  it("item 内前置空段落 + 内容（编辑器异常现场结构）：内容保留", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(
        taskItem(false, P.create(null), P.create(null), P.create(null, schema.text("任务一"))),
        taskItem(false, P.create(null, schema.text("任务二")))
      ),
    ]);
    const restored = markdownToDoc(docToMarkdown(doc));
    expect(docText(restored)).toContain("任务一");
    expect(docText(restored)).toContain("任务二");
  });

  it("item 内多段落：内容合并到首行保留", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(taskItem(false, P.create(null, schema.text("首段")), P.create(null, schema.text("次段")))),
    ]);
    const restored = markdownToDoc(docToMarkdown(doc));
    expect(docText(restored)).toContain("首段");
    expect(docText(restored)).toContain("次段");
  });

  it("嵌套子列表 + 后续段落：子列表结构与内容均保留", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(
        taskItem(
          false,
          P.create(null, schema.text("父项")),
          taskList(taskItem(false, P.create(null, schema.text("子项")))),
          P.create(null, schema.text("父项后续"))
        )
      ),
    ]);
    const restored = markdownToDoc(docToMarkdown(doc));
    expect(docText(restored)).toContain("父项");
    expect(docText(restored)).toContain("子项");
    expect(docText(restored)).toContain("父项后续");
  });

  it("正常 task list 序列化格式不变（回归）", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(
        taskItem(false, P.create(null, schema.text("任务一"))),
        taskItem(true, P.create(null, schema.text("任务二")))
      ),
    ]);
    expect(docToMarkdown(doc)).toBe("- [ ] 任务一\n- [x] 任务二\n");
  });
});
