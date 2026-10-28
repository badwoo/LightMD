/**
 * v0.15.0 R3c：AI 指令库的**纯操作函数**（增删改/复制/排序/变量展开）。
 *
 * 设计依据 §5.2：
 * - 增删改、复制、排序；
 * - 内建 7 个模板**只读**（可复制成用户指令，不可原地改/删）；
 * - 变量**仅** `{{selection}}` / `{{document}}` 文本替换，不执行代码。
 *
 * 本模块不碰 React/DOM/store，可直接单测。
 */
import type { AiInstruction } from "../../services/aiProfiles";

/** 指令作用域（与 aiProfiles.AiInstruction["scope"] 同源） */
export type AiInstructionScope = AiInstruction["scope"];

/** 允许的变量名（白名单；其他 `{{...}}` 原样保留，绝不执行） */
export const AI_INSTRUCTION_VARIABLES = ["selection", "document"] as const;
export type AiInstructionVariable = (typeof AI_INSTRUCTION_VARIABLES)[number];

/** 变量占位符（`{{selection}}` / `{{document}}`，用于插入按钮与校验） */
export const AI_INSTRUCTION_VARIABLE_TOKENS: Record<AiInstructionVariable, string> = {
  selection: "{{selection}}",
  document: "{{document}}",
};

/** 内建模板（只读；可"复制为我的指令"） */
export interface AiBuiltinInstruction {
  id: string;
  /** 名称 i18n key */
  nameKey: string;
  scope: AiInstructionScope;
  /**
   * 用户模板**正文**（含 `{{selection}}` / `{{document}}` 变量）。
   *
   * ⚠️ 为什么不放进 i18n 字典：项目的 `t()` 只替换**单花括号** `{name}`，
   * 双花括号会被原样渲染成多余花括号（`v0.9.0-shortcuts-review` 有专门断言
   * 禁止 locale 出现双花括号）。而指令模板的变量语法**必须**是双花括号
   * （由 `expandInstructionTemplate` 做字面替换，避免与 `t()` 的占位符语义冲突）。
   * 因此模板正文以常量形式随语言给出，名称/后缀仍走 i18n key。
   */
  userTemplate: { zh: string; en: string };
  /** 附加 system 后缀的 i18n key（可空） */
  systemSuffixKey?: string;
}

/**
 * 7 个内建模板。
 *
 * 为什么放前端常量而不进 Rust：与既有 `utils/aiChatTemplates.ts` 同口径
 * —— 模板是 UI 层产物，点击 chip 只**预填**输入框，不自动发送（设计 §5.2）。
 * 文案全部走 i18n key，中英字典一一对应。
 */
export const AI_BUILTIN_INSTRUCTIONS: readonly AiBuiltinInstruction[] = Object.freeze([
  {
    id: "summarize",
    nameKey: "settings.ai.instruction.builtin.summarize.name",
    scope: "selection",
    userTemplate: { zh: "请用要点形式总结以下内容：{{selection}}", en: "Summarize the following as bullet points: {{selection}}" },
  },
  {
    id: "rewrite",
    nameKey: "settings.ai.instruction.builtin.rewrite.name",
    scope: "selection",
    userTemplate: { zh: "请改写以下内容，保持原意与结构：{{selection}}", en: "Rewrite the following while preserving meaning and structure: {{selection}}" },
  },
  {
    id: "outline",
    nameKey: "settings.ai.instruction.builtin.outline.name",
    scope: "document",
    userTemplate: { zh: "请为下面文档生成 Markdown 目录大纲：{{document}}", en: "Generate a Markdown outline for this document: {{document}}" },
  },
  {
    id: "mermaid",
    nameKey: "settings.ai.instruction.builtin.mermaid.name",
    scope: "document",
    userTemplate: { zh: "请把下面的描述转换成 Mermaid 图表：{{selection}}", en: "Convert the following description into a Mermaid diagram: {{selection}}" },
  },
  {
    id: "formula",
    nameKey: "settings.ai.instruction.builtin.formula.name",
    scope: "selection",
    userTemplate: { zh: "请把下面的描述转换成 LaTeX 公式：{{selection}}", en: "Convert the following description into a LaTeX formula: {{selection}}" },
  },
  {
    id: "frontmatter",
    nameKey: "settings.ai.instruction.builtin.frontmatter.name",
    scope: "document",
    userTemplate: { zh: "请为下面文档生成 YAML Front Matter（标题、标签、摘要）：{{document}}", en: "Generate YAML front matter (title, tags, summary) for this document: {{document}}" },
  },
  {
    id: "proofread",
    nameKey: "settings.ai.instruction.builtin.proofread.name",
    scope: "selection",
    userTemplate: { zh: "请校对以下内容，只输出修改后的文本：{{selection}}", en: "Proofread the following, output only the corrected text: {{selection}}" },
    systemSuffixKey: "settings.ai.instruction.builtin.proofread.systemSuffix",
  },
]);

/** 生成稳定随机 ID（与 aiProfileOps 同口径） */
export function newInstructionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `ins-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 新建用户指令（默认选中「选区」作用域；模板留空等用户填） */
export function createBlankInstruction(name = "", id: string = newInstructionId()): AiInstruction {
  return { id, name, scope: "selection", userTemplate: "", systemSuffix: undefined };
}

/**
 * 从内建模板复制为用户指令。
 *
 * `name` / `userTemplate` / `systemSuffix` 由组件传入**已翻译**的文案
 * （纯函数不依赖 i18n 运行时，测试可直接断言）。
 * 复制出的指令是新 id，与模板无绑定关系 —— 模板始终只读。
 */
export function createInstructionFromBuiltin(
  builtin: AiBuiltinInstruction,
  name: string,
  userTemplate: string,
  systemSuffix?: string,
  id: string = newInstructionId(),
): AiInstruction {
  return {
    id,
    name,
    scope: builtin.scope,
    userTemplate,
    ...(systemSuffix ? { systemSuffix } : {}),
  };
}

/** 复制一条用户指令（新 id；名字由调用方加"副本"后缀） */
export function duplicateInstruction(
  instruction: AiInstruction,
  name: string,
  id: string = newInstructionId(),
): AiInstruction {
  return { ...instruction, id, name };
}

/** 追加指令 */
export function appendInstruction(
  instructions: AiInstruction[],
  instruction: AiInstruction,
): AiInstruction[] {
  return [...instructions, instruction];
}

/**
 * 局部更新指令。
 *
 * 显式清空 `systemSuffix` 时要从对象上**移除**该字段（置 undefined 而非留空串），
 * 否则下游 `instruction.systemSuffix ? ... : ...` 的判空仍会命中空串分支之外的行为差异。
 */
export function updateInstruction(
  instructions: AiInstruction[],
  id: string,
  patch: Partial<AiInstruction>,
): AiInstruction[] {
  return instructions.map((instruction) => {
    if (instruction.id !== id) return instruction;
    const next: AiInstruction = { ...instruction, ...patch, id: instruction.id };
    if ("systemSuffix" in patch && !patch.systemSuffix) delete next.systemSuffix;
    return next;
  });
}

/** 删除指令（不存在时原样返回同一引用，避免无谓重渲染） */
export function removeInstruction(instructions: AiInstruction[], id: string): AiInstruction[] {
  if (!instructions.some((instruction) => instruction.id === id)) return instructions;
  return instructions.filter((instruction) => instruction.id !== id);
}

/** 上移/下移（边界处原样返回同一引用） */
export function moveInstruction(
  instructions: AiInstruction[],
  id: string,
  direction: -1 | 1,
): AiInstruction[] {
  const index = instructions.findIndex((instruction) => instruction.id === id);
  if (index < 0) return instructions;
  const target = index + direction;
  if (target < 0 || target >= instructions.length) return instructions;
  const next = [...instructions];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

/**
 * 列出模板里用到的**已知**变量（白名单内去重，保持 selection→document 顺序）。
 *
 * 用途：编辑器下方提示"本指令可用变量：选区 / 全文"，并给插入按钮。
 */
export function collectUsedVariables(template: string): AiInstructionVariable[] {
  return AI_INSTRUCTION_VARIABLES.filter((name) => template.includes(AI_INSTRUCTION_VARIABLE_TOKENS[name]));
}

/** 最终作用是域的显示名 i18n key（纯函数返回 key，组件自行翻译） */
export function scopeLabelKey(scope: AiInstructionScope): string {
  switch (scope) {
    case "selection":
      return "settings.ai.instruction.scope.selection";
    case "document":
      return "settings.ai.instruction.scope.document";
    default:
      return "settings.ai.instruction.scope.none";
  }
}

/**
 * 展开指令的 userTemplate：只做 `{{selection}}` / `{{document}}` 字面替换。
 *
 * 安全边界（设计 §5.2「不执行代码」）：
 * - 只替换白名单里的两个 token，**其他 `{{任意内容}}` 原样保留**（不报错、不删除、
 *   不做模板引擎求值）—— 用户写 `{{date}}` 就是纯文本 `{{date}}`；
 * - 替换值里的 `$&`、`$1` 等正则替换模式必须当字面量（用函数式 replace 规避，
 *   否则文档里含 `$&` 会被意外吞掉）。
 */
export function expandInstructionTemplate(
  template: string,
  values: Partial<Record<AiInstructionVariable, string>>,
): string {
  let result = template;
  for (const name of AI_INSTRUCTION_VARIABLES) {
    const token = AI_INSTRUCTION_VARIABLE_TOKENS[name];
    if (!result.includes(token)) continue;
    // 函数式 replace：替换值一律按字面量处理，不解释 $ 模式
    result = result.replaceAll(token, () => values[name] ?? "");
  }
  return result;
}

/**
 * 指令名称/模板的轻校验：返回错误码数组（空 = 可保存）。
 *
 * 只校验"能不能用"，不校验内容质量：名称必填；模板必填；模板里若出现
 * `{{...}}` 但不是白名单变量，给出 warning 级提示（不阻止保存，因为
 * 用户可能就是要写字面量 `{{note}}`）。
 */
export type AiInstructionIssue =
  | { level: "error"; code: "name.required" | "template.required" }
  | { level: "warning"; code: "variable.unknown"; variables: string[] };

export function validateInstruction(instruction: AiInstruction): AiInstructionIssue[] {
  const issues: AiInstructionIssue[] = [];
  if (!instruction.name.trim()) issues.push({ level: "error", code: "name.required" });
  if (!instruction.userTemplate.trim()) issues.push({ level: "error", code: "template.required" });
  const unknown = collectUnknownVariables(instruction.userTemplate);
  if (unknown.length > 0) issues.push({ level: "warning", code: "variable.unknown", variables: unknown });
  return issues;
}

/**
 * 模板里出现但不在白名单中的 `{{...}}` 变量名（去重、保出现顺序）。
 *
 * 用于 warning 提示"这些变量不会被替换"，而不是静默当作可替换。
 */
export function collectUnknownVariables(template: string): string[] {
  const found: string[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const name = match[1]!.trim();
    if (!(AI_INSTRUCTION_VARIABLES as readonly string[]).includes(name) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}
