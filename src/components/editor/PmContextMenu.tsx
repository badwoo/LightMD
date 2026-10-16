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
 * v0.12.0 返修（问题1）触发策略：调用方（EditorContainer）仅在「有文本选区 / 已选中块」
 * 时才接管右键并渲染本菜单；**无选区时不再拦截**，交回 WebView2 原生菜单
 * （恢复 v0.11.0 的表情符号/书写方向/更多工具）。因此上面的「无选区」分支当前不会被
 * 阅读模式触发，保留它是为了让本组件在三态下都有明确定义（纯函数契约不变）。
 *
 * 选区读取时序：调用方在 contextmenu 处理器内**同步**读取 view.state.selection
 * （PM 的 mousedown 处理器先于 contextmenu 执行，取到的是最新选区；且
 * preventDefault 必须发生在事件分发期，rAF 内读取已无法阻止原生菜单）。
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
  /** v0.13.0 需求1：剪贴板里是否有可用的块数据（无则禁用「粘贴」） */
  hasBlockClipboard?: boolean;
  /**
   * v0.13.1 需求16：选区是否可剪切/复制。
   *
   * 与 `hasBlockClipboard` 同一用途（禁用态），且**同一条教训**：不得为算禁用态去
   * `navigator.clipboard.read()`（WebView2 会弹系统授权气泡）。这里只反映编辑器自身
   * 选区状态，调用方同步传值即可。省略时按 `hasSelection` 推断（保持既有语义）。
   */
  hasTextClipboard?: boolean;
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
  // ─── 块级选中（NodeSelection）：剪切/复制/粘贴/删除 XX ───
  if (ctx.nodeKind) {
    const key = NODE_DELETE_LABEL_KEYS[ctx.nodeKind] ?? "menu.deleteNode";
    return [
      { type: "item", action: "blockCut", label: t("blockMenu.cut") },
      { type: "item", action: "blockCopy", label: t("blockMenu.copy") },
      { type: "item", action: "blockPaste", label: t("blockMenu.paste"), disabled: !ctx.hasBlockClipboard },
      { type: "separator" },
      { type: "item", action: "formatPainter", label: t("menu.formatPainter") },
      { type: "separator" },
      { type: "item", action: "deleteNode", label: t(key) },
    ];
  }

  const items: PmMenuItemConfig[] = [];

  // ─── 有文本选区：剪贴板四件套（v0.13.1 需求16，置于菜单**最上面一栏**）───
  //
  // 「粘贴」与「粘贴为纯文本」的禁用态：**不读系统剪贴板**（会触发 WebView2 授权气泡），
  // 统一交给点击时的实现去读并 toast 失败。因此这里恒可用，只把「剪切/复制」
  // 与选区状态绑定。
  if (ctx.hasSelection) {
    const copyable = ctx.hasTextClipboard ?? true;
    items.push(
      { type: "item", action: "cut", label: t("menu.cut"), disabled: !copyable },
      { type: "item", action: "copy", label: t("menu.copy"), disabled: !copyable },
      { type: "item", action: "paste", label: t("menu.paste") },
      { type: "item", action: "pastePlain", label: t("menu.pastePlain") },
      { type: "separator" },
    );
  }

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
  /** v0.13.0 需求1：剪贴板是否有块数据（控制「粘贴」禁用态） */
  hasBlockClipboard?: boolean;
  /** v0.13.1 需求16：选区是否可剪切/复制（控制「剪切」「复制」禁用态） */
  hasTextClipboard?: boolean;
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
  hasBlockClipboard,
  hasTextClipboard,
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

  const items = buildPmMenuItems({
    hasSelection,
    nodeKind,
    isMdFile,
    translateEnabled,
    hasBlockClipboard,
    hasTextClipboard,
  });
  // v0.13.1 需求16：高度估算按**实际菜单项数**算，不再写死 440。
  // 新增剪贴板四件套（+5 行：4 项 + 1 分隔线）后，写死的估算会让菜单在窗口底部
  // 被判成"放得下"而被裁掉。每项约 30px，加容器内边距 16px；分隔线略矮，
  // 统一按项数计即足够保守（宁可上翻也不要被裁）。
  const pos = computeMenuPosition(
    x,
    y,
    { width: window.innerWidth, height: window.innerHeight },
    { width: 200, height: 16 + items.length * 30 },
  );

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