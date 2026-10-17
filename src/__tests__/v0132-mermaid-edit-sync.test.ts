// @vitest-environment jsdom
/**
 * v0.13.2 需求3：Mermaid 图表「上半部渲染结果也是编辑入口 + 上下实时联动」。
 *
 * ## 用户原话
 * 「需求6的 mermaid 图表编辑，除了下半部分可以编辑，在上半部分的渲染结果也要支持编辑，
 *  并且上下编辑要实时联动，文档的内容撤销和恢复也要保证生效。」
 * 选定方案：「渲染区也是编辑入口 + 实时联动」。
 *
 * ## 本文件锁定的行为
 * - 点**渲染结果**（previewLayer / 其中的 SVG）→ 进入编辑态（编辑层可见）；
 * - 编辑态下源码变化按 **120ms** 防抖重渲染，且 `getCode()` 读**活的 contentDOM**
 *   （不是滞后的 node 文本）—— 这是"实时联动"的核心；
 * - 编辑中临时输入非法语法时**保留上一张成功的 SVG**（keepLastOnError），不闪白；
 * - PM 的撤销 / 重做作用于 mermaid_block 的 content，并触发重渲染；
 * - `renderSeq` 竞态守卫：destroy 后 / 被新一次渲染取代的旧结果不得写回 DOM；
 * - destroy 摘掉防抖定时器与预览层监听。
 *
 * ## mock 说明
 * jsdom 没有 SVG 布局（mermaid 真实渲染依赖 getBBox / 测量），因此这里 mock
 * `mermaid.render` 入口；**所有断言仍作用在真实 MermaidBlockView 的行为上**
 * （调用是否被触发 / 被节流 / 被竞态丢弃、DOM 是否被更新），不锁源码字符串。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

/** mermaid mock 必须在导入被测模块前挂上（vi.mock 会提升） */
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));

import { createEditor } from "../core/editor";
import { lightMDSchema } from "../core/schema";
import { MermaidBlockView } from "../core/plugins/mermaid-block";

const MERMAID_MD = "```mermaid\ngraph TD\n  A-->B\n```\n";
const INITIAL_CODE = "graph TD\n  A-->B";

/** 默认渲染实现：把源码编码进 svg 的 data-code，便于断言"渲染的是哪一版源码" */
function defaultRender(_id: string, code: string): Promise<{ svg: string }> {
  if (code.includes("INVALID")) {
    return Promise.reject(new Error(`parse error: ${code}`));
  }
  return Promise.resolve({
    svg: `<svg data-code="${encodeURIComponent(code)}"><text>diagram</text></svg>`,
  });
}

/** 等微任务（mermaid.render 是异步 promise） */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function codeOfSvg(svg: Element | null): string | null {
  const raw = svg?.getAttribute("data-code");
  return raw == null ? null : decodeURIComponent(raw);
}

function mouse(target: EventTarget, type: string, button = 0): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button,
      clientX: 10,
      clientY: 10,
    }),
  );
}

function mount(content = MERMAID_MD): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: content })!;
  return { view, host };
}

function wrapperOf(host: HTMLElement): HTMLElement {
  return host.querySelector(".mermaid-block-wrapper") as HTMLElement;
}

function previewOf(host: HTMLElement): HTMLElement {
  return host.querySelector(".mermaid-preview-layer") as HTMLElement;
}

function codeElOf(host: HTMLElement): HTMLElement {
  return host.querySelector("code.language-mermaid") as HTMLElement;
}

/** 找到文档里 mermaid_block 的起始位置 */
function mermaidPos(view: EditorView): number {
  let pos = -1;
  view.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === "mermaid_block") {
      pos = p;
      return false;
    }
    return true;
  });
  return pos;
}

/**
 * 直接驱动 NodeView（不挂进 PM）：用于观测防抖 / 竞态 / destroy 这几类
 * 会被 ProseMirror DOMObserver 干扰的时序。构造仍用**真实** MermaidBlockView，
 * 点击预览区也走真实的 mousedown → handlePreviewPointerDown 路径。
 */
function makeNodeView(code: string): {
  nv: MermaidBlockView;
  preview: HTMLElement;
  content: HTMLElement;
  dispatch: ReturnType<typeof vi.fn>;
} {
  const node = lightMDSchema.nodes.mermaid_block.create(null, [
    lightMDSchema.text(code),
  ]);
  const doc = lightMDSchema.topNodeType.create(null, [node]);
  const state = EditorState.create({ doc });
  const dispatch = vi.fn();
  const fakeView = {
    state,
    dispatch,
    focus: vi.fn(() => undefined),
  } as unknown as EditorView;
  const nv = new MermaidBlockView(node, fakeView, () => 0);
  const preview = (nv as unknown as { previewLayer: HTMLElement }).previewLayer;
  return { nv, preview, content: nv.contentDOM as HTMLElement, dispatch };
}

beforeAll(() => {
  // jsdom 未实现 elementFromPoint；真实编辑器里 block-drag / PM 的坐标探测依赖它。
  // 这是环境缺口（不是 Mermaid 行为），补一个"命中不到元素"的桩。
  (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => null;
});

beforeEach(() => {
  mermaidMock.initialize.mockClear();
  mermaidMock.render.mockReset();
  mermaidMock.render.mockImplementation(defaultRender);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ═══════════════ 真实编辑器集成 ═══════════════

describe("需求3：真实编辑器里的渲染区编辑入口", () => {
  it("初始渲染：previewLayer 里出现 SVG，内容来自节点源码", async () => {
    const { view, host } = mount();
    try {
      await flush();
      const svg = previewOf(host).querySelector("svg");
      expect(svg).not.toBeNull();
      expect(codeOfSvg(svg)).toBe(INITIAL_CODE);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("点渲染区（previewLayer）→ 进入编辑态：mermaid-editing + 编辑层可见，预览仍保留", async () => {
    const { view, host } = mount();
    try {
      await flush();
      const wrapper = wrapperOf(host);
      const codeEl = codeElOf(host);
      expect(codeEl.style.display).toBe("none");

      mouse(previewOf(host), "mousedown");

      expect(wrapper.classList.contains("mermaid-editing")).toBe(true);
      expect(codeEl.style.display).toBe("block");
      expect(codeEl.getAttribute("contenteditable")).toBe("true");
      // 进入编辑后上方渲染结果仍然可见（上下联动的前提）
      expect(previewOf(host).style.display).toBe("block");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  /**
   * v0.13.2 返修（用户复测）：「在上半部分进行编辑，下半部分编辑区没有实时更新内容。」
   *
   * 根因：预览层是 contenteditable 编辑器的后代，且 `handlePreviewPointerDown`
   * 在 `isEditing === true` 时直接 return（不 preventDefault）→ 第二次点击把浏览器
   * 原生光标放进 SVG/预览 DOM，键入只改预览、不进 ProseMirror，下方源码自然不动。
   * 修法：预览层 `contenteditable=false` + **编辑态下也拦截** mousedown，
   * 把输入焦点和光标统一路由回真正的 contentDOM。
   */
  it("编辑态下再点渲染区：焦点回到源码编辑层，预览层不可被原生编辑", async () => {
    const { view, host } = mount();
    try {
      await flush();
      const preview = previewOf(host);
      const codeEl = codeElOf(host);
      expect(preview.getAttribute("contenteditable")).toBe("false");

      // 第一次点：进入编辑态
      mouse(preview, "mousedown");
      await flush();
      expect(wrapperOf(host).classList.contains("mermaid-editing")).toBe(true);
      // 第二次点（编辑态）：旧实现在这里直接 return，键入会落在预览 DOM
      mouse(preview, "mousedown");
      expect(document.activeElement).toBe(codeEl);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("点渲染出的 SVG 上同样进入编辑态（不是只有预览层空白处可点）", async () => {
    const { view, host } = mount();
    try {
      await flush();
      const svg = previewOf(host).querySelector("svg")!;
      expect(svg).not.toBeNull();

      mouse(svg, "mousedown");

      expect(wrapperOf(host).classList.contains("mermaid-editing")).toBe(true);
      expect(codeElOf(host).style.display).toBe("block");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("撤销 / 重做作用于 mermaid_block 源码，并触发预览重渲染", async () => {
    const { view, host } = mount();
    try {
      await flush();
      const pos = mermaidPos(view);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(codeOfSvg(previewOf(host).querySelector("svg"))).toBe(INITIAL_CODE);

      // 在节点内容起点插入一段源码（模拟用户编辑）
      view.dispatch(view.state.tr.insertText("EXTRA ", pos + 1));
      await flush();
      expect(view.state.doc.nodeAt(pos)!.textContent).toContain("EXTRA");
      expect(codeOfSvg(previewOf(host).querySelector("svg"))).toContain("EXTRA");

      // 撤销：源码回到初始 → 预览随之回到初始（说明 update 路径确实重渲染）
      undo(view.state, view.dispatch);
      await flush();
      expect(view.state.doc.nodeAt(pos)!.textContent).toBe(INITIAL_CODE);
      expect(codeOfSvg(previewOf(host).querySelector("svg"))).toBe(INITIAL_CODE);

      // 重做：又回到编辑后的源码
      redo(view.state, view.dispatch);
      await flush();
      expect(view.state.doc.nodeAt(pos)!.textContent).toContain("EXTRA");
      expect(codeOfSvg(previewOf(host).querySelector("svg"))).toContain("EXTRA");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ═══════════════ 实时联动 / 节流 ═══════════════

describe("需求3：上下实时联动（编辑态 120ms 防抖，读活的 contentDOM）", () => {
  it("编辑区输入后按 120ms 节流更新预览；渲染的是**新**源码而不是节点旧文本", async () => {
    const { nv, preview, content } = makeNodeView(INITIAL_CODE);
    try {
      await flush();
      expect(codeOfSvg(preview.querySelector("svg"))).toBe(INITIAL_CODE);

      // 点预览区进入编辑态（真实 mousedown → handlePreviewPointerDown）
      mouse(preview, "mousedown");
      await flush();
      const callsAfterEnter = mermaidMock.render.mock.calls.length;

      vi.useFakeTimers();
      const NEW_CODE = "graph LR\n  X-->Y";
      // 模拟用户敲源码：contentDOM 是活的文本源（getCode 在 isEditing 时读它）
      content.textContent = NEW_CODE;
      // 让 MutationObserver 回调先跑（它只负责排 120ms 防抖，不应立即渲染）
      await flush();
      expect(mermaidMock.render.mock.calls.length).toBe(callsAfterEnter);

      await vi.advanceTimersByTimeAsync(119);
      expect(mermaidMock.render.mock.calls.length).toBe(callsAfterEnter); // 未到点

      await vi.advanceTimersByTimeAsync(1);
      await flush();
      // 渲染入口收到的就是新源码（实时联动：不是上一版 node.textContent）
      const lastCall = mermaidMock.render.mock.calls[mermaidMock.render.mock.calls.length - 1];
      expect(lastCall[1]).toBe(NEW_CODE);
      expect(codeOfSvg(preview.querySelector("svg"))).toBe(NEW_CODE);
    } finally {
      nv.destroy();
    }
  });

  it("编辑中录入非法语法：**保留**上一张成功的 SVG，不闪成空白/错误态", async () => {
    const { nv, preview, content } = makeNodeView(INITIAL_CODE);
    try {
      await flush();
      expect(preview.querySelector("svg")).not.toBeNull();

      // 进入编辑态会按当前源码重渲染一次（同样成功）——在这之后取"上一张成功的图"，
      // 后面才能断言非法输入期间**同一个 DOM 节点**没被换掉。
      mouse(preview, "mousedown");
      await flush();
      const okSvg = preview.querySelector("svg");
      expect(okSvg).not.toBeNull();

      vi.useFakeTimers();
      content.textContent = "INVALID syntax here";
      await flush();
      await vi.advanceTimersByTimeAsync(120);
      await flush();

      // 渲染确实失败过一次（行为可观测：mock 抛错）
      expect(preview.querySelector(".mermaid-error")).toBeNull();
      expect(preview.querySelector("svg")).toBe(okSvg);
      expect(codeOfSvg(preview.querySelector("svg"))).toBe(INITIAL_CODE);
    } finally {
      nv.destroy();
    }
  });

  it("非编辑态的非法语法（没有成功图可保留）→ 显示错误提示而不是崩溃", async () => {
    const { nv, preview } = makeNodeView("INVALID");
    try {
      await flush();
      expect(preview.querySelector("svg")).toBeNull();
      expect(preview.querySelector(".mermaid-error")).not.toBeNull();
    } finally {
      nv.destroy();
    }
  });
});

// ═══════════════ 竞态守卫 / destroy ═══════════════

describe("需求3：renderSeq 竞态守卫与 destroy", () => {
  it("旧渲染结果晚回来时被丢弃：后发的新结果才允许写回 DOM", async () => {
    const resolvers: Array<(v: { svg: string }) => void> = [];
    mermaidMock.render.mockImplementation(
      () => new Promise<{ svg: string }>((resolve) => resolvers.push(resolve)),
    );

    const { nv, preview } = makeNodeView("code-A");
    try {
      // 第一次渲染挂起（seq=1）；随后节点更新触发第二次渲染（seq=2）
      const nodeB: PMNode = lightMDSchema.nodes.mermaid_block.create(null, [
        lightMDSchema.text("code-B"),
      ]);
      (nv as unknown as { update: (n: PMNode) => void }).update(nodeB);
      expect(resolvers).toHaveLength(2);

      // 旧结果先回来 → 必须被丢弃
      resolvers[0]({ svg: `<svg data-code="code-A"></svg>` });
      await flush();
      expect(preview.querySelector("svg")).toBeNull();

      // 新结果回来 → 正常写回
      resolvers[1]({ svg: `<svg data-code="code-B"></svg>` });
      await flush();
      expect(codeOfSvg(preview.querySelector("svg"))).toBe("code-B");
    } finally {
      nv.destroy();
    }
  });

  it("destroy() 后，在途渲染结果不得再写回已销毁的 DOM", async () => {
    let resolveRender!: (v: { svg: string }) => void;
    mermaidMock.render.mockImplementation(
      () => new Promise<{ svg: string }>((resolve) => (resolveRender = resolve)),
    );

    const { nv, preview } = makeNodeView("graph TD");
    nv.destroy();
    resolveRender({ svg: `<svg data-code="late"></svg>` });
    await flush();

    expect(preview.innerHTML).toBe("");
  });

  it("destroy() 清掉待触发的防抖渲染；同时摘掉预览层监听", async () => {
    const { nv, preview, content, dispatch } = makeNodeView(INITIAL_CODE);
    await flush();

    mouse(preview, "mousedown");
    await flush();
    expect(nv.dom.classList.contains("mermaid-editing")).toBe(true);

    vi.useFakeTimers();
    content.textContent = "graph LR\n  A-->B";
    await flush(); // MutationObserver 排入 120ms 防抖
    const callsBeforeDestroy = mermaidMock.render.mock.calls.length;

    nv.destroy();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    // 防抖定时器已被清除：不再有渲染副作用
    expect(mermaidMock.render.mock.calls.length).toBe(callsBeforeDestroy);

    // destroy 摘掉了预览层 mousedown 监听：再点不会再走 placeCaretInsideBlock
    const dispatchCalls = dispatch.mock.calls.length;
    mouse(preview, "mousedown");
    expect(dispatch.mock.calls.length).toBe(dispatchCalls);
  });
});
