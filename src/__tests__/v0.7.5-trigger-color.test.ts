/**
 * v0.7.5 功能3 验证测试：「译」选区浮动气泡颜色设置
 *
 * 覆盖：
 * - 插件 getTranslateColor：刷新时写入 --ai-btn-color；返回空串时移除该变量（回退主题色）
 * - AI 气泡颜色与「译」颜色互不干扰（同一 CSS 变量名、各自独立注入）
 * - 设置默认值（translateBubbleColor = ""）
 * - 窗口记忆字段（F6）的规范化与视口可见性判定
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import { createTranslateTooltipPlugin } from "../core/plugins/translateTooltip";
import {
  AI_CHAT_MIN_SIZE,
  DEFAULT_AI_CHAT_SIZE,
  DEFAULT_TRANSLATE_SETTINGS,
  isAiChatRectVisible,
  normalizeAiChatRect,
  useSettingsStore,
} from "../stores/useSettingsStore";

// ─── mocks（必须在 import 组件之前）：设置/入口面板只做 store 读写，
//     不真正发起网络请求，故桩掉 translateService 的连接与模型列表 ───
const { mockSetKey, mockHasKey, mockTestConnection, mockListModels } = vi.hoisted(() => ({
  mockSetKey: vi.fn(),
  mockHasKey: vi.fn(async () => true),
  mockTestConnection: vi.fn(async () => undefined),
  mockListModels: vi.fn(async () => [] as string[]),
}));

vi.mock("../services/translateService", () => ({
  translateService: {
    setKey: mockSetKey,
    hasKey: mockHasKey,
    testConnection: mockTestConnection,
    listModels: mockListModels,
    cancel: vi.fn(async () => undefined),
  },
}));

import { FullTranslateButton } from "../components/editor/FullTranslateButton";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";

const MD = "# 标题\n\n这是一段用于测试的中文文本内容。";

let createdView: EditorView | null = null;

afterEach(() => {
  createdView?.destroy();
  createdView = null;
  document.body.innerHTML = "";
});

function findTextPos(doc: PMNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isText || !node.text) return true;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) {
      found = { from: pos + idx, to: pos + idx + needle.length };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`text not found: ${needle}`);
  return found;
}

async function mountBubbles(options: {
  getTranslateColor?: () => string | undefined;
  getBubbleColor?: (task: "continue" | "polish" | "summary" | "chat") => string | undefined;
}): Promise<EditorView> {
  const doc = markdownToDoc(MD);
  const pos = findTextPos(doc, "中文文本");
  const plugin = createTranslateTooltipPlugin(() => {}, () => true, {
    getDelay: () => 0,
    getAiDelay: () => 0,
    getTranslateColor: options.getTranslateColor,
    getBubbleColor: options.getBubbleColor,
  });
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos.from, pos.to),
    plugins: [plugin],
  });
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const view = new EditorView({ mount }, { state });
  createdView = view;
  mount.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await new Promise((r) => setTimeout(r, 20));
  return view;
}

function translateBtn(): HTMLElement {
  return document.body.querySelector<HTMLElement>(".translate-trigger")!;
}

function aiBtns(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(".translate-ai-trigger"));
}

describe("v0.7.5 功能3：「译」气泡颜色注入", () => {
  it("getTranslateColor 返回颜色 → 写入 --ai-btn-color（边框/背景随之变化）", async () => {
    await mountBubbles({ getTranslateColor: () => "#ff8800" });
    expect(translateBtn().style.getPropertyValue("--ai-btn-color")).toBe("#ff8800");
  });

  it("默认（getter 未提供）→ 不写变量，回退主题默认色（外观与 v0.7.4 一致）", async () => {
    await mountBubbles({});
    expect(translateBtn().style.getPropertyValue("--ai-btn-color")).toBe("");
  });

  it("颜色被清空（空串）→ 移除 CSS 变量，回退主题色", async () => {
    let color = "#ff8800";
    const view = await mountBubbles({ getTranslateColor: () => color });
    expect(translateBtn().style.getPropertyValue("--ai-btn-color")).toBe("#ff8800");
    // 模拟用户在设置面板点「跟随主题」清空颜色 → 空事务刷新（EditorContainer 的订阅路径）
    color = "";
    view.dispatch(view.state.tr);
    expect(translateBtn().style.getPropertyValue("--ai-btn-color")).toBe("");
  });

  it("纯空白颜色同样视为未设置（trim 防御）", async () => {
    await mountBubbles({ getTranslateColor: () => "   " });
    expect(translateBtn().style.getPropertyValue("--ai-btn-color")).toBe("");
  });

  it("「译」颜色与 AI 气泡颜色互不干扰（同一变量名，各自独立注入）", async () => {
    await mountBubbles({
      getTranslateColor: () => "#111111",
      getBubbleColor: (task) => (task === "polish" ? "#222222" : ""),
    });
    expect(translateBtn().style.getPropertyValue("--ai-btn-color")).toBe("#111111");
    const byTask = new Map(aiBtns().map((b) => [b.dataset.task, b]));
    expect(byTask.get("polish")!.style.getPropertyValue("--ai-btn-color")).toBe("#222222");
    // 未设色的 AI 气泡不写变量
    expect(byTask.get("summary")!.style.getPropertyValue("--ai-btn-color")).toBe("");
  });

  it("设置默认值：translateBubbleColor 为空串（跟随主题）", () => {
    expect(DEFAULT_TRANSLATE_SETTINGS.translateBubbleColor).toBe("");
  });
});

describe("v0.7.5 功能3：两处设置入口读写同一字段（单源）", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      translate: { ...DEFAULT_TRANSLATE_SETTINGS },
      aiEnabled: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("「译」入口子设置面板：色板改色写入 translateBubbleColor", async () => {
    render(React.createElement(FullTranslateButton, { onStart: () => {} }));
    fireEvent.click(screen.getByTestId("ftb-settings-trigger"));
    const picker = screen.getByTestId("ftb-bubble-color") as HTMLInputElement;
    fireEvent.change(picker, { target: { value: "#abcdef" } });
    expect(useSettingsStore.getState().translate.translateBubbleColor).toBe("#abcdef");
  });

  it("「译」入口子设置面板：✕ 重置为空串（回退主题色）", () => {
    useSettingsStore.getState().setTranslateConfig({ translateBubbleColor: "#abcdef" });
    render(React.createElement(FullTranslateButton, { onStart: () => {} }));
    fireEvent.click(screen.getByTestId("ftb-settings-trigger"));
    fireEvent.click(screen.getByTestId("ftb-bubble-color-reset"));
    expect(useSettingsStore.getState().translate.translateBubbleColor).toBe("");
  });

  it("设置页「翻译设置」：色板与重置按钮读写同一字段", async () => {
    render(React.createElement(SettingsDialog, { onClose: () => {} }));
    const picker = await screen.findByTestId("translate-bubble-color");
    fireEvent.change(picker, { target: { value: "#123456" } });
    expect(useSettingsStore.getState().translate.translateBubbleColor).toBe("#123456");
    fireEvent.click(screen.getByTestId("translate-bubble-color-reset"));
    expect(useSettingsStore.getState().translate.translateBubbleColor).toBe("");
  });
});

describe("v0.7.5 功能6：对话窗窗口记忆字段校验", () => {
  const VP = { width: 1200, height: 800 };

  it("默认尺寸常量为 560×480，最小值 360×280", () => {
    expect(DEFAULT_AI_CHAT_SIZE).toEqual({ w: 560, h: 480 });
    expect(AI_CHAT_MIN_SIZE).toEqual({ w: 360, h: 280 });
  });

  it("normalizeAiChatRect：非法/过小值回落 null（回落默认居中）", () => {
    expect(normalizeAiChatRect(null)).toBeNull();
    expect(normalizeAiChatRect(undefined)).toBeNull();
    expect(normalizeAiChatRect({ x: 0, y: 0, w: 100, h: 100 })).toBeNull(); // 小于下限
    expect(normalizeAiChatRect({ x: NaN, y: 0, w: 560, h: 480 })).toBeNull();
    // 合法值取整后原样返回
    expect(normalizeAiChatRect({ x: 10.6, y: 20.2, w: 560.4, h: 480.5 })).toEqual({
      x: 11,
      y: 20,
      w: 560,
      h: 481,
    });
  });

  it("isAiChatRectVisible：视口内可见 → true；完全越界/显示器变小 → false", () => {
    expect(isAiChatRectVisible({ x: 100, y: 100, w: 560, h: 480 }, VP)).toBe(true);
    // 部分越界但仍可抓取（≥80×40 可见）→ 仍视为有效
    expect(isAiChatRectVisible({ x: -400, y: -300, w: 560, h: 480 }, VP)).toBe(true);
    // 完全在右侧视口外 → 失效
    expect(isAiChatRectVisible({ x: 1400, y: 100, w: 560, h: 480 }, VP)).toBe(false);
    // 原显示器 4K 的记忆放到小视口 → 失效（回落默认居中）
    expect(isAiChatRectVisible({ x: 3000, y: 1800, w: 560, h: 480 }, { width: 800, height: 600 })).toBe(
      false
    );
    expect(isAiChatRectVisible(null, VP)).toBe(false);
  });
});
