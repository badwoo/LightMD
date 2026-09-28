/**
 * v0.9.0 B6：块级原文保留 —— 解析期原文行号记录表。
 *
 * parser 在顶层解析时为每个顶层块记录其在源文本中的行区间 [start, end)；
 * serializer 对未被编辑的块（PM 不可变节点保持对象同一性 → WeakMap 命中）
 * 直接输出原文切片，实现「只回写真正变化的块」，根治保存时的全文档重排。
 *
 * 内存：source 存解析输入串的引用（全部块共享同一字符串），每块仅 2 个数字，O(1)。
 * 独立模块避免 parser ↔ serializer 循环依赖。
 */
import type { Node } from "prosemirror-model";

export interface BlockSourceInfo {
  /** 块内容起始行（0 基，含） */
  start: number;
  /** 块内容结束行（0 基，排他；不含块后空行） */
  end: number;
  /** 解析输入源文本（全部块共享同一引用） */
  source: string;
}

const map = new WeakMap<Node, BlockSourceInfo>();

export function setBlockSource(node: Node, info: BlockSourceInfo): void {
  map.set(node, info);
}

export function getBlockSource(node: Node): BlockSourceInfo | undefined {
  return map.get(node);
}
