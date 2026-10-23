/**
 * v0.14.0 第三批 需求1+2：搜索/替换要立即生效 + 要能撤销/恢复（含跨文件）。
 *
 * ## 用户原话
 * ① 「阅读模式下进行搜索和替换，文本没有立即生效。」
 * ② 「通过搜索替换也要进入到撤销栈中，当前没有生效，而且跨文件搜索和替换，
 *     切换到对应文件后也能使用撤销或恢复。」
 *
 * ## 实机取证（`scripts/v0140-probe-req1-crossfile-preview.mjs`，T1 vs T3 对照）
 * - 条幅**收起**时「全部替换」→ 走 SearchReplace 自己的 PM 分支 → 阅读视图立即变 ✔
 * - 条幅**展开**时「全部替换（所有文件）」→ `replaceAllAcrossFiles` 对**当前文档**
 *   也调 `onSourceContentChange`（源码态通道）→ 只改了隐藏 textarea 与 localStorage，
 *   **ProseMirror 一个字都没动** → 阅读视图毫无反应（需求1），且没有记录撤销步骤（需求2）。
 *
 * ## 本文件锁定的硬约束
 * ① `EditorContainer` 必须有**统一的整篇写回入口** `writeBackCurrentDoc`，
 *    且它按视图模式分流：阅读模式 → PM 事务（`addToHistory: true`）；
 *    源码模式 → textarea 状态 + `recordUndoEntry`。
 * ② `applyFileText`（跨文件替换的写回通道）的**当前文档分支**必须走该入口，
 *    **不得**只 `setSourceContent`（那正是缺陷本身）。
 * ③ `applyFileText` 的**其他标签分支**必须登记跨文件替换记录（供切过去后撤销）。
 * ④ `doLocalUndo` / `doLocalRedo` 必须**先**消费跨文件记录，且带「逐字节一致」护栏
 *    （内容被用户手改过就丢弃记录，绝不整篇覆盖回去）。
 * ⑤ `onSourceContentChange`（源码态通道）必须补撤销记录。
 *
 * 这些都是"接线契约"，最适合源码断言 + 纯函数行为测试双管齐下：
 * 纯函数侧验证 `docHistoryStore` 的跨文件记录语义（合并、护栏、对称），
 * 源码侧验证接线没有被后续重构悄悄删掉。
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  recordCrossFileEdit,
  peekCrossFileUndo,
  peekCrossFileRedo,
  dropCrossFileUndo,
  dropCrossFileRedo,
  pushCrossFileRedo,
  pushCrossFileUndo,
  hasCrossFileUndo,
  hasCrossFileRedo,
  __resetDocHistoryForTest,
} from "../services/docHistoryStore";

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf-8");

const containerSrc = read("components/editor/EditorContainer.tsx");
const searchSrc = read("components/editor/SearchReplace.tsx");

describe("需求1：整篇写回必须按视图模式分流（阅读模式要 dispatch 到 PM）", () => {
  it("存在统一写回入口 writeBackCurrentDoc", () => {
    expect(containerSrc).toContain("const writeBackCurrentDoc = useCallback");
  });

  it("阅读模式分支 dispatch 一条 PM 事务且进撤销栈（addToHistory: true）", () => {
    const body = containerSrc.slice(
      containerSrc.indexOf("const writeBackCurrentDoc = useCallback"),
      containerSrc.indexOf("const undoDocKey") > 0
        ? containerSrc.indexOf("const writeBackCurrentDoc = useCallback") + 3000
        : undefined,
    );
    // 阅读模式判定 + 整篇 replaceWith + 进撤销栈
    expect(body).toContain('viewMode === "preview" && isMdFile');
    expect(body).toContain("replaceWith(0, view.state.doc.content.size, newDoc.content)");
    expect(body).toContain('tr.setMeta("addToHistory", true)');
  });

  it("源码模式分支记录撤销记录（recordUndoEntry）", () => {
    const body = containerSrc.slice(containerSrc.indexOf("const writeBackCurrentDoc = useCallback"));
    const head = body.slice(0, 3000);
    expect(head).toContain("recordUndoEntry(");
  });

  it("applyFileText 的当前文档分支**不得**再直接 setSourceContent（缺陷根因）", () => {
    const body = containerSrc.slice(
      containerSrc.indexOf("const applyFileText = useCallback"),
      containerSrc.indexOf("const applyFileText = useCallback") + 2000,
    );
    expect(body).toContain("writeBackCurrentDoc(newText)");
    // 关键反向断言：当前文档分支里不能再出现「只改 state」的旧写法
    const currentBranch = body.slice(0, body.indexOf("const st = useEditorStore.getState()"));
    expect(currentBranch).not.toContain("setSourceContent(newText)");
  });
});

describe("需求2：跨文件替换的记录与消费", () => {
  it("applyFileText 的其他标签分支登记跨文件替换记录", () => {
    const body = containerSrc.slice(containerSrc.indexOf("const applyFileText = useCallback"));
    const head = body.slice(0, 2500);
    expect(head).toContain("recordCrossFileEdit(fileKey,");
  });

  it("onSourceContentChange 必须走统一写回入口（两个调用方都要正确）", () => {
    // 这个 prop 有两个调用方：① 面板自己在源码模式的替换；② replaceAllAcrossFiles
    // 对**当前文档**的写回（这条在**阅读模式**下也会发生）。
    // 后者正是需求1 的根因：旧实现无条件只写 state → 阅读视图不动、且切模式后被冲掉。
    // 因此它必须走按视图模式分流的 `writeBackCurrentDoc`，而不是自己拼一份写回逻辑。
    const idx = containerSrc.indexOf("onSourceContentChange={(newContent) =>");
    expect(idx).toBeGreaterThan(0);
    const body = containerSrc.slice(idx, idx + 1600);
    expect(body).toContain("writeBackCurrentDoc(newContent)");
    // 反向断言：不能在 prop 里再出现「只改 state」的旧写法
    // （注释里提到 setSourceContent 是允许的，只查代码行）
    const codeLines = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    expect(codeLines.join("\n")).not.toContain("setSourceContent(newContent)");
    // 撤销记录由 writeBackCurrentDoc 的源码模式分支负责，这里不重复实现
    expect(body).not.toContain("recordUndoEntry(");
  });

  it("doLocalUndo 先消费跨文件记录，且校验内容逐字节一致", () => {
    const idx = containerSrc.indexOf("const doLocalUndo = useCallback");
    const body = containerSrc.slice(idx, idx + 3000);
    expect(body).toContain("peekCrossFileUndo(");
    // 护栏：只有当前文本仍等于记录的 after 才应用
    expect(body).toMatch(/ext\.after === getMarkdownFromDoc|ext\.after === sourceContentRef\.current/);
    // 不一致时必须丢弃记录，落到常规撤销栈
    expect(body).toContain("dropCrossFileUndo(");
  });

  it("doLocalRedo 对称消费「恢复」记录", () => {
    const idx = containerSrc.indexOf("const doLocalRedo = useCallback");
    const body = containerSrc.slice(idx, idx + 3000);
    expect(body).toContain("peekCrossFileRedo(");
    expect(body).toMatch(/ext\.before === getMarkdownFromDoc|ext\.before === sourceContentRef\.current/);
  });

  it("撤销用 early-declared 的 undoDocKey（避开 TDZ），不是 later 的 currentDocKey", () => {
    // undoDocKey 声明位置必须早于 doLocalUndo
    const keyDecl = containerSrc.indexOf("const undoDocKey = useCallback");
    const undoDecl = containerSrc.indexOf("const doLocalUndo = useCallback");
    expect(keyDecl).toBeGreaterThan(0);
    expect(keyDecl).toBeLessThan(undoDecl);
  });
});

describe("docHistoryStore：跨文件记录的语义（纯函数）", () => {
  beforeEach(() => __resetDocHistoryForTest());

  it("记录后可查到，key 为空时不记录", () => {
    recordCrossFileEdit("C:/a.md", "cat", "DOG");
    expect(peekCrossFileUndo("C:/a.md")).toEqual({ before: "cat", after: "DOG" });
    expect(hasCrossFileUndo("C:/a.md")).toBe(true);
    recordCrossFileEdit(null, "x", "y");
    recordCrossFileEdit(undefined, "x", "y");
    recordCrossFileEdit("", "x", "y");
    expect(hasCrossFileUndo(null)).toBe(false);
  });

  it("无变化（before === after）不记录", () => {
    recordCrossFileEdit("C:/a.md", "same", "same");
    expect(hasCrossFileUndo("C:/a.md")).toBe(false);
  });

  it("同一文档连续替换 → 合并为「最早的 before + 最新的 after」", () => {
    recordCrossFileEdit("C:/a.md", "v0", "v1");
    recordCrossFileEdit("C:/a.md", "v1", "v2");
    recordCrossFileEdit("C:/a.md", "v2", "v3");
    // 用户心智：一次 Ctrl+Z 撤回"本轮批量替换"，回到 v0
    expect(peekCrossFileUndo("C:/a.md")).toEqual({ before: "v0", after: "v3" });
  });

  it("新的替换使旧的「恢复」记录失效（forward 分支被改写）", () => {
    const edit = { before: "v0", after: "v1" };
    pushCrossFileRedo("C:/a.md", edit);
    expect(hasCrossFileRedo("C:/a.md")).toBe(true);
    recordCrossFileEdit("C:/a.md", "v1", "v2");
    expect(hasCrossFileRedo("C:/a.md")).toBe(false);
  });

  it("撤销 ↔ 恢复可来回搬（对称）", () => {
    const edit = { before: "v0", after: "v1" };
    recordCrossFileEdit("C:/a.md", edit.before, edit.after);
    // 撤销：拿走 undo，登记 redo
    const taken = peekCrossFileUndo("C:/a.md")!;
    dropCrossFileUndo("C:/a.md");
    pushCrossFileRedo("C:/a.md", taken);
    expect(hasCrossFileUndo("C:/a.md")).toBe(false);
    expect(peekCrossFileRedo("C:/a.md")).toEqual({ before: "v0", after: "v1" });
    // 恢复：拿走 redo，登记 undo
    const back = peekCrossFileRedo("C:/a.md")!;
    dropCrossFileRedo("C:/a.md");
    pushCrossFileUndo("C:/a.md", back);
    expect(hasCrossFileRedo("C:/a.md")).toBe(false);
    expect(peekCrossFileUndo("C:/a.md")).toEqual({ before: "v0", after: "v1" });
  });

  it("不同文档互不影响", () => {
    recordCrossFileEdit("C:/a.md", "a0", "a1");
    recordCrossFileEdit("C:/b.md", "b0", "b1");
    expect(peekCrossFileUndo("C:/a.md")).toEqual({ before: "a0", after: "a1" });
    expect(peekCrossFileUndo("C:/b.md")).toEqual({ before: "b0", after: "b1" });
    dropCrossFileUndo("C:/a.md");
    expect(hasCrossFileUndo("C:/a.md")).toBe(false);
    expect(hasCrossFileUndo("C:/b.md")).toBe(true);
  });
});

describe("SearchReplace：跨文件全部替换要写回当前文档（不能只改 state）", () => {
  it("replaceAllAcrossFiles 对当前文档调用 onSourceContentChange（同一写回通道）", () => {
    const idx = searchSrc.indexOf("const replaceAllAcrossFiles");
    expect(idx).toBeGreaterThan(0);
    const body = searchSrc.slice(idx, idx + 4000);
    expect(body).toContain("onSourceContentChange?.(next)");
    expect(body).toContain("applyFileText?.(f.fileKey, next)");
  });

  it("单次「替换」在阅读模式下走 PM 事务且进撤销栈", () => {
    const idx = searchSrc.indexOf("const replaceCurrent = useCallback");
    expect(idx).toBeGreaterThan(0);
    const body = searchSrc.slice(idx, idx + 3000);
    expect(body).toContain('tr.setMeta("addToHistory", true)');
  });

  it("全部替换在阅读模式下同样进撤销栈", () => {
    const idx = searchSrc.indexOf("const replaceAll = useCallback");
    expect(idx).toBeGreaterThan(0);
    const body = searchSrc.slice(idx, idx + 4000);
    expect(body).toContain('tr.setMeta("addToHistory", true)');
  });
});
