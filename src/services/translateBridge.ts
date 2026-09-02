/**
 * translateBridge —— 选区 ↔ Markdown 序列化桥接（v0.6.0）
 *
 * 职责：
 * - extractFromSelection：PM 选区 → Markdown 文本（selection.content → 临时 doc → docToMarkdown）
 * - extractFromIframe：preview iframe 选区 → 纯文本
 * - sanitizeTranslated：防御性清洗（剥离 ``` 包裹与"以下是翻译："类前后缀）
 * - applyTranslation：译文回写（replace 行内/块级 / bilingual 引用块插入）
 *
 * 约束：翻译回写必须走本模块（markdownToInline/markdownToDoc 解析），
 * 禁止 insertText 裸插（避免格式标记丢失/转义错乱）。
 */
import type { EditorView } from "prosemirror-view";
import type { EditorState, Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { Slice, Fragment } from "prosemirror-model";
import { lightMDSchema } from "../core/schema";
import { docToMarkdown } from "../core/markdown/serializer";
import { markdownToInline, markdownToDoc } from "../core/markdown/parser";

/** 不可翻译块类型：代码/图表/公式（源码保持原样，AI 翻译无意义） */
const UNTRANSLATABLE_BLOCKS = new Set(["code_block", "math_block", "mermaid_block"]);

/** 回写模式：replace=替换选区 | bilingual=译文追加为引用块 */
export type ApplyMode = "replace" | "bilingual";

// ─── 提取 ────────────────────────────────────────────────

/** PM 选区提取结果（text 为 Markdown 片段，pos 为选区末尾位置） */
export interface SelectionExtract {
  text: string;
  pos: number;
}

/** 从 PM 编辑器选区提取 Markdown 文本（view 包装，C2/C4 入口用） */
export function extractFromSelection(view: EditorView): SelectionExtract | null {
  return extractSelectionText(view.state);
}

/** 核心提取逻辑（纯函数，可测试） */
export function extractSelectionText(state: EditorState): SelectionExtract | null {
  const { selection } = state;
  if (selection.empty) return null;
  // 纯代码/公式/图表选区拒绝翻译
  if (isSelectionUntranslatable(state)) return null;

  let text: string;
  try {
    const slice = selection.content();
    // 选区片段构建临时 doc 序列化（丢失的块级上下文由 open depths 表达）
    const doc = lightMDSchema.topNodeType.create(null, slice.content);
    text = docToMarkdown(doc).trim();
  } catch {
    return null;
  }
  if (!text) return null;
  return { text, pos: selection.to };
}

/** 选区覆盖的所有块节点均为不可翻译类型（code/math/mermaid）时返回 true */
function isSelectionUntranslatable(state: EditorState): boolean {
  const { from, to } = state.selection;
  let allBlocked = true;
  let hasBlock = false;
  state.doc.nodesBetween(from, to, (node) => {
    // doc 节点本身跳过（nodesBetween 回调包含顶层 doc）
    if (node === state.doc) return true;
    if (node.isBlock) {
      hasBlock = true;
      if (!UNTRANSLATABLE_BLOCKS.has(node.type.name)) {
        allBlocked = false;
        return false; // 提前终止遍历
      }
    }
    return true;
  });
  return allBlocked && hasBlock;
}

/** preview iframe 选区提取（纯文本通道，无 Markdown 标记） */
export function extractFromIframe(doc: Document): string | null {
  const sel = doc.getSelection();
  const text = sel ? sel.toString() : "";
  return text.trim() ? text : null;
}

// ─── 防御性清洗 ──────────────────────────────────────────

/** 剥离 LLM 常见前后缀：``` 包裹、"以下是翻译：" 类前缀、结尾客套语（循环至稳定） */
export function sanitizeTranslated(text: string): string {
  let t = text.trim();
  for (let round = 0; round < 3; round++) {
    const before = t;
    // 首尾代码围栏包裹：```lang\n...\n```
    const fenceMatch = t.match(/^```[a-zA-Z0-9_+-]*[ \t]*\n([\s\S]*?)\n?[ \t]*```$/);
    if (fenceMatch) {
      t = fenceMatch[1].trim();
    }
    // 前缀：好的，以下是翻译：/ 翻译如下：/ Translation: 等
    t = t.replace(
      /^(?:好的[，,]?\s*)?(?:以下|这是)?(?:是)?(?:翻译|译文|译文如下|翻译如下|翻译内容|翻译结果)[：:]\s*/i,
      ""
    );
    t = t.replace(/^(?:Translation|Translated text)\s*[：:]\s*/i, "");
    // 尾部客套：希望...有帮助/如需调整请告知 等（连同客套句末标点删除，正文标点保留）
    t = t.replace(
      /(?:希望[^。\n]*有帮助|如需[^。\n]*(?:调整|修改|告知)[^。\n]*)[。.]?\s*$/,
      ""
    );
    if (t === before) break; // 已稳定
  }
  return t.trim();
}

// ─── 回写 ────────────────────────────────────────────────

/** 构建回写事务（核心纯逻辑，可测试）。返回 null 表示译文无效或结构失配。 */
export function buildApplyTransaction(
  state: EditorState,
  translated: string,
  mode: ApplyMode
): Transaction | null {
  const clean = sanitizeTranslated(translated);
  if (!clean) return null;

  const { selection } = state;

  if (mode === "bilingual") {
    return buildBilingualInsert(state, selection.to, clean);
  }

  // replace 模式：NodeSelection（整节点选中）不支持替换语义
  if (!(selection instanceof TextSelection)) return null;

  try {
    if (isInlineSelection(selection)) {
      // 行内替换：译文按行内 Markdown 解析（粗体/斜体/链接保留，不产生块结构）
      const nodes = markdownToInline(clean);
      const slice = new Slice(Fragment.fromArray(nodes), 0, 0);
      return state.tr.replaceSelection(slice);
    }
    // 块级替换：译文按块解析，open depths 沿用原选区（保持与前后段落的拼接关系）
    const doc = markdownToDoc(clean);
    const original = selection.content();
    const slice = new Slice(doc.content, original.openStart, original.openEnd);
    return state.tr.replaceSelection(slice);
  } catch {
    // 解析失败（译文含 schema 不支持的构造）→ 调用方降级走双语插入
    return null;
  }
}

/** 译文回写（view 包装）。失败返回 false（调用方可降级 bilingual）。 */
export function applyTranslation(
  view: EditorView,
  translated: string,
  mode: ApplyMode
): boolean {
  const tr = buildApplyTransaction(view.state, translated, mode);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

/** 选区起止位于同一文本块内（行内选区） */
function isInlineSelection(selection: TextSelection): boolean {
  const { $from, $to } = selection;
  return $from.sameParent($to) && $from.parent.isTextblock;
}

/** 双语插入：在 pos 处插入引用块（quote 包裹译文块） */
function buildBilingualInsert(
  state: EditorState,
  pos: number,
  clean: string
): Transaction | null {
  try {
    const doc = markdownToDoc(clean);
    const quote = lightMDSchema.nodes.blockquote.create(null, doc.content);
    // tr.insert 在文本中间插入块节点时自动拆分目标块（ProseMirror fitting 语义）
    return state.tr.insert(pos, quote);
  } catch {
    return null;
  }
}

// ─── source（textarea）通道支持（C4）─────────────────────

/** textarea 选区末尾锚点计算参数（纯函数依赖注入，便于测试） */
export interface TextareaAnchorInput {
  /** textarea 视口矩形 */
  rect: { left: number; top: number; width: number };
  /** 几何信息：行高/内边距/等宽字符宽度/滚动偏移 */
  geo: { lineHeight: number; paddingTop: number; paddingLeft: number; charWidth: number; scrollTop: number };
  /** 选区末尾之前的全文（value.slice(0, selectionEnd)） */
  valueUpToCursor: string;
}

/**
 * 计算 textarea 选区末尾锚点（视口坐标，粗略估算）。
 * 公式：行号 × 行高 + 行内字符数 × 字符宽度（等宽字体近似）。
 * 气泡自身带边界自适应（computeBubblePosition），锚点无需像素级精确。
 */
export function computeTextareaAnchor(input: TextareaAnchorInput): { x: number; y: number } {
  const { rect, geo } = input;
  const lines = input.valueUpToCursor.split("\n");
  const lineIdx = lines.length - 1;
  const currentLine = lines[lineIdx] || "";
  // 行内 x 偏移封顶（长行换行显示时锚点不越出 textarea 右边界）
  const maxOffsetX = Math.max(0, rect.width - input.geo.paddingLeft - 24);
  const x = rect.left + geo.paddingLeft + Math.min(currentLine.length * geo.charWidth, maxOffsetX);
  const y = rect.top + geo.paddingTop + lineIdx * geo.lineHeight - geo.scrollTop;
  return { x, y };
}

/** textarea 选区末尾锚点（DOM 包装：读取样式与滚动位置） */
export function getTextareaSelectionAnchor(textarea: HTMLTextAreaElement): { x: number; y: number } {
  const rect = textarea.getBoundingClientRect();
  const style = window.getComputedStyle(textarea);
  const fontSize = parseFloat(style.fontSize) || 14;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;
  return computeTextareaAnchor({
    rect: { left: rect.left, top: rect.top, width: rect.width },
    geo: {
      lineHeight,
      paddingTop: parseFloat(style.paddingTop) || 0,
      paddingLeft: parseFloat(style.paddingLeft) || 0,
      // 等宽字体平均字符宽度 ≈ 0.6em（Cascadia/Consolas 实测近似）
      charWidth: fontSize * 0.6,
      scrollTop: textarea.scrollTop,
    },
    valueUpToCursor: textarea.value.slice(0, textarea.selectionEnd),
  });
}

/** source 通道回写结果：新内容与译文末尾光标位置 */
export interface SourceRewrite {
  content: string;
  cursor: number;
}

/**
 * source（textarea）通道回写（纯函数，可测试）。
 * - replace：选区文本替换为译文（译文为 Markdown 源码，直接拼接）
 * - bilingual：原文保留，其后追加引用块（每行加 "> " 前缀）
 * 返回 null 表示译文无效。
 */
export function buildSourceRewrite(
  content: string,
  start: number,
  end: number,
  translated: string,
  mode: ApplyMode
): SourceRewrite | null {
  const clean = sanitizeTranslated(translated);
  if (!clean) return null;
  const before = content.slice(0, start);
  const original = content.slice(start, end);
  const after = content.slice(end);

  if (mode === "replace") {
    return { content: before + clean + after, cursor: start + clean.length };
  }
  // bilingual：原文后空一行 + 引用块译文
  const quote = clean.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
  const insert = `\n\n${quote}\n`;
  return { content: before + original + insert + after, cursor: start + original.length + insert.length - 1 };
}
