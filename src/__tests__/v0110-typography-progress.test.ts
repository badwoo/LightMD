/**
 * v0.11.0 B4-10：排版三项设置 + 状态栏阅读进度。
 *
 * 缺陷背景：
 * - 排版：设置面板只有「字号 / 字体」两项，**行高与段间距硬编码**在 CSS 里
 *   （`.ProseMirror { line-height: 1.8 }`、段落 `margin: 0.8em`），
 *   内容区宽度固定 860px → 用户无法按阅读习惯调整，长文阅读体验受限；
 * - 进度：长文档阅读时**完全不知道还剩多少**（跨会话位置恢复有，
 *   但那是恢复用的内部状态，不是可见的进度指示）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useEditorStore } from "../stores/useEditorStore";

const editorCss = readFileSync("src/styles/editor.css", "utf-8");
const containerSrc = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");
const settingsSrc = readFileSync("src/components/dialogs/SettingsDialog.tsx", "utf-8");
const statusSrc = readFileSync("src/components/layout/StatusBar.tsx", "utf-8");
const storeSrc = readFileSync("src/stores/useSettingsStore.ts", "utf-8");

describe("v0.11.0 B4-10 排版三项设置", () => {
  it("store 有三项字段且默认 0（0 = 跟随主题默认，不改变既有观感）", () => {
    const s = useSettingsStore.getState();
    expect(s.lineHeight).toBe(0);
    expect(s.paragraphSpacing).toBe(0);
    expect(s.contentMaxWidth).toBe(0);
  });

  it("store 有 setTypography 且为部分更新（未传字段保持原值）", () => {
    const before = useSettingsStore.getState().paragraphSpacing;
    useSettingsStore.getState().setTypography({ lineHeight: 2.0 });
    const after = useSettingsStore.getState();
    expect(after.lineHeight).toBe(2.0);
    expect(after.paragraphSpacing).toBe(before);
    // 复位，避免影响其他用例
    useSettingsStore.getState().setTypography({ lineHeight: 0 });
  });

  it("CSS 通过 var() 接入三项变量（均带兜底值）", () => {
    expect(editorCss).toContain("var(--editor-line-height, 1.8)");
    expect(editorCss).toContain("var(--editor-content-max-width, 860px)");
    expect(editorCss).toContain("var(--editor-paragraph-spacing, 1)");
  });

  it("段间距用 calc 乘算而非硬编码 em", () => {
    expect(editorCss).toMatch(/margin-top: calc\(0\.8em \* var\(--editor-paragraph-spacing, 1\)\)/);
  });

  it("EditorContainer 把三项写到 :root（iframe 预览也能取到，与 B4-1 同机制）", () => {
    expect(containerSrc).toContain('"--editor-line-height"');
    expect(containerSrc).toContain('"--editor-paragraph-spacing"');
    expect(containerSrc).toContain('"--editor-content-max-width"');
  });

  it("值为 0 时移除属性（让 CSS 兜底值生效，而非写入 0）", () => {
    // 写 0 会让 line-height: 0 → 文字重叠，属严重 bug
    expect(containerSrc).toContain("root.style.removeProperty(name)");
    expect(containerSrc).toMatch(/if \(value > 0\) root\.style\.setProperty/);
  });

  it("设置面板有三条滑块（0 = 默认，范围合理）", () => {
    expect(settingsSrc).toContain('data-testid="settings-line-height"');
    expect(settingsSrc).toContain('data-testid="settings-paragraph-spacing"');
    expect(settingsSrc).toContain('data-testid="settings-content-max-width"');
    // 行高 1.4~2.4、段间距 0.6~2.0、内容宽 0~1600
    expect(settingsSrc).toMatch(/min=\{0\}[\s\S]{0,300}?max=\{24\}/);
    expect(settingsSrc).toContain("setLineHeight(Number(e.target.value) / 10)");
    expect(settingsSrc).toMatch(/max=\{1600\}/);
  });

  it("三项按「保存后生效」模式（与字号/字体一致）", () => {
    expect(settingsSrc).toContain("settings.setTypography({ lineHeight, paragraphSpacing, contentMaxWidth })");
    // 用本地 state 而非直接写 store
    expect(settingsSrc).toContain("const [lineHeight, setLineHeight] = useState(settings.lineHeight)");
  });

  it("store 字段声明与实现齐备", () => {
    expect(storeSrc).toContain("lineHeight: number;");
    expect(storeSrc).toContain("paragraphSpacing: number;");
    expect(storeSrc).toContain("contentMaxWidth: number;");
    expect(storeSrc).toContain("setTypography:");
  });
});

describe("v0.11.0 B4-10 状态栏阅读进度", () => {
  it("store 有 scrollProgress 且被钳制到 0~100", () => {
    expect(useEditorStore.getState().scrollProgress).toBe(0);
    const before = useEditorStore.getState().scrollProgress;
    useEditorStore.getState().setScrollProgress(150);
    expect(useEditorStore.getState().scrollProgress).toBe(100);
    useEditorStore.getState().setScrollProgress(-10);
    expect(useEditorStore.getState().scrollProgress).toBe(0);
    useEditorStore.getState().setScrollProgress(before);
  });

  it("状态栏渲染进度百分比（带 testid 与 tooltip）", () => {
    expect(statusSrc).toContain('data-testid="statusbar-progress"');
    expect(statusSrc).toContain("{scrollProgress}%");
    expect(statusSrc).toContain("statusbar.scrollProgress");
  });

  it("滚动监听用 rAF 节流 + 整数变化才 dispatch（避免持续重渲染）", () => {
    expect(containerSrc).toMatch(/requestAnimationFrame\(report\)/);
    expect(containerSrc).toMatch(/rounded !== lastPct/);
    expect(containerSrc).toContain("passive: true");
  });

  it("内容不足一屏时视为 100%（已读完，而非永远 0%）", () => {
    expect(containerSrc).toMatch(/scrollable <= 1 \? 100/);
  });

  it("卸载时清理监听与 rAF（避免内存泄漏）", () => {
    expect(containerSrc).toMatch(/return \(\) => \{[\s\S]{0,200}?removeEventListener\("scroll", onScroll\)[\s\S]{0,120}?cancelAnimationFrame\(raf\)/);
  });

  it("与跨会话位置恢复（fileScrollProgress）职责分离", () => {
    // 两者语义不同：百分比（展示）vs 位置（恢复）
    const scrollSrc = readFileSync("src/services/fileScrollProgress.ts", "utf-8");
    expect(scrollSrc).toContain("SCROLL_PROGRESS_KEY");
    // EditorContainer 的新监听不写 localStorage
    expect(containerSrc).not.toMatch(/scrollProgress[\s\S]{0,40}localStorage/);
  });

  it("样式：等宽数字避免滚动时底栏抖动", () => {
    const css = readFileSync("src/components/layout/StatusBar.css", "utf-8");
    expect(css).toMatch(/\.statusbar-progress \{[\s\S]{0,200}?font-variant-numeric: tabular-nums/);
  });
});
