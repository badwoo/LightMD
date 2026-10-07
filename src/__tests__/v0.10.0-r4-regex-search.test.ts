/**
 * R4（v0.10.0）：搜索替换支持正则与捕获组
 *
 * 1. 正则开关关闭 → 字面量行为回归（v0.4.2 既有语义不变）
 * 2. 正则开关开启 → 元字符按正则语义匹配（两条路径共用同一纯函数）
 * 3. 替换支持 $1 捕获组（textarea 与 PM 两条路径共用同一替换展开函数）
 * 4. 非法正则 → 返回 null（组件据此红字提示、禁用查找，不崩溃）
 */
import { describe, it, expect } from "vitest";
import {
  buildSearchRegex,
  findMatchRanges,
  findMatches,
  expandReplacement,
} from "../components/editor/SearchReplace";

describe("R4: buildSearchRegex", () => {
  it("关闭正则时元字符被转义（字面量语义）", () => {
    const re = buildSearchRegex("a.b", false, false);
    expect(re).not.toBeNull();
    expect(re!.test("a.b")).toBe(true);
    expect(re!.test("axb")).toBe(false);
  });

  it("开启正则时元字符生效", () => {
    const re = buildSearchRegex("\\d+", false, true);
    expect(re).not.toBeNull();
    expect(re!.test("abc 123")).toBe(true);
  });

  it("非法正则返回 null（不抛异常）", () => {
    expect(buildSearchRegex("[", false, true)).toBeNull();
    expect(buildSearchRegex("a)**", false, true)).toBeNull();
  });

  it("大小写开关贯通两种模式", () => {
    expect(buildSearchRegex("ABC", false, false)!.test("abc")).toBe(true);
    expect(buildSearchRegex("ABC", true, false)!.test("abc")).toBe(false);
    expect(buildSearchRegex("A\\w+", false, true)!.test("abc")).toBe(true);
    expect(buildSearchRegex("A\\w+", true, true)!.test("abc")).toBe(false);
  });
});

describe("R4: findMatchRanges", () => {
  it("正则模式返回变长匹配区间", () => {
    const ranges = findMatchRanges("ab12cd345", "\\d+", false, true);
    expect(ranges).toEqual([
      { start: 2, end: 4 },
      { start: 6, end: 9 },
    ]);
  });

  it("字面量模式区间长度等于关键词长度", () => {
    const ranges = findMatchRanges("hello world hello", "hello", false, false);
    expect(ranges).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 17 },
    ]);
  });

  it("非法正则返回 null", () => {
    expect(findMatchRanges("abc", "[", false, true)).toBeNull();
  });

  it("空匹配防死循环（zero-length match）", () => {
    const ranges = findMatchRanges("abc", "x*", false, true);
    // "x*" 在每处都产生零长匹配，不得死循环；允许跳过零长匹配
    expect(Array.isArray(ranges)).toBe(true);
  });

  it("空关键词返回空数组", () => {
    expect(findMatchRanges("abc", "", false, true)).toEqual([]);
    expect(findMatchRanges("abc", "", false, false)).toEqual([]);
  });
});

describe("R4: findMatches 兼容层", () => {
  it("默认（关闭正则）保持 v0.4.2 字面量语义", () => {
    expect(findMatches("a.b axb", "a.b")).toEqual([0]);
    expect(findMatches("abc", "abc")).toEqual([0]);
    expect(findMatches("abc", "xyz")).toEqual([]);
    expect(findMatches("abc", "")).toEqual([]);
  });

  it("开启正则时返回匹配起点", () => {
    expect(findMatches("ab12cd345", "\\d+", false, true)).toEqual([2, 6]);
  });

  it("非法正则返回空数组（组件层另行提示）", () => {
    expect(findMatches("abc", "[", false, true)).toEqual([]);
  });
});

describe("R4: expandReplacement（$1 捕获组展开）", () => {
  it("正则模式下 $1/$2 展开为捕获组内容", () => {
    const re = buildSearchRegex("(\\d+)\\.(\\w+)", false, true)!;
    expect(expandReplacement("12.abc", re, "$2-$1", true)).toBe("abc-12");
  });

  it("字面量模式下 $1 原样输出（不展开）", () => {
    const re = buildSearchRegex("abc", false, false)!;
    expect(expandReplacement("abc", re, "$1", true)).toBe("$1");
  });

  it("正则模式 $& 引用整个匹配", () => {
    const re = buildSearchRegex("\\d+", false, true)!;
    expect(expandReplacement("42", re, "[$&]", true)).toBe("[42]");
  });
});

describe("R4: 替换全流程（模拟 PM 路径逐 match 展开语义）", () => {
  it("逐 match 用 expandReplacement 展开 $1（PM 路径从后往前替换语义）", () => {
    const text = "12.abc 34.def";
    const re = buildSearchRegex("(\\d+)\\.(\\w+)", false, true)!;
    const ranges = findMatchRanges(text, "(\\d+)\\.(\\w+)", false, true)!;
    // PM 路径：每个 match 区间取匹配文本 → expandReplacement 展开捕获组
    const replacements = ranges.map((r) =>
      expandReplacement(text.slice(r.start, r.end), re, "$2: $1", true),
    );
    expect(replacements).toEqual(["abc: 12", "def: 34"]);
  });
});
