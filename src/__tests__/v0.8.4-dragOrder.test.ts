/**
 * v0.8.4 WP2 需求3：同目录手动顺序表（dragOrder.ts）
 *
 * 覆盖：
 * 1. setManualOrder/getManualOrder 读写往返（localStorage persist）
 * 2. 路径分隔符归一化（\ 与 / 等价）
 * 3. applyManualOrder：按表排列 / 新文件按字母序插尾（P5）/ 死项惰性清理 / 纯函数
 * 4. reorderList：before / after / 目标不在列表（末尾追加）/ 防御分支
 * 5. renameInOrder：表内原地换名 / 无表或不存在的 name 时 no-op
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  getManualOrder,
  setManualOrder,
  applyManualOrder,
  reorderList,
  renameInOrder,
} from "../utils/dragOrder";
import type { FileNodeData } from "../components/sidebar/FileNode";

const STORAGE_KEY = "lightmd-manual-order";

function node(name: string, isDir = false): FileNodeData {
  return { name, path: `C:/docs/${name}`, isDir, size: 0 };
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

describe("v0.8.4 需求3：get/set persist 与路径归一化", () => {
  it("set 后可 get 回读（localStorage 全表 JSON）", () => {
    setManualOrder("C:/docs", ["b.md", "a.md"]);
    expect(getManualOrder("C:/docs")).toEqual(["b.md", "a.md"]);
    // 持久化到约定的 localStorage key
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw["C:/docs"]).toEqual(["b.md", "a.md"]);
  });

  it("路径分隔符归一化：反斜杠写入 / 正斜杠读取命中同一记录", () => {
    setManualOrder("C:\\docs", ["b.md", "a.md"]);
    expect(getManualOrder("C:/docs")).toEqual(["b.md", "a.md"]);
    // 反向亦等价
    setManualOrder("C:/docs", ["a.md", "b.md"]);
    expect(getManualOrder("C:\\docs")).toEqual(["a.md", "b.md"]);
  });

  it("无记录返回 null；目录间记录互不干扰", () => {
    expect(getManualOrder("C:/empty")).toBeNull();
    setManualOrder("C:/docs", ["a.md"]);
    expect(getManualOrder("C:/other")).toBeNull();
  });

  it("localStorage 数据损坏（非法 JSON / 非法结构）时安全回退 null", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{{{");
    expect(getManualOrder("C:/docs")).toBeNull();
    localStorage.setItem(STORAGE_KEY, '"just-a-string"');
    expect(getManualOrder("C:/docs")).toBeNull();
  });
});

describe("v0.8.4 需求3：applyManualOrder 合并语义", () => {
  it("按顺序表排列 nodes", () => {
    const nodes = [node("a.md"), node("b.md"), node("c.md")];
    const out = applyManualOrder(nodes, ["c.md", "a.md", "b.md"]);
    expect(out.map((n) => n.name)).toEqual(["c.md", "a.md", "b.md"]);
  });

  it("表内不存在的 name（新文件）按字母序插到表尾（P5 尾插）", () => {
    const nodes = [node("a.md"), node("b.md"), node("new1.md"), node("new2.md")];
    const out = applyManualOrder(nodes, ["b.md", "a.md"]);
    // 表内项保持顺序，新文件字母序尾插
    expect(out.map((n) => n.name)).toEqual(["b.md", "a.md", "new1.md", "new2.md"]);
  });

  it("表中已不存在的 name（已删除文件）被惰性清理，不出现在结果中", () => {
    const nodes = [node("a.md"), node("b.md")];
    const out = applyManualOrder(nodes, ["deleted.md", "b.md", "gone.md", "a.md"]);
    expect(out.map((n) => n.name)).toEqual(["b.md", "a.md"]);
  });

  it("纯函数：不修改传入 nodes 与 order", () => {
    const nodes = [node("a.md"), node("b.md")];
    const order = ["b.md", "a.md"];
    applyManualOrder(nodes, order);
    expect(nodes.map((n) => n.name)).toEqual(["a.md", "b.md"]);
    expect(order).toEqual(["b.md", "a.md"]);
  });
});

describe("v0.8.4 需求3：reorderList 拖拽重排", () => {
  it("place=before：src 移到 target 之前", () => {
    expect(reorderList(["a", "b", "c", "d"], "c", "b", "before")).toEqual(["a", "c", "b", "d"]);
  });

  it("place=after：src 移到 target 之后", () => {
    expect(reorderList(["a", "b", "c", "d"], "c", "b", "after")).toEqual(["a", "b", "c", "d"]);
    expect(reorderList(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  it("target 不在列表（拖到空白处）→ 追加到末尾", () => {
    expect(reorderList(["a", "b", "c"], "a", "not-exist", "before")).toEqual(["b", "c", "a"]);
  });

  it("防御：src 不在列表 / src===target 时原样返回（新数组）", () => {
    expect(reorderList(["a", "b"], "x", "a", "before")).toEqual(["a", "b"]);
    expect(reorderList(["a", "b"], "a", "a", "before")).toEqual(["a", "b"]);
  });
});

describe("v0.8.4 需求3（S5）：renameInOrder 重命名联动", () => {
  it("表内原地换名，位置不变", () => {
    setManualOrder("C:/docs", ["b.md", "a.md", "c.md"]);
    renameInOrder("C:/docs", "a.md", "renamed.md");
    expect(getManualOrder("C:/docs")).toEqual(["b.md", "renamed.md", "c.md"]);
  });

  it("无该目录顺序表时 no-op（不创建空记录）", () => {
    renameInOrder("C:/none", "a.md", "b.md");
    expect(getManualOrder("C:/none")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("oldName 不在表中时 no-op（表内容保持不变）", () => {
    setManualOrder("C:/docs", ["b.md", "a.md"]);
    renameInOrder("C:/docs", "ghost.md", "x.md");
    expect(getManualOrder("C:/docs")).toEqual(["b.md", "a.md"]);
  });
});
