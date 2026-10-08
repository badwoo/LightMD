/**
 * v0.12.0 需求2：阅读模式（PM）右键菜单
 *
 * 此前 PM 模式完全没有自定义右键菜单（只有浏览器原生菜单）——本组件为
 * 首次引入。结构对齐 EditorContextMenu（portal + 视口自适应 + 捕获阶段关闭），
 * 菜单项构建走纯函数 buildPmMenuItems(ctx)，覆盖三态：
 *
 * - 有文本选区：行内格式（加粗/斜体/删除线/行内代码/高亮/下划线）+ 格式刷 + AI 翻译；
 * - NodeSelection（块级选中，需求6）：删除 XX（按块类型映射文案）；
 * - 无选区：插入类（链接/图片/表格/代码块/Mermaid）+ AI 续写/摘要。
 *
 * 选区读取时序（v2 修正）：调用方（EditorContainer）在 contextmenu 事件的
 * requestAnimationFrame 内**主动读取** view.state.selection —— mermaid 等
 * NodeView 的 stopEvent 可能拦过 mousedown，React 事件对象的时序不保证。
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/state";
// 复用 MiniContextMenu 的视口自适应定位（已导出且经测试）
import { computeMenuPosition } from "./MiniContextMenu";

export interface PmMenuItemConfig {
  type: "item" | "separator";
  action?: string;
  label?: string;
  disabled?: boolean;
}

export interface PmMenuContext {
  /** 是否有文本选区（TextSelection 且非空） */
  hasSelection: boolean;
  /** NodeSelection 的节点类型名（null = 非块级选中） */
  nodeKind: string | null;
  isMdFile: boolean;
  translateEnabled: boolean;
}

/** 块类型 → 删除文案的 i18n key（未知类型回退通用「删除块」） */
export const NODE_DELETE_LABEL_KEYS: Record<string, string> = {
  code_block: "menu.deleteCodeBlock",
  mermaid_block: "menu.deleteMermaid",
  math_block: "menu.deleteMathBlock",
  table: "menu.deleteTable",
};

/** 构建 PM 菜单项（纯函数，便于单测；文案经 t() 同步解析） */
export function buildPmMenuItems(ctx: PmMenuContext): PmMenuItemConfig[] {
  // ─── 块级选中（NodeSelection）：删除 XX ───
  if (ctx.nodeKind) {
    const key = NODE_DELETE_LABEL_KEYS[ctx.nodeKind] ?? "menu.deleteNode";
    return [
      { type: "item", action: "formatPainter", label: t("menu.formatPainter") },
      { type: "separator" },
      { type: "item", action: "deleteNode", label: t(key) },
    ];
  }

  const items: PmMenuItemConfig[] = [];

  // ─── 有文本选区：行内格式 + 格式刷 + AI 翻译 ───
  if (ctx.hasSelection) {
    items.push(
      { type: "item", action: "bold", label: t("menu.bold") },
      { type: "item", action: "italic", label: t("menu.italic") },
      { type: "item", action: "strikethrough", label: t("menu.strikethrough") },
      { type: "item", action: "code", label: t("menu.inlineCode") },
      { type: "item", action: "highlight", label: t("menu.highlight") },
      { type: "item", action: "underline", label: t("menu.underline") },
      { type: "separator" },
      { type: "item", action: "formatPainter", label: t("menu.formatPainter") },
    );
    if (ctx.isMdFile && ctx.translateEnabled) {
      items.push({ type: "item", action: "translate", label: t("menu.translate") });
    }
    return items;
  }

  // ─── 无选区：插入类 + AI 助手 ───
  items.push(
    { type: "item", action: "link", label: t("menu.insertLink") },
    { type: "item", action: "image", label: t("menu.insertImage") },
    { type: "item", action: "table", label: t("menu.insertTable") },
    { type: "item", action: "codeblock", label: t("menu.insertCodeblock") },
    { type: "item", action: "mermaid", label: t("menu.insertMermaid") },
  );
  if (ctx.isMdFile && ctx.translateEnabled) {
    items.push(
      { type: "separator" },
      { type: "item", action: "aiContinue", label: t("menu.aiContinue") },
      { type: "item", action: "aiSummary", label: t("menu.aiSummary") },
    );
  }
  return items;
}

export interface PmContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  nodeKind: string | null;
  isMdFile: boolean;
  translateEnabled: boolean;
  onAction: (action: string) => void;
  onClose: () => void;
}

export function PmContextMenu({
  open,
  x,
  y,
  hasSelection,
  nodeKind,
  isMdFile,
  translateEnabled,
  onAction,
  onClose,
}: PmContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Esc / 点击外部 / 滚轮关闭（捕获阶段，避免与编辑器内部处理打架）
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
  }, [open, onClose]);

  if (!open) return null;

  const items = buildPmMenuItems({ hasSelection, nodeKind, isMdFile, translateEnabled });
  const pos = computeMenuPosition(x, y, { width: window.innerWidth, height: window.innerHeight }, {
    width: 200,
    height: 440,
  });

  return createPortal(
    <div
      ref={menuRef}
      className="editor-context-menu"
      style={{ left: pos.left, top: pos.top }}
      data-testid="pm-context-menu"
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => {
        if (item.type === "separator") {
          return <div key={`sep-${idx}`} className="context-menu-separator" />;
        }
        return (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            className={`context-menu-item ${item.disabled ? "disabled" : ""}`}
            disabled={item.disabled}
            data-action={item.action}
            onClick={() => {
              onAction(item.action!);
              onClose();
            }}
          >
            <span className="context-menu-label">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}