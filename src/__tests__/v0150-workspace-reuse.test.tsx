/**
 * v0.15.0 F2 工作区复用：打开所在文件夹工作区不再重复挂载
 *
 * 覆盖（任务卡验收 7 类路径边界）：
 * 1. 直接父目录（file 的父目录恰好是已打开根）
 * 2. 祖先目录（file 的父目录是已打开根的子目录）
 * 3. 多根嵌套 → 选「包含该文件的最深根」作定位上下文
 * 4. `foo` vs `foobar` 相似前缀（/a/foo 不得匹配 /a/foobar）
 * 5. 分隔符混用 / 尾斜杠 / 大小写（Windows 语义）
 * 6. 中文 + 空格路径
 * 7. 未挂载 → 仍正确走 openFolder(parentDir)
 * 8. watcher 与 folder 数不变：mounted 分支不新增 folder、不调 watchFolder；
 *    openFolderAt 对已打开根不重复注册 watcher（集成层断言调用次数）
 *
 * 路径比较全部复用 utils/path.ts 的 isSameOrInsidePath —— 本文件只断言行为，不重复实现匹配。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { createElement } from "react";
import { render, cleanup, act } from "@testing-library/react";

// v0.15.0 F2 新增的 i18n key 由 Lead 统一加入 locales；本用例**不写 locales**，
// 用 mock 把「用了哪个 key」映射成可断言的文案，从而锁定「已定位 vs 已打开」的区分。
vi.mock("../i18n", () => {
  const DICT: Record<string, string> = {
    "filetree.workspaceLocated": "已定位到当前工作区: {name}",
    "filetree.workspaceOpened": "已在左侧打开: {name}",
  };
  const t = (key: string, params?: Record<string, string | number>) => {
    let out = DICT[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return out;
  };
  return { t, useT: () => t, getCurrentLanguage: () => "zh-CN" };
});

// mock fileService（isTauri=true 走真实服务调用路径，便于以 watchFolder 调用次数断言）
vi.mock("../services/fileService", () => ({
  fileService: {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    getFileSize: vi.fn(async () => 0),
    createFile: vi.fn(async () => {}),
    createDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    moveFile: vi.fn(async () => {}),
    revealInFolder: vi.fn(async () => {}),
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import {
  openContainingWorkspace,
  findDeepestContainingRoot,
  type OpenWorkspaceDeps,
} from "../utils/workspace";
import { isSameOrInsidePath, isSamePath, getParentDir } from "../utils/path";
import { FileTree } from "../components/sidebar/FileTree";
import { fileService } from "../services/fileService";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

/** 造 deps：isPathInOpenFolders 走真实的 store 语义（isSameOrInsidePath），
 *  openFolders 单独传入以便构造多根嵌套场景 */
function makeDeps(
  openFolders: { path: string }[],
  overrides: Partial<OpenWorkspaceDeps> = {},
) {
  const expandTo = vi.fn();
  const openFolder = vi.fn();
  const setActive = vi.fn();
  const deps: OpenWorkspaceDeps = {
    openFolders,
    isPathInOpenFolders: (p: string) => openFolders.some((f) => isSameOrInsidePath(p, f.path)),
    expandTo,
    openFolder,
    setActive,
    ...overrides,
  };
  return { deps, expandTo, openFolder, setActive };
}

// ─── 1. 纯函数层：openContainingWorkspace / findDeepestContainingRoot ────────
describe("v0.15.0 F2 openContainingWorkspace 路径边界", () => {
  it("① 直接父目录：父目录恰为已打开根 → 仅展开定位，不挂载", () => {
    const { deps, expandTo, openFolder, setActive } = makeDeps([{ path: "D:/docs" }]);
    const result = openContainingWorkspace("D:/docs/a.md", deps);

    expect(result.mounted).toBe(true);
    expect(result.parentDir).toBe("D:/docs");
    expect(result.rootDir).toBe("D:/docs");
    expect(expandTo).toHaveBeenCalledWith("D:/docs");
    expect(setActive).toHaveBeenCalledWith("D:/docs/a.md");
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("② 祖先目录：父目录是已打开根的子目录 → 仍判已挂载，按父目录展开", () => {
    const { deps, expandTo, openFolder, setActive } = makeDeps([{ path: "D:/docs" }]);
    const result = openContainingWorkspace("D:/docs/sub/deep/b.md", deps);

    expect(result.mounted).toBe(true);
    // 展开目标是「文件所在父目录」，而非工作区根
    expect(result.parentDir).toBe("D:/docs/sub/deep");
    expect(result.rootDir).toBe("D:/docs");
    expect(expandTo).toHaveBeenCalledWith("D:/docs/sub/deep");
    expect(setActive).toHaveBeenCalledWith("D:/docs/sub/deep/b.md");
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("③ 多根嵌套：选包含该文件的最深根（而非先出现的浅根）", () => {
    // 故意把浅根放前面 —— 取「首个命中」的旧实现会错选 D:/work
    const { deps, expandTo, openFolder } = makeDeps([
      { path: "D:/work" },
      { path: "D:/work/proj" },
      { path: "D:/work/proj/src" },
    ]);
    const result = openContainingWorkspace("D:/work/proj/src/util/c.md", deps);

    expect(result.mounted).toBe(true);
    expect(result.rootDir).toBe("D:/work/proj/src");
    expect(result.parentDir).toBe("D:/work/proj/src/util");
    expect(expandTo).toHaveBeenCalledWith("D:/work/proj/src/util");
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("③b findDeepestContainingRoot 直接断言：最深根 / 无命中 / 空输入", () => {
    const roots = [{ path: "D:/a" }, { path: "D:/a/b" }, { path: "D:/a/b/c" }];
    expect(findDeepestContainingRoot("D:/a/b/c/d.md", roots)).toBe("D:/a/b/c");
    expect(findDeepestContainingRoot("D:/a/b/x.md", roots)).toBe("D:/a/b");
    expect(findDeepestContainingRoot("D:/a/y.md", roots)).toBe("D:/a");
    // 无命中 → null（由调用方回退）
    expect(findDeepestContainingRoot("D:/other/z.md", roots)).toBe(null);
    expect(findDeepestContainingRoot("", roots)).toBe(null);
    expect(findDeepestContainingRoot("D:/a/y.md", [])).toBe(null);
    // 深度相同（罕见）：先出现者胜出，行为稳定
    expect(findDeepestContainingRoot("D:/a/y.md", [{ path: "D:/A" }, { path: "D:/a" }])).toBe("D:/A");
  });

  it("④ foo vs foobar 相似前缀：/a/foo 不得匹配 /a/foobar", () => {
    // 已打开 /a/foobar，文件在 /a/foo 下 → 必须判「未挂载」
    {
      const { deps, openFolder, expandTo } = makeDeps([{ path: "D:/a/foobar" }]);
      const result = openContainingWorkspace("D:/a/foo/x.md", deps);
      expect(result.mounted).toBe(false);
      expect(result.rootDir).toBe("D:/a/foo");
      expect(openFolder).toHaveBeenCalledWith("D:/a/foo");
      expect(expandTo).not.toHaveBeenCalled();
    }
    // 反向：已打开 /a/foo，文件在 /a/foobar 下 → 同样不得误判
    {
      const { deps } = makeDeps([{ path: "D:/a/foo" }]);
      expect(openContainingWorkspace("D:/a/foobar/x.md", deps).mounted).toBe(false);
    }
    // 纯函数直断（isSameOrInsidePath 的边界语义）
    expect(isSameOrInsidePath("D:/a/foobar", "D:/a/foo")).toBe(false);
    expect(isSameOrInsidePath("D:/a/foo", "D:/a/foobar")).toBe(false);
    expect(isSameOrInsidePath("D:/a/foo", "D:/a/foo")).toBe(true);
    expect(isSameOrInsidePath("D:/a/foo/x.md", "D:/a/foo")).toBe(true);
    expect(isSameOrInsidePath("D:/a/foo-bar/x.md", "D:/a/foo")).toBe(false);
  });

  it("⑤ 分隔符混用 / 尾斜杠 / 大小写：全部归一到同一工作区", () => {
    // 根用反斜杠 + 尾斜杠，文件用正斜杠 → 仍应判已挂载
    {
      const { deps, expandTo, openFolder } = makeDeps([{ path: "D:\\Docs\\" }]);
      const filePath = "D:/docs/sub/a.md";
      const result = openContainingWorkspace(filePath, deps);
      expect(result.mounted).toBe(true);
      // 定位上下文是 openFolders 里的原始写法（供 UI 取名/比对用）
      expect(result.rootDir).toBe("D:\\Docs\\");
      expect(expandTo).toHaveBeenCalledWith(getParentDir(filePath)); // "D:/docs/sub"
      expect(openFolder).not.toHaveBeenCalled();
    }
    // 大小写：D:/DOCS 根 vs d:/docs 文件
    {
      const { deps, openFolder } = makeDeps([{ path: "D:/DOCS" }]);
      expect(openContainingWorkspace("d:/docs/a.md", deps).mounted).toBe(true);
      expect(openFolder).not.toHaveBeenCalled();
    }
    // 纯函数层：尾斜杠/反斜杠/大小写三轴归一等价
    expect(isSameOrInsidePath("D:\\Docs\\Sub\\a.md", "D:/docs")).toBe(true);
    expect(isSameOrInsidePath("d:/docs/", "D:/Docs")).toBe(true);
    expect(isSamePath("D:\\docs\\a.md", "d:/DOCS/a.md")).toBe(true);
  });

  it("⑥ 中文 + 空格路径：判定与提示取名都正确", () => {
    const root = "D:/我的 文档/项目 A";
    const file = "D:/我的 文档/项目 A/子 目录/笔记.md";
    const { deps, expandTo, openFolder } = makeDeps([{ path: root }]);
    const result = openContainingWorkspace(file, deps);

    expect(result.mounted).toBe(true);
    expect(result.rootDir).toBe(root);
    expect(result.parentDir).toBe("D:/我的 文档/项目 A/子 目录");
    expect(expandTo).toHaveBeenCalledWith("D:/我的 文档/项目 A/子 目录");
    expect(openFolder).not.toHaveBeenCalled();
    // 中文 + 空格 + 反斜杠混用也能匹配
    expect(isSameOrInsidePath("D:\\我的 文档\\项目 A\\b.md", root)).toBe(true);
  });

  it("⑦ 未挂载：仍派发 openFolder(parentDir)，且不展开/不定位", () => {
    const { deps, expandTo, openFolder, setActive } = makeDeps([{ path: "D:/other" }]);
    const result = openContainingWorkspace("D:/projects/demo/a.md", deps);

    expect(result.mounted).toBe(false);
    expect(result.parentDir).toBe("D:/projects/demo");
    // 未挂载时 rootDir 即即将挂载的父目录
    expect(result.rootDir).toBe("D:/projects/demo");
    expect(openFolder).toHaveBeenCalledWith("D:/projects/demo");
    expect(expandTo).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
  });

  it("无已打开根 / 空文件路径：不抛错", () => {
    const { deps } = makeDeps([]);
    expect(() => openContainingWorkspace("D:/a/b.md", deps)).not.toThrow();
    expect(() => openContainingWorkspace("", deps)).not.toThrow();
  });
});

// ─── 2. store 层：isPathInOpenFolders 委托 isSameOrInsidePath ────────────────
describe("v0.15.0 F2 useFileStore.isPathInOpenFolders 统一路径比较", () => {
  beforeEach(() => {
    localStorage.removeItem("lightmd-file-store");
    useFileStore.setState({ openFolders: [], rootPath: null, fileTree: [] });
  });

  it("分隔符/尾斜杠/大小写归一 + foo/foobar 边界", () => {
    useFileStore.getState().addOpenFolder("D:\\Docs\\");
    const isIn = useFileStore.getState().isPathInOpenFolders;

    expect(isIn("D:/docs/a.md")).toBe(true); // 反斜杠根 + 正斜杠文件
    expect(isIn("d:/DOCS/sub/b.md")).toBe(true); // 大小写
    expect(isIn("D:/Docs")).toBe(true); // 自身
    expect(isIn("D:/DocsOther/c.md")).toBe(false); // 相似前缀
    expect(isIn("D:/doc")).toBe(false); // 前缀但非父级
    expect(isIn("")).toBe(false);
  });

  it("多根嵌套：任一命中即为 true", () => {
    const store = useFileStore.getState();
    store.addOpenFolder("D:/work");
    store.addOpenFolder("D:/work/proj/src");
    expect(useFileStore.getState().isPathInOpenFolders("D:/work/proj/src/a.md")).toBe(true);
    expect(useFileStore.getState().isPathInOpenFolders("D:/work/other/b.md")).toBe(true);
    expect(useFileStore.getState().isPathInOpenFolders("D:/elsewhere/c.md")).toBe(false);
  });

  it("无打开文件夹 → false", () => {
    expect(useFileStore.getState().isPathInOpenFolders("D:/any/a.md")).toBe(false);
  });
});

// ─── 3. 集成层：FileTree 打开所在工作区不重复挂载（watcher/folder 数不变）────
describe("v0.15.0 F2 FileTree 打开所在工作区：不新增 folder、不增加 watcher 调用", () => {
  const ROOT = "D:/proj";
  const SUB = "D:/proj/sub";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("lightmd-file-store");
    localStorage.removeItem("lightmd-editor-store");
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
    useSettingsStore.setState({ fileTreeSort: {} });
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
      recentFolders: [],
      tempFiles: [],
      fileTree: [],
      rootPath: null,
      openFolders: [],
    });
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) =>
      p === SUB
        ? [
            {
              name: "f.md",
              path: `${SUB}/f.md`,
              is_dir: false,
              size: 1,
              modified_ms: 0,
              created_ms: 0,
            },
          ]
        : [],
    );
  });

  afterEach(() => cleanup());

  /** 渲染 FileTree，经命令总线触发「打开所在文件夹工作区」 */
  async function openWorkspaceFor(filePath: string) {
    render(createElement(FileTree));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("lightmd:command", {
          detail: { id: "workspace.open", path: filePath },
        }),
      );
    });
  }

  it("父目录已在工作区内 → 不新增 folder、不调用 watchFolder、提示「已定位」", async () => {
    useFileStore.setState({
      openFolders: [{ path: ROOT, name: "proj", fileTree: [] }],
      rootPath: ROOT,
    });
    const foldersBefore = useFileStore.getState().openFolders.length;

    await openWorkspaceFor(`${SUB}/f.md`);

    const state = useFileStore.getState();
    // ① folder 数不变
    expect(state.openFolders).toHaveLength(foldersBefore);
    expect(state.openFolders.map((f) => f.path)).toEqual([ROOT]);
    // ② watcher 调用次数不增加（挂载才注册）
    expect(vi.mocked(fileService.watchFolder)).not.toHaveBeenCalled();
    // ③ 只做定位：逐级加载 + 展开 + 激活；不整树刷新（updateFolderTree 未走挂载分支）
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith(SUB);
    // ④ 提示文案走「已定位到当前工作区」
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已定位到当前工作区");
    expect(toast?.textContent).toContain("proj");
    expect(toast?.textContent).not.toContain("已在左侧打开");
  });

  it("未被任何工作区包含 → 走 openFolderAt 挂载，watcher 恰好注册一次", async () => {
    useFileStore.setState({ openFolders: [], rootPath: null });

    await openWorkspaceFor(`${ROOT}/a.md`);
    // 挂载由 lightmd:openFolder 事件异步驱动（FileTree 内部监听器），等一轮微/宏任务
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useFileStore.getState().openFolders.map((f) => f.path)).toEqual([ROOT]);
    expect(vi.mocked(fileService.watchFolder)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileService.watchFolder)).toHaveBeenCalledWith(ROOT);
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已在左侧打开");
  });

  it("openFolderAt 对已打开根去重：再次打开同一路径不重复注册 watcher", async () => {
    render(createElement(FileTree));
    // 第一次：真正新增 → 注册 watcher
    await act(async () => {
      window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: ROOT } }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(fileService.watchFolder)).toHaveBeenCalledTimes(1);
    const countAfterFirst = useFileStore.getState().openFolders.length;

    // 第二次：同一根（大小写/尾斜杠不同写法）→ 去重，不再增加 watcher、不增加 folder
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("lightmd:openFolder", { detail: { path: "D:\\proj\\" } }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(fileService.watchFolder)).toHaveBeenCalledTimes(1);
    expect(useFileStore.getState().openFolders).toHaveLength(countAfterFirst);
  });

  it("多根嵌套：定位取最深根，提示里出现最深根名而非浅根名", async () => {
    const DEEP = "D:/proj/src";
    useFileStore.setState({
      openFolders: [
        { path: ROOT, name: "proj", fileTree: [] },
        { path: DEEP, name: "src", fileTree: [] },
      ],
      rootPath: ROOT,
    });
    vi.mocked(fileService.listDir).mockImplementation(async () => []);

    await openWorkspaceFor(`${DEEP}/util/c.md`);

    expect(vi.mocked(fileService.watchFolder)).not.toHaveBeenCalled();
    expect(useFileStore.getState().openFolders).toHaveLength(2);
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("src");
    expect(toast?.textContent).toContain("已定位到当前工作区");
  });
});
