/**
 * v0.7.0 问题2复现：AI 续写 ghost 流式渲染机制验证
 *
 * 场景：点击 AI 续写后，chunk 陆续到达 → setAiGhost 追加文本 →
 * 编辑器光标处应实时显示灰色 ghost 文本 + Tab/Esc 提示。
 * 本测试用 jsdom + 真实 PM EditorView 复现流式渲染链路。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { markdownToDoc } from "../core/markdown/parser";
import { aiGhostPlugin, setAiGhost, clearAiGhost, aiGhostKey } from "../core/plugins/ai-ghost";

let view: EditorView | null = null;
let mount: HTMLElement | null = null;

function mountEditor(md: string, cursorTextEnd?: string): EditorView {
  const doc = markdownToDoc(md);
  let pos = 1;
  if (cursorTextEnd) {
    doc.descendants((node, p) => {
      if (node.isText && node.text?.endsWith(cursorTextEnd)) {
        pos = p + node.text.length;
        return false;
      }
      return true;
    });
  }
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, pos),
    plugins: [aiGhostPlugin()],
  });
  mount = document.createElement("div");
  document.body.appendChild(mount);
  view = new EditorView(mount, { state });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
  mount?.remove();
  mount = null;
});

describe("v0.7.0 问题2：AI 续写 ghost 流式渲染", () => {
  it("流式 chunk 连续追加时，ghost 文本实时更新（核心复现）", () => {
    const v = mountEditor("标题正文。\n\n第二段结尾。", "结尾。");
    const pos = v.state.selection.to;

    // 模拟 runAiGhost：初始空 → chunk1 → chunk2 → chunk3
    setAiGhost(v, pos, "");
    expect(mount!.querySelector(".ai-ghost")).toBeNull(); // 空文本不渲染

    setAiGhost(v, pos, "AI ");
    setAiGhost(v, pos, "AI 续写");
    setAiGhost(v, pos, "AI 续写的内容。");

    const text = mount!.querySelector(".ai-ghost-text");
    expect(text?.textContent).toBe("AI 续写的内容。");
    expect(mount!.querySelector(".ai-ghost-hint")?.textContent).toContain("Tab");
  });

  it("ghost 状态与插件 state 同步", () => {
    const v = mountEditor("正文。", "正文。");
    const pos = v.state.selection.to;
    setAiGhost(v, pos, "幽灵");
    expect(aiGhostKey.getState(v.state)?.text).toBe("幽灵");
    expect(aiGhostKey.getState(v.state)?.pos).toBe(pos);
    clearAiGhost(v);
    expect(aiGhostKey.getState(v.state)).toBeNull();
    expect(mount!.querySelector(".ai-ghost")).toBeNull();
  });

  it("文档编辑（docChanged）后 ghost 自动清除", () => {
    const v = mountEditor("正文。", "正文。");
    const pos = v.state.selection.to;
    setAiGhost(v, pos, "幽灵");
    expect(mount!.querySelector(".ai-ghost-text")).not.toBeNull();
    // 用户输入一个字符（docChanged，无 ghost meta）
    v.dispatch(v.state.tr.insertText("x", pos, pos));
    expect(aiGhostKey.getState(v.state)).toBeNull();
    expect(mount!.querySelector(".ai-ghost")).toBeNull();
  });
});
