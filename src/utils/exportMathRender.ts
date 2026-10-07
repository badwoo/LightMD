/**
 * R2（v0.10.0）：导出公式/图表保真渲染工具
 *
 * 背景（0.9.1 测评 R2）：导出管线中公式与 mermaid 图表不渲染——
 * - PNG 长图：html-to-image 不等异步脚本，data-math 占位/pre.mermaid 原样截入（公式空白）；
 * - DOCX：公式退化为 LaTeX 源码文本、mermaid 退化为代码块（exportDocx 注释自认）；
 * - EPUB：无脚本注入，data-math 占位是空元素 → 公式完全空白。
 *
 * 本模块提供三类替换器（PNG/DOCX 走 DOM 版，EPUB 走字符串版）：
 * - KaTeX：DOM 版渲染为 KaTeX HTML（依赖主文档已加载的 /vendor/katex CSS，
 *   html-to-image 会自动内联文档字体）；EPUB 字符串版渲染为纯 MathML
 *   （EPUB3 阅读器原生支持，无需携带 KaTeX CSS）；
 * - mermaid：mermaid.render 产出 SVG 后原位替换；flowchart htmlLabels:false
 *   产出纯 SVG（无 foreignObject），html-to-image 截图与 XHTML 序列化都更可靠。
 *
 * 降级策略：单个公式/图表渲染失败时保留占位/代码块（导出不中断、内容不丢）。
 */
import katex from "katex";

/** 渲染进度回调（done/total 均为"尝试渲染数"，失败也计数） */
export type ExportRenderProgress = (done: number, total: number) => void;

/** 渲染选项 */
export interface MermaidRenderOptions {
  /** mermaid 主题（跟随应用暗色主题：dark/default） */
  theme?: string;
  /** 进度回调（大文档 20+ 图表时 UI 可展示进度） */
  onProgress?: ExportRenderProgress;
}

/**
 * 将容器内 [data-math] 占位元素替换为 KaTeX 渲染结果（PNG/DOCX 导出用）。
 *
 * katex.renderToString 为同步纯 JS 计算（jsdom 亦可运行）；
 * 样式依赖主文档已加载的 KaTeX CSS（index.html <link> /vendor/katex），
 * html-to-image 截图时自动从 document.styleSheets 内联字体。
 *
 * @returns 成功替换数
 */
export function replaceMathPlaceholdersInDom(container: HTMLElement): number {
  const els = Array.from(container.querySelectorAll<HTMLElement>("[data-math]"));
  let count = 0;
  for (const el of els) {
    const latex = el.getAttribute("data-latex") || "";
    const displayMode = el.getAttribute("data-math") === "block";
    try {
      const html = katex.renderToString(latex, { throwOnError: false, displayMode });
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      el.replaceWith(tpl.content);
      count++;
    } catch (err) {
      // 渲染失败保留占位（导出降级不中断）
      console.warn("[导出公式] KaTeX 渲染失败:", latex, err);
    }
  }
  return count;
}

/**
 * EPUB 用：字符串级将 data-math 占位替换为纯 MathML 输出。
 *
 * EPUB 章节为 XHTML 且阅读器不带 KaTeX CSS，因此不用 KaTeX HTML 输出，
 * 而用 output:"mathml"（纯 <math> 标记，EPUB3 原生支持）。
 * 占位元素由 katex-plugin 固定格式输出：<span data-math="inline" data-latex=".."></span>，
 * data-latex 属性值已 HTML 转义（&quot;&amp;&lt;&gt;），提取后需反转义。
 *
 * @returns 替换后的 html 与成功替换数
 */
export function replaceMathWithMathmlInHtml(html: string): { html: string; count: number } {
  const re = /<(span|div)\s+data-math="(inline|block)"\s+data-latex="([^"]*)"><\/\1>/g;
  let count = 0;
  const result = html.replace(re, (match, _tag, mode: string, escapedLatex: string) => {
    try {
      const latex = decodeHtmlEntities(escapedLatex);
      const mathml = katex.renderToString(latex, {
        throwOnError: false,
        displayMode: mode === "block",
        output: "mathml",
      });
      count++;
      return mathml;
    } catch (err) {
      console.warn("[导出EPUB] MathML 渲染失败:", escapedLatex, err);
      return match; // 失败保留占位
    }
  });
  return { html: result, count };
}

/**
 * 将容器内 pre.mermaid 代码块替换为 mermaid 渲染的 SVG（PNG/EPUB 导出用）。
 *
 * - htmlLabels:false：产出纯 SVG（无 foreignObject），html-to-image 截图与
 *   EPUB XHTML 序列化都更可靠；
 * - SVG 补 xmlns 与显式 width/height（从 viewBox 推导），确保独立于 CSS 正确显示。
 *
 * @returns 成功替换数
 */
export async function replaceMermaidBlocksInDom(
  container: HTMLElement,
  opts?: MermaidRenderOptions,
): Promise<number> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("pre.mermaid"));
  if (blocks.length === 0) return 0;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    // v0.11.0 B2-6：**antiscript** 而非 loose。
    // 此函数用于 DOCX/PNG/EPUB 导出：产物会被用户传播，而导出内容可能来自
    // 不可信文档；loose 允许 mermaid 标签中的 HTML/脚本执行。
    // antiscript 在保留可读性的同时禁掉脚本执行。
    securityLevel: "antiscript",
    // mermaid 主题类型为字面量联合，调用方仅传 dark/default 两种（跟随应用主题）
    theme: (opts?.theme || "default") as "dark" | "default",
    // v0.11.0 B2-6：改用**顶层** htmlLabels（mermaid 11 已废弃图种内的设置）。
    // 此前只配了 flowchart.htmlLabels，sequence / class / state 等图种仍默认走
    // foreignObject → 序列化为非法 XHTML（epubcheck 报错、严格阅读器拒开）。
    // 顶层设置对所有图种生效。
    htmlLabels: false,
  });

  let done = 0;
  for (const block of blocks) {
    const code = block.textContent || "";
    try {
      const id = `lightmd-export-mermaid-${Math.random().toString(36).slice(2, 10)}`;
      const { svg } = await mermaid.render(id, code);
      const holder = document.createElement("div");
      holder.innerHTML = svg;
      const svgEl = holder.querySelector("svg");
      if (svgEl) {
        ensureSvgStandaloneAttributes(svgEl);
        block.replaceWith(svgEl);
        done++;
      }
    } catch (err) {
      // 渲染失败保留代码块（导出降级不中断）
      console.warn("[导出图表] mermaid 渲染失败:", err);
    }
    opts?.onProgress?.(done, blocks.length);
  }
  return done;
}

/**
 * EPUB 用：字符串级 mermaid 替换——解析为临时 DOM 容器后走 DOM 版替换器再序列化回去。
 * 仅当包含 mermaid 块时才做 DOM 往返（避免无谓解析开销）。
 */
export async function replaceMermaidInHtml(html: string, opts?: MermaidRenderOptions): Promise<string> {
  if (!html.includes('class="mermaid"')) return html;
  const holder = document.createElement("div");
  holder.innerHTML = html;
  await replaceMermaidBlocksInDom(holder, opts);
  return holder.innerHTML;
}

/**
 * 补齐 SVG 独立显示所需属性：
 * - xmlns：EPUB XHTML 序列化必需（mermaid 序列化产物可能缺省）；
 * - width/height：viewBox 推导的显式尺寸，防止 width="100%" 在
 *   html-to-image 截图 / EPUB 阅读器中塌缩为 0。
 */
export function ensureSvgStandaloneAttributes(svg: SVGSVGElement): void {
  if (!svg.getAttribute("xmlns")) {
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  const viewBox = svg.getAttribute("viewBox");
  if (!viewBox) return;
  const parts = viewBox.split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return;
  const w = Math.ceil(parts[2]!);
  const h = Math.ceil(parts[3]!);
  if (!svg.getAttribute("width") || svg.getAttribute("width") === "100%") {
    svg.setAttribute("width", String(w));
  }
  if (!svg.getAttribute("height") || svg.getAttribute("height") === "100%") {
    svg.setAttribute("height", String(h));
  }
}

/** 反转义 katex-plugin 输出的 data-latex 属性值（&amp;/&quot;/&lt;/&gt;） */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
