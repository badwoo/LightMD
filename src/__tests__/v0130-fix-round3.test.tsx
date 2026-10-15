/**
 * v0.13.0 返修第三轮（实机反馈第二批）：回归测试。
 *
 * 本轮由用户在**已安装的 0.13.0 实机包**上测出 14 个问题。本文件覆盖其中
 * 由 Lead 负责的 8 项（表格/菜单/图片管理/自动保存由并行的另外三份测试覆盖）：
 *
 * ① 段落等普通块前面不该有 ⋮⋮ 手柄，只有代码块/图表/公式/图片块才需要；
 * ② 点开三点菜单不得触发系统剪贴板授权弹窗
 *    （「http://tauri.localhost 想要查看复制到剪贴板的文本和图像」）；
 * ③ Mermaid / 公式块单击必须真正进入编辑态且**保持住**（不被 PM 重建 DOM 掉）；
 * ④ 块复制 → 粘贴不得把整篇文档粘进来；
 * ⑧ 带图片文档滚动时底部栏不得颤动（百分比/行列占位固定）；
 * ⑨ 切到带图片的文档时图片管理悬浮入口必须自动出现（切走要消失）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { createEditor } from "../core/editor";
import { EditorContainer } from "../components/editor/EditorContainer";
import { setCurrentDocPath } from "../utils/imagePath";
import { TextSelection } from "prosemirror-state";
import {
  isHandleBlock,
  DRAGGABLE_BLOCKS,
} from "../core/plugins/block-drag";
import { markdownToDoc } from "../core/markdown/parser";
import { nodeToMarkdown } from "../core/markdown/serializer";
import {
  selectBlockAt,
  copySelectedBlock,
  cutSelectedBlock,
  pasteBlockAtSelection,
  readBlockClipboard,
  hasInAppBlockClipboard,
  getInAppBlockClipboard,
  __resetInAppBlockClipboardForTest,
} from "../utils/blockClipboardOps";
import type { EditorView } from "prosemirror-view";

const SRC = (p: string) => readFileSync(`src/${p}`, "utf-8");
/** 去掉注释后的源码（注释里会引用旧写法，断言必须只看真实代码） */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const editorCssRaw = SRC("styles/editor.css");
const editorCss = stripComments(editorCssRaw);
const statusCss = stripComments(SRC("components/layout/StatusBar.css"));

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function mount(md: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: md }) as EditorView;
  return { view, host };
}

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

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  installTauriStub();
  setCurrentDocPath(null);
  __resetInAppBlockClipboardForTest();
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint =
    () => document.body;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

// ═════════ 问题1：手柄只给"特殊块" ═════════

describe("问题1：⋮⋮ 手柄只出现在代码块/图表/公式/图片块", () => {
  it("CSS：手柄选择器不再是无差别的 `.ProseMirror > *`", () => {
    // 旧实现给每个顶层块画手柄 → 每个段落前面都冒出手柄
    expect(editorCss).not.toContain(".ProseMirror > *::after");
    // 四类 wrapper + 含图片的段落
    for (const cls of [
      "code-block-wrapper",
      "mermaid-block-wrapper",
      "math-block-wrapper",
      "table-wrapper",
    ]) {
      expect(editorCss).toContain(`.ProseMirror > .${cls}::after`);
    }
    expect(editorCss).toContain(".ProseMirror > p:has(> img)::after");
  });

  it("CSS：手柄显示条件也按同一组收窄（普通段落 hover 也不显示）", () => {
    // 不能残留 `.ProseMirror > *:hover::after` 这类无差别规则
    expect(editorCss).not.toContain(".ProseMirror > *:hover::after");
    expect(editorCss).not.toContain(".ProseMirror .pm-block-active::after");
  });

  it("isHandleBlock：四类块 + 图片块为 true，普通块为 false", () => {
    const doc = markdownToDoc(
      "# H1\n\n普通段落\n\n- 列表\n\n> 引用\n\n```js\nx\n```\n\n$$\ny\n$$\n\n| A |\n| --- |\n| 1 |\n\n![i](./a.png)\n",
    );
    const kinds: Array<[number, string]> = [];
    let acc = 0;
    for (let i = 0; i < doc.childCount; i++) {
      kinds.push([acc, doc.child(i).type.name]);
      acc += doc.child(i).nodeSize;
    }
    const byName = new Map(kinds.map(([pos, name]) => [name, pos]));
    expect(isHandleBlock(doc, byName.get("code_block")!)).toBe(true);
    expect(isHandleBlock(doc, byName.get("math_block")!)).toBe(true);
    expect(isHandleBlock(doc, byName.get("table")!)).toBe(true);
    // 含图片的段落（图片块）
    const imgPara = kinds.find(([, n]) => n === "paragraph");
    const imgPos = kinds[kinds.length - 1][0];
    expect(doc.child(doc.childCount - 1).textContent).toBe("");
    expect(isHandleBlock(doc, imgPos)).toBe(true);
    // 普通块：标题 / 段落 / 列表 / 引用
    expect(isHandleBlock(doc, byName.get("heading")!)).toBe(false);
    expect(isHandleBlock(doc, imgPara![0])).toBe(false);
    expect(isHandleBlock(doc, byName.get("bullet_list")!)).toBe(false);
    expect(isHandleBlock(doc, byName.get("blockquote")!)).toBe(false);
  });

  it("mermaid 块也显示手柄（白名单完整）", () => {
    const doc = markdownToDoc("```mermaid\ngraph TD\n A-->B\n```\n");
    expect(isHandleBlock(doc, 0)).toBe(true);
    // DRAGGABLE_BLOCKS 保持宽（Alt+↑/↓ 键盘移动仍支持所有块），手柄白名单独立
    expect(DRAGGABLE_BLOCKS.has("paragraph")).toBe(true);
  });

  it("拖拽热区同步收窄（不再能在普通段落左缘拖走它）", () => {
    const src = SRC("core/plugins/block-drag.ts");
    expect(src).toContain("isHandleBlock(view.state.doc, pos)");
    expect(src).toContain("export function isHandleBlock");
  });
});

// ═════════ 问题2：三点菜单不得弹系统剪贴板授权 ═════════

describe("问题2：菜单禁用态判定不得触发系统剪贴板弹窗", () => {
  it("readBlockClipboard：应用内有数据时**完全不碰** navigator.clipboard", async () => {
    const readSpy = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read: readSpy, writeText: vi.fn(), write: vi.fn() },
    });
    // 先复制一个块（走 writeBlockClipboard → 记应用内兜底）
    const { view } = mount("AAA\n\nBBB\n");
    selectBlockAt(view, 0);
    await copySelectedBlock(view);
    expect(hasInAppBlockClipboard()).toBe(true);

    const back = await readBlockClipboard();
    expect(back?.markdown).toContain("AAA");
    // 关键：应用内兜底优先 → 不调用 clipboard.read（WebView2 会为它弹授权气泡）
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("getInAppBlockClipboard：同步返回（不是 Promise），空时返回 null", () => {
    expect(getInAppBlockClipboard()).toBeNull();
    const v = getInAppBlockClipboard();
    expect(v === null || typeof (v as { then?: unknown }).then !== "function").toBe(true);
  });

  it("EditorContainer 打开菜单时只用应用内兜底（真实代码不再读系统剪贴板）", () => {
    const src = stripComments(SRC("components/editor/EditorContainer.tsx"));
    // 两处菜单打开都不应再出现 readBlockClipboard 调用
    expect(src).not.toContain("readBlockClipboard");
    expect(src).toContain("hasBlockClipboard: hasInAppBlockClipboard()");
    expect(src).toContain("hasClipboard: hasInAppBlockClipboard()");
  });
});

// ═════════ 问题3：单击进编辑且保持住 ═════════

describe("问题3：Mermaid / 公式块单击进入编辑态并保持", () => {
  it("公式块：单击后 120ms 编辑态仍在（DOM 未被 PM 重建）", async () => {
    const { host } = mount("$$\nE = mc^2\n$$\n");
    const wrapper = host.querySelector(".math-block-wrapper") as HTMLElement;
    const preview = host.querySelector(".math-block-preview") as HTMLElement;
    preview.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 60, clientY: 30 }),
    );
    expect(wrapper.classList.contains("math-editing")).toBe(true);
    await tick();
    // 旧实现这里被 PM 重建 DOM → class 回到初始值、编辑层 display:none（"闪动"）
    const after = host.querySelector(".math-block-wrapper") as HTMLElement;
    const content = host.querySelector(".math-block-content") as HTMLElement;
    expect(after).toBe(wrapper); // 同一个 DOM 节点（没被重建）
    expect(after.classList.contains("math-editing")).toBe(true);
    expect(content.style.display).toBe("block");
  });

  it("Mermaid 块：单击后 120ms 编辑态仍在", async () => {
    const { host } = mount("```mermaid\ngraph TD\n  A --> B\n```\n");
    const wrapper = host.querySelector(".mermaid-block-wrapper") as HTMLElement;
    const preview = host.querySelector(".mermaid-preview-layer") as HTMLElement;
    preview.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 60, clientY: 30 }),
    );
    expect(wrapper.classList.contains("mermaid-editing")).toBe(true);
    await tick();
    const after = host.querySelector(".mermaid-block-wrapper") as HTMLElement;
    expect(after).toBe(wrapper);
    expect(after.classList.contains("mermaid-editing")).toBe(true);
  });

  it("两个 NodeView 都实现了 ignoreMutation 忽略自身编辑态突变", () => {
    for (const f of ["core/plugins/math-block.ts", "core/plugins/mermaid-block.ts"]) {
      const src = SRC(f);
      expect(src).toContain("ignoreMutation(mutation: ViewMutationRecord): boolean");
      // 必须忽略 contentDOM 的 attributes（display 切换）与 wrapper 的 attributes（class）
      expect(src).toContain('mutation.type === "attributes"');
    }
  });

  it("编辑层内的真实文本输入仍然进入文档（不能把内容编辑也忽略掉）", async () => {
    const { host, view } = mount("$$\nE = mc^2\n$$\n");
    const preview = host.querySelector(".math-block-preview") as HTMLElement;
    preview.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 60, clientY: 30 }),
    );
    await tick();
    // 光标应落在块内（TextSelection），且位置在块内容区间内
    const sel = view.state.selection;
    expect(sel.from).toBeGreaterThanOrEqual(1);
    expect(sel.from).toBeLessThanOrEqual(1 + view.state.doc.child(0).content.size);
  });
});

// ═════════ 问题4：块复制/粘贴 ═════════

describe("问题4：块复制 → 粘贴不得粘进整篇文档", () => {
  it("nodeToMarkdown：只返回**该块**，不含后续块（旧实现返回整篇源文档）", () => {
    const doc = markdownToDoc("AAA\n\nBBB\n\nCCC\n");
    // 首段命中 B6 原文记录（start === 0）——旧实现走 docToMarkdown 快路径返回整篇
    expect(nodeToMarkdown(doc.child(0))).toBe("AAA\n");
    expect(nodeToMarkdown(doc.child(1))).toBe("BBB\n");
    expect(nodeToMarkdown(doc.child(2))).toBe("CCC\n");
  });

  it("代码块 / 标题 / 表格 / 列表：都只返回自己", () => {
    const cases: Array<[string, number]> = [
      ["```js\nlet a = 1;\n```\n\nBBB\n", 0],
      ["## 标题二\n\nBBB\n", 0],
      ["- a\n- b\n\nBBB\n", 0],
      ["| A | B |\n| --- | --- |\n| 1 | 2 |\n\nBBB\n", 0],
    ];
    for (const [md, idx] of cases) {
      const doc = markdownToDoc(md);
      const out = nodeToMarkdown(doc.child(idx));
      expect(out).not.toContain("BBB");
      expect(out.trim().length).toBeGreaterThan(0);
    }
  });

  it("copySelectedBlock：载荷只含被复制的块", async () => {
    const { view } = mount("AAA\n\nBBB\n");
    selectBlockAt(view, 0);
    await copySelectedBlock(view);
    const back = await readBlockClipboard();
    expect(back?.markdown?.trim()).toBe("AAA");
    expect(back?.markdown).not.toContain("BBB");
  });

  it("粘贴：NodeSelection 时**替换**被选中的块（不是往前插一个）", async () => {
    const { view } = mount("AAA\n\nBBB\n");
    // 复制 AAA
    selectBlockAt(view, 0);
    await copySelectedBlock(view);
    // 选中 BBB 再粘贴 → 应替换 BBB，而不是在 BBB 前面再插一个
    const posB = view.state.doc.child(0).nodeSize;
    selectBlockAt(view, posB);
    const ok = await pasteBlockAtSelection(view);
    expect(ok).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).textContent).toBe("AAA");
    expect(view.state.doc.child(1).textContent).toBe("AAA");
  });

  it("粘贴：普通光标处插入（不删除任何块）", async () => {
    const { view } = mount("AAA\n\nBBB\n");
    selectBlockAt(view, 0);
    await copySelectedBlock(view);
    // 光标放到文档末尾（非 NodeSelection，用 TextSelection）
    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    const ok = await pasteBlockAtSelection(view);
    expect(ok).toBe(true);
    // 原有两块都在，末尾多出 AAA
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.textContent).toContain("AAABBB");
  });

  it("剪切 → 粘贴：块数守恒（不出现「多出来一个块」）", async () => {
    const { view } = mount("AAA\n\nBBB\n");
    selectBlockAt(view, 0);
    await cutSelectedBlock(view);
    expect(view.state.doc.childCount).toBe(1);
    // 粘贴回文档末尾
    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    await pasteBlockAtSelection(view);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.textContent).toBe("BBBAAA");
  });
});

// ═════════ 问题8：底部栏颤动 ═════════

describe("问题8：底部栏滚动时不颤动（变宽数值预留固定占位）", () => {
  it("阅读进度百分比固定宽度（1 位 → 3 位不改变宽度）", () => {
    const rule = statusCss.slice(statusCss.indexOf(".statusbar-progress"));
    expect(rule.slice(0, 500)).toContain("min-width");
  });

  it("行/列指示同样预留固定宽度", () => {
    const rule = statusCss.slice(statusCss.indexOf(".statusbar-cursor"));
    expect(rule.slice(0, 500)).toContain("min-width");
  });

  it("保留既有等宽数字（tabular-nums）不被回退", () => {
    expect(statusCss).toMatch(/\.statusbar-progress \{[\s\S]{0,400}?font-variant-numeric: tabular-nums/);
    expect(statusCss).toMatch(/\.statusbar-cursor \{[\s\S]{0,400}?font-variant-numeric: tabular-nums/);
  });
});

// ═════════ 问题9：图片管理入口跟随文档 ═════════

describe("问题9：图片管理悬浮入口随文档自动出现/消失", () => {
  const DOC_IMG = "# 图片文档\n\n![image.png](./assets/image-3.png)\n";
  const DOC_NOIMG = "# 纯文本\n\n这里没有图片。\n";

  it("从无图文档切到有图文档 → 图标出现（旧实现不出现）", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_NOIMG} filePath="D:/x/a.md" forceUpdateKey={1} />,
    );
    await waitFor(() => {
      expect(document.querySelector(".ProseMirror")!.textContent).toContain("这里没有图片");
    });
    expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeNull();

    rerender(<EditorContainer content={DOC_IMG} filePath="D:/x/b.md" forceUpdateKey={2} />);
    await waitFor(() => {
      expect(document.querySelector(".ProseMirror img")).toBeTruthy();
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeTruthy();
    });
  });

  it("从有图文档切到无图文档 → 图标消失（旧实现不消失）", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_IMG} filePath="D:/x/b.md" forceUpdateKey={1} />,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeTruthy();
    });

    rerender(<EditorContainer content={DOC_NOIMG} filePath="D:/x/a.md" forceUpdateKey={2} />);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeNull();
    });
  });

  it("编辑时新增图片 → 图标出现；删掉 → 消失", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_NOIMG} filePath="D:/x/a.md" forceUpdateKey={1} />,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeNull();
    });
    rerender(<EditorContainer content={DOC_NOIMG + "\n![n](./b.png)\n"} filePath="D:/x/a.md" forceUpdateKey={1} />);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeTruthy();
    });
  });

  it("源码模式下的假图片（代码围栏内）不显示入口", async () => {
    render(
      <EditorContainer
        content={"# 文档\n\n```md\n![x](./a.png)\n```\n"}
        filePath="D:/x/a.md"
        forceUpdateKey={1}
      />,
    );
    await tick(200);
    expect(document.querySelector('[data-testid="image-manager-btn"]')).toBeNull();
  });
});
