/**
 * G8 命令面板 - 命令注册中心
 *
 * 设计原则：
 * - 纯数据 + 纯函数，不依赖 React，便于测试
 * - 命令执行通过 window.dispatchEvent 派发 'lightmd:command' 事件
 *   由 App.tsx 监听并执行，避免命令注册中心依赖具体实现
 * - 搜索算法：子串匹配（开头匹配 > 包含匹配），支持中英文
 *
 * i18n 集成：
 * - 每个命令通过 titleKey 引用 i18n 字典 key
 * - searchCommands 接收可选的翻译函数 t，用于匹配本地化标题
 *   未提供 t 时仅匹配 keywords 和 id（便于无 i18n 环境的测试）
 */

/** 命令分组 */
export type CommandGroup = "file" | "edit" | "view" | "format" | "insert" | "export";

/** 命令定义 */
export interface Command {
  /** 唯一 ID，如 'file.new' */
  id: string;
  /** i18n key，如 'command.file.new' */
  titleKey: string;
  /** 快捷键描述，如 'Ctrl+N'（可选） */
  shortcut?: string;
  /** 所属分组 */
  group: CommandGroup;
  /** 额外搜索关键词（中英文，可选） */
  keywords?: string[];
  /**
   * 执行函数：派发 'lightmd:command' 事件
   * App.tsx 监听该事件并根据 id 路由到对应 handler
   */
  action: () => void;
}

/**
 * 派发命令事件
 * 使用工厂函数确保所有命令使用一致的事件格式
 */
function dispatchCommand(id: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("lightmd:command", { detail: { id } })
    );
  }
}

/**
 * 命令注册表
 *
 * 覆盖文件/视图/格式/插入/导出五大分组，约 25 条命令
 * 每个命令的 action 仅派发事件，由 App.tsx 路由到具体实现
 */
export const commands: Command[] = [
  // ─── 文件分组 ──────────────────────────────
  {
    id: "file.new",
    titleKey: "command.file.new",
    shortcut: "Ctrl+N",
    group: "file",
    keywords: ["新建", "new", "create"],
    action: () => dispatchCommand("file.new"),
  },
  {
    id: "file.open",
    titleKey: "command.file.open",
    shortcut: "Ctrl+O",
    group: "file",
    keywords: ["打开", "open"],
    action: () => dispatchCommand("file.open"),
  },
  {
    id: "file.save",
    titleKey: "command.file.save",
    shortcut: "Ctrl+S",
    group: "file",
    keywords: ["保存", "save"],
    action: () => dispatchCommand("file.save"),
  },
  {
    id: "file.saveAs",
    titleKey: "command.file.saveAs",
    shortcut: "Ctrl+Shift+S",
    group: "file",
    keywords: ["另存为", "save as", "saveas"],
    action: () => dispatchCommand("file.saveAs"),
  },
  // ─── 编辑分组 ──────────────────────────────
  {
    id: "edit.undo",
    titleKey: "command.edit.undo",
    shortcut: "Ctrl+Z",
    group: "edit",
    keywords: ["撤销", "undo"],
    action: () => dispatchCommand("edit.undo"),
  },
  {
    id: "edit.redo",
    titleKey: "command.edit.redo",
    shortcut: "Ctrl+Y",
    group: "edit",
    keywords: ["恢复", "重做", "redo"],
    action: () => dispatchCommand("edit.redo"),
  },
  {
    id: "edit.find",
    titleKey: "command.edit.find",
    shortcut: "Ctrl+F",
    group: "edit",
    keywords: ["查找", "搜索", "find", "search"],
    action: () => dispatchCommand("edit.find"),
  },
  {
    id: "edit.replace",
    titleKey: "command.edit.replace",
    shortcut: "Ctrl+H",
    group: "edit",
    keywords: ["替换", "replace"],
    action: () => dispatchCommand("edit.replace"),
  },
  // v0.6.0：AI 翻译选中内容（快捷键 F6）
  {
    id: "edit.translate",
    titleKey: "command.edit.translate",
    shortcut: "F6",
    group: "edit",
    keywords: ["翻译", "translate", "ai"],
    action: () => dispatchCommand("edit.translate"),
  },
  // v0.6.1：AI 全文翻译（快捷键 Shift+F6）
  {
    id: "edit.translateDocument",
    titleKey: "command.edit.translateDocument",
    shortcut: "Shift+F6",
    group: "edit",
    keywords: ["全文翻译", "整篇翻译", "translate", "document", "ai"],
    action: () => dispatchCommand("edit.translateDocument"),
  },
  // ─── 视图分组 ──────────────────────────────
  {
    id: "view.preview",
    titleKey: "command.view.preview",
    group: "view",
    keywords: ["阅读", "预览", "preview", "read"],
    action: () => dispatchCommand("view.preview"),
  },
  {
    id: "view.edit",
    titleKey: "command.view.edit",
    group: "view",
    keywords: ["编辑", "edit"],
    action: () => dispatchCommand("view.edit"),
  },
  {
    id: "view.split",
    titleKey: "command.view.split",
    group: "view",
    keywords: ["分屏", "split"],
    action: () => dispatchCommand("view.split"),
  },
  {
    id: "view.toggleTheme",
    titleKey: "command.view.toggleTheme",
    shortcut: "Ctrl+Shift+T",
    group: "view",
    keywords: ["主题", "切换主题", "theme", "toggle theme"],
    action: () => dispatchCommand("view.toggleTheme"),
  },
  {
    id: "view.toggleFocusMode",
    titleKey: "command.view.toggleFocusMode",
    shortcut: "F8",
    group: "view",
    keywords: ["专注", "focus"],
    action: () => dispatchCommand("view.toggleFocusMode"),
  },
  {
    id: "view.toggleTypewriter",
    titleKey: "command.view.toggleTypewriter",
    shortcut: "F9",
    group: "view",
    keywords: ["打字机", "typewriter"],
    action: () => dispatchCommand("view.toggleTypewriter"),
  },
  {
    id: "view.toggleOutline",
    titleKey: "command.view.toggleOutline",
    shortcut: "Ctrl+Shift+O",
    group: "view",
    keywords: ["大纲", "outline"],
    action: () => dispatchCommand("view.toggleOutline"),
  },
  {
    id: "view.settings",
    titleKey: "command.view.settings",
    shortcut: "Ctrl+,",
    group: "view",
    keywords: ["设置", "preferences", "settings"],
    action: () => dispatchCommand("view.settings"),
  },
  // ─── 格式分组 ──────────────────────────────
  {
    id: "format.bold",
    titleKey: "command.format.bold",
    shortcut: "Ctrl+B",
    group: "format",
    keywords: ["加粗", "粗体", "bold"],
    action: () => dispatchCommand("format.bold"),
  },
  {
    id: "format.italic",
    titleKey: "command.format.italic",
    shortcut: "Ctrl+I",
    group: "format",
    keywords: ["斜体", "italic"],
    action: () => dispatchCommand("format.italic"),
  },
  {
    id: "format.strikethrough",
    titleKey: "command.format.strikethrough",
    shortcut: "Ctrl+Alt+S",
    group: "format",
    keywords: ["删除线", "strikethrough"],
    action: () => dispatchCommand("format.strikethrough"),
  },
  {
    id: "format.inlineCode",
    titleKey: "command.format.inlineCode",
    group: "format",
    keywords: ["行内代码", "inline code", "code"],
    action: () => dispatchCommand("format.inlineCode"),
  },
  {
    id: "format.highlight",
    titleKey: "command.format.highlight",
    group: "format",
    keywords: ["高亮", "highlight"],
    action: () => dispatchCommand("format.highlight"),
  },
  {
    id: "format.heading1",
    titleKey: "command.format.heading1",
    group: "format",
    keywords: ["标题1", "一级标题", "h1", "heading 1"],
    action: () => dispatchCommand("format.heading1"),
  },
  {
    id: "format.heading2",
    titleKey: "command.format.heading2",
    group: "format",
    keywords: ["标题2", "二级标题", "h2", "heading 2"],
    action: () => dispatchCommand("format.heading2"),
  },
  {
    id: "format.heading3",
    titleKey: "command.format.heading3",
    group: "format",
    keywords: ["标题3", "三级标题", "h3", "heading 3"],
    action: () => dispatchCommand("format.heading3"),
  },
  // ─── 插入分组 ──────────────────────────────
  {
    id: "insert.table",
    titleKey: "command.insert.table",
    group: "insert",
    keywords: ["表格", "table"],
    action: () => dispatchCommand("insert.table"),
  },
  {
    id: "insert.link",
    titleKey: "command.insert.link",
    group: "insert",
    keywords: ["链接", "link"],
    action: () => dispatchCommand("insert.link"),
  },
  {
    id: "insert.image",
    titleKey: "command.insert.image",
    group: "insert",
    keywords: ["图片", "image"],
    action: () => dispatchCommand("insert.image"),
  },
  {
    id: "insert.codeblock",
    titleKey: "command.insert.codeblock",
    group: "insert",
    keywords: ["代码块", "code block"],
    action: () => dispatchCommand("insert.codeblock"),
  },
  {
    id: "insert.mermaid",
    titleKey: "command.insert.mermaid",
    group: "insert",
    keywords: ["mermaid", "图表", "diagram"],
    action: () => dispatchCommand("insert.mermaid"),
  },
  {
    id: "insert.taskList",
    titleKey: "command.insert.taskList",
    group: "insert",
    keywords: ["任务列表", "task list", "todo"],
    action: () => dispatchCommand("insert.taskList"),
  },
  {
    id: "insert.footnote",
    titleKey: "command.insert.footnote",
    group: "insert",
    keywords: ["脚注", "footnote"],
    action: () => dispatchCommand("insert.footnote"),
  },
  // ─── 导出分组 ──────────────────────────────
  {
    id: "export.html",
    titleKey: "command.export.html",
    shortcut: "Ctrl+Shift+E",
    group: "export",
    keywords: ["导出html", "export html"],
    action: () => dispatchCommand("export.html"),
  },
  {
    id: "export.pdf",
    titleKey: "command.export.pdf",
    group: "export",
    keywords: ["导出pdf", "export pdf"],
    action: () => dispatchCommand("export.pdf"),
  },
];

/** 分组顺序（用于命令面板的分组显示顺序） */
export const GROUP_ORDER: CommandGroup[] = ["file", "edit", "view", "format", "insert", "export"];

/** 分组的 i18n key 映射 */
export const GROUP_TITLE_KEYS: Record<CommandGroup, string> = {
  file: "command.group.file",
  edit: "command.group.edit",
  view: "command.group.view",
  format: "command.group.format",
  insert: "command.group.insert",
  export: "command.group.export",
};

/**
 * 搜索命令（子串匹配，支持中英文）
 *
 * @param query 搜索关键词（空字符串返回全部命令）
 * @param t 可选的翻译函数，用于匹配本地化标题
 * @returns 匹配的命令列表，按匹配度排序（开头匹配 > 包含匹配）
 */
export function searchCommands(
  query: string,
  t?: (key: string) => string
): Command[] {
  const q = query.trim().toLowerCase();
  // 空查询返回全部命令
  if (!q) return [...commands];

  type Scored = { cmd: Command; score: number };
  const matched: Scored[] = [];

  for (const cmd of commands) {
    let score = 0;
    // 1. id 匹配
    if (cmd.id.toLowerCase().includes(q)) {
      score = Math.max(score, cmd.id.toLowerCase().startsWith(q) ? 3 : 2);
    }
    // 2. 翻译标题匹配（若提供 t）
    if (t) {
      const title = t(cmd.titleKey).toLowerCase();
      if (title.includes(q)) {
        score = Math.max(score, title.startsWith(q) ? 3 : 2);
      }
    }
    // 3. keywords 匹配
    if (cmd.keywords) {
      for (const kw of cmd.keywords) {
        const kwLower = kw.toLowerCase();
        if (kwLower.includes(q)) {
          score = Math.max(score, kwLower.startsWith(q) ? 3 : 2);
        }
      }
    }
    if (score > 0) {
      matched.push({ cmd, score });
    }
  }

  // 按分数降序排序，分数相同则保持原顺序（稳定排序）
  matched.sort((a, b) => b.score - a.score);
  return matched.map((m) => m.cmd);
}
