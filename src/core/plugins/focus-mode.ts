/**
 * focus-mode 插件 —— 专注模式（只高亮当前段落）
 *
 * 当启用时，非活跃段落添加 .focus-dimmed 类
 * 活跃段落保持完整不透明度
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

    apply(tr, state) {
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
      let activeBlockPos = -1;
      for (let d = $from.depth; d >= 0; d--) {
        const node = $from.node(d);
        if (node.type.isBlock && node.type.name !== "doc") {
          activeBlockPos = $from.start(d);
          break;
        }
      }

      // 统计块节点数量，大文档使用距离阈值
      let blockCount = 0;
      state.doc.descendants((node) => {
        if (node.type.isBlock && node.type.name !== "doc") blockCount++;
      });
      const isLargeDoc = blockCount > 200;

      // 给所有非活跃的块级节点添加 dimmed 类装饰
      state.doc.descendants((node, pos) => {
        if (node.type.isBlock && node.type.name !== "doc") {
          if (pos !== activeBlockPos) {
            // 大文档：只装饰距离活跃块 5000 字符以内的节点（避免全量创建对象）
            if (isLargeDoc && Math.abs(pos - activeBlockPos) > 5000) {
              return;
            }
            decos.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: "focus-dimmed",
              })
            );
          }
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
