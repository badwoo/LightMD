/**
 * v0.8.4 需求11：大纲栏 hover 搜索框
 *
 * 覆盖（对应实施文档 §7 v0.8.4-outline-search 行）：
 * 1. hover 显隐：hover 展开 / 移出收起；聚焦兜底（输入中鼠标移出不收起，防误关）；
 *    blur 且鼠标不在 → 收起；关键字非空 → 保持显示
 * 2. 过滤：大小写不敏感、包含匹配；无匹配提示；outline-count 始终显示总数
 * 3. 过滤态禁用拖拽手柄（清空关键字后恢复）
 * 4. 过滤顺序：先 filter 后 MAX_OUTLINE_ITEMS 截断（>100 条时截断线之后的命中项仍可见）
 * 5. ESC 清空并收起；空文档（无标题）永不显示搜索条
 *
 * 测试约定（项目教训）：
 * - vitest 未开 globals → describe/it/expect/vi 全部显式 import
 * - @testing-library/react 16 的 auto-cleanup 在此配置下不生效 → afterEach(cleanup)
 * - jsdom 无 IntersectionObserver（Outline 滚动高亮依赖）→ 注入空实现
 * - 事件触发沿用项目已验证模式：fireEvent.mouseEnter/mouseLeave/focus/blur
 *   （参考 v0.7.0-fix2 / v0.7.2 已有全绿用例）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { markdownToDoc } from "../core/markdown/parser";
import { lightMDSchema as schema } from "../core/schema";
import { Outline } from "../components/editor/Outline";

// mock dnd-kit 绑定层：@dnd-kit 未写入本项目 package.json（历史疏漏），运行时从
// 仓库上层 node_modules 穿透解析，其 peer react 指向 React 19，与本项目 React 18
// 构成双副本导致 hooks 崩溃。这里仅替换 React 绑定（渲染为透传），被测的过滤 /
// 显隐 / 手柄禁用逻辑不受影响；拖拽事务逻辑由 g13-outline-drag.test.ts 纯函数覆盖。
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

// jsdom 未实现 IntersectionObserver，注入空实现（Outline 的 setupObserver 需要）
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

/** 构造假 EditorView：仅提供 Outline 读取的 state.doc / dispatch / nodeDOM */
function makeView(markdown: string): EditorView {
  const state = EditorState.create({ doc: markdownToDoc(markdown), schema });
  return {
    state,
    dispatch: vi.fn(),
    nodeDOM: () => null,
  } as unknown as EditorView;
}

/** 渲染 Outline 并返回根容器 / 搜索条包裹层 / 搜索输入框 */
function setup(markdown: string) {
  const utils = render(<Outline editorView={makeView(markdown)} />);
  const root = utils.container.querySelector(".outline") as HTMLElement;
  const searchWrap = utils.container.querySelector(
    ".outline-search",
  ) as HTMLElement | null;
  const input = searchWrap
    ? (searchWrap.querySelector("input") as HTMLInputElement)
    : null;
  return { ...utils, root, searchWrap, input };
}

/** 搜索条当前是否处于展开态（.visible 类；收起态由 CSS pointer-events:none 保证不可交互） */
function isVisible(searchWrap: HTMLElement | null): boolean {
  return !!searchWrap?.classList.contains("visible");
}

const SAMPLE = "# Apple\n## banana\n### Application\n# 樱桃\n";

// ─── hover 显隐（含防误关）───────────────────────────────────
describe("v0.8.4 需求11 hover 显隐", () => {
  it("默认收起，hover 展开，移出收起", () => {
    const { root, searchWrap } = setup(SAMPLE);
    expect(isVisible(searchWrap)).toBe(false);
    fireEvent.mouseEnter(root);
    expect(isVisible(searchWrap)).toBe(true);
    fireEvent.mouseLeave(root);
    expect(isVisible(searchWrap)).toBe(false);
  });

  it("输入中鼠标移出但焦点仍在 → 不收起（防误关）", () => {
    const { root, searchWrap, input } = setup(SAMPLE);
    fireEvent.mouseEnter(root);
    fireEvent.focus(input!);
    fireEvent.change(input!, { target: { value: "ap" } });
    fireEvent.mouseLeave(root);
    // 焦点兜底：虽已移出鼠标，仍保持展开
    expect(isVisible(searchWrap)).toBe(true);
  });

  it("blur 且鼠标不在（且无关键字）→ 收起", () => {
    const { root, searchWrap, input } = setup(SAMPLE);
    fireEvent.mouseEnter(root);
    fireEvent.focus(input!);
    fireEvent.mouseLeave(root);
    expect(isVisible(searchWrap)).toBe(true); // 聚焦兜底
    fireEvent.blur(input!);
    expect(isVisible(searchWrap)).toBe(false); // 三者皆否 → 收起
  });

  it("关键字非空时 blur + 鼠标移出仍保持显示", () => {
    const { root, searchWrap, input } = setup(SAMPLE);
    fireEvent.mouseEnter(root);
    fireEvent.focus(input!);
    fireEvent.change(input!, { target: { value: "ap" } });
    fireEvent.blur(input!);
    fireEvent.mouseLeave(root);
    // hasQuery 兜底：结果集持续可见
    expect(isVisible(searchWrap)).toBe(true);
  });

  it("空文档（无标题）永不显示搜索条", () => {
    const { container } = setup("普通段落，没有标题");
    expect(container.querySelector(".outline-search")).toBeNull();
    expect(container.querySelector(".outline-empty")).not.toBeNull();
  });
});

// ─── 过滤 ────────────────────────────────────
describe("v0.8.4 需求11 过滤", () => {
  it("大小写不敏感 + 包含匹配", () => {
    const { input } = setup(SAMPLE);
    fireEvent.change(input!, { target: { value: "AP" } });
    expect(screen.queryByText("Apple")).not.toBeNull();
    expect(screen.queryByText("Application")).not.toBeNull();
    expect(screen.queryByText("banana")).toBeNull();
    expect(screen.queryByText("樱桃")).toBeNull();
  });

  it("无匹配时显示空态提示", () => {
    const { input } = setup(SAMPLE);
    fireEvent.change(input!, { target: { value: "zzz不存在" } });
    expect(screen.getByText("无匹配标题")).toBeTruthy();
  });

  it("outline-count 始终显示标题总数（不随过滤变化）", () => {
    const { input } = setup(SAMPLE);
    fireEvent.change(input!, { target: { value: "an" } }); // 仅 banana 命中
    expect(screen.queryByText("banana")).not.toBeNull();
    expect(screen.queryByText("Apple")).toBeNull();
    expect(screen.getByText("4")).toBeTruthy(); // 总数仍为 4
  });

  it("ESC 清空关键字并失焦，鼠标不在容器内时随之收起", () => {
    const { root, searchWrap, input } = setup(SAMPLE);
    fireEvent.mouseEnter(root);
    // fireEvent.focus 触发 React onFocus；原生 focus() 同步 jsdom activeElement，
    // 使 ESC 处理器内的 blur() 能真正产生焦点变化并派发 blur 事件
    fireEvent.focus(input!);
    input!.focus();
    fireEvent.change(input!, { target: { value: "ap" } });
    fireEvent.mouseLeave(root);
    expect(isVisible(searchWrap)).toBe(true); // 聚焦兜底
    fireEvent.keyDown(input!, { key: "Escape" });
    // 关键字已清空，列表恢复全量
    expect(screen.queryByText("banana")).not.toBeNull();
    expect(screen.queryByText("Apple")).not.toBeNull();
    // ESC 内部触发 blur；此时鼠标已不在容器内 → 收起
    expect(isVisible(searchWrap)).toBe(false);
  });
});

// ─── 过滤态禁用拖拽 ────────────────────────────────────
describe("v0.8.4 需求11 过滤态禁用拖拽", () => {
  it("输入关键字后拖拽手柄消失，清空后恢复", () => {
    const { container, input } = setup(SAMPLE);
    // 默认 4 个标题均带拖拽手柄
    expect(container.querySelectorAll(".outline-drag-handle").length).toBe(4);
    fireEvent.change(input!, { target: { value: "ap" } });
    expect(container.querySelectorAll(".outline-drag-handle").length).toBe(0);
    fireEvent.change(input!, { target: { value: "" } });
    expect(container.querySelectorAll(".outline-drag-handle").length).toBe(4);
  });
});

// ─── 过滤顺序：先 filter 后 MAX 截断 ────────────────────────────────────
describe("v0.8.4 需求11 过滤顺序", () => {
  it("超过 100 条时，位于截断线之后但命中关键字的标题仍应出现", () => {
    // 构造 110 个标题：第 105 个为 DeepNeedle，其余为 Pad 编号（不含 needle）
    const lines: string[] = [];
    for (let i = 1; i <= 110; i++) {
      lines.push(i === 105 ? "# DeepNeedle" : `# Pad${String(i).padStart(3, "0")}`);
    }
    const md = lines.join("\n") + "\n";
    const { input } = setup(md);
    // 未过滤：仅渲染前 100 条（Pad001..Pad100），并显示剩余 10 条提示
    expect(screen.queryByText("Pad100")).not.toBeNull();
    expect(screen.queryByText("Pad101")).toBeNull();
    expect(screen.getByText("还有 10 个标题...")).toBeTruthy();
    // 输入小写关键字：DeepNeedle 原位于第 105 条（截断线之外），先过滤后截断应命中
    fireEvent.change(input!, { target: { value: "deepneedle" } });
    expect(screen.getByText("DeepNeedle")).toBeTruthy();
    expect(screen.queryByText(/Pad\d{3}/)).toBeNull();
  });
});
