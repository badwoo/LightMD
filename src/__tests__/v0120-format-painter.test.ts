/**
 * v0.12.0 需求2：格式刷测试
 *
 * 覆盖：
 * 1. collectSourceSnapshot：整段包裹符号（含叠加）+ 行首前缀块类型
 * 2. collectPmSnapshot：mark 交集 + heading 级别
 * 3. wrapRangeWithMarks：覆盖式（先剥后包，不叠加）；applyBlockTypeToLine 前缀替换
 * 4. buildPmSnapshotTr：清 6 类 mark + 套用 + setBlockType
 * 5. nextFormatPainterMode 全路径 + formatPainterHintText 文案边界
 * 6. useFormatPainterStore：once 应用后失效 / persistent 递减归零 / exit
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { lightMDSchema as schema } from "../core/schema";
import {
  collectSourceSnapshot,
  collectPmSnapshot,
  wrapRangeWithMarks,
  applyBlockTypeToLine,
  buildPmSnapshotTr,
  applyPmBlockSnapshot,
  nextFormatPainterMode,
  formatPainterHintText,
  FORMAT_PAINTER_MAX_USES,
} from "../utils/formatPainter";
import { useFormatPainterStore } from "../stores/useFormatPainterStore";

describe("v0.12.0 需求2：collectSourceSnapshot", () => {
  it("整段包裹：**abc** → strong；*abc* → em；~~abc~~ → strike；==abc== → mark", () => {
    expect(collectSourceSnapshot("**abc**", 0, 7).marks).toEqual(["strong"]);
    expect(collectSourceSnapshot("*abc*", 0, 5).marks).toEqual(["em"]);
    expect(collectSourceSnapshot("~~abc~~", 0, 7).marks).toEqual(["strike"]);
    expect(collectSourceSnapshot("==abc==", 0, 7).marks).toEqual(["mark"]);
    expect(collectSourceSnapshot("<u>abc</u>", 0, 10).marks).toEqual(["underline"]);
    expect(collectSourceSnapshot("`abc`", 0, 5).marks).toEqual(["code"]);
  });

  it("叠加：***abc*** → strong + em（Word 语义的粗斜体）", () => {
    const snap = collectSourceSnapshot("***abc***", 0, 9);
    expect(snap.marks).toContain("strong");
    expect(snap.marks).toContain("em");
  });

  it("块类型：行首前缀识别（heading/引用/列表/段落）", () => {
    expect(collectSourceSnapshot("## Title", 0, 8).blockType).toBe("heading2");
    expect(collectSourceSnapshot("> quote", 0, 7).blockType).toBe("blockquote");
    expect(collectSourceSnapshot("- a", 0, 3).blockType).toBe("bullet_list");
    expect(collectSourceSnapshot("1. b", 0, 4).blockType).toBe("ordered_list");
    expect(collectSourceSnapshot("plain", 0, 5).blockType).toBe("paragraph");
  });
});

describe("v0.12.0 需求2：collectPmSnapshot", () => {
  function stateOf(marks: string[], level?: number) {
    const markInstances = marks.map((m) => schema.marks[m].create());
    const text = schema.text("abc", markInstances);
    const node = level
      ? schema.node("heading", { level }, [text])
      : schema.node("paragraph", null, [text]);
    return EditorState.create({ doc: schema.node("doc", null, [node]) });
  }

  it("mark 交集：整段都加粗才算加粗", () => {
    const state = stateOf(["strong"]);
    const snap = collectPmSnapshot(state, 1, 4);
    expect(snap.marks).toEqual(["strong"]);
    expect(snap.blockType).toBe("paragraph");
  });

  it("heading 块类型附级别", () => {
    const state = stateOf(["em"], 2);
    const snap = collectPmSnapshot(state, 1, 4);
    expect(snap.marks).toEqual(["em"]);
    expect(snap.blockType).toBe("heading2");
  });

  it("部分加粗（区间混合）→ 交集为空", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("ab", [schema.marks.strong.create()]),
        schema.text("cd"),
      ]),
    ]);
    const state = EditorState.create({ doc });
    expect(collectPmSnapshot(state, 1, 5).marks).toEqual([]);
  });

  // ─── v0.12.0 需求2 返修：列表/序号/引用的块类型采集 ───
  it("点击列表项 → blockType = bullet_list（task_list 归并为 bullet_list）", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const list = schema.node("bullet_list", null, [schema.node("list_item", null, [para])]);
    const state = EditorState.create({ doc: schema.node("doc", null, [list]) });
    // pos: doc(0) > bullet_list(0) > list_item(0) > paragraph → 文本在 pos 3..6
    expect(collectPmSnapshot(state, 3, 6).blockType).toBe("bullet_list");
  });

  it("点击有序列表项 → blockType = ordered_list", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const list = schema.node("ordered_list", null, [schema.node("list_item", null, [para])]);
    const state = EditorState.create({ doc: schema.node("doc", null, [list]) });
    expect(collectPmSnapshot(state, 3, 6).blockType).toBe("ordered_list");
  });

  it("点击引用内段落 → blockType = blockquote", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const quote = schema.node("blockquote", null, [para]);
    const state = EditorState.create({ doc: schema.node("doc", null, [quote]) });
    expect(collectPmSnapshot(state, 2, 5).blockType).toBe("blockquote");
  });
});

describe("v0.12.0 需求2：覆盖式应用（源码侧）", () => {
  it("wrapRangeWithMarks：无符号文本 → 包裹", () => {
    const r = wrapRangeWithMarks("abc", 0, 3, ["strong"])!;
    expect(r.text).toBe("**abc**");
    expect(r.end).toBe(7);
  });

  it("目标已有相反格式（斜体）→ 被覆盖，不叠加", () => {
    // 目标 "*abc*"（斜体），套 strong → 应为 "**abc**"（斜体被剥离）
    const r = wrapRangeWithMarks("*abc*", 0, 5, ["strong"])!;
    expect(r.text).toBe("**abc**");
    expect(r.text).not.toContain("***");
  });

  it("多 mark 逆序包裹：数组首个为最外层", () => {
    const r = wrapRangeWithMarks("abc", 0, 3, ["strong", "em"])!;
    expect(r.text).toBe("***abc***");
  });

  it("无变化 → null（同 mark 重复应用幂等）", () => {
    expect(wrapRangeWithMarks("**abc**", 0, 7, ["strong"])).toBeNull();
  });

  it("applyBlockTypeToLine：采 H2 刷到段落 → 目标变 `## `", () => {
    const r = applyBlockTypeToLine("abc", 0, 3, "heading2")!;
    expect(r.text).toBe("## abc");
  });

  it("applyBlockTypeToLine：已有前缀先剥离再替换（# abc → ## abc）", () => {
    const r = applyBlockTypeToLine("# abc", 0, 5, "heading2")!;
    expect(r.text).toBe("## abc");
    // 转段落 → 清除前缀
    expect(applyBlockTypeToLine("## abc", 0, 6, "paragraph")!.text).toBe("abc");
    // 引用/列表
    expect(applyBlockTypeToLine("abc", 0, 3, "blockquote")!.text).toBe("> abc");
    expect(applyBlockTypeToLine("abc", 0, 3, "bullet_list")!.text).toBe("- abc");
    expect(applyBlockTypeToLine("abc", 0, 3, "ordered_list")!.text).toBe("1. abc");
  });
});

describe("v0.12.0 需求2：buildPmSnapshotTr（PM 侧覆盖式）", () => {
  function makeState(marks: string[], level?: number) {
    const text = schema.text("abc", marks.map((m) => schema.marks[m].create()));
    const node = level
      ? schema.node("heading", { level }, [text])
      : schema.node("paragraph", null, [text]);
    return EditorState.create({ doc: schema.node("doc", null, [node]) });
  }

  it("清空目标 6 类 mark 再套用快照 marks", () => {
    // 目标：em 文本；快照：strong → 结果应为 strong（em 被清）
    const state = makeState(["em"]);
    const tr = buildPmSnapshotTr(state, 1, 4, { marks: ["strong"], blockType: "paragraph" })!;
    const newState = state.apply(tr);
    const node = newState.doc.child(0).child(0);
    expect(node.marks.map((m) => m.type.name)).toEqual(["strong"]);
  });

  it("块级：套用 heading2（setBlockType）", () => {
    const state = makeState([]);
    const tr = buildPmSnapshotTr(state, 1, 4, { marks: [], blockType: "heading2" })!;
    const newState = state.apply(tr);
    expect(newState.doc.child(0).type.name).toBe("heading");
    expect(newState.doc.child(0).attrs.level).toBe(2);
  });

  it("完全无变化 → null", () => {
    const state = makeState(["strong"]);
    const tr = buildPmSnapshotTr(state, 1, 4, { marks: ["strong"], blockType: "paragraph" });
    expect(tr).toBeNull();
  });
});

describe("v0.12.0 需求2 返修：applyPmBlockSnapshot（列表/序号/引用块级管线）", () => {
  /** 最小 view 桩：dispatch 依次应用事务，最终 doc 可从 view.state 断言 */
  function mockView(state: EditorState) {
    const view = { state } as { state: EditorState; dispatch: (t: unknown) => void };
    view.dispatch = (t: unknown) => { view.state = view.state.apply(t as never); };
    return view;
  }

  it("段落 → 无序列表（wrapInList）", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const state = EditorState.create({ doc: schema.node("doc", null, [para]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 1, 4, { marks: [], blockType: "bullet_list" })).toBe(true);
    expect(view.state.doc.child(0).type.name).toBe("bullet_list");
    expect(view.state.doc.child(0).child(0).child(0).textContent).toBe("abc");
  });

  it("段落 → 引用（wrapIn blockquote）", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const state = EditorState.create({ doc: schema.node("doc", null, [para]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 1, 4, { marks: [], blockType: "blockquote" })).toBe(true);
    expect(view.state.doc.child(0).type.name).toBe("blockquote");
  });

  it("无序列表 → 段落（liftListItem 脱离列表）", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const list = schema.node("bullet_list", null, [schema.node("list_item", null, [para])]);
    const state = EditorState.create({ doc: schema.node("doc", null, [list]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 3, 6, { marks: [], blockType: "paragraph" })).toBe(true);
    expect(view.state.doc.child(0).type.name).toBe("paragraph");
  });

  it("无序列表 → 有序列表（先脱离再包裹）", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const list = schema.node("bullet_list", null, [schema.node("list_item", null, [para])]);
    const state = EditorState.create({ doc: schema.node("doc", null, [list]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 3, 6, { marks: [], blockType: "ordered_list" })).toBe(true);
    expect(view.state.doc.child(0).type.name).toBe("ordered_list");
  });

  it("标题 → 有序列表（先转段落再包裹）", () => {
    const text = schema.text("abc");
    const heading = schema.node("heading", { level: 2 }, [text]);
    const state = EditorState.create({ doc: schema.node("doc", null, [heading]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 1, 4, { marks: [], blockType: "ordered_list" })).toBe(true);
    expect(view.state.doc.child(0).type.name).toBe("ordered_list");
  });

  it("目标块型已一致 → 无操作返回 false", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const state = EditorState.create({ doc: schema.node("doc", null, [para]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 1, 4, { marks: [], blockType: "paragraph" })).toBe(false);
  });

  it("blockType 为 null（采集异常）→ 不动块级", () => {
    const para = schema.node("paragraph", null, [schema.text("abc")]);
    const state = EditorState.create({ doc: schema.node("doc", null, [para]) });
    const view = mockView(state);
    expect(applyPmBlockSnapshot(view as never, 1, 4, { marks: ["strong"], blockType: null })).toBe(false);
  });
});

describe("v0.12.0 需求2：状态机与文案", () => {
  it("nextFormatPainterMode 全路径", () => {
    expect(nextFormatPainterMode("arm-once", "idle")).toBe("once");
    expect(nextFormatPainterMode("arm-once", "persistent")).toBe("once");
    expect(nextFormatPainterMode("arm-persistent", "idle")).toBe("persistent");
    expect(nextFormatPainterMode("apply", "once")).toBe("idle");
    expect(nextFormatPainterMode("apply", "persistent")).toBe("persistent");
    expect(nextFormatPainterMode("exit", "once")).toBe("idle");
    expect(nextFormatPainterMode("exit", "persistent")).toBe("idle");
  });

  it("formatPainterHintText：idle → null；once/persistent 文案", () => {
    expect(formatPainterHintText("idle", 0)).toBeNull();
    expect(formatPainterHintText("once", 0)).toContain("单击");
    const persistent = formatPainterHintText("persistent", 3)!;
    expect(persistent).toContain("3");
    expect(persistent).toContain("Esc");
  });
});

describe("v0.12.0 需求2：useFormatPainterStore", () => {
  beforeEach(() => {
    useFormatPainterStore.getState().exit();
  });

  it("once：arm 后可应用一次 → consume 后自动失效", () => {
    const store = useFormatPainterStore.getState();
    store.armOnce({ marks: ["strong"], blockType: "paragraph" });
    expect(useFormatPainterStore.getState().mode).toBe("once");
    expect(useFormatPainterStore.getState().snapshot).not.toBeNull();
    useFormatPainterStore.getState().consume();
    expect(useFormatPainterStore.getState().mode).toBe("idle");
    expect(useFormatPainterStore.getState().snapshot).toBeNull();
  });

  it("persistent：连续应用递减，归零自动退出（防无限模式误用）", () => {
    useFormatPainterStore.getState().armPersistent({ marks: [], blockType: "heading1" });
    expect(useFormatPainterStore.getState().remaining).toBe(FORMAT_PAINTER_MAX_USES);
    for (let i = 0; i < FORMAT_PAINTER_MAX_USES; i++) {
      useFormatPainterStore.getState().consume();
    }
    expect(useFormatPainterStore.getState().mode).toBe("idle");
    expect(useFormatPainterStore.getState().snapshot).toBeNull();
  });

  it("persistent 中途 exit（Esc）→ 立即退出", () => {
    useFormatPainterStore.getState().armPersistent({ marks: [], blockType: "heading1" });
    useFormatPainterStore.getState().consume();
    expect(useFormatPainterStore.getState().mode).toBe("persistent");
    useFormatPainterStore.getState().exit();
    expect(useFormatPainterStore.getState().mode).toBe("idle");
  });
});

/**
 * v0.12.0 返修（问题5）：双击格式刷的最大连续应用次数由 5 调整为 10。
 * （锁定常量值，避免后续误改；持久模式语义仍是"归零自动退出"。）
 */
describe("v0.12.0 返修（问题5）：持久模式最大应用次数 = 10", () => {
  beforeEach(() => {
    useFormatPainterStore.getState().exit();
  });

  it("常量值为 10", () => {
    expect(FORMAT_PAINTER_MAX_USES).toBe(10);
  });

  it("armPersistent 初始化 remaining = 10；第 9 次后仍在 persistent，第 10 次归零退出", () => {
    useFormatPainterStore.getState().armPersistent({ marks: ["strong"], blockType: "paragraph" });
    expect(useFormatPainterStore.getState().remaining).toBe(10);
    for (let i = 1; i <= 9; i++) useFormatPainterStore.getState().consume();
    expect(useFormatPainterStore.getState().mode).toBe("persistent");
    expect(useFormatPainterStore.getState().remaining).toBe(1);
    useFormatPainterStore.getState().consume();
    expect(useFormatPainterStore.getState().mode).toBe("idle");
    expect(useFormatPainterStore.getState().snapshot).toBeNull();
  });
});