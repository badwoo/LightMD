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
import type { Node as PMNode, ResolvedPos } from "prosemirror-model";
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
 * v0.13.0 返修：把「父节点内容坐标系里的**字符偏移**」换算成真实**文档位置**。
 *
 * 缺陷背景：旧实现直接 `$pos.start() + colonIdx`，把字符串下标当作文档位置。
 * 但 `textBetween` 的字符流与文档位置并非一一对应——内联原子（如 `math_inline`）
 * 的 `nodeSize` 远大于其 `textContent` 长度：
 *   段落 `$x^2$ :sm`，math_inline nodeSize=5、textContent="x^2"（长度 3）
 *   → 字符串下标 5 对应的真实位置是 7，旧实现算出的 from 偏小 2，
 *     替换区间 `replaceWith(from, to, …)` 会**吃掉前一个原子节点的内容**
 *     （实测 math_inline 内容被改写为 "x^2:smile:"）。
 *
 * 这里按子节点的 `nodeSize` 逐个累加，并复刻 `textBetween` 的实际语义：
 *   · 文本节点 → 原文本；
 *   · **叶子**行内节点（image / hard_break）→ 调用方传入的 leafText（"\0"，1 字符）；
 *   · **非叶子**行内节点（`math_inline` 等）→ **其 textContent**
 *     （`textBetween` 会递归下钻取其内部文本，实测 `$x^2$` 贡献 "x^2" 而非 "\0"）。
 *
 * 偏移若落在非文本内容里（例如光标前的 `:` 其实在公式源码内）→ 返回 null，
 * 调用方据此**不触发**补全（避免把公式源码当成短码替换掉）。
 */
function parentCharOffsetToDocPos($pos: ResolvedPos, charOffset: number): number | null {
  let chars = 0;
  let pos = $pos.start();
  let result: number | null = null;
  let hitNonText = false;
  $pos.parent.forEach((child: PMNode) => {
    if (result !== null || hitNonText) return;
    const piece = child.isText
      ? (child.text ?? "")
      : child.isLeaf
        ? "\0"
        : child.textContent;
    if (charOffset < chars + piece.length) {
      if (child.isText) result = pos + (charOffset - chars);
      else hitNonText = true; // 命中非文本内容 → 不可用
      return;
    }
    chars += piece.length;
    pos += child.nodeSize;
  });
  if (hitNonText) return null;
  return result ?? pos;
}

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
  // v0.13.0 返修：排除「时间 / 比例」这类误触发。
  //
  // 旧判定只要求「冒号前不是冒号」，而查询词允许数字，于是正文里写时间或比例
  // （`3:1`、`ratio 2:3`、`John 3:16`）都会弹出 emoji 菜单（甚至弹出无候选的空菜单）。
  // 判据取「冒号紧邻的**前一个字符是数字**」——这覆盖了全部时间/比例写法，
  // 同时保留行首/词首的真实短码（`:100` → 冒号前无字符，仍可触发）。
  if (colonIdx > 0 && /\d/.test(textBefore[colonIdx - 1])) return null;
  // v0.13.0 返修：按 nodeSize 换算，不能用「内容起点 + 字符下标」
  const from = parentCharOffsetToDocPos($pos, colonIdx);
  if (from === null) return null; // 偏移落在非文本内容（如公式源码）里 → 不触发
  return {
    from,
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
