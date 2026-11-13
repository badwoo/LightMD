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
import { isRealTextarea as isRealTextareaFromSourcePane } from "./panes/sourcepane/SourcePane";

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
  /**
   * ⚠️ 防御性再判一次（虽然唯一调用点已经用 `isRealTextarea` 守卫过）：
   *
   * 这个函数是「P0 崩溃」的**原始现场**（`textarea.value.substring` 抛 TypeError）。
   * 现在它只被 `isRealTextarea(textarea) ? getCaretCoordinates(textarea) : ...` 调用，
   * 但那是一条**隐式契约** —— 将来任何人新增一个调用点、或把 `position` 的
   * `isRealTextarea` 分支改掉，崩溃就会静默回来，而 error 发生在 render 期
   * （`useMemo`），代价是**整棵树被 ErrorBoundary 接管**。
   *
   * 所以在这里再判一次，并返回一个"安全但无用"的坐标（调用方随后会被
   * `hasSource` 守卫挡住而不渲染菜单）。宁可位置不准，也不许崩。
   */
  if (!isRealTextarea(textarea)) {
    // 走到这里说明调用方传了非 textarea（如 CM6 宿主 div）。用宿主矩形兜底，
    // 保证菜单出现在编辑器附近而不是 (0,0)；随后渲染会被 hasSource 守卫挡住。
    const host = textarea as unknown as HTMLElement | null;
    const r = host && typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : null;
    return { left: r ? r.left + 8 : 0, top: r ? r.top + 24 : 0 };
  }
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

  // 守卫（`isRealTextarea`）在函数入口已判过；这里再显式取一次，
  // 让"读 .value 必须紧跟守卫"在源码扫描里也成立（防后人插入新代码时绕过）。
  const text = isRealTextarea(textarea) ? textarea.value : "";
  const cursorPos = isRealTextarea(textarea) ? textarea.selectionStart : 0;
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

/**
 * 判断一个元素**是不是真的 textarea**（有字符串 `value`）。
 *
 * ## ⚠️ 这个守卫为什么必须存在（v0.17.0 R4 · P0 崩溃）
 *
 * CM6 迁移后 `sourceTextareaRef.current` 指向的是**中性宿主 `<div>`**
 * （`<div class="source-editor source-editor-cm6">`，里面套 `.cm-editor`），
 * 它**是 truthy 的**，所以旧的 `if (!textarea) return;` 守卫**完全失效**。
 * 随后 `textarea.value` 是 `undefined` → `findSlashTrigger(undefined, 0)`
 * → `text.substring(...)` 抛 `TypeError: Cannot read properties of undefined
 * (reading 'substring')`。
 *
 * 关键点：这个抛错发生在 **render 期**（`position` 的 `useMemo` 里）和 effect 里，
 * 所以 `ErrorBoundary` 直接接管**整棵树** —— 用户看到的是"界面渲染出错"，
 * 整个编辑器不可用，必须刷新才能恢复。实测复现路径：
 * **编辑模式 → 光标放空行行首 → 敲 `/`**（`v0170-r4-slash-rec.mjs`）。
 *
 * 本项目已有 `v0170-div-as-textarea-guard.test.ts` 专门守这一类缺陷
 * （"CM6 下 ref 是 truthy 的 div，`if (el)` 守卫失效"），
 * 历史上修过 `captureSourceContentAnchor` / `applyHistoryText` 等处，
 * **SlashCommand 这处一直漏着**。
 *
 * 因此：**任何读 `.value` / `.selectionStart` 的地方都必须先过这个守卫**，
 * 不能只用真值性判断。
 */
export function isRealTextarea(el: unknown): el is HTMLTextAreaElement {
  /**
   * 委托给 `SourcePane` 的**同一份实现**（本轮把判断收成单一定义源）。
   *
   * 为什么不再各写一遍：P0 崩溃的成因就是"每一处都各自写了一遍 `if (!el)` 判断"，
   * 而 CM6 的宿主 div 是 truthy 的 —— 只要有一处漏改就会崩，且代价是整棵树。
   * 现在 `SourcePane.isRealTextarea` 是唯一权威实现，这里只做 re-export，
   * 两个模块永远不会漂移（单测 A 组专门断言"两者同语义"）。
   */
  return isRealTextareaFromSourcePane(el);
}

/**
 * 从**中性宿主元素**（CM6）里取光标的视口坐标，用于菜单定位。
 *
 * ## 为什么不能沿用 `getCaretCoordinates` 的 mirror div 方案
 * 那套方案（建隐藏 div 复刻 textarea 排版来量光标位置）依赖 `textarea.value` 与
 * `textarea.scrollTop`，CM6 下两者都不存在（宿主 div 不滚动，滚动在 `.cm-scroller`）。
 *
 * ## 三级兜底（每一级都验证过可用性，失败就降级而不是崩）
 * 1. `.cm-cursor`（CM6 的绘制光标）—— 最准，但**失焦时会被移除**，故不能只靠它；
 * 2. 原生选区 `getRangeAt(0).getBoundingClientRect()` —— CM6 的 DOM 选区是真实选区，
 *    菜单刚弹出那一刻通常还在；
 * 3. 宿主元素自身矩形 + 一个行高的偏移 —— 最粗，但保证菜单**出现在编辑器附近**，
 *    而不是跑到视口左上角 `(0,0)`（那会让用户以为"菜单没出来"）。
 */
function getCmCaretCoordinates(host: Element): { left: number; top: number } {
  const cur = host.querySelector(".cm-cursor");
  if (cur) {
    const r = cur.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return { left: r.left, top: r.bottom };
  }
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return { left: r.left, top: r.bottom };
    }
  } catch {
    /* 选区不可用：继续降级 */
  }
  const hostRect = host.getBoundingClientRect();
  return { left: hostRect.left + 8, top: hostRect.top + 24 };
}

export interface SlashCommandProps {
  /**
   * 目标编辑元素（由外部传入，组件不持有强引用）。
   *
   * - **真 textarea**（旧实现路径）：组件自己读 `.value` / `.selectionStart`；
   * - **CM6 中性宿主 div**：组件**不再读 `.value`**，改用下面的纯值 provider。
   */
  textarea?: HTMLTextAreaElement | null;
  /**
   * CM6 路径的全文 provider（v0.17.0 R4 · A2 既有收敛口径）。
   *
   * 为什么必须走 provider 而不是让组件自己去 DOM 里找：
   * 源码面的**唯一事实源**是 `SourceSurface`（`getText()` / `getSelection()`），
   * 组件直读 DOM 会在 CM6 下拿到 `undefined`（P0 崩溃的成因），
   * 将来换第三套实现（如 CodeMirror 升级）又会再坏一次。
   * 传纯值函数后，组件与"内容是存在 textarea 里还是别处"彻底解耦。
   */
  getText?: () => string;
  /** CM6 路径的选区 provider（字符 offset，与 `findSlashTrigger` 同坐标系） */
  getSelection?: () => { start: number; end: number };
  /** 插入回调：mode=block 时删除触发 `/` 和过滤文字后插入 markdown；mode=inline 时用 markdown 替换选中文本 */
  onInsert: (markdown: string, mode: InsertMode) => void;
  /** 关闭菜单回调 */
  onClose: () => void;
}

export function SlashCommand({
  textarea,
  getText,
  getSelection,
  onInsert,
  onClose,
}: SlashCommandProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * 统一的取值入口 —— **组件里所有文本/选区读取都必须走这两个函数**，
   * 不许再出现裸的 `textarea.value` / `textarea.selectionStart`。
   *
   * 优先级：provider（CM6 / 受控实现）> 真 textarea > 空值兜底。
   * 「空值兜底」而不是抛异常：菜单定位这类纯展示逻辑拿不到值时应该**降级显示**
   * 而不是让整棵树崩掉（P0 的教训 —— render 期抛错的代价是整个编辑器不可用）。
   */
  const readText = useCallback((): string => {
    if (getText) {
      try { return getText() ?? ""; } catch { return ""; }
    }
    return isRealTextarea(textarea) ? textarea.value : "";
  }, [getText, textarea]);

  const readSelection = useCallback((): { start: number; end: number } => {
    if (getSelection) {
      try {
        const s = getSelection();
        return { start: s?.start ?? 0, end: s?.end ?? 0 };
      } catch { return { start: 0, end: 0 }; }
    }
    return isRealTextarea(textarea)
      ? { start: textarea.selectionStart ?? 0, end: textarea.selectionEnd ?? 0 }
      : { start: 0, end: 0 };
  }, [getSelection, textarea]);

  // 初始化 query（组件挂载时基于当前文本/选区计算）
  useEffect(() => {
    const text = readText();
    if (!text) return;
    const result = findSlashTrigger(text, readSelection().start);
    setQuery(result.query);
  }, [textarea, readText, readSelection]);

  // 过滤后的菜单项（useMemo 缓存，仅 query 变化时重算）
  const filteredItems = useMemo(() => filterItems(MENU_ITEMS, query), [query]);

  // filteredItems 变化时重置选中项，避免越界
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  /**
   * 计算菜单位置（含视口边界检测）。
   *
   * ## v0.17.0 R4 P0：这里是**崩溃点**
   *
   * 旧实现 `if (!textarea) return; const coords = getCaretCoordinates(textarea);`
   * 在 CM6 下：textarea 是 truthy 的 div → 进得去 → `getCaretCoordinates` 里
   * `textarea.value.substring(...)` 抛 TypeError。因为它跑在 **`useMemo`（render 期）**，
   * 错误直接冒泡到 ErrorBoundary → 整个应用变成"界面渲染出错"。
   *
   * 现在：`getCaretCoordinates` **只接受真 textarea**；CM6 走
   * `getCmCaretCoordinates(host)`（三级兜底，永不抛）。
   * 用 `try/catch` 再兜一层：菜单定位再怎么样也不该让应用崩掉。
   */
  const position = useMemo(() => {
    const host = textarea as unknown as HTMLElement | null;
    try {
      let coords: { left: number; top: number };
      if (isRealTextarea(textarea)) {
        coords = getCaretCoordinates(textarea);
      } else if (host) {
        // CM6：宿主 div（真实现）+ 纯值 provider；坐标从 CM6 的 DOM 光标/选区反推
        coords = getCmCaretCoordinates(host);
      } else {
        return { left: 0, top: 0 };
      }
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
    } catch {
      // 布局不可用（jsdom / 元素已卸载）：退回 0,0 —— 菜单仍可用，只是位置不精确
      return { left: 0, top: 0 };
    }
  }, [textarea]);

  // 选中菜单项的处理（block/inline 分别构造插入文本）
  const handleSelect = useCallback(
    (item: MenuItem) => {
      if (!textarea) return;

      if (item.mode === "inline") {
        const { start, end } = readSelection();
        const text = readText();
        const selectedText = text.substring(start, end);
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
    [textarea, readText, readSelection, onInsert, onClose]
  );

  /**
   * 监听**文本变化**更新 query；触发条件失效时关闭菜单。
   *
   * ## ⚠️ 两条监听通道，互斥（不要合成一条）
   *
   * - **真 textarea**：绑 DOM `input` 事件（旧行为，逐字节不变）；
   * - **CM6**：`textarea` 是 div，**它不会发 input 事件** —— 绑上去永远不触发，
   *   菜单的过滤/关闭就全失效了。所以改用 surface 的 **`onDidChange`** 通道
   *   （这是本项目"CM6 输入上报"的唯一正路，`EditorContainer` 里也是这么订的）。
   *
   * 这里刻意**不**用 `polling`：轮询会持续产生布局读取，与打字机/滚动恢复抢帧。
   */
  useEffect(() => {
    // ── 路径 1：真 textarea（旧行为，零变化）──
    if (isRealTextarea(textarea)) {
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
    }
    // ── 路径 2：CM6（无 input 事件）→ 由外部经 surface 的 onDidChange 驱动 ──
    // 具体实现见 E8 附件：SlashCommand 自身不持有 surface，因此这里退化为
    // 「用最后一个已知文本比对」—— 由父组件每次渲染传入最新值触发比对。
    // 兜底策略：没有 input 事件时，靠 readText() 在 query 变化时重算（见下方 effect）。
    return;
  }, [textarea, onClose]);

  // 键盘事件：↑↓ 选择、Enter 插入、Esc 关闭
  // 捕获阶段注册，确保在 textarea 默认处理前拦截
  // CM6 下事件源是 `.cm-content`（宿主 div 里的可编辑元素），不是宿主本身
  useEffect(() => {
    const target: HTMLElement | null = isRealTextarea(textarea)
      ? textarea
      : (textarea as unknown as HTMLElement | null)?.querySelector?.(".cm-content") ?? null;
    if (!target) return;

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

    target.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => target.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [textarea, filteredItems, selectedIndex, handleSelect, onClose]);

  /**
   * CM6 路径的 query 同步（**没有 `input` 事件时的唯一通道**）。
   *
   * ## 为什么需要它
   * 旧实现完全依赖 `<textarea>` 的原生 `input` 事件来更新 query / 关闭菜单。
   * CM6 下宿主是 `<div>`，**永远不会有 input 事件** → 菜单弹出后就再不会更新：
   * 用户接着敲 `/h` 过滤词，列表纹丝不动；删掉 `/` 菜单也不关。
   *
   * ## 为什么用"每次渲染比对文本"而不是 rAF 轮询
   * 宿主（`EditorContainer`）在每次键入后都会因 `setSourceContent` 重渲染，
   * 于是本组件跟着重渲染 —— 渲染本身就是"文本可能变了"的信号，不必额外轮询。
   * 轮询会持续读布局（`readText` 走 surface），在打字机/滚动恢复场景里抢帧。
   *
   * 用 `lastTextRef` 去重：只有文本**真的变了**才重算/关闭 ——
   * 避免"每次渲染都 setQuery → 再渲染"的无谓循环。
   */
  const lastTextRef = useRef<string | null>(null);
  useEffect(() => {
    // 真 textarea 走上面的原生 input 监听，这里不重复处理（否则一次输入跑两遍）
    if (isRealTextarea(textarea)) return;
    const text = readText();
    if (lastTextRef.current === text) return;
    lastTextRef.current = text;
    const result = findSlashTrigger(text, readSelection().start);
    if (!result.trigger) {
      onClose();
      return;
    }
    // 只在真的变了时才 setState（React 对相同值会 bail out，但显式比对更省）
    setQuery((prev) => (prev === result.query ? prev : result.query));
  });

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

  /**
   * 渲染守卫：**必须有可用的文本/选区来源**才渲染，否则返回 null。
   *
   * 注意判定条件不再是"textarea 是否 truthy"（CM6 下那是 div，恒 truthy），
   * 而是"有没有 provider，或者是不是真 textarea"。
   * 这一行本身也顺带消除了"宿主传了 div 但没传 provider"的中间态崩溃风险。
   */
  const hasSource = !!getText || isRealTextarea(textarea);
  if (!hasSource || filteredItems.length === 0) return null;

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
