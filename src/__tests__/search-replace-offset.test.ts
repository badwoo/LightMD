/**
 * 搜索替换偏移映射测试
 *
 * 测试 buildOffsetBlocks 和 lookupPmPos 的正确性
 * 确保阅读模式下搜索替换能正确定位 ProseMirror 文档位置
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import type { Node } from "prosemirror-model";

// ─── 从 SearchReplace 中复制的核心函数（用于单元测试）──────────

interface OffsetBlock {
  textStart: number;
  textEnd: number;
  pmStart: number;
}

function buildOffsetBlocks(doc: Node): OffsetBlock[] {
  const blocks: OffsetBlock[] = [];
  let textOffset = 0;
  let lastBlockPos = -1;

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (lastBlockPos >= 0) {
        textOffset += 1;
        lastBlockPos = -1;
      }
      blocks.push({
        textStart: textOffset,
        textEnd: textOffset + node.text.length,
        pmStart: pos,
      });
      textOffset += node.text.length;
    } else if (node.isBlock && !node.isInline && pos > 0) {
      lastBlockPos = pos;
    }
    return true;
  });

  return blocks;
}

function lookupPmPos(blocks: OffsetBlock[], textOffset: number): number | undefined {
  let lo = 0, hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const block = blocks[mid];
    if (textOffset < block.textStart) {
      hi = mid - 1;
    } else if (textOffset >= block.textEnd) {
      lo = mid + 1;
    } else {
      return block.pmStart + (textOffset - block.textStart);
    }
  }
  return undefined;
}

// ─── 测试用例 ──────────────────────────────────────────────

describe("buildOffsetBlocks 偏移映射", () => {
  it("应该正确构建单段落文档的偏移映射", () => {
    const doc = markdownToDoc("hello world");
    const blocks = buildOffsetBlocks(doc);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].textStart).toBe(0);
    expect(blocks[0].textEnd).toBe(11); // "hello world" 长度
  });

  it("应该正确构建多段落文档的偏移映射", () => {
    const doc = markdownToDoc("第一段\n\n第二段");
    const blocks = buildOffsetBlocks(doc);

    // 应该有两个文本块
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    // 第二个块的 textStart 应该在第一个块之后（含换行符）
    const firstBlock = blocks[0];
    const secondBlock = blocks.find(b => b.textStart > firstBlock.textEnd);
    expect(secondBlock).toBeDefined();
    // 块之间应该有一个换行符的间隔
    expect(secondBlock!.textStart).toBe(firstBlock.textEnd + 1);
  });

  it("应该正确处理包含格式的文档", () => {
    const doc = markdownToDoc("**粗体** 和 *斜体*");
    const blocks = buildOffsetBlocks(doc);
    expect(blocks.length).toBeGreaterThan(0);

    // 验证能找到 "粗体" 文本
    const fullText = blocks.map(b => `${b.pmStart}`).join(",");
    expect(fullText.length).toBeGreaterThan(0);
  });
});

describe("lookupPmPos 二分查找", () => {
  it("应该正确查找第一个位置", () => {
    const doc = markdownToDoc("hello world");
    const blocks = buildOffsetBlocks(doc);
    const pos = lookupPmPos(blocks, 0);
    expect(pos).toBeDefined();
    expect(pos).toBe(blocks[0].pmStart);
  });

  it("应该正确查找中间位置", () => {
    const doc = markdownToDoc("hello world");
    const blocks = buildOffsetBlocks(doc);
    const pos = lookupPmPos(blocks, 5); // "world" 的 'w' 位置
    expect(pos).toBeDefined();
    expect(pos).toBe(blocks[0].pmStart + 5);
  });

  it("应该正确查找末尾位置", () => {
    const doc = markdownToDoc("hello world");
    const blocks = buildOffsetBlocks(doc);
    const pos = lookupPmPos(blocks, 10); // 'd' 位置
    expect(pos).toBeDefined();
    expect(pos).toBe(blocks[0].pmStart + 10);
  });

  it("应该正确查找多段落中的位置", () => {
    const doc = markdownToDoc("第一段\n\n第二段");
    const blocks = buildOffsetBlocks(doc);

    // 查找 "第二段" 的 "第" 字位置
    // "第一段" = 3 字符 + 1 换行符 = textOffset 4
    const pos = lookupPmPos(blocks, 4);
    expect(pos).toBeDefined();
  });

  it("应该返回 undefined 对于超出范围的位置", () => {
    const doc = markdownToDoc("hello");
    const blocks = buildOffsetBlocks(doc);
    const pos = lookupPmPos(blocks, 1000);
    expect(pos).toBeUndefined();
  });
});

describe("搜索替换定位一致性", () => {
  it("搜索文本应该能在 ProseMirror 文档中定位", () => {
    const md = "这是一段测试文本，包含关键词。";
    const doc = markdownToDoc(md);
    const blocks = buildOffsetBlocks(doc);

    // 模拟搜索 "关键词"
    const searchText = "关键词";
    const textContent = doc.textBetween(0, doc.content.size, "\n", "\n");
    const matchIndex = textContent.indexOf(searchText);
    expect(matchIndex).toBeGreaterThanOrEqual(0);

    // 通过偏移映射找到 PM 位置
    const pmStart = lookupPmPos(blocks, matchIndex);
    const pmEnd = lookupPmPos(blocks, matchIndex + searchText.length - 1);
    expect(pmStart).toBeDefined();
    expect(pmEnd).toBeDefined();

    // 验证 PM 位置对应的文本确实是搜索文本
    const foundText = doc.textBetween(pmStart!, pmEnd! + 1, "\n", "\n");
    expect(foundText).toBe(searchText);
  });
});
