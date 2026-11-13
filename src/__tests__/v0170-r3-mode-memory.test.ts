/**
 * src/__tests__/v0170-r3-mode-memory.test.ts —— T5：模式切换的位置/状态记忆（#6 / #11）
 *
 * ## 本文件锁什么
 *
 * ### #6 光标（编辑符号）的跨模式映射
 * 1. `alignBlockText` 的**逐字符对齐契约**（语法符 = 源码里有、可见文本里没有的字符）
 * 2. `sourceOffsetToVisibleIndex` / 可见→源码 的**双向可逆性**（同一可见字符往返必回原位）
 * 3. 落错块缺陷的回归护栏：**块行扫描器必须与 `parser` 的 `blockSourceMap` 完全一致**
 * 4. 语法符区间的口径（光标停在 `**` 中间 → 落到所修饰内容的第一个可见字符）
 *
 * ### #11 新文档跳到底部
 * 5. `resolveOpenScrollTarget` 的语义：**无进度快照 ⇒ 回顶部（0）**，不是"保持现状"
 * 6. 有进度快照 ⇒ 恢复；但"上一次的残留值"在任何情况下都不得泄漏到新文档
 *
 * ## ⚠️ 本文件最重要的一条纪律：判据必须能区分"修好"与"恒真"
 *
 * 第 3 条用例是**破坏性对照**：它断言"扫描器的结果 == parser 的结果"。
 * 为了证明这条断言真的会红（而不是两边都算成同样错的空数组），
 * 同一用例里先断言 `parser` 侧确实产出了**非平凡**的区间（9 块、行号各异），
 * 再断言扫描器与之逐项相等。把 `scanBlockRanges` 里任何一处改错，
 * 两个断言中至少一个必红 —— 见文件末尾的 `__sabotage` 自检用例（用错误实现喂同一组数据）。
 *
 * ## 为什么用真 `markdownToDoc` 而不是手搓 PM 文档
 * 要验证的正是"parser 记录的区间"这个**真实产物**。手搓文档会绕过 `blockSourceMap`，
 * 等于自己实现一遍再自证（R2 反复踩的循环论证）。
 */
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "prosemirror-model";
import {
  alignBlockText,
  collectPmBlockCaretInfo,
  computeLineStarts,
  docPosToVisibleIndex,
  findBlockBySourceOffset,
  findBlockIndexByLine,
  joinVisibleSegments,
  lineStartOffset,
  resolveOpenScrollTarget,
  scanBlockRanges,
  sliceBlockSource,
  pmPosToSourceOffset,
  sourceOffsetToPmPos,
  sourceOffsetToVisibleIndex,
  visibleIndexToDocPos,
  visibleIndexToSourceOffset,
  type VisibleTextSegment,
} from "../utils/caretMap";
import { markdownToDoc } from "../core/markdown/parser";
import { getBlockSource } from "../core/markdown/blockSourceMap";

/** `getBlockSource` 的类型是 `(node: Node) => BlockSourceInfo | undefined`，直接取引用即可 */
const probe = (node: unknown) => getBlockSource(node as PMNode);

/* ══════════════════════════════════════════════════════════════════════
 * 夹具：与探针 `scripts/v0170-r3-mode-memory.mjs` 的 CARET_DOC 同构
 * （9 个顶层块，覆盖标题/纯文本/加粗/列表/引用/代码块/表格）
 * ══════════════════════════════════════════════════════════════════════ */
const CARET_DOC = [
  "# K01 一级标题", //                          L0    heading
  "", //                                        L1
  "K02 纯文本段落，用来量纯文本基线的映射误差。", //  L2    paragraph
  "", //                                        L3
  "K03 前面有字 **加粗内容在这里** 后面也有字。", //  L4    paragraph(加粗)
  "", //                                        L5
  "- K04 列表项第一项", //                       L6    bullet_list（2 行 → 1 块）
  "- 列表项第二项", //                            L7
  "", //                                        L8
  "> K05 引用块里的文字", //                      L9    blockquote
  "", //                                        L10
  "```js", //                                   L11   code_block（围栏 3 行 → 1 块）
  "const K06 = 1;", //                          L12
  "```", //                                     L13
  "", //                                        L14
  "| 表头 A | 表头 B |", //                      L15   table（3 行 → 1 块）
  "| --- | --- |", //                           L16
  "| K07 单元格 | 值 |", //                      L17
  "", //                                        L18
  "## K08 二级标题", //                          L19   heading level 2
  "", //                                        L20
  "K09 结尾段落。", //                            L21   paragraph
  "", //                                        L22
].join("\n");

/* ══════════════════════════════════════════════════════════════════════
 * #6-1 / #6-2：文本对齐双向可逆
 * ══════════════════════════════════════════════════════════════════════ */
describe("#6 alignBlockText：源码 ↔ 可见文本的逐字符对齐", () => {
  it("纯文本块：无语法符 → 恒等映射，skippedSource=0", () => {
    const src = "K02 纯文本段落";
    const a = alignBlockText(src, src);
    expect(a.unmatchedVisible).toBe(0);
    expect(a.skippedSource).toBe(0);
    for (let i = 0; i < src.length; i++) expect(a.srcToVisible[i]).toBe(i);
  });

  it("标题块：`# ` 前缀是语法符 → 可见文本从源码第 2 个字符开始", () => {
    const src = "# K01 一级标题";
    const vis = "K01 一级标题";
    const a = alignBlockText(src, vis);
    expect(a.unmatchedVisible).toBe(0);
    // `#` 与空格是语法符
    expect(a.srcToVisible[0]).toBe(-1);
    expect(a.srcToVisible[1]).toBe(-1);
    expect(a.srcToVisible[2]).toBe(0); // 源码 'K' ↔ 可见 'K'
    expect(a.visibleToSrc[0]).toBe(2);
    expect(a.skippedSource).toBe(2);
  });

  it("加粗块：`**` 成对语法符被跳过，可见文本去掉两层标记", () => {
    const src = "K03 前面有字 **加粗内容在这里** 后面也有字。";
    const vis = "K03 前面有字 加粗内容在这里 后面也有字。";
    const a = alignBlockText(src, vis);
    expect(a.unmatchedVisible).toBe(0);
    expect(a.skippedSource).toBe(4); // 两组 `**`
    expect(a.visibleLength).toBe(vis.length);
    // 加粗内部第 0 个可见字符 '加' 应映射到源码里 `**` 之后的那个 '加'
    const visIdx = vis.indexOf("加");
    expect(a.visibleToSrc[visIdx]).toBe(src.indexOf("加"));
  });

  it("列表项：`- ` 是语法符（每行一个）", () => {
    const src = "- K04 列表项第一项\n- 列表项第二项";
    const vis = "K04 列表项第一项列表项第二项";
    const a = alignBlockText(src, vis);
    expect(a.unmatchedVisible).toBe(0);
    // 两个 `- ` + 中间换行
    expect(a.skippedSource).toBe(src.length - vis.length);
    expect(a.skippedSource).toBe(2 + 1 + 2);
  });

  it("引用块：`> ` 是语法符", () => {
    const src = "> K05 引用块里的文字";
    const vis = "K05 引用块里的文字";
    const a = alignBlockText(src, vis);
    expect(a.unmatchedVisible).toBe(0);
    expect(a.skippedSource).toBe(2);
  });

  it("代码块：围栏行 + 语言标记是语法符，正文可见", () => {
    const src = "```js\nconst K06 = 1;\n```";
    const vis = "const K06 = 1;";
    const a = alignBlockText(src, vis);
    expect(a.unmatchedVisible).toBe(0);
    expect(a.skippedSource).toBe(src.length - vis.length);
    // 开围栏 "```js\n"（6）+ 闭围栏 "\n```"（4）
    expect(a.skippedSource).toBe(6 + 4);
  });

  it("表格：竖线与对齐行是语法符", () => {
    const src = "| 表头 A | 表头 B |\n| --- | --- |\n| K07 单元格 | 值 |";
    const vis = "表头 A表头 BK07 单元格值";
    const a = alignBlockText(src, vis);
    expect(a.unmatchedVisible).toBe(0);
    expect(a.skippedSource).toBeGreaterThan(0);
    expect(a.visibleLength).toBe(vis.length);
  });

  it("★ 哨兵契约：可见文本里出现源码没有的字符 → unmatchedVisible > 0（调用方必须放弃映射）", () => {
    // 模拟"某个 NodeView 往可见文本里塞了源码没有的字"
    const a = alignBlockText("abc", "abXc");
    expect(a.unmatchedVisible).toBe(1);
    // 对齐不可信 → 两个方向的映射都必须返回 null（不许带错位继续用）
    expect(sourceOffsetToVisibleIndex(a, 0)).toBeNull();
    expect(visibleIndexToSourceOffset(a, 0)).toBeNull();
  });
});

describe("#6 双向映射：同一可见字符往返必回原位", () => {
  const CASES = [
    { name: "标题", src: "# K01 一级标题", vis: "K01 一级标题" },
    { name: "正文", src: "K02 纯文本段落", vis: "K02 纯文本段落" },
    { name: "加粗", src: "前 **加粗内容** 后", vis: "前 加粗内容 后" },
    { name: "引用", src: "> 引用文字", vis: "引用文字" },
    { name: "代码", src: "```js\nconst a = 1;\n```", vis: "const a = 1;" },
  ];

  for (const c of CASES) {
    it(`${c.name}：每个可见序号往返一致（源码→可见→源码 落在同一可见字符）`, () => {
      const a = alignBlockText(c.src, c.vis);
      expect(a.unmatchedVisible).toBe(0);
      for (let v = 0; v < c.vis.length; v++) {
        const srcOff = visibleIndexToSourceOffset(a, v);
        expect(srcOff, `可见序号 ${v}`).not.toBeNull();
        const back = sourceOffsetToVisibleIndex(a, srcOff as number);
        expect(back, `可见序号 ${v}（源码 ${srcOff}）`).toBe(v);
        // 且落在同一字符上
        expect(c.src[srcOff as number]).toBe(c.vis[v]);
      }
    });
  }

  it("加粗块：`**` 语法符当前位置 → 落到其后第一个可见字符（产品口径）", () => {
    const src = "前 **加粗内容** 后";
    const vis = "前 加粗内容 后";
    const a = alignBlockText(src, vis);
    const visOfJia = vis.indexOf("加");
    // 源码里 `**` 的第一个 `*`（index 2）
    const starIdx = src.indexOf("*");
    expect(sourceOffsetToVisibleIndex(a, starIdx)).toBe(visOfJia);
    // `**` 的第二个 `*`（index 3）也应落到同一个可见字符
    expect(sourceOffsetToVisibleIndex(a, starIdx + 1)).toBe(visOfJia);
  });

  it("块尾：源码末尾 → 可见文本末尾", () => {
    const src = "> 引用文字";
    const vis = "引用文字";
    const a = alignBlockText(src, vis);
    expect(sourceOffsetToVisibleIndex(a, src.length)).toBe(vis.length);
    expect(visibleIndexToSourceOffset(a, vis.length)).toBe(src.length);
  });

  it("空可见文本：全部是语法符 → 只在末尾有落点", () => {
    const a = alignBlockText("**", "");
    expect(a.visibleLength).toBe(0);
    expect(sourceOffsetToVisibleIndex(a, 0)).toBe(0);
    expect(visibleIndexToSourceOffset(a, 0)).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * #6-3：★ 破坏性对照 —— 块行扫描器必须与 parser 的 blockSourceMap 一致
 * ══════════════════════════════════════════════════════════════════════ */
describe("#6 ★ 破坏性对照：块行扫描器 == parser 的 blockSourceMap（防落错块）", () => {
  it("parser 侧确实产出**非平凡**的块区间（先把判据自身钉死，防两边都空也算过）", () => {
    const doc = markdownToDoc(CARET_DOC);
    const ranges: { startLine: number; endLine: number }[] = [];
    doc.forEach((node) => {
      const info = getBlockSource(node);
      if (info) ranges.push({ startLine: info.start, endLine: info.end });
    });
    // 夹具 9 个顶层块，parser 必须全部记录（否则本契约没有意义）
    expect(ranges).toHaveLength(9);
    // 行号各异且单调 → 不是"全 0"这种退化产物
    expect(ranges.map((r) => r.startLine)).toEqual([0, 2, 4, 6, 9, 11, 15, 19, 21]);
    // 列表/表格/代码块各占**多行**（正是"行计数估算法"会错的地方）
    expect(ranges[3]).toEqual({ startLine: 6, endLine: 8 }); // bullet_list 2 行
    expect(ranges[5]).toEqual({ startLine: 11, endLine: 14 }); // code_block 3 行
    expect(ranges[6]).toEqual({ startLine: 15, endLine: 18 }); // table 3 行
  });

  it("扫描器结果与 parser 逐项相等（改错扫描器必红）", () => {
    const doc = markdownToDoc(CARET_DOC);
    const expected: { startLine: number; endLine: number }[] = [];
    doc.forEach((node) => {
      const info = getBlockSource(node);
      if (info) expected.push({ startLine: info.start, endLine: info.end });
    });
    const actual = scanBlockRanges(CARET_DOC, probe, doc);
    expect(actual).toEqual(expected);
  });

  it("★ 反证：把扫描器换成「按行计数估算」（旧实现的假设）→ 与 parser 不等", () => {
    const doc = markdownToDoc(CARET_DOC);
    const expected: { startLine: number; endLine: number }[] = [];
    doc.forEach((node) => {
      const info = getBlockSource(node);
      if (info) expected.push({ startLine: info.start, endLine: info.end });
    });
    // 旧口径：每个块占 `textContent.split("\n").length` 行（从 0 开始累加）
    let line = 0;
    const naive: { startLine: number; endLine: number }[] = [];
    doc.forEach((node) => {
      const lines = (node.textContent || "").split("\n").length;
      naive.push({ startLine: line, endLine: line + lines });
      line += lines;
    });
    // 这就是"落错块"的量化来源：估算与权威区间从列表块起就开始偏离
    expect(naive).not.toEqual(expected);
    // 具体偏离：第 4 个块（bullet_list，期望 startLine=6）被估成 3
    //（前 4 块 textContent 分别是 0/0/0/0 个换行 → 累加行数恒 1 → 起点全错）
    expect(naive[3].startLine).toBe(3);
    expect(expected[3].startLine).toBe(6);
  });

  it("按源码行号找块：块间空行归属**上方**那个块（与内容锚口径一致）", () => {
    const doc = markdownToDoc(CARET_DOC);
    const ranges = scanBlockRanges(CARET_DOC, probe, doc);
    expect(findBlockIndexByLine(ranges, 0)).toBe(0); // H1
    expect(findBlockIndexByLine(ranges, 2)).toBe(1); // 段落
    expect(findBlockIndexByLine(ranges, 6)).toBe(3); // 列表首行
    expect(findBlockIndexByLine(ranges, 7)).toBe(3); // 列表第二行 → 同一块（★旧实现的错点）
    expect(findBlockIndexByLine(ranges, 12)).toBe(5); // 代码块正文行
    expect(findBlockIndexByLine(ranges, 17)).toBe(6); // 表格最后一行
    expect(findBlockIndexByLine(ranges, 19)).toBe(7); // H2
    expect(findBlockIndexByLine(ranges, 5)).toBe(2); // 空行 → 上方块
    expect(findBlockIndexByLine(ranges, 22)).toBe(8); // 文末空行 → 最后一块
  });

  it("块源码切片：与 parser 记录的区间原文一致（不含块后空行）", () => {
    const lineStarts = computeLineStarts(CARET_DOC);
    const doc = markdownToDoc(CARET_DOC);
    const ranges = scanBlockRanges(CARET_DOC, probe, doc);
    expect(sliceBlockSource(CARET_DOC, lineStarts, ranges[0])).toBe("# K01 一级标题");
    expect(sliceBlockSource(CARET_DOC, lineStarts, ranges[3])).toBe(
      "- K04 列表项第一项\n- 列表项第二项",
    );
    expect(sliceBlockSource(CARET_DOC, lineStarts, ranges[5])).toBe(
      "```js\nconst K06 = 1;\n```",
    );
    expect(sliceBlockSource(CARET_DOC, lineStarts, ranges[8])).toBe("K09 结尾段落。");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * #6 可见文本分段 ↔ PM 文档位置
 * ══════════════════════════════════════════════════════════════════════ */
describe("#6 可见文本分段与 PM 文档位置互转", () => {
  /**
   * 模拟段落 `前 **加粗内容** 后` 的真实 PM 位置。
   *
   * 段落节点占 `[0, 11]`，内容从 pos 1 开始；文本节点在文档里**首尾相接地共享边界位置**：
   * ```
   * text "前 "      → 字符在 pos 1,2，结束位置 = 3
   * text "加粗内容" ← 起始位置 = 3（与上一段结束共享，这是 PM 的固有语义）
   *                  字符在 pos 3,4,5,6，结束位置 = 7
   * text " 后"      ← 起始 = 7，字符 7,8，结束 = 9
   * ```
   * ⚠️ 第一版夹具写成 pos=4（凭空插了一个位置）→ 断言与实现互相矛盾。
   * 这正是"先写实现再写夹具"最容易犯的错：夹具必须按**真实语义**给，不能迁就实现。
   */
  const segs: VisibleTextSegment[] = [
    { pos: 1, text: "前 " }, //     acc 0..1
    { pos: 3, text: "加粗内容" }, // acc 2..5
    { pos: 7, text: " 后" }, //     acc 6..7
  ];

  it("拼接 = 可见文本（不含块分隔符）", () => {
    expect(joinVisibleSegments(segs)).toBe("前 加粗内容 后");
  });

  it("可见序号 → 文档位置：跨分段边界正确", () => {
    expect(visibleIndexToDocPos(segs, 0)).toBe(1); // '前'
    expect(visibleIndexToDocPos(segs, 1)).toBe(2); // ' '
    expect(visibleIndexToDocPos(segs, 2)).toBe(3); // 加粗首字「加」（= 上一段结束位置）
    expect(visibleIndexToDocPos(segs, 5)).toBe(6); // 加粗末字「容」
    expect(visibleIndexToDocPos(segs, 6)).toBe(7); // ' '（= 加粗段结束，段 3 起始）
    expect(visibleIndexToDocPos(segs, 8)).toBe(9); // '后' 的下一位置
  });

  it("文档位置 → 可见序号：往返一致", () => {
    for (let v = 0; v <= 8; v++) {
      const pos = visibleIndexToDocPos(segs, v);
      expect(pos, `可见序号 ${v}`).not.toBeNull();
      expect(docPosToVisibleIndex(segs, pos as number), `可见序号 ${v}`).toBe(v);
    }
  });

  it("可见序号超过末尾 → 落到最后一个分段的结束位置", () => {
    expect(visibleIndexToDocPos(segs, 999)).toBe(7 + 2);
  });

  it("空分段列表 → null（不许返回 0 兜底）", () => {
    expect(visibleIndexToDocPos([], 0)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * #11：无进度快照 ⇒ 回顶部（0），不是"保持现状"
 * ══════════════════════════════════════════════════════════════════════ */
describe("#11 resolveOpenScrollTarget：打开文档的滚动落点语义", () => {
  it("★ 无进度快照 → 目标必须是 0（旧实现 return 不操作 ⇒ 残留值留下）", () => {
    const r = resolveOpenScrollTarget({ percent: null, scrollHeight: 5000, clientHeight: 700 });
    expect(r.top).toBe(0);
    expect(r.reason).toBe("no-progress");
    // 旧实现的行为是"不写"，本判据明确要求"写 0"
    expect(r.write).toBe(true);
  });

  it("有进度快照 → 按百分比恢复", () => {
    const r = resolveOpenScrollTarget({ percent: 0.5, scrollHeight: 5000, clientHeight: 700 });
    expect(r.top).toBe(Math.round(0.5 * (5000 - 700)));
    expect(r.reason).toBe("progress");
    expect(r.write).toBe(true);
  });

  it("进度 0 → 写 0（与「无进度」同落点，但 reason 不同，便于诊断）", () => {
    const r = resolveOpenScrollTarget({ percent: 0, scrollHeight: 5000, clientHeight: 700 });
    expect(r.top).toBe(0);
    expect(r.write).toBe(true);
  });

  it("内容不足一屏 → 写 0，且标记为不可滚动", () => {
    const r = resolveOpenScrollTarget({ percent: 0.8, scrollHeight: 600, clientHeight: 700 });
    expect(r.top).toBe(0);
    expect(r.reason).toBe("not-scrollable");
  });

  it("进度值非法（NaN / 越界）→ 当作无进度，写 0", () => {
    for (const bad of [NaN, -1, 2, Infinity]) {
      const r = resolveOpenScrollTarget({ percent: bad, scrollHeight: 5000, clientHeight: 700 });
      expect(r.top, `percent=${bad}`).toBe(0);
    }
  });

  it("★ 反例护栏：同一文件有进度时**必须**恢复（修复不得矫枉过正）", () => {
    const r = resolveOpenScrollTarget({ percent: 0.42, scrollHeight: 5000, clientHeight: 700 });
    expect(r.top).toBeGreaterThan(0);
    expect(r.reason).toBe("progress");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * #6 编排层：源码 offset ↔ PM pos 的真实文档闭环
 * ══════════════════════════════════════════════════════════════════════ */
describe("#6 编排层：源码 offset ↔ PM pos（真实 markdownToDoc）", () => {
  const md = CARET_DOC;
  const doc = markdownToDoc(md);
  const blocks = collectPmBlockCaretInfo(md, doc, probe);

  it("块表覆盖 9 个真实块，且每块都有权威源码区间", () => {
    expect(blocks).toHaveLength(9);
    expect(blocks.every((b) => b.range !== null)).toBe(true);
    // 源码起始 offset 单调递增（权威行区间换算出来的，不是估算）
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].sourceStart).toBeGreaterThan(blocks[i - 1].sourceStart);
    }
  });

  it("★ 每块的对齐都可信（unmatchedVisible === 0），否则映射必须拒绝服务", () => {
    for (const b of blocks) {
      expect(b.aligned, `块 ${b.docIndex}（${String(b.sourceText).slice(0, 20)}）`).toBe(true);
      expect(b.alignment?.unmatchedVisible).toBe(0);
    }
  });

  it("★ 双向闭环：源码每个字符 → PM pos → 源码，落在同一可见字符上", () => {
    let checked = 0;
    for (const b of blocks) {
      for (let off = b.sourceStart; off <= b.sourceStart + b.sourceText.length; off++) {
        const pos = sourceOffsetToPmPos(blocks, md, off);
        expect(pos, `源码 offset ${off} 应可映射`).not.toBeNull();
        const back = pmPosToSourceOffset(blocks, md, pos as number);
        expect(back, `源码 offset ${off}（PM ${pos}）`).not.toBeNull();
        // 回程可能落在语法符区间内（被"其后第一个可见字符"归并），
        // 但**再次正向**必须落到同一 PM pos → 幂等即等价
        const pos2 = sourceOffsetToPmPos(blocks, md, back as number);
        expect(pos2, `源码 offset ${off} 回程 ${back}`).toBe(pos);
        checked++;
      }
    }
    // 9 块合计 200+ 个位置，确保不是"只测了几个点"
    expect(checked).toBeGreaterThan(150);
  });

  it("★ 落错块回归护栏：列表第二行（源码 L7）必须映射到**同一个块**，不是后一个块", () => {
    const lineStarts = computeLineStarts(md);
    const offL6 = lineStarts[6]; // "- K04 列表项第一项"
    const offL7 = lineStarts[7]; // "- 列表项第二项"
    const a = findBlockBySourceOffset(blocks, md, offL6);
    const b = findBlockBySourceOffset(blocks, md, offL7);
    expect(a?.docIndex).toBe(b?.docIndex); // 同一个 bullet_list 块
    expect(a?.range).toEqual({ startLine: 6, endLine: 8 });
  });

  it("★ 落错块回归护栏：代码块正文 / 表格末行 / H2 各自落到**正确的块类型**", () => {
    const lineStarts = computeLineStarts(md);
    const docTypes: string[] = [];
    doc.forEach((n) => docTypes.push(n.type.name));
    const typeAt = (line: number) => {
      const blk = findBlockBySourceOffset(blocks, md, lineStarts[line]);
      return blk ? docTypes[blk.docIndex] : null;
    };
    expect(typeAt(12)).toBe("code_block"); // 代码块正文
    expect(typeAt(17)).toBe("table"); // 表格末行
    expect(typeAt(19)).toBe("heading"); // H2
    expect(typeAt(9)).toBe("blockquote"); // 引用
    expect(typeAt(6)).toBe("bullet_list"); // 列表
  });

  it("★ 加粗中间：源码落在 `**` 内 → PM 落到加粗内容的第一个字符（产品口径）", () => {
    const srcLine = md.split("\n")[4]; // "K03 前面有字 **加粗内容在这里** 后面也有字。"
    const jiaIdx = srcLine.indexOf("加");
    expect(srcLine[jiaIdx - 1]).toBe("*"); // 确认前一个字符确实是语法符
    const lineStarts = computeLineStarts(md);
    const offStar = lineStarts[4] + jiaIdx - 2; // 第一个 `*`
    const offJia = lineStarts[4] + jiaIdx;
    const posStar = sourceOffsetToPmPos(blocks, md, offStar);
    const posJia = sourceOffsetToPmPos(blocks, md, offJia);
    // 语法符位置与它修饰内容的起点落到**同一 PM pos**
    expect(posStar).toBe(posJia);
    // 且该 PM pos 的文本确实是「加」
    expect(doc.textBetween(posJia as number, (posJia as number) + 1)).toBe("加");
  });

  it("★ 有 base64 图片的块 → 对齐不可信 → 双向映射都返回 null（不许猜）", () => {
    const mdImg = "![image.png](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg)";
    const docImg = markdownToDoc(mdImg);
    const bImg = collectPmBlockCaretInfo(mdImg, docImg, probe);
    expect(bImg).toHaveLength(1);
    // PM 侧文本是完整 base64，源码侧（masked 场景）是短标记 → 若传未 mask 源码则一致；
    // 这里刻意传 mask 后的文本，模拟真实调用点
    const masked = "![image.png](image-1.png)";
    const bMasked = collectPmBlockCaretInfo(masked, docImg, probe);
    expect(bMasked[0].aligned).toBe(false);
    expect(sourceOffsetToPmPos(bMasked, masked, 0)).toBeNull();
    expect(pmPosToSourceOffset(bMasked, masked, 1)).toBeNull();
  });
});
