/**
 * v0.7.5 功能2 验证测试：选区 AI 气泡独立隐藏 + 新增「问」气泡
 *
 * 覆盖：
 * - AI_BUBBLE_DEFS：气泡顺序/字形（续/润/摘/问）
 * - 插件 isBubbleHidden(task)：只隐藏被点的那一个，其余照常显示（不再"一刀切"）
 * - 「问」气泡点击 → onAiAction("chat")（入口层据此打开 AI 对话窗而非气泡任务）
 * - 右键菜单动态文案（隐藏「润」气泡 / 隐藏「问」气泡）
 * - 迁移：老 aiAssistBubbleHidden=true → hiddenTasks 全量；false/undefined → 空
 * - 状态栏齿轮面板：按任务独立勾选实时读写 hiddenTasks
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import {
  AI_BUBBLE_DEFS,
  createTranslateTooltipPlugin,
  type AiAssistTask,
} from "../core/plugins/translateTooltip";
import {
  ALL_AI_BUBBLE_TASKS,
  DEFAULT_TRANSLATE_SETTINGS,
  useSettingsStore,
} from "../stores/useSettingsStore";
import { AI_BUBBLE_GLYPHS, sameTaskList } from "../components/editor/EditorContainer";
import { StatusBar } from "../components/layout/StatusBar";
import { t } from "../i18n";

const MD = "# 标题\n\n这是一段用于测试的中文文本内容。";

let createdView: EditorView | null = null;

afterEach(() => {
  createdView?.destroy();
  createdView = null;
  cleanup();
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

/** 挂载带选区的编辑器并触发一次 mouseup（getDelay=0），使浮动按钮显隐完成 */
async function mountBubbles(options: {
  onAiAction?: (task: AiAssistTask) => void;
  isBubbleHidden?: (task: AiAssistTask) => boolean;
}): Promise<void> {
  const doc = markdownToDoc(MD);
  const pos = findTextPos(doc, "中文文本");
  const plugin = createTranslateTooltipPlugin(() => {}, () => true, {
    getDelay: () => 0,
    getAiDelay: () => 0,
    onAiAction: options.onAiAction,
    isBubbleHidden: options.isBubbleHidden,
  });
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos.from, pos.to),
    plugins: [plugin],
  });
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  createdView = new EditorView({ mount }, { state });
  mount.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await new Promise((r) => setTimeout(r, 20));
}

function aiButtons(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(".translate-ai-trigger"));
}

describe("v0.7.5 功能2：气泡定义与字形", () => {
  it("AI_BUBBLE_DEFS：四个 AI 气泡按 续/润/摘/问 排列（「问」在「摘」右侧）", () => {
    expect(AI_BUBBLE_DEFS.map((d) => d.task)).toEqual(["continue", "polish", "summary", "chat"]);
    expect(AI_BUBBLE_DEFS.map((d) => d.text)).toEqual(["续", "润", "摘", "问"]);
  });

  it("ALL_AI_BUBBLE_TASKS 与 AI_BUBBLE_DEFS 同集合（迁移全量 = 四个）", () => {
    expect([...ALL_AI_BUBBLE_TASKS].sort()).toEqual(
      AI_BUBBLE_DEFS.map((d) => d.task).sort()
    );
  });

  it("sameTaskList：顺序无关的内容比较（避免新数组引用触发无谓刷新）", () => {
    expect(sameTaskList(["polish"], ["polish"])).toBe(true);
    expect(sameTaskList(["polish", "chat"], ["chat", "polish"])).toBe(true);
    expect(sameTaskList([], [])).toBe(true);
    expect(sameTaskList(undefined, [])).toBe(true);
    expect(sameTaskList(["polish"], [])).toBe(false);
    expect(sameTaskList(["polish"], ["polish", "chat"])).toBe(false);
  });

  it("右键菜单动态文案：按被点气泡的 task 生成「隐藏『X』气泡」", () => {
    const label = (task: AiAssistTask) =>
      t("settings.translate.hideBubbleTask", { glyph: AI_BUBBLE_GLYPHS[task] });
    expect(label("polish")).toContain("润");
    expect(label("chat")).toContain("问");
    expect(label("polish")).not.toBe(label("chat"));
  });
});

describe("v0.7.5 功能2：插件按任务独立隐藏", () => {
  it("hiddenTasks 含 polish 时仅「润」不显示，其余三个 + 「译」照常", async () => {
    await mountBubbles({ isBubbleHidden: (task) => task === "polish" });
    const btns = aiButtons();
    const byTask = new Map(btns.map((b) => [b.dataset.task, b]));
    expect(byTask.get("polish")!.style.display).toBe("none");
    expect(byTask.get("continue")!.style.display).not.toBe("none");
    expect(byTask.get("summary")!.style.display).not.toBe("none");
    expect(byTask.get("chat")!.style.display).not.toBe("none");
    // 「译」不受 AI 气泡隐藏影响
    expect(document.body.querySelector<HTMLElement>(".translate-trigger")!.style.display).not.toBe(
      "none"
    );
  });

  it("总开关语义（全部返回 true）时四个 AI 全隐藏，「译」仍在", async () => {
    await mountBubbles({ isBubbleHidden: () => true });
    for (const b of aiButtons()) expect(b.style.display).toBe("none");
    expect(document.body.querySelector<HTMLElement>(".translate-trigger")).not.toBeNull();
  });

  it("「问」气泡点击触发 onAiAction('chat')（打开对话窗，非气泡任务）", async () => {
    const onAiAction = vi.fn();
    await mountBubbles({ onAiAction });
    const chat = aiButtons().find((b) => b.dataset.task === "chat")!;
    chat.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAiAction).toHaveBeenCalledWith("chat");
  });
});

describe("v0.7.5 功能2：设置迁移（一刀切隐藏 → 按任务列表）", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ translate: { ...DEFAULT_TRANSLATE_SETTINGS } });
  });

  it("默认值：hiddenTasks 为空数组，「问」气泡色为主题默认（空串）", () => {
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleHiddenTasks).toEqual([]);
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleColorChat).toBe("");
    expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toEqual([]);
  });

  it("老数据 aiAssistBubbleHidden=true → hiddenTasks 全量（四个气泡全部隐藏，可逐一恢复）", async () => {
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({
        state: {
          translate: {
            // v0.7.4 及之前：右键一次隐藏全部 AI 气泡
            aiAssistBubbleHidden: true,
            aiAssistBubbleEnable: true,
          },
        },
        version: 0,
      })
    );
    useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      const tr = useSettingsStore.getState().translate;
      expect([...tr.aiAssistBubbleHiddenTasks].sort()).toEqual([...ALL_AI_BUBBLE_TASKS].sort());
      // 旧字段保留（向前兼容回滚），但不再参与显隐判定
      expect(tr.aiAssistBubbleHidden).toBe(true);
    });
  });

  it("老数据 aiAssistBubbleHidden=false/undefined → hiddenTasks 空数组", async () => {
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({
        state: { translate: { aiAssistBubbleHidden: false } },
        version: 0,
      })
    );
    useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toEqual([]);
    });
  });

  it("非法任务名被过滤（白名单防御，防老数据/手改 localStorage 破坏显隐）", async () => {
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({
        state: {
          translate: { aiAssistBubbleHiddenTasks: ["polish", "bogus", "polish", 42] },
        },
        version: 0,
      })
    );
    useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toEqual(["polish"]);
    });
  });

  it("首次迁移后再次 rehydrate 不再重复迁移（hiddenTasks 已存在时按内容保留）", async () => {
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({
        state: {
          translate: { aiAssistBubbleHidden: true, aiAssistBubbleHiddenTasks: [] },
        },
        version: 0,
      })
    );
    useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      // 已有 hiddenTasks（用户已逐一恢复）→ 不再被旧字段迁移覆盖
      expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toEqual([]);
    });
  });
});

describe("v0.7.5 功能2：状态栏齿轮面板独立勾选", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      translate: { ...DEFAULT_TRANSLATE_SETTINGS },
      aiEnabled: true,
    });
  });

  it("总开关开启 → 四个子勾选全部勾选", () => {
    render(React.createElement(StatusBar));
    fireEvent.click(screen.getByTestId("ai-entry-gear"));
    for (const task of ALL_AI_BUBBLE_TASKS) {
      const box = screen.getByTestId(`ai-settings-bubble-${task}`) as HTMLInputElement;
      expect(box.checked).toBe(true);
    }
  });

  it("取消「润」勾选 → hiddenTasks 加入 polish（等价右键隐藏该气泡）", () => {
    render(React.createElement(StatusBar));
    fireEvent.click(screen.getByTestId("ai-entry-gear"));
    fireEvent.click(screen.getByTestId("ai-settings-bubble-polish"));
    expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toContain("polish");
    // 其余三个不受影响
    expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toHaveLength(1);
  });

  it("再次勾选「润」→ 从 hiddenTasks 移除（逐一恢复）", () => {
    useSettingsStore.getState().setTranslateConfig({ aiAssistBubbleHiddenTasks: ["polish"] });
    render(React.createElement(StatusBar));
    fireEvent.click(screen.getByTestId("ai-entry-gear"));
    fireEvent.click(screen.getByTestId("ai-settings-bubble-polish"));
    expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toEqual([]);
  });

  it("「问」气泡颜色 picker 存在且写入 aiAssistBubbleColorChat", () => {
    render(React.createElement(StatusBar));
    fireEvent.click(screen.getByTestId("ai-entry-gear"));
    const picker = screen.getByTestId("ai-settings-color-chat") as HTMLInputElement;
    fireEvent.change(picker, { target: { value: "#123456" } });
    expect(useSettingsStore.getState().translate.aiAssistBubbleColorChat).toBe("#123456");
  });

  it("总勾选（总开关）取消后隐藏子勾选区；重新勾选恢复全部气泡", () => {
    useSettingsStore.getState().setTranslateConfig({ aiAssistBubbleHiddenTasks: ["polish"] });
    render(React.createElement(StatusBar));
    fireEvent.click(screen.getByTestId("ai-entry-gear"));
    const master = screen.getByTestId("ai-settings-bubble-master") as HTMLInputElement;
    // hiddenTasks 非空 → 总勾选显示未勾选
    expect(master.checked).toBe(false);
    fireEvent.click(master); // 勾选 → 一键恢复全部
    expect(useSettingsStore.getState().translate.aiAssistBubbleEnable).toBe(true);
    expect(useSettingsStore.getState().translate.aiAssistBubbleHiddenTasks).toEqual([]);
  });
});
