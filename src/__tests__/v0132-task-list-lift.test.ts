// @vitest-environment jsdom
/**
 * Ctrl+T 在有序列表上「把当前行变成待办」—— **v0.17.0 第四轮用户裁决口径（R4）**。
 *
 * ## 口径演进（四层，别再搞混）
 *
 * ### 1️⃣ v0.13.2 之前：回车换行（缺陷）
 * 阅读模式 `insert.taskList` 只认「当前块是顶层段落/标题」，列表项里的光标其
 * `parent` 仍是 paragraph → 任务列表被塞进**列表项内部**（视觉上=回车换行）。
 *
 * ### 2️⃣ v0.13.2 需求2：「提升到列表之前」+ 序号写成字面文本
 * 用户当时原话：「任务列表没有自动加到有序列表前，而是回车换行了」+
 * 「一加有序列表就消失了，我需要的效果是 `- [ ] 1. xxx`」。
 * 于是：摘出来 → 新任务列表插在原列表**之前** → 序号作为**字面文本**写进任务项。
 * 缺陷：3 项列表转第 2 项后阅读视图是 `☐ 2. bb` → `1. aa` → `2. cc`，序号视觉 **2/1/2**。
 *
 * ### 3️⃣ v0.17.0 R3（C2 就地转换）
 * 任务项**不带**序号、列表断成两段、后段 `order` 续号 →
 * `1. aa` / `☐ bb` / `2. cc`（视觉序号 1、2 连续）。
 * 缺陷（用户 R4 复测原话）：「在有序列表上加任务待办会**把有序列表弄没**」——
 * 视觉上任务项夹在列表中间把列表"劈开"，用户认为列表消失了。
 *
 * ### 4️⃣ v0.17.0 R4（**现行**，用户 2026-11-12 17:07 裁决，取代 C2）
 * 用户原话：「正确例子如**在 2. 上加任务，那么结果应该是 `- [ ] 2.`**」
 * ```
 * 1. aa          ← 原样保留，逐字节不变
 * - [ ] 2. bb    ← 原地变待办，带字面序号 `2.`
 * 3. cc          ← 原样保留，逐字节不变
 * ```
 *
 * ## R4 的三个硬点（回归价值最高，别删）
 *
 * 1. **任务项带字面序号**（写进首段文本开头；任务项自己没有序号 attr）。
 *    `2. ` 后有空格 —— 否则变 `- [ ] 2.bb`。
 * 2. **后段列表 `order` = `startOrder + itemIndex + 1`**。
 *    R4 下待办项**自己保留了序号**，后续项不能顶替它的位置，必须接着它后面数。
 *    写 `+0`（= C2 的写法）→ `2. cc`（序号 2 出现两次，跳号）；
 *    不设 → `1. cc`（复位）。
 * 3. **前段列表 `order` 沿用原值**（`1. aa` 逐字节不变，用户明确要求不重编号）。
 *
 * ## 为什么这个形态在 markdown 里是稳的
 *
 * `1. aa / - [ ] 2. bb / 3. cc` 解析出 **3 个独立块**
 * （`ordered_list(order=1)` / `task_list` / `ordered_list(order=3)`），
 * 序列化回来逐字节一致、重新打开视觉不变。**不是权宜之计。**
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import { history, undo, redo } from "prosemirror-history";
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

/** 定位第 `listIndex` 个**顶层列表**里第 `itemIndex` 项的段落文本起点 */
function itemTextPos(doc: PMNode, listIndex: number, itemIndex: number): number {
  let seen = 0;
  let listPos = -1;
  doc.forEach((node, offset) => {
    if (listPos >= 0) return;
    if (["ordered_list", "bullet_list", "task_list"].includes(node.type.name)) {
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

/** 顶层块的结构快照：类型 + 有序列表的 order/delim + 文本 */
function structureOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => {
    const order = n.attrs?.order;
    const delim = n.attrs?.delim === ")" ? ")" : ".";
    if (n.type.name === "ordered_list") out.push(`ol(${order}${delim})[${n.textContent}]`);
    else if (n.type.name === "task_list") out.push(`task[${n.textContent}]`);
    else if (n.type.name === "bullet_list") out.push(`ul[${n.textContent}]`);
    else out.push(`${n.type.name}[${n.textContent}]`);
  });
  return out;
}

function liftAt(doc: PMNode, pos: number) {
  const state = makeState(doc, pos);
  const { view, get } = stubView(state);
  const handled = runPreviewCommand("insert.taskList", view);
  return { handled, doc: get().doc, state: get() };
}

// ═══════════════════════ 阅读模式：R4 真值表 ═══════════════════════

describe("R4 · 阅读模式：有序列表项原地变待办，其余项原样保留", () => {
  /** 真值表：输入 → 光标项 → 期望块结构 + 期望序列化文本 */
  const TABLE: Array<{
    name: string;
    md: string;
    itemIndex: number;
    want: string[];
    wantMd: string;
  }> = [
    {
      name: "3 项列表，转第 1 项（首项）",
      md: "1. aa\n2. bb\n3. cc\n",
      itemIndex: 0,
      want: ["task[1. aa]", "ol(2.)[bbcc]"],
      wantMd: "- [ ] 1. aa\n\n2. bb\n3. cc\n",
    },
    {
      name: "3 项列表，转第 2 项（中间项）—— 用户主诉场景",
      md: "1. aa\n2. bb\n3. cc\n",
      itemIndex: 1,
      want: ["ol(1.)[aa]", "task[2. bb]", "ol(3.)[cc]"],
      wantMd: "1. aa\n\n- [ ] 2. bb\n\n3. cc\n",
    },
    {
      name: "3 项列表，转第 3 项（末项）",
      md: "1. aa\n2. bb\n3. cc\n",
      itemIndex: 2,
      want: ["ol(1.)[aabb]", "task[3. cc]"],
      wantMd: "1. aa\n2. bb\n\n- [ ] 3. cc\n",
    },
    {
      name: "唯一一项 → 整表被待办替换（列表消失正确，因为没有其他项）",
      md: "1. only\n",
      itemIndex: 0,
      want: ["task[1. only]"],
      wantMd: "- [ ] 1. only\n",
    },
    {
      name: "起始非 1（3./4./5.）转第 2 项 → 前段保持 3.，后段保持 5.",
      md: "3. aa\n4. bb\n5. cc\n",
      itemIndex: 1,
      want: ["ol(3.)[aa]", "task[4. bb]", "ol(5.)[cc]"],
      wantMd: "3. aa\n\n- [ ] 4. bb\n\n5. cc\n",
    },
    {
      name: "`)` 分隔符风格 → 序号前缀与前后两段都保留 `)`",
      md: "1) aa\n2) bb\n3) cc\n",
      itemIndex: 1,
      want: ["ol(1))[aa]", "task[2) bb]", "ol(3))[cc]"],
      wantMd: "1) aa\n\n- [ ] 2) bb\n\n3) cc\n",
    },
    {
      name: "无序列表 → 任务项不带序号（无序列表本来就没有序号）",
      md: "- aa\n- bb\n- cc\n",
      itemIndex: 1,
      want: ["ul[aa]", "task[bb]", "ul[cc]"],
      wantMd: "- aa\n\n- [ ] bb\n\n- cc\n",
    },
  ];

  for (const c of TABLE) {
    it(c.name, () => {
      const doc = markdownToDoc(c.md);
      const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, c.itemIndex));
      expect(handled).toBe(true);
      expect(structureOf(next)).toEqual(c.want);
      expect(docToMarkdown(next)).toBe(c.wantMd);
    });
  }

  it("★ 用户验收原话：`1. aa / 2. bb / 3. cc` 在 `2. bb` 上 Ctrl+T → `- [ ] 2. bb` 且列表三行都在", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    const md = docToMarkdown(next);

    // 用户原话「正确例子如在 2. 上加任务，那么结果应该是 `- [ ] 2.`」
    expect(md).toContain("- [ ] 2. bb");
    // 「把有序列表弄没」的反面：`1. aa` 与 `3. cc` 必须原样在
    expect(md).toContain("1. aa");
    expect(md).toContain("3. cc");
    // 逐字节不变的严格口径：三行按顺序出现
    expect(md).toBe("1. aa\n\n- [ ] 2. bb\n\n3. cc\n");
  });

  it("反例：C2 口径的产物形态必须不再出现（任务项**不带**序号）", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    // C2 产物是 `- [ ] bb`（无序号）；R4 必须是 `- [ ] 2. bb`
    expect(docToMarkdown(next)).not.toMatch(/^- \[ \] bb$/m);
    expect(docToMarkdown(next)).not.toMatch(/^- \[ \] bb\b(?!\.)/m);
  });
});

describe("R4 · 序号「不跳号 / 不重复 / 不复位」的机器校验", () => {
  /** 抽出 markdown 里所有有序列表编号，按段返回 */
  function collectOrderedNumbers(md: string): Array<{ start: number; items: number[] }> {
    const blocks: Array<{ start: number; items: number[] }> = [];
    let cur: { start: number; items: number[] } | null = null;
    for (const line of md.split("\n")) {
      const m = /^(\d+)[.)] /.exec(line);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!cur) {
          cur = { start: n, items: [n] };
          blocks.push(cur);
        } else {
          cur.items.push(n);
        }
      } else if (line.trim() === "") {
        cur = null;
      }
    }
    return blocks;
  }

  it("每段内部连号 + 段间序号严格递增（R4：后段接着待办项后面数）", () => {
    for (const itemIndex of [0, 1, 2]) {
      const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
      const { doc: next } = liftAt(doc, itemTextPos(doc, 0, itemIndex));
      const blocks = collectOrderedNumbers(docToMarkdown(next));

      // 每段内部必须严格 +1
      for (const b of blocks) {
        for (let i = 1; i < b.items.length; i++) {
          expect(b.items[i], `itemIndex=${itemIndex} 段内不连号：${JSON.stringify(b)}`).toBe(
            b.items[i - 1] + 1,
          );
        }
      }
      // R4 的段间关系：后段起始号 = 前段末号 + 2
      // （中间隔着**带序号**的待办项，它占掉了一个序号位置）
      if (blocks.length === 2) {
        const lastOfFirst = blocks[0].items[blocks[0].items.length - 1];
        expect(
          blocks[1].start,
          `itemIndex=${itemIndex} 段间跳号/复位：${JSON.stringify(blocks)}`,
        ).toBe(lastOfFirst + 2);
      }
    }
  });

  it("起始非 1 时同样成立：3./4./5. 转第 2 项 → 段 [3] 段 [5]", () => {
    const doc = markdownToDoc("3. aa\n4. bb\n5. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    const blocks = collectOrderedNumbers(docToMarkdown(next));
    expect(blocks.map((b) => b.items)).toEqual([[3], [5]]);
  });

  it("任务项的字面序号 = 该项在原列表中的字面序号（含起始非 1）", () => {
    const cases: Array<[string, number, string]> = [
      ["1. aa\n2. bb\n3. cc\n", 0, "- [ ] 1. aa"],
      ["1. aa\n2. bb\n3. cc\n", 1, "- [ ] 2. bb"],
      ["1. aa\n2. bb\n3. cc\n", 2, "- [ ] 3. cc"],
      ["3. aa\n4. bb\n5. cc\n", 0, "- [ ] 3. aa"],
      ["3. aa\n4. bb\n5. cc\n", 1, "- [ ] 4. bb"],
      ["3. aa\n4. bb\n5. cc\n", 2, "- [ ] 5. cc"],
      ["10. aa\n11. bb\n", 1, "- [ ] 11. bb"],
    ];
    for (const [md, idx, wantTask] of cases) {
      const doc = markdownToDoc(md);
      const { doc: next } = liftAt(doc, itemTextPos(doc, 0, idx));
      const taskLine = docToMarkdown(next).split("\n").find((l) => l.startsWith("- [ ] "));
      expect(taskLine, `${md} item#${idx}`).toBe(wantTask);
    }
  });
});

describe("R4 · 序号前缀的格式细节（空格 / 分隔符）", () => {
  it("`2. ` 后必须有空格（否则视觉上序号与正文粘连成 `2.bb`）", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    expect(docToMarkdown(next)).not.toMatch(/- \[ \] \d+[.)][^\s]/);
  });

  it("`)` 分隔符不被改写成 `.`", () => {
    const doc = markdownToDoc("1) aa\n2) bb\n3) cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    const md = docToMarkdown(next);
    expect(md).toContain("- [ ] 2) bb");
    expect(md).not.toContain("- [ ] 2. bb");
  });
});

describe("R4 · 内容零丢失与结构合法（v0.13.2 修过「第二段静默丢失」，别回退）", () => {
  it("列表项含多个段落：整项内容一起搬入任务项", () => {
    const doc = markdownToDoc("1. bb1\n\n   bb2\n\n2. cc\n");
    expect(doc.child(0).child(0).childCount).toBe(2); // 前提：parser 确实切成两段
    const { doc: next } = liftAt(doc, 4);
    const taskList = next.child(0);
    expect(taskList.type.name).toBe("task_list");
    expect(taskList.child(0).childCount).toBe(2);
    expect(next.textContent).toContain("bb2");
    expect(next.child(1).type.name).toBe("ordered_list");
  });

  it("嵌套子列表随列表项一起搬（不丢）", () => {
    const doc = markdownToDoc("1. 父项\n   - 子A\n   - 子B\n\n2. 下一项\n");
    const { doc: next } = liftAt(doc, 4);
    expect(next.textContent).toContain("子A");
    expect(next.textContent).toContain("子B");
  });

  it("输出文档满足 schema（构造过程不抛错）", () => {
    for (const [md, idx] of [
      ["1. aa\n2. bb\n3. cc\n", 1],
      ["1. only\n", 0],
      ["1. a\n2. b\n3. c\n4. d\n", 3],
    ] as Array<[string, number]>) {
      const doc = markdownToDoc(md);
      expect(() => liftAt(doc, itemTextPos(doc, 0, idx))).not.toThrow();
    }
  });

  it("★ 序列化往返：修复后 → 再解析 → 再序列化，逐字节不变", () => {
    const cases: Array<[string, number]> = [
      ["1. aa\n2. bb\n3. cc\n", 0],
      ["1. aa\n2. bb\n3. cc\n", 1],
      ["1. aa\n2. bb\n3. cc\n", 2],
      ["1. only\n", 0],
      ["3. aa\n4. bb\n5. cc\n", 1],
      ["1) aa\n2) bb\n3) cc\n", 1],
      ["- aa\n- bb\n- cc\n", 1],
      ["1. bb1\n\n   bb2\n\n2. cc\n", 0],
      ["1. outer\n   1. inner1\n   2. inner2\n", 0],
    ];
    for (const [md, idx] of cases) {
      const doc = markdownToDoc(md);
      const { doc: next } = liftAt(doc, itemTextPos(doc, 0, idx));
      const once = docToMarkdown(next);
      const twice = docToMarkdown(markdownToDoc(once));
      expect(twice, `往返不一致：${md} item#${idx}`).toBe(once);
    }
  });

  it("★ 重新解析后的块结构 = 修复后文档的结构（视觉不变）", () => {
    for (const [md, idx] of [
      ["1. aa\n2. bb\n3. cc\n", 1],
      ["3. aa\n4. bb\n5. cc\n", 1],
      ["1) aa\n2) bb\n3) cc\n", 1],
    ] as Array<[string, number]>) {
      const doc = markdownToDoc(md);
      const { doc: next } = liftAt(doc, itemTextPos(doc, 0, idx));
      const reparsed = markdownToDoc(docToMarkdown(next));
      expect(structureOf(reparsed)).toEqual(structureOf(next));
    }
  });
});

describe("R4 · 光标落点（两轮踩过同一处坑，别再错）", () => {
  it("★ 光标落在任务项**正文末尾**：接着键入得到 `- [ ] 2. bbX`（不是 `- [ ] X2. bb`）", () => {
    for (const [md, idx, wantLine] of [
      ["1. aa\n2. bb\n3. cc\n", 0, "- [ ] 1. aaX"],
      ["1. aa\n2. bb\n3. cc\n", 1, "- [ ] 2. bbX"],
      ["1. aa\n2. bb\n3. cc\n", 2, "- [ ] 3. ccX"],
      ["3. aa\n4. bb\n5. cc\n", 1, "- [ ] 4. bbX"],
      ["1) aa\n2) bb\n3) cc\n", 1, "- [ ] 2) bbX"],
    ] as Array<[string, number, string]>) {
      const doc = markdownToDoc(md);
      const { state } = liftAt(doc, itemTextPos(doc, 0, idx));
      // 不做任何重新定位，直接键入（模拟用户"转换完立刻接着打字"）
      const typed = state.apply(state.tr.insertText("X", state.selection.from));
      const taskLine = docToMarkdown(typed.doc).split("\n").find((l) => l.startsWith("- [ ] "));
      expect(taskLine, `${md} item#${idx}`).toBe(wantLine);
    }
  });
});

describe("R4 · 一次 Ctrl+Z 能整体撤销（不留半截事务）", () => {
  /**
   * 任务卡判据之一：「一次 Ctrl+Z 能整体撤销」。
   *
   * 为什么要单独测：R4 的实现是**一个事务里 `replaceWith` 三个节点**
   * （前段列表 + 待办 + 后段列表）。如果实现拆成多次 dispatch（例如先删项再插任务列表），
   * 用户按一次 Ctrl+Z 只会撤销一半，得到"列表被吃掉一项但任务项没出来"的中间态。
   * 这里用**真实 history 插件**验证：一次 undo 必须完全回到原文，一次 redo 必须完全回到修复后。
   */
  function stateWithHistory(md: string, pos: number) {
    const doc = markdownToDoc(md);
    return EditorState.create({
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [history()],
    });
  }

  it("★ 中间项：undo 一次 → 逐字节回到原文；redo 一次 → 逐字节回到修复后", () => {
    const md = "1. aa\n2. bb\n3. cc\n";
    const doc = markdownToDoc(md);
    let cur = stateWithHistory(md, itemTextPos(doc, 0, 1));
    const view = {
      get state() {
        return cur;
      },
      dispatch: (tr: Transaction) => {
        cur = cur.apply(tr);
      },
      focus: () => {},
    } as unknown as EditorView;

    const before = docToMarkdown(cur.doc);
    expect(runPreviewCommand("insert.taskList", view)).toBe(true);
    const after = docToMarkdown(cur.doc);
    expect(after).toBe("1. aa\n\n- [ ] 2. bb\n\n3. cc\n");

    // 一次撤销
    expect(undo(cur, (tr) => { cur = cur.apply(tr); })).toBe(true);
    expect(docToMarkdown(cur.doc), "一次 Ctrl+Z 未完全回到原文").toBe(before);

    // 一次重做
    expect(redo(cur, (tr) => { cur = cur.apply(tr); })).toBe(true);
    expect(docToMarkdown(cur.doc), "一次 Ctrl+Y 未回到修复后").toBe(after);
  });

  it("★ 首项 / 无序列表同样一次撤销到位", () => {
    for (const [md, idx, wantAfter] of [
      ["1. aa\n2. bb\n3. cc\n", 0, "- [ ] 1. aa\n\n2. bb\n3. cc\n"],
      ["- aa\n- bb\n- cc\n", 1, "- aa\n\n- [ ] bb\n\n- cc\n"],
    ] as Array<[string, number, string]>) {
      const doc = markdownToDoc(md);
      let cur = stateWithHistory(md, itemTextPos(doc, 0, idx));
      const view = {
        get state() {
          return cur;
        },
        dispatch: (tr: Transaction) => {
          cur = cur.apply(tr);
        },
        focus: () => {},
      } as unknown as EditorView;

      const before = docToMarkdown(cur.doc);
      runPreviewCommand("insert.taskList", view);
      expect(docToMarkdown(cur.doc)).toBe(wantAfter);

      expect(undo(cur, (tr) => { cur = cur.apply(tr); })).toBe(true);
      expect(docToMarkdown(cur.doc), `${md} item#${idx} 一次撤销未回到原文`).toBe(before);
    }
  });
});

// ═══════════════════════ 源码模式：liftListLineToTask 纯函数 ═══════════════════════

/** 光标偏移 → 落在第 `lineIdx` 行中间 */
function caretInLine(text: string, lineIdx: number, offsetInLine = 3): number {
  const lines = text.split("\n");
  let pos = 0;
  for (let i = 0; i < lineIdx; i++) pos += lines[i].length + 1;
  return pos + Math.min(offsetInLine, lines[lineIdx].length);
}

const linesOf = (s: string) => s.split("\n");
/** 归一化：把连续空行压成一个（两模式唯一允许的差异就是空行策略） */
const norm = (s: string) => s.replace(/\n+/g, "\n").trim();

describe("R4 · 源码模式 liftListLineToTask：与阅读模式语义一致", () => {
  it("有序列表中间行 → 原地变 `- [ ] 2. two`，前后两段序号保持原值", () => {
    const text = ["intro", "", "1. one", "2. two", "3. three", "", "tail"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 3));
    expect(res).not.toBeNull();
    expect(linesOf(res!.replacement)).toEqual([
      "intro",
      "",
      "1. one",
      "",
      "- [ ] 2. two",
      "",
      "3. three",
      "",
      "tail",
    ]);
  });

  it("首项 → 后段从 2 开始（原第 2 项的字面序号）", () => {
    const text = ["1. one", "2. two", "3. three"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 0))!;
    expect(linesOf(res.replacement)).toEqual(["- [ ] 1. one", "", "2. two", "3. three"]);
  });

  it("末项 → 前段保留，任务行在最后", () => {
    const text = ["1. one", "2. two", "3. three"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 2))!;
    expect(linesOf(res.replacement)).toEqual(["1. one", "2. two", "", "- [ ] 3. three"]);
  });

  it("唯一一项 → 只剩 `- [ ] 1. only`", () => {
    const res = liftListLineToTask("1. only", 3)!;
    expect(linesOf(res.replacement)).toEqual(["- [ ] 1. only"]);
  });

  it("起始非 1（3./4./5.）→ 任务项 4.，后段保持 5.", () => {
    const text = ["3. a", "4. b", "5. c"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1))!;
    expect(linesOf(res.replacement)).toEqual(["3. a", "", "- [ ] 4. b", "", "5. c"]);
  });

  it("`)` 分隔符保留", () => {
    const text = ["1) a", "2) b", "3) c"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1))!;
    expect(linesOf(res.replacement)).toEqual(["1) a", "", "- [ ] 2) b", "", "3) c"]);
  });

  it("无序列表：断成两段，任务行不带序号", () => {
    const text = ["- aa", "- bb", "- cc"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1))!;
    expect(linesOf(res.replacement)).toEqual(["- aa", "", "- [ ] bb", "", "- cc"]);
  });

  it("caretPos 精确落在任务行末尾（可直接继续输入）", () => {
    const text = ["intro", "1. one", "2. two", "3. three"].join("\n");
    const cursorPos = caretInLine(text, 2);
    const res = liftListLineToTask(text, cursorPos)!;
    const after = cursorPos + res.cursorOffset;
    expect(res.replacement.slice(0, after).endsWith("- [ ] 2. two")).toBe(true);
    expect(res.replacement[after]).toBe("\n");
  });

  it("非列表行 → null（调用方回退到既有的「插入空任务项」）", () => {
    for (const text of ["普通段落", "# 标题", "", "> 引用", "```\ncode\n```"]) {
      expect(liftListLineToTask(text, Math.min(2, text.length))).toBeNull();
    }
  });

  it("已经是任务项（`- [ ]` / `- [x]` / `* [X]`）→ null（不重复转换）", () => {
    for (const text of ["- [ ] done", "- [x] done", "* [X] done"]) {
      expect(liftListLineToTask(text, 3)).toBeNull();
    }
  });

  it("0~3 空格缩进的列表行也被识别，任务行沿用原缩进", () => {
    const text = ["   1. aa", "   2. bb"].join("\n");
    const res = liftListLineToTask(text, caretInLine(text, 1))!;
    expect(linesOf(res.replacement)).toEqual(["   1. aa", "", "   - [ ] 2. bb"]);
  });

  it("输出是合法 markdown：解析后再序列化必须原样往返", () => {
    const cases: Array<[string, number]> = [
      ["1. one\n2. two\n3. three", 1],
      ["1. one\n2. two\n3. three", 0],
      ["3. a\n4. b\n5. c", 1],
      ["1) a\n2) b\n3) c", 1],
      ["- aa\n- bb\n- cc", 1],
    ];
    for (const [text, line] of cases) {
      const res = liftListLineToTask(text, caretInLine(text, line))!;
      const back = docToMarkdown(markdownToDoc(res.replacement + "\n")).replace(/\n+$/, "");
      expect(back, `往返不一致：${text}`).toBe(res.replacement.replace(/\n+$/, ""));
    }
  });
});

describe("R4 · 跨模式一致性：同一输入 → 阅读模式与源码模式语义相同", () => {
  it("7 种边界：两模式归一化后文本完全相同", () => {
    const cases: Array<{ md: string; pmIndex: number; srcLine: number }> = [
      { md: "1. aa\n2. bb\n3. cc\n", pmIndex: 0, srcLine: 0 },
      { md: "1. aa\n2. bb\n3. cc\n", pmIndex: 1, srcLine: 1 },
      { md: "1. aa\n2. bb\n3. cc\n", pmIndex: 2, srcLine: 2 },
      { md: "1. only\n", pmIndex: 0, srcLine: 0 },
      { md: "3. aa\n4. bb\n5. cc\n", pmIndex: 1, srcLine: 1 },
      { md: "1) aa\n2) bb\n3) cc\n", pmIndex: 1, srcLine: 1 },
      { md: "- aa\n- bb\n- cc\n", pmIndex: 1, srcLine: 1 },
    ];
    for (const c of cases) {
      const doc = markdownToDoc(c.md);
      const { doc: pmNext } = liftAt(doc, itemTextPos(doc, 0, c.pmIndex));
      const pmText = docToMarkdown(pmNext);
      const stripped = c.md.replace(/\n$/, "");
      const res = liftListLineToTask(stripped, caretInLine(stripped, c.srcLine));
      expect(res, `源码模式未处理：${c.md}`).not.toBeNull();
      expect(norm(res!.replacement), `跨模式不一致：${c.md}`).toBe(norm(pmText));
    }
  });
});

// ═══════════════════════ 接线（源码契约锁） ═══════════════════════

describe("接线契约（jsdom 无法跑完整源码模式链路，故锁源码）", () => {
  const containerSrc = readFileSync("src/components/editor/EditorContainerSource.ts.txt", "utf-8");
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
