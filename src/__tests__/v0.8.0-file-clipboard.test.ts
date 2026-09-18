/**
 * v0.8.0 WP2 需求1：文件剪贴板与拖拽载荷工具测试
 *
 * 覆盖：
 * - 内存剪贴板的 set/get/clear/has（明确不使用系统剪贴板）
 * - makeUniqueName：重名时" - 副本"递增、保留扩展名、无扩展名情形
 * - isFileDrag / readDragPath：识别自定义 MIME、纯路径兜底、空载荷
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  setClipboard,
  getClipboard,
  clearClipboard,
  hasClipboard,
  makeUniqueName,
  isFileDrag,
  readDragPath,
  resolveTransferName,
  clipboardTransferMode,
  FILE_DRAG_MIME,
} from "../utils/fileClipboard";

/** 构造一个最小的 DataTransfer 替身 */
function fakeDT(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

describe("v0.8.0 WP2 文件剪贴板", () => {
  beforeEach(() => clearClipboard());

  it("set/get/clear/has 行为正确（未指定 mode 时默认 copy）", () => {
    expect(hasClipboard()).toBe(false);
    expect(getClipboard()).toBeNull();

    setClipboard({ path: "D:/docs/a.md", name: "a.md" });
    expect(hasClipboard()).toBe(true);
    expect(getClipboard()).toEqual({ path: "D:/docs/a.md", name: "a.md", mode: "copy" });

    clearClipboard();
    expect(getClipboard()).toBeNull();
  });

  it("P13-1：剪切模式写入并被 clipboardTransferMode 映射为 move", () => {
    setClipboard({ path: "D:/docs/a.md", name: "a.md", mode: "cut" });
    expect(getClipboard()).toEqual({ path: "D:/docs/a.md", name: "a.md", mode: "cut" });
    expect(clipboardTransferMode(getClipboard())).toBe("move");
  });

  it("P13-1：复制模式（含空剪贴板）映射为 copy", () => {
    setClipboard({ path: "D:/docs/a.md", name: "a.md", mode: "copy" });
    expect(clipboardTransferMode(getClipboard())).toBe("copy");
    expect(clipboardTransferMode(null)).toBe("copy");
  });

  it("P13-1：非法 mode 归一化为 copy", () => {
    setClipboard({ path: "D:/a.md", name: "a.md", mode: "unknown" as never });
    expect(getClipboard()?.mode).toBe("copy");
  });

  it("未触碰系统剪贴板（不调用 navigator.clipboard）", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    setClipboard({ path: "D:/docs/a.md", name: "a.md" });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("v0.8.0 WP2 makeUniqueName（重名自动副本）", () => {
  it("无冲突时保持原名", () => {
    expect(makeUniqueName("a.md", ["b.md"])).toBe("a.md");
    expect(makeUniqueName("a.md", [])).toBe("a.md");
  });

  it("冲突时追加 ' - 副本'，保留扩展名", () => {
    expect(makeUniqueName("a.md", ["a.md"])).toBe("a - 副本.md");
  });

  it("连续冲突时递增序号", () => {
    expect(makeUniqueName("a.md", ["a.md", "a - 副本.md"])).toBe("a - 副本2.md");
    expect(
      makeUniqueName("a.md", ["a.md", "a - 副本.md", "a - 副本2.md"]),
    ).toBe("a - 副本3.md");
  });

  it("无扩展名时直接追加", () => {
    expect(makeUniqueName("assets", ["assets"])).toBe("assets - 副本");
  });

  it("支持 Set 与数组两种入参", () => {
    expect(makeUniqueName("a.md", new Set(["a.md"]))).toBe("a - 副本.md");
  });
});

describe("v0.8.0 WP2 拖拽载荷", () => {
  it("识别自定义 MIME 与 text/plain", () => {
    expect(isFileDrag({ dataTransfer: fakeDT({ [FILE_DRAG_MIME]: "{}" }) })).toBe(true);
    expect(isFileDrag({ dataTransfer: fakeDT({ "text/plain": "D:/a.md" }) })).toBe(true);
    expect(isFileDrag({ dataTransfer: fakeDT({ "text/html": "<b>x</b>" }) })).toBe(false);
    expect(isFileDrag({ dataTransfer: null })).toBe(false);
  });

  it("readDragPath 解析 JSON 载荷", () => {
    const dt = fakeDT({ [FILE_DRAG_MIME]: JSON.stringify({ path: "D:/docs/a.md" }) });
    expect(readDragPath({ dataTransfer: dt })).toBe("D:/docs/a.md");
  });

  it("readDragPath 兼容纯路径与非 JSON 载荷", () => {
    expect(readDragPath({ dataTransfer: fakeDT({ "text/plain": "D:/docs/b.md" }) })).toBe(
      "D:/docs/b.md",
    );
    // 自定义 MIME 里塞了非 JSON 字符串时按纯路径返回
    expect(readDragPath({ dataTransfer: fakeDT({ [FILE_DRAG_MIME]: "D:/docs/c.md" }) })).toBe(
      "D:/docs/c.md",
    );
    expect(readDragPath({ dataTransfer: null })).toBe("");
  });
});

describe("v0.8.0 修复 P1-7 resolveTransferName（移动到自身目录 no-op）", () => {
  it("移动到自身所在目录 → null（不执行任何操作，不再误改名' - 副本'）", () => {
    expect(
      resolveTransferName("D:/docs/a.md", "D:/docs", "move", ["a.md"]),
    ).toBeNull();
    // 分隔符与结尾斜杠差异也应判等
    expect(
      resolveTransferName("D:\\docs\\a.md", "D:/docs/", "move", ["a.md"]),
    ).toBeNull();
  });

  it("移动到其他目录 → 原名（不冲突时）", () => {
    expect(resolveTransferName("D:/docs/a.md", "D:/notes", "move", [])).toBe("a.md");
  });

  it("移动到其他目录且重名 → 生成副本名", () => {
    expect(resolveTransferName("D:/docs/a.md", "D:/notes", "move", ["a.md"])).toBe(
      "a - 副本.md",
    );
  });

  it("复制到自身所在目录 → 仍生成副本名（复制语义与移动不同，不是 no-op）", () => {
    expect(resolveTransferName("D:/docs/a.md", "D:/docs", "copy", ["a.md"])).toBe(
      "a - 副本.md",
    );
  });

  it("空文件名 → null", () => {
    expect(resolveTransferName("D:/docs/", "D:/notes", "move", [])).toBeNull();
  });
});
