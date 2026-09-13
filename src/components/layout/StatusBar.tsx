import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useEditorStore } from "../../stores/useEditorStore";
import { useSettingsStore, type AiAssistBubbleTask } from "../../stores/useSettingsStore";
import { useT } from "../../i18n";
// v0.6.1：全文翻译进度（状态栏显示 + 取消）
import { useFullTranslateStore } from "../../stores/fullTranslateStore";
import { translateService } from "../../services/translateService";
import { translateErrorKey } from "../editor/TranslateBubble";
// v0.7.0 修复3：AI 任务状态（任务进行中 AI 抽屉保持展开）
import { useAiAssistStore } from "../../stores/aiAssistStore";
import "./StatusBar.css";

/** v0.7.0：AI 助手任务命令派发（续写/润色/摘要，EditorContainer 统一接线执行）
 *  v0.7.5：扩展 "chat"（AI 对话，派发 ai.chat 打开浮动窗口） */
export function dispatchAiCommand(task: "continue" | "polish" | "summary" | "chat") {
  window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: `ai.${task}` } }));
}

/**
 * v0.7.5 功能2：齿轮面板中"按任务独立隐藏"的勾选项定义。
 * 字形与 core/plugins/translateTooltip.AI_BUBBLE_DEFS 保持一致（单源），
 * 标签走 i18n（「续」续写气泡 / 「润」润色气泡 / 「摘」摘要气泡 / 「问」AI 对话气泡）。
 */
const AI_BUBBLE_TOGGLES: ReadonlyArray<{
  task: AiAssistBubbleTask;
  labelKey: string;
  colorKey: string;
  colorLabelKey: string;
  colorTestId: string;
}> = [
  {
    task: "continue",
    labelKey: "statusbar.ai.bubbleContinue",
    colorKey: "aiAssistBubbleColorContinue",
    colorLabelKey: "statusbar.ai.colorCont",
    colorTestId: "ai-settings-color-continue",
  },
  {
    task: "polish",
    labelKey: "statusbar.ai.bubblePolish",
    colorKey: "aiAssistBubbleColorPolish",
    colorLabelKey: "statusbar.ai.colorPolish",
    colorTestId: "ai-settings-color-polish",
  },
  {
    task: "summary",
    labelKey: "statusbar.ai.bubbleSummary",
    colorKey: "aiAssistBubbleColorSummary",
    colorLabelKey: "statusbar.ai.colorSummary",
    colorTestId: "ai-settings-color-summary",
  },
  {
    task: "chat",
    labelKey: "statusbar.ai.bubbleChat",
    colorKey: "aiAssistBubbleColorChat",
    colorLabelKey: "statusbar.ai.colorChat",
    colorTestId: "ai-settings-color-chat",
  },
];

/**
 * v0.7.5 优化2：AI 抽屉按钮的配色变量注入（空值不注入 → CSS 回退主题 accent）。
 *
 * 语义：气泡颜色是"该 AI 功能"的标识色，底部栏同一功能的按钮应与气泡同色；
 * 仅在 hover / :active 时显现，避免常驻变色破坏底部栏的克制视觉。
 */
export function aiEntryColorStyle(color: string | undefined): React.CSSProperties {
  const c = (color ?? "").trim();
  return c ? ({ "--ai-entry-color": c } as React.CSSProperties) : {};
}

/** v0.7.5 优化2：抽屉按钮文案（「问」用短文案，其余复用 AI 任务标题） */
export function aiEntryLabelKey(task: AiAssistBubbleTask): string {
  return task === "chat" ? "statusbar.ai.chat" : `ai.title.${task}`;
}

export function StatusBar() {
  const t = useT();
  const isDirty = useEditorStore((s) => s.isDirty);
  const cursorLine = useEditorStore((s) => s.cursorLine);
  const wordCount = useEditorStore((s) => s.wordCount);
  const filePath = useEditorStore((s) => s.filePath);
  const focusMode = useEditorStore((s) => s.focusMode);
  const toggleFocusMode = useEditorStore((s) => s.toggleFocusMode);
  const typewriterMode = useSettingsStore((s) => s.typewriterMode);
  const toggleTypewriter = useSettingsStore((s) => s.toggleTypewriter);
  // v0.7.0 修复1：全局 AI 总开关（关闭时 AI 入口置灰禁用，抽屉不展开）
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  // v0.7.4 功能8：AI 相关设置（齿轮面板实时读写）
  const aiSettings = useSettingsStore((s) => s.translate);
  const setTranslateConfig = useSettingsStore((s) => s.setTranslateConfig);
  const setShowSearch = useEditorStore((s) => s.setShowSearch);
  // 问题5：底部栏搜索按钮切换开关（已开启则关闭）
  const showSearch = useEditorStore((s) => s.showSearch);
  const toggleSearch = useEditorStore((s) => s.toggleSearch);
  // v0.6.1：全文翻译进度状态
  const ftStatus = useFullTranslateStore((s) => s.status);
  const ftDone = useFullTranslateStore((s) => s.doneCount);
  const ftTotal = useFullTranslateStore((s) => s.totalCount);
  const ftErrorCode = useFullTranslateStore((s) => s.errorCode);
  // v0.7.3 U6：当前翻译段（状态栏 tooltip / 行内简示，指示任务在推进）
  const ftSegment = useFullTranslateStore((s) => s.currentSegmentText);
  const ftRequestCancel = useFullTranslateStore((s) => s.requestCancel);
  const ftReset = useFullTranslateStore((s) => s.reset);

  // G11：字数详情面板展开状态
  const [showDetail, setShowDetail] = useState(false);
  const wordWrapRef = useRef<HTMLDivElement>(null);
  // v0.7.0：AI 助手入口抽屉展开状态
  // 修复3：hover 展开；移出后保持展示——点击外部区域或 AI 任务结束后才收回
  const [aiOpen, setAiOpen] = useState(false);
  const aiWrapRef = useRef<HTMLDivElement>(null);
  // v0.7.4 功能8：齿轮设置 popover 展开状态
  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useRef<HTMLDivElement>(null);
  // v0.7.0 修复3：AI 任务活跃（loading/streaming/done 气泡显示中）时抽屉保持展开
  const aiStatus = useAiAssistStore((s) => s.status);
  const aiTaskActive = aiStatus !== "idle";

  // v0.7.4 功能8：固定开关开启时强制保持抽屉展开（即使鼠标移开/任务结束也不收回）
  useEffect(() => {
    if (aiSettings.aiEntryFixed && aiEnabled) setAiOpen(true);
  }, [aiSettings.aiEntryFixed, aiEnabled]);

  // v0.6.4：翻译完成态 2 秒后自动消失（取消/切换文档走 reset，同样离开 done 态）
  useEffect(() => {
    if (ftStatus !== "done") return;
    const timer = setTimeout(() => ftReset(), 2000);
    return () => clearTimeout(timer);
  }, [ftStatus, ftReset]);

  // v0.7.0 修复3a：点击抽屉外部区域收回（AI 任务进行中不收回——见修复3b）
  // v0.7.4 功能8：固定开关（aiEntryFixed）开启时抽屉保持展开，点击外部也不收回
  useEffect(() => {
    if (!aiOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        aiWrapRef.current &&
        !aiWrapRef.current.contains(target) &&
        !aiTaskActive &&
        !aiSettings.aiEntryFixed
      ) {
        setAiOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [aiOpen, aiTaskActive, aiSettings.aiEntryFixed]);

  // v0.7.0 修复3b：点击功能按钮后保持展开，AI 任务结束（取消/关闭气泡/失败回 idle）才收回；
  // 总开关关闭时同样收回（入口已禁用）
  // v0.7.4 功能8：固定开关开启时不自动收回
  useEffect(() => {
    if ((!aiTaskActive || !aiEnabled) && !aiSettings.aiEntryFixed) setAiOpen(false);
  }, [aiTaskActive, aiEnabled, aiSettings.aiEntryFixed]);

  const fileName = filePath
    ? filePath.replace(/\\/g, "/").split("/").pop() || t("statusbar.untitled")
    : t("statusbar.untitled");

  // 点击外部关闭详情面板（监听 mousedown，与下拉菜单关闭逻辑一致）
  useEffect(() => {
    if (!showDetail) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (wordWrapRef.current && !wordWrapRef.current.contains(target)) {
        setShowDetail(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showDetail]);

  // v0.7.4 功能8：点击齿轮 popover 外部关闭
  useEffect(() => {
    if (!gearOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (gearRef.current && !gearRef.current.contains(target)) {
        setGearOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [gearOpen]);

  return (
    <div className="statusbar">
      <span className="statusbar-item">
        {fileName}
        {isDirty && <span className="statusbar-dirty"> ●</span>}
      </span>
      <span className="statusbar-item statusbar-center">
        {/* v0.6.1：全文翻译进度；v0.6.4：完成态显示"翻译完成 ✓"2 秒自动消失，
            段级失败不在底部栏显示（编辑器内气泡逐段提示），仅系统性错误保留提示 */}
        {ftStatus === "running" && (
          <span
            className="statusbar-ft-progress"
            // v0.7.3 U6：tooltip 显示当前段，指示任务在推进（而非卡死）
            title={ftSegment ? t("translate.full.currentSegment", { text: ftSegment }) : undefined}
          >
            <span className="statusbar-ft-spinner" aria-hidden="true" />
            {t("translate.full.progress", { done: ftDone, total: ftTotal })}
            {ftSegment && (
              <span className="statusbar-ft-segment" data-testid="statusbar-ft-segment">
                {ftSegment.length > 20 ? `${ftSegment.slice(0, 20)}…` : ftSegment}
              </span>
            )}
            <button
              type="button"
              className="statusbar-ft-cancel"
              title={t("translate.full.cancel")}
              onClick={() => {
                ftRequestCancel();
                translateService.cancel().catch(() => undefined);
              }}
            >
              ✕
            </button>
          </span>
        )}
        {ftStatus === "done" && (
          <span className="statusbar-ft-progress statusbar-ft-done" data-testid="statusbar-ft-done">
            {t("translate.full.done")}
            <span className="statusbar-ft-check" aria-hidden="true">✓</span>
          </span>
        )}
        {ftStatus === "error" && ftErrorCode && (
          <span className="statusbar-ft-progress statusbar-ft-error">
            {t(translateErrorKey(ftErrorCode))}
            <button
              type="button"
              className="statusbar-ft-cancel"
              title={t("translate.full.dismiss")}
              onClick={ftReset}
            >
              ✕
            </button>
          </span>
        )}
        {/* 搜索入口：放大镜图标 + "搜索"文字，点击切换开关 */}
        <button
          className={`statusbar-toggle ${showSearch ? "active" : ""}`}
          title={t("search.placeholder")}
          onClick={toggleSearch}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" stroke-linecap="round" />
          </svg>
          {t("search.placeholder")}
        </button>
        {/* 专注模式：靶心图标 + "专注模式（F8）"文字 */}
        <button
          className={`statusbar-toggle ${focusMode ? "active" : ""}`}
          title={t("statusbar.focusModeTitle")}
          onClick={toggleFocusMode}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            {/* 靶心：同心圆 */}
            <circle cx="8" cy="8" r="6" />
            <circle cx="8" cy="8" r="4" />
            <circle cx="8" cy="8" r="2" />
            {/* 中心命中点 */}
            <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
          </svg>
          {t("statusbar.focusMode")}
        </button>
        {/* 打字机模式（问题4：文字改为"打字机（F9）"） */}
        <button
          className={`statusbar-toggle ${typewriterMode ? "active" : ""}`}
          title={t("statusbar.typewriterTitle")}
          onClick={toggleTypewriter}
        >
          {t("statusbar.typewriter")}
        </button>
        {/* v0.7.0：AI 助手入口（斜体 AI 图标；hover 从左往右抽屉展开 续写/润色/摘要）
            v0.7.0 修复1：总开关关闭时置灰禁用、抽屉不展开；修复6：抽屉绝对定位不挤压左侧按钮
            v0.7.0 修复3：移出不再收回——点击外部区域（非任务中）或 AI 任务结束才收回 */}
        <div
          className={`ai-entry${aiOpen ? " open" : ""}${aiEnabled ? "" : " disabled"}`}
          ref={aiWrapRef}
          onMouseEnter={() => aiEnabled && setAiOpen(true)}
          data-testid="ai-entry"
        >
          <button
            type="button"
            className="ai-entry-icon"
            title={t("statusbar.ai")}
            aria-label={t("statusbar.ai")}
            disabled={!aiEnabled}
          >
            <span className="ai-entry-logo" aria-hidden="true">AI</span>
          </button>
          <div className="ai-entry-drawer">
            {/* v0.7.5 优化2：四个 AI 入口按钮按任务注入 --ai-entry-color（取自各气泡颜色），
                hover / 按下时以该色高亮，与选区气泡保持同一套配色。
                顺序由 AI_BUBBLE_TOGGLES 单源决定：续 / 润 / 摘 / 对话（对话在摘要右侧、齿轮左侧） */}
            {AI_BUBBLE_TOGGLES.map(({ task, colorKey }) => (
              <button
                key={task}
                type="button"
                className="ai-entry-item"
                data-task={task}
                data-testid={`ai-entry-${task}`}
                style={aiEntryColorStyle(aiSettings[colorKey as keyof typeof aiSettings] as string)}
                onClick={() => dispatchAiCommand(task)}
              >
                {t(aiEntryLabelKey(task))}
              </button>
            ))}
            {/* v0.7.4 功能8：齿轮设置按钮（摘要右侧）→ AI 功能设置 popover */}
            <div className="ai-entry-gear" ref={gearRef}>
              <button
                type="button"
                className={`ai-entry-gear-btn${gearOpen ? " active" : ""}`}
                data-testid="ai-entry-gear"
                title={t("statusbar.ai.settings")}
                aria-label={t("statusbar.ai.settings")}
                onClick={(e) => {
                  e.stopPropagation();
                  setGearOpen((v) => !v);
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <circle cx="8" cy="8" r="2.2" />
                  <path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M12.6 3.4L11 5M5 11l-1.6 1.6" strokeLinecap="round" />
                </svg>
              </button>
              {gearOpen && (
                <div className="ai-settings-popover" role="dialog" data-testid="ai-settings-popover">
                  {/* 固定：开启后 AI 入口/抽屉保持展开 */}
                  <label className="ai-settings-row">
                    <input
                      type="checkbox"
                      checked={aiSettings.aiEntryFixed}
                      onChange={(e) =>
                        setTranslateConfig({ aiEntryFixed: e.target.checked })
                      }
                    />
                    <span>{t("statusbar.ai.fixed")}</span>
                  </label>
                  {/* 选中文本 AI 气泡总开关：开启后出现 [续][润][摘][问]。
                      v0.7.4 修复1：勾选态需反映"总开关开启"且"没有被隐藏的气泡"。
                      v0.7.5 功能2：隐藏已改为按任务独立（hiddenTasks），
                      故总勾选 = 总开关开启 且 hiddenTasks 为空；勾选时一键恢复全部。 */}
                  <label className="ai-settings-row">
                    <input
                      type="checkbox"
                      checked={
                        aiSettings.aiAssistBubbleEnable &&
                        aiSettings.aiAssistBubbleHiddenTasks.length === 0
                      }
                      onChange={(e) =>
                        setTranslateConfig(
                          e.target.checked
                            ? { aiAssistBubbleEnable: true, aiAssistBubbleHiddenTasks: [] }
                            : { aiAssistBubbleEnable: false }
                        )
                      }
                      data-testid="ai-settings-bubble-master"
                    />
                    <span>{t("statusbar.ai.bubble")}</span>
                  </label>
                  {/* v0.7.5 功能2：按任务独立勾选（取消勾选 = 加入 hiddenTasks，
                      与该气泡右键「隐藏『X』气泡」等价；仅总开关开启时显示） */}
                  {aiSettings.aiAssistBubbleEnable && (
                    <div className="ai-settings-subtasks" data-testid="ai-settings-subtasks">
                      {AI_BUBBLE_TOGGLES.map(({ task, labelKey }) => {
                        const visible = !aiSettings.aiAssistBubbleHiddenTasks.includes(task);
                        return (
                          <label className="ai-settings-row ai-settings-subrow" key={task}>
                            <input
                              type="checkbox"
                              checked={visible}
                              data-testid={`ai-settings-bubble-${task}`}
                              onChange={(e) => {
                                const cur = aiSettings.aiAssistBubbleHiddenTasks;
                                setTranslateConfig({
                                  aiAssistBubbleHiddenTasks: e.target.checked
                                    ? cur.filter((x) => x !== task)
                                    : cur.includes(task)
                                      ? cur
                                      : [...cur, task],
                                });
                              }}
                            />
                            <span>{t(labelKey)}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {/* 气泡延迟：仅气泡实际可见（开启且未隐藏）时可设置 */}
                  {aiSettings.aiAssistBubbleEnable && (
                    <div className="ai-settings-row ai-settings-delay">
                      <span>{t("statusbar.ai.bubbleDelay")}</span>
                      <input
                        type="range"
                        min={0}
                        max={2000}
                        step={100}
                        value={aiSettings.aiAssistBubbleDelayMs}
                        onChange={(e) =>
                          setTranslateConfig({ aiAssistBubbleDelayMs: Number(e.target.value) })
                        }
                        style={{ flex: 1, minWidth: 60 }}
                        data-testid="ai-settings-delay"
                      />
                      <span className="ai-settings-value">{aiSettings.aiAssistBubbleDelayMs}ms</span>
                    </div>
                  )}
                  {/* 气泡颜色：续/润/摘/问 分别设置（空串 = 主题默认色）。
                      v0.7.5 功能2：新增「问」色 */}
                  {AI_BUBBLE_TOGGLES.map(({ task, colorKey, colorLabelKey, colorTestId }) => {
                    const value = aiSettings[colorKey as keyof typeof aiSettings] as string;
                    return (
                      <div className="ai-settings-colorrow" key={task}>
                        <span className="ai-settings-colorbrand">
                          <i style={{ background: value || undefined }} />
                          {t(colorLabelKey)}
                        </span>
                        <input
                          type="color"
                          value={value || "#4a9eff"}
                          data-testid={colorTestId}
                          onChange={(e) => setTranslateConfig({ [colorKey]: e.target.value })}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </span>
      <span className="statusbar-item">
        {wordCount.words > 0 && (
          <div className="statusbar-word-wrap" ref={wordWrapRef}>
            <span
              className="statusbar-word-trigger"
              title={t("statusbar.words")}
              onClick={() => setShowDetail((v) => !v)}
            >
              {wordCount.words} {t("statusbar.words")}
            </span>
            {/* G11：字数详情面板（向上弹出） */}
            {showDetail && (
              <div className="statusbar-detail-popover" role="dialog">
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.words")}</span>
                  <span className="statusbar-detail-value">{wordCount.words}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.chars")}</span>
                  <span className="statusbar-detail-value">{wordCount.chars}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.charsNoSpaces")}</span>
                  <span className="statusbar-detail-value">{wordCount.charsNoSpaces}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.lines")}</span>
                  <span className="statusbar-detail-value">{wordCount.lines}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.paragraphs")}</span>
                  <span className="statusbar-detail-value">{wordCount.paragraphs}</span>
                </div>
                <div className="statusbar-detail-row">
                  <span className="statusbar-detail-label">{t("statusbar.readingTime")}</span>
                  <span className="statusbar-detail-value">{wordCount.readingTimeMin} {t("statusbar.minutes")}</span>
                </div>
              </div>
            )}
          </div>
        )}
        {cursorLine > 0 && <span>{t("statusbar.line", { line: cursorLine })}</span>}
      </span>
    </div>
  );
}
