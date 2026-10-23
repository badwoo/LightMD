/**
 * v0.14.0 续修 需求1：跨文件替换后切到 B 文件无法撤销 —— **撤销入口收口**契约。
 *
 * ## 用户原话
 * 「在 a 文件中搜索内容并点击『查找所有打开文件』，在 b 文件中也查找到了内容，
 *  然后替换内容，a 和 b 文件的内容都成功替换了，但执行撤销时候只有 a 文件能撤销，
 *  我点击到 b 文件点击撤销就失效了。」
 *
 * ## 根因（代码证据 + 实机取证）
 * 上一轮把「跨文件替换记录」的消费放在 `EditorContainer.doLocalUndo`，但撤销有**两条**
 * 入口，只有一条经过它：
 * - 菜单 / 右键 / 命令面板 → 命令总线 → App `edit.undo` → store `undoHandler`
 *   → `handleUndo` → `doLocalUndo` ✔（上一轮探针 v1 只测了这条，所以全 PASS）；
 * - **阅读模式按 Ctrl+Z** → `dynamicShortcutsPlugin`（core/keymap.ts）→ 直接
 *   `prosemirror-history` 的 `undo` ✘。B 的 PM 栈在换文档时被 `resetHistory` 按内容
 *   重建（历史为空），于是键盘撤销毫无反应；A 的替换本身进了 PM 历史，所以"只有 A 能撤"。
 *
 * 实机证据：`scripts/v0140-probe-crossfile-undo-v2.mjs`
 * - S1：阅读模式 + **命令总线**入口 + 真实内容（CRLF/列表/表格/行内代码）→ 切 B 撤销 PASS；
 * - S2：阅读模式 + **真实键盘 Ctrl+Z** → 切 B 撤销 FAIL（本文件的回归目标）。
 *
 * ## 本文件锁定的硬约束
 * ① PM 动态键位里的 edit.undo/edit.redo **必须**转交宿主处理器（`setHostUndoRedo`），
 *    未注册宿主时才退化为原生 history 命令（独立 createEditor / 单测不回归）；
 * ② `EditorContainer` 挂载时必须把 `handleUndo/handleRedo` 注册进该表，卸载时清空；
 * ③ `App` 的窗口 keydown 对 global-editor 必须**区分三种落点**且互斥（防双撤销）：
 *    PM 内 → 让行给 PM；输入控件内 → 让行给原生撤销；焦点在标签/工具栏/空白区 → 交给
 *    宿主入口（否则"点完 B 标签立刻 Ctrl+Z"没人处理 —— 用户真实动作链）；
 * ④ 「逐字节一致」安全护栏**不得放松**：用户手改过 B 之后记录必须被丢弃，
 *    绝不整篇覆盖用户的手工编辑。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { history, undoDepth } from "prosemirror-history";
import fs from "node:fs";
import path from "node:path";
import { markdownToDoc } from "../core/markdown/parser";
import { getMarkdownFromDoc } from "../core/editor";
import { withTrailingParagraph } from "../core/plugins/trailing-paragraph";
import { getPMCommand, setHostUndoRedo, classifyGlobalEditorKeyTarget } from "../core/keymap";
import { crossFileEditMatches } from "../components/editor/EditorContainer";

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, "..", rel), "utf-8");

const keymapSrc = read("core/keymap.ts");
const appSrc = read("App.tsx");
const containerSrc = read("components/editor/EditorContainer.tsx");

function stateWithHistory(markdown: string): EditorState {
  return EditorState.create({ doc: markdownToDoc(markdown), plugins: [history()] });
}

/** 在文档开头插一段文本 → 产生一步可撤销历史 */
function withOneEdit(markdown: string): EditorState {
  const s = stateWithHistory(markdown);
  return s.apply(s.tr.insertText("X", 1));
}

afterEach(() => setHostUndoRedo(null));

describe("撤销入口收口：PM 动态键位必须把 undo/redo 交回宿主（不直接跑原生 history）", () => {
  it("宿主已注册：edit.undo 调宿主一次、不 dispatch、不动 PM 历史", () => {
    let undoCalls = 0;
    let redoCalls = 0;
    setHostUndoRedo({ undo: () => { undoCalls++; }, redo: () => { redoCalls++; } });
    const state = withOneEdit("hello\n");
    expect(undoDepth(state)).toBe(1);
    let dispatched = 0;
    const handled = getPMCommand("edit.undo")!(state, () => { dispatched++; });
    expect(handled).toBe(true);
    expect(undoCalls).toBe(1);
    expect(redoCalls).toBe(0);
    expect(dispatched).toBe(0);
    // 原生历史未被消费（说明确实没走 prosemirror-history）
    expect(undoDepth(state)).toBe(1);
  });

  it("宿主已注册：edit.redo 同样交回宿主（Ctrl+Y 才能恢复跨文件替换）", () => {
    let undoCalls = 0;
    let redoCalls = 0;
    setHostUndoRedo({ undo: () => { undoCalls++; }, redo: () => { redoCalls++; } });
    const state = withOneEdit("hello\n");
    const handled = getPMCommand("edit.redo")!(state, () => {});
    expect(handled).toBe(true);
    expect(redoCalls).toBe(1);
    expect(undoCalls).toBe(0);
  });

  it("未注册宿主（独立 createEditor / 单测）：退化为原生 undo，行为与修复前一致", () => {
    setHostUndoRedo(null);
    const state = withOneEdit("hello\n");
    let next: EditorState | null = null;
    const ok = getPMCommand("edit.undo")!(state, (tr) => { next = state.apply(tr); });
    expect(ok).toBe(true);
    expect(next).not.toBeNull();
    // 撤销掉刚才的插入 → 文本回到 hello
    expect((next as unknown as EditorState).doc.textContent).toBe("hello");
  });

  it("setHostUndoRedo(null) 后立即恢复原生（组件卸载不留悬挂处理器）", () => {
    let calls = 0;
    setHostUndoRedo({ undo: () => { calls++; }, redo: () => {} });
    setHostUndoRedo(null);
    const state = withOneEdit("hello\n");
    let next: EditorState | null = null;
    getPMCommand("edit.undo")!(state, (tr) => { next = state.apply(tr); });
    expect(calls).toBe(0);
    expect((next as unknown as EditorState).doc.textContent).toBe("hello");
  });
});

describe("接线契约：keymap / EditorContainer / App 三处必须同时到位", () => {
  it("keymap：edit.undo / edit.redo 必须经 hostUndoCommand", () => {
    expect(keymapSrc).toContain('"edit.undo": hostUndoCommand("undo")');
    expect(keymapSrc).toContain('"edit.redo": hostUndoCommand("redo")');
    expect(keymapSrc).toContain('"edit.redo2": hostUndoCommand("redo")');
    // 反向断言：不允许回退成「直接执行原生 undo」（那正是本缺陷的根因）
    expect(keymapSrc).not.toContain("const undoLocal = undo;");
  });

  it("EditorContainer：挂载时把 handleUndo/handleRedo 注册进宿主表，卸载时清空", () => {
    expect(containerSrc).toContain("setHostUndoRedo({ undo: handleUndo, redo: handleRedo })");
    const idx = containerSrc.indexOf("setHostUndoRedo({ undo: handleUndo, redo: handleRedo })");
    const tail = containerSrc.slice(idx, idx + 500);
    expect(tail).toContain("setHostUndoRedo(null)");
  });

  it("App：global-editor 四种落点互斥（PM 让行 / 输入控件让行 / 标签工具栏交宿主 / textarea 走源码栈）", () => {
    const idx = appSrc.indexOf('if (def.scope === "global-editor")');
    expect(idx).toBeGreaterThan(0);
    const body = appSrc.slice(idx, idx + 1200);
    // 落点分类走纯函数（便于下面行为级单测覆盖四条契约）
    expect(body).toContain("classifyGlobalEditorKeyTarget(target)");
    // ① PM 内让行（否则 PM keymap + 窗口监听 = 一次 Ctrl+Z 撤两步）
    expect(body).toContain('where === "prosemirror"');
    // ② 输入控件（搜索框等）让行给原生撤销
    expect(body).toContain('where === "editable"');
    // ③ 焦点在标签/工具栏/空白区 → 交给宿主入口（用户"点完 B 标签按撤销"的动作链）
    expect(body).toContain('where === "chrome"');
    expect(body).toContain("undoHandler?.()");
    expect(body).toContain("redoHandler?.()");
  });
});

describe("classifyGlobalEditorKeyTarget：撤销键位落点分类（防双撤销 / 不抢输入框）", () => {
  const mk = (html: string): Element => {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
  };
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("源码编辑区 textarea → textarea（窗口监听统一 dispatch 自定义撤销栈）", () => {
    const host = mk('<textarea class="source-editor"></textarea>');
    expect(classifyGlobalEditorKeyTarget(host.querySelector("textarea"))).toBe("textarea");
  });

  it("ProseMirror 根节点及其子节点 → prosemirror（必须让行给 PM 动态键位）", () => {
    const host = mk(
      '<div class="ProseMirror" contenteditable="true"><p><span id="inner">正文</span></p></div>',
    );
    expect(classifyGlobalEditorKeyTarget(host.querySelector(".ProseMirror"))).toBe("prosemirror");
    // 子节点（真实 keydown 的 target 通常是光标所在的 span/文本元素）
    expect(classifyGlobalEditorKeyTarget(host.querySelector("#inner"))).toBe("prosemirror");
  });

  it("搜索框 / 设置输入框 / 非 PM 的 contenteditable → editable（不抢 Ctrl+Z）", () => {
    const host = mk(
      '<input class="search-input" /><select></select><div id="ce" contenteditable="true"></div>',
    );
    expect(classifyGlobalEditorKeyTarget(host.querySelector("input"))).toBe("editable");
    expect(classifyGlobalEditorKeyTarget(host.querySelector("select"))).toBe("editable");
    expect(classifyGlobalEditorKeyTarget(host.querySelector("#ce"))).toBe("editable");
  });

  it("标签按钮 / 工具栏按钮 / body / null → chrome（交给宿主撤销入口）", () => {
    const host = mk('<button class="tab-item">文档B.md</button><button class="toolbar-btn"></button>');
    expect(classifyGlobalEditorKeyTarget(host.querySelector(".tab-item"))).toBe("chrome");
    expect(classifyGlobalEditorKeyTarget(host.querySelector(".toolbar-btn"))).toBe("chrome");
    expect(classifyGlobalEditorKeyTarget(document.body)).toBe("chrome");
    expect(classifyGlobalEditorKeyTarget(null)).toBe("chrome");
  });
});

describe("安全护栏：内容不一致绝不整篇覆盖（用户手改后不误覆盖）", () => {
  it("crossFileEditMatches：逐字节相等才放行，任何差异都拒绝", () => {
    const after = "B 段落里有 DOG\n";
    expect(crossFileEditMatches(after, after)).toBe(true);
    // 用户手工编辑过（哪怕只加一个字）
    expect(crossFileEditMatches(after, after + "手改")).toBe(false);
    expect(crossFileEditMatches(after, after.replace("DOG", "DOG!"))).toBe(false);
    // 行尾差异同样拒绝：整篇写回会把 CRLF 文件改成 LF，属于"用户没要求的变化"
    expect(crossFileEditMatches("a\r\nb", "a\nb")).toBe(false);
  });

  it("doLocalUndo / doLocalRedo 的四条分支都用该护栏判定（阅读/源码 × 撤销/恢复）", () => {
    const undoIdx = containerSrc.indexOf("const doLocalUndo = useCallback");
    const undoBody = containerSrc.slice(undoIdx, undoIdx + 3200);
    expect(undoBody).toContain("crossFileEditMatches(ext.after, getMarkdownFromDoc");
    expect(undoBody).toContain("crossFileEditMatches(ext.after, sourceContentRef.current)");
    const redoIdx = containerSrc.indexOf("const doLocalRedo = useCallback");
    const redoBody = containerSrc.slice(redoIdx, redoIdx + 3200);
    expect(redoBody).toContain("crossFileEditMatches(ext.before, getMarkdownFromDoc");
    expect(redoBody).toContain("crossFileEditMatches(ext.before, sourceContentRef.current)");
  });

  it("真实形态 md（CRLF/末尾无换行/列表/表格/行内代码）装载后与替换结果逐字节一致 → 护栏不误伤", () => {
    // 这条是上一轮怀疑「序列化往返不等价导致护栏误判」的**反证**：
    // 文档是从替换结果文本直接解析的，未改动的块走序列化器的原文切片快路径，
    // 因此 getMarkdownFromDoc 能逐字节还原（实机 S1 也据此 PASS）。
    const realMd = [
      "# 文档 B",
      "",
      "B 段落里有 DOG，还有行内 `DOG` 代码。",
      "",
      "- 列表里的 DOG",
      "- 普通项",
      "",
      "| 列1 | 列2 |",
      "| --- | --- |",
      "| DOG | 测试 |",
    ].join("\r\n"); // 末尾无换行
    const doc = withTrailingParagraph(markdownToDoc(realMd));
    expect(getMarkdownFromDoc(doc)).toBe(realMd);
  });
});
