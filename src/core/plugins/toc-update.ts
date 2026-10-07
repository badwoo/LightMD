/**
 * v0.11.0 B4-7：TOC 目录在阅读模式自动更新。
 *
 * 缺陷背景（P1）：
 *   `parser.ts` 解析时把标题列表序列化进 `toc` 节点的 attrs.headings，
 *   `schema.ts` 的 toDOM 只渲染该**快照**，全项目无更新机制
 *   → 阅读模式下改标题后 `[toc]` 目录**不更新**。
 *   而分屏预览与导出走 markdown-it 每次重新扫描（toc-plugin.ts），
 *   是正确的 → **两种编辑模式行为不一致**。
 *
 * 修复：新增 tocUpdatePlugin —— appendTransaction 检测 doc 变化 →
 * 重新扫描全文标题 → setNodeMarkup 更新 toc 节点 attrs。
 *
 * 设计要点：
 * - debounce 300ms：避免每次击键都全量重扫标题（长文档标题多时代价明显）；
 * - 无 toc 节点时零开销：先 doc.descendants 短路判定，不触发任何事务；
 * - 标题扫描与 heading-anchor 保持同一套 level/text 口径。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
// v0.11.0 B4-5：复用 markdown-it 侧的 slugify，保证 TOC 链接与正文标题 id 同口径
import { slugify, type TocHeading } from "../markdown/heading-anchor";
import type { EditorView } from "prosemirror-view";

export const tocUpdateKey = new PluginKey("tocUpdate");

/** 标题项（与 markdown/heading-anchor 的 TocHeading 同构） */
export type TocHeadingItem = TocHeading;

/**
 * 标题锚点 slug 化：**直接复用 markdown-it 侧的 slugify**。
 *
 * v0.11.0 B4-5 修正：本模块原先自带一份 slugify 副本且**去重口径与
 * heading-anchor 不一致** —— heading-anchor 首次重名加 `-1`，本模块加 `-2`。
 * 后果：阅读模式 TOC 里第二个「Same」链接指向 `#same-2`，而正文渲染出的
 * 标题 id 是 `#same-1` → **点击跳不过去**。现改为共用同一实现与口径。
 */
const sharedSlugify = slugify;

/**
 * 扫描文档中的全部标题。
 *
 * 去重口径与 heading-anchor.collectHeadings 完全一致：
 * 首次出现不加后缀，第二次 `-1`，第三次 `-2`……
 *
 * @returns 标题列表；无标题返回空数组
 */
export function collectHeadings(doc: PMNode): TocHeadingItem[] {
  const out: TocHeadingItem[] = [];
  // 原始 slug → 已使用次数（与 heading-anchor 的 usedIds 同口径）
  const usedIds = new Map<string, number>();

  doc.descendants((node) => {
    if (node.type.name !== "heading") return true;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    const rawId = sharedSlugify(text) || "heading";
    const used = usedIds.get(rawId) || 0;
    const id = used === 0 ? rawId : `${rawId}-${used}`;
    usedIds.set(rawId, used + 1);
    out.push({ level: Number(node.attrs.level) || 1, text, id });
    return true;
  });
  return out;
}

/** 文档内是否含 toc 节点（快速短路，避免无谓计算） */
function hasTocNode(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === "toc") {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * 生成 toc 节点的新 attrs（JSON 字符串）。
 * 标题为空时返回 "[]"，避免残留旧目录。
 */
export function buildTocHeadingsAttr(headings: TocHeadingItem[]): string {
  return JSON.stringify(headings);
}

/**
 * 构造更新 toc attrs 的 transaction（纯函数，便于单测）。
 *
 * @returns 需要更新的 transaction；无需更新时返回 null
 */
export function buildTocUpdateTransaction(
  state: EditorState,
  newHeadings: TocHeadingItem[],
): Transaction | null {
  const doc = state.doc;
  if (!hasTocNode(doc)) return null;

  const attr = buildTocHeadingsAttr(newHeadings);
  const tr = state.tr;
  let changed = false;

  doc.descendants((node, pos) => {
    if (node.type.name !== "toc") return true;
    if (node.attrs.headings === attr) return true; // 无变化
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, headings: attr });
    changed = true;
    return true;
  });

  return changed ? tr : null;
}

/**
 * TOC 自动更新插件。
 *
 * @param debounceMs 击键后延迟多久重算（默认 300ms）
 */
export function tocUpdatePlugin(debounceMs = 300): Plugin {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 持有 view 引用以在 debounce 回调中 dispatch */
  let viewRef: EditorView | null = null;

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const view = viewRef;
      if (!view || !view.dom.isConnected) return;
      const headings = collectHeadings(view.state.doc);
      const tr = buildTocUpdateTransaction(view.state, headings);
      // setMeta 标记来源，避免本插件自己触发的 docChanged 再次调度（死循环防护）
      if (tr) view.dispatch(tr.setMeta(tocUpdateKey, true));
    }, debounceMs);
  };

  return new Plugin({
    key: tocUpdateKey,
    view(editorView) {
      viewRef = editorView;
      return {
        destroy() {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          viewRef = null;
        },
      };
    },
    appendTransaction(transactions, _oldState, newState) {
      // 忽略由本插件自己发起的事务（防无限循环）
      if (transactions.some((t) => t.getMeta(tocUpdateKey))) return null;
      if (!transactions.some((t) => t.docChanged)) return null;
      // 无 toc 节点 → 零开销，不调度
      if (!hasTocNode(newState.doc)) return null;
      // 无 view（如纯逻辑测试环境）时同步计算，行为一致
      if (!viewRef) {
        const headings = collectHeadings(newState.doc);
        return buildTocUpdateTransaction(newState, headings);
      }
      schedule();
      return null;
    },
  });
}
