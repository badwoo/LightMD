/**
 * TaskItemView —— 任务列表项 NodeView
 *
 * 设计：
 * - 渲染 checkbox + 文本内容
 * - 点击 checkbox 切换 checked 状态
 * - checked 状态下文本显示删除线效果
 */
import type { NodeView, EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export class TaskItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private checkbox: HTMLInputElement;
  private handleChange: () => void;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    // 外层容器
    this.dom = document.createElement("li");
    this.dom.className = "task-item";
    this.dom.setAttribute("data-checked", String(node.attrs.checked));

    // checkbox
    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.checked = node.attrs.checked;
    this.checkbox.className = "task-checkbox";
    this.handleChange = () => this.toggleChecked();
    this.checkbox.addEventListener("change", this.handleChange);
    this.dom.appendChild(this.checkbox);

    // 内容区域
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "task-content";
    if (node.attrs.checked) {
      this.contentDOM.classList.add("task-checked");
    }
    this.dom.appendChild(this.contentDOM);
  }

  private toggleChecked() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const checked = this.checkbox.checked;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      checked,
    });
    this.view.dispatch(tr);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.checkbox.checked = node.attrs.checked;
    this.dom.setAttribute("data-checked", String(node.attrs.checked));
    if (node.attrs.checked) {
      this.contentDOM.classList.add("task-checked");
    } else {
      this.contentDOM.classList.remove("task-checked");
    }
    return true;
  }

  destroy() {
    this.checkbox.removeEventListener("change", this.handleChange);
  }
}
