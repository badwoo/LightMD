import { create } from "zustand";
import { persist } from "zustand/middleware";
// 从 i18n/state 而非 i18n/index 导入，避免循环依赖（i18n/index 反向依赖本 store）
import { _setCurrentLanguage } from "../i18n/state";
import type { Language } from "../i18n/types";

/**
 * 主题类型（G6：从 2 主题扩展到 6 主题）
 * - light: 亮色（默认）
 * - dark: 暗色
 * - github: GitHub 风格
 * - newsprint: 报纸风
 * - night: 深蓝夜空
 * - solarized: Solarized 配色
 */
export type Theme = "light" | "dark" | "github" | "newsprint" | "night" | "solarized";

/** 所有可用主题枚举值（供测试与 UI 遍历使用，已冻结以防止运行期被修改） */
export const THEMES: readonly Theme[] = Object.freeze([
  "light",
  "dark",
  "github",
  "newsprint",
  "night",
  "solarized",
]);

/** v0.6.0：AI 翻译结果模式 */
export type TranslateResultMode = "bubble" | "replace" | "bilingual" | "clipboard";

/**
 * v0.7.5：选区浮动 AI 气泡任务标识（与 core/plugins/translateTooltip.AiAssistTask 一致）
 *
 * 赋值给 hiddenTasks 数组，用于「按任务独立隐藏气泡」。
 * "chat" 为 v0.7.5 新增的「问」气泡（打开 AI 对话窗）。
 */
export type AiAssistBubbleTask = "continue" | "polish" | "summary" | "chat";

/** v0.7.5：AI 对话窗口的位置与尺寸（F6 记忆；null = 使用默认居中布局） */
export interface AiChatWindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** v0.7.5：对话框窗口默认尺寸（宽 560 × 高 480，水平居中、垂直 12% 处） */
export const DEFAULT_AI_CHAT_SIZE = { w: 560, h: 480 } as const;

/** v0.7.5：AI 对话窗口尺寸下限/上限（下限与 CSS min-width/height 对齐） */
export const AI_CHAT_MIN_SIZE = { w: 360, h: 280 } as const;

/**
 * v0.7.5：窗口矩形是否仍落在当前视口内（显示器变更/分辨率缩小后回落默认居中）
 *
 * 判定标准：窗口四边至少有一部分可见，且尺寸不小于最小值。
 * 完全越界（负坐标远离视口或超出右/下边界）视为失效。
 */
export function isAiChatRectVisible(
  rect: AiChatWindowRect | null | undefined,
  viewport: { width: number; height: number }
): boolean {
  if (!rect) return false;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  if (!(rect.w >= AI_CHAT_MIN_SIZE.w) || !(rect.h >= AI_CHAT_MIN_SIZE.h)) return false;
  // 允许部分越界，但必须至少留 80px 可见区域在视口内（可抓取拖动）
  const visibleX = Math.min(rect.x + rect.w, viewport.width) - Math.max(rect.x, 0);
  const visibleY = Math.min(rect.y + rect.h, viewport.height) - Math.max(rect.y, 0);
  return visibleX >= 80 && visibleY >= 40;
}

/** v0.6.0：AI 翻译配置（persist；API Key 单独走 keyring，绝不进 localStorage） */
export interface TranslateSettings {
  /** AI 翻译总开关（关闭后所有翻译入口不响应） */
  translateEnabled: boolean;
  /** Provider 预设标识：deepseek | zhipu | minimax | alibaba | kimi | volcengine | doubao | gemini | claude | modelscope | siliconflow | openai | custom */
  translateProviderPreset: string;
  translateBaseUrl: string;
  translateModel: string;
  /** 目标语言：auto（中英互译）| zh-CN | en | ja | ko | ... */
  translateTargetLang: string;
  /** 语体：正式 | 口语 | 技术文档 */
  translateTone: string;
  /** 结果模式：bubble=气泡手动确认（默认）| replace | bilingual | clipboard */
  translateResultMode: TranslateResultMode;
  /** 自定义 Prompt 模板（空串 = 使用内置模板） */
  translateCustomPrompt: string;
  /** v0.7.0：隐藏选中文本的翻译小气泡（隐藏后选区「译」按钮不显示，bubble 模式降级为复制到剪贴板） */
  translateBubbleHidden: boolean;
  /** v0.7.0 修复4：选中文本后「译」浮动按钮延迟出现毫秒数（默认 500ms，0=立即；
   * 仅气泡开关开启时可设置，避免选中即弹的干扰） */
  translateBubbleDelayMs: number;
  /** v0.7.5 功能3：「译」浮动气泡颜色（空串 = 跟随主题默认色，与 AI 气泡色同语义）。
   * 经 CSS 变量 --ai-btn-color 注入驱动边框/背景，测试设置即时生效。 */
  translateBubbleColor: string;
  /** v0.7.3：采样温度（0~2）。默认 0.1（确定性任务）；kimi 部分模型仅允许 1，
   * 切换 kimi 预设时默认置 1。修复 400 invalid temperature。 */
  translateTemperature: number;
  /**
   * v0.7.4 功能7：是否隐藏选中文本的 AI 气泡（默认 false）。
   *
   * v0.7.5 起**降级为遗留字段**：原语义为「右键一次隐藏全部 AI 气泡」，
   * 现由 aiAssistBubbleHiddenTasks 按任务独立隐藏。本字段仅保留作迁移输入与
   * 回滚兼容（不再被 UI/插件读取），迁移见 persist merge。
   */
  aiAssistBubbleHidden: boolean;
  /**
   * v0.7.5 功能2：被独立隐藏的选区 AI 气泡任务列表（默认 []）。
   *
   * 取代 aiAssistBubbleHidden 的「一刀切隐藏」——右键某个气泡只隐藏该个，
   * 状态栏 AI 齿轮面板可按任务逐一勾选恢复。
   */
  aiAssistBubbleHiddenTasks: AiAssistBubbleTask[];
  /** v0.7.4 功能8：选中文本 AI 气泡总开关（默认 true）。
   * 开启后选中文本会出现 [续][润][摘][问] 四个小气泡。 */
  aiAssistBubbleEnable: boolean;
  /** v0.7.4 功能8：选中文本 AI 气泡出现延迟毫秒数（默认 500，与 translateBubbleDelayMs 一致）。 */
  aiAssistBubbleDelayMs: number;
  /** v0.7.4 功能8：「AI 续写」气泡颜色（空串 = 用主题 accent 默认色） */
  aiAssistBubbleColorContinue: string;
  /** v0.7.4 功能8：「AI 润色」气泡颜色（空串 = 用主题 accent 默认色） */
  aiAssistBubbleColorPolish: string;
  /** v0.7.4 功能8：「AI 摘要」气泡颜色（空串 = 用主题 accent 默认色） */
  aiAssistBubbleColorSummary: string;
  /** v0.7.5 功能2：「问」AI 对话气泡颜色（空串 = 用主题 accent 默认色） */
  aiAssistBubbleColorChat: string;
  /** v0.7.4 功能8：底部栏 AI 入口固定（默认 false）。
   * 开启后 AI 入口/抽屉保持展开，不随鼠标移开收回。 */
  aiEntryFixed: boolean;
}

/** v0.6.0：AI 翻译默认配置（默认 DeepSeek，模型角色 deepseek-v4-flash）
 * v0.6.2 问题1：translateEnabled 默认关闭（新装用户不自动开启，需在设置中手动开启） */
export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  translateEnabled: false,
  translateProviderPreset: "deepseek",
  translateBaseUrl: "https://api.deepseek.com/v1",
  translateModel: "deepseek-v4-flash",
  translateTargetLang: "auto",
  translateTone: "正式",
  translateResultMode: "bubble",
  translateCustomPrompt: "",
  translateBubbleHidden: false,
  translateBubbleDelayMs: 500,
  // v0.7.5 功能3：「译」气泡颜色默认跟随主题
  translateBubbleColor: "",
  translateTemperature: 0.1,
  // v0.7.4 功能7/8：AI 气泡默认显示、延迟 500、颜色用主题默认色（空串）、底部栏入口不固定
  aiAssistBubbleHidden: false,
  // v0.7.5 功能2：默认无独立隐藏项（四个气泡全部显示）
  aiAssistBubbleHiddenTasks: [],
  aiAssistBubbleEnable: true,
  aiAssistBubbleDelayMs: 500,
  aiAssistBubbleColorContinue: "",
  aiAssistBubbleColorPolish: "",
  aiAssistBubbleColorSummary: "",
  // v0.7.5 功能2：「问」气泡颜色默认跟随主题
  aiAssistBubbleColorChat: "",
  aiEntryFixed: false,
};

/** v0.7.5 功能2：全部可独立隐藏的 AI 气泡任务（迁移「一刀切隐藏」时的全量集合） */
export const ALL_AI_BUBBLE_TASKS: readonly AiAssistBubbleTask[] = Object.freeze([
  "continue",
  "polish",
  "summary",
  "chat",
]);

interface SettingsState {
  theme: Theme;
  fontSize: number;
  fontFamily: string;
  autoSaveIntervalMs: number;
  defaultExportFormat: "html" | "pdf";
  customCss: string;
  typewriterMode: boolean;
  /** 启动时是否载入上次打开的文件 */
  loadLastFileOnStartup: boolean;
  /** F2: 启动载入文件数量（1-50） */
  loadLastFileCount: number;
  /** F3: 启动时是否载入上次打开的文件夹 */
  loadLastFolderOnStartup: boolean;
  /** F3: 启动载入文件夹数量（1-5） */
  loadLastFolderCount: number;
  /** F1: 界面语言 */
  language: Language;
  /** G9: 显示代码行号（默认 true） */
  showCodeLineNumbers: boolean;
  /** G10: 拼写检查开关（默认 false，使用浏览器原生 spellcheck） */
  spellcheckEnabled: boolean;
  /** N1: 自动配对补全开关（默认 true，输入括号/引号自动补全配对） */
  autoPairEnabled: boolean;
  /** v0.4.0: 侧边栏宽度（默认 260，范围 180~480） */
  sidebarWidth: number;
  /** v0.4.0: 大纲栏宽度（默认 240，范围 180~480） */
  outlineWidth: number;
  /** v0.4.0: 分屏左右比例（默认 0.5，范围 0.3~0.7） */
  splitRatio: number;
  /** v0.6.0: AI 翻译配置（API Key 走 keyring，不在此处） */
  translate: TranslateSettings;
  /** v0.7.0 修复1/2：全局 AI 总开关（翻译/续写/润色/摘要共用；关闭后所有 AI 入口静默）
   * 老数据迁移：v0.7.0 之前无此字段，translateEnabled=true 的老用户自动继承为 true */
  aiEnabled: boolean;
  /**
   * v0.7.5 功能6：AI 对话窗位置/尺寸记忆（null = 首次使用，走默认居中布局）。
   * 仅在拖拽/缩放**结束时**写入（非每帧），避免高频 persist 写 localStorage。
   */
  aiChatWindow: AiChatWindowRect | null;

  /** v0.7.0：设置全局 AI 总开关（关闭时联动关闭翻译子开关） */
  setAiEnabled: (v: boolean) => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setAutoSaveInterval: (ms: number) => void;
  setDefaultExportFormat: (format: "html" | "pdf") => void;
  setCustomCss: (css: string) => void;
  toggleTypewriter: () => void;
  setLoadLastFileOnStartup: (v: boolean) => void;
  setLoadLastFileCount: (n: number) => void;
  setLoadLastFolderOnStartup: (v: boolean) => void;
  setLoadLastFolderCount: (n: number) => void;
  setLanguage: (lang: Language) => void;
  /** G9：设置是否显示代码行号 */
  setShowCodeLineNumbers: (v: boolean) => void;
  /** G10: 设置是否启用拼写检查 */
  setSpellcheckEnabled: (v: boolean) => void;
  /** N1: 设置是否启用自动配对补全 */
  setAutoPairEnabled: (v: boolean) => void;
  /** v0.4.0：设置侧边栏宽度（钳制 180~480） */
  setSidebarWidth: (w: number) => void;
  /** v0.4.0：设置大纲栏宽度（钳制 180~480） */
  setOutlineWidth: (w: number) => void;
  /** v0.4.0：设置分屏比例（钳制 0.3~0.7） */
  setSplitRatio: (r: number) => void;
  /** v0.6.0：合并更新 AI 翻译配置 */
  setTranslateConfig: (cfg: Partial<TranslateSettings>) => void;
  /**
   * v0.7.5 功能6：记录 AI 对话窗位置/尺寸（拖拽/缩放结束时调用）。
   * 传入 null 清除记忆（回落默认居中）。
   */
  setAiChatWindow: (rect: AiChatWindowRect | null) => void;
}

/** 钳制到 [min, max] 范围内 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * v0.7.5：规范化窗口矩形（非法/过小 → null，回落默认居中布局）
 * 供 persist merge（旧数据防御）与 setAiChatWindow（写入防御）共用，保持单源。
 */
export function normalizeAiChatRect(
  rect: AiChatWindowRect | null | undefined
): AiChatWindowRect | null {
  if (!rect) return null;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  if (!Number.isFinite(rect.w) || !Number.isFinite(rect.h)) return null;
  if (rect.w < AI_CHAT_MIN_SIZE.w || rect.h < AI_CHAT_MIN_SIZE.h) return null;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "light",
      fontSize: 16,
      fontFamily: "var(--font-sans)",
      // 自动保存默认间隔 30 秒（30000ms）
      autoSaveIntervalMs: 30000,
      defaultExportFormat: "html",
      customCss: "",
      typewriterMode: false,
      // 默认开启：启动时载入上次打开的文件
      loadLastFileOnStartup: true,
      // F2：默认恢复 1 个文件（与 0.2.0 行为一致，向后兼容）
      loadLastFileCount: 1,
      // F3：默认关闭文件夹恢复（与文件开关不同，需明确开启）
      loadLastFolderOnStartup: false,
      // F3：默认恢复 1 个文件夹
      loadLastFolderCount: 1,
      // F1：默认中文
      language: "zh-CN",
      // G9：默认显示代码行号
      showCodeLineNumbers: true,
      // G10：默认关闭拼写检查（用户按需开启）
      spellcheckEnabled: false,
      // N1：默认开启自动配对补全
      autoPairEnabled: true,
      // v0.4.0：侧边栏默认宽度 260px
      sidebarWidth: 260,
      // v0.4.0：大纲栏默认宽度 240px
      outlineWidth: 240,
      // v0.4.0：分屏默认比例 0.5（左右各半）
      splitRatio: 0.5,
      // v0.6.0：AI 翻译默认配置（旧 localStorage 缺字段时自动回退默认值）
      translate: { ...DEFAULT_TRANSLATE_SETTINGS },
      // v0.7.0：全局 AI 总开关默认关闭（迁移逻辑见 merge：老用户 translateEnabled=true 继承）
      aiEnabled: false,
      // v0.7.5 功能6：对话窗无位置记忆（首次打开走默认居中）
      aiChatWindow: null,

      // v0.7.0：关闭总开关时联动关闭翻译子开关（所有翻译入口静默）
      setAiEnabled: (v) =>
        set((s) => ({
          aiEnabled: v,
          ...(v ? {} : { translate: { ...s.translate, translateEnabled: false } }),
        })),
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setAutoSaveInterval: (autoSaveIntervalMs) => set({ autoSaveIntervalMs: clamp(autoSaveIntervalMs, 0, 600000) }),
      setDefaultExportFormat: (defaultExportFormat) => set({ defaultExportFormat }),
      setCustomCss: (customCss) => set({ customCss }),
      toggleTypewriter: () => set((s) => ({ typewriterMode: !s.typewriterMode })),
      setLoadLastFileOnStartup: (loadLastFileOnStartup) => set({ loadLastFileOnStartup }),
      // 钳制到 1-50
      setLoadLastFileCount: (n) => set({ loadLastFileCount: clamp(Math.floor(n), 1, 50) }),
      setLoadLastFolderOnStartup: (loadLastFolderOnStartup) => set({ loadLastFolderOnStartup }),
      // 钳制到 1-5
      setLoadLastFolderCount: (n) => set({ loadLastFolderCount: clamp(Math.floor(n), 1, 5) }),
      setLanguage: (language) => {
        // 同步到 i18n 模块缓存，确保非 React 场景下 t() 也能立即响应
        _setCurrentLanguage(language);
        set({ language });
      },
      // G9：设置是否显示代码行号
      setShowCodeLineNumbers: (showCodeLineNumbers) => set({ showCodeLineNumbers }),
      // G10：设置是否启用拼写检查
      setSpellcheckEnabled: (spellcheckEnabled) => set({ spellcheckEnabled }),
      // N1：设置是否启用自动配对补全
      setAutoPairEnabled: (autoPairEnabled) => set({ autoPairEnabled }),
      // v0.4.0：钳制到 180~480
      setSidebarWidth: (w) => set({ sidebarWidth: clamp(Math.round(w), 180, 480) }),
      // v0.4.0：钳制到 180~480
      setOutlineWidth: (w) => set({ outlineWidth: clamp(Math.round(w), 180, 480) }),
      // v0.4.0：钳制到 0.3~0.7
      setSplitRatio: (r) => set({ splitRatio: clamp(r, 0.3, 0.7) }),
      // v0.6.0：合并更新 AI 翻译配置（浅合并，未知字段忽略）
      setTranslateConfig: (cfg) =>
        set((s) => ({ translate: { ...s.translate, ...cfg } })),
      // v0.7.5 功能6：对话窗位置/尺寸记忆（非法/过小值 → null，回落默认居中）
      setAiChatWindow: (rect) => set({ aiChatWindow: normalizeAiChatRect(rect) }),
    }),
    {
      name: "lightmd-settings",
      // v0.6.0：自定义合并——translate 嵌套对象做字段级回退，
      // 旧 localStorage 无 translate 或字段缺失时回退默认值
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<SettingsState>;
        // v0.7.0 迁移：老数据无 aiEnabled 字段时，translateEnabled=true 的老用户继承为 true
        // （旧版本 translateEnabled 即全局 AI 开关，语义升级后总开关须保持用户既有开启状态）
        const legacyAiEnabled = p.aiEnabled === undefined && p.translate?.translateEnabled === true;
        const persistedTranslate = (p.translate || {}) as Partial<TranslateSettings>;
        // v0.7.3 迁移：老用户无 translateTemperature 字段。
        // 已选 kimi 预设的老用户默认温度置 1（kimi 部分模型仅允许 temperature=1，否则 400）；
        // 其他预设默认 0.1。新字段缺失一律落默认值。
        const mergedTranslate = { ...current.translate, ...persistedTranslate };
        if (persistedTranslate.translateTemperature === undefined) {
          mergedTranslate.translateTemperature =
            persistedTranslate.translateProviderPreset === "kimi" ? 1 : 0.1;
        }
        // v0.7.5 功能2 迁移：老数据「右键一刀切隐藏」（aiAssistBubbleHidden=true）
        // → 全量写入 aiAssistBubbleHiddenTasks（用户意图是"隐藏 AI 气泡"，含本次新增
        // 的「问」气泡；可在齿轮面板逐一勾选恢复）。false/undefined → 空数组。
        // 旧字段读取后保留不删除（向前兼容回滚到 v0.7.4）。
        if (persistedTranslate.aiAssistBubbleHiddenTasks === undefined) {
          mergedTranslate.aiAssistBubbleHiddenTasks =
            persistedTranslate.aiAssistBubbleHidden === true
              ? [...ALL_AI_BUBBLE_TASKS]
              : [];
        }
        // 防御：老数据可能存有非法任务名，过滤为白名单内项（去重）
        else if (Array.isArray(mergedTranslate.aiAssistBubbleHiddenTasks)) {
          mergedTranslate.aiAssistBubbleHiddenTasks = [
            ...new Set(
              mergedTranslate.aiAssistBubbleHiddenTasks.filter((t): t is AiAssistBubbleTask =>
                (ALL_AI_BUBBLE_TASKS as readonly string[]).includes(t as string)
              )
            ),
          ];
        } else {
          mergedTranslate.aiAssistBubbleHiddenTasks = [];
        }
        return {
          ...current,
          ...p,
          aiEnabled: legacyAiEnabled ? true : (p.aiEnabled ?? current.aiEnabled),
          translate: mergedTranslate,
          // v0.7.5 功能6：窗口记忆字段缺失/非法时回退 null（回落默认居中）
          aiChatWindow: normalizeAiChatRect(p.aiChatWindow ?? current.aiChatWindow),
        };
      },
      // hydration 完成后同步 i18n 模块缓存
      onRehydrateStorage: () => (state) => {
        if (state && state.language) {
          _setCurrentLanguage(state.language);
        }
      },
    }
  )
);
