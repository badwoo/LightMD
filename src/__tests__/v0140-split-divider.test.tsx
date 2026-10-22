/**
 * v0.14.0 需求3 —— 分屏分割线拖拽回归测试（行为级）
 *
 * 背景（缺陷）：用户实机反馈「分屏的分割线往左拖能调整大小，往右拖拖不回来」。
 * 实机 CDP 探针（scripts/v0140-probe-split-divider.mjs）取证结论：
 *   分割条右侧紧贴 `iframe.split-preview`，往右拖时指针进入 iframe，
 *   父文档的 mousemove/mouseup 全部丢失（左拖 6 次移动收到 6 次；右拖 6 次移动收到 0 次）
 *   → 拖拽链路中断、比例冻结。
 *
 * 本文件覆盖修复后的**可观测行为**：
 *   1. 同一实例两次独立手势：左拖使 ratio 变小 → 松手 → 右拖使 ratio 变大；
 *   2. 拖到 min(0.3) 边界后反向拖「立即」增大（无死区：一步就动）；
 *   3. 外部 store 值（rerender 新 initialRatio）变化后内部 ratio 同步，
 *      但拖拽进行中不被覆盖；
 *   4. 拖拽的起点比例以最新外部值为准（旧实现的 `initialRatio` 只在挂载时读一次，
 *      第二次拖拽会从**旧起点**开始，表现为「要拖过一段才动」）；
 *   5. iframe 兜底：拖拽开始时 iframe 的指针事件被屏蔽、结束时恢复原值；
 *   6. `direction: "left"/"right"` 老行为不变（对照 v0.4.0-resizer.test.ts 的语义）；
 *   7. v0.8.2 的「失焦 / buttons===0」兜底语义保留。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { renderHook, act } from "@testing-library/react";
import { useResizable } from "../hooks/useResizable";

// ─── 工具：模拟分割条元素（jsdom 的 getBoundingClientRect 恒为 0，必须打桩）───

/** 构造一个带指定父容器宽度的 pointerdown 目标元素（挂到真实 DOM 上） */
function makeDivider(containerWidth: number): HTMLElement {
  const parent = document.createElement("div");
  const divider = document.createElement("div");
  parent.appendChild(divider);
  document.body.appendChild(parent);
  // jsdom 不做布局：容器宽度必须打桩，否则 delta/containerWidth 无从计算
  Object.defineProperty(parent, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: containerWidth, height: 600, left: 0, right: containerWidth, top: 0, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }),
  });
  return divider;
}

/** 构造 mock React.MouseEvent（用于触发 hook 的 onMouseDown） */
function makeDownEvent(clientX: number, currentTarget: HTMLElement | null): React.MouseEvent {
  return {
    button: 0,
    clientX,
    clientY: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget,
  } as unknown as React.MouseEvent;
}

/**
 * 派发原生 mousemove。
 * 注意 jsdom 的 MouseEvent 必须显式给 `buttons: 1` —— hook 里 v0.8.2 的兜底逻辑
 * 会把 `buttons === 0` 当作「按键已松开 → 结束拖拽」。
 */
function moveTo(clientX: number): void {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY: 0, buttons: 1, bubbles: true }));
}

/** 派发原生 mousemove（显式表示按键已松开） */
function moveWithoutButton(clientX: number): void {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY: 0, buttons: 0, bubbles: true }));
}

function mouseUp(): void {
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

/** 清理 DOM 里为测试生成的分割条 */
function cleanupDom(): void {
  document.body.innerHTML = "";
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.body.classList.remove("split-resizing");
  document.documentElement.removeAttribute("data-split-resizing");
}

/**
 * split hook 的渲染上下文 —— **严格镜像 EditorContainer 的真实接线**：
 *   ```
 *   const splitRatio = useSettingsStore(s => s.splitRatio);          // 外部值
 *   useResizable({ initialRatio: splitRatio, onSplitChange: r => setSplitRatio(r) });
 *   ```
 * 所以这里用一个 useState 充当 store：onSplitChange 写回，initialRatio 从它读。
 * 这样「第二次拖拽是否从最新值起算」才和实机一致。
 */
function renderSplit(initialRatio: number, containerWidth = 1000) {
  const changes: number[] = [];
  const hook = renderHook(() => {
    const [storeRatio, setStoreRatio] = useState(initialRatio);
    const r = useResizable({
      direction: "split",
      initialRatio: storeRatio,
      onSplitChange: (v) => {
        changes.push(v);
        setStoreRatio(v);
      },
    });
    return { ...r, storeRatio, setStoreRatio };
  });
  const divider = makeDivider(containerWidth);
  return { hook, divider, changes };
}

// ─── 0. 每个用例前后清场 ─────────────────────────────
beforeEach(() => {
  cleanupDom();
});
afterEach(() => {
  cleanupDom();
});

// ═══ 1. 核心缺陷：左拖 → 松手 → 右拖（同一实例两次独立手势）═══

describe("v0.14.0 需求3：分屏分割线「左拖变小 → 松手 → 右拖变大」", () => {
  it("两次独立手势都要生效（回归：右拖不得冻住）", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    // ── 手势 1：往左拖 200px → ratio 0.5 - 0.2 = 0.3 ──
    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(300));
    expect(changes[changes.length - 1]).toBeCloseTo(0.3, 5);
    expect(result.current.ratio).toBeCloseTo(0.3, 5);
    act(() => mouseUp());
    expect(result.current.isDragging).toBe(false);

    // ── 手势 2：往右拖 200px → ratio 0.3 + 0.2 = 0.5（必须能拖回来）──
    act(() => result.current.onMouseDown(makeDownEvent(300, divider)));
    act(() => moveTo(500));
    expect(changes[changes.length - 1]).toBeCloseTo(0.5, 5);
    expect(result.current.ratio).toBeCloseTo(0.5, 5);
    act(() => mouseUp());
  });

  it("连续多次左右来回拖拽，每一次都从「当前比例」起算（不累积漂移）", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    const dragBy = (deltaX: number) => {
      const startX = 500;
      act(() => result.current.onMouseDown(makeDownEvent(startX, divider)));
      act(() => moveTo(startX + deltaX));
      act(() => mouseUp());
      return changes[changes.length - 1] as number;
    };

    expect(dragBy(-100)).toBeCloseTo(0.4, 5); // 0.5 - 0.1
    expect(dragBy(100)).toBeCloseTo(0.5, 5); // 0.4 + 0.1
    expect(dragBy(150)).toBeCloseTo(0.65, 5); // 0.5 + 0.15
    expect(dragBy(-150)).toBeCloseTo(0.5, 5); // 0.65 - 0.15
  });
});

// ═══ 2. 边界后反向：无死区，一步即响应 ═══

describe("v0.14.0 需求3：拖到边界后反向拖立即响应（无死区）", () => {
  it("拖到 min(0.3) 后，往右拖 10px 就应立即增大（不是先拖过一段再动）", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    // 手势 1：一把拖过下限（delta -500 → 0.5-0.5=-0.0 → 钳制 0.3）
    act(() => result.current.onMouseDown(makeDownEvent(600, divider)));
    act(() => moveTo(100));
    expect(changes[changes.length - 1]).toBe(0.3);
    act(() => mouseUp());

    // 手势 2：反向只拖 10px → 0.3 + 0.01 = 0.31（严格大于 0.3，说明无死区）
    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(510));
    expect(changes[changes.length - 1] as number).toBeGreaterThan(0.3);
    expect(changes[changes.length - 1]).toBeCloseTo(0.31, 5);
    act(() => mouseUp());
  });

  it("拖到 max(0.7) 后，往左拖 10px 就应立即减小", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    act(() => result.current.onMouseDown(makeDownEvent(100, divider)));
    act(() => moveTo(900)); // 0.5 + 0.8 → 钳制 0.7
    expect(changes[changes.length - 1]).toBe(0.7);
    act(() => mouseUp());

    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(490));
    expect(changes[changes.length - 1] as number).toBeLessThan(0.7);
    expect(changes[changes.length - 1]).toBeCloseTo(0.69, 5);
    act(() => mouseUp());
  });

  it("边界值本身不会被「下一次拖拽」的起点带偏（起点恒为合法区间 + 与屏幕一致）", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    // 拖到下限
    act(() => result.current.onMouseDown(makeDownEvent(600, divider)));
    act(() => moveTo(0));
    act(() => mouseUp());
    expect(changes[changes.length - 1]).toBe(0.3);

    // 第二次按下后原地不动（delta=0）→ 计算出的比例必须仍是 0.3
    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(500));
    expect(changes[changes.length - 1]).toBeCloseTo(0.3, 5);
    act(() => mouseUp());
  });
});

// ═══ 3. 外部 store 值同步（拖拽中不覆盖）═══

describe("v0.14.0 需求3：外部 initialRatio 变化时同步内部 ratio", () => {
  it("非拖拽时外部值被改动（如「重置布局」）→ hook.ratio 跟随", () => {
    const { hook } = renderSplit(0.5, 1000);
    const { result } = hook;

    expect(result.current.ratio).toBe(0.5);
    act(() => result.current.setStoreRatio(0.62));
    expect(result.current.ratio).toBeCloseTo(0.62, 5);
    act(() => result.current.setStoreRatio(0.35));
    expect(result.current.ratio).toBeCloseTo(0.35, 5);
  });

  it("拖拽进行中外部值变化 → 内部实时值不被覆盖（防跟手抖动）", () => {
    const { hook, divider } = renderSplit(0.5, 1000);
    const { result } = hook;

    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(560)); // 0.5 + 0.06 = 0.56
    expect(result.current.ratio).toBeCloseTo(0.56, 5);

    // 拖拽途中外部值被强行写成 0.9 → 不能覆盖正在跟手的 0.56
    act(() => result.current.setStoreRatio(0.9));
    expect(result.current.ratio).toBeCloseTo(0.56, 5);

    // 继续拖，仍从**本次手势起点 0.5** 连续计算（若被覆盖成 0.9 这里会是 0.99→0.7）
    act(() => moveTo(600)); // 0.5 + 0.1 = 0.6
    expect(result.current.ratio).toBeCloseTo(0.6, 5);
    act(() => mouseUp());
  });

  it("第二次拖拽的起点以「外部最新值」为准（旧实现用滞后内部 state → 要拖一段才动）", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    // 手势 1：拖到 0.3
    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(300));
    act(() => mouseUp());
    expect(changes[changes.length - 1]).toBeCloseTo(0.3, 5);

    // 外部把比例改成 0.6（例如用户点了「重置布局」/ 另一个入口改了 store）
    act(() => result.current.setStoreRatio(0.6));
    expect(result.current.ratio).toBeCloseTo(0.6, 5);

    // 手势 2：按下后原地不动 → 起点必须是 0.6，而不是 0.3
    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(500));
    expect(changes[changes.length - 1]).toBeCloseTo(0.6, 5);
    // 再往右 100px → 0.6 + 0.1 = 0.7（如果起点是 0.3 这里会是 0.4）
    act(() => moveTo(600));
    expect(changes[changes.length - 1]).toBeCloseTo(0.7, 5);
    act(() => mouseUp());
  });
});

// ═══ 4. iframe 兜底：拖拽期间屏蔽嵌入元素指针事件 ═══

describe("v0.14.0 需求3：拖拽期间屏蔽 iframe 指针事件（根因兜底）", () => {
  it("拖拽开始 → iframe 的 pointer-events 变 none；结束 → 恢复原值", () => {
    const { hook, divider } = renderSplit(0.5, 1000);
    const { result } = hook;

    const iframe = document.createElement("iframe");
    iframe.className = "split-preview";
    iframe.style.pointerEvents = "auto"; // 模拟"原本有内联值"
    document.body.appendChild(iframe);
    const other = document.createElement("iframe");
    document.body.appendChild(other); // 原本没有内联值

    expect(iframe.style.pointerEvents).toBe("auto");

    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    expect(iframe.style.pointerEvents).toBe("none");
    expect(other.style.pointerEvents).toBe("none");
    // 兜底样式表也生效（覆盖拖拽期间新挂载的 iframe）
    expect(document.documentElement.getAttribute("data-split-resizing")).toBe("1");
    expect(document.getElementById("lightmd-split-resizing-style")).not.toBeNull();
    // body 类名（供 CSS 可选配合）
    expect(document.body.classList.contains("split-resizing")).toBe(true);

    act(() => mouseUp());
    expect(iframe.style.pointerEvents).toBe("auto"); // 原值恢复，不是被清成 ""
    expect(other.style.pointerEvents).toBe("");
    expect(document.documentElement.getAttribute("data-split-resizing")).toBeNull();
    expect(document.body.classList.contains("split-resizing")).toBe(false);
  });

  it("拖拽中指针进入 iframe（父文档收不到 mousemove）后松手不卡死：pointerup 能收尾", () => {
    const { hook, divider } = renderSplit(0.5, 1000);
    const { result } = hook;
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);

    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    act(() => moveTo(400)); // 0.4
    expect(result.current.ratio).toBeCloseTo(0.4, 5);

    // 模拟真实的「事件丢失」：此后父文档**一个 mousemove 都收不到**，
    // 唯一的救命通道是 pointerup / blur / buttons===0 兜底。
    // 这里验证 pointerup 通道确实能收尾，把拖拽态清干净。
    act(() => document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, buttons: 0 })));
    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.classList.contains("split-resizing")).toBe(false);
    expect(iframe.style.pointerEvents).toBe("");

    // 收尾后残留监听器不得再改写比例
    const frozen = result.current.ratio;
    act(() => moveTo(900));
    expect(result.current.ratio).toBe(frozen);
  });

  it("pointer 通道优先：一次物理移动不会回调两次（pointermove + 兼容 mousemove 去重）", () => {
    const { hook, divider, changes } = renderSplit(0.5, 1000);
    const { result } = hook;

    act(() => result.current.onMouseDown(makeDownEvent(500, divider)));
    const before = changes.length;
    // 同一次物理移动：先 pointermove，后兼容 mousemove（Chromium 的真实派发顺序）
    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 550, clientY: 0, buttons: 1 }));
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 550, clientY: 0, buttons: 1 }));
    });
    expect(changes.length - before).toBe(1);
    expect(changes[changes.length - 1]).toBeCloseTo(0.55, 5);
    act(() => mouseUp());
  });
});

// ═══ 5. 老方向行为不变（left / right，对照 v0.4.0-resizer.test.ts）═══

describe("v0.14.0 需求3：direction=left/right 老行为回归", () => {
  it("left 方向：delta 正→宽度增加（260 + 50 = 310）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 260, minWidth: 180, maxWidth: 480, direction: "left", onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    act(() => moveTo(150));
    expect(onChange).toHaveBeenCalledWith(310);
  });

  it("left 方向：宽度钳制到 maxWidth（480）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 260, minWidth: 180, maxWidth: 480, direction: "left", onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    act(() => moveTo(600)); // delta +500，260+500=760 → 钳制 480
    expect(onChange).toHaveBeenLastCalledWith(480);
    act(() => mouseUp());
  });

  it("left 方向：宽度钳制到 minWidth（180）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 260, minWidth: 180, maxWidth: 480, direction: "left", onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    act(() => moveTo(0)); // delta -100，260-100=160 → 钳制 180
    expect(onChange).toHaveBeenLastCalledWith(180);
    act(() => mouseUp());
  });

  it("right 方向：delta 正→宽度减少（240 - 50 = 190）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 240, minWidth: 180, maxWidth: 480, direction: "right", onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    act(() => moveTo(150));
    expect(onChange).toHaveBeenLastCalledWith(190);
    act(() => mouseUp());
  });

  it("right 方向：delta 负→宽度增加（240 + 50 = 290）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 240, minWidth: 180, maxWidth: 480, direction: "right", onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    act(() => moveTo(50));
    expect(onChange).toHaveBeenLastCalledWith(290);
    act(() => mouseUp());
  });

  it("left/right 也会写 body 光标，且结束恢复（既有可视反馈不变）", () => {
    const { result } = renderHook(() => useResizable({ initialWidth: 260, direction: "left" }));
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    act(() => mouseUp());
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("vertical 方向：delta 正→高度减小（200 - 50 = 150），光标 row-resize", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ direction: "vertical", initialHeight: 200, minHeight: 80, maxHeight: 400, onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(0, null)));
    expect(document.body.style.cursor).toBe("row-resize");
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 50, buttons: 1, bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(150);
    act(() => mouseUp());
  });
});

// ═══ 6. v0.8.2 兜底语义保留 ═══

describe("v0.14.0 需求3：v0.8.2 兜底语义保留（不回归）", () => {
  it("mousemove 检测到 buttons===0 → 结束拖拽，宽度不再变化", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ direction: "left", initialWidth: 200, minWidth: 100, maxWidth: 480, onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(0, null)));
    act(() => moveTo(50));
    expect(onChange).toHaveBeenLastCalledWith(250);

    act(() => moveWithoutButton(100));
    expect(result.current.isDragging).toBe(false);

    const frozen = onChange.mock.calls.length;
    act(() => moveTo(200));
    expect(onChange.mock.calls.length).toBe(frozen);
  });

  it("窗口 blur → 结束拖拽（mouseup 丢失兜底）", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ direction: "left", initialWidth: 200, minWidth: 100, maxWidth: 480, onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(0, null)));
    act(() => window.dispatchEvent(new Event("blur")));
    expect(result.current.isDragging).toBe(false);
    act(() => moveTo(200));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mouseup 后停止监听，后续 mousemove 不再触发 onChange", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() =>
      useResizable({ initialWidth: 260, minWidth: 180, maxWidth: 480, direction: "left", onChange }),
    );
    act(() => result.current.onMouseDown(makeDownEvent(100, null)));
    act(() => moveTo(150));
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => mouseUp());
    act(() => moveTo(200));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
