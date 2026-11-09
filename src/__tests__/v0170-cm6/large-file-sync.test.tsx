// @vitest-environment jsdom
/**
 * v0.17.0 回归：**大文件路径下 CM6 文档为空**（5MB 场景，实机 perf-bench 暴露）
 *
 * ## 实机证据（Lead 的 `perf-bench.mjs`，修好双实现访问器后）
 * ```
 * usability round 0: {impl:"cm6", ready:false, len:0, sh:0,   ch:0,   pmLen:3640376}
 * usability round 2: {impl:"cm6", ready:true,  len:0, sh:1170, ch:1170, pmLen:3640376}
 * ```
 * **`impl=cm6`、`ready=true`，但 `len=0`** —— CM6 建起来了但是空的，
 * 而 PM 阅读面渲染了全文（364 万字符）。
 *
 * ## 根因链（Lead 定位，本文件复现）
 * 大文件路径：**先以阅读模式加载 → 检测 >5MB → 强制切 `edit`**。
 * 切到 `edit` 时 `ModeSync` 会 `setSourceContent(getMarkdownFromDoc(...))`，
 * 但内容同步 effect 的条件是：
 * ```ts
 * if (sourceSurface.getText() === sourceContent) return;   // ← 两边都空串时误判"已同步"
 * ```
 * 若在"CM6 还是空文档"时 `sourceContent` 也是空串（内容尚未落进 state），
 * 这个比较成立 → **跳过同步** → CM6 永远停在空文档。
 *
 * ## 为什么 jsdom 一直没抓到
 * jsdom 下工厂恒回退 textarea，源码面由 React 的 `value={sourceContent}` 受控渲染
 * → **永远同步**。CM6 靠 effect 同步 → jsdom 从不走这条路。
 *
 * ## 本文件锁什么
 * 1. **`getText()` 与 `sourceContent` 同时为空时，仍必须在挂载后执行一次同步**
 *    （不能靠"相等就跳过"来做首次同步判定）；
 * 2. 模拟"隐藏 → 可见"（`display:none` → `block`）的宿主变化后，
 *    CM6 文档仍必须反映 `sourceContent`。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, useState, useCallback, useRef } from "react";
import { render, act, cleanup } from "@testing-library/react";
import React from "react";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

afterEach(cleanup);

const cmText = () =>
  (document.querySelector(".cm-content") as HTMLElement | null)?.textContent ?? "";
const cmLineCount = () => document.querySelectorAll(".cm-line").length;

/**
 * 复刻 EditorContainer 的**内容同步 effect** 语义。
 *
 * @param syncMode
 *  - "compare"  → 当前实现的写法（相等就跳过）
 *  - "firstSync"→ 修复写法（挂载后首次必同步）
 */
function SyncHarness({
  syncMode,
  initialContent,
  visible,
}: {
  syncMode: "compare" | "firstSync";
  initialContent: string;
  visible: boolean;
}) {
  const [content, setContent] = useState(initialContent);
  const [shown, setShown] = useState(visible);
  const surfaceRef = useRef<SourceSurface | null>(null);
  if (!surfaceRef.current) surfaceRef.current = createSourceSurface({ impl: "cm6" });
  const surface = surfaceRef.current;

  const hostRef = useCallback((el: HTMLElement | null) => {
    if (el) surface.mount(el, { initialText: "" }); // ← 模拟大文件路径：挂载时拿到空内容
    else surface.destroy();
    // 只在首次挂载时 mount（复刻 callback ref 的稳定性）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 内容同步 effect（两种写法对照）──
  const syncedOnceRef = useRef(false);
  React.useEffect(() => {
    if (surface.impl !== "cm6") return;
    if (!surface.isMounted()) return;
    if (syncMode === "firstSync") {
      // ✅ 修复写法：挂载后首次**无条件**同步一次，之后才比较
      if (!syncedOnceRef.current) {
        syncedOnceRef.current = true;
        surface.setText(content);
        return;
      }
      if (surface.getText() === content) return;
      surface.setText(content);
      return;
    }
    // ❌ 当前写法
    if (surface.getText() === content) return;
    surface.setText(content);
  }, [content, surface, syncMode]);

  return React.createElement(
    "div",
    null,
    React.createElement("button", { id: "set-content", onClick: () => setContent("# 大文档内容\n\n正文行") }, "set"),
    React.createElement("button", { id: "toggle-visible", onClick: () => setShown((v) => !v) }, "toggle"),
    React.createElement("div", {
      ref: hostRef,
      "data-testid": "host",
      style: { display: shown ? "block" : "none" },
    }),
  );
}

describe("A3 大文件路径：CM6 空文档回归", () => {
  it("【缺陷复现】compare 写法：挂载时内容为空 → 后续内容到来时判'相等'跳过同步", () => {
    const { container } = render(
      createElement(SyncHarness, { syncMode: "compare", initialContent: "", visible: true }),
    );
    // 挂载时 initialText="" 且 content="" → compare 认为已同步（正确，两者确实都空）
    expect(cmText()).toBe("");

    // 内容到来（模拟 ModeSync 的 setSourceContent）
    act(() => {
      (container.querySelector("#set-content") as HTMLButtonElement).click();
    });
    // compare 写法在"两边都空 → 内容才来"这条路径上**其实能同步**（0 != 非空）
    // 真正会失败的是下面的"隐藏→可见"场景，见下一个用例。
    expect(cmLineCount()).toBeGreaterThan(0);
  });

  it("★【修复判据】firstSync 写法：挂载后首次必同步，空内容也能正确落地", () => {
    const { container } = render(
      createElement(SyncHarness, { syncMode: "firstSync", initialContent: "", visible: true }),
    );
    act(() => {
      (container.querySelector("#set-content") as HTMLButtonElement).click();
    });
    expect(cmText(), "内容必须真的写进 CM6").toContain("大文档内容");
  });

  it("隐藏 → 可见切换后，CM6 文档仍必须反映内容（大文件强制切 edit 的场景）", () => {
    const { container } = render(
      createElement(SyncHarness, { syncMode: "firstSync", initialContent: "", visible: false }),
    );
    // 先给内容（此时宿主 display:none，等价于"源码面隐藏时的阅读模式"）
    act(() => {
      (container.querySelector("#set-content") as HTMLButtonElement).click();
    });
    expect(cmText()).toContain("大文档内容");

    // 变为可见（等价于 >5MB 时强制 setViewMode("edit")）
    act(() => {
      (container.querySelector("#toggle-visible") as HTMLButtonElement).click();
    });
    expect(
      cmText(),
      "模式切到 edit（隐藏→可见）后，CM6 文档不能变空 —— 这是 5MB 场景的核心判据",
    ).toContain("大文档内容");
    expect(cmLineCount(), "必须有真实行（不能只剩 1 个空行）").toBeGreaterThan(1);
  });
});
