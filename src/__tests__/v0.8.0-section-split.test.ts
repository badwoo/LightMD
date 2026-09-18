/**
 * v0.8.0 WP4 修复1（任务 4.1）+ 需求9（任务 4.2）单元测试
 *
 * 覆盖：
 * 1. computeSplit 纯函数：相邻配对分配（向下拖→本区+delta、下区-delta，自然方向不取反）、
 *    双向 minHeight 钳制、总和守恒；
 * 2. useSectionSplit hook：mousedown→mousemove 触发 setPair，方向正确性（不取反）；
 * 3. 滚动箭头显隐判定（canShowUp / canShowDown）纯函数：到顶不显上箭头、
 *    到底不显下箭头、内容不溢出时都不显示。
 *
 * 注：delta 取反的旧逻辑（useResizable vertical 分支）已被本实现取代，
 * 本测试锁定"相邻配对 + 自然方向"这一正确行为。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderHook, act } from "@testing-library/react";
import { computeSplit, useSectionSplit, SectionSizeContext } from "../hooks/useSectionSplit";
import { canShowUp, canShowDown } from "../components/sidebar/SidebarScrollArrows";

// ─── 1. computeSplit 纯函数 ──────────────────────────────
describe("computeSplit 相邻配对分配（自然方向，不取反）", () => {
  it("向下拖 delta>0：本区(上) +delta，下区 -delta", () => {
    // top=200,bottom=200,delta=+50 → 250 / 150
    expect(computeSplit(200, 200, 50, 80)).toEqual({ top: 250, bottom: 150 });
  });

  it("向上拖 delta<0：本区(上) -delta，下区 +delta", () => {
    expect(computeSplit(200, 200, -50, 80)).toEqual({ top: 150, bottom: 250 });
  });

  it("总和守恒（任意 delta）", () => {
    const cases: Array<[number, number, number]> = [
      [200, 200, 0],
      [120, 300, 40],
      [300, 120, -60],
      [250, 250, 9999],
      [80, 400, -9999],
    ];
    for (const [t, b, d] of cases) {
      const r = computeSplit(t, b, d, 80);
      expect(r.top + r.bottom).toBe(t + b);
    }
  });

  it("上区触底钳制到 minHeight，下区吃掉剩余（守恒）", () => {
    // top=80（已是 min），delta=-50 → top 应继续被钳到 80，bottom = 80+200-80 = 200
    const r = computeSplit(80, 200, -50, 80);
    expect(r.top).toBe(80);
    expect(r.bottom).toBe(200);
    expect(r.top + r.bottom).toBe(280);
  });

  it("下区触底钳制到 minHeight，上区吃掉剩余（守恒）", () => {
    // bottom=80（已是 min），delta=+50 → bottom 钳到 80，top = 300+80-80 = 300
    const r = computeSplit(300, 80, 50, 80);
    expect(r.bottom).toBe(80);
    expect(r.top).toBe(300);
    expect(r.top + r.bottom).toBe(380);
  });

  it("极端 delta 下两区都不低于 minHeight", () => {
    const r = computeSplit(100, 100, -9999, 80);
    expect(r.top).toBeGreaterThanOrEqual(80);
    expect(r.bottom).toBeGreaterThanOrEqual(80);
    expect(r.top + r.bottom).toBe(200);
  });
});

// ─── 2. useSectionSplit hook ──────────────────────────────
function makeMouseEvent(clientY: number, target?: HTMLElement) {
  return {
    button: 0,
    clientX: 0,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: target ?? document.createElement("div"),
  } as unknown as React.MouseEvent;
}

const wrapper = (value: unknown) => ({ children }: { children: React.ReactNode }) =>
  createElement(SectionSizeContext.Provider, { value: value as never }, children);

describe("useSectionSplit hook（方向正确性：不取反）", () => {
  it("向下拖：setPair 收到 上区+delta、本区(下)-delta", () => {
    const setPair = vi.fn();
    const ctx = { sizes: { a: 200, b: 200 }, sizeOf: (k: string) => ({ a: 200, b: 200 } as Record<string, number>)[k] ?? 0, setPair, minHeight: 80 };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "b", prevKey: "a" }), {
      wrapper: wrapper(ctx) as any,
    });

    act(() => {
      result.current.onMouseDown(makeMouseEvent(100));
    });
    expect(result.current.isDragging).toBe(true);

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 150 })); // delta = +50
    });

    expect(setPair).toHaveBeenCalledWith("a", "b", 250, 150);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });

  it("向上拖：方向相反（上区-delta、本区+delta）", () => {
    const setPair = vi.fn();
    const ctx = { sizes: { a: 200, b: 200 }, sizeOf: (k: string) => ({ a: 200, b: 200 } as Record<string, number>)[k] ?? 0, setPair, minHeight: 80 };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "b", prevKey: "a" }), {
      wrapper: wrapper(ctx) as any,
    });

    act(() => {
      result.current.onMouseDown(makeMouseEvent(100));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 50 })); // delta = -50
    });

    expect(setPair).toHaveBeenCalledWith("a", "b", 150, 250);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });

  it("本区是最上面一个区域（无上方邻区）→ 标题栏不可拖拽", () => {
    const setPair = vi.fn();
    const ctx = { sizes: { a: 200 }, sizeOf: (k: string) => ({ a: 200 } as Record<string, number>)[k] ?? 0, setPair, minHeight: 80 };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "a" }), {
      wrapper: wrapper(ctx) as any,
    });
    act(() => {
      result.current.onMouseDown(makeMouseEvent(100));
    });
    // 没有 mousemove 监听器附加，setPair 不应被调用
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 200 }));
    });
    expect(setPair).not.toHaveBeenCalled();
  });

  it("拖拽起点使用 sizeOf 的默认高度（未记录进 sizes 的区域不会从 0 起算）", () => {
    const setPair = vi.fn();
    // sizes 里只有 a，b 未记录 → sizeOf 返回默认 250
    const ctx = {
      sizes: { a: 200 },
      sizeOf: (k: string) => (k === "a" ? 200 : 250),
      setPair,
      minHeight: 80,
    };
    const { result } = renderHook(() => useSectionSplit({ selfKey: "b", prevKey: "a" }), {
      wrapper: wrapper(ctx) as any,
    });

    act(() => result.current.onMouseDown(makeMouseEvent(100)));
    act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientY: 130 }))); // delta=+30

    expect(setPair).toHaveBeenCalledWith("a", "b", 230, 220);
    act(() => document.dispatchEvent(new MouseEvent("mouseup")));
  });
});

// ─── 2.5 v0.8.0 修复 P9-1：标题栏拖拽语义接线 ─────────────
describe("v0.8.0 修复 P9-1 标题栏拖拽语义（源码接线）", () => {
  const fileTreeSrc = readFileSync(
    resolve(__dirname, "../components/sidebar/FileTree.tsx"),
    "utf-8",
  );

  it("文件夹/收藏/最近/temp 的标题栏都改为按 prevOf 配对（拖动自身改变上方区与本区）", () => {
    expect(fileTreeSrc).toContain("prevSectionKey={prevOf(fkey)}");
    expect(fileTreeSrc).toContain('prevSectionKey={prevOf("favorites")}');
    expect(fileTreeSrc).toContain('prevSectionKey={prevOf("recent")}');
    expect(fileTreeSrc).not.toContain("nextSectionKey");
    expect(fileTreeSrc).not.toContain("nextOf");
  });

  it("temp 区标题栏拖动的是「上方邻区 + temp」", () => {
    expect(fileTreeSrc).toMatch(/beginSectionDrag\(\s*tempPrevKey,\s*"temp"/);
  });

  it("SectionSizeContext 提供 sizeOf（拖拽起点用渲染中的实际高度）", () => {
    expect(fileTreeSrc).toContain("sizeOf,");
  });
});

// ─── 3. 滚动箭头显隐判定（纯函数） ───────────────────────
describe("canShowUp / canShowDown 显隐判定", () => {
  it("scrollTop=0 → 不显示上箭头", () => {
    expect(canShowUp(0)).toBe(false);
  });
  it("scrollTop>0 → 显示上箭头", () => {
    expect(canShowUp(1)).toBe(true);
    expect(canShowUp(120)).toBe(true);
  });

  it("未到底 → 显示下箭头", () => {
    // scrollTop 0, clientHeight 100, scrollHeight 200 → 0+100=100 < 199 → true
    expect(canShowDown(0, 100, 200)).toBe(true);
    // 中间态
    expect(canShowDown(50, 100, 200)).toBe(true);
  });

  it("到底（scrollTop+clientHeight >= scrollHeight-1）→ 不显示下箭头", () => {
    expect(canShowDown(99, 100, 200)).toBe(false); // 199 >= 199
    expect(canShowDown(100, 100, 200)).toBe(false); // 200 >= 199
  });

  it("内容不溢出（scrollHeight == clientHeight）→ 上下箭头都不显示", () => {
    expect(canShowUp(0)).toBe(false);
    expect(canShowDown(0, 200, 200)).toBe(false);
    expect(canShowDown(0, 100, 100)).toBe(false);
  });
});
