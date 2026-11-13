/**
 * v0.17.0 R5 · B7 回归测试：有序列表转待办时**嵌套子列表的序号不得被重排**
 *
 * ## 这不是"新功能"，而是一个**真机验证才发现的既有缺陷**回归锁定
 *
 * R4 交付的 #2（有序列表 Ctrl+T 保留列表 + 任务项带字面序号）在浏览器侧
 * 8 种边界全过，但真机验证（R5 V3）发现：**3 空格缩进的嵌套子列表会被 +1**。
 *
 * 铁证是"缩进差 1 空格结果就不同"：
 * | 嵌套缩进 | 修复前 | 判定 |
 * |---|---|---|
 * | 3 空格 | 内层 `2./3.` | ❌ |
 * | 4 空格 | 内层 `1./2.` | ✅ |
 *
 * 根因：`sourceFormat.ts` 的 `isListLine` 用 `/^\s{0,3}/`（允许 0~3 空格），
 * 于是 3 空格嵌套行满足匹配被扫进后段 → 被 `renumberAfter` 一起重编号；
 * 而 4 空格反而不匹配 → 两种缩进行为不一致。
 *
 * ## 为什么单测当时没抓到
 *
 * R4 的 8 种边界表里"嵌套"那条只断言了**输出里含 inner1 / inner2**（内容不丢），
 * **没断言序号不变**。→ 判据覆盖不全（"内容在" ≠ "语义对"）。
 *
 * ## 判定口径
 * - 嵌套子列表：**序号逐字节不变**（`1.` 仍是 `1.`）
 * - 后段同级项：**仍要正确接续重编号**（`ownOrder + 1` 起）—— 不能为了修 B7 把它弄坏
 * - 内容：零丢失
 */
import { describe, it, expect } from "vitest";
import { liftListLineToTask } from "../components/editor/sourceFormat";

/** 把结果转成便于阅读的数组（去掉空行便于断言结构） */
const nonEmpty = (s: string) => s.split("\n").filter((l) => l.trim() !== "");

describe("v0.17.0 R5 · B7 嵌套子列表序号不被重排", () => {
  it("★ 3 空格缩进嵌套：内层序号保持 1./2.（修复前会被 +1 成 2./3.）", () => {
    const src = ["1. 外层", "   1. 内一", "   2. 内二", ""].join("\n");
    // 光标在第 1 行（"1. 外层"）行首
    const out = liftListLineToTask(src, 0);
    expect(out).not.toBeNull();
    const lines = nonEmpty(out!.replacement);
    // 外层变成任务项且带字面序号
    expect(lines[0]).toBe("- [ ] 1. 外层");
    // ★ 内层两个子项：序号必须原样
    expect(lines).toContain("   1. 内一");
    expect(lines).toContain("   2. 内二");
    // ★ 反向断言：不能出现被 +1 的形态（这是缺陷本体的指纹）
    expect(lines).not.toContain("   2. 内一");
    expect(lines).not.toContain("   3. 内二");
    // 内容零丢失
    expect(out!.replacement).toContain("内一");
    expect(out!.replacement).toContain("内二");
  });

  it("★ 4 空格缩进嵌套：同样保持 1./2.（修复前碰巧正确，现在必须仍然正确）", () => {
    const src = ["1. 外层", "    1. 内一", "    2. 内二", ""].join("\n");
    const out = liftListLineToTask(src, 0);
    expect(out).not.toBeNull();
    const lines = nonEmpty(out!.replacement);
    expect(lines[0]).toBe("- [ ] 1. 外层");
    expect(lines).toContain("    1. 内一");
    expect(lines).toContain("    2. 内二");
    expect(out!.replacement).toContain("内一");
  });

  it("★ 2 空格缩进嵌套：也要保持（覆盖 1~4 空格全谱）", () => {
    const src = ["1. 外层", "  1. 内一", "  2. 内二", ""].join("\n");
    const out = liftListLineToTask(src, 0);
    const lines = nonEmpty(out!.replacement);
    expect(lines[0]).toBe("- [ ] 1. 外层");
    expect(lines).toContain("  1. 内一");
    expect(lines).toContain("  2. 内二");
  });

  it("嵌套 + 后段同级项共存：嵌套不动、后段仍按 ownOrder+1 重编号", () => {
    const src = ["1. 外层", "   1. 内一", "   2. 内二", "2. 第二项", "3. 第三项", ""].join("\n");
    const out = liftListLineToTask(src, 0);
    const lines = nonEmpty(out!.replacement);
    expect(lines[0]).toBe("- [ ] 1. 外层");
    // 嵌套原样
    expect(lines).toContain("   1. 内一");
    expect(lines).toContain("   2. 内二");
    // 后段同级：ownOrder(1)+1 = 2，逐行 +1
    expect(lines).toContain("2. 第二项");
    expect(lines).toContain("3. 第三项");
  });

  it("转换中间项时嵌套仍不动（ownOrder=2 场景）", () => {
    const src = ["1. 一", "2. 二", "   1. 内一", "   2. 内二", "3. 三", ""].join("\n");
    // 光标在第 2 行（"2. 二"）
    const out = liftListLineToTask(src, src.indexOf("2. 二"));
    const lines = nonEmpty(out!.replacement);
    expect(lines).toContain("- [ ] 2. 二");
    expect(lines).toContain("   1. 内一");
    expect(lines).toContain("   2. 内二");
    // 后段同级接续：ownOrder(2)+1 = 3
    expect(lines).toContain("3. 三");
    // 前段原样
    expect(lines).toContain("1. 一");
  });

  it("回归护栏：纯有序列表的后段重编号语义没被破坏（R4 口径）", () => {
    // 无嵌套时，行为必须与 R4 完全一致
    const src = ["1. aa", "2. bb", "3. cc", ""].join("\n");
    const out = liftListLineToTask(src, src.indexOf("2. bb"));
    const lines = nonEmpty(out!.replacement);
    expect(lines).toContain("1. aa");
    expect(lines).toContain("- [ ] 2. bb");
    expect(lines).toContain("3. cc");
    // 逐字节不变（R4 的核心承诺）
    expect(lines[0]).toBe("1. aa");
    expect(lines[2]).toBe("3. cc");
  });

  it("回归护栏：无序列表（无序号）行为不变", () => {
    const src = ["- aa", "- bb", "- cc", ""].join("\n");
    const out = liftListLineToTask(src, src.indexOf("- bb"));
    const lines = nonEmpty(out!.replacement);
    expect(lines).toContain("- aa");
    expect(lines).toContain("- [ ] bb");
    expect(lines).toContain("- cc");
  });
});
