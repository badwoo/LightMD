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
import type { AiInstruction } from "../services/aiProfiles";

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

// ═══ v0.15.4 需求7：AI 指令库的应用入口（对话窗第二排 chips + 输入框 `/` 选用）═══
//
// 指令库（设置里的自定义指令）在 0.15.3 之前**没有应用入口**：能配置但不能用。
// 这里把「触发识别 / 列表过滤 / 上下文展开」抽成纯函数，组件只负责渲染与键盘导航。

/** `/` 选用触发点（`start` = `/` 在输入框文本中的下标） */
export interface InstructionTrigger {
  start: number;
  query: string;
}

/**
 * 识别输入框里的 `/` 触发（纯函数，可测试）
 *
 * 规则刻意保守：
 * - 只认**当前 token**（从光标向左到上一个空白）以 `/` 开头，所以 `https://…`
 *   这类中间含 `/` 的文本不会弹菜单（token 不以 `/` 开头）；
 * - 光标右侧即使还有内容也不影响（`/` 之后继续输入会刷新 query）；
 * - 没有 `/` / 光标在 0 / token 为空 → null。
 */
export function findInstructionTrigger(text: string, caret: number = text.length): InstructionTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  if (start >= caret) return null;
  if (text[start] !== "/") return null;
  return { start, query: text.slice(start + 1, caret) };
}

/**
 * 过滤可用的指令（纯函数，可测试）
 *
 * - **只有模板正文非空**的指令可应用（空模板展开后是空串，点了没反应）；
 * - 名称大小写不敏感包含匹配；query 为空 = 全部。
 */
export function filterApplicableInstructions(
  instructions: readonly AiInstruction[],
  query = ""
): AiInstruction[] {
  const usable = instructions.filter((item) => item.userTemplate.trim().length > 0);
  const q = query.trim().toLowerCase();
  if (!q) return usable;
  return usable.filter((item) => item.name.trim().toLowerCase().includes(q));
}

/** 指令作用域 → 上下文范围（两者取值本就是同一三档，这里显式表达"联动"语义） */
export function instructionScopeToContextScope(instruction: AiInstruction): AiChatContextScope {
  return instruction.scope;
}

/**
 * 把指令模板按**当前上下文**展开成可发送的指令文本（纯函数，可测试）
 *
 * 变量只有 `{{selection}}` / `{{document}}`（白名单，见 aiInstructionOps）。
 * 传入的两个值由入口层按对话上下文上限截断（选区 4000 / 全文 20000）后再进来，
 * 避免把整篇长文档塞进输入框。
 */
export function expandChatInstruction(
  instruction: AiInstruction,
  values: { selection: string; document: string },
  expand: (template: string, values: { selection: string; document: string }) => string
): string {
  return expand(instruction.userTemplate, {
    selection: values.selection,
    document: values.document,
  });
}

/**
 * 把 `/` 触发的 token 替换成展开后的指令（纯函数，可测试）
 *
 * @param text  当前输入框全文
 * @param start `/` 的下标（来自 findInstructionTrigger）
 * @param caret 光标位置（替换范围是 [start, caret)）
 * @param replacement 展开后的指令文本
 * @returns 新文本与新光标位置（= start + replacement.length）
 */
export function replaceInstructionTrigger(
  text: string,
  start: number,
  caret: number,
  replacement: string
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(caret, text.length));
  const next = `${text.slice(0, from)}${replacement}${text.slice(to)}`;
  return { text: next, caret: from + replacement.length };
}

/**
 * `/` 选用列表是否应当显示（纯函数，可测试）
 *
 * 三条**不显示**的情形（缺一不可）：
 * 1. 没有 `/` 触发点；
 * 2. 输入法组合态（`isComposing`）——中文输入时 `/` 常作为候选词输入的一部分，
 *    此时弹列表会跟候选窗打架；
 * 3. 过滤后没有可用指令（空指令库 → 不弹空列表）。
 */
export function shouldShowInstructionPalette(
  trigger: InstructionTrigger | null,
  items: readonly AiInstruction[],
  composing = false
): boolean {
  if (composing) return false;
  if (!trigger) return false;
  return items.length > 0;
}

/** 键盘上下移动高亮项（纯函数；越界时钳制在两端，不循环） */
export function movePaletteIndex(current: number, delta: -1 | 1, total: number): number {
  if (total <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= total) return total - 1;
  return next;
}
