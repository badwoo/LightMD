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
        // v0.12.0 需求1 返修：语法辅助栏插入同样走格式 ghost 通道——
        // 带 ghost 文案的项（粗体/标题/列表等）显示灰色占位提示且不落盘；
        // 所有项（含代码块模板）都记录插入区间，未编辑时退格可整段删除（与格式栏一致）
        if (!selected) {
          // v0.12.0 返修（问题1）：语法辅助栏的粗体/斜体等同样"占位落在格式符中间"
          const gt = computeGhostTail(newContent, cursorPos, finalSyntax.slice(cursorPos - start));
          formatGhostRef.current = {
            text: opts?.ghost ?? "",
            pos: cursorPos,
            start,
            end: start + finalSyntax.length,
            content: newContent,
            tail: gt.maskTail ? gt.tail : "",
            maskTail: gt.maskTail,
          };
          sourceGhostHandlersRef.current.invalidate();
          requestAnimationFrame(() => formatGhostHandlersRef.current.render());
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


  // ─── 初始化编辑器（只执行一次）──────────────────
  useEffect(() => {
    const parent = editorRef.current;
    if (!parent) return;
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
        if (!isRestoringScrollRef.current) {
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
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    let raf = 0;
    /** 滚动/尺寸变化后用 rAF 合并采样（滚动事件每帧可多次触发，测量不便宜） */
    const scheduleCache = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // v0.15.1 需求3（二次修复）：**在可见期间**缓存源码面块几何。
        // 切换瞬间 textarea 已 display:none、clientWidth/Height 全 0 → 现量必得 null
        // → 「编辑→阅读」方向会静默退回百分比（这正是漂移没根治的原因）。
        if (!isRestoringScrollRef.current) cacheSourceGeometry();
      });
    };
    const handler = () => {
      const percent = computeScrollPercent(textarea.scrollHeight, textarea.clientHeight, textarea.scrollTop);
      // v0.15.1 需求1：记录"编辑前"的滚动位置，供撤销恢复现场用
      //（onChange 里读到的已是新布局，跨行编辑时 scrollTop 可能已被浏览器调整）
      lastSourceScrollTopRef.current = textarea.scrollTop;
      if (percent !== null) {
        textareaScrollPercentRef.current = percent;
        // v0.12.0 返修（问题5）：恢复期间不写进度（同上）
        if (!isRestoringScrollRef.current) {
          // v0.7.0 bug修复：按文件记录浏览进度（同上）
          fileScrollProgress.set(progressKeyRef.current, percent);
        }
      }
      scheduleCache();
    };
    // v0.8.3 WP5：passive 监听（滚动路径上无需 preventDefault）——浏览器无需等待
    // JS 返回即可提交合成帧，滚动同步更稳。
    textarea.addEventListener("scroll", handler, { passive: true });
    return () => {
      textarea.removeEventListener("scroll", handler);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [cacheSourceGeometry]); // textarea 始终在 DOM 中，只需绑定一次


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
       */
      setSourceContent(content);
      sourceContentRef.current = content;
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
    // v0.8.3 WP4 需求6：进度键从"文件路径"改为"tab 键"（临时文本 = untitled:<id>），
    // 这样跨会话恢复的临时标签也能记住阅读位置。
    const percent = fileScrollProgress.get(progressKeyRef.current);
    if (percent === null) return;
    // 标记恢复中，防打字机 effect 的 smooth 滚动覆盖（与 applyScroll 相同策略）；
    // v0.12.0 返修（问题5）：恢复完成前 scroll 处理器不写进度，避免中途瞬时 0 覆盖快照
    isRestoringScrollRef.current = true;

    // v0.12.0 返修（问题5）：进度恢复的"内容未就绪重试"。
    // 启动恢复时图片/公式/mermaid 是异步渲染的，若此刻内容还没撑开，
    // computeRestoreScrollTop 返回 null，旧实现 `newTop ?? 0` 会把刚恢复的
    // 进度当场清成 0（用户反馈"重载的文件阅读进度丢失"）。
    // 现在：percent > 0 且暂不可滚动 → 短间隔重试（最多 ~0.6s），仍不可滚动才落到 0。
    let attempts = 0;
    const apply = () => {
      attempts++;
      const el = isSourceMode
        ? sourceTextareaRef.current
        : editorRef.current;
      if (!el) {
        isRestoringScrollRef.current = false;
        return;
      }
      const newTop = computeRestoreScrollTop(percent, el.scrollHeight, el.clientHeight);
      if (newTop === null && percent > 0 && attempts < 8) {
        setTimeout(apply, 80);
        return;
      }
      el.scrollTop = newTop ?? 0;
      if (isSourceMode && previewShown) {
        // 分屏模式 iframe 异步写入：记录待恢复百分比，iframe 写入 effect 末尾消费
        pendingIframeScrollRef.current = percent;
      }
      isRestoringScrollRef.current = false;
    };
    requestAnimationFrame(() => requestAnimationFrame(apply));
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
        const { text: mdMasked } = maskBase64Images(getMarkdownFromDoc(view.state.doc), base64TokensRef.current);
        syncedSourceText = mdMasked;
        setSourceContent(mdMasked);
        sourceContentRef.current = mdMasked;

        // 映射光标位置
        const { from } = view.state.selection;
        const textBefore = view.state.doc.textBetween(0, from, "\n", "\n");
        const lineIndex = lineIndexOfOffset(textBefore, textBefore.length);
        // v0.12.0 返修（问题6）：行内列偏移——PM doc 文本不含 markdown 语法字符，
        // 切到编辑模式后按"行首 + 列偏移"落光标（clamp 到源码行长度），
        // 修复"阅读到 abc 后切换模式，输入光标却回到行首"
        const anchorColumn = textBefore.length - (textBefore.lastIndexOf("\n") + 1);

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
        modeSwitchAnchorRef.current = null;

        requestAnimationFrame(() => {
          // TODO(v0.18): CM6 能力缺口 — 模式切换的选区恢复需真实元素。当前 CM6 表现：切换后的光标位置退化为按锚点行估算（不精确，不丢内容） | 用户可感知度：中 | 建议优先级：P1
          const textarea = sourceTextareaRef.current;
          if (textarea) {
            const lines = mdMasked.split("\n");
            let pos = 0;
            for (let i = 0; i < Math.min(lineIndex, lines.length - 1); i++) {
              pos += lines[i].length + 1;
            }
            // v0.12.0 返修（问题6）：加行内列偏移（clamp 到源码行长度，防语法字符差异越界）
            const lineLen = lines.length > lineIndex ? lines[lineIndex].length : 0;
            pos += Math.min(anchorColumn, lineLen);
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

          // E12(v0.9.4)：仅内容变化时才做整树替换，避免无意义的 PM history 记录
          const tr = contentChanged
            ? view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content)
            : view.state.tr;
          const safePos = Math.min(targetPos, tr.doc.content.size - 1);
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
          // ① 光标位置：按内容映射恢复（行 + 行内列偏移，clamp 到源码行长度），
          //    无锚点时保持现有光标不动
          if (anchorLine != null) {
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
          traceScroll("res-source", {
            before: textarea.scrollTop,
            want: anchorTop,
            pct: percent,
            anchorIdx: contentAnchor?.blockIndex,
            anchorRatio: contentAnchor?.ratioWithinBlock,
            anchorSrcLine: contentAnchor?.sourceLine,
            anchorAtTop: contentAnchor?.atTop,
            anchorAtBottom: contentAnchor?.atBottom,
            h: textarea.clientHeight,
            sh: textarea.scrollHeight,
          });
          if (anchorTop !== null) {
            textarea.scrollTop = anchorTop;
            traceScroll("res-source-after", { after: textarea.scrollTop, want: anchorTop });
            // 布局稳定后校正一次（内容可能刚写入，scrollHeight 还在变）
            requestAnimationFrame(() => {
              // TODO(v0.18): CM6 能力缺口 — 内容锚点 → `scrollTop` 的二次校正。当前 CM6 表现：跳过该校正，滚动恢复取首次写入值，位置略偏 | 用户可感知度：低 | 建议优先级：P2
              const t2 = sourceTextareaRef.current;
              if (!t2) return;
              const again = textareaTopFromContentAnchor(t2, contentAnchor);
              if (again !== null) t2.scrollTop = again;
            });
          } else {
            restoreScrollWithRetry(textarea, percent, 0, () => isRestoringScrollRef.current);
          }
          // focus/setSelectionRange 可能触发浏览器把光标滚入视口 → 下一帧校正
          if (computeRestoreScrollTop(percent, textarea.scrollHeight, textarea.clientHeight) !== null) {
            requestAnimationFrame(() => {
              // TODO(v0.18): CM6 能力缺口 — 块几何需 `coordsAtPos`/`getMetrics` 语义。当前 CM6 表现：模式切换时的源码块几何不可得 → 该方向退回百分比映射（偏约 4 倍量级） | 用户可感知度：中 | 建议优先级：P1
              const t2 = sourceTextareaRef.current;
              if (!t2) return;
              // 有锚点时以锚点为准，不要让百分比校正把它覆盖回错误位置
              if (contentAnchor) {
                const again = textareaTopFromContentAnchor(t2, contentAnchor);
                if (again !== null) t2.scrollTop = again;
                return;
              }
              const top2 = computeRestoreScrollTop(percent, t2.scrollHeight, t2.clientHeight);
              if (top2 !== null) t2.scrollTop = top2;
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
