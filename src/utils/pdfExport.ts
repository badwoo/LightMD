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
 * v0.11.0 B2-2：**已停用**，恒返回空串。
 *
 * 缺陷背景（P1）：本函数此前生成 `@bottom-center { content: counter(page) }`，
 * 但导出走 Chromium `--print-to-pdf`（src-tauri/commands/export.rs），
 * **Chromium 不支持 CSS 分页上下文（margin box）** → `@page` 内的
 * `@top-center` / `@bottom-center` 全部被静默忽略，PdfExportDialog 的
 * 「页眉/页脚/页码」4 个排版选项中 3 个实际无效。
 *
 * 本次决策（用户拍板）：**降级为「仅页脚、不含页码」**。
 * 原因：Chromium 打印时 `position: fixed` 元素会在**每页重复**（见
 * generateFixedMarginBoxCss），故页眉页脚可正常实现；但页码依赖 counter(page)
 * 且 margin box 不可用，在现有导出引擎下无法正确实现。
 * 与其提供一个看似可选、实则无效的开关，不如停用并在 UI 中说明。
 *
 * 保留本函数（返回空串）而非删除，是为了让 PdfExportDialog 的类型与
 * 既有测试不必大改；未来若改用 WebView2 PrintToPdf（支持 margin box），
 * 可直接恢复实现。
 */
function buildPageNumberRule(format: PageNumberFormat): string {
  void format;
  return "";
}

/**
 * v0.11.0 B2-2：把 {title}/{date} 变量替换为纯文本。
 *
 * 与 buildContentExpression 的区别：**不处理 {page}** —— margin box 不可用后
 * 页码无法实现，文本中的 {page} 直接剔除（而非留下一个永远不替换的占位符）。
 */
function buildPlainText(text: string, title: string, dateStr: string): string {
  const safeTitle = title.replace(/\{page\}/g, "");
  return text
    .replace(/\{title\}/g, safeTitle)
    .replace(/\{date\}/g, dateStr)
    .replace(/\{page\}/g, "");
}

/**
 * v0.11.0 B2-2：生成页眉/页脚的**常规文档流元素**样式（替代失效的 margin box）。
 *
 * 原理：Chromium 打印时 `position: fixed` 的元素会在每一页重复渲染。
 * **定位基准是页面盒（含页边距），不是内容盒** —— 实测同一 header 在
 * `@page{margin:20mm}` 与 `@page{margin:40mm}` 下，首个文本基线 Y 完全相同
 * （差 0.0pt），说明 `top:0` 贴的是**物理页顶**，落在页边距区内、不会压正文。
 *
 * ⚠️ v0.11.0 返修：首版用**负偏移**（`top:-offsetMm`）把元素拉进页边距，
 * 实测会同时踩两个坑（本机 Edge 154 对照实验，见 scripts 实验记录）：
 *   1. 页眉在**最后一页**丢失、页脚在**第一页**丢失（29 页文档实测 28/29）；
 *   2. 短文档（4 段，基线 1 页）会**多出一页仅有页脚的空白页**。
 * 改为零偏移后：长文档每页齐全且页数=基线，短文档页数也=基线。
 *
 * @param options PDF 导出选项
 * @param title 文档标题（{title}/{date} 变量替换）
 * @param dateStr 日期字符串
 * @returns CSS 片段（无页眉页脚时返回空串）
 */
export function generateFixedMarginBoxCss(
  options: PdfExportOptions,
  title: string,
  dateStr: string = formatDate(),
): string {
  void title;
  void dateStr;
  const hasHeader = options.headerText.trim().length > 0;
  const hasFooter = options.footerText.trim().length > 0;
  if (!hasHeader && !hasFooter) return "";

  const rules: string[] = [];
  if (hasHeader) {
    rules.push(`.pdf-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 9pt;
  color: #666;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
}`);
  }
  if (hasFooter) {
    rules.push(`.pdf-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 9pt;
  color: #666;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
}`);
  }
  return rules.join("\n");
}

/**
 * v0.11.0 B2-2：生成页眉/页脚的 HTML 片段（与 generateFixedMarginBoxCss 配套）。
 *
 * 注意：CSS `content` 属性只对 ::before/::after 伪元素生效，页眉页脚内容
 * 必须放进真实 DOM 节点，否则 Chromium 打印时输出空白。
 *
 * @returns HTML 片段（无页眉页脚时返回空串）
 */
export function generateFixedMarginBoxHtml(
  options: PdfExportOptions,
  title: string,
  dateStr: string = formatDate(),
): string {
  const parts: string[] = [];
  if (options.headerText.trim()) {
    const text = buildPlainText(options.headerText, title, dateStr);
    parts.push(`<div class="pdf-header">${escapeHtmlText(text)}</div>`);
  }
  if (options.footerText.trim()) {
    const text = buildPlainText(options.footerText, title, dateStr);
    parts.push(`<div class="pdf-footer">${escapeHtmlText(text)}</div>`);
  }
  return parts.join("\n");
}

/** HTML 文本转义（页眉页脚内容进 DOM，需防注入） */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  // v0.11.0 B2-2：@page 内**只保留 size 与 margin**。
  // 此前还在此生成 @top-center / @bottom-center（页眉/页脚）与 counter(page)
  // （页码），但导出走 Chromium --print-to-pdf，不支持分页上下文 margin box
  // → 全部被静默忽略。现页眉页脚改由 generateFixedMarginBoxCss/Html 以
  // position:fixed 常规元素实现（Chromium 打印时每页重复）。
  const rules: string[] = [];
  rules.push(`  size: ${size};`);
  rules.push(`  margin: ${marginMm}mm;`);

  // 兼容保留：buildPageNumberRule 恒返回空串（页码已降级停用）
  const pageNumberRule = buildPageNumberRule(options.pageNumberFormat);
  if (pageNumberRule) rules.push(pageNumberRule);

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
  // v0.11.0 B2-2：页眉/页脚改用 fixed 常规元素（Chromium 打印每页重复），
  // 不再依赖 @page margin box（Chromium 不支持，原实现静默失效）
  const marginBoxCss = generateFixedMarginBoxCss(options, title, dateStr);
  // body 基础样式：避免 @page margin:0 导致内容贴边
  // 由于 @page 已设置 margin，body 不再需要额外 padding
  const bodyCss = `body {
  font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12pt;
  line-height: 1.6;
  color: #1a1a1a;
}`;
  const parts = [pageCss, marginBoxCss, bodyCss].filter(Boolean);
  return parts.join("\n");
}
