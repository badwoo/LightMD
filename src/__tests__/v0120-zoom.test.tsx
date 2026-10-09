/**
 * v0.12.0 需求5：文档整体缩放测试
 *
 * 覆盖：
 * 1. store：setDocZoom 钳制 50~200、adjustDocZoom 步进与边界
 * 2. 持久化：docZoom 写入 localStorage（persist 全量 + merge 防御）
 * 3. ZoomRuler 组件：百分比显示、range 边界/步进、onChange 回调
 * 4. 源码落点断言：阅读 .ProseMirror zoom、textarea 字号 calc、iframe body zoom
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useSettingsStore, DOC_ZOOM_MIN, DOC_ZOOM_MAX, DOC_ZOOM_STEP } from "../stores/useSettingsStore";
import { ZoomRuler } from "../components/editor/ZoomRuler";

// jsdom 环境下 import.meta.url 解析异常，改用进程 cwd（vitest 以项目根运行）相对路径
const readSrc = (p: string) => readFileSync(`src/${p}`, "utf-8");

afterEach(cleanup);

beforeEach(() => {
  useSettingsStore.getState().setDocZoom(100);
});

describe("v0.12.0 需求5：docZoom store", () => {
  it("setDocZoom：钳制 50~200（整数）", () => {
    useSettingsStore.getState().setDocZoom(150);
    expect(useSettingsStore.getState().docZoom).toBe(150);
    useSettingsStore.getState().setDocZoom(30);
    expect(useSettingsStore.getState().docZoom).toBe(DOC_ZOOM_MIN);
    useSettingsStore.getState().setDocZoom(250);
    expect(useSettingsStore.getState().docZoom).toBe(DOC_ZOOM_MAX);
    useSettingsStore.getState().setDocZoom(120.6);
    expect(useSettingsStore.getState().docZoom).toBe(121);
  });

  it("adjustDocZoom：±5 步进；到边界继续滚动无反应不报错", () => {
    useSettingsStore.getState().adjustDocZoom(DOC_ZOOM_STEP);
    expect(useSettingsStore.getState().docZoom).toBe(105);
    useSettingsStore.getState().adjustDocZoom(-DOC_ZOOM_STEP);
    expect(useSettingsStore.getState().docZoom).toBe(100);
    // 到上边界继续放大 → 保持 200
    useSettingsStore.getState().setDocZoom(200);
    useSettingsStore.getState().adjustDocZoom(DOC_ZOOM_STEP);
    expect(useSettingsStore.getState().docZoom).toBe(200);
    // 到下边界继续缩小 → 保持 50
    useSettingsStore.getState().setDocZoom(50);
    useSettingsStore.getState().adjustDocZoom(-DOC_ZOOM_STEP);
    expect(useSettingsStore.getState().docZoom).toBe(50);
  });

  it("持久化：docZoom 写入 localStorage（重启保持）", () => {
    useSettingsStore.getState().setDocZoom(175);
    const raw = localStorage.getItem("lightmd-settings") || "";
    expect(raw).toContain('"docZoom":175');
  });

  it("merge 防御：非法持久化值回默认而非钳到边界（源码断言）", () => {
    const src = readSrc("stores/useSettingsStore.ts");
    expect(src).toContain("Number.isFinite(p.docZoom) ? p.docZoom : current.docZoom");
    expect(src).toContain("docZoom: clamp(Math.round(rawZoom), DOC_ZOOM_MIN, DOC_ZOOM_MAX)");
  });
});

describe("v0.12.0 需求5：ZoomRuler 组件（返修：100% 居中 + 气泡 + 淡百分比）", () => {
  it("100% 位于滑条正中间（分段线性映射：50~100 占下半、100~200 占上半）", () => {
    render(<ZoomRuler value={100} onChange={() => {}} />);
    const range = screen.getByRole("slider") as HTMLInputElement;
    // 内部滑条用线性"位置值" 0~1000，100% → 500（正中）
    expect(range.min).toBe("0");
    expect(range.max).toBe("1000");
    expect(range.value).toBe("500");
  });

  it("滑块位置随百分比非线性分布：75% → 250、150% → 750、200% → 1000", () => {
    const cases: Array<[number, string]> = [[75, "250"], [150, "750"], [200, "1000"], [50, "0"]];
    for (const [value, pos] of cases) {
      const { unmount } = render(<ZoomRuler value={value} onChange={() => {}} />);
      const range = screen.getByRole("slider") as HTMLInputElement;
      expect(range.value, `value=${value}`).toBe(pos);
      unmount();
    }
  });

  it("拖动/点击刻度触发 onChange（位置值 → 真实缩放，按步进取整）", () => {
    const onChange = vi.fn();
    render(<ZoomRuler value={100} onChange={onChange} />);
    // 位置 875 → 100 + (875-500)/500*100 = 175
    fireEvent.change(screen.getByRole("slider"), { target: { value: "875" } });
    expect(onChange).toHaveBeenCalledWith(175);
    // 位置 260 → 50 + 260/500*50 = 76 → 按步进取整为 75
    fireEvent.change(screen.getByRole("slider"), { target: { value: "260" } });
    expect(onChange).toHaveBeenLastCalledWith(75);
  });

  it("调整中显示气泡；停止后显示淡百分比；100% 停止后两者都不显示", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ZoomRuler value={125} onChange={() => {}} />);
      // 挂载即"调整中" → 气泡可见、淡百分比不可见
      expect(screen.getByTestId("zoom-ruler-bubble").textContent).toBe("125%");
      expect(screen.queryByTestId("zoom-ruler-idle-value")).toBeNull();
      // 600ms 停顿 → 调整结束：气泡消失、淡百分比出现
      act(() => { vi.advanceTimersByTime(700); });
      expect(screen.queryByTestId("zoom-ruler-bubble")).toBeNull();
      expect(screen.getByTestId("zoom-ruler-idle-value").textContent).toBe("125%");
      // 保持 100% → 淡百分比也不显示
      rerender(<ZoomRuler value={100} onChange={() => {}} />);
      act(() => { vi.advanceTimersByTime(700); });
      expect(screen.queryByTestId("zoom-ruler-bubble")).toBeNull();
      expect(screen.queryByTestId("zoom-ruler-idle-value")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("v0.12.0 需求5：落点接线（源码断言）", () => {
  it("阅读模式：.ProseMirror 用 CSS zoom 变量", () => {
    const css = readSrc("styles/editor.css");
    expect(css).toContain("zoom: var(--doc-zoom, 1)");
  });

  it("编辑模式：textarea 字号用 calc 乘 --doc-zoom（不 zoom textarea）", () => {
    const src = readSrc("components/editor/EditorContainer.tsx");
    expect(src).toContain("calc(${fontSize}px * var(--doc-zoom, 1))");
    // --doc-zoom 注入 :root（比例值）
    expect(src).toContain('setProperty("--doc-zoom", String(docZoom / 100))');
  });

  it("分屏 iframe：body zoom + 增量更新刷新 :root 变量", () => {
    const src = readSrc("components/editor/EditorContainer.tsx");
    expect(src).toContain("zoom: var(--doc-zoom, 1);");
    expect(src).toContain('setProperty("--doc-zoom", cv.docZoom)');
  });

  it("Ctrl+滚轮：监听 .editor-main-area 并 preventDefault", () => {
    const src = readSrc("components/editor/EditorContainer.tsx");
    expect(src).toContain('adjustDocZoom(e.deltaY < 0 ? DOC_ZOOM_STEP : -DOC_ZOOM_STEP)');
    expect(src).toContain('addEventListener("wheel", onWheel, { passive: false })');
  });

  it("表格 zoom 补偿：rect/拖拽 delta 除以 zoom（避免列宽二次放大）", () => {
    const src = readSrc("core/plugins/table-editor.ts");
    expect(src).toContain("getBoundingClientRect().width / zoom");
    expect(src).toContain("startHeight: rowEl.getBoundingClientRect().height / zoom");
    expect(src).toContain("(e.clientX - this.resizing.startX) / (this.resizing.zoom || 1)");
  });
});