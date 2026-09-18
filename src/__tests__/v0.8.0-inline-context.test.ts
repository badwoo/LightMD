/**
 * v0.8.0 修复 P1-3：isInInlineCodeOrMath 行为测试
 *
 * 覆盖：行内代码、行内公式、普通文本、转义字符、多行文档的当前行判定。
 */
import { describe, it, expect } from "vitest";
import { isInInlineCodeOrMath } from "../utils/inlineContext";

describe("v0.8.0 修复 P1-3 isInInlineCodeOrMath", () => {
  it("光标在行内代码内 → true", () => {
    const text = "前文 `const x = 1` 后文";
    expect(isInInlineCodeOrMath(text, text.indexOf("const"))).toBe(true);
    expect(isInInlineCodeOrMath(text, text.indexOf("= 1"))).toBe(true);
  });

  it("光标在行内代码外 → false", () => {
    const text = "前文 `code` 后文";
    expect(isInInlineCodeOrMath(text, text.indexOf("后文"))).toBe(false);
    expect(isInInlineCodeOrMath(text, text.indexOf("前文"))).toBe(false);
  });

  it("光标在行内公式内 → true", () => {
    const text = "公式 $E = mc^2$ 结束";
    expect(isInInlineCodeOrMath(text, text.indexOf("mc"))).toBe(true);
  });

  it("光标在公式外 → false", () => {
    const text = "公式 $x$ 结束";
    expect(isInInlineCodeOrMath(text, text.indexOf("结束"))).toBe(false);
  });

  it("转义的 ` 和 $ 不计入配对", () => {
    // \` 是字面反引号，不开启代码区间
    const text = "a \\` b（光标）";
    expect(isInInlineCodeOrMath(text, text.indexOf("光标"))).toBe(false);
    const text2 = "价格 \\$100（光标）";
    expect(isInInlineCodeOrMath(text2, text2.indexOf("光标"))).toBe(false);
  });

  it("多行文档：只按当前行判定（上一行未闭合的反引号不影响）", () => {
    const text = "第一行 `code`\n第二行（光标）";
    expect(isInInlineCodeOrMath(text, text.indexOf("光标"))).toBe(false);
  });

  it("光标在文首/空文本 → false", () => {
    expect(isInInlineCodeOrMath("", 0)).toBe(false);
    expect(isInInlineCodeOrMath("abc", 0)).toBe(false);
  });

  it("成对删除的真实场景：`（x）` 内的括号不被吞", () => {
    // 光标位于 `（内容）` 中闭括号前
    const text = "`（内容`）";
    expect(isInInlineCodeOrMath(text, text.indexOf("`）"))).toBe(true);
  });
});
