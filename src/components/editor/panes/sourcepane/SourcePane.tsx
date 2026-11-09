/**
 * src/components/editor/panes/SourcePane/SourcePane.tsx —— SourcePane pane
 *
 * ## 职责边界
 *
 * 源码面输入链路（textarea 变更/按键/粘贴/斜杠插入/打字机/专注遮罩）
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 2951-3994 行。
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
  useRef,
  useCallback,
  useState,
  useEffect,
} from "react";
import { hasRawBase64Image, maskBase64Images, adjustCursorForMask, unmaskBase64Images } from "../../../../utils/base64ImageMask";
import { inferSourceEditKind } from "../../../../editorHistory/sourceAdapter";
import { documentHistory } from "../../../../services/documentHistory";
import { useEditorStore } from "../../../../stores/useEditorStore";
import { calculateWordCount } from "../../../../utils/wordCount";
import { findSlashTrigger, isInCodeBlock, InsertMode } from "../.././SlashCommand";
import { ContentAnchor, collectPmBlockGeometry, restoreContentAnchor, captureContentAnchor } from "../../../../utils/contentScrollMap";
import { withTrailingParagraph } from "../../../../core/plugins/trailing-paragraph";
import { markdownToDoc } from "../../../../core/markdown/parser";
import { captureTextAnchor, restoreTextAnchor } from "../../../../utils/viewportAnchor";
import { remapOffsetAcrossTextChange, decideSourceScrollRestore } from "../../../../utils/textOffsetRemap";
import { Slice } from "prosemirror-model";
import { useFormatPainterStore } from "../../../../stores/useFormatPainterStore";
import { resolveImageSrc } from "../../../../utils/imagePath";
import { anchorMatchesHeading, resolveLinkAction } from "../../../../utils/linkNav";
import { openExternalHref } from "../../../../utils/openExternal";
import { removeLinePrefix as removeLinePrefixFn, liftListLineToTask as liftListLineToTaskFn, getHeadingPrefix, setLinePrefix as setLinePrefixFn, getLineRange, HEADING_GHOST_TEXTS, buildFormatReplacement, computeGhostTail, parseShortcut } from "../.././sourceFormat";
import { isHttpUrl } from "../../../../core/plugins/smart-paste";
import { planSourceTab, planSourceBackspace } from "../../../../utils/sourceAutoPair";
import { indentUnitString, useSettingsStore } from "../../../../stores/useSettingsStore";
import { planSourceOutdent, planSourceIndent } from "../../../../utils/sourceIndent";
import type { EditorView as EditorView } from "prosemirror-view";
import type { HistoryCoordinator as HistoryCoordinator } from "../../../../editorHistory/coordinator";
import {
  HistoryEntry,
  traceScroll,
  computeSlashInsert,
  buildSourcePairInput,
} from "../../EditorContainer";
import type { SourcePaneParams, SourcePaneResult } from "./types";

export function useSourcePane(p: SourcePaneParams): SourcePaneResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    sourceSurface,
    pendingSourceSelectionRef,
    sourceSelectionRestoreTokenRef,
    sourceGhostHandlersRef,
    formatGhostHandlersRef,
    base64TokensRef,
    sourceContentRef,
    sourceAdapterRef,
    sourceComposingRef,
    sourceJustPairedRef,
    sourceJustPastedRef,
    lastSourceScrollTopRef,
    historyCoordinatorRef,
    historyDocKeyOrEmpty,
    lastRealTextRef,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    lastTextareaCursorRef,
    wordCountTimerRef,
    setWordCountRef,
    editorRef,
    applyHistoryTextRef,
    viewMode,
    isMdFile,
    viewRef,
    historyScrollGuardUntilRef,
    HISTORY_SCROLL_GUARD_MS,
    sourceTextareaRef,
    pushUndoEntry,
    recordDiscreteSourceEdit,
    filePath,
    formatGhostRef,
    isSourceMode,
    autoPairEnabled,
    sourceGhostActiveRef,
  } = p;


  // ─── 源码编辑内容变化 ──────────────────────────
  const handleSourceChange = useRef((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // v0.15.1 需求1：真实用户输入 = 选区保护窗立即失效（否则撤销后的光标还原
    // 会跟用户的输入抢光标）。
    pendingSourceSelectionRef.current = null;
    // v0.15.1 需求6（再审计缺陷 1）：连带让撤销时排下的 rAF / 60ms 兜底定时器退场，
    // 否则它们会在 250ms 后把光标抢回撤销位置（实测：输入后 selectionStart 9 → 又被拽回 8）。
    sourceSelectionRestoreTokenRef.current++;
    // v0.7.3 改进10(U3)：任何用户编辑（含自动配对/粘贴/撤销）都会使 source
    // 续写 ghost 位置语义失效——取消任务并清除 overlay（与 PM 模式 docChanged 失效一致）
    sourceGhostHandlersRef.current.invalidate();
    // v0.12.0 需求1：任何真实输入使格式 ghost 完成使命（键入即替换占位提示）
    formatGhostHandlersRef.current.clear("input");
    const textarea = e.target;
    let newContent = textarea.value;
    let cursorPos = textarea.selectionStart;
    // v0.6.6 问题4：粘贴/输入 base64 图片 → 实时替换为短标记并补偿光标
    if (hasRawBase64Image(newContent)) {
      const { text: masked, replacements } = maskBase64Images(newContent, base64TokensRef.current);
      if (replacements.length > 0) {
        cursorPos = adjustCursorForMask(cursorPos, replacements);
        newContent = masked;
        // 受控组件：直接同步 DOM value 与光标（React setState 相同值不重渲染）
        textarea.value = masked;
        textarea.setSelectionRange(cursorPos, cursorPos);
      }
    }
    // v0.15.0 需求（跨模式撤销统一）：源码编辑改由 sourceAdapter 归并后提交到**统一时间线**。
    // 旧 `recordUndoEntry`（diff 栈）退休——它与阅读模式的 PM 栈物理隔离，正是"跨模式撤不掉"
    // 的根因。adapter 负责把连续打字/退格合并成一步（900ms 窗口、光标连续），
    // 并把 IME / 自动配对 / 粘贴各自成组。
    //
    // ⚠️ 时间线只存**真实内容**：`sourceContentRef` 是 base64 mask 后的展示文本，
    // 必须 unmask 后再提交，否则一次撤销会把 data URL 永久退化成 `image-1.png`（存盘即损坏）。
    {
      const beforeReal = unmaskBase64Images(
        sourceContentRef.current,
        base64TokensRef.current,
      );
      const afterReal = unmaskBase64Images(newContent, base64TokensRef.current);
      /**
       * v0.17.0 A2（修复 C14 第一处）：**输入意图由事件源头判定**，不再靠文本形状猜。
       *
       * 旧实现把 `composing/justPaired/justPasted` 三个一次性标记喂给
       * `inferSourceEditKind`，但这三个标记在原文件里**从未被置 true**（P0 实测确认：
       * 3 处声明、3 处读取、2 处清零，零处置位），所以真正生效的只有它末尾那条
       * "长度变短 → delete，否则 typing" 的猜测 —— 于是 IME/配对/粘贴三类
       * "一步归并"从未生效，一次拼音会拆成多步、一次补全会和后续打字合并。
       *
       * 现在：
       * - IME 直接取原生事件 `isComposing`（composition 期间的 input 事件必为 true），
       *   这是**源头事实**，比任何事后推断都可靠；
       * - 配对/粘贴取落地路径与 DOM 事件处置位（见上方 justPaired/justPasted 的赋值）；
       * - 只有三者都不是时才退回 `inferSourceEditKind`（此时它只剩 delete/typing 判定，
       *   那两条本来就是合法规则，不是猜测）。
       */
      // `nativeEvent` 的静态类型是 Event，但 React 的合成事件在这里一定是 InputEvent
      // （textarea 的 onChange 对应原生 input 事件），InputEvent 有 isComposing。
      const nativeComposing = !!(e.nativeEvent as InputEvent | undefined)?.isComposing;
      const plan = sourceAdapterRef.current.plan({
        before: beforeReal,
        text: afterReal,
        kind: inferSourceEditKind({
          before: beforeReal,
          after: afterReal,
          composing: nativeComposing || sourceComposingRef.current,
          justPaired: sourceJustPairedRef.current,
          justPasted: sourceJustPastedRef.current,
        }),
        selection: { start: cursorPos, end: cursorPos, scrollTop: textarea.scrollTop },
        // v0.15.1 需求1：把**编辑前**的现场也带上（撤销要回到这里）。
        // 光标取"上一次已知光标 + 本次长度增量"反推（onChange 触发时 DOM 选区已在新位置）；
        // 滚动取上一帧记录的 scrollTop（同一行打字时它不变，跨行回车时它才是对的旧值）。
        beforeSelection: {
          start: Math.max(0, cursorPos - (afterReal.length - beforeReal.length)),
          end: Math.max(0, cursorPos - (afterReal.length - beforeReal.length)),
          scrollTop: lastSourceScrollTopRef.current,
        },
      });
      // 三个一次性标记消费后复位：它们只描述"刚刚发生的那一次输入"
      sourceJustPairedRef.current = false;
      sourceJustPastedRef.current = false;
      if (plan) historyCoordinatorRef.current?.commitFromSource(plan);
      else if (beforeReal !== afterReal) {
        // adapter 认为不需要新条目（例如仍是同一组连续输入）→ 只推进时间线基线，
        // 保证下一条 commit 的 before 与宿主逐字节一致（否则会被 commit 拒绝）。
        const key = historyDocKeyOrEmpty();
        if (key) documentHistory.rebaseText(key, afterReal);
      }
      lastRealTextRef.current = afterReal;
    }
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.1 问题3：用户手动编辑恢复正常自动保存（解除翻译回写抑制）
    useEditorStore.getState().setSuppressAutoSave(false);
    // v0.6.1 问题2：用户手动编辑后原文快照失效，清除"取消翻译"气泡
    useEditorStore.getState().setTranslateUndoSnapshot(null);
    // lastContentRef 与 content prop 同为真实坐标（出口 unmask 后的值），
    // 保证行 551 的相等检查不会因坐标系不同而误触发 PM 全量重建
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);
    lastTextareaCursorRef.current = cursorPos;

    // G11：源码模式下更新字数统计（防抖 300ms，与 ProseMirror 模式一致）
    if (wordCountTimerRef.current) clearTimeout(wordCountTimerRef.current);
    wordCountTimerRef.current = setTimeout(() => setWordCountRef.current(calculateWordCount(newContent)), 300);

    // SlashCommand 触发检测：行首 / 且不在代码块内
    // 后续 query 更新和失效关闭由 SlashCommand 组件内部监听 input 处理
    const trigger = findSlashTrigger(newContent, cursorPos);
    if (trigger.trigger && !isInCodeBlock(newContent, cursorPos)) {
      setSlashCommandOpen(true);
    }
  });


  /**
   * v0.15.1 需求1：撤销/恢复落地后**保住阅读面的滚动位置**。
   *
   * 缺陷（用户原话「进行撤销时候文档会滚动底」）：撤销把整篇 doc `replaceWith` 成更短的
   * 内容后，`scrollHeight` 立刻变小 → 浏览器把 `scrollTop` 钳到**新的 max**（= 底部），
   * 而 `editor.ts` 的 dispatchTransaction 里那段"保存/恢复 scrollTop"也会被同一个钳位
   * 打回（它写的是旧像素值，超过新 max 就被钳到 max）。
   * 结果：撤销一次，视口就贴到底。
   *
   * 修法：**锚内容不锚像素**。撤销前采「视口中央是哪个块 + 块内比例」，落地后按新几何
   * 反算 scrollTop；块表在异步布局（图片/mermaid 撑高）里会变，故 0/60/160ms 各校正一次，
   * 用户一旦自己滚了就停手（`userScrolled` 判据用输入事件，不用 scrollTop 差值 ——
   * 浏览器钳位会被误判成用户操作，见语义地图 §4-31）。
   *
   * @returns 一个"落地后调用"的还原函数（撤销前先调 `capturePreviewScrollAnchor`）
   */
  const restorePreviewScrollFromAnchor = (
    anchor: ContentAnchor | null,
    userScrolledRef: { current: boolean },
  ): void => {
    if (!anchor) return;
    const apply = () => {
      if (userScrolledRef.current) return;
      const container = editorRef.current;
      if (!container || container.clientHeight <= 0) return;
      const blocks = collectPmBlockGeometry(container);
      if (!blocks) return;
      const top = restoreContentAnchor(blocks, anchor, container.clientHeight, {
        contentHeight: container.scrollHeight,
      });
      if (top === null) return; // 映射不到就放弃（绝不写 0）
      container.scrollTop = top;
    };
    requestAnimationFrame(() => {
      apply();
      // 图片 / mermaid / katex 异步撑高会改块几何，短窗口内再校正两次
      window.setTimeout(apply, 60);
      window.setTimeout(apply, 160);
    });
  };


  /** 撤销前采集阅读面滚动锚点（阅读面此刻可见，几何可信） */
  const capturePreviewScrollAnchor = (): ContentAnchor | null => {
    const container = editorRef.current;
    if (!container || container.clientHeight <= 0) return null;
    const blocks = collectPmBlockGeometry(container);
    if (!blocks) return null;
    return captureContentAnchor(blocks, container.scrollTop, container.clientHeight, {
      contentHeight: container.scrollHeight,
    });
  };


  /**
   * v0.15.0 需求（跨模式撤销统一）：把时间线条目的目标文本**写回宿主**。
   *
   * 这是 coordinator 唯一的落地通道（通过 `applyHistoryTextRef` 注入），必须保证：
   * - 阅读模式：整篇 replaceWith 的 bridge 事务带 `addToHistory:false` + `historyBridge:true`，
   *   否则 pmAdapter 会把"撤销动作本身"当成新编辑再记一条 → 一次按键双撤销/来回弹；
   * - 源码模式：写 `setSourceContent` + `sourceContentRef` + 上层通知，并按 selection 恢复光标；
   * - 两条路径都**不得**再走旧 `pushUndoEntry/recordUndoEntry`（已退休）。
   */
  applyHistoryTextRef.current = (text, restore, meta) => {
    const bridgeMeta = meta as { bridge?: boolean; direction?: "undo" | "redo" } | undefined;
    const isBridge = bridgeMeta?.bridge === true;
    if (viewMode === "preview" && isMdFile) {
      const view = viewRef.current;
      if (!view || view.isDestroyed) return;
      // v0.15.1 需求1：撤销前先记「视口中央是哪块内容」，落地后按新几何还原。
      // 必须在 dispatch 之前采（dispatch 后 doc 已换、几何已变）。
      const scrollAnchor = capturePreviewScrollAnchor();
      /**
       * v0.15.4 需求10：进入**撤销滚动窗口**。
       *
       * 打开窗口后，`.ProseMirror` 的 keyup 处理器不再调用 `scrollToVisible()` /
       * `scrollToCenter()`（用户只按了 Ctrl+Z，不该触发"把光标滚进视口"）；
       * 窗口内的视口位置由下面 `restorePreviewScrollFromAnchor` 的内容锚点统一负责。
       * 不开窗口的后果（实测）：锚点先把视口放对 → keyup 把视口推到光标（+3448px）
       * → 60ms 后锚点拉回（−3448px）= 用户看到的「撤销时文档抖一下」。
       */
      historyScrollGuardUntilRef.current = performance.now() + HISTORY_SCROLL_GUARD_MS;
      const userScrolledRef = { current: false };
      const markUserScrolled = () => {
        userScrolledRef.current = true;
      };
      const container = editorRef.current;
      // 用户接管判据：**输入事件**（wheel/pointerdown/touchstart/滚动键），排除修饰键
      // —— 浏览器钳位产生的 scroll 事件不能算用户操作。
      const onWheel = () => markUserScrolled();
      const onPointer = () => markUserScrolled();
      const onKey = (e: KeyboardEvent) => {
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown|ArrowLeft|ArrowRight| )$/.test(e.key)) {
          markUserScrolled();
        }
      };
      container?.addEventListener("wheel", onWheel, { passive: true });
      container?.addEventListener("pointerdown", onPointer, { passive: true });
      container?.addEventListener("touchstart", onPointer, { passive: true });
      window.addEventListener("keydown", onKey, true);
      try {
        const newDoc = withTrailingParagraph(markdownToDoc(text));
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
        // 🔴 关键：撤销动作的落地不进 PM 历史；只用 historyBridge 标记让 pmAdapter 忽略整批
        tr.setMeta("addToHistory", false);
        if (isBridge) tr.setMeta("historyBridge", true);
        view.dispatch(tr);
        // v0.15.1 需求1：整篇替换会让 scrollHeight 变小 → 浏览器把 scrollTop 钳到新 max
        // （= 贴底）。这里按内容锚点还原，避免"撤销一次就滚到底"。
        restorePreviewScrollFromAnchor(scrollAnchor, userScrolledRef);
      } catch (e) {
        console.error("[EditorContainer] 统一撤销：阅读模式写回失败:", e);
      } finally {
        // 还原窗口结束（约 200ms）后解绑，避免长期挂监听
        window.setTimeout(() => {
          container?.removeEventListener("wheel", onWheel);
          container?.removeEventListener("pointerdown", onPointer);
          container?.removeEventListener("touchstart", onPointer);
          window.removeEventListener("keydown", onKey, true);
        }, 260);
      }
      return;
    }
    // 源码模式：写 state + 恢复光标/滚动
    //
    // v0.15.4 需求10：源码面同样进入撤销滚动窗口。
    // 源码面没有 keyup 的 scrollToVisible 路径，但 textarea 的**原生动滚动**
    // （`setSelectionRange` 后浏览器把光标滚入视口）会在下面的选区恢复里发生，
    // 与 `applyScrollRestore` 的内容锚校正互相踩 —— 同样一次「先跳后回」。
    // 窗口内不接管具体写入（下面本来就是锚点统一负责），只需要让
    // 其它自动滚动路径（打字机居中 / ResizeObserver 补偿）让位。
    historyScrollGuardUntilRef.current = performance.now() + HISTORY_SCROLL_GUARD_MS;
    //
    // ─── v0.15.3 返修（缺陷 A）：跨模式撤销后源码面「贴底」────
    //
    // ## 缺陷（实机取证，打包产物 v0.15.2，`scripts/v0153-probe-undo-big.mjs`）
    // 用户在**阅读模式**里编辑几步 → 切**源码模式** → Ctrl+Z。
    // 被撤的那条条目是 **PM 条目**，`HistoryEntry.beforeSelection` 是 undefined
    // （PM 侧 `beforeAnchor` 至今未接线，见 `editorHistory/pmAdapter.ts`）。
    // 于是旧实现的 `if (sel)` 不成立 → **完全不恢复滚动**；而文本变短让
    // `scrollHeight` 变小 → 浏览器把 `scrollTop` 钳到新 max = **贴底**。
    // 实测：撤销前 `top=21531 / max=21948`，撤销后 `top=21112 / max=21113`
    // （距底 1px；61 帧采样里 57 帧贴底）；接着切回阅读面 `top=max=11485`（全贴底）。
    // 用户看到的就是「撤销/恢复文档会抖动」+「之后双击 Ctrl 漂移」。
    //
    // ## 修法：锚**内容**不锚像素（与阅读面同一口径）
    // 1. 写入**之前**（此刻 textarea 还是旧文本）采「视口中央那一行字符的偏移」， 
    //    即 `{ offset, viewportY }`；
    // 2. 用 `remapOffsetAcrossTextChange` 把 offset 从旧文本映射到目标文本
    //    （字符偏移与排版、字号、软换行、文本长度全都无关）；
    // 3. 写入后用同一套 rAF / 60ms / 160ms 校正把那一行拉回原视口 Y。
    // 像素只在「文本长度不变」时作快路径；**永不写 0**（写 0 = 丢进度，v0.14.0 P1 老 bug）。
    const textarea = sourceTextareaRef.current;
    const sel = restore as { start: number; end: number; scrollTop?: number } | undefined;
    /**
     * 写入前采内容锚（必须在 `setSourceContent` 之前 —— 之后 textarea.value 已是新文本，
     * 采到的 offset 就指向新文本的同一偏移，而不是"眼前那一行"）。
     * 取**视口中央**（与阅读面 `capturePreviewScrollAnchor` 同口径：用户判断"阅读焦点"
     * 看的是视口中间）。不可见 / 内容不足一屏时 `captureTextAnchor` 返回 null，
     * 决策函数会安全地退到像素或 none 分支。
     */
    const histAnchor = textarea
      ? captureTextAnchor(textarea, Math.max(0, textarea.clientHeight / 2))
      : null;
    const beforeText = textarea ? textarea.value : "";
    const beforeTextLength = beforeText.length;
    setSourceContent(text);
    sourceContentRef.current = text;
    onContentChangeRef.current?.(text);
    setDirtyRef.current(true);
    lastContentRef.current = text;
    lastRealTextRef.current = text;
    // 时间线只存真实内容，因此 text 已是 unmask 后的完整文本；
    // 展示层需要重新 mask 成短标记，否则 textarea 里会平铺超长 base64。
    const { text: masked } = maskBase64Images(text, base64TokensRef.current);
    if (masked !== text) {
      setSourceContent(masked);
      sourceContentRef.current = masked;
      onContentChangeRef.current?.(masked);
    }
    /**
     * 滚动恢复计划（写入后执行）。
     *
     * 注意 `masked` 才是 textarea 真正会显示的文本：锚点 offset 必须映射到
     * `masked` 而不是 `text`，否则含 base64 图片的文档上偏移会整体错位。
     *
     * 用写入**前**的 `beforeText` 作映射源（而不是写后再读 `textarea.value`）：
     * `setSourceContent` 是 React 受控更新，此刻 DOM 上可能还是旧值、也可能已是
     * 新值，取决于是否在同一个提交里 —— 唯一确定的是我们手里留存的这份旧文本。
     */
    const afterTextLength = masked.length;
    const remapped = histAnchor
      ? {
          offset: remapOffsetAcrossTextChange(histAnchor.offset, beforeText, masked),
          viewportY: histAnchor.viewportY,
        }
      : null;
    const scrollPlan = decideSourceScrollRestore({
      textLengthChanged: afterTextLength !== beforeTextLength,
      anchor: remapped,
      pixelScrollTop: sel && typeof sel.scrollTop === "number" ? sel.scrollTop : null,
    });
    traceScroll("undo-source", {
      histAnchor: histAnchor ? { o: histAnchor.offset, y: Math.round(histAnchor.viewportY * 100) / 100 } : null,
      beforeLen: beforeTextLength,
      afterLen: afterTextLength,
      sel: sel ? { s: sel.start, st: typeof sel.scrollTop === "number" ? sel.scrollTop : null } : null,
      plan: scrollPlan.kind,
      planOffset: scrollPlan.kind === "anchor" ? scrollPlan.anchor.offset : null,
      taTop: textarea ? Math.round(textarea.scrollTop * 100) / 100 : null,
      taMax: textarea ? Math.max(0, textarea.scrollHeight - textarea.clientHeight) : null,
      taCh: textarea ? textarea.clientHeight : null,
    });
    /**
     * 落地滚动恢复。
     *
     * 为什么 0 / 60 / 160ms 三段：与阅读面 `restorePreviewScrollFromAnchor` 同款 ——
     * `setSourceContent` 是受控组件，React 提交后浏览器还要重排一次（长文尤其明显），
     * 单帧恢复会在重排后被推走。三段全部用**同一锚点**（幂等）。
     */
    const applyScrollRestore = () => {
      const ta = sourceTextareaRef.current;
      if (!ta || ta.clientHeight <= 0) return;
      if (scrollPlan.kind === "anchor") {
        restoreTextAnchor(ta, scrollPlan.anchor);
      } else if (scrollPlan.kind === "pixel") {
        const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
        const want = Math.min(Math.max(0, scrollPlan.scrollTop), max);
        if (Math.abs(ta.scrollTop - want) > 0.5) ta.scrollTop = want;
      }
      // kind === "none"：**什么都不做**（绝不写 0，见决策函数注释）
    };
    if (scrollPlan.kind !== "none") {
      requestAnimationFrame(() => {
        applyScrollRestore();
        window.setTimeout(applyScrollRestore, 60);
        window.setTimeout(applyScrollRestore, 160);
      });
    }
    if (sel) {
      const pos = Math.max(0, Math.min(masked.length, sel.start));
      const end = Math.min(masked.length, sel.end);
      /**
       * v0.15.3 返修（缺陷 A 配套）：这里**不再**无条件写历史像素。
       *
       * 旧实现把 `sel.scrollTop`（历史记录里的**旧像素**）交给 `pendingSourceSelectionRef`，
       * 由 `useLayoutEffect` 与 rAF/60ms 兜底各写一次 —— 而它和上面新加的
       * `applyScrollRestore`（内容锚）会互相踩：像素先写一次（文本变短时被浏览器钳到
       * 新 max = 贴底）、锚点再拉回一次 → 61 帧采样里出现「贴底 → 拉回」的往返，
       * 正是用户说的"撤销时文档抖一下"。
       * 现在：滚动统一由 `scrollPlan` 负责，选区通道**只恢复光标**。
       * 唯一例外是 `scrollPlan.kind === "pixel"`（文本长度未变、锚点采不到）——
       * 那种情况下像素就是权威值，由 `applyScrollRestore` 统一写，这里仍不重复写。
       */
      const scrollTopForSelection: number | null = null;
      pendingSourceSelectionRef.current = {
        start: pos,
        end,
        scrollTop: scrollTopForSelection,
        // 选区保护窗：覆盖「撤销 → onContentChange → App.setContent → content prop
        // 变化 → 再 setSourceContent」这条二次受控提交链（实测需要 ~100ms）。
        until: Date.now() + 250,
      };
      /**
       * v0.15.1 需求6（再审计缺陷 1）：这两个定时器必须能被**用户输入作废**。
       *
       * 实测：撤销后 60ms 内打字 → 字符插对了，但 250ms 后光标被这里抢回撤销时的
       * 位置（`selectionStart` 8 → 9 → 又回到 8）→ 下一个字符插到错误位置。
       * `handleSourceChange` 会 `++sourceSelectionRestoreTokenRef`，这里比对代际号即可。
       */
      const restoreToken = ++sourceSelectionRestoreTokenRef.current;
      const applySelection = () => {
        if (sourceSelectionRestoreTokenRef.current !== restoreToken) return;
        const ta = sourceTextareaRef.current;
        if (!ta) return;
        const len = ta.value.length;
        ta.focus();
        ta.setSelectionRange(Math.min(pos, len), Math.min(end, len));
        lastTextareaCursorRef.current = Math.min(pos, len);
      };
      applySelection();
      requestAnimationFrame(applySelection);
      window.setTimeout(applySelection, 60);
    }
  };


  // ─── 在光标处插入文本（统一入口，供对话框 onInsert 复用）────────────
  // 复用 sourceInsertHandler 的差异记录与光标恢复逻辑
  const insertTextAtCursor = useCallback((text: string, cursorOffset?: number) => {
    // v0.17.0 A2 收敛：只需选区三个纯值 → 经 surface（CM6 下同样成立）
    if (!sourceSurface.getText()) return;
    const sel = sourceSurface.getSelection();
    const start = sel.start;
    const end = sel.end;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const newContent = currentContent.substring(0, start) + text + currentContent.substring(end);
    const scrollTop = sourceSurface.getScrollTop();
    // v0.6.6 问题4：插入内容含 base64 图片（如 ImageInsertDialog）→ mask 为短标记
    let finalContent = newContent;
    let newCursorPos = selected ? start + text.length : (cursorOffset !== undefined ? start + cursorOffset : start + text.length);
    if (hasRawBase64Image(newContent)) {
      const { text: masked, replacements } = maskBase64Images(newContent, base64TokensRef.current);
      if (replacements.length > 0) {
        finalContent = masked;
        newCursorPos = adjustCursorForMask(newCursorPos, replacements);
      }
    }
    // 直接推入差异（对话框插入是离散操作，无需防抖）
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休，写进去没人消费）
    recordDiscreteSourceEdit(currentContent, finalContent, start, scrollTop);
    setSourceContent(finalContent);
    sourceContentRef.current = finalContent;
    onContentChangeRef.current?.(finalContent);
    setDirtyRef.current(true);
    lastContentRef.current = unmaskBase64Images(finalContent, base64TokensRef.current);
    const restore = () => {
      // v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（不涉及布局几何），
      // 改经 SourceSurface —— CM6 实现下同一段代码同样成立。
      sourceSurface.focus();
      sourceSurface.setSelection(newCursorPos, newCursorPos);
      sourceSurface.setScrollTop(scrollTop);
      lastTextareaCursorRef.current = newCursorPos;
      };
    requestAnimationFrame(restore);
    setTimeout(restore, 50);
  }, [pushUndoEntry]);


  // ─── E1(v0.9.2):阅读模式下对话框插入直接写入 ProseMirror ────
  // 此前 LinkDialog/ImageInsertDialog 确认后走 insertTextAtCursor(textarea 通道),
  // 阅读模式无 textarea → 静默失败。preview 模式下改走 markdownToDoc → replaceSelection。
  const insertMarkdownIntoPM = useCallback((md: string) => {
    const view = viewRef.current;
    if (!view) return;
    try {
      // 开放度 0/0:作为整体块插入,不与两侧内容粘连
      const slice = new Slice(markdownToDoc(md).content, 0, 0);
      const tr = view.state.tr.replaceSelection(slice);
      view.dispatch(tr.scrollIntoView());
      view.focus();
    } catch (e) {
      console.warn("[EditorContainer] PM 插入失败,回退文本通道:", e);
      insertTextAtCursor(md);
    }
  }, [insertTextAtCursor]);


  // ─── SlashCommand 插入回调 ────────────────────────
  // mode="block"：删除当前行从行首（含 / 和过滤文字）到光标的内容，在行首插入 markdown
  // mode="inline"：用 markdown 替换当前选中文本（markdown 已是完整包裹字符串）
  // 菜单关闭由 SlashCommand 组件内部调用 onClose 处理，此处不主动关闭
  // 核心字符串变换逻辑提取为纯函数 computeSlashInsert（文件底部导出），便于单元测试
  const handleSlashInsert = useCallback((markdown: string, mode: InsertMode) => {
    // v0.17.0 A2 收敛：纯值语义（选区 + 滚动像素）→ 经 surface
    const sel0 = sourceSurface.getSelection();
    const cursorPos = sel0.start;
    const selectionEnd = sel0.end;
    const currentContent = sourceContentRef.current;
    const scrollTop = sourceSurface.getScrollTop();

    // 调用纯函数计算新内容与光标位置
    const { newContent, newCursorPos } = computeSlashInsert(
      currentContent,
      cursorPos,
      selectionEnd,
      markdown,
      mode
    );

    // 推入 undo 栈（离散操作，无需防抖）
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
    recordDiscreteSourceEdit(currentContent, newContent, cursorPos, scrollTop);

    setSourceContent(newContent);
    sourceContentRef.current = newContent;
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);

    // 恢复光标位置（rAF + setTimeout 双保险，与 insertTextAtCursor 一致）
    const restore = () => {
      // v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（不涉及布局几何），
      // 改经 SourceSurface —— CM6 实现下同一段代码同样成立。
      sourceSurface.focus();
      sourceSurface.setSelection(newCursorPos, newCursorPos);
      sourceSurface.setScrollTop(scrollTop);
      lastTextareaCursorRef.current = newCursorPos;
      };
    requestAnimationFrame(restore);
    setTimeout(restore, 50);
  }, [pushUndoEntry]);


  // ─── 对话框 open 状态 ────────────────────────────
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  const [linkInitialText, setLinkInitialText] = useState("");

  const [tableDialogOpen, setTableDialogOpen] = useState(false);

  const [imageDialogOpen, setImageDialogOpen] = useState(false);

  // ─── G3：图片编辑对话框状态 ────────────────────
  // imageEditSrc 为 resolve 后的可显示 URL（asset:// 或 data:）
  // imageEditPos 为 ProseMirror 文档中图片节点的位置，确认后通过 setNodeMarkup 修改 attrs.src
  // E11b(v0.9.3)：同时携带节点 alt/width，对话框内可编辑并写回
  const [imageEditDialogOpen, setImageEditDialogOpen] = useState(false);

  const [imageEditSrc, setImageEditSrc] = useState("");

  const [imageEditAlt, setImageEditAlt] = useState("");

  const [imageEditWidth, setImageEditWidth] = useState<number | null>(null);

  /** v0.13.0 需求4：图片水平对齐（打开图片编辑对话框时从节点 attrs 带入） */
  const [imageEditAlign, setImageEditAlign] = useState<"left" | "center" | "right">("left");

  const [imageEditPos, setImageEditPos] = useState<number | null>(null);

  // ─── 右键菜单状态 ────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number; hasSelection: boolean }>({
    open: false, x: 0, y: 0, hasSelection: false,
  });

  // v0.12.0 需求2：PM 模式右键菜单状态（选区信息在 rAF 内主动读取后填入）
  const [pmContextMenu, setPmContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    hasSelection: boolean;
    nodeKind: string | null;
    /** v0.13.0 需求1：剪贴板是否有块数据（控制「粘贴」禁用态） */
    hasBlockClipboard: boolean;
    /**
     * v0.13.1 需求16：选区是否可剪切/复制（控制「剪切」「复制」禁用态）。
     *
     * 只读编辑器自身选区，**不读系统剪贴板**——v0.13.0 第三轮的教训是
     * `navigator.clipboard.read()` 会让 WebView2 弹出系统授权气泡，
     * 用户只是右键一下就被打断。
     */
    hasTextClipboard: boolean;
  }>({
    open: false,
    x: 0,
    y: 0,
    hasSelection: false,
    nodeKind: null,
    hasBlockClipboard: false,
    hasTextClipboard: false,
  });

  // ─── v0.13.0 需求1：块右上角三点菜单（blockKebab 派发 lightmd:blockAction） ───
  const [blockKebabMenu, setBlockKebabMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    /** 被点块的文档位置 */
    pos: number;
    /** 剪贴板是否有块数据（控制「粘贴」禁用态） */
    hasClipboard: boolean;
  }>({ open: false, x: 0, y: 0, pos: 0, hasClipboard: false });

  // v0.12.0 需求2：格式刷状态（订阅以驱动光标样式 / Esc 监听 / 状态栏提示）
  const formatPainterMode = useFormatPainterStore((s) => s.mode);

  // ─── Mermaid 模板下拉状态 ────────────────────────
  const [mermaidMenuOpen, setMermaidMenuOpen] = useState(false);

  // ─── v0.12.1 需求5：任务列表图标样式下拉（方形 / 圆形）───
  const [taskStyleMenuOpen, setTaskStyleMenuOpen] = useState(false);

  // ─── SlashCommand 菜单 open 状态 ───────────────────
  // 仅在源码模式 + Markdown 文件 + 行首输入 / 时打开
  const [slashCommandOpen, setSlashCommandOpen] = useState(false);


  // ─── 打开链接对话框（携带选中文本作为 initialText）────
  const openLinkDialog = useCallback(() => {
    // v0.17.0 A2 收敛：仅取选区子串 → 经 surface
    {
      const sel = sourceSurface.getSelection();
      const selected = sourceContentRef.current.substring(sel.start, sel.end);
      setLinkInitialText(selected);
    }
    setLinkDialogOpen(true);
  }, []);


  // ─── E1(v0.9.2):命令面板/工具栏在阅读模式下发的链接/图片对话框打开事件 ────
  useEffect(() => {
    const handler = (e: Event) => {
      const kind = (e as CustomEvent).detail?.kind;
      if (kind === "link") {
        openLinkDialog();
      } else if (kind === "image") {
        setImageDialogOpen(true);
      }
    };
    window.addEventListener("lightmd:pm-dialog", handler);
    return () => window.removeEventListener("lightmd:pm-dialog", handler);
  }, [openLinkDialog]);


  // ─── v0.13.2 需求10：图片编辑入口改为「右上角手柄」 ────────────────
  //
  // 用户要求：「原来点击文档中图片会弹窗进入编辑，现在需要在图片右上角加上小手柄按钮，
  // 鼠标移动到图片上就会显现，将弹窗进入编辑的功能放在这个按钮里点击即可进入；
  // 而原来点击图片改为激活该图片，通过鼠标拖拽图片边缘可以进行图片大小调整。」
  //
  // 因此旧的「捕获阶段点击 img → 打开编辑弹窗」整段移除：
  // - 点击/拖拽由 `core/plugins/image-node.ts` 的 ImageView 接管（激活 / 缩放）；
  // - 手柄点击时派发 `lightmd:image-edit`，由本 effect 打开编辑弹窗。
  useEffect(() => {
    const handler = (e: Event) => {
      const pos = (e as CustomEvent).detail?.pos as number | undefined;
      if (typeof pos !== "number") return;
      const view = viewRef.current;
      if (!view) return;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "image") return;
      // src 用解析后的可显示 URL（asset:// / data: / http(s)），与旧实现同源
      setImageEditSrc(resolveImageSrc(String(node.attrs.src ?? "")));
      setImageEditAlt(String(node.attrs.alt ?? ""));
      setImageEditWidth(typeof node.attrs.width === "number" ? node.attrs.width : null);
      setImageEditAlign(
        node.attrs.align === "center" || node.attrs.align === "right" ? node.attrs.align : "left",
      );
      setImageEditPos(pos);
      setImageEditDialogOpen(true);
    };
    window.addEventListener("lightmd:image-edit", handler);
    return () => window.removeEventListener("lightmd:image-edit", handler);
  }, []);


  // ─── v0.9.5 问题3：文档内链接点击导航 ────────────────
  // 此前全项目无链接点击处理——阅读模式 <a href> 点击被 WebView2 当作页面内导航,
  // 相对路径链接点击无任何反应。统一分发:内部文件 → lightmd:open-path 事件
  // (App 层 openFileByPath 复用打开链路);http(s)/mailto → 外部打开;
  // 锚点 → 编辑器内滚动到标题
  // v0.12.0 需求8：外部打开逻辑抽出为 utils/openExternal（设置弹窗「关于」复用），
  // openExternalHref 现为模块级静态函数，无需 useCallback 包装

  const scrollEditorToAnchor = useCallback((anchor: string) => {
    const container = editorRef.current;
    if (!container) return;
    const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of headings) {
      const el = h as HTMLElement;
      if (el.id === anchor || anchorMatchesHeading(anchor, el.textContent || "")) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  }, []);


  const handleLinkNav = useCallback(
    (href: string) => {
      const action = resolveLinkAction(href, filePath || "");
      if (action.kind === "open-internal") {
        window.dispatchEvent(new CustomEvent("lightmd:open-path", { detail: { path: action.path } }));
      } else if (action.kind === "open-external") {
        void openExternalHref(action.href);
      } else if (action.kind === "scroll-anchor") {
        scrollEditorToAnchor(action.anchor);
      }
    },
    [filePath, scrollEditorToAnchor]
  );


  // 阅读模式：ProseMirror 容器内链接点击(捕获阶段,先于 PM 的选区处理)
  useEffect(() => {
    if (viewMode !== "preview") return;
    const container = editorRef.current;
    if (!container) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      handleLinkNav(href);
    };
    container.addEventListener("click", handler, true);
    return () => container.removeEventListener("click", handler, true);
  }, [viewMode, handleLinkNav]);


  // 分屏：iframe 内链接点击经 postMessage 桥接回主文档(桥接脚本在完整重写时注入 head)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "lightmd-preview-link") return;
      const href = e.data.href;
      if (typeof href === "string" && href) handleLinkNav(href);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleLinkNav]);


  /**
   * G3：图片编辑确认回调 —— 通过 setNodeMarkup 修改 image 节点 attrs
   * E11b(v0.9.3)：除 src 外同时写回对话框编辑的 alt 与 width
   * v0.13.0 需求4：同时写回水平对齐（非 left 时序列化为 `<img style>`）
   */
  const handleImageEditConfirm = useCallback((newSrc: string, meta: { alt: string; width: number | null; align: "left" | "center" | "right" }) => {
    const view = viewRef.current;
    if (!view || imageEditPos === null) {
      setImageEditDialogOpen(false);
      return;
    }
    try {
      const node = view.state.doc.nodeAt(imageEditPos);
      if (node && node.type.name === "image") {
        const tr = view.state.tr.setNodeMarkup(imageEditPos, undefined, {
          ...node.attrs,
          src: newSrc,
          alt: meta.alt,
          width: meta.width,
          align: meta.align,
        });
        view.dispatch(tr);
      }
    } catch {
      // 节点位置无效时静默失败（避免编辑过程中文档已变更导致崩溃）
    }
    setImageEditDialogOpen(false);
    setImageEditPos(null);
    setImageEditSrc("");
    setImageEditAlt("");
    setImageEditWidth(null);
    setImageEditAlign("left");
  }, [imageEditPos]);


  // ─── 格式工具栏操作 ────────────────────────────
  // 通过 buildFormatReplacement 纯函数生成 replacement + cursorOffset，
  // 减少 switch 重复代码；mermaid 按钮点击改为打开下拉，不走此路径
  const handleFormatAction = useRef((action: string) => {
    // 归一化 H1-H6 按钮 action（"h1"~"h6"）到 heading 前缀路径（"heading1"~"heading6"），
    // 与快捷键 Ctrl+1~6 一致走行首替换逻辑，而非在光标位置插入文本
    if (/^h[1-6]$/.test(action)) {
      action = `heading${action[1]}`;
    }
    // v0.17.0 A2 收敛：纯值语义 → 经 surface
    const sel1 = sourceSurface.getSelection();
    const start = sel1.start;
    const end = sel1.end;
    const currentContent = sourceContentRef.current;
    const selected = currentContent.substring(start, end);
    const scrollTop = sourceSurface.getScrollTop();

    // 行首类操作：Ctrl+1~6 在行首插入/替换标题，Ctrl+0 移除标题
    if (action === "paragraph") {
      const { replacement: newText, cursorOffset } = removeLinePrefixFn(currentContent, start);
      if (newText === currentContent) return; // 非标题行，无变化
      // v0.12.0 需求1：Ctrl+0 转段落 → 清除可能残留的标题格式 ghost
      formatGhostHandlersRef.current.clear("input");
      // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
      recordDiscreteSourceEdit(currentContent, newText, start, scrollTop);
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      const newCursorPos = start + cursorOffset;
      const restore = () => {
        // v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（不涉及布局几何），
        // 改经 SourceSurface —— CM6 实现下同一段代码同样成立。
        sourceSurface.focus();
        sourceSurface.setSelection(newCursorPos, newCursorPos);
        sourceSurface.setScrollTop(scrollTop);
        };
      requestAnimationFrame(restore);
      setTimeout(restore, 50);
      return;
    }
    // v0.13.2 需求2：源码模式 Ctrl+T —— 把当前行从列表里"提升"为任务项，
    // 任务列表插到原列表之前（与阅读模式 pmCommands 的口径一致）。
    // 不适用（当前行不是列表项）时返回 null → 继续走下面的通用路径
    // （在普通段落里 Ctrl+T 仍然是"新建任务项"，行为零回归）。
    if (action === "taskListLift") {
      const lifted = liftListLineToTaskFn(currentContent, start);
      if (!lifted) {
        // 非列表行：退回既有的语法插入（`\n- [ ] `），保持旧行为
        insertTextAtCursor("\n- [ ] ");
        return;
      }
      const { replacement: newText, cursorOffset } = lifted;
      // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
      recordDiscreteSourceEdit(currentContent, newText, start, scrollTop);
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      formatGhostHandlersRef.current.clear("input");
      const newCursorPos = Math.max(0, Math.min(newText.length, start + cursorOffset));
      const restore = () => {
        // v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（不涉及布局几何），
        // 改经 SourceSurface —— CM6 实现下同一段代码同样成立。
        sourceSurface.focus();
        sourceSurface.setSelection(newCursorPos, newCursorPos);
        sourceSurface.setScrollTop(scrollTop);
        lastTextareaCursorRef.current = newCursorPos;
        };
      requestAnimationFrame(restore);
      setTimeout(restore, 50);
      return;
    }

    if (action.startsWith("heading")) {
      // heading1 ~ heading6：在行首插入/替换标题前缀
      const level = parseInt(action.slice("heading".length), 10);
      const prefix = getHeadingPrefix(level);
      const { replacement: newText, cursorOffset } = setLinePrefixFn(currentContent, start, prefix);
      // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
      recordDiscreteSourceEdit(currentContent, newText, start, scrollTop);
      setSourceContent(newText);
      sourceContentRef.current = newText;
      onContentChangeRef.current?.(newText);
      setDirtyRef.current(true);
      // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
      lastContentRef.current = unmaskBase64Images(newText, base64TokensRef.current);
      const newCursorPos = start + cursorOffset;
      const restore = () => {
        // v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（不涉及布局几何），
        // 改经 SourceSurface —— CM6 实现下同一段代码同样成立。
        sourceSurface.focus();
        sourceSurface.setSelection(newCursorPos, newCursorPos);
        sourceSurface.setScrollTop(scrollTop);
        };
      requestAnimationFrame(restore);
      setTimeout(restore, 50);
      // v0.12.0 需求1：无选中文本且当前行除已有前缀外为空 → 显示标题占位 ghost
      // （已有内容的行不显示，避免"标题一"被误解为要追加的文字）
      // 返修：记录语法符号区间 [行首, 行首+新前缀) 与全文快照，供退格整段删除
      const { start: lineStart, end: lineEnd } = getLineRange(currentContent, start);
      const lineBody = currentContent.substring(lineStart, lineEnd).replace(/^#{1,6}\s*/, "");
      if (start === end && lineBody.trim() === "") {
        formatGhostRef.current = {
          text: HEADING_GHOST_TEXTS[level - 1],
          pos: newCursorPos,
          start: lineStart,
          end: lineStart + prefix.length,
          content: newText,
        };
        sourceGhostHandlersRef.current.invalidate();
        requestAnimationFrame(() => formatGhostHandlersRef.current.render());
      } else {
        formatGhostHandlersRef.current.clear("input");
      }
      return;
    }

    // 通用行内/块级格式：调用纯函数生成 replacement
    const result = buildFormatReplacement(action, selected);
    if (!result) return;
    const { replacement, cursorOffset } = result;

    // 直接推入差异（格式操作是离散的，不需要防抖）
    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
    const newContent = currentContent.substring(0, start) + replacement + currentContent.substring(end);
    recordDiscreteSourceEdit(currentContent, newContent, start, scrollTop);
    setSourceContent(newContent);
    onContentChangeRef.current?.(newContent);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(newContent, base64TokensRef.current);

    const newCursorPos = start + cursorOffset;
    const restore = () => {
      // v0.17.0 A2 收敛：恢复光标/滚动是**纯值语义**（不涉及布局几何），
      // 改经 SourceSurface —— CM6 实现下同一段代码同样成立。
      sourceSurface.focus();
      sourceSurface.setSelection(newCursorPos, newCursorPos);
      sourceSurface.setScrollTop(scrollTop);
      lastTextareaCursorRef.current = newCursorPos;
      };
    requestAnimationFrame(restore);
    setTimeout(restore, 50);

    // v0.12.0 需求1：无选区行内格式 → 文档只插语法符号，占位提示走格式 ghost；
    // 预填类（代码块/表格/Mermaid 等模板）或其它情况 → 清除残留 ghost。
    // 返修：记录语法符号区间 [start, start+replacement.length) 与全文快照——
    // ghost 渲染基于快照（防时序漂移），退格可整段删除格式符。
    if (result.ghostText) {
      // v0.12.0 返修（问题1）：把光标之后的尾部语法符号交给 overlay 可见渲染，
      // 并用底色遮住 textarea 中被占位压住的符号 → 占位文字恰好落在左右格式符中间
      const gt = computeGhostTail(newContent, newCursorPos, replacement.slice(cursorOffset));
      formatGhostRef.current = {
        text: result.ghostText,
        pos: newCursorPos,
        start,
        end: start + replacement.length,
        content: newContent,
        tail: gt.maskTail ? gt.tail : "",
        maskTail: gt.maskTail,
      };
      // AI ghost 让位（格式操作是用户主动动作，异步任务不打断视觉）
      sourceGhostHandlersRef.current.invalidate();
      requestAnimationFrame(() => formatGhostHandlersRef.current.render());
    } else {
      formatGhostHandlersRef.current.clear("input");
    }
  });


  // ─── N2：智能粘贴 URL→链接（源码模式） ──────────
  // 粘贴单个 http(s) URL 时转为 Markdown 链接：无选区 → [url](url)；
  // 有选区 → [选中文字](url)。代码块内不处理。
  const handleSourcePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // ⚠️ v0.17.0 A2（修复 C14 第三处）：**在事件源头**标记"这次变更来自粘贴"。
    // 旧实现三个一次性标记（sourceComposingRef/sourceJustPairedRef/sourceJustPastedRef）
    // 全文件**没有任何置 true 的路径**（实测确认），所以 IME/配对/粘贴三类"一步归并"
    // 从未生效，全部落回 inferSourceEditKind 的**文本形态猜测** —— 猜测必然误判。
    // 这里在粘贴真正发生前把标记置上，紧随其后的 onChange 消费后复位。
    sourceJustPastedRef.current = true;
    const ta = sourceTextareaRef.current;
    const text = e.clipboardData.getData("text/plain").trim();
    if (!ta || !isHttpUrl(text)) return;
    const psel = sourceSurface.getSelection();
    const start = psel.start;
    const end = psel.end;
    if (isInCodeBlock(ta.value, start)) return;
    e.preventDefault();
    const selected = ta.value.slice(start, end);
    /**
     * v0.17.0 A2（G7）：改经 `SourceSurface.applyEdit` 落地 —— **单事务单步**。
     *
     * 旧实现用 `document.execCommand("insertText")` 只是为了"制造一次原生 input
     * 事件"从而让一次粘贴只占一步撤销；CM6 实现下 `applyEdit` 的单个 dispatch
     * 天然就是一步，不需要这个 workaround。统一走接口后这段代码对两种实现都成立。
     *
     * 同时保留"一次粘贴 = 一步"的语义：applyEdit 会带 `userEvent: "input.pair"` 标记，
     * 配合 sourceJustPastedRef（已在函数开头置位）让 adapter 归为 paste 组。
     */
    const inserted = `[${selected || text}](${text})`;
    sourceSurface.applyEdit({
      kind: "edit",
      edit: { from: start, to: end, text: inserted, caret: start + inserted.length },
    });
  }, []);


  // ─── 源码模式快捷键处理器 ────────────────────────
  // 在 textarea 的 keydown 中拦截 Ctrl/Cmd 组合键，分发到对应 action
  // 注意：Ctrl+Shift+S 已被 App.tsx 占用为「另存为」，删除线改用 Ctrl+Alt+S
  const handleSourceKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSourceMode || !isMdFile) return;

    // v0.7.3 改进10(U3)：source 续写 ghost 的 Tab 采纳 / Esc 放弃
    // （与 PM 模式 ghost 手势一致）；ghost 未活跃时不拦截，走原有自动配对/快捷键）
    if (sourceGhostActiveRef.current) {
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        sourceGhostHandlersRef.current.accept();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        sourceGhostHandlersRef.current.cancel();
        return;
      }
      // 其余按键：用户主动编辑 → ghost 位置语义可能失效，交给变更处理器统一判定
    }

    // v0.12.0 需求1：Esc 清除格式 ghost（不回滚已插入的语法符号，用户 Ctrl+Z 自行撤销；
    // AI ghost 活跃时已由上方分支消费本次 Esc）
    if (e.key === "Escape" && formatGhostRef.current) {
      e.preventDefault();
      e.stopPropagation();
      formatGhostHandlersRef.current.clear("escape");
      return;
    }

    // v0.12.0 需求1 返修④：点击格式符/语法辅助栏后未编辑时按退格 → 整段删除格式符
    // （如 `****`/`- [ ] ` 一次删净，而不是逐字符删除）；光标已移动或已编辑则走默认退格。
    // 格式刷/语法辅助栏等其它插入路径的 ghost 同样由此覆盖。
    if (
      e.key === "Backspace" &&
      !e.ctrlKey && !e.metaKey && !e.altKey &&
      formatGhostRef.current &&
      formatGhostHandlersRef.current.remove()
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // v0.12.1 需求4：Tab 跳出配对（光标夹在 ()"" 之间 → 跳到闭符号右侧）。
    // 位置在 ghost 采纳之后：AI 续写 ghost 活跃时 Tab 的语义是「采纳」，优先级更高。
    if (
      autoPairEnabled &&
      e.key === "Tab" &&
      !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
    ) {
      const ta = sourceTextareaRef.current;
      if (ta) {
        const plan = planSourceTab(buildSourcePairInput(ta, ta.selectionStart ?? 0, ta.selectionEnd ?? 0));
        if (plan.kind === "edit") {
          e.preventDefault();
          e.stopPropagation();
          // ⚠️ v0.17.0 A2（修复 C14 第二处）：配对落地的**同一处**标记 justPaired，
          // 使"一次补全 = 一步撤销"成立（而不是事后靠文本形状推）。
          sourceJustPairedRef.current = true;
           sourceSurface.applyEdit(plan);
          return;
        }
      }
    }

    // v0.16.0 需求（Tab 与缩进体系）：源码模式缩进（Tab / Shift+Tab）。
    //
    // 修 D2：v0.15.6 及之前源码模式 Tab 完全不缩进（value 不变、prevented=false、
    // 焦点逃出 textarea）。这里补缩进落地，并**无论是否产出编辑都吞键**，
    // 否则反缩进在"无可删"场景仍会让焦点逃逸。
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !sourceGhostActiveRef.current) {
      // IME 组合态守卫（与同函数内 Backspace 分支同款）
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const ta = sourceTextareaRef.current;
      if (ta) {
        const input = {
          value: ta.value,
          start: ta.selectionStart ?? 0,
          end: ta.selectionEnd ?? 0,
          unit: indentUnitString(useSettingsStore.getState().indentUnit),
        };
        const plan = e.shiftKey ? planSourceOutdent(input) : planSourceIndent(input);
        e.preventDefault();
        e.stopPropagation();
        if (plan.kind === "edit") {
          sourceJustPairedRef.current = true;
           sourceSurface.applyEdit(plan);
        }
        return; // 无论 edit 还是 none 都吞键（否则焦点逃逸依旧存在）
      }
    }

    // ─── v0.12.1 需求4：删除/跳过类交互（输入补全由 beforeinput 监听统一处理）───
    // 为什么补全不在 keydown 里做：IME 提交的中文标点不会以单字符 keydown 到达
    // （Chromium 走 composition 路径），keydown + input 双路径会重复判定。
    // 现在统一为：
    //   · beforeinput（insertText 单字符）→ 补全 / 包围 / 跳过；
    //   · compositionend（组合提交后相位）→ 补一次闭符号；
    //   · keydown → 退格成对删除、Tab 跳出（这两个必须抢在默认行为之前）。
    if (autoPairEnabled && e.key === "Backspace") {
      const ta = sourceTextareaRef.current;
      if (ta) {
        // E5(v0.9.2):IME 组合态守卫——组合期按 Backspace 删拼音，不做成对删除
        // （部分输入法组合期 isComposing=false 但 keyCode=229，与 PM 端 auto-pair 对齐）
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // v0.8.0 修复 P1-3：围栏代码块 + 行内代码/公式内都不做成对删除（在规划器内判定）
        const plan = planSourceBackspace(
          buildSourcePairInput(ta, ta.selectionStart ?? 0, ta.selectionEnd ?? 0),
        );
        if (plan.kind === "edit") {
          e.preventDefault();
          e.stopPropagation();
          // ⚠️ v0.17.0 A2（修复 C14 第二处）：配对落地的**同一处**标记 justPaired，
          // 使"一次补全 = 一步撤销"成立（而不是事后靠文本形状推）。
          sourceJustPairedRef.current = true;
           sourceSurface.applyEdit(plan);
          return;
        }
      }
    }

    const action = parseShortcut(e.nativeEvent);
    if (!action) return;
    e.preventDefault();
    // 阻止冒泡到 window，避免 App.tsx 的全局快捷键误触发
    e.stopPropagation();
    if (action === "math") {
      handleFormatAction.current("math");
    } else if (action === "paragraph") {
      handleFormatAction.current("paragraph");
    } else if (action.startsWith("heading")) {
      handleFormatAction.current(action);
    } else {
      handleFormatAction.current(action);
    }
  }, [isSourceMode, isMdFile, autoPairEnabled]);

  return {
    handleSourceChange,
    insertTextAtCursor,
    insertMarkdownIntoPM,
    handleSlashInsert,
    linkDialogOpen,
    setLinkDialogOpen,
    linkInitialText,
    setLinkInitialText,
    tableDialogOpen,
    setTableDialogOpen,
    imageDialogOpen,
    setImageDialogOpen,
    imageEditDialogOpen,
    setImageEditDialogOpen,
    imageEditSrc,
    setImageEditSrc,
    imageEditAlt,
    setImageEditAlt,
    imageEditWidth,
    setImageEditWidth,
    imageEditAlign,
    setImageEditAlign,
    setImageEditPos,
    contextMenu,
    setContextMenu,
    pmContextMenu,
    setPmContextMenu,
    blockKebabMenu,
    setBlockKebabMenu,
    formatPainterMode,
    mermaidMenuOpen,
    setMermaidMenuOpen,
    taskStyleMenuOpen,
    setTaskStyleMenuOpen,
    slashCommandOpen,
    setSlashCommandOpen,
    openLinkDialog,
    handleImageEditConfirm,
    handleFormatAction,
    handleSourcePaste,
    handleSourceKeyDown
  };
}
