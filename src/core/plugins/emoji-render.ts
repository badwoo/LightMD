/**
 * v0.11.0 B4-8 / v0.12.2 P1：Emoji 短码在阅读模式显示为图形（显示层与存储层解耦）。
 *
 * 缺陷背景：
 *   `parser.ts`（v0.9.0 D9 决策）**故意**把 `:smile:` 保留为短码原文，
 *   以保证源码写法可逆 —— 这个决策是对的，不该改。
 *   但结果是：阅读模式（走 ProseMirror toDOM）显示 `:smile:` 文字，
 *   而分屏/导出（走 markdown-it）正常渲染为 😄 → **两种模式不一致**。
 *
 * ─── v0.12.2 P1 修复：原实现（text 节点 NodeView）会导致编辑器崩溃 ───
 *
 * 原实现为 **`text` 节点**注册 NodeView 并返回 `<span>`。这有两处致命问题：
 *
 * ① **崩溃（P0）**：ProseMirror 硬性要求 text 节点必须渲染为 DOM text node
 *    （prosemirror-view `create()`：`else if (dom.nodeType != 3) throw new RangeError`）。
 *    返回 `<span>` 会在 `new EditorView(...)` 时抛 `RangeError: Text must be
 *    rendered as a DOM text node`；而 createEditor 无 try/catch、应用无 ErrorBoundary
 *    → 打开任何含可识别短码的文档都会白屏。
 *
 * ② **光标定位失效**：即使改成返回 DOM text node，`text` 节点一旦走自定义 spec
 *    就会变成 `CustomNodeViewDesc`，而该类**不实现 `localPosFromDOM`**，于是
 *    `posAtDOM` 退化为「整个文本节点只映射到一个位置」。实测（jsdom + 真实
 *    prosemirror-view）：`hello :smile: world` 的 15 个 DOM 偏移**全部**映射到
 *    docPos=1 —— 点哪里光标都跳到段首。且与内容长度无关（等长替换同样失效）。
 *
 * 因此 text NodeView 这条路**整体不可用**，改用 **Decoration**：
 *   · 短码区间加 `Decoration.inline` + `data-emoji` 属性，由 CSS 用
 *     `::before { content: attr(data-emoji) }` 叠加显示 emoji 图形；
 *   · 原短码文字用 `font-size:0` 收起（不删 DOM 文本，**长度与 doc 一致**
 *     → 位置映射完全不受影响）；
 *   · 无 NodeView ⇒ 仍是标准 `TextViewDesc`，`posAtDOM`/`coordsAtPos`/选区全部正常。
 *
 * 映射表来源：借 markdown-it-emoji 插件本身（`md.render(":smile:")` 的输出），
 * 保证与插件口径完全一致，不自行维护 emoji 表（避免与插件版本脱节）。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import type MarkdownIt from "markdown-it";

export const emojiRenderKey = new PluginKey<DecorationSet>("emojiRender");

/** 短码正则：`:name:`（name 为字母数字下划线加号减号，与 emoji 插件一致） */
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;

/** 预检用：文本里是否存在任意「短码形态」（不判断是否可识别，廉价） */
const SHORTCODE_ANY_RE = /:[a-zA-Z0-9_+-]+:/;

/** 缓存：shortcode → unicode（避免每次渲染重复解析） */
const unicodeCache = new Map<string, string | null>();

/**
 * 用 markdown-it-emoji 插件把短码解析为 unicode。
 *
 * 借插件自身能力（而非内置表）保证与 markdown-it 渲染结果一致：
 * 插件不认识的短码返回 null（保持原文，不误替换）。
 */
export function resolveUnicode(md: MarkdownIt, shortcode: string): string | null {
  if (unicodeCache.has(shortcode)) return unicodeCache.get(shortcode)!;
  let result: string | null = null;
  try {
    // 实测（markdown-it-emoji full 版）：输出的是**裸 unicode**，无 span 包裹
    //   md.render("hello :smile: world") → '<p>hello 😄 world</p>\n'
    // 故取 <p> 与 </p> 之间的内容；未识别的短码会原样返回 :name:
    const html = md.render(`:${shortcode}:`).trim();
    const m = /^<p>([\s\S]*)<\/p>$/.exec(html);
    const inner = (m?.[1] ?? "").trim();
    if (inner && !inner.includes(":")) result = inner;
  } catch {
    result = null;
  }
  unicodeCache.set(shortcode, result);
  return result;
}

/** 清空缓存（测试用） */
export function clearEmojiCache(): void {
  unicodeCache.clear();
}

/**
 * 把文本中的所有可识别短码替换为 unicode。
 *
 * @param text 原始文本
 * @param md   markdown-it 实例（须已 use emoji 插件）
 * @returns 替换后的文本；无可识别短码时原样返回（同一引用）
 */
export function renderEmojiInText(text: string, md: MarkdownIt): string {
  if (!text.includes(":")) return text;
  // 逐段判断，避免无短码时产生新字符串
  let hasMatch = false;
  SHORTCODE_RE.lastIndex = 0;
  let probe: RegExpExecArray | null;
  while ((probe = SHORTCODE_RE.exec(text)) !== null) {
    if (resolveUnicode(md, probe[1]!)) {
      hasMatch = true;
      break;
    }
  }
  if (!hasMatch) return text;

  let out = "";
  let last = 0;
  SHORTCODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHORTCODE_RE.exec(text)) !== null) {
    const unicode = resolveUnicode(md, m[1]!);
    if (!unicode) continue;
    out += text.slice(last, m.index) + unicode;
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return out;
}

/**
 * 收集一个文本节点内所有「可识别短码」的区间（纯函数，便于单测）。
 *
 * @param text 文本节点内容
 * @param start 该文本节点在文档中的起始位置（绝对 doc pos）
 * @param md   markdown-it 实例（须已 use emoji 插件）
 * @returns 每个可识别短码的 {from,to,unicode}（绝对位置）
 */
export function collectEmojiRanges(
  text: string,
  start: number,
  md: MarkdownIt,
): Array<{ from: number; to: number; unicode: string }> {
  const out: Array<{ from: number; to: number; unicode: string }> = [];
  if (!text.includes(":")) return out;
  SHORTCODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHORTCODE_RE.exec(text)) !== null) {
    const unicode = resolveUnicode(md, m[1]!);
    if (!unicode) continue;
    out.push({ from: start + m.index, to: start + m.index + m[0].length, unicode });
  }
  return out;
}

/**
 * 判断某个文本节点是否应跳过 emoji 替换。
 *
 * 行内代码用 `code` **mark** 承载（不是节点），代码块由 CodeBlockView 整体接管，
 * 因此这里只需检查 mark。
 */
function isCodeContext(node: PMNode): boolean {
  return node.marks.some((m) => m.type.name === "code");
}

/** 依据当前文档计算 emoji 装饰集 */
function computeDecorations(state: EditorState, getMd: () => MarkdownIt): DecorationSet {
  let md: MarkdownIt | null = null;
  const decos: Decoration[] = [];

  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    // 预检 1：不含冒号（绝大多数节点在此短路，零开销）
    if (!text.includes(":")) return true;
    // 预检 2：无短码形态（如 "a:b"）
    if (!SHORTCODE_ANY_RE.test(text)) return true;
    // 预检 3：代码语境不替换
    if (isCodeContext(node)) return true;
    // 预检 4：惰性取 markdown-it（仅在真的出现短码形态时才加载）
    if (!md) {
      try {
        md = getMd();
      } catch {
        return false;
      }
      if (!md) return false;
    }
    for (const r of collectEmojiRanges(text, pos, md)) {
      decos.push(
        Decoration.inline(r.from, r.to, {
          class: "emoji-shortcode",
          "data-emoji": r.unicode,
        }),
      );
    }
    return true;
  });

  return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
}

/**
 * Emoji 渲染插件（v0.12.2 P1：由 text NodeView 改为 Decoration）。
 *
 * @param getMd 惰性获取 markdown-it 实例（避免编辑器初始化时加载插件）
 */
export function emojiRenderPlugin(getMd: () => MarkdownIt): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: emojiRenderKey,
    state: {
      init(_config, state) {
        return computeDecorations(state, getMd);
      },
      apply(tr, old, _oldState, newState) {
        // 文档未变 → 复用（零成本）
        if (!tr.docChanged) return old;
        // 文档变化：重算。遍历成本 O(文档文本)，但每节点先做不含冒号的廉价预检，
        // 只有真含短码形态的节点才会走到 markdown-it 解析。
        return computeDecorations(newState, getMd);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

/** 供测试使用的辅助：判断文本是否含可识别短码 */
export function hasRenderableShortcode(text: string, md: MarkdownIt): boolean {
  if (!text.includes(":")) return false;
  SHORTCODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHORTCODE_RE.exec(text)) !== null) {
    if (resolveUnicode(md, m[1]!)) return true;
  }
  return false;
}
