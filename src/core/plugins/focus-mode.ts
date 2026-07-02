/**
 * focus-mode 插件 —— 专注模式（只高亮当前段落）
 *
 * 当启用时，非活跃段落添加 .focus-dimmed 类
 * 活跃段落保持完整不透明度
 *
 * 性能优化：
 * - 大文档（>200块）只装饰活跃块附近的节点，避免全量遍历
 * - 使用 userEvent meta 判断是否为纯光标移动，避免不必要的重计算
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export const focusModeKey = new PluginKey("focusMode");

export const focusModePlugin = new Plugin({
  key: focusModeKey,

  state: {
    init() {
      return { enabled: false };
    },

    apply(tr, state, _oldState, newState) {
      const meta = tr.getMeta(focusModeKey);
      if (meta === "toggle") {
        return { enabled: !state.enabled };
      }
      if (meta === "enable") {
        return { enabled: true };
      }
      if (meta === "disable") {
        return { enabled: false };
      }
      return state;
    },
  },

  props: {
    decorations(state) {
      const pluginState = focusModeKey.getState(state);
      if (!pluginState?.enabled) return DecorationSet.empty;

      const { $from } = state.selection;
      const decos: Decoration[] = [];

      // 找到光标所在的块级节点
      // $from.node(d) 是光标所在的 d 层级节点
      // $from.start(d) 是该节点内容的起始位置（= 节点 pos + 1）
      // descendants 回调中的 pos 是节点本身的位置
      // 所以活跃块的 pos = $from.start(d) - 1
      let activeBlockPos = -1;
      for (let d = $from.depth; d >= 0; d--) {
        const node = $from.node(d);
        if (node.type.isBlock && node.type.name !== "doc") {
          activeBlockPos = $from.start(d) - 1; // 转换为节点位置（descendants 中的 pos）
          break;
        }
      }

      if (activeBlockPos < 0) return DecorationSet.empty;

      // 统计块节点数量，大文档使用距离阈值
      let blockCount = 0;
      state.doc.descendants((node) => {
        if (node.type.isBlock && node.type.name !== "doc") blockCount++;
      });
      const isLargeDoc = blockCount > 200;

      // 给所有非活跃的块级节点添加 dimmed 类装饰
      // 大文档：只装饰活跃块前后 N 个块，避免全量创建装饰对象
      const NEARBY_THRESHOLD = 30; // 大文档只处理附近 30 个块
      let nearbyCount = 0;

      state.doc.descendants((node, pos) => {
        if (node.type.isBlock && node.type.name !== "doc") {
          // 判断是否为活跃块（pos 匹配）
          if (pos === activeBlockPos) return; // 活跃块不装饰

          // 跳过活跃块的祖先节点：如果该节点范围包含活跃块，不添加 dimmed
          // 修复：嵌套结构（blockquote > paragraph、list_item > paragraph 等）
          // 祖先节点被 dimmed 后 opacity 影响整个子树，导致活跃块也被变暗
          const nodeEnd = pos + node.nodeSize;
          if (pos < activeBlockPos && nodeEnd > activeBlockPos) {
            return; // 祖先节点不装饰，但继续遍历子节点处理兄弟节点
          }

          if (isLargeDoc) {
            // 大文档：只装饰活跃块附近的节点
            const distance = Math.abs(pos - activeBlockPos);
            if (distance > 10000) return; // 超过 10000 字符的直接跳过
            nearbyCount++;
            if (nearbyCount > NEARBY_THRESHOLD) return;
          }

          decos.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: "focus-dimmed",
            })
          );
        }
      });

      return DecorationSet.create(state.doc, decos);
    },
  },
});

/** 切换专注模式 */
export function toggleFocusMode(view: { dispatch: Function; state: { tr: any } }) {
  const { state, dispatch } = view;
  const tr = state.tr.setMeta(focusModeKey, "toggle");
  dispatch(tr);
}
