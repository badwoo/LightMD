/**
 * AiAssistBubble —— AI 助手结果气泡（v0.7.0：续写 / 润色 / 摘要）
 *
 * 行为（与 TranslateBubble 同构，视觉复用同一套 CSS 类）：
 * - 消费 aiAssistStore：idle 不渲染；loading/streaming 流式文本；done 操作按钮
 * - rAF 批量刷新流式文本（chunk 入队，每帧合并 flush，避免高频 setState）
 * - Esc 关闭并取消进行中的任务
 * - 错误态：错误码 → 本地化文案（复用翻译错误码映射）+ 重试按钮
 * - 完成态主按钮按任务切换：润色=替换选中，续写/摘要=插入到光标处
 *
 * v0.7.4 增强：
 * - 摘要窗口（选段/全文）支持拖拽移动 + 右下角拖拽放大；生成时按内容自动拉长、
 *   最高触到底部栏
 * - 摘要窗口按"所属文档"过滤：切到其他已打开文档时不显示，切回仍保留（未关闭）
 * - 选段摘要虚线锚定选中文本末尾，拖拽窗口时锚点固定、虚线窗口端实时跟随
 * - 摘要窗口标题栏新增「译」字翻译按钮：点击翻译窗口内容并替换译文，再点恢复原文
 * - 全文摘要去掉左外侧「}」收拢符号
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAiAssistStore } from "../../stores/aiAssistStore";
import { aiAssistService, type AiTask } from "../../services/aiAssistService";
import { translateErrorKey, computeBubblePosition } from "./TranslateBubble";
import { translateService } from "../../services/translateService";
import { useEditorStore } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
import { visualizePlaceholders } from "../../utils/placeholderVisual";
import "./TranslateBubble.css";

interface AiAssistBubbleProps {
  /** 应用结果到编辑器（按任务与来源通道接线：替换选中 / 插入光标处） */
  onApply: (task: AiTask, text: string) => void;
  /** 复制结果到剪贴板 */
  onCopy: (text: string) => void;
  /** 重试上次任务（入口层持有任务上下文） */
  onRetry: () => void;
}

/** 任务标题 i18n 键（导出供测试） */
export function aiTaskTitleKey(task: AiTask): string {
  return `ai.title.${task}`;
}

/** 完成态主按钮文案 i18n 键（导出供测试）：润色=替换选中，其余=插入 */
export function aiTaskApplyKey(task: AiTask): string {
  return task === "polish" ? "ai.replace" : "ai.insert";
}

/** v0.7.0 修复5：判断摘要是否为全文模式（无选区锚点 → 视为全文） */
export function isFullDocSummary(anchor: { x: number; y: number } | null): boolean {
  return !anchor || (anchor.x === 0 && anchor.y === 0);
}

/** v0.7.0 修复5：选段摘要虚线路径（气泡左缘中点 → 选区锚点，二次贝塞尔弧线） */
export function computeSummaryPath(
  from: { x: number; y: number },
  to: { x: number; y: number }
): { d: string } {
  const cx = Math.min(from.x, to.x) - Math.max(40, Math.abs(from.y - to.y) * 0.2);
  const cy = (from.y + to.y) / 2;
  return { d: `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}` };
}

/** v0.7.0：AI 助手错误码 → i18n 键（EMPTY 用 AI 语境文案，其余复用翻译映射） */
export function aiErrorKey(code: string): string {
  return code === "EMPTY" ? "ai.error.empty" : translateErrorKey(code);
}

/** 摘要默认宽度/高度（功能4：可拖拽放大后变更；导出供测试） */
const SUMMARY_W = 480;
const SUMMARY_H = 220;
const SUMMARY_GAP_BOTTOM = 16; // 底部栏之上预留间距（功能6：自动拉长触底）

export function AiAssistBubble({ onApply, onCopy, onRetry }: AiAssistBubbleProps) {
  const t = useT();
  const status = useAiAssistStore((s) => s.status);
  const task = useAiAssistStore((s) => s.task);
  const errorCode = useAiAssistStore((s) => s.errorCode);
  const errorDetail = useAiAssistStore((s) => s.errorDetail);
  const result = useAiAssistStore((s) => s.result);
  const anchor = useAiAssistStore((s) => s.anchor);
  const close = useAiAssistStore((s) => s.close);
  const bubbleFilePath = useAiAssistStore((s) => s.filePath);
  // v0.7.4 修复3：气泡按"所属文档"过滤——切到其他已打开文档时不显示也不响应快捷键
  // （否则上一文档的润色/摘要结果会被当成当前文档的结果，且 Esc 会误取消隐藏中的任务）
  const currentFilePath = useEditorStore((s) => s.filePath);
  const belongsToCurrentDoc = (bubbleFilePath ?? null) === (currentFilePath ?? null);

  // rAF 批量刷新流式文本（与 TranslateBubble 相同的合并刷新策略）
  const [displayText, setDisplayText] = useState("");
  const stateRef = useRef({ pending: "", raf: 0 });

  useEffect(() => {
    const ref = stateRef.current;
    const flush = () => {
      ref.raf = 0;
      const text = ref.pending;
      ref.pending = "";
      setDisplayText((prev) => prev + text);
    };
    const unsub = useAiAssistStore.subscribe((state, prev) => {
      if (state.status === "loading" && prev.status !== "loading") {
        setDisplayText("");
        return;
      }
      if (state.streamedText !== prev.streamedText) {
        const delta = state.streamedText.startsWith(prev.streamedText)
          ? state.streamedText.slice(prev.streamedText.length)
          : state.streamedText;
        ref.pending += delta;
        if (!ref.raf) ref.raf = requestAnimationFrame(flush);
      }
    });
    return () => {
      unsub();
      if (ref.raf) cancelAnimationFrame(ref.raf);
    };
  }, []);

  // done 时确保完整结果显示（流式 tail 与最终结果可能有细微差异）
  const finalText = status === "done" && result ? result.translated : displayText;

  // Esc 关闭 + 取消（v0.7.4 修复3：非当前文档的气泡不响应，避免误取消隐藏中的任务）
  useEffect(() => {
    if (status === "idle" || !belongsToCurrentDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        aiAssistService.cancel().catch(() => undefined);
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [status, close, belongsToCurrentDoc]);

  // 双击气泡外任意空白处关闭（气泡打开期间监听；气泡内双击不关闭）
  useEffect(() => {
    if (status === "idle" || !belongsToCurrentDoc) return;
    const onDblClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(".translate-bubble")) return;
      close();
    };
    window.addEventListener("dblclick", onDblClick);
    return () => window.removeEventListener("dblclick", onDblClick);
  }, [status, close, belongsToCurrentDoc]);

  // 复制成功反馈
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!finalText) return;
    onCopy(finalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [finalText, onCopy]);

  const isSummary = task === "summary";
  const fullDoc = isFullDocSummary(isSummary ? anchor : null);

  // v0.7.4：摘要窗口可拖拽移动/缩放——本地保存位置与尺寸。
  // 初始位置由下方 useMemo 计算（选段贴锚点、全文靠右侧），首帧写入 dragPos。
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragSize, setDragSize] = useState<{ w: number; h: number } | null>(null);
  const dragRef = useRef({ mode: "none" as "none" | "move" | "resize", sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, oh: 0 });
  const bubbleRef = useRef<HTMLDivElement>(null);

  const isDraggingRef = useRef(false);
  const [dragFlag, setDragFlag] = useState(false);
  const dragFrameRef = useRef(0);

  // 摘要窗口自动高度（功能6）：done 态根据内容自动拉长，最高触到底部栏。
  // 用 rAF 测量内容高度，高度随内容增长，clamp 到「底部栏上方」。
  const [autoH, setAutoH] = useState<number | null>(null);
  useEffect(() => {
    if (!isSummary || status !== "done") return;
    const raf = requestAnimationFrame(() => {
      const el = bubbleRef.current;
      if (!el) return;
      // 内容实际高度：气泡除去 header/actions 后剩余，由 body 撑起。直接用气泡高度即可，
      // 但 body 有 min-height 与 max；这里读取 body.scrollHeight 是否超限
      const textEl = el.querySelector<HTMLElement>(".ai-summary-bubble .translate-bubble-text");
      const bodyEl = el.querySelector<HTMLElement>(".translate-bubble-body");
      if (!bodyEl || !textEl) return;
      const maxH = Math.max(120, window.innerHeight - SUMMARY_GAP_BOTTOM - 48);
      // 内容高度 = body padding + 文本高度
      const cs = getComputedStyle(bodyEl);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const contentH = textEl.getBoundingClientRect().height + pad + 60; // +header+actions 估算
      setAutoH(Math.min(maxH, Math.max(120, contentH)));
    });
    return () => cancelAnimationFrame(raf);
  }, [isSummary, status, displayText, finalText]);

  // 摘要窗口定位/尺寸计算
  const summaryLayout = useMemo(() => {
    if (!isSummary) return null;
    const width = dragSize?.w ?? SUMMARY_W;
    let left: number;
    let top: number;
    if (dragPos) {
      left = dragPos.x;
      top = dragPos.y;
    } else if (fullDoc) {
      left = window.innerWidth - width - 32;
      top = window.innerHeight * 0.1;
    } else if (anchor) {
      // 选段摘要：默认显示在选区右下方空白区，贴近选区
      left = Math.min(anchor.x + 12, window.innerWidth - width - 12);
      top = Math.min(anchor.y + 16, window.innerHeight * 0.7);
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    } else {
      left = Math.max(8, window.innerWidth - width - 32);
      top = window.innerHeight * 0.1;
    }
    // v0.7.4 功能6：done 态才用自动高度（加载/流式用默认）；高度触底 clamp
    const height = autoH ?? dragSize?.h ?? SUMMARY_H;
    const bottomClamp = window.innerHeight - SUMMARY_GAP_BOTTOM - 8;
    const topClamp = 8;
    const finalTop = Math.min(top, bottomClamp - height);
    return { left, top: Math.max(topClamp, finalTop), width, height };
  }, [isSummary, fullDoc, anchor, dragPos, dragSize, autoH]);

  // 拖拽开始（标题栏拖动移动 / 右下角手柄缩放）
  const onDragStart = useCallback((mode: "move" | "resize", e: React.MouseEvent) => {
    if (!summaryLayout) return;
    e.preventDefault();
    const r = dragRef.current;
    r.mode = mode;
    r.sx = e.clientX;
    r.sy = e.clientY;
    r.ox = summaryLayout.left;
    r.oy = summaryLayout.top;
    r.ow = summaryLayout.width;
    r.oh = summaryLayout.height;
    isDraggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - r.sx;
      const dy = ev.clientY - r.sy;
      if (r.mode === "move") {
        setDragPos({ x: r.ox + dx, y: r.oy + dy });
      } else {
        setDragSize({ w: Math.max(280, r.ow + dx), h: Math.max(140, r.oh + dy) });
      }
      // 触发虚线重测（拖拽后窗口挪动，连线窗口端需跟随）；rAF 节流防频繁布局
      if (!dragFrameRef.current) {
        dragFrameRef.current = requestAnimationFrame(() => {
          dragFrameRef.current = 0;
          setDragFlag((v) => !v);
        });
      }
    };
    const onUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [summaryLayout]);

  // 选段摘要虚线：锚定选中文本末尾（anchor 固定），窗口左缘中点跟随（立即测量）。
  // dragFlag 变化触发重测，保证拖拽窗口时虚线跟随展开。
  const [lineFrom, setLineFrom] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!isSummary || fullDoc || !anchor) {
      setLineFrom(null);
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const rect = bubbleRef.current?.getBoundingClientRect();
        if (rect) setLineFrom({ x: rect.left, y: rect.top + rect.height * 0.5 });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isSummary, fullDoc, anchor, dragFlag, summaryLayout?.left, summaryLayout?.top]);

  // v0.7.4 功能5：摘要窗口「译」字翻译入口——点击翻译窗口内容为译文，再点恢复原文。
  // 语义：仅在 summary done 态可用；复用 translateService 选中翻译（流式，RN）。
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translatingBubble, setTranslatingBubble] = useState(false);
  const handleBubbleTranslate = useCallback(async () => {
    if (!isSummary || status !== "done" || !result) return;
    // 已有译文 → 再点恢复原文
    if (translatedText !== null) {
      setTranslatedText(null);
      return;
    }
    setTranslatingBubble(true);
    try {
      const r = await translateService.translate(result.translated, () => undefined);
      setTranslatedText(r.translated);
    } catch {
      setTranslatedText(null);
    } finally {
      setTranslatingBubble(false);
    }
  }, [isSummary, status, result, translatedText]);

  const shownText = translatedText !== null ? translatedText : finalText;

  if (status === "idle") return null;
  // v0.7.4 修复3：所有气泡按"所属文档"过滤——切到其他已打开文档时不显示
  // （避免把上一文档的润色/摘要结果误认为当前文档的结果），切回原文档仍保留
  if (!belongsToCurrentDoc) return null;
  // polish/continue 需要 anchor 定位；summary 全文模式无 anchor 仍渲染（右侧默认）
  if (!isSummary && !anchor) return null;

  const showActions = status === "done" && result;
  const connectorPath =
    isSummary && !fullDoc && lineFrom && anchor ? computeSummaryPath(lineFrom, anchor).d : null;
  const bubbleStyle = isSummary
    ? ({
        left: `${summaryLayout!.left}px`,
        top: `${summaryLayout!.top}px`,
        width: `${summaryLayout!.width}px`,
        height: `${summaryLayout!.height}px`,
      } as React.CSSProperties)
    : !anchor
      ? {}
      : computeBubblePosition(anchor, { width: window.innerWidth, height: window.innerHeight });

  return createPortal(
    <>
      {/* 选段摘要虚线连接层（fixed 全屏 SVG，不拦截交互，气泡之下） */}
      {connectorPath && (
        <svg
          className="ai-summary-connector"
          data-testid="ai-summary-connector"
          aria-hidden="true"
        >
          <path d={connectorPath} className="ai-summary-connector-path" />
          <circle cx={anchor!.x} cy={anchor!.y} r="3.5" className="ai-summary-connector-dot" />
        </svg>
      )}
      <div
        ref={bubbleRef}
        className={`translate-bubble${isSummary ? " ai-summary-bubble" : ""}`}
        style={bubbleStyle}
        data-testid="ai-assist-bubble"
      >
        <div className="translate-bubble-header ai-bubble-drag-handle" onMouseDown={isSummary ? (e) => onDragStart("move", e) : undefined}>
          <span className="translate-bubble-title">
            {isSummary ? t(fullDoc ? "ai.title.summary.full" : "ai.title.summary.selection") : t(aiTaskTitleKey(task))}
            {status === "loading" && <span className="translate-bubble-loading">…</span>}
          </span>
          {/* v0.7.4 功能5：摘要标题栏「译」字翻译入口（仅摘要 done 态） */}
          {isSummary && showActions && (
            <button
              type="button"
              className={`translate-bubble-btn ai-bubble-translate${translatedText !== null ? " is-active" : ""}`}
              onClick={handleBubbleTranslate}
              disabled={translatingBubble}
              title={t("settings.translate.translateBubbleTitle")}
              data-testid="ai-bubble-translate"
            >
              {translatingBubble ? "…" : t("settings.translate.triggerTitle")}
            </button>
          )}
          {status === "streaming" && (
            <button
              className="translate-bubble-status translate-bubble-btn"
              onClick={() => {
                aiAssistService.cancel().catch(() => undefined);
                close();
              }}
              title={t("ai.stop")}
            >
              {t("ai.stop")}
            </button>
          )}
          {showActions && result && (
            <span
              className="translate-bubble-tokens"
              title={`${t("translate.tokensIn")} ${result.promptTokens} + ${t("translate.tokensOut")} ${result.completionTokens}`}
            >
              ↑{result.promptTokens} ↓{result.completionTokens} {t("translate.tokens")}
            </span>
          )}
          <button
            className="translate-bubble-close"
            onClick={() => {
              aiAssistService.cancel().catch(() => undefined);
              close();
            }}
            title={t("common.close")}
          >
            ×
          </button>
        </div>

        <div className="translate-bubble-body">
          {status === "error" ? (
            <div className="translate-bubble-error">
              <div>{t(aiErrorKey(errorCode ?? "NETWORK"))}</div>
              {errorDetail && <div className="translate-bubble-error-detail">{errorDetail}</div>}
              <button className="translate-bubble-retry" onClick={onRetry}>
                {t("translate.retry")}
              </button>
            </div>
          ) : (
            <div className="translate-bubble-text">{visualizePlaceholders(shownText)}</div>
          )}
        </div>

        {showActions && result && (
          <div className="translate-bubble-actions">
            <button
              className="translate-bubble-btn primary"
              onClick={() => onApply(task, result!.translated)}
            >
              {t(aiTaskApplyKey(task))}
            </button>
            <button className="translate-bubble-btn" onClick={handleCopy}>
              {copied ? t("translate.copied") : t("translate.copy")}
            </button>
            {/* v0.7.3 U5：done 态也提供"重试" */}
            <button className="translate-bubble-btn" onClick={onRetry}>
              {t("translate.retry")}
            </button>
          </div>
        )}

        {/* v0.7.4 功能4/功能6：摘要窗口右下角拖拽缩放手柄（放大摘要气泡） */}
        {isSummary && (
          <span
            className="ai-bubble-resize-handle"
            data-testid="ai-bubble-resize-handle"
            onMouseDown={(e) => onDragStart("resize", e)}
          />
        )}
      </div>
    </>,
    document.body
  );
}