/**
 * src/components/editor/panes/AiChatPane/AiChatPane.tsx —— AiChatPane pane
 *
 * ## 职责边界
 *
 * AI 对话与全文翻译（上下文采集、发送、写回、进度提示）
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 4838-6280 行。
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
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { t as translate } from "../../../../i18n";
import { aiAssistService, AiTask } from "../../../../services/aiAssistService";
import { TranslateServiceError, parseTranslateError, translateService } from "../../../../services/translateService";
import { useAiAssistStore, AiAssistSourceMode } from "../../../../stores/aiAssistStore";
import { unmaskBase64Images, maskBase64Images } from "../../../../utils/base64ImageMask";
import { getMarkdownFromDoc } from "../../../../core/editor";
import { applyTranslation, buildSourceRewrite, extractFromSelection, getTextareaSelectionAnchor } from "../../../../services/translateBridge";
import { useEditorStore, isTranslateSnapshotForFile } from "../../../../stores/useEditorStore";
import { markdownToDoc } from "../../../../core/markdown/parser";
import { Slice, Node as PMNode } from "prosemirror-model";
import { useSettingsStore, isAiChatRectVisible } from "../../../../stores/useSettingsStore";
import { notifyWarning } from "../../../../services/notificationService";
import { useFullTranslateStore } from "../../../../stores/fullTranslateStore";
import { BubbleAnchor, useTranslateStore } from "../../../../stores/translateStore";
import { AiChatContextScope, hasUsableContext, truncateChatContext, chatSelectionSignature, resolveAutoFollowScope, planChatSelectionChange, aiChatService, resolveChatSendScope, buildChatRequestMessages } from "../../../../services/aiChatService";
import { useAiChatStore } from "../../../../stores/aiChatStore";
import { aiGhostKey, clearAiGhost } from "../../../../core/plugins/ai-ghost";
import { TextSelection } from "prosemirror-state";
import { splitDocumentForTranslation, createContextAbortChecker, runFullTranslateLoop, rebuildTranslatedDocument } from "../../../../services/fullTranslate";
import { versionSnapshotService } from "../../../../services/versionSnapshotService";
import type { EditorView as EditorView } from "prosemirror-view";
import {
  isPmSelectionSnapshotValid,
  isSourceSelectionSnapshotValid,
  canReplaceDocument,
  lastTranslateSnapshot,
  TRANSLATE_SNAPSHOT_THROTTLE_MS,
} from "../../EditorContainer";
import type { AiChatPaneParams, AiChatPaneResult } from "./types";

export function useAiChatPane(p: AiChatPaneParams): AiChatPaneResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    renderSourceGhost,
    sourceTextareaRef,
    formatGhostRef,
    sourceGhostActiveRef,
    sourceGhostPosRef,
    sourceGhostPlaceholderRef,
    sourceGhostTextRef,
    aiSeqRef,
    activeFileRef,
    clearSourceGhost,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    sourceGhostHandlersRef,
    aiCtxRef,
    viewRef,
    applyingTranslationRef,
    activeKeyRef,
    sourceContentRef,
    content,
    viewMode,
    isMdFile,
    isSourceMode,
    runAiBubble,
    runAiGhost,
    startAiAssistRef,
    forceUpdateKey,
    startAiChatRef,
    editorRef,
    ghostActiveRef,
    sourceGhostOverlayRef,
    lastSyncDiskRef,
    filePath,
    startFullTranslateRef,
    startTranslateRef,
    handleFormatAction,
  } = p;
  // v0.17.0 P0-1（唯一非纯搬运处，见 DEVIATIONS.md）：原模块级 `let lastTranslateSnapshot`
  // 需要被本 pane 赋值，但 ES 模块 import 绑定只读 → 改为 pane 内 useRef，语义等价（容器单实例）
  const lastTranslateSnapshotRef = useRef({ path: "", at: 0 });



  /** 执行 source 模式续写 ghost：流式更新 overlay，完成后保留 ghost 等待 Tab 采纳 / Esc 放弃 */
  const runSourceAiGhost = useCallback((head: string, pos: number) => {
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    // v0.12.0 需求1：AI ghost 优先——启动时清除格式 ghost（占位提示让位给续写预览）
    formatGhostRef.current = null;
    sourceGhostActiveRef.current = true;
    sourceGhostPosRef.current = pos;
    // v0.7.5 优化3：立即渲染「续写中…」占位 ghost（与 PM 模式一致），
    // 首个真实增量到达即替换；占位期间不可采纳（见 acceptSourceGhost）
    sourceGhostPlaceholderRef.current = true;
    sourceGhostTextRef.current = translate("ai.continuing");
    renderSourceGhost();
    const seq = ++aiSeqRef.current;
    // v0.7.3 改进5(P4-1)：与 PM ghost 一致，流式 chunk 累积到 rAF 每帧至多刷新一次
    let accGhost = "";
    /** v0.7.5 优化3：是否已收到首个真实增量 */
    let gotFirstChunk = false;
    let ghostFrame: number | null = null;
    let ghostFinalized = false;
    const flushGhost = () => {
      ghostFrame = null;
      if (ghostFinalized || !sourceGhostActiveRef.current) return;
      // 局部累加 → ref（供 Tab 采纳时取完整 ghost 文本）
      sourceGhostTextRef.current = accGhost;
      renderSourceGhost();
    };
    const scheduleGhostFlush = () => {
      if (ghostFrame !== null) return;
      ghostFrame = requestAnimationFrame(flushGhost);
    };
    aiAssistService
      .run("continue", head, (chunk) => {
        // v0.7.4 修复3：旧任务残余 chunk 不得污染新任务的 ghost
        if (aiSeqRef.current !== seq) return;
        if (!sourceGhostActiveRef.current) return;
        // v0.7.5 优化3：首个增量替换占位提示（占位文案不参与累积）
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          sourceGhostPlaceholderRef.current = false;
          accGhost = chunk;
        } else {
          accGhost += chunk;
        }
        scheduleGhostFlush();
      })
      .then((result) => {
        // 完成后须用已回填（unmask）的最终文本替换 ghost——流式 chunk 是 {{N}} 占位符坐标
        if (aiSeqRef.current !== seq) return;
        if (!sourceGhostActiveRef.current) return;
        ghostFinalized = true;
        sourceGhostPlaceholderRef.current = false;
        sourceGhostTextRef.current = result.translated;
        renderSourceGhost();
      })
      .catch((e) => {
        if (aiSeqRef.current !== seq) return;
        sourceGhostActiveRef.current = false;
        const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
        if (info.code === "CANCELLED") return;
        // 失败时以气泡提示（ghost 已清除）
        useAiAssistStore.getState().openBubble("continue", "source", { x: window.innerWidth / 2, y: 120 }, activeFileRef.current);
        useAiAssistStore.getState().fail(info.code, info.detail);
      });
  }, [renderSourceGhost]);


  /** 采纳 source ghost（Tab）：将 ghost 文本插入光标处，清除 overlay */
  const acceptSourceGhost = useCallback(() => {
    if (!sourceGhostActiveRef.current) return false;
    // v0.7.5 优化3：占位提示（续写中…）不是正文，不可采纳——消费掉本次 Tab
    // 但不插入、也不清除 ghost（等待真实增量到达）
    if (sourceGhostPlaceholderRef.current) return true;
    const textarea = sourceTextareaRef.current;
    const ghost = sourceGhostTextRef.current;
    sourceGhostActiveRef.current = false;
    aiAssistService.cancel().catch(() => undefined);
    if (!textarea || !ghost) {
      clearSourceGhost();
      return true;
    }
    const pos = Math.min(sourceGhostPosRef.current, textarea.value.length);
    const newContent = textarea.value.slice(0, pos) + ghost + textarea.value.slice(pos);
    // v0.15.1 需求6（再审计缺陷 2）：AI 续写 ghost 的 Tab 采纳同样是外部写回，
    // 不进时间线就撤不回、并会把 knownText 推偏（后续打字 force-rebase 清掉 redo）。
    recordDiscreteSourceEdit(textarea.value, newContent, pos, textarea.scrollTop, pos + ghost.length);
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // 显示层 masked，lastContentRef 存真实坐标（与续写/摘要气泡插入一致）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
    const cursor = pos + ghost.length;
    clearSourceGhost();
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
    return true;
  }, [clearSourceGhost]);


  /** 放弃 source ghost（Esc）：取消任务 + 清除 overlay */
  const cancelSourceGhost = useCallback(() => {
    if (!sourceGhostActiveRef.current) return false;
    sourceGhostActiveRef.current = false;
    aiAssistService.cancel().catch(() => undefined);
    clearSourceGhost();
    return true;
  }, [clearSourceGhost]);


  /** 用户编辑导致 source ghost 位置语义失效：取消任务 + 清除 overlay */
  const invalidateSourceGhost = useCallback(() => {
    if (sourceGhostActiveRef.current) {
      sourceGhostActiveRef.current = false;
      aiAssistService.cancel().catch(() => undefined);
      clearSourceGhost();
    }
  }, [clearSourceGhost]);


  // 每次渲染将最新实现转发到 ref（handleSourceKeyDown/handleSourceChange 仅挂载一次）
  sourceGhostHandlersRef.current = {
    accept: acceptSourceGhost,
    cancel: cancelSourceGhost,
    invalidate: invalidateSourceGhost,
  };


  /** AI 结果应用（气泡操作按钮）：润色=替换选中，续写/摘要=插入到任务启动时光标处 */
  const handleAiApply = useCallback((task: AiTask, text: string) => {
    const ctx = aiCtxRef.current;
    if (!ctx || !text.trim()) return;
    // v0.7.4 修复3：任务上下文必须属于当前文档——切文档后旧任务仍可能通过
    // 气泡按钮/快捷键触发应用，旧文档的选区坐标 + 译文会写入当前文档。
    // 归属不符时直接丢弃并关闭气泡。
    if (ctx.filePath !== (activeFileRef.current ?? null)) {
      useAiAssistStore.getState().close();
      aiCtxRef.current = null;
      return;
    }

    if (task === "polish" && ctx.sourceMode === "pm") {
      // pm 通道：applyTranslation 结构保真替换选区（失败返回 false 保留气泡供复制）
      const view = viewRef.current;
      if (!view) return;
      // v0.7.3 改进7(U4)：记录回写前全文快照（复用翻译的"取消翻译"气泡恢复机制，
      // 让润色回写后也能一键恢复原文）
      let original: string | null = null;
      try {
        original = getMarkdownFromDoc(view.state.doc);
      } catch {
        original = null;
      }
      // AI 回写不触发自动保存（与翻译回写策略一致）
      applyingTranslationRef.current = true;
      let ok = false;
      try {
        ok = applyTranslation(view, text, "replace");
      } finally {
        applyingTranslationRef.current = false;
      }
      if (ok) {
        useAiAssistStore.getState().close();
        aiCtxRef.current = null;
        // v0.7.3 U4：润色恢复快照绑定文档上下文（filePath/key），防跨文件串写
        if (original !== null) {
          useEditorStore.getState().setTranslateUndoSnapshot({
            content: original,
            filePath: activeFileRef.current ?? null,
            key: activeKeyRef.current,
          });
        }
      }
      return;
    }

    if (task === "polish" && ctx.sourceMode === "source" && ctx.start !== undefined && ctx.end !== undefined) {
      const rewrite = buildSourceRewrite(sourceContentRef.current, ctx.start, ctx.end, text, "replace");
      if (!rewrite) return;
      // v0.15.1 需求6（再审计缺陷 2）：AI 润色的源码回写同样必须进统一时间线，
      // 否则既撤不回、又会把时间线 knownText 推偏（下次打字 force-rebase 清掉 redo 分支）。
      recordDiscreteSourceEdit(
        sourceContentRef.current,
        rewrite.content,
        ctx.start,
        sourceTextareaRef.current?.scrollTop ?? 0,
        rewrite.cursor,
      );
      setSourceContent(rewrite.content);
      onContentChangeRef.current?.(rewrite.content);
      setDirtyRef.current(true);
      useEditorStore.getState().setSuppressAutoSave(true);
      // 显示层 masked，lastContentRef 存真实坐标（与翻译回写一致）
      lastContentRef.current = unmaskBase64Images(rewrite.content, base64TokensRef.current);
      useAiAssistStore.getState().close();
      aiCtxRef.current = null;
      const textarea = sourceTextareaRef.current;
      if (textarea) {
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(rewrite.cursor, rewrite.cursor);
        });
      }
      return;
    }

    // 续写/摘要：插入到光标处（用户主动采纳，走正常保存流程）
    if (ctx.sourceMode === "pm") {
      const view = viewRef.current;
      if (!view) return;
      // pos 可能因后续编辑漂移：clamp 到文档范围
      const pos = Math.min(ctx.insertPos ?? view.state.selection.from, view.state.doc.content.size);
      // 优先 markdown 解析为 fragment 插入（多段落/格式正确渲染），失败降级纯文本
      try {
        const frag = markdownToDoc(text).content;
        view.dispatch(view.state.tr.replace(pos, pos, new Slice(frag, 0, 0)));
      } catch {
        view.dispatch(view.state.tr.insertText(text, pos, pos));
      }
    } else {
      const textarea = sourceTextareaRef.current;
      const pos = ctx.insertPos ?? textarea?.selectionStart ?? sourceContentRef.current.length;
      const content = sourceContentRef.current;
      const newContent = content.slice(0, pos) + text + content.slice(pos);
      // v0.15.1 需求6（再审计缺陷 2）：AI 续写 / 摘要的源码插入也是"外部写回"，
      // 同样要进统一时间线（可撤销 + 让 knownText 跟上，避免后续打字 force-rebase）。
      recordDiscreteSourceEdit(
        content,
        newContent,
        pos,
        textarea?.scrollTop ?? 0,
        pos + text.length,
      );
      setSourceContent(newContent);
      onContentChangeRef.current?.(newContent);
      setDirtyRef.current(true);
      lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
      const ta = sourceTextareaRef.current;
      if (ta) {
        const cursor = pos + text.length;
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(cursor, cursor);
        });
      }
    }
    useAiAssistStore.getState().close();
    aiCtxRef.current = null;
  }, []);


  /** AI 助手触发入口（StatusBar AI 抽屉 ai.* 命令统一走这里）。
   * 与翻译共享单任务槽：全文翻译运行中禁止 AI 任务（避免取消整篇翻译）。
   * - continue：PM=ghost 流式；source=气泡（完成后插入光标处）
   * - polish：选中文本（无选区静默返回）
   * - summary：优先选区，否则全文（base64 先 mask 省 token）
   * v0.7.0 修复1：全局 AI 总开关关闭时所有 AI 助手入口静默（与底部栏禁用态双保险） */
  const startAiAssist = useCallback((task: AiTask) => {
    // v0.7.3 U1：禁用/冲突状态由静默改为 toast（用户主动点 AI 抽屉里的功能，需有反馈）
    if (!useSettingsStore.getState().aiEnabled) {
      notifyWarning(translate("ai.disabledNotify"));
      return;
    }
    if (useFullTranslateStore.getState().status === "running") {
      notifyWarning(translate("translate.fullRunningNotify"));
      return;
    }

    // 1. PM 阅读模式（md 文件）
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.state.selection.to;

      if (task === "continue") {
        // 光标前上文（纯文本，截尾 800 字符）→ ghost 流式续写
        const head = view.state.doc.textBetween(Math.max(0, pos - 800), pos, "\n\n");
        if (!head.trim()) {
          notifyWarning(translate("ai.continueEmptyNotify"));
          return;
        }
        runAiGhost(head, pos);
        return;
      }

      if (task === "polish") {
        const extract = extractFromSelection(view);
        if (!extract) {
          notifyWarning(translate("ai.polishNoSelectionNotify"));
          return;
        }
        let anchor: BubbleAnchor;
        try {
          const coords = view.coordsAtPos(view.state.selection.to);
          anchor = { x: coords.left, y: coords.bottom };
        } catch {
          anchor = { x: window.innerWidth / 2, y: 100 };
        }
        runAiBubble("polish", extract.text, "pm", anchor, undefined, undefined, pos);
        return;
      }

      // summary：优先选区，否则全文（mask base64 省 token；结果插入光标处不回填，标记无副作用）
      // v0.7.0 修复5：有选区时锚点取选区末端坐标（气泡虚线连接用）；全文摘要锚点 {0,0}
      const extract = extractFromSelection(view);
      const text = extract
        ? extract.text
        : maskBase64Images(getMarkdownFromDoc(view.state.doc), base64TokensRef.current).text;
      if (!text.trim()) return;
      let summaryAnchor: BubbleAnchor = { x: 0, y: 0 };
      if (extract) {
        try {
          const coords = view.coordsAtPos(view.state.selection.to);
          summaryAnchor = { x: coords.left, y: coords.bottom };
        } catch {
          summaryAnchor = { x: window.innerWidth / 2, y: 100 };
        }
      }
      runAiBubble("summary", text, "pm", summaryAnchor, undefined, undefined, pos);
      return;
    }

    // 2. 源码模式（edit/split）：textarea
    if (isSourceMode) {
      const textarea = sourceTextareaRef.current;
      if (!textarea) return;
      const hasSel = textarea.selectionStart !== textarea.selectionEnd;

      if (task === "continue") {
        const head = textarea.value.slice(Math.max(0, textarea.selectionStart - 800), textarea.selectionStart);
        if (!head.trim()) {
          notifyWarning(translate("ai.continueEmptyNotify"));
          return;
        }
        // v0.7.3 改进10(U3)：source 模式续写从"气泡渲染"改为"光标处 ghost 预览"
        // （Tab 采纳 / Esc 放弃），与 PM 模式交互手势统一
        runSourceAiGhost(head, textarea.selectionStart);
        return;
      }
      if (task === "polish") {
        if (!hasSel) {
          notifyWarning(translate("ai.polishNoSelectionNotify"));
          return;
        }
        const text = sourceContentRef.current.slice(textarea.selectionStart, textarea.selectionEnd);
        if (!text.trim()) return;
        runAiBubble("polish", text, "source", getTextareaSelectionAnchor(textarea), textarea.selectionStart, textarea.selectionEnd);
        return;
      }
      // summary：优先选区，否则全文（sourceContent 已是 masked 显示层，base64 为短标记）
      // v0.7.0 修复5：有选区时锚点取选区坐标（气泡虚线连接用）；全文摘要锚点 {0,0}
      const text = hasSel
        ? sourceContentRef.current.slice(textarea.selectionStart, textarea.selectionEnd)
        : sourceContentRef.current;
      if (!text.trim()) return;
      runAiBubble(
        "summary",
        text,
        "source",
        hasSel ? getTextareaSelectionAnchor(textarea) : { x: 0, y: 0 },
        undefined,
        undefined,
        textarea.selectionStart
      );
    }
  }, [viewMode, isMdFile, isSourceMode, runAiBubble, runAiGhost, runSourceAiGhost]);

  startAiAssistRef.current = startAiAssist;


  /** 重试上次 AI 任务（复用任务上下文，锚点取当前气泡位置） */
  const handleAiRetry = useCallback(() => {
    const ctx = aiCtxRef.current;
    if (!ctx) return;
    // v0.7.4 修复3：重试同样受文档归属约束（旧文档的原文不得在新文档重新发起）
    if (ctx.filePath !== (activeFileRef.current ?? null)) return;
    const anchor = useAiAssistStore.getState().anchor ?? ctx.anchor;
    runAiBubble(ctx.task, ctx.text, ctx.sourceMode, anchor, ctx.start, ctx.end, ctx.insertPos);
  }, [runAiBubble]);


  // ─── v0.7.4 修复3：无路径文档的 AI 气泡归属兜底 ──────────
  // 尚未保存的新文件 filePath 均为 null，无法据此区分归属；文件切换
  // （forceUpdateKey 变化）时直接作废残留气泡，防跨文档串写内容。
  useEffect(() => {
    const st = useAiAssistStore.getState();
    if (st.status === "idle" || st.filePath !== null) return;
    aiAssistService.cancel().catch(() => undefined);
    st.close();
    aiCtxRef.current = null;
  }, [forceUpdateKey]);


  // ─── v0.7.5 功能1：AI 对话接线（浮动窗口 / 上下文 / 动作回写）─────────
  /** 对话任务序号：新任务/关闭窗口后旧 promise 的 chunk/finish 一律丢弃 */
  const aiChatSeqRef = useRef(0);

  /**
   * 对话任务「发送时快照」（动作回写与 DOC_CHANGED 守卫用）。
   * 落实体检报告 D1 教训：回写不得使用"当前选区"，必须用发送时快照 clamp。
   */
  const chatCtxRef = useRef<{
    sourceMode: AiAssistSourceMode;
    /** 实际生效的上下文范围（选区丢失时已降级） */
    scope: AiChatContextScope;
    hadSelection: boolean;
    /** pm 通道：发送时选区位置 + 文档引用（文档被编辑则引用失配，动作降级） */
    selFrom?: number;
    selTo?: number;
    selDoc?: PMNode;
    /** source 通道：发送时选区切片位置 */
    srcStart?: number;
    srcEnd?: number;
    /**
     * v0.7.5：source 通道发送时的全文快照。
     * textarea 没有 doc 引用可比对，只能以内容是否逐字相同判断切片坐标是否仍有效；
     * 不一致时「替换选区」必须拒绝（否则会把回答写到别的文字上）。
     */
    srcSnapshot?: string;
    /** 插入位置（pm/source 皆为发送时光标） */
    insertPos?: number;
    /** 发送时全文快照（「替换全文」的 DOC_CHANGED 校验基准） */
    docSnapshot: string;
  } | null>(null);

  /** 对话窗打开状态（驱动选区变化时的 chip 预览刷新） */
  const chatOpen = useAiChatStore((s) => s.open);


  /**
   * v0.7.5：提取 AI 对话上下文（预览与发送共用；始终取"当下"的编辑器状态）
   * - PM 阅读模式（md 文件）：选区走 extractFromSelection（Markdown 保真）；
   *   全文走 maskBase64Images(getMarkdownFromDoc)（base64 短标记省 token）
   * - 源码模式（edit/split）：选区/全文取 textarea 切片（sourceContent 已是显示层坐标）
   * - preview + 非 md（纯文本预览）：不支持上下文，返回空（仅发送指令本身）
   */
  const extractChatContext = useCallback(
    (scope: AiChatContextScope): { raw: string; sourceMode: AiAssistSourceMode } => {
      if (scope === "none") return { raw: "", sourceMode: "pm" };
      if (viewMode === "preview" && isMdFile) {
        const view = viewRef.current;
        if (!view) return { raw: "", sourceMode: "pm" };
        if (scope === "selection") {
          return { raw: extractFromSelection(view)?.text ?? "", sourceMode: "pm" };
        }
        return {
          raw: maskBase64Images(getMarkdownFromDoc(view.state.doc), base64TokensRef.current).text,
          sourceMode: "pm",
        };
      }
      if (isSourceMode) {
        const content = sourceContentRef.current;
        if (scope === "selection") {
          const ta = sourceTextareaRef.current;
          if (!ta || ta.selectionStart === ta.selectionEnd) return { raw: "", sourceMode: "source" };
          return { raw: content.slice(ta.selectionStart, ta.selectionEnd), sourceMode: "source" };
        }
        return { raw: content, sourceMode: "source" };
      }
      return { raw: "", sourceMode: "pm" };
    },
    [viewMode, isMdFile, isSourceMode]
  );


  /**
   * v0.7.5：刷新对话窗上下文 chip 预览（打开窗口 / 切换范围 / 选区变化时调用）
   * - scope=selection 但选区已丢失 → 自动降级为全文，并置 degraded（chip 明示）
   * - 超上限截断 → chip 标注「已截断」（chars 仍显示原始字数）
   */
  const refreshChatPreview = useCallback(
    (scope: AiChatContextScope) => {
      const store = useAiChatStore.getState();
      if (!store.open) return;
      let actualScope = scope;
      let degraded = false;
      let raw = extractChatContext(scope).raw;
      if (scope === "selection" && !hasUsableContext(raw)) {
        actualScope = "document";
        raw = extractChatContext("document").raw;
        degraded = true;
      }
      const slice = truncateChatContext(raw, actualScope);
      store.setContextPreview({
        scope,
        actualScope,
        chars: Array.from(raw).length,
        truncated: slice.truncated,
        degraded,
      });
    },
    [extractChatContext]
  );


  /**
   * v0.15.4 需求9：读取**当下**的编辑器选区（PM 通道 / 源码 textarea 通道）。
   *
   * 为什么不用 `document.activeElement`：窗口焦点在对话输入框时，PM 的
   * `view.state.selection` 与 textarea 的 selectionStart/End **都还在**，
   * 只是 DOM 焦点挪走了。旧实现看到 activeElement 在对话框内就直接 return，
   * 于是「点过输入框之后在编辑器里选文本」永远不刷新 chip —— 正是用户报的 bug。
   * 这里直接读编辑器自身的选区状态，与焦点无关。
   */
  const readChatSelection = useCallback((): {
    mode: "pm" | "source";
    from: number;
    to: number;
    text: string;
  } => {
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view || view.isDestroyed) return { mode: "pm", from: 0, to: 0, text: "" };
      const { from, to } = view.state.selection;
      return {
        mode: "pm",
        from,
        to,
        text: from === to ? "" : (extractFromSelection(view)?.text ?? ""),
      };
    }
    if (isSourceMode) {
      const ta = sourceTextareaRef.current;
      if (!ta) return { mode: "source", from: 0, to: 0, text: "" };
      const from = ta.selectionStart;
      const to = ta.selectionEnd;
      return {
        mode: "source",
        from,
        to,
        text: to > from ? sourceContentRef.current.slice(from, to) : "",
      };
    }
    return { mode: "pm", from: 0, to: 0, text: "" };
  }, [viewMode, isMdFile, isSourceMode]);


  /**
   * v0.15.4 需求7：指令模板展开所需的两个变量值（按上下文上限截断后）。
   *
   * 指令库的 `{{selection}}` / `{{document}}` 由这里取"当下"的真实文本，
   * 而不是 chip 预览里的字数——展开后的指令要能直接发送。
   */
  const getChatContextValues = useCallback((): { selection: string; document: string } => {
    return {
      selection: truncateChatContext(extractChatContext("selection").raw, "selection").text,
      document: truncateChatContext(extractChatContext("document").raw, "document").text,
    };
  }, [extractChatContext]);


  /** 上次记录的选区签名（用于辨别"真实选区变化"；见 chatSelectionSignature） */
  const chatSelSigRef = useRef<string>("");


  /** 读取当下选区签名（"pm:from:to" / "source:from:to"；空选区统一为 "mode:"） */
  const currentChatSelectionSignature = useCallback((): string => {
    const sel = readChatSelection();
    return chatSelectionSignature(sel.mode, sel.from, sel.to);
  }, [readChatSelection]);


  /**
   * v0.7.5 功能1：AI 对话入口（底部栏「AI对话」/ Ctrl+K / 选区「问」气泡共用）。
   *
   * - 未打开：新建会话，默认上下文范围 = 有可用选区 → 选区；否则全文
   * - 已打开：**不重置会话**（避免顺手再按一次 Ctrl+K 把对话历史清空），
   *   仅展开折叠态、按当下选区刷新 chip 预览并把焦点交回输入框
   * - 总开关关闭 → toast 提示（修复体检报告 U1 的静默失败）
   * - 全文翻译运行中禁止（与 startAiAssist 同源约束，避免取消整篇翻译）
   */
  const startAiChat = useCallback(() => {
    if (!useSettingsStore.getState().aiEnabled) {
      notifyWarning(translate("ai.disabledNotify"));
      return;
    }
    if (useFullTranslateStore.getState().status === "running") {
      notifyWarning(translate("translate.fullRunningNotify"));
      return;
    }
    // v0.15.4 需求9：打开/复用会话时按**当下**选区算出范围，并进入「自动跟随」。
    // 打开那一刻没有可用选区 → 全文；之后编辑器里选区变化会由下方 effect 跟随。
    const defaultScope = resolveAutoFollowScope(
      hasUsableContext(extractChatContext("selection").raw)
    );

    const store = useAiChatStore.getState();
    if (store.open) {
      // 复用已开会话：展开 + 刷新预览 + 聚焦输入框。
      // 注意：再次按 Ctrl+K 视为「重新开始自动跟随」——用户的意图是"用当前选区"，
      // 不应被上一次的手动锁定挡住。
      if (store.minimized) store.toggleMinimize();
      store.setContextScopeWithAuto(defaultScope, true);
      chatSelSigRef.current = currentChatSelectionSignature();
      refreshChatPreview(defaultScope);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>(".ai-chat-input")?.focus();
      });
      return;
    }

    // 功能6：有窗口记忆且仍落在当前视口内 → 复原；越界（显示器变更）→ 回落默认居中
    const saved = useSettingsStore.getState().aiChatWindow;
    const rect = isAiChatRectVisible(saved, { width: window.innerWidth, height: window.innerHeight })
      ? saved
      : null;
    // 打开即自动跟随（第 4 参 autoFollow=true 是默认，显式写出便于阅读）
    store.openWindow(activeFileRef.current ?? null, rect, defaultScope, true);
    chatSelSigRef.current = currentChatSelectionSignature();
    refreshChatPreview(defaultScope);
  }, [extractChatContext, refreshChatPreview]);

  startAiChatRef.current = startAiChat;


  /**
   * v0.7.5 / v0.15.4 需求9：对话窗打开期间，编辑器选区变化时**自动跟随**并刷新 chip。
   *
   * 旧实现的三个问题（用户实测「选了文本也不生效」）：
   * 1. `if (active?.closest?.(".ai-chat-dialog")) return;` —— 点过输入框后焦点
   *    长期在窗内，这个分支会让选区变化**永远**不刷新。焦点在不在窗内与
   *    "编辑器有没有选区"是两件事：PM 的 `state.selection` 与 textarea 的
   *    selectionStart/End 都还在，直接读编辑器状态即可。现改为只跳过
   *    **窗内自己的选区**（用户拖选 AI 回答文本时 `document.getSelection()` 的
   *    anchorNode 落在 `.ai-chat-dialog` 里），那确实不是编辑器选区。
   * 2. 只刷新预览、不改范围 → chip 一直显示上次算出的范围。
   *    现在按 `planChatSelectionChange` 决策：真实选区变化 → 自动切「选区」；
   *    选区消失且处于自动跟随 → 回落全文；手动锁定则保持不动。
   * 3. v0.15.4：250ms 防抖，用户拖选时高频触发只落地最后一次。
   *
   * v0.15.5（用户实测「快速选中文字会经常失效，没有显示选区文字」）再修两处：
   *
   * ## 缺陷 A：`isSelectionInsideChatDialog()` 吞掉了真实选区变化
   *
   * v0.15.4 加的那个 guard 本意是忽略「拖选 AI 回答文本」，但它检查的是 **DOM 选区**。
   * 而「DOM 选区落在哪里」与「编辑器选区有没有变」是两件事：
   * 用户选完正文后**点一下对话输入框**（最常见的动作：选完就去打字），
   * DOM 选区立刻落进 `.ai-chat-dialog` 的 textarea → 下一次回调被 early return
   * → **已经选好的正文永远没被应用**，chip 停在「全文」。
   * 实机探针 `scripts/v0155-probe-quick-selection.mjs` 的 M3 场景 100% 复现：
   * 选中 16 字 → 点输入框 → chip 仍是「全文 4,773 字」。
   *
   * 正确判据是**编辑器自己的选区签名**：`readChatSelection()` 读 PM 的
   * `state.selection` / textarea 的 `selectionStart/End`，与焦点、与 DOM 选区无关。
   * 窗内拖选 AI 回答时编辑器签名**根本不变** → `planChatSelectionChange` 返回 null
   * （只刷新预览、不动范围），原语义自动保留，因此 guard 已删除。
   *
   * ## 缺陷 B：防抖让「手快」看不到反馈
   *
   * 拖选松手后要等 250ms 才更新，观感就是「没生效」。
   * 现在 `selectionchange` 用 120ms 短防抖（合并拖选过程中的连续事件），
   * 但**真实手势结束（mouseup / pointerup / keyup）立刻落地**，松手那一帧 chip 就跟随。
   */
  useEffect(() => {
    if (!chatOpen) return;
    // 打开瞬间先记录基线签名：此后只有**变化**才算真实选区变化
    chatSelSigRef.current = currentChatSelectionSignature();
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** 应用一次「编辑器选区 → chip」决策（唯一出口） */
    const applyDecision = () => {
      const store = useAiChatStore.getState();
      if (!store.open) return;
      const nextSig = currentChatSelectionSignature();
      const sel = readChatSelection();
      const hasSel = hasUsableContext(sel.text);
      const planned = planChatSelectionChange({
        prevSignature: chatSelSigRef.current,
        nextSignature: nextSig,
        hasSelection: hasSel,
      });
      chatSelSigRef.current = nextSig;
      // planned=null → 不是真实选区变化（光标移动 / 窗内拖选回答 / 同一选区的重复事件）：
      // 只刷新预览字数，绝不动用户手动锁定的范围
      if (planned === null) {
        refreshChatPreview(store.contextScope);
        return;
      }
      // 真实选区变化 → **解锁**并自动跟随。
      // 「手动点 chip 的锁定」只保持到下一次真实选区变化为止（用户口径），
      // 因此在锁定态下也要把 planned 应用下去，同时把 contextAuto 恢复为 true。
      if (planned !== store.contextScope || !store.contextAuto) {
        store.setContextScopeWithAuto(planned, true);
      }
      refreshChatPreview(planned);
    };

    const cancelPending = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    /** selectionchange 的短防抖：合并拖选过程中的高频事件 */
    const schedule = () => {
      cancelPending();
      timer = setTimeout(() => {
        timer = null;
        applyDecision();
      }, 120);
    };

    /** 真实手势结束 → 立刻落地，不等防抖（chip 松手即跟随） */
    const flush = () => {
      cancelPending();
      applyDecision();
    };

    document.addEventListener("selectionchange", schedule);
    // capture 阶段挂 window：确保先于其它 handler 跑，且覆盖整个文档的手势
    window.addEventListener("mouseup", flush, true);
    window.addEventListener("pointerup", flush, true);
    window.addEventListener("keyup", flush, true);
    // 源码通道兜底：部分 WebView2 版本里 textarea 的选区变化不一定派发 document
    // 级 selectionchange（保留兜底，不重复 flush）。
    const ta = sourceTextareaRef.current;
    ta?.addEventListener("select", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("mouseup", flush, true);
      window.removeEventListener("pointerup", flush, true);
      window.removeEventListener("keyup", flush, true);
      ta?.removeEventListener("select", schedule);
      cancelPending();
    };
  }, [chatOpen, refreshChatPreview, currentChatSelectionSignature, readChatSelection]);


  /**
   * v0.7.5：编辑模式切换时上下文来源通道随之改变（PM 选区 ↔ textarea 切片），
   * 立即刷新 chip 预览，避免显示上一模式的过期选区字数。
   *
   * v0.15.4 需求9：模式切换 = 选区通道切换，也算一次真实选区观测 ——
   * 自动跟随态下按新模式里的选区重新跟随（例如"源码模式选了文本 → 切阅读模式"）。
   * 同时更新签名，避免紧随其后的 selectionchange 把刚算好的范围又判成"变化"。
   */
  useEffect(() => {
    const store = useAiChatStore.getState();
    if (!store.open) return;
    chatSelSigRef.current = currentChatSelectionSignature();
    if (store.contextAuto) {
      const sel = readChatSelection();
      const followed = resolveAutoFollowScope(hasUsableContext(sel.text));
      if (followed !== store.contextScope) {
        store.setContextScopeWithAuto(followed, true);
        refreshChatPreview(followed);
        return;
      }
    }
    refreshChatPreview(store.contextScope);
  }, [viewMode, isSourceMode, isMdFile, refreshChatPreview, currentChatSelectionSignature, readChatSelection]);


  // v0.7.5：切换文件时作废对话窗（无路径新文件的 filePath 均为 null，无法区分归属，
  // 与 v0.7.4 AI 气泡同款兜底：宁可关闭也不跨文档串写内容）
  useEffect(() => {
    const st = useAiChatStore.getState();
    if (!st.open) return;
    if ((st.filePath ?? null) === (activeFileRef.current ?? null)) return;
    aiChatService.cancel().catch(() => undefined);
    aiChatSeqRef.current += 1;
    chatCtxRef.current = null;
    st.closeWindow();
  }, [forceUpdateKey]);


  // ─── v0.7.4 修复5：滚动时摘要锚点跟随选区 ──────────
  // 摘要锚点是触发时刻的屏幕坐标，滚动后选区在视口中的位置已变化，必须按
  // 文档位置（coordsAtPos / textarea 几何）重算。滚动事件高频 → rAF 节流，
  // 每帧至多一次重算；setAnchor 对坐标未变化的情况跳过通知（零重渲染）。
  useEffect(() => {
    const targets: HTMLElement[] = [];
    const container = editorRef.current;
    if (container) targets.push(container);
    const textarea = sourceTextareaRef.current;
    if (textarea) targets.push(textarea);
    if (targets.length === 0) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      const st = useAiAssistStore.getState();
      // 仅摘要气泡有锚点虚线；仅当前文档的气泡需要跟随
      if (st.status === "idle" || st.task !== "summary") return;
      if ((st.filePath ?? null) !== (activeFileRef.current ?? null)) return;
      const a = st.anchor;
      if (!a || (a.x === 0 && a.y === 0)) return; // 全文摘要无锚点
      const ctx = aiCtxRef.current;
      if (!ctx || ctx.insertPos === undefined) return;
      if (ctx.sourceMode === "source") {
        const ta = sourceTextareaRef.current;
        if (!ta) return;
        useAiAssistStore.getState().setAnchor(getTextareaSelectionAnchor(ta));
        return;
      }
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      // 位置越界（文档已被替换或编辑变短）时跳过，避免 coordsAtPos 抛错
      if (ctx.insertPos > view.state.doc.content.size) return;
      try {
        const c = view.coordsAtPos(ctx.insertPos);
        useAiAssistStore.getState().setAnchor({ x: c.left, y: c.bottom });
      } catch {
        /* 位置失效：忽略本次同步 */
      }
    };
    const handler = () => {
      if (raf) return; // 已有待执行帧：合并本次滚动
      raf = requestAnimationFrame(sync);
    };
    for (const el of targets) el.addEventListener("scroll", handler, { passive: true });
    return () => {
      for (const el of targets) el.removeEventListener("scroll", handler);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [viewMode, isSourceMode, forceUpdateKey]);


  // ghost 存在时：Tab 采纳（markdown 解析插入，失败降级纯文本）/ Esc 放弃（取消+清除）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ghostActiveRef.current) return;
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      const ghost = aiGhostKey.getState(view.state);
      if (!ghost || !ghost.text) return;
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        // v0.7.5 优化3：占位提示（续写中…）不是正文，不可采纳——消费掉本次 Tab
        // 但不插入，保持 ghost 存活等待真实增量（否则会把提示语写进文档）
        if (ghost.placeholder) return;
        ghostActiveRef.current = false;
        try {
          const frag = markdownToDoc(ghost.text).content;
          clearAiGhost(view);
          view.dispatch(view.state.tr.replace(ghost.pos, ghost.pos, new Slice(frag, 0, 0)));
        } catch {
          clearAiGhost(view);
          view.dispatch(view.state.tr.insertText(ghost.text, ghost.pos, ghost.pos));
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ghostActiveRef.current = false;
        aiAssistService.cancel().catch(() => undefined);
        clearAiGhost(view);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);


  // v0.7.3 改进10(U3)：离开源码模式 / 文件切换时清理 source ghost overlay
  // （防止 overlay 内容残留在切换到阅读模式后的 DOM 中）
  useEffect(() => {
    if (!isSourceMode) {
      sourceGhostActiveRef.current = false;
      const overlay = sourceGhostOverlayRef.current;
      if (overlay) overlay.innerHTML = "";
    }
  }, [isSourceMode, activeKeyRef.current]);


  /**
   * 全文翻译回写（一次性替换整篇文档）。
   * - preview+md：直接替换 PM doc（单事务，Ctrl+Z 可整体撤销）
   * - 任意模式：同步 sourceContent 与 App 层 content state，置脏
   * - v0.6.1 问题2：undoSnapshot 非空时记录原文快照（显示"取消翻译"气泡）
   */
  const applyFullTranslation = useCallback((newContent: string, undoSnapshot?: string) => {
    // v0.6.6 问题4：坐标归一化——输入可能来自全文翻译（真实内容）或
    // 选中翻译回写的快照（masked 坐标），先 unmask 统一为真实内容
    const realContent = unmaskBase64Images(newContent, base64TokensRef.current);
    // PM 模式直接替换 doc；设置 lastContentRef 防止 content effect 重复替换
    if (viewMode === "preview" && viewRef.current) {
      try {
        const view = viewRef.current;
        const newDoc = markdownToDoc(realContent);
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
        tr.setSelection(TextSelection.atStart(tr.doc));
        tr.setMeta("fileSwitch", true); // 整篇替换后滚动交由联动逻辑处理
        // v0.13.1 需求8：翻译回写是**同一个文件**的整篇重写（应用内有专门的
        // 「取消翻译」快照机制），不应作为一个可撤销的内容编辑步骤留在 PM 历史里；
        // 同样**不清空**历史栈。
        tr.setMeta("addToHistory", false);
        // v0.6.1 问题3：标记翻译回写中，onDocChange 据此抑制自动保存
        applyingTranslationRef.current = true;
        try {
          view.dispatch(tr);
        } finally {
          applyingTranslationRef.current = false;
        }
      } catch {
        // PM 解析失败：仍写入 sourceContent（切模式时同步），不阻断
      }
    }
    // 显示层 mask（无 base64 时零开销原样返回）；lastContentRef 存真实坐标
    const { text: masked } = maskBase64Images(realContent, base64TokensRef.current);
    setSourceContent(masked);
    sourceContentRef.current = masked;
    lastContentRef.current = realContent;
    // 出口统一 unmask：onContentChange 拿到的是真实内容（masked → realContent）
    onContentChangeRef.current?.(masked);
    setDirtyRef.current(true);
    // v0.6.1 问题3：全文翻译回写的修改不自动保存，等待用户手动保存或继续编辑
    useEditorStore.getState().setSuppressAutoSave(true);
    // v0.6.1 问题2：记录原文快照（undefined 表示不更新，如恢复原文场景）
    // v0.6.3 P0-2：快照绑定文档上下文（filePath/key），恢复前校验归属
    if (undoSnapshot !== undefined) {
      useEditorStore.getState().setTranslateUndoSnapshot({
        content: undoSnapshot,
        filePath: activeFileRef.current ?? null,
        key: activeKeyRef.current,
      });
    }
  }, [viewMode]);


  /**
   * v0.6.1 问题2：取消翻译 —— 用原文快照整体恢复文档。
   * 恢复的是原文（磁盘已知内容），不抑制自动保存；
   * 恢复后内容与最近磁盘同步一致时清除脏标记
   */
  const undoTranslation = useCallback(() => {
    const snap = useEditorStore.getState().translateUndoSnapshot;
    if (snap === null) return;
    // v0.7.4 问题4：归属判定只按 filePath（见 isTranslateSnapshotForFile）。
    // 旧实现额外要求 snap.key === activeKeyRef.current，但切标签会递增 forceUpdateKey，
    // 导致"全文翻译 → 切走 → 切回"后 key 必然变化，按钮可见却点击无效（快照被误清）。
    // 非当前文档的快照 → 拒绝恢复并清除，防止 A 文件原文灌进 B 文件。
    if (!isTranslateSnapshotForFile(snap, activeFileRef.current)) {
      useEditorStore.getState().setTranslateUndoSnapshot(null);
      useEditorStore.getState().setSuppressAutoSave(false);
      return;
    }
    const original = snap.content;
    // 恢复原文：不记录新快照（清除气泡）、解除自动保存抑制
    // v0.6.6 问题4：快照可能是 masked 坐标（选中翻译回写场景），
    // applyFullTranslation 内部归一化；与磁盘内容比较也需统一为真实坐标
    applyFullTranslation(original);
    useEditorStore.getState().setTranslateUndoSnapshot(null);
    useEditorStore.getState().setSuppressAutoSave(false);
    // 恢复后内容与最近磁盘内容一致 → 不再是脏状态
    if (unmaskBase64Images(original, base64TokensRef.current) === lastSyncDiskRef.current) {
      setDirtyRef.current(false);
      const { activeTabIdx } = useEditorStore.getState();
      useEditorStore.getState().updateTabDirty(activeTabIdx, false);
    }
  }, [applyFullTranslation]);


  // ─── v0.7.5 功能1/F5：AI 对话发送与结果动作回写 ─────────────────
  /**
   * 发送一条对话指令（对话框输入区提交）。
   *
   * 上下文在**发送这一刻**重新提取（窗口可能开了很久，选区/文档已变），
   * 同时记录「发送时快照」供动作回写与 DOC_CHANGED 校验使用（§2.4 决策）。
   * 历史只携带最近 3 轮且为"裸指令"，文档上下文仅挂在当前这条 user 消息上
   * （见 aiChatService 注释：避免每轮重复整篇文档导致 token 线性膨胀）。
   */
  const sendAiChat = useCallback(
    (instruction: string, templateId: string | null) => {
      const store = useAiChatStore.getState();
      if (!store.open) return;
      // v0.15.4 需求9：发送时按**这一刻**的选区重新判定范围。
      // 自动跟随状态下即使 250ms 防抖的 chip 还没刷新（用户刚选完就按 Enter），
      // 也绝不能"chip 显示全文、实际发选区"或反之。
      const selNow = readChatSelection();
      const hasSelNow = hasUsableContext(selNow.text);
      const scope = resolveChatSendScope(store.contextScope, store.contextAuto, hasSelNow);
      // 发送瞬间就是一次真实选区观测：同步签名，避免随后的 selectionchange
      // 把已发送的范围又"自动跟随"回旧状态
      chatSelSigRef.current = chatSelectionSignature(selNow.mode, selNow.from, selNow.to);
      if (scope !== store.contextScope) store.setContextScopeWithAuto(scope, store.contextAuto);

      let actualScope: AiChatContextScope = scope;
      let extracted = extractChatContext(scope);
      // 选区已丢失 → 降级为全文（与 chip 预览同规则）
      if (scope === "selection" && !hasUsableContext(extracted.raw)) {
        actualScope = "document";
        extracted = extractChatContext("document");
      }
      const context = truncateChatContext(extracted.raw, actualScope);
      const request = buildChatRequestMessages(store.messages, instruction, context);

      // ── 发送时快照（回写定位 + 全文守卫基准）──
      const view = viewRef.current;
      const ta = sourceTextareaRef.current;
      const isPm = extracted.sourceMode === "pm";
      let docSnapshot: string;
      try {
        docSnapshot =
          viewMode === "preview" && isMdFile && view
            ? getMarkdownFromDoc(view.state.doc)
            : unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
      } catch {
        docSnapshot = "";
      }
      chatCtxRef.current = {
        sourceMode: extracted.sourceMode,
        scope: actualScope,
        hadSelection: actualScope === "selection",
        selFrom: isPm && view ? view.state.selection.from : undefined,
        selTo: isPm && view ? view.state.selection.to : undefined,
        selDoc: isPm && view ? view.state.doc : undefined,
        srcStart: !isPm && ta ? ta.selectionStart : undefined,
        srcEnd: !isPm && ta ? ta.selectionEnd : undefined,
        // source 通道：记录发送时全文，供「替换选区」校验坐标有效性
        srcSnapshot: isPm ? undefined : sourceContentRef.current,
        insertPos: isPm ? view?.state.selection.to : ta?.selectionEnd,
        docSnapshot,
      };

      const meta = {
        hadSelection: actualScope === "selection",
        scope: actualScope,
        templateId,
      };
      store.appendUser(instruction, meta);
      // chip 预览同步为发送时的真实状态（含降级/截断）
      store.setContextPreview({
        scope,
        actualScope,
        chars: Array.from(extracted.raw).length,
        truncated: context.truncated,
        degraded: scope === "selection" && actualScope === "document",
      });

      const seq = ++aiChatSeqRef.current;
      aiChatService
        .send(request, (chunk) => {
          // 旧任务残余 chunk 不得写入新会话（取消为异步，在途消息可能到达）
          if (aiChatSeqRef.current !== seq) return;
          useAiChatStore.getState().appendChunk(chunk);
        })
        .then((result) => {
          if (aiChatSeqRef.current !== seq) return;
          useAiChatStore.getState().finish(result);
        })
        .catch((e) => {
          if (aiChatSeqRef.current !== seq) return;
          const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
          // CANCELLED 静默（用户已停止或新任务已接管）
          if (info.code === "CANCELLED") return;
          useAiChatStore.getState().fail(info.code, info.detail);
        });
    },
    [extractChatContext, readChatSelection, viewMode, isMdFile]
  );


  /** 停止对话流式任务（作废后续回调；半截回答不入历史，避免污染下一轮上下文） */
  const stopAiChat = useCallback(() => {
    aiChatSeqRef.current += 1;
    aiChatService.cancel().catch(() => undefined);
    useAiChatStore.getState().cancelStream();
  }, []);


  /** 重新生成最后一条回复（复用同一指令；上下文按当下重新提取） */
  const regenerateAiChat = useCallback(() => {
    const store = useAiChatStore.getState();
    if (!store.open) return;
    const ctx = store.regenerateContext();
    if (!ctx) return;
    const lastUser = store.messages[ctx.history.length];
    // 裁到"最后一条 user 之前"：sendAiChat 会把该指令重新 appendUser 并作为
    // 当前轮发送。若只裁掉 assistant（保留 user），历史里会重复出现同一指令。
    store.setMessages(ctx.history);
    sendAiChat(ctx.instruction, lastUser?.meta?.templateId ?? null);
  }, [sendAiChat]);


  /**
   * 结果动作：插入到光标处（发送时光标快照 clamp 后插入）。
   * PM 走 markdownToDoc 解析插入——```mermaid 围栏与 $$ 公式由此进入
   * mermaid-block / math-block 实时渲染管线，零额外渲染代码（本功能差异点）。
   */
  const chatInsertAtCursor = useCallback((text: string) => {
    if (!text.trim()) return;
    const ctx = chatCtxRef.current;
    if (ctx?.sourceMode === "source") {
      const content = sourceContentRef.current;
      const ta = sourceTextareaRef.current;
      const pos = Math.min(ctx.insertPos ?? ta?.selectionStart ?? content.length, content.length);
      const newContent = content.slice(0, pos) + text + content.slice(pos);
      // v0.15.1 需求6（再审计缺陷 2）：AI 对话「插入光标处」（源码通道）也是外部写回，
      // 不进时间线就会"撤不回 + 下次打字 force-rebase 静默清掉 redo"。
      recordDiscreteSourceEdit(content, newContent, pos, ta?.scrollTop ?? 0, pos + text.length);
      setSourceContent(newContent);
      onContentChangeRef.current?.(newContent);
      setDirtyRef.current(true);
      lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
      const cursor = pos + text.length;
      requestAnimationFrame(() => {
        const el = sourceTextareaRef.current;
        el?.focus();
        el?.setSelectionRange(cursor, cursor);
      });
      return;
    }
    const view = viewRef.current;
    if (!view || view.isDestroyed) return;
    // 位置可能因后续编辑漂移：clamp 到文档范围
    const pos = Math.min(ctx?.insertPos ?? view.state.selection.from, view.state.doc.content.size);
    try {
      const frag = markdownToDoc(text).content;
      view.dispatch(view.state.tr.replace(pos, pos, new Slice(frag, 0, 0)));
    } catch {
      view.dispatch(view.state.tr.insertText(text, pos, pos));
    }
    view.focus();
  }, []);


  /**
   * 结果动作：替换发送时的选区（快照位置；不使用"当前选区"，防错位 —— D1 教训）。
   * 回写前记录原文快照，支持 Esc / 「取消翻译」气泡整体恢复。
   */
  const chatReplaceSelection = useCallback((text: string) => {
    if (!text.trim()) return;
    const ctx = chatCtxRef.current;
    if (!ctx || !ctx.hadSelection) return;

    if (ctx.sourceMode === "pm") {
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      // 快照有效性：文档引用必须未变（变了则 from/to 语义已不可靠）。
      // 此处**拒绝而非降级用"当前选区"**——对话窗可能开了很久，用户当前选区
      // 往往在别处，退化路径会把回答写到错误的文字上（错位回写，D1 教训）。
      if (
        ctx.selFrom === undefined ||
        ctx.selTo === undefined ||
        !isPmSelectionSnapshotValid(ctx.selDoc, view.state.doc)
      ) {
        notifyWarning(translate("ai.chat.replaceSelectionMissing"));
        return;
      }
      let original: string | null = null;
      try {
        original = getMarkdownFromDoc(view.state.doc);
      } catch {
        original = null;
      }
      applyingTranslationRef.current = true;
      let ok = false;
      try {
        ok = applyTranslation(view, text, "replace", {
          from: ctx.selFrom,
          to: ctx.selTo,
          doc: ctx.selDoc,
        });
      } finally {
        applyingTranslationRef.current = false;
      }
      if (!ok) {
        // 结构失配（译文无法解析到该位置）→ 明确提示，用户可改用「插入光标处」
        notifyWarning(translate("ai.chat.replaceSelectionMissing"));
        return;
      }
      if (original !== null) {
        useEditorStore.getState().setTranslateUndoSnapshot({
          content: original,
          filePath: activeFileRef.current ?? null,
          key: activeKeyRef.current,
        });
      }
      return;
    }

    // source 通道：切片坐标仅在全文逐字未变时有效，否则拒绝（同上，防错位回写）
    if (ctx.srcStart === undefined || ctx.srcEnd === undefined) return;
    if (!isSourceSelectionSnapshotValid(ctx.srcSnapshot, sourceContentRef.current)) {
      notifyWarning(translate("ai.chat.replaceSelectionMissing"));
      return;
    }
    const rewrite = buildSourceRewrite(sourceContentRef.current, ctx.srcStart, ctx.srcEnd, text, "replace");
    if (!rewrite) return;
    const original = sourceContentRef.current;
    // v0.15.1 需求6（再审计缺陷 2）：AI 对话「替换选区」的源码回写同样进统一时间线。
    recordDiscreteSourceEdit(
      original,
      rewrite.content,
      ctx.srcStart,
      sourceTextareaRef.current?.scrollTop ?? 0,
      rewrite.cursor,
    );
    setSourceContent(rewrite.content);
    onContentChangeRef.current?.(rewrite.content);
    setDirtyRef.current(true);
    useEditorStore.getState().setSuppressAutoSave(true);
    lastContentRef.current = unmaskBase64Images(rewrite.content, base64TokensRef.current);
    useEditorStore.getState().setTranslateUndoSnapshot({
      content: original,
      filePath: activeFileRef.current ?? null,
      key: activeKeyRef.current,
    });
    requestAnimationFrame(() => {
      const el = sourceTextareaRef.current;
      el?.focus();
      el?.setSelectionRange(rewrite.cursor, rewrite.cursor);
    });
  }, []);


  /**
   * 结果动作：替换全文（复用全文翻译同款安全链）。
   * DOC_CHANGED 守卫：当前全文必须与**发送时快照**完全一致才允许整体替换，
   * 否则拒绝并提示（整篇替换会静默丢弃对话期间的用户编辑 —— v0.6.3 P0-3 同源）。
   */
  const chatReplaceDocument = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      const ctx = chatCtxRef.current;
      if (!ctx) return;
      let currentText: string | null;
      try {
        currentText =
          viewMode === "preview" && isMdFile && viewRef.current
            ? getMarkdownFromDoc(viewRef.current.state.doc)
            : unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
      } catch {
        currentText = null;
      }
      if (!canReplaceDocument(currentText, ctx.docSnapshot)) {
        notifyWarning(translate("ai.chat.docChanged"));
        return;
      }
      applyFullTranslation(text, ctx.docSnapshot);
    },
    [viewMode, isMdFile, applyFullTranslation]
  );


  /** 复制对话结果到剪贴板 */
  const chatCopy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);


  /**
   * 上下文范围切换（对话框 chip / 指令作用域联动触发）。
   *
   * v0.15.4 需求9：这里的调用一律视为**用户手动指定** → 锁定该范围。
   * 自动跟随产出的范围由 selectionchange effect 走 `setContextScopeWithAuto`，
   * 不经本入口，因此不会被误锁定。
   */
  const chatScopeChange = useCallback(
    (scope: AiChatContextScope) => {
      useAiChatStore.getState().setContextScope(scope);
      refreshChatPreview(scope);
    },
    [refreshChatPreview]
  );


  // ── v0.6.4 问题1c：失败段气泡 ──────────────────────────────
  // 翻译失败的段在内容首处以气泡提示（底部栏不再显示失败），5 秒后自动消失
  const [segmentFailTip, setSegmentFailTip] = useState<{ text: string; count: number } | null>(null);

  const segmentFailTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  /** 显示失败段气泡（重复调用重置计时；切文档/再次翻译时由调用方清除） */
  const showSegmentFailTip = useCallback((failedText: string, totalFailed: number) => {
    if (segmentFailTipTimerRef.current) clearTimeout(segmentFailTipTimerRef.current);
    setSegmentFailTip({ text: failedText, count: totalFailed });
    segmentFailTipTimerRef.current = setTimeout(() => setSegmentFailTip(null), 5000);
  }, []);


  /**
   * 全文翻译入口（悬浮按钮 / Shift+F6 / 命令面板统一走这里）。
   * 流程：取全文 → 切分 → 快照 → 逐段串行翻译（进度/取消）→ 一次性重组回写。
   * 失败安全：任何失败/中断/标签切换路径均不写入，原文零破坏。
   */
  const startFullTranslate = useCallback(() => {
    const ftStore = useFullTranslateStore.getState();
    // 运行中再次触发 = 取消
    if (ftStore.status === "running") {
      ftStore.requestCancel();
      translateService.cancel().catch(() => undefined);
      return;
    }
    if (!useSettingsStore.getState().translate.translateEnabled) return;
    if (!isMdFile) return; // 非 md 代码文件不支持全文翻译

    // 取当前全文内容（preview 走 PM 序列化；edit/split 走 sourceContent）
    // v0.6.6 问题4：sourceContent 是 masked 短标记坐标 → unmask 还原真实内容，
    // 保证版本快照、回写校验与译文重组都在真实坐标系进行
    let fullText: string;
    if (viewMode === "preview") {
      const view = viewRef.current;
      if (!view) return;
      try {
        fullText = getMarkdownFromDoc(view.state.doc);
      } catch {
        return;
      }
    } else {
      fullText = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
    }

    const units = splitDocumentForTranslation(fullText);
    if (units.length === 0) return; // 无可译内容（纯代码/空文档）静默返回

    // 快照先行（有文件路径时），支持从版本历史恢复原文
    // v0.6.3 P2-14：时间节流——同一文件 10 分钟内不重复记录翻译前快照，
    // 避免反复触发全文翻译把用户真实的版本历史挤掉（上限 5 条）
    if (
      filePath &&
      (lastTranslateSnapshotRef.current.path !== filePath ||
        Date.now() - lastTranslateSnapshotRef.current.at > TRANSLATE_SNAPSHOT_THROTTLE_MS)
    ) {
      lastTranslateSnapshotRef.current = { path: filePath, at: Date.now() };
      versionSnapshotService.recordSnapshot(filePath, fullText).catch(() => undefined);
    }

    // v0.6.3 P0-1：中止判断 = 任务启动上下文（闭包快照）vs 当前活跃上下文（latest-ref）。
    // 原实现拿闭包捕获值与启动时写入的 ref 比较，结构性恒 false，切标签后译文会写入错误文档
    ftStore.start(units.length);
    const shouldAbort = createContextAbortChecker(
      { filePath, key: forceUpdateKey ?? 0 },
      () => ({ filePath: activeFileRef.current, key: activeKeyRef.current }),
      () => useFullTranslateStore.getState().cancelRequested,
    );

    runFullTranslateLoop(units, {
      // v0.7.3 改进9(P4-2)：全文翻译并发 3 路提速。每段用 translateConcurrent
      // 注册独立并发槽位（互不取消，避免 translate() 的内部单任务 cancel 互相打断）；
      // task_id 含起点时间戳，跨轮次不冲突（begin_concurrent_task 同 id 会取消旧槽位）
      translateUnit: (text, index) =>
        translateService.translateConcurrent(
          text, // v0.7.4 修复：第一个参数是待译文本（旧代码把 concurrent_id 当 text 传入，
                // 导致后端实际翻译 "ft-xxx" 字符串，译文显示为 ft-xxx 占位行）
          `ft-${Date.now()}-${index ?? 0}`,
          () => undefined
        ),
      onProgress: () => useFullTranslateStore.getState().tick(),
      // v0.7.3 U6：每段开始时上报当前段，状态栏据此显示推进中的段落
      onSegmentStart: (unit) => useFullTranslateStore.getState().setSegment(unit.text),
      concurrency: 3,
      shouldAbort,
      errorCodeOf: (e) =>
        e instanceof TranslateServiceError ? e.info.code : parseTranslateError(e).code,
    }).then((outcome) => {
      const s = useFullTranslateStore.getState();
      if (outcome.cancelled) {
        s.reset();
        return;
      }
      if (outcome.errorCode) {
        s.fail(outcome.errorCode);
        return;
      }
      // 全部段落失败：视为整体失败（不写入）
      // v0.6.3 P1-5：上报真实错误码（如 RATE/AUTH），不再固定 STREAM 误导排查
      if (outcome.failedCount >= units.length) {
        s.fail(outcome.lastErrorCode ?? "STREAM");
        return;
      }
      // 写入前再次确认未发生标签切换
      if (shouldAbort()) {
        s.reset();
        return;
      }
      // v0.6.3 P0-3：回写前校验文档未被编辑——当前内容与启动时快照一致才允许整体回写，
      // 不一致则放弃回写（整篇替换会静默丢弃翻译期间的用户编辑）
      let currentText: string | null;
      try {
        if (viewMode === "preview" && viewRef.current) {
          currentText = getMarkdownFromDoc(viewRef.current.state.doc);
        } else {
          // v0.6.6 问题4：与 fullText 同坐标系（真实内容）比较
          currentText = unmaskBase64Images(sourceContentRef.current, base64TokensRef.current);
        }
      } catch {
        currentText = null;
      }
      if (currentText !== fullText) {
        s.fail("DOC_CHANGED");
        return;
      }
      const newContent = rebuildTranslatedDocument(fullText, units, outcome.translations);
      // v0.6.1 问题2：传入原文快照，回写后显示"取消翻译"气泡
      applyFullTranslation(newContent, fullText);
      s.finish(outcome.failedCount);
      // v0.6.4 问题1c：失败段在内容首处以气泡提示（底部栏不再显示失败）
      if (outcome.failedCount > 0) {
        const idx = outcome.translations.indexOf(null);
        const firstFailed = idx >= 0 ? units[idx] : null;
        showSegmentFailTip(firstFailed?.text ?? "", outcome.failedCount);
      }
    });
  }, [viewMode, isMdFile, filePath, forceUpdateKey, applyFullTranslation, showSegmentFailTip]);

  startFullTranslateRef.current = startFullTranslate;


  // v0.6.4 问题1b：切换文档时清除上一文档的翻译状态（done 提示/系统性错误/运行进度
  // 均不跨文档残留；运行中的任务由 shouldAbort 上下文检测中止）
  useEffect(() => {
    const s = useFullTranslateStore.getState();
    if (s.status !== "idle") s.reset();
    if (segmentFailTipTimerRef.current) clearTimeout(segmentFailTipTimerRef.current);
    setSegmentFailTip(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);


  // 全文翻译运行中：Esc 中断
  const fullTranslateRunning = useFullTranslateStore((s) => s.status === "running");

  useEffect(() => {
    if (!fullTranslateRunning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const s = useFullTranslateStore.getState();
        s.requestCancel();
        translateService.cancel().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullTranslateRunning]);


  // v0.6.2 问题2：翻译回写成功后（"取消翻译"气泡可见期间），Esc 恢复原文。
  // 翻译气泡打开时（status 非 idle）Esc 优先关闭气泡，不触发恢复原文
  const translateUndoSnapshot = useEditorStore((s) => s.translateUndoSnapshot);

  useEffect(() => {
    if (translateUndoSnapshot === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (useTranslateStore.getState().status !== "idle") return;
      // v0.7.4 问题4：只处理属于当前文档的快照——否则在其它文档按 Esc 会
      // 误清掉原文档保留的"取消翻译"状态（快照跨标签保留）
      if (!isTranslateSnapshotForFile(
        useEditorStore.getState().translateUndoSnapshot,
        activeFileRef.current,
      )) return;
      e.preventDefault();
      undoTranslation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [translateUndoSnapshot, undoTranslation]);


  // 监听命令面板/快捷键转发的 edit.translate 命令（App.tsx 派发，统一入口 startTranslate）
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (id === "edit.translate") startTranslateRef.current();
      // v0.6.1：全文翻译（Shift+F6 / 命令面板 / 悬浮按钮共用入口）
      if (id === "edit.translateDocument") startFullTranslateRef.current();
      // v0.7.0：AI 助手（StatusBar AI 抽屉入口：续写/润色/摘要）
      if (id === "ai.continue") startAiAssistRef.current("continue");
      if (id === "ai.polish") startAiAssistRef.current("polish");
      if (id === "ai.summary") startAiAssistRef.current("summary");
      // v0.7.5 功能1：AI 对话（底部栏「AI对话」/ Ctrl+K / 命令面板共用同一入口）
      if (id === "ai.chat") startAiChatRef.current();
      // v0.11.0 B3-1 返修：源码模式下命令面板的「正文（移除标题）」。
      // App.tsx 对该 id 在源码模式直接放行（见其注释），由这里复用源码模式的
      // 既有格式化入口 —— 与 Ctrl+0 同一条路径，真正移除行首 `#`。
      if (id === "format.paragraph") {
        const vm = useEditorStore.getState().viewMode;
        if (vm !== "preview") handleFormatAction.current("paragraph");
      }
      // v0.13.2 需求2：源码模式的 Ctrl+T（任务列表）。
      // App.tsx 对该 id 在源码模式直接放行，由这里走「把当前行提升为任务项」，
      // 与阅读模式 pmCommands 的语义一致（见 sourceFormat.liftListLineToTask）。
      if (id === "insert.taskList") {
        const vm = useEditorStore.getState().viewMode;
        if (vm !== "preview") handleFormatAction.current("taskListLift");
      }
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, []);

  return {
    handleAiApply,
    handleAiRetry,
    getChatContextValues,
    undoTranslation,
    sendAiChat,
    stopAiChat,
    regenerateAiChat,
    chatInsertAtCursor,
    chatReplaceSelection,
    chatReplaceDocument,
    chatCopy,
    chatScopeChange,
    segmentFailTip,
    fullTranslateRunning
  };
}
