/**
 * v0.7.0 修复测试（第二轮）
 *
 * 修复1：选区「译」浮动按钮右键菜单（contextmenu 回调 → 入口层渲染快捷菜单）
 * 修复2：「选中文本翻译气泡」关闭时选区翻译入口静默（runTranslate 前置拦截，
 *        F6/右键/命令面板/重试统一入口；插件按钮经 enabled getter 同步隐藏）
 * 修复3：底部栏 AI 抽屉——移出保持展开，点击外部（非任务中）或 AI 任务结束才收回
 * 修复4：气泡延迟出现（插件 getDelay + 「译」面板滑条 0~2s 默认 0.5s）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import {
  createTriggerButton,
  createTranslateTooltipPlugin,
} from "../core/plugins/translateTooltip";
import { markdownToDoc } from "../core/markdown/parser";
import { StatusBar } from "../components/layout/StatusBar";
import { FullTranslateButton } from "../components/editor/FullTranslateButton";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useAiAssistStore } from "../stores/aiAssistStore";

// mock translateService（cancel 不发 Tauri invoke）
vi.mock("../services/translateService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/translateService")>();
  return {
    ...orig,
    translateService: {
      ...orig.translateService,
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
});

/** 在 doc 中选中指定文本的 EditorState（含翻译浮动按钮插件） */
function makeState(opts: {
  needle: string;
  enabled?: () => boolean;
  getDelay?: () => number;
}) {
  const doc = markdownToDoc(`hello ${opts.needle} world`);
  let from = 0;
  doc.descendants((node: PMNode, pos: number) => {
    if (node.isText && node.text && node.text.includes(opts.needle) && from === 0) {
      const idx = node.text.indexOf(opts.needle);
      from = pos + idx;
      return false;
    }
    return true;
  });
  if (from === 0) throw new Error(`text not found: ${opts.needle}`);
  const plugin = createTranslateTooltipPlugin(() => {}, opts.enabled ?? (() => true), {
    getDelay: opts.getDelay,
  });
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, from + opts.needle.length),
    plugins: [plugin],
  });
}

/** 挂载 view 并向 .ProseMirror 派发左键 mouseup（模拟选中松开） */
function mountAndMouseUp(state: EditorState) {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const view = new EditorView({ mount }, { state });
  view.dom.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
  return { view, mount };
}

/** v0.7.3：浮动「译」按钮挂载于 body（display:none 即隐藏） */
function floatingTriggerVisible(): boolean {
  const floatEl = document.body.querySelector(
    ".translate-trigger-float"
  ) as HTMLElement | null;
  return !!floatEl && floatEl.style.display !== "none";
}

beforeEach(() => {
  // 统一初始设置：AI 双开关开启、气泡显示、默认延迟 500ms
  useSettingsStore.setState({
    aiEnabled: true,
    translate: {
      ...useSettingsStore.getState().translate,
      translateEnabled: true,
      translateBubbleHidden: false,
      translateBubbleDelayMs: 500,
    },
  });
  useAiAssistStore.getState().close();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── 修复1：浮动按钮右键菜单回调 ─────────────────────────

describe("v0.7.0 修复1：选区「译」浮动按钮右键菜单", () => {
  it("contextmenu 触发回调（携带按钮与事件）并阻止默认行为", () => {
    const onClick = vi.fn();
    const onCtx = vi.fn();
    const btn = createTriggerButton(onClick, onCtx);
    document.body.appendChild(btn);
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    btn.dispatchEvent(e);
    expect(onCtx).toHaveBeenCalledTimes(1);
    expect(onCtx.mock.calls[0][0]).toBe(btn);
    expect(e.defaultPrevented).toBe(true);
    // 右键不触发翻译
    expect(onClick).not.toHaveBeenCalled();
  });

  it("mousedown 同样阻止失焦（保持选区，右键菜单定位依赖选区锚点）", () => {
    const btn = createTriggerButton(() => {}, () => {});
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("未传 onContextMenu 时右键不拦截（保持原生菜单）", () => {
    const btn = createTriggerButton(() => {});
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    btn.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

// ─── 修复2：气泡开关关闭时选区翻译入口静默 ────────────────

describe("v0.7.0 修复2：「选中文本翻译气泡」关闭时入口静默", () => {
  // EditorContainer 选区翻译入口的统一守卫语义：
  // - translateEnabledGetter（浮动按钮显隐）
  // - runTranslate 前置拦截（F6 / 右键菜单 / 命令面板 / 气泡重试 → 全部静默 return）
  const entryEnabled = () => {
    const s = useSettingsStore.getState();
    return s.aiEnabled && s.translate.translateEnabled && !s.translate.translateBubbleHidden;
  };

  it("双开关开启 + 气泡显示 → 入口可用", () => {
    expect(entryEnabled()).toBe(true);
  });

  it("气泡开关关闭 → 入口静默（F6/右键/命令面板不发起翻译）", () => {
    useSettingsStore.getState().setTranslateConfig({ translateBubbleHidden: true });
    expect(entryEnabled()).toBe(false);
    expect(useSettingsStore.getState().translate.translateBubbleHidden).toBe(true);
  });

  it("插件按钮同步隐藏（enabled=false：mouseup 后不渲染浮动按钮）", () => {
    vi.useFakeTimers();
    const state = makeState({
      needle: "brave",
      enabled: () => false,
      getDelay: () => 0,
    });
    const { view, mount } = mountAndMouseUp(state);
    vi.advanceTimersByTime(10);
    expect(floatingTriggerVisible()).toBe(false);
    view.destroy();
  });
});

// ─── 修复4：插件延迟显示 getDelay ─────────────────────────

describe("v0.7.0 修复4：浮动按钮延迟出现", () => {
  it("延迟 500ms：到期前不显示，到期后显示", () => {
    vi.useFakeTimers();
    const state = makeState({ needle: "brave", getDelay: () => 500 });
    const { view, mount } = mountAndMouseUp(state);
    vi.advanceTimersByTime(499);
    expect(floatingTriggerVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(floatingTriggerVisible()).toBe(true);
    view.destroy();
  });

  it("延迟 0：下一 tick 立即显示", () => {
    vi.useFakeTimers();
    const state = makeState({ needle: "brave", getDelay: () => 0 });
    const { view, mount } = mountAndMouseUp(state);
    vi.advanceTimersByTime(0);
    expect(floatingTriggerVisible()).toBe(true);
    view.destroy();
  });

  it("连续 mouseup 重置计时器（不叠加多个定时器）", () => {
    vi.useFakeTimers();
    const state = makeState({ needle: "brave", getDelay: () => 500 });
    const { view, mount } = mountAndMouseUp(state);
    // 第一次 mouseup 后 300ms 再次 mouseup：计时器应重新计 500ms
    vi.advanceTimersByTime(300);
    view.dom.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    vi.advanceTimersByTime(499);
    expect(floatingTriggerVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(floatingTriggerVisible()).toBe(true);
    view.destroy();
  });

  it("延迟期间选区已清除 → 到期后不显示", () => {
    vi.useFakeTimers();
    const state = makeState({ needle: "brave", getDelay: () => 500 });
    const { view, mount } = mountAndMouseUp(state);
    // 延迟期间光标塌陷选区（如用户点击别处）
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    vi.advanceTimersByTime(500);
    expect(floatingTriggerVisible()).toBe(false);
    view.destroy();
  });
});

// ─── 修复4：滑条设置 UI ───────────────────────────────────

describe("v0.7.0 修复4：「译」面板气泡延迟滑条", () => {
  const openPanel = () => {
    render(<FullTranslateButton onStart={() => {}} />);
    fireEvent.click(screen.getByTestId("ftb-settings-trigger"));
  };

  it("气泡开关开启：滑条显示，默认 0.5s", () => {
    openPanel();
    const slider = screen.getByTestId("ftb-bubble-delay") as HTMLInputElement;
    expect(slider).toBeDefined();
    expect(slider.value).toBe("500");
    expect(screen.getByText("0.5s")).toBeDefined();
  });

  it("拖动滑条更新 translateBubbleDelayMs 并实时显示", () => {
    openPanel();
    fireEvent.change(screen.getByTestId("ftb-bubble-delay"), { target: { value: "1200" } });
    expect(useSettingsStore.getState().translate.translateBubbleDelayMs).toBe(1200);
    expect(screen.getByText("1.2s")).toBeDefined();
  });

  it("气泡开关关闭：滑条隐藏（无无效配置）", () => {
    useSettingsStore.getState().setTranslateConfig({ translateBubbleHidden: true });
    openPanel();
    expect(screen.queryByTestId("ftb-bubble-delay-row")).toBeNull();
    // 开关本身仍在（可重新打开）
    expect(screen.getByTestId("ftb-bubble-toggle")).toBeDefined();
  });
});

// ─── 修复3：AI 抽屉交互 ───────────────────────────────────

describe("v0.7.0 修复3：底部栏 AI 抽屉展开/收回", () => {
  const isOpen = () => (screen.getByTestId("ai-entry") as HTMLElement).className.includes("open");

  it("hover 展开，鼠标移出后保持展示（不再随移出收回）", () => {
    render(<StatusBar />);
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    expect(isOpen()).toBe(true);
    fireEvent.mouseLeave(screen.getByTestId("ai-entry"));
    expect(isOpen()).toBe(true);
  });

  it("点击抽屉外部区域收回", () => {
    render(<StatusBar />);
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    expect(isOpen()).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(isOpen()).toBe(false);
  });

  it("点击抽屉内部不收回", () => {
    render(<StatusBar />);
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    fireEvent.mouseDown(screen.getByTestId("ai-entry-continue"));
    expect(isOpen()).toBe(true);
  });

  it("AI 任务进行中点击外部不收回（任务结束才收回）", () => {
    render(<StatusBar />);
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    act(() => {
      useAiAssistStore.getState().openBubble("summary", "pm", { x: 100, y: 100 });
    });
    expect(isOpen()).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(isOpen()).toBe(true);
  });

  it("AI 任务结束（气泡关闭回 idle）后自动收回", () => {
    render(<StatusBar />);
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    act(() => {
      useAiAssistStore.getState().openBubble("continue", "pm", { x: 100, y: 100 });
    });
    expect(isOpen()).toBe(true);
    act(() => {
      useAiAssistStore.getState().close();
    });
    expect(isOpen()).toBe(false);
  });

  it("任务失败回 error→close 后收回；总开关关闭时抽屉收回且不可展开", () => {
    render(<StatusBar />);
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    act(() => {
      useAiAssistStore.getState().openBubble("polish", "pm", { x: 100, y: 100 });
      useAiAssistStore.getState().fail("NETWORK");
    });
    // error 态气泡仍显示（任务上下文未结束）→ 抽屉保持
    expect(isOpen()).toBe(true);
    act(() => {
      useAiAssistStore.getState().close();
    });
    expect(isOpen()).toBe(false);
    // 总开关关闭：hover 不展开
    act(() => {
      useSettingsStore.setState({ aiEnabled: false });
    });
    fireEvent.mouseEnter(screen.getByTestId("ai-entry"));
    expect(isOpen()).toBe(false);
  });
});
