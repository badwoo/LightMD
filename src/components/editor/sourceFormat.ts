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
  /**
   * v0.12.0 需求1：无选区时的占位提示文本（不写入文档！）。
   * 由 source ghost overlay 以灰色幽灵文本渲染：用户直接键入即替换之，
   * 不键入则永不落盘（修复"粗体文本/标题一 残留进文件"）。
   * 仅行内格式与标题使用；块级模板（代码块/表格/引用等）仍预填真文本
   * ——新建块需要可见模板指引，属既有语义保留。
   */
  ghostText?: string;
}

/**
 * 包裹选中文本：在前后插入成对的标记符号
 * - 有选中文本时：完整包裹，光标移到包裹后末尾
 * - 无选中文本时：仅插入语法符号（如 `**`），占位文字改走 ghostText
 *   （v0.12.0 需求1：不再把占位文字写进文档，光标居中便于直接键入）
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
  // v0.12.0 需求1：replacement 只含语法符号；placeholder 作为 ghostText 渲染
  const replacement = `${before}${after}`;
  return { replacement, cursorOffset: before.length, ghostText: placeholder };
}

/**
 * v0.12.0 需求1 返修：前缀/包裹类格式的 ghost 占位文案。
 * 用户反馈"还有好多格式符中间的文本没有设置为 ghost 文本"——
 * 列表/任务/有序列表/引用/链接/图片全部改为「只插语法符号 + ghost 提示」，
 * 占位文字（列表项/链接文本等）不再落盘。块级多行模板
 * （代码块/表格/Mermaid/公式/分割线）仍预填真文本（新建块需要模板指引）。
 */
export const PREFIX_GHOST_TEXTS = {
  list: "列表项",
  task: "任务项",
  quote: "引用文本",
  link: "链接文本",
  image: "图片描述",
} as const;

/** v0.12.0 需求1 返修：代码块占位提示（无选区时块内容为空，提示走 ghost 不落盘） */
export const CODEBLOCK_GHOST_TEXT = "代码内容";

/**
 * v0.12.0 需求1 返修：计算"格式 ghost 落在格式符中间"所需的尾部符号与遮罩开关。
 *
 * 背景：粗体等行内格式在光标处插入成对符号（`**` + `**`），光标停在两对符号
 * 中间。占位文字由 overlay 渲染，若不处理会**压住右侧符号**（用户反馈"重叠"）。
 * 处理方式：把光标之后的尾部符号取出，由 overlay 渲染为可见普通色跟在占位文字后，
 * 并用不透明底色遮住 textarea 里被压住的那些符号 → 视觉上即为 `**粗体文本**`。
 *
 * @param content 插入后的全文
 * @param tailStart 尾部符号在全文中的起始偏移（= 光标位置）
 * @param insertedTail 本次插入内容中位于光标之后的原始片段（可为多行模板）
 * @returns tail 为需要可见渲染的尾符号（跨行模板为空）；maskTail 为是否启用底色遮罩
 *   （仅当该行尾部再无其它内容时启用，否则底色会连带遮住用户已有文字）
 */
export function computeGhostTail(
  content: string,
  tailStart: number,
  insertedTail: string,
): { tail: string; maskTail: boolean } {
  if (!insertedTail) return { tail: "", maskTail: false };
  // 跨行模板（尾部以换行开头）：尾部符号不在同一行，无需可见尾符号/遮罩
  const nl = insertedTail.indexOf("\n");
  const tail = nl === -1 ? insertedTail : insertedTail.slice(0, nl);
  if (!tail) return { tail: "", maskTail: false };
  const lineEnd = tailStart + tail.length;
  const maskTail = lineEnd >= content.length || content[lineEnd] === "\n";
  return { tail, maskTail };
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
 * v0.12.0 需求1：标题占位 Ghost 文案（H1~H6，索引 0 = 一级标题）。
 * buildFormatReplacement 与 EditorContainer 的 heading 行首路径共用，保证文案一致。
 */
export const HEADING_GHOST_TEXTS = ["标题一", "标题二", "标题三", "标题四", "标题五", "标题六"] as const;

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
      // v0.12.0 需求1 返修：块内容留空，占位提示走 ghost（不再把"代码内容"写进文档）
      return {
        replacement: `\n\`\`\`\n${selected}\n\`\`\`\n`,
        cursorOffset: selected ? 4 + selected.length + 5 : 5,
        ghostText: selected ? undefined : CODEBLOCK_GHOST_TEXT,
      };
    case "h1":
      return selected
        ? { replacement: `# ${selected}`, cursorOffset: 2 + selected.length }
        // v0.12.0 需求1：无选区仅插入前缀，标题占位走 ghostText（不落盘）
        : { replacement: "# ", cursorOffset: 2, ghostText: HEADING_GHOST_TEXTS[0] };
    case "h2":
      return selected
        ? { replacement: `## ${selected}`, cursorOffset: 3 + selected.length }
        : { replacement: "## ", cursorOffset: 3, ghostText: HEADING_GHOST_TEXTS[1] };
    case "h3":
      return selected
        ? { replacement: `### ${selected}`, cursorOffset: 4 + selected.length }
        : { replacement: "### ", cursorOffset: 4, ghostText: HEADING_GHOST_TEXTS[2] };
    case "h4":
      return selected
        ? { replacement: `#### ${selected}`, cursorOffset: 5 + selected.length }
        : { replacement: "#### ", cursorOffset: 5, ghostText: HEADING_GHOST_TEXTS[3] };
    case "h5":
      return selected
        ? { replacement: `##### ${selected}`, cursorOffset: 6 + selected.length }
        : { replacement: "##### ", cursorOffset: 6, ghostText: HEADING_GHOST_TEXTS[4] };
    case "h6":
      return selected
        ? { replacement: `###### ${selected}`, cursorOffset: 7 + selected.length }
        : { replacement: "###### ", cursorOffset: 7, ghostText: HEADING_GHOST_TEXTS[5] };
    // v0.12.0 需求1 返修：无选区时前缀/包裹类格式只插语法符号，占位提示走 ghostText；
    // 有选区时保持完整包裹（前缀 + 选中文字，既有行为不变）
    case "ul":
      return selected
        ? { replacement: `- ${selected}`, cursorOffset: 2 + selected.length }
        : { replacement: "- ", cursorOffset: 2, ghostText: PREFIX_GHOST_TEXTS.list };
    case "task":
      return selected
        ? { replacement: `- [ ] ${selected}`, cursorOffset: 6 + selected.length }
        : { replacement: "- [ ] ", cursorOffset: 6, ghostText: PREFIX_GHOST_TEXTS.task };
    // v0.12.1 需求5：圆形图标的任务项（源码 `* [ ] `，见 core/markdown/task-style.ts）
    case "task-circle":
      return selected
        ? { replacement: `* [ ] ${selected}`, cursorOffset: 6 + selected.length }
        : { replacement: "* [ ] ", cursorOffset: 6, ghostText: PREFIX_GHOST_TEXTS.task };
    case "ol":
      return selected
        ? { replacement: `1. ${selected}`, cursorOffset: 3 + selected.length }
        : { replacement: "1. ", cursorOffset: 3, ghostText: PREFIX_GHOST_TEXTS.list };
    case "quote":
      return selected
        ? { replacement: `> ${selected}`, cursorOffset: 2 + selected.length }
        : { replacement: "> ", cursorOffset: 2, ghostText: PREFIX_GHOST_TEXTS.quote };
    case "link":
      return selected
        ? { replacement: `[${selected}](url)`, cursorOffset: selected.length + 3 }
        : { replacement: "[](url)", cursorOffset: 1, ghostText: PREFIX_GHOST_TEXTS.link };
    case "image":
      return selected
        ? { replacement: `![${selected}](url)`, cursorOffset: selected.length + 4 }
        : { replacement: "![](url)", cursorOffset: 2, ghostText: PREFIX_GHOST_TEXTS.image };
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
 * v0.12.0 需求1：格式 ghost（占位提示）的清除时机判定（纯函数，便于单测）。
 *
 * 清除（返回 true）：
 * - "input"：任何真实输入（用户开始键入，占位提示完成使命）；
 * - "escape"：用户按 Esc 放弃提示（不回滚已插入的语法符号，用户可 Ctrl+Z 撤销）；
 * - "undo"：v0.12.0 返修——撤销/恢复后文档内容已与 ghost 快照不符，必须清除
 *   （修复"点击格式符后 Ctrl+Z 撤销了但 ghost 文本还在"）；
 * - "file-switch" / "mode-switch"：切文件/切模式（防跨文档残留）。
 * 保留（返回 false）：
 * - 方向键移动光标 / 点击移动光标 —— 用户可能想移到别处继续，提示继续有效。
 */
export function shouldClearFormatGhost(kind: string): boolean {
  return (
    kind === "input" ||
    kind === "escape" ||
    kind === "undo" ||
    kind === "file-switch" ||
    kind === "mode-switch"
  );
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
  // v0.11.0 返修（B3-2）：这三条此前只有 shortcuts.ts 的 scope 改成了
  // `rich-source`，本表却缺映射 → parseShortcut 返回 null → 源码 textarea 里
  // Ctrl+Shift+8/9/. 仍然完全无反应（验收①未达成）。buildFormatReplacement
  // 早已支持 ul/ol/quote，只差这三行。
  "format.bulletList": "ul",
  "format.orderedList": "ol",
  "format.blockquote": "quote",
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
  /** v0.12.0 需求2 返修：刷子形状 SVG 图标（格式刷按钮） */
  isBrushIcon?: boolean;
}

/**
 * 格式工具栏按钮配置（静态常量，避免每次渲染重建）
 * 顺序：撤销/恢复/格式刷(刷子图标) | 分隔 | H1-H6 | 粗体/斜体/粗斜体/删除线/行内代码 | 代码块 | 列表/任务 | 引用/链接/图片/表格 | Mermaid/数学公式/分割线
 *
 * v0.9.0 自定义快捷键：title 不再硬编码键位，展示时经 formatButtonTitle 动态拼接生效键位
 */
export const FORMAT_BUTTONS: FormatButton[] = [
  { action: "undo", label: "↩", title: "撤销", isUndoRedo: true },
  { action: "redo", label: "↪", title: "恢复", isUndoRedo: true },
  // v0.12.0 需求2 返修：格式刷改为刷子形状图标（isBrushIcon），并移到「恢复」按钮右边
  { action: "formatPainter", label: "", title: "格式刷（单击应用一次，双击持续应用）", isBrushIcon: true },
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
  // v0.12.1 需求5：任务列表按钮改为下拉（可选方形 / 圆形图标样式），点击行为由此下拉接管
  { action: "task", label: "☑", title: "任务列表（点击选择方形 / 圆形图标）" },
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
