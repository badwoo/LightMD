// @vitest-environment jsdom
/**
 * v0.17.0 A2：`TextareaSourceSurface.mount()` 的宿主接管契约
 *
 * ## 这条测试守护一个真实踩过的坑（3 条跨模式撤销回归的根因）
 *
 * A2 把源码面的挂载方式从 React `useRef` 改成 callback ref 交给 `SourceSurface.mount()`。
 * 宿主 JSX 渲染的 `<textarea ref={hostRef}>` 被作为 `host` 传进来，
 * 而旧 `mount()` 只在 `externalTa === null` 时走"自建"分支 → **在 textarea 内部
 * 又 appendChild 了一个嵌套 textarea**。于是 DOM 里有两个 `.source-editor`：
 *
 * - `document.querySelector("textarea.source-editor")` 拿到**外层**（React 受控、内容正确）；
 * - `surface` 的所有读写/`setSelectionRange` 都作用在**内层**；
 * - 撤销后选区恢复写在内层，外层 `selectionStart` 停在文末
 *   → 「撤销后光标回到编辑前位置」断言实测偏 8/12（3 条测试红）。
 *
 * 判据（也是本文件的断言方向）：**mount 之后宿主内不得出现嵌套 textarea，
 * 且 surface 必须作用于宿主元素本身。** 删掉那条分支，本文件立刻红。
 */

import { describe, it, expect, afterEach } from "vitest";
import { TextareaSourceSurface } from "../../editor/surface/TextareaSourceSurface";

function cleanup(): void {
  document.body.innerHTML = "";
}

afterEach(cleanup);

describe("A2：mount 必须直接接管 <textarea> 宿主，不得嵌套第二个", () => {
  it("host 是 textarea 时，mount 不新增任何子节点", () => {
    const ta = document.createElement("textarea");
    ta.className = "source-editor";
    ta.value = "hello world";
    document.body.appendChild(ta);

    const surface = new TextareaSourceSurface();
    surface.mount(ta, { initialText: "hello world" });

    // 核心断言：宿主内部不得出现嵌套 textarea（旧实现会 appendChild 一个）
    expect(ta.querySelectorAll("textarea")).toHaveLength(0);
    expect(document.querySelectorAll("textarea.source-editor")).toHaveLength(1);

    // surface 必须作用于宿主本身（A3 收尾后不再暴露 legacy ref，
    // 改用"读写确实落在宿主元素上"这个行为判据 —— 比查 ref 更强）
    expect(surface.getText()).toBe("hello world");
    surface.setSelection(3, 3);
    expect(ta.selectionStart).toBe(3);

    surface.destroy();
  });

  it("挂载后 setSelection 作用在宿主元素上（撤销选区恢复的落地面）", () => {
    const ta = document.createElement("textarea");
    ta.value = "hello world";
    document.body.appendChild(ta);

    const surface = new TextareaSourceSurface();
    surface.mount(ta, { initialText: ta.value });

    surface.setSelection(3, 3);
    // 必须是**外层宿主**的选区被改到 —— 这正是 3 条撤销回归的失败面
    expect(ta.selectionStart).toBe(3);
    expect(ta.selectionEnd).toBe(3);

    surface.destroy();
  });

  it("destroy 后不得残留嵌套节点，也不得删除外部宿主（它由 React 管理）", () => {
    const ta = document.createElement("textarea");
    ta.value = "keep me";
    document.body.appendChild(ta);

    const surface = new TextareaSourceSurface();
    surface.mount(ta, { initialText: ta.value });
    surface.destroy();

    // 外部宿主要留着（React 的 DOM 不归 surface 删）
    expect(document.body.contains(ta)).toBe(true);
    expect(ta.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("host 不是 textarea 时才自建（这是 CM6 / 单测场景的合法路径）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const surface = new TextareaSourceSurface();
    surface.mount(host, { initialText: "abc" });

    // 自建路径：宿主内应当出现一个 textarea
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    expect(surface.getText()).toBe("abc");

    surface.destroy();
    // 自建的那个应当在 destroy 时被移除
    expect(host.querySelectorAll("textarea")).toHaveLength(0);
  });
});
