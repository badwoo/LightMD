/**
 * FullTranslateButton —— 全文翻译悬浮按钮（v0.7.0 改版）
 *
 * 行为：
 * - 固定悬浮于阅读区域右上角（不随文档滚动）
 * - 点击：全文翻译（运行中点击 = 取消）
 * - v0.7.0 功能优化3a：右键 → 菜单「关闭 AI 翻译」（translateEnabled=false）
 * - v0.7.0 功能优化3b：hover → 按钮下方由右至左滑出子设置图标（齿轮），
 *   点击展开快捷设置面板：目标语言 / 语体 / 结果模式 / 选中文本翻译气泡显隐开关
 * - 样式全部使用 CSS 变量，自动适配 6 主题
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useFullTranslateStore } from "../../stores/fullTranslateStore";
import { useSettingsStore, type TranslateSettings } from "../../stores/useSettingsStore";
import { MiniContextMenu } from "./MiniContextMenu";
import "./FullTranslateButton.css";

interface FullTranslateButtonProps {
  /** 触发全文翻译（运行中调用表示取消） */
  onStart: () => void;
}

export function FullTranslateButton({ onStart }: FullTranslateButtonProps) {
  const t = useT();
  const status = useFullTranslateStore((s) => s.status);
  const doneCount = useFullTranslateStore((s) => s.doneCount);
  const totalCount = useFullTranslateStore((s) => s.totalCount);
  const running = status === "running";
  const translate = useSettingsStore((s) => s.translate);
  const setTranslateConfig = useSettingsStore((s) => s.setTranslateConfig);

  // v0.7.0：hover 滑出子设置图标；面板展开状态；右键菜单位置
  const [hovered, setHovered] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 面板打开时：点击 wrap 外部关闭（mousedown 捕获，与字数详情面板一致）
  useEffect(() => {
    if (!settingsOpen) return;
    const handle = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [settingsOpen]);

  return (
    <div
      className="ftb-wrap"
      ref={wrapRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`full-translate-btn${running ? " running" : ""}`}
        title={running ? t("translate.full.runningTip") : t("translate.full.title")}
        aria-label={t("translate.full.title")}
        onClick={onStart}
        onContextMenu={(e) => {
          // v0.7.0 功能优化3a：右键菜单 → 关闭 AI 翻译
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        {/* 「译」字气泡：与 PM 选区触发按钮同款图形（v0.6.1 问题5） */}
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
          <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-4.2 3.5c-.5.4-1.3.1-1.3-.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
          <text x="12" y="13.5" textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--bg-primary)">译</text>
        </svg>
        {running && (
          <span className="full-translate-progress">
            {doneCount}/{totalCount}
          </span>
        )}
      </button>

      {/* v0.7.0 功能优化3b：子设置图标（hover 由右至左滑出，面板展开时常驻） */}
      <button
        type="button"
        className={`ftb-settings-trigger${hovered || settingsOpen ? " show" : ""}`}
        title={t("translate.entry.settings")}
        aria-label={t("translate.entry.settings")}
        data-testid="ftb-settings-trigger"
        onClick={() => setSettingsOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* v0.7.0 功能优化3a：右键菜单（关闭 AI 翻译） */}
      {menuPos && (
        <MiniContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={[
            {
              action: "disable-ai-translate",
              label: t("translate.menu.disableAI"),
              onClick: () => setTranslateConfig({ translateEnabled: false }),
            },
          ]}
          onClose={() => setMenuPos(null)}
        />
      )}

      {/* v0.7.0 功能优化3b：快捷设置面板（目标语言 / 语体 / 结果模式 / 气泡显隐） */}
      {settingsOpen && (
        <div className="ftb-settings-panel" data-testid="ftb-settings-panel" role="dialog">
          <div className="ftb-settings-row">
            <label>{t("settings.translate.targetLang")}</label>
            <select
              value={translate.translateTargetLang}
              data-testid="ftb-target-lang"
              onChange={(e) => setTranslateConfig({ translateTargetLang: e.target.value })}
            >
              <option value="auto">{t("settings.translate.targetLang.auto")}</option>
              <option value="简体中文">简体中文</option>
              <option value="English">English</option>
              <option value="日本語">日本語</option>
              <option value="한국어">한국어</option>
            </select>
          </div>
          <div className="ftb-settings-row">
            <label>{t("settings.translate.tone")}</label>
            <select
              value={translate.translateTone}
              data-testid="ftb-tone"
              onChange={(e) => setTranslateConfig({ translateTone: e.target.value })}
            >
              <option value="正式">{t("settings.translate.tone.formal")}</option>
              <option value="口语">{t("settings.translate.tone.casual")}</option>
              <option value="技术文档">{t("settings.translate.tone.technical")}</option>
            </select>
          </div>
          <div className="ftb-settings-row">
            <label>{t("settings.translate.resultMode")}</label>
            <select
              value={translate.translateResultMode}
              data-testid="ftb-result-mode"
              onChange={(e) =>
                setTranslateConfig({
                  translateResultMode: e.target.value as TranslateSettings["translateResultMode"],
                })
              }
            >
              <option value="bubble">{t("settings.translate.resultMode.bubble")}</option>
              <option value="replace">{t("settings.translate.resultMode.replace")}</option>
              <option value="bilingual">{t("settings.translate.resultMode.bilingual")}</option>
              <option value="clipboard">{t("settings.translate.resultMode.clipboard")}</option>
            </select>
          </div>
          <div className="ftb-settings-row">
            <label>{t("translate.entry.showBubble")}</label>
            <button
              type="button"
              className={`ftb-toggle${translate.translateBubbleHidden ? "" : " on"}`}
              role="switch"
              aria-checked={!translate.translateBubbleHidden}
              data-testid="ftb-bubble-toggle"
              title={t("translate.entry.showBubble")}
              onClick={() =>
                setTranslateConfig({ translateBubbleHidden: !translate.translateBubbleHidden })
              }
            >
              <span className="ftb-toggle-knob" />
            </button>
          </div>
          {/* v0.7.0 修复4：气泡延迟出现设置（滑条 0~2s 步进 0.1s，默认 0.5s）
              仅「选中文本翻译气泡」开启时可设置（关闭时隐藏，避免无效配置） */}
          {!translate.translateBubbleHidden && (
            <div className="ftb-settings-row ftb-delay-row" data-testid="ftb-bubble-delay-row">
              <label>{t("translate.entry.bubbleDelay")}</label>
              <div className="ftb-delay-slider">
                <input
                  type="range"
                  min={0}
                  max={2000}
                  step={100}
                  value={translate.translateBubbleDelayMs}
                  data-testid="ftb-bubble-delay"
                  aria-label={t("translate.entry.bubbleDelay")}
                  onChange={(e) =>
                    setTranslateConfig({ translateBubbleDelayMs: Number(e.target.value) })
                  }
                />
                <span className="ftb-delay-value">
                  {(translate.translateBubbleDelayMs / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          )}
          {/* v0.7.5 功能3：「译」气泡颜色（与设置页「翻译设置」同一字段，单源；
              清空（✕）→ 移除 CSS 变量回退主题默认色） */}
          <div className="ftb-settings-row" data-testid="ftb-bubble-color-row">
            <label>{t("translate.entry.bubbleColor")}</label>
            <div className="ftb-color-row">
              <input
                type="color"
                value={translate.translateBubbleColor || "#4a9eff"}
                data-testid="ftb-bubble-color"
                aria-label={t("translate.entry.bubbleColor")}
                onChange={(e) => setTranslateConfig({ translateBubbleColor: e.target.value })}
              />
              <button
                type="button"
                className="ftb-color-reset"
                title={t("settings.translate.bubbleColorReset")}
                data-testid="ftb-bubble-color-reset"
                onClick={() => setTranslateConfig({ translateBubbleColor: "" })}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
