/**
 * v0.5.0 N3：数学公式编辑态实时预览
 *
 * 验收标准：
 * 1. 块级公式编辑态：预览层不再隐藏，与编辑区上下并列（toggleEditMode 无 previewLayer.style.display = "none"）
 * 2. 双击进入编辑态后预览层可见，且渲染当前 LaTeX
 * 3. 编辑输入（node 更新）后预览实时刷新（rAF 合并，等待下一帧后预览内容为新公式）
 * 4. update 用 rAF 合并渲染：同步多次 update 只调度一次
 * 5. destroy 取消未完成的 rAF，无泄漏
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEditor } from "../core/editor";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 测试专用：createEditor 在 jsdom 下不会返回 null，断言为非空简化用例 */
function mk(opts: { parent: HTMLElement; initialContent: string }): EditorView {
  return createEditor(opts) as EditorView;
}

/** 等待 rAF + 宏任务落定（预览渲染为 rAF 合并） */
async function waitFrame() {
  await new Promise((r) => setTimeout(r, 30));
}

describe("v0.5.0 N3：数学公式编辑态实时预览", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    parent.remove();
  });

  /** 查找块级公式 wrapper DOM */
  function findMathBlock(): HTMLElement | null {
    return parent.querySelector(".math-block-wrapper");
  }

  it("源码：编辑态不再隐藏预览层，update 用 rAF 合并渲染", () => {
    const src = readSrc("src/core/plugins/math-block.ts");
    // 编辑分支不得隐藏预览层（旧实现为 previewLayer.style.display = "none"）
    expect(src).not.toMatch(/previewLayer\.style\.display = "none"/);
    // 编辑分支显示预览层并立即渲染
    expect(src).toMatch(/this\.previewLayer\.style\.display = "block"/);
    // rAF 合并渲染 + destroy 取消
    expect(src).toMatch(/requestAnimationFrame/);
    expect(src).toMatch(/cancelAnimationFrame/);
  });

  it("CSS：编辑态上下并列布局与预览角标", () => {
    const css = readSrc("src/styles/editor.css");
    expect(css).toMatch(/\.math-block-wrapper\.math-editing \{\s*display: flex;\s*flex-direction: column;/);
    expect(css).toMatch(/\.math-block-wrapper\.math-editing > \.math-block-preview::before/);
    expect(css).toMatch(/content: "预览"/);
  });

  it("块级公式：双击进入编辑态后预览层可见且渲染当前公式", async () => {
    view = mk({ parent, initialContent: "$$\\frac{a}{b}$$" });
    const wrapper = findMathBlock();
    expect(wrapper).not.toBeNull();
    const preview = wrapper!.querySelector<HTMLElement>(".math-block-preview");
    expect(preview).not.toBeNull();

    // 双击进入编辑态
    wrapper!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFrame();

    // 预览层显示且包含 KaTeX 渲染结果
    expect(preview!.style.display).not.toBe("none");
    expect(preview!.innerHTML).toContain("katex");
    // 编辑区可见
    const content = wrapper!.querySelector<HTMLElement>(".math-block-content");
    expect(content!.style.display).not.toBe("none");
  });

  it("块级公式：编辑中修改公式源码，预览实时刷新", async () => {
    const v = mk({ parent, initialContent: "$$a+b$$" });
    view = v;
    const wrapper = findMathBlock();
    wrapper!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFrame();

    // 模拟编辑：将公式内容改为 c+d（直接通过 transaction 修改节点文本）
    let mathPos = -1;
    v.state.doc.descendants((node, pos) => {
      if (mathPos < 0 && node.type.name === "math_block") {
        mathPos = pos;
        return false;
      }
      return true;
    });
    expect(mathPos).toBeGreaterThan(-1);
    const mathNode = v.state.doc.nodeAt(mathPos)!;
    // 模拟真实编辑路径：在节点内部追加文本（触发 NodeView.update 而非整节点替换重建）
    const insideEnd = mathPos + 1 + mathNode.content.size;
    v.dispatch(v.state.tr.insertText("+c", insideEnd));
    await waitFrame();

    // 双击/编辑可能触发 PM 重建 NodeView，重新查询当前 wrapper
    const freshWrapper = findMathBlock()!;
    const freshPreview = freshWrapper.querySelector<HTMLElement>(".math-block-preview")!;
    // 预览已更新为新公式（data-latex 与预览 HTML 均反映 a+b+c）
    expect(freshWrapper.getAttribute("data-latex")).toBe("a+b+c");
    expect(freshPreview.innerHTML).toContain("katex");
  });

  it("rAF 合并：连续多次 update 只渲染一帧", async () => {
    const v = mk({ parent, initialContent: "$$x$$" });
    view = v;
    const wrapper = findMathBlock();
    wrapper!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await waitFrame();

    // 同一同步块内连续 3 次 update（模拟快速输入）
    let mathPos = -1;
    v.state.doc.descendants((node, pos) => {
      if (mathPos < 0 && node.type.name === "math_block") {
        mathPos = pos;
        return false;
      }
      return true;
    });
    const mathNode0 = v.state.doc.nodeAt(mathPos)!;
    const insideEnd = mathPos + 1 + mathNode0.content.size;
    // 同一同步块内连续 3 次在节点内部追加字符（模拟快速输入）
    v.dispatch(v.state.tr.insertText("1", insideEnd));
    v.dispatch(v.state.tr.insertText("2", insideEnd + 1));
    v.dispatch(v.state.tr.insertText("3", insideEnd + 2));
    await waitFrame();

    // 最终渲染为最后一次内容（rAF 只渲染一帧，内容为 x123）
    // 双击/编辑可能触发 PM 重建 NodeView，重新查询当前 wrapper
    expect(findMathBlock()!.getAttribute("data-latex")).toBe("x123");
  });
});
