/**
 * v0.8.5 需求8：「最近打开」面板混排最近打开文件夹
 *
 * 覆盖：
 * 1. 文件与文件夹按 accessedAt 降序混排在同一列表（时间交错）
 * 2. 文件夹条目渲染专属图标（📁，与树内一致）+ 名称；文件条目仍为 📝
 * 3. 点击文件夹条目 → 派发既有 lightmd:openFolder 事件（detail={path}），
 *    由 FileTree 既有监听器调用 openFolderAt 打开为文件夹栏；不触发 onOpen
 * 4. 全空（文件+文件夹均无记录）时整栏不渲染；仅文件夹有记录时栏渲染
 * 5. 总上限 66 条：文件+文件夹合并计数截断（超出掉最旧条目）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RecentFiles } from "../components/sidebar/RecentFiles";
import { useFileStore, MAX_RECENT_FILES } from "../stores/useFileStore";

// ─── ResizeObserver mock（防御性：jsdom 未实现，部分环境挂载时可能用到）────
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
  useFileStore.setState({ recentFiles: [], recentFolders: [] });
});

afterEach(() => {
  cleanup();
});

/** 读取当前渲染的混排条目（按 DOM 顺序返回每条的 filetree-name 文本） */
function getItemNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".recent-file-item .filetree-name")).map(
    (el) => el.textContent ?? ""
  );
}

/** 按 filetree-name 文本定位条目元素 */
function getItemByName(container: HTMLElement, name: string): HTMLElement {
  const el = Array.from(container.querySelectorAll(".recent-file-item")).find(
    (item) => item.querySelector(".filetree-name")?.textContent === name
  );
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

describe("v0.8.5 需求8：文件与文件夹混排", () => {
  it("按 accessedAt 降序混排（时间交错：文件夹夹在文件之间）", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFiles: [
        { path: "C:/docs/f1.md", name: "f1.md", accessedAt: now - 1000 },
        { path: "C:/docs/f2.md", name: "f2.md", accessedAt: now - 5000 },
        { path: "C:/docs/f3.md", name: "f3.md", accessedAt: now - 9000 },
      ],
      recentFolders: [
        { path: "C:/work/a", name: "a", accessedAt: now }, // 最新，应排最前
        { path: "C:/work/b", name: "b", accessedAt: now - 3000 }, // 夹在 f1 与 f2 之间
      ],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    // 期望顺序：a(now) → f1(now-1s) → b(now-3s) → f2(now-5s) → f3(now-9s)
    expect(getItemNames(container)).toEqual(["a", "f1.md", "b", "f2.md", "f3.md"]);
  });

  it("文件夹条目渲染专属图标 📁，文件条目仍为 📝", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFiles: [
        { path: "C:/docs/f1.md", name: "f1.md", accessedAt: now - 1000 },
      ],
      recentFolders: [
        { path: "C:/work/a", name: "a", accessedAt: now },
      ],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    const folderItem = getItemByName(container, "a");
    expect(folderItem.querySelector(".filetree-icon")?.textContent).toBe("📁");
    expect(folderItem.querySelector(".filetree-name")?.textContent).toBe("a");

    const fileItem = getItemByName(container, "f1.md");
    expect(fileItem.querySelector(".filetree-icon")?.textContent).toBe("📝");
  });

  it("文件夹条目 hover 提示含完整路径与最近打开时间（同文件条目格式）", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: now }],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    const folderItem = getItemByName(container, "a");
    expect(folderItem.getAttribute("title")).toContain("C:/work/a");
    expect(folderItem.getAttribute("title")).toContain("最近打开");
  });

  it("点击文件夹条目 → 派发 lightmd:openFolder 事件（detail={path}），不触发 onOpen", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: now }],
    });

    const onOpen = vi.fn();
    const { container } = render(<RecentFiles onOpen={onOpen} />);

    // 监听既有事件总线：FileTree 已注册 lightmd:openFolder → openFolderAt
    const handler = vi.fn();
    window.addEventListener("lightmd:openFolder", handler);

    fireEvent.click(getItemByName(container, "a"));

    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toEqual({ path: "C:/work/a" });
    // 文件夹条目不走文件打开回调
    expect(onOpen).not.toHaveBeenCalled();

    window.removeEventListener("lightmd:openFolder", handler);
  });

  it("点击文件条目仍触发 onOpen（回归：混排不改变文件条目行为）", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFiles: [
        { path: "C:/docs/f1.md", name: "f1.md", accessedAt: now },
      ],
    });

    const onOpen = vi.fn();
    const { container } = render(<RecentFiles onOpen={onOpen} />);

    fireEvent.click(getItemByName(container, "f1.md"));

    expect(onOpen).toHaveBeenCalledWith({
      name: "f1.md",
      path: "C:/docs/f1.md",
      isDir: false,
      size: 0,
    });
  });

  it("标题栏控制按钮仍渲染（回归：文件夹记录存在时栏结构完整）", () => {
    const now = Date.now();
    useFileStore.setState({
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: now }],
    });

    render(<RecentFiles onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByTitle("缩小")).toBeTruthy();
    expect(screen.getByTitle("放大")).toBeTruthy();
    expect(screen.getByTitle("关闭")).toBeTruthy();
  });
});

describe("v0.8.5 需求8：空态显隐", () => {
  it("文件与文件夹记录全空时整栏不渲染", () => {
    useFileStore.setState({ recentFiles: [], recentFolders: [] });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it("仅文件夹有记录（文件为空）时栏正常渲染", () => {
    useFileStore.setState({
      recentFiles: [],
      recentFolders: [{ path: "C:/work/a", name: "a", accessedAt: Date.now() }],
    });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    expect(container.firstChild).not.toBeNull();
    expect(getItemNames(container)).toEqual(["a"]);
  });
});

describe("v0.8.5 需求8：总上限 66 条截断", () => {
  it("文件+文件夹合并计数，超出 MAX_RECENT_FILES 截掉最旧条目", () => {
    const base = Date.now();
    // 70 个文件（较旧，accessedAt: base-10 … base-79）
    const files = Array.from({ length: 70 }, (_, i) => ({
      path: `C:/d/f${i}.md`,
      name: `f${i}.md`,
      accessedAt: base - 10 - i,
    }));
    // 5 个文件夹（最新，accessedAt: base … base-4）→ 混排后应全部保留
    const folders = Array.from({ length: 5 }, (_, i) => ({
      path: `C:/d/dir${i}`,
      name: `dir${i}`,
      accessedAt: base - i,
    }));
    useFileStore.setState({ recentFiles: files, recentFolders: folders });

    const { container } = render(<RecentFiles onOpen={vi.fn()} />);

    const items = container.querySelectorAll(".recent-file-item");
    // 75 条数据只渲染前 66 条（合并计数，而非分别截断）
    expect(items).toHaveLength(MAX_RECENT_FILES);
    // 5 个最新文件夹全部保留（数 📁 图标）
    const folderCount = Array.from(items).filter(
      (item) => item.querySelector(".filetree-icon")?.textContent === "📁"
    ).length;
    expect(folderCount).toBe(5);
    // 最旧的 f68.md / f69.md（base-78 / base-79）被截断
    expect(getItemNames(container)).not.toContain("f68.md");
    expect(getItemNames(container)).not.toContain("f69.md");
  });
});
