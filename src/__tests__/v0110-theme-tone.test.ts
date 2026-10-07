/**
 * v0.11.0 B4-3 / B4-4：主题明暗判定与分屏图表换色。
 *
 * 缺陷背景（P1）：
 * ① 全项目判断主题深浅一律用 `theme === "dark"` 二分（9 处），而 6 套主题中
 *    **night 也是暗色**（--bg-primary: #0f1b2d）→ night 主题下 mermaid 用浅色
 *    default、Prism 用亮色 token，与深色背景冲突。
 * ② 切主题时分屏图表不换色：iframe 增量更新分支只调 `mermaid.run`，而 mermaid
 *    主题在 `initialize` 时确定 → 图表配色滞后。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isDarkTheme, mermaidThemeName, prismThemeName } from "../utils/themeTone";

describe("v0.11.0 B4-3 主题明暗判定", () => {
  it("night 被正确判定为暗色（此前被二分漏判）", () => {
    expect(isDarkTheme("night")).toBe(true);
    // 对照：night 主题实际底色
    const css = readFileSync("src/styles/themes/night.css", "utf-8");
    expect(css).toContain("--bg-primary: #0f1b2d");
  });

  it("dark 判定为暗色，4 套亮色主题判定为亮色", () => {
    expect(isDarkTheme("dark")).toBe(true);
    for (const t of ["light", "github", "newsprint", "solarized"]) {
      expect(isDarkTheme(t)).toBe(false);
    }
  });

  it("六套主题的 --bg-primary 亮度与判定一致（防止新增主题时漏配）", () => {
    // 直接读主题 CSS 算亮度，与 isDarkTheme 交叉验证
    const themes = ["light", "dark", "github", "newsprint", "night", "solarized"];
    for (const t of themes) {
      const css = readFileSync(`src/styles/themes/${t}.css`, "utf-8");
      const m = /--bg-primary:\s*(#[0-9a-fA-F]{3,6})/.exec(css);
      expect(m, `${t} 应有 --bg-primary`).not.toBeNull();
      const hex = m![1]!;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const luminance = (r * 299 + g * 587 + b * 114) / 1000;
      const actuallyDark = luminance < 128;
      // 判定与实际亮度必须一致（night 是本次修复的关键项）
      expect(isDarkTheme(t), `${t} 亮度 ${luminance.toFixed(0)} 与判定不一致`).toBe(actuallyDark);
    }
  });

  it("mermaid 主题名映射正确", () => {
    expect(mermaidThemeName("dark")).toBe("dark");
    expect(mermaidThemeName("night")).toBe("dark");
    expect(mermaidThemeName("light")).toBe("default");
    expect(mermaidThemeName("github")).toBe("default");
  });

  it("Prism 主题名映射正确", () => {
    expect(prismThemeName("night")).toBe("dark");
    expect(prismThemeName("solarized")).toBe("light");
  });

  it("源码中不再有 theme === \"dark\" 二分（仅注释可出现）", () => {
    for (const p of [
      "src/components/editor/EditorContainer.tsx",
      "src/components/dialogs/ExportDialog.tsx",
    ]) {
      const src = readFileSync(p, "utf-8");
      // 去掉注释后再检查（注释里会提到这个模式作为背景说明）
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
        .join("\n");
      expect(code, `${p} 仍应有 isDarkTheme/mermaidThemeName 判定`).not.toMatch(/theme === "dark"/);
    }
  });
});

describe("v0.11.0 B4-4 分屏图表换色", () => {
  it("增量分支在主题变化时重新 initialize mermaid", () => {
    const src = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");
    // 增量更新分支内须有 initialize 调用（否则切主题图表不换色）
    expect(src).toMatch(/mermaid\.initialize\(\{/);
    expect(src).toContain("init.theme !== mermaidTheme");
  });

  it("needFullRewrite 判据包含主题变化", () => {
    const src = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");
    expect(src).toContain("themeChanged");
    expect(src).toMatch(/needFullRewrite[\s\S]{0,200}themeChanged/);
  });

  it("iframe 初始化状态记录 theme（供下次比对）", () => {
    const src = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");
    expect(src).toMatch(/previewIframeInitRef[\s\S]{0,200}theme/);
    // 写入点也要带 theme
    expect(src).toContain("previewIframeInitRef.current = { mermaid: hasMermaid, math: hasMath, theme }");
  });
});
