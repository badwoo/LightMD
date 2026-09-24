/**
 * v0.8.3 需求3：光标行列 / 选中字符数的纯函数计算。
 *
 * 两部分：
 * 1. 阅读模式（ProseMirror）：computeDocLine / computeBlockColumn——由 doc/ResolvedPos
 *    直接算出行号与列号；
 * 2. 源码模式（textarea）：computeTextareaCursorPosition——由 value + 选区偏移计算。
 *
 * 抽为纯函数的原因：
 * - 便于单测覆盖边界（长文档、行首/行尾、跨行选区、越界选区钳制）；
 * - 两种模式共用同一套语义：line/column 均 1 起，选中字符数按选区长度计。
 */

import type { Node as PMNode, ResolvedPos } from "prosemirror-model";

export interface CursorPosition {
  /** 行号（1 起） */
  line: number;
  /** 列号（1 起，按 "\n" 硬换行切分） */
  column: number;
  /** 选中字符数（未选中为 0） */
  selectedChars: number;
}

/** 钳制到 [0, max] */
function clampOffset(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return n > max ? max : n;
}

// ─── v0.8.3 需求3：阅读模式的行号（结构化计算，不拼接整篇文本）────────────
//
// 背景（实测发现的既有缺陷）：旧实现是
//   `doc.textBetween(0, $from.pos).split("\n").length`
// 而 `textBetween` 在未传 blockSeparator 时**不在块之间插入分隔符**
// （见 prosemirror-model 源码：`if (... && blockSeparator)`），因此该值实际只统计
// 光标前的"硬换行"数——在常规 Markdown 文档（块之间是空行）里恒等于 1，
// 状态栏的"行"永远显示 1，不满足"光标所在行"的语义。
//
// 现改为结构化计数（零字符串分配、O(光标前的块数)）：
//   行 = 光标之前的块行数之和 + 块内光标之前的硬换行数 + 1
// 其中：
//   - 每个文本块（p / h1-h6 / code_block / task-content 内段落…）占 1 行；
//   - 块内硬换行（hard_break，对应 Markdown 的"两空格换行"/反斜杠换行）各占 1 行；
//   - 原子块（hr 等）占 1 行；
//   - 容器块（blockquote / ul / ol / li / task_item 等）本身不占行，递归累加子块；
//   - 表格按"每个表行 1 行"计（与 Markdown 源码的表格行一致）；
//   - 块之间的空行不计入（行号是"逻辑块行号"，非磁盘字节行号）。

/** 表格相关节点名（按文档顺序行数折算） */
const TABLE = "table";
const TABLE_SECTIONS = new Set(["table_head", "table_body"]);
const TABLE_ROW = "table_row";
const TABLE_CELLS = new Set(["table_cell", "table_header"]);
const HARD_BREAK = "hard_break";

/** 表格里的行数（table / table_head / table_body 都归一为"表行数"） */
function tableRowCount(node: PMNode): number {
  if (node.type.name === TABLE_ROW) return 1;
  let rows = 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const name = child.type.name;
    if (name === TABLE_ROW) rows += 1;
    else if (TABLE_SECTIONS.has(name) || name === TABLE) rows += tableRowCount(child);
  }
  return rows;
}

/** 单个文本块内的硬换行数 */
function countHardBreaks(node: PMNode): number {
  let breaks = 0;
  node.descendants((child) => {
    if (child.type.name === HARD_BREAK) breaks++;
    return true;
  });
  return breaks;
}

/**
 * 一个块在"逻辑行号"里占用的行数。
 * 容器返回其子块之和；文本块返回 1 + 硬换行数；表格返回表行数；原子块返回 1。
 */
export function blockLineWeight(node: PMNode): number {
  const name = node.type.name;
  if (name === TABLE || TABLE_SECTIONS.has(name)) return tableRowCount(node);
  if (name === TABLE_ROW) return 1;
  // 表格单元格本身不占行（所在表行已计 1 行）
  if (TABLE_CELLS.has(name)) return 0;
  if (node.isTextblock) {
    // 快路径：单个文本子节点 → 不可能含硬换行（覆盖绝大多数段落/标题）
    if (node.childCount === 1 && node.firstChild!.isText) return 1;
    return 1 + countHardBreaks(node);
  }
  if (node.isLeaf && node.isBlock) return 1;
  let lines = 0;
  for (let i = 0; i < node.childCount; i++) lines += blockLineWeight(node.child(i));
  return lines;
}

/**
 * 计算光标所在的逻辑行号（1 起）。
 *
 * @param $pos 由 `doc.resolve(pos)` 或 `state.selection.$from` 得到
 */
export function computeDocLine($pos: ResolvedPos): number {
  let line = 1;
  const depth = $pos.depth;
  // 逐层累加"光标之前、不在光标祖先链上"的兄弟块行数
  for (let d = 0; d < depth; d++) {
    const parent = $pos.node(d);
    const idx = $pos.index(d);
    for (let i = 0; i < idx; i++) line += blockLineWeight(parent.child(i));
  }
  // 光标所在文本块内、光标之前的硬换行
  const parent = $pos.parent;
  const offset = $pos.parentOffset;
  if (parent.isTextblock && offset > 0 && parent.childCount > 0) {
    parent.nodesBetween(0, offset, (node) => {
      if (node.type.name === HARD_BREAK) line++;
    });
  }
  return line;
}

/** 计算光标在所在文本块内的列号（1 起） */
export function computeBlockColumn($pos: ResolvedPos): number {
  return $pos.parent.textBetween(0, $pos.parentOffset).length + 1;
}

/**
 * 由 textarea 的 value + 选区偏移计算光标位置。
 *
 * @param value textarea 当前文本
 * @param selectionStart 选区起点（越界自动钳制）
 * @param selectionEnd 选区终点（默认 = selectionStart；小于起点时按起点处理）
 */
export function computeTextareaCursorPosition(
  value: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): CursorPosition {
  const len = typeof value === "string" ? value.length : 0;
  const start = clampOffset(selectionStart, len);
  const end = Math.max(start, clampOffset(selectionEnd, len));

  // 单趟扫描 [0, start)：统计换行数并记住最后一个换行的下标
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < start; i++) {
    if (value.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastBreak = i;
    }
  }

  return {
    line,
    // lastBreak = -1（首行）时列号 = start + 1
    column: start - lastBreak,
    selectedChars: end - start,
  };
}
