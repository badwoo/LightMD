/**
 * TranslateBubble —— AI 翻译结果气泡（v0.6.0）
 *
 * 行为：
 * - 消费 translateStore：idle 不渲染；loading/streaming 流式文本；done 操作按钮
 * - rAF 批量刷新流式文本（chunk 入队，每帧合并 flush，避免高频 setState）
 * - Esc 关闭并取消进行中的任务
 * - 错误态：错误码 → 本地化文案 + 重试按钮
 * - 警告态：占位符失配（placeholdersIntact=false）→ 提示建议双语模式
 * - sourceMode=preview（iframe 纯文本通道）时隐藏替换/双语（无 PM view 可回写）
 *
 * 定位：传入锚点（视口坐标），气泡置于锚点右下方，越界自动调整。
 * 主题：全部使用 CSS 变量，自动适配 6 主题。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslateStore } from "../../stores/translateStore";
import { translateService, type TranslateErrorCode } from "../../services/translateService";
import { useT } from "../../i18n";
import "./TranslateBubble.css";

interface TranslateBubbleProps {
  /** 回写译文到编辑器（mode: replace | bilingual）。由挂载点接线到 translateBridge */
  onApply: (mode: "replace" | "bilingual", translated: string) => void;
  /** 复制译文到剪贴板（返回 Promise<boolean> 由调用方实现） */
  onCopy: (text: string) => void;
  /** 重试上次翻译（入口层持有原选区文本） */
  onRetry: () => void;
}

/** 错误码 → i18n 键映射（导出供测试） */
export function translateErrorKey(code: string): string {
  // v0.6.3 P2-2：CANCELLED 不在列——runTranslate 在 CANCELLED 时静默返回，永不进 fail，文案不可达
  // v0.6.3 P2-1：NO_KEY 接线（Key 未配置，与 AUTH 的 Key 无效区分）
  const known: TranslateErrorCode[] = [
    "NETWORK", "AUTH", "RATE", "TRUNCATED", "STREAM",
    "PROVIDER", "TOO_LONG", "EMPTY", "NO_KEY",
    "DOC_CHANGED",
  ];
  return known.includes(code as TranslateErrorCode)
    ? `translate.error.${code}`
    : "translate.error.NETWORK";
}

/** 计算气泡位置（视口坐标，导出供测试） */
export function computeBubblePosition(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
  bubbleSize = { width: 380, height: 220 }
): { left: number; top: number } {
  const GAP = 8;
  const MARGIN = 8;
  let x = anchor.x;
  let y = anchor.y + GAP;
  // 右边界溢出 → 左移
  if (x + bubbleSize.width > viewport.width - MARGIN) {
    x = Math.max(MARGIN, viewport.width - bubbleSize.width - MARGIN);
  }
  // 底部溢出 → 显示在锚点上方
  if (y + bubbleSize.height > viewport.height - MARGIN) {
    y = Math.max(MARGIN, anchor.y - GAP - bubbleSize.height);
  }
  return { left: x, top: y };
}

export function TranslateBubble({ onApply, onCopy, onRetry }: TranslateBubbleProps) {
  const t = useT();
  const status = useTranslateStore((s) => s.status);
  const sourceMode = useTranslateStore((s) => s.sourceMode);
  const errorCode = useTranslateStore((s) => s.errorCode);
  const errorDetail = useTranslateStore((s) => s.errorDetail);
  const result = useTranslateStore((s) => s.result);
  const anchor = useTranslateStore((s) => s.anchor);
  const close = useTranslateStore((s) => s.close);

  // rAF 批量刷新流式文本
  const [displayText, setDisplayText] = useState("");
  const stateRef = useRef({ pending: "", raf: 0 });

  useEffect(() => {
    const ref = stateRef.current;
    const flush = () => {
      ref.raf = 0;
      // 先快照再清空：setState updater 异步执行，直接读 ref.pending 会拿到空串
      const text = ref.pending;
      ref.pending = "";
      setDisplayText((prev) => prev + text);
    };
    const unsub = useTranslateStore.subscribe((state, prev) => {
      // 新任务（loading 重置）时清空显示
      if (state.status === "loading" && prev.status !== "loading") {
        setDisplayText("");
        return;
      }
      if (state.streamedText !== prev.streamedText) {
        // 流式文本只增不减（正常追加）；异常回退时整体替换
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

  // done 时确保完整译文显示（流式 tail 与最终结果可能有细微差异）
  const finalText = status === "done" && result ? result.translated : displayText;

  // Esc 关闭 + 取消
  useEffect(() => {
    if (status === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        translateService.cancel().catch(() => undefined);
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [status, close]);

  // 双击气泡外任意空白处关闭（气泡打开期间监听；气泡内双击不关闭）
  useEffect(() => {
    if (status === "idle") return;
    const onDblClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(".translate-bubble")) return;
      close();
    };
    window.addEventListener("dblclick", onDblClick);
    return () => window.removeEventListener("dblclick", onDblClick);
  }, [status, close]);

  // 复制成功反馈
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!finalText) return;
    onCopy(finalText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [finalText, onCopy]);

  // 位置计算（视口坐标）
  const style = useMemo(() => {
    if (!anchor) return {};
    return computeBubblePosition(
      anchor,
      { width: window.innerWidth, height: window.innerHeight }
    );
  }, [anchor]);

  if (status === "idle" || !anchor) return null;

  const isPreview = sourceMode === "preview";
  const showActions = status === "done" && result;
  const showWarning = result && !result.placeholdersIntact;

  return createPortal(
    <div className="translate-bubble" style={style} data-testid="translate-bubble">
      <div className="translate-bubble-header">
        <span className="translate-bubble-title">
          {t("translate.title")}
          {status === "loading" && <span className="translate-bubble-loading">…</span>}
        </span>
        {status === "streaming" && (
          <span className="translate-bubble-status">{t("translate.streaming")}</span>
        )}
        {showActions && result && (
          <span className="translate-bubble-tokens">
            {result.promptTokens + result.completionTokens} {t("translate.tokens")}
          </span>
        )}
        <button
          className="translate-bubble-close"
          onClick={() => {
            translateService.cancel().catch(() => undefined);
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
            <div>{t(translateErrorKey(errorCode ?? "NETWORK"))}</div>
            {errorDetail && <div className="translate-bubble-error-detail">{errorDetail}</div>}
            <button className="translate-bubble-retry" onClick={onRetry}>
              {t("translate.retry")}
            </button>
          </div>
        ) : (
          <div className="translate-bubble-text">{finalText}</div>
        )}
      </div>

      {showWarning && status === "done" && (
        <div className="translate-bubble-warning">{t("translate.warning.placeholders")}</div>
      )}

      {showActions && (
        <div className="translate-bubble-actions">
          {!isPreview && (
            <>
              <button
                className="translate-bubble-btn primary"
                onClick={() => onApply("replace", result!.translated)}
              >
                {t("translate.replace")}
              </button>
              <button
                className="translate-bubble-btn"
                onClick={() => onApply("bilingual", result!.translated)}
              >
                {t("translate.bilingual")}
              </button>
            </>
          )}
          <button className="translate-bubble-btn" onClick={handleCopy}>
            {copied ? t("translate.copied") : t("translate.copy")}
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}
