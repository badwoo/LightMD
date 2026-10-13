/**
 * v0.13.0 需求1：块级复制 / 剪切 / 粘贴的**执行层**（ProseMirror 侧）。
 *
 * 纯逻辑在 `utils/blockClipboard.ts`（序列化/反序列化/格式判定），本文件负责
 * 与 EditorView 的交互：建事务、写剪贴板、落点。
 *
 * ## 安全约束
 *
 * - 剪切/删除必须**一次事务 = 一次撤销**；
 * - 删除块后若文档为空，自动补一个空段落（PM 要求 doc 至少一个块，
 *   沿用 `code-block-exit.ts` 的同类处理）；
 * - 剪贴板写失败 → 抛错由调用方 toast 提示，**不**静默失败。
 */
import { NodeSelection, type EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { docToMarkdown, nodeToMarkdown } from "../core/markdown/serializer";
import { markdownToDoc } from "../core/markdown/parser";
import {
  BLOCK_CLIPBOARD_MIME,
  serializeBlockClipboard,
  type BlockClipboardData,
} from "./blockClipboard";

/** 当前 NodeSelection 覆盖的块节点（非 NodeSelection 时返回 null） */
export function selectedBlockNode(state: EditorState): PMNode | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  return state.doc.nodeAt(selection.from) ?? null;
}

/** 序列化一个块为剪贴板载荷（Markdown 源码 + 位置） */
export function serializeBlock(state: EditorState, from: number): BlockClipboardData | null {
  // nodeAt 对越界位置会抛错 → 包一层，返回 null 让调用方安静失败
  let node: PMNode | null = null;
  try {
    node = state.doc.nodeAt(from) ?? null;
  } catch {
    return null;
  }
  if (!node) return null;
  return {
    markdown: nodeToMarkdown(node),
    from,
    to: from + node.nodeSize,
    at: Date.now(),
  };
}

/**
 * 写块数据到剪贴板（三份格式）。
 *
 * @returns 是否成功写入（WebView2 权限拒绝时返回 false，调用方应 toast 提示）
 */
export async function writeBlockClipboard(data: BlockClipboardData): Promise<boolean> {
  const payload = serializeBlockClipboard(data);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        "text/plain": new Blob([data.markdown], { type: "text/plain" }),
        [BLOCK_CLIPBOARD_MIME]: new Blob([payload], { type: BLOCK_CLIPBOARD_MIME }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch {
    // 落到 writeText 保底
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(data.markdown);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * 从剪贴板读块数据（三级降级：专用格式 → Markdown 文本 → 纯文本）。
 *
 * 非 Tauri / 无 Clipboard API 时返回 null。
 */
export async function readBlockClipboard(): Promise<BlockClipboardData | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    const entries: Array<{ type: string; content: string }> = [];
    for (const item of items) {
      for (const type of item.types) {
        if (type !== "text/plain" && type !== BLOCK_CLIPBOARD_MIME) continue;
        try {
          entries.push({ type, content: await (await item.getType(type)).text() });
        } catch {
          // 单个类型读取失败跳过
        }
      }
    }
    const { parseBlockClipboard } = await import("./blockClipboard");
    return parseBlockClipboard(entries);
  } catch {
    return null;
  }
}

/** PM 侧块级复制（不删块） */
export async function copySelectedBlock(view: EditorView): Promise<boolean> {
  const { state } = view;
  const node = selectedBlockNode(state);
  if (!node) return false;
  const data = serializeBlock(state, state.selection.from);
  if (!data) return false;
  return writeBlockClipboard(data);
}

/** PM 侧块级剪切（复制 + 一次事务删除，= 一次撤销） */
export async function cutSelectedBlock(view: EditorView): Promise<boolean> {
  const ok = await copySelectedBlock(view);
  if (!ok) return false;
  deleteSelectedBlock(view);
  return true;
}

/** 删除当前 NodeSelection 覆盖的块；删空后自动补空段落 */
export function deleteSelectedBlock(view: EditorView): void {
  const { state } = view;
  if (!(state.selection instanceof NodeSelection)) return;
  const { from, to } = state.selection;
  const tr = state.tr.delete(from, to);
  // PM 要求 doc 至少一个块：删空后补一个空段落
  if (tr.doc.childCount === 0) {
    const para = state.schema.nodes.paragraph;
    if (para) tr.insert(0, para.create());
  }
  view.dispatch(tr);
  view.focus();
}

/**
 * 在光标处插入剪贴板里的块（阅读模式）。
 *
 * 优先走专用格式的**结构级精确还原**（保留 B6 原文切片）；只有 Markdown 文本时
 * 走 `markdownToDoc` 重新解析。
 */
export async function pasteBlockAtSelection(view: EditorView): Promise<boolean> {
  const data = await readBlockClipboard();
  if (!data) return false;
  const { state } = view;
  const tr = state.tr;
  const insertPos = state.selection.from;
  try {
    const doc = markdownToDoc(data.markdown);
    if (!doc || doc.childCount === 0) return false;
    tr.replaceWith(insertPos, insertPos, doc.content);
    view.dispatch(tr);
    view.focus();
    return true;
  } catch {
    return false;
  }
}

/** 建立指定位置的 NodeSelection（三点菜单「选中该块」用） */
export function selectBlockAt(view: EditorView, pos: number): void {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
  view.focus();
}
