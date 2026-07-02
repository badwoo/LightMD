/**
 * LinkDialog 组件测试
 *
 * 覆盖：
 * - buildLinkMarkdown 纯函数（边界情况、title 转义）
 * - 组件渲染、输入、预览、点击插入/取消
 * - 快捷键 Esc 取消、Enter 插入
 * - initialText 预填、url 为空时按钮 disabled
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LinkDialog, buildLinkMarkdown } from "../components/dialogs/LinkDialog";

beforeEach(() => {
  cleanup();
});

describe("buildLinkMarkdown", () => {
  it("有 title 生成 [text](url \"title\")", () => {
    expect(buildLinkMarkdown("示例", "https://a.com", "提示")).toBe(
      '[示例](https://a.com "提示")'
    );
  });

  it("无 title 生成 [text](url)", () => {
    expect(buildLinkMarkdown("示例", "https://a.com", "")).toBe("[示例](https://a.com)");
  });

  it("text 为空时用 url 作为显示文本", () => {
    expect(buildLinkMarkdown("", "https://a.com", "")).toBe(
      "[https://a.com](https://a.com)"
    );
  });

  it("url 为空时返回空串（不可插入）", () => {
    expect(buildLinkMarkdown("示例", "", "标题")).toBe("");
  });

  it("title 中双引号被转义，避免破坏 Markdown", () => {
    expect(buildLinkMarkdown("t", "u", 'say "hi"')).toBe('[t](u "say \\"hi\\"")');
  });

  it("空白 url 视为空", () => {
    expect(buildLinkMarkdown("t", "   ", "x")).toBe("");
  });
});

describe("<LinkDialog />", () => {
  it("open=false 时不渲染", () => {
    const { container } = render(
      <LinkDialog open={false} onInsert={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("open=true 渲染三个输入框与预览", () => {
    render(<LinkDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs).toHaveLength(3);
    expect(screen.getByText(/Markdown 预览/)).toBeTruthy();
  });

  it("initialText/initialUrl 在打开时预填", () => {
    render(
      <LinkDialog
        open
        initialText="选中"
        initialUrl="https://b.com"
        onInsert={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs[0].value).toBe("选中");
    expect(inputs[1].value).toBe("https://b.com");
  });

  it("url 为空时插入按钮禁用", () => {
    render(<LinkDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const insertBtn = screen.getByRole("button", { name: /插入/ }) as HTMLButtonElement;
    expect(insertBtn.disabled).toBe(true);
  });

  it("输入 text/url/title 后预览更新并点击插入回调正确 Markdown", () => {
    const onInsert = vi.fn();
    render(<LinkDialog open onInsert={onInsert} onClose={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "示例" } });
    fireEvent.change(inputs[1], { target: { value: "https://a.com" } });
    fireEvent.change(inputs[2], { target: { value: "提示" } });

    // 预览更新
    const preview = screen.getByText(/\[示例\]\(https:\/\/a\.com "提示"\)/);
    expect(preview).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /插入/ }));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith('[示例](https://a.com "提示")');
  });

  it("无 title 时插入输出 [text](url)", () => {
    const onInsert = vi.fn();
    render(<LinkDialog open onInsert={onInsert} onClose={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "文本" } });
    fireEvent.change(inputs[1], { target: { value: "https://c.com" } });
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));
    expect(onInsert).toHaveBeenCalledWith("[文本](https://c.com)");
  });

  it("点击取消调用 onClose", () => {
    const onClose = vi.fn();
    render(<LinkDialog open onInsert={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 触发 onClose", () => {
    const onClose = vi.fn();
    render(<LinkDialog open onInsert={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter 在 url 非空时触发插入", () => {
    const onInsert = vi.fn();
    render(<LinkDialog open onInsert={onInsert} onClose={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "x" } });
    fireEvent.change(inputs[1], { target: { value: "https://d.com" } });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith("[x](https://d.com)");
  });

  it("Enter 在 url 为空时不触发插入", () => {
    const onInsert = vi.fn();
    render(<LinkDialog open onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("点击遮罩层触发 onClose", () => {
    const onClose = vi.fn();
    const { container } = render(
      <LinkDialog open onInsert={vi.fn()} onClose={onClose} />
    );
    const overlay = container.querySelector(".link-dialog-overlay");
    expect(overlay).toBeTruthy();
    // 模拟点击遮罩（非冒泡阻断）
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
