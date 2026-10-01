/**
 * E12(v0.9.4)：撤销历史跨模式边界优化
 *
 * 修复前：①源码→阅读的 replaceWith 未区分内容是否变化，"切一圈不改"也占用一次 PM 撤销；
 * ②阅读→源码无条件清空源码 diff 栈，切回来历史被丢；③源码撤到底再按 Ctrl+Z 为静默 no-op。
 * 修复后：①②改由纯函数判定（本文件直接验证判定语义 + PM history 机制），③给出明确提示。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { history, undoDepth } from "prosemirror-history";
import { markdownToDoc } from "../core/markdown/parser";
import {
  shouldReplacePmDoc,
  shouldResetSourceUndoStack,
  sourceUndoBoundaryMessage,
} from "../components/editor/EditorContainer";
import { notifyWarning, setNotificationHandler, type Notification } from "../services/notificationService";

function stateWithHistory(markdown: string): EditorState {
  return EditorState.create({ doc: markdownToDoc(markdown), plugins: [history()] });
}

describe("E12：判定纯函数语义", () => {
  it("shouldReplacePmDoc：内容一致 → 跳过整树替换", () => {
    expect(shouldReplacePmDoc("hello\n", "hello\n")).toBe(false);
  });

  it("shouldReplacePmDoc：内容不同 → 需要替换", () => {
    expect(shouldReplacePmDoc("hello world\n", "hello\n")).toBe(true);
  });

  it("shouldResetSourceUndoStack：文本一致 → 保留 diff 栈", () => {
    expect(shouldResetSourceUndoStack("abc", "abc")).toBe(false);
  });

  it("shouldResetSourceUndoStack：文本不同 → 重建基线（清空）", () => {
    expect(shouldResetSourceUndoStack("abc", "abd")).toBe(true);
  });

  it("sourceUndoBoundaryMessage：栈空给出提示，非空不提示", () => {
    expect(sourceUndoBoundaryMessage(0)).toBe("已到本模式撤销边界");
    expect(sourceUndoBoundaryMessage(3)).toBeNull();
  });
});

describe("E12：PM history 机制（跳过 replaceWith 不产生空撤销步骤）", () => {
  it("内容一致时不 dispatch → 撤销深度保持 0", () => {
    const state = stateWithHistory("hello\n");
    expect(undoDepth(state)).toBe(0);
    // 修复后的路径：shouldReplacePmDoc 为 false → 不 dispatch 整树替换
    if (shouldReplacePmDoc("hello\n", "hello\n")) {
      throw new Error("内容一致时不应替换");
    }
    expect(undoDepth(state)).toBe(0);
  });

  it("内容变化时 replaceWith → 新增一步撤销（Ctrl+Z 可回源码会话前）", () => {
    const state1 = stateWithHistory("hello\n");
    const newDoc = markdownToDoc("hello world\n");
    const state2 = state1.apply(
      state1.tr.replaceWith(0, state1.doc.content.size, newDoc.content),
    );
    expect(undoDepth(state2)).toBe(1);
  });

  it("（旧行为回归说明）无条件 replaceWith 即使内容一致也会占一次撤销", () => {
    const state1 = stateWithHistory("hello\n");
    const sameDoc = markdownToDoc("hello\n");
    const state2 = state1.apply(
      state1.tr.replaceWith(0, state1.doc.content.size, sameDoc.content),
    );
    // 这正是修复前"阅读→源码→不改→阅读"多出一步空撤销的根因
    expect(undoDepth(state2)).toBe(1);
  });
});

describe("E12：撤销边界提示送达 UI", () => {
  afterEach(() => setNotificationHandler(null));

  it("撤到底的提示文案经 notificationService 以 warning 送达", () => {
    const received: Notification[] = [];
    setNotificationHandler((n) => received.push(n));
    const msg = sourceUndoBoundaryMessage(0);
    expect(msg).not.toBeNull();
    if (msg) notifyWarning(msg);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("warning");
    expect(received[0].message).toBe("已到本模式撤销边界");
  });
});
