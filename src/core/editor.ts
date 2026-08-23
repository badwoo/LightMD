/**
 * 编辑器工厂 —— 创建配置完整的 ProseMirror EditorView
 *
 * 性能优化：
 * - docToMarkdown 结果缓存，避免自动保存、手动保存、模式切换时重复序列化
 * - 缓存通过 doc 引用验证有效性，doc 不一致时自动回退到重新序列化
 */
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
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
import { footnoteHoverPlugin } from "./plugins/footnote-hover";
import { CodeBlockView } from "./plugins/code-block";
import { MermaidBlockView } from "./plugins/mermaid-block";
import { MathInlineView, MathBlockView } from "./plugins/math-block";
import { TaskItemView } from "./plugins/task-list";
import { TableView, TableCellView } from "./plugins/table-editor";
import { autoPairPlugin } from "./plugins/auto-pair";
import { smartPastePlugin } from "./plugins/smart-paste";

// ─── 搜索高亮 Plugin（问题1修复）──────────────────────
// 使用 ProseMirror Decoration 管理搜索高亮，不依赖编辑器焦点
// 通过 tr.setMeta(searchHighlightKey, { from, to }) 更新高亮位置
// 通过 tr.setMeta(searchHighlightKey, null) 清除高亮
export const searchHighlightKey = new PluginKey<DecorationSet>("searchHighlight");
const searchHighlightPlugin = new Plugin<DecorationSet>({
  key: searchHighlightKey,
  state: {
    init() {
      return DecorationSet.empty;
    },
    apply(tr, old) {
      const meta = tr.getMeta(searchHighlightKey);
      if (meta !== undefined) {
        // null 表示清除高亮
        if (meta === null) return DecorationSet.empty;
        // { from, to } 表示设置高亮
        const deco = Decoration.inline(meta.from, meta.to, { class: "search-highlight" });
        return DecorationSet.create(tr.doc, [deco]);
      }
      // 文档变化时映射 decoration 位置
      return old.map(tr.mapping, tr.doc);
    },
  },
  props: {
    decorations(state) {
      return searchHighlightKey.getState(state);
    },
  },
});

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
  /** 选区变更回调（G11：第二参数由 wordCount:number 改为 text:string，字数计算移至 EditorContainer 调用 calculateWordCount） */
  onSelectionChange?: (line: number, text: string) => void;
  /** 编辑器就绪回调 */
  onReady?: (view: EditorView) => void;
  /**
   * 打字机模式 ref，供 EditorContainer 的 keyup 监听判断滚动方式
   *
   * 滚动策略（由 EditorContainer 的 keyup/click 监听统一处理）：
   * - 光标 Y 不变（同行输入）：恢复 keydown 时的 scrollTop，阻止任何滚动
   * - 光标 Y 变化（换行/软换行）：
   *   * 打字机开启：smooth 滚动到中央
   *   * 打字机关闭：instant 滚动让光标可见
   *
   * ProseMirror 自身的滚动机制通过以下方式完全禁用：
   * - handleScrollToSelection 返回 true，阻止 "to selection" 模式的 scrollToSelection()
   * - EditorContainer 设置 overflow-anchor:none，禁用 "preserve" 模式的 storeScrollPos/resetScrollPos
   */
  typewriterModeRef?: { current: boolean };
  /**
   * G10：拼写检查开关初始值
   * 创建 EditorView 时通过 attributes.spellcheck 设置到 .ProseMirror 元素上，
   * 后续切换由 EditorContainer 的 useEffect 同步更新 dom.spellcheck 属性
   */
  spellcheckEnabled?: boolean;
}

/**
 * 创建配置完整的 ProseMirror EditorView
 */
export function createEditor(options: EditorOptions): EditorView | null {
  const { parent, initialContent = "", onDocChange, onSelectionChange, onReady, typewriterModeRef, spellcheckEnabled = false } = options;

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
      footnoteHoverPlugin,
      searchHighlightPlugin,
      autoPairPlugin(),
      smartPastePlugin(),
    ],
  });

  let initialized = false;
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
      // F1 修复：td/th 挂轻量 NodeView，忽略拖拽时直接写 style 的 attributes
      // mutation，阻止 ProseMirror 重建单元格导致列宽丢失
      table_cell: (node) => new TableCellView(node),
      table_header: (node) => new TableCellView(node),
    },
    // G10：通过 attributes 设置 spellcheck 初始值（contenteditable 元素原生属性）
    // 后续切换由 EditorContainer 的 useEffect 同步更新 dom.spellcheck 属性
    attributes: {
      spellcheck: spellcheckEnabled ? "true" : "false",
    },
    // 阻止 ProseMirror 在 "to selection" 模式下主动调用 scrollToSelection()
    // 滚动由 EditorContainer 的 keyup/click 监听统一处理，避免编辑时屏幕跳动
    handleScrollToSelection: () => true,
    dispatchTransaction(tr) {
      const isFileSwitch = tr.getMeta("fileSwitch");
      const newState = view.state.apply(tr);

      // ─── 同步保存/恢复 scrollTop，防止编辑时屏幕闪动 ───────
      // 根因：view.updateState 内部调用 selectionToDOM 将 state.selection
      // 同步到 DOM 选区，浏览器原生 selection 滚动会改变 scrollTop。
      // 由于 scroll 事件是异步触发的，无法在浏览器重绘前恢复 scrollTop，
      // 用户会看到 scrollTop 变化的中间状态（闪动）。
      //
      // 解决方案：在 updateState 前后同步保存/恢复 scrollTop。
      // 浏览器不会在 updateState 内部重绘，所以用户看不到中间状态。
      // 后续滚动由 EditorContainer 的 keyup/click 监听统一处理。
      //
      // 文件切换事务不恢复 scrollTop（由 EditorContainer 滚动联动逻辑处理）
      // 问题2修复：滚动容器从 .ProseMirror 改为 .editor-container（parentElement），
      // 因为 .ProseMirror 移除 overflow-y: auto 后，滚动发生在 editor-container 上
      const editorDom = view.dom as HTMLElement;
      const scrollContainer = editorDom.parentElement as HTMLElement;
      const savedScrollTop = isFileSwitch ? -1 : (scrollContainer ? scrollContainer.scrollTop : 0);
      view.updateState(newState);
      if (savedScrollTop >= 0 && scrollContainer && scrollContainer.scrollTop !== savedScrollTop) {
        scrollContainer.scrollTop = savedScrollTop;
      }

      // 文件切换事务不触发 dirty 标记和序列化
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

      // 选区变化时更新行号和文本（字数计算由 EditorContainer 防抖 300ms 后调用 calculateWordCount 完成）
      // 注意：此处不再节流，避免快速输入时最后一次更新被丢失（EditorContainer 内部已有防抖）
      if (tr.selectionSet && onSelectionChange) {
        const { $from } = newState.selection;
        const lineCount = newState.doc.content.size > 0
          ? newState.doc.textBetween(0, $from.pos).split("\n").length
          : 1;
        const allText = newState.doc.textContent;
        onSelectionChange(lineCount, allText);
      }
    },
  });

  // 通知父组件编辑器已就绪
  if (onReady) {
    requestAnimationFrame(() => onReady(view));
  }

  return view;
}
