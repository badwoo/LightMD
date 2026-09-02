/**
 * SlashCommandPm ── 阅读模式（ProseMirror 富文本）的 `/` 命令菜单
 *
 * v0.6.6 问题2：此前 Slash 面板仅在源码模式（textarea）生效，
 * 阅读模式下输入 `/` 无响应。本组件与源码版 SlashCommand 复用
 * 同一份菜单配置（MENU_ITEMS）与列表 UI（SlashMenuList），
 * 差异仅在：
 * - 触发状态由 ProseMirror 插件（slash-command.ts）检测，经 props 传入
 * - 定位使用 view.coordsAtPos（无需 mirror div）
 * - 插入逻辑由 applyMenuItem 执行（块级转换，删除 `/query` 触发文本）
 * - 仅提供块级命令（行内格式需要选中文本，slash 触发时为空选区）
 */
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import {
  MENU_ITEMS,
  filterItems,
  SlashMenuList,
  MENU_WIDTH,
  MENU_MAX_HEIGHT,
  type MenuItem,
} from "./SlashCommand";
import { applyMenuItem, type SlashState } from "../../core/plugins/slash-command";
import { useT } from "../../i18n";

export interface SlashCommandPmProps {
  /** ProseMirror 编辑器视图 */
  view: EditorView | null;
  /** 插件检测到的触发状态（null 时组件不渲染） */
  slash: SlashState;
  /** 关闭菜单回调 */
  onClose: () => void;
}

export function SlashCommandPm({ view, slash, onClose }: SlashCommandPmProps) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // 阅读模式仅块级命令：行内格式（加粗等）需要选中文本，slash 触发时为空选区
  const filteredItems = useMemo(
    () => filterItems(MENU_ITEMS, slash.query).filter((i) => i.mode === "block"),
    [slash.query]
  );

  // filteredItems 变化时重置选中项，避免越界
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  // 计算菜单位置（含视口边界检测）
  // 依赖 slash.from：同一触发会话内 from 固定，query 增删不会导致菜单抖动
  const position = useMemo(() => {
    if (!view) return { left: 0, top: 0 };
    const coords = view.coordsAtPos(slash.from);
    const left =
      coords.left + MENU_WIDTH > window.innerWidth
        ? Math.max(8, coords.left - MENU_WIDTH + 20)
        : coords.left;
    const top =
      coords.top + 24 + MENU_MAX_HEIGHT > window.innerHeight
        ? Math.max(8, coords.top - MENU_MAX_HEIGHT - 4)
        : coords.top + 24; // 光标下方 24px
    return { left, top };
  }, [view, slash.from]);

  // 选中菜单项：应用块级转换后关闭菜单
  const handleSelect = useCallback(
    (item: MenuItem) => {
      if (!view) return;
      if (applyMenuItem(view, item, slash)) onClose();
    },
    [view, slash, onClose]
  );

  // 键盘事件：↑↓ 选择、Enter 插入、Esc 关闭
  // 捕获阶段注册在编辑器 DOM 上，先于 ProseMirror 的 keymap 处理
  useEffect(() => {
    if (!view) return;

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

    view.dom.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => view.dom.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [view, filteredItems, selectedIndex, handleSelect, onClose]);

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

  if (!view || filteredItems.length === 0) return null;

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
