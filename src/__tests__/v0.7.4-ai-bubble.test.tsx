/**
 * v0.7.4 功能7/8 验证测试：
 * - 选区「译」按钮右侧新增 [续][润][摘] 三个 AI 气泡按钮，成一排（computeTriggerRowWidth 布局）
 * - createAiAssistButton：文字/task/颜色 CSS 变量/click/contextmenu
 * - createTranslateTooltipPlugin 集成：一排按钮、AI 气泡隐藏（不影响「译」）、
 *   getBubbleColor 应用颜色、onAiAction 触发
 * - useSettingsStore：新增 7 个设置字段默认值 + 老数据缺字段迁移回退默认
 *
 * v0.7.5 更新：AI 气泡扩为 4 个（+「问」），隐藏判定由整体布尔 isAiHidden
 * 改为按任务的 isBubbleHidden(task)，故本文件同步改用新 API（行为断言不变）。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "../core/markdown/parser";
import {
  computeTriggerRowWidth,
  createAiAssistButton,
  createTranslateTooltipPlugin,
  type AiAssistTask,
} from "../core/plugins/translateTooltip";
import {
  DEFAULT_TRANSLATE_SETTINGS,
  useSettingsStore,
} from "../stores/useSettingsStore";

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

const MD = "# 标题\n\n这是一段用于测试的中文文本内容。";

/** 上一个挂载的 EditorView（集成用例延迟到 afterEach 销毁，避免 remove floatEl） */
let createdView: EditorView | null = null;

afterEach(() => {
  createdView?.destroy();
  createdView = null;
  document.body.innerHTML = "";
});

/** 挂载带选区编辑器并触发一次 selection/mouseup，让浮动按钮显示 */
async function mountWithLedSelection(options: {
  onAiAction?: (task: AiAssistTask) => void;
  onAiContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void;
  isBubbleHidden?: (task: AiAssistTask) => boolean;
  getBubbleColor?: (task: AiAssistTask) => string | undefined;
  getTranslateColor?: () => string | undefined;
}): Promise<void> {
  const doc = markdownToDoc(MD);
  const pos = findTextPos(doc, "中文文本");
  const plugin = createTranslateTooltipPlugin(() => {}, () => true, {
    getDelay: () => 0,
    onAiAction: options.onAiAction,
    onAiContextMenu: options.onAiContextMenu,
    isBubbleHidden: options.isBubbleHidden,
    getBubbleColor: options.getBubbleColor,
    getTranslateColor: options.getTranslateColor,
  });
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos.from, pos.to),
    plugins: [plugin],
  });
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  createdView = new EditorView({ mount }, { state });
  // 触发 mouseup（delay=0）→ PM 同步选区 + 延迟后 dispatch 可见
  mount.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await new Promise((r) => setTimeout(r, 20));
}

function triggerButtons(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(".translate-trigger-float span"));
}

describe("v0.7.4 功能7：选中文本 AI 续写/润色/摘要 气泡按钮", () => {
  it("computeTriggerRowWidth：一排 [译] + 3 个 AI 按钮的总宽度（含间隙）", () => {
    // 默认 28px*4 + 2px*3 = 112 + 6 = 118
    expect(computeTriggerRowWidth(3)).toBe(118);
    expect(computeTriggerRowWidth(3, 4, 28)).toBe(124);
    // 仅「译」时不计算 AI 间隙
    expect(computeTriggerRowWidth(0)).toBe(28);
  });

  it("createAiAssistButton：文字/task/颜色/click/contextmenu", () => {
    const onClick = vi.fn();
    const onCtx = vi.fn();
    const btn = createAiAssistButton(
      "continue",
      "续",
      "AI 续写",
      (b, t) => onClick(b, t),
      "#ff0000",
      onCtx
    );
    expect(btn.textContent).toBe("续");
    expect(btn.dataset.task).toBe("continue");
    expect(btn.title).toBe("AI 续写");
    expect(btn.className).toBe("translate-ai-trigger");
    // 颜色写入 CSS 变量
    expect(btn.style.getPropertyValue("--ai-btn-color")).toBe("#ff0000");

    btn.dispatchEvent(new MouseEvent("click"));
    expect(onClick).toHaveBeenCalledWith(btn, "continue");

    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onCtx).toHaveBeenCalledTimes(1);
  });

  it("createAiAssistButton：空颜色不写入 CSS 变量（回退主题默认色）", () => {
    const btn = createAiAssistButton("polish", "润", "", () => {}, "", undefined);
    expect(btn.style.getPropertyValue("--ai-btn-color")).toBe("");
  });

  it("集成：选区可见时渲染一排五按钮（译 + 续/润/摘/问）", async () => {
    await mountWithLedSelection({});
    const spans = triggerButtons();
    // 译(SVG) + 四个 AI 文字按钮（v0.7.5：「问」排在「摘」右侧）
    expect(spans.length).toBe(5);
    expect(spans[0].classList.contains("translate-trigger")).toBe(true);
    const tasks = spans.slice(1).map((s) => s.dataset.task);
    expect(tasks).toEqual(["continue", "polish", "summary", "chat"]);
  });

  it("集成：isBubbleHidden=true 时隐藏全部 AI 按钮，但「译」仍显示", async () => {
    await mountWithLedSelection({ isBubbleHidden: () => true });
    const spans = triggerButtons();
    expect(spans.length).toBe(5);
    // 译显示
    expect(spans[0].style.display).not.toBe("none");
    // AI 按钮隐藏
    for (const s of spans.slice(1)) {
      expect(s.style.display).toBe("none");
    }
  });

  it("集成：getBubbleColor 应用到各 AI 按钮", async () => {
    const colors: Record<AiAssistTask, string> = {
      continue: "#ff0000",
      polish: "#00ff00",
      summary: "#0000ff",
      chat: "#ff00ff",
    };
    await mountWithLedSelection({ getBubbleColor: (t) => colors[t] });
    const ai = triggerButtons().slice(1);
    expect(ai[0].style.getPropertyValue("--ai-btn-color")).toBe("#ff0000");
    expect(ai[1].style.getPropertyValue("--ai-btn-color")).toBe("#00ff00");
    expect(ai[2].style.getPropertyValue("--ai-btn-color")).toBe("#0000ff");
    expect(ai[3].style.getPropertyValue("--ai-btn-color")).toBe("#ff00ff");
  });

  it("集成：点击 AI 按钮触发 onAiAction(对应 task)", async () => {
    const onAiAction = vi.fn();
    await mountWithLedSelection({ onAiAction });
    const ai = triggerButtons().slice(1);
    ai[2].dispatchEvent(new MouseEvent("click")); // 摘要
    expect(onAiAction).toHaveBeenCalledWith("summary");
  });

  it("集成：右键 AI 按钮触发 onAiContextMenu", async () => {
    const onCtx = vi.fn();
    await mountWithLedSelection({ onAiContextMenu: onCtx });
    const ai = triggerButtons().slice(1);
    ai[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onCtx).toHaveBeenCalledTimes(1);
  });
});

describe("v0.7.4 功能8：设置字段（默认值 + 迁移）", () => {
  it("DEFAULT_TRANSLATE_SETTINGS 含新增 7 个字段默认值", () => {
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleHidden).toBe(false);
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleEnable).toBe(true);
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleDelayMs).toBe(500);
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleColorContinue).toBe("");
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleColorPolish).toBe("");
    expect(DEFAULT_TRANSLATE_SETTINGS.aiAssistBubbleColorSummary).toBe("");
    expect(DEFAULT_TRANSLATE_SETTINGS.aiEntryFixed).toBe(false);
  });

  it("设置 store 初始状态包含新字段默认值", () => {
    const tr = useSettingsStore.getState().translate;
    expect(tr.aiAssistBubbleHidden).toBe(false);
    expect(tr.aiAssistBubbleEnable).toBe(true);
    expect(tr.aiAssistBubbleDelayMs).toBe(500);
    expect(tr.aiAssistBubbleColorContinue).toBe("");
    expect(tr.aiEntryFixed).toBe(false);
  });

  it("setTranslateConfig 更新新字段（实时生效）", () => {
    useSettingsStore.getState().setTranslateConfig({
      aiAssistBubbleHidden: true,
      aiAssistBubbleEnable: false,
      aiAssistBubbleDelayMs: 1000,
      aiAssistBubbleColorContinue: "#123456",
      aiEntryFixed: true,
    });
    const tr = useSettingsStore.getState().translate;
    expect(tr.aiAssistBubbleHidden).toBe(true);
    expect(tr.aiAssistBubbleEnable).toBe(false);
    expect(tr.aiAssistBubbleDelayMs).toBe(1000);
    expect(tr.aiAssistBubbleColorContinue).toBe("#123456");
    expect(tr.aiEntryFixed).toBe(true);
    // 恢复默认，避免污染后续用例
    useSettingsStore.setState({
      translate: { ...DEFAULT_TRANSLATE_SETTINGS },
    });
  });

  it("merge：老数据（无 v0.7.4 字段）迁移时新字段回退默认值", () => {
    // 模拟 localStorage 中只有老字段的持久化数据
    localStorage.setItem(
      "lightmd-settings",
      JSON.stringify({
        state: {
          theme: "dark",
          translate: {
            translateEnabled: true,
            translateBubbleDelayMs: 300,
            // 无 v0.7.4 新字段
          },
        },
        version: 0,
      })
    );
    // 重置并重新 hydration
    useSettingsStore.persist.rehydrate();
    // 等待微任务完成 hydration 后读取
    return vi.waitFor(() => {
      const tr = useSettingsStore.getState().translate;
      // 老字段保留，v0.7.4 新字段回退默认
      expect(tr.translateBubbleDelayMs).toBe(300);
      expect(tr.aiAssistBubbleHidden).toBe(false);
      expect(tr.aiAssistBubbleEnable).toBe(true);
      expect(tr.aiAssistBubbleDelayMs).toBe(500);
    });
  });
});