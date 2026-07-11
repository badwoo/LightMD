/**
 * G11 字数统计详情测试
 *
 * 覆盖 calculateWordCount 纯函数：
 * 1. 纯中文文档
 * 2. 纯英文文档
 * 3. 中英混合文档
 * 4. 空文档
 * 5. 多段落（\n\n 分隔）
 * 6. 多行（\n 分隔）
 * 7. 阅读时长边界（中文 300 字/分，英文 200 词/分）
 */
import { describe, it, expect } from "vitest";
import { calculateWordCount } from "../utils/wordCount";

describe("G11 calculateWordCount 字数统计", () => {
  it("纯中文文档：每个汉字算 1 词", () => {
    const result = calculateWordCount("你好世界");
    // 任务期望：4 字，4 字符，0 词英文，阅读时长 1 分钟
    expect(result.words).toBe(4);
    expect(result.chars).toBe(4);
    expect(result.charsNoSpaces).toBe(4);
    expect(result.lines).toBe(1);
    expect(result.paragraphs).toBe(1);
    expect(result.readingTimeMin).toBe(1);
  });

  it("纯英文文档：按空格分词", () => {
    const result = calculateWordCount("hello world");
    // 任务期望：2 词，11 字符，10 字符不含空格
    expect(result.words).toBe(2);
    expect(result.chars).toBe(11);
    expect(result.charsNoSpaces).toBe(10);
    expect(result.lines).toBe(1);
    expect(result.paragraphs).toBe(1);
    expect(result.readingTimeMin).toBe(1);
  });

  it("中英混合文档：中文按字 + 英文按词", () => {
    const result = calculateWordCount("你好 hello 世界 world");
    // 中文字符 4 个（你好世界） + 英文词 2 个（hello world） = 6
    expect(result.words).toBe(6);
    // 字符数：4 中文 + 2 空格 + 5 字母(hello) + 1 空格 + 2 中文(世界) + 1 空格 + 5 字母(world) = 20
    // 重新数：你(1)好(1)空格(1)h(1)e(1)l(1)l(1)o(1)空格(1)世(1)界(1)空格(1)w(1)o(1)r(1)l(1)d(1) = 17
    expect(result.chars).toBe(17);
    // 不含空格：17 - 3 = 14
    expect(result.charsNoSpaces).toBe(14);
    expect(result.lines).toBe(1);
    expect(result.paragraphs).toBe(1);
    // 4/300 + 2/200 = 0.0133 + 0.01 = 0.0233，向上取整 = 1，最少 1 分钟
    expect(result.readingTimeMin).toBe(1);
  });

  it("空文档：全 0", () => {
    const result = calculateWordCount("");
    expect(result.words).toBe(0);
    expect(result.chars).toBe(0);
    expect(result.charsNoSpaces).toBe(0);
    expect(result.lines).toBe(0);
    expect(result.paragraphs).toBe(0);
    expect(result.readingTimeMin).toBe(0);
  });

  it("多段落：空行分隔的非空段数", () => {
    const result = calculateWordCount("段落1\n\n段落2");
    // 2 个非空段
    expect(result.paragraphs).toBe(2);
    // 行数：3（"段落1"、""、"段落2"）
    expect(result.lines).toBe(3);
    // 中文字符 4（段落段落）+ 数字词 2（1、2）= 6
    expect(result.words).toBe(6);
    // 字符数：3 + 1 + 1 + 3 = 8
    expect(result.chars).toBe(8);
    // 不含空格：8 - 2（\n\n）= 6
    expect(result.charsNoSpaces).toBe(6);
  });

  it("多段落：连续空行只算作一个分隔", () => {
    const result = calculateWordCount("段落1\n\n\n\n段落2");
    // 2 个非空段（连续空行视为段落分隔）
    expect(result.paragraphs).toBe(2);
  });

  it("多行：\\n 分隔（无空行，单段落）", () => {
    const result = calculateWordCount("行1\n行2\n行3");
    // 行数：3
    expect(result.lines).toBe(3);
    // 段落数：1（无空行分隔）
    expect(result.paragraphs).toBe(1);
    // 中文字符 3（行行行）+ 数字词 3（1、2、3）= 6
    expect(result.words).toBe(6);
  });

  it("阅读时长：中文 300 字/分钟（恰好 300 字 = 1 分钟）", () => {
    const text = "字".repeat(300);
    const result = calculateWordCount(text);
    expect(result.words).toBe(300);
    expect(result.readingTimeMin).toBe(1);
  });

  it("阅读时长：中文 301 字 = 2 分钟（向上取整）", () => {
    const text = "字".repeat(301);
    const result = calculateWordCount(text);
    expect(result.words).toBe(301);
    // 301/300 = 1.0033，向上取整 = 2
    expect(result.readingTimeMin).toBe(2);
  });

  it("阅读时长：英文 200 词 = 1 分钟", () => {
    // 构造 200 个英文词：word0 word1 ... word199
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const result = calculateWordCount(words);
    expect(result.words).toBe(200);
    expect(result.readingTimeMin).toBe(1);
  });

  it("阅读时长：英文 201 词 = 2 分钟", () => {
    const words = Array.from({ length: 201 }, (_, i) => `word${i}`).join(" ");
    const result = calculateWordCount(words);
    expect(result.words).toBe(201);
    // 201/200 = 1.005，向上取整 = 2
    expect(result.readingTimeMin).toBe(2);
  });

  it("阅读时长：中英混合（300 中文字 + 200 英文词 = 2 分钟）", () => {
    const cjk = "字".repeat(300);
    const en = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const result = calculateWordCount(`${cjk} ${en}`);
    // 300 + 200 = 500 词
    expect(result.words).toBe(500);
    // 300/300 + 200/200 = 1 + 1 = 2 分钟
    expect(result.readingTimeMin).toBe(2);
  });

  it("数字也算英文词（连续字母数字序列）", () => {
    const result = calculateWordCount("abc123 def456");
    // 2 个词：abc123、def456
    expect(result.words).toBe(2);
  });

  it("包含制表符和换行符的文本", () => {
    const result = calculateWordCount("a\tb\nc");
    // 字符数：5（a、\t、b、\n、c）
    expect(result.chars).toBe(5);
    // 不含空格：3（a、b、c），\t 和 \n 都是 \s
    expect(result.charsNoSpaces).toBe(3);
    // 行数：2（"a\tb"、"c"）
    expect(result.lines).toBe(2);
    // 词数：3（a、b、c 各算一个词）
    expect(result.words).toBe(3);
  });

  it("仅空白字符的文档", () => {
    const result = calculateWordCount("   \n\n  ");
    // 字符数：7
    expect(result.chars).toBe(7);
    // 不含空格：0
    expect(result.charsNoSpaces).toBe(0);
    // 词数：0
    expect(result.words).toBe(0);
    // 行数：3（"   "、""、"  "）
    expect(result.lines).toBe(3);
    // 段落数：0（无非空段）
    expect(result.paragraphs).toBe(0);
    // 阅读时长：0（words=0）
    expect(result.readingTimeMin).toBe(0);
  });

  it("Markdown 语法不计入字数（按字符处理）", () => {
    // 注意：calculateWordCount 按"文本字符"计数，不解析 Markdown 语法
    // 因此 "# 标题" 中的 # 会被算作字符，"标题" 算 2 个中文词
    const result = calculateWordCount("# 标题\n\n正文");
    // 中文字符 4（标题正文）+ 英文词 0 = 4
    expect(result.words).toBe(4);
    // 字符数：# (1) + 空格 (1) + 标 (1) + 题 (1) + \n (1) + \n (1) + 正 (1) + 文 (1) = 8
    expect(result.chars).toBe(8);
    // 段落数：2（"# 标题" 和 "正文"）
    expect(result.paragraphs).toBe(2);
  });
});
