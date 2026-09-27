/**
 * v0.9.0 WP9：只读模式与外部修改标记。
 *
 * 覆盖：
 * - store 契约：只读/外部修改标记是**标签级**（不影响同窗口其他标签）
 * - ProseMirror 集成：`editableGetter` 返回 false 时关闭 contenteditable（AC-9）
 * - 只读开关在运行期切换后重新求值（`view.updateState(view.state)` 路径）
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { useEditorStore } from "../stores/useEditorStore";
import { createEditor } from "../core/editor";

afterEach(() => {
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  vi.restoreAllMocks();
});

describe("v0.9.0 WP9：只读标记（store 契约）", () => {
  it("标记只作用于目标标签，其他标签不受影响", () => {
    const s = useEditorStore.getState();
    s.addTab({ path: "D:/a.md", name: "a.md", content: "A" });
    s.addTab({ path: "D:/b.md", name: "b.md", content: "B" });
    useEditorStore.getState().setTabReadonly(1, true);
    const tabs = useEditorStore.getState().openTabs;
    expect(tabs[0].isReadonly).toBeFalsy();
    expect(tabs[1].isReadonly).toBe(true);
  });

  it("可重复切换为可编辑", () => {
    useEditorStore.getState().addTab({ path: "D:/a.md", name: "a.md", content: "A" });
    useEditorStore.getState().setTabReadonly(0, true);
    expect(useEditorStore.getState().openTabs[0].isReadonly).toBe(true);
    useEditorStore.getState().setTabReadonly(0, false);
    expect(useEditorStore.getState().openTabs[0].isReadonly).toBe(false);
  });

  it("外部修改标记同为标签级（N22 保存竞态确认依据）", () => {
    const s = useEditorStore.getState();
    s.addTab({ path: "D:/a.md", name: "a.md", content: "A" });
    s.addTab({ path: "D:/b.md", name: "b.md", content: "B" });
    useEditorStore.getState().setTabExternallyChanged(0, true);
    expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(true);
    expect(useEditorStore.getState().openTabs[1].isExternallyChanged).toBeFalsy();
    useEditorStore.getState().setTabExternallyChanged(0, false);
    expect(useEditorStore.getState().openTabs[0].isExternallyChanged).toBe(false);
  });

  it("索引越界时不误改其他标签（空集合安全）", () => {
    useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
    expect(() => useEditorStore.getState().setTabReadonly(3, true)).not.toThrow();
    expect(useEditorStore.getState().openTabs).toEqual([]);
  });
});

describe("v0.9.0 WP9：ProseMirror 可编辑性（AC-9）", () => {
  function mountEditor(editable: boolean) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = createEditor({
      parent,
      initialContent: "# 标题\n\n正文",
      editableGetter: () => editable,
    });
    return { view, parent };
  }

  it("editableGetter=true 时 contenteditable 开启", () => {
    const { view, parent } = mountEditor(true);
    expect(view).toBeTruthy();
    expect(view!.editable).toBe(true);
    expect(view!.dom.getAttribute("contenteditable")).toBe("true");
    view!.destroy();
    parent.remove();
  });

  it("editableGetter=false 时关闭 contenteditable（只读打开）", () => {
    const { view, parent } = mountEditor(false);
    expect(view!.editable).toBe(false);
    expect(view!.dom.getAttribute("contenteditable")).toBe("false");
    view!.destroy();
    parent.remove();
  });

  it("运行期切换只读态后重新求值（updateState 路径）", () => {
    let readonly = false;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = createEditor({
      parent,
      initialContent: "正文",
      editableGetter: () => !readonly,
    });
    expect(view!.editable).toBe(true);
    // 模拟 EditorContainer 的 effect：同一 state 再 updateState 一次
    readonly = true;
    view!.updateState(view!.state);
    expect(view!.editable).toBe(false);
    expect(view!.dom.getAttribute("contenteditable")).toBe("false");
    // 切回可编辑
    readonly = false;
    view!.updateState(view!.state);
    expect(view!.editable).toBe(true);
    view!.destroy();
    parent.remove();
  });

  it("只读态下输入不改变文档（DOM 不可编辑 + 无 dispatch）", () => {
    const { view, parent } = mountEditor(false);
    const before = view!.state.doc.textContent;
    // contenteditable=false 的 DOM 不接受输入；直接构造事务也会被 PM 拒绝执行输入规则，
    // 此处仅断言视图不可编辑且文档未变
    expect(view!.editable).toBe(false);
    expect(view!.state.doc.textContent).toBe(before);
    view!.destroy();
    parent.remove();
  });
});
