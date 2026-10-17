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
import {
  getInAppBlockClipboard,
  __resetInAppBlockClipboardForTest,
} from "../utils/blockClipboardOps";

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

  /**
   * v0.13.2 需求1：复制按钮同时写入「块载荷」。
   *
   * 缺陷背景（用户报告）：「点击代码块右上角快捷复制按钮，复制代码块到其他文档
   * 没有立即渲染。」旧实现只 `writeText(裸代码)` —— 裸代码没有任何 Markdown 结构，
   * 粘贴时被判为"不像 Markdown" → 退回字面粘贴，目标文档里只是一段普通文字。
   * 现在系统剪贴板仍写纯代码（外部编辑器拿到干净代码），同时登记一份围栏形态的
   * 块载荷，本应用内粘贴即可还原成代码块。
   */
  it("复制同时登记块载荷（围栏形态），应用内粘贴可还原结构", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    __resetInAppBlockClipboardForTest();
    const view = mount();
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    await btn.click();
    const data = getInAppBlockClipboard();
    expect(data).not.toBeNull();
    // markdown 是围栏代码块（带语言标识）
    expect(data!.markdown).toContain("```js");
    expect(data!.markdown).toContain(CODE);
    expect(data!.markdown.trimEnd().endsWith("```")).toBe(true);
    // text/plain 仍是纯代码（外部粘贴不带围栏）
    expect(data!.plain).toBe(CODE);
  });

  it("代码内含三反引号时围栏自动加长（不会提前闭合）", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    __resetInAppBlockClipboardForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const md = "````md\n```js\nconst a = 1;\n```\n````\n";
    const view = createEditor({ parent: host, initialContent: md }) as EditorView;
    const btn = view.dom.querySelector(".code-copy-btn") as HTMLButtonElement;
    await btn.click();
    const data = getInAppBlockClipboard();
    expect(data).not.toBeNull();
    // 外层围栏必须长于内层最长的连续反引号（3 → 至少 4）
    expect(data!.markdown.startsWith("````")).toBe(true);
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
    // click → handleCopyClick（async）：先让 microtask 结算（.copied 在 await 之后添加）。
    // v0.13.2 需求1 起复制改走块剪贴板（handleCopyClick → writeCodeBlockClipboard
    // → writeBlockClipboardDetailed），await 链深了一层，需要多结算两轮。
    await Promise.resolve();
    await Promise.resolve();
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
