/**
 * v0.12.2 P6：标题锚点 id 与文本保持同步。
 *
 * ─── 缺陷背景 ───
 *
 * 0.11.0 B4-5 把标题 `id` 从「toDOM 时按文本现算」提升为**节点属性**（修好了
 * 重名去重口径不一致导致的 TOC 跳转失效）。但 `id` 只在**解析时**写入一次：
 *
 *   `parser.ts` 解析 markdown → heading-attr 由 markdown-it 的 collectHeadings 写好；
 *   此后在阅读模式改标题文本，**没有任何机制重算 id**。
 *
 * 而 `toc-update.ts` 的 `collectHeadings(doc)` 是按**当前 textContent** 重算 slug 的：
 *   → 正文标题 DOM 仍是 `id="old-title"`，TOC 里却生成 `href="#new-title"`，
 *     点击跳转失败（`[toc]` 与同名锚点链接都受影响）。
 *
 * 实测（真实 parser）：`# Same`×3 → id 依次 `same` / `same-1` / `same-2`（去重正确）；
 * 改第二个标题文本后其 id 不更新，而 TOC 已按新文本重算 → 失配。
 *
 * ─── 修复 ───
 *
 * 新增本插件：docChanged 时重扫全部标题，把每个 heading 的 `id` 重设为
 * 「按当前文本 slugify + 同名去重（首次不加后缀、第 2 次 -1、第 3 次 -2…）」，
 * 口径与 `heading-anchor.collectHeadings` / `toc-update.collectHeadings` **完全一致**
 * （复用同一 `slugify`）。
 *
 * 设计要点（与 toc-update 同款）：
 * - 仅在 id 真的需要变化时才产生事务（无标题变化时零事务、零重排）；
 * - 单事务一次性改完所有标题（一次撤销）；
 * - `setMeta` 标记来源，防 appendTransaction 自触发死循环；
 * - 与 toc-update 独立：即使文档没有 `[toc]`，锚点链接也依赖 id，故本插件不依赖 toc。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { slugify } from "../markdown/heading-anchor";

export const headingIdSyncKey = new PluginKey("headingIdSync");

/**
 * 按当前文本计算每个标题应有的 id（与 heading-anchor 同口径）。
 *
 * 去重规则：首次出现不加后缀，第 2 次 `-1`，第 3 次 `-2`……
 *
 * @returns `{pos, id}` 列表（pos 为 heading 节点起始位置）
 */
export function computeHeadingIds(doc: PMNode): Array<{ pos: number; id: string }> {
  const out: Array<{ pos: number; id: string }> = [];
  const usedIds = new Map<string, number>();

  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    const rawId = slugify(text) || "heading";
    const used = usedIds.get(rawId) || 0;
    const id = used === 0 ? rawId : `${rawId}-${used}`;
    usedIds.set(rawId, used + 1);
    out.push({ pos, id });
    return true;
  });

  return out;
}

/**
 * 构造同步 heading id 的事务（纯函数，便于单测）。
 *
 * @returns 需要更新的 transaction；无需更新时返回 null
 */
export function buildHeadingIdSyncTransaction(state: EditorState): Transaction | null {
  const wanted = computeHeadingIds(state.doc);
  if (wanted.length === 0) return null;

  const tr = state.tr;
  let changed = false;

  for (const { pos, id } of wanted) {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type.name !== "heading") continue;
    if (node.attrs.id === id) continue; // 已一致，跳过
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
    changed = true;
  }

  return changed ? tr : null;
}

/**
 * 标题 id 同步插件。
 *
 * 用 appendTransaction 在每次文档变化后同步（同步执行、无防抖）：
 * 标题数量通常很少，且只在 id 真的不一致时才产生事务，成本可忽略。
 * （toc-update 用 300ms 防抖是因为它要重算整棵目录并改 toc 节点 attrs，
 *   而本插件只做 O(标题数) 的比较，无需防抖。）
 */
export function headingIdSyncPlugin(): Plugin {
  return new Plugin({
    key: headingIdSyncKey,
    appendTransaction(transactions, _oldState, newState) {
      // 忽略自身发起的事务，防死循环
      if (transactions.some((t) => t.getMeta(headingIdSyncKey))) return null;
      if (!transactions.some((t) => t.docChanged)) return null;
      const tr = buildHeadingIdSyncTransaction(newState);
      return tr ? tr.setMeta(headingIdSyncKey, true) : null;
    },
  });
}
