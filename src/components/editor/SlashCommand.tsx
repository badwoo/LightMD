/**
 * SlashCommand —— 类 Notion 的 `/` 触发命令菜单
 *
 * 功能：
 * - 在 textarea（源码模式）行首输入 `/` 时弹出菜单（触发判定由外部负责）
 * - 菜单显示可插入的块级元素列表（标题/引用/列表/代码块/表格/数学公式等）
 * - 用户输入 `/` 后继续输入文字作为过滤关键词
 * - 键盘导航：↑↓ 选择、Enter 插入、Esc 关闭
 * - 鼠标点击或悬停也可选择
 * - 菜单跟随光标位置定位，含视口边界检测
 *
 * 设计：
 * - 使用 React Portal 渲染到 body，避免父容器 overflow 裁剪
 * - 菜单项配置（MENU_ITEMS）为纯常量，便于单元测试
 * - 过滤（filterItems）、插入构造（buildInsertText）、触发判定（findSlashTrigger）
 *   均为纯函数导出，便于单元测试
 * - useMemo 缓存过滤结果，避免每次渲染重算
 * - 组件卸载时清理所有事件监听器，避免内存泄漏
 * - 不持有 textarea 的强引用（通过 props 传入）
 *
 * onInsert 接入约定：
 * - mode="block"：EditorContainer 应删除当前光标所在行从行首（含触发的 `/` 和过滤文字）到光标的内容，
 *   然后在行首插入 markdown
 * - mode="inline"：EditorContainer 应使用 markdown 替换当前 textarea 选中文本
 *   （markdown 已是完整包裹字符串，如 `**选中文本**`）
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";

// ─── 类型定义 ────────────────────────────────────

/** 菜单项分组 */
export type MenuGroup = "基本块" | "列表" | "高级" | "行内格式";

/** 分组名到 i18n key 的映射（保留中文 group 用于过滤匹配，渲染时通过此映射翻译） */
export const GROUP_I18N_KEY: Record<MenuGroup, string> = {
  "基本块": "command.group.basic",
  "列表": "command.group.list",
  "高级": "command.group.advanced",
  "行内格式": "command.group.inline",
};

/** 菜单项插入模式 */
export type InsertMode = "block" | "inline";

/** 菜单项配置 */
export interface MenuItem {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 过滤关键词（与 name、id 一起参与匹配，不区分大小写） */
  keywords: string[];
  /** 所属分组 */
  group: MenuGroup;
  /** 插入模式：block=块级（行首插入），inline=行内（包裹选中文本） */
  mode: InsertMode;
  /**
   * 插入语法：
   * - block 模式：直接插入的字符串（如 `# `、`- `）
   * - inline 模式：含 `{text}` 占位符的包裹格式（如 `**{text}**`）
   */
  syntax: string;
  /** 显示图标（短文本符号，渲染在左侧） */
  icon: string;
}

// ─── 菜单项配置 ────────────────────────────────────

/** 完整菜单项列表（按分组顺序：基本块 → 列表 → 高级 → 行内格式） */
export const MENU_ITEMS: MenuItem[] = [
  // ─── 基本块 ───
  { id: "h1", name: "标题 H1", keywords: ["h1", "标题1", "一级标题", "heading", "#"], group: "基本块", mode: "block", syntax: "# ", icon: "H1" },
  { id: "h2", name: "标题 H2", keywords: ["h2", "标题2", "二级标题", "heading", "##"], group: "基本块", mode: "block", syntax: "## ", icon: "H2" },
  { id: "h3", name: "标题 H3", keywords: ["h3", "标题3", "三级标题", "heading", "###"], group: "基本块", mode: "block", syntax: "### ", icon: "H3" },
  { id: "h4", name: "标题 H4", keywords: ["h4", "标题4", "四级标题", "heading", "####"], group: "基本块", mode: "block", syntax: "#### ", icon: "H4" },
  { id: "quote", name: "引用", keywords: ["quote", "引用", "blockquote", ">"], group: "基本块", mode: "block", syntax: "> ", icon: "❝" },
  { id: "hr", name: "分割线", keywords: ["hr", "分割线", "横线", "divider", "---"], group: "基本块", mode: "block", syntax: "\n---\n", icon: "—" },
  { id: "codeblock", name: "代码块", keywords: ["code", "代码", "codeblock", "```", "fence"], group: "基本块", mode: "block", syntax: "\n```\n\n```\n", icon: "{ }" },

  // ─── 列表 ───
  { id: "ul", name: "无序列表", keywords: ["ul", "无序列表", "列表", "list", "bullet", "-"], group: "列表", mode: "block", syntax: "- ", icon: "•" },
  { id: "ol", name: "有序列表", keywords: ["ol", "有序列表", "numbered", "list", "1."], group: "列表", mode: "block", syntax: "1. ", icon: "1." },
  { id: "task", name: "任务列表", keywords: ["task", "任务", "todo", "checkbox", "未完成", "unchecked"], group: "列表", mode: "block", syntax: "- [ ] ", icon: "☐" },
  { id: "task-done", name: "已完成任务", keywords: ["done", "完成", "completed", "已勾选", "checked"], group: "列表", mode: "block", syntax: "- [x] ", icon: "☑" },

  // ─── 高级 ───
  { id: "math", name: "数学公式", keywords: ["math", "数学", "公式", "formula", "katex", "latex", "$$"], group: "高级", mode: "block", syntax: "\n$$\n\n$$\n", icon: "∑" },
  { id: "mermaid", name: "Mermaid 图表", keywords: ["mermaid", "图表", "diagram", "flowchart", "graph"], group: "高级", mode: "block", syntax: "\n```mermaid\ngraph TD\n    A --> B\n```\n", icon: "◈" },
  { id: "table", name: "表格", keywords: ["table", "表格", "grid", "|"], group: "高级", mode: "block", syntax: "\n| 列1 | 列2 |\n|------|------|\n| 内容 | 内容 |\n", icon: "⊞" },

  // ─── 行内格式（仅在有选中文本时可用）───
  { id: "bold", name: "加粗", keywords: ["bold", "加粗", "粗体", "strong", "**"], group: "行内格式", mode: "inline", syntax: "**{text}**", icon: "B" },
  { id: "italic", name: "斜体", keywords: ["italic", "斜体", "em", "*"], group: "行内格式", mode: "inline", syntax: "*{text}*", icon: "I" },
  { id: "strikethrough", name: "删除线", keywords: ["strikethrough", "删除线", "del", "strike", "~~"], group: "行内格式", mode: "inline", syntax: "~~{text}~~", icon: "S" },
  { id: "code", name: "行内代码", keywords: ["code", "代码", "inline code", "backtick", "`"], group: "行内格式", mode: "inline", syntax: "`{text}`", icon: "<>" },
  { id: "highlight", name: "高亮", keywords: ["highlight", "高亮", "mark", "=="], group: "行内格式", mode: "inline", syntax: "=={text}==", icon: "H" },
];

// ─── 纯函数（便于单元测试）────────────────────────────

/** 行内格式无选中文本时的占位符 */
export const INLINE_PLACEHOLDER = "文本";

/**
 * 根据关键词过滤菜单项
 *
 * 匹配规则（不区分大小写）：
 * - query 为空字符串时返回全部
 * - 匹配 name、id 或 keywords 中任一项的子串
 *
 * @param items 菜单项列表
 * @param query 过滤关键词
 * @returns 过滤后的菜单项列表（保持原顺序）
 */
export function filterItems(items: MenuItem[], query: string): MenuItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.toLowerCase().includes(q))
  );
}

/**
 * 构造要插入的文本
 *
 * - block 模式：直接返回 syntax（如 `# `、`- `）
 * - inline 模式：用 selectedText 替换 `{text}` 占位符
 *   - 无 selectedText 时使用占位文字（便于用户手动替换）
 *
 * @param item 菜单项配置
 * @param selectedText 当前选中的文本（inline 模式使用）
 * @returns 最终要插入的字符串
 */
export function buildInsertText(item: MenuItem, selectedText: string): string {
  if (item.mode === "inline") {
    const text = selectedText || INLINE_PLACEHOLDER;
    return item.syntax.replace("{text}", text);
  }
  return item.syntax;
}

/**
 * 判定光标位置是否处于 `/` 触发条件
 *
 * 触发条件：
 * - 光标所在行：行首（允许前导空格）+ `/` + 可选的过滤文字（字母数字）
 * - 例如 `  /h2`、`/`、`/table` 均触发
 * - `/` 前不能有其他非空白字符
 *
 * @param text textarea 完整内容
 * @param cursorPos 光标字符位置
 * @returns trigger=true 时附带 slashStart（`/` 位置）和 queryStart（`/` 后一位）以及当前 query 字符串
 */
export function findSlashTrigger(
  text: string,
  cursorPos: number
): { trigger: boolean; slashStart: number; queryStart: number; query: string } {
  // 找到光标所在行的起点
  let lineStart = cursorPos;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;

  const lineText = text.substring(lineStart, cursorPos);
  // 行首只能有空白 + `/` + 过滤文字（仅字母数字，避免误触发路径如 /usr/bin）
  const match = lineText.match(/^(\s*)\/(\w*)$/);
  if (!match) {
    return { trigger: false, slashStart: -1, queryStart: -1, query: "" };
  }
  const slashStart = lineStart + match[1].length;
  const queryStart = slashStart + 1; // `/` 之后的位置
  return {
    trigger: true,
    slashStart,
    queryStart,
    query: match[2],
  };
}

/**
 * 判定光标是否在代码块内（基于 ``` 围栏计数）
 *
 * 算法：统计光标前的 ``` 出现次数，奇数表示在代码块内。
 * 注：此判定用于外部触发条件，组件本身不调用。
 *
 * @param text textarea 完整内容
 * @param cursorPos 光标字符位置
 * @returns true 表示光标在代码块内（不应触发 Slash 菜单）
 */
export function isInCodeBlock(text: string, cursorPos: number): boolean {
  const before = text.substring(0, cursorPos);
  const fenceCount = (before.match(/```/g) || []).length;
  return fenceCount % 2 === 1;
}

// ─── 光标坐标计算 ────────────────────────────────────

/**
 * 计算 textarea 光标的视口坐标（用于菜单定位）
 *
 * 使用 mirror div 技巧：创建与 textarea 样式一致的隐藏 div，
 * 复制文本到光标位置，通过测量标记元素的 getBoundingClientRect 获取坐标。
 * 这是业界标准做法（VS Code、Atlassian 等均采用），能准确处理软换行。
 *
 * 实现参考 src/utils/focus-paragraph.ts 中的 mirror div 方案，
 * 但此处使用一次性 div（每次定位创建/销毁），简化生命周期管理。
 */
function getCaretCoordinates(textarea: HTMLTextAreaElement): { left: number; top: number } {
  const rect = textarea.getBoundingClientRect();
  const cs = getComputedStyle(textarea);

  // 创建临时 mirror div，复制 textarea 的关键样式
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    zIndex: "-1",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    boxSizing: cs.boxSizing,
    width: `${textarea.clientWidth}px`,
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize,
  } as Partial<CSSStyleDeclaration>);

  document.body.appendChild(mirror);

  const text = textarea.value;
  const cursorPos = textarea.selectionStart;
  const before = text.substring(0, cursorPos);
  const after = text.substring(cursorPos);

  // 在光标位置插入空 span 作为标记，测量其视口坐标
  mirror.textContent = "";
  mirror.appendChild(document.createTextNode(before));
  const marker = document.createElement("span");
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(after));

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();

  // 光标视口坐标 = textarea 视口偏移 + mirror 内偏移 - textarea.scrollTop
  // （mirror 无滚动，markerRect.top - mirrorRect.top 包含 padding-top，等同于文档坐标）
  const paddingTop = parseFloat(cs.paddingTop) || 0;
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const left = rect.left + (markerRect.left - mirrorRect.left) + borderLeft;
  const top = rect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop + paddingTop;

  // 清理 mirror div，避免泄漏
  mirror.remove();

  return { left, top };
}

// ─── 组件 ────────────────────────────────

/** 菜单预估尺寸（用于边界检测） */
export const MENU_WIDTH = 280;
export const MENU_MAX_HEIGHT = 360;

/**
 * v0.6.6 问题2：菜单列表渲染（共享组件）
 * 源码模式（SlashCommand）与阅读模式（SlashCommandPm）复用同一份列表 UI，
 * 仅定位与事件监听方式不同。
 */
export interface SlashMenuListProps {
  /** 过滤后的菜单项 */
  items: MenuItem[];
  /** 当前选中索引 */
  selectedIndex: number;
  /** 选中（点击）回调 */
  onSelect: (item: MenuItem) => void;
  /** 悬停高亮回调 */
  onHover: (index: number) => void;
}

export function SlashMenuList({ items, selectedIndex, onSelect, onHover }: SlashMenuListProps) {
  const t = useT();
  return (
    <>
      {items.map((item, idx) => {
        // 分组标题：第一项或与前一项不同组时显示
        const showGroup = idx === 0 || items[idx - 1].group !== item.group;
        return (
          <div key={item.id}>
            {showGroup && (
              <div
                style={{
                  padding: "6px 14px 4px",
                  fontSize: "11px",
                  color: "var(--text-tertiary, #999)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {t(GROUP_I18N_KEY[item.group])}
              </div>
            )}
            <button
              type="button"
              className={`slash-command-item${idx === selectedIndex ? " selected" : ""}`}
              role="option"
              aria-selected={idx === selectedIndex}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(idx)}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                padding: "6px 14px",
                border: "none",
                background:
                  idx === selectedIndex
                    ? "var(--bg-hover, #f0f0f0)"
                    : "transparent",
                color: "var(--text-primary, #333)",
                fontSize: "13px",
                lineHeight: "1.5",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                gap: "10px",
                outline: "none",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "28px",
                  height: "28px",
                  borderRadius: "4px",
                  background: "var(--bg-secondary, #f4f4f4)",
                  color: "var(--text-secondary, #666)",
                  fontSize: "12px",
                  fontWeight: 600,
                  fontFamily:
                    "var(--font-mono, 'Consolas', 'Monaco', monospace)",
                  flexShrink: 0,
                }}
              >
                {item.icon}
              </span>
              <span
                style={{
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {t(`command.${item.id}.name`)}
              </span>
            </button>
          </div>
        );
      })}
    </>
  );
}

export interface SlashCommandProps {
  /** 目标 textarea（由外部传入，组件不持有强引用） */
  textarea: HTMLTextAreaElement | null;
  /** 插入回调：mode=block 时删除触发 `/` 和过滤文字后插入 markdown；mode=inline 时用 markdown 替换选中文本 */
  onInsert: (markdown: string, mode: InsertMode) => void;
  /** 关闭菜单回调 */
  onClose: () => void;
}

export function SlashCommand({ textarea, onInsert, onClose }: SlashCommandProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // 初始化 query（组件挂载时基于 textarea 当前状态计算）
  useEffect(() => {
    if (!textarea) return;
    const result = findSlashTrigger(textarea.value, textarea.selectionStart);
    setQuery(result.query);
  }, [textarea]);

  // 过滤后的菜单项（useMemo 缓存，仅 query 变化时重算）
  const filteredItems = useMemo(() => filterItems(MENU_ITEMS, query), [query]);

  // filteredItems 变化时重置选中项，避免越界
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  // 计算菜单位置（含视口边界检测）
  // textarea 引用变化时重算（菜单打开时只算一次，不随 query 变化抖动）
  const position = useMemo(() => {
    if (!textarea) return { left: 0, top: 0 };
    const coords = getCaretCoordinates(textarea);
    // 边界检测：右侧溢出则向左偏移；下方溢出则显示在光标上方
    const left =
      coords.left + MENU_WIDTH > window.innerWidth
        ? Math.max(8, coords.left - MENU_WIDTH + 20)
        : coords.left;
    const top =
      coords.top + 24 + MENU_MAX_HEIGHT > window.innerHeight
        ? Math.max(8, coords.top - MENU_MAX_HEIGHT - 4)
        : coords.top + 24; // 光标下方 24px
    return { left, top };
  }, [textarea]);

  // 选中菜单项的处理（block/inline 分别构造插入文本）
  const handleSelect = useCallback(
    (item: MenuItem) => {
      if (!textarea) return;

      if (item.mode === "inline") {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = textarea.value.substring(start, end);
        if (!selectedText) {
          // 行内格式无选中文本时不允许插入
          return;
        }
        const wrapped = buildInsertText(item, selectedText);
        onInsert(wrapped, "inline");
      } else {
        // block 模式：直接传 syntax，EditorContainer 负责删除触发字符并插入
        const markdown = buildInsertText(item, "");
        onInsert(markdown, "block");
      }
      onClose();
    },
    [textarea, onInsert, onClose]
  );

  // 监听 textarea input：更新 query，触发条件失效时关闭菜单
  useEffect(() => {
    if (!textarea) return;

    const handleInput = () => {
      const result = findSlashTrigger(textarea.value, textarea.selectionStart);
      if (!result.trigger) {
        // 触发条件不再满足（删除了 `/` 或移动到其他行），关闭菜单
        onClose();
        return;
      }
      setQuery(result.query);
    };

    textarea.addEventListener("input", handleInput);
    return () => textarea.removeEventListener("input", handleInput);
  }, [textarea, onClose]);

  // 键盘事件：↑↓ 选择、Enter 插入、Esc 关闭
  // 捕获阶段注册，确保在 textarea 默认处理前拦截
  useEffect(() => {
    if (!textarea) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) =>
          filteredItems.length > 0 ? (i + 1) % filteredItems.length : 0
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) =>
          filteredItems.length > 0
            ? (i - 1 + filteredItems.length) % filteredItems.length
            : 0
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const item = filteredItems[selectedIndex];
        if (item) handleSelect(item);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    textarea.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => textarea.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [textarea, filteredItems, selectedIndex, handleSelect, onClose]);

  // 点击菜单外部关闭
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".slash-command-menu")) {
        onClose();
      }
    };
    // capture 阶段先于菜单项的 click 处理
    document.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () =>
      document.removeEventListener("mousedown", handleMouseDown, { capture: true });
  }, [onClose]);

  // 选中项变化时滚动到可见区域（菜单有滚动时确保键盘选中项可见）
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const selectedEl = menu.querySelector(".slash-command-item.selected") as HTMLElement | null;
    if (!selectedEl) return;
    const menuRect = menu.getBoundingClientRect();
    const itemRect = selectedEl.getBoundingClientRect();
    if (itemRect.top < menuRect.top || itemRect.bottom > menuRect.bottom) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!textarea || filteredItems.length === 0) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="slash-command-menu"
      role="listbox"
      aria-label={t("command.ariaLabel")}
      style={{
        position: "fixed",
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${MENU_WIDTH}px`,
        maxHeight: `${MENU_MAX_HEIGHT}px`,
        overflowY: "auto",
        zIndex: 10000,
        background: "var(--bg-primary, #fff)",
        border: "1px solid var(--border-color, #e0e0e0)",
        borderRadius: "8px",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.1)",
        padding: "4px 0",
        margin: 0,
        animation: "slashMenuIn 0.12s ease-out",
      }}
    >
      <SlashMenuList
        items={filteredItems}
        selectedIndex={selectedIndex}
        onSelect={handleSelect}
        onHover={setSelectedIndex}
      />
    </div>,
    document.body
  );
}
