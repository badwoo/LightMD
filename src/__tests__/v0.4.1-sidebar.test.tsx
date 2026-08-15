/**
 * v0.4.1 侧边栏增强 - 单元测试
 *
 * 覆盖：
 * 1. useResizable vertical 方向：mousedown→mousemove 触发 onChange(height)，delta 正→高度增加，钳制 min/max
 * 2. useResizable vertical：body cursor 设为 row-resize
 * 3. useResizable 向后兼容：left/right/split 逻辑不变
 * 4. Favorites 组件：渲染标题栏三个按钮，点击缩小折叠列表，点击关闭触发 onClose
 * 5. RecentFiles 组件：同上
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useResizable } from "../hooks/useResizable";
import { Favorites } from "../components/sidebar/Favorites";
import { RecentFiles } from "../components/sidebar/RecentFiles";
import { useFileStore } from "../stores/useFileStore";

// ─── mock localStorage（zustand persist 需要）────────────
const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  }),
};
Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  configurable: true,
  writable: true,
});

// ─── mock event 工具函数 ────────────────────────────

/** 构造 mock React.MouseEvent（含 clientY，用于 vertical 方向） */
function createMockEventV(clientY: number): React.MouseEvent {
  return {
    button: 0,
    clientX: 0,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: null as unknown as HTMLElement,
  } as unknown as React.MouseEvent;
}

/** 构造 mock React.MouseEvent（含 clientX，用于 left/right 方向；可选 currentTarget 用于 split） */
function createMockEventX(clientX: number, currentTarget?: HTMLElement): React.MouseEvent {
  return {
    button: 0,
    clientX,
    clientY: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: currentTarget ?? (null as unknown as HTMLElement),
  } as unknown as React.MouseEvent;
}

/** 构造 mock element，其 parentElement.getBoundingClientRect().width = containerWidth（用于 split 模式） */
function createMockElementWithParent(containerWidth: number): HTMLElement {
  const parent = {
    getBoundingClientRect: () => ({ width: containerWidth, left: 0, right: containerWidth, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
  } as unknown as HTMLElement;
  return { parentElement: parent } as unknown as HTMLElement;
}

/** 派发原生 mousemove 事件（含 clientY） */
function dispatchMouseMoveY(clientY: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientY }));
}

/** 派发原生 mousemove 事件（含 clientX） */
function dispatchMouseMoveX(clientX: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}

/** 派发原生 mouseup 事件 */
function dispatchMouseUp() {
  document.dispatchEvent(new MouseEvent("mouseup"));
}

// ─── 1. useResizable vertical 方向 ──────────────────────────────

describe("useResizable vertical 方向", () => {
  it("mousedown→mousemove 触发 onChange(height)，delta 正→高度减小（Issue 3 修复：方向取反）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        direction: "vertical",
        initialHeight: 200,
        minHeight: 80,
        maxHeight: 400,
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventV(100));
    });
    act(() => {
      dispatchMouseMoveY(150); // delta = +50（往下拖），Issue 3 修复后高度减小
    });

    expect(onChange).toHaveBeenCalledWith(150); // 200 - 50
  });

  it("高度钳制到 maxHeight（400）- 往上拖增大高度（Issue 3 修复）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        direction: "vertical",
        initialHeight: 200,
        minHeight: 80,
        maxHeight: 400,
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventV(100));
    });
    act(() => {
      dispatchMouseMoveY(-500); // delta = -600（往上拖），Issue 3 修复后高度增加：200-(-600)=800 → 钳制到 400
    });

    expect(onChange).toHaveBeenCalledWith(400);
  });

  it("高度钳制到 minHeight（80）- 往下拖减小高度（Issue 3 修复）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        direction: "vertical",
        initialHeight: 200,
        minHeight: 80,
        maxHeight: 400,
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventV(100));
    });
    act(() => {
      dispatchMouseMoveY(600); // delta = +500（往下拖），Issue 3 修复后高度减小：200-500=-300 → 钳制到 80
    });

    expect(onChange).toHaveBeenCalledWith(80);
  });

  it("拖拽中设置 body cursor 为 row-resize，结束时恢复", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        direction: "vertical",
        initialHeight: 200,
        minHeight: 80,
        maxHeight: 400,
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventV(100));
    });
    expect(document.body.style.cursor).toBe("row-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => {
      dispatchMouseUp();
    });
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("返回值包含 height 字段", () => {
    const { result } = renderHook(() =>
      useResizable({
        direction: "vertical",
        initialHeight: 150,
        minHeight: 80,
        maxHeight: 400,
      })
    );

    expect(result.current.height).toBe(150);
    expect(typeof result.current.onMouseDown).toBe("function");
  });

  it("mouseup 后停止监听，后续 mousemove 不再触发 onChange", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        direction: "vertical",
        initialHeight: 200,
        minHeight: 80,
        maxHeight: 400,
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventV(100));
    });
    act(() => {
      dispatchMouseMoveY(150);
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchMouseUp();
    });
    const callCountBefore = onChange.mock.calls.length;
    act(() => {
      dispatchMouseMoveY(200);
    });
    expect(onChange.mock.calls.length).toBe(callCountBefore);
  });
});

// ─── 2. useResizable 向后兼容（left/right/split 不变）──────────────

describe("useResizable 向后兼容（left/right/split 逻辑不变）", () => {
  it("left 方向：delta 正→宽度增加", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 260,
        minWidth: 180,
        maxWidth: 480,
        direction: "left",
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventX(100));
    });
    act(() => {
      dispatchMouseMoveX(150); // delta = +50
    });

    expect(onChange).toHaveBeenCalledWith(310); // 260 + 50
  });

  it("left 方向：宽度钳制到 maxWidth", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 260,
        minWidth: 180,
        maxWidth: 480,
        direction: "left",
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventX(100));
    });
    act(() => {
      dispatchMouseMoveX(600); // delta = +500
    });

    expect(onChange).toHaveBeenCalledWith(480);
  });

  it("right 方向：delta 正→宽度减少", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 240,
        minWidth: 180,
        maxWidth: 480,
        direction: "right",
        onChange,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventX(100));
    });
    act(() => {
      dispatchMouseMoveX(150); // delta = +50
    });

    expect(onChange).toHaveBeenCalledWith(190); // 240 - 50
  });

  it("split 方向：body cursor 为 col-resize（非 row-resize）", () => {
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 0,
        minWidth: 0,
        maxWidth: 0,
        direction: "split",
        initialRatio: 0.5,
      })
    );

    act(() => {
      result.current.onMouseDown(createMockEventX(100, createMockElementWithParent(1000)));
    });
    expect(document.body.style.cursor).toBe("col-resize");

    act(() => {
      dispatchMouseUp();
    });
  });
});

// ─── 3. Favorites 组件 ──────────────────────────────────────

describe("Favorites 组件 v0.4.1", () => {
  beforeEach(() => {
    cleanup();
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
      tempFiles: [],
    });
  });

  it("渲染标题栏三个控制按钮（缩小/放大/关闭）", () => {
    useFileStore.setState({
      favorites: [{ path: "/test/a.md", name: "a.md", addedAt: Date.now() }],
    });

    render(<Favorites onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByTitle("缩小")).toBeTruthy();
    expect(screen.getByTitle("放大")).toBeTruthy();
    expect(screen.getByTitle("关闭")).toBeTruthy();
  });

  it("点击缩小按钮折叠列表（文件项消失）", () => {
    useFileStore.setState({
      favorites: [{ path: "/test/a.md", name: "a.md", addedAt: Date.now() }],
    });

    render(<Favorites onOpen={vi.fn()} onClose={vi.fn()} />);

    // 折叠前文件名可见
    expect(screen.getByText("a.md")).toBeTruthy();

    // 点击缩小按钮
    fireEvent.click(screen.getByTitle("缩小"));

    // 折叠后文件名消失
    expect(screen.queryByText("a.md")).toBeNull();
  });

  it("点击关闭按钮触发 onClose 回调", () => {
    const onClose = vi.fn();
    render(<Favorites onOpen={vi.fn()} onClose={onClose} />);

    fireEvent.click(screen.getByTitle("关闭"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("未传 onClose 时不渲染关闭按钮", () => {
    useFileStore.setState({
      favorites: [{ path: "/test/a.md", name: "a.md", addedAt: Date.now() }],
    });

    render(<Favorites onOpen={vi.fn()} />);

    expect(screen.queryByTitle("关闭")).toBeNull();
    // 缩小/放大按钮仍存在
    expect(screen.getByTitle("缩小")).toBeTruthy();
    expect(screen.getByTitle("放大")).toBeTruthy();
  });

  it("点击放大按钮展开（文件项仍可见，非折叠态）", () => {
    useFileStore.setState({
      favorites: [{ path: "/test/a.md", name: "a.md", addedAt: Date.now() }],
    });

    render(<Favorites onOpen={vi.fn()} onClose={vi.fn()} />);

    // 点击放大按钮
    fireEvent.click(screen.getByTitle("放大"));

    // 文件项仍可见（放大不折叠）
    expect(screen.getByText("a.md")).toBeTruthy();
  });
});

// ─── 4. RecentFiles 组件 ──────────────────────────────────────

describe("RecentFiles 组件 v0.4.1", () => {
  beforeEach(() => {
    cleanup();
    useFileStore.setState({
      favorites: [],
      recentFiles: [],
      tempFiles: [],
    });
  });

  it("渲染标题栏三个控制按钮（缩小/放大/关闭）", () => {
    useFileStore.setState({
      recentFiles: [{ path: "/test/b.md", name: "b.md", accessedAt: Date.now() }],
    });

    render(<RecentFiles onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByTitle("缩小")).toBeTruthy();
    expect(screen.getByTitle("放大")).toBeTruthy();
    expect(screen.getByTitle("关闭")).toBeTruthy();
  });

  it("点击缩小按钮折叠列表（文件项消失）", () => {
    useFileStore.setState({
      recentFiles: [{ path: "/test/b.md", name: "b.md", accessedAt: Date.now() }],
    });

    render(<RecentFiles onOpen={vi.fn()} onClose={vi.fn()} />);

    // 折叠前文件名可见
    expect(screen.getByText("b.md")).toBeTruthy();

    // 点击缩小按钮
    fireEvent.click(screen.getByTitle("缩小"));

    // 折叠后文件名消失
    expect(screen.queryByText("b.md")).toBeNull();
  });

  it("点击关闭按钮触发 onClose 回调", () => {
    const onClose = vi.fn();
    useFileStore.setState({
      recentFiles: [{ path: "/test/b.md", name: "b.md", accessedAt: Date.now() }],
    });

    render(<RecentFiles onOpen={vi.fn()} onClose={onClose} />);

    fireEvent.click(screen.getByTitle("关闭"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("空状态返回 null（不渲染）", () => {
    const { container } = render(<RecentFiles onOpen={vi.fn()} onClose={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });
});
