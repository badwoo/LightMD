/**
 * 大纲拖拽排序纯函数模块（G13）
 *
 * 设计目标：
 * - 将拖拽核心逻辑封装为纯函数，便于单元测试
 * - 不依赖 React/DOM，仅操作 ProseMirror EditorState/Transaction
 * - 拖拽过程中不修改文档，仅 onDragEnd 时计算并返回一次 transaction
 *
 * 核心概念：
 * - "section"：一个标题节点 + 其后所有内容，直到下一个同级或更高级标题之前
 *   例如 H2 标题后的所有 H3/H4 内容都属于该 H2 的 section
 * - 跨层级拖拽时，源 section 内所有标题按相同 delta 调整级别，保持相对层级
 */
import type { Node as PMNode } from "prosemirror-model";
import { Fragment } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";

/**
 * 获取指定标题节点及其所有子内容的范围
 *
 * 范围 [start, end]：
 * - start = headingPos（标题节点之前的 pos）
 * - end = 下一个同级或更高级标题的 pos，或文档末尾
 *
 * @param doc ProseMirror 文档
 * @param headingPos 标题节点的 pos（节点之前的位置）
 * @returns { start, end }，若 headingPos 处非 heading 节点则返回单点范围
 */
export function getSectionRange(
  doc: PMNode,
  headingPos: number,
): { start: number; end: number } {
  const headingNode = doc.nodeAt(headingPos);
  if (!headingNode || headingNode.type.name !== "heading") {
    return { start: headingPos, end: headingPos };
  }
  const level = headingNode.attrs.level;

  // 遍历顶级子节点，找到 headingPos 之后第一个 level <= 当前 level 的标题
  let end = doc.content.size;
  doc.forEach((child, offset) => {
    const childPos = offset; // doc 的子节点 pos = offset
    if (
      childPos > headingPos &&
      child.type.name === "heading" &&
      child.attrs.level <= level
    ) {
      // 取第一个匹配的（doc.forEach 按顺序遍历）
      if (end === doc.content.size) end = childPos;
    }
  });

  return { start: headingPos, end };
}

/**
 * 调整标题节点的级别（保留内容和 marks）
 *
 * @param node heading 节点
 * @param targetLevel 目标级别（1-6，超出会被截断）
 * @returns 新的 heading 节点；若非 heading 或级别未变则返回原节点
 */
export function adjustHeadingLevel(node: PMNode, targetLevel: number): PMNode {
  if (node.type.name !== "heading") return node;
  const clamped = Math.max(1, Math.min(6, Math.floor(targetLevel)));
  if (node.attrs.level === clamped) return node;
  // 用新 level 重建节点，保留 content 和 marks
  return node.type.create(
    { ...node.attrs, level: clamped },
    node.content,
    node.marks,
  );
}

/**
 * 计算拖拽产生的 ProseMirror transaction
 *
 * 算法：
 * 1. 校验源/目标位置合法性
 * 2. 获取源 section 范围
 * 3. 确定目标层级（目标标题的层级；拖到末尾时取最后一个标题的层级）
 * 4. 按 levelDelta 调整源 section 内所有标题的级别（保持相对层级）
 * 5. 先删除源 section，再在调整后的目标位置插入
 *
 * @param state 当前 EditorState
 * @param sourcePos 源标题节点的 pos
 * @param targetPos 目标位置 pos（目标标题节点之前，或 doc.content.size 表示末尾）
 * @returns 计算好的 transaction；若拖拽无效（相同位置/目标在源内部/源非标题）返回 null
 */
export function calculateDragTransaction(
  state: EditorState,
  sourcePos: number,
  targetPos: number,
): Transaction | null {
  const { tr, doc } = state;

  // 无效：源和目标相同
  if (sourcePos === targetPos) return null;

  const sourceNode = doc.nodeAt(sourcePos);
  if (!sourceNode || sourceNode.type.name !== "heading") return null;

  const sourceRange = getSectionRange(doc, sourcePos);

  // 无效：目标在源 section 内部（不含边界）
  if (targetPos > sourceRange.start && targetPos < sourceRange.end) {
    return null;
  }

  // 边界校验
  if (targetPos < 0 || targetPos > doc.content.size) return null;

  // 确定目标层级
  let targetLevel = sourceNode.attrs.level;
  if (targetPos < doc.content.size) {
    // 拖到目标标题之前：源变成目标标题的层级
    const targetNode = doc.nodeAt(targetPos);
    if (targetNode && targetNode.type.name === "heading") {
      targetLevel = targetNode.attrs.level;
    }
  } else {
    // 拖到文档末尾：使用最后一个标题的层级
    let lastHeadingLevel = sourceNode.attrs.level;
    doc.forEach((child) => {
      if (child.type.name === "heading") {
        lastHeadingLevel = child.attrs.level;
      }
    });
    targetLevel = lastHeadingLevel;
  }

  // 计算层级差，调整源 section 内所有标题
  const levelDelta = targetLevel - sourceNode.attrs.level;

  // 获取源 slice（边界对齐到节点，openStart/openEnd = 0）
  const slice = doc.slice(sourceRange.start, sourceRange.end);

  // 调整 slice 中所有标题的级别（保持相对层级）
  const newNodes: PMNode[] = [];
  slice.content.forEach((child) => {
    if (child.type.name === "heading") {
      const newLevel = child.attrs.level + levelDelta;
      newNodes.push(adjustHeadingLevel(child, newLevel));
    } else {
      newNodes.push(child);
    }
  });
  const contentToInsert = Fragment.from(newNodes);

  // 计算插入位置（在 delete 之前，基于原始 doc 计算）
  // - 向上拖拽（targetPos < sourceRange.start）：插入到目标标题之前
  //   删除源后不影响 targetPos（源在目标之后）
  // - 向下拖拽（targetPos >= sourceRange.end）：插入到目标 section 之后
  //   用户意图是把源移到目标之后（向下），而非目标之前（否则等于无变化）
  //   删除源后，目标 section 的 end 前移 (sourceRange.end - sourceRange.start)
  let insertPos: number;
  if (targetPos < sourceRange.start) {
    // 向上拖拽：插入到目标标题之前
    insertPos = targetPos;
  } else {
    // 向下拖拽：插入到目标 section 末尾之后
    const targetSectionEnd = getSectionRange(doc, targetPos).end;
    insertPos = targetSectionEnd - (sourceRange.end - sourceRange.start);
  }

  // 先删除源 section，再在调整后的位置插入
  // 注意：tr 是 mutable，delete 后 tr.doc 已更新，insert 基于 tr 当前状态
  tr.delete(sourceRange.start, sourceRange.end);
  tr.insert(insertPos, contentToInsert);

  return tr;
}
