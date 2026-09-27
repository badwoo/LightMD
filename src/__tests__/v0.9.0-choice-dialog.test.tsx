/**
 * v0.9.0：应用内决策对话框（ChoiceDialog）。
 *
 * 该组件承载 v0.9.0 新增的四处交互（冲突检测 / 外部文件策略询问 /
 * 关闭窗口确认 / 保存竞态），故必须保证：
 * - 选项完整渲染且顺序稳定
 * - 点击选项回调准确的 id
 * - 取消的三条路径（取消按钮 / Esc / 点击遮罩）都走 onCancel
 * - open=false 时不渲染（不拦截底层交互）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChoiceDialog, type ChoiceOption } from "../components/dialogs/ChoiceDialog";

const OPTIONS: ChoiceOption[] = [
  { id: "readonly", label: "只读打开", description: "编辑被禁用" },
  { id: "force", label: "强制编辑" },
  { id: "focus", label: "切换到已有窗口", tone: "primary" },
];

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof ChoiceDialog>[0]> = {}) {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ChoiceDialog
      open
      title="文件冲突"
      message="已在其他窗口中打开"
      detail="D:/docs/README.md"
      options={OPTIONS}
      cancelLabel="取消"
      onChoose={onChoose}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onChoose, onCancel };
}

describe("v0.9.0 ChoiceDialog", () => {
  it("open=false 时不渲染", () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId("choice-dialog")).toBeNull();
  });

  it("渲染标题/主文案/路径与全部选项", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("文件冲突")).toBeTruthy();
    expect(screen.getByText("已在其他窗口中打开")).toBeTruthy();
    expect(screen.getByText("D:/docs/README.md")).toBeTruthy();
    for (const o of OPTIONS) {
      expect(screen.getByTestId(`choice-option-${o.id}`)).toBeTruthy();
      expect(screen.getByText(o.label)).toBeTruthy();
    }
    expect(screen.getByText("编辑被禁用")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
  });

  it("点击选项回调其 id（冲突三选项）", () => {
    const { onChoose } = renderDialog();
    fireEvent.click(screen.getByTestId("choice-option-readonly"));
    expect(onChoose).toHaveBeenCalledWith("readonly");
    fireEvent.click(screen.getByTestId("choice-option-force"));
    expect(onChoose).toHaveBeenLastCalledWith("force");
    fireEvent.click(screen.getByTestId("choice-option-focus"));
    expect(onChoose).toHaveBeenLastCalledWith("focus");
  });

  it("取消按钮走 onCancel", () => {
    const { onCancel, onChoose } = renderDialog();
    fireEvent.click(screen.getByText("取消"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("Esc 走 onCancel", () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("点击遮罩走 onCancel，点击面板内部不取消", () => {
    const { onCancel } = renderDialog();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("choice-dialog"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("关闭按钮走 onCancel", () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByTitle("关闭"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("外部文件策略（两选项）与关闭确认（两选项）复用同一组件", () => {
    const { onChoose } = renderDialog({
      title: "打开外部文件",
      options: [
        { id: "current", label: "在当前窗口打开" },
        { id: "new", label: "在新窗口打开" },
      ],
    });
    expect(screen.queryByTestId("choice-option-readonly")).toBeNull();
    fireEvent.click(screen.getByTestId("choice-option-new"));
    expect(onChoose).toHaveBeenCalledWith("new");
  });

  it("危险操作带 tone=danger 样式类（破坏性动作视觉区分）", () => {
    renderDialog({
      options: [
        { id: "save", label: "保存全部并关闭" },
        { id: "discard", label: "不保存并关闭", tone: "danger" },
      ],
    });
    expect(screen.getByTestId("choice-option-discard").className).toContain("choice-option-danger");
    expect(screen.getByTestId("choice-option-save").className).not.toContain("choice-option-danger");
  });
});
