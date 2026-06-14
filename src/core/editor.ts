/**
 * 编辑器工厂 —— 创建配置完整的 ProseMirror EditorView
 *
 * 性能优化：
 * - docToMarkdown 结果缓存，避免自动保存、手动保存、模式切换时重复序列化
 * - 缓存通过 doc 引用验证有效性，doc 不一致时自动回退到重新序列化
 */
import { EditorView } from "prosemirror-view";
import { EditorState } from "prosemirror-state";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema } from "./schema";
import { markdownToDoc } from "./markdown/parser";
import { docToMarkdown } from "./markdown/serializer";
import { buildInputRules } from "./inputrules";
import { buildKeymap } from "./keymap";
import { wysiwygPlugin } from "./plugins/wysiwyg";
import { imagePastePlugin } from "./plugins/image-paste";
import { focusModePlugin } from "./plugins/focus-mode";
import { CodeBlockView } from "./plugins/code-block";
import { MermaidBlockView } from "./plugins/mermaid-block";
import { MathInlineView, MathBlockView } from "./plugins/math-block";
import { TaskItemView } from "./plugins/task-list";
import { TableView } from "./plugins/table-editor";

// ─── 序列化缓存 ────────────────────────────────────
// 缓存最近一次 docToMarkdown 结果，供自动保存、手动保存、模式切换复用
// 通过 doc 引用验证缓存有效性（ProseMirror doc 是不可变的，每次 transaction 产生新对象）
let serializationCache: { doc: PMNode; markdown: string } | null = null;

/**
 * 获取文档的 Markdown 字符串，优先使用缓存
 * 缓存命中条件：传入的 doc 与缓存中的 doc 是同一个对象引用
 */
export function getMarkdownFromDoc(doc: PMNode): string {
  if (serializationCache && serializationCache.doc === doc) {
    return serializationCache.markdown;
  }
  const md = docToMarkdown(doc);
  serializationCache = { doc, markdown: md };
  return md;
}

/** 清除序列化缓存（文件切换时调用） */
export function clearSerializationCache() {
  serializationCache = null;
}

export interface EditorOptions {
  /** 挂载点 DOM 元素 */
  parent: HTMLElement | null;
  /** 初始 Markdown 内容 */
  initialContent?: string;
  /** 文档变更回调 */
  onDocChange?: (markdown: string) => void;
  /** 选区变更回调 */
  onSelectionChange?: (line: number, wordCount: number) => void;
  /** 编辑器就绪回调 */
  onReady?: (view: EditorView) => void;
}

/**
 * 创建配置完整的 ProseMirror EditorView
 */
export function createEditor(options: EditorOptions): EditorView | null {
  const { parent, initialContent = "", onDocChange, onSelectionChange, onReady } = options;

  if (!parent) return null;

  let doc;
  try {
    doc = markdownToDoc(
      initialContent || "# 欢迎使用 LightMD\n\n开始输入 Markdown..."
    );
  } catch {
    doc = lightMDSchema.topNodeType.create(null, [
      lightMDSchema.nodes.paragraph.create(null, [
        lightMDSchema.text("欢迎使用 LightMD"),
      ]),
    ]);
  }

  const state = EditorState.create({
    doc,
    plugins: [
      history(),
      keymap(baseKeymap),
      buildInputRules(),
      buildKeymap(),
      wysiwygPlugin,
      imagePastePlugin,
      focusModePlugin,
    ],
  });

  let initialized = false;
  let lastWordCountTime = 0;
  // 序列化防抖：连续输入时只序列化最后一次变更，减少内存分配
  let serializeRafId: number | null = null;

  const view = new EditorView(parent, {
    state,
    nodeViews: {
      code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos),
      mermaid_block: (node, view, getPos) => new MermaidBlockView(node, view, getPos),
      math_inline: (node, view, getPos) => new MathInlineView(node, view, getPos),
      math_block: (node, view, getPos) => new MathBlockView(node, view, getPos),
      task_item: (node, view, getPos) => new TaskItemView(node, view, getPos),
      table: (node, view, getPos) => new TableView(node, view, getPos),
    },
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr);
      view.updateState(newState);

      // 文件切换事务不触发 dirty 标记和序列化
      const isFileSwitch = tr.getMeta("fileSwitch");
      if (tr.docChanged && onDocChange && initialized && !isFileSwitch) {
        // 取消上一次待执行的序列化，确保只序列化最新状态
        if (serializeRafId !== null) {
          cancelAnimationFrame(serializeRafId);
        }
        serializeRafId = requestAnimationFrame(() => {
          serializeRafId = null;
          // 确保当前 state 仍是最新（可能又有新事务）
          if (view.state.doc === newState.doc) {
            const md = docToMarkdown(newState.doc);
            // 更新缓存，供后续自动保存/手动保存/模式切换复用
            serializationCache = { doc: newState.doc, markdown: md };
            onDocChange(md);
          }
        });
      }

      // 标记初始事务已完成
      if (!initialized) initialized = true;

      // 选区变化时更新行号和字数
      if (tr.selectionSet && onSelectionChange) {
        const { $from } = newState.selection;
        const lineCount = newState.doc.content.size > 0
          ? newState.doc.textBetween(0, $from.pos).split("\n").length
          : 1;
        const now = Date.now();
        if (now - lastWordCountTime > 300) {
          lastWordCountTime = now;
          const allText = newState.doc.textContent;
          const wc = allText.replace(/\s/g, "").length;
          onSelectionChange(lineCount, wc);
        }
      }
    },
  });

  // 通知父组件编辑器已就绪
  if (onReady) {
    requestAnimationFrame(() => onReady(view));
  }

  return view;
}
