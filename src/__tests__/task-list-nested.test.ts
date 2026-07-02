/**
 * 任务列表嵌套功能测试
 *
 * 测试 parseTaskList 和 taskListToMarkdown 对嵌套任务列表的支持
 * 确保多层级缩进的任务项能正确解析和序列化
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

describe("任务列表嵌套", () => {
  it("应该正确解析扁平任务列表", () => {
    const md = "- [x] 已完成\n- [ ] 未完成\n";
    const doc = markdownToDoc(md);
    expect(doc.firstChild?.type.name).toBe("task_list");
    const taskList = doc.firstChild!;
    expect(taskList.childCount).toBe(2);
    expect(taskList.child(0).attrs.checked).toBe(true);
    expect(taskList.child(1).attrs.checked).toBe(false);
  });

  it("应该正确解析嵌套任务列表（一级缩进）", () => {
    const md = "- [ ] 父任务\n  - [x] 子任务1\n  - [ ] 子任务2\n";
    const doc = markdownToDoc(md);
    const taskList = doc.firstChild;
    expect(taskList?.type.name).toBe("task_list");
    expect(taskList?.childCount).toBe(1);

    const parentItem = taskList!.child(0);
    expect(parentItem.type.name).toBe("task_item");
    expect(parentItem.attrs.checked).toBe(false);

    // task_item 的子节点：第一个是 paragraph，第二个是嵌套的 task_list
    expect(parentItem.childCount).toBe(2);
    expect(parentItem.child(0).type.name).toBe("paragraph");
    expect(parentItem.child(1).type.name).toBe("task_list");

    const nestedList = parentItem.child(1);
    expect(nestedList.childCount).toBe(2);
    expect(nestedList.child(0).attrs.checked).toBe(true);
    expect(nestedList.child(1).attrs.checked).toBe(false);
  });

  it("应该正确解析多级嵌套任务列表", () => {
    const md = "- [ ] 第一层\n  - [ ] 第二层\n    - [x] 第三层\n";
    const doc = markdownToDoc(md);
    const taskList = doc.firstChild;
    expect(taskList?.type.name).toBe("task_list");

    const level1 = taskList!.child(0);
    expect(level1.child(1).type.name).toBe("task_list");

    const level2 = level1.child(1).child(0);
    expect(level2.child(1).type.name).toBe("task_list");

    const level3 = level2.child(1).child(0);
    expect(level3.attrs.checked).toBe(true);
  });

  it("应该正确序列化嵌套任务列表", () => {
    const md = "- [ ] 父任务\n  - [x] 子任务1\n  - [ ] 子任务2\n";
    const doc = markdownToDoc(md);
    const serialized = docToMarkdown(doc);
    // 验证序列化后包含正确的缩进
    expect(serialized).toContain("- [ ] 父任务");
    expect(serialized).toContain("  - [x] 子任务1");
    expect(serialized).toContain("  - [ ] 子任务2");
  });

  it("应该正确序列化多级嵌套任务列表", () => {
    const md = "- [ ] 第一层\n  - [ ] 第二层\n    - [x] 第三层\n";
    const doc = markdownToDoc(md);
    const serialized = docToMarkdown(doc);
    expect(serialized).toContain("- [ ] 第一层");
    expect(serialized).toContain("  - [ ] 第二层");
    expect(serialized).toContain("    - [x] 第三层");
  });

  it("应该正确处理混合任务列表和普通内容", () => {
    const md = "- [ ] 任务1\n  - [x] 子任务\n- [ ] 任务2\n";
    const doc = markdownToDoc(md);
    const taskList = doc.firstChild;
    expect(taskList?.type.name).toBe("task_list");
    expect(taskList?.childCount).toBe(2);

    // 第一个任务有子任务
    const item1 = taskList!.child(0);
    expect(item1.child(1).type.name).toBe("task_list");

    // 第二个任务没有子任务
    const item2 = taskList!.child(1);
    expect(item2.childCount).toBe(1); // 只有 paragraph
    expect(item2.child(0).type.name).toBe("paragraph");
  });

  it("嵌套任务列表往返序列化应保持一致", () => {
    const md = "- [x] 完成\n  - [ ] 子任务\n- [ ] 未完成\n";
    const doc = markdownToDoc(md);
    const serialized = docToMarkdown(doc);
    const doc2 = markdownToDoc(serialized);
    const serialized2 = docToMarkdown(doc2);

    // 两次序列化结果应该一致
    expect(serialized.trim()).toBe(serialized2.trim());
  });
});
