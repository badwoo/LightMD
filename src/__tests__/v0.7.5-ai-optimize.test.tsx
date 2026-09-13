/**
 * v0.7.5 AI 功能细节优化 验证测试（5 项）
 *
 * 1. 按 Esc 关闭 AI 气泡/对话窗不再重置文档阅读进度
 *    （keydown 被气泡 window 捕获监听 stopPropagation 吞掉，keyup 仍到达编辑器，
 *     旧实现用陈旧 savedScrollTop 恢复滚动 → 文档跳回上次按键位置/开头）
 * 2. 气泡颜色同步到底部栏 AI 按钮（hover / 按下用同一配色）
 * 3. AI 续写点击后立即出现「续写中...」占位 ghost，首个增量到达即替换
 * 4. AI 对话窗口内嵌 AI 翻译（新增「AI翻译」快捷指令 + 逐条回答「译」）
 * 5. 打开对话窗拖动位置限制（可拖到视口外）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import {
  consumeScrollKeyUp,
  createScrollKeyBaseline,
  markScrollKeyDown,
} from "../utils/typewriter";
import { DEFAULT_TRANSLATE_SETTINGS, useSettingsStore } from "../stores/useSettingsStore";
import { useAiChatStore } from "../stores/aiChatStore";
import { AiChatDialog, clampChatRect } from "../components/editor/AiChatDialog";
import { AI_CHAT_TEMPLATES, resolveTemplateInstruction } from "../utils/aiChatTemplates";
import { aiEntryColorStyle, StatusBar } from "../components/layout/StatusBar";
import { buildSourceGhostHtml } from "../utils/focus-paragraph";
import { aiGhostKey, aiGhostPlugin, setAiGhost, clearAiGhost } from "../core/plugins/ai-ghost";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownToDoc } from "../core/markdown/parser";
import { t } from "../i18n";
import type { TranslateResultData } from "../stores/translateStore";

// ─── mocks：窗口内翻译走 translateService（不真正发请求）───
const { mockTranslate, mockCancel } = vi.hoisted(() => ({
  mockTranslate: vi.fn(),
  mockCancel: vi.fn(async () => undefined),
}));

vi.mock("../services/translateService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/translateService")>();
  return {
    ...actual,
    translateService: {
      ...actual.translateService,
      translate: mockTranslate,
      cancel: mockCancel,
    },
  };
});

const RESULT: TranslateResultData = {
  translated: "answer",
  placeholdersIntact: true,
  finishReason: "stop",
  promptTokens: 1,
  completionTokens: 1,
};

/** 视口（jsdom 默认 1024×768，显式传入的纯函数用例用 1200×800） */
const VP = { width: 1200, height: 800 };

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// ─── 优化1：Esc 不再重置阅读进度 ────────────────────────────

describe("v0.7.5 优化1：Esc 关闭气泡不再重置文档阅读进度", () => {
  it("已消费的基线不能被后续无配套 keydown 的 keyup 复用", () => {
    const b = createScrollKeyBaseline();
    // 用户在文档开头（scrollTop=0）按过键
    markScrollKeyDown(b, 40, 0, false);
    // 正常键入：keyup 配对 → 可用基线
    expect(consumeScrollKeyUp(b)).toBe(true);
    // 再来的 keyup（无配套 keydown）必须被拒绝
    expect(consumeScrollKeyUp(b)).toBe(false);
  });

  it("复现 bug 场景：keydown 被气泡 Esc 吞掉 → keyup 不得使用陈旧 scrollTop", () => {
    const b = createScrollKeyBaseline();
    // 1) 用户在文档开头按了某个编辑键 → 基线记录 scrollTop=0
    markScrollKeyDown(b, 30, 0, false);
    consumeScrollKeyUp(b); // 该次 keyup 正常消费
    // 2) 用户向下滚动阅读（滚动不产生 keydown/keyup），光标仍在开头
    // 3) 按 Esc 关闭摘要气泡：气泡在 window 捕获阶段 stopPropagation，
    //    编辑器捕获 keydown **不会执行** → 基线未被刷新
    // 4) keyup 到达编辑器
    const paired = consumeScrollKeyUp(b);
    // 修复点：paired=false → 不得据此恢复 scrollTop=0（否则文档跳回开头）
    expect(paired).toBe(false);
  });

  it("正常输入：每次 keydown 刷新基线后均可配对消费", () => {
    const b = createScrollKeyBaseline();
    markScrollKeyDown(b, 10, 200, false);
    expect(consumeScrollKeyUp(b)).toBe(true);
    markScrollKeyDown(b, 40, 260, true);
    expect(consumeScrollKeyUp(b)).toBe(true);
    // 第二次消费后 seen 已复位
    expect(b.seen).toBe(false);
  });

  it("基线完整记录 keydown 时的光标 Y / scrollTop / 视口外标记", () => {
    const b = createScrollKeyBaseline();
    markScrollKeyDown(b, 123, 456, true);
    expect(b).toMatchObject({ seen: true, cursorY: 123, scrollTop: 456, cursorWasOutside: true });
  });
});

// ─── 优化2：气泡颜色同步底部栏 AI 按钮 ──────────────────────

describe("v0.7.5 优化2：气泡颜色同步到底部栏 AI 按钮", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      translate: { ...DEFAULT_TRANSLATE_SETTINGS },
      aiEnabled: true,
    });
  });

  it("aiEntryColorStyle：有颜色 → 注入 --ai-entry-color；空串/空白 → 不注入", () => {
    expect(aiEntryColorStyle("#ffe600")).toEqual({ "--ai-entry-color": "#ffe600" });
    expect(aiEntryColorStyle("  #ffe600  ")).toEqual({ "--ai-entry-color": "#ffe600" });
    expect(aiEntryColorStyle("")).toEqual({});
    expect(aiEntryColorStyle("   ")).toEqual({});
    expect(aiEntryColorStyle(undefined)).toEqual({});
  });

  it("四个 AI 抽屉按钮各自带上对应气泡颜色（续=黄 → 按钮注入黄色）", () => {
    useSettingsStore.getState().setTranslateConfig({
      aiAssistBubbleColorContinue: "#ffe600",
      aiAssistBubbleColorPolish: "#00c853",
    });
    render(React.createElement(StatusBar));
    const cont = screen.getByTestId("ai-entry-continue") as HTMLElement;
    const polish = screen.getByTestId("ai-entry-polish") as HTMLElement;
    const summary = screen.getByTestId("ai-entry-summary") as HTMLElement;
    expect(cont.style.getPropertyValue("--ai-entry-color")).toBe("#ffe600");
    expect(polish.style.getPropertyValue("--ai-entry-color")).toBe("#00c853");
    // 未设色的按钮不注入 → CSS 回退主题 accent（外观与旧版一致）
    expect(summary.style.getPropertyValue("--ai-entry-color")).toBe("");
    // 每个按钮都带 task 标识（供样式/测试定位）
    expect(cont.dataset.task).toBe("continue");
    expect((screen.getByTestId("ai-entry-chat") as HTMLElement).dataset.task).toBe("chat");
  });

  it("颜色设置实时反映到按钮（改色后 style 立即更新）", async () => {
    render(React.createElement(StatusBar));
    expect(
      (screen.getByTestId("ai-entry-summary") as HTMLElement).style.getPropertyValue(
        "--ai-entry-color"
      )
    ).toBe("");
    act(() => {
      useSettingsStore.getState().setTranslateConfig({ aiAssistBubbleColorSummary: "#ff00ff" });
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("ai-entry-summary") as HTMLElement).style.getPropertyValue(
          "--ai-entry-color"
        )
      ).toBe("#ff00ff")
    );
  });
});

// ─── 优化3：续写立即显示「续写中...」占位 ghost ─────────────

describe("v0.7.5 优化3：AI 续写立即出现「续写中...」占位 ghost", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function mountEditor(): EditorView {
    const doc = markdownToDoc("# 标题\n\n正文内容");
    // ghost 由插件装饰驱动，必须注册 aiGhostPlugin 才能读到 meta 状态
    const state = EditorState.create({ doc, plugins: [aiGhostPlugin()] });
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    view = new EditorView({ mount }, { state });
    return view;
  }

  it("setAiGhost(placeholder=true) 写入占位态，供 Tab 采纳时拒绝", () => {
    const v = mountEditor();
    setAiGhost(v, 1, t("ai.continuing"), true);
    const st = aiGhostKey.getState(v.state);
    expect(st).toMatchObject({ pos: 1, text: t("ai.continuing"), placeholder: true });
    // 真实增量到达后占位标记清除
    setAiGhost(v, 1, "续写出来的正文");
    expect(aiGhostKey.getState(v.state)).toMatchObject({
      text: "续写出来的正文",
      placeholder: false,
    });
    clearAiGhost(v);
    expect(aiGhostKey.getState(v.state)).toBeNull();
  });

  it("占位态 widget 带 ai-ghost-placeholder 类且不显示采纳提示", () => {
    const v = mountEditor();
    setAiGhost(v, 1, t("ai.continuing"), true);
    const el = document.querySelector(".ai-ghost");
    expect(el).not.toBeNull();
    expect(el!.classList.contains("ai-ghost-placeholder")).toBe(true);
    // 占位期间不可采纳 → 不渲染「Tab 采纳 · Esc 放弃」提示
    expect(el!.querySelector(".ai-ghost-hint")).toBeNull();
    expect(el!.querySelector(".ai-ghost-text")!.textContent).toBe(t("ai.continuing"));
  });

  it("首个增量替换占位提示（不累积、不残留提示语）", async () => {
    const v = mountEditor();
    setAiGhost(v, 1, t("ai.continuing"), true);
    setAiGhost(v, 1, "第一段");
    await waitFor(() => {
      const el = document.querySelector(".ai-ghost")!;
      expect(el.textContent).not.toContain(t("ai.continuing"));
      expect(el.textContent).toContain("第一段");
      // 真实内容态恢复采纳提示
      expect(el.querySelector(".ai-ghost-hint")).not.toBeNull();
    });
  });

  it("source 通道：buildSourceGhostHtml 占位态加 placeholder 类、提示为空", () => {
    const placeholderHtml = buildSourceGhostHtml("abc", 1, t("ai.continuing"), "", true);
    expect(placeholderHtml).toContain("ai-ghost-text ai-ghost-placeholder");
    expect(placeholderHtml).toContain(t("ai.continuing"));
    // 真实内容态：无 placeholder 类
    const realHtml = buildSourceGhostHtml("abc", 1, "续写内容", "Tab ⏎ · Esc ✕", false);
    expect(realHtml).not.toContain("ai-ghost-placeholder");
    expect(realHtml).toContain("续写内容");
    // 默认参数保持向后兼容
    expect(buildSourceGhostHtml("abc", 1, "x", "hint")).toBe(
      buildSourceGhostHtml("abc", 1, "x", "hint", false)
    );
  });

  it("i18n：「续写中...」占位文案已就绪", () => {
    expect(t("ai.continuing")).toBe("续写中...");
  });
});

// ─── 优化4：对话窗内嵌 AI 翻译 ──────────────────────────────

describe("v0.7.5 优化4：AI 对话窗口内嵌 AI 翻译", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      translate: { ...DEFAULT_TRANSLATE_SETTINGS },
      aiEnabled: true,
    });
    useAiChatStore.getState().closeWindow();
    mockTranslate.mockReset();
  });

  function renderDialog(overrides: Record<string, unknown> = {}) {
    const handlers = {
      onSend: vi.fn(),
      onStop: vi.fn(),
      onRegenerate: vi.fn(),
      onInsertAtCursor: vi.fn(),
      onReplaceSelection: vi.fn(),
      onReplaceDocument: vi.fn(),
      onCopy: vi.fn(),
      onScopeChange: vi.fn(),
      ...overrides,
    };
    render(React.createElement(AiChatDialog, handlers as never));
    return handlers;
  }

  it("存在「AI翻译」快捷指令，默认偏好选区（通过选区打开时翻译选区）", () => {
    const tpl = AI_CHAT_TEMPLATES.find((x) => x.id === "translate");
    expect(tpl).toBeTruthy();
    expect(tpl!.labelKey).toBe("ai.chat.tpl.translate");
    expect(t(tpl!.labelKey)).toBe("AI翻译");
    expect(tpl!.preferSelection).toBe(true);
    expect(tpl!.needsTargetLang).toBe(true);
  });

  it("resolveTemplateInstruction：auto → 中英互译表述；指定语言 → 填入 {target}", () => {
    const tpl = AI_CHAT_TEMPLATES.find((x) => x.id === "translate")!;
    const auto = resolveTemplateInstruction(tpl, t, "auto");
    expect(auto).toBe(t("ai.chat.tpl.translate.promptAuto"));
    expect(auto).not.toContain("{target}");

    const en = resolveTemplateInstruction(tpl, t, "English");
    expect(en).toContain("English");
    expect(en).not.toContain("{target}");

    const zh = resolveTemplateInstruction(tpl, t, "简体中文");
    expect(zh).toContain("简体中文");
  });

  it("resolveTemplateInstruction：非翻译模板始终返回其 instructionKey", () => {
    const tpl = AI_CHAT_TEMPLATES.find((x) => x.id === "summary")!;
    expect(resolveTemplateInstruction(tpl, t, "English")).toBe(t("ai.chat.tpl.summary.prompt"));
  });

  it("点击「AI翻译」chip 预填翻译指令（按设置的目标语言）并切到选区范围", () => {
    useSettingsStore.getState().setTranslateConfig({ translateTargetLang: "English" });
    useAiChatStore.getState().openWindow(null, null, "document");
    useAiChatStore.getState().setContextPreview({
      scope: "document",
      actualScope: "selection",
      chars: 12,
      truncated: false,
      degraded: false,
    });
    const handlers = renderDialog();
    fireEvent.click(screen.getByTestId("ai-chat-tpl-translate"));
    expect((screen.getByTestId("ai-chat-input") as HTMLTextAreaElement).value).toContain("English");
    expect(handlers.onScopeChange).toHaveBeenCalledWith("selection");
  });

  it("每条回答带「译」按钮：点击翻译并就地替换展示，再点还原原文", async () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "selection");
    s.appendUser("翻译这段", { hadSelection: true, scope: "selection", templateId: "translate" });
    useAiChatStore.getState().finish({ ...RESULT, translated: "Hello world" });
    mockTranslate.mockResolvedValue({ ...RESULT, translated: "你好世界" });

    renderDialog();
    const bubble = screen.getByTestId("ai-chat-msg-assistant-1").querySelector(".ai-chat-bubble")!;
    expect(bubble.textContent).toBe("Hello world");

    fireEvent.click(
      screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="translate"]')!
    );
    await waitFor(() => expect(bubble.textContent).toBe("你好世界"));
    // 已翻译：按钮变为「原文」且气泡带已翻译标识
    const btn = screen
      .getByTestId("ai-chat-msg-assistant-1")
      .querySelector('[data-action="translate"]')!;
    expect(btn.textContent).toBe(t("ai.chat.action.translateBack"));
    expect(bubble.getAttribute("data-translated")).toBeTruthy();

    // 再点还原原文
    fireEvent.click(btn);
    await waitFor(() => expect(bubble.textContent).toBe("Hello world"));
    expect(bubble.getAttribute("data-translated")).toBeNull();
  });

  it("译文态下「替换选区 / 复制」使用译文（窗口内翻译闭环）", async () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "selection");
    s.appendUser("翻译", { hadSelection: true, scope: "selection", templateId: "translate" });
    useAiChatStore.getState().finish({ ...RESULT, translated: "Hello" });
    mockTranslate.mockResolvedValue({ ...RESULT, translated: "你好" });
    const handlers = renderDialog();

    fireEvent.click(
      screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="translate"]')!
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("ai-chat-msg-assistant-1").querySelector(".ai-chat-bubble")!.textContent
      ).toBe("你好")
    );
    fireEvent.click(
      screen
        .getByTestId("ai-chat-msg-assistant-1")
        .querySelector('[data-action="replace-selection"]')!
    );
    expect(handlers.onReplaceSelection).toHaveBeenCalledWith("你好");
    fireEvent.click(
      screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="copy"]')!
    );
    expect(handlers.onCopy).toHaveBeenCalledWith("你好");
  });

  it("超长回答不发起翻译，直接提示（避免静默失败）", async () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    s.appendUser("x", { hadSelection: false, scope: "document", templateId: null });
    useAiChatStore.getState().finish({ ...RESULT, translated: "字".repeat(4001) });
    renderDialog();
    fireEvent.click(
      screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="translate"]')!
    );
    expect(mockTranslate).not.toHaveBeenCalled();
  });
});

// ─── 优化5：打开对话窗拖动限制 ──────────────────────────────

describe("v0.7.5 优化5：对话窗可自由拖动（位置不再受视口约束）", () => {
  const noopProps = {
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRegenerate: vi.fn(),
    onInsertAtCursor: vi.fn(),
    onReplaceSelection: vi.fn(),
    onReplaceDocument: vi.fn(),
    onCopy: vi.fn(),
    onScopeChange: vi.fn(),
  };

  it("clampChatRect 不再钳制位置，尺寸仍受限", () => {
    expect(clampChatRect({ x: -9999, y: -9999, w: 560, h: 480 }, VP)).toEqual({
      x: -9999,
      y: -9999,
      w: 560,
      h: 480,
    });
    expect(clampChatRect({ x: 50, y: 60, w: 100, h: 100 }, VP)).toEqual({
      x: 50,
      y: 60,
      w: 360,
      h: 280,
    });
  });

  it("拖拽标题栏可把窗口移到视口外（不再被拉回）", () => {
    useAiChatStore.getState().openWindow(null, { x: 100, y: 100, w: 560, h: 480 }, "document");
    render(React.createElement(AiChatDialog, noopProps as never));
    const dialog = screen.getByTestId("ai-chat-dialog");
    const header = screen.getByTestId("ai-chat-header");

    fireEvent.mouseDown(header, { clientX: 200, clientY: 120 });
    // 拖到视口左上方之外（负坐标）
    fireEvent.mouseMove(window, { clientX: -300, clientY: -200 });
    fireEvent.mouseUp(window);

    // dx = -300-200 = -500 → x = 100-500 = -400；dy = -200-120 = -320 → y = 100-320 = -220
    expect(dialog.style.left).toBe("-400px");
    expect(dialog.style.top).toBe("-220px");
    // 拖拽结束落盘记忆（下次打开可复原）
    expect(useSettingsStore.getState().aiChatWindow).toMatchObject({ x: -400, y: -220 });
  });

  it("再次打开时，完全落在视口外的记忆回落默认居中（避免窗口打不开）", () => {
    useAiChatStore.getState().openWindow(null, { x: -5000, y: -5000, w: 560, h: 480 }, "document");
    render(React.createElement(AiChatDialog, noopProps as never));
    const dialog = screen.getByTestId("ai-chat-dialog");
    // 默认居中：left = max(8, (innerWidth - 560) / 2)（jsdom 视口宽度为 1024）
    const expectedX = Math.max(8, Math.round((window.innerWidth - 560) / 2));
    expect(dialog.style.left).toBe(`${expectedX}px`);
  });
});
