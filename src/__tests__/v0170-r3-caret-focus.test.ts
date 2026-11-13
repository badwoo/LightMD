/**
 * v0.17.0 第三轮 T1：`resolveFocusMeasureRange` 单测
 *
 * ## 这个函数存在的唯一理由（缺陷 #7）
 *
 * 用户原话：「以编辑符所在行为中心进行上下行一共 3 行进行高亮，并且跟随插入符号移动，
 * 当前在空白行情况下只高亮了两行。」
 *
 * 两个契约各自正确、组合起来错：
 * - `findFocusRowRange` 的 `[start, end)` 是**完整行**语义（`end` = 窗口末行之后那个
 *   `\n` 的**下标**，不含），区间内容形如 `"行1\n行2\n行3"`；
 * - `measureRangeContentY(start, end)` 是**字形矩形**语义，内部用 `coordsAtPos(end - 1)`
 *   取「区间最后一个字符」的 bottom。
 *
 * 于是当**窗口末行是空行**（无任何字符）时，`end - 1` 落到**上一行末尾的 `\n`** →
 * 拿到上一行行底 → **空行行盒一 px 都没被覆盖** = 用户说的"只亮两行"。
 *
 * ## 真值表怎么读（本文件的期望值全部由实现独立手算核实）
 *
 * 每个用例给「文档 + 光标」，先手算 `findFocusRowRange` 的区间，再断言翻译结果。
 * **关键断言是 `end` 的借位**：
 * - 末行为空行 → `end + 1`（让内部 `end-1` 落在那个 `\n` 上）
 * - 末行为末尾空行（无字符可借）→ `extendEndByLineHeight = true`
 * - 末行非空 → 原样透传（**负对照**：别把所有情况都借位了）
 *
 * 字符索引速查（`A\n\nB`）：A=0, `\n`=1, `\n`=2, B=3，长度 4。
 */
import { describe, it, expect } from "vitest";
import { findFocusRowRange, resolveFocusMeasureRange } from "../utils/focus-paragraph";

/** 便捷：把「文档 + 光标」跑完整流程，返回 spec 与两个关键下标 */
function run(text: string, cursor: number) {
  const range = findFocusRowRange(text, cursor, 1);
  const spec = resolveFocusMeasureRange(text, range);
  return {
    range,
    spec,
    /** 修复后 `measureRangeContentY` 实际会去测的「最后一个字符」下标（它内部用 end-1） */
    newLast: spec.end - 1,
    /** 修复前（直接把 range 喂进去）会测的下标 */
    oldLast: range.end - 1,
    rangeText: text.substring(range.start, range.end),
    measuredText: text.substring(spec.start, spec.end),
  };
}

describe("resolveFocusMeasureRange —— 末行为空行时必须借位（缺陷 #7 根因）", () => {
  it("★ 核心用例：`A␤␤B` 光标在第 1 行 → 窗口末行是空行 → end 借位 +1", () => {
    // 字符：A=0, \n=1, \n=2, B=3
    // 光标 pos=0（"A"）：
    //   向后第 1 个 \n 在 1、第 2 个在 2 → range.end = 2
    //   向前不足 2 个 \n → range.start = 0
    //   → 窗口 = [0,2) = "A\n"，覆盖「行0(A) + 行1(空)」，rows=2（向下已到底，上方收缩）
    const r = run("A\n\nB", 0);
    expect(r.range).toEqual({ start: 0, end: 2, rows: 2 });
    expect(r.rangeText).toBe("A\n");

    // 末行（行1）是空行 → 必须借位
    expect(r.spec.lastLineEmpty).toBe(true);
    expect(r.spec.end).toBe(3); // 2 → 3
    expect(r.spec.extendEndByLineHeight).toBe(false);

    // ★ 决定性：修复前测 end-1=1（行0 的换行 = 行0 行底），修复后测 end-1=2（空行行1 的行界）
    expect(r.oldLast).toBe(1);
    expect(r.newLast).toBe(2);
    expect(r.newLast).not.toBe(r.oldLast);
  });

  it("★ 主路径：markdown 段落间距（第一段 ␤ ␤ 第二段）", () => {
    // 第一段=0..2, \n=3, \n=4, 第二段从 5
    // 光标 pos=1 → 向后第 1 个 \n=3、第 2 个=4 → end=4；向前不足 → start=0
    // → 窗口 = [0,4) = "第一段\n"，末行是那个空行
    const r = run("第一段\n\n第二段", 1);
    expect(r.range).toEqual({ start: 0, end: 4, rows: 2 });
    expect(r.spec.lastLineEmpty).toBe(true);
    expect(r.spec.end).toBe(5);
    // 修复前测到 "第一段" 的行底（\n 在 3），修复后测到空行的行界（\n 在 4）
    expect(r.oldLast).toBe(3);
    expect(r.newLast).toBe(4);
    expect("第一段\n\n第二段"[r.newLast]).toBe("\n");
    expect("第一段\n\n第二段"[r.newLast + 1]).toBe("第");
  });

  it("普通三行全部非空 → 原样透传（负对照：不应借位）", () => {
    // aaa=0..2, \n=3, bbb=4..6, \n=7, ccc=8..10, \n=11, ddd=12..14
    // 光标 pos=5 → 向后第 1 个 \n=7、第 2 个=11 → end=11；向前不足 → start=0
    const r = run("aaa\nbbb\nccc\nddd", 5);
    expect(r.range).toEqual({ start: 0, end: 11, rows: 3 });
    expect(r.spec).toEqual({ start: 0, end: 11, extendEndByLineHeight: false, lastLineEmpty: false });
    // 负对照的实质：借位与否下标必须相同（否则说明实现对所有情况都 +1 了）
    expect(r.newLast).toBe(r.oldLast);
  });

  it("★ 相邻空行连成片（a␤␤b␤␤c）也正确借位", () => {
    // a=0, \n=1, \n=2, b=3, \n=4, \n=5, c=6
    // 光标 pos=3（"b"）→ 向后第 1 个 \n=4、第 2 个=5 → end=5
    //                     向前第 1 个 \n=2、第 2 个=1 → start=2
    const r = run("a\n\nb\n\nc", 3);
    expect(r.range).toEqual({ start: 2, end: 5, rows: 3 });
    expect(r.spec.lastLineEmpty).toBe(true);
    expect(r.spec.end).toBe(6);
    expect(r.oldLast).toBe(4); // "b" 的换行
    expect(r.newLast).toBe(5); // 空行的换行
  });
});

describe("resolveFocusMeasureRange —— 文档边界与越界护栏", () => {
  it("★ 末尾空行（文档以 \\n 结尾）→ 无字符可借位，标记 extendEndByLineHeight", () => {
    // "aaa\n"：行0 "aaa"=0..2，\n=3，行1 ""=4..4（末尾空行）
    // 光标 pos=1 → 向后第 1 个 \n=3、第 2 个没有 → end=len=4
    const r = run("aaa\n", 1);
    expect(r.range).toEqual({ start: 0, end: 4, rows: 2 });
    expect(r.spec.lastLineEmpty).toBe(true);
    expect(r.spec.end).toBe(4);                      // 不借位（end 已到文档末尾）
    expect(r.spec.extendEndByLineHeight).toBe(true); // 交给调用方补一行高
  });

  it("★ 单行文档（无换行）→ 不借位、不补行高", () => {
    const r = run("abc", 1);
    expect(r.range).toEqual({ start: 0, end: 3, rows: 1 });
    expect(r.spec).toEqual({ start: 0, end: 3, extendEndByLineHeight: false, lastLineEmpty: false });
  });

  it("★ 空文档 → [0,0)，不借位（end+1 会越界）", () => {
    const r = run("", 0);
    expect(r.range).toEqual({ start: 0, end: 0, rows: 1 });
    expect(r.spec).toEqual({ start: 0, end: 0, extendEndByLineHeight: false, lastLineEmpty: false });
  });

  it("★ 越界护栏不变式：遍历多种文档 × 所有光标位置，end 恒 ≤ len、借位恒 ≤ 1", () => {
    const docs = [
      "", "a", "a\n", "a\n\n", "a\n\nb", "\n", "\n\n", "a\n\nb\n\nc",
      "aaa\nbbb\nccc\nddd\n", "\n\n\n\n", "x\n\ny\n\n", "P1\n\nP2\n\nP3\n",
    ];
    for (const text of docs) {
      for (let pos = 0; pos <= text.length; pos++) {
        const range = findFocusRowRange(text, pos, 1);
        const spec = resolveFocusMeasureRange(text, range);
        // ① 绝不越过文档末尾（越界会让 coordsAtPos 抛错/被 clamp 到错误位置）
        expect(spec.end).toBeLessThanOrEqual(text.length);
        // ② 区间不倒置、不起负
        expect(spec.start).toBeGreaterThanOrEqual(0);
        expect(spec.end).toBeGreaterThanOrEqual(spec.start);
        // ③ 借位最多 +1（不许把窗口放大成 4 行）
        expect(spec.end - range.end).toBeLessThanOrEqual(1);
        // ④ 借位时 end-1 必须落在合法下标上（能安全喂给 coordsAtPos）
        if (spec.lastLineEmpty && !spec.extendEndByLineHeight) {
          expect(spec.end - 1).toBeGreaterThanOrEqual(0);
          expect(spec.end - 1).toBeLessThan(text.length);
        }
      }
    }
  });

  it("纯空行文档（全是 \\n）不崩、不越界", () => {
    const text = "\n\n\n\n";
    for (let pos = 0; pos <= text.length; pos++) {
      const spec = resolveFocusMeasureRange(text, findFocusRowRange(text, pos, 1));
      expect(spec.end).toBeLessThanOrEqual(text.length);
      expect(Number.isFinite(spec.start)).toBe(true);
      expect(Number.isFinite(spec.end)).toBe(true);
    }
  });

  it("range 越界/倒置时安全钳制（防御）", () => {
    const spec = resolveFocusMeasureRange("abc", { start: 10, end: 2, rows: 1 });
    expect(spec.start).toBe(3); // 钳到 len
    expect(spec.end).toBe(3);   // 不小于 start
  });
});

describe("resolveFocusMeasureRange —— 破坏性对照（证明判据能区分修好与没修）", () => {
  /**
   * 若把 `FormatMenuHost` 的调用改回「直接把 `findFocusRowRange` 的区间喂给
   * `measureRangeContentY`」，则：
   *   末行为空行时「最后测量字符」= 上一行末尾的 `\n` → coordsAtPos 给**上一行行底**
   *   → 空行行盒不被覆盖 → 探针的「覆盖行数」从 3 掉到 2。
   *
   * 本用例把两种口径的**下标**并列，证明这道翻译是可观测的（不是等价变换）。
   * 探针侧 `scripts/v0170-r3-caret-focus.mjs` 的 F3/F3b 就是端到端验证同一件事。
   */
  it("★ 破坏性对照：不借位时最后测量字符落在**上一行**的 \\n 上；借位后落在**空行**的 \\n 上", () => {
    const text = "A\n\nB";
    const r = run(text, 0);

    // 修复前：oldLast = 1 → 行0("A") 的换行符 → coordsAtPos 给行0 的行底
    expect(r.oldLast).toBe(1);
    expect(text[r.oldLast]).toBe("\n");

    // 修复后：newLast = 2 → 空行(行1) 的行界 → coordsAtPos 给空行的行底
    expect(r.newLast).toBe(2);
    expect(text[r.newLast]).toBe("\n");
    // 下标 2 的下一个字符就是行2 的首字符，证明它上面那行确实是空行
    expect(text[r.newLast + 1]).toBe("B");

    // ★ 两个下标必须不同 —— 否则单测证明不了任何事
    expect(r.newLast).not.toBe(r.oldLast);
  });

  it("★ 反向护栏：末行非空时借位与否结果相同（证明不是无脑 +1）", () => {
    const text = "aaa\nbbb\nccc\nddd";
    const r = run(text, 5);
    expect(r.spec.end).toBe(r.range.end);
    expect(r.newLast).toBe(r.oldLast);
  });
});

/**
 * ─── `expandFocusRangeToRows`：文档边界补齐 ──────────────────────────────
 *
 * ## 为什么需要它（缺陷 #7 的第二半）
 *
 * `findFocusRowRange` 的既有语义是「光标行 ±radius，**文档边界自动收缩**」
 * （v0.12.0 设计，`v0120-focus-row-range.test.ts` 锁着：首行 → 2 行、末行 → 2 行）。
 * 但用户这次要求的是「上下行**一共 3 行**」—— 强调总行数。
 * 两者在文档中部等价，在首/末行不等价。
 *
 * ## 实测证明这不是视口裁剪（否则不该补）
 * ```
 * 末行场景：bandTouchesOverlayBottom=false（窗没被钳位）
 *           maxScroll 608 > scrollTop 564（还有 44px 可滚，第 3 行物理可达）
 *           bandH=49.8 恒定 vs 正常 3 行窗 78.6 → 窗本身就算成 2 行
 * ```
 */
import { expandFocusRangeToRows } from "../utils/focus-paragraph";

/** 便捷：文档 + 光标 → 补齐后的 spec 及覆盖的行文本数组 */
function expandRows(text: string, cursor: number, target = 3) {
  const range = findFocusRowRange(text, cursor, 1);
  const out = expandFocusRangeToRows(text, range, target);
  const lines = text.substring(out.start, out.end).split("\n");
  return { range, out, lines };
}

describe("expandFocusRangeToRows —— 文档边界补齐到目标行数", () => {
  it("★ 末行（不以 \\n 结尾）→ 向上补 1 行，凑满 3 行", () => {
    // "aaa\nbbb\nccc\nddd"：光标在末行 ddd（行3）→ findFocusRowRange 给 2 行
    const { range, out, lines } = expandRows("aaa\nbbb\nccc\nddd", 14);
    expect(range.rows).toBe(2);      // 既有语义（收缩）
    expect(out.rows).toBe(3);        // 补齐
    expect(lines).toEqual(["bbb", "ccc", "ddd"]);
  });

  it("★ 末行（以 \\n 结尾的末尾空行）→ 向上补，含末尾空行", () => {
    // "aaa\nbbb\nccc\nddd\n"：末尾有个空行，光标在 text.length
    const { out, lines } = expandRows("aaa\nbbb\nccc\nddd\n", 16);
    expect(out.rows).toBe(3);
    expect(lines).toEqual(["ccc", "ddd", ""]);
  });

  it("★ 首行 → 向下补 1 行（上方没有空间）", () => {
    const { range, out, lines } = expandRows("aaa\nbbb\nccc\nddd", 1);
    expect(range.rows).toBe(2);
    expect(out.rows).toBe(3);
    expect(lines).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("文档中部 → 无需补齐，原样返回（负对照）", () => {
    const { range, out, lines } = expandRows("aaa\nbbb\nccc\nddd\neee", 6);
    expect(out.rows).toBe(3);
    expect(lines).toEqual(["aaa", "bbb", "ccc"]);
    // 与 findFocusRowRange 完全一致（不是无脑扩张）
    expect(out.start).toBe(range.start);
    expect(out.end).toBe(range.end);
  });

  it("★ 单行文档 → 补不满（物理限制），返回全文", () => {
    const { out, lines } = expandRows("abc", 1);
    expect(out.rows).toBe(1);
    expect(lines).toEqual(["abc"]);
  });

  it("★ 两行文档 → 补到 2 行即止（物理限制，不是缺陷）", () => {
    const { out, lines } = expandRows("aaa\nbbb", 1);
    expect(out.rows).toBe(2);
    expect(lines).toEqual(["aaa", "bbb"]);
  });

  it("★ 空文档 → [0,0)、rows=1，不崩", () => {
    const { out } = expandRows("", 0);
    expect(out).toEqual({ start: 0, end: 0, rows: 1 });
  });

  it("★ 仅 \"\\n\"（一个空行）→ 2 行，补不满", () => {
    const { out } = expandRows("\n", 0);
    expect(out.rows).toBe(2);
    expect(out.start).toBe(0);
    expect(out.end).toBeLessThanOrEqual(1);
  });

  it("★ 连续空行结尾（...\\n\\n）→ 补齐且不越界", () => {
    const { out } = expandRows("aaa\nbbb\nccc\n\n", 14);
    expect(out.rows).toBe(3);
    expect(out.end).toBeLessThanOrEqual("aaa\nbbb\nccc\n\n".length);
  });

  it("★ 不变式：遍历多文档 × 所有光标 → rows == min(target, 文档总行数)、边界合法", () => {
    const docs = [
      "", "a", "a\n", "a\n\n", "a\n\nb", "\n", "\n\n", "a\n\nb\n\nc",
      "aaa\nbbb\nccc\nddd\n", "\n\n\n\n", "x\n\ny\n\n", "a\nb", "a\nb\nc",
      "p1\n\np2\n\np3\n\np4",
    ];
    for (const text of docs) {
      const totalLines = text.split("\n").length;
      for (let pos = 0; pos <= text.length; pos++) {
        const out = expandFocusRangeToRows(text, findFocusRowRange(text, pos, 1), 3);
        // ① 行数 = min(3, 文档总行数) —— 文档够 3 行时必须凑满
        expect(out.rows).toBe(Math.min(3, totalLines));
        // ② 边界合法
        expect(out.start).toBeGreaterThanOrEqual(0);
        expect(out.end).toBeLessThanOrEqual(text.length);
        expect(out.end).toBeGreaterThanOrEqual(out.start);
        // ③ 光标所在行必须仍落在窗口内（补边不能把光标挤出窗口）
        const cursorLine = text.substring(0, pos).split("\n").length - 1;
        const winFirst = text.substring(0, out.start).split("\n").length - 1;
        const winLast = text.substring(0, out.end).split("\n").length - 1;
        expect(cursorLine).toBeGreaterThanOrEqual(winFirst);
        expect(cursorLine).toBeLessThanOrEqual(winLast);
      }
    }
  });

  it("targetRows=1 时退化为单行窗口", () => {
    const text = "aaa\nbbb\nccc";
    const out = expandFocusRangeToRows(text, findFocusRowRange(text, 5, 1), 1);
    expect(out.rows).toBe(1);
  });

  it("targetRows 非法值（0 / 负数 / 小数）也能安全处理", () => {
    const text = "aaa\nbbb\nccc";
    for (const t of [0, -1, 1.7, NaN]) {
      const out = expandFocusRangeToRows(text, findFocusRowRange(text, 5, 1), t as number);
      expect(out.rows).toBeGreaterThanOrEqual(1);
      expect(out.end).toBeLessThanOrEqual(text.length);
    }
  });
});

describe("expandFocusRangeToRows —— 破坏性对照（证明补齐是必需的）", () => {
  /**
   * 若不补齐（= 直接拿 `findFocusRowRange` 的结果），首/末行只有 2 行 →
   * 探针的「覆盖行数」判据会从 3 掉到 2。本用例把两种口径的行数并列。
   */
  it("★ 末行：不补齐 2 行 vs 补齐 3 行（差异必须可观测）", () => {
    const text = "aaa\nbbb\nccc\nddd";
    const range = findFocusRowRange(text, 14, 1);
    const expanded = expandFocusRangeToRows(text, range, 3);
    expect(range.rows).toBe(2);
    expect(expanded.rows).toBe(3);
    // ★ 行数必须不同 —— 否则这段补齐是恒等变换，探针就证明不了任何事
    expect(expanded.rows).not.toBe(range.rows);
  });

  it("★ 首行：不补齐 2 行 vs 补齐 3 行", () => {
    const text = "aaa\nbbb\nccc\nddd";
    const range = findFocusRowRange(text, 1, 1);
    expect(range.rows).toBe(2);
    expect(expandFocusRangeToRows(text, range, 3).rows).toBe(3);
  });

  it("★ 反向护栏：文档中部补齐前后完全相同（不是无脑扩张）", () => {
    const text = "aaa\nbbb\nccc\nddd\neee";
    const range = findFocusRowRange(text, 6, 1);
    const out = expandFocusRangeToRows(text, range, 3);
    expect(out.start).toBe(range.start);
    expect(out.end).toBe(range.end);
  });
});
