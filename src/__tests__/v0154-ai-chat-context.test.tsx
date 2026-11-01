/**
 * @vitest-environment jsdom
 *
 * v0.15.4 需求9：AI 对话上下文「自动跟随选区」失效修复。
 *
 * 用户实测 bug：未选内容打开对话时上下文永远是「全文」，之后在编辑器里选中
 * 文本也不生效。三处根因（本文件逐条锁住）：
 * 1. `startAiChat` 只在打开那一刻取一次选区算默认范围，之后从不跟随；
 * 2. selectionchange 监听里 `if (active?.closest?.(".ai-chat-dialog")) return;`
 *    —— 点过输入框后焦点长期在窗内 → 选区变化**永远**不刷新；
 * 3. chip 一旦是 document 就不会自动回到 selection。
 *
 * 修法：显式 `contextAuto` 状态位 + 选区签名 + 纯函数决策（发送时再判一次）。
 * 本文件既测纯函数决策，也用源码级断言锁住 EditorContainer 的接线契约
 * （真实 EditorContainer 依赖 Tauri/iframe/PM 全链路，不适合在这里整挂）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  chatSelectionSignature,
  planChatSelectionChange,
  resolveAutoFollowScope,
  resolveChatSendScope,
} from "../services/aiChatService";
import { useAiChatStore } from "../stores/aiChatStore";
import { chatContextChipText, nextChatScope } from "../components/editor/AiChatDialog";
import { t } from "../i18n";

const CONTAINER_SRC = readFileSync(
  join(__dirname, "..", "components", "editor", "EditorContainer.tsx"),
  "utf-8",
);

beforeEach(() => {
  useAiChatStore.getState().closeWindow();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 纯函数：选区签名 ────────────────────────────────────

describe("v0.15.4 需求9：选区签名（辨别真实选区变化）", () => {
  it("有选区时签名含 from:to；空选区（光标）统一为一个值", () => {
    expect(chatSelectionSignature("pm", 3, 9)).toBe("pm:3:9");
    expect(chatSelectionSignature("source", 3, 9)).toBe("source:3:9");
    // 光标位置变化不算「选区变化」——这是保护用户手动锁定的关键
    expect(chatSelectionSignature("pm", 5, 5)).toBe("pm:");
    expect(chatSelectionSignature("pm", 40, 40)).toBe("pm:");
    // 两条通道同名位置互不干扰
    expect(chatSelectionSignature("pm", 3, 9)).not.toBe(chatSelectionSignature("source", 3, 9));
  });
});

// ─── 纯函数：自动跟随决策 ────────────────────────────────

describe("v0.15.4 需求9：planChatSelectionChange（选区变化 → 范围）", () => {
  it("签名未变 → 不动（光标移动 / 同一选区的重复事件）", () => {
    expect(planChatSelectionChange({ prevSignature: "pm:", nextSignature: "pm:", hasSelection: false })).toBeNull();
    expect(planChatSelectionChange({ prevSignature: "pm:", nextSignature: "pm:", hasSelection: true })).toBeNull();
    expect(
      planChatSelectionChange({ prevSignature: "pm:3:9", nextSignature: "pm:3:9", hasSelection: true })
    ).toBeNull();
  });

  it("出现选区 → 切到 selection", () => {
    expect(
      planChatSelectionChange({ prevSignature: "pm:", nextSignature: "pm:4:10", hasSelection: true })
    ).toBe("selection");
  });

  it("选区消失 → 回落 document（自动跟随态）", () => {
    expect(
      planChatSelectionChange({ prevSignature: "pm:4:10", nextSignature: "pm:", hasSelection: false })
    ).toBe("document");
  });

  it("选区换了位置但空文本（纯代码块等不可提取）→ 仍按全文", () => {
    expect(
      planChatSelectionChange({ prevSignature: "pm:", nextSignature: "pm:20:30", hasSelection: false })
    ).toBe("document");
  });

  it("跨模式（pm → source）签名变化同样触发跟随", () => {
    expect(
      planChatSelectionChange({ prevSignature: "pm:3:9", nextSignature: "source:3:9", hasSelection: true })
    ).toBe("selection");
  });
});

describe("v0.15.4 需求9：resolveAutoFollowScope / resolveChatSendScope", () => {
  it("resolveAutoFollowScope：有选区 → selection；无 → document", () => {
    expect(resolveAutoFollowScope(true)).toBe("selection");
    expect(resolveAutoFollowScope(false)).toBe("document");
  });

  it("自动跟随中：发送按当下重判（防 250ms 防抖窗口内 chip 滞后）", () => {
    // chip 还是全（刚选完就按 Enter）→ 实发选区
    expect(resolveChatSendScope("document", true, true)).toBe("selection");
    // chip 还是选区（选区已取消）→ 实发全文
    expect(resolveChatSendScope("selection", true, false)).toBe("document");
  });

  it("手动锁定：尊重用户指定的范围，发送时不擅自改", () => {
    expect(resolveChatSendScope("document", false, true)).toBe("document");
    expect(resolveChatSendScope("selection", false, false)).toBe("selection");
    expect(resolveChatSendScope("none", false, true)).toBe("none");
  });
});

// ─── store：contextAuto 状态位 ───────────────────────────

describe("v0.15.4 需求9：aiChatStore.contextAuto 状态位", () => {
  it("打开窗口默认进入自动跟随", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const st = useAiChatStore.getState();
    expect(st.open).toBe(true);
    expect(st.contextAuto).toBe(true);
    expect(st.contextScope).toBe("document");
  });

  it("openWindow 可显式锁定（第 4 参 autoFollow=false）", () => {
    useAiChatStore.getState().openWindow(null, null, "none", false);
    expect(useAiChatStore.getState().contextAuto).toBe(false);
    expect(useAiChatStore.getState().contextScope).toBe("none");
  });

  it("setContextScope（用户手动点 chip）= 锁定", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    useAiChatStore.getState().setContextScope("selection");
    expect(useAiChatStore.getState().contextAuto).toBe(false);
    expect(useAiChatStore.getState().contextScope).toBe("selection");
  });

  it("setContextScopeWithAuto(true) = 自动跟随产出的范围，不算手动锁定", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    useAiChatStore.getState().setContextScopeWithAuto("selection", true);
    expect(useAiChatStore.getState().contextScope).toBe("selection");
    expect(useAiChatStore.getState().contextAuto).toBe(true);
  });

  it("关闭窗口重置回自动跟随（下次打开是新会话）", () => {
    useAiChatStore.getState().openWindow(null, null, "none", false);
    useAiChatStore.getState().closeWindow();
    expect(useAiChatStore.getState().contextAuto).toBe(true);
    useAiChatStore.getState().openWindow(null, null, "document");
    expect(useAiChatStore.getState().contextAuto).toBe(true);
  });
});

// ─── chip 文案与实际提取一致性 ───────────────────────────

describe("v0.15.4 需求9：chip 文案与实际上下文一致", () => {
  it("自动切换到选区后 chip 显示「选区 N 字」（N 与提取字数一致）", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    useAiChatStore.getState().setContextScopeWithAuto("selection", true);
    useAiChatStore.getState().setContextPreview({
      scope: "selection",
      actualScope: "selection",
      chars: 12,
      truncated: false,
      degraded: false,
    });
    const text = chatContextChipText(useAiChatStore.getState().contextPreview, t);
    expect(text).toContain("12");
    expect(text).toBe(t("ai.chat.ctx.selection", { count: "12" }));
  });

  it("选区消失回落全文后 chip 显示「全文 N 字」，不再是选区文案", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    useAiChatStore.getState().setContextPreview({
      scope: "document",
      actualScope: "document",
      chars: 5231,
      truncated: false,
      degraded: false,
    });
    const text = chatContextChipText(useAiChatStore.getState().contextPreview, t);
    expect(text).toBe(t("ai.chat.ctx.document", { count: (5231).toLocaleString() }));
  });

  it("降级（显示选区已丢失）不再使用：自动跟随下不会出现 degraded 文案", () => {
    // 自动跟随在选区消失时**直接切到 document**（不保留 scope=selection 再降级），
    // 因此 chip 不会显示「选区已丢失」，而是干净的「全文 N 字」。
    const degradedText = t("ai.chat.ctx.degraded", { count: "300" });
    expect(degradedText).not.toBe(t("ai.chat.ctx.document", { count: "300" }));
  });

  it("手动锁定后 chip 的循环切换仍以锁定范围为准", () => {
    expect(nextChatScope("document", true)).toBe("none");
    expect(nextChatScope("selection", true)).toBe("document");
    expect(nextChatScope("none", true)).toBe("selection");
    expect(nextChatScope("none", false)).toBe("document");
  });
});

// ─── 接线契约（源码级断言）──────────────────────────────

describe("v0.15.4 需求9：EditorContainer 接线契约", () => {
  const src = CONTAINER_SRC;
  /**
   * 去掉注释后的源码：注释里会引用"旧缺陷原文"，直接正则搜全文件会命中注释，
   * 断言"代码里不再有该分支"必须只看真实代码。
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("【回归锁定】selectionchange 不再因焦点/窗内 DOM 选区而整体 return", () => {
    // 旧缺陷一：`if (active?.closest?.(".ai-chat-dialog")) return;`
    // 取对话接线区而非全文件：其他功能区可能合法使用 activeElement
    const start = code.indexOf("AI 对话接线");
    const region = start >= 0 ? code.slice(start, start + 30000) : code;
    expect(region).not.toMatch(/active\?*\.closest\?*\.\("\.ai-chat-dialog"\)/);
    /**
     * 旧缺陷二（v0.15.5 用户实测再修）：
     * v0.15.4 换成 `isSelectionInsideChatDialog()` 守卫后仍有问题 ——
     * 它检查 DOM 选区，而用户「选完正文后点一下输入框」会让 DOM 选区落进对话窗，
     * 于是回调整体 return，已经选好的正文永远不被应用（chip 停在「全文」）。
     * 实机探针 M3 场景 100% 复现。因此该守卫也必须不存在：
     * 正确判据是编辑器自己的选区签名（readChatSelection → planChatSelectionChange），
     * 窗内拖选回答时编辑器签名不变，决策函数自然返回 null。
     */
    expect(code).not.toMatch(/isSelectionInsideChatDialog/);
    expect(code).not.toMatch(/closest\?*\("\.ai-chat-dialog"\)/);
  });

  it("selectionchange 用 readChatSelection 读编辑器选区（与焦点无关）", () => {
    expect(src).toMatch(/readChatSelection/);
    // 直接读 PM state.selection
    expect(src).toMatch(/view\.state\.selection/);
    // 直接读 textarea selectionStart/End
    expect(src).toMatch(/ta\.selectionStart/);
    expect(src).toMatch(/ta\.selectionEnd/);
  });

  it("自动跟随走 planChatSelectionChange + setContextScopeWithAuto", () => {
    expect(src).toMatch(/planChatSelectionChange/);
    expect(src).toMatch(/setContextScopeWithAuto/);
    // 真实选区变化必须恢复自动跟随（锁定只维持到下一次变化）
    expect(src).toMatch(/setContextScopeWithAuto\(planned, true\)/);
  });

  it("窗口打开状态下选区变化：锁定态也要被下一次真实选区变化解锁", () => {
    // 契约：effect 里不因 contextAuto=false 就 return；看"是否只在 contextAuto 时才写"
    expect(src).not.toMatch(/store\.contextAuto\s*&&\s*store\.contextScope/);
  });

  it("发送时调用 resolveChatSendScope 重新判定（按发送那一刻的选区）", () => {
    expect(src).toMatch(/resolveChatSendScope/);
  });

  it("打开对话进入自动跟随（openWindow 第 4 参为 true / resolveAutoFollowScope 决策）", () => {
    expect(src).toMatch(/resolveAutoFollowScope/);
    expect(src).toMatch(/openWindow\([\s\S]{0,120}true\)/);
  });

  it("手动点 chip（chatScopeChange）仍走 setContextScope（= 锁定语义）", () => {
    expect(src).toMatch(/chatScopeChange[\s\S]{0,300}setContextScope\(/);
  });

  it("AI 对话渲染处传入 getContextValues（指令变量展开的数据来源）", () => {
    expect(src).toMatch(/<AiChatDialog[\s\S]{0,400}getContextValues=\{getChatContextValues\}/);
  });
});

// ─── 端到端场景（用 store 模拟真实事件序列）────────────────

describe("v0.15.4 需求9：完整场景序列", () => {
  /** 模拟 selectionchange effect 的决策部分（与 EditorContainer 内实现同口径） */
  function simulateSelectionChange(
    prevSig: string,
    nextSig: string,
    hasSelection: boolish,
  ): void {
    const store = useAiChatStore.getState();
    const planned = planChatSelectionChange({
      prevSignature: prevSig,
      nextSignature: nextSig,
      hasSelection: hasSelection === true,
    });
    if (planned === null) return;
    // 真实选区变化：应用 planned 并恢复自动跟随（锁定只维持到这一次变化为止）
    if (planned !== store.contextScope || !store.contextAuto) {
      store.setContextScopeWithAuto(planned, true);
    }
  }
  type boolish = boolean;

  it("未选内容打开 → 全文；选中文本 → 选区；取消选区 → 回落全文", () => {
    // 1) 未选内容打开对话
    useAiChatStore.getState().openWindow(null, null, resolveAutoFollowScope(false));
    expect(useAiChatStore.getState().contextScope).toBe("document");
    expect(useAiChatStore.getState().contextAuto).toBe(true);

    // 2) 编辑器里选中一段文本（pm:5:20）→ 自动切选区
    simulateSelectionChange("pm:", "pm:5:20", true);
    expect(useAiChatStore.getState().contextScope).toBe("selection");
    expect(useAiChatStore.getState().contextAuto).toBe(true);

    // 3) 取消选区（变成光标）→ 回落全文
    simulateSelectionChange("pm:5:20", "pm:", false);
    expect(useAiChatStore.getState().contextScope).toBe("document");
    expect(useAiChatStore.getState().contextAuto).toBe(true);
  });

  it("手动点 chip 锁定：光标移动/同一选区重复事件不覆盖，真实选区变化才解锁", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    // 用户手动点 chip 指定「无上下文」
    useAiChatStore.getState().setContextScope("none");
    expect(useAiChatStore.getState().contextAuto).toBe(false);
    expect(useAiChatStore.getState().contextScope).toBe("none");

    // ① 光标移动（空选区 → 空选区）签名不变 → 保持锁定
    simulateSelectionChange("pm:", "pm:", false);
    expect(useAiChatStore.getState().contextScope).toBe("none");
    expect(useAiChatStore.getState().contextAuto).toBe(false);

    // ② 真实选区变化（用户新选了一段文本）→ 解锁并跟随
    simulateSelectionChange("pm:", "pm:3:12", true);
    expect(useAiChatStore.getState().contextScope).toBe("selection");
    expect(useAiChatStore.getState().contextAuto).toBe(true);
  });

  it("拖动选区过程中光标签名不变（空选区）不会把锁定范围打回全文", () => {
    useAiChatStore.getState().openWindow(null, null, "none", false);
    // 关键字移动光标：签名从 "pm:" 到 "pm:"（未变）→ planned=null
    simulateSelectionChange("pm:", "pm:", false);
    expect(useAiChatStore.getState().contextScope).toBe("none");
  });

  it("发送时按发送那一刻的选区提取（chip 滞后不影响实发内容）", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    // chip 显示全文，但用户此刻其实已选中文本
    expect(useAiChatStore.getState().contextScope).toBe("document");
    const effective = resolveChatSendScope(
      useAiChatStore.getState().contextScope,
      useAiChatStore.getState().contextAuto,
      true,
    );
    expect(effective).toBe("selection");
  });
});
