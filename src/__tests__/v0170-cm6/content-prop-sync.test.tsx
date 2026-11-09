// @vitest-environment jsdom
/**
 * v0.17.0 装配回归：**`content` prop 变化必须跟进 `sourceContent`**
 *
 * ## 缺陷（5MB 大文件场景，实机 `perf-bench` 暴露，我用独立探针复现）
 *
 * `sourceContent` 由 `useState(content)` 初始化 —— **只在挂载时取一次**。
 * 之后 App 把 `content` 换成 5MB 新文档时，`sourceContent` **不跟随**，
 * 仍停留在挂载时的 32 字符欢迎文档。
 *
 * 实机日志证据（修前 / 修后）：
 * ```
 * 修前:
 *   [APPDIAG] setContent len=5452669            ← App 设为 5MB
 *   [SYNCDIAG] contentPropLen=5452669           ← prop 已是 5MB
 *   [SYNCDIAG] stateLen=32 head="# 欢迎使用 LightMD"   ← state 还是欢迎文档
 *   → CM6 显示欢迎文档，5MB 文件打开后一片空白
 *
 * 修后:
 *   renderedLines=74697 / renderedTextLen=5452669   ← 5MB 全部进入 CM6
 * ```
 *
 * ## 为什么 jsdom 一直没抓到
 * textarea 路径的源码面是 `value={sourceContent}` 受控渲染，而 `sourceContent`
 * 就是那个不跟随的 state —— **jsdom 下同样会显示旧内容**，但既有测试都用
 * `forceUpdateKey` 或直接断言 PM 文本，没有一条断言"换 `content` prop 后源码面文本变了"。
 * CM6 路径则完全依赖这个 state → 表现为空白。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createElement, useState, useCallback, useRef, useEffect } from "react";
import { render, act, cleanup } from "@testing-library/react";
import React from "react";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

afterEach(cleanup);

const cmText = () =>
  (document.querySelector(".cm-content") as HTMLElement | null)?.textContent ?? "";

/**
 * 复刻 EditorContainer 的关键链路：`content` prop → `sourceContent` state → CM6。
 *
 * @param followProp true = 修复后的写法（prop 变化跟进 state）；
 *                   false = 缺陷形态（`useState(content)` 后不再跟随）
 */
function Harness({ followProp }: { followProp: boolean }) {
  const [content, setContent] = useState("# 欢迎使用 LightMD\n\n开始输入 Markdown...");
  const [sourceContent, setSourceContent] = useState(content);
  const surfaceRef = useRef<SourceSurface | null>(null);
  if (!surfaceRef.current) surfaceRef.current = createSourceSurface({ impl: "cm6" });
  const surface = surfaceRef.current;
  const sourceContentRef = useRef(sourceContent);
  sourceContentRef.current = sourceContent;

  const hostRef = useCallback((el: HTMLElement | null) => {
    if (el) surface.mount(el, { initialText: sourceContentRef.current });
    else surface.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ① 缺陷/修复的分界：prop 变化是否跟进 state
  useEffect(() => {
    if (!followProp) return;
    if (sourceContent === content) return;
    setSourceContent(content);
  }, [content, sourceContent, followProp]);

  // ② content → CM6（EditorContainer 的同步 effect）
  useEffect(() => {
    if (surface.impl !== "cm6") return;
    if (!surface.isMounted()) return;
    if (surface.getText() === sourceContent) return;
    surface.setText(sourceContent);
  }, [sourceContent, surface]);

  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      { id: "open-big", onClick: () => setContent("# BIG\n\n5MB 文档正文第一行") },
      "open",
    ),
    React.createElement("div", { ref: hostRef, "data-testid": "host" }),
  );
}

describe("A3 大文件：content prop 变化必须跟进 sourceContent", () => {
  it("【缺陷复现】不跟进 prop 时：换 content 后 CM6 仍是旧内容", () => {
    const { container } = render(createElement(Harness, { followProp: false }));
    expect(cmText()).toContain("欢迎使用 LightMD");

    act(() => {
      (container.querySelector("#open-big") as HTMLButtonElement).click();
    });
    // 缺陷形态：state 没跟随 → CM6 停在旧内容（这正是 5MB 打开后空白的机制）
    expect(
      cmText(),
      "不复位 state 时 CM6 保持旧内容 —— 这就是 5MB 文件打开后显示欢迎页的原因",
    ).toContain("欢迎使用 LightMD");
  });

  it("★【修复判据】跟进 prop 后：换 content 时 CM6 必须显示新内容", () => {
    const { container } = render(createElement(Harness, { followProp: true }));
    expect(cmText()).toContain("欢迎使用 LightMD");

    act(() => {
      (container.querySelector("#open-big") as HTMLButtonElement).click();
    });
    expect(cmText(), "content 变化后 CM6 必须显示新文档").toContain("5MB 文档正文第一行");
    expect(cmText(), "旧内容不得残留").not.toContain("欢迎使用 LightMD");
  });

  it("多次换文档都能正确跟进（不累积、不残留）", () => {
    const { container } = render(createElement(Harness, { followProp: true }));
    act(() => {
      (container.querySelector("#open-big") as HTMLButtonElement).click();
    });
    expect(cmText()).toContain("5MB 文档正文第一行");
    // 再点一次（同一内容）不应崩、不应重复
    act(() => {
      (container.querySelector("#open-big") as HTMLButtonElement).click();
    });
    expect(cmText()).toContain("5MB 文档正文第一行");
  });
});
