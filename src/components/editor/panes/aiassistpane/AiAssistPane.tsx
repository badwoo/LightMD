/**
 * src/components/editor/panes/AiAssistPane/AiAssistPane.tsx —— AiAssistPane pane
 *
 * ## 职责边界
 *
 * 翻译与 AI 气泡/续写 ghost（选区幽灵、格式 ghost、全文翻译入口）
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 4009-4153 / 4254-4835 行。
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
  useState,
  useCallback,
} from "react";
import { t as translate } from "../../../../i18n";
import { useSettingsStore } from "../../../../stores/useSettingsStore";
import { planSourceChar, planSourceCompositionCommit } from "../../../../utils/sourceAutoPair";
import { TranslateSourceMode, BubbleAnchor, useTranslateStore } from "../../../../stores/translateStore";
import { Node as PMNode } from "prosemirror-model";
import { AiAssistTask, translateTooltipKey } from "../../../../core/plugins/translateTooltip";
import { useEditorStore } from "../../../../stores/useEditorStore";
import { UNTITLED_PROGRESS_PREFIX } from "../../../../utils/tabKey";
import { hasTranslatableText } from "../../../../services/fullTranslate";
import { notifyWarning, notifySuccess } from "../../../../services/notificationService";
import { translateService, TranslateServiceError, parseTranslateError } from "../../../../services/translateService";
import { useFullTranslateStore } from "../../../../stores/fullTranslateStore";
import { extractFromSelection, getTextareaSelectionAnchor, extractFromIframe, applyTranslation, buildSourceRewrite } from "../../../../services/translateBridge";
import { getMarkdownFromDoc } from "../../../../core/editor";
import { unmaskBase64Images } from "../../../../utils/base64ImageMask";
import { AiTask, aiAssistService } from "../../../../services/aiAssistService";
import { AiAssistSourceMode, useAiAssistStore } from "../../../../stores/aiAssistStore";
import { setAiGhost, aiGhostKey, clearAiGhost } from "../../../../core/plugins/ai-ghost";
import { syncTextareaMetrics, buildSourceGhostHtml } from "../../../../utils/focus-paragraph";
import { shouldClearFormatGhost } from "../.././sourceFormat";
import type { EditorView as EditorView } from "prosemirror-view";
import {
  buildSourcePairInput,
  applySourcePairPlan,
} from "../../EditorContainer";
import type { AiAssistPaneParams, AiAssistPaneResult } from "./types";

export function useAiAssistPane(p: AiAssistPaneParams): AiAssistPaneResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    isSourceMode,
    isMdFile,
    sourceTextareaRef,
    triggerMenuPosRef,
    aiMenuPosRef,
    viewRef,
    filePath,
    progressKeyRef,
    forceUpdateKey,
    viewMode,
    startFullTranslateRef,
    sourceContentRef,
    previewShown,
    previewIframeRef,
    startTranslateRef,
    applyingTranslationRef,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    sourceGhostActiveRef,
    formatGhostRef,
    formatGhostHandlersRef,
  } = p;

  useEffect(() => {
    if (!isSourceMode || !isMdFile) return;
    const ta = sourceTextareaRef.current;
    if (!ta) return;

    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (ie.isComposing) return; // 组合输入期间暂停配对
      if (ie.inputType !== "insertText") return; // 粘贴/删除/换行走默认
      const data = ie.data;
      if (typeof data !== "string" || data.length !== 1) return;
      if (!useSettingsStore.getState().autoPairEnabled) return;
      const plan = planSourceChar(
        buildSourcePairInput(ta, ta.selectionStart ?? 0, ta.selectionEnd ?? 0),
        data,
      );
      if (plan.kind !== "edit") return;
      ie.preventDefault();
      applySourcePairPlan(ta, plan);
    };

    const onCompositionEnd = (e: Event) => {
      const data = (e as CompositionEvent).data;
      if (typeof data !== "string" || data.length !== 1) return;
      if (!useSettingsStore.getState().autoPairEnabled) return;
      // rAF：等浏览器把组合文本真正落进 value 并稳定选区后再判定
      requestAnimationFrame(() => {
        if (sourceTextareaRef.current !== ta || !ta.isConnected) return;
        const pos = ta.selectionStart ?? 0;
        if (pos !== (ta.selectionEnd ?? 0)) return;
        const plan = planSourceCompositionCommit({
          ...buildSourcePairInput(ta, pos, pos),
          char: data,
          commitEnd: pos,
        });
        if (plan.kind !== "edit") return;
        applySourcePairPlan(ta, plan);
      });
    };

    ta.addEventListener("beforeinput", onBeforeInput);
    ta.addEventListener("compositionend", onCompositionEnd);
    return () => {
      ta.removeEventListener("beforeinput", onBeforeInput);
      ta.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [isSourceMode, isMdFile]);

  const translateCtxRef = useRef<{
    text: string;
    sourceMode: TranslateSourceMode;
    anchor: BubbleAnchor;
    start?: number;
    end?: number;
    // v0.7.3 改进1(D1)：pm 通道任务启动时的文档引用快照——回写时若文档未被编辑
    // （doc 引用一致）则用快照 from/to 定位替换目标，防流式期间选区漂移错位回写
    doc?: PMNode;
  } | null>(null);

  const translateSeqRef = useRef(0);

  const handleTranslateApplyRef = useRef<(mode: "replace" | "bilingual", translated: string) => void>(() => {});

  const [triggerMenuPos, setTriggerMenuPos] = useState<{ x: number; y: number } | null>(null);

  triggerMenuPosRef.current = (x, y) => setTriggerMenuPos({ x, y });

  const [aiMenuPos, setAiMenuPos] = useState<{
    x: number;
    y: number;
    task: AiAssistTask | null;
  } | null>(null);

  aiMenuPosRef.current = (x, y, task) => setAiMenuPos({ x, y, task });

  const hideTranslateTrigger = useCallback(() => {
    const view = viewRef.current;
    if (view && !view.isDestroyed) {
      view.dispatch(view.state.tr.setMeta(translateTooltipKey, false));
    }
  }, []);

  const activeFileRef = useRef<string | null | undefined>(undefined);

  activeFileRef.current = filePath;

  const activeProgressKey = useEditorStore((s) => {
    const tab = s.openTabs[s.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? s.activeTabIdx}`
      : tab.path || null;
  });

  progressKeyRef.current = activeProgressKey;

  const activeKeyRef = useRef<number>(0);

  activeKeyRef.current = forceUpdateKey ?? 0;

  const currentDocKey = useCallback((): string | null => {
    const st = useEditorStore.getState();
    const tab = st.openTabs[st.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? st.activeTabIdx}`
      : tab.path || null;
  }, []);

  const runTranslate = useCallback((
    text: string,
    sourceMode: TranslateSourceMode,
    anchor: BubbleAnchor,
    start?: number,
    end?: number,
  ) => {
    // v0.6.2 问题4：无可译文字（纯符号/纯链接选区）静默返回不发请求省 token
    // v0.7.3 U1：由静默改为 toast 提示，用户能感知"该选区不可翻译"
    if (!hasTranslatableText(text)) {
      notifyWarning(translate("translate.noTranslatable"));
      return;
    }
    // v0.7.3 问题2修复：移除"隐藏翻译小气泡时一律拦截"的守卫——
    // 隐藏的只是选中文本浮动的小气泡，翻译功能未关闭，F6 / 右键 / 命令面板仍应可用。
    // 隐藏时：气泡模式（bubble）降级为复制到剪贴板并 toast；replace/bilingual 直接回写。
    const cfg = useSettingsStore.getState().translate;
    const seq = ++translateSeqRef.current;
    // v0.7.3 D2：序号守卫——旧任务 promise 完成时若已发起新任务则丢弃，防止旧译文
    // 写入新任务气泡（与 aiSeqRef 同款，修复窄竞态窗口）
    // v0.7.3 D1：pm 通道记录任务启动时的文档引用快照——回写时据此定位替换目标防错位
    translateCtxRef.current = {
      text,
      sourceMode,
      anchor,
      start,
      end,
      doc: sourceMode === "pm" ? viewRef.current?.state.doc : undefined,
    };
    const bubbleHidden = cfg.translateBubbleHidden;
    if (!bubbleHidden) {
      useTranslateStore.getState().openBubble(sourceMode, anchor);
    }

    translateService
      .translate(text, (chunk) => {
        if (translateSeqRef.current !== seq) return;
        useTranslateStore.getState().appendChunk(chunk);
      })
      .then((result) => {
        if (translateSeqRef.current !== seq) return;
        if (!bubbleHidden) useTranslateStore.getState().finish(result);
        // v0.7.0：气泡隐藏时 bubble 模式降级为 clipboard（结果有去向，不静默丢弃）
        const mode = bubbleHidden && cfg.translateResultMode === "bubble"
          ? "clipboard" as const
          : cfg.translateResultMode;
        // preview 通道无回写能力，强制气泡交互；clipboard 模式对任何通道均直接复制
        if (mode === "clipboard") {
          navigator.clipboard?.writeText(result.translated).catch(() => undefined);
          useTranslateStore.getState().close();
          // v0.7.3 U1：隐藏气泡 + 复制到剪贴板时给出反馈，避免"看似没反应"
          if (bubbleHidden) notifySuccess(translate("translate.copiedToClipboardHidden"));
        } else if (sourceMode !== "preview" && (mode === "replace" || mode === "bilingual")) {
          handleTranslateApplyRef.current(mode, result.translated);
        }
      })
      .catch((e) => {
        if (translateSeqRef.current !== seq) return;
        const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
        // CANCELLED 静默：新任务已 openBubble 重置状态，旧任务的 fail 会污染新任务
        if (info.code === "CANCELLED") return;
        // v0.7.3 U1：隐藏气泡的翻译失败也要能感知（气泡不可见时无法看错误态）
        if (bubbleHidden) {
          notifyWarning(translate("translate.failedNotify"));
        }
        useTranslateStore.getState().fail(info.code, info.detail);
      });
  }, []);

  const startTranslate = useCallback((fallbackToFull?: boolean) => {
    // v0.7.0 修复1：双开关——全局 AI 总开关 + 翻译子开关都开启才响应
    // v0.7.3 U1：由静默返回改为 toast，用户能感知被禁用
    const s = useSettingsStore.getState();
    if (!s.aiEnabled || !s.translate.translateEnabled) {
      notifyWarning(translate("translate.disabledNotify"));
      return;
    }
    // v0.6.3 P1-2：全文翻译运行中不响应选中翻译——translateService.translate 无条件取消旧任务，
    // 会导致整篇翻译被静默中止且已完成段落的译文全部作废
    // v0.7.3 U1：给出提示
    if (useFullTranslateStore.getState().status === "running") {
      notifyWarning(translate("translate.fullRunningNotify"));
      return;
    }

    // 1. PM 阅读模式（md 文件）
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view) return;
      const extract = extractFromSelection(view);
      if (!extract) {
        // v0.6.2 问题3：无有效选区且来自「译」按钮 → 回退全文翻译
        if (fallbackToFull) startFullTranslateRef.current();
        // v0.7.3 U1：非回退入口（F6/菜单）无选区时提示
        else notifyWarning(translate("translate.noSelectionNotify"));
        return;
      }
      let anchor: BubbleAnchor;
      try {
        const coords = view.coordsAtPos(view.state.selection.to);
        anchor = { x: coords.left, y: coords.bottom };
      } catch {
        anchor = { x: window.innerWidth / 2, y: 100 };
      }
      runTranslate(extract.text, "pm", anchor);
      return;
    }

    // 2. 源码模式（edit/split）：textarea 选区优先
    if (isSourceMode) {
      const textarea = sourceTextareaRef.current;
      if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
        const text = sourceContentRef.current.slice(textarea.selectionStart, textarea.selectionEnd);
        if (text.trim()) {
          runTranslate(text, "source", getTextareaSelectionAnchor(textarea), textarea.selectionStart, textarea.selectionEnd);
          return;
        }
      }
      // 3. 编辑模式 textarea 无选区 → iframe 预览选区（纯文本通道）
      if (previewShown) {
        const iframe = previewIframeRef.current;
        const doc = iframe?.contentDocument;
        const text = doc ? extractFromIframe(doc) : null;
        if (doc && text) {
          const sel = doc.getSelection();
          const iframeRect = iframe!.getBoundingClientRect();
          let anchor: BubbleAnchor = { x: iframeRect.left + 100, y: iframeRect.top + 100 };
          if (sel && sel.rangeCount > 0) {
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            anchor = { x: iframeRect.left + rect.right, y: iframeRect.top + rect.bottom };
          }
          runTranslate(text, "preview", anchor);
          return;
        }
      }
      // v0.6.2 问题3：textarea 与 iframe 均无选区且来自「译」按钮 → 回退全文翻译
      // v0.7.3 U1：非回退入口（F6/菜单）在源码模式无选区时提示
      if (fallbackToFull) startFullTranslateRef.current();
      else notifyWarning(translate("translate.noSelectionNotify"));
      return;
    }

    // 4. preview+非 md 文件：主文档 DOM 选区（纯文本通道）
    if (viewMode === "preview" && !isMdFile) {
      const sel = document.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (sel && text && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        runTranslate(text, "preview", { x: rect.right, y: rect.bottom });
      }
    }
  }, [viewMode, isMdFile, isSourceMode, runTranslate]);

  startTranslateRef.current = startTranslate;

  const handleTranslateApply = useCallback((mode: "replace" | "bilingual", translated: string) => {
    const ctx = translateCtxRef.current;
    if (!ctx || !translated.trim()) return;

    if (ctx.sourceMode === "pm") {
      const view = viewRef.current;
      if (!view) return;
      // v0.6.1 问题2：记录回写前全文快照（取消翻译恢复用）
      let original: string | null = null;
      try {
        original = getMarkdownFromDoc(view.state.doc);
      } catch {
        original = null;
      }
      // replace 失败（结构失配/解析失败）自动降级 bilingual 引用块插入
      // v0.6.1 问题3：标记翻译回写中，onDocChange 据此抑制自动保存
      // v0.7.3 改进1(D1)：用任务启动时的选区快照定位替换目标，防流式期间选区漂移错位回写
      applyingTranslationRef.current = true;
      let ok = false;
      try {
        const snap =
          ctx.doc &&
          typeof ctx.start === "number" &&
          typeof ctx.end === "number"
            ? { from: ctx.start, to: ctx.end, doc: ctx.doc }
            : undefined;
        ok = applyTranslation(view, translated, mode, snap) ||
          (mode === "replace" && applyTranslation(view, translated, "bilingual", snap));
      } finally {
        applyingTranslationRef.current = false;
      }
      if (ok) {
        useTranslateStore.getState().close();
        translateCtxRef.current = null;
        // v0.6.1 问题2：回写成功后记录原文快照，显示"取消翻译"气泡
        // v0.6.3 P0-2：快照绑定文档上下文（filePath/key），恢复前校验归属
        if (original !== null) {
          useEditorStore.getState().setTranslateUndoSnapshot({
            content: original,
            filePath: activeFileRef.current ?? null,
            key: activeKeyRef.current,
          });
        }
      }
      // 失败保留气泡，用户可复制译文
      return;
    }

    if (ctx.sourceMode === "source" && ctx.start !== undefined && ctx.end !== undefined) {
      const rewrite = buildSourceRewrite(sourceContentRef.current, ctx.start, ctx.end, translated, mode);
      if (!rewrite) return;
      // v0.6.1 问题2：记录回写前全文快照（取消翻译恢复用）
      const original = sourceContentRef.current;
      /**
       * v0.15.1 需求6（再审计缺陷 2）：翻译回写**必须进统一时间线**。
       *
       * 旧实现只 `setSourceContent` → ① Ctrl+Z 撤不回译文（只能靠「取消翻译」气泡）；
       * ② 更隐蔽：时间线 `knownText` 停在回写前 → 下一次打字 commit 的 before 失配 →
       * 协调器 `rebaseText(force:true)` → **静默 truncateRedo**（用户只是打了个字，
       * 却把 redo 分支整段丢了）。走 `recordDiscreteSourceEdit` 一并解决基线纠偏。
       */
      recordDiscreteSourceEdit(
        original,
        rewrite.content,
        ctx.start,
        sourceTextareaRef.current?.scrollTop ?? 0,
        rewrite.cursor,
      );
      setSourceContent(rewrite.content);
      onContentChangeRef.current?.(rewrite.content);
      setDirtyRef.current(true);
      // v0.6.1 问题3：翻译回写的修改不自动保存
      useEditorStore.getState().setSuppressAutoSave(true);
      // v0.6.1 问题2：记录原文快照，显示"取消翻译"气泡
      // v0.6.3 P0-2：快照绑定文档上下文（filePath/key），恢复前校验归属
      useEditorStore.getState().setTranslateUndoSnapshot({
        content: original,
        filePath: activeFileRef.current ?? null,
        key: activeKeyRef.current,
      });
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(rewrite.content, base64TokensRef.current);
      useTranslateStore.getState().close();
      translateCtxRef.current = null;
      // 光标移到译文末尾并聚焦
      const textarea = sourceTextareaRef.current;
      if (textarea) {
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(rewrite.cursor, rewrite.cursor);
        });
      }
    }
  }, []);

  handleTranslateApplyRef.current = handleTranslateApply;

  const handleTranslateCopy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  const handleTranslateRetry = useCallback(() => {
    const ctx = translateCtxRef.current;
    if (!ctx) return;
    const anchor = useTranslateStore.getState().anchor ?? ctx.anchor;
    runTranslate(ctx.text, ctx.sourceMode, anchor, ctx.start, ctx.end);
  }, [runTranslate]);

  const aiCtxRef = useRef<{
    task: AiTask;
    text: string;
    sourceMode: AiAssistSourceMode;
    anchor: BubbleAnchor;
    start?: number;
    end?: number;
    insertPos?: number;
    /** v0.7.4 修复3：任务所属文档路径——应用/重试前校验归属，防跨文档串写内容 */
    filePath: string | null;
  } | null>(null);

  const aiSeqRef = useRef(0);

  const ghostActiveRef = useRef(false);

  const sourceGhostOverlayRef = useRef<HTMLDivElement>(null);

  const sourceGhostPlaceholderRef = useRef(false);

  const sourceGhostTextRef = useRef("");

  const sourceGhostPosRef = useRef(0);

  const runAiBubble = useCallback((
    task: AiTask,
    text: string,
    sourceMode: AiAssistSourceMode,
    anchor: BubbleAnchor,
    start?: number,
    end?: number,
    insertPos?: number,
  ) => {
    // v0.7.4 修复3：上下文绑定所属文档，应用/重试前校验归属（防切文档后串写内容）
    const ctxFilePath = activeFileRef.current ?? null;
    aiCtxRef.current = { task, text, sourceMode, anchor, start, end, insertPos, filePath: ctxFilePath };
    const seq = ++aiSeqRef.current;
    // v0.7.4：气泡记录所属文档路径（摘要气泡跨文档显示时按归属过滤）
    useAiAssistStore.getState().openBubble(task, sourceMode, anchor, ctxFilePath);
    aiAssistService
      .run(task, text, (chunk) => {
        // v0.7.4 修复3：旧任务的残余 chunk 不得写入新任务气泡（取消为异步，在途消息可能到达）
        if (aiSeqRef.current !== seq) return;
        useAiAssistStore.getState().appendChunk(chunk);
      })
      .then((result) => {
        // 旧任务结果丢弃（新任务已 openBubble 重置状态）
        if (aiSeqRef.current !== seq) return;
        useAiAssistStore.getState().finish(result);
      })
      .catch((e) => {
        if (aiSeqRef.current !== seq) return;
        const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
        // CANCELLED 静默：新任务已接管，fail 会污染新任务状态
        if (info.code === "CANCELLED") return;
        useAiAssistStore.getState().fail(info.code, info.detail);
      });
  }, []);

  const runAiGhost = useCallback((head: string, pos: number) => {
    const view = viewRef.current;
    if (!view) return;
    ghostActiveRef.current = true;
    // v0.7.5 优化3：立即渲染「续写中…」占位 ghost。
    // 首包到达前可能有数秒空白，此前用户点击后毫无反馈（体验投诉点）；
    // 首个真实增量到达即替换为正文，占位期间不可采纳（见下方 Tab 处理）。
    setAiGhost(view, pos, translate("ai.continuing"), true);
    const seq = ++aiSeqRef.current;
    // v0.7.3 改进5(P4-1)：流式 rAF 节流——每 chunk dispatch 一次事务会频繁重建
    // ghost widget（key 含 text.length），改成累积到每帧最多刷新一次，缓解大文档掉帧
    let accGhost = "";
    /** v0.7.5 优化3：是否已收到首个真实增量（决定占位提示是否退场） */
    let gotFirstChunk = false;
    let ghostFrame: number | null = null;
    let ghostFinalized = false;
    const flushGhost = () => {
      ghostFrame = null;
      if (ghostFinalized || !ghostActiveRef.current) return;
      const vv = viewRef.current;
      if (!vv || vv.isDestroyed) return;
      const cur = aiGhostKey.getState(vv.state);
      if (!cur) return; // 已完成/清除则不刷新（防覆盖最终 unmask 文本）
      setAiGhost(vv, cur.pos, accGhost);
    };
    const scheduleGhostFlush = () => {
      if (ghostFrame !== null) return;
      ghostFrame = requestAnimationFrame(flushGhost);
    };
    aiAssistService
      .run("continue", head, (chunk) => {
        // v0.7.4 修复3：旧任务残余 chunk 不得污染新任务的 ghost
        if (aiSeqRef.current !== seq) return;
        if (!ghostActiveRef.current) return;
        const v = viewRef.current;
        if (!v || v.isDestroyed) return;
        const cur = aiGhostKey.getState(v.state);
        // ghost 已被用户编辑清除：位置语义失效，取消任务停止更新
        if (!cur) {
          ghostActiveRef.current = false;
          aiAssistService.cancel().catch(() => undefined);
          return;
        }
        // v0.7.5 优化3：首个增量替换占位提示（占位文案不参与累积）
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          accGhost = chunk;
        } else {
          accGhost += chunk; // 累积文本
        }
        scheduleGhostFlush(); // 每帧至多刷新一次
      })
      .then((result) => {
        // v0.7.1 修复：流式 chunk 是 {{N}} 占位符坐标（Rust 侧 mask 后发送），
        // 完成后须用已回填（unmask）的最终文本替换 ghost——否则上文含链接/
        // 行内代码时，Tab 采纳会把 {{N}} 字面量插入文档
        if (aiSeqRef.current !== seq) return;
        if (!ghostActiveRef.current) return;
        ghostFinalized = true; // 结束后不再被 rAF 覆盖（用 unmask 最终文本）
        const v = viewRef.current;
        if (!v || v.isDestroyed) return;
        const cur = aiGhostKey.getState(v.state);
        if (cur) setAiGhost(v, cur.pos, result.translated);
      })
      .catch((e) => {
        if (aiSeqRef.current !== seq) return;
        ghostActiveRef.current = false;
        const v = viewRef.current;
        if (v && !v.isDestroyed) clearAiGhost(v);
        const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
        if (info.code === "CANCELLED") return;
        // 失败时以气泡提示（ghost 已清除）
        useAiAssistStore.getState().openBubble("continue", "pm", { x: window.innerWidth / 2, y: 120 }, activeFileRef.current);
        useAiAssistStore.getState().fail(info.code, info.detail);
      });
  }, []);

  const renderSourceGhost = useCallback(() => {
    const overlay = sourceGhostOverlayRef.current;
    const textarea = sourceTextareaRef.current;
    if (!overlay || !textarea) return;
    syncTextareaMetrics(textarea, overlay);
    const text = textarea.value;
    const pos = Math.max(0, Math.min(sourceGhostPosRef.current, text.length));
    // v0.7.5 优化3：占位态不显示采纳提示（此时尚不可采纳）
    const placeholder = sourceGhostPlaceholderRef.current;
    overlay.innerHTML = buildSourceGhostHtml(
      text,
      pos,
      sourceGhostTextRef.current,
      placeholder ? "" : translate("settings.translate.ghostHint"),
      placeholder
    );
    // ghost 在光标之后追加：同步 overlay 滚动位置到 textarea，保证预览与视口对齐
    overlay.scrollTop = textarea.scrollTop;
  }, []);

  const clearSourceGhost = useCallback(() => {
    const overlay = sourceGhostOverlayRef.current;
    if (overlay) overlay.innerHTML = "";
    sourceGhostActiveRef.current = false;
    sourceGhostPlaceholderRef.current = false;
    sourceGhostTextRef.current = "";
  }, []);

  const renderFormatGhost = useCallback(() => {
    const overlay = sourceGhostOverlayRef.current;
    const textarea = sourceTextareaRef.current;
    const ghost = formatGhostRef.current;
    if (!overlay || !textarea || !ghost) return;
    // AI ghost 优先（异步任务不被打断视觉）
    if (sourceGhostActiveRef.current) return;
    // 文档已偏离 ghost 快照（真实输入/撤销/其它写路径）→ ghost 语义失效，清除
    if (textarea.value !== ghost.content) {
      formatGhostRef.current = null;
      overlay.innerHTML = "";
      return;
    }
    syncTextareaMetrics(textarea, overlay);
    // hintText 为空（格式 ghost 无需"Tab 采纳"提示）；
    // v0.12.0 返修：携带尾部符号 + 遮罩开关 → 占位文字落在左右格式符中间
    overlay.innerHTML = buildSourceGhostHtml(ghost.content, ghost.pos, ghost.text, "", false, {
      tail: ghost.tail,
      maskBg: ghost.maskTail,
    });
    overlay.scrollTop = textarea.scrollTop;
  }, []);

  const clearFormatGhost = useCallback((kind: string) => {
    if (!shouldClearFormatGhost(kind)) return;
    if (!formatGhostRef.current) return;
    formatGhostRef.current = null;
    // 仅当 AI ghost 未占用 overlay 时清空可见内容
    if (!sourceGhostActiveRef.current) {
      const overlay = sourceGhostOverlayRef.current;
      if (overlay) overlay.innerHTML = "";
    }
  }, []);

  const removeFormatGhostSyntax = useCallback(() => {
    const ghost = formatGhostRef.current;
    const textarea = sourceTextareaRef.current;
    if (!ghost || !textarea) return false;
    // 光标已离开插入点 → 不再整段删除，走默认退格
    if (textarea.selectionStart !== textarea.selectionEnd || textarea.selectionStart !== ghost.pos) return false;
    const current = sourceContentRef.current;
    if (current.slice(ghost.start, ghost.end) !== ghost.content.slice(ghost.start, ghost.end)) return false;
    const newContent = current.slice(0, ghost.start) + current.slice(ghost.end);
    const scrollTop = textarea.scrollTop;
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
    recordDiscreteSourceEdit(current, newContent, ghost.start, scrollTop);
    setSourceContent(newContent);
    sourceContentRef.current = newContent;
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
    formatGhostRef.current = null;
    if (!sourceGhostActiveRef.current) {
      const overlay = sourceGhostOverlayRef.current;
      if (overlay) overlay.innerHTML = "";
    }
    const caret = ghost.start;
    const restore = () => {
      const ta = sourceTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
        ta.scrollTop = scrollTop;
      }
    };
    requestAnimationFrame(restore);
    return true;
  }, [recordDiscreteSourceEdit]);

  formatGhostHandlersRef.current = { render: renderFormatGhost, clear: clearFormatGhost, remove: removeFormatGhostSyntax };

  useEffect(() => {
    formatGhostHandlersRef.current.clear("file-switch");
  }, [filePath]);

  useEffect(() => {
    formatGhostHandlersRef.current.clear("mode-switch");
  }, [viewMode]);

  return {
    triggerMenuPos,
    setTriggerMenuPos,
    aiMenuPos,
    setAiMenuPos,
    hideTranslateTrigger,
    activeFileRef,
    activeKeyRef,
    currentDocKey,
    handleTranslateApply,
    handleTranslateCopy,
    handleTranslateRetry,
    aiCtxRef,
    aiSeqRef,
    ghostActiveRef,
    sourceGhostOverlayRef,
    sourceGhostPlaceholderRef,
    sourceGhostTextRef,
    sourceGhostPosRef,
    runAiBubble,
    runAiGhost,
    renderSourceGhost,
    clearSourceGhost
  };
}
