/**
 * MiniContextMenu —— 轻量右键菜单（v0.7.0）
 *
 * 用途：翻译气泡 / 「译」悬浮按钮等处的右键快捷菜单（portal 渲染，视口定位）。
 * 行为：Esc / 点击菜单外 / 滚轮 关闭；菜单项点击后自动关闭。
 * 主题：CSS 变量（复用 TranslateBubble.css 的菜单样式）。
 */
import { Fragment, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MiniMenuItem {
  /** 动作标识（测试定位用 data-action） */
  action: string;
  label: string;
  onClick: () => void;
  /**
   * v0.13.0 返修（问题5）：禁用态。
   *
   * `buildBlockMenuItems` 早就产出了 `disabled`（如无剪贴板时禁用「粘贴」、
   * 首块禁用「上移」），但本组件此前**完全忽略**该字段——所有菜单项看起来都可点，
   * 点了没反应，用户感知为「菜单里的功能都不能用」。这里补上真正的禁用渲染。
   */
  disabled?: boolean;
  /**
   * v0.13.0 返修（问题5）：危险项（如「删除该块」）红色显示。
   * editor.css 早已定义 `.mini-context-menu-item.danger`，但从未被使用。
   */
  danger?: boolean;
  /** 分隔线：在该项**之前**画一条分隔线（buildBlockMenuItems 的 separator 语义） */
  separator?: boolean;
}

interface MiniContextMenuProps {
  /** 视口坐标（contextmenu 事件的 clientX/clientY） */
  x: number;
  y: number;
  items: MiniMenuItem[];
  onClose: () => void;
}

/** 计算菜单位置（视口内自适应，导出供测试） */
export function computeMenuPosition(
  x: number,
  y: number,
  viewport: { width: number; height: number },
  menuSize = { width: 180, height: 40 * 3 }
): { left: number; top: number } {
  const MARGIN = 6;
  let left = x;
  let top = y;
  // 右边界溢出 → 左移
  if (left + menuSize.width > viewport.width - MARGIN) {
    left = Math.max(MARGIN, viewport.width - menuSize.width - MARGIN);
  }
  // 底部溢出 → 显示在鼠标上方
  if (top + menuSize.height > viewport.height - MARGIN) {
    top = Math.max(MARGIN, viewport.height - menuSize.height - MARGIN);
  }
  return { left, top };
}

export function MiniContextMenu({ x, y, items, onClose }: MiniContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // mousedown 捕获：点击菜单外任意处关闭（菜单内点击由 React onClick 处理，不触发外部关闭）
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onWheel = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onWheel);
    };
  }, [onClose]);

  const pos = computeMenuPosition(x, y, {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  return createPortal(
    <div
      ref={menuRef}
      className="mini-context-menu"
      style={{ left: pos.left, top: pos.top }}
      data-testid="mini-context-menu"
      role="menu"
    >
      {items.map((item) => (
        <Fragment key={item.action}>
          {/* v0.13.0 返修（问题5）：分隔线（删除/格式刷/上移前的分组线） */}
          {item.separator && <div className="mini-context-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`mini-context-menu-item${item.danger ? " danger" : ""}`}
            data-action={item.action}
            // v0.13.0 返修（问题5）：禁用项真正不可点（此前 disabled 被忽略，
            // 所有菜单项都可点但无反应）
            disabled={item.disabled === true}
            aria-disabled={item.disabled === true || undefined}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body
  );
}
