/**
 * v0.8.0 WP2 修复2 + path 工具测试
 *
 * 覆盖：
 * 1. isSameOrInsidePath：自身 / 目录内 / 前缀陷阱（D:/a2 不属于 D:/a）/ 分隔符 / 结尾斜杠
 * 2. collectTabsToClose：精确匹配、文件夹递归匹配、临时标签（空路径）不匹配、
 *    前缀同名目录不误伤
 * 3. 与 store 联动：按 collectTabsToClose 的结果从后往前 closeTab，
 *    活跃标签与剩余标签正确（模拟 App.closeTabsByPath 的核心行为）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { isSameOrInsidePath, normalizePath } from "../utils/path";
import { collectTabsToClose } from "../utils/tabCleanup";
import { useEditorStore } from "../stores/useEditorStore";

describe("v0.8.0 WP2 isSameOrInsidePath", () => {
  it("自身 / 目录内为真", () => {
    expect(isSameOrInsidePath("D:/docs/a.md", "D:/docs/a.md")).toBe(true);
    expect(isSameOrInsidePath("D:/docs/sub/a.md", "D:/docs")).toBe(true);
  });

  it("同名前缀的兄弟目录不误判（D:/docs2 不属于 D:/docs）", () => {
    expect(isSameOrInsidePath("D:/docs2/a.md", "D:/docs")).toBe(false);
    expect(isSameOrInsidePath("D:/docs/a.md.bak", "D:/docs/a.md")).toBe(false);
  });

  it("兼容反斜杠与结尾斜杠", () => {
    expect(isSameOrInsidePath("D:\\docs\\a.md", "D:/docs")).toBe(true);
    expect(isSameOrInsidePath("D:/docs/sub/a.md", "D:\\docs\\")).toBe(true);
    expect(isSameOrInsidePath("D:/docs/", "D:/docs")).toBe(true);
  });

  it("空值安全", () => {
    expect(isSameOrInsidePath("", "D:/docs")).toBe(false);
    expect(isSameOrInsidePath("D:/docs/a.md", "")).toBe(false);
  });

  it("v0.8.0 修复 P2-4：按 Windows 语义大小写不敏感", () => {
    expect(isSameOrInsidePath("D:/DOCS/a.md", "D:/docs")).toBe(true);
    expect(isSameOrInsidePath("d:/docs", "D:/Docs")).toBe(true);
    expect(isSameOrInsidePath("D:/Notes/a.md", "D:/docs")).toBe(false);
  });

  it("normalizePath 统一分隔符", () => {
    expect(normalizePath("D:\\a\\b")).toBe("D:/a/b");
  });
});

describe("v0.8.0 WP2 collectTabsToClose", () => {
  it("删除单个文件：只关闭该文件标签", () => {
    const paths = ["D:/docs/a.md", "D:/docs/b.md", "D:/other/c.md"];
    expect(collectTabsToClose(paths, "D:/docs/a.md")).toEqual([0]);
  });

  it("删除文件夹：关闭其下所有已打开文件（不含同前缀兄弟目录）", () => {
    const paths = [
      "D:/docs/a.md",
      "D:/docs/sub/b.md",
      "D:/docs2/c.md",
      "D:/other/d.md",
    ];
    expect(collectTabsToClose(paths, "D:/docs")).toEqual([0, 1]);
  });

  it("临时标签（空路径）不参与匹配", () => {
    const paths = ["", "D:/docs/a.md"];
    expect(collectTabsToClose(paths, "D:/docs/a.md")).toEqual([1]);
  });

  it("删除文件夹时大小写不同的路径也能匹配（P2-4）", () => {
    expect(collectTabsToClose(["D:/Docs/sub/a.md"], "d:/docs")).toEqual([0]);
  });

  it("空删除路径返回空数组", () => {
    expect(collectTabsToClose(["D:/a.md"], "")).toEqual([]);
  });
});

describe("v0.8.0 WP2 删除后关闭标签与 store 联动", () => {
  beforeEach(() => {
    useEditorStore.setState({
      openTabs: [
        { path: "D:/docs/a.md", name: "a.md", content: "A" },
        { path: "D:/docs/sub/b.md", name: "b.md", content: "B" },
        { path: "D:/other/c.md", name: "c.md", content: "C" },
      ],
      activeTabIdx: 1,
    });
  });

  it("删除文件夹后：其下标签全部关闭，活跃标签回落到剩余标签", () => {
    const { openTabs, closeTab } = useEditorStore.getState();
    const toClose = collectTabsToClose(openTabs.map((t) => t.path), "D:/docs");
    expect(toClose).toEqual([0, 1]);
    // 从后往前关闭（与 App.closeTabsByPath 一致）
    for (let k = toClose.length - 1; k >= 0; k--) closeTab(toClose[k]);

    const after = useEditorStore.getState();
    expect(after.openTabs.map((t) => t.path)).toEqual(["D:/other/c.md"]);
    expect(after.activeTabIdx).toBe(0);
    expect(after.openTabs[after.activeTabIdx].content).toBe("C");
  });

  it("删除非活跃文件：活跃标签保持不变", () => {
    const { closeTab } = useEditorStore.getState();
    closeTab(0);
    const after = useEditorStore.getState();
    expect(after.openTabs.map((t) => t.path)).toEqual([
      "D:/docs/sub/b.md",
      "D:/other/c.md",
    ]);
    expect(after.openTabs[after.activeTabIdx].path).toBe("D:/docs/sub/b.md");
  });
});
