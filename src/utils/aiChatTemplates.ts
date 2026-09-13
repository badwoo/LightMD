/**
 * aiChatTemplates —— AI 对话快捷指令模板（v0.7.5 功能4）
 *
 * 设计要点：
 * - 模板只放前端（不进 Rust）：模板是 UI 层产物，便于后续做用户自定义（v0.7.6 F7）
 * - 点击 chip **只预填输入框**，不直接发送——用户可先编辑再发（避免误发长上下文）
 * - 每条模板带默认上下文范围：选中「改写全文」时自动切到「全文」，
 *   选中「生成公式」时若当前无选区则回落「无上下文」
 * - 文案全部走 i18n key（labelKey 为 chip 显示名，instructionKey 为预填指令），
 *   中英字典一一对应
 */
import type { AiChatContextScope } from "../services/aiChatService";

export interface AiChatTemplate {
  /** 稳定标识（测试定位 data-template） */
  id: string;
  /** chip 文案 i18n key */
  labelKey: string;
  /** 预填指令 i18n key */
  instructionKey: string;
  /** 点击时的默认上下文范围 */
  defaultScope: AiChatContextScope;
  /**
   * 有选区时优先用选区（否则用 defaultScope）。
   * 例：生成图表「选区/全文」→ true；改写全文「全文」→ false。
   */
  preferSelection?: boolean;
  /**
   * v0.7.5 优化4：指令含 {target} 占位，需用当前设置的"目标语言"填充。
   * 目标语言为 auto 时改用 instructionAutoKey（中英互译表述）。
   */
  needsTargetLang?: boolean;
  /** 目标语言为 auto 时使用的预填指令 i18n key（仅 needsTargetLang 模板需要） */
  instructionAutoKey?: string;
}

/**
 * 快捷指令模板（顺序即 chip 渲染顺序，按高频优先）
 *
 * 与 §2.6 表格一一对应，另加 v0.7.5 优化4 的「AI翻译」：
 * 生成图表 / 生成公式 / 生成摘要 / AI翻译 / 标题与标签 / 改写全文 / 分析文档
 */
export const AI_CHAT_TEMPLATES: readonly AiChatTemplate[] = Object.freeze([
  {
    id: "mermaid",
    labelKey: "ai.chat.tpl.mermaid",
    instructionKey: "ai.chat.tpl.mermaid.prompt",
    defaultScope: "document",
    preferSelection: true,
  },
  {
    id: "formula",
    labelKey: "ai.chat.tpl.formula",
    instructionKey: "ai.chat.tpl.formula.prompt",
    // 公式描述通常就是选中的一小段；无选区时不需要整篇文档（省 token）
    defaultScope: "none",
    preferSelection: true,
  },
  {
    id: "summary",
    labelKey: "ai.chat.tpl.summary",
    instructionKey: "ai.chat.tpl.summary.prompt",
    defaultScope: "document",
    preferSelection: true,
  },
  {
    // v0.7.5 优化4：AI 翻译——通过选区打开对话窗时，点击该指令即翻译选区文字；
    // 目标语言取自翻译设置（auto → 中英互译表述）
    id: "translate",
    labelKey: "ai.chat.tpl.translate",
    instructionKey: "ai.chat.tpl.translate.prompt",
    instructionAutoKey: "ai.chat.tpl.translate.promptAuto",
    needsTargetLang: true,
    defaultScope: "document",
    preferSelection: true,
  },
  {
    id: "frontmatter",
    labelKey: "ai.chat.tpl.frontmatter",
    instructionKey: "ai.chat.tpl.frontmatter.prompt",
    defaultScope: "document",
    preferSelection: false,
  },
  {
    id: "rewrite",
    labelKey: "ai.chat.tpl.rewrite",
    instructionKey: "ai.chat.tpl.rewrite.prompt",
    defaultScope: "document",
    preferSelection: false,
  },
  {
    id: "analyze",
    labelKey: "ai.chat.tpl.analyze",
    instructionKey: "ai.chat.tpl.analyze.prompt",
    defaultScope: "document",
    preferSelection: false,
  },
]);

/**
 * 解析模板的预填指令（纯函数，便于单测）
 *
 * @param tpl 模板
 * @param t i18n 翻译函数
 * @param targetLang 当前设置的目标语言（"auto"/空 表示中英互译）
 */
export function resolveTemplateInstruction(
  tpl: AiChatTemplate,
  t: (key: string, params?: Record<string, string | number>) => string,
  targetLang: string
): string {
  if (!tpl.needsTargetLang) return t(tpl.instructionKey);
  const lang = (targetLang ?? "").trim();
  if (!lang || lang.toLowerCase() === "auto") {
    return t(tpl.instructionAutoKey ?? tpl.instructionKey);
  }
  return t(tpl.instructionKey, { target: lang });
}

/**
 * 解析模板的目标上下文范围（纯函数，便于单测）
 *
 * @param tpl 模板
 * @param hasSelection 当前是否存在有效选区
 * @param currentScope 当前范围（模板未指定 preferSelection 时保持用户当前选择）
 */
export function resolveTemplateScope(
  tpl: AiChatTemplate,
  hasSelection: boolean,
  currentScope: AiChatContextScope
): AiChatContextScope {
  if (tpl.preferSelection) {
    return hasSelection ? "selection" : tpl.defaultScope === "selection" ? "document" : tpl.defaultScope;
  }
  // 明确要求全文/无上下文的模板：直接采用模板默认
  return tpl.defaultScope === "document" ? "document" : tpl.defaultScope ?? currentScope;
}
