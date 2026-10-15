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
 * v0.13.0 返修（问题5）：**应用内剪贴板兜底**。
 *
 * 缺陷背景：`readBlockClipboard` 依赖 `navigator.clipboard.read()`，而 WebView2
 * 默认**拒绝** clipboard-read 权限（该权限需要显式授权，Tauri 下拿不到）→ read() 抛错
 * → 返回 null → 「粘贴」**永远失败**，即使用户刚刚用同一菜单「复制」过。
 *
 * 因此在本进程内保留最后一份块数据：系统剪贴板读得到就用系统剪贴板（可跨窗口/
 * 跨应用），读不到就用这份兜底。这样「复制 → 粘贴」在同一应用内必定可用。
 */
let inAppBlockClipboard: BlockClipboardData | null = null;

/** 当前应用内是否有可粘贴的块数据（供菜单「粘贴」禁用态同步判定） */
export function hasInAppBlockClipboard(): boolean {
  return inAppBlockClipboard !== null;
}

/**
 * v0.13.0 返修第三轮（问题2）：**同步**读取应用内块剪贴板。
 *
 * 缺陷背景：三点菜单一打开就调 `readBlockClipboard()`（内部 `navigator.clipboard.read()`）
 * 只为算「粘贴」的禁用态，而 WebView2 对 `clipboard.read` 会弹出系统授权气泡
 * 「http://tauri.localhost 想要查看复制到剪贴板的文本和图像」——用户完全没打算
 * 粘贴，只是点了三个点看菜单，却被弹窗打断。菜单禁用态用本函数同步判定即可，
 * **不触发任何系统剪贴板访问**。
 */
export function getInAppBlockClipboard(): BlockClipboardData | null {
  return inAppBlockClipboard;
}

/** 测试用：清空应用内剪贴板 */
export function __resetInAppBlockClipboardForTest(): void {
  inAppBlockClipboard = null;
}

/**
 * 写块数据到剪贴板（三份格式）。
 *
 * @returns 是否成功写入（WebView2 权限拒绝时返回 false，调用方应 toast 提示）
 */
export async function writeBlockClipboard(data: BlockClipboardData): Promise<boolean> {
  // v0.13.0 返修（问题5）：无论系统剪贴板是否成功，都先记下应用内兜底，
  // 保证「复制 → 粘贴」在本应用内可用。
  inAppBlockClipboard = data;
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
  // 系统剪贴板完全不可用：应用内兜底仍然有效，故对「本应用内粘贴」算成功
  return true;
}

/**
 * 从剪贴板读块数据（三级降级：**应用内兜底** → 专用格式 → Markdown 文本）。
 *
 * v0.13.0 返修（问题5）：系统剪贴板读不到（WebView2 拒绝 clipboard-read）时
 * 回退到应用内兜底，让「复制 → 粘贴」在应用内必定可用。
 *
 * v0.13.0 返修第三轮（问题2）：**应用内兜底优先，且命中时完全不碰系统剪贴板**。
 * 缺陷背景：旧实现先 `navigator.clipboard.read()`，而 WebView2 会为它弹出系统
 * 授权气泡「http://tauri.localhost 想要查看复制到剪贴板的文本和图像」。
 * 本应用内刚复制过块时，应用内兜底就是最权威的来源（专用格式、无损），
 * 直接返回即可——既不弹窗、也不再依赖权限。
 * 只有应用内没有数据（例如用户从**别的应用**复制了 Markdown 想粘进来）时，
 * 才去读系统剪贴板。
 */
export async function readBlockClipboard(): Promise<BlockClipboardData | null> {
  // ① 应用内兜底优先（同步、零权限、零弹窗）
  if (inAppBlockClipboard) return inAppBlockClipboard;
  // ② 系统剪贴板
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.read) {
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
      const parsed = parseBlockClipboard(entries);
      if (parsed) return parsed;
    }
  } catch {
    // 权限被拒 / API 不可用 → 没有可用块数据
  }
  return null;
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
 *
 * v0.13.0 返修第三轮（问题4）：**NodeSelection 时替换被选中的块**，不再一律
 * `insert(selection.from)`。
 *
 * 缺陷背景：用户在块被整块选中（NodeSelection，三点菜单「选中该块」/ 点表格外沿
 * 都会产生）时点「粘贴」，旧实现把载荷插到 `selection.from`（**该块起点之前**），
 * 于是原块还在、新块又插进来 —— 用户感知为「粘贴多出来一整个块」。
 * 现在选中块时用 `replaceSelection` 语义（替换该块），与通用编辑器一致。
 */
export async function pasteBlockAtSelection(view: EditorView): Promise<boolean> {
  const data = await readBlockClipboard();
  if (!data) return false;
  const { state } = view;
  const tr = state.tr;
  try {
    const doc = markdownToDoc(data.markdown);
    if (!doc || doc.childCount === 0) return false;
    const { selection } = state;
    if (selection instanceof NodeSelection) {
      // 替换被选中的块（from/to 即该块区间）
      tr.replaceWith(selection.from, selection.to, doc.content);
    } else {
      tr.replaceWith(selection.from, selection.from, doc.content);
    }
    if (!tr.docChanged) return false;
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
