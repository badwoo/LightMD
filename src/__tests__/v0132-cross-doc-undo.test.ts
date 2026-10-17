// @vitest-environment jsdom
/**
 * v0.13.2 需求5：跨文档**顺序**撤销 / 恢复（Word 语义）。
 *
 * ## 用户原话
 * 「在 a 文档编辑了 3 处，然后到 b 文档编辑了 2 处，现在我在 b 文档进行撤销，
 *  撤销了 b 文档编辑的 2 处，再进行撤销那么就自动跳到 a 文档进行 a 文档的撤销。
 *  逻辑和 word 文档的应该是一致的，顺序撤销和恢复。」
 *
 * ## 本文件覆盖三层
 * 1. **纯账本**（`services/docUndoOrder`）：编辑顺序、撤销/恢复目标、账本搬移、
 *    待执行请求、路由三种返回值与 `switchTo` 收到的 key；
 * 2. **快照仓库**（`services/docHistoryStore`）：save/load 往返、content 不匹配丢弃、
 *    LRU 淘汰、撤销/恢复深度；
 * 3. **真实 ProseMirror 往返**（`core/editor` + 真实 history 插件）：把 A 的
 *    history state 存进仓库 → 切到 B → 切回 A 并装回 → 连续撤销 3 次回到初始内容。
 *
 * ## 关键坑位（与实现注释同源）
 * history 里的 step 是相对「保存时那份 doc」的，因此快照的 content 必须是**离开时**的
 * `docToMarkdown(view.state.doc)`；装回到内容不一致的 doc 上会抛
 * `RangeError: Position N out of range`。本文件因此既测「内容严格配对时能装回」，
 * 也测「内容不匹配时 `loadDocHistory` 安全丢弃快照」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeHistory, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  __ledgerSnapshot,
  __resetDocUndoOrderForTest,
  consumePendingRequest,
  forgetDoc,
  getActiveDocKey,
  hasPendingRequest,
  noteEdit,
  noteRedone,
  noteUndone,
  registerUndoBridge,
  routeUndo,
  setPendingRequest,
  takeRedoTarget,
  takeUndoTarget,
  type UndoBridge,
} from "../services/docUndoOrder";
import {
  __docHistorySize,
  __resetDocHistoryForTest,
  docHistoryRedoDepth,
  docHistoryUndoDepth,
  forgetDocHistory,
  loadDocHistory,
  pmRedoDepth,
  pmUndoDepth,
  saveDocHistory,
} from "../services/docHistoryStore";
import {
  createEditor,
  getPmHistoryState,
  pmHistoryDepth,
  withPmHistoryState,
} from "../core/editor";
import { docToMarkdown } from "../core/markdown/serializer";
import { markdownToDoc } from "../core/markdown/parser";

// ─────────────────────────── 辅助 ───────────────────────────

/** 挂载真实编辑器（真实插件流水线，含 history） */
function mount(content: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createEditor({ parent: host, initialContent: content })!;
  return { view, host };
}

/**
 * 在文档末尾插入文本，制造一条**独立**的编辑历史。
 *
 * `closeHistory` 把上一次 history 分组切断：连续两次 insertText 在默认 500ms
 * 窗口内会被 prosemirror-history 合并成**一个**事件，那样「3 次编辑」的深度
 * 就只有 1，无法验证顺序撤销。测试里显式断开分组，等价于用户"停顿后再输入"。
 */
function typeAtEnd(view: EditorView, text: string): void {
  const end = view.state.doc.content.size - 1;
  const tr = view.state.tr.insertText(text, end);
  closeHistory(tr);
  view.dispatch(tr);
}

/** 模拟 EditorContainer 的换文档：整篇替换 + fileSwitch/resetHistory（+ 可选装回历史） */
function fileSwitch(view: EditorView, content: string, restoreHistory?: unknown): void {
  const newDoc = markdownToDoc(content);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
  tr.setSelection(TextSelection.atStart(tr.doc));
  tr.setMeta("fileSwitch", true);
  tr.setMeta("addToHistory", false);
  tr.setMeta("resetHistory", true);
  if (restoreHistory !== undefined) tr.setMeta("restoreHistory", restoreHistory);
  view.dispatch(tr);
}

/** 装一个可控的路由桥；返回可断言的 switchTo spy */
function installBridge(
  active: string | null,
  depths: Record<string, { undo?: number; redo?: number }> = {},
  switchOk: (key: string) => boolean = () => true,
) {
  const switchTo = vi.fn(switchOk);
  const bridge: UndoBridge = {
    activeKey: () => active,
    depthOf: (key, kind) => depths[key]?.[kind] ?? 0,
    switchTo,
  };
  registerUndoBridge(bridge);
  return { bridge, switchTo };
}

beforeEach(() => {
  __resetDocUndoOrderForTest();
  __resetDocHistoryForTest();
});

afterEach(() => {
  document.body.innerHTML = "";
  __resetDocUndoOrderForTest();
  __resetDocHistoryForTest();
});

// ═══════════════════════ (a) 纯账本 ═══════════════════════

describe("需求5(a)：编辑顺序账本（docUndoOrder）", () => {
  it("noteEdit 按编辑先后排序；重复编辑同一文档会把它提到末尾", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    expect(__ledgerSnapshot().undo).toEqual(["a.md", "b.md"]);

    noteEdit("a.md");
    expect(__ledgerSnapshot().undo).toEqual(["b.md", "a.md"]);
  });

  it("takeUndoTarget 取**最近编辑**且仍可撤销的文档", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    expect(takeUndoTarget(() => true)).toBe("b.md");
    // 目标之后的文档（已撤不动）被就地剔除，只保留到目标为止
    expect(__ledgerSnapshot().undo).toEqual(["a.md", "b.md"]);
  });

  it("takeUndoTarget 跳过已撤空的文档（避免 Ctrl+Z 毫无反应）", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    // b 撤不动、a 还能撤 → 目标 a，且 b 被剔除
    expect(takeUndoTarget((key) => key === "a.md")).toBe("a.md");
    expect(__ledgerSnapshot().undo).toEqual(["a.md"]);
  });

  it("全部文档都撤不动时 takeUndoTarget 返回 null 并清空账本", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    expect(takeUndoTarget(() => false)).toBeNull();
    expect(__ledgerSnapshot().undo).toEqual([]);
  });

  it("takeRedoTarget 从恢复账本取最近被撤销的文档", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    noteUndone("b.md");
    noteUndone("a.md");
    expect(__ledgerSnapshot().redo).toEqual(["b.md", "a.md"]);
    expect(takeRedoTarget(() => true)).toBe("a.md");
    expect(takeRedoTarget(() => false)).toBeNull();
  });

  it("noteEdit 只把**当前文档**从恢复账本移除，其他文档的 redo 不受影响", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    noteUndone("b.md"); // 新契约：b 保留在 undo 末尾，同时进入 redo
    noteUndone("a.md"); // undo: [b, a]；redo: [b, a]
    expect(__ledgerSnapshot().redo).toEqual(["b.md", "a.md"]);

    // 在 b 里继续编辑：只作废 b 的 redo，a 的 redo 必须保留（每文档独立栈）
    noteEdit("b.md");
    expect(__ledgerSnapshot().redo).toEqual(["a.md"]);
    // 撤销账本里 b 被提到末尾（最近编辑），a 仍在
    expect(__ledgerSnapshot().undo).toEqual(["a.md", "b.md"]);
  });

  it("noteUndone / noteRedone：**保留 + 置末尾 + 双账本并存**，不把文档搬走", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    expect(__ledgerSnapshot()).toEqual({ undo: ["a.md", "b.md"], redo: [] });

    // 一次撤销后：b 仍在撤销账本末尾（它可能还有剩余步数），同时进入恢复账本。
    // 旧实现把 b 从 undo 删掉 → 第 2 次撤销就跳到 a，正是用户报的错误顺序。
    noteUndone("b.md");
    expect(__ledgerSnapshot()).toEqual({ undo: ["a.md", "b.md"], redo: ["b.md"] });
    expect(__ledgerSnapshot().undo[__ledgerSnapshot().undo.length - 1]).toBe("b.md");

    noteUndone("a.md");
    expect(__ledgerSnapshot()).toEqual({ undo: ["b.md", "a.md"], redo: ["b.md", "a.md"] });

    // noteRedone 对称：b 保留在 redo 末尾，同时回到 undo 末尾
    noteRedone("b.md");
    expect(__ledgerSnapshot()).toEqual({ undo: ["a.md", "b.md"], redo: ["a.md", "b.md"] });
    expect(__ledgerSnapshot().redo[__ledgerSnapshot().redo.length - 1]).toBe("b.md");
  });

  it("forgetDoc 清掉该文档在两侧账本与待执行请求里的全部账目", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    noteUndone("a.md");
    setPendingRequest({ key: "a.md", kind: "undo" });
    expect(hasPendingRequest()).toBe(true);

    forgetDoc("a.md");
    expect(__ledgerSnapshot()).toEqual({ undo: ["b.md"], redo: [] });
    expect(hasPendingRequest()).toBe(false);
  });

  it("pendingRequest 一次性消费：取出后即清空", () => {
    expect(hasPendingRequest()).toBe(false);
    expect(consumePendingRequest()).toBeNull();

    setPendingRequest({ key: "a.md", kind: "redo" });
    expect(hasPendingRequest()).toBe(true);
    expect(consumePendingRequest()).toEqual({ key: "a.md", kind: "redo" });
    expect(hasPendingRequest()).toBe(false);
    expect(consumePendingRequest()).toBeNull();
  });

  it("getActiveDocKey：未注册桥时为 null，注册后透传 bridge.activeKey", () => {
    expect(getActiveDocKey()).toBeNull();
    installBridge("b.md");
    expect(getActiveDocKey()).toBe("b.md");
    registerUndoBridge(null);
    expect(getActiveDocKey()).toBeNull();
  });
});

describe("需求5(a)：routeUndo 三种路由结果", () => {
  it("没有路由桥时退回 local（行为与旧版一致）", () => {
    expect(routeUndo("undo")).toBe("local");
    expect(routeUndo("redo")).toBe("local");
    expect(hasPendingRequest()).toBe(false);
  });

  it("目标就是当前文档且还有深度 → local，不切标签", () => {
    noteEdit("b.md");
    const { switchTo } = installBridge("b.md", { "b.md": { undo: 2 } });

    expect(routeUndo("undo")).toBe("local");
    expect(switchTo).not.toHaveBeenCalled();
    expect(hasPendingRequest()).toBe(false);
  });

  it("当前文档撤空、别的文档还能撤 → switched，switchTo 收到正确的 key 并登记 pending", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    // b 已撤空（账本里它还在，但 depthOf 为 0）；a 还有 2 步
    const { switchTo } = installBridge("b.md", { "a.md": { undo: 2 }, "b.md": { undo: 0 } });

    expect(routeUndo("undo")).toBe("switched");
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("a.md");
    expect(consumePendingRequest()).toEqual({ key: "a.md", kind: "undo" });
  });

  it("恢复（redo）同样跨文档：目标文档是最近被撤销过的那个", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    noteUndone("b.md");
    // 当前在 a；a 没有可恢复的，b 有
    const { switchTo } = installBridge("a.md", { "a.md": { redo: 0 }, "b.md": { redo: 1 } });

    expect(routeUndo("redo")).toBe("switched");
    expect(switchTo).toHaveBeenCalledWith("b.md");
    expect(consumePendingRequest()).toEqual({ key: "b.md", kind: "redo" });
  });

  it("没有可撤销的目标 → none", () => {
    installBridge("b.md", {});
    expect(routeUndo("undo")).toBe("none");
    expect(hasPendingRequest()).toBe(false);
  });

  it("switchTo 失败时剔除目标并重试一次；重试也失败则 none", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    const { switchTo } = installBridge(
      "b.md",
      { "a.md": { undo: 1 }, "b.md": { undo: 0 } },
      () => false,
    );

    expect(routeUndo("undo")).toBe("none");
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(hasPendingRequest()).toBe(false);
    // 已失效的目标文档被摘掉，不会在下次撤销时再次被选中
    expect(__ledgerSnapshot().undo).not.toContain("a.md");
  });

  it("switchTo 第一次失败、第二个可撤销文档成功 → switched 到后者", () => {
    // 账本顺序：[c, a, b]；b 当前且撤空，a 已失效（switch 失败），c 仍可撤
    noteEdit("c.md");
    noteEdit("a.md");
    noteEdit("b.md");
    const { switchTo } = installBridge(
      "b.md",
      { "a.md": { undo: 1 }, "c.md": { undo: 3 }, "b.md": { undo: 0 } },
      (key) => key === "c.md",
    );

    expect(routeUndo("undo")).toBe("switched");
    expect(switchTo.mock.calls.map((c) => c[0])).toEqual(["a.md", "c.md"]);
    expect(consumePendingRequest()).toEqual({ key: "c.md", kind: "undo" });
  });
});

// ═══════════ 需求5 核心：顺序语义（B2 → B1 → A3 → A2 → A1）═══════════

describe("需求5：跨文档**顺序**撤销 / 恢复（Word 语义）", () => {
  interface DepthMap {
    [key: string]: { undo: number; redo: number };
  }

  /** 可变的真实深度账本 + 会切换 activeKey 的桥（模拟 EditorContainer/App） */
  function installDynamicBridge(initialActive: string, depths: DepthMap) {
    let active = initialActive;
    const switchTo = vi.fn((key: string) => {
      active = key;
      return true;
    });
    registerUndoBridge({
      activeKey: () => active,
      depthOf: (key, kind) => depths[key]?.[kind] ?? 0,
      switchTo,
    });
    return { switchTo, active: () => active };
  }

  /**
   * 模拟**完整**的撤销管线（与 EditorContainer 一致）：
   * - `local`      → 当前文档本地撤销一步，并 `noteUndone` 记账；
   * - `switched`   → App 切标签，换文档 effect 消费 pending 后在目标文档本地撤销一步；
   * - `none`       → 到底，停止。
   */
  function runUndoPipeline(depths: DepthMap): { kinds: string[]; targets: string[] } {
    const kinds: string[] = [];
    const targets: string[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const routed = routeUndo("undo");
      kinds.push(routed);
      if (routed === "none") break;
      const key =
        routed === "local"
          ? getActiveDocKey()
          : consumePendingRequest()?.key ?? null;
      expect(key, "路由结果必须能确定目标文档").not.toBeNull();
      depths[key!].undo = Math.max(0, depths[key!].undo - 1);
      noteUndone(key!);
      targets.push(key!);
    }
    return { kinds, targets };
  }

  /** 模拟完整的恢复管线（与 runUndoPipeline 对称） */
  function runRedoPipeline(depths: DepthMap): { kinds: string[]; targets: string[] } {
    const kinds: string[] = [];
    const targets: string[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const routed = routeUndo("redo");
      kinds.push(routed);
      if (routed === "none") break;
      const key =
        routed === "local"
          ? getActiveDocKey()
          : consumePendingRequest()?.key ?? null;
      expect(key, "路由结果必须能确定目标文档").not.toBeNull();
      depths[key!].redo = Math.max(0, depths[key!].redo - 1);
      noteRedone(key!);
      targets.push(key!);
    }
    return { kinds, targets };
  }

  it("a 编辑 3 处、b 编辑 2 处：完整管线依次撤销 b2→b1→a3→a2→a1，只在第 3 次切到 a", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    const depths: DepthMap = {
      "a.md": { undo: 3, redo: 0 },
      "b.md": { undo: 2, redo: 0 },
    };
    const { switchTo } = installDynamicBridge("b.md", depths);

    const { kinds, targets } = runUndoPipeline(depths);

    // 第 3 次路由才是 switched；切到 a 后由 pending 请求执行 a 的第 1 次撤销，
    // 因此后续两次是 local，第 6 次到底。
    expect(kinds).toEqual(["local", "local", "switched", "local", "local", "none"]);
    expect(targets).toEqual(["b.md", "b.md", "a.md", "a.md", "a.md"]);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("a.md");
  });

  it("路由层：pending 尚未执行时，b 撤空后先切 a，再由 a 自己完成剩余 3 步（不重复切换）", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    const depths: DepthMap = {
      "a.md": { undo: 3, redo: 0 },
      "b.md": { undo: 2, redo: 0 },
    };
    const { switchTo } = installDynamicBridge("b.md", depths);

    // 注意：本用例只驱动 routeUndo + switchTo，**不**执行 pending 的本地撤销
    // （模拟 flushPendingUndoRequest 的 rAF 延迟窗口）。这是路由层的顺序契约：
    // pending 一旦执行完，下一轮就是上面那条"完整管线"的 5 步模型。
    const results: string[] = [];
    results.push(routeUndo("undo"));
    depths["b.md"].undo--;
    noteUndone("b.md");
    results.push(routeUndo("undo"));
    depths["b.md"].undo--;
    noteUndone("b.md");

    results.push(routeUndo("undo")); // switched → a
    for (let i = 0; i < 3; i++) {
      results.push(routeUndo("undo")); // a 的 3 步都在原地
      depths["a.md"].undo--;
      noteUndone("a.md");
    }
    results.push(routeUndo("undo")); // 到底

    expect(results).toEqual([
      "local",
      "local",
      "switched",
      "local",
      "local",
      "local",
      "none",
    ]);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("a.md");
    // pending 撤销仍待换文档 effect 消费（这正是"切过去之后再撤"的语义）
    expect(consumePendingRequest()).toEqual({ key: "a.md", kind: "undo" });
  });

  it("旧 bug 回归：同一文档连撤 2 次不得提前切换到别的文档", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    const depths: DepthMap = {
      "a.md": { undo: 3, redo: 0 },
      "b.md": { undo: 2, redo: 0 },
    };
    const { switchTo } = installDynamicBridge("b.md", depths);

    // 第 1 次撤销后 b 还剩 1 步：noteUndone(b) 必须让 b 仍留在撤销账本末尾，
    // 否则第 2 次 routeUndo 会选中 a → 用户按两次 Ctrl+Z 就莫名跳文档。
    expect(routeUndo("undo")).toBe("local");
    depths["b.md"].undo--;
    noteUndone("b.md");

    expect(routeUndo("undo")).toBe("local");
    expect(switchTo).not.toHaveBeenCalled();
    depths["b.md"].undo--;
    noteUndone("b.md");

    // b 真正撤空后才允许切到 a
    expect(routeUndo("undo")).toBe("switched");
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("a.md");
  });

  it("恢复方向：先把当前文档 a 恢复完，再 switched 到 b", () => {
    noteEdit("a.md");
    noteEdit("b.md");
    // 已撤销到边界：a 撤了 3 次、b 撤了 2 次（新契约下注意顺序：b 先、a 后）
    noteUndone("b.md");
    noteUndone("b.md");
    noteUndone("a.md");
    noteUndone("a.md");
    noteUndone("a.md");
    expect(__ledgerSnapshot().redo).toEqual(["b.md", "a.md"]);

    const depths: DepthMap = {
      "a.md": { undo: 0, redo: 3 },
      "b.md": { undo: 0, redo: 2 },
    };
    const { switchTo } = installDynamicBridge("a.md", depths);

    const { kinds, targets } = runRedoPipeline(depths);

    expect(kinds).toEqual(["local", "local", "local", "switched", "local", "none"]);
    expect(targets).toEqual(["a.md", "a.md", "a.md", "b.md", "b.md"]);
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("b.md");
  });

  it("同一文档连撤 2 次后连恢复 2 次，都能在原地完成（noteRedone 对称性）", () => {
    noteEdit("doc.md");
    const depths: DepthMap = { "doc.md": { undo: 2, redo: 0 } };
    const { switchTo } = installDynamicBridge("doc.md", depths);

    for (let i = 0; i < 2; i++) {
      expect(routeUndo("undo")).toBe("local");
      depths["doc.md"].undo--;
      noteUndone("doc.md");
    }

    // 撤销后文档仍在 undo 账本里；恢复 2 次也必须都在原地（旧实现第 1 次
    // noteRedone 就把文档移出 redo 账本 → 第 2 次 Ctrl+Y 变成 none）
    depths["doc.md"].redo = 2;
    for (let i = 0; i < 2; i++) {
      expect(routeUndo("redo")).toBe("local");
      depths["doc.md"].redo--;
      noteRedone("doc.md");
    }
    expect(switchTo).not.toHaveBeenCalled();
  });
});

// ═══════════════════ (b) 快照仓库 ═══════════════════

describe("需求5(b)：每文档历史快照仓库（docHistoryStore）", () => {
  const snap = (content: string, done = 3, undone = 1, srcUndo: unknown[] = [1, 2]) => ({
    content,
    pmHistory: { done: { eventCount: done }, undone: { eventCount: undone } },
    sourceUndo: srcUndo,
    sourceRedo: [3],
  });

  it("save → load 往返：内容一致时原样取回并提升活跃度", () => {
    saveDocHistory("a.md", snap("AAA"));
    expect(__docHistorySize()).toBe(1);

    const loaded = loadDocHistory("a.md", "AAA");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("AAA");
    expect(pmUndoDepth(loaded!.pmHistory)).toBe(3);
    expect(pmRedoDepth(loaded!.pmHistory)).toBe(1);
    expect(loaded!.sourceUndo).toEqual([1, 2]);
    expect(loaded!.sourceRedo).toEqual([3]);
  });

  it("content 与快照不一致时**丢弃**快照并返回 null（位置敏感的防线）", () => {
    saveDocHistory("a.md", snap("AAA"));
    expect(loadDocHistory("a.md", "AAA-edited")).toBeNull();
    // 已丢弃：下次即便传回原 content 也取不到（避免把错位历史装回去）
    expect(loadDocHistory("a.md", "AAA")).toBeNull();
    expect(__docHistorySize()).toBe(0);
  });

  it("LRU 40：第 41 个文档淘汰最久未用的那个", () => {
    for (let i = 0; i < 40; i++) saveDocHistory(`doc-${i}`, snap(`c${i}`));
    expect(__docHistorySize()).toBe(40);

    saveDocHistory("doc-40", snap("c40"));
    expect(__docHistorySize()).toBe(40);
    expect(loadDocHistory("doc-0", "c0")).toBeNull(); // 被淘汰
    expect(loadDocHistory("doc-40", "c40")).not.toBeNull();
  });

  it("LRU：load 命中也提升活跃度，之后淘汰的是次久未用的", () => {
    for (let i = 0; i < 40; i++) saveDocHistory(`doc-${i}`, snap(`c${i}`));
    // 访问 doc-1（此时 doc-1 变为最新；最旧的是 doc-0）
    expect(loadDocHistory("doc-1", "c1")).not.toBeNull();

    saveDocHistory("doc-40", snap("c40")); // 淘汰 doc-0
    saveDocHistory("doc-41", snap("c41")); // 淘汰 doc-2（doc-1 因刚用过而幸免）
    expect(loadDocHistory("doc-1", "c1")).not.toBeNull();
    expect(loadDocHistory("doc-2", "c2")).toBeNull();
  });

  it("撤销/恢复深度 = PM history 深度 + 源码栈长度", () => {
    saveDocHistory("a.md", snap("AAA", 3, 1, [1, 2]));
    expect(docHistoryUndoDepth("a.md")).toBe(5); // done.eventCount 3 + sourceUndo 2
    expect(docHistoryRedoDepth("a.md")).toBe(2); // undone.eventCount 1 + sourceRedo 1
    expect(docHistoryUndoDepth("missing")).toBe(0);
    expect(docHistoryRedoDepth(null)).toBe(0);
  });

  it("pmUndoDepth / pmRedoDepth 对残缺结构做防御性读取（不抛错，按 0 处理）", () => {
    expect(pmUndoDepth(null)).toBe(0);
    expect(pmUndoDepth(undefined)).toBe(0);
    expect(pmUndoDepth({})).toBe(0);
    expect(pmUndoDepth({ done: null })).toBe(0);
    expect(pmUndoDepth({ done: { eventCount: -2 } })).toBe(0);
    expect(pmUndoDepth({ done: { eventCount: 4 } })).toBe(4);
    expect(pmRedoDepth({ undone: { eventCount: 2 } })).toBe(2);
    expect(pmRedoDepth({ undone: { eventCount: "x" } })).toBe(0);
  });

  it("forgetDocHistory 丢弃指定文档的历史", () => {
    saveDocHistory("a.md", snap("AAA"));
    forgetDocHistory("a.md");
    expect(__docHistorySize()).toBe(0);
    expect(loadDocHistory("a.md", "AAA")).toBeNull();
  });
});

// ═══════════════════ (c) 真实 ProseMirror 往返 ═══════════════════

describe("需求5(c)：真实 ProseMirror history 的保存与装回", () => {
  it("A 里编辑 3 处 → 存 history → 切 B → 切回 A 装回 → 连续撤销 3 次回到初始，再恢复 3 次", () => {
    const { view, host } = mount("AAA\n");
    try {
      typeAtEnd(view, "1");
      typeAtEnd(view, "2");
      typeAtEnd(view, "3");
      expect(view.state.doc.textContent).toBe("AAA123");
      expect(pmHistoryDepth(view.state)).toEqual({ undo: 3, redo: 0 });
      expect(undoDepth(view.state)).toBe(3);

      // 离开 A 时保存：content 必须是**离开时**的序列化结果（位置基线）
      const contentA = docToMarkdown(view.state.doc);
      expect(contentA).toBe("AAA123\n");
      const histA = getPmHistoryState(view.state);
      onSaveHistory("A", contentA, histA);
      expect(docHistoryUndoDepth("A")).toBe(3);

      // 切到 B：历史归零（v0.13.1 的数据安全边界不变）
      fileSwitch(view, "BBB\n");
      expect(view.state.doc.textContent).toBe("BBB");
      expect(pmHistoryDepth(view.state)).toEqual({ undo: 0, redo: 0 });

      // 切回 A：内容严格配对 → 快照可用 → 装回
      const loaded = loadDocHistory("A", contentA);
      expect(loaded).not.toBeNull();
      fileSwitch(view, contentA, loaded!.pmHistory);
      expect(view.state.doc.textContent).toBe("AAA123");
      expect(pmHistoryDepth(view.state)).toEqual({ undo: 3, redo: 0 });

      for (let i = 0; i < 3; i++) undo(view.state, view.dispatch);
      expect(view.state.doc.textContent).toBe("AAA");
      expect(pmHistoryDepth(view.state)).toEqual({ undo: 0, redo: 3 });

      for (let i = 0; i < 3; i++) redo(view.state, view.dispatch);
      expect(view.state.doc.textContent).toBe("AAA123");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("A、B 各自 2 次编辑：两份历史互不污染，切回各自文档都能撤到底", () => {
    const { view, host } = mount("AAA\n");
    try {
      typeAtEnd(view, "1");
      typeAtEnd(view, "2");
      const contentA = docToMarkdown(view.state.doc); // "AAA12\n"
      const histA = getPmHistoryState(view.state);
      onSaveHistory("A", contentA, histA);

      fileSwitch(view, "BBB\n");
      typeAtEnd(view, "x");
      typeAtEnd(view, "y");
      expect(view.state.doc.textContent).toBe("BBBxy");
      const contentB = docToMarkdown(view.state.doc); // "BBBxy\n"
      const histB = getPmHistoryState(view.state);
      onSaveHistory("B", contentB, histB);

      // 回 A：装回 A 的历史，撤销只作用于 A
      fileSwitch(view, contentA, loadDocHistory("A", contentA)!.pmHistory);
      expect(view.state.doc.textContent).toBe("AAA12");
      undo(view.state, view.dispatch);
      undo(view.state, view.dispatch);
      expect(view.state.doc.textContent).toBe("AAA");
      expect(view.state.doc.textContent).not.toContain("BBB");

      // 再回 B：B 的历史仍然完好
      fileSwitch(view, contentB, loadDocHistory("B", contentB)!.pmHistory);
      expect(view.state.doc.textContent).toBe("BBBxy");
      undo(view.state, view.dispatch);
      undo(view.state, view.dispatch);
      expect(view.state.doc.textContent).toBe("BBB");
      expect(view.state.doc.textContent).not.toContain("AAA");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("换文档时不带 restoreHistory → 行为与 v0.13.1 一致（历史归零）", () => {
    const { view, host } = mount("AAA\n");
    try {
      typeAtEnd(view, "1");
      expect(undoDepth(view.state)).toBe(1);

      fileSwitch(view, "BBB\n");
      expect(pmHistoryDepth(view.state)).toEqual({ undo: 0, redo: 0 });
      expect(redoDepth(view.state)).toBe(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("withPmHistoryState 只接受结构合法的 HistoryState；null / 残缺对象安全降级", () => {
    const { view, host } = mount("AAA\n");
    try {
      typeAtEnd(view, "1");
      typeAtEnd(view, "2");
      const base = view.state;

      expect(withPmHistoryState(base, null)).toBe(base);
      expect(withPmHistoryState(base, {})).toBe(base);
      // 只有 done、没有 undone → 不是合法的 HistoryState
      expect(withPmHistoryState(base, { done: { eventCount: 2 } })).toBe(base);

      const hist = getPmHistoryState(view.state);
      const restored = withPmHistoryState(base, hist);
      expect(pmHistoryDepth(restored)).toEqual({ undo: 2, redo: 0 });
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("没有 history 插件的 state：getPmHistoryState 返回 null，装回是 no-op", () => {
    const doc = markdownToDoc("AAA\n");
    const bare = EditorState.create({ doc });
    expect(getPmHistoryState(bare)).toBeNull();
    expect(withPmHistoryState(bare, { done: {}, undone: {} })).toBe(bare);
  });

  it("内容不匹配 → 快照被丢弃，不得把位置错位的历史装进别的文档", () => {
    const { view, host } = mount("AAA\n");
    try {
      typeAtEnd(view, "1");
      const contentA = docToMarkdown(view.state.doc); // "AAA1\n"
      onSaveHistory("A", contentA, getPmHistoryState(view.state));

      fileSwitch(view, "BBB\n");
      // 用户切回 A 但这些内容在磁盘上已被外部改动：当前 content 与快照不一致
      const currentContent = "AAA-changed\n";
      expect(loadDocHistory("A", currentContent)).toBeNull();
      expect(docHistoryUndoDepth("A")).toBe(0);
      // 不装回历史 → A 的撤销栈从空开始（宁可丢历史，也不把撤销应用到错误位置）
      fileSwitch(view, currentContent);
      expect(pmHistoryDepth(view.state)).toEqual({ undo: 0, redo: 0 });
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ═══════════════════ 小工具 ═══════════════════

/** 把一份真实的 PM history state 存进快照仓库（回调形式，避免重复构造对象） */
function onSaveHistory(key: string, content: string, pmHistory: unknown): void {
  saveDocHistory(key, {
    content,
    pmHistory,
    sourceUndo: [],
    sourceRedo: [],
  });
}
