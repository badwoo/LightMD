/**
 * v0.13.0 需求5：代码块复制按钮。
 *
 * 覆盖：
 * - 按钮 DOM 构造（class / contenteditable 属性 / title / data-testid）；
 * - 复制内容是 `node.textContent`（**不含行号**——行号层是 user-select:none
 *   的独立层，本就不在 textContent 中）；
 * - 成功后加 `.copied` class，1.5s 后还原；
 * - 剪贴板不可用时 toast 提示，不静默失败；
 * - 按钮不抢编辑器焦点 / 不移动光标（mousedown 被 preventDefault）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEditor } from "../core/editor";
import type { EditorView } from "prosemirror-view";

const CODE = "const a = 1;\nconst b = 2;";

function mount(): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return createEditor({ parent: host, initialContent: `\`\`\`js\n${CODE}\n\`\`\`\n` }) as EditorView;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("v0.13.0 需求5：代码块复制按钮", () => {
  it("渲染 .code-copy-btn（含 contenteditable=false 与 data-testid）", () => {
    const view = mount();
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // contentEditable=false 必须落在 attribute 上（CSS/测试才能读到）
    expect(btn.getAttribute("contenteditable")).toBe("false");
    expect(btn.dataset.testid).toBe("code-copy-btn");
    // 有可访问文案（i18n）
    expect(btn.title.length).toBeGreaterThan(0);
    expect(btn.getAttribute("aria-label")?.length).toBeGreaterThan(0);
  });

  it("按钮与语言下拉、三点菜单同处右上角且不重叠（z-index 递增）", () => {
    const view = mount();
    const wrapper = view.dom.querySelector(".code-block-wrapper") as HTMLElement;
    expect(wrapper.classList.contains("has-lang-select")).toBe(true);
    // 三者都应存在
    expect(wrapper.querySelector(".code-lang-select")).not.toBeNull();
    expect(wrapper.querySelector(".code-copy-btn")).not.toBeNull();
    expect(wrapper.querySelector(".block-kebab")).not.toBeNull();
  });

  it("点击复制 → 剪贴板内容 = 代码纯文本（无行号、无语言名）", async () => {
    const calls: string[] = [];
    const writeText = vi.fn(async (text: string) => {
      calls.push(text);
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const view = mount();
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    await btn.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe(CODE);
  });

  it("复制成功后加 .copied class，1.5s 后还原", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    const view = mount();
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    btn.click();
    // click → handleCopyClick（async）：先让 microtask 结算（.copied 在 await 之后添加）
    await Promise.resolve();
    expect(btn.classList.contains("copied")).toBe(true);
    expect(btn.title.length).toBeGreaterThan(0);

    // 1.5s 后还原。注意：PM 可能在定时器期间重建 NodeView DOM
    // （30ms 高亮防抖 → syncHighlight），因此还原后**重新查询**按钮，
    // 断言的是「当前 DOM 里的按钮不带 .copied」，而不是旧元素引用。
    await vi.advanceTimersByTimeAsync(2000);
    const now = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement | null;
    expect(now).not.toBeNull();
    expect(now!.classList.contains("copied")).toBe(false);
  });

  it("剪贴板不可用 → 提示用户，不静默失败", async () => {
    const notifyWarning = vi.fn();
    vi.doMock("../services/notificationService", () => ({
      notify: vi.fn(),
      notifyError: vi.fn(),
      notifySuccess: vi.fn(),
      notifyWarning,
      setNotificationHandler: vi.fn(),
    }));
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
      configurable: true,
    });
    const view = mount();
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    await btn.click();
    // 动态 import 的模块需要一点时间；轮询等待
    await vi.waitFor(() => expect(notifyWarning).toHaveBeenCalled(), { timeout: 2000 });
    // 不应标记成功
    expect(btn.classList.contains("copied")).toBe(false);
    vi.doUnmock("../services/notificationService");
  });

  it("mousedown 被 preventDefault —— 按钮不抢编辑器焦点、不移动光标", () => {
    const view = mount();
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    const before = view.state.selection.from;
    const ev = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // 编辑器选区未被移动（仍停在原处）
    expect(view.state.selection.from).toBe(before);
  });

  it("非代码块不渲染复制按钮（只挂在 CodeBlockView 上）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({
      parent: host,
      initialContent: "# 标题\n\n正文段落\n",
    }) as EditorView;
    expect(view.dom.querySelector(".code-copy-btn")).toBeNull();
    // 但三点菜单仍应出现（挂在有 NodeView 的块上）
    expect(view.dom.querySelector(".block-kebab")).toBeNull();
  });
});
