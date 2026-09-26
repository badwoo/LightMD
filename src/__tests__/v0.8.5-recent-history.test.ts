/**
 * v0.8.5 需求6：「最近打开」= 纯历史记录（条目不随文件/文件夹的打开或关闭而消失）
 *
 * 用户拍板语义：
 * - 关闭文件/文件夹后，「最近打开」中的对应条目保留（不再随关闭而消失）；
 * - 实际文件/文件夹被移动或删除时，对应条目只标 ⚠ 提示（stale），永不删除。
 *
 * 覆盖：
 * 1. 数据层：removeOpenFolder 不再移除 recentFolders（历史条目保留），仅同步会话快照
 * 2. App.tsx 源码断言：所有关闭路径不再调用 removeRecentFile/removeRecentFolder
 * 3. markRecentFolderStale：标记 / 归一化匹配 / 不存在 no-op / 重新打开清除
 * 4. 启动恢复与 recentFolders 解耦：恢复读 sessionFolders 会话快照（独立持久化），
 *    关闭文件夹后快照更新而 recentFolders 不变
 * 5. startupRestore 恢复失败 → 标 stale 回调（不再移除条目）
 * 6. UI：文件夹条目 stale 时显示 ⚠ + tooltip 追加失效提示（与文件条目一致）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createElement } from "react";
import { useFileStore } from "../stores/useFileStore";
import { restoreRecentFiles, restoreRecentFolders } from "../utils/startupRestore";
import { RecentFiles } from "../components/sidebar/RecentFiles";

const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
const storeSrc = readFileSync(resolve(__dirname, "../stores/useFileStore.ts"), "utf-8");

// ─── ResizeObserver mock（防御性：jsdom 未实现，RecentFiles 挂载链路可能用到）────
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
);

beforeEach(() => {
  localStorage.clear();
  useFileStore.setState({
    openFolders: [],
    recentFiles: [],
    recentFolders: [],
    sessionFolders: [],
    favorites: [],
    tempFiles: [],
    rootPath: null,
    fileTree: [],
  });
});

afterEach(() => {
  cleanup();
});

/** 读取 localStorage 中 lightmd-file-store 的 state（persist partialize 结果） */
function readPersistedState(): Record<string, unknown> {
  const raw = localStorage.getItem("lightmd-file-store");
  expect(raw).toBeTruthy();
  return JSON.parse(raw!).state;
}

// ─── 1. 关闭文件夹后历史条目仍在 ──────────────────────────────

describe("v0.8.5 需求6：关闭文件夹后最近打开条目保留", () => {
  it("removeOpenFolder 后 recentFolders 历史条目仍在，仅 sessionFolders 快照同步移除", () => {
    const { addOpenFolder, removeOpenFolder } = useFileStore.getState();
    addOpenFolder("C:/work/a");
    addOpenFolder("C:/work/b");
    removeOpenFolder("C:/work/a");

    // 历史条目全部保留（不随关闭消失）
    const folders = useFileStore.getState().recentFolders;
    expect(folders).toHaveLength(2);
    expect(folders.find((f) => f.path === "C:/work/a")).toBeTruthy();
    expect(folders.find((f) => f.path === "C:/work/b")).toBeTruthy();
    // 会话快照只剩未关闭的 b（启动恢复数据源）
    expect(useFileStore.getState().sessionFolders).toEqual(["C:/work/b"]);
  });

  it("App.tsx 源码断言：所有关闭路径不再调用 removeRecentFile / removeRecentFolder", () => {
    // v0.8.5 需求6：最近打开 = 纯历史，关闭标签/文件/文件夹、删除文件联动均不删条目
    // （覆盖 handleTabClose / lightmd:closeFile 事件 / handleCloseMany / closeTabsByPath / 启动恢复回调）
    expect(appSrc).not.toMatch(/\.removeRecentFile\(/);
    expect(appSrc).not.toMatch(/\.removeRecentFolder\(/);
    expect(appSrc).not.toMatch(/removeRecentFolder: \(path\)/);
    // 启动恢复失败回调改为注入标 stale action
    expect(appSrc).toMatch(/markRecentStale: \(path\)/);
    expect(appSrc).toMatch(/markRecentFolderStale: \(path\)/);
  });

  it("useFileStore 源码断言：removeOpenFolder 不再过滤 recentFolders（纯历史）", () => {
    // 旧 v0.4.5 实现中 removeOpenFolder 含 "recentFolders: state.recentFolders.filter(...)"，
    // v0.8.5 起该移除逻辑已删除（快照同步改用 sessionFolders）
    const removeOpenFolderSection = storeSrc.match(
      /removeOpenFolder: \(path\) => \{[\s\S]*?\n      \},/
    );
    expect(removeOpenFolderSection).not.toBeNull();
    expect(removeOpenFolderSection![0]).not.toMatch(/recentFolders:/);
    expect(removeOpenFolderSection![0]).toMatch(/sessionFolders:/);
  });
});

// ─── 2. markRecentFolderStale ──────────────────────────────

describe("v0.8.5 需求6：markRecentFolderStale", () => {
  it("路径匹配的文件夹条目置 stale: true，其他条目不受影响", () => {
    useFileStore.setState({
      recentFolders: [
        { path: "C:/work/a", name: "a", accessedAt: 3 },
        { path: "C:/work/b", name: "b", accessedAt: 2 },
      ],
    });
    useFileStore.getState().markRecentFolderStale("C:/work/a");
    const folders = useFileStore.getState().recentFolders;
    // 条目保留（永不删除），仅标记
    expect(folders).toHaveLength(2);
    expect(folders.find((f) => f.path === "C:/work/a")!.stale).toBe(true);
    expect(folders.find((f) => f.path === "C:/work/b")!.stale).toBeUndefined();
  });

  it("路径分隔符归一化匹配：标 stale 用 \\，与 / 记录等价", () => {
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: 1 }],
    });
    useFileStore.getState().markRecentFolderStale("C:\\work\\a");
    expect(
      useFileStore.getState().recentFolders.find((f) => f.path === "C:/work/a")!.stale
    ).toBe(true);
  });

  it("不存在的路径 no-op（列表不变、不新增条目）", () => {
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: 1 }],
    });
    useFileStore.getState().markRecentFolderStale("C:/work/ghost");
    const folders = useFileStore.getState().recentFolders;
    expect(folders).toHaveLength(1);
    expect(folders[0].stale).toBeUndefined();
  });

  it("成功重新打开同一路径（addOpenFolder 头插）→ 该条目不再 stale", () => {
    const { addOpenFolder } = useFileStore.getState();
    addOpenFolder("C:/work/a");
    useFileStore.getState().markRecentFolderStale("C:/work/a");
    expect(
      useFileStore.getState().recentFolders.find((f) => f.path === "C:/work/a")!.stale
    ).toBe(true);
    // 文件夹被移回原位/重新打开成功 → 头插的新条目无 stale 字段（天然清除）
    addOpenFolder("C:/work/a");
    const entry = useFileStore.getState().recentFolders.find((f) => f.path === "C:/work/a")!;
    expect(entry.stale).toBeFalsy();
  });
});

// ─── 3. 启动恢复与 recentFolders 解耦（sessionFolders 会话快照）────────────────

describe("v0.8.5 需求6：启动恢复读会话快照，与 recentFolders 历史解耦", () => {
  it("openFolders 变化时 sessionFolders 同步更新：关闭文件夹后快照更新而 recentFolders 不变", () => {
    const { addOpenFolder, removeOpenFolder } = useFileStore.getState();
    addOpenFolder("C:/work/a");
    addOpenFolder("C:/work/b");
    removeOpenFolder("C:/work/b");

    // 快照 = 仍打开的文件夹；历史记录不受关闭影响
    expect(useFileStore.getState().sessionFolders).toEqual(["C:/work/a"]);
    expect(useFileStore.getState().recentFolders).toHaveLength(2);
  });

  it("sessionFolders 随 persist 持久化（独立于 recentFolders 的恢复数据源）", () => {
    const { addOpenFolder, removeOpenFolder } = useFileStore.getState();
    addOpenFolder("C:/work/a");
    addOpenFolder("C:/work/b");
    removeOpenFolder("C:/work/b");

    const persisted = readPersistedState();
    expect(persisted.sessionFolders).toEqual(["C:/work/a"]);
    // 历史条目同样持久化（供「最近打开」面板显示）
    expect(Array.isArray(persisted.recentFolders)).toBe(true);
    expect(persisted.recentFolders).toHaveLength(2);
  });

  it("restoreRecentFolders 按 sessionFolders 恢复，不受 recentFolders 历史干扰", async () => {
    // 快照里只有 opened-folder（上次会话结束时的状态）；
    // 历史里还有 closed-folder（已关闭，不应被恢复）
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { loadLastFolderOnStartup: true, loadLastFolderCount: 3 } })
    );
    localStorage.setItem(
      "lightmd-file-store",
      JSON.stringify({
        state: {
          sessionFolders: ["C:/work/opened-folder"],
          recentFolders: [
            { path: "C:/work/opened-folder", name: "opened-folder", accessedAt: 20 },
            { path: "C:/work/closed-folder", name: "closed-folder", accessedAt: 10 },
          ],
          recentFiles: [],
          favorites: [],
        },
      })
    );

    const addOpenFolder = vi.fn();
    const result = await restoreRecentFolders({
      fileServiceImpl: { readFile: vi.fn(), listDir: vi.fn(async () => []) },
      addOpenFolder,
      updateFolderTree: vi.fn(),
      markRecentFolderStale: vi.fn(),
      isTauriEnv: true,
      count: 3,
    });

    // 仅恢复快照中的文件夹；已关闭的历史条目（closed-folder）不恢复
    expect(result.restored).toBe(1);
    expect(addOpenFolder).toHaveBeenCalledTimes(1);
    expect(addOpenFolder).toHaveBeenCalledWith("C:/work/opened-folder");
  });
});

// ─── 4. 启动恢复失败 → 标 stale（不移除）──────────────────────────────

describe("v0.8.5 需求6：启动恢复失败标 stale 不移除", () => {
  it("文件夹恢复失败 → markRecentFolderStale 回调被调用（原 removeRecentFolder 行为已废弃）", async () => {
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { loadLastFolderOnStartup: true, loadLastFolderCount: 3 } })
    );
    localStorage.setItem(
      "lightmd-file-store",
      JSON.stringify({
        state: {
          sessionFolders: ["C:/work/gone-folder", "C:/work/ok-folder"],
          recentFolders: [],
          recentFiles: [],
          favorites: [],
        },
      })
    );

    const addOpenFolder = vi.fn();
    const markRecentFolderStale = vi.fn();
    const result = await restoreRecentFolders({
      fileServiceImpl: {
        readFile: vi.fn(),
        listDir: vi.fn(async (path: string) => {
          if (path === "C:/work/gone-folder") throw new Error("folder not exists");
          return [];
        }),
      },
      addOpenFolder,
      updateFolderTree: vi.fn(),
      markRecentFolderStale,
      isTauriEnv: true,
      count: 3,
    });

    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(1);
    // 失败路径被标 stale（而不是从清单移除）
    expect(markRecentFolderStale).toHaveBeenCalledWith("C:/work/gone-folder");
  });

  it("文件夹恢复失败后，历史条目仍保留且被真实标记为 stale", async () => {
    const { addOpenFolder } = useFileStore.getState();
    addOpenFolder("C:/work/gone-folder");

    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { loadLastFolderOnStartup: true, loadLastFolderCount: 1 } })
    );
    localStorage.setItem(
      "lightmd-file-store",
      JSON.stringify({
        state: {
          sessionFolders: ["C:/work/gone-folder"],
          recentFolders: useFileStore.getState().recentFolders,
          recentFiles: [],
          favorites: [],
        },
      })
    );

    // 注入真实的 store action（模拟 App.tsx 的接线方式）
    const result = await restoreRecentFolders({
      fileServiceImpl: {
        readFile: vi.fn(),
        listDir: vi.fn(async () => {
          throw new Error("folder not exists");
        }),
      },
      addOpenFolder: vi.fn(),
      updateFolderTree: vi.fn(),
      markRecentFolderStale: (path) => useFileStore.getState().markRecentFolderStale(path),
      isTauriEnv: true,
      count: 1,
    });

    expect(result.skipped).toBe(1);
    // 条目仍在历史中，且带 ⚠ 标记（永不删除语义）
    const entry = useFileStore
      .getState()
      .recentFolders.find((f) => f.path === "C:/work/gone-folder");
    expect(entry).toBeTruthy();
    expect(entry!.stale).toBe(true);
  });

  it("文件恢复失败 → markRecentStale 回调被调用（原 removeRecentFile 行为已废弃）", async () => {
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({ state: { loadLastFileOnStartup: true, loadLastFileCount: 2 } })
    );
    localStorage.setItem(
      "lightmd-file-store",
      JSON.stringify({
        state: {
          recentFiles: [
            { path: "C:/docs/gone.md", name: "gone.md", accessedAt: 20 },
            { path: "C:/docs/ok.md", name: "ok.md", accessedAt: 10 },
          ],
          recentFolders: [],
          favorites: [],
        },
      })
    );

    const dispatched: Array<{ path: string; content: string }> = [];
    const markRecentStale = vi.fn();
    const result = await restoreRecentFiles({
      fileServiceImpl: {
        readFile: vi.fn(async (path: string) => {
          if (path === "C:/docs/gone.md") throw new Error("file not found");
          return "content";
        }),
      },
      dispatchOpenFile: (detail) => dispatched.push(detail),
      markRecentStale,
      isTauriEnv: true,
    });

    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(1);
    expect(markRecentStale).toHaveBeenCalledWith("C:/docs/gone.md");
    // 成功的文件正常恢复
    expect(dispatched.map((d) => d.path)).toEqual(["C:/docs/ok.md"]);
  });
});

// ─── 5. UI：文件夹条目 stale 显示 ⚠ + tooltip ──────────────────────────────

describe("v0.8.5 需求6：RecentFiles 文件夹条目 stale UI", () => {
  function getItem(container: HTMLElement, name: string): HTMLElement {
    const el = Array.from(container.querySelectorAll(".recent-file-item")).find(
      (item) => item.querySelector(".filetree-name")?.textContent === name
    );
    expect(el).toBeTruthy();
    return el as HTMLElement;
  }

  it("文件夹条目 stale 时显示淡黄 ⚠，tooltip 追加失效提示（与文件条目一致）", () => {
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: Date.now(), stale: true }],
      recentFiles: [{ path: "C:/docs/f.md", name: "f.md", accessedAt: Date.now(), stale: true }],
    });

    const { container } = render(createElement(RecentFiles, { onOpen: vi.fn() }));

    // 文件夹条目：⚠ 标记渲染
    const folderItem = getItem(container, "a");
    expect(folderItem.querySelector(".recent-file-stale")?.textContent).toBe("⚠");
    // tooltip 含失效提示（复用 recent.staleHint）
    expect(folderItem.getAttribute("title")).toContain("该文件可能已变更位置或删除");
    expect(folderItem.getAttribute("title")).toContain("C:/work/a");

    // 文件条目 stale 显示不回归
    const fileItem = getItem(container, "f.md");
    expect(fileItem.querySelector(".recent-file-stale")?.textContent).toBe("⚠");
    expect(fileItem.getAttribute("title")).toContain("该文件可能已变更位置或删除");
  });

  it("非 stale 的文件夹条目不显示 ⚠，tooltip 无失效提示", () => {
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: Date.now() }],
    });

    const { container } = render(createElement(RecentFiles, { onOpen: vi.fn() }));

    const folderItem = getItem(container, "a");
    expect(folderItem.querySelector(".recent-file-stale")).toBeNull();
    expect(folderItem.getAttribute("title")).not.toContain("该文件可能已变更位置或删除");
  });

  it("点击 stale 的文件夹条目仍可尝试打开（历史条目可找回，不因 stale 禁用）", () => {
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: Date.now(), stale: true }],
    });

    const { container } = render(createElement(RecentFiles, { onOpen: vi.fn() }));
    const handler = vi.fn();
    window.addEventListener("lightmd:openFolder", handler);

    fireEvent.click(getItem(container, "a"));

    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toEqual({ path: "C:/work/a" });

    window.removeEventListener("lightmd:openFolder", handler);
  });
});
