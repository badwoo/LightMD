/**
 * G7 文档收藏功能测试
 *
 * 覆盖 useFileStore 的收藏操作方法：
 * - addFavorite 添加新文件
 * - addFavorite 重复添加同一 path 不重复（去重）
 * - addFavorite 超过 50 条时截断
 * - removeFavorite 移除指定文件
 * - removeFavorite 移除不存在的文件不报错
 * - isFavorite 正确返回查询结果
 *
 * 测试策略：使用 jsdom 环境提供真实 localStorage，
 * 通过 setState 重置 store 状态保证测试间隔离。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useFileStore } from "../stores/useFileStore";

/** 生成 N 个 fake 收藏条目 */
function genFavorites(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/test/fav-${i + 1}.md`,
    name: `fav-${i + 1}.md`,
  }));
}

describe("G7: useFileStore 收藏操作", () => {
  beforeEach(() => {
    // 清除 localStorage 中持久化的数据，避免上一个测试残留
    localStorage.removeItem("lightmd-file-store");
    // 每个测试前重置 store 状态，确保隔离
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
      recentFolders: [],
      tempFiles: [],
      fileTree: [],
      rootPath: null,
    });
  });

  it("addFavorite 添加新文件到收藏列表", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/docs/readme.md", name: "readme.md" });

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(1);
    expect(favorites[0].path).toBe("/docs/readme.md");
    expect(favorites[0].name).toBe("readme.md");
    expect(typeof favorites[0].addedAt).toBe("number");
    expect(favorites[0].addedAt).toBeGreaterThan(0);
  });

  it("addFavorite 头插：新文件排在第一位", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/a.md", name: "a.md" });
    store.addFavorite({ path: "/b.md", name: "b.md" });
    store.addFavorite({ path: "/c.md", name: "c.md" });

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(3);
    // 头插顺序：c 在最前，a 在最后
    expect(favorites[0].path).toBe("/c.md");
    expect(favorites[1].path).toBe("/b.md");
    expect(favorites[2].path).toBe("/a.md");
  });

  it("addFavorite 重复添加同一 path 不重复（按 path 去重）", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/docs/x.md", name: "x.md" });
    // 再次添加同 path（即使 name 不同），不应重复
    store.addFavorite({ path: "/docs/x.md", name: "renamed.md" });

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(1);
    // 原条目保留（不覆盖 name）
    expect(favorites[0].name).toBe("x.md");
  });

  it("addFavorite 超过 50 条时截断为 50 条", () => {
    const store = useFileStore.getState();
    // 添加 60 条
    genFavorites(60).forEach((f) => store.addFavorite(f));

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(50);
    // 由于头插，最新的 fav-60 应在第一位，fav-11 应在最后（fav-1~10 被截断）
    expect(favorites[0].path).toBe("/test/fav-60.md");
    expect(favorites[49].path).toBe("/test/fav-11.md");
  });

  it("addFavorite 恰好 50 条时不截断", () => {
    const store = useFileStore.getState();
    genFavorites(50).forEach((f) => store.addFavorite(f));

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(50);
    expect(favorites[0].path).toBe("/test/fav-50.md");
    expect(favorites[49].path).toBe("/test/fav-1.md");
  });

  it("removeFavorite 移除指定文件", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/a.md", name: "a.md" });
    store.addFavorite({ path: "/b.md", name: "b.md" });
    store.addFavorite({ path: "/c.md", name: "c.md" });

    store.removeFavorite("/b.md");

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(2);
    expect(favorites.find((f) => f.path === "/b.md")).toBeUndefined();
    expect(favorites.map((f) => f.path)).toEqual(["/c.md", "/a.md"]);
  });

  it("removeFavorite 移除不存在的文件不报错", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/a.md", name: "a.md" });

    // 移除不存在的 path
    expect(() => store.removeFavorite("/nonexistent.md")).not.toThrow();

    const favorites = useFileStore.getState().favorites;
    expect(favorites).toHaveLength(1);
    expect(favorites[0].path).toBe("/a.md");
  });

  it("removeFavorite 在空列表上调用不报错", () => {
    const store = useFileStore.getState();
    expect(() => store.removeFavorite("/any.md")).not.toThrow();
    expect(useFileStore.getState().favorites).toHaveLength(0);
  });

  it("isFavorite 返回 false（未收藏）", () => {
    const store = useFileStore.getState();
    expect(store.isFavorite("/not-favorited.md")).toBe(false);
  });

  it("isFavorite 返回 true（已收藏）", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/docs/guide.md", name: "guide.md" });

    expect(useFileStore.getState().isFavorite("/docs/guide.md")).toBe(true);
  });

  it("isFavorite 移除后返回 false", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/docs/guide.md", name: "guide.md" });
    store.removeFavorite("/docs/guide.md");

    expect(useFileStore.getState().isFavorite("/docs/guide.md")).toBe(false);
  });

  it("isFavorite 区分不同 path", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/a.md", name: "a.md" });

    expect(useFileStore.getState().isFavorite("/a.md")).toBe(true);
    expect(useFileStore.getState().isFavorite("/b.md")).toBe(false);
  });

  it("favorites 通过 persist 持久化到 localStorage", () => {
    const store = useFileStore.getState();
    store.addFavorite({ path: "/persist/test.md", name: "test.md" });

    // persist 中间件应写入 localStorage
    const raw = localStorage.getItem("lightmd-file-store");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.favorites).toHaveLength(1);
    expect(parsed.state.favorites[0].path).toBe("/persist/test.md");
  });
});
