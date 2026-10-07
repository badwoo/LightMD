/**
 * v0.11.0 B4-8：Emoji 短码在阅读模式显示为图形（显示层与存储层解耦）。
 *
 * 缺陷背景（P1）：
 *   `parser.ts`（v0.9.0 D9 决策）**故意**把 `:smile:` 保留为短码原文，
 *   以保证源码写法可逆 —— 这个决策是对的，不该改。
 *   但结果是：阅读模式（走 ProseMirror toDOM）显示 `:smile:` 文字，
 *   而分屏/导出（走 markdown-it）正常渲染为 😄 → **两种模式不一致**。
 *
 * 修复思路（不改 doc、不改序列化）：
 *   在**序列化出口**把短码渲染为 unicode。`text` 节点是 leaf，
 *   ProseMirror 对 leaf 节点的 toDOM 无法按位置切分文本，因此
 *   改用 **NodeView**（plaintext 节点）承载：在 toDOM 里把 `:smile:`
 *   替换为 unicode，同时保证 `doc` 与 `serialize` 完全不变。
 *
 * 映射表来源：借 markdown-it-emoji 插件本身（`md.render(":smile:")` 的输出），
 * 保证与插件口径完全一致，不自行维护 emoji 表（避免与插件版本脱节）。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type MarkdownIt from "markdown-it";
import type { NodeViewConstructor } from "prosemirror-view";

export const emojiRenderKey = new PluginKey("emojiRender");

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
 * 文本节点 NodeView：在 DOM 里把短码渲染为 unicode，
 * 但 **doc 与序列化完全不变**（NodeView 不参与 markdown 序列化）。
 */
class EmojiTextView {
  dom: HTMLElement;

  constructor(
    node: PMNode,
    getMd: () => MarkdownIt,
    isCode: boolean,
  ) {
    this.dom = document.createElement("span");
    // 代码上下文（行内代码 / 代码块）保持原文，不替换
    const md = isCode ? null : safeMd(getMd);
    const text = md ? renderEmojiInText(node.text ?? "", md) : (node.text ?? "");
    if (text !== (node.text ?? "")) {
      this.dom.className = "emoji-render";
    }
    this.dom.textContent = text;
  }
}

function safeMd(getMd: () => MarkdownIt): MarkdownIt | null {
  try {
    return getMd();
  } catch {
    return null;
  }
}

/**
 * 判断该 text 节点是否处于**行内代码**语境。
 *
 * 注：NodeView 拿到的 text node 是 leaf（无 parent），故无法查 parent.type；
 * 代码块内的 text 是 code_block 的**直接子节点**，其 code 标记在 marks 上不可见，
 * 但 CodeBlockView 会整体接管代码块的 DOM（不经过 text nodeView），故不受影响。
 */
function isCodeContext(node: PMNode): boolean {
  return node.marks.some((m) => m.type.name === "code");
}

/**
 * Emoji 渲染插件：为 text 节点提供 NodeView。
 *
 * @param getMd 惰性获取 markdown-it 实例（避免编辑器初始化时加载插件）
 */
export function emojiRenderPlugin(getMd: () => MarkdownIt): Plugin {
  return new Plugin({
    key: emojiRenderKey,
    props: {
      // 只接管「含冒号且可能含短码」的 text 节点，其余交回默认渲染（零开销）
      nodeViews: {
        // 只接管「确实含可识别短码」的 text 节点。
        // 理由：NodeView 会接管 DOM 渲染，接管全部 text 会带来不必要的
        // 渲染开销，且可能干扰 IME 组合输入 —— 故先做廉价的字符串预检，
        // 不含短码形态时返回 undefined 交回默认渲染。
        text: ((node: PMNode) => {
          const raw = node.text ?? "";
          // 预检 1：不含冒号
          if (!raw.includes(":")) return undefined;
          // 预检 2：无线上短码形态（如 "a:b"）
          if (!SHORTCODE_ANY_RE.test(raw)) return undefined;
          // 预检 3：代码语境不替换
          if (isCodeContext(node)) return undefined;
          // 预检 4：确实有可识别的短码（需 markdown-it 实例，稍重但可接受）
          let md: MarkdownIt | null = null;
          try {
            md = getMd();
          } catch {
            return undefined;
          }
          if (!md || !hasRenderableShortcode(raw, md)) return undefined;
          return new EmojiTextView(node, getMd, false) as unknown as never;
        // ProseMirror 运行时允许返回 undefined 交回默认渲染，但其类型定义未
        // 标注该分支（NodeViewConstructor 声明为返回 NodeView）→ 断言绕过。
        }) as unknown as NodeViewConstructor,
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
