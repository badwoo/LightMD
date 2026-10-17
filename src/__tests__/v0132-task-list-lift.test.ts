// @vitest-environment jsdom
/**
 * v0.13.2 需求2：Ctrl+T 在有序列表里要「把当前行提升为任务项」。
 *
 * ## 用户原话
 * 「在阅读模式下，我在有序列表使用快捷键 ctrl+t，想给这行加任务列表，
 *  结果任务列表没有自动加到有序列表前，而是回车换行了。」
 * 选定方案：「把当前行『提升』为任务项」。
 *
 * ## 旧实现的两个根因（本文件用真实实现锁住新契约）
 * - 阅读模式：`insert.taskList` 只认「当前块是顶层段落/标题」，列表项里的光标其
 *   `parent` 仍是 paragraph → 任务列表被塞进**列表项内部**（视觉上=回车换行）。
 * - 源码模式：`COMMAND_SYNTAX["insert.taskList"] = "\n- [ ] "`，只是在光标处插一行，
 *   同样把列表项劈成两半。
 *
 * 新口径：当前行从原列表**摘出来**成为任务项，新任务列表放在原列表**之前**，
 * 列表其余项保留；整表只有一项时整表被任务列表替换。
 *
 * ─── v0.13.2 返修（用户第二批复测）───
 * 用户原话：「给有序列表加任务列表没有实现，一加有序列表就消失了，我需要的效果是：
 * `- [ ] 1. xxx`。」因此**有序列表的序号要作为字面文本保留在任务项里**：
 * 第 2 项提升后源码是 `- [ ] 2. bb`，阅读模式渲染为 ☐ 2. bb。
 * 无序列表没有序号，行为不变（`- [ ] bb`）。
 *
 * 说明：阅读模式走真实 `runPreviewCommand` + 真实 ProseMirror schema/序列化器。
 * 源码模式的完整路径需要 textarea 事件 + 撤销栈（jsdom 无法可靠建模），
 * 因此纯函数 `liftListLineToTask` 做行为级测试，接线只做一条源码契约锁（见文末）。
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { readFileSync } from "node:fs";

import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { runPreviewCommand } from "../core/pmCommands";
import { liftListLineToTask } from "../components/editor/sourceFormat";

// ───────────────────────── 阅读模式（ProseMirror）工具 ─────────────────────────

/** 与既有 pm 命令测试同型的 stub view：dispatch 后把事务应用到当前 state */
function stubView(state: EditorState): { view: EditorView; get: () => EditorState } {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch: (tr: Transaction) => {
      current = current.apply(tr);
    },
    focus: () => {},
  } as unknown as EditorView;
  return { view, get: () => current };
}

function makeState(doc: PMNode, pos: number): EditorState {
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

/**
 * 定位第 `listIndex` 个**顶层列表**（ordered/bullet/task）里第 `itemIndex` 项的
 * 段落文本起点（光标可直接落进去）。
 */
function itemTextPos(doc: PMNode, listIndex: number, itemIndex: number): number {
  let seen = 0;
  let listPos = -1;
  doc.forEach((node, offset) => {
    if (listPos >= 0) return;
    if (node.type.name === "ordered_list" || node.type.name === "bullet_list" || node.type.name === "task_list") {
      if (seen === listIndex) listPos = offset;
      seen++;
    }
  });
  if (listPos < 0) throw new Error(`找不到第 ${listIndex} 个列表`);
  const list = doc.nodeAt(listPos)!;
  let itemPos = listPos + 1;
  for (let i = 0; i < itemIndex; i++) itemPos += list.child(i).nodeSize;
  // itemPos -> item 起点；+1 -> 首段（paragraph）起点；+2 -> 段落文本起点
  return itemPos + 2;
}

function topLevelTypes(doc: PMNode): string[] {
  const types: string[] = [];
  doc.forEach((n) => types.push(n.type.name));
  return types;
}

function liftAt(doc: PMNode, pos: number) {
  const state = makeState(doc, pos);
  const { view, get } = stubView(state);
  const handled = runPreviewCommand("insert.taskList", view);
  return { handled, doc: get().doc };
}

// ═══════════════════════ 阅读模式：列表项 → 任务项 ═══════════════════════

describe("需求2 · 阅读模式：有序列表中间项被提升到列表之前", () => {
  it("3 项有序列表、光标在第 2 项 → 顶层变成 [task_list, ordered_list]", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));

    expect(handled).toBe(true);
    // 顶层顺序：任务列表在**前**（用户原话「任务列表没有自动加到有序列表前」）
    expect(topLevelTypes(next)).toEqual(["task_list", "ordered_list"]);

    const taskList = next.child(0);
    expect(taskList.childCount).toBe(1);
    const taskItem = taskList.child(0);
    expect(taskItem.type.name).toBe("task_item");
    // v0.13.2 返修：原序号（第 2 项 = `2.`）作为字面文本保留
    expect(taskItem.textContent).toBe("2. bb");
    expect(taskItem.attrs.checked).toBe(false);

    // 列表其余项原样保留（顺序不变）
    const rest = next.child(1);
    expect(rest.childCount).toBe(2);
    expect(rest.textContent).toBe("aacc");
  });

  it("序列化 markdown：`- [ ] 2. bb` 出现在 `1. aa` 之前（序号保留、不是列表项内部）", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    const md = docToMarkdown(next);

    // 用户要的形态：复选框 + 原序号 + 正文
    const taskAt = md.indexOf("- [ ] 2. bb");
    const listAt = md.indexOf("1. aa");
    expect(taskAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(taskAt).toBeLessThan(listAt);
    // 旧缺陷的形态：任务项被缩进进列表项内部
    expect(md).not.toMatch(/^ {2,}- \[ \] /m);
    expect(md).toContain("2. cc");
    expect(md).not.toContain("bb\n1.");
  });

  it("光标落在第 3 项 → 提升的是第 3 项，前两项留在列表里", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 2));
    expect(next.child(0).textContent).toBe("3. cc");
    expect(next.child(1).textContent).toBe("aabb");
  });

  it("无序列表同样适用（`- x` / `* x` 都走同一条路径）", () => {
    const doc = markdownToDoc("- aa\n- bb\n- cc\n");
    const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    expect(handled).toBe(true);
    expect(topLevelTypes(next)).toEqual(["task_list", "bullet_list"]);
    expect(next.child(0).textContent).toBe("bb");
    expect(next.child(1).childCount).toBe(2);
  });

  it("单元素有序列表 → 整表被任务列表替换，顶层只剩 1 个节点", () => {
    const doc = markdownToDoc("1. only\n");
    const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, 0));
    expect(handled).toBe(true);
    expect(next.childCount).toBe(1);
    expect(next.child(0).type.name).toBe("task_list");
    // 这就是用户要的 `- [ ] 1. xxx` 形态
    expect(next.child(0).textContent).toBe("1. only");
    expect(docToMarkdown(next)).toBe("- [ ] 1. only\n");
  });
});

describe("需求2 · 阅读模式：任务列表里的项（重复触发）", () => {
  it("已勾选的两项任务列表、提升第 2 项 → 结构完整，新任务项重置为未勾选", () => {
    const doc = markdownToDoc("- [ ] a\n- [x] b\n");
    const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));

    expect(handled).toBe(true);
    // 实现契约（list_item / task_item 同一套 LIST_ITEM_TYPES）：
    // 提升的是「当前行」，与原节点是否为任务项无关。结构不被破坏：
    // 顶层两个 task_list，互不嵌套，文本不丢失。
    expect(topLevelTypes(next)).toEqual(["task_list", "task_list"]);
    expect(next.child(0).textContent).toBe("b");
    expect(next.child(1).textContent).toBe("a");
    // 实际契约：提升产生的是**新的未勾选**任务项（勾选状态不随提升保留）
    expect(next.child(0).child(0).attrs.checked).toBe(false);
    expect(next.child(1).child(0).attrs.checked).toBe(false);

    const md = docToMarkdown(next);
    // 旧缺陷形态「回车换行」= 把 `- [ ]` 塞进原列表项内部（2 空格缩进）
    expect(md).not.toMatch(/^ {2,}- \[ \]/m);
    expect(md.indexOf("- [ ] b")).toBeLessThan(md.indexOf("- [ ] a"));
  });

  it("单项任务列表上重复触发 → 仍是单个 task_list（幂等结构，勾选态被重置）", () => {
    const doc = markdownToDoc("- [x] done\n");
    const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, 0));
    expect(handled).toBe(true);
    expect(next.childCount).toBe(1);
    expect(next.child(0).type.name).toBe("task_list");
    expect(next.child(0).childCount).toBe(1);
    expect(next.child(0).textContent).toBe("done");
    // 契约：整表替换成**新的**未勾选任务项（不是原地保留 attrs）
    expect(next.child(0).child(0).attrs.checked).toBe(false);
  });
});

describe("需求2 · 阅读模式：退化路径与边界", () => {
  it("顶层普通段落 → 仍退化为普通 task_list 插入（不崩，文本不丢）", () => {
    const doc = markdownToDoc("todo item\n");
    const { handled, doc: next } = liftAt(doc, 2);
    expect(handled).toBe(true);
    expect(topLevelTypes(next)).toEqual(["task_list"]);
    expect(next.textContent).toBe("todo item");
  });

  it("嵌套列表：光标在内层项 → 只提升内层项，外层结构不变", () => {
    const doc = markdownToDoc("1. outer\n   1. inner1\n   2. inner2\n");
    // 找到内层列表的位置：descendants 里第二个 ordered_list
    const listPositions: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "ordered_list") listPositions.push(pos);
    });
    expect(listPositions.length).toBe(2);
    const innerPos = listPositions[1];
    const inner = doc.nodeAt(innerPos)!;
    const innerItem2 = innerPos + 1 + inner.child(0).nodeSize;
    const { handled, doc: next } = liftAt(doc, innerItem2 + 2);

    expect(handled).toBe(true);
    // 外层只有一个有序列表；其内容 = 段落 + （任务列表 + 内层列表）
    expect(next.childCount).toBe(1);
    expect(next.child(0).type.name).toBe("ordered_list");
    const childTypes: string[] = [];
    next.child(0).child(0).forEach((c) => childTypes.push(c.type.name));
    expect(childTypes).toEqual(["paragraph", "task_list", "ordered_list"]);
    expect(next.child(0).child(0).child(1).textContent).toBe("2. inner2");
    expect(next.child(0).child(0).child(2).textContent).toBe("inner1");
  });

  it("列表项含多个段落时**整项内容**一起提升（不得丢块）", () => {
    // 手工构造，保证节点结构确定（parser 对 `1. a\n\n   b` 的切分随缩进而变）
    const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
    const item = schema.nodes.list_item.create(null, [p("bb1"), p("bb2")]);
    const list = schema.nodes.ordered_list.create({ order: 1 }, [item]);
    const tail = schema.nodes.paragraph.create(null, schema.text("tail"));
    const doc = schema.topNodeType.create(null, [list, tail]);
    const { handled, doc: next } = liftAt(doc, 4); // 第一段文本内

    expect(handled).toBe(true);
    expect(topLevelTypes(next)).toEqual(["task_list", "paragraph"]);
    // 任务项内容模型与 list_item 相同（`paragraph block*`）→ 两段都要搬过去。
    // （v0.13.2 复审修复的数据丢失缺陷：旧实现只取 firstParagraphOf，bb2 凭空消失）
    expect(next.child(0).child(0).childCount).toBe(2);
    // 序号作为字面文本保留在首段开头
    expect(next.child(0).textContent).toBe("1. bb1bb2");
  });

  it("真实源码 `1. a` + 缩进续段解析出的多块列表项：提升后一个字符都不丢", () => {
    const doc = markdownToDoc("1. bb1\n\n   bb2\n\n2. cc\n");
    const list = doc.child(0);
    const firstItem = list.child(0);
    // parser 把缩进续段解析为同一列表项的第二个段落 → 这确实是真实可达的结构
    expect(firstItem.childCount).toBe(2);
    expect(firstItem.textContent).toBe("bb1bb2");

    const { doc: next } = liftAt(doc, 4);
    // 提升后任务项必须含**两段**；bb2 不得丢失（阅读模式 Ctrl+T 的数据丢失路径）
    expect(next.child(0).type.name).toBe("task_list");
    expect(next.child(0).textContent).toBe("1. bb1bb2");
    expect(next.textContent).toContain("bb2");
    // 原列表剩下的 `2. cc` 仍在（提升只摘走当前项）
    const residual = next.child(1);
    expect(residual.type.name).toBe("ordered_list");
    expect(residual.textContent).toBe("cc");
  });
});

// ═══════════════════════ 源码模式：liftListLineToTask 纯函数 ═══════════════════════

/** 光标偏移 → 落在第 `lineIdx` 行中间（用于构造不依赖绝对偏移的光标） */
function caretInLine(text: string, lineIdx: number, offsetInLine = 3): number {
  const lines = text.split("\n");
  let pos = 0;
  for (let i = 0; i < lineIdx; i++) pos += lines[i].length + 1;
  return pos + Math.min(offsetInLine, lines[lineIdx].length);
}

/** 把 `replacement` 按行切开，便于断言行序 */
const linesOf = (s: string) => s.split("\n");

describe("需求2 · 源码模式：liftListLineToTask", () => {
  it("有序列表中间行 → 任务行被插到列表块之前，序号 `2.` 保留", () => {
    const text = ["intro", "", "1. one", "2. two", "3. three", "", "tail"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 3));
    expect(res).not.toBeNull();
    expect(linesOf(res!.replacement)).toEqual([
      "intro",
      "",
      "- [ ] 2. two",
      "1. one",
      "3. three",
      "",
      "tail",
    ]);
  });

  it("无序列表中间行 → 同样提升；列表标记保持原样", () => {
    const text = ["- aa", "* bb", "+ cc"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1));
    expect(res).not.toBeNull();
    expect(linesOf(res!.replacement)).toEqual(["- [ ] bb", "- aa", "+ cc"]);
  });

  it("列表位于文本开头 → 任务行在最前面", () => {
    const text = ["1. aa", "2. bb"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 0));
    expect(res).not.toBeNull();
    expect(linesOf(res!.replacement)).toEqual(["- [ ] 1. aa", "2. bb"]);
  });

  it("光标在行首 / 行尾 → 仍按「光标所在行」处理", () => {
    const text = ["1. aa", "2. bb", "3. cc"].join("\n");
    const lineStart = caretInLine(text, 1, 0);
    const lineEnd = caretInLine(text, 1, 1000);
    for (const pos of [lineStart, lineEnd]) {
      const res = liftListLineToTask(text, pos);
      expect(res, `caret=${pos}`).not.toBeNull();
      expect(linesOf(res!.replacement)[0]).toBe("- [ ] 2. bb");
    }
  });

  it("caretPos 精确落在任务行末尾（可直接继续输入）", () => {
    const text = ["intro", "1. one", "2. two", "3. three"].join("\n");
    const cursorPos = caretInLine(text, 2);
    const res = liftListLineToTask(text, cursorPos)!;
    expect(res).not.toBeNull();
    const after = cursorPos + res.cursorOffset;
    expect(res.replacement.slice(0, after).endsWith("- [ ] 2. two")).toBe(true);
    // 后面紧跟的必须是换行（不是半个单词）
    expect(res.replacement[after]).toBe("\n");
  });

  it("空行分隔的列表块：任务行插在该列表块之前，不跑到文档最前面", () => {
    const text = ["intro", "", "1. aa", "2. bb", "", "tail"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 3))!;
    expect(res).not.toBeNull();
    expect(linesOf(res.replacement)).toEqual([
      "intro",
      "",
      "- [ ] 2. bb",
      "1. aa",
      "",
      "tail",
    ]);
  });

  it("非列表行 → null（调用方回退到既有的「插入空任务项」）", () => {
    for (const text of ["普通段落", "# 标题", "", "> 引用", "```\ncode\n```"]) {
      expect(liftListLineToTask(text, Math.min(2, text.length))).toBeNull();
    }
  });

  it("已经是任务项（`- [ ]` / `- [x]` / `* [X]`）→ null（不回退成嵌套提升）", () => {
    for (const text of ["- [ ] done", "- [x] done", "* [X] done"]) {
      expect(liftListLineToTask(text, 3)).toBeNull();
    }
  });

  it("0~3 空格缩进的列表行也被识别（提升后按任务项顶层书写）", () => {
    const text = ["   1. aa", "   2. bb"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1));
    expect(res).not.toBeNull();
    expect(linesOf(res!.replacement)).toEqual(["- [ ] 2. bb", "   1. aa"]);
  });

  it("嵌套列表项：源码模式把任务行提到**整个列表块**之前（与阅读模式的内层提升不同）", () => {
    // 已知的行为不一致（任务 output 已记录，低严重度）：
    // 阅读模式找的是**最内层**列表，任务列表留在父项内部（见上方嵌套用例）；
    // 源码模式把连续列表行视为一个块，块起点是最外层行 → 任务行被提到最外层之前。
    const text = ["1. outer", "   1. inner1", "   2. inner2"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1))!;
    expect(res).not.toBeNull();
    expect(linesOf(res.replacement)).toEqual([
      "- [ ] 1. inner1",
      "1. outer",
      "   2. inner2",
    ]);
  });

  it("多行文本只改动目标行（其余行逐字节不变）", () => {
    const text = ["a", "1. one", "2. two", "3. three", "b"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 2))!;
    const before = new Set(linesOf(text));
    for (const line of linesOf(res.replacement)) {
      if (line === "- [ ] 2. two") continue;
      expect(before.has(line), `多余行: ${line}`).toBe(true);
    }
    // 行数不变：目标行被摘出、任务行插入，净增 0
    expect(linesOf(res.replacement).length).toBe(linesOf(text).length);
  });
});

// ═══════════════════════ 接线（源码契约锁） ═══════════════════════

/**
 * jsdom 里跑不通完整源码模式路径：`lightmd:command` → EditorContainer 的
 * `handleFormatAction("taskListLift")` 需要真实 textarea 选区、撤销栈与 ghost 层，
 * 直接渲染 EditorContainer 会连带 iframe/预览渲染。因此这里只锁**接线**：
 * 三处必须存在（App 放行 → EditorContainer 监听 → 纯函数 + 回退）。
 */
describe("需求2 · 接线契约（jsdom 无法跑完整源码模式链路，故锁源码）", () => {
  const containerSrc = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");
  const appSrc = readFileSync("src/App.tsx", "utf-8");

  it("App 在源码模式对 insert.taskList 提前放行（不写死语法串）", () => {
    expect(appSrc).toContain('if (id === "insert.taskList") return;');
  });

  it("EditorContainer 的 lightmd:command 监听把 insert.taskList 交给 taskListLift", () => {
    expect(containerSrc).toContain('if (id === "insert.taskList") {');
    expect(containerSrc).toContain('handleFormatAction.current("taskListLift")');
  });

  it("taskListLift 分支走纯函数，非列表行回退到原有语法插入", () => {
    expect(containerSrc).toContain('if (action === "taskListLift") {');
    expect(containerSrc).toContain("liftListLineToTaskFn(currentContent, start)");
    expect(containerSrc).toContain('insertTextAtCursor("\\n- [ ] ")');
  });
});
