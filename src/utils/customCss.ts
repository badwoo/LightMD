/**
 * v0.11.0 B6-2：让 `customCss` 设置真正生效。
 *
 * 缺陷背景（P0 · 欺骗性 UI）：
 *   设置面板有「自定义 CSS」输入框（`SettingsDialog.tsx`），store 有
 *   `customCss` 字段与 `setCustomCss`（`useSettingsStore.ts`），Rust 侧也有
 *   字段（`configService.ts`）—— 但**全仓无任何样式注入点**
 *   （grep `createElement("style")` / `adoptedStyleSheets` / `insertRule` 零命中）
 *   → 用户写完 CSS、点「保存设置」、毫无反应。这是最典型的欺骗性 UI。
 *
 * 本模块负责注入，单源且幂等：
 * - 同一份 CSS 重复注入不叠加（按内容比对）；
 * - 非法 CSS 不抛错（用 CSSStyleSheet.replaceSync 的 try/catch 兜底，
 *   部分解析成功时也能生效）；
 * - 跨窗口同步：store 订阅在 persist rehydrate（含 broadcast）时也会触发。
 */

/** 注入容器的 DOM id（幂等锚点） */
export const STYLE_EL_ID = "lightmd-custom-css";

/** 缓存上次写入的内容，避免重复 DOM 操作 */
let lastApplied = "";

/**
 * 把 CSS 文本注入到文档。
 *
 * @param css CSS 文本；空串表示清除（移除容器）
 * @returns 是否发生了实际变更
 */
export function applyCustomCss(css: string): boolean {
  // 空串 → 清除
  if (!css || !css.trim()) {
    const existing = document.getElementById(STYLE_EL_ID);
    if (existing) {
      existing.remove();
      lastApplied = "";
      return true;
    }
    return false;
  }

  // 内容未变 → 跳过（避免无谓 DOM 操作与 rehydrate 抖动）
  if (css === lastApplied && document.getElementById(STYLE_EL_ID)) {
    return false;
  }

  let el = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_EL_ID;
    // 放在 head 末尾 → 优先级高于应用内样式，允许用户覆盖主题
    document.head.appendChild(el);
  }

  // 优先用 CSSOM API：非法 CSS 会被忽略而非让整个 style 元素失效
  const sheet = el.sheet;
  if (sheet) {
    try {
      // replaceSync 接受任意文本，非法规则被静默丢弃
      (sheet as CSSStyleSheet).replaceSync(css);
      lastApplied = css;
      return true;
    } catch {
      // 极老环境无 replaceSync → 回退 textContent
    }
  }
  el.textContent = css;
  lastApplied = css;
  return true;
}

/**
 * 订阅 store 的 customCss 变化并注入。
 * 在应用启动时调用一次（main.tsx 或 App 挂载后）。
 *
 * @returns 取消订阅函数
 */
export function initCustomCssInjection(): () => void {
  // 立即应用一次（覆盖 persist rehydrate 早于本订阅的场景）
  try {
    // 动态 import 避免 store 与本模块的静态循环依赖
    void (async () => {
      const { useSettingsStore } = await import("../stores/useSettingsStore");
      applyCustomCss(useSettingsStore.getState().customCss || "");
    })();
  } catch {
    /* 忽略 */
  }

  // 订阅后续变化
  let unbind: (() => void) | null = null;
  void (async () => {
    const { useSettingsStore } = await import("../stores/useSettingsStore");
    unbind = useSettingsStore.subscribe((state, prev) => {
      if (state.customCss !== prev.customCss) {
        applyCustomCss(state.customCss || "");
      }
    });
  })();

  return () => {
    if (unbind) unbind();
  };
}

/** 仅供测试：重置内部缓存 */
export function resetCustomCssCache(): void {
  lastApplied = "";
}
