/**
 * aiGhost 插件 —— AI 续写幽灵文本装饰（v0.7.0）
 *
 * 行为：
 * - EditorContainer 通过 setAiGhost/clearAiGhost 以 meta 驱动更新（流式 chunk 追加）
 * - 在指定 pos 渲染灰色斜体 ghost 文本 widget（含「Tab 采纳 · Esc 放弃」提示）
 * - 文档被编辑（docChanged 且非本插件 meta 事务）时自动清除，
 *   避免用户编辑后 ghost 位置语义漂移
 * - ghost 文本仅是装饰：不进文档、不触发 onDocChange、不计入撤销栈；
 *   Tab 采纳时由入口层按 markdown 解析一次性插入
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface AiGhostState {
  /** ghost 插入点（光标位置） */
  pos: number;
  /** 流式累积的续写文本 */
  text: string;
  /**
   * v0.7.5 优化3：是否为"等待首个增量"的占位提示（如「续写中...」）。
   *
   * 用户点击 AI 续写后模型首包可能要等数秒，此前这段时间界面毫无反馈。
   * 现在发起任务时立即以占位提示启动 ghost，首个真实增量到达即替换。
   * 占位态的文本是提示语而非正文，**不可采纳**（Tab 会把提示语当正文插入），
   * 故 Tab 采纳前必须检查此标记（见 EditorContainer 的 ghost keydown 处理）。
   */
  placeholder?: boolean;
}

export const aiGhostKey = new PluginKey<AiGhostState | null>("aiGhost");

/** 更新/启动 ghost（流式追加时重复调用；placeholder=true 表示等待首个增量的占位提示） */
export function setAiGhost(view: EditorView, pos: number, text: string, placeholder = false): void {
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(aiGhostKey, { pos, text, placeholder }));
}

/** 清除 ghost（Tab 采纳插入后 / Esc 放弃后） */
export function clearAiGhost(view: EditorView): void {
  if (view.isDestroyed) return;
  const cur = aiGhostKey.getState(view.state);
  if (cur) view.dispatch(view.state.tr.setMeta(aiGhostKey, null));
}

/** 构建 ghost 文本 widget DOM（灰斜体 + 采纳提示）。
 *  v0.7.3 改进8(D5)：hintText 由入口层注入（i18n），不再硬编码中文
 *  v0.7.5 优化3：占位态（续写中…）不显示采纳提示（此时尚不可采纳） */
function createGhostWidget(state: AiGhostState, hintText: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = state.placeholder ? "ai-ghost ai-ghost-placeholder" : "ai-ghost";
  const text = document.createElement("span");
  text.className = "ai-ghost-text";
  text.textContent = state.text;
  wrap.appendChild(text);
  if (!state.placeholder) {
    const hint = document.createElement("span");
    hint.className = "ai-ghost-hint";
    hint.textContent = hintText;
    wrap.appendChild(hint);
  }
  return wrap;
}

export function aiGhostPlugin(hintText = "Tab ⏎ · Esc ✕"): Plugin<AiGhostState | null> {
  return new Plugin<AiGhostState | null>({
    key: aiGhostKey,
    state: {
      init: () => null,
      apply(tr, prev) {
        const meta = tr.getMeta(aiGhostKey);
        if (meta !== undefined) return meta as AiGhostState | null;
        // 文档编辑（含撤销/重做）时清除 ghost：位置语义已失效
        if (prev && tr.docChanged) return null;
        return prev;
      },
    },
    props: {
      decorations(state) {
        const ghost = aiGhostKey.getState(state);
        if (!ghost || !ghost.text) return DecorationSet.empty;
        // v0.7.1 修复：key 必须携带内容指纹——PM 的 WidgetType.eq 在 key 相同
        // 时判定 widget 未变化（matchesWidget 复用旧 DOM，不再调用 toDOM），
        // 固定 key 会导致流式 chunk 到达后 widget 永远停留在第一个 chunk 的
        // 内容。key 含 text.length：文本追加即变化 → widget 重建 → 显示最新
        // v0.7.5：key 另含 placeholder 标记——占位提示与首个真实增量若长度恰好
        // 相同（如都被截断到同一长度）否则不会重建 widget，占位文案会残留
        const widget = Decoration.widget(ghost.pos, () => createGhostWidget(ghost, hintText), {
          key: `ai-ghost-${ghost.placeholder ? "p" : "t"}-${ghost.text.length}`,
          side: 1,
        });
        return DecorationSet.create(state.doc, [widget]);
      },
    },
  });
}
