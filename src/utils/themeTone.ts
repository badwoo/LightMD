/**
 * v0.11.0 B4-3：主题明暗判定（单源）。
 *
 * 缺陷背景（P1）：全项目判断主题深浅一律用 `theme === "dark"` 二分
 * （EditorContainer.tsx 的 mermaid/KaTeX、ExportDialog.tsx 的 Prism CSS 等
 * 共 8 处），而 6 套主题中 **night 也是暗色**（--bg-primary: #0f1b2d）→
 * night 主题下 mermaid 用浅色 default、Prism 用亮色 token，与深色背景冲突。
 *
 * 各主题实测底色（src/styles/themes/*.css 的 --bg-primary）：
 *   light    #ffffff   亮
 *   github   #ffffff   亮
 *   newsprint #f8f5ef  亮
 *   solarized #fdf6e3  亮
 *   dark     #1e2028   暗
 *   night    #0f1b2d   暗  ← 此前被漏判
 */
import type { Theme } from "../stores/useSettingsStore";

/** 暗色主题集合（唯一事实来源） */
const DARK_THEMES: ReadonlySet<Theme> = new Set<Theme>(["dark", "night"]);

/** 该主题是否为暗色底 */
export function isDarkTheme(theme: Theme | string): boolean {
  return DARK_THEMES.has(theme as Theme);
}

/** Prism 高亮主题名 */
export function prismThemeName(theme: Theme | string): "dark" | "light" {
  return isDarkTheme(theme) ? "dark" : "light";
}

/** mermaid 主题名 */
export function mermaidThemeName(theme: Theme | string): "dark" | "default" {
  return isDarkTheme(theme) ? "dark" : "default";
}
