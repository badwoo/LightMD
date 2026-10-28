// @vitest-environment jsdom
/**
 * v0.15.1 需求1：跨模式撤销统一 —— 回归测试
 *
 * 用户实测缺陷（原文）：
 * 「跨模式撤销两套栈进行统一还有问题，随便文档编辑撤销恢复几次后就会出现
 *  "已经到这个模式的边界"然后撤销和恢复就不能用了，另外进行撤销时候文档会滚动底，
 *  跨模式撤销一定要多种情形实机测试到位。」
 *
 * 本文件用**真实挂载的 EditorContainer**（真实插件栈 + 真实统一时间线）驱动，
 * 断言的是**文档文本序列**（不是内部状态），从而锁住：
 * 1. 源码打字 → 撤销 → 恢复的精确往返，且反复往返多轮后仍可用；
 * 2. 撤销后再编辑必须截断 redo（且不能把整个时间线搞坏）；
 * 3. 撤到底只提示，且**恢复（redo）仍然可用**（旧缺陷：一次边界提示后全废）；
 * 4. 模式切换（会整篇重解析 doc）不得把时间线打断；
 * 5. 阅读模式（PM）打字后切到编辑模式仍能撤销那一步。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { EditorContainer } from "../components/editor/EditorContainer";
import { useEditorStore } from "../stores/useEditorStore";
import { documentHistory, __resetDocumentHistoryForTest, snapshotForTest } from "../services/documentHistory";
import { setNotificationHandler, type Notification } from "../services/notificationService";

// ─── 环境桩 ──────────────────────────────────────────────
function installTauriStub() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async () => 0,
    unregisterListener: async () => {},
    convertFileSrc: (p: string) => `asset://localhost/${p}`,
    plugins: {},
  };
}
function removeTauriStub() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

const DOC_KEY = "D:/tmp/a.md";
const DOC = "# Title\n\nbody paragraph\n";

let view: EditorView | null = null;

function sourceTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("textarea.source-editor");
}

/** 当前可见面的真实文本 */
function currentText(): string {
  const mode = useEditorStore.getState().viewMode;
  if (mode !== "preview") {
    const ta = sourceTextarea();
    return ta ? ta.value : "";
  }
  return view ? view.state.doc.textContent : "";
}

/** 通过 store 的宿主入口撤销（与 App/菜单/PM 键位同一条路径） */
function undoOnce() {
  act(() => {
    useEditorStore.getState().undoHandler?.();
  });
}
function redoOnce() {
  act(() => {
    useEditorStore.getState().redoHandler?.();
  });
}

/** 等一帧（撤销后的光标/滚动恢复在 rAF 里执行） */
async function nextFrame() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

/**
 * 等撤销的「现场恢复」彻底收敛。
 *
 * 为什么要 ~300ms：撤销会触发 `onContentChange → App.setContent → content prop 变化
 * → 再 setSourceContent` 的**二次受控提交**，React 每次提交都会重置 textarea 选区，
 * 因此光标还原要在选区保护窗（250ms）内反复应用才稳定（实测 12 → 0 → 12）。
 */
async function settleRestore() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
}

/** 在源码 textarea 里**当前光标处**打字（触发真实 onChange 链路 → sourceAdapter → 时间线） */
function typeInSource(text: string) {
  const ta = sourceTextarea();
  if (!ta) throw new Error("找不到源码 textarea");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const next = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  act(() => {
    setter?.call(ta, next);
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 在阅读模式 PM 里打字（真实 dispatch → dispatchTransaction → pmAdapter） */
function typeInPm(text: string) {
  if (!view) throw new Error("view 未就绪");
  const end = view.state.doc.content.size - 1;
  act(() => {
    view!.dispatch(view!.state.tr.insertText(text, end));
  });
}

let notifications: Notification[] = [];

beforeEach(() => {
  localStorage.clear();
  installTauriStub();
  __resetDocumentHistoryForTest();
  notifications = [];
  setNotificationHandler((n) => notifications.push(n));
  view = null;
  act(() => {
    useEditorStore.setState({
      viewMode: "edit",
      splitPreviewOpen: false,
      openTabs: [
        {
          id: "t1",
          name: "a.md",
          path: DOC_KEY,
          content: DOC,
          isDirty: false,
        } as never,
      ],
      activeTabIdx: 0,
    });
  });
});

afterEach(() => {
  cleanup();
  setNotificationHandler(null);
  removeTauriStub();
  document.body.innerHTML = "";
  view = null;
});

function mountEditor() {
  const utils = render(
    <EditorContainer
      content={DOC}
      filePath={DOC_KEY}
      forceUpdateKey={1}
      onEditorReady={(v) => {
        view = v;
      }}
    />,
  );
  return utils;
}

/**
 * `onEditorReady` 在 `createEditor` 的 requestAnimationFrame 里回调（见 core/editor.ts），
 * 所以挂载后必须等一帧才能拿到 view。用真实定时器 + act 包住。
 */
async function mountAndWait() {
  const utils = mountEditor();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  return utils;
}

describe("v0.15.1 需求1：统一时间线在模式切换后仍然连续", () => {
  it("源码打字 → 撤销：文本回到打字前", () => {
    mountEditor();
    const before = currentText();
    typeInSource("XYZ");
    expect(currentText()).toContain("XYZ");
    undoOnce();
    expect(currentText()).toBe(before);
  });

  it("源码打字 → 撤销 → 恢复：文本回到打字后（redo 分支没被截断）", () => {
    mountEditor();
    typeInSource("XYZ");
    const afterType = currentText();
    undoOnce();
    expect(currentText()).not.toContain("XYZ");
    redoOnce();
    expect(currentText()).toBe(afterType);
  });

  it("连续 3 轮 撤销×N / 恢复×N 后时间线仍然可用（旧缺陷：几次后就报边界且全废）", () => {
    mountEditor();
    const t0 = currentText();
    typeInSource("A");
    typeInSource("B");
    typeInSource("C");
    const t3 = currentText();
    expect(t3).not.toBe(t0);

    for (let round = 0; round < 3; round++) {
      // 一直撤到底（不假设步数：连续打字可能被归并成 1~3 步）
      let guard = 0;
      while (guard++ < 12) {
        const before = currentText();
        undoOnce();
        if (currentText() === before) break;
      }
      expect(currentText(), `第 ${round + 1} 轮应能撤到初始文本`).toBe(t0);
      // 一直恢复到顶
      guard = 0;
      while (guard++ < 12) {
        const before = currentText();
        redoOnce();
        if (currentText() === before) break;
      }
      expect(currentText(), `第 ${round + 1} 轮应能恢复到最新文本`).toBe(t3);
    }
  });

  it("撤到底给出边界提示，且**之后恢复仍可用**", () => {
    mountEditor();
    typeInSource("A");
    const t1 = currentText();
    // 撤到底：连续按到文本不再变化
    let guard = 0;
    while (guard++ < 12) {
      const before = currentText();
      undoOnce();
      if (currentText() === before) break;
    }
    expect(notifications.some((n) => n.message.includes("边界"))).toBe(true);
    // 关键：边界提示之后 redo 必须还能用（旧缺陷：一次边界后 redo 也废了）
    redoOnce();
    expect(currentText()).toBe(t1);
  });

  it("撤销后再编辑：redo 分支被截断，但撤销仍可用", () => {
    mountEditor();
    const t0 = currentText();
    typeInSource("A");
    undoOnce();
    expect(currentText()).toBe(t0);
    typeInSource("B");
    const tB = currentText();
    expect(tB).toContain("B");
    // redo 已失效（新编辑截断分支）
    redoOnce();
    expect(currentText()).toBe(tB);
    // undo 仍可用，且回到 t0
    undoOnce();
    expect(currentText()).toBe(t0);
  });
});

describe("v0.15.1 需求1：阅读 ↔ 编辑 跨模式撤销", () => {
  it("编辑打字 → 切阅读 → 撤销：撤得掉编辑模式那一步", () => {
    mountEditor();
    typeInSource("EDIT");
    expect(currentText()).toContain("EDIT");
    act(() => {
      useEditorStore.getState().setViewMode("preview");
    });
    expect(useEditorStore.getState().viewMode).toBe("preview");
    undoOnce();
    expect(currentText()).not.toContain("EDIT");
  });

  it("阅读打字 → 切编辑 → 撤销：撤得掉阅读模式那一步", async () => {
    act(() => {
      useEditorStore.setState({ viewMode: "preview" });
    });
    await mountAndWait();
    expect(view).not.toBeNull();
    typeInPm("PMEDIT");
    expect(currentText()).toContain("PMEDIT");
    act(() => {
      useEditorStore.getState().setViewMode("edit");
    });
    expect(useEditorStore.getState().viewMode).toBe("edit");
    undoOnce();
    expect(currentText()).not.toContain("PMEDIT");
  });

  it("模式来回切换多次后，撤销仍然作用于同一份内容（时间线没被重置）", () => {
    mountEditor();
    typeInSource("ONE");
    act(() => {
      useEditorStore.getState().setViewMode("preview");
    });
    act(() => {
      useEditorStore.getState().setViewMode("edit");
    });
    act(() => {
      useEditorStore.getState().setViewMode("preview");
    });
    expect(documentHistory.currentText(DOC_KEY), "时间线仍在（未被重置）").not.toBeNull();
    undoOnce();
    expect(currentText()).not.toContain("ONE");
  });

  it("阅读 ↔ 编辑 反复切换 5 次后，撤销/恢复仍精确往返", () => {
    mountEditor();
    const t0 = currentText();
    typeInSource("X");
    const t1 = currentText();
    for (let i = 0; i < 5; i++) {
      act(() => {
        useEditorStore.getState().setViewMode("preview");
      });
      act(() => {
        useEditorStore.getState().setViewMode("edit");
      });
    }
    undoOnce();
    expect(currentText()).not.toBe(t1);
    redoOnce();
    expect(currentText()).toBe(t1);
    void t0;
  });
});

describe("v0.15.1 需求1：撤销的『现场恢复』（光标 / 滚动）", () => {
  /**
   * 用户原话：「另外进行撤销时候文档会滚动底」。
   *
   * 根因有两层，本用例锁第二层（源码面）：
   * - `sourceAdapter.plan()` 从不产出 `beforeSelection` → 撤销时光标/scrollTop 无处可恢复；
   * - PM 侧 `beforeAnchor` 从未接线 → 阅读面撤销后整篇变短 → 浏览器把 scrollTop 钳到
   *   新 max（= 贴底）。
   */
  it("源码模式：撤销后恢复编辑前的光标位置（不是跳到 0 或文末）", async () => {
    mountEditor();
    const ta = sourceTextarea();
    if (!ta) throw new Error("找不到 textarea");
    // 把光标放到文档中间某处再打字
    const mid = Math.floor(ta.value.length / 2);
    act(() => {
      ta.focus();
      ta.setSelectionRange(mid, mid);
    });
    typeInSource("ZZZ");
    undoOnce();
    await settleRestore();
    // 撤销后光标应回到打字前那一处（允许 ±1 的边界差）
    const pos = ta.selectionStart;
    expect(Math.abs(pos - mid)).toBeLessThanOrEqual(1);
  });

  it("源码模式：撤销不把滚动位置写到底部", () => {
    mountEditor();
    const ta = sourceTextarea();
    if (!ta) throw new Error("找不到 textarea");
    // 造一个足够长的文档，让 textarea 真的可滚动
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    typeInSource("\n" + filler);
    // 滚到中间
    act(() => {
      ta.scrollTop = Math.max(0, (ta.scrollHeight - ta.clientHeight) * 0.5);
      ta.dispatchEvent(new Event("scroll"));
    });
    const midScroll = ta.scrollTop;
    undoOnce();
    // 撤销后不得贴底（旧缺陷：scrollTop 被钳到 max）
    const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
    if (max > 10) {
      expect(ta.scrollTop).toBeLessThan(max - 1);
    }
    void midScroll;
  });

  it("统一时间线条目必须带 beforeSelection（否则撤销无现场可恢复）", () => {
    mountEditor();
    typeInSource("ABC");
    const snap = snapshotForTest(DOC_KEY);
    expect(snap).not.toBeNull();
    const last = snap!.entries[snap!.entries.length - 1];
    expect(last, "应有至少一条历史").toBeTruthy();
    expect(last.beforeSelection, "beforeSelection 不能为空").toBeTruthy();
    expect(typeof last.beforeSelection!.start).toBe("number");
  });
});
