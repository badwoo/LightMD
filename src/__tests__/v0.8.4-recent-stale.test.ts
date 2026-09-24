/**
 * v0.8.4 WP2 需求1b：最近打开 stale 双条目数据层（useFileStore.ts）
 *
 * 覆盖：
 * 1. markRecentStale：路径匹配条目置 stale: true（含 \ / 分隔符归一化匹配），其他条目不受影响
 * 2. renameFileEntry 拆分后语义：
 *    - recentFiles：旧条目保留标 stale + 新路径条目头插入列（双条目）
 *    - favorites：仍原地改路径（不复制成两条）
 *    - tempFiles：仍原地改路径（活标签镜像）
 * 3. 成功再次打开（addRecentFile 同路径）→ stale 清除
 * 4. stale 字段随 persist 持久化（recentFiles 在持久化白名单内）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useFileStore } from "../stores/useFileStore";

beforeEach(() => {
  localStorage.removeItem("lightmd-file-store");
  useFileStore.setState({ recentFiles: [], favorites: [], tempFiles: [] });
});

/** 预置三条最近打开记录（a/b/c） */
function seedRecent() {
  const { addRecentFile } = useFileStore.getState();
  addRecentFile({ path: "C:/docs/a.md", name: "a.md" });
  addRecentFile({ path: "C:/docs/b.md", name: "b.md" });
  addRecentFile({ path: "C:/docs/c.md", name: "c.md" });
}

describe("v0.8.4 需求1b：markRecentStale", () => {
  it("路径匹配的条目置 stale: true，其他条目不受影响", () => {
    seedRecent();
    useFileStore.getState().markRecentStale("C:/docs/b.md");
    const list = useFileStore.getState().recentFiles;
    expect(list.find((f) => f.path === "C:/docs/b.md")!.stale).toBe(true);
    expect(list.find((f) => f.path === "C:/docs/a.md")!.stale).toBeUndefined();
    expect(list.find((f) => f.path === "C:/docs/c.md")!.stale).toBeUndefined();
  });

  it("路径分隔符归一化匹配：标 stale 用 \\，与 / 记录等价", () => {
    seedRecent();
    useFileStore.getState().markRecentStale("C:\\docs\\b.md");
    const list = useFileStore.getState().recentFiles;
    expect(list.find((f) => f.path === "C:/docs/b.md")!.stale).toBe(true);
  });

  it("不存在的路径 no-op（列表不变）", () => {
    seedRecent();
    useFileStore.getState().markRecentStale("C:/docs/ghost.md");
    expect(useFileStore.getState().recentFiles).toHaveLength(3);
    expect(useFileStore.getState().recentFiles.every((f) => !f.stale)).toBe(true);
  });
});

describe("v0.8.4 需求1b：renameFileEntry 拆分语义", () => {
  it("recentFiles：旧条目保留标 stale + 新路径条目头插入列（双条目）", () => {
    seedRecent();
    useFileStore.getState().renameFileEntry("C:/docs/a.md", "C:/docs/moved/a.md", "a.md");
    const list = useFileStore.getState().recentFiles;
    // 双条目：旧条目保留且 stale，新条目在列表头部
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ path: "C:/docs/moved/a.md", name: "a.md" });
    expect(list[0].stale).toBeUndefined();
    expect(list.find((f) => f.path === "C:/docs/a.md")!.stale).toBe(true);
  });

  it("favorites：仍原地改路径，不产生两条", () => {
    const { addFavorite } = useFileStore.getState();
    addFavorite({ path: "C:/docs/a.md", name: "a.md" });
    useFileStore.getState().renameFileEntry("C:/docs/a.md", "C:/docs/moved/a.md", "a.md");
    const favs = useFileStore.getState().favorites;
    expect(favs).toHaveLength(1);
    expect(favs[0]).toMatchObject({ path: "C:/docs/moved/a.md", name: "a.md" });
  });

  it("tempFiles：仍原地改路径（「打开的文件」面板活标签镜像）", () => {
    useFileStore.setState({
      tempFiles: [{ name: "a.md", path: "C:/docs/a.md", isDir: false, size: 0 }],
    });
    useFileStore.getState().renameFileEntry("C:/docs/a.md", "C:/docs/moved/a.md", "a.md");
    const temps = useFileStore.getState().tempFiles;
    expect(temps).toHaveLength(1);
    expect(temps[0]).toMatchObject({ path: "C:/docs/moved/a.md", name: "a.md" });
  });
});

describe("v0.8.4 需求1b：stale 的清除", () => {
  it("成功再次打开同一路径（addRecentFile）→ 该条目不再 stale", () => {
    seedRecent();
    useFileStore.getState().markRecentStale("C:/docs/b.md");
    expect(useFileStore.getState().recentFiles.find((f) => f.path === "C:/docs/b.md")!.stale).toBe(true);
    // 文件被移回原位/重新打开成功
    useFileStore.getState().addRecentFile({ path: "C:/docs/b.md", name: "b.md" });
    const list = useFileStore.getState().recentFiles;
    expect(list).toHaveLength(3);
    expect(list[0].path).toBe("C:/docs/b.md");
    expect(list[0].stale).toBeFalsy();
  });

  it("renameFileEntry 的新条目不带 stale（移动后在新路径打开语义）", () => {
    seedRecent();
    useFileStore.getState().renameFileEntry("C:/docs/a.md", "C:/docs/new/a.md", "a.md");
    const fresh = useFileStore.getState().recentFiles[0];
    expect(fresh.path).toBe("C:/docs/new/a.md");
    expect(fresh.stale).toBeFalsy();
  });
});

describe("v0.8.4 需求1b：stale 随 persist 持久化", () => {
  it("markRecentStale 后 localStorage 中该条目含 stale: true", () => {
    seedRecent();
    useFileStore.getState().markRecentStale("C:/docs/b.md");
    const persisted = JSON.parse(localStorage.getItem("lightmd-file-store")!);
    const entry = persisted.state.recentFiles.find(
      (f: { path: string }) => f.path === "C:/docs/b.md"
    );
    expect(entry.stale).toBe(true);
  });
});
