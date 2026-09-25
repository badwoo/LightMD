/**
 * v0.8.4 集成测试 —— 第一部分（WP4 右键菜单）
 *
 * 覆盖：
 * 1. 需求2：树内文件/文件夹右键菜单含"复制/剪切"（位于"重命名"上方），
 *    点击后写入内存剪贴板（fileClipboard.getClipboard 可读）+ toast 反馈，菜单关闭
 * 2. 需求8：文件夹空白区右键菜单扩为四项（新建文件/新建文件夹/刷新/粘贴）：
 *    - 点击"刷新"以 folderCtxMenu.dir 为目标调用 refreshTree（经 listDir 调用参数断言）
 *    - 点击"新建文件"以 folderCtxMenu.dir 为落点调用 handleNewFile（经 createFile 调用参数断言）
 *    - 粘贴项置灰/可用态（v0.8.4 反馈1：改为渲染期实时读取 hasClipboard()）
 * 3. 反馈1：右键「粘贴」激活/置灰状态实时化 + 文件夹节点右键粘贴 + 同次右键不误关菜单
 *
 * 注：本文件为 v0.8.4 各工作包共享的集成测试文件，
 *     后续工作包（WP5 新建弹窗、S1 workspace 逐级加载、S7 刷新范围）将追加用例。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

// mock fileService：isTauri=true 让 refreshTree / handleNewFile 真正走到服务调用，
// 便于以 listDir / createFile 的调用参数断言"目标目录传参正确"
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
    // v0.8.4 需求10：watch 接入（FileTree 挂载即订阅事件；onFolderChanged 返回 unlisten）
    watchFolder: vi.fn(async () => {}),
    unwatchFolder: vi.fn(async () => {}),
    onFolderChanged: vi.fn(async () => () => {}),
  },
  isTauri: () => true,
}));

import { FileTree } from "../components/sidebar/FileTree";
import { useFileStore } from "../stores/useFileStore";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService } from "../services/fileService";
import { getClipboard, clearClipboard, setClipboard } from "../utils/fileClipboard";

// jsdom 未实现 ResizeObserver（SidebarScrollArrows 用其监听尺寸），mock 空实现，
// 供所有渲染 FileTree 的用例使用
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// vitest 未开启 globals → @testing-library/react 的 auto-cleanup 不生效，
// 组件渲染类测试需在 afterEach 手动 cleanup，避免 DOM 残留影响 querySelector
afterEach(() => cleanup());

const FILE_PATH = "C:/proj/a.md";
const DIR_PATH = "C:/proj/sub";

/** 打开一个含"文件 + 子文件夹"的文件夹，并复位剪贴板 / 编辑器 / 设置状态 */
function setupFolder() {
  clearClipboard();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  useSettingsStore.setState({ fileTreeSort: {} });
  useFileStore.setState({
    favorites: [],
    recentFiles: [],
    recentFolders: [],
    tempFiles: [],
    fileTree: [],
    rootPath: null,
    openFolders: [
      {
        path: "C:/proj",
        name: "proj",
        fileTree: [
          { name: "a.md", path: FILE_PATH, isDir: false, size: 10 },
          { name: "sub", path: DIR_PATH, isDir: true, size: 0 },
        ],
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupFolder();
});

/** 渲染 FileTree 并对指定节点（按 title=路径 定位）触发右键，返回弹出的菜单元素 */
function openNodeContextMenu(nodeTitle: string): HTMLElement {
  render(createElement(FileTree));
  const node = document.querySelector(`.filetree-node[title="${nodeTitle}"]`) as HTMLElement | null;
  expect(node).toBeTruthy();
  fireEvent.contextMenu(node!);
  const menu = document.querySelector(".filetree-context-menu") as HTMLElement | null;
  expect(menu).toBeTruthy();
  return menu!;
}

/** 渲染 FileTree 并对文件夹空白区触发右键，返回弹出的菜单元素 */
function openBlankContextMenu(): HTMLElement {
  render(createElement(FileTree));
  const content = document.querySelector(".filetree-folder-content") as HTMLElement | null;
  expect(content).toBeTruthy();
  fireEvent.contextMenu(content!);
  const menu = document.querySelector(".filetree-context-menu") as HTMLElement | null;
  expect(menu).toBeTruthy();
  return menu!;
}

/** 取菜单内全部按钮文本（trim 后） */
function menuButtonTexts(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim());
}

/** 在菜单中按文本查找按钮 */
function findMenuButton(menu: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(menu.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  expect(btn).toBeTruthy();
  return btn as HTMLButtonElement;
}

// ─── 1. 需求2：树内节点右键"复制/剪切" ──────────────────
describe("v0.8.4 需求2：树内节点右键复制/剪切", () => {
  it("文件节点右键菜单含复制/剪切，且位于重命名上方", () => {
    const menu = openNodeContextMenu(FILE_PATH);
    const texts = menuButtonTexts(menu);
    expect(texts).toContain("复制");
    expect(texts).toContain("剪切");
    expect(texts).toContain("重命名");
    expect(texts.indexOf("复制")).toBeLessThan(texts.indexOf("重命名"));
    expect(texts.indexOf("剪切")).toBeLessThan(texts.indexOf("重命名"));
  });

  it("点击复制 → 剪贴板写入（mode=copy）+ toast 反馈 + 菜单关闭", () => {
    const menu = openNodeContextMenu(FILE_PATH);
    fireEvent.click(findMenuButton(menu, "复制"));
    expect(getClipboard()).toEqual({ path: FILE_PATH, name: "a.md", mode: "copy" });
    // 点击后菜单关闭（现有 setContextMenu(null) 模式）
    expect(document.querySelector(".filetree-context-menu")).toBeNull();
    // toast 反馈与「打开的文件」面板右键一致
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已复制: a.md");
  });

  it("点击剪切 → 剪贴板写入（mode=cut）+ toast 反馈 + 菜单关闭", () => {
    const menu = openNodeContextMenu(FILE_PATH);
    fireEvent.click(findMenuButton(menu, "剪切"));
    expect(getClipboard()).toEqual({ path: FILE_PATH, name: "a.md", mode: "cut" });
    expect(document.querySelector(".filetree-context-menu")).toBeNull();
    const toast = document.querySelector(".filetree-toast");
    expect(toast?.textContent).toContain("已剪切: a.md");
  });

  it("文件夹节点同样支持右键复制/剪切（剪贴板路径为文件夹）", () => {
    const menu = openNodeContextMenu(DIR_PATH);
    expect(menuButtonTexts(menu)).toEqual(
      expect.arrayContaining(["复制", "剪切"]),
    );
    fireEvent.click(findMenuButton(menu, "剪切"));
    // v0.8.4 需求3 修复：剪贴板新增 isDir（目录为 true），供粘贴时自嵌套守卫按源类型分流
    expect(getClipboard()).toEqual({ path: DIR_PATH, name: "sub", mode: "cut", isDir: true });
  });
});

// ─── 2. 需求8：空白区右键四项菜单 ───────────────────────
describe("v0.8.4 需求8：空白区右键四项菜单", () => {
  it("四项齐全且顺序为：新建文件、新建文件夹、刷新、粘贴", () => {
    const menu = openBlankContextMenu();
    const texts = menuButtonTexts(menu);
    expect(texts).toHaveLength(4);
    // titlebar.newFile / titlebar.newFolder 文案带 emoji 前缀，用 includes 匹配
    expect(texts[0]).toContain("新建文件");
    expect(texts[1]).toContain("新建文件夹");
    expect(texts[2]).toBe("刷新");
    expect(texts[3]).toBe("粘贴");
  });

  it("点击刷新 → refreshTree 以右键所在目录为目标（listDir 被调用）", async () => {
    const menu = openBlankContextMenu();
    await act(async () => {
      fireEvent.click(findMenuButton(menu, "刷新"));
    });
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith("C:/proj");
    // 点击后菜单关闭
    expect(document.querySelector(".filetree-context-menu")).toBeNull();
  });

  // v0.8.4 WP5 适配：handleNewFile 改为打开 NewFileDialog（不再用原生 prompt），
  // 确认后才走 createFile；完整创建流程见下方"新建文件弹框确认后创建"用例
  it("点击新建文件 → 打开 NewFileDialog（目标目录为右键所在目录），菜单关闭", async () => {
    const menu = openBlankContextMenu();
    await act(async () => {
      fireEvent.click(findMenuButton(menu, "📄 新建文件"));
    });
    // 弹框打开且目标目录只读展示为本文件夹（需求5：确认"落在哪个子文件夹"）
    const overlay = document.querySelector(".newfile-overlay") as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain("C:/proj");
    expect(document.querySelector(".filetree-context-menu")).toBeNull();
    // 确认后创建流程：
    // 默认名已预填（listDir 返回 [] → 不避让，仍为"新文档.md"），直接点创建
    await act(async () => {});
    const createBtn = Array.from(overlay.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "创建",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(createBtn);
    });
    // handleCreateFileConfirm → createFile(joinPath(parentPath, name))；
    // 无扩展名/带 .md 均尊重（默认名"新文档.md"已带扩展名）
    expect(vi.mocked(fileService.createFile)).toHaveBeenCalledWith("C:/proj/新文档.md");
    // 创建成功后弹框关闭
    expect(document.querySelector(".newfile-overlay")).toBeNull();
  });

  it("点击新建文件夹 → 打开 NewFolderDialog（落点为本文件夹），菜单关闭", () => {
    const menu = openBlankContextMenu();
    fireEvent.click(findMenuButton(menu, "📁 新建文件夹"));
    expect(document.querySelector(".newfolder-overlay")).toBeTruthy();
    expect(document.querySelector(".filetree-context-menu")).toBeNull();
  });

  it("粘贴项：剪贴板为空时置灰，复制后可用", () => {
    render(createElement(FileTree));
    const content = document.querySelector(".filetree-folder-content") as HTMLElement;

    // 剪贴板为空 → 粘贴 disabled
    fireEvent.contextMenu(content);
    let menu = document.querySelector(".filetree-context-menu") as HTMLElement;
    expect(findMenuButton(menu, "粘贴").disabled).toBe(true);
    // 关闭菜单（点击空白触发 window click 关闭）
    fireEvent.click(document.body);
    expect(document.querySelector(".filetree-context-menu")).toBeNull();

    // 复制文件后重新右键 → 粘贴可用
    setClipboard({ path: FILE_PATH, name: "a.md" });
    fireEvent.contextMenu(content);
    menu = document.querySelector(".filetree-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(findMenuButton(menu, "粘贴").disabled).toBe(false);
  });
});

// ─── 3. WP5：S2 ref 双写（新建文件夹确认后 refreshTree 覆盖新展开目录） ──────────
describe("v0.8.4 WP5 S2：新建文件夹后 ref 双写刷新新展开目录", () => {
  /** FileEntry mock 工厂（snake_case，与 Rust 返回一致） */
  const entry = (name: string, path: string, isDir: boolean) => ({
    name,
    path,
    is_dir: isDir,
    size: 0,
    modified_ms: 0,
    created_ms: 0,
  });

  it("对未展开子文件夹右键新建文件夹 → 确认后该子目录被 refreshTree 重读（listDir 覆盖）", async () => {
    // 根层 listDir 返回 a.md + sub，其余目录返回空
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) =>
      p === "C:/proj" ? [entry("a.md", FILE_PATH, false), entry("sub", DIR_PATH, true)] : [],
    );
    render(createElement(FileTree));
    // 对未展开的 sub 节点右键 → 新建文件夹（preselected = sub 自身）
    const node = document.querySelector(`.filetree-node[title="${DIR_PATH}"]`) as HTMLElement;
    expect(node).toBeTruthy();
    fireEvent.contextMenu(node);
    let menu = document.querySelector(".filetree-context-menu") as HTMLElement;
    fireEvent.click(findMenuButton(menu, "📁 新建文件夹"));
    // NewFolderDialog 打开且已预选 sub，填名确认
    const overlay = document.querySelector(".newfolder-overlay") as HTMLElement;
    expect(overlay).toBeTruthy();
    const input = overlay.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nested" } });
    const createBtn = Array.from(overlay.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "创建",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(createBtn);
    });
    // S2 修复前：expandedPathsRef 要等 useEffect 才同步，refreshTree 读不到
    // "C:/proj/sub" → 该新展开目录不会被重读；
    // 修复后：handleCreateFolder 在 setState updater 内同步双写 ref →
    // refreshTree 递归刷新已展开目录时对 sub 再调一次 listDir
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith("C:/proj/sub");
    // 弹框关闭
    expect(document.querySelector(".newfolder-overlay")).toBeNull();
  });
});

// ─── 4. WP5：S1 workspace 深层文件定位逐级加载 ──────────────────────
describe("v0.8.4 WP5 S1：workspace 深层定位逐级加载中间层", () => {
  const entry = (name: string, path: string, isDir: boolean) => ({
    name,
    path,
    is_dir: isDir,
    size: 0,
    modified_ms: 0,
    created_ms: 0,
  });

  it("深层文件定位 → 根到目标父目录逐级 listDir，中间层 childrenMap 均写入且祖先在展开集中", async () => {
    // 深层结构：C:/proj/sub/deep/f.md（sub 为未展开目录）
    useFileStore.setState({
      openFolders: [
        {
          path: "C:/proj",
          name: "proj",
          fileTree: [
            { name: "a.md", path: FILE_PATH, isDir: false, size: 10 },
            { name: "sub", path: DIR_PATH, isDir: true, size: 0 },
          ],
        },
      ],
    });
    const listDirMock = vi.mocked(fileService.listDir);
    listDirMock.mockImplementation(async (p: string) => {
      if (p === "C:/proj") return [entry("a.md", FILE_PATH, false), entry("sub", DIR_PATH, true)];
      if (p === DIR_PATH) return [entry("deep", "C:/proj/sub/deep", true)];
      if (p === "C:/proj/sub/deep") return [entry("f.md", "C:/proj/sub/deep/f.md", false)];
      return [];
    });
    render(createElement(FileTree));
    // 与标签栏"打开所在文件夹工作区"同一条命令总线入口
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("lightmd:command", {
          detail: { id: "workspace.open", path: "C:/proj/sub/deep/f.md" },
        }),
      );
    });
    // 中间层均被逐级加载（S1 修复前：expandAncestors 只塞 expandedPaths 不调 listDir）
    expect(listDirMock).toHaveBeenCalledWith(DIR_PATH);
    expect(listDirMock).toHaveBeenCalledWith("C:/proj/sub/deep");
    // 树中 sub 已展开且内容为 deep（childrenMap 已写入），
    // deep 已展开且内容为 f.md（目标文件可见）——祖先路径全在展开集中
    expect(document.querySelector('.filetree-node[title="C:/proj/sub/deep"]')).toBeTruthy();
    expect(
      document.querySelector('.filetree-node[title="C:/proj/sub/deep/f.md"]'),
    ).toBeTruthy();
  });
});

// ─── 5. 需求10（D6 拍板）：刷新按钮去留 ──────────────────────
describe("v0.8.4 需求10：标题栏刷新按钮移除，兜底入口保留", () => {
  it("FolderSection 标题栏无 section-refresh 按钮；工具栏全局刷新按钮仍在", () => {
    // 工具栏全局刷新按钮的渲染条件是 rootPath（打开过文件夹即有值）
    useFileStore.setState({ rootPath: "C:/proj" });
    render(createElement(FileTree));
    // D6 拍板：仅移除标题栏刷新按钮（watch 实时刷新取代）
    expect(document.querySelector(".section-refresh")).toBeNull();
    // 兜底保留：工具栏全局刷新按钮（title=filetree.refreshTitle="刷新"）
    const toolbarRefresh = document.querySelector('.filetree-btn[title="刷新"]');
    expect(toolbarRefresh).toBeTruthy();
  });

  it("空白右键菜单「刷新」项保留（D6：右键刷新兜底不回填标题栏）", () => {
    const menu = openBlankContextMenu();
    expect(findMenuButton(menu, "刷新")).toBeTruthy();
  });
});

// ─── 6. 需求10 S7：FileNode 文件夹右键"刷新"刷目标自身子树 ──────────
describe("v0.8.4 需求10 S7：右键深层子文件夹刷新 node.path", () => {
  const entry = (name: string, path: string, isDir: boolean) => ({
    name,
    path,
    is_dir: isDir,
    size: 0,
    modified_ms: 0,
    created_ms: 0,
  });
  const DEEP_PATH = "C:/proj/sub/deep";

  it("右键深层子文件夹选刷新 → refreshTree 以该子文件夹路径调用（listDir(deep)），而非根", async () => {
    // 层级：C:/proj/sub/deep/f.md
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) => {
      if (p === "C:/proj") return [entry("a.md", FILE_PATH, false), entry("sub", DIR_PATH, true)];
      if (p === DIR_PATH) return [entry("deep", DEEP_PATH, true)];
      return [];
    });
    render(createElement(FileTree));
    // 展开 sub → deep 出现（childrenMap 写入）
    const subNode = document.querySelector(`.filetree-node[title="${DIR_PATH}"]`) as HTMLElement;
    expect(subNode).toBeTruthy();
    await act(async () => {
      fireEvent.click(subNode);
    });
    const deepNode = document.querySelector(`.filetree-node[title="${DEEP_PATH}"]`) as HTMLElement;
    expect(deepNode).toBeTruthy();

    // S7 断言关键：清除展开阶段产生的 listDir 调用记录，隔离"刷新"本身的调用
    vi.mocked(fileService.listDir).mockClear();
    fireEvent.contextMenu(deepNode);
    const menu = document.querySelector(".filetree-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    await act(async () => {
      fireEvent.click(findMenuButton(menu, "刷新"));
    });
    // 修复后：以右键目标自身路径调用（右键谁刷谁的子树）
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith(DEEP_PATH);
    // 修复前：闭包固定为 section 根 → 会以根路径刷新（listDir("C:/proj")）
    expect(vi.mocked(fileService.listDir)).not.toHaveBeenCalledWith("C:/proj");
  });

  it("右键根层子文件夹选刷新 → 同样以该文件夹路径调用（非根、非无参）", async () => {
    vi.mocked(fileService.listDir).mockImplementation(async (p: string) =>
      p === "C:/proj" ? [entry("a.md", FILE_PATH, false), entry("sub", DIR_PATH, true)] : [],
    );
    render(createElement(FileTree));
    const subNode = document.querySelector(`.filetree-node[title="${DIR_PATH}"]`) as HTMLElement;
    expect(subNode).toBeTruthy();
    vi.mocked(fileService.listDir).mockClear();
    fireEvent.contextMenu(subNode);
    const menu = document.querySelector(".filetree-context-menu") as HTMLElement;
    await act(async () => {
      fireEvent.click(findMenuButton(menu, "刷新"));
    });
    expect(vi.mocked(fileService.listDir)).toHaveBeenCalledWith(DIR_PATH);
    expect(vi.mocked(fileService.listDir)).not.toHaveBeenCalledWith("C:/proj");
  });
});

// ─── 7. 反馈1：右键「粘贴」可用态实时化 + 文件夹节点右键粘贴 ──────────
describe("v0.8.4 反馈1：右键粘贴的激活/置灰状态", () => {
  /** 打开含"文件 + 子文件夹"的文件夹，并复位剪贴板（本组用例需要精细控制剪贴板） */
  function setupFolderWithClipboard(
    clip: { path: string; name: string; mode?: "copy" | "cut"; isDir?: boolean } | null,
  ) {
    setupFolder();
    if (clip) setClipboard(clip);
  }

  it("剪贴板为空时：空白区菜单与文件夹节点菜单的「粘贴」都置灰（disabled）", () => {
    // ① 文件夹空白区右键
    let menu = openBlankContextMenu();
    const blankPaste = findMenuButton(menu, "粘贴");
    expect(blankPaste.disabled).toBe(true);
    // 置灰时给出 tooltip 提示文案
    expect(blankPaste.title).toBe("剪贴板为空，请先复制文件");
    cleanup();

    // ② 文件夹节点右键（v0.8.4 反馈1 新增的粘贴项）
    menu = openNodeContextMenu(DIR_PATH);
    const nodePaste = findMenuButton(menu, "粘贴");
    expect(nodePaste.disabled).toBe(true);
    expect(nodePaste.title).toBe("剪贴板为空，请先复制文件");
  });

  it("复制后：两处「粘贴」均为可用态（disabled === false）", () => {
    // 走真实用户路径：文件节点右键「复制」写入剪贴板
    let menu = openNodeContextMenu(FILE_PATH);
    fireEvent.click(findMenuButton(menu, "复制"));
    expect(getClipboard()).toEqual({ path: FILE_PATH, name: "a.md", mode: "copy" });
    cleanup();

    // ① 空白区菜单：粘贴可用
    menu = openBlankContextMenu();
    expect(findMenuButton(menu, "粘贴").disabled).toBe(false);
    cleanup();

    // ② 文件夹节点菜单：粘贴可用
    menu = openNodeContextMenu(DIR_PATH);
    expect(findMenuButton(menu, "粘贴").disabled).toBe(false);
  });

  it("点击文件夹节点的「粘贴」→ 以 node.path 为目标复制（copyFile 落点正确）", async () => {
    setupFolderWithClipboard({ path: FILE_PATH, name: "a.md", mode: "copy" });
    const menu = openNodeContextMenu(DIR_PATH);
    await act(async () => {
      fireEvent.click(findMenuButton(menu, "粘贴"));
    });
    // 目标目录为右键的那个文件夹（复用 handlePasteIntoDir → transferTo）
    expect(vi.mocked(fileService.copyFile)).toHaveBeenCalledWith(FILE_PATH, `${DIR_PATH}/a.md`);
    // 点击后菜单关闭
    expect(document.querySelector(".filetree-context-menu")).toBeNull();
  });

  it("剪贴板为「剪切」时，节点「粘贴」= 移动（moveFile），且粘贴后剪贴板清空", async () => {
    setupFolderWithClipboard({ path: FILE_PATH, name: "a.md", mode: "cut" });
    const menu = openNodeContextMenu(DIR_PATH);
    await act(async () => {
      fireEvent.click(findMenuButton(menu, "粘贴"));
    });
    expect(vi.mocked(fileService.moveFile)).toHaveBeenCalledWith(FILE_PATH, `${DIR_PATH}/a.md`);
    // 与系统资源管理器一致：剪切粘贴成功后清空剪贴板
    expect(getClipboard()).toBeNull();
  });

  it("文件节点右键不渲染「粘贴」项（对文件粘贴无意义）", () => {
    setupFolderWithClipboard({ path: DIR_PATH, name: "sub", mode: "copy", isDir: true });
    const menu = openNodeContextMenu(FILE_PATH);
    expect(menuButtonTexts(menu)).not.toContain("粘贴");
    // 对照组：同一剪贴板状态下文件夹节点是有「粘贴」的
    cleanup();
    const dirMenu = openNodeContextMenu(DIR_PATH);
    expect(menuButtonTexts(dirMenu)).toContain("粘贴");
  });

  it("菜单已打开时再次右键另一文件夹：菜单保持打开并重新定位，粘贴落到新目标", async () => {
    // 两个打开的文件夹（第二个用于"右键另一文件夹"）
    setupFolderWithClipboard({ path: FILE_PATH, name: "a.md", mode: "copy" });
    useFileStore.setState({
      openFolders: [
        {
          path: "C:/proj",
          name: "proj",
          fileTree: [
            { name: "a.md", path: FILE_PATH, isDir: false, size: 10 },
            { name: "sub", path: DIR_PATH, isDir: true, size: 0 },
          ],
        },
        { path: "C:/other", name: "other", fileTree: [] },
      ],
    });
    render(createElement(FileTree));
    const contents = document.querySelectorAll(".filetree-folder-content");
    expect(contents.length).toBe(2);

    // 第一次右键第一个文件夹空白区 → 菜单打开
    fireEvent.contextMenu(contents[0], { clientX: 10, clientY: 20 });
    const firstMenu = document.querySelector(".filetree-context-menu") as HTMLElement | null;
    expect(firstMenu).toBeTruthy();
    expect(firstMenu!.style.left).toBe("10px");

    // 菜单仍打开时右键第二个文件夹空白区 → 不应被"同一次右键"的 window 关闭监听干掉
    fireEvent.contextMenu(contents[1], { clientX: 40, clientY: 50 });
    const secondMenu = document.querySelector(".filetree-context-menu") as HTMLElement | null;
    expect(secondMenu).toBeTruthy();
    // 重新定位到第二次右键的坐标（证明菜单是"新打开"的那个，而非残留的旧菜单）
    expect(secondMenu!.style.left).toBe("40px");

    // 再点「粘贴」→ 目标已切换为第二个文件夹
    await act(async () => {
      fireEvent.click(findMenuButton(secondMenu!, "粘贴"));
    });
    expect(vi.mocked(fileService.copyFile)).toHaveBeenCalledWith(FILE_PATH, "C:/other/a.md");
  });
});
