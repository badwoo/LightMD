/**
 * v0.16.0 Agent B5 —— 一致性校验（D12 / D13 / D14）
 *
 * 覆盖：
 * 1. D12：CSS 的 tab 宽度单源化 —— `code-theme.css` 与 `editor.css` 三处
 *    `tab-size` 全部引用 `var(--lm-tab-size`，且**再无硬编码 `tab-size: 4`**；
 * 2. D14：i18n 中英字典各含缩进单位 5 条 + 列表首项提示 1 条（共 6 个 key）；
 * 3. D13：`USER_GUIDE.md` 新增「Tab 与缩进行为」小节；
 *    `README.md` 不再包含「经确认是用户期望的行为」；
 * 4. D14：`SettingsDialog.tsx` 挂载了 `data-testid="settings-indent-unit"`。
 *
 * 说明：本文件全部为**静态源码 / 字典断言**，不需要 jsdom 渲染，
 * 与既有 `v0.8.x` / `v0.12.x` 同类一致性用例的写法保持一致。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";

const here = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(here, rel), "utf-8");
/** 项目根（--logmd/src => project root） */
const rootRead = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf-8");

// ─── D12：tab-size 单源化 ───────────────────────────────────────────────
describe("D12：tab-size 单源化为 CSS 变量 --lm-tab-size", () => {
  const codeThemeCss = read("styles/code-theme.css");
  const editorCss = read("styles/editor.css");

  it("code-theme.css（Prism 高亮层 code[class*=language-]）引用 var(--lm-tab-size", () => {
    expect(codeThemeCss).toMatch(/tab-size:\s*var\(--lm-tab-size/);
  });

  it("editor.css 至少两处（.code-block-wrapper code 与 .source-editor）引用 var(--lm-tab-size", () => {
    const matches = editorCss.match(/tab-size:\s*var\(--lm-tab-size/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("editor.css 的 .code-block-wrapper code 规则内使用变量而非硬编码 4", () => {
    const rule = /\.code-block-wrapper\s+code\s*\{([^}]*)\}/.exec(editorCss);
    expect(rule, ".code-block-wrapper code 规则应存在").toBeTruthy();
    expect(rule![1]).toMatch(/tab-size:\s*var\(--lm-tab-size/);
  });

  it("editor.css 的 .source-editor 规则内使用变量而非硬编码 4", () => {
    // 需行首锚定：另有一条 `body.format-painter-armed .source-editor {` 规则
    const rule = /(?:^|\n)\.source-editor\s*\{([^}]*)\}/.exec(editorCss);
    expect(rule, ".source-editor 规则应存在").toBeTruthy();
    expect(rule![1]).toMatch(/tab-size:\s*var\(--lm-tab-size/);
  });

  it("两个样式文件中不再出现硬编码的 tab-size: 4", () => {
    // 只匹配「tab-size: 4;」这类真实声明，不误伤注释里的数字
    expect(codeThemeCss).not.toMatch(/tab-size:\s*4\s*;/);
    expect(editorCss).not.toMatch(/tab-size:\s*4\s*;/);
  });

  it("兜底值统一为 2（与 indentUnit 默认 \"2\" 自洽）", () => {
    const fallbacks = [
      ...(codeThemeCss.match(/var\(--lm-tab-size,\s*([^)]*)\)/g) ?? []),
      ...(editorCss.match(/var\(--lm-tab-size,\s*([^)]*)\)/g) ?? []),
    ];
    expect(fallbacks.length).toBeGreaterThanOrEqual(3);
    for (const decl of fallbacks) {
      expect(decl).toMatch(/var\(--lm-tab-size,\s*2\s*\)/);
    }
  });

  it("store 侧确实写入 --lm-tab-size（防止 CSS 变量断链）", () => {
    const store = read("stores/useSettingsStore.ts");
    expect(store).toContain('setProperty("--lm-tab-size"');
  });
});

// ─── D14：i18n 键 ─────────────────────────────────────────────────────────
describe("D14：缩进单位 i18n 键（中英各 6 条）", () => {
  const requiredKeys = [
    "settings.indentUnit",
    "settings.indentUnit.tab",
    "settings.indentUnit.two",
    "settings.indentUnit.four",
    "settings.indentUnitHint",
    "indent.cannotNestFirstItem",
  ] as const;

  it("zh-CN 字典包含全部 6 个键且值不为键名本身", () => {
    for (const key of requiredKeys) {
      expect(zhCN[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(zhCN[key], `zh-CN 的 ${key} 不应回退为 key 本身`).not.toBe(key);
    }
  });

  it("en-US 字典包含全部 6 个键且值不为键名本身", () => {
    for (const key of requiredKeys) {
      expect(enUS[key], `en-US 缺 ${key}`).toBeTruthy();
      expect(enUS[key], `en-US 的 ${key} 不应回退为 key 本身`).not.toBe(key);
    }
  });

  it("中英字典键集合对齐（不出现单边缺键）", () => {
    for (const key of requiredKeys) {
      expect(zhCN[key]).toBeDefined();
      expect(enUS[key]).toBeDefined();
    }
  });

  it("三个缩进单位选项的文案互不相同", () => {
    const zhValues = [
      zhCN["settings.indentUnit.tab"],
      zhCN["settings.indentUnit.two"],
      zhCN["settings.indentUnit.four"],
    ];
    expect(new Set(zhValues).size).toBe(3);
    const enValues = [
      enUS["settings.indentUnit.tab"],
      enUS["settings.indentUnit.two"],
      enUS["settings.indentUnit.four"],
    ];
    expect(new Set(enValues).size).toBe(3);
  });
});

// ─── D14：设置项 UI ──────────────────────────────────────────────────────
describe("D14：SettingsDialog 缩进单位下拉", () => {
  const dialog = read("components/dialogs/SettingsDialog.tsx");

  it("挂载 data-testid=settings-indent-unit", () => {
    expect(dialog).toContain('data-testid="settings-indent-unit"');
  });

  it("下拉绑定 settings.indentUnit 与 settings.setIndentUnit", () => {
    expect(dialog).toContain("settings.indentUnit");
    expect(dialog).toContain("settings.setIndentUnit(");
  });

  it("三个 option 的 value 与 store 的 IndentUnit 三态一致", () => {
    expect(dialog).toContain('<option value="tab">');
    expect(dialog).toContain('<option value="2">');
    expect(dialog).toContain('<option value="4">');
  });

  it("使用与既有设置项一致的 settings-field / settings-select / settings-hint 结构", () => {
    const testidIdx = dialog.indexOf('data-testid="settings-indent-unit"');
    expect(testidIdx).toBeGreaterThan(-1);
    // 取该下拉前后各一段窗口（hint 在 select 之后，故后向留足长度）
    const window = dialog.slice(Math.max(0, testidIdx - 700), testidIdx + 1200);
    expect(window).toContain("settings-field");
    expect(window).toContain("settings-select");
    expect(window).toContain("settings-hint");
    expect(window).toContain("settings.indentUnitHint");
  });
});

// ─── D13：文档口径 ───────────────────────────────────────────────────────
describe("D13：文档与实现对齐", () => {
  const userGuide = rootRead("USER_GUIDE.md");
  const readme = rootRead("README.md");

  it("USER_GUIDE.md 含「Tab 与缩进行为」小节", () => {
    expect(userGuide).toContain("Tab 与缩进行为");
  });

  it("USER_GUIDE.md 小节声明 0.16.0 统一口径并覆盖关键场景", () => {
    expect(userGuide).toContain("0.16.0 起统一口径");
    for (const scenario of ["表格单元格", "代码块", "列表 / 任务列表", "引用块", "普通段落"]) {
      expect(userGuide, `USER_GUIDE 缺场景「${scenario}」`).toContain(scenario);
    }
    expect(userGuide).toContain("列表首项无法再缩进");
    expect(userGuide).toContain("三种模式行为一致");
  });

  it("USER_GUIDE.md 的列表快捷键表已加「仅列表项内生效」限定", () => {
    expect(userGuide).toContain("仅列表项内生效");
    expect(userGuide).toContain("列表首项不缩进");
  });

  it("README.md 不再包含「经确认是用户期望的行为」", () => {
    expect(readme).not.toContain("经确认是用户期望的行为");
  });

  it("README.md 将 pairTabOut 抢占表格 Tab 记为已确认缺陷", () => {
    expect(readme).toContain("pairTabOut");
    expect(readme).toContain("已确认为缺陷，v0.16.0 修复");
  });

  it("README.md 快捷键表已加「首项不缩进」限定", () => {
    expect(readme).toContain("首项不缩进");
  });

  it("README.md 更新历史含 v0.16.0 记录", () => {
    expect(readme).toContain("### v0.16.0");
    expect(readme).toContain("--lm-tab-size");
  });
});
