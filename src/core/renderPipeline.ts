/**
 * R1（v0.10.0）：统一渲染管线
 *
 * 背景（0.9.1 测评 R1）：同一文档存在三套 markdown-it 配置源——
 * 分屏预览（parser.ts 工厂实例）、导出 HTML/PDF/PNG（ExportDialog 独立实例）、
 * DOCX/LaTeX（exportBlocks 独立实例）。核验发现两处漂移：
 * ① 导出 typographer:true vs 编辑器 false → 弯引号不一致（所见非所得）；
 * ② 导出 validateLink 关闭 → `javascript:` 等危险 scheme URL 可进入导出 HTML（安全洞）。
 *
 * 统一决策（本文件为单一事实来源）：
 * - typographer 恒 false：导出与编辑所见即所得一致，导出不静默改写用户引号；
 * - validateLink 白名单全管线强制：sanitizeLinkHref 拒绝 javascript:/vbscript:/file:，
 *   放行 data:image（v0.9.5 起），base64 图片导出不受影响，无需再传 validateLink:false；
 * - HTML 白名单（E8）：编辑/分屏/导出 HTML·PDF·PNG 共用 html:true + htmlBlockDisabled
 *   （html_block 禁用、行内仅 <u>/<br>/<sub>/<sup>/<mark> 放行）；
 *   DOCX/LaTeX 例外维持 html:false——其 Block[] 中间结构无法承载 html token，
 *   开启会走 default 分支丢内容（E14 factory jsdoc 已述）。
 *
 * 调用方（新增语法只改此处 + parser.ts 工厂一处配置）：
 * - 分屏预览：EditorContainer.renderMarkdownToHtml → renderMarkdownHtml
 * - 导出 HTML/PDF/PNG：ExportDialog.renderMarkdownToHTML → renderMarkdownHtml
 * - DOCX/LaTeX：exportBlocks.createDefaultMarkdownIt → getDocxLatexMarkdownIt
 */
import type MarkdownIt from "markdown-it";
import { createMarkdownIt, getMarkdownIt } from "./markdown/parser";
import { useSettingsStore } from "../stores/useSettingsStore";
import { highlightCodeBlocksInHtml } from "../utils/highlight";

/** 段内换行语义（true=GFM 即换行；false=CommonMark），未传时读设置 */
export function getRenderBreaks(): boolean {
  return useSettingsStore.getState().paragraphBreaks !== "commonmark";
}

/**
 * 渲染/导出共用的 markdown-it 实例（分屏 + HTML/PDF/PNG 导出）。
 * 直接委托 parser.ts 的 getMarkdownIt——与编辑器 PM 解析共用同一工厂配置，
 * 保证"编辑器里能解析的语法"与"分屏/导出里渲染的语法"一致。
 */
export function getRenderMarkdownIt(breaks: boolean = getRenderBreaks()): MarkdownIt {
  return getMarkdownIt(breaks);
}

/**
 * DOCX/LaTeX 导出专用实例：HTML 关闭（Block[] 中间结构无法承载 html token，
 * 见模块 jsdoc），其余配置（typographer false + validateLink 白名单）与渲染管线一致。
 */
export function getDocxLatexMarkdownIt(breaks: boolean = getRenderBreaks()): MarkdownIt {
  return createMarkdownIt({ breaks, typographer: false, validateLink: true });
}

/** 渲染选项 */
export interface RenderMarkdownHtmlOptions {
  /** 是否对代码块做 Prism 高亮（默认 true；EPUB 等纯结构场景可关闭） */
  highlight?: boolean;
}

/**
 * 统一的 markdown → HTML 渲染入口。
 *
 * 步骤：markdown-it 渲染 → mermaid 代码块包装为 `<pre class="mermaid">`
 * （供 iframe 内 mermaid 脚本 / R2 导出替换器识别）→ Prism 代码高亮（跳过 mermaid）。
 * 此前三处调用方各自复制 mermaid 包装正则 + 高亮调用，是渲染不一致的温床。
 */
export function renderMarkdownHtml(markdown: string, opts?: RenderMarkdownHtmlOptions): string {
  let html = getRenderMarkdownIt().render(markdown);
  // 将 mermaid 代码块包装为可渲染的容器（iframe 脚本 / 导出替换器以此识别）
  html = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    '<pre class="mermaid">$1</pre>',
  );
  // 对代码块进行 PrismJS 语法高亮（highlightCodeBlocksInHtml 内部跳过 mermaid 代码块）
  if (opts?.highlight !== false) {
    html = highlightCodeBlocksInHtml(html);
  }
  return html;
}
