/**
 * i18n 国际化入口模块
 *
 * 导出：
 * - t(key, params?) 同步翻译函数（来自 state.ts）
 * - useT() React Hook（订阅 store 的 language 字段，触发组件重渲染）
 * - getCurrentLanguage() 获取当前语言
 *
 * 实现要点：
 * - 模块加载时初始化订阅 useSettingsStore.language 变化
 * - state.ts 中的 currentLang 由 store 的 setter / onRehydrateStorage 主动同步
 * - 模块级订阅作为兜底，避免遗漏某些路径下的同步
 */
import { useSettingsStore } from "../stores/useSettingsStore";
import { t, getCurrentLanguage } from "./state";

export { t, getCurrentLanguage };
export type { Language } from "./types";

/**
 * React Hook：订阅 store 的 language 字段，语言变化时触发组件重渲染
 * @returns t 函数（已绑定最新语言）
 *
 * 使用方式：
 *   const t = useT();
 *   return <h1>{t('settings.title')}</h1>;
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  // 订阅 language，触发组件重渲染（state.ts 中的 currentLang 由 store setter 同步）
  useSettingsStore((s) => s.language);
  return t;
}

// ─── 模块加载时初始化订阅（兜底机制）──────────────────────
// store 的 setter 已主动同步 currentLang，此处订阅用于覆盖非 setter 路径
// （如其他模块直接 set({ language }) 的场景）
try {
  useSettingsStore.subscribe((state, prevState) => {
    if (state.language !== prevState.language) {
      // 动态导入避免循环依赖
      import("./state").then(({ _setCurrentLanguage }) => {
        _setCurrentLanguage(state.language);
      });
    }
  });
} catch {
  // store 未初始化或非 React 环境忽略
}
