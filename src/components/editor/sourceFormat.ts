/**
 * sourceFormat —— 源码模式格式化纯函数
 *
 * 设计目标：
 * - 所有函数无副作用、无 DOM 依赖，便于单元测试
 * - EditorContainer.tsx 的快捷键与按钮回调复用同一套逻辑
 * - 通过 buildFormatReplacement 统一构造「替换文本 + 光标偏移」结果
 *
 * 涉及场景：
 * - 行内格式包裹：粗体 / 斜体 / 粗斜体 / 删除线 / 行内代码
 * - 行首前缀：标题 H1~H6（已有标题则替换）/ 移除标题（转为段落）
 * - 块级插入：代码块 / 引用 / 列表 / 分割线 / 数学公式 / Mermaid 模板
 */
// v0.9.0 自定义快捷键：源码模式键位解析读生效键位表（默认 + 用户覆盖）
import { matchShortcut, getShortcutLabel } from "../../core/shortcuts";

/** 格式化操作结果：替换文本 + 光标相对选区起点的偏移 */
export interface FormatResult {
  /** 替换选区的文本 */
  replacement: string;
  /** 替换后光标相对原选区起点的偏移量 */
  cursorOffset: number;
}

/**
 * 包裹选中文本：在前后插入成对的标记符号
 * - 有选中文本时：完整包裹，光标移到包裹后末尾
 * - 无选中文本时：插入占位文本，光标移到占位文本之前（便于直接键入替换）
 */
export function wrapSelection(
  selected: string,
  before: string,
  after: string,
  placeholder: string,
): FormatResult {
  if (selected) {
    const replacement = `${before}${selected}${after}`;
    return { replacement, cursorOffset: replacement.length };
  }
  const replacement = `${before}${placeholder}${after}`;
  // 无选中时光标停在 placeholder 之前，方便用户直接覆盖输入
  return { replacement, cursorOffset: before.length };
}

/**
 * 获取指定级别的标题前缀（如 level=3 返回 "### "）
 * level 自动 clamp 到 [1, 6]
 */
export function getHeadingPrefix(level: number): string {
  const n = Math.max(1, Math.min(6, Math.floor(level)));
  return "#".repeat(n) + " ";
}

/**
 * 找到光标所在行的 [lineStart, lineEnd) 字符区间
 * - lineStart：当前行第一个字符的位置（紧邻上一个 \n 之后）
 * - lineEnd：当前行最后一个字符的下一个位置（指向 \n 或字符串末尾）
 */
export function getLineRange(text: string, cursorPos: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", cursorPos - 1) + 1;
  const nl = text.indexOf("\n", cursorPos);
  const end = nl === -1 ? text.length : nl;
  return { start, end };
}

/**
 * 在光标所在行行首插入/替换标题前缀
 * - 已有标题前缀（# ~ ######）先移除，再插入新前缀
 * - 已有同级别前缀时，相当于去标题（保持幂等：再按一次移除）
 * - 返回新文本和光标位置（光标停在新行末尾）
 */
export function setLinePrefix(text: string, cursorPos: number, prefix: string): FormatResult {
  const { start, end } = getLineRange(text, cursorPos);
  const line = text.substring(start, end);
  // 移除已有的标题前缀（含 1~6 个 # + 一个空格）
  const stripped = line.replace(/^#{1,6}\s*/, "");
  const newLine = prefix + stripped;
  const newText = text.substring(0, start) + newLine + text.substring(end);
  // 光标停在新行末尾
  return { replacement: newText, cursorOffset: start + newLine.length - cursorPos };
}

/**
 * 移除光标所在行的标题前缀（Ctrl+0 转为普通段落）
 * - 已有标题前缀（# ~ ######）则移除
 * - 非标题行原样返回（cursorOffset = 0 表示无变化）
 */
export function removeLinePrefix(text: string, cursorPos: number): FormatResult {
  const { start, end } = getLineRange(text, cursorPos);
  const line = text.substring(start, end);
  const stripped = line.replace(/^#{1,6}\s*/, "");
  if (stripped === line) {
    // 非标题行，无变化
    return { replacement: text, cursorOffset: 0 };
  }
  const newText = text.substring(0, start) + stripped + text.substring(end);
  // 光标位置 clamp 到新行内
  const newCursor = Math.min(start + stripped.length, cursorPos);
  return { replacement: newText, cursorOffset: newCursor - cursorPos };
}

/**
 * 构造指定 action 的格式化结果（按钮点击路径）
 *
 * 统一入口：handleFormatAction 与右键菜单都通过此函数生成 replacement + cursorOffset。
 * - 行内格式：调用 wrapSelection
 * - 标题 H1~H6：使用前缀包裹（与原按钮行为一致，选中文本作为标题内容）
 * - 块级语法：返回固定模板字符串
 * - 未知 action 返回 null，调用方应判空
 */
export function buildFormatReplacement(action: string, selected: string): FormatResult | null {
  switch (action) {
    case "bold":
      return wrapSelection(selected, "**", "**", "粗体文本");
    case "italic":
      return wrapSelection(selected, "*", "*", "斜体文本");
    case "bolditalic":
      return wrapSelection(selected, "***", "***", "粗斜体");
    case "strikethrough":
      return wrapSelection(selected, "~~", "~~", "删除线");
    case "underline":
      // E8(v0.9.3):下划线无 Markdown 原生语法,源码模式以 HTML <u> 表达
      return wrapSelection(selected, "<u>", "</u>", "下划线文本");
    case "code":
      return wrapSelection(selected, "`", "`", "代码");
    case "codeblock":
      return {
        replacement: `\n\`\`\`\n${selected || "代码内容"}\n\`\`\`\n`,
        cursorOffset: selected ? 4 + selected.length + 5 : 5,
      };
    case "h1":
      return { replacement: `# ${selected || "标题一"}`, cursorOffset: selected ? (2 + selected.length) : 2 };
    case "h2":
      return { replacement: `## ${selected || "标题二"}`, cursorOffset: selected ? (3 + selected.length) : 3 };
    case "h3":
      return { replacement: `### ${selected || "标题三"}`, cursorOffset: selected ? (4 + selected.length) : 4 };
    case "h4":
      return { replacement: `#### ${selected || "标题四"}`, cursorOffset: selected ? (5 + selected.length) : 5 };
    case "h5":
      return { replacement: `##### ${selected || "标题五"}`, cursorOffset: selected ? (6 + selected.length) : 6 };
    case "h6":
      return { replacement: `###### ${selected || "标题六"}`, cursorOffset: selected ? (7 + selected.length) : 7 };
    case "ul":
      return { replacement: `- ${selected || "列表项"}`, cursorOffset: selected ? (2 + selected.length) : 2 };
    case "task":
      return { replacement: `- [ ] ${selected || "任务项"}`, cursorOffset: selected ? (6 + selected.length) : 6 };
    case "ol":
      return { replacement: `1. ${selected || "列表项"}`, cursorOffset: selected ? (3 + selected.length) : 3 };
    case "quote":
      return { replacement: `> ${selected || "引用文本"}`, cursorOffset: selected ? (2 + selected.length) : 2 };
    case "link":
      return { replacement: `[${selected || "链接文本"}](url)`, cursorOffset: selected ? (selected.length + 3) : 1 };
    case "image":
      return { replacement: `![${selected || "图片描述"}](url)`, cursorOffset: selected ? (selected.length + 4) : 2 };
    case "table":
      return {
        replacement: `\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n`,
        cursorOffset: 2,
      };
    case "math":
      return { replacement: `\n$$\n\\sum_{i=1}^{n} x_i\n$$\n`, cursorOffset: 5 };
    case "hr":
      return { replacement: `\n---\n`, cursorOffset: 5 };
    default:
      return null;
  }
}

/**
 * 判断键盘事件是否为修饰键组合（Ctrl 或 Cmd）
 */
export function hasModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * 源码模式快捷键 action 名映射（id 对齐 core/shortcuts.ts SHORTCUT_DEFS）
 */
const SOURCE_ACTION_BY_ID: Record<string, string> = {
  "format.bold": "bold",
  "format.italic": "italic",
  "format.strikethrough": "strikethrough",
  "format.inlineCode": "code",
  // E8(v0.9.3):下划线源码模式以 <u> 包裹(Markdown 无原生语法)
  "format.underline": "underline",
  "format.math": "math",
  "format.heading1": "heading1",
  "format.heading2": "heading2",
  "format.heading3": "heading3",
  "format.heading4": "heading4",
  "format.heading5": "heading5",
  "format.heading6": "heading6",
  "format.paragraph": "paragraph",
};

/**
 * 解析源码模式 textarea 的快捷键事件，返回对应的 action 名（无匹配返回 null）
 *
 * v0.9.0 自定义快捷键：改为读 core/shortcuts.ts 生效键位表（默认 + 用户覆盖），
 * 默认键位与历史行为一致：
 * - Ctrl/Cmd + B → bold；Ctrl/Cmd + I → italic；
 * - Ctrl/Cmd + Alt + S → strikethrough（D1：与富文本统一，避开 Ctrl+Shift+S 另存为）
 * - Ctrl/Cmd + ` → code；Ctrl/Cmd + Shift + M → math（块级公式）
 * - Ctrl/Cmd + 1~6 → heading1~heading6；Ctrl/Cmd + 0 → paragraph
 *
 * 全局键（Ctrl+S/O/N/F/H 等）属 global 作用域，结构上不会在本函数命中；
 * 插入类（Ctrl+T 任务列表 / Ctrl+Alt+T 表格）由 App.tsx 全局匹配派发，也不在此处理。
 */
export function parseShortcut(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
  code?: string;
}): string | null {
  const def = matchShortcut(e, ["source"]);
  return def ? SOURCE_ACTION_BY_ID[def.id] ?? null : null;
}

/** Mermaid 模板列表（按钮下拉菜单项） */
export interface MermaidTemplate {
  label: string;
  syntax: string;
}

export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    label: "Flowchart",
    syntax: "\n```mermaid\ngraph TD\n    A[开始] --> B[结束]\n```\n",
  },
  {
    label: "Sequence",
    syntax: "\n```mermaid\nsequenceDiagram\n    participant A\n    participant B\n    A->>B: 请求\n    B-->>A: 响应\n```\n",
  },
  {
    label: "State",
    syntax: "\n```mermaid\nstateDiagram-v2\n    [*] --> 待机\n    待机 --> 运行: 启动\n    运行 --> [*]: 停止\n```\n",
  },
  {
    label: "Gantt",
    syntax: "\n```mermaid\ngantt\n    title 项目计划\n    section 阶段一\n    任务1 :a1, 2024-01-01, 30d\n```\n",
  },
  {
    label: "Pie",
    syntax: "\n```mermaid\npie title 销售占比\n    \"产品A\" : 40\n    \"产品B\" : 60\n```\n",
  },
  {
    label: "ER图",
    syntax: "\n```mermaid\nerDiagram\n    CUSTOMER ||--o{ ORDER : places\n```\n",
  },
  {
    label: "Gitgraph",
    syntax: "\n```mermaid\ngitGraph\n    commit\n    branch develop\n    checkout develop\n    commit\n```\n",
  },
];

/** 格式工具栏按钮配置 */
export interface FormatButton {
  action: string;
  label: string;
  title: string;
  isUndoRedo?: boolean;
  isSeparator?: boolean;
  hasDropdown?: boolean;
}

/**
 * 格式工具栏按钮配置（静态常量，避免每次渲染重建）
 * 顺序：撤销/恢复 | 分隔 | H1-H6 | 粗体/斜体/粗斜体/删除线/行内代码 | 代码块 | 列表/任务 | 引用/链接/图片/表格 | Mermaid/数学公式/分割线
 *
 * v0.9.0 自定义快捷键：title 不再硬编码键位，展示时经 formatButtonTitle 动态拼接生效键位
 */
export const FORMAT_BUTTONS: FormatButton[] = [
  { action: "undo", label: "↩", title: "撤销", isUndoRedo: true },
  { action: "redo", label: "↪", title: "恢复", isUndoRedo: true },
  { action: "sep1", label: "|", title: "", isSeparator: true },
  { action: "h1", label: "H1", title: "标题一" },
  { action: "h2", label: "H2", title: "标题二" },
  { action: "h3", label: "H3", title: "标题三" },
  { action: "h4", label: "H4", title: "标题四" },
  { action: "h5", label: "H5", title: "标题五" },
  { action: "h6", label: "H6", title: "标题六" },
  { action: "bold", label: "B", title: "粗体" },
  { action: "italic", label: "I", title: "斜体" },
  { action: "bolditalic", label: "BI", title: "粗斜体" },
  { action: "strikethrough", label: "S", title: "删除线" },
  { action: "code", label: "<>", title: "行内代码" },
  { action: "codeblock", label: "```", title: "代码块" },
  { action: "ul", label: "•", title: "无序列表" },
  { action: "task", label: "☑", title: "任务列表" },
  { action: "ol", label: "1.", title: "有序列表" },
  { action: "quote", label: "❝", title: "引用" },
  { action: "link", label: "🔗", title: "链接" },
  { action: "image", label: "🖼", title: "图片" },
  { action: "table", label: "⊞", title: "表格" },
  { action: "mermaid", label: "◈", title: "Mermaid 图表", hasDropdown: true },
  { action: "math", label: "∑", title: "数学公式" },
  { action: "hr", label: "—", title: "分割线" },
];

/** 工具栏 action → 快捷键条目 id（有键位的才在 tooltip 中拼接） */
const TOOLBAR_ACTION_DEF: Record<string, string> = {
  undo: "edit.undo",
  redo: "edit.redo",
  h1: "format.heading1",
  h2: "format.heading2",
  h3: "format.heading3",
  h4: "format.heading4",
  h5: "format.heading5",
  h6: "format.heading6",
  bold: "format.bold",
  italic: "format.italic",
  strikethrough: "format.strikethrough",
  code: "format.inlineCode",
  ul: "format.bulletList",
  ol: "format.orderedList",
  quote: "format.blockquote",
  table: "insert.table",
  task: "insert.taskList",
  math: "format.math",
};

/** 工具栏按钮 tooltip：基础文案 + 生效键位（改键后跟随变化） */
export function formatButtonTitle(btn: FormatButton): string {
  const defId = TOOLBAR_ACTION_DEF[btn.action];
  const combo = defId ? getShortcutLabel(defId) : undefined;
  return combo ? `${btn.title} (${combo})` : btn.title;
}
