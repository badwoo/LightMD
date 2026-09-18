/**
 * v0.8.0 WP2 需求6：打开所在文件夹工作区
 *
 * 覆盖 openContainingWorkspace 的两条分支：
 * - 已在侧栏挂载：仅展开定位（不重复挂载）
 * - 未挂载：派发挂载事件
 * 以及父目录推导、空调用等边界。
 */
import { describe, it, expect, vi } from "vitest";
import { openContainingWorkspace, type OpenWorkspaceDeps } from "../utils/workspace";

function makeDeps(overrides: Partial<OpenWorkspaceDeps> = {}) {
  return {
    openFolders: [] as { path: string }[],
    isPathInOpenFolders: vi.fn(() => false),
    expandTo: vi.fn(),
    openFolder: vi.fn(),
    setActive: vi.fn(),
    ...overrides,
  };
}

describe("v0.8.0 WP2 需求6 打开所在文件夹工作区", () => {
  it("未挂载时派发挂载事件，且不展开/不定位", () => {
    const deps = makeDeps({ isPathInOpenFolders: vi.fn(() => false) });
    const result = openContainingWorkspace("D:/projects/demo/a.md", deps);

    expect(result).toEqual({ mounted: false, parentDir: "D:/projects/demo" });
    expect(deps.openFolder).toHaveBeenCalledWith("D:/projects/demo");
    expect(deps.expandTo).not.toHaveBeenCalled();
    expect(deps.setActive).not.toHaveBeenCalled();
  });

  it("已挂载时仅展开并定位，不重复挂载", () => {
    const deps = makeDeps({ isPathInOpenFolders: vi.fn(() => true) });
    const result = openContainingWorkspace("D:\\docs\\sub\\b.md", deps);

    expect(result.mounted).toBe(true);
    expect(result.parentDir).toBe("D:/docs/sub");
    expect(deps.expandTo).toHaveBeenCalledWith("D:/docs/sub");
    expect(deps.setActive).toHaveBeenCalledWith("D:\\docs\\sub\\b.md");
    expect(deps.openFolder).not.toHaveBeenCalled();
  });

  it("setActive 为可选依赖，未提供时不报错", () => {
    const deps = makeDeps({ isPathInOpenFolders: vi.fn(() => true) });
    delete (deps as Partial<OpenWorkspaceDeps>).setActive;
    expect(() => openContainingWorkspace("D:/a/b.md", deps)).not.toThrow();
    expect(deps.expandTo).toHaveBeenCalledWith("D:/a");
  });

  it("判断依据是父目录而非文件路径本身", () => {
    const isPathInOpenFolders = vi.fn((p: string) => p === "D:/docs");
    const deps = makeDeps({ isPathInOpenFolders });
    openContainingWorkspace("D:/docs/a.md", deps);
    expect(isPathInOpenFolders).toHaveBeenCalledWith("D:/docs");
  });
});
