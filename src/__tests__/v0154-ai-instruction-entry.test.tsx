/**
 * @vitest-environment jsdom
 *
 * v0.15.4 需求7：AI 指令库的**应用入口**验证。
 *
 * 背景：指令库在设置里可增删改/复制/排序（v0.15.0 R3c），但**没有任何应用入口**
 * ——能配置却不能用。本需求把它接进 AI 对话窗：
 * 1. 「快捷指令」下一排显示自定义指令 chips（空库时整排不渲染，不留空行）；
 * 2. 输入框输入 `/` 弹出指令选用列表（上下 + Enter 选用、Esc 关闭、输入法组合态不弹）；
 * 3. 选用后按**当前上下文**展开 `{{selection}}` / `{{document}}` 并预填输入框；
 * 4. 指令作用域（selection/document/none）联动上下文范围 chip。
 *
 * 全部走真实 i18n（与 v0.7.5-ai-chat 同口径），store 用真实 settings store。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { AiChatDialog } from "../components/editor/AiChatDialog";
import {
  expandChatInstruction,
  filterApplicableInstructions,
  findInstructionTrigger,
  instructionScopeToContextScope,
  movePaletteIndex,
  replaceInstructionTrigger,
  shouldShowInstructionPalette,
} from "../utils/aiChatTemplates";
import { expandInstructionTemplate } from "../components/settings/aiInstructionOps";
import { useAiChatStore } from "../stores/aiChatStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { AiInstruction, AiSettings } from "../services/aiProfiles";
import { t } from "../i18n";

function instruction(patch: Partial<AiInstruction> = {}): AiInstruction {
  return {
    id: "i1",
    name: "总结要点",
    scope: "selection",
    userTemplate: "总结：{{selection}}",
    ...patch,
  };
}

/** 写 settings store 的自定义指令库（保留 profile 段为空，本需求不依赖） */
function setInstructions(instructions: AiInstruction[]) {
  const ai: AiSettings = { profiles: [], activeProfileId: "", instructions };
  useSettingsStore.setState({ ai });
}

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
    getContextValues: () => ({ selection: "选中的文字", document: "全文内容" }),
    ...overrides,
  };
  const utils = render(React.createElement(AiChatDialog, handlers as never));
  return { handlers, ...utils };
}

const input = () => screen.getByTestId("ai-chat-input") as HTMLTextAreaElement;

beforeEach(() => {
  useAiChatStore.getState().closeWindow();
  setInstructions([]);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// ─── 纯函数：`/` 触发识别 ────────────────────────────────

describe("v0.15.4 需求7：findInstructionTrigger", () => {
  it("光标前当前 token 以 / 开头 → 触发，query 为 / 之后的内容", () => {
    expect(findInstructionTrigger("/", 1)).toEqual({ start: 0, query: "" });
    expect(findInstructionTrigger("/总结", 3)).toEqual({ start: 0, query: "总结" });
    // token 前有空白的 `/` 同样触发（"改写 /总结"）
    expect(findInstructionTrigger("改写 /总结", 6)).toEqual({ start: 3, query: "总结" });
  });

  it("URL / 路径里的 / 不误触发（token 不以 / 开头）", () => {
    expect(findInstructionTrigger("https://example.com/a", 22)).toBeNull();
    expect(findInstructionTrigger("D:/docs/a.md", 12)).toBeNull();
    // 中文紧邻的 / 仍按 token 判定：整段 "看/a" 的 token 是 "看/a"，不以 / 开头
    expect(findInstructionTrigger("看/a", 3)).toBeNull();
  });

  it("无 / / 光标在 0 / 光标前只有空白 → null", () => {
    expect(findInstructionTrigger("普通文本", 4)).toBeNull();
    expect(findInstructionTrigger("文本", 0)).toBeNull();
    expect(findInstructionTrigger("/x ", 3)).toBeNull(); // 光标在空格后：token 为空
  });

  it("光标位置越界 → 不崩溃（返回 null）", () => {
    expect(findInstructionTrigger("/x", -1)).toBeNull();
    expect(findInstructionTrigger("/x", 99)).toBeNull();
  });
});

// ─── 纯函数：列表过滤 / 是否显示 / 键盘移动 / 替换 ─────────

describe("v0.15.4 需求7：指令列表过滤与显示条件", () => {
  it("空模板不进入列表（展开后是空串，点了没反应）", () => {
    const list = filterApplicableInstructions([
      instruction({ id: "a", userTemplate: "正文 {{selection}}" }),
      instruction({ id: "b", userTemplate: "   " }),
      instruction({ id: "c", userTemplate: "" }),
    ]);
    expect(list.map((x) => x.id)).toEqual(["a"]);
  });

  it("query 按名称大小写不敏感包含匹配；空 query 返回全部可用项", () => {
    const items = [
      instruction({ id: "a", name: "Summary" }),
      instruction({ id: "b", name: "改写全文" }),
    ];
    expect(filterApplicableInstructions(items, "").map((x) => x.id)).toEqual(["a", "b"]);
    expect(filterApplicableInstructions(items, "sum").map((x) => x.id)).toEqual(["a"]);
    expect(filterApplicableInstructions(items, "改写").map((x) => x.id)).toEqual(["b"]);
    expect(filterApplicableInstructions(items, "不存在的")).toEqual([]);
  });

  it("shouldShowInstructionPalette：组合态 / 无触发 / 空列表 都不显示", () => {
    const items = [instruction()];
    const trigger = findInstructionTrigger("/", 1);
    expect(shouldShowInstructionPalette(trigger, items, false)).toBe(true);
    // 输入法组合态：不弹（中文输入时 / 常是候选词的一部分）
    expect(shouldShowInstructionPalette(trigger, items, true)).toBe(false);
    // 没有 / 触发点
    expect(shouldShowInstructionPalette(null, items, false)).toBe(false);
    // 空指令库 → 不弹空列表
    expect(shouldShowInstructionPalette(trigger, [], false)).toBe(false);
  });

  it("movePaletteIndex：上下移动并钳制在两端（不循环）", () => {
    expect(movePaletteIndex(0, 1, 3)).toBe(1);
    expect(movePaletteIndex(2, 1, 3)).toBe(2); // 底部不越界
    expect(movePaletteIndex(0, -1, 3)).toBe(0); // 顶部不越界
    expect(movePaletteIndex(1, -1, 3)).toBe(0);
    expect(movePaletteIndex(0, 1, 0)).toBe(0);
  });

  it("replaceInstructionTrigger：只替换 / token 区段，保留其余文本与光标", () => {
    const out = replaceInstructionTrigger("前文 /总 后文", 3, 5, "展开后的指令");
    expect(out.text).toBe("前文 展开后的指令 后文");
    expect(out.caret).toBe(3 + "展开后的指令".length);
  });
});

// ─── 纯函数：上下文展开与作用域联动 ────────────────────────

describe("v0.15.4 需求7：按当前上下文展开指令", () => {
  it("{{selection}} / {{document}} 按当下上下文替换", () => {
    const expanded = expandChatInstruction(
      instruction({ userTemplate: "选区：{{selection}}\n全文：{{document}}" }),
      { selection: "S", document: "D" },
      expandInstructionTemplate
    );
    expect(expanded).toBe("选区：S\n全文：D");
  });

  it("未知变量原样保留（不做模板求值）", () => {
    const expanded = expandChatInstruction(
      instruction({ userTemplate: "{{date}} / {{selection}}" }),
      { selection: "S", document: "D" },
      expandInstructionTemplate
    );
    expect(expanded).toBe("{{date}} / S");
  });

  it("替换值按字面量处理（$& 不被当正则替换模式）", () => {
    const expanded = expandChatInstruction(
      instruction({ userTemplate: "X{{selection}}Y" }),
      { selection: "$&$1", document: "" },
      expandInstructionTemplate
    );
    expect(expanded).toBe("X$&$1Y");
  });

  it("指令作用域与上下文范围三档一一对应（联动口径单源）", () => {
    for (const scope of ["selection", "document", "none"] as const) {
      expect(instructionScopeToContextScope(instruction({ scope }))).toBe(scope);
    }
  });
});

// ─── 组件：第二排 chips ─────────────────────────────────

describe("v0.15.4 需求7：自定义指令第二排 chips", () => {
  it("有自定义指令时渲染第二排，每条形如 data-testid=ai-chat-inst-<id>", () => {
    setInstructions([
      instruction({ id: "a", name: "总结要点" }),
      instruction({ id: "b", name: "全文大纲", scope: "document", userTemplate: "大纲：{{document}}" }),
    ]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();

    const row = screen.getByTestId("ai-chat-instructions");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain(t("ai.chat.instructions"));
    expect(screen.getByTestId("ai-chat-inst-a")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-inst-b")).toBeTruthy();
    // 第一排（内建模板）仍在
    expect(screen.getByTestId("ai-chat-templates")).toBeTruthy();
  });

  it("【空库】不渲染第二排（不留空行、不显示空标签）", () => {
    setInstructions([]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();
    expect(screen.queryByTestId("ai-chat-instructions")).toBeNull();
  });

  it("【空模板】全是指令正文为空的条目时同样不渲染第二排", () => {
    setInstructions([instruction({ id: "a", userTemplate: "  " })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();
    expect(screen.queryByTestId("ai-chat-instructions")).toBeNull();
  });

  it("点 chip：按当下上下文展开并预填输入框（不自动发送），作用域联动 chip", () => {
    setInstructions([instruction({ id: "a", scope: "document", userTemplate: "大纲：{{document}}" })]);
    useAiChatStore.getState().openWindow(null, null, "none");
    const { handlers } = renderDialog();

    fireEvent.click(screen.getByTestId("ai-chat-inst-a"));
    expect(input().value).toBe("大纲：全文内容");
    expect(handlers.onSend).not.toHaveBeenCalled();
    // 指令作用域 document → 请求切换上下文范围
    expect(handlers.onScopeChange).toHaveBeenCalledWith("document");
  });

  it("选区作用域指令：有选区文本时展开为选区内容", () => {
    setInstructions([instruction({ id: "a", scope: "selection" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();

    fireEvent.click(screen.getByTestId("ai-chat-inst-a"));
    expect(input().value).toBe("总结：选中的文字");
    expect(handlers.onScopeChange).toHaveBeenCalledWith("selection");
  });

  it("指令已等于当前范围时不再派发 onScopeChange（避免无谓状态写入）", () => {
    setInstructions([instruction({ id: "a", scope: "document", userTemplate: "大纲：{{document}}" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    fireEvent.click(screen.getByTestId("ai-chat-inst-a"));
    expect(handlers.onScopeChange).not.toHaveBeenCalled();
  });
});

// ─── 组件：`/` 选用列表 ─────────────────────────────────

describe("v0.15.4 需求7：输入框 `/` 指令选用列表", () => {
  it("输入 / 弹出列表（列出全部可用指令）", () => {
    setInstructions([
      instruction({ id: "a", name: "总结要点" }),
      instruction({ id: "b", name: "全文大纲", scope: "document", userTemplate: "{{document}}" }),
    ]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();

    fireEvent.change(input(), { target: { value: "/", selectionStart: 1 } });
    expect(screen.getByTestId("ai-chat-palette")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-palette-item-a")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-palette-item-b")).toBeTruthy();
  });

  it("继续输入按名称过滤；无匹配时列表收起", () => {
    setInstructions([
      instruction({ id: "a", name: "总结要点" }),
      instruction({ id: "b", name: "全文大纲", userTemplate: "{{document}}" }),
    ]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();

    fireEvent.change(input(), { target: { value: "/总结", selectionStart: 3 } });
    expect(screen.getByTestId("ai-chat-palette-item-a")).toBeTruthy();
    expect(screen.queryByTestId("ai-chat-palette-item-b")).toBeNull();

    fireEvent.change(input(), { target: { value: "/不存在", selectionStart: 4 } });
    expect(screen.queryByTestId("ai-chat-palette")).toBeNull();
  });

  it("【空库】输入 / 不弹任何列表", () => {
    setInstructions([]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();
    fireEvent.change(input(), { target: { value: "/", selectionStart: 1 } });
    expect(screen.queryByTestId("ai-chat-palette")).toBeNull();
  });

  it("键盘下移 + Enter 选用：替换 / token 并展开模板", () => {
    setInstructions([
      instruction({ id: "a", name: "总结要点", userTemplate: "总结：{{selection}}" }),
      instruction({ id: "b", name: "全文大纲", scope: "document", userTemplate: "大纲：{{document}}" }),
    ]);
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();

    fireEvent.change(input(), { target: { value: "/", selectionStart: 1 } });
    // 默认高亮第 1 条；ArrowDown → 第 2 条
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(
      screen.getByTestId("ai-chat-palette-item-b").getAttribute("aria-selected")
    ).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(input().value).toBe("大纲：全文内容");
    // 列表收起 + 未发送
    expect(screen.queryByTestId("ai-chat-palette")).toBeNull();
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("Enter 选用不会触发发送（选用优先于发送）", () => {
    setInstructions([instruction({ id: "a" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    fireEvent.change(input(), { target: { value: "/总结", selectionStart: 3 } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("Esc 只收起列表、不关闭对话窗", () => {
    setInstructions([instruction({ id: "a" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();
    fireEvent.change(input(), { target: { value: "/", selectionStart: 1 } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByTestId("ai-chat-palette")).toBeNull();
    // 窗口仍然打开（Esc 关窗由 capture 阶段监听负责，本用例 target 阶段已 stopPropagation）
    expect(useAiChatStore.getState().open).toBe(true);
  });

  it("【输入法组合态】组合期间输入 / 不弹列表；组合结束后才允许触发", () => {
    setInstructions([instruction({ id: "a", name: "总结要点" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();

    fireEvent.compositionStart(input());
    fireEvent.change(input(), { target: { value: "/总", selectionStart: 2 } });
    expect(screen.queryByTestId("ai-chat-palette")).toBeNull();

    fireEvent.compositionEnd(input(), { target: { value: "/总", selectionStart: 2 } });
    expect(screen.getByTestId("ai-chat-palette")).toBeTruthy();
  });

  it("【输入法组合态】组合期间的 Enter 不发送、也不选用", () => {
    setInstructions([instruction({ id: "a" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    fireEvent.change(input(), { target: { value: "/" , selectionStart: 1 } });
    // 组合态 Enter：InputEvent 的 isComposing=true（选词键）
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true } as never);
    expect(handlers.onSend).not.toHaveBeenCalled();
    // 列表仍未收起（说明没有走选用分支）
    expect(screen.getByTestId("ai-chat-palette")).toBeTruthy();
  });

  it("鼠标点选列表项同样展开并预填（mousedown 不夺走输入框焦点）", () => {
    setInstructions([instruction({ id: "a", name: "总结要点" })]);
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();
    fireEvent.change(input(), { target: { value: "/", selectionStart: 1 } });
    fireEvent.click(screen.getByTestId("ai-chat-palette-item-a"));
    expect(input().value).toBe("总结：选中的文字");
  });
});
