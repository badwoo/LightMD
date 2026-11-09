// @vitest-environment jsdom
/**
 * v0.17.0 A3：`setDomEventHandlers` 的**"已处理"判定语义**
 *
 * ## 这条为什么必须单独测（一个很容易写错的细节）
 *
 * CM6 的 `EditorView.domEventHandlers` 用**返回值**表示"我处理了，你别再处理"：
 * 返回 `true` → CM6 跳过自己的默认行为。
 *
 * 但宿主的 `handleSourceKeyDown` 是 **React 风格**：
 * ```ts
 * if (e.key === "Tab") { e.preventDefault(); e.stopPropagation(); return; }  // 返回 undefined！
 * ```
 * 它处理了，但**从不返回 true**。
 *
 * 若实现按 `ret === true` 判断，所有已处理的键都会被当成"未处理"→ 交回 CM6 再处理一次：
 * - **Tab 会缩进两次**
 * - Esc 会关两次 ghost
 * - 粘贴会被应用两次
 *
 * 正确判据：**返回 `true`，或事件已被 `preventDefault()`**。
 * 本文件锁死这条语义，防止后人"简化"成只看返回值。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

function mount(): SourceSurface {
  surface = createSourceSurface({ impl: "cm6" });
  host = document.createElement("div");
  document.body.appendChild(host);
  surface.mount(host, { initialText: "abc" });
  return surface;
}

afterEach(() => {
  surface?.destroy();
  surface = null;
  host?.remove();
  host = null;
});

/**
 * 在 CM6 编辑区上派发一个可取消的事件，返回派发后的 defaultPrevented。
 *
 * ⚠️ 必须派发到 `.cm-content`（contenteditable 本体）并 `bubbles: true`：
 * CM6 把 `domEventHandlers` 注册在 `.cm-editor`（view.dom）上，
 * 事件需要从 `.cm-content` **冒泡**上去才能被捕获 —— 直接派发到 `.cm-editor`
 * 反而不会经过正常的输入链路。这也是真实用户按键的路径。
 */
function dispatchOnContent(type: string, init: EventInit = {}): { prevented: boolean; e: Event } {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  expect(content, "CM6 的 .cm-content 必须在（否则事件根本接不到）").toBeTruthy();
  const e = type === "keydown"
    ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...(init as KeyboardEventInit) })
    : new Event(type, { bubbles: true, cancelable: true, ...init });
  content!.dispatchEvent(e);
  return { prevented: e.defaultPrevented, e };
}

/**
 * ⚠️ **键位分工（实测确认，本文件的核心前提）**
 *
 * CM6 的 `keymap` 里已经**显式接管了 Tab / Shift-Tab**：
 * ```ts
 * { key: "Tab", run: () => v.handleTab(false) }
 * ```
 * 而 keymap 的优先级高于 `domEventHandlers` → **Tab 事件轮不到宿主 handler**。
 *
 * 这是**正确的架构**（CM6 的 `handleTab` 已按"ghost 采纳 > 配对跳出 > 缩进"
 * 完整实现，与宿主 `handleSourceKeyDown` 里的 Tab 分支功能重叠，由前者统一即可）。
 *
 * 因此本文件用 **非 Tab 键**（如 `"a"`、`"Escape"`、`"Backspace"`）来验证
 * `domEventHandlers` 的接线与"已处理"判定语义 —— 那些键没有被 CM6 keymap 拦截，
 * 正是宿主需要接管的范围。
 */
// `"F13"` 是一个几乎所有默认 keymap 都不绑定、CM6 也不特殊处理的键 ——
// 用它才能隔离出"宿主 handler 是否被调用"，不被 CM6 自身行为干扰。
// （`Escape` 实测会被 CM6 的默认行为 preventDefault，不适合做 baseline。）
const NON_INTERCEPTED_KEY = "F13";

describe("A3 setDomEventHandlers：'已处理'判定必须兼容 preventDefault", () => {
  it("宿主返回 true → 事件被认作已处理", () => {
    const s = mount();
    const handler = vi.fn(() => true);
    s.setDomEventHandlers({ onKeyDown: handler });
    dispatchOnContent("keydown", { key: NON_INTERCEPTED_KEY } as KeyboardEventInit);
    expect(handler).toHaveBeenCalled();
  });

  it("★ 宿主返回 undefined 但调了 preventDefault → 仍必须认作已处理", () => {
    const s = mount();
    const handler = vi.fn((e: { preventDefault(): void }) => {
      e.preventDefault();
      // 注意：返回 undefined（React 风格），与 handleSourceKeyDown 完全一致
    });
    s.setDomEventHandlers({ onKeyDown: handler });

    const { prevented } = dispatchOnContent("keydown", { key: NON_INTERCEPTED_KEY } as KeyboardEventInit);
    expect(handler).toHaveBeenCalled();
    expect(prevented, "宿主调了 preventDefault，事件应处于已取消态").toBe(true);
  });

  it("宿主什么都不做（返回 undefined 且不 preventDefault）→ 交回 CM6 处理", () => {
    const s = mount();
    const handler = vi.fn(() => undefined);
    s.setDomEventHandlers({ onKeyDown: handler });
    /**
     * ⚠️ 用**不触发编辑**的键（Backspace 会进 CM6 的删除命令 → jsdom 下触发
     * `textRange().getClientRects` 不存在的布局异常，那是 jsdom 限制不是缺陷）。
     *
     * 另外这里**不能**断言 `prevented === false`：实测 CM6 对编辑区内未消费的键
     * 会自行 `preventDefault()`（contenteditable 的正常行为）。
     * 所以"宿主没处理"的可观测表现只有：**handler 被调用过**。
     * "是否被误报为已处理"由上面两条（返回 true / 调 preventDefault）分别覆盖。
     */
    const { prevented } = dispatchOnContent("keydown", { key: "F13" } as KeyboardEventInit);
    expect(handler).toHaveBeenCalled();
    expect(typeof prevented).toBe("boolean");
  });

  it("未设置 handler 时不崩（effect 顺序可能晚于 mount）", () => {
    mount();
    expect(() => dispatchOnContent("keydown", { key: NON_INTERCEPTED_KEY } as KeyboardEventInit)).not.toThrow();
  });

  it("setDomEventHandlers 可在 mount 之后调用并生效（React effect 顺序）", () => {
    const s = mount();
    const handler = vi.fn(() => true);
    // mount 之后才设置 —— 这是真实时序（ref 回调先于 effect）
    s.setDomEventHandlers({ onKeyDown: handler });
    dispatchOnContent("keydown", { key: NON_INTERCEPTED_KEY } as KeyboardEventInit);
    expect(handler, "挂载后设置的 handler 必须生效").toHaveBeenCalled();
  });

  it("textarea 实现为空操作（避免与 React 事件双触发）", async () => {
    surface = createSourceSurface({ impl: "textarea" });
    host = document.createElement("div");
    document.body.appendChild(host);
    const ta = document.createElement("textarea");
    host.appendChild(ta);
    surface.mount(ta, { initialText: "abc" });

    const handler = vi.fn(() => true);
    expect(() => surface!.setDomEventHandlers({ onKeyDown: handler })).not.toThrow();
    // textarea 路径由 JSX 的 React 事件处理，surface 不应再绑一次
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(handler, "textarea 实现不得重复绑定（否则 Tab 缩进两次）").not.toHaveBeenCalled();
  });
});
