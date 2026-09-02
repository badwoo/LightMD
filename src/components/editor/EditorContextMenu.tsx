/**
 * EditorContextMenu —— 编辑器主区域右键菜单
 *
 * 功能：
 * - 在编辑器文本区域右键时显示自定义菜单（替代浏览器默认菜单）
 * - 支持撤销/恢复、剪切/复制/粘贴、行内格式、插入操作
 * - 根据上下文智能显示（无选中文本时隐藏行内格式项）
 *
 * 设计：
 * - 使用 React Portal 渲染到 body，避免被父容器 overflow 裁剪
 * - 菜单项配置通过 buildMenuItems 纯函数生成，便于单元测试
 * - useMemo 缓存菜单项，避免每次渲染重建
 * - 关闭时清理事件监听器，避免内存泄漏
 */
import { useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import "./EditorContextMenu.css";

/** 菜单项类型 */
export interface MenuItemConfig {
  type: "item" | "separator";
  action?: string;
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  hidden?: boolean;
}

export interface EditorContextMenuProps {
  /** 是否显示 */
  open: boolean;
  /** 鼠标 X 坐标（视口坐标） */
  x: number;
  /** 鼠标 Y 坐标（视口坐标） */
  y: number;
  /** 是否有选中文本 */
  hasSelection: boolean;
  /** 是否可撤销 */
  canUndo: boolean;
  /** 是否可恢复 */
  canRedo: boolean;
  /** v0.6.0：是否为 Markdown 文件（决定是否显示 AI 翻译项） */
  isMdFile?: boolean;
  /** v0.6.0：AI 翻译总开关（关闭时隐藏"AI 翻译"项） */
  translateEnabled?: boolean;
  /** 菜单项触发回调，参数为 action 名称 */
  onAction: (action: string) => void;
  /** 关闭菜单回调 */
  onClose: () => void;
}

/**
 * 构建菜单项配置（纯函数，便于单元测试）
 *
 * 根据上下文状态（是否有选中文本、是否可撤销/恢复、是否 md 文件）决定菜单项的显示和禁用状态。
 * 无选中文本时隐藏"加粗"等行内格式项及其分隔符。
 * v0.6.0：md 文件 + 翻译开关开启 + 有选区时显示"AI 翻译"项（快捷键 F6）。
 */
export function buildMenuItems(
  hasSelection: boolean,
  canUndo: boolean,
  canRedo: boolean,
  isMdFile = true,
  translateEnabled = true,
): MenuItemConfig[] {
  const items: MenuItemConfig[] = [
    // ─── 撤销/恢复 ───
    { type: "item", action: "undo", label: "撤销", shortcut: "Ctrl+Z", disabled: !canUndo },
    { type: "item", action: "redo", label: "恢复", shortcut: "Ctrl+Y", disabled: !canRedo },
    { type: "separator" },
    // ─── 剪切/复制/粘贴 ───
    { type: "item", action: "cut", label: "剪切", shortcut: "Ctrl+X", disabled: !hasSelection },
    { type: "item", action: "copy", label: "复制", shortcut: "Ctrl+C", disabled: !hasSelection },
    { type: "item", action: "paste", label: "粘贴", shortcut: "Ctrl+V", disabled: false },
  ];

  // ─── 行内格式（仅在有选中文本时显示）───
  if (hasSelection) {
    items.push(
      { type: "separator" },
      { type: "item", action: "bold", label: "加粗", shortcut: "Ctrl+B" },
      { type: "item", action: "italic", label: "斜体", shortcut: "Ctrl+I" },
      { type: "item", action: "strikethrough", label: "删除线" },
      { type: "item", action: "code", label: "行内代码", shortcut: "Ctrl+E" },
    );
    // v0.6.0：AI 翻译（md 文件 + 总开关开启；快捷键 F6）
    if (isMdFile && translateEnabled) {
      items.push(
        { type: "separator" },
        { type: "item", action: "translate", label: "AI 翻译", shortcut: "F6" },
      );
    }
  }

  // ─── 插入操作 ───
  items.push(
    { type: "separator" },
    { type: "item", action: "link", label: "插入链接" },
    { type: "item", action: "image", label: "插入图片" },
    { type: "item", action: "table", label: "插入表格" },
    { type: "item", action: "codeblock", label: "插入代码块" },
    { type: "item", action: "mermaid", label: "插入 Mermaid" },
  );

  return items;
}

export function EditorContextMenu({
  open,
  x,
  y,
  hasSelection,
  canUndo,
  canRedo,
  isMdFile = true,
  translateEnabled = true,
  onAction,
  onClose,
}: EditorContextMenuProps) {
  const t = useT();
  // 缓存菜单项配置，仅当上下文状态变化时重建
  const menuItems = useMemo(
    () => buildMenuItems(hasSelection, canUndo, canRedo, isMdFile, translateEnabled),
    [hasSelection, canUndo, canRedo, isMdFile, translateEnabled],
  );

  // 计算菜单显示位置，避免溢出视口边界
  const position = useMemo(() => {
    if (!open) return { left: 0, top: 0 };
    // 菜单预估尺寸（与 CSS 中 min-width 和最大高度对应）
    const MENU_WIDTH = 220;
    const MENU_MAX_HEIGHT = 400;
    const left = x + MENU_WIDTH > window.innerWidth ? x - MENU_WIDTH : x;
    const top = y + MENU_MAX_HEIGHT > window.innerHeight ? y - MENU_MAX_HEIGHT : y;
    // 确保不为负
    return { left: Math.max(0, left), top: Math.max(0, top) };
  }, [open, x, y]);

  // 点击菜单项
  const handleItemClick = useCallback(
    (action: string, disabled?: boolean) => {
      if (disabled) return;
      onAction(action);
      onClose();
    },
    [onAction, onClose],
  );

  // Esc 键关闭 + 点击外部关闭（事件监听器在 open 变化时绑定/清理）
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    // 点击外部关闭：mousedown 事件触发时若目标不在菜单内则关闭
    // 使用 mousedown 而非 click，避免点击菜单项时的冒泡问题
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".editor-context-menu")) {
        onClose();
      }
    };

    // 捕获阶段注册，确保在菜单项的 click 之前处理外部点击
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    document.addEventListener("mousedown", handleMouseDown, { capture: true });

    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
      document.removeEventListener("mousedown", handleMouseDown, { capture: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="editor-context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menuItems.map((item, idx) => {
        if (item.type === "separator") {
          return <div key={`sep-${idx}`} className="context-menu-separator" />;
        }
        return (
          <button
            key={item.action}
            className={`context-menu-item ${item.disabled ? "disabled" : ""}`}
            disabled={item.disabled}
            onClick={() => handleItemClick(item.action!, item.disabled)}
          >
            <span className="context-menu-label">{t(`menu.${item.action}`)}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
