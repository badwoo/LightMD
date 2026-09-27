/**
 * v0.9.0：应用内多选一决策对话框（统一 v0.9.0 新增的四处交互）。
 *
 * 用途（实施计划 F13：统一用应用内对话框，不再用阻塞式 `window.confirm`）：
 * - 文件冲突（只读打开 / 强制编辑 / 切换到已有窗口 / 取消）
 * - 外部文件打开策略「询问」（当前窗口打开 / 新窗口打开 / 取消）
 * - 关闭窗口前的未保存确认（保存全部 / 不保存 / 取消）
 * - 保存时的磁盘竞态（覆盖 / 另存为 / 取消）
 *
 * 设计：本组件是纯展示 + 回调，文案由调用方（App.tsx）经 i18n 注入，
 * 因此可在 jsdom 下直接单测选项渲染与回调。
 */
import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import "./ChoiceDialog.css";

export interface ChoiceOption {
  /** 回调标识 */
  id: string;
  label: string;
  /** 选项下方的一行说明（可省略） */
  description?: string;
  /** 视觉权重：primary = 主操作，danger = 破坏性操作 */
  tone?: "default" | "primary" | "danger";
}

export interface ChoiceDialogProps {
  open: boolean;
  title: string;
  /** 主文案（可省略） */
  message?: string;
  /** 等宽显示的补充信息（文件路径等） */
  detail?: string;
  options: ChoiceOption[];
  cancelLabel: string;
  onChoose: (id: string) => void;
  onCancel: () => void;
}

export function ChoiceDialog({
  open,
  title,
  message,
  detail,
  options,
  cancelLabel,
  onChoose,
  onCancel,
}: ChoiceDialogProps) {
  const t = useT();
  const firstRef = useRef<HTMLButtonElement>(null);

  // 打开时把焦点交给第一个选项，键盘用户可直接回车确认
  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
  }, [open]);

  // Esc = 取消（与其它弹框一致的退出语义）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="choice-overlay"
      role="presentation"
      data-testid="choice-dialog"
      onMouseDown={(e) => {
        // 点击遮罩 = 取消（点击面板内部不冒泡取消）
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="choice-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="choice-header">
          <span className="choice-title">{title}</span>
          <button className="choice-close" title={t("common.close")} onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="choice-body">
          {message && <p className="choice-message">{message}</p>}
          {detail && <p className="choice-detail">{detail}</p>}
          <div className="choice-options">
            {options.map((opt, i) => (
              <button
                key={opt.id}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                className={`choice-option${opt.tone && opt.tone !== "default" ? ` choice-option-${opt.tone}` : ""}`}
                data-testid={`choice-option-${opt.id}`}
                onClick={() => onChoose(opt.id)}
              >
                <span className="choice-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="choice-option-desc">{opt.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="choice-footer">
          <button type="button" className="choice-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
