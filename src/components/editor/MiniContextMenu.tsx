/**
 * MiniContextMenu —— 轻量右键菜单（v0.7.0）
 *
 * 用途：翻译气泡 / 「译」悬浮按钮等处的右键快捷菜单（portal 渲染，视口定位）。
 * 行为：Esc / 点击菜单外 / 滚轮 关闭；菜单项点击后自动关闭。
 * 主题：CSS 变量（复用 TranslateBubble.css 的菜单样式）。
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MiniMenuItem {
  /** 动作标识（测试定位用 data-action） */
  action: string;
  label: string;
  onClick: () => void;
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
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className="mini-context-menu-item"
          data-action={item.action}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
