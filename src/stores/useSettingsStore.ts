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
  /** G10：设置是否启用拼写检查 */
  setSpellcheckEnabled: (v: boolean) => void;
}

/** 钳制到 [min, max] 范围内 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
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
    }),
    {
      name: "lightmd-settings",
      // hydration 完成后同步 i18n 模块缓存
      onRehydrateStorage: () => (state) => {
        if (state && state.language) {
          _setCurrentLanguage(state.language);
        }
      },
    }
  )
);
