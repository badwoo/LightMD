/**
 * G5 PDF 导出排版增强 —— 纯函数模块
 *
 * 职责：根据用户选项生成 `@page` 打印 CSS（含页眉/页脚/页码/边距/纸张大小）。
 *
 * 设计原则：
 * - 纯函数：输入相同 options，输出相同 CSS 字符串；不依赖任何外部状态
 *   （日期通过参数注入，便于测试）
 * - 支持变量替换：{title} 文档标题 / {date} 日期 / {page} 页码（浏览器自动填充）
 *
 * @page margin boxes 参考：
 *   @top-center / @top-left / @top-right
 *   @bottom-center / @bottom-left / @bottom-right
 * 浏览器自动填充页码使用 counter(page)。
 */

/** 页码格式 */
export type PageNumberFormat = "none" | "bottom-center" | "bottom-right";

/** 边距预设 */
export type MarginPreset = "narrow" | "normal" | "wide" | "custom";

/** 纸张大小 */
export type PaperSize = "A4" | "Letter" | "Legal";

/** PDF 导出选项 */
export interface PdfExportOptions {
  /** 页眉文本（含变量 {title}/{date}/{page}） */
  headerText: string;
  /** 页脚文本（含变量 {title}/{date}/{page}） */
  footerText: string;
  /** 页码格式 */
  pageNumberFormat: PageNumberFormat;
  /** 边距预设 */
  margin: MarginPreset;
  /** 自定义边距值（mm），仅当 margin === "custom" 时生效 */
  customMarginMm: number;
  /** 纸张大小 */
  paperSize: PaperSize;
}

/** 默认 PDF 导出选项 */
export const DEFAULT_PDF_EXPORT_OPTIONS: PdfExportOptions = {
  headerText: "{title}",
  footerText: "{date}",
  pageNumberFormat: "bottom-center",
  margin: "normal",
  customMarginMm: 20,
  paperSize: "A4",
};

/** 边距预设值（mm） */
export const MARGIN_PRESET_MM: Record<Exclude<MarginPreset, "custom">, number> = {
  narrow: 10,
  normal: 20,
  wide: 30,
};

/** 纸张大小对应的 CSS size 值 */
export const PAPER_SIZE_CSS: Record<PaperSize, string> = {
  A4: "A4",
  Letter: "Letter",
  Legal: "Legal",
};

/**
 * 格式化日期为 YYYY-MM-DD（中文环境友好）
 * @param date Date 对象（参数注入便于测试）
 */
export function formatDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 转义 CSS 字符串字面量中的特殊字符
 * 仅处理双引号和反斜杠，避免 content: "..." 解析失败
 */
function escapeCssString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 构造 content 属性值字符串
 *
 * 处理变量替换：
 * - {title} → 文档标题（直接拼入字符串字面量）
 * - {date} → 当前日期字符串
 * - {page} → counter(page)（浏览器自动填充当前页码）
 *
 * 当文本含 {page} 时，content 使用字符串字面量与 counter(page) 拼接：
 *   content: "前缀" counter(page) "后缀";
 *
 * @param text 用户输入的页眉/页脚文本
 * @param title 文档标题
 * @param dateStr 日期字符串
 * @returns 形如 `"Hello " counter(page) " 页"` 的 CSS 表达式（不含 `content:` 和末尾 `;`）
 */
export function buildContentExpression(
  text: string,
  title: string,
  dateStr: string,
): string {
  // 1. 先替换非页码变量（避免 title 含 {page} 被二次解析）
  const safeTitle = title.replace(/\{page\}/g, "");
  const replaced = text.replace(/\{title\}/g, safeTitle).replace(/\{date\}/g, dateStr);

  // 2. 按 {page} 分割，构造 "literal" counter(page) "literal" 拼接
  const parts = replaced.split(/\{page\}/);
  if (parts.length === 1) {
    return `"${escapeCssString(parts[0])}"`;
  }
  // 多个 {page}：每个部分之间用 counter(page) 拼接
  return parts.map((p) => `"${escapeCssString(p)}"`).join(" counter(page) ");
}

/**
 * 根据选项计算实际边距值（mm）
 */
export function resolveMarginMm(options: PdfExportOptions): number {
  if (options.margin === "custom") {
    const v = options.customMarginMm;
    // 自定义边距允许 0-50mm，越界回退到正常值
    if (!Number.isFinite(v) || v < 0 || v > 50) return MARGIN_PRESET_MM.normal;
    return v;
  }
  return MARGIN_PRESET_MM[options.margin];
}

/**
 * 生成页码 margin box 规则
 *
 * @param format 页码格式
 * @returns 形如 `@bottom-center { content: counter(page); }` 的 CSS 片段（无换行起止）
 */
function buildPageNumberRule(format: PageNumberFormat): string {
  switch (format) {
    case "bottom-center":
      return `  @bottom-center {\n    content: counter(page);\n  }`;
    case "bottom-right":
      return `  @bottom-right {\n    content: counter(page);\n  }`;
    case "none":
    default:
      return "";
  }
}

/**
 * 生成完整的 @page 打印 CSS
 *
 * 输出形如：
 * ```css
 * @page {
 *   size: A4;
 *   margin: 20mm;
 *   @top-center {
 *     content: "文档标题";
 *   }
 *   @bottom-center {
 *     content: counter(page);
 *   }
 * }
 * ```
 *
 * @param options PDF 导出选项
 * @param title 文档标题（用于 {title} 变量替换）
 * @param dateStr 日期字符串（用于 {date} 变量替换）
 * @returns 完整的 @page CSS 块
 */
export function generatePrintCss(
  options: PdfExportOptions,
  title: string,
  dateStr: string = formatDate(),
): string {
  const size = PAPER_SIZE_CSS[options.paperSize];
  const marginMm = resolveMarginMm(options);

  const rules: string[] = [];
  rules.push(`  size: ${size};`);
  rules.push(`  margin: ${marginMm}mm;`);

  // 页眉：仅当用户填写了文本时生成
  if (options.headerText.trim()) {
    const headerContent = buildContentExpression(options.headerText, title, dateStr);
    rules.push(`  @top-center {\n    content: ${headerContent};\n  }`);
  }

  // 页脚：仅当用户填写了文本时生成
  if (options.footerText.trim()) {
    const footerContent = buildContentExpression(options.footerText, title, dateStr);
    rules.push(`  @bottom-center {\n    content: ${footerContent};\n  }`);
  }

  // 页码：仅当格式非 none 且未占用对应位置时生成
  // 注意：若页脚已使用 @bottom-center 且页码也是 bottom-center，
  // 页码规则应覆盖页脚（用户明确选择页码格式时优先级更高）
  const pageNumberRule = buildPageNumberRule(options.pageNumberFormat);
  if (pageNumberRule) {
    // 移除页脚中相同位置的规则以避免冲突
    if (options.pageNumberFormat === "bottom-center") {
      // 移除已添加的 @bottom-center 页脚规则
      const idx = rules.findIndex((r) => r.includes("@bottom-center"));
      if (idx >= 0) rules.splice(idx, 1);
    }
    rules.push(pageNumberRule);
  }

  return `@page {\n${rules.join("\n")}\n}`;
}

/**
 * 生成包含 body 基础样式的完整打印 CSS
 *
 * 在 @page 规则之外，添加 body 的字体、行高、颜色等基础样式，
 * 使导出 HTML 在打印时有合理的默认排版。
 *
 * @param options PDF 导出选项
 * @param title 文档标题
 * @param dateStr 日期字符串
 * @returns 完整的 <style> 标签内容（不含 <style> 标签本身）
 */
export function generateFullPrintStylesheet(
  options: PdfExportOptions,
  title: string,
  dateStr: string = formatDate(),
): string {
  const pageCss = generatePrintCss(options, title, dateStr);
  // body 基础样式：避免 @page margin:0 导致内容贴边
  // 由于 @page 已设置 margin，body 不再需要额外 padding
  const bodyCss = `body {
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12pt;
  line-height: 1.6;
  color: #1a1a1a;
}`;
  return `${pageCss}\n${bodyCss}`;
}
