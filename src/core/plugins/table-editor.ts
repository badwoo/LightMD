/**
 * TableEditor —— 表格 NodeView（可视化编辑）
 *
 * 修复：添加 contentDOM 让 ProseMirror 管理表格内容编辑
 * 保留右键菜单功能
 */
import type { NodeView, EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";

let activeMenu: HTMLElement | null = null;

function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
}

export class TableView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("div");
    this.dom.className = "table-wrapper";

    // contentDOM 是 ProseMirror 管理的 DOM 节点
    // ProseMirror 会自动将表格内容渲染到这里
    this.contentDOM = document.createElement("table");
    this.contentDOM.className = "pm-table";
    this.dom.appendChild(this.contentDOM);

    // 右键菜单
    this.dom.addEventListener("contextmenu", (e) => this.onContextMenu(e));
  }

  // ─── 右键菜单 ──────────────────────────────────────

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const cell = (e.target as HTMLElement).closest("td, th") as HTMLElement;
    if (!cell) return;

    closeMenu();
    const menu = document.createElement("div");
    menu.className = "table-context-menu";
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:999;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;box-shadow:var(--shadow-md);padding:4px 0;min-width:155px;font-size:13px;color:var(--text-primary);`;

    const items = [
      "⬆ 上方插入行", "⬇ 下方插入行", "-",
      "⬅ 左侧插入列", "➡ 右侧插入列", "-",
      "🗑 删除当前行", "🗑 删除当前列",
    ];
    items.forEach((label) => {
      if (label === "-") {
        const sep = document.createElement("div");
        sep.style.cssText = "height:1px;background:var(--border-light);margin:3px 0;";
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = "display:block;width:100%;padding:5px 12px;border:none;background:none;text-align:left;cursor:pointer;";
      if (label.includes("删除")) btn.style.color = "#d32f2f";
      btn.addEventListener("mouseenter", () => btn.style.background = "var(--bg-hover)");
      btn.addEventListener("mouseleave", () => btn.style.background = "none");
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeMenu();
        // 行列操作暂时通过 ProseMirror 事务实现
        // 后续 P3 阶段完善
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    activeMenu = menu;
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
  }

  // ─── NodeView 接口 ─────────────────────────────────

  update(node: Node): boolean {
    if (node.type.name !== "table") return false;
    return true;
  }

  ignoreMutation(): boolean {
    return false;
  }

  destroy() {
    closeMenu();
  }
}
