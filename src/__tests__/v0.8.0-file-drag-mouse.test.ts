/**
 * v0.8.0 修复 P3：自制鼠标拖拽（fileDragMouse）单元测试
 *
 * 背景：Tauri 的 dragDropEnabled=true 会在 Windows 上拦截 HTML5 拖放事件，
 * 导致"打开的文件 → 已打开文件夹"的内部拖拽完全不触发。改用鼠标事件自制拖拽。
 *
 * 覆盖：
 * - resolveDragMode：Shift = 移动，否则复制
 * - isDragStarted：拖拽启动阈值（小于阈值视为点击）
 * - resolveDropDirFromElement / findDropDirAt：落点识别（取最近的 data-drop-dir）
 * - beginFileDrag 会话：阈值、Shift 语义、落点高亮与浮层清理、Esc 取消、无效落点
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  beginFileDrag,
  resolveDragMode,
  isDragStarted,
  resolveDropDirFromElement,
  findDropDirAt,
  DROP_DIR_ATTR,
  DRAG_ACTIVE_CLASS,
  DRAG_THRESHOLD_PX,
} from "../utils/fileDragMouse";

function mountDropDir(dir: string): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute(DROP_DIR_ATTR, dir);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.body.classList.remove("file-dragging");
});

describe("v0.8.0 修复 P3 resolveDragMode（Shift = 移动）", () => {
  it("默认复制，按住 Shift 为移动", () => {
    expect(resolveDragMode(false)).toBe("copy");
    expect(resolveDragMode(true)).toBe("move");
  });
});

describe("v0.8.0 修复 P3 isDragStarted（拖拽启动阈值）", () => {
  it("小于阈值不算拖拽（保住点击/选择行为）", () => {
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(isDragStarted(0, 0)).toBe(false);
    expect(isDragStarted(3, -3)).toBe(false);
    expect(isDragStarted(1, 2, 3)).toBe(false);
  });

  it("任一方向达到阈值即算拖拽", () => {
    expect(isDragStarted(4, 0)).toBe(true);
    expect(isDragStarted(0, -4)).toBe(true);
    expect(isDragStarted(10, 2)).toBe(true);
  });
});

describe("v0.8.0 修复 P3 落点识别（data-drop-dir）", () => {
  it("嵌套时取最近的可投放文件夹", () => {
    const outer = mountDropDir("D:/a");
    const inner = mountDropDir("D:/a/b");
    outer.appendChild(inner);
    const leaf = document.createElement("span");
    inner.appendChild(leaf);

    expect(resolveDropDirFromElement(leaf)).toBe("D:/a/b");
    expect(resolveDropDirFromElement(inner)).toBe("D:/a/b");
    expect(resolveDropDirFromElement(outer)).toBe("D:/a");
  });

  it("非落点元素与空值返回 null", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(resolveDropDirFromElement(plain)).toBe(null);
    expect(resolveDropDirFromElement(null)).toBe(null);
    expect(resolveDropDirFromElement(undefined)).toBe(null);
  });

  it("findDropDirAt 通过注入的 hitTest 判定坐标落点", () => {
    const holder = mountDropDir("D:/docs");
    const child = document.createElement("span");
    holder.appendChild(child);

    expect(findDropDirAt(10, 20, () => child)).toBe("D:/docs");
    expect(findDropDirAt(10, 20, () => null)).toBe(null);
  });
});

describe("v0.8.0 修复 P3 beginFileDrag 拖拽会话", () => {
  const payload = { path: "D:/src/a.md", name: "a.md" };

  it("位移不足阈值 → 视为点击：不生成浮层、不回调", () => {
    const onDrop = vi.fn();
    beginFileDrag(payload, { clientX: 100, clientY: 100, button: 0 }, { onDrop }, () => null);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 102, clientY: 101 }));
    expect(document.querySelector(".file-drag-ghost")).toBe(null);

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 102, clientY: 101 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("超过阈值落到文件夹 → 默认复制，浮层与高亮在松手后清理", () => {
    const onDrop = vi.fn();
    const target = mountDropDir("D:/docs");
    beginFileDrag(
      payload,
      { clientX: 0, clientY: 0, button: 0 },
      { onDrop },
      (x) => (x >= 50 ? target : null),
    );

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60, clientY: 8 }));
    const ghost = document.querySelector(".file-drag-ghost");
    expect(ghost).not.toBe(null);
    expect((ghost as HTMLElement).textContent).toBe("a.md");
    expect(target.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    expect(document.body.classList.contains("file-dragging")).toBe(true);

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 60, clientY: 8 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(payload, "D:/docs", "copy");
    expect(document.querySelector(".file-drag-ghost")).toBe(null);
    expect(target.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    expect(document.body.classList.contains("file-dragging")).toBe(false);
  });

  it("按住 Shift 松手 → 移动语义", () => {
    const onDrop = vi.fn();
    const target = mountDropDir("D:/docs");
    beginFileDrag(
      payload,
      { clientX: 0, clientY: 0, button: 0 },
      { onDrop },
      () => target,
    );

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 40, clientY: 0, shiftKey: true }));

    expect(onDrop).toHaveBeenCalledWith(payload, "D:/docs", "move");
  });

  it("落在非文件夹区域 → 不回调，但仍清理浮层", () => {
    const onDrop = vi.fn();
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, { onDrop }, () => null);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 0 }));
    expect(document.querySelector(".file-drag-ghost")).not.toBe(null);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 80, clientY: 0 }));

    expect(onDrop).not.toHaveBeenCalled();
    expect(document.querySelector(".file-drag-ghost")).toBe(null);
  });

  it("Esc 取消拖拽：不回调且清理浮层", () => {
    const onDrop = vi.fn();
    const target = mountDropDir("D:/docs");
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, { onDrop }, () => target);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60, clientY: 0 }));
    expect(target.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".file-drag-ghost")).toBe(null);
    expect(target.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);

    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 60, clientY: 0 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("窗口失焦（窗口外松手等）取消拖拽并清理，且可继续发起新拖拽", () => {
    const onDrop = vi.fn();
    const target = mountDropDir("D:/docs");
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, { onDrop }, () => target);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60, clientY: 0 }));
    expect(document.querySelector(".file-drag-ghost")).not.toBe(null);

    window.dispatchEvent(new Event("blur"));
    expect(document.querySelector(".file-drag-ghost")).toBe(null);
    expect(target.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);

    // 会话已释放：新的拖拽可以正常启动
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 0 }, { onDrop }, () => target);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60, clientY: 0 }));
    expect(document.querySelector(".file-drag-ghost")).not.toBe(null);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 60, clientY: 0 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("非左键（如右键）按下不启动拖拽", () => {
    const onDrop = vi.fn();
    beginFileDrag(payload, { clientX: 0, clientY: 0, button: 2 }, { onDrop }, () => null);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 60, clientY: 0 }));
    expect(document.querySelector(".file-drag-ghost")).toBe(null);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 60, clientY: 0 }));
    expect(onDrop).not.toHaveBeenCalled();
  });
});