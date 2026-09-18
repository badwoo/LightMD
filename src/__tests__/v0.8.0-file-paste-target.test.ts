/**
 * v0.8.0 修复 P1（需求1 问题1/问题2）单元测试
 *
 * - 问题1：侧栏操作提示改为全局浮动 toast，不再在侧栏内插入内联提示条（避免抖动）
 * - 问题2：Ctrl+V 粘贴目标优先使用"用户点选的文件夹"，而不是固定的
 *          "当前文件所在目录 / 第一个打开文件夹"
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePasteTargetDir } from "../utils/fileClipboard";

const fileTreeSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/FileTree.tsx"),
  "utf-8",
);

describe("v0.8.0 修复 P1-2 resolvePasteTargetDir（粘贴目标解析）", () => {
  it("优先使用用户点选的文件夹", () => {
    expect(resolvePasteTargetDir("D:/picked", "D:/other/a.md", ["D:/first"])).toBe("D:/picked");
  });

  it("未点选时回退到当前活跃文件所在目录", () => {
    expect(resolvePasteTargetDir(null, "D:/other/a.md", ["D:/first"])).toBe("D:/other");
  });

  it("既无点选也无活跃文件时回退到第一个已打开文件夹", () => {
    expect(resolvePasteTargetDir(null, null, ["D:/first", "D:/second"])).toBe("D:/first");
  });

  it("三者都为空时返回空串（调用方据此跳过粘贴）", () => {
    expect(resolvePasteTargetDir(null, null, [])).toBe("");
    expect(resolvePasteTargetDir("", "", [])).toBe("");
  });

  it("兼容 Windows 反斜杠路径（父目录统一为 / 分隔）", () => {
    expect(resolvePasteTargetDir(null, "D:\\docs\\a.md", [])).toBe("D:/docs");
  });
});

describe("v0.8.0 修复 P1-2 侧栏点击文件夹即设为粘贴目标", () => {
  it("FileTree 使用 resolvePasteTargetDir 纯函数解析目标", () => {
    expect(fileTreeSrc).toContain("resolvePasteTargetDir(pasteTargetDir");
  });

  it("文件夹区域在 capture 阶段记录粘贴目标（点标题栏/空白处都生效）", () => {
    expect(fileTreeSrc).toContain("onMouseDownCapture");
    expect(fileTreeSrc).toContain("onActivateFolder");
  });
});

describe("v0.8.0 修复 P4-1 侧栏「新增文件」改为新建临时文件", () => {
  it("工具栏按钮派发 file.new 命令（与 Ctrl+N 同一路径，保证编辑器上下文同步）", () => {
    expect(fileTreeSrc).toContain('detail: { id: "file.new" }');
  });

  it("不再固定把新文件建到第一个打开的文件夹（rootPath）", () => {
    expect(fileTreeSrc).not.toContain("handleNewFile(rootPath");
  });
});

describe("v0.8.0 修复 P1-1 侧栏提示改为全局浮动 toast", () => {
  it("不再渲染内联的 filetree-status 提示条", () => {
    expect(fileTreeSrc).not.toContain("filetree-status");
    expect(fileTreeSrc).not.toContain("statusMessage");
  });

  it("提示改为侧栏旁的浮动层（v0.8.0 修复 P11-8：不占布局也不跑到软件右下角）", () => {
    expect(fileTreeSrc).toContain("filetree-toast-stack");
    expect(fileTreeSrc).toContain("pushToast(msg, false)");
    expect(fileTreeSrc).toContain("pushToast(msg, true)");
  });
});