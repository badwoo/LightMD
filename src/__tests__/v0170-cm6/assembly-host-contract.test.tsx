// @vitest-environment jsdom
/**
 * v0.17.0 A3 装配缺陷回归：**受控 textarea 当宿主会让 CM6 被 React 抹掉**
 *
 * ## 这个缺陷是怎么逃过 6600+ 条测试的（本文件存在的理由）
 *
 * - 全量测试都跑在 jsdom → 工厂 `isJsdomLike()` 为真 → **一律回退 textarea 实现**
 *   → CM6 路径从来没被执行过一行；
 * - 而 `v0170-cm6` 的 54 条契约测试是**手工 `new CmSourceSurface()` 直接测类**，
 *   绕过了"React 受控宿主"这个真实装配环境。
 *
 * 所以"契约正确"和"装配正确"是两件事，我们只验了前者。
 * **本文件补的就是装配面**：在真实 React 装配下 mount，再经过 re-render，
 * 断言 CM6 的 DOM 仍在。
 *
 * ## 缺陷机制（实机探针定位，非推测）
 *
 * ```tsx
 * <textarea ref={sourceHostRef} value={sourceContent} … />   // ← React 受控
 * ```
 * `mount()` 把 CM6 挂到该 textarea **内部**（`new EditorView({ parent: host })`）。
 * 但受控 `<textarea>` 意味着 React"认为这个节点的内容由我管" ——
 * 后续任何 re-render 都会**整体重写它的子节点**，把 CM6 注入的 `.cm-editor` 清掉。
 *
 * 实机表现：mount 后 `.cm-editor` 存在 → 约 2.5s（首次 state 变化）后消失，
 * 且 `destroy()` 从未被调用（不是我们主动销毁，是 React 覆写）。
 */

import { describe, it, expect, afterEach } from "vitest";
import { useState, useCallback, useMemo, useRef } from "react";
import { render, act, cleanup } from "@testing-library/react";
import React from "react";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

afterEach(cleanup);

/**
 * 复刻真实装配：宿主元素 + 受控 value + surface.mount。
 *
 * @param useNeutralHost true = 方案 A 的形态（中性 host div）；
 *                       false = 缺陷形态（受控 textarea 当宿主）
 */
function Harness({ useNeutralHost }: { useNeutralHost: boolean }) {
  const [content, setContent] = useState("# hello\n\nworld");
  const surfaceRef = useRef<SourceSurface | null>(null);
  if (!surfaceRef.current) surfaceRef.current = createSourceSurface({ impl: "cm6" });
  const surface = surfaceRef.current;

  const hostRef = useCallback(
    (el: HTMLElement | null) => {
      if (el) surface.mount(el, { initialText: content });
      else surface.destroy();
    },
    // 故意不依赖 content —— 复刻"只在挂载时 mount 一次"
    [],
  );

  // 暴露一个"触发 re-render"的抓手，模拟 2.5s 后那次内容同步
  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      { id: "rerender", onClick: () => setContent((c) => c + "!") },
      "rerender",
    ),
    useNeutralHost
      ? React.createElement("div", { ref: hostRef, "data-testid": "host" })
      : React.createElement("textarea", {
          ref: hostRef,
          "data-testid": "host",
          value: content,
          readOnly: true,
        }),
  );
}

/** 数 DOM 里还有几个 `.cm-editor`（CM6 建成功后必有） */
const cmEditorCount = () => document.querySelectorAll(".cm-editor").length;

describe("A3 装配缺陷：受控 textarea 当宿主会被 React 抹掉", () => {
  it("【缺陷复现】受控 textarea 当宿主：re-render 后 .cm-editor 被清掉", () => {
    const { container } = render(React.createElement(Harness, { useNeutralHost: false }));

    // mount 那一刻：CM6 建成功（与实机探针日志一致）
    expect(cmEditorCount(), "mount 后 CM6 应当存在（实机同样如此）").toBe(1);
    const host = container.querySelector('[data-testid="host"]') as HTMLTextAreaElement;
    expect(host.tagName).toBe("TEXTAREA");

    // 触发一次 re-render（受控 value 变化）→ 模拟实机 2.5s 后那次同步
    act(() => {
      (container.querySelector("#rerender") as HTMLButtonElement).click();
    });

    // ⚠️ 缺陷：受控 textarea 让 React 重写内容，把 CM6 抹掉
    // 这条断言在**修复后**（宿主改成中性 div）应当变绿；
    // 保留它是为了让"缺陷形态"本身留下可执行记录。
    expect(
      cmEditorCount(),
      "受控 textarea 当宿主时，re-render 会把 CM6 节点清掉（这正是实机 .cm-editor true→false 的机制）",
    ).toBe(0);
  });

  it("【修复形态】中性 host div：re-render 后 .cm-editor 必须仍然存在", () => {
    const { container } = render(React.createElement(Harness, { useNeutralHost: true }));

    expect(cmEditorCount(), "mount 后 CM6 应当存在").toBe(1);
    const host = container.querySelector('[data-testid="host"]') as HTMLElement;
    expect(host.tagName, "宿主必须是中性 div，不是受控 textarea").toBe("DIV");

    // 多次 re-render（模拟持续的内容同步）
    for (let i = 0; i < 3; i++) {
      act(() => {
        (container.querySelector("#rerender") as HTMLButtonElement).click();
      });
      expect(cmEditorCount(), `第 ${i + 1} 次 re-render 后 CM6 必须仍然存活`).toBe(1);
    }
  });
});
