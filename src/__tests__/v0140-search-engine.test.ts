/**
 * v0.14.0 需求2：searchEngine 纯函数层单测（node 环境，无 DOM）
 *
 * 覆盖：
 * - 全词匹配（含中文/下划线/数字边界，明确写出期望值，不做"大概不匹配"的模糊断言）
 * - 匹配大小写 / 正则 + 全词组合 / 非法正则
 * - 范围过滤（完全落在范围内才算命中）
 * - shiftRange / applyReplacementToRange 的边界情形（含替换恰好覆盖范围起点/终点）
 * - collectFileResults：多行、单行多命中、CRLF、超长行裁剪、截断标志
 * - clipLineForDisplay：裁剪后高亮偏移仍与文本对齐
 * - buildOffsetMap / lookupPmPos / pmPosToTextOffset 与旧实现一致
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import {
  buildSearchRegexEx,
  findMatchRangesEx,
  shiftRange,
  applyReplacementToRange,
  collectFileResults,
  clipLineForDisplay,
  buildOffsetMap,
  lookupPmPos,
  pmPosToTextOffset,
  normalizeNewlines,
  buildRawOffsetMap,
  rawOffsetToNormalized,
  resolveJumpOffset,
  resolveJumpByOccurrence,
  MAX_FILE_RESULTS,
  type MatchRange,
  type OffsetBlock,
} from "../utils/searchEngine";

// ─── 全词匹配 ─────────────────────────────────────────────

describe("v0.14.0 buildSearchRegexEx：全词匹配", () => {
  const ranges = (text: string, q: string, opts = {}) =>
    findMatchRangesEx(text, q, { wholeWord: true, caseSensitive: true, ...opts }) ?? [];

  it("cat 不匹配 concat / cats（英文词边界）", () => {
    expect(ranges("cat", "cat")).toEqual([{ start: 0, end: 3 }]);
    expect(ranges("concat", "cat")).toEqual([]);
    expect(ranges("cats", "cat")).toEqual([]);
    expect(ranges("the cat sat", "cat")).toEqual([{ start: 4, end: 7 }]);
  });

  it("下划线算词字符：cat 不匹配 cat_x，但匹配 cat-x", () => {
    expect(ranges("cat_x", "cat")).toEqual([]);
    expect(ranges("cat-x", "cat")).toEqual([{ start: 0, end: 3 }]);
  });

  it("数字算词字符：cat 不匹配 cat1，但匹配 cat 1", () => {
    expect(ranges("cat1", "cat")).toEqual([]);
    expect(ranges("1 cat", "cat")).toEqual([{ start: 2, end: 5 }]);
  });

  it("中文按 \\p{L} 处理：「测试」不匹配「我的测试」内部，但匹配独立的「测试」", () => {
    // 「我的测试」中「测试」左侧是「的」（\\p{L}）→ 不算整词
    expect(ranges("我的测试", "测试")).toEqual([]);
    // 空格分隔 → 两侧都不是词字符 → 命中
    expect(ranges("我的 测试 用例", "测试")).toEqual([{ start: 3, end: 5 }]);
    // 标点分隔同样命中
    expect(ranges("（测试）", "测试")).toEqual([{ start: 1, end: 3 }]);
  });

  it("关闭全词时恢复子串匹配（默认行为不变）", () => {
    expect(findMatchRangesEx("concat", "cat", { wholeWord: false })).toEqual([{ start: 3, end: 6 }]);
    expect(findMatchRangesEx("concat", "cat")).toEqual([{ start: 3, end: 6 }]);
  });

  it("全词匹配 + 正则：\\d+ 只认独立的数字段", () => {
    expect(findMatchRangesEx("a1 123 b", "\\d+", { wholeWord: true, useRegex: true })).toEqual([
      { start: 3, end: 6 },
    ]);
  });

  it("全词匹配 + 正则 + 或分支：断言作用于整体而不是分支局部", () => {
    // 「cat|dog」若不整体包裹会变成 (?<!w)cat|dog(?!w)，导致 dog 左侧无约束，
    // 于是 "dogs" 里的 "dog" 会被误判为整词。整体包裹后只有独立的 cat 命中。
    // 下标：concat(0..5) space(6) dogs(7..10) space(11) cat(12..14)
    const r = findMatchRangesEx("concat dogs cat", "cat|dog", { wholeWord: true, useRegex: true });
    expect(r).toEqual([{ start: 12, end: 15 }]);
  });

  it("全词匹配不改变匹配长度（零宽断言不进食字符）", () => {
    expect(findMatchRangesEx("the cat sat", "cat", { wholeWord: true })).toEqual([{ start: 4, end: 7 }]);
  });

  it("全词模式下的字面量大括号不抛异常（u 模式恒等转义坑）", () => {
    // 关闭正则时 `{` 是字面量；全词模式会开 u 标志，若把字面量原样传进 u 模式会语法错误
    expect(buildSearchRegexEx("{a}", { wholeWord: true })).not.toBeNull();
    expect(findMatchRangesEx("x {a} y", "{a}", { wholeWord: true })).toEqual([{ start: 2, end: 5 }]);
  });
});

// ─── 大小写 / 非法正则 ────────────────────────────────────

describe("v0.14.0 buildSearchRegexEx：大小写与非法表达式", () => {
  it("默认大小写不敏感", () => {
    expect(findMatchRangesEx("Abc abc", "abc")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it("caseSensitive 只命中大小写完全一致处", () => {
    expect(findMatchRangesEx("Abc abc", "abc", { caseSensitive: true })).toEqual([{ start: 4, end: 7 }]);
  });

  it("非法正则返回 null（不抛异常）", () => {
    expect(buildSearchRegexEx("[", { useRegex: true })).toBeNull();
    expect(findMatchRangesEx("abc", "[", { useRegex: true })).toBeNull();
  });

  it("空关键词返回空数组", () => {
    expect(findMatchRangesEx("abc", "")).toEqual([]);
  });

  it("零长匹配不死循环（x* 全篇零长 → 全部跳过）", () => {
    const r = findMatchRangesEx("abc", "x*", { useRegex: true });
    expect(r).toEqual([]);
  });
});

// ─── 范围过滤 ─────────────────────────────────────────────

describe("v0.14.0 findMatchRangesEx：选取范围内过滤", () => {
  // 下标：foo(0..2) space(3) bar(4..6) space(7) foo(8..10) space(11) baz(12..14) space(15) foo(16..18)
  const text = "foo bar foo baz foo";

  it("只保留完全落在范围内的命中", () => {
    // 范围 [8, 15) = "foo baz"：只完整包含第二个 foo（第三个 foo 起点 16 越界）
    expect(findMatchRangesEx(text, "foo", { range: { start: 8, end: 15 } })).toEqual([{ start: 8, end: 11 }]);
  });

  it("跨越范围边界的命中不算命中", () => {
    // 范围 [9, 16)：第二个 foo 起点 8 < 9（起点越界），第三个 foo 终点 19 > 16（终点越界）
    expect(findMatchRangesEx(text, "foo", { range: { start: 9, end: 16 } })).toEqual([]);
    // 范围 [8, 10)：foo 覆盖 8..11，终点越界 → 不算命中
    expect(findMatchRangesEx(text, "foo", { range: { start: 8, end: 10 } })).toEqual([]);
  });

  it("空范围 {0,0} 让任何非零长匹配都不命中（无选区时的语义）", () => {
    expect(findMatchRangesEx(text, "foo", { range: { start: 0, end: 0 } })).toEqual([]);
  });

  it("range 为 null/undefined 时不加约束", () => {
    expect(findMatchRangesEx(text, "foo", { range: null })!.length).toBe(3);
    expect(findMatchRangesEx(text, "foo")!.length).toBe(3);
  });

  it("范围正好等于整个文本 → 全部命中", () => {
    expect(findMatchRangesEx(text, "foo", { range: { start: 0, end: text.length } })!.length).toBe(3);
  });
});

// ─── 范围平移 ─────────────────────────────────────────────

describe("v0.14.0 shiftRange / applyReplacementToRange", () => {
  /** 按区间替换后手动模拟文本，用于交叉验证平移结果 */
  const applyEdit = (text: string, at: number, removed: number, inserted: string) =>
    text.slice(0, at) + inserted + text.slice(at + removed);

  it("① 纯插入发生在范围内：起点不变、终点右移", () => {
    expect(shiftRange({ start: 5, end: 15 }, 10, 0, 3)).toEqual({ start: 5, end: 18 });
  });

  it("② 纯删除发生在范围内：起点不变、终点左移", () => {
    expect(shiftRange({ start: 5, end: 15 }, 10, 4, 0)).toEqual({ start: 5, end: 11 });
  });

  it("③ 替换发生在范围之前：范围整体平移 delta", () => {
    // 范围 [10,20)，在 0 处删2增1（delta -1）→ [9,19)
    expect(shiftRange({ start: 10, end: 20 }, 0, 2, 1)).toEqual({ start: 9, end: 19 });
  });

  it("④ 替换发生在范围之后：范围完全不动", () => {
    expect(shiftRange({ start: 10, end: 20 }, 30, 5, 2)).toEqual({ start: 10, end: 20 });
  });

  it("⑤ 替换正好从范围起点开始：起点粘住不动，终点按 delta 伸缩", () => {
    // 范围 [10,20)，替换 [10,13) 为 1 个字符 → 范围 [10,18)
    expect(shiftRange({ start: 10, end: 20 }, 10, 3, 1)).toEqual({ start: 10, end: 18 });
    // 替换文本更长：范围罩住全部替换文本
    expect(shiftRange({ start: 10, end: 20 }, 10, 3, 8)).toEqual({ start: 10, end: 25 });
  });

  it("⑥ 替换正好覆盖范围终点：终点贴回替换文本末尾", () => {
    // 范围 [10,20)，替换 [17,23) 为 "xy"（长度2，delta -4）
    // start 10 在替换点前不动；end 20 落在被删区间内 → 收到 17+2=19
    expect(shiftRange({ start: 10, end: 20 }, 17, 6, 2)).toEqual({ start: 10, end: 19 });
  });

  it("⑦ 替换完全覆盖整个范围：范围塌陷成替换文本本身", () => {
    // 范围 [10,20)，替换 [5,30) 为 4 个字符 → start/end 都落在被删区间内 → [5,9)
    // （起点 10 > editStart 5 且 < removedEnd 30 → 收敛到 editStart+insertedLen=9）
    expect(shiftRange({ start: 10, end: 20 }, 5, 25, 4)).toEqual({ start: 9, end: 9 });
  });

  it("⑧ 替换紧贴在范围起点左侧结束：范围整体按 delta 平移", () => {
    // 范围 [10,20)，替换 [5,10) 为 3 字符（delta -2）
    // end 正好等于 removedEnd → 走「右移分支」→ start/end 同时 -2
    expect(shiftRange({ start: 10, end: 20 }, 5, 5, 3)).toEqual({ start: 8, end: 18 });
  });

  it("applyReplacementToRange 与 shiftRange 同语义，且在真实文本上自洽", () => {
    const text = "0123456789ABCDEFGHIJ"; // 范围取 [4,14) = "456789ABCD"
    const range: MatchRange = { start: 4, end: 14 };
    // 替换范围内 [8,10) 的 "89" 为 "XYZW"
    const removed = 2;
    const inserted = "XYZW";
    const next = applyEdit(text, 8, removed, inserted);
    const shifted = applyReplacementToRange(range, 8, removed, inserted.length);
    // 平移后的区间在**新文本**上切出来的内容，应等于替换后的范围语义
    expect(next.slice(shifted.start, shifted.end)).toBe("4567XYZWABCD");
  });

  it("替换后区间始终满足 end >= start（替换文本被删空时的安全底线）", () => {
    const r = shiftRange({ start: 5, end: 5 }, 3, 4, 0);
    expect(r.end).toBeGreaterThanOrEqual(r.start);
  });
});

// ─── 换行归一化 / 原始偏移换算 ────────────────────────────

describe("v0.14.0 换行归一化与原始偏移换算", () => {
  it("normalizeNewlines 把 CRLF / CR 都变成 LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeNewlines("plain")).toBe("plain");
  });

  it("无 \\r 时 buildRawOffsetMap 返回 null（零开销快路径）", () => {
    expect(buildRawOffsetMap("abc")).toBeNull();
  });

  it("buildRawOffsetMap 把归一化偏移映射回原始串", () => {
    const raw = "a\r\nb\rc"; // 原始: a \r \n b \r c；归一化: a \n b \n c
    const map = buildRawOffsetMap(raw)!;
    // 归一化偏移 2（'b'）对应原始偏移 3
    expect(map[2]).toBe(3);
    // 归一化偏移 4（'c'）对应原始偏移 5
    expect(map[4]).toBe(5);
    expect(map[5]).toBe(raw.length);
  });

  it("rawOffsetToNormalized 是 buildRawOffsetMap 的逆运算", () => {
    const raw = "a\r\nb\rc";
    const map = buildRawOffsetMap(raw)!;
    for (let norm = 0; norm <= raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").length; norm++) {
      expect(rawOffsetToNormalized(raw, map[norm])).toBe(norm);
    }
  });
});

// ─── clipLineForDisplay ───────────────────────────────────

describe("v0.14.0 clipLineForDisplay：超长行裁剪", () => {
  it("短行原样返回，高亮偏移不变", () => {
    const r = clipLineForDisplay("hello world", 6, 11, 160);
    expect(r.displayText).toBe("hello world");
    expect(r.displayMatchStart).toBe(6);
    expect(r.displayMatchEnd).toBe(11);
    expect(r.clippedHead).toBe(false);
  });

  it("超长行以命中处为中心裁剪，裁剪后高亮恰好等于关键词", () => {
    const line = "x".repeat(300) + "KEYWORD" + "y".repeat(300);
    const r = clipLineForDisplay(line, 300, 307, 40);
    expect(r.displayText.length).toBeLessThanOrEqual(42); // 40 + 两个省略号
    expect(r.displayText).toContain("KEYWORD");
    expect(r.displayText.slice(r.displayMatchStart, r.displayMatchEnd)).toBe("KEYWORD");
    expect(r.clippedHead).toBe(true);
  });

  it("命中在行首时头部不裁（不产生前导省略号）", () => {
    const line = "KEYWORD" + "y".repeat(500);
    const r = clipLineForDisplay(line, 0, 7, 40);
    expect(r.clippedHead).toBe(false);
    expect(r.displayText.startsWith("KEYWORD")).toBe(true);
    expect(r.displayText.slice(r.displayMatchStart, r.displayMatchEnd)).toBe("KEYWORD");
  });

  it("命中在行尾时尾部不裁（不产生尾部省略号）", () => {
    const line = "x".repeat(500) + "KEYWORD";
    const r = clipLineForDisplay(line, 500, 507, 40);
    expect(r.displayText.endsWith("KEYWORD")).toBe(true);
    expect(r.displayText.slice(r.displayMatchStart, r.displayMatchEnd)).toBe("KEYWORD");
  });
});

// ─── collectFileResults ───────────────────────────────────

describe("v0.14.0 collectFileResults：多文件结果", () => {
  const meta = { fileKey: "f1", filePath: "D:/docs/a.md", fileName: "a.md" };

  it("每行一条结果，同一行多处命中合并并全部高亮", () => {
    const content = "foo foo bar\nbaz\nfoo";
    const { results, truncated, matchCount } = collectFileResults(content, { query: "foo" }, meta);
    expect(truncated).toBe(false);
    expect(matchCount).toBe(3);
    expect(results.length).toBe(2);
    // 第一行：两处命中都在 ranges 里，segments 里有两个高亮段
    expect(results[0].line).toBe(1);
    expect(results[0].column).toBe(1);
    expect(results[0].ranges).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    const marks = results[0].segments.filter((s) => s.match);
    expect(marks.map((s) => s.text)).toEqual(["foo", "foo"]);
    // segments 拼接必须无损还原显示行文本
    expect(results[0].segments.map((s) => s.text).join("")).toBe(results[0].lineText);
    // 第三行
    expect(results[1].line).toBe(3);
    expect(results[1].column).toBe(1);
  });

  it("命中在行中间时 column 是 1 基列号", () => {
    const { results } = collectFileResults("abc KEY xyz", { query: "KEY" }, meta);
    expect(results[0].line).toBe(1);
    expect(results[0].column).toBe(5);
    expect(results[0].matchStart).toBe(4);
    expect(results[0].matchEnd).toBe(7);
  });

  it("CRLF 内容行号与列号正确（\\r 不污染列号）", () => {
    const { results } = collectFileResults("aa\r\nbb KEY\r\ncc", { query: "KEY" }, meta);
    expect(results.length).toBe(1);
    expect(results[0].line).toBe(2);
    expect(results[0].column).toBe(4);
    expect(results[0].lineText).toBe("bb KEY");
  });

  it("超长行裁剪后 matchStart/matchEnd 落在裁剪后的显示文本上", () => {
    const longLine = "p".repeat(400) + "NEEDLE" + "q".repeat(400);
    const { results } = collectFileResults(longLine, { query: "NEEDLE" }, meta);
    expect(results.length).toBe(1);
    expect(results[0].lineText.length).toBeLessThanOrEqual(162);
    expect(results[0].lineText.slice(results[0].matchStart, results[0].matchEnd)).toBe("NEEDLE");
    // ranges 是「原文该行内」的偏移，不受裁剪影响
    expect(results[0].ranges).toEqual([{ start: 400, end: 406 }]);
  });

  it("全词/大小写/正则选项在文件结果里同样生效", () => {
    const content = "concat cat\nCat cats";
    // 忽略大小写 + 全词：第 1 行 "cat"、第 2 行 "Cat" 各一处（concat/cats 不是整词）
    expect(collectFileResults(content, { query: "cat", wholeWord: true }, meta).matchCount).toBe(2);
    // 区分大小写 + 全词：只剩第 1 行的 "cat"
    expect(
      collectFileResults(content, { query: "cat", wholeWord: true, caseSensitive: true }, meta).matchCount,
    ).toBe(1);
    expect(
      collectFileResults(content, { query: "Cat", wholeWord: true, caseSensitive: true }, meta).results[0].line,
    ).toBe(2);
    // 正则 "c.t"：concat(con**cat**) / cat / Cat / cats 各一处
    expect(collectFileResults(content, { query: "c.t", useRegex: true }, meta).matchCount).toBe(4);
  });

  it("超过 MAX_FILE_RESULTS 行时置 truncated 标志", () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_FILE_RESULTS + 20; i++) lines.push("hit");
    const { results, truncated } = collectFileResults(lines.join("\n"), { query: "hit" }, meta);
    expect(results.length).toBe(MAX_FILE_RESULTS);
    expect(truncated).toBe(true);
  });

  it("无命中返回空结果且不截断", () => {
    const r = collectFileResults("abc", { query: "zzz" }, meta);
    expect(r.results).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.matchCount).toBe(0);
  });

  it("空关键词返回空结果", () => {
    expect(collectFileResults("abc", { query: "" }, meta).results).toEqual([]);
  });

  it("fileKey/filePath/fileName 原样回填（条幅显示与跳转依赖）", () => {
    const { results } = collectFileResults("x hit", { query: "hit" }, meta);
    expect(results[0].fileKey).toBe("f1");
    expect(results[0].filePath).toBe("D:/docs/a.md");
    expect(results[0].fileName).toBe("a.md");
  });

  it("occurrence 是该行首个命中在文件全部命中中的 0 基序号（跨行累计）", () => {
    // 第 1 行两处、第 3 行一处 → occurrence 分别是 0 与 2
    const content = "hit hit\nnone\nhit";
    const { results } = collectFileResults(content, { query: "hit" }, meta);
    expect(results.length).toBe(2);
    expect(results[0].occurrence).toBe(0);
    expect(results[1].occurrence).toBe(2);
  });

  it("occurrence 在单行多命中时只标首个，后续可用 行内序号 推算", () => {
    const { results } = collectFileResults("hit hit hit", { query: "hit" }, meta);
    expect(results.length).toBe(1);
    expect(results[0].occurrence).toBe(0);
    expect(results[0].ranges.length).toBe(3);
  });
});

// ─── 跨文本空间跳转（occurrence 定位）─────────────────────

describe("v0.14.0 resolveJumpByOccurrence：跨文本空间定位", () => {
  it("按 occurrence 取第 N 次出现（0 基）", () => {
    const text = "aaa bbb aaa ccc aaa";
    expect(resolveJumpByOccurrence(text, "aaa", 0)).toBe(0);
    expect(resolveJumpByOccurrence(text, "aaa", 1)).toBe(8);
    expect(resolveJumpByOccurrence(text, "aaa", 2)).toBe(16);
  });

  it("源码空间多次出现、渲染文本只合并成一处时，occurrence 越界仍能靠「唯一一处」兜底", () => {
    // 源码里 "链接" 出现 2 次，但渲染文本只有 1 次（模拟语法记号被吃掉后的合并）
    expect(resolveJumpByOccurrence("只有一处 链接 文本", "链接", 3)).toBe(5);
  });

  it("occurrence 越界且文本有多处 → 返回 null（不猜，交给调用方提示）", () => {
    expect(resolveJumpByOccurrence("aaa bbb aaa", "aaa", 5)).toBeNull();
  });

  it("文本里没有关键词 → null", () => {
    expect(resolveJumpByOccurrence("nothing here", "aaa", 0)).toBeNull();
  });

  it("空关键词 → null", () => {
    expect(resolveJumpByOccurrence("abc", "", 0)).toBeNull();
  });

  it("尊重大小写与全词选项（与搜索口径一致）", () => {
    const text = "Cat cat concat";
    // 区分大小写：只有下标 4 的小写 cat
    expect(resolveJumpByOccurrence(text, "cat", 0, { caseSensitive: true })).toBe(4);
    // 全词（大小写不敏感）：Cat(0) 与 cat(4) 两处，concat 里的不算
    expect(resolveJumpByOccurrence(text, "cat", 0, { wholeWord: true })).toBe(0);
    expect(resolveJumpByOccurrence(text, "cat", 1, { wholeWord: true })).toBe(4);
    // 只有 2 处 → occurrence 2 越界，且不唯一 → null
    expect(resolveJumpByOccurrence(text, "cat", 2, { wholeWord: true })).toBeNull();
  });

  it("忽略传入的 range（跨空间范围无意义）", () => {
    // 即使传了 range 也应无视，仍按全文 occurrence 定位
    expect(resolveJumpByOccurrence("aaa bbb aaa", "aaa", 1, { range: { start: 0, end: 3 } })).toBe(8);
  });

  it("正则模式下按 occurrence 定位（匹配长度可变）", () => {
    // 下标：n0 1→1，空格2，n3 2,2→4..6，空格6，n7 3,3,3→8..11
    const text = "n1 n22 n333";
    expect(resolveJumpByOccurrence(text, "\\d+", 0, { useRegex: true })).toBe(1);
    expect(resolveJumpByOccurrence(text, "\\d+", 1, { useRegex: true })).toBe(4);
    expect(resolveJumpByOccurrence(text, "\\d+", 2, { useRegex: true })).toBe(8);
  });
});

// ─── PM 偏移映射一致性 ────────────────────────────────────

/** 旧实现（从 SearchReplace.tsx / search-replace-offset.test.ts 抄来的历史版本），用于对照 */
function legacyBuildOffsetBlocks(doc: import("prosemirror-model").Node): OffsetBlock[] {
  const blocks: OffsetBlock[] = [];
  let textOffset = 0;
  let lastBlockPos = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (lastBlockPos >= 0) {
        textOffset += 1;
        lastBlockPos = -1;
      }
      blocks.push({ textStart: textOffset, textEnd: textOffset + node.text.length, pmStart: pos });
      textOffset += node.text.length;
    } else if (node.isBlock && !node.isInline && pos > 0) {
      lastBlockPos = pos;
    }
    return true;
  });
  return blocks;
}

describe("v0.14.0 buildOffsetMap / lookupPmPos 与旧实现一致", () => {
  const docs = ["hello world", "第一段\n\n第二段", "**粗体** 和 *斜体*", "# 标题\n\n- a\n- b\n\n> 引用"];

  it("blocks 与 text 与历史实现逐项一致", () => {
    for (const md of docs) {
      const doc = markdownToDoc(md);
      const map = buildOffsetMap(doc);
      const legacy = legacyBuildOffsetBlocks(doc);
      expect(map.blocks, `md=${md}`).toEqual(legacy);
      // text 长度必须等于最后一个块的 textEnd（同趟遍历、偏移自洽）
      if (map.blocks.length > 0) {
        expect(map.text.length).toBe(map.blocks[map.blocks.length - 1].textEnd);
      }
    }
  });

  it("lookupPmPos 在每个块内都能往返（text 偏移 ↔ PM 位置）", () => {
    const doc = markdownToDoc("第一段\n\n第二段");
    const map = buildOffsetMap(doc);
    for (const block of map.blocks) {
      for (let off = block.textStart; off < block.textEnd; off++) {
        expect(lookupPmPos(map.blocks, off)).toBe(block.pmStart + (off - block.textStart));
      }
    }
  });

  it("lookupPmPos 越界返回 undefined（历史行为）", () => {
    const map = buildOffsetMap(markdownToDoc("hello"));
    expect(lookupPmPos(map.blocks, 1000)).toBeUndefined();
  });

  it("pmPosToTextOffset 是 lookupPmPos 的逆运算（块内精确往返）", () => {
    const map = buildOffsetMap(markdownToDoc("第一段\n\n第二段"));
    for (const block of map.blocks) {
      for (let off = block.textStart; off < block.textEnd; off++) {
        expect(pmPosToTextOffset(map.blocks, lookupPmPos(map.blocks, off)!)).toBe(off);
      }
    }
  });

  it("pmPosToTextOffset 落在块间隙时收敛到前一块末尾（不吞换行）", () => {
    const map = buildOffsetMap(markdownToDoc("ab\n\ncd"));
    const first = map.blocks[0];
    // 段落之间的 PM 位置（第一块末尾之后）应收敛到第一块 textEnd
    expect(pmPosToTextOffset(map.blocks, first.pmStart + 2)).toBe(first.textEnd);
  });

  it("pmPosToTextOffset 对空 blocks / 早于首个文本块的 pmPos 返回 undefined", () => {
    expect(pmPosToTextOffset([], 5)).toBeUndefined();
    const map = buildOffsetMap(markdownToDoc("abc"));
    // 首个文本块起点之前（段落开标签位置 0）无法映射到任何字符 → undefined
    expect(pmPosToTextOffset(map.blocks, map.blocks[0].pmStart - 1)).toBeUndefined();
  });

  it("pmPosToTextOffset 对超出最后一块的 pmPos 收敛到最后一块末尾", () => {
    const map = buildOffsetMap(markdownToDoc("abc"));
    const last = map.blocks[map.blocks.length - 1];
    expect(pmPosToTextOffset(map.blocks, last.pmStart + 999)).toBe(last.textEnd);
  });
});

// ─── 跳转定位 ─────────────────────────────────────────────

describe("v0.14.0 resolveJumpOffset：命中定位", () => {
  const text = "line one\nline KEY two\nthree KEY";

  it("行列换算后正好等于关键词 → 直接采用", () => {
    // 第 2 行第 6 列起是 KEY（"line " 占 5 个字）
    expect(resolveJumpOffset(text, { line: 2, column: 6, query: "KEY" })).toBe(14);
  });

  it("列号有偏差时在该行内找关键词（CRLF/PM 换行差异的兜底）", () => {
    // 故意把 column 写错 3 格，仍应落在 KEY 上
    const offset = resolveJumpOffset(text, { line: 2, column: 9, query: "KEY" });
    expect(text.slice(offset, offset + 3)).toBe("KEY");
  });

  it("行内找不到时全文兜底", () => {
    const offset = resolveJumpOffset(text, { line: 2, column: 1, query: "three" });
    expect(text.slice(offset, offset + 5)).toBe("three");
  });

  it("大小写不敏感匹配", () => {
    expect(resolveJumpOffset("aaa KEY bbb", { line: 1, column: 1, query: "key" })).toBe(4);
  });

  it("行号越界时夹到最后一行而不是返回负数", () => {
    const offset = resolveJumpOffset(text, { line: 999, column: 1, query: "" });
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(text.length);
  });
});
