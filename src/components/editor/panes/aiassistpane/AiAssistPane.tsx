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
} from "../../EditorContainer";
import type { AiAssistPaneParams, AiAssistPaneResult } from "./types";

export function useAiAssistPane(p: AiAssistPaneParams): AiAssistPaneResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    sourceSurface,
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


  // ─── v0.12.1 需求4：textarea 自动配对的输入路径（beforeinput / compositionend）───
  //
  // 为什么用 beforeinput 而不是 keydown：
  //  · keydown 能拿到按键但拿不到"本次究竟插入了什么字符"，且组合输入提交的中文标点
  //    没有可用的单字符 keydown（Chromium 走 composition 路径，实测 key=Process/keyCode=229）；
  //  · beforeinput（inputType=insertText、isComposing=false）是**插入前**唯一可靠的钩子，
  //    在这里 preventDefault + execCommand 落地补全，用户只看到最终 `()`，无中间态。
  //  · 组合提交（compositionend 是这一串事件的**最后一个**，实测顺序：
  //    beforeinput(isComposing=true) → input → compositionend）无法在插入前拦截，
  //    故提交后用 rAF 做一次"补闭符号"的补救——即需求里的"等组合提交后再处理"。
  //
  // 与旧实现的关系：旧实现把补全放在 keydown 里（PAIR_MAP[key]），中文标点依赖
  // IME 恰好派发单字符 keydown，属偶然可用；现在两条路径都由 sourceAutoPair 规划器裁决。
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
      sourceSurface.applyEdit(plan);
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
        sourceSurface.applyEdit(plan);
      });
    };

    ta.addEventListener("beforeinput", onBeforeInput);
    ta.addEventListener("compositionend", onCompositionEnd);
    return () => {
      ta.removeEventListener("beforeinput", onBeforeInput);
      ta.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [isSourceMode, isMdFile]);


  // ─── v0.6.0：AI 翻译入口接线 ────────────────────
  /** 当前翻译任务上下文（原文/来源通道/textarea 选区位置；重试与回写用） */
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

  // v0.7.3 D2：翻译任务序号守卫（与 AI 助手 aiSeqRef 同款）——
  // 旧任务 promise 完成/失败时若序号已变则丢弃，防止旧译文写入新任务气泡
  const translateSeqRef = useRef(0);

  const handleTranslateApplyRef = useRef<(mode: "replace" | "bilingual", translated: string) => void>(() => {});

  // v0.7.0 修复1：选区「译」浮动按钮右键菜单位置（null=关闭）
  // 插件 contextmenu 回调经 ref 转发（createEditor 仅初始化一次，避免闭包过期）
  const [triggerMenuPos, setTriggerMenuPos] = useState<{ x: number; y: number } | null>(null);

  triggerMenuPosRef.current = (x, y) => setTriggerMenuPos({ x, y });

  // v0.7.4 功能7 / v0.7.5 功能2：任一 AI 气泡（续/润/摘/问）右键菜单位置 + 目标任务
  // （null 位置 = 关闭；task 用于「隐藏『X』气泡」动态文案与独立隐藏）
  const [aiMenuPos, setAiMenuPos] = useState<{
    x: number;
    y: number;
    task: AiAssistTask | null;
  } | null>(null);

  aiMenuPosRef.current = (x, y, task) => setAiMenuPos({ x, y, task });

  /** 右键菜单动作后立即隐藏已显示的浮动按钮（设置变化不触发 PM 重渲染，需主动 dispatch） */
  const hideTranslateTrigger = useCallback(() => {
    const view = viewRef.current;
    if (view && !view.isDestroyed) {
      view.dispatch(view.state.tr.setMeta(translateTooltipKey, false));
    }
  }, []);


  // v0.6.3 P0-1/P0-2：当前活跃文档上下文（latest-ref，每次渲染刷新）。
  // - 全文翻译 shouldAbort 用「任务启动闭包快照 vs 此 ref」检测标签切换
  // - 翻译撤销快照的写入/校验用它读写当前 filePath/forceUpdateKey
  //   （handleTranslateApply 等空依赖 useCallback 拿不到最新 props，必须走 ref）
  const activeFileRef = useRef<string | null | undefined>(undefined);

  activeFileRef.current = filePath;


  // ─── v0.8.3 WP4 需求6：浏览进度的独立键 ──────────────────────
  // activeFileRef 的语义是"当前文档的真实磁盘路径"（AI 上下文归属 / 翻译快照
  // 归属判断依赖它，临时文档恒为 null），**不能**被改写成 tab 键。
  // 浏览进度需要按"标签"维度记录（临时标签也要能记住位置），故新增独立 ref：
  // 真实文件 = path，临时标签 = "untitled:<id>"（见 utils/tabKey.ts 单源）。
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


  /**
   * v0.14.0 需求2：搜索面板用的「当前文档稳定键」。
   *
   * 与 `currentDocKeyFromStore()` 同口径（真实文件 = 路径 / 临时标签 = `untitled:<id>`），
   * 但**走 React 派生**而不是 store 快照：搜索面板在渲染期就需要这个值，
   * 直接读 store 会拿到与本次渲染不同步的值（切标签时 setActiveTab 与 setContent
   * 是两次 setState，面板可能先用新 key 渲染、内容却还是旧的）。
   */
  const currentDocKey = useCallback((): string | null => {
    const st = useEditorStore.getState();
    const tab = st.openTabs[st.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? st.activeTabIdx}`
      : tab.path || null;
  }, []);


  /**
   * v0.14.0 需求5（补充说明）：搜索结果条幅的「跳到别的文件」由 App 层切标签
   * （见 App.tsx 的 SEARCH_JUMP_EVENT 监听）。
   *
   * 为什么不在本组件里切：切标签要同步 filePath / content / 语言 / forceUpdateKey
   * / 撤销历史，这些逻辑只在 App.handleTabSwitch 一处维护；在这里重复实现必然漏项。
   * 本组件只负责「切过来之后」的事：SearchReplace 自己的 effect 会
   * `takeSearchJump(docKey)` 取走目标并定位/高亮（同一实例跨标签常驻，docKey 变化即触发）。
   */

  /** 执行翻译任务：打开气泡 → 流式调用 → finish/fail；resultMode 非 bubble 时自动应用结果 */
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


  /**
   * 翻译触发入口（右键菜单 / F6 / 命令面板 / PM 选区浮动按钮统一走这里）。
   * 总开关关闭时所有入口静默返回。
   * 按当前模式选择提取通道：
   * - preview+md：PM 选区（Markdown 结构保真，可回写）
   * - edit/split：textarea 选区（Markdown 源码直接回写）
   * - split 且 textarea 无选区：iframe 预览选区（纯文本，仅复制）
   * - preview+非 md：DOM 选区（纯文本，仅复制）
   * v0.6.2 问题3：fallbackToFull=true 时（「译」按钮入口），所有通道均无有效选区
   * 则回退到全文翻译（非 md 文件全文翻译不支持，静默返回）
   */
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
      /**
       * v0.17.0 A2 收敛：选区两端是纯值 → 经 surface；
       * 但 `getTextareaSelectionAnchor(textarea)` **需要真实 textarea 度量**（判据 1），
       * 因此该调用仍传 ref 元素（CM6 下由 A3 换成 coordsAtPos）。
       */
      const tsel = sourceSurface.getSelection();
      if (tsel.start !== tsel.end) {
        const textarea = sourceTextareaRef.current;
        const text = sourceContentRef.current.slice(tsel.start, tsel.end);
        if (text.trim() && textarea) {
          runTranslate(text, "source", getTextareaSelectionAnchor(textarea), tsel.start, tsel.end);
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


  /** 译文回写：pm 通道走 translateBridge（replace 失败降级 bilingual）；source 通道走 buildSourceRewrite */
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
      // 光标移到译文末尾并聚焦（v0.17.0 A2 收敛：纯值语义 → 经 surface）
      requestAnimationFrame(() => {
        sourceSurface.focus();
        sourceSurface.setSelection(rewrite.cursor, rewrite.cursor);
      });
    }
  }, []);

  handleTranslateApplyRef.current = handleTranslateApply;


  /** 复制译文到剪贴板 */
  const handleTranslateCopy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);


  /** 重试上次翻译（复用任务上下文的原文与来源通道，锚点取当前气泡位置） */
  const handleTranslateRetry = useCallback(() => {
    const ctx = translateCtxRef.current;
    if (!ctx) return;
    const anchor = useTranslateStore.getState().anchor ?? ctx.anchor;
    runTranslate(ctx.text, ctx.sourceMode, anchor, ctx.start, ctx.end);
  }, [runTranslate]);


  // ─── v0.7.0：AI 助手接线（续写 ghost / 润色 / 摘要气泡）─────────
  /** AI 助手任务上下文（重试与应用结果用；start/end 为 source 通道选区，insertPos 为续写/摘要插入点） */
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

  /** 任务序号：新任务自动取消旧任务时，旧 promise 的 finish/fail 不得污染新任务状态 */
  const aiSeqRef = useRef(0);

  /** ghost 续写活跃标记（用户编辑致 ghost 失效 / 采纳 / 放弃后置 false，停止流式更新） */
  const ghostActiveRef = useRef(false);


  // v0.7.3 改进10(U3)：source 模式续写 ghost 对齐——
  // textarea 上层叠加 ghost overlay（样式与 textarea 完全同步），续写在光标处
  // 显示灰斜体预览，Tab 采纳 / Esc 放弃，与 PM 模式 ghost 手势一致。
  /** source ghost overlay DOM 引用 */
  const sourceGhostOverlayRef = useRef<HTMLDivElement>(null);

  /** v0.7.5 优化3：source ghost 是否处于"续写中…"占位态（占位不可采纳） */
  const sourceGhostPlaceholderRef = useRef(false);

  /** source 续写累积 ghost 文本 */
  const sourceGhostTextRef = useRef("");

  /** source 续写插入点（发起任务时光标位置；与 PM 的 ghost.pos 语义一致） */
  const sourceGhostPosRef = useRef(0);


  /** 执行气泡型 AI 任务（润色/摘要/源码续写）：openBubble → 流式 → finish/fail */
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


  /** 执行 ghost 续写（PM 阅读模式）：流式 setAiGhost，完成后保留 ghost 等待 Tab 采纳 / Esc 放弃 */
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


  // ─── v0.7.3 改进10(U3)：source 模式续写 ghost 对齐 ────────
  // 目标：让 edit/split（textarea）模式的续写与 PM 模式统一为"光标处 ghost 预览，
  // Tab 采纳 / Esc 放弃"，替代原来的"气泡渲染 + 点按钮插入"。
  // 实现：在 textarea 上层叠加一个 .source-ghost-overlay div，样式与 textarea
  // 完全同构（syncTextareaMetrics），透明复刻全文保证换行对齐，仅在插入点
  // 显示灰斜体 ghost 片断。Tab 采纳即把 ghost 文本插入光标处。

  /** 渲染 source ghost overlay（同步样式 + 写入当前累积文本） */
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


  /** 清除 source ghost overlay */
  const clearSourceGhost = useCallback(() => {
    const overlay = sourceGhostOverlayRef.current;
    if (overlay) overlay.innerHTML = "";
    sourceGhostActiveRef.current = false;
    sourceGhostPlaceholderRef.current = false;
    sourceGhostTextRef.current = "";
  }, []);


  /**
   * v0.12.0 需求1：渲染格式 ghost（占位提示）到 overlay；AI ghost 活跃时让位不渲染。
   * 返修：基于插入时的全文快照（ghost.content）渲染，保证 ghost 一定落在格式符中间；
   * textarea 当前值与快照不一致（用户已编辑/撤销）时自清除，防幽灵内容错位残留。
   */
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


  /** v0.12.0 需求1：按清除时机判定清除格式 ghost（kind 见 shouldClearFormatGhost） */
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


  /**
   * v0.12.0 需求1 返修④：退格删除整个格式符。
   * ghost 活跃且光标仍停在插入点时按 Backspace → 整段删除本次插入的语法符号
   * （如 `****`/`- [ ] `），光标回到插入前位置；删除本身推入撤销栈，Ctrl+Z 可恢复。
   */
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
    // v0.17.0 A2 收敛：纯值语义（光标 + 滚动）→ 经 surface
    const restore = () => {
      sourceSurface.focus();
      sourceSurface.setSelection(caret, caret);
      sourceSurface.setScrollTop(scrollTop);
    };
    requestAnimationFrame(restore);
    return true;
  }, [recordDiscreteSourceEdit]);

  formatGhostHandlersRef.current = { render: renderFormatGhost, clear: clearFormatGhost, remove: removeFormatGhostSyntax };


  // v0.12.0 需求1：切文件 / 切模式时清除格式 ghost（防跨文档、跨模式残留）
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
