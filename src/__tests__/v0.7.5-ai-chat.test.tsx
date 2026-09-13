/**
 * v0.7.5 功能1/4/5 验证测试：AI 对话浮动窗口
 *
 * 覆盖：
 * - 服务层纯函数：上下文截断（4000/20000）、历史截断（最近 3 轮 + 角色对齐）、
 *   消息组装（上下文只挂当前轮，历史保持裸指令）
 * - sanitizeTranslated 的 mermaid 围栏例外（风险点 1：剥壳会毁掉文生图表）
 * - 窗口几何：默认居中布局、越界钳制
 * - 上下文 chip：三档循环、各状态文案（选区/全文/截断/无/降级）
 * - 快捷指令模板：数量/顺序/默认范围解析
 * - DOC_CHANGED 守卫判定
 * - aiChatStore 状态机与多轮历史（含 meta 与重新生成语义）
 * - AiChatDialog 组件：开关渲染、发送/停止、动作条条件渲染、Esc 关闭
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  MAX_CHAT_DOCUMENT_CHARS,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CHAT_SELECTION_CHARS,
  buildChatRequestMessages,
  chatContextLimit,
  hasUsableContext,
  trimChatHistory,
  truncateChatContext,
  type AiChatMessage,
} from "../services/aiChatService";
import { sanitizeTranslated } from "../services/translateBridge";
import { markdownToDoc } from "../core/markdown/parser";
import { useAiChatStore } from "../stores/aiChatStore";
import {
  AiChatDialog,
  chatContextChipText,
  clampChatRect,
  computeDefaultChatRect,
  nextChatScope,
} from "../components/editor/AiChatDialog";
import { AI_CHAT_TEMPLATES, resolveTemplateScope } from "../utils/aiChatTemplates";
import { canReplaceDocument, isPmSelectionSnapshotValid, isSourceSelectionSnapshotValid } from "../components/editor/EditorContainer";
import { t } from "../i18n";
import type { TranslateResultData } from "../stores/translateStore";

const RESULT: TranslateResultData = {
  translated: "| 列1 | 列2 |",
  placeholdersIntact: true,
  finishReason: "stop",
  promptTokens: 12,
  completionTokens: 8,
};

const VP = { width: 1200, height: 800 };

function msg(role: "user" | "assistant", content: string): AiChatMessage {
  return { role, content };
}

beforeEach(() => {
  useAiChatStore.getState().closeWindow();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// ─── 上下文策略（功能4）──────────────────────────────────

describe("v0.7.5 功能4：上下文策略与截断", () => {
  it("各范围上限：选区 4000 / 全文 20000 / 无 0", () => {
    expect(chatContextLimit("selection")).toBe(4000);
    expect(chatContextLimit("document")).toBe(20000);
    expect(chatContextLimit("none")).toBe(0);
    expect(MAX_CHAT_SELECTION_CHARS).toBe(4000);
    expect(MAX_CHAT_DOCUMENT_CHARS).toBe(20000);
  });

  it("truncateChatContext：未超限原样返回；超限截断并标记 truncated", () => {
    const short = "短文本";
    expect(truncateChatContext(short, "selection")).toEqual({ text: short, truncated: false });

    const long = "字".repeat(MAX_CHAT_SELECTION_CHARS + 50);
    const cut = truncateChatContext(long, "selection");
    expect(cut.truncated).toBe(true);
    expect(Array.from(cut.text).length).toBe(MAX_CHAT_SELECTION_CHARS);

    const doc = "a".repeat(MAX_CHAT_DOCUMENT_CHARS + 1);
    expect(truncateChatContext(doc, "document").truncated).toBe(true);
    // 无上下文：一律空
    expect(truncateChatContext(long, "none")).toEqual({ text: "", truncated: false });
  });

  it("truncateChatContext：按字符（码点）截断，不切坏代理对", () => {
    const emoji = "😀".repeat(MAX_CHAT_SELECTION_CHARS + 10);
    const cut = truncateChatContext(emoji, "selection");
    expect(Array.from(cut.text).length).toBe(MAX_CHAT_SELECTION_CHARS);
    // 末位仍是完整 emoji（长度 2 个 UTF-16 码元）
    expect(cut.text.endsWith("😀")).toBe(true);
  });

  it("hasUsableContext：null/undefined/纯空白均视为无上下文", () => {
    expect(hasUsableContext("abc")).toBe(true);
    expect(hasUsableContext("  \n ")).toBe(false);
    expect(hasUsableContext("")).toBe(false);
    expect(hasUsableContext(null)).toBe(false);
    expect(hasUsableContext(undefined)).toBe(false);
  });
});

// ─── 历史截断与消息组装 ──────────────────────────────────

describe("v0.7.5 功能1：历史截断与消息组装", () => {
  it("MAX_CHAT_HISTORY_MESSAGES = 6（最近 3 轮）", () => {
    expect(MAX_CHAT_HISTORY_MESSAGES).toBe(6);
  });

  it("trimChatHistory：未超限全部保留；超限只留最近 6 条", () => {
    const three = [msg("user", "1"), msg("assistant", "1a"), msg("user", "2")];
    expect(trimChatHistory(three)).toEqual(three);

    // 8 条（4 轮）→ 保留最近 6 条（即第 3~8 条）
    const eight: AiChatMessage[] = [];
    for (let i = 1; i <= 4; i++) {
      eight.push(msg("user", `u${i}`), msg("assistant", `a${i}`));
    }
    const trimmed = trimChatHistory(eight);
    expect(trimmed).toHaveLength(6);
    expect(trimmed[0]).toEqual(msg("user", "u2"));
    expect(trimmed[5]).toEqual(msg("assistant", "a4"));
  });

  it("trimChatHistory：截断后若首条是 assistant 则丢弃（历史必须以 user 开头）", () => {
    // 7 条：u1 a1 u2 a2 u3 a3 u4 → 尾部 6 条以 a1 开头 → 丢弃 a1 后为 5 条
    const seven: AiChatMessage[] = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "u3"),
      msg("assistant", "a3"),
      msg("user", "u4"),
    ];
    const trimmed = trimChatHistory(seven);
    expect(trimmed[0].role).toBe("user");
    expect(trimmed).toHaveLength(5);
  });

  it("trimChatHistory：剥离 UI 元信息（只保留 role/content 进 IPC 载荷）", () => {
    const withMeta = [
      { role: "user" as const, content: "指令", meta: { hadSelection: true, scope: "selection" as const, templateId: null } },
    ];
    const [only] = trimChatHistory(withMeta);
    expect(Object.keys(only).sort()).toEqual(["content", "role"]);
  });

  it("buildChatRequestMessages：上下文挂在当前 user 消息上，历史保持裸指令", () => {
    const history = [msg("user", "总结这段"), msg("assistant", "这是一段总结")];
    const out = buildChatRequestMessages(history, "压缩成一句话", {
      text: "文档正文",
      truncated: false,
    });
    expect(out).toHaveLength(3);
    // 历史原样（裸指令，不带上下文）
    expect(out[0]).toEqual(msg("user", "总结这段"));
    expect(out[1]).toEqual(msg("assistant", "这是一段总结"));
    // 当前轮 = 指令 + 上下文标记 + 正文
    expect(out[2].role).toBe("user");
    expect(out[2].content).toContain("压缩成一句话");
    expect(out[2].content).toContain("【上下文】");
    expect(out[2].content).toContain("文档正文");
    // 历史里不得重复出现上下文（token 控制的关键）
    expect(out.filter((m) => m.content.includes("文档正文"))).toHaveLength(1);
  });

  it("buildChatRequestMessages：无上下文时只发指令本身", () => {
    const out = buildChatRequestMessages([], "生成一个流程图", { text: "", truncated: false });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(msg("user", "生成一个流程图"));
    expect(out[0].content).not.toContain("【上下文】");
  });

  it("buildChatRequestMessages：多轮时自动应用历史截断", () => {
    const history: AiChatMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      history.push(msg("user", `u${i}`), msg("assistant", `a${i}`));
    }
    const out = buildChatRequestMessages(history, "再来", { text: "", truncated: false });
    // 最多 6 条历史 + 1 条当前
    expect(out).toHaveLength(MAX_CHAT_HISTORY_MESSAGES + 1);
    expect(out[out.length - 1].content).toBe("再来");
  });
});

// ─── sanitizeTranslated mermaid 例外（风险点 1）────────────

describe("v0.7.5 风险点1：sanitizeTranslated 与 mermaid 围栏", () => {
  it("```mermaid 整段围栏必须原样保留（剥壳会破坏文生图表）", () => {
    const mermaid = "```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```";
    expect(sanitizeTranslated(mermaid)).toBe(mermaid);
  });

  it("带其它语言的整段围栏仍按原语义剥壳", () => {
    expect(sanitizeTranslated("```markdown\n你好世界\n```")).toBe("你好世界");
    expect(sanitizeTranslated("```\n你好世界\n```")).toBe("你好世界");
  });

  it("Mermaid（大小写不敏感）同样保留", () => {
    const m = "```Mermaid\nsequenceDiagram\n  A->>B: hi\n```";
    expect(sanitizeTranslated(m)).toBe(m);
  });

  it("$$ 公式块不受围栏剥壳影响（原样）", () => {
    const f = "$$\nE = mc^2\n$$";
    expect(sanitizeTranslated(f)).toBe(f);
  });

  it("客套前后缀清洗不受影响（回归）", () => {
    expect(sanitizeTranslated("以下是翻译：你好世界")).toBe("你好世界");
  });
});

// ─── 插入即所见闭环（本功能差异化核心）─────────────────────

describe("v0.7.5 插入即所见：AI 输出的围栏进入既有渲染管线", () => {
  it("mermaid 围栏经 markdownToDoc 解析为 mermaid_block 节点（无需额外渲染代码）", () => {
    const md = sanitizeTranslated("```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```");
    const doc = markdownToDoc(md);
    const nodeNames: string[] = [];
    doc.descendants((node) => {
      nodeNames.push(node.type.name);
      return true;
    });
    expect(nodeNames).toContain("mermaid_block");
    // 图表源码必须完整保留（剥壳/丢内容都会让图表渲染失败）
    const block = doc.firstChild!;
    expect(block.textContent).toContain("flowchart TD");
    expect(block.textContent).toContain("A[开始] --> B[结束]");
  });

  it("$$ 块级公式经 markdownToDoc 解析为 math_block 节点", () => {
    const doc = markdownToDoc(sanitizeTranslated("$$\nE = mc^2\n$$"));
    const nodeNames: string[] = [];
    doc.descendants((node) => {
      nodeNames.push(node.type.name);
      return true;
    });
    expect(nodeNames).toContain("math_block");
  });
});

// ─── 窗口几何 ────────────────────────────────────────────

describe("v0.7.5 功能1/6：对话窗几何", () => {
  it("computeDefaultChatRect：560×480，水平居中、垂直 12%", () => {
    expect(computeDefaultChatRect(VP)).toEqual({
      x: Math.round((1200 - 560) / 2),
      y: Math.round(800 * 0.12),
      w: 560,
      h: 480,
    });
  });

  it("computeDefaultChatRect：小视口下收缩到视口内（但不小于最小值）", () => {
    const r = computeDefaultChatRect({ width: 400, height: 300 });
    expect(r.w).toBeLessThanOrEqual(400 - 24);
    // 高度受最小高度约束（280）：视口 - 24 = 276 < 280，故保持最小高度
    expect(r.h).toBe(Math.max(280, Math.min(480, 300 - 24)));
    expect(r.x).toBeGreaterThanOrEqual(8);
    expect(r.y).toBeGreaterThanOrEqual(8);
  });

  it("clampChatRect：尺寸钳制到 [min, 视口-8]", () => {
    expect(clampChatRect({ x: 0, y: 0, w: 100, h: 50 }, VP)).toMatchObject({ w: 360, h: 280 });
    expect(clampChatRect({ x: 0, y: 0, w: 5000, h: 5000 }, VP)).toMatchObject({
      w: VP.width - 8,
      h: VP.height - 8,
    });
  });

  it("clampChatRect：v0.7.5 优化5 起位置完全自由（不再钳制到视口内）", () => {
    // 位置原样保留——用户可把窗口拖到屏幕任意位置（含视口外）
    const far = clampChatRect({ x: -2000, y: -1500, w: 560, h: 480 }, VP);
    expect(far.x).toBe(-2000);
    expect(far.y).toBe(-1500);
    const beyond = clampChatRect({ x: 5000, y: 5000, w: 560, h: 480 }, VP);
    expect(beyond.x).toBe(5000);
    expect(beyond.y).toBe(5000);
    // 尺寸仍受钳制（避免缩放到 0 / 撑出无意义巨框）
    expect(clampChatRect({ x: 0, y: 0, w: 5000, h: 5000 }, VP)).toMatchObject({
      w: VP.width - 8,
      h: VP.height - 8,
    });
  });
});

// ─── 上下文 chip ─────────────────────────────────────────

describe("v0.7.5 功能4：上下文 chip 文案与切换", () => {
  it("nextChatScope：selection → document → none → selection（有选区时回到选区）", () => {
    expect(nextChatScope("selection", true)).toBe("document");
    expect(nextChatScope("document", true)).toBe("none");
    expect(nextChatScope("none", true)).toBe("selection");
  });

  it("nextChatScope：无选区时跳过「选区」档", () => {
    expect(nextChatScope("none", false)).toBe("document");
    expect(nextChatScope("document", false)).toBe("none");
  });

  it("chatContextChipText：各状态文案（含千分位与截断/降级说明）", () => {
    expect(
      chatContextChipText({ scope: "selection", actualScope: "selection", chars: 128, truncated: false, degraded: false }, t)
    ).toContain("128");
    expect(
      chatContextChipText({ scope: "document", actualScope: "document", chars: 5231, truncated: false, degraded: false }, t)
    ).toBe(t("ai.chat.ctx.document", { count: (5231).toLocaleString() }));
    const truncated = chatContextChipText(
      { scope: "document", actualScope: "document", chars: 38000, truncated: true, degraded: false },
      t
    );
    expect(truncated).toContain((38000).toLocaleString());
    expect(truncated).toContain((MAX_CHAT_DOCUMENT_CHARS).toLocaleString());
    expect(chatContextChipText({ scope: "none", actualScope: "none", chars: 0, truncated: false, degraded: false }, t)).toBe(
      t("ai.chat.ctx.none")
    );
    expect(chatContextChipText(null, t)).toBe(t("ai.chat.ctx.none"));
    // 选区丢失降级：明示改用全文
    const degraded = chatContextChipText(
      { scope: "selection", actualScope: "document", chars: 300, truncated: false, degraded: true },
      t
    );
    expect(degraded).toBe(t("ai.chat.ctx.degraded", { count: "300" }));
  });
});

// ─── 快捷指令模板 ────────────────────────────────────────

describe("v0.7.5 功能4：快捷指令模板", () => {
  it("7 条模板（§2.6 六条 + v0.7.5 优化4 的 AI翻译），文案 key 均可翻译", () => {
    expect(AI_CHAT_TEMPLATES).toHaveLength(7);
    expect(AI_CHAT_TEMPLATES.map((x) => x.id)).toEqual([
      "mermaid",
      "formula",
      "summary",
      "translate",
      "frontmatter",
      "rewrite",
      "analyze",
    ]);
    for (const tpl of AI_CHAT_TEMPLATES) {
      expect(t(tpl.labelKey)).not.toBe(tpl.labelKey);
      expect(t(tpl.instructionKey)).not.toBe(tpl.instructionKey);
      expect(t(tpl.instructionKey).length).toBeGreaterThan(5);
      if (tpl.instructionAutoKey) {
        expect(t(tpl.instructionAutoKey)).not.toBe(tpl.instructionAutoKey);
      }
    }
  });

  it("resolveTemplateScope：偏选区的模板在有选区时用选区，否则用模板默认", () => {
    const mermaid = AI_CHAT_TEMPLATES.find((x) => x.id === "mermaid")!;
    expect(resolveTemplateScope(mermaid, true, "document")).toBe("selection");
    expect(resolveTemplateScope(mermaid, false, "document")).toBe("document");
    const formula = AI_CHAT_TEMPLATES.find((x) => x.id === "formula")!;
    // 公式：无选区时不需要整篇文档（省 token）
    expect(resolveTemplateScope(formula, false, "document")).toBe("none");
  });

  it("resolveTemplateScope：不偏好选区的模板强制全文（改写全文/标题标签/分析）", () => {
    for (const id of ["rewrite", "frontmatter", "analyze"]) {
      const tpl = AI_CHAT_TEMPLATES.find((x) => x.id === id)!;
      expect(resolveTemplateScope(tpl, true, "selection")).toBe("document");
    }
  });
});

// ─── DOC_CHANGED 守卫 ───────────────────────────────────

describe("v0.7.5 功能5：替换全文 DOC_CHANGED 守卫", () => {
  it("当前全文与发送时快照一致 → 允许替换", () => {
    expect(canReplaceDocument("# A\n\n正文", "# A\n\n正文")).toBe(true);
  });

  it("文档被编辑过（哪怕一个字符）→ 拒绝替换", () => {
    expect(canReplaceDocument("# A\n\n正文！", "# A\n\n正文")).toBe(false);
  });

  it("读取失败（null）→ 拒绝替换", () => {
    expect(canReplaceDocument(null, "# A")).toBe(false);
  });
});

describe("v0.7.5 功能5：替换选区的发送时快照有效性（防错位回写）", () => {
  it("PM 通道：doc 引用未变 → 有效；引用变化（文档被编辑）→ 无效", () => {
    const doc = markdownToDoc("# A\n\n正文");
    const edited = markdownToDoc("# A\n\n正文改");
    expect(isPmSelectionSnapshotValid(doc, doc)).toBe(true);
    expect(isPmSelectionSnapshotValid(doc, edited)).toBe(false);
    // 快照缺失（未记录）→ 一律无效，不允许退化用"当前选区"
    expect(isPmSelectionSnapshotValid(undefined, doc)).toBe(false);
    expect(isPmSelectionSnapshotValid(undefined, undefined)).toBe(false);
  });

  it("source 通道：全文逐字未变 → 有效；任一字符变化 → 无效", () => {
    expect(isSourceSelectionSnapshotValid("abc", "abc")).toBe(true);
    expect(isSourceSelectionSnapshotValid("abc", "abC")).toBe(false);
    expect(isSourceSelectionSnapshotValid("abc", "abcd")).toBe(false);
    expect(isSourceSelectionSnapshotValid(undefined, "abc")).toBe(false);
  });
});

// ─── Store 状态机 ───────────────────────────────────────

describe("v0.7.5 功能1：aiChatStore 状态机与多轮历史", () => {
  it("openWindow：开启并重置会话（关闭重开后历史清空）", () => {
    const s = useAiChatStore.getState();
    s.openWindow("C:/a.md", { x: 10, y: 10, w: 560, h: 480 }, "selection");
    let st = useAiChatStore.getState();
    expect(st.open).toBe(true);
    expect(st.minimized).toBe(false);
    expect(st.messages).toEqual([]);
    expect(st.contextScope).toBe("selection");
    expect(st.filePath).toBe("C:/a.md");

    st.appendUser("指令", { hadSelection: true, scope: "selection", templateId: "mermaid" });
    st.appendChunk("部分");
    useAiChatStore.getState().closeWindow();
    st = useAiChatStore.getState();
    expect(st.open).toBe(false);
    expect(st.messages).toEqual([]);
    expect(st.streamedText).toBe("");

    // 重开：历史已清空（v0.7.5 不持久化对话）
    useAiChatStore.getState().openWindow(null, null);
    expect(useAiChatStore.getState().messages).toEqual([]);
  });

  it("appendUser → appendChunk → finish：流式文本并入历史并携带 meta", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null);
    s.appendUser("画个流程图", { hadSelection: true, scope: "selection", templateId: "mermaid" });
    expect(useAiChatStore.getState().status).toBe("loading");
    useAiChatStore.getState().appendChunk("```mermaid");
    expect(useAiChatStore.getState().status).toBe("streaming");
    useAiChatStore.getState().appendChunk("\nA-->B\n```");
    expect(useAiChatStore.getState().streamedText).toBe("```mermaid\nA-->B\n```");

    useAiChatStore.getState().finish(RESULT);
    const st = useAiChatStore.getState();
    expect(st.status).toBe("done");
    expect(st.streamedText).toBe("");
    expect(st.messages).toHaveLength(2);
    expect(st.messages[0]).toMatchObject({ role: "user", content: "画个流程图" });
    expect(st.messages[1]).toMatchObject({ role: "assistant", content: RESULT.translated });
    // assistant 消息继承本轮的生成元信息（动作条条件渲染依据）
    expect(st.messages[1].meta).toEqual({
      hadSelection: true,
      scope: "selection",
      templateId: "mermaid",
    });
  });

  it("fail：错误码进入 error 态且半截流式文本丢弃", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null);
    s.appendUser("x");
    useAiChatStore.getState().appendChunk("半截");
    useAiChatStore.getState().fail("RATE", "too many");
    const st = useAiChatStore.getState();
    expect(st.status).toBe("error");
    expect(st.errorCode).toBe("RATE");
    expect(st.errorDetail).toBe("too many");
    expect(st.streamedText).toBe("");
    // 失败的回答不入历史
    expect(st.messages).toHaveLength(1);
  });

  it("cancelStream：回到 idle 且半截回答不入历史（避免污染下一轮上下文）", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null);
    s.appendUser("x");
    useAiChatStore.getState().appendChunk("半截回答");
    useAiChatStore.getState().cancelStream();
    const st = useAiChatStore.getState();
    expect(st.status).toBe("idle");
    expect(st.streamedText).toBe("");
    expect(st.messages).toEqual([{ role: "user", content: "x" }]);
  });

  it("regenerateContext：返回最后一条 user 之前的历史与该指令", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null);
    s.appendUser("第一问");
    useAiChatStore.getState().finish({ ...RESULT, translated: "第一答" });
    s.appendUser("第二问");
    useAiChatStore.getState().finish({ ...RESULT, translated: "第二答" });

    const ctx = useAiChatStore.getState().regenerateContext()!;
    expect(ctx.instruction).toBe("第二问");
    expect(ctx.history.map((m) => m.content)).toEqual(["第一问", "第一答"]);
    // 重新生成语义：裁到 history 后由 appendUser 重新加入该指令，
    // 保证 request = history + [指令]（不会重复出现两次同一指令）
    useAiChatStore.getState().setMessages(ctx.history);
    useAiChatStore
      .getState()
      .appendUser(ctx.instruction, { hadSelection: false, scope: "document", templateId: null });
    const rebuilt = buildChatRequestMessages(
      useAiChatStore.getState().messages.slice(0, -1),
      ctx.instruction,
      { text: "", truncated: false }
    );
    expect(rebuilt.map((m) => m.content)).toEqual(["第一问", "第一答", "第二问"]);
  });

  it("regenerateContext：无 user 消息时返回 null", () => {
    useAiChatStore.getState().openWindow(null, null);
    expect(useAiChatStore.getState().regenerateContext()).toBeNull();
  });

  it("toggleMinimize：折叠/展开切换（折叠不取消任务）", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null);
    s.appendUser("x");
    useAiChatStore.getState().appendChunk("流式中");
    useAiChatStore.getState().toggleMinimize();
    const st = useAiChatStore.getState();
    expect(st.minimized).toBe(true);
    // 任务状态不因折叠而改变
    expect(st.status).toBe("streaming");
    expect(st.streamedText).toBe("流式中");
  });
});

// ─── 组件 ───────────────────────────────────────────────

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
  const utils = render(React.createElement(AiChatDialog, handlers as never));
  return { handlers, ...utils };
}

describe("v0.7.5 功能1：AiChatDialog 组件", () => {
  it("未打开时不渲染任何窗口 DOM", () => {
    renderDialog();
    expect(screen.queryByTestId("ai-chat-dialog")).toBeNull();
  });

  it("打开后渲染标题栏/上下文 chip/模板/输入区/缩放手柄", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    renderDialog();
    expect(screen.getByTestId("ai-chat-dialog")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-context-chip")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-input")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-resize")).toBeTruthy();
    expect(screen.getByTestId("ai-chat-send")).toBeTruthy();
    for (const tpl of AI_CHAT_TEMPLATES) {
      expect(screen.getByTestId(`ai-chat-tpl-${tpl.id}`)).toBeTruthy();
    }
  });

  it("输入指令后 Enter 触发 onSend（携带当前模板 id）", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    const input = screen.getByTestId("ai-chat-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "把这段改成表格" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onSend).toHaveBeenCalledWith("把这段改成表格", null);
    // 发送后输入框清空
    expect((screen.getByTestId("ai-chat-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("Shift+Enter 不发送（允许换行）", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    const input = screen.getByTestId("ai-chat-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("空指令不发送（发送按钮禁用）", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    expect((screen.getByTestId("ai-chat-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("ai-chat-send"));
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("点击模板 chip 预填输入框（不直接发送）并切换上下文范围", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    fireEvent.click(screen.getByTestId("ai-chat-tpl-rewrite"));
    const input = screen.getByTestId("ai-chat-input") as HTMLTextAreaElement;
    expect(input.value).toBe(t("ai.chat.tpl.rewrite.prompt"));
    expect(handlers.onSend).not.toHaveBeenCalled();
    // 改写全文默认全文（当前已是 document，不重复派发）
    expect(handlers.onScopeChange).not.toHaveBeenCalled();

    // 生成公式：默认无上下文 → 从 document 切到 none
    fireEvent.click(screen.getByTestId("ai-chat-tpl-formula"));
    expect(handlers.onScopeChange).toHaveBeenCalledWith("none");
  });

  it("上下文 chip 点击 → 按循环顺序请求切换范围", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    fireEvent.click(screen.getByTestId("ai-chat-context-chip"));
    expect(handlers.onScopeChange).toHaveBeenCalledWith("none");
  });

  it("流式中显示「停止」按钮，点击触发 onStop", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    s.appendUser("x");
    useAiChatStore.getState().appendChunk("生成中");
    const { handlers } = renderDialog();
    expect(screen.queryByTestId("ai-chat-send")).toBeNull();
    fireEvent.click(screen.getByTestId("ai-chat-stop"));
    expect(handlers.onStop).toHaveBeenCalled();
  });

  it("动作条：总是有插入/复制；有选区时额外「替换选区」；仅「改写全文」模板显示「替换全文」", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "selection");
    // 第一条：带选区 + 非 rewrite 模板
    s.appendUser("画图", { hadSelection: true, scope: "selection", templateId: "mermaid" });
    useAiChatStore.getState().finish({ ...RESULT, translated: "A" });
    // 第二条：全文 + rewrite 模板
    s.appendUser("改写", { hadSelection: false, scope: "document", templateId: "rewrite" });
    useAiChatStore.getState().finish({ ...RESULT, translated: "B" });
    renderDialog();

    const first = screen.getByTestId("ai-chat-msg-assistant-1");
    expect(first.querySelector('[data-action="insert"]')).toBeTruthy();
    expect(first.querySelector('[data-action="copy"]')).toBeTruthy();
    expect(first.querySelector('[data-action="replace-selection"]')).toBeTruthy();
    expect(first.querySelector('[data-action="replace-document"]')).toBeNull();
    // 非最后一条 → 无「重新生成」
    expect(first.querySelector('[data-action="regenerate"]')).toBeNull();

    const second = screen.getByTestId("ai-chat-msg-assistant-3");
    expect(second.querySelector('[data-action="replace-selection"]')).toBeNull();
    expect(second.querySelector('[data-action="replace-document"]')).toBeTruthy();
    // 最后一条 → 有「重新生成」
    expect(second.querySelector('[data-action="regenerate"]')).toBeTruthy();
  });

  it("动作条按钮把该条回答文本交给对应回写回调", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    s.appendUser("改写", { hadSelection: false, scope: "document", templateId: "rewrite" });
    useAiChatStore.getState().finish({ ...RESULT, translated: "改写后的全文" });
    const { handlers } = renderDialog();

    fireEvent.click(screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="insert"]')!);
    expect(handlers.onInsertAtCursor).toHaveBeenCalledWith("改写后的全文");
    fireEvent.click(
      screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="replace-document"]')!
    );
    expect(handlers.onReplaceDocument).toHaveBeenCalledWith("改写后的全文");
    fireEvent.click(screen.getByTestId("ai-chat-msg-assistant-1").querySelector('[data-action="regenerate"]')!);
    expect(handlers.onRegenerate).toHaveBeenCalled();
  });

  it("错误态渲染错误码文案与详情，并提供「重试」（复用上一条指令重发）", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    s.appendUser("x");
    useAiChatStore.getState().fail("RATE", "429 from provider");
    const { handlers } = renderDialog();
    const err = screen.getByTestId("ai-chat-error");
    expect(err.textContent).toContain(t("translate.error.RATE"));
    expect(err.textContent).toContain("429 from provider");
    fireEvent.click(screen.getByTestId("ai-chat-error-retry"));
    expect(handlers.onRegenerate).toHaveBeenCalled();
  });

  it("错误态但无任何用户指令时不显示「重试」（无指令可复用）", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    useAiChatStore.getState().fail("NETWORK", null);
    renderDialog();
    expect(screen.getByTestId("ai-chat-error")).toBeTruthy();
    expect(screen.queryByTestId("ai-chat-error-retry")).toBeNull();
  });

  it("Esc 关闭：流式中先 onStop 再关闭窗口", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    s.appendUser("x");
    useAiChatStore.getState().appendChunk("生成中");
    const { handlers } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onStop).toHaveBeenCalled();
    expect(useAiChatStore.getState().open).toBe(false);
  });

  it("点击 [×] 关闭窗口（非流式不调用 onStop）", () => {
    useAiChatStore.getState().openWindow(null, null, "document");
    const { handlers } = renderDialog();
    fireEvent.click(screen.getByTestId("ai-chat-close"));
    expect(useAiChatStore.getState().open).toBe(false);
    expect(handlers.onStop).not.toHaveBeenCalled();
  });

  it("折叠态只保留输入条（标题栏 + 输入区，无消息区/模板区）", () => {
    const s = useAiChatStore.getState();
    s.openWindow(null, null, "document");
    s.appendUser("x");
    useAiChatStore.getState().appendChunk("生成中");
    renderDialog();
    fireEvent.click(screen.getByTestId("ai-chat-minimize"));
    expect(screen.queryByTestId("ai-chat-body")).toBeNull();
    expect(screen.queryByTestId("ai-chat-templates")).toBeNull();
    expect(screen.getByTestId("ai-chat-input")).toBeTruthy();
    // 折叠不取消任务：仍显示停止按钮
    expect(screen.getByTestId("ai-chat-stop")).toBeTruthy();
  });
});
