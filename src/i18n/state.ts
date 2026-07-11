/**
 * i18n 状态与翻译函数（无 store 依赖）
 *
 * 从 i18n/index.ts 分离出来，避免与 useSettingsStore 形成循环依赖
 * useSettingsStore 只依赖此模块的 _setCurrentLanguage
 */
import type { Language } from "./types";
import { zhCN } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";

/** 字典映射表：语言 → 字典 */
const dictionaries: Record<Language, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** 模块级当前语言缓存（默认中文） */
let currentLang: Language = "zh-CN";

/**
 * 同步翻译函数
 * @param key 字典 key（如 'settings.title'）
 * @param params 可选的 {name} 参数替换
 * @returns 翻译文本；缺失 key 时返回 key 本身并 console.warn
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[currentLang] || dictionaries["zh-CN"];
  let value = dict[key];
  if (value === undefined) {
    // 缺失 key：回退到 key 本身并警告
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[i18n] missing key: ${key}`);
    }
    value = key;
  }
  // 参数替换：将 {name} 占位符替换为 params.name
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}

/** 获取当前语言 */
export function getCurrentLanguage(): Language {
  return currentLang;
}

/**
 * 内部函数：设置当前语言
 * 由 useSettingsStore 在 setLanguage / onRehydrateStorage 中调用
 */
export function _setCurrentLanguage(lang: Language): void {
  currentLang = lang;
}
