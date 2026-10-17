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
import { markdownToDoc, getMarkdownIt } from "./markdown/parser";
import { docToMarkdown } from "./markdown/serializer";
import { buildInputRules } from "./inputrules";
import { buildKeymap, dynamicShortcutsPlugin, blockClipboardPlugin } from "./keymap";
// v0.8.3 需求3：光标行（结构化行号）与列的计算（纯函数，可单测）
import { computeDocLine, computeBlockColumn } from "../utils/cursorPosition";
import { wysiwygPlugin, createWysiwygPlugin } from "./plugins/wysiwyg";
// E6(v0.9.4)：行内语法标记显示（光标进入 mark 区间显示源码符号）
import { inlineMarkRevealPlugin } from "./plugins/inline-mark-reveal";
import { imagePastePlugin } from "./plugins/image-paste";
import { clipboardPastePlugin } from "./plugins/clipboard-paste";
import { focusModePlugin } from "./plugins/focus-mode";
import { footnoteHoverPlugin } from "./plugins/footnote-hover";
// v0.11.0 B4-7：TOC 目录自动更新（此前用解析期快照，阅读模式改标题后不更新）
import { tocUpdatePlugin } from "./plugins/toc-update";
// v0.11.0 B4-8：Emoji 短码渲染层显示为图形（不改 doc 与序列化）
import { emojiRenderPlugin } from "./plugins/emoji-render";
// v0.12.2 P6：标题锚点 id 与文本同步（改标题后重算 slug，避免 TOC/锚点失配）
import { headingIdSyncPlugin } from "./plugins/heading-id-sync";
// v0.11.0 B4-9：阅读模式图片灯箱（点击放大/遮罩关闭/键盘导航）
import { imageLightboxPlugin } from "./plugins/image-lightbox";
import { CodeBlockView } from "./plugins/code-block";
import { MermaidBlockView } from "./plugins/mermaid-block";
// v0.13.2 需求10：图片激活 + 边缘拖拽缩放 + 右上角编辑手柄
import { ImageView } from "./plugins/image-node";
import { MathInlineView, MathBlockView } from "./plugins/math-block";
import { TaskItemView } from "./plugins/task-list";
import { TableView, TableCellView } from "./plugins/table-editor";
// v0.12.0 需求11：块级鼠标拖拽移动（自制拖拽，规避 Tauri 对 HTML5 DnD 的拦截）
import { blockDragPlugin } from "./plugins/block-drag";
import { autoPairPlugin } from "./plugins/auto-pair";
import { smartPastePlugin } from "./plugins/smart-paste";
import { createTranslateTooltipPlugin, type AiAssistTask } from "./plugins/translateTooltip";
import { createSlashCommandPlugin } from "./plugins/slash-command";
// v0.13.0 需求10：Emoji 短码补全
import { createEmojiCompletePlugin } from "./plugins/emoji-complete";
// v0.13.2 需求9：文档末尾垫一个可放光标的段落（表格/代码块结尾时才能继续编辑）
import { trailingParagraphPlugin, withTrailingParagraph } from "./plugins/trailing-paragraph";
// v0.7.0：AI 续写幽灵文本装饰（meta 驱动，无回调依赖）
import { aiGhostPlugin } from "./plugins/ai-ghost";

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

// ─── v0.13.2 需求5：跨文档保留撤销历史的存取 ─────────────────
/**
 * 定位 `prosemirror-history` 的插件实例。
 *
 * 该库**没有导出** `historyKey`（`dist/index.d.ts` 只导出命令与深度函数），
 * 而插件 state 存放在 `state[plugin.key]`。因此按 key 前缀定位：
 * `PluginKey` 的 key 形如 `"history$"` / `"history$1"`（重名时后缀递增），
 * 全仓只注册一个 history 插件，故取第一个匹配即可。
 *
 * 注：`Plugin` 的 .d.ts 未声明 `key` 字段（运行时存在），故这里走宽松读取。
 */
function findHistoryPlugin(state: EditorState): { key: string } | null {
  for (const p of state.plugins) {
    const key = (p as unknown as { key?: unknown }).key;
    if (typeof key === "string" && /^history\$/.test(key)) return { key };
  }
  return null;
}

/** 读取插件 state 字段（`state[plugin.key]`，.d.ts 未声明，故走宽松索引） */
function readPluginField(state: EditorState, key: string): unknown {
  return (state as unknown as Record<string, unknown>)[key];
}

/**
 * 取出当前视图的 ProseMirror 撤销历史状态（供换文档时保存）。
 *
 * 返回值是 prosemirror-history 内部的 `HistoryState`（含 done / undone
 * 两条分支），本层不解析其结构，原样交给 `services/docHistoryStore` 保管。
 */
export function getPmHistoryState(state: EditorState): unknown {
  const plugin = findHistoryPlugin(state);
  if (!plugin) return null;
  return readPluginField(state, plugin.key) ?? null;
}

/**
 * 把保存下来的撤销历史装回一个**新建**的 state。
 *
 * ⚠️ 位置敏感：只有当新文档与保存时的文档内容**逐字节一致**时才能装回，
 * 否则历史里的 step 会作用到错误的偏移上（比丢历史严重得多）。
 * 这条前置条件由调用方（`EditorContainer`）用内容比较保证。
 *
 * 实现：`EditorState.create` 之后直接覆盖 history 插件对应的 state 字段
 * （`state[plugin.key]`）——该字段正是插件 state 的存储位置，
 * 与 `EditorState.fromJSON` 的还原路径同一机制。
 *
 * @returns 装回后的 state；插件缺失 / 结构不符时原样返回（安全降级为"无历史"）
 */
export function withPmHistoryState(
  base: EditorState,
  pmHistory: unknown,
): EditorState {
  if (!pmHistory) return base;
  const plugin = findHistoryPlugin(base);
  if (!plugin) return base;
  // 结构校验：只有真的 HistoryState（含 done / undone）才装回
  const h = pmHistory as { done?: unknown; undone?: unknown };
  if (!h.done || !h.undone) return base;
  try {
    const next = EditorState.create({
      doc: base.doc,
      plugins: base.plugins,
      selection: base.selection,
    });
    (next as unknown as Record<string, unknown>)[plugin.key] = pmHistory;
    return next;
  } catch {
    return base;
  }
}

/** 该 state 的撤销 / 恢复深度（供跨文档顺序撤销判断"撤完了没有"） */
export function pmHistoryDepth(state: EditorState): { undo: number; redo: number } {
  const plugin = findHistoryPlugin(state);
  const h = plugin
    ? (readPluginField(state, plugin.key) as
        | { done?: { eventCount?: number }; undone?: { eventCount?: number } }
        | undefined)
    : undefined;
  return {
    undo: Math.max(0, h?.done?.eventCount ?? 0),
    redo: Math.max(0, h?.undone?.eventCount ?? 0),
  };
}

export interface EditorOptions {
  /** 挂载点 DOM 元素 */
  parent: HTMLElement | null;
  /** 初始 Markdown 内容 */
  initialContent?: string;
  /** 文档变更回调 */
  onDocChange?: (markdown: string) => void;
  /**
   * 选区变更回调。
   *
   * G11：第二参数由 wordCount:number 改为 text:string，字数计算移至
   * EditorContainer 调用 calculateWordCount。
   * v0.8.3 需求3：签名为 (line, column, selectedChars, getText)——
   * - column：光标在当前文本块内的列（1 起），O(块内) 成本可忽略；
   * - selectedChars：选中的字符数（无选区恒为 0，不计算）；
   * - getText：**惰性**取全文档文本的函数。旧实现每次选区变化（含每次击键）
   *   都做 doc.textContent 全量序列化，长文档下是输入卡顿来源之一；
   *   现在只有真正需要字数统计时才调用（EditorContainer 内 300ms 防抖）。
   */
  onSelectionChange?: (
    line: number,
    column: number,
    selectedChars: number,
    getText: () => string,
  ) => void;
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
  /**
   * v0.6.0：AI 翻译触发回调（选区「译」浮动按钮点击时调用，参数为所属 view）
   * 由 EditorContainer 注入，负责提取选区文本并打开翻译气泡
   */
  onTranslateTrigger?: (view: EditorView) => void;
  /** v0.6.0：AI 翻译总开关 getter（动态读取设置，返回 false 时不显示浮动按钮） */
  translateEnabledGetter?: () => boolean;
  /**
   * v0.7.0 修复1/4：选区「译」浮动按钮扩展选项
   * - getDelay：延迟出现毫秒数 getter（translateBubbleDelayMs，防选中即弹）
   * - onContextMenu：按钮右键回调（入口层渲染快捷菜单：关闭 AI 翻译 / 隐藏气泡）
   */
  translateTooltipOptions?: {
    getDelay?: () => number;
    onContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void;
    // v0.7.3 改进8(D5)：按钮 title（i18n 注入）
    title?: string;
    // v0.7.4 功能7：AI 气泡（续/润/摘）接线
    onAiAction?: (task: AiAssistTask) => void;
    onAiContextMenu?: (btn: HTMLSpanElement, e: MouseEvent) => void;
    /** v0.7.5 功能2：按任务判定气泡是否隐藏（取代整体布尔 isAiHidden） */
    isBubbleHidden?: (task: AiAssistTask) => boolean;
    /** 各 AI 按钮颜色 getter（空串 = 用主题默认色） */
    getBubbleColor?: (task: AiAssistTask) => string | undefined;
    /** v0.7.5 功能3：「译」按钮颜色 getter（空串 = 用主题默认色） */
    getTranslateColor?: () => string | undefined;
    /** 各 AI 按钮 title getter（i18n 注入） */
    getAiTitle?: (task: AiAssistTask) => string;
    /** v0.7.4 修复2：AI 三个气泡出现延迟毫秒数 getter（从 mouseup 起算，独立于「译」） */
    getAiDelay?: () => number;
  };
  /**
   * v0.6.6 问题2：阅读模式 Slash 命令触发状态回调
   * 由 EditorContainer 注入，驱动 SlashCommandPm 菜单渲染（触发 → SlashState；失效 → null）
   */
  onSlashStateChange?: (s: import("./plugins/slash-command").SlashState | null) => void;
  /** v0.13.0 需求10：阅读模式 Emoji 短码补全触发状态回调 */
  onEmojiStateChange?: (s: import("./plugins/emoji-complete").EmojiState | null) => void;
  /** v0.7.3 改进8(D5)：AI 续写 ghost 的采纳提示文案（i18n 注入，硬编码中文穿帮清理） */
  aiGhostHint?: string;
  /**
   * v0.9.0 WP9：只读 getter。
   *
   * 返回 false 时 ProseMirror 关闭 contenteditable（`editable() => false`），
   * 仍可选中/复制/导出，但无法编辑。运行期由 EditorContainer 在只读标记变化时
   * 调用 `view.updateState(view.state)` 触发重新求值（PM 在 updateStateInner 内
   * 重新计算 `this.editable`）。
   */
  editableGetter?: () => boolean;
  /**
   * v0.12.1 需求1：点击标题级别徽标（H1~H6）的回调。
   * 参数：headingPos = 标题节点起始位置；currentLevel = 当前级别；anchor = 徽标视口矩形。
   * EditorContainer 据此渲染级别下拉菜单（改级别 = setNodeMarkup）。
   */
  onHeadingBadgeClick?: (headingPos: number, currentLevel: number, anchor: DOMRect) => void;
}

/**
 * 创建配置完整的 ProseMirror EditorView
 */
export function createEditor(options: EditorOptions): EditorView | null {
  const { parent, initialContent = "", onDocChange, onSelectionChange, onReady, typewriterModeRef, spellcheckEnabled = false, onTranslateTrigger, translateEnabledGetter, translateTooltipOptions, onSlashStateChange, onEmojiStateChange, aiGhostHint, editableGetter, onHeadingBadgeClick } = options;

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
  // v0.13.2 需求9：初始文档同样要保证"末尾有可放光标的段落"。
  // 插件（appendTransaction）只在**文档被改动**时运行，而刚打开一份
  // "以表格结尾"的文档时还没有任何事务 —— 用户当场点表格下方空白会没有插入符。
  // 这里在创建 state 之前就补上（pad 段落不进序列化，见 serializer）。
  doc = withTrailingParagraph(doc);

  const state = EditorState.create({
    doc,
    plugins: [
      history(),
      // v0.13.0 需求1：块级剪贴板快捷键（NodeSelection 态下 Ctrl+C/X → 整块复制/剪切）。
      // 必须**早于**动态快捷键插件与静态 keymap 注册（PM 的 props.handleKeyDown
      // 越靠前优先级越高），否则 NodeSelection 态下的 Ctrl+C 会先被别处消费。
      blockClipboardPlugin(),
      // v0.9.0 自定义快捷键：动态键位插件次之——每次 keydown 读生效键位表
      // （默认 + 用户覆盖），命中即接管，未命中 fallthrough 到静态 keymap / baseKeymap
      dynamicShortcutsPlugin(),
      // v0.8.0 修复 P11-6：自定义键位必须**先于** baseKeymap 注册。
      // 否则列表项/任务项内按 Enter 会命中 baseKeymap 的 splitBlock（在同一项内新建段落），
      // 序列化时项内多段落被合并成一行 → 切模式后换行丢失。
      buildKeymap(),
      keymap(baseKeymap),
      buildInputRules(),
      // v0.12.1 需求1：标题级别徽标需要回调（点击展开 H1~H6 下拉菜单）
      onHeadingBadgeClick ? createWysiwygPlugin({ onHeadingBadgeClick }) : wysiwygPlugin,
      // E6(v0.9.4)：块级 marker 之后注册行内 reveal，两者装饰互补
      inlineMarkRevealPlugin,
      imagePastePlugin,
      // E9(v0.9.4)：Markdown 感知粘贴/富文本粘贴。
      // 必须晚于 imagePaste（图片优先），早于 smartPaste（单 URL→链接为兜底）
      clipboardPastePlugin(),
      focusModePlugin,
      footnoteHoverPlugin,
      // v0.11.0 B4-7：TOC 自动更新（appendTransaction + 300ms debounce）
      tocUpdatePlugin(),
      // v0.12.2 P6：标题锚点 id 与文本同步（改标题后重算 slug）
      // 注册在 tocUpdatePlugin 之后：两者都是 appendTransaction，PM 按顺序调用，
      // 本插件同步执行、tocUpdate 防抖调度，互不干扰。
      headingIdSyncPlugin(),
      // v0.11.0 B4-8：Emoji 短码渲染为图形（惰性取 md 实例，含 emoji 插件）
      emojiRenderPlugin(() => getMarkdownIt(true)),
      // v0.11.0 B4-9：图片灯箱（仅阅读模式生效）
      imageLightboxPlugin(),
      searchHighlightPlugin,
      autoPairPlugin(),
      smartPastePlugin(),
      // v0.6.0：AI 翻译选区浮动按钮（未传回调时不注册；enabled getter 动态响应设置开关）
      // v0.7.0 修复1/4：options 携带延迟显示 getter 与右键菜单回调
      ...(onTranslateTrigger
        ? [createTranslateTooltipPlugin(onTranslateTrigger, translateEnabledGetter ?? (() => true), translateTooltipOptions ?? {})]
        : []),
      // v0.6.6 问题2：阅读模式 Slash 命令面板（未传回调时不注册）
      ...(onSlashStateChange ? [createSlashCommandPlugin(onSlashStateChange)] : []),
      // v0.13.0 需求10：Emoji 短码补全（未传回调时不注册）
      ...(onEmojiStateChange ? [createEmojiCompletePlugin(onEmojiStateChange)] : []),
      // v0.7.0：AI 续写幽灵文本（meta 驱动，常驻注册，无任务时零开销）
      aiGhostPlugin(aiGhostHint),
      // v0.12.0 需求11：块级鼠标拖拽移动（选中块后从左侧手柄热区拖动）
      blockDragPlugin(),
      // v0.13.2 需求9：文档末尾永远垫一个可放光标的段落
      // （表格/代码块/图表/公式结尾时，用户点空白处才能继续编辑）
      trailingParagraphPlugin(),
    ],
  });

  let initialized = false;
  // 序列化防抖：连续输入时只序列化最后一次变更，减少内存分配
  let serializeRafId: number | null = null;

  // v0.12.2 P1：编辑器创建兜底。
  //
  // 缺陷背景：v0.11.0 的 emoji text NodeView 会在含可识别短码的文档上让
  // `new EditorView(...)` 抛 `RangeError: Text must be rendered as a DOM text node`，
  // 而本函数与调用方（EditorContainer 的 useEffect）都没有 try/catch，
  // 应用也没有 ErrorBoundary → React 树卸载、阅读/编辑模式白屏不可用。
  //
  // 该具体缺陷已在 emoji-render.ts 改为 Decoration 后修复；这里再加一道防线：
  // 任何 NodeView / 插件在创建期抛错时，退化为「纯段落文本」的只读视图，
  // 让用户至少能看到内容并切到源码模式，而不是白屏。
  // v0.12.2 P1：先声明 view，供下方 dispatchTransaction 闭包引用（创建后才赋值）
  let view: EditorView;

  const buildView = (stateToUse: typeof state, plain = false): EditorView =>
    new EditorView(parent, {
      state: stateToUse,
      // 兜底模式：不挂任何自定义 NodeView（排除 NodeView 抛错的可能）
      nodeViews: plain
        ? {}
        : {
            code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos),
            mermaid_block: (node, view, getPos) => new MermaidBlockView(node, view, getPos),
            math_inline: (node, view, getPos) => new MathInlineView(node, view, getPos),
            math_block: (node, view, getPos) => new MathBlockView(node, view, getPos),
            task_item: (node, view, getPos) => new TaskItemView(node, view, getPos),
            // v0.13.2 需求10：图片（激活 / 边缘缩放 / 右上角编辑手柄）
            image: (node, view, getPos) => new ImageView(node, view, getPos),
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
    // v0.9.0 WP9：只读标签关闭 contenteditable（仍可选中/复制/导出）
    editable: () => editableGetter?.() ?? true,
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

      // ─── v0.13.1 需求8：换文档时**清空撤销历史**（撤销绝不跨文档）───────────
      //
      // 缺陷背景（用户报告「在 a 文档编辑，切到 b 文档按 Ctrl+Z，切回 a 后发现
      // a 的内容变成了 b 的内容」）：
      // 所有标签共用同一个 EditorView，而**撤销历史是 EditorState 内部的**
      // （`prosemirror-history` 的 state 字段）。换文档此前只是 dispatch 一个
      // `replaceWith(0, size, newDoc)` 事务 —— 这条事务同样被记进历史，
      // 于是：
      //   · Ctrl+Z 会把「切换文档」这一步撤销掉，编辑器当场回到**上一个文档**的内容，
      //     而当前活动标签已经是新文档 → onDocChange 把旧文档内容写进新标签，
      //     随后一次保存就会把 A 的内容写进 B 的文件（静默跨文件数据损坏）；
      //   · 即使本次切换被排除，历史里仍留着**上一个文档**的编辑步骤，
      //     撤销会拿那些步骤去改当前文档（位置完全不同）→ 内容错乱。
      // 因此这里在换文档事务应用后**重建一次 state**（复用同一批插件实例），
      // history 字段随之归零：新文档的撤销栈从空开始，撤销永远只作用于本文档。
      // 代价（有意为之）：切走再切回不保留本文档的撤销历史 —— 与"撤销绝不跨文档"
      // 的数据安全相比，这个代价是必须付的。
      //
      // 判据必须是 `resetHistory` 而**不是** `fileSwitch`：后者被三处共用
      // （换文档 / 阅读↔源码的整篇重解析 / 翻译回写），后两者都发生在**同一个文件**
      // 内，清掉历史会让"切个模式就丢掉全部撤销记录"，属明显的功能回归。
      //
      // ─── v0.13.2 需求5：resetHistory 由「清空」升级为「换栈」 ───────────
      // 用户反馈「切回 a 文档后 a 的编辑撤不回来了」，并进一步要求跨文档**顺序**撤销。
      // 现在：换文档事务可携带 `restoreHistory`（该文档上次离开时保存的
      // history 插件状态），在重建 state 时**装回**它 → 切回来仍可撤销。
      // 装回前必须由调用方保证「内容与保存时逐字节一致」（位置敏感，见
      // `withPmHistoryState` 的注释）；不带该 meta 时行为与 v0.13.1 完全一致
      // （历史归零），因此"撤销绝不跨文档"的数据安全边界不变。
      if (tr.getMeta("resetHistory")) {
        const base = EditorState.create({
          doc: newState.doc,
          plugins: newState.plugins,
          selection: newState.selection,
        });
        const restore = tr.getMeta("restoreHistory");
        view.updateState(restore ? withPmHistoryState(base, restore) : base);
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

      // 选区变化时更新行号/列号/选中字符数（字数计算由 EditorContainer 防抖 300ms 后
      // 惰性调用 getText() 完成）
      // 注意：此处不再节流，避免快速输入时最后一次更新被丢失（EditorContainer 内部已有防抖）
      if (tr.selectionSet && onSelectionChange) {
        const sel = newState.selection;
        const { $from } = sel;
        // v0.8.3 需求3：行号改为**结构化**计算（utils/cursorPosition）。
        // 旧实现 `doc.textBetween(0, $from.pos).split("\n").length` 有两处问题：
        // ① textBetween 未传 blockSeparator 时不在块间插入分隔符 → 该值只统计光标前的
        //    硬换行数，常规 Markdown 文档里恒为 1（"行"永远显示 1，语义错误）；
        // ② split("\n") 分配整个光标前文本的字符串数组。
        // 新实现零字符串分配，O(光标前的块数)，且与"逻辑块行号"语义一致。
        const lineCount = newState.doc.content.size > 0 ? computeDocLine($from) : 1;
        // 列号只取光标所在文本块，O(块内)
        const column = computeBlockColumn($from);
        // v0.8.3 需求3：仅在有选区时计算选中字符数（无选区恒为 0，零成本）
        const selectedChars = sel.empty
          ? 0
          : newState.doc.textBetween(sel.from, sel.to).length;
        onSelectionChange(lineCount, column, selectedChars, () => newState.doc.textContent);
      }
    },
  });

  // v0.12.2 P1：创建失败时退化为「无自定义 NodeView」的简单视图（仍可读可切源码模式）
  try {
    view = buildView(state);
  } catch (err) {
    console.error("[createEditor] 编辑器创建失败，回退为简化视图:", err);
    try {
      view = buildView(state, true);
    } catch (err2) {
      console.error("[createEditor] 简化视图创建仍失败:", err2);
      return null;
    }
  }

  // 通知父组件编辑器已就绪
  if (onReady) {
    requestAnimationFrame(() => onReady(view));
  }

  return view;
}
