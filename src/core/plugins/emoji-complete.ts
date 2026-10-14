/**
 * v0.13.0 需求10：Emoji 短码补全（阅读模式）。
 *
 * ## 触发
 *
 * 光标位于 paragraph / heading 内、且光标前的块内文本匹配
 * `:` + 字母数字（`^\s*:(\w*)$` 形态的**尾部一段**）→ 弹出候选。
 *
 * 与 slash 命令（行首 `/`）不同，emoji 触发点是**行内任意位置**的 `:`，
 * 因此判定取「光标前最近的一个未闭合 `:`」。
 *
 * ## 交互（复用 slash-command 的插件形态）
 *
 * 插件只做状态检测 + 回调（`onStateChange`），UI 与键盘导航由 React 层
 * （`SlashCommandPm` 同款 portal 模式）负责——与 translateTooltip /
 * slash-command 的既有分工一致。
 *
 * ## 采纳
 *
 * 插入 `:name:` **文本**（非 unicode）—— 随后被 `emoji-render.ts` 的
 * Decoration 渲染为图形，而存盘仍是短码（源码可逆，与 v0.11.0 B4 决策一致）。
 *
 * ## 代码块等不触发
 *
 * 与 slash 判定同口径：只在 paragraph / heading 内触发（代码块/公式内
 * 输入 `:` 是正常字符，不该弹菜单）。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** Emoji 触发状态：from 为 `:` 位置，to 为光标位置（替换区间 [from, to]） */
export interface EmojiState {
  /** 触发 `:` 的文档位置 */
  from: number;
  /** 光标位置（= 已输入查询词的结束） */
  to: number;
  /** 已输入的过滤词（不含冒号） */
  query: string;
}

/** 光标前的块内文本中，最后一个未闭合 `:` 及其后的查询词 */
const EMOJI_TAIL_RE = /:([a-zA-Z0-9_+-]*)$/;

/**
 * 检测编辑器当前是否处于 Emoji 补全触发状态（纯函数）。
 *
 * 条件：
 * - 空选区（光标态）；
 * - 位于 paragraph / heading 内；
 * - 光标前的块内文本以 `:name` 结尾（name 可为空 → 刚打出冒号）。
 */
export function detectEmojiState(state: EditorState): EmojiState | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  const parent = $pos.parent;
  if (parent.type.name !== "paragraph" && parent.type.name !== "heading") return null;
  const textBefore = parent.textBetween(0, $pos.parentOffset, "\n", "\0");
  const m = EMOJI_TAIL_RE.exec(textBefore);
  if (!m) return null;
  // 冒号前不能再有冒号（`::` 通常是连续两个短码，不触发）
  // 说明：正则已保证「最后一个冒号到文本末尾」，此处只需排除前一个字符也是冒号
  const colonIdx = textBefore.length - (m[0].length);
  if (colonIdx > 0 && textBefore[colonIdx - 1] === ":") return null;
  return {
    from: $pos.start() + colonIdx,
    to: $pos.pos,
    query: m[1] ?? "",
  };
}

/** 插件 key（外部可读取插件状态做断言） */
export const emojiPluginKey = new PluginKey<EmojiState | null>("emojiCompletePm");

/**
 * 创建 Emoji 补全插件。
 *
 * @param onStateChange 状态变化回调（触发 → EmojiState；失效 → null）
 */
export function createEmojiCompletePlugin(onStateChange: (s: EmojiState | null) => void) {
  let last: EmojiState | null = null;
  return new Plugin<EmojiState | null>({
    key: emojiPluginKey,
    view() {
      return {
        update(v: EditorView, prevState: EditorState) {
          // 纯光标移动（文档未变）不触发——与 slash 判定一致，避免一移动光标就弹菜单
          if (v.state.doc === prevState.doc) return;
          const s = detectEmojiState(v.state);
          if (s?.from === last?.from && s?.to === last?.to && s?.query === last?.query) return;
          last = s;
          onStateChange(s);
        },
      };
    },
  });
}

/**
 * 采纳某个候选：把 `:query` 区间替换为 `:name:` 文本。
 *
 * 插的是**短码文本**而非 unicode：Decoration 负责渲染图形，存盘保持源码可逆。
 * 若 `name` 与已输入的 query 相同，则退化为普通插入（用户就是要这个）。
 *
 * @returns 是否成功应用
 */
export function applyEmojiCandidate(view: EditorView, name: string, emoji: EmojiState): boolean {
  if (!name) return false;
  const { state } = view;
  const insert = `:${name}:`;
  const tr = state.tr.replaceWith(emoji.from, emoji.to, state.schema.text(insert));
  // 光标停在插入内容之后
  const end = emoji.from + insert.length;
  try {
    const sel = (state.selection.constructor as unknown as {
      create: (doc: typeof state.doc, pos: number) => typeof state.selection;
    }).create(tr.doc, end);
    tr.setSelection(sel);
  } catch {
    // 定位失败时保持 replaceWith 的默认选区
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}
