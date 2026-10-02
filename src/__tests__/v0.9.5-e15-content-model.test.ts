/**
 * v0.9.5 E15:任务项/脚注内容模型无损化
 *
 * 1. 任务项内嵌套普通列表/多段落不再压平进首行:
 *    - 解析端 task-list-plugin 收集缩进续行,子文档解析为块级 token
 *    - 序列化端输出 4 空格缩进续行(段落前空行)
 * 2. 脚注定义从 inline* 升级为 block+:多段落脚注往返保持分段
 * 3. 旧扁平写法(单行脚注、无嵌套任务)解析不受影响
 */
import { describe, it, expect } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

const para = (text = "") => schema.nodes.paragraph.create(null, text ? [schema.text(text)] : []);
const taskItem = (checked: boolean, ...kids: PMNode[]) =>
  schema.nodes.task_item.create({ checked }, kids);
const taskList = (...items: PMNode[]) => schema.nodes.task_list.create(null, items);
const bulletItem = (text: string) => schema.nodes.list_item.create(null, para(text));
const bulletList = (...items: PMNode[]) =>
  schema.nodes.bullet_list.create(null, items);
const fnDef = (label: string, ...blocks: PMNode[]) =>
  schema.nodes.footnote_definition.create({ label }, blocks);
// 带脚注引用的正文段落(markdown-it-footnote 仅在有引用时输出脚注块 token)
const refPara = (label: string) =>
  schema.nodes.paragraph.create(null, [
    schema.text('正文'),
    schema.nodes.footnote_ref.create({ label }),
  ]);

/** task_item 的直接子块类型列表 */
function childTypes(node: PMNode): string[] {
  const types: string[] = [];
  node.forEach((c) => types.push(c.type.name));
  return types;
}

/** 找到 doc 中第一个指定类型的节点 */
function findFirst(doc: PMNode, name: string): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((n) => {
    if (!found && n.type.name === name) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

describe("v0.9.5 E15-1 任务项内嵌套普通列表(解析端)", () => {
  it("缩进的普通子弹列表解析进 task_item 内部,而非分离为顶层列表", () => {
    const src = "- [ ] 主任务\n    - 子弹一\n    - 子弹二\n";
    const doc = markdownToDoc(src);
    const tl = findFirst(doc, "task_list")!;
    expect(tl).not.toBeNull();
    const item = tl.firstChild!;
    expect(item.type.name).toBe("task_item");
    // E15 后:task_item 内含 paragraph + bullet_list;改前 bullet_list 分离到顶层
    expect(childTypes(item)).toEqual(["paragraph", "bullet_list"]);
    const sub = item.child(1);
    expect(sub.childCount).toBe(2);
    expect(sub.child(0).textContent).toBe("子弹一");
    expect(sub.child(1).textContent).toBe("子弹二");
  });

  it("缩进的普通段落解析为 task_item 内的第二段落", () => {
    const src = "- [ ] 首行\n    续段\n";
    const doc = markdownToDoc(src);
    const item = findFirst(doc, "task_item")!;
    expect(childTypes(item)).toEqual(["paragraph", "paragraph"]);
    expect(item.child(1).textContent).toBe("续段");
  });

  it("顶层非任务项内容不并入任务列表(既有行为不回归)", () => {
    const src = "- [ ] 任务\n正文段落\n";
    const doc = markdownToDoc(src);
    const tl = findFirst(doc, "task_list")!;
    expect(tl.childCount).toBe(1);
    // 正文段落是顶层独立块
    let topTypes: string[] = [];
    doc.forEach((n) => topTypes.push(n.type.name));
    expect(topTypes).toContain("paragraph");
    expect(doc.textContent).toContain("正文段落");
  });
});

describe("v0.9.5 E15-1 任务项序列化(miss 路径)", () => {
  it("嵌套普通列表序列化为 2 空格缩进续行,往返结构不丢", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(taskItem(false, para("主任务"), bulletList(bulletItem("子弹一"), bulletItem("子弹二")))),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toContain("- [ ] 主任务");
    expect(md).toContain("  - 子弹一");
    expect(md).toContain("  - 子弹二");
    const restored = markdownToDoc(md);
    const item = findFirst(restored, "task_item")!;
    expect(childTypes(item)).toEqual(["paragraph", "bullet_list"]);
    expect(item.child(1).childCount).toBe(2);
  });

  it("任务项内多段落序列化为空行+缩进续行,往返分段保持", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(taskItem(false, para("首段"), para("次段"))),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toBe("- [ ] 首段\n\n  次段\n");
    const restored = markdownToDoc(md);
    const item = findFirst(restored, "task_item")!;
    expect(childTypes(item)).toEqual(["paragraph", "paragraph"]);
    expect(item.child(1).textContent).toBe("次段");
  });

  it("嵌套任务列表序列化保持 2 空格缩进(既有行为回归)", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(taskItem(false, para("父"), taskList(taskItem(true, para("子"))))),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toContain("  - [x] 子");
    const restored = markdownToDoc(md);
    const item = findFirst(restored, "task_item")!;
    expect(childTypes(item)).toEqual(["paragraph", "task_list"]);
    expect((item.child(1) as PMNode).firstChild!.attrs.checked).toBe(true);
  });

  it("混合嵌套(任务子列表+普通列表)往返均保留", () => {
    const doc = schema.topNodeType.create(null, [
      taskList(
        taskItem(
          false,
          para("父"),
          taskList(taskItem(true, para("子任务"))),
          bulletList(bulletItem("子弹"))
        )
      ),
    ]);
    const md = docToMarkdown(doc);
    const restored = markdownToDoc(md);
    const item = findFirst(restored, "task_item")!;
    expect(childTypes(item)).toEqual(["paragraph", "task_list", "bullet_list"]);
    expect(item.child(1).firstChild!.textContent).toBe("子任务");
    expect(item.child(2).firstChild!.textContent).toBe("子弹");
  });
});

describe("v0.9.5 E15-2 脚注内容模型无损化", () => {
  it("多段落脚注解析保持分段(footnote_definition 内 2 个段落)", () => {
    const src = "正文[^1]\n\n[^1]: 第一段\n\n    第二段\n";
    const doc = markdownToDoc(src);
    const def = findFirst(doc, "footnote_definition")!;
    expect(def).not.toBeNull();
    // E15 后:内容模型 block+,多段落不压平
    expect(def.childCount).toBe(2);
    expect(def.child(0).textContent).toBe("第一段");
    expect(def.child(1).textContent).toBe("第二段");
  });

  it("多段落脚注序列化为缩进续行,往返分段保持", () => {
    const doc = schema.topNodeType.create(null, [
      refPara("1"),
      fnDef("1", para("第一段"), para("第二段")),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toContain("[^1]: 第一段");
    expect(md).toContain("\n\n    第二段");
    const restored = markdownToDoc(md);
    const def = findFirst(restored, "footnote_definition")!;
    expect(def.childCount).toBe(2);
    expect(def.child(1).textContent).toBe("第二段");
  });

  it("单行脚注(旧扁平写法)解析与序列化不受影响", () => {
    const src = "正文[^1]\n\n[^1]: 单行定义\n";
    const doc = markdownToDoc(src);
    const def = findFirst(doc, "footnote_definition")!;
    expect(def.childCount).toBe(1);
    expect(def.child(0).textContent).toBe("单行定义");
    // B6 快路径逐字节返回
    expect(docToMarkdown(doc)).toBe(src);
  });

  it("空脚注往返收敛", () => {
    const doc = schema.topNodeType.create(null, [refPara("1"), fnDef("1", para())]);
    const md = docToMarkdown(doc);
    expect(md).toContain("[^1]:");
    const restored = markdownToDoc(md);
    const def = findFirst(restored, "footnote_definition")!;
    expect(def).not.toBeNull();
    expect(def.childCount).toBeGreaterThanOrEqual(1);
    expect(def.child(0).textContent).toBe("");
  });

  it("脚注内多段落 + inline 格式往返保留", () => {
    const doc = schema.topNodeType.create(null, [
      refPara("a"),
      fnDef("a", para("第一段"), para("第二段")),
    ]);
    const md = docToMarkdown(doc);
    const restored = markdownToDoc(md);
    const def = findFirst(restored, "footnote_definition")!;
    expect(def.childCount).toBe(2);
    expect(def.attrs.label).toBe("a");
  });
});

describe("v0.9.5 E15-3 schema 内容模型", () => {
  it("footnote_definition 内容模型为 block+(可含多块)", () => {
    expect((schema.nodes.footnote_definition as any).spec.content).toBe("block+");
  });

  it("insert.footnote 命令创建的脚注定义为合法 block+ 结构", async () => {
    const { insertFootnoteDefinition } = await import("../core/pmCommands");
    // 直接验证命令产出的节点结构(schema 合法性)
    const def = insertFootnoteDefinition("1");
    expect(def.type.name).toBe("footnote_definition");
    expect(def.childCount).toBeGreaterThanOrEqual(1);
    expect(def.child(0).type.name).toBe("paragraph");
  });
});
