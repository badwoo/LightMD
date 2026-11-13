/**
 * src/components/editor/panes/ModeSync/ModeSync.tsx —— ModeSync pane
 *
 * ## 职责边界
 *
 * ProseMirror 创建、文件切换、模式切换内容/滚动同步与滚动恢复重试链
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 1912-2948 行。
 * **hook 体逐字节原样**（连缩进、注释、空行都没动）——这是本轮拆分的硬约束：
 * 判定"无逻辑改写"靠的是文本不变，不是靠肉眼审。
 *
 * 参数经 `Params` 解构到本地同名绑定 → 函数体内引用与拆分前完全一致；
 * 产物以 `Result` 对象返回给容器。两边字段都由 TypeChecker 生成真类型。
 *
 * ⚠️ 本文件**不得**直接 import textarea 具体实现：源码面一律经 `SourceSurface`
 * 接口访问（见 src/editor/types.ts）。
 */
import {
  useEffect,
  useRef,
} from "react";
import { t as translate } from "../../../../i18n";
import { HUGE_FILE_THRESHOLD } from "../../../../utils/constants";
import { nextFootnoteLabelFromText } from "../../../../core/pmCommands";
import { unmaskBase64Images, maskBase64Images } from "../../../../utils/base64ImageMask";
import { computeGhostTail } from "../.././sourceFormat";
import { setCurrentDocPath } from "../../../../utils/imagePath";
import { createEditor, clearSerializationCache, getPmHistoryState, getMarkdownFromDoc } from "../../../../core/editor";
import { useSettingsStore } from "../../../../stores/useSettingsStore";
import { useEditorStore } from "../../../../stores/useEditorStore";
import { calculateWordCount } from "../../../../utils/wordCount";
import { documentHistory, begin as historyBegin } from "../../../../services/documentHistory";
import { AiAssistTask } from "../../../../core/plugins/translateTooltip";
import { closeLightbox } from "../../../../core/plugins/image-lightbox";
import { computeScrollPercent, computeRestoreScrollTop } from "../../../../utils/typewriter";
import { fileScrollProgress } from "../../../../services/fileScrollProgress";
import { markdownHasImage } from "../../../../utils/imageManager";
import { computeTextareaCursorPosition } from "../../../../utils/cursorPosition";
import { saveDocHistory, loadDocHistory } from "../../../../services/docHistoryStore";
import { withTrailingParagraph } from "../../../../core/plugins/trailing-paragraph";
import { markdownToDoc } from "../../../../core/markdown/parser";
import { TextSelection } from "prosemirror-state";
import { lineIndexOfOffset } from "../../../../utils/modeAnchor";
import {
  resolveOpenScrollTarget,
  collectPmBlockCaretInfo,
  pmPosToSourceOffset,
  sourceOffsetToPmPos,
  remapOffsetAcrossLineEdits,
} from "../../../../utils/caretMap";
import { getBlockSource } from "../../../../core/markdown/blockSourceMap";
import { collectPmBlockGeometry, restoreContentAnchor } from "../../../../utils/contentScrollMap";
import type { AiTask as AiTask } from "../../../../services/aiAssistService";
import type { EditorView as EditorView } from "prosemirror-view";
import type { EmojiState as EmojiState } from "../../../../core/plugins/emoji-complete";
import type { SlashState as SlashState } from "../../../../core/plugins/slash-command";
import {
  HistoryEntry,
  ScrollRestoreTarget,
  sameTaskList,
  MODE_SLIDE_MS,
  shouldSkipProseMirrorSync,
  shouldResetSourceUndoStack,
  shouldReplacePmDoc,
  traceScroll,
  sourceLineToPos,
  SCROLL_RESTORE_GUARD_MS,
} from "../../EditorContainer";
import type { ModeSyncParams, ModeSyncResult } from "./types";

export function useModeSync(p: ModeSyncParams): ModeSyncResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    sourceSurface,
    isSourceMode,
    setSourceInsertHandler,
    pushUndoEntry,
    sourceTextareaRef,
    sourceContentRef,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    formatGhostRef,
    sourceGhostHandlersRef,
    formatGhostHandlersRef,
    lastTextareaCursorRef,
    typewriterMode,
    editorRef,
    filePath,
    docKeyRef,
    currentDocKeyFromStore,
    lastHistoryContentRef,
    content,
    applyingTranslationRef,
    setCursorLineRef,
    setCursorColumnRef,
    setSelectedCharsRef,
    wordCountTimerRef,
    setWordCountRef,
    isRestoringScrollRef,
    viewRef,
    pmAdapterRef,
    sourceAdapterRef,
    lastRealTextRef,
    onEditorReadyRef,
    startTranslateRef,
    triggerMenuPosRef,
    startAiChatRef,
    startAiAssistRef,
    aiMenuPosRef,
    setPmSlash,
    setPmEmoji,
    setHeadingMenu,
    forceUpdateKey,
    pmScrollPercentRef,
    cachePmGeometry,
    progressKeyRef,
    viewMode,
    setDocHasImageFlag,
    cacheSourceGeometry,
    lastSourceScrollTopRef,
    textareaScrollPercentRef,
    isMdFile,
    lastForceUpdateKeyRef,
    lastSyncDiskRef,
    undoStackRef,
    redoStackRef,
    previewShown,
    pendingIframeScrollRef,
    prevViewModeRef,
    modeAnimGenRef,
    setModeAnim,
    pendingScrollRef,
    modeSwitchAnchorRef,
    sourceContent,
    textareaTopFromContentAnchor,
    restoreScrollWithRetry,
    restorePendingIframeScroll,
    scrollRestoreGenRef,
  } = p;


  // ─── 语法插入回调 ────────────────────────────────
  useEffect(() => {
    if (isSourceMode) {
      const insertHandler = (
        syntax: string,
        cursorOffset?: number,
        opts?: { label?: string; ghost?: string },
      ) => {
        // A3 收敛：纯值（选区）→ 经 surface
        const start = sourceSurface.getSelection().start;
        const end = sourceSurface.getSelection().end;
        const currentContent = sourceContentRef.current;
        const selected = currentContent.substring(start, end);
        // v0.11.0 B3-3：脚注定义使用**未占用的下一个编号**。
        // 缺陷背景：源码模式原固定插入 `[^1]: `，连续两次插入产生两个 `[^1]:`，
        // 后者覆盖前者 → 脚注内容静默丢失。阅读模式走 PM 侧 nextFootnoteLabel，
        // 只有源码模式有此问题。此处有 currentContent，可直接算。
        const finalSyntax = /^\[\^\d+\]: $/.test(syntax)
          ? `[^${nextFootnoteLabelFromText(currentContent)}]: `
          : syntax;
        const newContent = currentContent.substring(0, start) + finalSyntax + currentContent.substring(end);
        const scrollTop = sourceSurface.getScrollTop();
        // 直接推入差异（不用防抖，格式操作是离散的）
        // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
        recordDiscreteSourceEdit(currentContent, newContent, start, scrollTop);
        setSourceContent(newContent);
        sourceContentRef.current = newContent;
        onContentChangeRef.current?.(newContent);
        setDirtyRef.current(true);
        // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
        lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
        const cursorPos = selected
          ? start + finalSyntax.length
          : cursorOffset !== undefined
            ? start + cursorOffset
            : start + Math.floor(finalSyntax.length / 2);
        /**
         * ## ═══ v0.17.0 R4 · T2 · 用户第 1 项：**语法辅助栏插入时页面瞬间往下跳** ═══
         *
         * ### 缺陷（实测，`scripts/v0170-r4-scroll.mjs`，60 段文档滚到 45%）
         *
         * 上面 `setSourceContent(newContent)` 是**整篇 state 替换**，它会让
         * `EditorContainer` 的受控写入 effect 跑一次 `surface.setText(全文)` ——
         * 这在 CM6 下是**整篇替换事务**，触发 heightMap **整体重估**：
         * ```
         * P2  语法栏「代码块」：scrollTop 单帧 174px；scrollHeight 8796 → 7201（塌 1595px）
         * P2b 语法栏「粗体」  ：scrollTop 单帧 257px；scrollHeight 8278 → 7230（塌 1048px）
         * P1  格式栏「粗体」  ：scrollTop 单帧   0px；scrollHeight 8785 → 8785（Δ0）  ← 对照
         * ```
         * **同样的操作幅度、不同的落地链路、完全不同的结果** ——
         * P1 走 `SourcePane.applyMinimalDiscreteEdit`（单事务最小 changes，上一轮已修），
         * 而本函数一直走整篇 `setSourceContent`，上一轮**没有覆盖到**。
         * 这正是用户"特别是从语法辅助栏插入会瞬间往下跳"的机制解释：
         * `scrollHeight` 一次性塌掉 1000~1600px ⇒ 浏览器把 `scrollTop` 钳到新的 max
         * ⇒ 视口内容整体位移 ⇒ 再由 `restore`（本函数末尾的 rAF）用旧像素拉回
         * ⇒ 用户看到一帧"先跳下去再回来"。
         *
         * ### 修法（与 `SourcePane` / 撤销路径**完全同源**：最小 diff 单事务）
         * 算出公共前后缀夹逼出的最小连续替换，经 `applyEdit` 走**单事务最小 changes**，
         * heightMap 只增量更新受影响区块，CM6 **根本不改写 `scrollTop`**。
         *
         * ### ⚠️ 顺序铁律（顺序反了前功尽弃，上一轮踩过）
         * **必须在 `setSourceContent` 之后**：先让 React state / `sourceContentRef` 指向新文本，
         * 受控写入 effect 才会认为"已经是目标值"而**跳过整篇 `setText`**；
         * 若放在之前，effect 会再写一次整篇，最小 diff 白做。
         *
         * ### 为什么这里**内联**而不复用 `SourcePane.computeMinimalEdit`
         * `SourcePane` 的 `computeMinimalEdit` 是导出的，看起来很现成，但：
         * `ModeSync` 已从 `EditorContainer` import 一大票东西，而 `SourcePane` 也从
         * `EditorContainer` import 类型 —— 若为复用再加一条 `ModeSync → SourcePane`，
         * 依赖图会成环（本轮 Lead 明确要求避免）。
         * **宁可这 6 行重复，不要隐式耦合**：最小 diff 的语义是稳定的纯算法，
         * 重复的维护成本远低于一个环。若将来抽到 `utils/minimalEdit.ts`，此处应改为复用。
         */
        if (sourceSurface.impl === "cm6") {
          const a = currentContent;
          const b = newContent;
          if (a !== b && a.length > 0 && b.length > 0) {
            // 公共前缀
            const minLen = Math.min(a.length, b.length);
            let prefix = 0;
            while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
            // 公共后缀（不得越过前缀，避免重叠）
            let suffix = 0;
            const maxSuffix = minLen - prefix;
            while (
              suffix < maxSuffix &&
              a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
            ) suffix++;
            const delLen = a.length - prefix - suffix;
            const insLen = b.length - prefix - suffix;
            /**
             * 只接受"小改动"：改动量不超过文档的 1/4（下限 64 字符）。
             * 超过说明不是"插一段语法符"而是整篇换掉（切文件 / 跨文件替换 / 翻译回写），
             * 那种情况最小化的收益低、且会把一次整篇语义拆成奇怪的局部编辑 —— 退回整篇路径。
             */
            const budget = Math.max(64, Math.floor(Math.max(a.length, b.length) / 4));
            if (delLen + insLen <= budget) {
              try {
                sourceSurface.applyEdit({
                  kind: "edit",
                  edit: {
                    from: prefix,
                    to: prefix + delLen,
                    text: b.slice(prefix, b.length - suffix),
                    // 光标夹到新文本长度内（插入语法符会改变长度，旧 caret 可能越界）
                    caret: Math.max(0, Math.min(b.length, cursorPos)),
                  },
                });
              } catch {
                /* 最小化落地失败：下面的 restore() 仍会用旧像素/光标兜底 */
              }
            }
          }
        }
        // v0.12.0 需求1 返修：语法辅助栏插入同样走格式 ghost 通道——
        // 带 ghost 文案的项（粗体/标题/列表/代码块等）显示灰色占位提示且不落盘。
        //
        // ─── v0.17.0 R3 #3（**实测发现的真实缺陷**）───
        // 旧实现是 `if (!selected)` —— 只要没选区就**无条件**建 ghost 记录，
        // 把 `text` 设为 `opts?.ghost ?? ""`（可能为空串），却仍然计算并渲染 `tail`。
        // 后果（探针 `_tmp-diag7` 实测，点语法栏「表格」）：
        // ```
        // 文档：| 列1 | 列2 | 列3 | / |------|… （预填，正常）
        // 屏幕上还多出一行灰色残影 "列1 | 列2 | 列3 |"（.cm-source-ghost，空 text + 非空 tail）
        // ```
        // 那行灰字既不是占位提示也不是文档内容，纯属**重影**。
        // 「分割线」同样会得到一个空 text 的 ghost 元素（宽 0，肉眼看不见但 DOM 里在）。
        //
        // 修法：**只有带 ghost 文案的项才进入 ghost 通道**，其余清掉残留 ghost。
        // 这与格式栏路径（`SourcePane` 的 `if (result.ghostText) … else clear("input")`）
        // 完全对齐 —— 两条入口对同一个"预填类模板"必须给同一个结果。
        if (!selected && opts?.ghost) {
          // v0.12.0 返修（问题1）：语法辅助栏的粗体/斜体等同样"占位落在格式符中间"
          const gt = computeGhostTail(newContent, cursorPos, finalSyntax.slice(cursorPos - start));
          formatGhostRef.current = {
            text: opts.ghost,
            pos: cursorPos,
            start,
            end: start + finalSyntax.length,
            content: newContent,
            tail: gt.maskTail ? gt.tail : "",
            maskTail: gt.maskTail,
          };
          sourceGhostHandlersRef.current.invalidate();
          requestAnimationFrame(() => formatGhostHandlersRef.current.render());
        } else {
          // 预填类模板（表格/分割线/公式…）与有选区插入：不产生占位提示。
          // 显式清掉上一条命令可能留下的 ghost，避免"新插入 + 旧占位"叠在一屏。
          formatGhostHandlersRef.current.clear("input");
        }
        /**
         * v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（光标位置 + 滚动像素），
         * 不依赖 textarea 的布局几何，因此改经 `SourceSurface` —— 这样 CM6 实现下
         * 同一段代码同样生效，不必再写一份。
         */
        const restore = () => {
          sourceSurface.focus();
          sourceSurface.setSelection(cursorPos, cursorPos);
          sourceSurface.setScrollTop(scrollTop);
          lastTextareaCursorRef.current = cursorPos;
        };
        requestAnimationFrame(restore);
        setTimeout(restore, 50);
      };
      setSourceInsertHandler(insertHandler);
    } else {
      setSourceInsertHandler(null);
    }
    return () => setSourceInsertHandler(null);
  }, [isSourceMode, setSourceInsertHandler, pushUndoEntry]);


  // ─── 打字机模式 ref ──────────────────────────────
  // 提前定义，供 createEditor 的 dispatchTransaction 拦截 ProseMirror 自动滚动
  // 原理：在特定操作（回车换行/方向键/点击）后滚动，使光标所在行位于视口中央
  // 注意：不监听 input 事件，避免每输入一个字符就跳动；
  //       内容未超出视口时不滚动，保证单行/少量内容时屏幕稳定
  // 核心判断逻辑已提取到 utils/typewriter.ts，便于单元测试
  const typewriterModeRef = useRef(typewriterMode);

  typewriterModeRef.current = typewriterMode;


  // v0.8.0 修复4：阅读模式 scrollToCenter 函数提升为 ref，供 onSelectionChange 复用
  // （打字机开启且移动光标时即时居中），避免重复实现滚动逻辑
  const scrollToCenterRef = useRef<() => void>(() => {});


  /**
   * 内容是否达到"超大文件"档位。
   *
   * ⚠️ **必须按 UTF-8 字节数判定，不能用 `content.length`（字符数）**。
   * `App.tsx` 用的是 `fileService.getFileSize()`（**字节**）与 `HUGE_FILE_THRESHOLD` 比较；
   * 而中文 1 字符 = 3 字节 → 一份 5MB 的中文文档只有约 175 万**字符**，
   * 用 `content.length` 判会**永远不触发**（实测：5.2MB 复杂文档 textLen 仅 304 万字符，
   * 未达 5242880 的字符阈值 → PM 照样被创建 → 仍卡 32s）。
   *
   * 用 `TextEncoder` 是最准确的等价换算（浏览器原生、无额外依赖）；
   * 它在 jsdom/WebView2 均可用。
   */
  const isHugeDoc = (text: string | undefined): boolean => {
    if (!text) return false;
    // 快速排除：字符数都不到阈值的 1/3 时，字节数不可能达标（UTF-8 每字符最多 4 字节）
    if (text.length * 3 < HUGE_FILE_THRESHOLD) return false;
    try {
      return new TextEncoder().encode(text).length > HUGE_FILE_THRESHOLD;
    } catch {
      // 极端环境无 TextEncoder：退回按字符数估算（每字符 3 字节，偏保守）
      return text.length * 3 > HUGE_FILE_THRESHOLD;
    }
  };

  // ─── 初始化编辑器（只执行一次）──────────────────
  useEffect(() => {
    const parent = editorRef.current;
    if (!parent) return;
    /**
     * ## v0.17.0：大文件**不创建 ProseMirror**（执行既有策略，非新增设计）
     *
     * `utils/constants.ts` 的 `HUGE_FILE_THRESHOLD` 注释原文就是
     * 「超过此值的文件将禁用 Markdown 渲染和 ProseMirror」，
     * `App.tsx` 的大文件分支也注释「避免 ProseMirror 创建巨大 DOM 导致页面卡顿或崩溃」
     * 并强制切 `edit` + 关预览 + 提示用户。
     *
     * **但那条策略只切了模式，没有真正阻止 PM 创建** —— 本 effect 无条件
     * `createEditor({ initialContent: content })`，5MB 文档照样被全量解析成节点树。
     *
     * 实机 CPU profile（54.7s 采样）证据：PM 的
     * `updateStateInner → updateChildren → forChild` 链占 **45.7%**，
     * 5MB 复杂文档装载 31.8s 全部耗在这里；而 CM6 那侧内容早已正确载入。
     *
     * 因此这里补上"策略的最后一环"：超大文档不建 PM。
     * 这是**执行既有策略**，不是新增降级语义 —— 用户本来就会收到
     * 「已切换到编辑模式以保证流畅度」的提示。
     *
     * @see 第二层：`content` 后续变大时销毁已建 PM（见下方"文件切换"effect）
     */
    if (isHugeDoc(content)) {
      return;
    }
    // v0.12.1 需求3：首次解析也要先把全局文档路径设成本份内容的路径。
    // 本 effect（子组件）先于 App 的 setCurrentDocPath effect 执行，若不在这里同步，
    // 首屏渲染图片时 currentDocPath 还是空的 → 相对路径解析成裸相对路径 → 图片不可见。
    setCurrentDocPath(filePath || "");
    // v0.13.2 需求5：记录初始文档键与内容基线（撤销历史按文档保管的前提）
    docKeyRef.current = currentDocKeyFromStore();
    lastHistoryContentRef.current = content;
    const view = createEditor({
      parent,
      typewriterModeRef,
      // G10：传入 spellcheck 初始值，创建时即设置 .ProseMirror 的 spellcheck 属性
      spellcheckEnabled: useSettingsStore.getState().spellcheckEnabled,
      initialContent: content,
      onDocChange: (markdown: string) => {
        // 更新 lastContentRef 防止 useEffect([content]) 重复解析
        lastContentRef.current = markdown;
        onContentChangeRef.current?.(markdown);
        setDirtyRef.current(true);
        // v0.6.1 问题3：翻译回写（替换/双语）的修改不自动保存；
        // 用户手动输入则恢复正常自动保存
        useEditorStore.getState().setSuppressAutoSave(applyingTranslationRef.current);
        // v0.6.1 问题2：用户手动编辑后原文快照失效，清除"取消翻译"气泡
        if (!applyingTranslationRef.current) {
          useEditorStore.getState().setTranslateUndoSnapshot(null);
        }
      },
      onSelectionChange: (line, column, selectedChars, getText) => {
        setCursorLineRef.current(line);
        // v0.8.3 需求3：列号 / 选中字符数实时同步（均为 O(块内) / O(选区) 计算）
        setCursorColumnRef.current(column);
        setSelectedCharsRef.current(selectedChars);
        if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
        // G11：调用 calculateWordCount 计算字数详情（含字符数/行数/段落数/阅读时长）
        // v0.8.3 需求3：getText 为惰性 getter——全文序列化从"每次选区变化"降为
        // "每 300ms 至多一次"，是长文档输入卡顿的既定热点修复。
        wordCountTimerRef.current = setTimeout(() => setWordCountRef.current(calculateWordCount(getText())), 300);
        // v0.8.0 修复4：打字机开启且非模式切换恢复滚动期间，移动光标即时居中
        // 用 rAF 延后到浏览器布局稳定后执行；scrollToCenter 内部 computeTypewriterScrollTop
        // 自带 5px 阈值防抖，光标已在中央附近时不触发滚动（避免打字抖动）
        if (typewriterModeRef.current && !isRestoringScrollRef.current) {
          requestAnimationFrame(() => scrollToCenterRef.current?.());
        }
      },
      onReady: (v) => {
        viewRef.current = v;
        // v0.15.1 需求1（**关键修复**）：编辑器创建完成后必须给统一时间线建基线。
        //
        // 缺陷：v0.15.0 只在「换文档 effect」里 `historyBegin(incomingKey, content)`，
        // 而那个 effect 要求 `content !== lastContentRef.current`（否则提前 return）。
        // 首次挂载时 `lastContentRef` 就等于 `content` → **一次 begin 都不会发生** →
        // `documentHistory.currentText(key)` 恒为 null → 协调器 `commitFromPm` 里
        // `syncBaseline` 看到 known=null 直接跳过 → `api.commit` 里 `ensureDoc` 用
        // `raw.before ?? ""` 建了一条 **knownText=""** 的空时间线 → `before !== knownText`
        // → **commit 被静默拒绝**。结果：**阅读模式（PM）里的编辑从来不进时间线**，
        // 切到编辑模式后按 Ctrl+Z 撤不掉（用户实测「跨模式撤销还是有问题」）。
        //
        // 这里补上首挂基线：content 是真实内容（App 传入的就是磁盘/标签文本）。
        pmAdapterRef.current.reset(content);
        sourceAdapterRef.current.reset();
        const initialKey = docKeyRef.current;
        if (initialKey && documentHistory.currentText(initialKey) === null) {
          historyBegin(initialKey, content);
        }
        lastRealTextRef.current = content;
        onEditorReadyRef.current?.(v);
      },
      // v0.6.0：PM 选区「译」浮动按钮触发（ref 转发最新闭包，编辑器只创建一次）
      onTranslateTrigger: () => startTranslateRef.current(),
      // v0.9.0 WP9：只读标签（同一文件在其他窗口有未保存修改时选择「只读打开」）
      // getter 动态读当前活跃标签，标记变化时由下方 effect 触发 PM 重新求值
      editableGetter: () => {
        const st = useEditorStore.getState();
        return !st.openTabs[st.activeTabIdx]?.isReadonly;
      },
      // v0.6.0：总开关关闭时不显示选区浮动按钮（动态读取设置）
      // v0.7.0：隐藏翻译小气泡时选区「译」按钮也不显示（气泡已隐藏，触发无反馈）
      // v0.7.0 修复1：双开关语义——全局 AI 总开关 + 翻译子开关都开启才显示
      translateEnabledGetter: () => {
        const s = useSettingsStore.getState();
        return s.aiEnabled && s.translate.translateEnabled && !s.translate.translateBubbleHidden;
      },
      // v0.7.0 修复1/4：延迟出现 + 右键快捷菜单（回调经 ref 转发最新闭包）
      // v0.7.3 改进8(D5)：title 走 i18n，不再硬编码中文
      translateTooltipOptions: {
        getDelay: () => useSettingsStore.getState().translate.translateBubbleDelayMs,
        onContextMenu: (_btn, e) => triggerMenuPosRef.current(e.clientX, e.clientY),
        title: translate("settings.translate.triggerTitle"),
        // v0.7.4 功能7 / v0.7.5 功能2：AI 气泡（续/润/摘/问）接线。
        // onAiAction：「问」打开 AI 对话窗（不走 startAiAssist 气泡任务流），
        // 其余三个复用 startAiAssist（经 ref 转发最新闭包，选区提取逻辑一致）
        onAiAction: (task) => {
          if (task === "chat") startAiChatRef.current();
          else startAiAssistRef.current(task);
        },
        // 任一 AI 按钮右键 → 渲染「隐藏『X』气泡」快捷菜单（按被点按钮的 task 动态文案）
        onAiContextMenu: (btn, e) => {
          const task = (btn as HTMLElement).dataset.task;
          if (!task) {
            aiMenuPosRef.current(e.clientX, e.clientY, null);
            return;
          }
          aiMenuPosRef.current(e.clientX, e.clientY, task as AiAssistTask);
        },
        // v0.7.5 功能2：按任务独立显隐——总开关关闭（aiAssistBubbleEnable=false）
        // 或该任务被独立隐藏（hiddenTasks 命中）均不显示；互不影响其余气泡
        isBubbleHidden: (task) => {
          const tr = useSettingsStore.getState().translate;
          return !tr.aiAssistBubbleEnable || tr.aiAssistBubbleHiddenTasks.includes(task);
        },
        // 各 AI 按钮颜色（空串 → 插件回退主题默认色）
        getBubbleColor: (task) => {
          const tr = useSettingsStore.getState().translate;
          if (task === "continue") return tr.aiAssistBubbleColorContinue || undefined;
          if (task === "polish") return tr.aiAssistBubbleColorPolish || undefined;
          if (task === "summary") return tr.aiAssistBubbleColorSummary || undefined;
          return tr.aiAssistBubbleColorChat || undefined;
        },
        // v0.7.5 功能3：「译」按钮颜色（空串 → 回退主题默认色，外观与 v0.7.4 一致）
        getTranslateColor: () => useSettingsStore.getState().translate.translateBubbleColor || undefined,
        // v0.7.4 修复2：AI 三个气泡延迟（从 mouseup 起算，独立于「译」按钮延迟）
        getAiDelay: () => useSettingsStore.getState().translate.aiAssistBubbleDelayMs,
        // 各 AI 按钮 title（i18n）
        getAiTitle: (task) => {
          if (task === "continue") return translate("ai.title.continue");
          if (task === "polish") return translate("ai.title.polish");
          if (task === "summary") return translate("ai.title.summary");
          return translate("ai.title.chat");
        },
      },
      // v0.7.3 改进8(D5)：AI 续写 ghost 采纳提示文案走 i18n
      aiGhostHint: translate("settings.translate.ghostHint"),
      // v0.6.6 问题2：阅读模式 Slash 命令触发状态（插件检测后回调，驱动 SlashCommandPm 渲染）
      onSlashStateChange: (s) => setPmSlash(s),
      // v0.13.0 需求10：阅读模式 Emoji 短码补全触发状态（驱动 EmojiCompletePm 渲染）
      onEmojiStateChange: (s) => setPmEmoji(s),
      // v0.12.1 需求1：标题级别徽标点击 → 打开 H1~H6 下拉菜单
      // （setState 稳定，无需经 ref 转发；只读标签的拦截在插件 click 处理器内）
      onHeadingBadgeClick: (headingPos, currentLevel, anchor) =>
        setHeadingMenu({ open: true, anchor, level: currentLevel, pos: headingPos }),
      // v0.15.0 需求（跨模式撤销统一）：把 PM 事务转发给时间线的 PM adapter。
      // adapter 内部过滤 bridge / addToHistory:false / 无 docChanged 的事务，
      // 这里无条件转发即可。
      onTransactions: (before, trs, after) => {
        pmAdapterRef.current.handleTransactions(before, trs, after);
      },
    });
    if (view) viewRef.current = view;
    return () => {
      if (view) view.destroy();
      viewRef.current = null;
      // 清理字数统计定时器
      if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
      // v0.15.0 需求（图片灯箱）：卸载时兜底关闭（PM 插件 destroy 与组件卸载各有一层，
      // 三层冗余是刻意的——任何一层失效都不该把浮层留在界面上）
      closeLightbox();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ─── v0.9.0 WP9：只读标记变化时刷新 ProseMirror 的 contenteditable ──────────
  // PM 在 updateStateInner 内重新计算 `this.editable`，故用同一 state 调一次
  // updateState 即可（不产生事务、不触发 onDocChange）。
  const activeIsReadonly = useEditorStore((s) => !!s.openTabs[s.activeTabIdx]?.isReadonly);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.updateState(view.state);
  }, [activeIsReadonly]);


  /**
   * ## ═══ v0.17.0 R5（V1-5 关软件重开进度被覆盖成 0）：启动恢复锁存 ═══
   *
   * ### 缺陷（真机跨进程实测，`_plan/v0170-r5-v1-scroll.md` V1-5）
   * ```
   * 写入阶段（进程1 关闭前）: progress = { "...coldstart.md": 0.50087371 }  ← 正确
   * 读取阶段（进程2 启动后）: progress = { "...coldstart.md": 0 }           ← 被覆盖成 0！
   *                         scrollTop 12次×250ms = [0,0,0,...]              ← 从未恢复
   * ```
   * 根因：冷启动初始 `scrollTop=0` 的 scroll 事件**先于** `[forceUpdateKey]` 恢复
   * effect 到达，scroll 处理器里的 `fileScrollProgress.set` 把 0.5009 冲成 0
   * （`isRestoringScrollRef` 要到恢复 effect 内才置 true，**来不及**挡住抢先的事件）。
   *
   * ### 锁存语义：**启动恢复完成前不写进度**
   * 初始 `false`（挡住抢先到达的 scroll 事件）；恢复流程的**每个收尾点**置 true：
   * 1. `[forceUpdateKey]` effect 的 `finish()`（进度分支恢复完成）；
   * 2. 零分支保护窗超时（无进度/不可滚动，恢复目标本来就是 0，无值可冲）；
   * 3. 无容器早退（没有恢复动作，此状态下也不存在能写进度的 scroll 监听）；
   * 4. `writeOnce` 目标容器消失（恢复不可能完成，按收尾放行）。
   * ⚠️ 四个收尾点**缺一不可**：漏掉任何一个都会造成「进度永不保存」
   * （比本缺陷更严重，round5 报告明确警告过），所以每处都显式收尾。
   */
  const startupRestoreCompleteRef = useRef(false);


  // ─── 持续追踪 ProseMirror 滚动百分比 ──────────
  // 编辑器创建后设置监听，在滚动时实时记录百分比
  // 注意：元素变为 display:none 时 scrollHeight/clientHeight 均为 0，max=0，
  // 此时不应更新百分比（否则会被错误地置为 0，导致模式切换后滚动位置丢失）
  useEffect(() => {
    // 问题4修复：滚动容器从 .ProseMirror 改为 .editor-container
    // 移除 .ProseMirror overflow-y: auto 后，滚动发生在 editor-container 上
    const container = editorRef.current;
    if (!container) return;
    const handler = () => {
      const percent = computeScrollPercent(container.scrollHeight, container.clientHeight, container.scrollTop);
      if (percent !== null) {
        pmScrollPercentRef.current = percent;
        // v0.15.0 需求（阅读↔编辑内容对齐）：滚动期缓存块几何。
        // 必须在这里采（阅读面可见、布局真实），不能在切换瞬间采（那时 display:none）。
        // 恢复过程中不采：瞬时布局（内容刚替换）会污染缓存。
        if (!isRestoringScrollRef.current) cachePmGeometry();
        // v0.12.0 返修（问题5）：正在恢复滚动位置时不写进度——恢复过程中的瞬时
        // 像素值（如内容刚替换时的 0）会覆盖刚从快照注入的进度
        // v0.17.0 R5（V1-5）：启动恢复完成前同样不写（冷启动初始 scrollTop=0 的
        // scroll 事件会抢先覆盖已保存进度，见 startupRestoreCompleteRef 注释）
        if (!isRestoringScrollRef.current && startupRestoreCompleteRef.current) {
          // v0.7.0 bug修复：按文件记录浏览进度（标签切换保留；重新打开由 App 层 clear 重置）
          fileScrollProgress.set(progressKeyRef.current, percent);
        }
      }
    };
    // v0.8.3 WP5 需求7：passive 滚动监听——滚动处理不调用 preventDefault，
    // 声明 passive 后浏览器无需等待 JS 即可提交合成帧。
    container.addEventListener("scroll", handler, { passive: true });
    return () => container.removeEventListener("scroll", handler);
  }, [content, forceUpdateKey]);


  // ─── v0.13.0 返修（问题6）：同步「文档是否含图片」标志 ──────────
  // 用于决定右上角「图片管理」悬浮入口是否显示。
  //
  // v0.13.0 返修第三轮（问题9）：**改为只依据 `content` 文本判定**。
  //
  // 缺陷背景（用户报告「打开带图片的文档，右上角的图片管理图标没有自动出现」）：
  // 旧实现在阅读模式下读 `viewRef.current.state.doc`，但本 effect 的声明位置在
  // 「文件切换重建 doc」那个 effect **之前**（React 按声明顺序执行 effect）→
  // 切文件时这里读到的还是**上一个文档**的文档树；而依赖数组 `[content, viewMode,
  // forceUpdateKey]` 在「无图文档 → 有图文档」且两者 content 结构不同时虽会变化，
  // 但读到的仍是旧 doc，于是标志被算成 false。实测：从无图文档切到有图文档后
  // 图标不出现；反向切回后图标也不消失（双向错）。
  //
  // `markdownHasImage(content)` 已经在**文本层**判定并剔除了围栏/行内代码里的假图片
  // （v0.13.0 返修问题6 引入，有单测），而 `content` 是 App 侧的唯一内容源、
  // 文件切换与每次编辑都会更新 → 与 effect 执行顺序无关，不存在读到旧文档的问题。
  useEffect(() => {
    const has = markdownHasImage(content);
    setDocHasImageFlag((prev) => (prev === has ? prev : has));
  }, [content, viewMode, forceUpdateKey, filePath]);


  // ─── v0.7.4 修复1/2 / v0.7.5 功能2/3：AI 气泡设置变化 → 刷新浮动按钮 ──────────
  // AI 气泡的显示/颜色由设置驱动，而设置变化不会产生 PM 事务，
  // 插件因此无法感知（此前右键隐藏后需重新选文本才恢复显示、改色不生效）。
  // 用 store 订阅（不引起组件重渲染）+ 空事务 dispatch 触发插件 view().update
  // → updateFloating 重读 isBubbleHidden/getBubbleColor/getTranslateColor，即时生效。
  useEffect(() => {
    const unsubscribe = useSettingsStore.subscribe((state, prevState) => {
      const cur = state.translate;
      const prev = prevState.translate;
      const changed =
        cur.aiAssistBubbleEnable !== prev.aiAssistBubbleEnable ||
        cur.aiAssistBubbleDelayMs !== prev.aiAssistBubbleDelayMs ||
        cur.aiAssistBubbleColorContinue !== prev.aiAssistBubbleColorContinue ||
        cur.aiAssistBubbleColorPolish !== prev.aiAssistBubbleColorPolish ||
        cur.aiAssistBubbleColorSummary !== prev.aiAssistBubbleColorSummary ||
        // v0.7.5 功能2/3：独立隐藏列表（数组需比较内容）与「问」「译」颜色
        cur.aiAssistBubbleColorChat !== prev.aiAssistBubbleColorChat ||
        cur.translateBubbleColor !== prev.translateBubbleColor ||
        !sameTaskList(cur.aiAssistBubbleHiddenTasks, prev.aiAssistBubbleHiddenTasks);
      if (!changed) return;
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      view.dispatch(view.state.tr);
    });
    return unsubscribe;
  }, []);


  // ─── 持续追踪 textarea 滚动百分比 + **缓存源码面块几何** ──────────────
  useEffect(() => {
    // TODO(v0.18): CM6 能力缺口 — 源码块几何的滚动期采样。当前 CM6 表现：不采样 → 分屏对齐退回百分比（同 4 倍量级偏差） | 用户可感知度：中 | 建议优先级：P1
    /**
     * ═══ v0.17.0 P1-4：源码侧滚动监听必须经 `SourceSurface` ═══
     *
     * ## 缺陷（实机取证，文字/位置级证据见 `_plan/v0170-p1-4-*`）
     *
     * 旧实现把监听直接绑在 `sourceTextareaRef.current`：
     * ```ts
     * const textarea = sourceTextareaRef.current;   // CM6 下是**中性宿主 div**
     * if (!textarea) return;                        // div 非 null → 继续执行
     * textarea.addEventListener("scroll", handler); // ← 绑在一个**永不滚动**的元素上
     * ```
     * CM6 的真实滚动发生在 `view.scrollDOM`（`.cm-scroller`），而宿主 div 的
     * `scrollHeight === clientHeight`（实机 1250 / 1250）→
     * **`scroll` 事件永不触发** → `handler` 一次都不跑 →
     * ① `textareaScrollPercentRef` 永停初始值 0 → 切阅读时按 percent=0 恢复 → **落回文档顶部**；
     * ② 同一 handler 里的 `fileScrollProgress.set(...)` 永不执行 →
     *    **编辑态滚动进度从不写盘**（实机：编辑态滚 33% → 写盘 0 次；阅读态正常）。
     *
     * ## 修法
     * 走 `sourceSurface.onDidScroll(cb)`（接口能力，textarea 实现绑元素、
     * CM6 实现绑 `view.scrollDOM`），几何一律取 `getMetrics()`。
     * 与 `PreviewPane` 的分屏双向联动同一套做法（commit 44aa12c）。
     */
    const offSourceScroll = (() => {
    let raf = 0;
    /** 滚动/尺寸变化后用 rAF 合并采样（滚动事件每帧可多次触发，测量不便宜） */
    const scheduleCache = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // v0.15.1 需求3（二次修复）：**在可见期间**缓存源码面块几何。
        // 切换瞬间源码面已 display:none、clientWidth/Height 全 0 → 现量必得 null
        // → 「编辑→阅读」方向会静默退回百分比（这正是漂移没根治的原因）。
        if (!isRestoringScrollRef.current) cacheSourceGeometry();
      });
    };
    const off = sourceSurface.onDidScroll((ev) => {
      const { scrollTop, scrollHeight, clientHeight } = ev;
      const percent = computeScrollPercent(scrollHeight, clientHeight, scrollTop);
      // v0.15.1 需求1：记录"编辑前"的滚动位置，供撤销恢复现场用
      //（onChange 里读到的已是新布局，跨行编辑时 scrollTop 可能已被浏览器调整）
      lastSourceScrollTopRef.current = scrollTop;
      if (percent !== null) {
        textareaScrollPercentRef.current = percent;
        // v0.12.0 返修（问题5）：恢复期间不写进度（同上）
        // v0.17.0 R5（V1-5）：启动恢复完成前同样不写 —— 冷启动初始 scrollTop=0 的
        // scroll 事件先于恢复流程到达，会把已保存进度冲成 0（见 startupRestoreCompleteRef）
        if (!isRestoringScrollRef.current && startupRestoreCompleteRef.current) {
          // v0.7.0 bug修复：按文件记录浏览进度（同上）
          // v0.17.0 P1-4：这条此前在 CM6 下**永不执行**（监听绑在不滚动的宿主上）
          fileScrollProgress.set(progressKeyRef.current, percent);
        }
      }
      scheduleCache();
    });
    return off;
    })();
    return () => {
      offSourceScroll();
    };
  }, [cacheSourceGeometry, sourceSurface]); // surface 实例稳定（useRef），只需绑定一次


  /**
   * v0.15.1 需求3：源码面几何缓存的**主动刷新点**。
   *
   * ⚠️ 只在这些**低频**时机刷新，**不要**挂 `sourceContent`（每次按键都变）：
   * `measureSourceBlocks` 会建一个覆盖全文的镜像 div 再逐块量 `getBoundingClientRect`
   * —— 大文档上是 O(全文) 的强制布局，挂在输入路径上会直接拖慢打字。
   * 输入后的新鲜几何在**切换的那一帧现量**就够了（见 `captureSourceContentAnchor`：
   * render 期 textarea 仍可见 → 现量优先，缓存只是量不到时的兜底）。
   */
  useEffect(() => {
    if (isSourceMode) {
      // 刚切进编辑面：等两帧（React 提交 + 浏览器布局）后采一次
      const r1 = requestAnimationFrame(() => {
        const r2 = requestAnimationFrame(() => cacheSourceGeometry());
        void r2;
      });
      return () => cancelAnimationFrame(r1);
    }
    // 切离编辑面：**保留**缓存（下次切换要用它做兜底锚点），不清理
    return;
  }, [isSourceMode, cacheSourceGeometry, viewMode]);


  // ─── v0.8.3 需求3：源码模式（textarea）光标行列 / 选中字符数 ──────────
  // textarea 的 selectionStart/End 是唯一真相源；用 rAF 合并同一帧内的多次事件
  // （select → click → input 常连续触发），避免重复写 store。
  /**
   * #6（v0.17.0 第三轮）：模式切换时**精确源码光标**的传递通道。
   *
   * 为什么不塞进 `pendingScrollRef`：那个类型在 `historyhost/types.ts` 定义、
   * 三处同步（types + HistoryHost + ModeSync），而 `HistoryHost.tsx` 不在 T5 写域。
   * 局部 ref 完全够用 —— 写入（`viewMode` effect）与读取（`applyScroll`）在同一次
   * 同步切换流程内，没有跨文档/跨 await 的边界。
   *
   * `null` = 没有精确值，调用方走 v0.12.0 的"行号 + 列偏移"回退。
   */
  const pendingPreciseCursorRef = useRef<number | null>(null);

  const sourceCursorRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isSourceMode) return;
    // TODO(v0.18): CM6 能力缺口 — 光标行列的事件绑定（CM6 已用 `onDidChange` + `selectionchange` 覆盖主路径）。当前 CM6 表现：本处元素事件不生效，但主路径已覆盖，状态栏正常 | 用户可感知度：低 | 建议优先级：P2
    const textarea = sourceTextareaRef.current;
    /**
     * v0.17.0 A3 收尾（**B 类·静默失效 → 已修**）：源码模式光标行列 / 选中字符数。
     *
     * 原 `if (!textarea) return;` 在 CM6 下让整段 effect 不执行 →
     * **光标行列、列号、选中字符数全部停止更新**（状态栏一直停在旧值，零 fallback）。
     *
     * 修法：取值早已改经 surface，问题只在"事件从哪来"。因此：
     * - 有 textarea → 绑元素事件（原行为不变，最精确）；
     * - 无 textarea（CM6）→ 用 `surface.onDidChange` 订阅（A3 已具备的能力）
     *   + `document` 的 selectionchange（覆盖纯光标移动，不产生 change 事件的情形）。
     */
    const update = () => {
      if (sourceCursorRafRef.current !== null) return;
      sourceCursorRafRef.current = requestAnimationFrame(() => {
        sourceCursorRafRef.current = null;
        // A3 收敛：纯值（文本 + 选区）→ 经 surface
        const curSel = sourceSurface.getSelection();
        const pos = computeTextareaCursorPosition(sourceSurface.getText(), curSel.start, curSel.end);
        setCursorLineRef.current(pos.line);
        setCursorColumnRef.current(pos.column);
        setSelectedCharsRef.current(pos.selectedChars);
      });
    };
    /** 卸载清理集合（两种绑定路径共用） */
    const cleanups: Array<() => void> = [];
    if (textarea) {
      textarea.addEventListener("keyup", update);
      textarea.addEventListener("click", update);
      textarea.addEventListener("input", update);
      textarea.addEventListener("select", update);
      textarea.addEventListener("focus", update);
      cleanups.push(() => {
        textarea.removeEventListener("keyup", update);
        textarea.removeEventListener("click", update);
        textarea.removeEventListener("input", update);
        textarea.removeEventListener("select", update);
        textarea.removeEventListener("focus", update);
      });
    } else {
      // CM6 路径：surface 变更订阅 + 全局 selectionchange（覆盖纯光标移动）
      const off = sourceSurface.onDidChange(update);
      cleanups.push(off);
    }
    // selectionchange 对所有实现都成立（覆盖方向键/Home/End 等不触发 change 的光标移动）
    document.addEventListener("selectionchange", update);
    cleanups.push(() => document.removeEventListener("selectionchange", update));

    // 进入源码模式时先同步一次当前光标位置（不等用户操作）
    update();
    return () => {
      cleanups.forEach((fn) => fn());
      if (sourceCursorRafRef.current !== null) {
        cancelAnimationFrame(sourceCursorRafRef.current);
        sourceCursorRafRef.current = null;
      }
    };
  }, [isSourceMode]);


  // ─── 文件切换：更新编辑器内容 ──────────────────
  // 非 md 文件不需要更新 ProseMirror（阅读模式使用纯文本视图）
  useEffect(() => {
    if (!isMdFile) return;
    const view = viewRef.current;
    const forceUpdate = forceUpdateKey !== lastForceUpdateKeyRef.current;
    /**
     * ## v0.17.0：内容后来变成超大文档 → **销毁已建的 PM**
     *
     * 第二层保护。大文件的真实时序是：
     * 「先以欢迎页/空内容挂载（此时 `content` 很短 → 建前判据不成立 → PM 被创建）
     *  → `openFile` 把 `content` 换成 5MB → 上一步的"建前跳过"已经赶不上了」。
     *
     * 所以必须在**内容变化时**再判一次：超阈值就销毁 view 并置 null，
     * 让后续所有 `viewRef.current` 读取走它们已有的 `if (!view) return` 守卫。
     *
     * ⚠️ 销毁后不可恢复：本档位下 App 已强制 `viewMode === "edit"` 且关闭预览，
     * 用户没有入口回到阅读模式（切换按钮已按大文件策略禁用），因此不需要"重建"路径。
     */
    if (view && isHugeDoc(content)) {
      try {
        view.destroy();
      } catch {
        /* view 可能已销毁 */
      }
      viewRef.current = null;
      return;
    }
    if (!view || content === undefined) return;
    if (!forceUpdate && content === lastContentRef.current) return;
    // ⚠️ v0.13.2 返修（用户复测：新文档切走再切回 Ctrl+Z 失效）：
    // `lastContentRef` 是**离开文档**的历史基线，必须在保存历史之后再改成新文档内容。
    // 旧实现先执行 `lastContentRef.current = content`（新文档内容），再到下面用
    // `lastContentRef.current` 作为快照 content 保存 —— 结果快照里存的是
    // 「新文档的内容 + 旧文档的 history」。切回旧文档时 content 与快照 content
    // 必然不一致 → `loadDocHistory` 按安全策略丢弃快照 → 撤销历史归零（Ctrl+Z 无效）。
    // 新建的空文档尤其明显（它的编辑历史刚建立就丢），因此这里只更新"上一次的
    // forceUpdateKey"，基线留到 saveDocHistory 之后再更新。
    lastForceUpdateKeyRef.current = forceUpdateKey;
    if (forceUpdate) lastSyncDiskRef.current = content;
    // 文件切换时清除序列化缓存，因为 doc 对象会变化
    if (forceUpdate) clearSerializationCache();
    try {
      // v0.12.1 需求3（图片切文档后消失）：**在解析文档之前**把全局文档路径切到本份内容
      // 对应的路径。schema.image.toDOM 用模块级 currentDocPath 解析相对路径
      // （./assets/x.png → asset://…），而 App 层"设路径"和"投内容"都走 React 状态：
      // 子组件（本组件）的 effect 先于父组件 App 的 effect 执行，于是切标签时
      // 这里解析图片用的仍是**上一个**文档的路径 —— 文档一换、图片路径就错，
      // 表现为"图片文档切走再切回来图片就没了"。这里以 filePath 为准同步一次，
      // 与内容同源、与 React effect 顺序无关。
      setCurrentDocPath(filePath || "");
      // ─── v0.13.2 需求5：先把**离开的那个文档**的撤销历史存起来 ───────────
      // 用户报告「切走再切回，a 文档之前的编辑就撤不回来了」。旧实现（v0.13.1）
      // 换文档时直接清空撤销栈（数据安全优先），代价正是丢历史。
      // 现在：离开前把该文档的 PM history 状态 + 源码 diff 栈存进
      // `services/docHistoryStore`；回来时若内容与保存时逐字节一致就装回去。
      // 内容不一致（例如被外部程序改过）时快照被丢弃 —— 位置敏感，
      // 宁可丢历史也不能把撤销应用到错误偏移（详见 docHistoryStore 的注释）。
      //
      // ⚠️ 内容基线取 `lastContentRef.current` 而**不是** `lastHistoryContentRef`：
      // 前者在每次换文档/回写时都同步为"当前文档的真实内容"（编辑期间由
      // `onDocChange` 持续刷新），后者只是上次换文档那一刻的快照。
      // 用后者会导致"切走时存的是旧内容"，回来时内容比较必然失败 → 历史被丢弃
      // （这正是实测中"切回来仍撤不了"的原因）。
      const leavingKey = docKeyRef.current;
      if (leavingKey) {
        saveDocHistory(leavingKey, {
          // 此时 lastContentRef 仍是**离开文档**的内容（基线更新已移到本块之后）
          content: lastContentRef.current,
          pmHistory: getPmHistoryState(view.state),
          sourceUndo: [...undoStackRef.current],
          sourceRedo: [...redoStackRef.current],
        });
      }
      // 保存完离开文档的历史，才能把内容基线切到新文档
      lastContentRef.current = content;
      // v0.13.2 需求9：换过来的文档若是"以表格/代码块结尾"，也要补一个可放光标的
      // 空段落（pad 段落不进序列化，见 core/plugins/trailing-paragraph.ts）。
      // 插件的 appendTransaction 只在文档被改动时跑，而"整篇替换"这一条事务本身
      // 就是 docChanged，插件会在其之后补上；这里显式补一次是为了让**内容比较**
      // （`loadDocHistory`）与最终 doc 一致，避免历史装回时基线对不上。
      const newDoc = withTrailingParagraph(markdownToDoc(content));
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
      tr.setSelection(TextSelection.atStart(tr.doc));
      tr.setMeta("fileSwitch", true);
      // v0.13.1 需求8：换文档 = 撤销历史的**边界**。
      // `addToHistory:false` 让"切换文档"这一步本身不可撤销；
      // `resetHistory:true` 让 editor.ts 重建 state ——
      // 否则在 B 里按 Ctrl+Z 会撤销/重放 A 的编辑步骤，把 A 的内容带进 B
      // （随后保存就会写错文件）。详见 core/editor.ts 的 dispatchTransaction 注释。
      tr.setMeta("addToHistory", false);
      tr.setMeta("resetHistory", true);
      // v0.13.2 需求5：若这个文档上次离开时留有历史，且内容一致 → 装回去
      const incomingKey = currentDocKeyFromStore();
      const restored = loadDocHistory(incomingKey, content);
      if (restored?.pmHistory) {
        tr.setMeta("restoreHistory", restored.pmHistory);
      }
      view.dispatch(tr);
      /**
       * ## v0.17.0 装配修复：文件切换时必须同步 `sourceContent`
       *
       * **缺陷（5MB 大文件场景，实机 `perf-bench` 暴露）**：
       * 大文件（> HUGE_FILE_THRESHOLD）打开时 App 会**强制切到编辑模式**，
       * 此时走的就是这条"文件切换"effect。但它过去**只更新 PM 的 doc**，
       * 从不调 `setSourceContent(content)` —— 在 textarea 时代这没问题
       *（源码面由 React 的 `value={sourceContent}` 受控渲染，`sourceContent`
       * 的初值来自 `useState(content)`）；
       *
       * 而 CM6 渲染的是中性 div，内容完全靠 `sourceContent` state → effect `setText` 同步。
       * 于是：
       * - `sourceContent` 停留在挂载时的旧值（空串）；
       * - CM6 收到空文档 → **5MB 文件打开后编辑器一片空白**。
       *
       * 实机证据（`scripts/v0170-diag-5mb-empty.mjs`）：
       * `tabs=1` 且状态栏显示 `big.md ●`（文件确实打开了），
       * 但 30s 内 `.cm-line` 恒为 1 条、`.cm-scroller` 高 1170px（= 视口高，无内容）。
       *
       * 修法：与 PM 同步**同一处**把文本推进源码面 state。两个实现都受益
       *（textarea 路径下是一次等价重渲染，行为不变）。
       *
       * ## ⚠️ v0.17.0 第三轮 #9-B 追加：**必须 mask 后再推进**
       *
       * 上面那次修复落地时写的是 `setSourceContent(content)` —— 裸真实内容。
       * 但 `sourceContent` 的契约是 **masked 展示坐标**（base64 → `image-1.png`），
       * 真实内容只能进 `onContentChange` / 落盘 / 翻译快照。
       *
       * 后果（用户第 9 项）：「之前图片都以短格式展示，现在编辑模式下又变成长串
       * 编码了」。实测 4,182,172 字节文档：源码面 `len=4182120`、`hasRawBase64=true`
       * —— 与原文长度**完全相等**，说明这里写进去的就是未 mask 的裸内容。
       *
       * 这里**不需要**回声判定：本 effect 只在**换文档**（fileSwitch/forceUpdate）时
       * 走这条分支，不是每键热路径（`content === lastContentRef.current` 时上面已
       * 提前 return）。所以一次 `maskBase64Images` 是低频成本。
       *
       * 标记表也一并重置：跨文档复用 `image-1.png` 会 unmask 成**上一份文档的图片**。
       */
      base64TokensRef.current = new Map();
      const { text: maskedContent } = maskBase64Images(content, base64TokensRef.current);
      setSourceContent(maskedContent);
      sourceContentRef.current = maskedContent;
      // v0.13.2 需求5：源码模式的撤销栈同样按文档存取（与 PM 侧同一口径）。
      // 旧实现换文档即清空两条栈 —— 那正是"切回来撤不了"的另一半原因。
      undoStackRef.current = (restored?.sourceUndo as HistoryEntry[] | undefined) ?? [];
      redoStackRef.current = (restored?.sourceRedo as HistoryEntry[] | undefined) ?? [];
      lastHistoryContentRef.current = content;
      docKeyRef.current = incomingKey;
      // v0.15.0 需求（跨模式撤销统一）：切换文档时把**统一时间线**切到新文档。
      // 内容与时间线已知文本一致 → 保留历史（切回来仍可撤销）；不一致 → 重置
      // （外部重载/磁盘被改，位置语义已失效）。同时清空两个 adapter 的节流队列，
      // 避免上一个文档的待提交编辑串到新文档。
      if (incomingKey) {
        pmAdapterRef.current.reset(content);
        sourceAdapterRef.current.reset();
        // v0.15.0 需求（跨模式撤销统一）：切文档时**不能无条件 `historyBegin`**。
        //
        // `begin(docKey, content)` 在 `content !== knownText` 时会**整条重置**时间线
        // （那是给"外部重载/磁盘被改"用的安全语义）。但切标签时 `content` 是 store
        // 里的最新文本，而时间线的 `knownText` 可能是"跨文件替换记录时的 before"——
        // 两者必然不同 → 一进 B 就把「跨文件替换」条目丢掉，用户切过去撤不回来
        //（实机探针 8 项 FAIL 的根因）。
        //
        // 正确语义：
        // - 该文档**还没有**时间线 → `begin` 建立基线；
        // - 已有时间线 → 保留条目，只把基线推进到当前文本（`rebaseText`）；
        //   仅在"确实无历史"（条目为空）时才用 `begin` 重新对齐。
        const hadTimeline = documentHistory.currentText(incomingKey) !== null;
        if (hadTimeline) {
          // force:true → 处于"已撤销若干步"时先截断 redo 再推进基线
          //（切走再切回来，redo 分支的位置语义已失效，丢弃比错位安全）
          documentHistory.rebaseText(incomingKey, content, { force: true });
          historyBegin(incomingKey, content);
        } else {
          documentHistory.begin(incomingKey, content);
        }
        lastRealTextRef.current = content;
      }
    } catch (e) {
      console.error("更新编辑器内容失败:", e);
    }
    // v0.15.0 需求（图片灯箱）：切文档强制关闭灯箱，避免浮层盖住新文档 / 残留旧图
    closeLightbox();
  }, [content, forceUpdateKey, isMdFile, filePath]);


  // ─── v0.7.0 bug修复：文件切换保留浏览进度 ─────────
  // 需求：切换不同打开的文件时浏览进度不重置；重新打开该文件时重置到顶部。
  // 实现：scroll 事件已按 filePath 实时写入 fileScrollProgress；
  // 此处文件切换（forceUpdateKey 变化，App 层所有切换路径都会 +1）时读取
  // 新文件的进度并恢复。重新打开场景 App 层已 clear → get 返回 null → 不恢复（顶部）。
  // 性能：Map.get 单次哈希查询；恢复仅在切换时执行一次（双 rAF 等布局稳定）。
  useEffect(() => {
    /**
     * ## ═══ v0.17.0 第三轮（#11 新打开的文档自动跳到文档底部）：`null` 必须写 0，不能 return ═══
     *
     * ### 缺陷
     * 旧写法：
     * ```ts
     * const percent = fileScrollProgress.get(progressKeyRef.current);
     * if (percent === null) return;    // ← 「没有进度快照」被当成「什么都不做」
     * ```
     * 但滚动容器是**跨文档复用**的同一个 DOM 节点：
     * - 编辑态是 CM6 的 `view.scrollDOM`（`.cm-scroller`）；
     * - 阅读态是 `.editor-container`。
     *
     * 切文档时它们**不会被销毁重建**，`scrollTop` 原地保留 → 「不写」= 「沿用上一份文档的位置」。
     *
     * ### 为什么残留值会被放大成"到底"（这是用户看到的现象）
     * CM6 的 scroll anchoring（`@codemirror/view/dist/index.js`）：
     * ```js
     * // :787-790
     * scrolledToBottom = elt.scrollTop > Math.max(1, sh - ch - 4);
     * // :6349  贴底时**不做锚点记录**
     * let scrollAnchor = this.scrolledToBottom ? null : this.scrollAnchorAt(this.scrollOffset);
     * // :6355-59  没有锚点 → 位置标记为 -1
     * else { this.scrollAnchorPos = -1; this.scrollAnchorHeight = prevHeight; }
     * // :8307  补偿时按 -1 处理 = 推到新文档的**最底部**
     * else if (scrollAnchorPos < 0) scroll.scrollTop = scroll.scrollHeight;
     * ```
     * 于是：上一份文档"在底部" ⇒ 新文档**首帧就在底部**（不是逐帧爬到底，是一步到位）。
     *
     * ### 实测（`scripts/v0170-r3-grad-ab.mjs`，单变量只改 A 的位置）
     * | 组 | A 打开前的 st | 打开 B 后 B 的 st / max |
     * |---|---|---|
     * | G0 | 0 | **0 / 10974** |
     * | G1 | 1695（50%） | **65 / 11349** |
     * | G2 | 3706（=max） | **11395 / 11395 = 100%** |
     * | G3 | 11395（=max，长文档） | **1662 / 1662 = 100%**（钳到自身 max） |
     *
     * 阅读面更直接：R0=0 / R1=**1099** / R2=**2197**（= A 的原值，1:1 搬运）。
     *
     * ### 修法
     * 语义改为：**「没有该文件的进度」⇒ 明确回到顶部（0）**；
     * 有合法进度 ⇒ 按百分比恢复（**同一文件**的进度不能被这条修复废掉）。
     * 决策逻辑抽成纯函数 `resolveOpenScrollTarget`（`utils/caretMap.ts`，有单测锁定）。
     *
     * ### ⚠️ 写完 0 还不够：CM6 的 measure 会在后续帧再覆盖一次
     * 上面的 `:8307` 分支跑在 CM6 自己的 `measure()` 里，它可能发生在**我们写完 0 之后**
     * （布局收敛、视口外行补渲染都会触发 measure）。所以：
     * - 写完先**读回**验证；
     * - 不是 0 就在后续帧**重写**（rAF / 120ms / 320ms 三段，覆盖实测的 sh 增长窗口
     *   5254→6251→7057）；
     * - 只对 `no-progress` 这类"目标值恒为 0"的场景做重写 —— 有进度的场景沿用既有
     *   "几何收敛后重算"链，避免两套逻辑打架。
     */
    // v0.8.3 WP4 需求6：进度键从"文件路径"改为"tab 键"（临时文本 = untitled:<id>），
    // 这样跨会话恢复的临时标签也能记住阅读位置。
    const percent = fileScrollProgress.get(progressKeyRef.current);
    /**
     * ## ═══ v0.17.0 第二轮（#10 重启后阅读进度不恢复）：本 effect 在 CM6 下曾经整体失效 ═══
     *
     * ### 缺陷
     * 旧写法在编辑态读 `sourceTextareaRef.current` 的几何：
     * ```ts
     * const el = isSourceMode ? sourceTextareaRef.current : editorRef.current;
     * const newTop = computeRestoreScrollTop(percent, el.scrollHeight, el.clientHeight);
     * el.scrollTop = newTop ?? 0;
     * ```
     * CM6 下该 ref 是**中性宿主 div**（不滚动）：`scrollHeight === clientHeight`
     * → `computeRestoreScrollTop` 的 `max = sh - h = 0` → **恒返回 null**；
     * 空值又触发 `newTop === null && percent > 0` 的重试分支 → 白重试 8 次 ×80ms
     * → 最后 `el.scrollTop = 0`（对 div 是空操作）。
     * 结果：**编辑态的文件切换 / 跨会话进度恢复整条链没有任何效果**，且零报错。
     *
     * 这与 §4-31 / P1-4 是同一类缺陷（"把 CM6 宿主 div 当 textarea 用"）——
     * `onDidScroll` 订阅侧已修（P1-4），但**这条读几何的恢复侧漏了**。
     *
     * ### 修法（只换几何来源，不动重试链结构与 `isRestoringScrollRef` 语义）
     * - 真 textarea → 原路径逐字节不变；
     * - CM6 → 几何取 `sourceSurface.getMetrics()`，写入取 `sourceSurface.setScrollTop()`。
     *   ⚠️ **不能**沿用"div 的 clientHeight > 0 就当可测量"：div 的 clientHeight 恒 > 0，
     *   但它的 `scrollHeight` 与 `scrollTop` 都是假的（分别等于 clientHeight / 0），
     *   拿它算 `maxScroll` 永远得 0，且写 `scrollTop` 是空操作。
     */
    // ⚠️ 必须 `typeof .value === "string"` 判定，不能真值性判断（div 是 truthy）
    const rawSourceEl = sourceTextareaRef.current as unknown as HTMLElement | null;
    const realTextarea =
      rawSourceEl && typeof (rawSourceEl as unknown as { value?: unknown }).value === "string"
        ? (rawSourceEl as unknown as HTMLTextAreaElement)
        : null;
    /** 统一的"当前目标容器的几何 + 写入"抽象（阅读面 / 源码面各一套） */
    const target = isSourceMode
      ? realTextarea
        ? {
            rect: () => ({
              scrollHeight: realTextarea.scrollHeight,
              clientHeight: realTextarea.clientHeight,
            }),
            write: (top: number) => {
              realTextarea.scrollTop = top;
            },
          }
        : {
            rect: () => {
              const m = sourceSurface.getMetrics();
              return { scrollHeight: m.scrollHeight, clientHeight: m.clientHeight };
            },
            write: (top: number) => sourceSurface.setScrollTop(top),
          }
      : (() => {
          const readRect = () => {
            const c = editorRef.current;
            return c
              ? { scrollHeight: c.scrollHeight, clientHeight: c.clientHeight }
              : null;
          };
          return {
            rect: readRect,
            write: (top: number) => {
              const c = editorRef.current;
              if (c) c.scrollTop = top;
            },
          };
        })();
    // 阅读面容器可能还没挂上（非 md 文件等）→ 与旧行为一致：直接收尾
    if (!target.rect()) {
      isRestoringScrollRef.current = false;
      // R5 锁存收尾③：无容器 = 没有恢复动作可保护；此状态下也不存在能写进度的
      // scroll 监听（PM 监听绑同一容器、源面隐藏），开锁安全且必须（防永久闭锁）
      startupRestoreCompleteRef.current = true;
      return;
    }
    // 标记恢复中，防打字机 effect 的 smooth 滚动覆盖（与 applyScroll 相同策略）；
    // v0.12.0 返修（问题5）：恢复完成前 scroll 处理器不写进度，避免中途瞬时 0 覆盖快照
    isRestoringScrollRef.current = true;

    /* ══════════════════════════════════════════════════════════════════════
     * #11（v0.17.0 第三轮）：**没有该文件的进度 ⇒ 明确回顶部**，而不是「什么都不做」
     *
     * 决策交给纯函数 `resolveOpenScrollTarget`（`utils/caretMap.ts`，有单测锁定），
     * 这里只负责「写 + 复核 + 必要时重写」—— 因为 CM6 会覆盖。
     * ══════════════════════════════════════════════════════════════════════ */
    const openTarget = resolveOpenScrollTarget({
      percent,
      scrollHeight: target.rect()?.scrollHeight ?? 0,
      clientHeight: target.rect()?.clientHeight ?? 0,
    });
    if (openTarget.reason !== "progress") {
      /**
       * ## 为什么"写完还要复核"
       *
       * `scrollTop = 0` 只改我们这一侧。CM6 的 `measure()` 在**后续帧**仍可能执行
       * 贴底补偿（`@codemirror/view` :8307 `else if (scrollAnchorPos < 0)
       * scroll.scrollTop = scroll.scrollHeight`），触发时机是布局收敛 /
       * 视口外行补渲染（R2 实测 sh 在 ~1s 内 5254→6251→7057 逐次增长）。
       * 也就是说：**我们写的 0 会被随后的一次 measure 覆盖成 max**。
       * 所以必须在几个已知的 sh 增长窗口上复查并重写。
       *
       * 三段时机（rAF / 120ms / 320ms）取自 R2 #10 实测的增长点：
       * - rAF：贴合本次提交后的第一次布局；
       * - 120ms：CM6 补渲染视口外行；
       * - 320ms：异步内容（图片/公式/mermaid）撑开后可能再次触发 measure。
       */
      const isRealTa =
        !!realTextarea && typeof (realTextarea as unknown as { value?: unknown }).value === "string";
      const writeZero = () => {
        target.write(0);
      };
      const readTop = () =>
        isRealTa ? (realTextarea as unknown as HTMLTextAreaElement).scrollTop : sourceSurface.getScrollTop();
      /** 读回验证：目标是 0，被覆盖成 > 8px 才重写（避免与亚像素/取整抖动打架） */
      const verifyZero = (label: string) => {
        const now = readTop();
        if (now > 8) {
          writeZero();
          traceScroll("restore-zero-retry", { label, coveredTo: Math.round(now) });
        }
      };
      writeZero();
      traceScroll("restore-zero", {
        why: openTarget.reason,
        percent,
        impl: isRealTa ? "textarea" : "surface",
        h: target.rect()?.clientHeight,
        sh: target.rect()?.scrollHeight,
      });
      requestAnimationFrame(() => verifyZero("raf"));
      window.setTimeout(() => verifyZero("t120"), 120);
      window.setTimeout(() => verifyZero("t320"), 320);
      // 分屏右屏同样回到顶部（iframe 异步写入，交给既有 pending 通道消费）
      if (isSourceMode && previewShown) pendingIframeScrollRef.current = 0;
      // 恢复窗口覆盖上面三次写入（否则 scroll 监听会把中途值当"用户滚动"写进进度）
      const zeroGen = ++scrollRestoreGenRef.current;
      window.setTimeout(() => {
        if (scrollRestoreGenRef.current !== zeroGen) return;
        isRestoringScrollRef.current = false;
        // R5 锁存收尾②：零分支的恢复目标本来就是 0（无进度/不可滚动），
        // 此后 scroll 写入不再有"覆盖已保存值"的风险 → 放行
        startupRestoreCompleteRef.current = true;
        if (viewMode === "preview") cachePmGeometry();
        else cacheSourceGeometry();
      }, SCROLL_RESTORE_GUARD_MS);
      return;
    }

    // v0.12.0 返修（问题5）：进度恢复的"内容未就绪重试"。
    // 启动恢复时图片/公式/mermaid 是异步渲染的，若此刻内容还没撑开，
    // computeRestoreScrollTop 返回 null，旧实现 `newTop ?? 0` 会把刚恢复的
    // 进度当场清成 0（用户反馈"重载的文件阅读进度丢失"）。
    // 现在：percent > 0 且暂不可滚动 → 短间隔重试（最多 ~0.6s），仍不可滚动才落到 0。
    let attempts = 0;
    /**
     * ## ═══ v0.17.0 第二轮（#10 重启后阅读进度回退一截）：percent 也必须在**布局收敛后**再算 ═══
     *
     * ### 实测证据（`scripts/v0170-r2-writehook.mjs`，hook 了 `scrollTop` setter 抓调用栈）
     * ```
     * t=2208  写 2243 → 当时 sh=5254 h=759 max=4495   lines=33   w=517
     * t=2215  写 2376 → 当时 sh=6251 h=759 max=5492   lines=48   w=517
     * 最终     st=2376 / max=5492  → pct=0.4326（期望 0.4990）
     * ```
     * 两次写入**都发生在 sh 还在变的窗口里**：mount 那一刻 CM6 只渲染了 33 行
     * （视口内 + 少量溢出），**视口外的行用估算高度** → `scrollHeight` 5254；
     * 约 100ms 后补渲染到 48 行 → 6251（稳定值 7057，与"滚过一轮"的同源文档一致）。
     *
     * 于是 `newTop = percent × (sh_now - h)` 用的是**偏小的 sh** → 写入的绝对像素偏小
     * → 之后 sh 涨上去，`scrollTop` 不变 → **用户看到的 percent 变小了**（0.499 → 0.433）。
     * 这不是"恢复没生效"，而是**在错误的布局快照上算了正确的百分比**。
     *
     * ### 修法（只动"何时写"，不动重试链结构与 `isRestoringScrollRef` 语义）
     * 把"写一次就收工"改成"**几何收敛后**再写，并做有限次校正"：
     * - 每次写入后隔一帧复查 `scrollHeight`；若已变化 → 用**新 sh** 重算并重写（幂等）；
     * - 最多校正 `SCROLL_GEOM_SETTLE_MAX` 次（约 1s 窗口），收敛即停；
     * - 全部校正结束后才放开 `isRestoringScrollRef`（恢复窗口覆盖最后一次写入，
     *   避免被 scroll 监听当成"用户滚动"写进进度快照）。
     * 这与 `applyScroll` 侧已有的"rAF 二次校正"是同一套思路，只是这里多了"sh 变化即重算"的判据。
     *
     * ⚠️ 为什么不能改成"等 1s 再写一次"：用户会先看到顶部、再看到跳动，比现在更差。
     * 边写边校正则首帧就落在近似位置，后续只是微调，视觉上无感。
     */
    /**
     * ⚠️ TypeScript 收窄：上面 `reason !== "progress"` 分支已经 return，
     * 到这里 `percent` 必然是合法数值。但 TS 无法从 `openTarget.reason` 反推
     * `percent` 的类型（两者是分别计算出来的），所以显式取一次窄化后的值 ——
     * 不要用 `percent!` 非空断言，那会把"将来有人改动决策函数"变成静默崩溃。
     */
    const restorePercent = percent as number;
    const SCROLL_GEOM_SETTLE_MAX = 12;
    /**
     * 重新计算并写入；返回本次使用的 `scrollHeight`（供下一帧比较是否已收敛）。
     * `null` 表示未写入（不可滚动且重试耗尽）。
     */
    const writeOnce = (attempt: number): number | null => {
      const rect = target.rect();
      if (!rect) {
        // 目标容器消失（恢复期间被卸载/重建）→ 本次恢复不可能完成，按收尾放行锁存，
        // 否则 startupRestoreCompleteRef 永不置真 → 「进度永不保存」
        finish();
        return null;
      }
      const newTop = computeRestoreScrollTop(restorePercent, rect.scrollHeight, rect.clientHeight);
      if (newTop === null && restorePercent > 0 && attempt < 8) {
        setTimeout(() => apply(attempt + 1), 80);
        return null;
      }
      target.write(newTop ?? 0);
      return rect.scrollHeight;
    };
    const apply = (attempt: number, settle = 0) => {
      const shUsed = writeOnce(attempt);
      if (shUsed === null) return;
      if (settle >= SCROLL_GEOM_SETTLE_MAX) {
        finish();
        return;
      }
      requestAnimationFrame(() => {
        const rect = target.rect();
        // 布局已收敛（scrollHeight 没变）→ 本次写入即最终值，立即收尾
        if (!rect || rect.scrollHeight === shUsed) {
          finish();
          return;
        }
        // 布局还在长（CM6 补渲染视口外行）→ 用新几何重算重写
        apply(attempt, settle + 1);
      });
    };
    const finish = () => {
      if (isSourceMode && previewShown) {
        // 分屏模式 iframe 异步写入：记录待恢复百分比，iframe 写入 effect 末尾消费
        pendingIframeScrollRef.current = percent;
      }
      isRestoringScrollRef.current = false;
      // R5 锁存收尾①：进度分支恢复完成 → 此后的 scroll 事件属于真实用户滚动，放行写入
      startupRestoreCompleteRef.current = true;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => apply(0)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceUpdateKey]);


  // ─── 模式切换时同步内容 ──────────────────────
  // 核心原则：三个模式操作同一个文件，切换时内容不丢失
  // 滚动百分比已在 scroll 事件中持续追踪，此处直接使用
  //
  // 切换方向逻辑：
    // - 阅读 → 编辑/分屏：从 ProseMirror 同步到 textarea（ProseMirror 是最新的）
    // - 编辑/分屏 → 阅读：从 textarea 同步到 ProseMirror（textarea 是最新的）
    // - 编辑 ↔ 分屏：不需要同步内容（textarea 内容已经是最新的，只恢复滚动位置）
  useEffect(() => {
    const view = viewRef.current;
    const prevMode = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;

    /**
     * v0.15.2 需求1：模式切换滑入动画。
     *
     * 必须在**模式真的变了**时才播（不能因为其它 state 引起 effect 重跑就重播），
     * 且要在 `if (!view) return` 之前挂上 —— 非 md 文件（纯文本阅读面）没有 PM view，
     * 但同样应该看到滑动（`.plaintext-preview` 也接了 keyframes）。
     *
     * 收尾用代际 token：快速连切时旧定时器自觉退场，避免把新一轮动画腰斩。
     */
    if (prevMode !== viewMode) {
      const dir: "to-edit" | "to-preview" =
        prevMode === "preview" ? "to-edit" : "to-preview";
      const gen = ++modeAnimGenRef.current;
      setModeAnim(dir);
      window.setTimeout(() => {
        if (modeAnimGenRef.current !== gen) return;
        setModeAnim(null);
      }, MODE_SLIDE_MS);
    }

    if (!view) return;

    // v0.15.1 需求1：**模式切换前必须先 flush PM 的节流队列**。
    //
    // pmAdapter 把「序列化 + 提交时间线」推迟到防抖窗口末尾（350ms，最长 900ms）。
    // 用户在阅读模式打完字立刻切到编辑模式时，最后那次输入还挂在队列里：
    // - 不 flush → 时间线里少这一步（切过去再撤销撤不到它，用户看到"阅读里打的字
    //   切到编辑就撤不掉了"）；
    // - 更糟：切换本身会整篇重解析 doc，随后 bridge/rebase 事务会**清掉队列**
    //   （pmAdapter 的 addToHistory:false 分支 `hasPending=false`），那一步永久丢失。
    // flush 会同步把 pending 序列化并 commit，必须在任何整篇替换之前执行。
    pmAdapterRef.current.flush();

    // 判断切换方向
    const fromPreview = prevMode === "preview";
    const toPreview = viewMode === "preview";
    const fromSource = prevMode !== "preview";
    const toSource = isSourceMode;

    // 编辑 ↔ 分屏：不需要同步内容，只恢复滚动位置
    // Issue 7：非 md 文件也不走 ProseMirror doc 转换（ProseMirror 为空）
    // 用 shouldSkipProseMirrorSync 统一判断，保证非 md 文件直接保留 sourceContent
    if (shouldSkipProseMirrorSync(isMdFile, fromSource, toSource)) {
      const sourcePercent = fromPreview
        ? pmScrollPercentRef.current
        : textareaScrollPercentRef.current;
      // v0.12.0 返修（问题4/6）：携带"光标所在行 + 行内列偏移"作为编辑位置锚点
      //（滚动位置一律按百分比恢复 → 三模式阅读进度一致）
      let anchorLine: number | null = null;
      let anchorColumn: number | null = null;
      if (fromSource) {
        {
          const cursorPos = sourceSurface.getSelection().start ?? lastTextareaCursorRef.current;
          lastTextareaCursorRef.current = cursorPos;
          anchorLine = lineIndexOfOffset(sourceContentRef.current, cursorPos);
          anchorColumn = cursorPos - (sourceContentRef.current.lastIndexOf("\n", cursorPos - 1) + 1);
        }
      }
      pendingScrollRef.current = {
        targetMode: viewMode,
        percent: sourcePercent,
        anchorLine,
        anchorColumn,
      };
      return;
    }

    // 确定来源模式的滚动百分比
    const sourcePercent = fromPreview
      ? pmScrollPercentRef.current
      : textareaScrollPercentRef.current;

    if (fromPreview && toSource) {
      // ── 阅读 → 编辑/分屏：从 ProseMirror 同步到 textarea ──
      // E12(v0.9.4)：记录进入前 textarea 文本与本次同步文本（供 diff 栈清空判定，见下方）
      const prevSourceText = sourceContentRef.current;
      let syncedSourceText = "";
      try {
        // v0.6.6 问题4：PM 序列化输出含完整 base64 → 显示层 mask 为短标记
        // （data URL 不含换行，mask 不改变行结构，光标行号映射不受影响）
        /**
         * ## ═══ v0.17.0 R4 · T1 接线（两件事，顺序不可颠倒） ═══
         *
         * ### ① `{ normalizeOrderedLists: true }`（T4 的 #6 能力接线）
         * 用户第 6 项：「编辑模式两个 `1.` 切阅读渲染 1./2.，切回编辑仍是两个 `1.`」。
         * 序列化层已有该能力（`core/markdown/serializer.ts`），但它**默认关闭**——
         * 因为改写磁盘文本属于产品口径变更，只在"阅读 → 编辑"这一处显式启用。
         *
         * ⚠️ 必须 `getMarkdownFromDoc` 拿到**归一化后的文本**再 mask。反过来
         *（先 mask 再归一化）会拿到未归一化的原文，两个 `1.` 依旧。
         *
         * ### ② `onContentChangeRef` 上报（**因①而成为必需**，见下）
         *
         * ⚠️ 先说明：**这一行不是 #5 的修复**。本轮探针实测证明 #5 的真因是
         * `SourcePane.applySourceInput` 把 CM6 的纯选区事件当成内容变更回写
         * （详见该函数内 `isContentChange` 的长注释）；本分支的 `setSourceContent`
         * 本来就是对的，App 侧在**打字时**就已经拿到新内容了。
         *
         * 但①引入了"本分支会**改写**文本"的新事实：
         * - `mdMasked`（归一化后）与 App 的 `content`（归一化前）**不再相等**；
         * - 而编辑面 Ctrl+S 取的是 `contentRef.current`（App content）、
         *   自动保存取的是 `sourceContent`… 两个数据源开始分叉；
         * - 不上报 → 磁盘仍是两个 `1.`，#6 只在屏幕上"看起来对了"，**一存盘就回退**。
         *
         * 所以上报是**为了让归一化真正落到 App/标签/磁盘**，与 #5 无关。
         * ⚠️ 上报值与 `setSourceContent` 必须**同一个 `mdMasked`**，不能重新序列化一次
         * （重算会绕开归一化，或得到与展示层不一致的文本）。
         */
        const { text: mdMasked } = maskBase64Images(
          getMarkdownFromDoc(view.state.doc, { normalizeOrderedLists: true }),
          base64TokensRef.current,
        );
        syncedSourceText = mdMasked;
        setSourceContent(mdMasked);
        sourceContentRef.current = mdMasked;
        onContentChangeRef.current?.(mdMasked);

        // 映射光标位置
        const { from } = view.state.selection;
        const textBefore = view.state.doc.textBetween(0, from, "\n", "\n");
        const lineIndex = lineIndexOfOffset(textBefore, textBefore.length);
        // v0.12.0 返修（问题6）：行内列偏移——PM doc 文本不含 markdown 语法字符，
        // 切到编辑模式后按"行首 + 列偏移"落光标（clamp 到源码行长度），
        // 修复"阅读到 abc 后切换模式，输入光标却回到行首"
        const anchorColumn = textBefore.length - (textBefore.lastIndexOf("\n") + 1);

        /**
         * ## ═══ v0.17.0 第三轮（#6 编辑符号位置记忆）：阅读 → 编辑 的**精确**落点 ═══
         *
         * 上面那套「PM 文本第 N 个换行 = 源码第 N 行 + 同列偏移」是 v0.12.0 的近似口径，
         * 它的假设（PM 块内换行数 == 源码行数）**实测不成立**：
         * 列表/表格/引用在 PM 里是**一个块**、块内 `textContent` 没有换行，
         * 而源码那边是 N 行 → 行计数系统性偏小 → 落进别的块
         *（实测：源码 L12 代码块 → PM `table_header`；源码 L19 H2 → `table_cell`）。
         *
         * 现在优先走**权威块 + 逐字符对齐**（`utils/caretMap`）：
         * 用 `blockSourceMap` 的源码行区间定位块，再把块内"可见字符序号"换算成源码 offset。
         * 拿不到（有图块对齐不可信 / 新敲出来的块无区间）才回退旧口径 —— **不猜**。
         */
        let preciseCursor: number | null = null;
        try {
          const probe = (nd: unknown) =>
            getBlockSource(nd as Parameters<typeof getBlockSource>[0]);
          /**
           * ## ═══ v0.17.0 R5（V2-4 跨模式光标记忆真机完全失效）：必须用**原始文本
           * 坐标**映射，不能拿旧 `blockSource` 行区间切序列化后的新文本 ═══
           *
           * ### 缺陷（真机实测 `scripts/v0170-r5-edit.mjs` V2-4）
           * 加粗/列表/代码块三用例往返后光标全部落回文档前部（31/32/33，"根本没记住"）。
           * 根因是**混坐标**：旧实现 `collectPmBlockCaretInfo(mdMasked, ...)` 拿
           * `blockSource` 的**解析期行区间**去切 `mdMasked`（序列化后的新文本）。
           * 两者只在"序列化逐字节还原原文"时才对齐，而实测中至少两种分歧会破坏它：
           * - 序列化往返 quirk（块前后补空行 +3、硬换行补 `"  "` +400）；
           * - `normalizeOrderedLists` 改写有序列表标记长度（T4 #6 接线引入）。
           * 错位后旧行区间切出**别的块的内容** → `alignBlockText` 的
           * `unmatchedVisible` 哨兵拒绝 → 映射返回 null → 回退到 v0.12.0 的
           * "PM 块序 ≈ 源码行"近似 → 落到文档前部（实测 31/32/33）。
           *
           * ### 修法（坐标一致性优先，两步）
           * ① 用 `prevSourceText`（= 本文档解析时的 masked 源码）+ 原始 `blockSource`
           *    做映射 —— 两侧**天然同坐标**（解析器记录的行区间就是原文行号），
           *    结果是「原文中的精确 offset」；
           * ② 再经 `remapOffsetAcrossLineEdits` 把该 offset 从原文重映射到
           *    `mdMasked` —— 归一化/补空行只改行内容或插删行，行内容未变的行
           *    **恒等映射**（Lead 口径「非列表块偏移不变，直接使用」）。
           * ③ 二次兜底：块被 PM 编辑过时（旧源码与可见文本对不上，①会拒绝），
           *    沿用旧口径「切 mdMasked」（编辑未改行结构时它反而准）—— 保证
           *    「阅读面打字后切回」的既有行为不回退。
           */
          const origBlocks = collectPmBlockCaretInfo(prevSourceText, view.state.doc, probe);
          const origCursor = pmPosToSourceOffset(origBlocks, prevSourceText, from);
          if (origCursor !== null) {
            preciseCursor = remapOffsetAcrossLineEdits(prevSourceText, mdMasked, origCursor);
          } else {
            const caretBlocks = collectPmBlockCaretInfo(mdMasked, view.state.doc, probe);
            preciseCursor = pmPosToSourceOffset(caretBlocks, mdMasked, from);
          }
        } catch (e) {
          // 映射失败不阻断切模式（光标位置是体验项，内容同步才是硬要求）
          traceScroll("caret-map-fail", { dir: "reader-to-source", err: String(e).slice(0, 80) });
        }
        traceScroll("caret-map", {
          dir: "reader-to-source",
          pmFrom: from,
          precise: preciseCursor,
          approxLine: lineIndex,
          approxCol: anchorColumn,
        });

        // v0.12.0 返修（问题4/6）：只携带"光标行号 + 行内列偏移"作为编辑位置锚点；
        // 滚动位置由 applyScroll 按百分比恢复（三模式阅读进度一致）
        pendingScrollRef.current = {
          targetMode: viewMode,
          percent: sourcePercent,
          anchorLine: lineIndex,
          anchorColumn,
          // v0.15.0 需求（阅读↔编辑内容对齐）：附上内容锚点。
          // ⚠️ 此 effect 是"切换之后"跑的，来源（阅读面）此时可能已被 `setViewMode`
          // 卸载 → 只能采到空。因此真正的采集发生在 useLayoutEffect（见下方
          // `modeSwitchAnchorRef`），这里只负责把已采到的锚点带进恢复计划。
          contentAnchor: modeSwitchAnchorRef.current,
        };
        /**
         * #6：精确源码 offset 用**本 hook 内的局部 ref** 传递，不改 `pendingScrollRef`
         * 的共享类型 —— 那个类型定义在 `historyhost/types.ts`（三个文件同步），
         * 而 `HistoryHost.tsx` 不在本轮 T5 的写域里。局部 ref 语义等价：
         * 写入点（本 effect）与读取点（下方 `applyScroll`）在同一次同步切换流程内，
         * 中间没有 await/跨文档边界。
         */
        pendingPreciseCursorRef.current = preciseCursor;
        modeSwitchAnchorRef.current = null;

        requestAnimationFrame(() => {
          // TODO(v0.18): CM6 能力缺口 — 模式切换的选区恢复需真实元素。当前 CM6 表现：切换后的光标位置退化为按锚点行估算（不精确，不丢内容） | 用户可感知度：中 | 建议优先级：P1
          const textarea = sourceTextareaRef.current;
          if (textarea) {
            let pos: number;
            if (preciseCursor !== null) {
              // 精确路径：权威块 + 逐字符对齐算出的源码 offset（已按块边界钳制过）
              pos = Math.max(0, Math.min(mdMasked.length, preciseCursor));
            } else {
              // 回退路径（旧口径，逐字节保留）：行号 + 列偏移
              const lines = mdMasked.split("\n");
              let acc = 0;
              for (let i = 0; i < Math.min(lineIndex, lines.length - 1); i++) {
                acc += lines[i].length + 1;
              }
              // v0.12.0 返修（问题6）：加行内列偏移（clamp 到源码行长度，防语法字符差异越界）
              const lineLen = lines.length > lineIndex ? lines[lineIndex].length : 0;
              pos = acc + Math.min(anchorColumn, lineLen);
            }
            // A2 收敛：纯值语义（选区恢复）→ 经 surface，CM6 下同样成立
            sourceSurface.focus();
            sourceSurface.setSelection(pos, pos);
          }
        });
      } catch {
        const { text: fallbackMasked } = maskBase64Images(content, base64TokensRef.current);
        syncedSourceText = fallbackMasked;
        setSourceContent(fallbackMasked);
        sourceContentRef.current = fallbackMasked;
        // 解析失败时无可用光标行号 → 无锚点，回退滚动百分比
        pendingScrollRef.current = {
          targetMode: viewMode,
          percent: sourcePercent,
          anchorLine: null,
          anchorColumn: null,
        };
      }

      // E12(v0.9.4)：不再无条件清空 diff 栈。
      // 仅当本次同步文本与进入前 textarea 文本不一致（PM 侧有变更 → 旧栈基线失效）时才清空；
      // 内容一致（如"切一圈不改"）保留栈，避免撤销历史被白白丢弃。
      if (shouldResetSourceUndoStack(prevSourceText, syncedSourceText)) {
        undoStackRef.current = [];
        redoStackRef.current = [];
      }
    } else if (fromSource && toPreview) {
      // ── 编辑/分屏 → 阅读：从 textarea 同步到 ProseMirror ──
      if (sourceContent) {
        try {
          // v0.6.6 问题4：textarea 显示层是短标记 → 还原完整 base64 后再解析 PM doc
          const unmaskedSource = unmaskBase64Images(sourceContent, base64TokensRef.current);
          // E12(v0.9.4)：内容与 PM 完全一致时跳过整树替换——replaceWith 会写入一条
          // PM history，"切一圈不改"也会占用一次撤销。改为仅移动光标（选区事务不入历史）。
          const contentChanged = shouldReplacePmDoc(unmaskedSource, getMarkdownFromDoc(view.state.doc));
          const newDoc = contentChanged ? markdownToDoc(unmaskedSource) : view.state.doc;

          // 映射光标位置
          let targetPos = 1;
          const srcSel = sourceSurface.getSelection();
          const cursorPos = srcSel.start ?? lastTextareaCursorRef.current;
          if (srcSel.start > 0) {
            lastTextareaCursorRef.current = srcSel.start;
          }
          const lineIndex = lineIndexOfOffset(sourceContent, cursorPos);

          /**
           * ## ═══ v0.17.0 第三轮（#6 编辑符号位置记忆）：编辑 → 阅读 的**精确**落点 ═══
           *
           * ### 旧实现（下面是保留的回退路径）的假设错在哪
           * 按「累计 `node.textContent.split("\n").length`」找目标块，前提是
           * "PM 块内换行数 == 源码行数"。实测（`scripts/v0170-r3-blocks.mjs`，9 块夹具）：
           *
           * | 源码 | 真实行数 | 块内 textContent 换行数 |
           * |---|---|---|
           * | `- K04 p1` / `- p2` | 2 | **0**（`bullet_list` 一个块） |
           * | 表格 3 行 | 3 | **0**（`table` 一个块） |
           * | `> K05 引用` | 1 | 0 |
           *
           * → 行计数**系统性偏小** → 目标块越找越靠后。实测落错块：
           * 源码 L12（代码块正文）→ PM `table_header`；源码 L19（H2）→ `table_cell`。
           * 这不是"误差几字符"，是**落进别的块**。
           *
           * ### 新路径
           * 用 `utils/caretMap` 的 `sourceOffsetToPmPos`：
           * - 块级：`blockSourceMap` 的**权威源码行区间**（parser 解析期记录，DOM 上即 `data-src-line`）；
           * - 块内：源码原文 ↔ 可见文本的**逐字符对齐**（语法符 = 源码有、可见没有的字符）。
           *
           * ### 口径（Lead 已裁定）
           * 「同一字符」= **同一可见字符**。光标停在 `**` 这类语法符上时，落到它修饰内容的
           * 第一个可见字符 —— 因为语法符在阅读面**没有字形**，用户看的是屏幕可见位置。
           *
           * ### 失败即回退，不猜
           * 有 base64 图片的块（源码侧是 `image-1.png`、PM 侧是未 mask 的长 base64）、
           * 或新敲出来还没有源码区间的块 → 对齐不可信 → `null` → 走下面的旧行计数路径。
           */
          let precisePmPos: number | null = null;
          try {
            const caretBlocks = collectPmBlockCaretInfo(
              sourceContent,
              newDoc,
              (nd: unknown) => getBlockSource(nd as Parameters<typeof getBlockSource>[0]),
            );
            precisePmPos = sourceOffsetToPmPos(caretBlocks, sourceContent, cursorPos);
          } catch (e) {
            traceScroll("caret-map-fail", { dir: "source-to-reader", err: String(e).slice(0, 80) });
          }
          traceScroll("caret-map", {
            dir: "source-to-reader",
            srcOffset: cursorPos,
            precise: precisePmPos,
            approxLine: lineIndex,
          });

          if (precisePmPos === null) {
            // ── 回退路径（旧口径，逐字节保留）：累计行数找块 ──
            let currentLine = 0;
            let found = false;
            newDoc.descendants((node, pos) => {
              if (found) return false;
              if (node.isBlock && node.type.name !== "doc") {
                if (currentLine === lineIndex) { targetPos = pos + 1; found = true; return false; }
                const nodeLines = (node.textContent || "").split("\n").length;
                if (currentLine + nodeLines > lineIndex) { targetPos = pos + 1; found = true; return false; }
                currentLine += nodeLines;
              }
              return true;
            });
          }

          // E12(v0.9.4)：仅内容变化时才做整树替换，避免无意义的 PM history 记录
          const tr = contentChanged
            ? view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content)
            : view.state.tr;
          /**
           * #6：选区落点。精确映射可用就用它（已按块边界与可见文本长度钳制过，
           * 但仍走 `TextSelection.near` 兜底：PM 的 pos 可能正落在节点边界，
           * `near` 会把它吸附到最近的合法文本位置 —— 这比 `resolve` 直接抛错安全）。
           * `tr.doc` 与 `newDoc` 在 `contentChanged` 时是同一份内容，
           * 所以来自 `newDoc` 的 pos 对 `tr.doc` 同样有效。
           */
          const wantPos = precisePmPos !== null ? precisePmPos : targetPos;
          const safePos = Math.min(wantPos, tr.doc.content.size - 1);
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(1, safePos))));
          tr.setMeta("fileSwitch", true);
          // v0.13.1 需求8：这是**同一个文件内**的模式切换整篇重解析，不是换文档。
          // 因此只排除本事务自身进历史（"切模式"不该是一个可撤销的内容编辑步骤），
          // 但**不清空**历史栈（清了会让"切个模式就丢掉全部撤销记录"）。
          tr.setMeta("addToHistory", false);
          view.dispatch(tr);

          // v0.12.0 返修（问题4）：锚点 = 切换瞬间 textarea 光标所在行（行号），
          // 滚动位置由 applyScroll 按百分比恢复 → 三模式阅读进度一致
          pendingScrollRef.current = {
            targetMode: viewMode,
            percent: sourcePercent,
            anchorLine: lineIndex,
            anchorColumn: null,
            // v0.15.1 需求3：编辑→阅读方向也带内容锚点（在 useLayoutEffect 里采的）。
            // 旧实现这里没有 anchor，只能按百分比恢复 —— 与阅读→编辑方向不对称，
            // 反复双击 Ctrl 时误差单向累积，视口越切越偏。
            contentAnchor: modeSwitchAnchorRef.current,
          };
          modeSwitchAnchorRef.current = null;

          onContentChangeRef.current?.(sourceContent);
          lastContentRef.current = sourceContent;
        } catch (e) {
          console.error("同步源码内容到阅读模式失败:", e);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  // v0.15.0 需求（图片灯箱）：切模式时关闭灯箱（阅读↔编辑两侧的采集 root 会变）

  // ─── 延迟恢复滚动位置 ──────────────────────────
  // 等内容渲染完成后再恢复滚动，使用 sourceContent 和 viewMode 作为触发
  // 双重 rAF 确保浏览器完成布局计算
  useEffect(() => {
    if (!pendingScrollRef.current) return;
    const { targetMode, percent, anchorLine, anchorColumn, contentAnchor } = pendingScrollRef.current;
    pendingScrollRef.current = null;
    // ⚠️ #6：这里**不能**提前清 `pendingPreciseCursorRef` ——
    // 它在「阅读→编辑」方向的 `targetMode !== "preview"` 分支里消费。
    // 若这一轮是「编辑→阅读」（无 pendingScroll 或 targetMode 为 preview），
    // 那个 ref 会是上一轮的陈旧值；但消费点只在 `else`（源码面）分支且
    // 该分支只在「阅读→编辑」时进入，跨方向不会串用。留作显式说明。
    // 标记正在恢复滚动位置，阻止打字机 effect 的初始 scrollToCenter 覆盖
    // 根因：打字机 effect 的 scrollToCenter 使用 smooth 滚动，是异步多帧的，
    // 会在 applyScroll（instant 设置）之后继续滚动，覆盖滚动位置
    isRestoringScrollRef.current = true;

    const applyScroll = () => {
      if (targetMode === "preview") {
        // 问题4修复：滚动容器从 .ProseMirror 改为 .editor-container
        const container = editorRef.current;
        if (container) {
          viewRef.current?.focus();
          // v0.15.1 需求3：**优先用内容锚点**（编辑→阅读方向）。
          //
          // v0.12.0 的口径是"滚动位置一律按百分比恢复"，理由是源码行号→PM 块的映射
          // 在含代码块/表格/列表的文档里不等价。那一点仍然成立 —— 但那是拿**行号**去
          // 映射块的旧做法。现在用的是 `contentScrollMap` 的**块几何锚点**（实测按行轴
          // 反推的块 top/height + 视口中央比例），跨排版等价性已由 52 条纯函数用例覆盖。
          //
          // 而百分比在阅读↔编辑两种排版间**不等价**（正文列宽/行高/块距不同 → 软换行数
          // 不同 → 同一百分比指向不同内容）。只用百分比就会让「双击 Ctrl 反复切换」
          // 每轮累积一点偏移（用户实测的"屏幕不断滚动位置偏移"）。
          // 因此：有锚点走锚点，锚点不可用（采不到/映射失败）才退回百分比。
          let newTop: number | null = null;
          if (contentAnchor) {
            const blocks = collectPmBlockGeometry(container);
            if (blocks) {
              newTop = restoreContentAnchor(blocks, contentAnchor, container.clientHeight, {
                contentHeight: container.scrollHeight,
              });
            }
          }
          if (newTop === null) {
            newTop = computeRestoreScrollTop(percent, container.scrollHeight, container.clientHeight);
          }
          const prevTop = container.scrollTop;
          container.scrollTop = newTop ?? 0;
          traceScroll("res-reader", {
            before: prevTop,
            after: container.scrollTop,
            want: newTop,
            pct: percent,
            anchorIdx: contentAnchor?.blockIndex,
            anchorRatio: contentAnchor?.ratioWithinBlock,
            anchorSrcLine: contentAnchor?.sourceLine,
            anchorAtTop: contentAnchor?.atTop,
            anchorAtBottom: contentAnchor?.atBottom,
            h: container.clientHeight,
            sh: container.scrollHeight,
          });
          // PM 焦点/选区映射可能让浏览器把光标滚入视口 → 下一帧再校正一次
          if (newTop !== null) {
            requestAnimationFrame(() => {
              const c = editorRef.current;
              if (!c) return;
              // 有锚点时下一帧仍以锚点为准（内容可能刚布局完，scrollHeight 还在变）
              if (contentAnchor) {
                const b2 = collectPmBlockGeometry(c);
                if (b2) {
                  const again = restoreContentAnchor(b2, contentAnchor, c.clientHeight, {
                    contentHeight: c.scrollHeight,
                  });
                  if (again !== null) {
                    c.scrollTop = again;
                    traceScroll("res-reader-raf", { after: c.scrollTop, want: again });
                    return;
                  }
                }
              }
              c.scrollTop = newTop as number;
              traceScroll("res-reader-raf", { after: c.scrollTop, want: newTop, pct: true });
            });
          }
        }
        // 清理 iframe 待恢复标记，避免残留值影响后续切换
        pendingIframeScrollRef.current = null;
      } else {
        // TODO(v0.18): CM6 能力缺口 — 模式切换的滚动重试链需真实元素（`restoreScrollWithRetry`）。当前 CM6 表现：滚动恢复退化为一次性写入，长文切换后位置可能不精确 | 用户可感知度：中 | 建议优先级：P1
        const textarea = sourceTextareaRef.current;
        if (textarea) {
          // ① 光标位置：**优先用精确映射**（#6），拿不到才回退旧口径
          //
          // 旧口径（v0.12.0）：行号 + 行内列偏移，clamp 到源码行长度。
          // 它的假设「PM 块内换行数 == 源码行数」实测不成立（列表/表格/引用块内无换行），
          // 于是行计数偏小 → 光标落进**别的块**。
          //
          // 新口径（v0.17.0 第三轮 #6）：`viewMode` effect 里已经用权威块表 +
          // 逐字符对齐算出**精确源码 offset**，存在 `pendingPreciseCursorRef`。
          // 这里只负责消费它；null 表示映射不可靠（有图块对齐失败等）→ 回退。
          const precise = pendingPreciseCursorRef.current;
          pendingPreciseCursorRef.current = null;
          if (precise !== null) {
            const pos = Math.max(0, Math.min(sourceContentRef.current.length, precise));
            traceScroll("res-source-caret", { impl: "precise", pos });
            sourceSurface.focus();
            sourceSurface.setSelection(pos, pos);
            lastTextareaCursorRef.current = pos;
          } else if (anchorLine != null) {
            traceScroll("res-source-caret", { impl: "approx", line: anchorLine, col: anchorColumn });
            let pos = sourceLineToPos(sourceContentRef.current, anchorLine);
            if (anchorColumn != null && anchorColumn > 0) {
              const text = sourceContentRef.current;
              const nl = text.indexOf("\n", pos);
              const lineLen = (nl === -1 ? text.length : nl) - pos;
              pos += Math.min(anchorColumn, lineLen);
            }
            // A2 收敛：纯值语义（选区恢复）→ 经 surface，CM6 下同样成立
            sourceSurface.focus();
            sourceSurface.setSelection(pos, pos);
            lastTextareaCursorRef.current = pos;
          }
          // ② 滚动位置恢复。
          //
          // v0.15.0 需求（阅读↔编辑内容对齐）：**优先用内容锚点**（阅读→编辑方向）。
          // 百分比在两种排版下不等价（正文宽度/行高/段距不同 → 长段落软换行数不同，
          // 同一百分比指向不同内容）；锚点记的是"视口中央是哪个块 + 块内比例"，
          // 与排版无关。只有锚点不可用时才退回百分比。
          //
          // v0.14.0 需求2（P1 根因修复）：此处**不能**再写 `newTop ?? 0`。
          // 实测双 rAF 在 ~44ms 执行，此时 textarea 的 scrollHeight-clientHeight=0
          // （内容尚未写入/尚未布局）→ newTop=null → 旧代码写成 0 且不重试，
          // 左栏停顶部；splitScrollSync 随即把 0 推给右屏 iframe → 两屏都掉到 0。
          // 现在改为：可滚动才写；不可滚动且期望非顶部 → 短间隔重试（见
          // planScrollRestore / SCROLL_RESTORE_RETRY_MS 的注释）。
          const anchorTop = textareaTopFromContentAnchor(textarea, contentAnchor);
          /**
           * v0.17.0 P1-4：写入必须经 `SourceSurface`。
           *
           * CM6 下 `textarea` 是**不滚动的宿主 div**（`scrollHeight === clientHeight`），
           * `textarea.scrollTop = x` 写上去既不改真实滚动位置、也不派发 scroll 事件 →
           * 「阅读→编辑」方向的位置跟随**整条链静默失效**（实机：阅读 88% 切回编辑
           * 仍停在 50%，零报错）。真 textarea 走原路（行为一字未变）。
           */
          const isRealTextarea =
            !!textarea && typeof (textarea as unknown as { value?: unknown }).value === "string";
          const writeSourceTop = (top: number) => {
            if (isRealTextarea) (textarea as unknown as HTMLTextAreaElement).scrollTop = top;
            else sourceSurface.setScrollTop(top);
          };
          const readSourceTop = () =>
            isRealTextarea
              ? (textarea as unknown as HTMLTextAreaElement).scrollTop
              : sourceSurface.getScrollTop();
          traceScroll("res-source", {
            before: readSourceTop(),
            want: anchorTop,
            pct: percent,
            anchorIdx: contentAnchor?.blockIndex,
            anchorRatio: contentAnchor?.ratioWithinBlock,
            anchorSrcLine: contentAnchor?.sourceLine,
            anchorAtTop: contentAnchor?.atTop,
            anchorAtBottom: contentAnchor?.atBottom,
            h: isRealTextarea ? (textarea as unknown as HTMLTextAreaElement).clientHeight : sourceSurface.getMetrics().clientHeight,
            sh: isRealTextarea ? (textarea as unknown as HTMLTextAreaElement).scrollHeight : sourceSurface.getMetrics().scrollHeight,
          });
          if (anchorTop !== null) {
            writeSourceTop(anchorTop);
            traceScroll("res-source-after", { after: readSourceTop(), want: anchorTop });
            // 布局稳定后校正一次（内容可能刚写入，scrollHeight 还在变）
            requestAnimationFrame(() => {
              const t2 = sourceTextareaRef.current;
              if (!t2) return;
              const again = textareaTopFromContentAnchor(t2 as unknown as HTMLTextAreaElement, contentAnchor);
              if (again !== null) writeSourceTop(again);
            });
          } else {
            const metricsNow = isRealTextarea
              ? { scrollHeight: (textarea as unknown as HTMLTextAreaElement).scrollHeight, clientHeight: (textarea as unknown as HTMLTextAreaElement).clientHeight, scrollTop: (textarea as unknown as HTMLTextAreaElement).scrollTop }
              : sourceSurface.getMetrics();
            /**
             * v0.17.0 R5（V2 百分比兜底写临时对象）：**必须带写入器**。
             * 旧实现把 `setScrollTop` 塞进临时对象再 `as never`，但
             * `restoreScrollWithRetry` 只会 `target.scrollTop = plan.top` ——
             * CM6 下写入落在临时对象/中性宿主 div 上，真实滚动一动不动（整条兜底静默失效）。
             * 现在 `setScrollTop` 是 `ScrollRestoreTarget` 的可选写入器（见其注释），
             * 重试链一律经 `writeSourceTop` 落到真实滚动容器。
             */
            restoreScrollWithRetry(
              { ...metricsNow, scrollTop: 0, setScrollTop: writeSourceTop },
              percent,
              0,
              () => isRestoringScrollRef.current,
            );
          }
          // focus/setSelectionRange 可能触发浏览器把光标滚入视口 → 下一帧校正
          // v0.17.0 R5：几何与写入都必须按实现分派 —— CM6 下 `textarea` 是中性宿主 div
          //（scrollHeight === clientHeight），旧口径读它恒得 null（整块校正被跳过）、
          // 写 `t2.scrollTop` 空转。真 textarea 路径逐字节不变。
          const readTopMetrics = () =>
            isRealTextarea
              ? {
                  scrollHeight: (textarea as unknown as HTMLTextAreaElement).scrollHeight,
                  clientHeight: (textarea as unknown as HTMLTextAreaElement).clientHeight,
                }
              : sourceSurface.getMetrics();
          const guardMetrics = readTopMetrics();
          if (computeRestoreScrollTop(percent, guardMetrics.scrollHeight, guardMetrics.clientHeight) !== null) {
            requestAnimationFrame(() => {
              // TODO(v0.18): CM6 能力缺口 — 块几何需 `coordsAtPos`/`getMetrics` 语义。当前 CM6 表现：模式切换时的源码块几何不可得 → 该方向退回百分比映射（偏约 4 倍量级） | 用户可感知度：中 | 建议优先级：P1
              const t2 = sourceTextareaRef.current;
              if (!t2) return;
              // 有锚点时以锚点为准，不要让百分比校正把它覆盖回错误位置
              if (contentAnchor) {
                const again = textareaTopFromContentAnchor(t2, contentAnchor);
                if (again !== null) writeSourceTop(again);
                return;
              }
              const m2 = readTopMetrics();
              const top2 = computeRestoreScrollTop(percent, m2.scrollHeight, m2.clientHeight);
              if (top2 !== null) writeSourceTop(top2);
            });
          }
        }
        // 修复：分屏模式下同步恢复 iframe 滚动位置
        // 根因：原代码只恢复 textarea，iframe 滚动位置丢失，需鼠标滚动一下才同步
        // iframe 内容在另一个 useEffect 中异步写入，此时可能尚未写入或 scrollHeight 不准确，
        // 因此先记录待恢复百分比，由 iframe 写入完成后再设置
        // v0.14.0 需求1：右侧预览面板是否显示（旧 split）
        //
        // v0.14.0 需求2（P1）：**不能只依赖 iframe 内容写入 effect 来消费 pending**
        // ——那个 effect 的依赖是 previewHtml，阅读→编辑切换时 previewHtml 可能
        // 根本没变（右屏内容早就渲染好了，只是外壳宽度从 0 变正），effect 不会重跑，
        // pending 就永远没人消费。故这里也走"重试直到 iframe 可滚动"的兜底，
        // 与内容写入 effect 末尾的消费互为双保险（先成功者清 pending）。
        if (targetMode === "edit" && useEditorStore.getState().splitPreviewOpen) {
          // v0.8.0 修复3 TODO：split 模式左（源码）右（iframe 预览）锚点定位待实现，
          // 暂沿用滚动百分比恢复，后续接入双栏锚点映射
          pendingIframeScrollRef.current = percent;
          restorePendingIframeScroll();
        }
      }
      // v0.15.1 需求3（二次修复）：**恢复窗口要覆盖全部校正写入**，不能在这里立刻放开。
      //
      // 旧实现到这里就 `isRestoringScrollRef.current = false`，但恢复动作不止一次：
      // 上面还有 rAF 校正、`textareaTopFromContentAnchor` 的二次校正、以及
      // `restoreScrollWithRetry` 的 60ms×N 重试。这些**后续写入**发生时标志已经是 false
      // → scroll 监听把它们当成"用户滚动"→ `cacheSourceGeometry()` /
      // `cachePmGeometry()` 把**校正后的像素**当成新基准缓存下来。
      // 下一轮切换以这个（已被上轮校正偏过的）基准重算 → 每轮叠加一点点 → 用户看到的
      // 「先编辑面细微偏移，然后阅读面跟着偏」。
      //
      // 修法：给恢复动作留一个**短保护窗**（覆盖 60/160ms 校正链），窗口内不写几何缓存、
      // 不写阅读进度；窗口结束由最后一次校正的写入成为新基准。
      const restoreGeneration = ++scrollRestoreGenRef.current;
      window.setTimeout(() => {
        // 期间又发生过切换（新一代）→ 由新一代负责收尾，本次不再动标志
        if (scrollRestoreGenRef.current !== restoreGeneration) return;
        isRestoringScrollRef.current = false;
        // 窗口结束后**主动**采一次几何：此时布局已稳定，采到的是"最终真值"，
        // 而不是中途某次校正的中间值。
        if (viewMode === "preview") cachePmGeometry();
        else cacheSourceGeometry();
      }, SCROLL_RESTORE_GUARD_MS);
    };

    // 双重 rAF：第一帧等 React 渲染完成，第二帧等浏览器布局完成
    requestAnimationFrame(() => {
      requestAnimationFrame(applyScroll);
    });
  }, [sourceContent, viewMode]);

  return {
    typewriterModeRef,
    scrollToCenterRef,
    activeIsReadonly
  };
}
