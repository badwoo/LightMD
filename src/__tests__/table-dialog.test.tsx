/**
 * TableDialog 组件测试
 *
 * 覆盖：
 * - buildTableMarkdown 纯函数（行列数、表头开关、边界值）
 * - 组件渲染、输入、预览、点击插入/取消
 * - 快捷键 Esc 取消、Enter 插入
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TableDialog, buildTableMarkdown } from "../components/dialogs/TableDialog";

beforeEach(() => {
  cleanup();
});

describe("buildTableMarkdown", () => {
  it("2 行 3 列含表头输出标准表格", () => {
    const md = buildTableMarkdown(2, 3, true);
    expect(md).toBe(
      "| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |"
    );
  });

  it("1 行 2 列含表头只有表头和分隔行", () => {
    const md = buildTableMarkdown(1, 2, true);
    expect(md).toBe("| 列1 | 列2 |\n|------|------|");
  });

  it("不含表头时表头单元格为「内容」", () => {
    const md = buildTableMarkdown(1, 2, false);
    expect(md).toBe("| 内容 | 内容 |\n|------|------|");
  });

  it("3 行 2 列不含表头包含 2 行数据（表头占 1 行）", () => {
    const md = buildTableMarkdown(3, 2, false);
    const lines = md.split("\n");
    // 3 行总行数：表头(内容) + 分隔 + 2 数据行 = 4 行输出
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("| 内容 | 内容 |");
    expect(lines[2]).toBe("| 内容 | 内容 |");
    expect(lines[3]).toBe("| 内容 | 内容 |");
  });

  it("列数越界被 clamp 到 10", () => {
    const md = buildTableMarkdown(1, 99, true);
    const headerCells = md.split("\n")[0].split("|").filter(Boolean);
    expect(headerCells).toHaveLength(10);
  });

  it("行数越界被 clamp 到 20", () => {
    const md = buildTableMarkdown(99, 1, true);
    const lines = md.split("\n");
    // 表头 + 分隔 + 19 数据行（含表头时数据行 = rows-1）
    expect(lines).toHaveLength(2 + 19);
  });

  it("rows<=0 视为 1", () => {
    const md = buildTableMarkdown(0, 1, true);
    expect(md).toBe("| 列1 |\n|------|");
  });

  it("cols<=0 视为 1", () => {
    const md = buildTableMarkdown(1, -5, true);
    expect(md).toBe("| 列1 |\n|------|");
  });
});

describe("<TableDialog />", () => {
  it("open=false 时不渲染", () => {
    const { container } = render(
      <TableDialog open={false} onInsert={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("open=true 渲染行列输入与预览", () => {
    render(<TableDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const numbers = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(numbers).toHaveLength(2);
    // 默认 3x3 含表头
    expect(numbers[0].value).toBe("3");
    expect(numbers[1].value).toBe("3");
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("修改行列后预览更新", () => {
    render(<TableDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const numbers = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numbers[0], { target: { value: "2" } });
    fireEvent.change(numbers[1], { target: { value: "3" } });
    // 预览区第一行应为 | 列1 | 列2 | 列3 |
    const preview = screen.getByText(/\| 列1 \| 列2 \| 列3 \|/);
    expect(preview).toBeTruthy();
  });

  it("点击插入回调标准 Markdown", () => {
    const onInsert = vi.fn();
    render(<TableDialog open onInsert={onInsert} onClose={vi.fn()} />);
    const numbers = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numbers[0], { target: { value: "2" } });
    fireEvent.change(numbers[1], { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));
    expect(onInsert).toHaveBeenCalledWith(
      "| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |"
    );
  });

  it("取消表头勾选后插入输出无「列N」", () => {
    const onInsert = vi.fn();
    render(<TableDialog open onInsert={onInsert} onClose={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /插入/ }));
    expect(onInsert).toHaveBeenCalledWith(
      "| 内容 | 内容 | 内容 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |"
    );
  });

  it("点击取消调用 onClose", () => {
    const onClose = vi.fn();
    render(<TableDialog open onInsert={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 触发 onClose", () => {
    const onClose = vi.fn();
    render(<TableDialog open onInsert={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter 触发插入", () => {
    const onInsert = vi.fn();
    render(<TableDialog open onInsert={onInsert} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it("行数超出 20 被 clamp", () => {
    render(<TableDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const numbers = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numbers[0], { target: { value: "100" } });
    expect(numbers[0].value).toBe("20");
  });

  it("列数超出 10 被 clamp", () => {
    render(<TableDialog open onInsert={vi.fn()} onClose={vi.fn()} />);
    const numbers = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(numbers[1], { target: { value: "50" } });
    expect(numbers[1].value).toBe("10");
  });
});
