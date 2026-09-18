/**
 * v0.8.0 WP2 需求4(2)：新建文件夹弹框测试
 *
 * 覆盖：
 * 1. validateFolderName：必填、非法字符、通过
 * 2. resolveTargetDirs：自定义路径优先于勾选、无输入时为空
 * 3. 组件行为：单文件夹自动勾选、名称为空/非法时不提交、自定义路径覆盖勾选、
 *    确认时把（目标父目录列表, 文件夹名）交给 onConfirm
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  NewFolderDialog,
  validateFolderName,
  resolveTargetDirs,
} from "../components/dialogs/NewFolderDialog";

const FOLDERS = [
  { path: "D:/docs", name: "docs" },
  { path: "D:/notes", name: "notes" },
];

afterEach(cleanup);

describe("v0.8.0 WP2 validateFolderName", () => {
  it("空名字 → 必填提示", () => {
    expect(validateFolderName("")).toBe("newFolder.nameRequired");
    expect(validateFolderName("   ")).toBe("newFolder.nameRequired");
  });

  it("非法字符 → 非法提示（\\ / : * ? \" < > |）", () => {
    for (const bad of ['a/b', "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(validateFolderName(bad)).toBe("newFolder.invalidName");
    }
  });

  it("合法名字 → null", () => {
    expect(validateFolderName("项目笔记")).toBeNull();
    expect(validateFolderName("v0.8.0 notes")).toBeNull();
  });
});

describe("v0.8.0 WP2 resolveTargetDirs", () => {
  it("自定义路径优先，忽略勾选", () => {
    expect(resolveTargetDirs(["D:/docs"], "D:/custom")).toEqual(["D:/custom"]);
  });

  it("无自定义路径时用勾选（过滤空值）", () => {
    expect(resolveTargetDirs(["D:/docs", "D:/notes"], "")).toEqual(["D:/docs", "D:/notes"]);
    expect(resolveTargetDirs(["", "D:/docs"], "  ")).toEqual(["D:/docs"]);
  });

  it("都为空 → 空数组", () => {
    expect(resolveTargetDirs([], "")).toEqual([]);
  });
});

describe("v0.8.0 WP2 NewFolderDialog 组件", () => {
  it("只有一个打开文件夹时默认勾选它，确认后按该目录创建", () => {
    const onConfirm = vi.fn();
    render(
      <NewFolderDialog
        open
        openFolders={[FOLDERS[0]!]}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByPlaceholderText(/新文件夹|New Folder/i);
    fireEvent.change(input, { target: { value: "子目录" } });
    fireEvent.click(screen.getByText(/^创建$|^Create$/));
    expect(onConfirm).toHaveBeenCalledWith(["D:/docs"], "子目录");
  });

  it("名称为空时不提交并提示", () => {
    const onConfirm = vi.fn();
    render(<NewFolderDialog open openFolders={FOLDERS} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText(/^创建$|^Create$/));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/请输入文件夹名|enter a folder name/i)).toBeTruthy();
  });

  it("名称含非法字符时不提交", () => {
    const onConfirm = vi.fn();
    render(<NewFolderDialog open openFolders={FOLDERS} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByPlaceholderText(/新文件夹|New Folder/i), {
      target: { value: "a/b" },
    });
    fireEvent.click(screen.getByText(/^创建$|^Create$/));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/不能包含|cannot contain/i)).toBeTruthy();
  });

  it("多选目标文件夹时全部生效", () => {
    const onConfirm = vi.fn();
    render(<NewFolderDialog open openFolders={FOLDERS} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByPlaceholderText(/新文件夹|New Folder/i), {
      target: { value: "共享" },
    });
    // 勾选两个文件夹
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByText(/^创建$|^Create$/));
    expect(onConfirm).toHaveBeenCalledWith(["D:/docs", "D:/notes"], "共享");
  });

  it("填写自定义路径时优先生效，勾选被禁用", () => {
    const onConfirm = vi.fn();
    render(<NewFolderDialog open openFolders={FOLDERS} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByPlaceholderText(/新文件夹|New Folder/i), {
      target: { value: "新目录" },
    });
    // 自定义路径输入框（用 id 精确定位，避免与"文件夹名"输入框的同值歧义）
    const pathInput = document.getElementById("newfolder-path") as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: "D:/custom" } });
    expect(pathInput.value).toBe("D:/custom");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled)).toBe(true);
    fireEvent.click(screen.getByText(/^创建$|^Create$/));
    expect(onConfirm).toHaveBeenCalledWith(["D:/custom"], "新目录");
  });

  it("没有打开文件夹且未填自定义路径时提示需要目标", () => {
    const onConfirm = vi.fn();
    render(<NewFolderDialog open openFolders={[]} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByPlaceholderText(/新文件夹|New Folder/i), {
      target: { value: "无目标" },
    });
    fireEvent.click(screen.getByText(/^创建$|^Create$/));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/至少选择一个|at least one/i)).toBeTruthy();
  });

  it("open=false 时不渲染", () => {
    const { container } = render(
      <NewFolderDialog open={false} openFolders={FOLDERS} onClose={() => {}} onConfirm={vi.fn()} />,
    );
    expect(container.querySelector(".newfolder-dialog")).toBeNull();
  });
});
