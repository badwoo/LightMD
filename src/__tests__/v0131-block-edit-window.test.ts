// @vitest-environment jsdom
/**
 * v0.13.1 需求6：公式 / Mermaid 就地编辑窗的**尺寸、退出与平滑**。
 *
 * ## 用户原话
 * 「公式/Mermaid 点击进入编辑模式的窗口太大，要尽量根据内容；点击其他区域要立即恢复
 *  渲染；进入/恢复的过程要平滑、不抖动。」
 *
 * ## 三个缺陷（本文件逐条锁定）
 * 1. **窗口太大**：编辑层内联 CSS 是 `padding:1em` + 块级占满整行 —— 一个 20 字符的
 *    公式也撑出一整行高的大方框。
 * 2. **点其他区域不恢复**：旧实现只在 `dblclick` 上 toggle，**没有任何**"点块外退出"
 *    的监听；点到正文别处，块会一直停在编辑态。
 * 3. **进入/恢复抖动**：`display:none ↔ block` 切换且**未声明任何过渡**；Mermaid 还会
 *    把预览层 `display:none` 掉，高度直接突变。
 *
 * ## 手法
 * 挂载**真实** `createEditor`（真实 NodeView 注册与 DOM），用真实鼠标事件驱动，断言
 * 真实 DOM 的内联样式与类名。滚动/动画的视觉平滑无法在 jsdom 里"看见"，因此对
 * 过渡只断言**声明存在**（`transition`/`animation` 已写入内联样式），不假装验证动画效果。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import type { EditorView } from "prosemirror-view";

const MATH_MD = "$$\nx^2 + y^2 = z^2\n$$\n";
const MERMAID_MD = "```mermaid\ngraph TD\nA-->B\n```\n";

function mk(initialContent: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = createEditor({ parent, initialContent }) as EditorView;
  return { view, parent };
}

// jsdom 未实现 document.elementFromPoint，而 ProseMirror 的 posAtCoords 依赖它
// （真实浏览器有）。缺失时点进编辑态会抛 "elementFromPoint is not a function"，
// 那是环境缺口而非产品缺陷 —— 这里补一个"命中不到任何元素"的最小桩，
// 让 placeCaretInsideBlock 走它的兜底分支（把光标放在块起始处）。
beforeAll(() => {
  (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => null;
});

/** 真实左键单击（NodeView 的进入编辑走 mousedown） */
function click(el: Element) {
  el.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    }),
  );
}

/** 在块**外部**点击（document 捕获阶段的"点块外退出"监听应命中） */
function clickOutside() {
  const outside = document.createElement("div");
  document.body.appendChild(outside);
  outside.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  );
  // 同时覆盖 PointerEvent 路径（触屏/手写笔）
  if (typeof PointerEvent === "function") {
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  }
  outside.remove();
}

describe("v0.13.1 需求6：公式块编辑窗", () => {
  let view: EditorView | null = null;
  let parent: HTMLElement;

  beforeEach(() => {
    const m = mk(MATH_MD);
    view = m.view;
    parent = m.parent;
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
  });

  function wrapper() {
    return parent.querySelector(".math-block-wrapper") as HTMLElement;
  }
  function content() {
    return parent.querySelector(".math-block-content") as HTMLElement;
  }

  it("单击进入编辑态：编辑层可见且**宽度收窄到内容**（不再占满整行）", () => {
    expect(content().style.display).toBe("none");
    click(wrapper());
    expect(wrapper().classList.contains("math-editing")).toBe(true);
    expect(content().style.display).toBe("block");
    // 需求6 的核心：按内容宽度，而不是块级占满
    expect(content().style.width).toBe("fit-content");
    expect(content().style.maxWidth).toBe("100%");
  });

  it("内边距不再用 1em 的大方框（旧实现在这里撑高整块）", () => {
    const pad = () => content().style.padding;
    expect(pad()).not.toContain("1em");
    click(wrapper());
    expect(pad()).not.toContain("1em");
    // 紧凑但仍可点选
    expect(pad()).toMatch(/0\.4em\s+0\.6em/);
  });

  it("进入态声明了过渡与进入动画（平滑、不抖动的可验证部分）", () => {
    click(wrapper());
    const css = content().style.cssText;
    expect(css).toMatch(/transition:[^;]*0\.12s/);
    // jsdom 会把 cssText 规范化（"animation: inline-editor-enter 0.14s ease-out"），
    // 故用空白容忍的匹配，而不是拼死一个无空格的字符串
    expect(css).toMatch(/animation:\s*inline-editor-enter/);
    // 过渡只动 padding/background/opacity —— **不得**动 height/width，
    // 否则文字重排会带来抖动
    const transition = css.slice(css.indexOf("transition:"), css.indexOf(";", css.indexOf("transition:")));
    expect(transition).not.toContain("height");
    expect(transition).not.toContain("width");
  });

  it("点击块外 → **立即**退出编辑态并恢复渲染", () => {
    click(wrapper());
    expect(wrapper().classList.contains("math-editing")).toBe(true);

    clickOutside();

    expect(wrapper().classList.contains("math-editing")).toBe(false);
    expect(content().style.display).toBe("none");
    // 渲染恢复：预览层仍在且可见
    const preview = parent.querySelector(".math-block-preview") as HTMLElement;
    expect(preview).toBeTruthy();
    expect(preview.style.display).not.toBe("none");
  });

  it("未进入编辑态时，点击块外不产生任何影响（监听只在编辑期挂载）", () => {
    clickOutside();
    expect(wrapper().classList.contains("math-editing")).toBe(false);
    expect(content().style.display).toBe("none");
  });

  it("双击预览层可切回预览（越过 600ms 的同手势保护窗之后）", () => {
    // v0.13.0 的既有语义：刚由单击进入编辑的同一手势里的 dblclick 会被忽略
    // （否则"单击进编辑"会被紧随的 dblclick 立刻 toggle 掉）。因此这里必须把时间
    // 推过 600ms 保护窗，才是"用户稍后双击预览层"的真实路径。
    // 用可控时钟而不是假定时器：只影响 Date.now，不牵动 rAF/防抖。
    const realNow = Date.now;
    let fakeNow = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      click(wrapper());
      expect(wrapper().classList.contains("math-editing")).toBe(true);
      fakeNow += 700; // 越过 600ms 保护窗
      wrapper().dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0 }),
      );
      expect(wrapper().classList.contains("math-editing")).toBe(false);
      expect(content().style.display).toBe("none");
    } finally {
      spy.mockRestore();
    }
  });

  it("视图销毁后，块外点击不得再触发（document 级监听已摘除）", () => {
    click(wrapper());
    expect(wrapper().classList.contains("math-editing")).toBe(true);
    view!.destroy();
    view = null;
    // 销毁后点击不应抛错，也不应再去动一个已卸载的 DOM
    expect(() => clickOutside()).not.toThrow();
  });
});

describe("v0.13.1 需求6：Mermaid 块编辑窗", () => {
  let view: EditorView | null = null;
  let parent: HTMLElement;

  beforeEach(() => {
    const m = mk(MERMAID_MD);
    view = m.view;
    parent = m.parent;
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
  });

  function wrapper() {
    return parent.querySelector(".mermaid-block-wrapper") as HTMLElement;
  }
  function code() {
    return parent.querySelector("code.language-mermaid") as HTMLElement;
  }

  it("单击进入：整行宽 + **按内容高度**并限高，不再是大方框", () => {
    click(wrapper());
    expect(wrapper().classList.contains("mermaid-editing")).toBe(true);
    expect(code().style.display).toBe("block");
    expect(code().style.width).toBe("100%");
    expect(code().style.maxHeight).toBe("45vh");
    expect(code().style.overflow).toBe("auto");
    expect(code().style.padding).not.toContain("1em");
  });

  it("进入编辑时**保留**预览层可见（旧实现 display:none → 高度突变抖动）", () => {
    const preview = parent.querySelector(".mermaid-preview-layer") as HTMLElement;
    click(wrapper());
    expect(preview.style.display).not.toBe("none");
  });

  it("点击块外 → 立即退出编辑态、恢复渲染（预览层可见 + 编辑层隐藏）", () => {
    click(wrapper());
    expect(wrapper().classList.contains("mermaid-editing")).toBe(true);
    clickOutside();
    expect(wrapper().classList.contains("mermaid-editing")).toBe(false);
    expect(code().style.display).toBe("none");
    const preview = parent.querySelector(".mermaid-preview-layer") as HTMLElement;
    expect(preview.style.display).toBe("block");
  });

  it("进入态声明过渡与进入动画", () => {
    click(wrapper());
    const css = code().style.cssText;
    expect(css).toMatch(/transition:[^;]*0\.12s/);
    expect(css).toMatch(/animation:\s*inline-editor-enter/);
  });
});
