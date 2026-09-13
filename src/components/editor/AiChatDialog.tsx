/**
 * AiChatDialog —— AI 对话浮动窗口（v0.7.5 功能1）
 *
 * 设计要点（实施计划 §2.3/§2.4）：
 * - 自研轻量浮动层（不用系统 Dialog）：标题栏拖拽移动、右下角拖拽缩放、
 *   [—] 折叠为输入条、[×]/Esc 关闭；z-index 1200（高于翻译气泡 1000，
 *   低于 MiniContextMenu 2100）
 * - 三个入口共用同一窗口：底部栏「AI对话」按钮 / Ctrl+K / 选区「问」气泡
 * - 上下文 chip 三档一键循环（选区 / 全文 / 无）+ 快捷指令模板 chips
 * - 每条 AI 消息自带动作条：插入光标处 / 替换选区（有选区时）/ 替换全文
 *   （「改写全文」模板或右键动作条）/ 复制 / 重新生成（仅最后一条）
 * - 流式文本用 rAF 批量刷新（与 TranslateBubble/AiAssistBubble 同款策略），
 *   避免每个 chunk 触发一次 React 渲染
 * - 窗口几何计算与上下文 chip 文案抽为导出的纯函数，便于单元测试
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useAiChatStore } from "../../stores/aiChatStore";
import type { AiChatContextPreview } from "../../stores/aiChatStore";
import { MAX_CHAT_DOCUMENT_CHARS, type AiChatContextScope } from "../../services/aiChatService";
import {
  MAX_SELECTION_CHARS,
  parseTranslateError,
  TranslateServiceError,
  translateService,
} from "../../services/translateService";
import { notifyWarning } from "../../services/notificationService";
import {
  AI_CHAT_MIN_SIZE,
  DEFAULT_AI_CHAT_SIZE,
  isAiChatRectVisible,
  useSettingsStore,
  type AiChatWindowRect,
} from "../../stores/useSettingsStore";
import {
  AI_CHAT_TEMPLATES,
  resolveTemplateInstruction,
  resolveTemplateScope,
  type AiChatTemplate,
} from "../../utils/aiChatTemplates";
import { MiniContextMenu } from "./MiniContextMenu";
import "./AiChatDialog.css";

// ─── 窗口几何（纯函数，导出供测试）─────────────────────────

/**
 * 默认窗口布局：宽 560 × 高 480，水平居中、垂直 12% 处（§5）。
 * 视口过小时整体收缩，保证不越界。
 */
export function computeDefaultChatRect(viewport: { width: number; height: number }): AiChatWindowRect {
  const w = Math.min(DEFAULT_AI_CHAT_SIZE.w, Math.max(AI_CHAT_MIN_SIZE.w, viewport.width - 24));
  const h = Math.min(DEFAULT_AI_CHAT_SIZE.h, Math.max(AI_CHAT_MIN_SIZE.h, viewport.height - 24));
  return {
    x: Math.max(8, Math.round((viewport.width - w) / 2)),
    y: Math.max(8, Math.round(viewport.height * 0.12)),
    w,
    h,
  };
}

/**
 * v0.7.5 优化5：窗口尺寸钳制（**不再限制位置**）。
 *
 * 原实现同时钳制位置（至少保留 80×40 在视口内），导致用户无法把窗口拖到
 * 屏幕任意位置（例如拖到副屏、拖到边缘外）。现按用户要求打开位置限制：
 * - 拖拽移动：完全自由（由 onDragStart 直接用位移结果，不过此函数）
 * - 尺寸：仍钳制到 [最小值, 视口-8]，避免缩放到 0 或撑出无意义的巨框
 *
 * 位置记忆的安全网保留在 baseRect：下次**重新打开**时若记忆矩形完全落在
 * 视口外（换显示器/分辨率变小），回落默认居中，避免窗口"打不开"。
 */
export function clampChatRect(
  rect: AiChatWindowRect,
  viewport: { width: number; height: number }
): AiChatWindowRect {
  const maxW = Math.max(AI_CHAT_MIN_SIZE.w, viewport.width - 8);
  const maxH = Math.max(AI_CHAT_MIN_SIZE.h, viewport.height - 8);
  const w = Math.min(Math.max(rect.w, AI_CHAT_MIN_SIZE.w), maxW);
  const h = Math.min(Math.max(rect.h, AI_CHAT_MIN_SIZE.h), maxH);
  // v0.7.5 优化5：位置原样保留（打开拖动限制）
  return { x: rect.x, y: rect.y, w, h };
}

// ─── 上下文 chip（纯函数，导出供测试）───────────────────────

/** 上下文范围循环顺序：selection → document → none → selection（无选区时跳过 selection） */
export function nextChatScope(
  current: AiChatContextScope,
  hasSelection: boolean
): AiChatContextScope {
  if (current === "selection") return "document";
  if (current === "document") return "none";
  return hasSelection ? "selection" : "document";
}

/** chip 文案（§2.5：`选区 128 字` / `全文 5,231 字` / `全文 38,000 字（截断至 20,000）` / `无上下文`） */
export function chatContextChipText(
  preview: AiChatContextPreview | null,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (!preview) return t("ai.chat.ctx.none");
  const { actualScope, chars, truncated, degraded } = preview;
  if (actualScope === "none") return t("ai.chat.ctx.none");
  const count = chars.toLocaleString();
  if (degraded) return t("ai.chat.ctx.degraded", { count });
  if (actualScope === "selection") return t("ai.chat.ctx.selection", { count });
  if (truncated) {
    return t("ai.chat.ctx.documentTruncated", {
      count,
      max: MAX_CHAT_DOCUMENT_CHARS.toLocaleString(),
    });
  }
  return t("ai.chat.ctx.document", { count });
}

/** 拖拽终点提交（拖拽期间只改本地 state，mouseup 才写 store + 持久化） */
type DragMode = "move" | "resize";

interface AiChatDialogProps {
  /** 提交指令（入口层负责发送时重新提取上下文、流式与元信息记录） */
  onSend: (instruction: string, templateId: string | null) => void;
  /** 停止当前流式任务（并作废其后续回调） */
  onStop: () => void;
  /** 重新生成最后一条 AI 回复 */
  onRegenerate: () => void;
  /** 插入到光标处 */
  onInsertAtCursor: (text: string) => void;
  /** 替换发送时的选区快照（上下文含选区时才显示该动作） */
  onReplaceSelection: (text: string) => void;
  /** 替换全文（DOC_CHANGED 守卫在入口层） */
  onReplaceDocument: (text: string) => void;
  /** 复制 */
  onCopy: (text: string) => void;
  /** 上下文范围切换（入口层重新提取预览） */
  onScopeChange: (scope: AiChatContextScope) => void;
}

export function AiChatDialog({
  onSend,
  onStop,
  onRegenerate,
  onInsertAtCursor,
  onReplaceSelection,
  onReplaceDocument,
  onCopy,
  onScopeChange,
}: AiChatDialogProps) {
  const t = useT();
  const open = useAiChatStore((s) => s.open);
  const minimized = useAiChatStore((s) => s.minimized);
  const rect = useAiChatStore((s) => s.rect);
  const messages = useAiChatStore((s) => s.messages);
  const status = useAiChatStore((s) => s.status);
  const errorCode = useAiChatStore((s) => s.errorCode);
  const errorDetail = useAiChatStore((s) => s.errorDetail);
  const contextScope = useAiChatStore((s) => s.contextScope);
  const contextPreview = useAiChatStore((s) => s.contextPreview);
  const closeWindow = useAiChatStore((s) => s.closeWindow);
  const toggleMinimize = useAiChatStore((s) => s.toggleMinimize);
  const setRect = useAiChatStore((s) => s.setRect);
  const setAiChatWindow = useSettingsStore((s) => s.setAiChatWindow);

  const [input, setInput] = useState("");
  /** 最近一次点击的快捷指令模板 id（动作条据此决定是否展示「替换全文」） */
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  /**
   * v0.7.5 优化4：窗口内嵌 AI 翻译——每条回答的译文（index → 译文）。
   * 点「译」把该条回答替换为译文，再点（显示为「原文」）还原。
   */
  const [translations, setTranslations] = useState<Record<number, string>>({});
  /** 正在翻译中的消息序号（按钮显示 …） */
  const [translatingIdx, setTranslatingIdx] = useState<number | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 1200 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  const [localRect, setLocalRect] = useState<AiChatWindowRect | null>(null);
  const localRectRef = useRef<AiChatWindowRect | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const busy = status === "loading" || status === "streaming";
  const hasSelection = contextPreview?.actualScope === "selection" && !contextPreview.degraded;
  // 翻译设置里的目标语言（模板预填指令与窗口内翻译共用同一配置）
  const targetLang = useSettingsStore((s) => s.translate.translateTargetLang);

  // 会话重置/重开时清空译文缓存（消息序号会重新从 0 开始，旧译文会错位）
  useEffect(() => {
    if (!open) setTranslations({});
  }, [open]);
  useEffect(() => {
    if (messages.length === 0) setTranslations({});
  }, [messages.length]);

  // ─── 流式文本 rAF 批量刷新（与 AiAssistBubble 同款：chunk 入队，每帧合并）───
  const [streamDisplay, setStreamDisplay] = useState("");
  useEffect(() => {
    const ref = { pending: "", raf: 0 };
    const flush = () => {
      ref.raf = 0;
      const text = ref.pending;
      ref.pending = "";
      if (text) setStreamDisplay((prev) => prev + text);
    };
    const unsub = useAiChatStore.subscribe((state, prev) => {
      // 新一轮请求开始 / 结束 / 取消：清空流式缓冲（避免与历史消息重复显示）
      if (state.status !== prev.status) {
        if (state.status === "loading" || state.status === "done" || state.status === "idle") {
          ref.pending = "";
          if (ref.raf) {
            cancelAnimationFrame(ref.raf);
            ref.raf = 0;
          }
          setStreamDisplay("");
          if (state.status === "loading") return;
        }
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

  // ─── 视口变化：重算尺寸上限（显示器变更后窗口仍可用）───
  useEffect(() => {
    if (!open) return;
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // 窗口基准矩形：有设置记忆且仍在视口内 → 复原；否则默认居中（功能6）。
  // 拖拽/缩放过程中用 localRect 覆盖（每帧只更新本地 state，松手才落盘）。
  const baseRect = useMemo(
    () =>
      isAiChatRectVisible(rect, viewport) && rect
        ? rect
        : computeDefaultChatRect(viewport),
    [rect, viewport]
  );

  // 每次打开重置拖拽态，使新会话回到"设置记忆/默认居中"基准
  useEffect(() => {
    if (!open) return;
    setLocalRect(null);
    localRectRef.current = null;
  }, [open]);

  // 每次打开聚焦输入框（Ctrl+K 后可直接输入指令）
  useEffect(() => {
    if (!open || minimized) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, minimized]);

  // 新消息/流式增量时贴底滚动（仅列表内部滚动，不影响页面）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streamDisplay, status]);

  const effective = useMemo(
    () => clampChatRect(localRect ?? baseRect, viewport),
    [localRect, baseRect, viewport]
  );

  // ─── 拖拽移动 / 缩放（拖拽中只更新本地 state，mouseup 才落盘）───
  const onDragStart = useCallback(
    (mode: DragMode, e: React.MouseEvent) => {
      e.preventDefault();
      const start = {
        sx: e.clientX,
        sy: e.clientY,
        x: effective.x,
        y: effective.y,
        w: effective.w,
        h: effective.h,
      };
      const vp = { width: window.innerWidth, height: window.innerHeight };
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - start.sx;
        const dy = ev.clientY - start.sy;
        // v0.7.5 优化5：移动时位置自由（clampChatRect 已只钳制尺寸），
        // 用户可把窗口拖到屏幕任意位置（含边缘外、副屏）
        const next =
          mode === "move"
            ? clampChatRect({ x: start.x + dx, y: start.y + dy, w: start.w, h: start.h }, vp)
            : clampChatRect({ x: start.x, y: start.y, w: start.w + dx, h: start.h + dy }, vp);
        localRectRef.current = next;
        setLocalRect(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const final = localRectRef.current;
        if (!final) return;
        setRect(final); // 当前会话立即生效
        setAiChatWindow(final); // 功能6：仅在拖拽/缩放结束时持久化
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [effective, setRect, setAiChatWindow]
  );

  // ─── 关闭 / 停止 ───
  const handleClose = useCallback(() => {
    if (busy) onStop();
    closeWindow();
  }, [busy, onStop, closeWindow]);

  // Esc 关闭（流式中先停止任务再关闭）；capture 阶段拦截，避免触发其他 Esc 快捷键
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, handleClose]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    onSend(text, activeTemplateId);
    setInput("");
    setActiveTemplateId(null);
  }, [input, busy, onSend, activeTemplateId]);

  const applyTemplate = useCallback(
    (tpl: AiChatTemplate) => {
      // v0.7.5 优化4：AI 翻译模板的指令需按当前目标语言填充（auto → 中英互译表述）
      setInput(resolveTemplateInstruction(tpl, t, targetLang));
      setActiveTemplateId(tpl.id);
      // 模板自带默认上下文范围（有选区且模板偏好选区时优先选区）
      const next = resolveTemplateScope(tpl, hasSelection, contextScope);
      if (next !== contextScope) onScopeChange(next);
      inputRef.current?.focus();
    },
    [t, hasSelection, contextScope, onScopeChange, targetLang]
  );

  /**
   * v0.7.5 优化4：窗口内嵌 AI 翻译——把该条回答翻译为当前目标语言并就地替换显示，
   * 再点还原原文。复用 translateService（与翻译气泡同一任务槽与错误协议）。
   * 回答可能超长（选中翻译上限 4000 字），超限时提示而不是静默失败。
   */
  const handleTranslateMessage = useCallback(
    async (text: string, index: number) => {
      // 已有译文 → 再点还原原文
      if (translations[index] !== undefined) {
        setTranslations((prev) => {
          const next = { ...prev };
          delete next[index];
          return next;
        });
        return;
      }
      if (text.length > MAX_SELECTION_CHARS) {
        notifyWarning(t("ai.chat.translateTooLong"));
        return;
      }
      setTranslatingIdx(index);
      try {
        const r = await translateService.translate(text, () => undefined);
        setTranslations((prev) => ({ ...prev, [index]: r.translated }));
      } catch (e) {
        const info = e instanceof TranslateServiceError ? e.info : parseTranslateError(e);
        // 用户主动取消不提示（与其他 AI 入口一致）
        if (info.code !== "CANCELLED") notifyWarning(t(`translate.error.${info.code}`));
      } finally {
        setTranslatingIdx((cur) => (cur === index ? null : cur));
      }
    },
    [translations, t]
  );

  /** v0.7.5 优化4：窗口内翻译时，源语言跟随设置（auto 时由后端按 CJK 占比判向） */

  const handleCopy = useCallback(
    (text: string, index: number) => {
      onCopy(text);
      setCopiedIdx(index);
      setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 1500);
    },
    [onCopy]
  );

  if (!open) return null;

  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

  const menuMsg = menu ? messages[menu.index] : null;
  /**
   * v0.7.5 优化4：该条消息当前展示的文本。
   * 若用户点过「译」，展示与动作（插入/替换/复制）都使用译文——这样
   * "选区 → 问 → AI翻译 → 替换选区"就是一条完整的窗口内翻译闭环。
   */
  const displayTextOf = (index: number): string => translations[index] ?? messages[index].content;

  const windowStyle: React.CSSProperties = minimized
    ? {
        left: `${effective.x}px`,
        top: `${effective.y}px`,
        width: "360px",
        height: "48px",
      }
    : {
        left: `${effective.x}px`,
        top: `${effective.y}px`,
        width: `${effective.w}px`,
        height: `${effective.h}px`,
      };

  return createPortal(
    <div
      className={`ai-chat-dialog${minimized ? " minimized" : ""}`}
      style={windowStyle}
      role="dialog"
      aria-label={t("ai.chat.title")}
      data-testid="ai-chat-dialog"
    >
      {/* 标题栏：拖拽移动手柄 + 收起/关闭 */}
      <div
        className="ai-chat-header"
        onMouseDown={minimized ? undefined : (e) => onDragStart("move", e)}
        data-testid="ai-chat-header"
      >
        <span className="ai-chat-title">{t("ai.chat.title")}</span>
        <button
          type="button"
          className="ai-chat-headbtn"
          title={minimized ? t("ai.chat.expand") : t("ai.chat.minimize")}
          data-testid="ai-chat-minimize"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={toggleMinimize}
        >
          {minimized ? "▢" : "—"}
        </button>
        <button
          type="button"
          className="ai-chat-headbtn"
          title={t("ai.chat.close")}
          data-testid="ai-chat-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleClose}
        >
          ×
        </button>
      </div>

      {!minimized && (
        <>
          {/* 上下文 chip（三档循环切换 + 字数/截断/降级明示） */}
          <div className="ai-chat-context">
            <span className="ai-chat-context-label">{t("ai.chat.ctx.label")}</span>
            <button
              type="button"
              className="ai-chat-chip"
              title={t("ai.chat.ctx.switchHint")}
              data-testid="ai-chat-context-chip"
              data-scope={contextPreview?.actualScope ?? "none"}
              onClick={() => onScopeChange(nextChatScope(contextScope, hasSelection))}
            >
              {chatContextChipText(contextPreview, t)}
              <span className="ai-chat-chip-caret" aria-hidden="true">▾</span>
            </button>
          </div>

          {/* 快捷指令模板 chips（点击预填输入框，可编辑后再发） */}
          <div className="ai-chat-templates" data-testid="ai-chat-templates">
            <span className="ai-chat-context-label">{t("ai.chat.templates")}</span>
            <div className="ai-chat-template-list">
              {AI_CHAT_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className={`ai-chat-tpl${activeTemplateId === tpl.id ? " active" : ""}`}
                  data-template={tpl.id}
                  data-testid={`ai-chat-tpl-${tpl.id}`}
                  title={resolveTemplateInstruction(tpl, t, targetLang)}
                  onClick={() => applyTemplate(tpl)}
                >
                  {t(tpl.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 消息区：多轮对话，流式渲染最后一条 */}
          <div className="ai-chat-body" ref={listRef} data-testid="ai-chat-body">
            {messages.length === 0 && !busy && (
              <div className="ai-chat-empty">{t("ai.chat.empty")}</div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`ai-chat-msg ai-chat-msg-${msg.role}`}
                data-testid={`ai-chat-msg-${msg.role}-${i}`}
              >
                {/* v0.7.5 优化4：展示译文（若已翻译），否则原文 */}
                <div className="ai-chat-bubble" data-translated={translations[i] !== undefined || undefined}>
                  {displayTextOf(i)}
                </div>
                {msg.role === "assistant" && (
                  <div
                    className="ai-chat-actions"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, index: i });
                    }}
                  >
                    <button
                      type="button"
                      className="ai-chat-act primary"
                      data-action="insert"
                      onClick={() => onInsertAtCursor(displayTextOf(i))}
                    >
                      {t("ai.chat.action.insert")}
                    </button>
                    {msg.meta?.hadSelection && (
                      <button
                        type="button"
                        className="ai-chat-act"
                        data-action="replace-selection"
                        onClick={() => onReplaceSelection(displayTextOf(i))}
                      >
                        {t("ai.chat.action.replaceSelection")}
                      </button>
                    )}
                    {msg.meta?.templateId === "rewrite" && (
                      <button
                        type="button"
                        className="ai-chat-act"
                        data-action="replace-document"
                        onClick={() => onReplaceDocument(displayTextOf(i))}
                      >
                        {t("ai.chat.action.replaceDoc")}
                      </button>
                    )}
                    {/* v0.7.5 优化4：窗口内嵌 AI 翻译——就地译 / 还原该条回答。
                        流式中禁用：翻译与对话共用单任务槽，点击会取消进行中的对话 */}
                    <button
                      type="button"
                      className="ai-chat-act"
                      data-action="translate"
                      disabled={busy || translatingIdx === i}
                      title={t("ai.chat.action.translate")}
                      onClick={() => handleTranslateMessage(msg.content, i)}
                    >
                      {translatingIdx === i
                        ? "…"
                        : translations[i] !== undefined
                          ? t("ai.chat.action.translateBack")
                          : t("ai.chat.action.translate")}
                    </button>
                    <button
                      type="button"
                      className="ai-chat-act"
                      data-action="copy"
                      onClick={() => handleCopy(displayTextOf(i), i)}
                    >
                      {copiedIdx === i ? t("ai.chat.action.copied") : t("ai.chat.action.copy")}
                    </button>
                    {i === lastAssistantIdx && !busy && (
                      <button
                        type="button"
                        className="ai-chat-act"
                        data-action="regenerate"
                        onClick={onRegenerate}
                      >
                        {t("ai.chat.action.regenerate")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* 流式中的临时 assistant 气泡 */}
            {busy && (
              <div className="ai-chat-msg ai-chat-msg-assistant" data-testid="ai-chat-streaming">
                <div className="ai-chat-bubble">
                  {streamDisplay || t("ai.chat.loading")}
                  <span className="ai-chat-caret" aria-hidden="true">▍</span>
                </div>
              </div>
            )}

            {status === "error" && (
              <div className="ai-chat-error" data-testid="ai-chat-error">
                <div>{t(errorKey(errorCode))}</div>
                {errorDetail && <div className="ai-chat-error-detail">{errorDetail}</div>}
                {/* 失败时指令已从输入框清空，提供「重试」复用上一条指令重发
                    （没有 assistant 消息，动作条上的「重新生成」不可达） */}
                {messages.some((m) => m.role === "user") && (
                  <button
                    type="button"
                    className="ai-chat-act"
                    data-testid="ai-chat-error-retry"
                    onClick={onRegenerate}
                  >
                    {t("translate.retry")}
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* 输入区：Enter 发送 / Shift+Enter 换行；流式中发送键变停止键。
          折叠（minimized）态下保留——折叠语义就是"只剩输入条"（§2.3），
          且折叠不取消进行中的任务。 */}
      <div className="ai-chat-inputrow">
        <textarea
          ref={inputRef}
          className="ai-chat-input"
          rows={minimized ? 1 : 2}
          value={input}
          placeholder={t("ai.chat.placeholder")}
          aria-label={t("ai.chat.title")}
          data-testid="ai-chat-input"
          onChange={(e) => {
            setInput(e.target.value);
            // 手动改动指令后不再视为模板产物（「替换全文」按钮随之下线）
            setActiveTemplateId(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              // 输入法组合态下的 Enter 用于选词，不能当发送
              if (e.nativeEvent.isComposing) return;
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="ai-chat-send stop"
            data-testid="ai-chat-stop"
            onClick={onStop}
          >
            {t("ai.chat.stop")}
          </button>
        ) : (
          <button
            type="button"
            className="ai-chat-send"
            data-testid="ai-chat-send"
            disabled={!input.trim()}
            onClick={handleSend}
          >
            {t("ai.chat.send")}
          </button>
        )}
      </div>

      {/* 右下角缩放手柄（折叠态不显示） */}
      {!minimized && (
        <span
          className="ai-chat-resize"
          data-testid="ai-chat-resize"
          onMouseDown={(e) => onDragStart("resize", e)}
        />
      )}

      {/* 动作条右键菜单：任意 AI 消息均可选「替换全文 / 替换选区」 */}
      {menu && menuMsg && (
        <MiniContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              action: "chat-replace-doc",
              label: t("ai.chat.action.replaceDoc"),
              onClick: () => onReplaceDocument(displayTextOf(menu.index)),
            },
            ...(menuMsg.meta?.hadSelection
              ? [
                  {
                    action: "chat-replace-selection",
                    label: t("ai.chat.action.replaceSelection"),
                    onClick: () => onReplaceSelection(displayTextOf(menu.index)),
                  },
                ]
              : []),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>,
    document.body
  );
}

/** 错误码 → i18n key（EMPTY/TOO_LONG 用对话语境文案，其余复用翻译映射） */
function errorKey(code: string | null): string {
  if (!code) return "translate.error.NETWORK";
  if (code === "EMPTY") return "ai.error.empty";
  if (code === "TOO_LONG") return "ai.chat.error.tooLong";
  return `translate.error.${code}`;
}
