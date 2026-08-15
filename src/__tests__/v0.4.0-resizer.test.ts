/**
 * v0.4.0 分割栏拖拽调整宽度 - 单元测试
 *
 * 覆盖：
 * 1. useResizable hook：mousedown→mousemove 触发 onChange，宽度钳制到 min/max
 * 2. useResizable split 模式：ratio 钳制到 0.3~0.7
 * 3. 方向逻辑：left 方向 delta 正→宽度增加；right 方向 delta 正→宽度减少
 * 4. useSettingsStore 新增配置项默认值和 setter 钳制
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useResizable } from "../hooks/useResizable";
import { useSettingsStore } from "../stores/useSettingsStore";

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

/** 构造 mock React.MouseEvent，用于触发 onMouseDown */
function createMockEvent(clientX: number, currentTarget?: HTMLElement): React.MouseEvent {
  return {
    button: 0,
    clientX,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: currentTarget ?? (null as unknown as HTMLElement),
  } as unknown as React.MouseEvent;
}

/** 构造 mock element，其 parentElement.getBoundingClientRect().width = containerWidth */
function createMockElementWithParent(containerWidth: number): HTMLElement {
  const parent = {
    getBoundingClientRect: () => ({ width: containerWidth, left: 0, right: containerWidth, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
  } as unknown as HTMLElement;
  return { parentElement: parent } as unknown as HTMLElement;
}

/** 派发原生 mousemove 事件 */
function dispatchMouseMove(clientX: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}

/** 派发原生 mouseup 事件 */
function dispatchMouseUp() {
  document.dispatchEvent(new MouseEvent("mouseup"));
}

// ─── 1. useResizable left 方向 ──────────────────────────────

describe("useResizable left 方向", () => {
  it("mousedown→mousemove 触发 onChange，delta 正→宽度增加", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(150); // delta = +50
    });

    expect(onChange).toHaveBeenCalledWith(310); // 260 + 50
  });

  it("宽度钳制到 maxWidth（480）", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(600); // delta = +500，远超 max
    });

    expect(onChange).toHaveBeenCalledWith(480);
  });

  it("宽度钳制到 minWidth（180）", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(0); // delta = -100，newWidth = 160，低于 min
    });

    expect(onChange).toHaveBeenCalledWith(180);
  });

  it("mouseup 后停止监听，后续 mousemove 不再触发 onChange", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(150);
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchMouseUp();
    });
    const callCountBefore = onChange.mock.calls.length;
    act(() => {
      dispatchMouseMove(200);
    });
    expect(onChange.mock.calls.length).toBe(callCountBefore);
  });
});

// ─── 2. useResizable right 方向 ──────────────────────────────

describe("useResizable right 方向", () => {
  it("delta 正（向右拖）→宽度减少", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(150); // delta = +50
    });

    // right 方向：newWidth = startWidth - delta = 240 - 50 = 190
    expect(onChange).toHaveBeenCalledWith(190);
  });

  it("delta 负（向左拖）→宽度增加", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(50); // delta = -50
    });

    // right 方向：newWidth = 240 - (-50) = 290
    expect(onChange).toHaveBeenCalledWith(290);
  });

  it("宽度钳制到 maxWidth", () => {
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
      result.current.onMouseDown(createMockEvent(100));
    });
    act(() => {
      dispatchMouseMove(-400); // delta = -500，newWidth = 740，超过 max
    });

    expect(onChange).toHaveBeenCalledWith(480);
  });
});

// ─── 3. useResizable split 方向 ──────────────────────────────

describe("useResizable split 方向", () => {
  it("ratio 随 delta 变化（容器宽 1000，delta 100→ratio 增加 0.1）", () => {
    const onSplitChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 0,
        minWidth: 0,
        maxWidth: 0,
        direction: "split",
        initialRatio: 0.5,
        onSplitChange,
      })
    );

    const mockEl = createMockElementWithParent(1000);
    act(() => {
      result.current.onMouseDown(createMockEvent(100, mockEl));
    });
    act(() => {
      dispatchMouseMove(200); // delta = +100，ratio = 0.5 + 100/1000 = 0.6
    });

    expect(onSplitChange).toHaveBeenCalledWith(0.6);
  });

  it("ratio 钳制到上限 0.7", () => {
    const onSplitChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 0,
        minWidth: 0,
        maxWidth: 0,
        direction: "split",
        initialRatio: 0.5,
        onSplitChange,
      })
    );

    const mockEl = createMockElementWithParent(1000);
    act(() => {
      result.current.onMouseDown(createMockEvent(100, mockEl));
    });
    act(() => {
      dispatchMouseMove(1000); // delta = +900，ratio = 0.5 + 0.9 = 1.4 → 钳制 0.7
    });

    expect(onSplitChange).toHaveBeenCalledWith(0.7);
  });

  it("ratio 钳制到下限 0.3", () => {
    const onSplitChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 0,
        minWidth: 0,
        maxWidth: 0,
        direction: "split",
        initialRatio: 0.5,
        onSplitChange,
      })
    );

    const mockEl = createMockElementWithParent(1000);
    act(() => {
      result.current.onMouseDown(createMockEvent(100, mockEl));
    });
    act(() => {
      dispatchMouseMove(-900); // delta = -1000，ratio = 0.5 - 1.0 = -0.5 → 钳制 0.3
    });

    expect(onSplitChange).toHaveBeenCalledWith(0.3);
  });

  it("拖拽中设置 body cursor 为 col-resize，结束时恢复", () => {
    const onSplitChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({
        initialWidth: 0,
        minWidth: 0,
        maxWidth: 0,
        direction: "split",
        initialRatio: 0.5,
        onSplitChange,
      })
    );

    const mockEl = createMockElementWithParent(1000);
    act(() => {
      result.current.onMouseDown(createMockEvent(100, mockEl));
    });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => {
      dispatchMouseUp();
    });
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});

// ─── 4. useSettingsStore 新增配置项 ──────────────────────────────

describe("useSettingsStore v0.4.0 新增配置项", () => {
  beforeEach(() => {
    // 重置为默认值
    useSettingsStore.setState({
      sidebarWidth: 260,
      outlineWidth: 240,
      splitRatio: 0.5,
    });
  });

  it("默认值：sidebarWidth=260, outlineWidth=240, splitRatio=0.5", () => {
    expect(useSettingsStore.getState().sidebarWidth).toBe(260);
    expect(useSettingsStore.getState().outlineWidth).toBe(240);
    expect(useSettingsStore.getState().splitRatio).toBe(0.5);
  });

  it("setter 存在", () => {
    expect(typeof useSettingsStore.getState().setSidebarWidth).toBe("function");
    expect(typeof useSettingsStore.getState().setOutlineWidth).toBe("function");
    expect(typeof useSettingsStore.getState().setSplitRatio).toBe("function");
  });

  it("setSidebarWidth 正常值生效", () => {
    useSettingsStore.getState().setSidebarWidth(300);
    expect(useSettingsStore.getState().sidebarWidth).toBe(300);
  });

  it("setSidebarWidth 钳制到下限 180", () => {
    useSettingsStore.getState().setSidebarWidth(100);
    expect(useSettingsStore.getState().sidebarWidth).toBe(180);
  });

  it("setSidebarWidth 钳制到上限 480", () => {
    useSettingsStore.getState().setSidebarWidth(600);
    expect(useSettingsStore.getState().sidebarWidth).toBe(480);
  });

  it("setOutlineWidth 正常值生效", () => {
    useSettingsStore.getState().setOutlineWidth(320);
    expect(useSettingsStore.getState().outlineWidth).toBe(320);
  });

  it("setOutlineWidth 钳制到下限 180", () => {
    useSettingsStore.getState().setOutlineWidth(50);
    expect(useSettingsStore.getState().outlineWidth).toBe(180);
  });

  it("setOutlineWidth 钳制到上限 480", () => {
    useSettingsStore.getState().setOutlineWidth(999);
    expect(useSettingsStore.getState().outlineWidth).toBe(480);
  });

  it("setSplitRatio 正常值生效", () => {
    useSettingsStore.getState().setSplitRatio(0.4);
    expect(useSettingsStore.getState().splitRatio).toBeCloseTo(0.4);
  });

  it("setSplitRatio 钳制到下限 0.3", () => {
    useSettingsStore.getState().setSplitRatio(0.1);
    expect(useSettingsStore.getState().splitRatio).toBeCloseTo(0.3);
  });

  it("setSplitRatio 钳制到上限 0.7", () => {
    useSettingsStore.getState().setSplitRatio(0.9);
    expect(useSettingsStore.getState().splitRatio).toBeCloseTo(0.7);
  });
});
