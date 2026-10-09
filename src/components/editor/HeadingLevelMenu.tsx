/**
 * HeadingLevelMenu —— v0.12.1 需求1：标题级别下拉菜单（H1~H6）
 *
 * 触发：阅读模式点击标题左侧的级别徽标（H1/H2…）——徽标由 wysiwyg 插件以
 * Decoration.widget 渲染（真实 DOM 按钮），点击回调经 createEditor 上抛到
 * EditorContainer，本组件以 portal 渲染到 body（与 PmContextMenu 同款定位/关闭策略）。
 *
 * 为什么不放在 PM 的 DOM 里：菜单需要 React 状态与主题 CSS 变量；portal 渲染还能
 * 避免被 .ProseMirror 的 contenteditable 选区/事件体系干扰。
 *
 * 动效（需求明确要求"顺滑的展开动画"）：
 *  - 关键帧 heading-menu-in：自上而下 scaleY(.92) → 1 + 位移 -4px → 0 + 淡入；
 *  - transform-origin 跟随锚点（贴标题左缘时左上角为原点）；
 *  - 缓动 cubic-bezier(0.16, 1, 0.3, 1)（easeOutExpo 观感，收尾不顿）；
 *  - 尊重系统 prefers-reduced-motion（关闭动画）。
 *
 * v0.12.1 需求1 范围确认：Markdown 标准只有 6 级标题（markdown-it 仅把 1~6 个 `#`
 * 解析为标题，7 个 `#` 是普通段落），故菜单只列 H1~H6，避免生成无法往返的语法。
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/state";
import { computeMenuPosition } from "./MiniContextMenu";

/** 支持的标题级别（Markdown 标准上限 6） */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

export interface HeadingLevelMenuProps {
  open: boolean;
  /** 锚点（徽标）视口矩形；null 表示未知（回退 0,0） */
  anchor: DOMRect | null;
  /** 当前级别（菜单内高亮） */
  current: number;
  onSelect: (level: number) => void;
  onClose: () => void;
}

/** 菜单尺寸估算（6 项 + 标题行 + 提示行，用于视口翻转） */
const MENU_SIZE = { width: 168, height: 300 };

export function HeadingLevelMenu({ open, anchor, current, onSelect, onClose }: HeadingLevelMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Esc / 点击外部 / 滚轮关闭（捕获阶段，避免与 PM 内部处理打架）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
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
  }, [open, onClose]);

  if (!open) return null;

  // 锚点在标题左缘外，菜单从其左下展开；视口不足时 computeMenuPosition 会自动翻转/贴边。
  // 徽标贴到窗口左缘时（窄窗口 + 侧栏折叠）菜单可能被左边界裁掉，这里补一次左边界钳制
  // （computeMenuPosition 只处理右/下两侧，改动它会波及其它菜单）。
  const raw = computeMenuPosition(
    anchor ? anchor.left : 0,
    anchor ? anchor.bottom + 4 : 0,
    { width: window.innerWidth, height: window.innerHeight },
    MENU_SIZE,
  );
  const pos = { left: Math.max(6, raw.left), top: raw.top };

  return createPortal(
    <div
      ref={menuRef}
      className="heading-level-menu"
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
      role="menu"
      aria-label={t("heading.menu.title")}
      data-testid="heading-level-menu"
    >
      <div className="heading-level-menu-header">
        <span className="heading-level-menu-title">{t("heading.menu.title")}</span>
        <span className="heading-level-menu-hint">{t("heading.menu.hint")}</span>
      </div>
      <div className="heading-level-menu-list">
        {HEADING_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            role="menuitemradio"
            aria-checked={level === current}
            className={`heading-level-item ${level === current ? "active" : ""}`}
            data-level={level}
            onClick={() => {
              onSelect(level);
              onClose();
            }}
          >
            {/* 级别预览：字号按级别递减，直观对应渲染效果；右侧给出等价的 # 语法 */}
            <span className={`heading-level-badge lv${level}`}>H{level}</span>
            <span className="heading-level-mark">{"#".repeat(level)}</span>
            {level === current && (
              <span className="heading-level-current">{t("heading.menu.current")}</span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
