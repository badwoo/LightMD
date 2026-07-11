/**
 * G5 PDF 导出排版增强测试
 *
 * 覆盖 generatePrintCss 及相关纯函数：
 * 1. 默认选项生成正确 CSS
 * 2. 各种纸张大小
 * 3. 各种边距预设
 * 4. 自定义边距（含越界回退）
 * 5. 页码格式（无/底部居中/底部右）
 * 6. 页眉页脚变量替换（{title}/{date}/{page}）
 * 7. 边距数值正确（mm）
 * 8. 完整样式表（@page + body）
 * 9. 空页眉/页脚不生成对应规则
 * 10. 页码 bottom-center 与页脚冲突时的处理
 */
import { describe, it, expect } from "vitest";
import {
  generatePrintCss,
  generateFullPrintStylesheet,
  buildContentExpression,
  resolveMarginMm,
  formatDate,
  DEFAULT_PDF_EXPORT_OPTIONS,
  MARGIN_PRESET_MM,
  PAPER_SIZE_CSS,
  type PdfExportOptions,
} from "../utils/pdfExport";

describe("G5 PDF 导出排版增强", () => {
  // ─── 基础工具函数 ──────────────────────────────────

  describe("formatDate 日期格式化", () => {
    it("格式化为 YYYY-MM-DD", () => {
      const date = new Date(2026, 6, 4); // 2026-07-04（月份从 0 开始）
      expect(formatDate(date)).toBe("2026-07-04");
    });

    it("月份和日期补零", () => {
      const date = new Date(2026, 0, 1); // 2026-01-01
      expect(formatDate(date)).toBe("2026-01-01");
    });

    it("12 月 31 日不补零问题已修复", () => {
      const date = new Date(2026, 11, 31); // 2026-12-31
      expect(formatDate(date)).toBe("2026-12-31");
    });
  });

  describe("MARGIN_PRESET_MM 边距预设值", () => {
    it("窄边距 10mm", () => {
      expect(MARGIN_PRESET_MM.narrow).toBe(10);
    });
    it("正常边距 20mm", () => {
      expect(MARGIN_PRESET_MM.normal).toBe(20);
    });
    it("宽边距 30mm", () => {
      expect(MARGIN_PRESET_MM.wide).toBe(30);
    });
  });

  describe("PAPER_SIZE_CSS 纸张大小映射", () => {
    it("A4 → A4", () => {
      expect(PAPER_SIZE_CSS.A4).toBe("A4");
    });
    it("Letter → Letter", () => {
      expect(PAPER_SIZE_CSS.Letter).toBe("Letter");
    });
    it("Legal → Legal", () => {
      expect(PAPER_SIZE_CSS.Legal).toBe("Legal");
    });
  });

  // ─── resolveMarginMm 边距解析 ──────────────────────

  describe("resolveMarginMm 边距解析", () => {
    it("预设 narrow 返回 10mm", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, margin: "narrow" };
      expect(resolveMarginMm(opts)).toBe(10);
    });

    it("预设 normal 返回 20mm", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, margin: "normal" };
      expect(resolveMarginMm(opts)).toBe(20);
    });

    it("预设 wide 返回 30mm", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, margin: "wide" };
      expect(resolveMarginMm(opts)).toBe(30);
    });

    it("自定义边距 15mm", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: 15,
      };
      expect(resolveMarginMm(opts)).toBe(15);
    });

    it("自定义边距越界（负数）回退到正常值", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: -5,
      };
      expect(resolveMarginMm(opts)).toBe(20);
    });

    it("自定义边距越界（>50）回退到正常值", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: 100,
      };
      expect(resolveMarginMm(opts)).toBe(20);
    });

    it("自定义边距 NaN 回退到正常值", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: NaN,
      };
      expect(resolveMarginMm(opts)).toBe(20);
    });

    it("自定义边距边界值 0mm 允许", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: 0,
      };
      expect(resolveMarginMm(opts)).toBe(0);
    });

    it("自定义边距边界值 50mm 允许", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: 50,
      };
      expect(resolveMarginMm(opts)).toBe(50);
    });
  });

  // ─── buildContentExpression 变量替换 ────────────────

  describe("buildContentExpression 变量替换", () => {
    it("纯文本无变量：直接输出字面量", () => {
      const expr = buildContentExpression("Hello World", "标题", "2026-07-04");
      expect(expr).toBe('"Hello World"');
    });

    it("{title} 变量替换", () => {
      const expr = buildContentExpression("文档：{title}", "我的文档", "2026-07-04");
      expect(expr).toBe('"文档：我的文档"');
    });

    it("{date} 变量替换", () => {
      const expr = buildContentExpression("日期：{date}", "标题", "2026-07-04");
      expect(expr).toBe('"日期：2026-07-04"');
    });

    it("{page} 变量替换为 counter(page)", () => {
      const expr = buildContentExpression("第 {page} 页", "标题", "2026-07-04");
      expect(expr).toBe('"第 " counter(page) " 页"');
    });

    it("多变量混合替换", () => {
      const expr = buildContentExpression("{title} - {date} - 第 {page} 页", "文档", "2026-07-04");
      expect(expr).toBe('"文档 - 2026-07-04 - 第 " counter(page) " 页"');
    });

    it("多个 {page} 变量", () => {
      const expr = buildContentExpression("{page} / {page}", "标题", "2026-07-04");
      expect(expr).toBe('"" counter(page) " / " counter(page) ""');
    });

    it("标题含双引号需转义", () => {
      const expr = buildContentExpression("{title}", '含"引号"的标题', "2026-07-04");
      expect(expr).toBe('"含\\"引号\\"的标题"');
    });

    it("标题含反斜杠需转义", () => {
      const expr = buildContentExpression("{title}", "含\\反斜杠", "2026-07-04");
      expect(expr).toBe('"含\\\\反斜杠"');
    });

    it("标题含 {page} 时被清除（避免二次解析）", () => {
      const expr = buildContentExpression("{title}", "含{page}的标题", "2026-07-04");
      // safeTitle 移除了 {page}，因此结果中不含 counter(page)
      expect(expr).toBe('"含的标题"');
    });

    it("空文本输出空字符串字面量", () => {
      const expr = buildContentExpression("", "标题", "2026-07-04");
      expect(expr).toBe('""');
    });
  });

  // ─── generatePrintCss 完整 CSS 生成 ─────────────────

  describe("generatePrintCss 完整 CSS 生成", () => {
    it("默认选项生成 A4 + 20mm 边距 + 底部居中页码", () => {
      const css = generatePrintCss(DEFAULT_PDF_EXPORT_OPTIONS, "测试文档", "2026-07-04");
      expect(css).toContain("@page");
      expect(css).toContain("size: A4");
      expect(css).toContain("margin: 20mm");
      // 默认页眉 = {title}，应被替换
      expect(css).toContain("@top-center");
      expect(css).toContain("测试文档");
      // 默认页码格式 bottom-center
      expect(css).toContain("@bottom-center");
      expect(css).toContain("counter(page)");
    });

    it("纸张大小 Letter", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, paperSize: "Letter" };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("size: Letter");
    });

    it("纸张大小 Legal", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, paperSize: "Legal" };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("size: Legal");
    });

    it("窄边距 10mm", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, margin: "narrow" };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("margin: 10mm");
    });

    it("宽边距 30mm", () => {
      const opts: PdfExportOptions = { ...DEFAULT_PDF_EXPORT_OPTIONS, margin: "wide" };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("margin: 30mm");
    });

    it("自定义边距 25mm", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        margin: "custom",
        customMarginMm: 25,
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("margin: 25mm");
    });

    it("页码格式 none 不生成页码规则", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        pageNumberFormat: "none",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      // 不应包含独立的页码 counter(page) 规则
      // 注意：页脚可能仍含 counter(page)（如果 footerText 含 {page}）
      // 因此检查不包含 @bottom-center 的独立页码规则
      expect(css).not.toMatch(/@bottom-center\s*\{[^}]*content:\s*counter\(page\)/);
    });

    it("页码格式 bottom-right 生成 @bottom-right 规则", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        pageNumberFormat: "bottom-right",
        footerText: "",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("@bottom-right");
      expect(css).toContain("counter(page)");
    });

    it("页码格式 bottom-center 生成 @bottom-center 页码规则", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        pageNumberFormat: "bottom-center",
        footerText: "",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).toContain("@bottom-center");
      expect(css).toMatch(/@bottom-center\s*\{[^}]*counter\(page\)/);
    });

    it("空页眉不生成 @top-center 规则", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        headerText: "",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).not.toContain("@top-center");
    });

    it("空页脚不生成 @bottom-center 页脚规则", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        footerText: "",
        pageNumberFormat: "none",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      expect(css).not.toContain("@bottom-center");
    });

    it("页码 bottom-center 与页脚冲突时移除页脚规则", () => {
      // 当 pageNumberFormat = bottom-center 且 footerText 非空时
      // 页码规则应覆盖页脚（移除页脚的 @bottom-center，保留页码的 @bottom-center）
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        footerText: "页脚文本",
        pageNumberFormat: "bottom-center",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      // 应只包含一个 @bottom-center（页码），且内容为 counter(page)
      const matches = css.match(/@bottom-center/g) || [];
      expect(matches.length).toBe(1);
      expect(css).toMatch(/@bottom-center\s*\{[^}]*counter\(page\)/);
    });

    it("页码 bottom-right 不影响页脚 @bottom-center", () => {
      const opts: PdfExportOptions = {
        ...DEFAULT_PDF_EXPORT_OPTIONS,
        footerText: "页脚文本",
        pageNumberFormat: "bottom-right",
      };
      const css = generatePrintCss(opts, "标题", "2026-07-04");
      // 应同时包含 @bottom-center（页脚）和 @bottom-right（页码）
      expect(css).toContain("@bottom-center");
      expect(css).toContain("@bottom-right");
      expect(css).toContain("页脚文本");
    });

    it("CSS 包含 @page 起始和闭合括号", () => {
      const css = generatePrintCss(DEFAULT_PDF_EXPORT_OPTIONS, "标题", "2026-07-04");
      expect(css.startsWith("@page {")).toBe(true);
      expect(css.endsWith("}")).toBe(true);
    });
  });

  // ─── generateFullPrintStylesheet 完整样式表 ─────────

  describe("generateFullPrintStylesheet 完整样式表", () => {
    it("包含 @page 规则和 body 样式", () => {
      const css = generateFullPrintStylesheet(DEFAULT_PDF_EXPORT_OPTIONS, "标题", "2026-07-04");
      expect(css).toContain("@page");
      expect(css).toContain("body");
      expect(css).toContain("font-family");
    });

    it("body 字体大小为 12pt（打印友好）", () => {
      const css = generateFullPrintStylesheet(DEFAULT_PDF_EXPORT_OPTIONS, "标题", "2026-07-04");
      expect(css).toContain("font-size: 12pt");
    });

    it("body 行高为 1.6", () => {
      const css = generateFullPrintStylesheet(DEFAULT_PDF_EXPORT_OPTIONS, "标题", "2026-07-04");
      expect(css).toContain("line-height: 1.6");
    });

    it("body 颜色为深色 #1a1a1a", () => {
      const css = generateFullPrintStylesheet(DEFAULT_PDF_EXPORT_OPTIONS, "标题", "2026-07-04");
      expect(css).toContain("color: #1a1a1a");
    });
  });

  // ─── DEFAULT_PDF_EXPORT_OPTIONS 默认值 ─────────────

  describe("DEFAULT_PDF_EXPORT_OPTIONS 默认值", () => {
    it("默认页眉为 {title}", () => {
      expect(DEFAULT_PDF_EXPORT_OPTIONS.headerText).toBe("{title}");
    });
    it("默认页脚为 {date}", () => {
      expect(DEFAULT_PDF_EXPORT_OPTIONS.footerText).toBe("{date}");
    });
    it("默认页码格式为 bottom-center", () => {
      expect(DEFAULT_PDF_EXPORT_OPTIONS.pageNumberFormat).toBe("bottom-center");
    });
    it("默认边距为 normal", () => {
      expect(DEFAULT_PDF_EXPORT_OPTIONS.margin).toBe("normal");
    });
    it("默认自定义边距为 20mm", () => {
      expect(DEFAULT_PDF_EXPORT_OPTIONS.customMarginMm).toBe(20);
    });
    it("默认纸张大小为 A4", () => {
      expect(DEFAULT_PDF_EXPORT_OPTIONS.paperSize).toBe("A4");
    });
  });
});
