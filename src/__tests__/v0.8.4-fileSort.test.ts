/**
 * v0.8.4 WP2 需求7：文件树排序纯函数（fileSort.ts）
 *
 * 覆盖：
 * 1. SORT_MODES 数组 6 项及顺序
 * 2. 6 种模式排序正确（混排：文件与文件夹不分组）
 * 3. 时间 0（未知）兜底——无论升降序都排最后
 * 4. 相同时间回退名称 localeCompare 保证稳定
 * 5. sortModeBadge 徽标映射（↑=升序 A-Z/早-晚，↓=降序 Z-A/晚-早，C2 拍板语义）
 */
import { describe, it, expect } from "vitest";
import { SORT_MODES, sortNodes, sortModeBadge } from "../utils/fileSort";
import type { FileNodeData } from "../components/sidebar/FileNode";

/** 构造测试节点（children 缺省、时间字段按需传入） */
function node(name: string, opts: Partial<FileNodeData> = {}): FileNodeData {
  return { name, path: `C:/docs/${name}`, isDir: false, size: 0, ...opts };
}

describe("v0.8.4 需求7：SORT_MODES 数组", () => {
  it("共 6 项，顺序为 name 2 + modified 2 + created 2", () => {
    expect(SORT_MODES).toEqual([
      "name-asc",
      "name-desc",
      "modified-desc",
      "modified-asc",
      "created-desc",
      "created-asc",
    ]);
  });
});

describe("v0.8.4 需求7：sortNodes 6 种模式", () => {
  it("name-asc：A-Z 字母序", () => {
    const list = [node("c.md"), node("a.md"), node("b.md")];
    expect(sortNodes(list, "name-asc").map((n) => n.name)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("name-desc：Z-A 反向字母序", () => {
    const list = [node("a.md"), node("c.md"), node("b.md")];
    expect(sortNodes(list, "name-desc").map((n) => n.name)).toEqual(["c.md", "b.md", "a.md"]);
  });

  it("modified-desc：修改时间晚-早（新在前）", () => {
    const list = [
      node("old.md", { modifiedMs: 100 }),
      node("new.md", { modifiedMs: 300 }),
      node("mid.md", { modifiedMs: 200 }),
    ];
    expect(sortNodes(list, "modified-desc").map((n) => n.name)).toEqual([
      "new.md",
      "mid.md",
      "old.md",
    ]);
  });

  it("modified-asc：修改时间早-晚", () => {
    const list = [
      node("old.md", { modifiedMs: 100 }),
      node("new.md", { modifiedMs: 300 }),
      node("mid.md", { modifiedMs: 200 }),
    ];
    expect(sortNodes(list, "modified-asc").map((n) => n.name)).toEqual([
      "old.md",
      "mid.md",
      "new.md",
    ]);
  });

  it("created-desc：创建时间晚-早（新在前）", () => {
    const list = [
      node("old.md", { createdMs: 10 }),
      node("new.md", { createdMs: 30 }),
      node("mid.md", { createdMs: 20 }),
    ];
    expect(sortNodes(list, "created-desc").map((n) => n.name)).toEqual([
      "new.md",
      "mid.md",
      "old.md",
    ]);
  });

  it("created-asc：创建时间早-晚", () => {
    const list = [
      node("old.md", { createdMs: 10 }),
      node("new.md", { createdMs: 30 }),
      node("mid.md", { createdMs: 20 }),
    ];
    expect(sortNodes(list, "created-asc").map((n) => n.name)).toEqual([
      "old.md",
      "mid.md",
      "new.md",
    ]);
  });
});

describe("v0.8.4 需求7：混排（文件与文件夹不分组）", () => {
  it("name-asc 混排：文件夹与文件按名称统一排，文件夹不强制在前", () => {
    const list = [
      node("zeta.md"),
      node("beta", { isDir: true }),
      node("alpha.md"),
    ];
    expect(sortNodes(list, "name-asc").map((n) => n.name)).toEqual([
      "alpha.md",
      "beta",
      "zeta.md",
    ]);
  });

  it("modified-desc 混排：较新的文件排在较旧的文件夹前面", () => {
    const list = [
      node("dir", { isDir: true, modifiedMs: 100 }),
      node("file.md", { modifiedMs: 900 }),
    ];
    expect(sortNodes(list, "modified-desc").map((n) => n.name)).toEqual(["file.md", "dir"]);
  });
});

describe("v0.8.4 需求7：时间 0（未知）兜底", () => {
  it("modified-desc：时间为 0 的节点排最后（而非按 0 当作最早）", () => {
    const list = [
      node("unknown.md", { modifiedMs: 0 }),
      node("old.md", { modifiedMs: 100 }),
      node("new.md", { modifiedMs: 200 }),
    ];
    expect(sortNodes(list, "modified-desc").map((n) => n.name)).toEqual([
      "new.md",
      "old.md",
      "unknown.md",
    ]);
  });

  it("modified-asc：时间为 0（含字段缺失）的节点同样排最后", () => {
    const list = [
      node("unknown.md"), // 字段缺失 = undefined
      node("a.md", { modifiedMs: 100 }),
      node("b.md", { modifiedMs: 200 }),
    ];
    expect(sortNodes(list, "modified-asc").map((n) => n.name)).toEqual([
      "a.md",
      "b.md",
      "unknown.md",
    ]);
  });

  it("created-desc：createdMs 为 0 的节点排最后", () => {
    const list = [
      node("unknown.md", { createdMs: 0 }),
      node("x.md", { createdMs: 50 }),
    ];
    expect(sortNodes(list, "created-desc").map((n) => n.name)).toEqual(["x.md", "unknown.md"]);
  });
});

describe("v0.8.4 需求7：稳定回退（相同时间/双方未知）", () => {
  it("modified-desc：相同修改时间回退名称 localeCompare", () => {
    const list = [
      node("b.md", { modifiedMs: 100 }),
      node("a.md", { modifiedMs: 100 }),
      node("c.md", { modifiedMs: 200 }),
    ];
    expect(sortNodes(list, "modified-desc").map((n) => n.name)).toEqual([
      "c.md",
      "a.md",
      "b.md",
    ]);
  });

  it("modified-asc：双方时间均未知时按名称序排", () => {
    const list = [node("b.md"), node("a.md")];
    expect(sortNodes(list, "modified-asc").map((n) => n.name)).toEqual(["a.md", "b.md"]);
  });

  it("sortNodes 不修改入参数组（纯函数）", () => {
    const list = [node("b.md"), node("a.md")];
    sortNodes(list, "name-asc");
    expect(list.map((n) => n.name)).toEqual(["b.md", "a.md"]);
  });
});

describe("v0.8.4 需求7：sortModeBadge 徽标映射（C2 语义）", () => {
  it("↑=升序：name-asc→↑A-Z；modified-asc→↑U；created-asc→↑C", () => {
    expect(sortModeBadge("name-asc")).toEqual({ arrow: "up", label: "A-Z" });
    expect(sortModeBadge("modified-asc")).toEqual({ arrow: "up", label: "U" });
    expect(sortModeBadge("created-asc")).toEqual({ arrow: "up", label: "C" });
  });

  it("↓=降序：name-desc→↓Z-A；modified-desc→↓U；created-desc→↓C", () => {
    expect(sortModeBadge("name-desc")).toEqual({ arrow: "down", label: "Z-A" });
    expect(sortModeBadge("modified-desc")).toEqual({ arrow: "down", label: "U" });
    expect(sortModeBadge("created-desc")).toEqual({ arrow: "down", label: "C" });
  });
});
