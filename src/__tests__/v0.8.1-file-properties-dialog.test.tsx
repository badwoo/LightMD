/**
 * v0.8.1 需求3：文件属性对话框（替代原生 alert，避免 WebView2 系统提示音）
 *
 * 覆盖：
 * 1. buildPropertyRows 数据组装（含/不含大小、未知类型）
 * 2. 渲染与关闭（关闭按钮 / 遮罩 / Esc）
 * 3. 防回归：FileTree 不再使用原生 alert()
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FilePropertiesDialog,
  buildPropertyRows,
  type FilePropertiesData,
} from "../components/dialogs/FilePropertiesDialog";
import { t } from "../i18n/state";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");

const baseFile: FilePropertiesData = {
  name: "note.md",
  path: "D:/docs/note.md",
  dir: "D:/docs",
  ext: "md",
  sizeText: "1.5 KB",
};

afterEach(() => {
  cleanup();
});

// ─── 1. 数据组装 ─────────────────────────────────────────
describe("v0.8.1 buildPropertyRows 属性行组装", () => {
  it("含大小行时共 5 行，顺序为 名称/路径/目录/类型/大小", () => {
    const rows = buildPropertyRows(baseFile, t);
    expect(rows.map((r) => r.value)).toEqual([
      "note.md",
      "D:/docs/note.md",
      "D:/docs",
      ".md",
      "1.5 KB",
    ]);
  });

  it("sizeText 为空时不产出大小行", () => {
    const rows = buildPropertyRows({ ...baseFile, sizeText: "" }, t);
    expect(rows).toHaveLength(4);
  });

  it("扩展名为空时类型显示「未知」", () => {
    const rows = buildPropertyRows({ ...baseFile, ext: "", name: "LICENSE" }, t);
    const typeRow = rows.find((r) => r.label === t("fileprops.type"));
    expect(typeRow?.value).toBe(t("filetree.propUnknownType"));
  });
});

// ─── 2. 渲染与关闭 ───────────────────────────────────────
describe("v0.8.1 FilePropertiesDialog 渲染与关闭", () => {
  it("file 为 null 时不渲染", () => {
    render(<FilePropertiesDialog file={null} onClose={() => {}} />);
    expect(screen.queryByTestId("file-properties-dialog")).toBeNull();
  });

  it("传递数据时渲染各字段值（英文/中文均含关键内容）", () => {
    render(<FilePropertiesDialog file={baseFile} onClose={() => {}} />);
    const dialog = screen.getByTestId("file-properties-dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByText("note.md")).toBeTruthy();
    expect(screen.getByText("D:/docs/note.md")).toBeTruthy();
    expect(screen.getByText("1.5 KB")).toBeTruthy();
  });

  it("点击关闭按钮触发 onClose", () => {
    const onClose = vi.fn();
    render(<FilePropertiesDialog file={baseFile} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("file-properties-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击遮罩触发 onClose，点击弹框内部不触发", () => {
    const onClose = vi.fn();
    render(<FilePropertiesDialog file={baseFile} onClose={onClose} />);
    fireEvent.click(screen.getByText("note.md")); // 内部
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("file-properties-dialog")); // 遮罩
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("按 Esc 触发 onClose", () => {
    const onClose = vi.fn();
    render(<FilePropertiesDialog file={baseFile} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. 防回归 ───────────────────────────────────────────
describe("v0.8.1 属性查看不再使用原生 alert", () => {
  it("FileTree.tsx 不含 alert( 调用，且已接入 FilePropertiesDialog", () => {
    const src = read("../components/sidebar/FileTree.tsx");
    expect(src).not.toMatch(/\balert\(/);
    expect(src).toContain("FilePropertiesDialog");
    expect(src).toContain("setPropFile");
  });

  it("中英文都新增了 fileprops.* 词典", () => {
    expect(read("../i18n/locales/zh-CN.ts")).toContain('"fileprops.title": "文件属性"');
    expect(read("../i18n/locales/en-US.ts")).toContain('"fileprops.title": "File Properties"');
  });
});
