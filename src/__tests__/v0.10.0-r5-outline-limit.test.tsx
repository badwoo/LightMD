/**
 * R5（v0.10.0）：大纲渲染上限提升 100 → 1000
 *
 * 1. 1001 个标题渲染前 1000 项 + 截断提示（i18n 文案「仅渲染前 1000 项，还有 N 个标题」）
 * 2. 1000 个标题不出现截断提示（边界回归）
 *
 * 测试约定（项目教训）：vitest 显式 import；afterEach(cleanup)；jsdom 注入
 * IntersectionObserver 空实现；dnd-kit 绑定层 mock（同 v0.8.4-outline-search.test.tsx）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { markdownToDoc } from "../core/markdown/parser";
import { lightMDSchema as schema } from "../core/schema";
import { Outline } from "../components/editor/Outline";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => null,
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: undefined,
}));
vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(cleanup);

function makeView(markdown: string): EditorView {
  const state = EditorState.create({ doc: markdownToDoc(markdown), schema });
  return {
    state,
    dispatch: vi.fn(),
    nodeDOM: () => null,
  } as unknown as EditorView;
}

function renderOutline(markdown: string) {
  return render(<Outline editorView={makeView(markdown)} />);
}

function headingDoc(count: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`# H${String(i).padStart(4, "0")}`);
  }
  return lines.join("\n") + "\n";
}

describe("R5: 大纲渲染上限 1000", () => {
  it("1001 个标题渲染前 1000 项 + 截断提示文案", () => {
    const { container } = renderOutline(headingDoc(1001));
    const items = container.querySelectorAll(".outline-list > .outline-item");
    expect(items.length).toBe(1000);
    expect(screen.queryByText("H1000")).not.toBeNull();
    expect(screen.queryByText("H1001")).toBeNull();
    expect(screen.getByText("仅渲染前 1000 项，还有 1 个标题...")).toBeTruthy();
  });

  it("恰好 1000 个标题不出现截断提示（边界）", () => {
    const { container } = renderOutline(headingDoc(1000));
    const items = container.querySelectorAll(".outline-list > .outline-item");
    expect(items.length).toBe(1000);
    expect(container.querySelector(".outline-more")).toBeNull();
  });
});
