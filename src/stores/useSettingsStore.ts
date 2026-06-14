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

  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setAutoSaveInterval: (ms: number) => void;
  setDefaultExportFormat: (format: "html" | "pdf") => void;
  setCustomCss: (css: string) => void;
  toggleTypewriter: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "light",
      fontSize: 16,
      fontFamily: "var(--font-sans)",
      autoSaveIntervalMs: 3000,
      defaultExportFormat: "html",
      customCss: "",
      typewriterMode: false,

      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setAutoSaveInterval: (autoSaveIntervalMs) => set({ autoSaveIntervalMs }),
      setDefaultExportFormat: (defaultExportFormat) => set({ defaultExportFormat }),
      setCustomCss: (customCss) => set({ customCss }),
      toggleTypewriter: () => set((s) => ({ typewriterMode: !s.typewriterMode })),
    }),
    {
      name: "lightmd-settings",
    }
  )
);
