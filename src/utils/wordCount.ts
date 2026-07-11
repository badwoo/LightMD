/**
 * 字数统计工具（纯函数，便于单元测试）
 *
 * 设计要点：
 * - 中文按字符计数（每字算 1 词），英文按 Unicode word boundary 分词
 * - 字符数：含空格 / 不含空格
 * - 行数：text.split('\n').length（空文档返回 0）
 * - 段落数：空行分隔的非空段数
 * - 阅读时长：中文 300 字/分钟 + 英文 200 词/分钟，向上取整，最少 1 分钟（空文档为 0）
 */

/** 字数统计结果 */
export interface WordCountResult {
  /** 字数（中文字符数 + 英文词数） */
  words: number;
  /** 字符数（含空格） */
  chars: number;
  /** 字符数（不含空格） */
  charsNoSpaces: number;
  /** 行数 */
  lines: number;
  /** 段落数（空行分隔的非空段） */
  paragraphs: number;
  /** 阅读时长（分钟） */
  readingTimeMin: number;
}

/**
 * CJK Unicode 范围（中日韩统一表意文字 + 扩展 A + 兼容表意文字 + 平假名 + 片假名 + 韩文音节）
 * 用于匹配中文/日文/韩文字符，每字算 1 词
 */
const CJK_REGEX = /[\u4e00-\u9fa5\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;

/**
 * 英文单词匹配（连续的字母或数字序列视为一个词）
 * 不使用 \b 是因为 \b 在 CJK 字符边界行为不一致
 */
const WORD_REGEX = /[a-zA-Z0-9]+/g;

/** 中文阅读速度：300 字/分钟 */
const CJK_READ_SPEED = 300;
/** 英文阅读速度：200 词/分钟 */
const EN_READ_SPEED = 200;

/** 空结果常量，避免每次创建新对象 */
const EMPTY_RESULT: WordCountResult = {
  words: 0,
  chars: 0,
  charsNoSpaces: 0,
  lines: 0,
  paragraphs: 0,
  readingTimeMin: 0,
};

/**
 * 计算文本的字数统计详情
 *
 * @param text 原始文本（Markdown 源码或纯文本）
 * @returns 字数统计结果
 *
 * 算法说明：
 * 1. 字数：CJK 字符数（每字算 1 词） + 英文词数（按空格分词）
 * 2. 字符数：text.length（含空格）/ text.replace(/\s/g, "").length（不含空格）
 * 3. 行数：text.split('\n').length（空文档为 0）
 * 4. 段落数：text.split(/\n\s*\n/).filter(s => s.trim().length > 0).length
 * 5. 阅读时长：ceil(cjk/300 + en/200)，最少 1 分钟（空文档为 0）
 */
export function calculateWordCount(text: string): WordCountResult {
  // 空文档快速返回（避免 split 返回 [""] 导致行数为 1）
  if (!text) {
    return EMPTY_RESULT;
  }

  // 字符数
  const chars = text.length;
  const charsNoSpaces = text.replace(/\s/g, "").length;

  // 字数：CJK 字符 + 英文词
  const cjkMatches = text.match(CJK_REGEX) || [];
  const wordMatches = text.match(WORD_REGEX) || [];
  const cjkCount = cjkMatches.length;
  const enWordCount = wordMatches.length;
  const words = cjkCount + enWordCount;

  // 行数
  const lines = text.split("\n").length;

  // 段落数：空行分隔的非空段
  const paragraphs = text
    .split(/\n\s*\n/)
    .filter((s) => s.trim().length > 0)
    .length;

  // 阅读时长：中文 300 字/分 + 英文 200 词/分，向上取整，最少 1 分钟
  let readingTimeMin = 0;
  if (words > 0) {
    const minutes = cjkCount / CJK_READ_SPEED + enWordCount / EN_READ_SPEED;
    readingTimeMin = Math.max(1, Math.ceil(minutes));
  }

  return { words, chars, charsNoSpaces, lines, paragraphs, readingTimeMin };
}
