/**
 * 撤销/恢复核心逻辑测试
 *
 * 测试 computeDiff 和 applyDiff 的正确性，
 * 确保增量差异存储方案在各种场景下都能正确撤销和恢复
 */
import { describe, it, expect } from "vitest";

// ─── 从 EditorContainer 中提取的核心函数（复制用于单元测试）──────────

interface HistoryEntry {
  start: number;
  deleted: string;
  inserted: string;
  cursorPos: number;
  scrollTop: number;
}

function computeDiff(oldText: string, newText: string): { start: number; deleted: string; inserted: string } {
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }
  let oldSuffixLen = 0;
  let newSuffixLen = 0;
  while (
    oldSuffixLen < (oldText.length - prefixLen) &&
    newSuffixLen < (newText.length - prefixLen) &&
    oldText[oldText.length - 1 - oldSuffixLen] === newText[newText.length - 1 - newSuffixLen]
  ) {
    oldSuffixLen++;
    newSuffixLen++;
  }
  return {
    start: prefixLen,
    deleted: oldText.substring(prefixLen, oldText.length - oldSuffixLen),
    inserted: newText.substring(prefixLen, newText.length - newSuffixLen),
  };
}

function applyDiff(text: string, entry: HistoryEntry, reverse: boolean): string {
  const deleted = reverse ? entry.inserted : entry.deleted;
  const inserted = reverse ? entry.deleted : entry.inserted;
  return text.substring(0, entry.start) + inserted + text.substring(entry.start + deleted.length);
}

// ─── 模拟完整的撤销/恢复流程 ────────────────────────────────

function simulateUndoRedo(edits: string[]) {
  /** 模拟编辑器内容变化和撤销/恢复 */
  if (edits.length < 2) throw new Error("至少需要两个版本");

  let current = edits[0];
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];

  // 记录每次编辑的差异
  for (let i = 1; i < edits.length; i++) {
    const diff = computeDiff(current, edits[i]);
    undoStack.push({ ...diff, cursorPos: 0, scrollTop: 0 });
    current = edits[i];
  }

  return { current, undoStack, redoStack };
}

// ─── 测试用例 ──────────────────────────────────────────────

describe("computeDiff", () => {
  it("应该正确计算插入操作", () => {
    const diff = computeDiff("hello", "hello world");
    expect(diff.start).toBe(5);
    expect(diff.deleted).toBe("");
    expect(diff.inserted).toBe(" world");
  });

  it("应该正确计算删除操作", () => {
    const diff = computeDiff("hello world", "hello");
    expect(diff.start).toBe(5);
    expect(diff.deleted).toBe(" world");
    expect(diff.inserted).toBe("");
  });

  it("应该正确计算替换操作", () => {
    const diff = computeDiff("hello", "hallo");
    expect(diff.start).toBe(1);
    expect(diff.deleted).toBe("e");
    expect(diff.inserted).toBe("a");
  });

  it("应该正确处理完全相同的文本", () => {
    const diff = computeDiff("same", "same");
    expect(diff.start).toBe(4);
    expect(diff.deleted).toBe("");
    expect(diff.inserted).toBe("");
  });

  it("应该正确处理空字符串到有内容", () => {
    const diff = computeDiff("", "new content");
    expect(diff.start).toBe(0);
    expect(diff.deleted).toBe("");
    expect(diff.inserted).toBe("new content");
  });

  it("应该正确处理有内容到空字符串", () => {
    const diff = computeDiff("old content", "");
    expect(diff.start).toBe(0);
    expect(diff.deleted).toBe("old content");
    expect(diff.inserted).toBe("");
  });

  it("应该正确处理中间插入", () => {
    const diff = computeDiff("ab", "aXYb");
    expect(diff.start).toBe(1);
    expect(diff.deleted).toBe("");
    expect(diff.inserted).toBe("XY");
  });

  it("应该正确处理中间删除", () => {
    const diff = computeDiff("aXYb", "ab");
    expect(diff.start).toBe(1);
    expect(diff.deleted).toBe("XY");
    expect(diff.inserted).toBe("");
  });

  it("应该正确处理尾部修改", () => {
    const diff = computeDiff("hello!", "hello?");
    expect(diff.start).toBe(5);
    expect(diff.deleted).toBe("!");
    expect(diff.inserted).toBe("?");
  });

  it("应该正确处理中文内容", () => {
    const diff = computeDiff("你好世界", "你好中国");
    expect(diff.start).toBe(2);
    expect(diff.deleted).toBe("世界");
    expect(diff.inserted).toBe("中国");
  });

  it("应该正确处理多行内容", () => {
    const oldText = "# 标题\n\n第一段\n\n第二段";
    const newText = "# 标题\n\n第一段\n\n第三段";
    const diff = computeDiff(oldText, newText);
    expect(diff.deleted).toBe("二");
    expect(diff.inserted).toBe("三");
  });
});

describe("applyDiff - 撤销（reverse=true）", () => {
  it("应该撤销插入操作", () => {
    const entry: HistoryEntry = { start: 5, deleted: "", inserted: " world", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("hello world", entry, true);
    expect(result).toBe("hello");
  });

  it("应该撤销删除操作", () => {
    const entry: HistoryEntry = { start: 5, deleted: " world", inserted: "", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("hello", entry, true);
    expect(result).toBe("hello world");
  });

  it("应该撤销替换操作", () => {
    const entry: HistoryEntry = { start: 1, deleted: "e", inserted: "a", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("hallo", entry, true);
    expect(result).toBe("hello");
  });

  it("应该撤销中文替换", () => {
    const entry: HistoryEntry = { start: 2, deleted: "世界", inserted: "中国", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("你好中国", entry, true);
    expect(result).toBe("你好世界");
  });
});

describe("applyDiff - 恢复（reverse=false）", () => {
  it("应该恢复插入操作", () => {
    const entry: HistoryEntry = { start: 5, deleted: "", inserted: " world", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("hello", entry, false);
    expect(result).toBe("hello world");
  });

  it("应该恢复删除操作", () => {
    const entry: HistoryEntry = { start: 5, deleted: " world", inserted: "", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("hello world", entry, false);
    expect(result).toBe("hello");
  });

  it("应该恢复替换操作", () => {
    const entry: HistoryEntry = { start: 1, deleted: "e", inserted: "a", cursorPos: 0, scrollTop: 0 };
    const result = applyDiff("hello", entry, false);
    expect(result).toBe("hallo");
  });
});

describe("完整撤销/恢复流程", () => {
  it("应该支持连续撤销多步编辑", () => {
    const edits = ["hello", "hello world", "hello world!", "HELLO world!"];
    const { current, undoStack } = simulateUndoRedo(edits);

    expect(current).toBe("HELLO world!");
    expect(undoStack.length).toBe(3);

    // 撤销第3步
    let text = applyDiff(current, undoStack[2], true);
    expect(text).toBe("hello world!");

    // 撤销第2步
    text = applyDiff(text, undoStack[1], true);
    expect(text).toBe("hello world");

    // 撤销第1步
    text = applyDiff(text, undoStack[0], true);
    expect(text).toBe("hello");
  });

  it("撤销后恢复应该回到原状态", () => {
    const oldText = "# 标题\n\n第一段";
    const newText = "# 标题\n\n第一段\n\n第二段";
    const diff = computeDiff(oldText, newText);
    const entry: HistoryEntry = { ...diff, cursorPos: 0, scrollTop: 0 };

    // 撤销
    const afterUndo = applyDiff(newText, entry, true);
    expect(afterUndo).toBe(oldText);

    // 恢复（从撤销后的状态，用 redo diff）
    const redoDiff = computeDiff(afterUndo, newText);
    const redoEntry: HistoryEntry = { ...redoDiff, cursorPos: 0, scrollTop: 0 };
    const afterRedo = applyDiff(afterUndo, redoEntry, false);
    expect(afterRedo).toBe(newText);
  });

  it("应该正确处理连续字符输入（模拟打字）", () => {
    const edits = ["a", "ab", "abc", "abcd"];
    const { current, undoStack } = simulateUndoRedo(edits);

    expect(current).toBe("abcd");

    // 逐步撤销
    let text = current;
    for (let i = undoStack.length - 1; i >= 0; i--) {
      text = applyDiff(text, undoStack[i], true);
    }
    expect(text).toBe("a");
  });

  it("应该正确处理大段删除后撤销", () => {
    const oldText = "# 标题\n\n这是一段很长的内容，包含多行文字。\n\n第二段内容。";
    const newText = "# 标题";
    const diff = computeDiff(oldText, newText);
    const entry: HistoryEntry = { ...diff, cursorPos: 0, scrollTop: 0 };

    // 撤销删除
    const afterUndo = applyDiff(newText, entry, true);
    expect(afterUndo).toBe(oldText);
  });

  it("应该正确处理格式化操作（如加粗）", () => {
    const oldText = "这是普通文本";
    const newText = "这是**粗体文本**";
    const diff = computeDiff(oldText, newText);
    const entry: HistoryEntry = { ...diff, cursorPos: 0, scrollTop: 0 };

    // 撤销加粗
    const afterUndo = applyDiff(newText, entry, true);
    expect(afterUndo).toBe(oldText);

    // 恢复加粗
    const redoDiff = computeDiff(afterUndo, newText);
    const redoEntry: HistoryEntry = { ...redoDiff, cursorPos: 0, scrollTop: 0 };
    const afterRedo = applyDiff(afterUndo, redoEntry, false);
    expect(afterRedo).toBe(newText);
  });

  it("应该正确处理交替撤销和恢复", () => {
    const v0 = "初始内容";
    const v1 = "初始内容+修改1";
    const v2 = "初始内容+修改1+修改2";

    // 编辑 v0 → v1
    const diff1 = computeDiff(v0, v1);
    const entry1: HistoryEntry = { ...diff1, cursorPos: 0, scrollTop: 0 };

    // 编辑 v1 → v2
    const diff2 = computeDiff(v1, v2);
    const entry2: HistoryEntry = { ...diff2, cursorPos: 0, scrollTop: 0 };

    // 当前在 v2，撤销到 v1
    let text = applyDiff(v2, entry2, true);
    expect(text).toBe(v1);

    // 恢复到 v2
    const redoDiff2 = computeDiff(text, v2);
    const redoEntry2: HistoryEntry = { ...redoDiff2, cursorPos: 0, scrollTop: 0 };
    text = applyDiff(text, redoEntry2, false);
    expect(text).toBe(v2);

    // 再撤销回 v1
    text = applyDiff(text, entry2, true);
    expect(text).toBe(v1);

    // 再撤销回 v0
    text = applyDiff(text, entry1, true);
    expect(text).toBe(v0);
  });

  it("差异存储应该比完整快照节省内存", () => {
    const oldText = "# 很长的文档标题\n\n" + "这是一段很长的内容。".repeat(100);
    const newText = oldText.replace("很长的内容", "简短的内容");

    const diff = computeDiff(oldText, newText);

    // 差异存储大小
    const diffSize = diff.deleted.length + diff.inserted.length;
    // 完整快照大小
    const snapshotSize = oldText.length;

    // 差异存储应该远小于完整快照
    expect(diffSize).toBeLessThan(snapshotSize * 0.1); // 差异应小于快照的 10%
  });

  it("恢复后撤销应该正确工作（undoDiff 方向验证）", () => {
    // 模拟完整的撤销→恢复→撤销流程
    const v0 = "原始内容";
    const v1 = "原始内容+新增";

    // 编辑 v0 → v1
    const editDiff = computeDiff(v0, v1);
    const editEntry: HistoryEntry = { ...editDiff, cursorPos: 0, scrollTop: 0 };

    // 撤销 v1 → v0
    const afterUndo = applyDiff(v1, editEntry, true);
    expect(afterUndo).toBe(v0);

    // 计算 redoDiff（从撤销后到撤销前）
    const redoDiff = computeDiff(afterUndo, v1);
    const redoEntry: HistoryEntry = { ...redoDiff, cursorPos: 0, scrollTop: 0 };

    // 恢复 v0 → v1
    const afterRedo = applyDiff(afterUndo, redoEntry, false);
    expect(afterRedo).toBe(v1);

    // 计算 undoDiff（从恢复前到恢复后，这样撤销时反向应用才正确）
    const undoDiff = computeDiff(afterUndo, afterRedo);
    const undoEntry: HistoryEntry = { ...undoDiff, cursorPos: 0, scrollTop: 0 };

    // 撤销恢复后的内容，应该回到恢复前的状态
    const afterRedoUndo = applyDiff(afterRedo, undoEntry, true);
    expect(afterRedoUndo).toBe(afterUndo);
    expect(afterRedoUndo).toBe(v0);
  });
});
