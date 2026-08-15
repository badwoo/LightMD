/**
 * v0.4.1 版本快照窗口测试
 *
 * 覆盖：
 * 1. 问题6：放大按钮点击——maximized state 切换，dialog 样式变化（width/height）
 * 2. 问题6：最大化时拖拽禁用——onHeaderMouseDown 不响应
 * 3. 问题6：还原按钮——maximized 切回 false
 * 4. 问题6：双击标题栏切换最大化
 * 5. 问题7：左右栏滚动联动——左栏滚动时右栏同步 scrollTop
 * 6. 问题7：切换快照时滚动重置为 0
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { VersionSnapshotDialog } from "../components/dialogs/VersionSnapshotDialog";
import type { SnapshotMeta, SnapshotDiff } from "../services/versionSnapshotService";

// 用 vi.hoisted 创建 mock 函数，确保 vi.mock 工厂能引用（hoisted 优先执行）
const {
  mockGetSnapshots,
  mockReadSnapshotContent,
  mockDiffContent,
  mockApplySnapshot,
} = vi.hoisted(() => ({
  mockGetSnapshots: vi.fn(),
  mockReadSnapshotContent: vi.fn(),
  mockDiffContent: vi.fn(),
  mockApplySnapshot: vi.fn(),
}));

// mock versionSnapshotService（组件唯一外部依赖，mock 后不会加载 tauri 模块）
vi.mock("../services/versionSnapshotService", () => ({
  versionSnapshotService: {
    getSnapshots: mockGetSnapshots,
    readSnapshotContent: mockReadSnapshotContent,
    diffContent: mockDiffContent,
    applySnapshot: mockApplySnapshot,
  },
}));

// 快照元数据工厂
function makeSnapshots(count: number): SnapshotMeta[] {
  const arr: SnapshotMeta[] = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      id: `snap-${i}`,
      filePath: "/test/file.md",
      timestamp: 1000 * (i + 1),
      size: 20,
      contentPath: `/snap/${i}.md`,
      isInitial: i === 0,
      contentHash: `hash-${i}`,
    });
  }
  return arr;
}

// diff 测试数据（2 行 context，保证左右栏行数相同）
const mockDiffResult: SnapshotDiff = {
  added: 0,
  removed: 0,
  lines: [
    { type: "context", oldLineNo: 1, newLineNo: 1, content: "line 1" },
    { type: "context", oldLineNo: 2, newLineNo: 2, content: "line 2" },
  ],
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mockGetSnapshots.mockReset();
  mockReadSnapshotContent.mockReset();
  mockDiffContent.mockReset();
  mockApplySnapshot.mockReset();
  // 默认返回空快照和无差异
  mockGetSnapshots.mockReturnValue([]);
  mockReadSnapshotContent.mockResolvedValue("");
  mockDiffContent.mockReturnValue({ added: 0, removed: 0, lines: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 辅助：渲染带 diff 内容的组件
 * @param snapCount 快照数量（默认 2）
 * @returns render 结果
 */
function renderWithDiff(snapCount = 2) {
  const snapshots = makeSnapshots(snapCount);
  mockGetSnapshots.mockReturnValue(snapshots);
  mockReadSnapshotContent.mockResolvedValue("line 1\nline 2");
  mockDiffContent.mockReturnValue(mockDiffResult);

  return render(
    <VersionSnapshotDialog
      filePath="/test/file.md"
      currentContent="line 1\nline 2"
      onClose={vi.fn()}
      onApply={vi.fn()}
    />
  );
}

/**
 * 辅助：覆盖元素的 scrollTop 为可控的 get/set
 * jsdom 不计算布局，默认 scrollTop 始终为 0，需手动覆盖才能测试滚动联动
 * @returns [getValue, setValue] 用于读取/设置虚拟 scrollTop
 */
function mockScrollTop(el: HTMLElement): [() => number, (v: number) => void] {
  let val = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => val,
    set: (v: number) => {
      val = v;
    },
  });
  return [
    () => val,
    (v: number) => {
      val = v;
    },
  ];
}

// ─── 问题6：放大/缩小按钮 ──────────────────────────────────────
describe("v0.4.1 问题6：放大/缩小按钮", () => {
  it("初始未最大化，dialog 无 maximized class", () => {
    const { container } = renderWithDiff();
    const dialog = container.querySelector(".snapshot-dialog") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.classList.contains("maximized")).toBe(false);
  });

  it("点击放大按钮切换最大化，dialog 全屏样式生效", () => {
    const { container } = renderWithDiff();
    const dialog = container.querySelector(".snapshot-dialog") as HTMLElement;
    const maximizeBtn = container.querySelector(
      ".snapshot-maximize"
    ) as HTMLButtonElement;
    expect(maximizeBtn).toBeTruthy();

    fireEvent.click(maximizeBtn);

    // maximized class 添加
    expect(dialog.classList.contains("maximized")).toBe(true);
    // 内联样式覆盖为全屏
    expect(dialog.style.width).toBe("100vw");
    expect(dialog.style.height).toBe("100vh");
    expect(dialog.style.left).toBe("0px");
    expect(dialog.style.top).toBe("0px");
    expect(dialog.style.maxWidth).toBe("100vw");
    expect(dialog.style.maxHeight).toBe("100vh");
  });

  it("还原按钮（再次点击）maximized 切回 false", () => {
    const { container } = renderWithDiff();
    const dialog = container.querySelector(".snapshot-dialog") as HTMLElement;
    const maximizeBtn = container.querySelector(
      ".snapshot-maximize"
    ) as HTMLButtonElement;

    // 先最大化
    fireEvent.click(maximizeBtn);
    expect(dialog.classList.contains("maximized")).toBe(true);

    // 再点击还原
    fireEvent.click(maximizeBtn);
    expect(dialog.classList.contains("maximized")).toBe(false);
    // 还原后 width 不再是 100vw（回退到 CSS 默认 840px）
    expect(dialog.style.width).not.toBe("100vw");
    expect(dialog.style.height).not.toBe("100vh");
  });

  it("双击标题栏切换最大化", () => {
    const { container } = renderWithDiff();
    const dialog = container.querySelector(".snapshot-dialog") as HTMLElement;
    const header = container.querySelector(
      ".snapshot-header"
    ) as HTMLElement;

    fireEvent.doubleClick(header);
    expect(dialog.classList.contains("maximized")).toBe(true);

    fireEvent.doubleClick(header);
    expect(dialog.classList.contains("maximized")).toBe(false);
  });

  it("放大按钮 title 随状态切换（放大↔缩小）", () => {
    const { container } = renderWithDiff();
    const maximizeBtn = container.querySelector(
      ".snapshot-maximize"
    ) as HTMLButtonElement;

    // 未最大化时 title = "放大"
    expect(maximizeBtn.title).toBe("放大");

    // 最大化后 title = "缩小"
    fireEvent.click(maximizeBtn);
    expect(maximizeBtn.title).toBe("缩小");
  });

  it("最大化时拖拽禁用——mousedown + mousemove 不改变位置", () => {
    const { container } = renderWithDiff();
    const dialog = container.querySelector(".snapshot-dialog") as HTMLElement;
    const header = container.querySelector(
      ".snapshot-header"
    ) as HTMLElement;
    const maximizeBtn = container.querySelector(
      ".snapshot-maximize"
    ) as HTMLButtonElement;

    // 先最大化
    fireEvent.click(maximizeBtn);
    expect(dialog.style.left).toBe("0px");
    expect(dialog.style.top).toBe("0px");

    // 模拟拖拽：mousedown on header → mousemove on document
    fireEvent.mouseDown(header, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });

    // 最大化时位置不应改变
    expect(dialog.style.left).toBe("0px");
    expect(dialog.style.top).toBe("0px");
  });

  it("放大按钮 mousedown 不触发窗口拖拽（stopPropagation 生效）", () => {
    const { container } = renderWithDiff();
    const dialog = container.querySelector(".snapshot-dialog") as HTMLElement;
    const maximizeBtn = container.querySelector(
      ".snapshot-maximize"
    ) as HTMLButtonElement;

    // 记录初始位置
    const initialLeft = dialog.style.left;
    const initialTop = dialog.style.top;

    // mousedown on 放大按钮 → stopPropagation 阻止冒泡到 header
    fireEvent.mouseDown(maximizeBtn, { clientX: 100, clientY: 100, button: 0 });
    // mousemove on document
    fireEvent.mouseMove(document, { clientX: 400, clientY: 400 });

    // 位置不应改变（拖拽未被启动）
    expect(dialog.style.left).toBe(initialLeft);
    expect(dialog.style.top).toBe(initialTop);
  });
});

// ─── 问题7：左右栏滚动联动 ──────────────────────────────────────
describe("v0.4.1 问题7：左右栏滚动联动", () => {
  it("左栏滚动时右栏同步 scrollTop", async () => {
    const { container } = renderWithDiff();

    // 等待 diff 内容渲染完成（readSnapshotContent 是异步的）
    await waitFor(() => {
      expect(container.querySelector(".snapshot-diff-col.left")).toBeTruthy();
      expect(container.querySelector(".snapshot-diff-col.right")).toBeTruthy();
    });

    const leftCol = container.querySelector(
      ".snapshot-diff-col.left"
    ) as HTMLElement;
    const rightCol = container.querySelector(
      ".snapshot-diff-col.right"
    ) as HTMLElement;

    // 覆盖 scrollTop（jsdom 不计算布局，需手动模拟）
    const [getLeftTop, setLeftTop] = mockScrollTop(leftCol);
    const [getRightTop] = mockScrollTop(rightCol);

    // 模拟左栏滚动到 100
    setLeftTop(100);
    fireEvent.scroll(leftCol);

    // 右栏应同步到 100
    expect(getRightTop()).toBe(100);
  });

  it("右栏滚动时左栏同步 scrollTop", async () => {
    const { container } = renderWithDiff();

    await waitFor(() => {
      expect(container.querySelector(".snapshot-diff-col.left")).toBeTruthy();
      expect(container.querySelector(".snapshot-diff-col.right")).toBeTruthy();
    });

    const leftCol = container.querySelector(
      ".snapshot-diff-col.left"
    ) as HTMLElement;
    const rightCol = container.querySelector(
      ".snapshot-diff-col.right"
    ) as HTMLElement;

    const [getLeftTop] = mockScrollTop(leftCol);
    const [, setRightTop] = mockScrollTop(rightCol);

    // 模拟右栏滚动到 50
    setRightTop(50);
    fireEvent.scroll(rightCol);

    // 左栏应同步到 50
    expect(getLeftTop()).toBe(50);
  });

  it("切换快照时左右栏 scrollTop 重置为 0", async () => {
    const { container } = renderWithDiff(2);

    // 等待 diff 内容渲染
    await waitFor(() => {
      expect(container.querySelector(".snapshot-diff-col.left")).toBeTruthy();
      expect(container.querySelector(".snapshot-diff-col.right")).toBeTruthy();
    });

    const leftCol = container.querySelector(
      ".snapshot-diff-col.left"
    ) as HTMLElement;
    const rightCol = container.querySelector(
      ".snapshot-diff-col.right"
    ) as HTMLElement;

    const [getLeftTop, setLeftTop] = mockScrollTop(leftCol);
    const [getRightTop, setRightTop] = mockScrollTop(rightCol);

    // 模拟已滚动到非零位置
    setLeftTop(100);
    setRightTop(100);
    expect(getLeftTop()).toBe(100);
    expect(getRightTop()).toBe(100);

    // 点击第一个快照（index=0），触发 useEffect 重置滚动
    const items = container.querySelectorAll(".snapshot-item");
    expect(items.length).toBe(2);
    fireEvent.click(items[0]);

    // useEffect 执行后 scrollTop 应被重置为 0
    await waitFor(() => {
      expect(getLeftTop()).toBe(0);
      expect(getRightTop()).toBe(0);
    });
  });

  it("联动防循环：连续滚动不会死循环", async () => {
    const { container } = renderWithDiff();

    await waitFor(() => {
      expect(container.querySelector(".snapshot-diff-col.left")).toBeTruthy();
      expect(container.querySelector(".snapshot-diff-col.right")).toBeTruthy();
    });

    const leftCol = container.querySelector(
      ".snapshot-diff-col.left"
    ) as HTMLElement;
    const rightCol = container.querySelector(
      ".snapshot-diff-col.right"
    ) as HTMLElement;

    const [getLeftTop, setLeftTop] = mockScrollTop(leftCol);
    const [getRightTop] = mockScrollTop(rightCol);

    // 左栏滚动 → 右栏同步 → 不应反向触发左栏再同步
    setLeftTop(200);
    fireEvent.scroll(leftCol);

    expect(getRightTop()).toBe(200);
    // 左栏仍为 200（未被反向覆盖）
    expect(getLeftTop()).toBe(200);
  });
});
