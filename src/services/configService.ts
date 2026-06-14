/**
 * 配置服务 —— 封装设置读写
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./fileService";

interface AppConfig {
  theme: "light" | "dark";
  fontSize: number;
  fontFamily: string;
  autoSaveIntervalMs: number;
  defaultExportFormat: "html" | "pdf";
  customCss: string;
}

const defaultConfig: AppConfig = {
  theme: "light",
  fontSize: 16,
  fontFamily: "var(--font-sans)",
  autoSaveIntervalMs: 3000,
  defaultExportFormat: "html",
  customCss: "",
};

export const configService = {
  async getConfig(): Promise<AppConfig> {
    if (!isTauri()) return { ...defaultConfig };
    try {
      return await invoke<AppConfig>("get_config");
    } catch {
      return { ...defaultConfig };
    }
  },

  async setConfig(config: Partial<AppConfig>): Promise<void> {
    if (!isTauri()) {
      // 浏览器模式：存入 localStorage
      const existing = JSON.parse(localStorage.getItem("lightmd-config") || "{}");
      localStorage.setItem("lightmd-config", JSON.stringify({ ...existing, ...config }));
      return;
    }
    try {
      await invoke("set_config", { config });
    } catch {
      console.warn("保存配置失败");
    }
  },
};
