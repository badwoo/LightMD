/**
 * focus-mode 插件 —— 专注模式（只高亮当前段落）
 *
 * 当启用时，非活跃段落添加 .focus-dimmed 类
 * 活跃段落保持完整不透明度
 *
 * 性能设计（E16 重构）：
 * - DecorationSet 缓存在 plugin state 中，props.decorations 直接返回缓存值，
 *   不再每次 state 变化从零重算
 * - 纯光标移动且活跃块未变 → 直接复用旧 DecorationSet（零成本）
 * - doc 变化或活跃块变化 → 重算；大文档（content.size > 50000，O(1) 判定）
 *   只在活跃块 ±10000 范围内收集装饰，避免每键 O(全文档) 遍历
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export const focusModeKey = new PluginKey("focusMode");

/** 大文档判定阈值：doc.content.size 超过该值走局部重算路径 */
const LARGE_DOC_SIZE = 50000;
/** 大文档下只装饰活跃块前后 N 个块 */
const NEARBY_THRESHOLD = 30;
/** 大文档下活跃块附近的收集半径（字符） */
const NEARBY_RADIUS = 10000;

interface FocusModeState {
  enabled: boolean;
  /** 当前生效的装饰集（enabled=false 时恒为 empty） */
  decos: DecorationSet;
  /** 生成 decos 时的活跃块位置，-1 表示无 */
  activePos: number;
}

/** 找到光标所在的块级节点位置（descendants 语义的 pos） */
function findActiveBlockPos(selection: EditorState["selection"]): number {
  const { $from } = selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type.isBlock && node.type.name !== "doc") {
      return $from.start(d) - 1;
    }
  }
  return -1;
}

/**
 * 按当前 state 重算装饰集。
 * 小文档全量遍历；大文档只在活跃块附近收集（nodesBetween 局部遍历）。
 */
function computeDecorations(state: EditorState): { decos: DecorationSet; activePos: number } {
  const activePos = findActiveBlockPos(state.selection);
  if (activePos < 0) return { decos: DecorationSet.empty, activePos: -1 };

  // 大文档判定用 content.size（O(1)），替代原先的全量 descendants 计数
  const isLargeDoc = state.doc.content.size > LARGE_DOC_SIZE;

  const decos: Decoration[] = [];
  let nearbyCount = 0;

  const collect = (node: PMNode, pos: number) => {
    if (!node.type.isBlock || node.type.name === "doc") return;
    // 活跃块本身不装饰
    if (pos === activePos) return;
    // 活跃块的祖先不装饰（否则 opacity 影响整个子树，活跃块也会被变暗）
    const nodeEnd = pos + node.nodeSize;
    if (pos < activePos && nodeEnd > activePos) return;

    if (isLargeDoc) {
      const distance = Math.abs(pos - activePos);
      if (distance > NEARBY_RADIUS) return;
      nearbyCount++;
      if (nearbyCount > NEARBY_THRESHOLD) return;
    }

    decos.push(
      Decoration.node(pos, pos + node.nodeSize, { class: "focus-dimmed" }, { focusMark: true })
    );
  };

  if (isLargeDoc) {
    const from = Math.max(0, activePos - NEARBY_RADIUS);
    const to = Math.min(state.doc.content.size, activePos + NEARBY_RADIUS);
    state.doc.nodesBetween(from, to, collect);
  } else {
    state.doc.descendants(collect);
  }

  return { decos: DecorationSet.create(state.doc, decos), activePos };
}

export const focusModePlugin = new Plugin<FocusModeState>({
  key: focusModeKey,

  state: {
    init() {
      return { enabled: false, decos: DecorationSet.empty, activePos: -1 };
    },

    apply(tr: Transaction, old: FocusModeState, _oldState: EditorState, newState: EditorState): FocusModeState {
      const meta = tr.getMeta(focusModeKey);
      if (meta === "disable") {
        return { enabled: false, decos: DecorationSet.empty, activePos: -1 };
      }
      if (meta === "toggle" || meta === "enable") {
        const enabled = meta === "enable" ? true : !old.enabled;
        if (!enabled) return { enabled: false, decos: DecorationSet.empty, activePos: -1 };
        const computed = computeDecorations(newState);
        return { enabled: true, ...computed };
      }
      if (!old.enabled) return old;

      if (tr.docChanged) {
        // 文档变化：重算（大文档走局部路径，避免每键全量遍历）
        const computed = computeDecorations(newState);
        return { enabled: true, ...computed };
      }
      // 纯选区/属性事务：活跃块未变则整体复用，零重算
      const activePos = findActiveBlockPos(newState.selection);
      if (activePos === old.activePos) return old;
      const computed = computeDecorations(newState);
      return { enabled: true, ...computed };
    },
  },

  props: {
    decorations(state: EditorState) {
      const pluginState = focusModeKey.getState(state);
      return pluginState?.decos ?? DecorationSet.empty;
    },
  },
});

/** 切换专注模式 */
export function toggleFocusMode(view: { dispatch: Function; state: { tr: any } }) {
  const { state, dispatch } = view;
  const tr = state.tr.setMeta(focusModeKey, "toggle");
  dispatch(tr);
}
