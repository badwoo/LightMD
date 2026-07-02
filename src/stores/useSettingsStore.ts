import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark";

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

  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setAutoSaveInterval: (ms: number) => void;
  setDefaultExportFormat: (format: "html" | "pdf") => void;
  setCustomCss: (css: string) => void;
  toggleTypewriter: () => void;
  setLoadLastFileOnStartup: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "light",
      fontSize: 16,
      fontFamily: "var(--font-sans)",
      // 自动保存默认间隔 5 秒（5000ms）
      autoSaveIntervalMs: 5000,
      defaultExportFormat: "html",
      customCss: "",
      typewriterMode: false,
      // 默认开启：启动时载入上次打开的文件
      loadLastFileOnStartup: true,

      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setAutoSaveInterval: (autoSaveIntervalMs) => set({ autoSaveIntervalMs }),
      setDefaultExportFormat: (defaultExportFormat) => set({ defaultExportFormat }),
      setCustomCss: (customCss) => set({ customCss }),
      toggleTypewriter: () => set((s) => ({ typewriterMode: !s.typewriterMode })),
      setLoadLastFileOnStartup: (loadLastFileOnStartup) => set({ loadLastFileOnStartup }),
    }),
    {
      name: "lightmd-settings",
    }
  )
);
