/**
 * v0.12.1 需求3 回归测试：带图片的文档「切走再切回」图片仍可见
 *
 * 缺陷复现（用户报告）：打开带图片的 md（`![image.png](./assets/image-3.png)`）→ 切到
 * 另一个文档 → 再切回来，图片消失。
 *
 * 根因：图片相对路径由 schema.image.toDOM 用**模块级全局** currentDocPath 解析
 * （utils/imagePath）。App 层"设路径"与"投内容"都是 React 状态，而子组件
 * （EditorContainer）的 effect 先于父组件 App 的 effect 执行 → 切标签时解析图片用的
 * 还是上一个文档的目录（甚至空串）→ 图片路径错，表现为"图片没了"。
 *
 * 本测试用真实 EditorContainer + 完整 Tauri 桩（convertFileSrc 直接拼 asset:// 前缀），
 * 断言三种时序下的 img src：
 *   ① 首次挂载（createEditor 路径）
 *   ② 切到无图文档
 *   ③ 切回原文档（旧实现在这一步会拿到上一个文档的目录 → 断言失败）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { EditorContainer } from "../components/editor/EditorContainer";
import { setCurrentDocPath } from "../utils/imagePath";

const DOC_A = "# 图片文档\n\n![image.png](./assets/image-3.png)\n";
const DOC_B = "# 纯文本文档\n\n这里没有图片。\n";

const PATH_A = "D:/10254/桌面/md测试.md";
const PATH_B = "D:/10254/文档/其他.md";

/** 完整 Tauri 运行时桩（convertFileSrc 转为可断言的 asset:// URL） */
function installTauriStub(prefix = "asset://localhost/") {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async () => 0,
    unregisterListener: async () => {},
    convertFileSrc: (p: string) => `${prefix}${p}`,
    plugins: {},
  };
}

function removeTauriStub() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

beforeEach(() => {
  localStorage.clear();
  installTauriStub();
  setCurrentDocPath(null);
});

afterEach(() => {
  cleanup();
  removeTauriStub();
  setCurrentDocPath(null);
});

describe("v0.12.1 需求3：文档切换后图片仍可见", () => {
  it("首次挂载：相对路径按本文档目录解析为 asset:// URL", async () => {
    render(<EditorContainer content={DOC_A} filePath={PATH_A} forceUpdateKey={1} />);
    await waitFor(() => {
      expect(document.querySelector(".ProseMirror img")).toBeTruthy();
    });
    const img = document.querySelector<HTMLImageElement>(".ProseMirror img")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/D:/10254/桌面/assets/image-3.png");
    // 原始相对路径必须保留在节点属性里（存盘写回的是相对路径，不是 asset URL）
    expect(img.getAttribute("alt")).toBe("image.png");
  });

  it("切到无图文档再切回：图片 src 仍按**原文档**目录解析（回归点）", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_A} filePath={PATH_A} forceUpdateKey={1} />,
    );
    await waitFor(() => expect(document.querySelector(".ProseMirror img")).toBeTruthy());

    // ② 切到 B：无图
    rerender(<EditorContainer content={DOC_B} filePath={PATH_B} forceUpdateKey={2} />);
    await waitFor(() => {
      expect(document.querySelector(".ProseMirror")!.textContent).toContain("这里没有图片");
    });
    expect(document.querySelector(".ProseMirror img")).toBeNull();

    // ③ 切回 A：图片必须回来，且路径是 A 的目录（不是 B 的）
    rerender(<EditorContainer content={DOC_A} filePath={PATH_A} forceUpdateKey={3} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror img")).toBeTruthy());
    const img = document.querySelector<HTMLImageElement>(".ProseMirror img")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/D:/10254/桌面/assets/image-3.png");
    expect(img.getAttribute("src")).not.toContain("文档/其他");
  });

  it("内容与路径同帧变化的极端时序：仍用新路径解析（不受 effect 执行顺序影响）", async () => {
    // 模拟 App 层"先设路径、后投内容"两条 useEffect 的执行顺序差异：
    // 直接把全局路径指到另一个文档，再让 EditorContainer 收到新内容 + 新路径
    setCurrentDocPath(PATH_B);
    render(<EditorContainer content={DOC_A} filePath={PATH_A} forceUpdateKey={1} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror img")).toBeTruthy());
    const img = document.querySelector<HTMLImageElement>(".ProseMirror img")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/D:/10254/桌面/assets/image-3.png");
  });
});
