/**
 * PrismJS 代码高亮集成
 */
import Prism from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-go";
// 以下为按需扩展语言（按使用频率排序）
import "prismjs/components/prism-markup-templating"; // PHP 依赖
import "prismjs/components/prism-php";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-dart";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-r";
import "prismjs/components/prism-scala";
import "prismjs/components/prism-perl";
import "prismjs/components/prism-powershell";

// 语言别名映射
const langAliases: Record<string, string> = {
  js: "javascript", ts: "typescript", jsx: "jsx", tsx: "tsx",
  html: "markup", xml: "markup", svg: "markup",
  py: "python", rs: "rust", sh: "bash", shell: "bash", zsh: "bash",
  md: "markdown", yml: "yaml", "c++": "cpp", golang: "go",
  mermaid: "markdown", // mermaid 语法高亮使用 markdown 语法
  // 扩展语言别名
  php3: "php", php4: "php", php5: "php", php7: "php", php8: "php",
  kt: "kotlin", kts: "kotlin",
  rb: "ruby",
  pl: "perl", pm: "perl",
  ps1: "powershell", pwsh: "powershell",
  rlang: "r",
};

/** 解析语言名，返回 PrismJS 支持的语言标识或 "plaintext" */
function resolveLanguage(lang: string): string {
  const normalized = lang.toLowerCase().trim();
  const resolved = langAliases[normalized] || normalized;
  const grammar = (Prism.languages as Record<string, unknown>)[resolved];
  return grammar ? resolved : "plaintext";
}

/** 对 DOM 元素内的代码块进行高亮 */
export function highlightCodeBlocks(container: HTMLElement): void {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre code[class*="language-"]');
  for (const code of codeBlocks) {
    const langMatch = code.className.match(/language-(\w+)/);
    if (!langMatch) continue;
    const lang = resolveLanguage(langMatch[1]);
    code.className = `language-${lang}`;
    if (code.classList.contains("prism-highlighted")) continue;
    try {
      const grammar = (Prism.languages as Record<string, unknown>)[lang];
      if (grammar) {
        const highlighted = Prism.highlight(code.textContent || "", grammar, lang);
        code.innerHTML = highlighted;
        code.classList.add("prism-highlighted");
      }
    } catch { /* 保留原始代码 */ }
  }
}

/** 对纯文本进行语法高亮 */
export function highlightCode(code: string, language: string): string {
  const lang = resolveLanguage(language);
  if (lang === "plaintext") return escapeHtml(code);
  const grammar = (Prism.languages as Record<string, unknown>)[lang];
  if (!grammar) return escapeHtml(code);
  try {
    return Prism.highlight(code, grammar, lang);
  } catch {
    return escapeHtml(code);
  }
}

/**
 * v0.4.0：将代码文件内容渲染为带语法高亮的 HTML
 * 用于非 Markdown 文件（.js/.py/.ts 等）的阅读模式和分屏预览
 * 整个内容用 PrismJS 高亮，包裹在 <pre class="code-file-preview"><code> 中
 * @param content 代码文本
 * @param language 语言标识（如 "javascript"/"python"，未知语言回退到 plaintext）
 * @returns 可直接插入 DOM 的 HTML 字符串
 */
export function renderCodeFilePreview(content: string, language: string): string {
  const highlighted = highlightCode(content, language);
  return `<pre class="code-file-preview"><code class="language-${language}">${highlighted}</code></pre>`;
}

/**
 * 对 HTML 字符串中的代码块进行语法高亮处理
 * 匹配 <pre><code class="language-xxx">...</code></pre> 模式，
 * 用 PrismJS 高亮代码内容（跳过 mermaid 代码块）
 * 用于分屏预览 iframe 和导出 HTML/PDF
 */
export function highlightCodeBlocksInHtml(html: string): string {
  return html.replace(
    /<pre><code class="language-([\w+-]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_match, lang: string, code: string) => {
      // mermaid 代码块不做语法高亮，交给 mermaid.js 渲染
      if (lang === "mermaid") return _match;
      // 反转义 HTML 实体，还原原始代码文本
      const rawCode = code
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
      const highlighted = highlightCode(rawCode, lang);
      return `<pre><code class="language-${lang}">${highlighted}</code></pre>`;
    }
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 生成 PrismJS 语法高亮 CSS（用于 iframe 和导出 HTML）
 * @param dark 是否暗色主题
 */
export function getPrismCss(dark: boolean): string {
  const c = dark
    ? { text: "#abb2bf", comment: "#5c6370", punct: "#abb2bf", num: "#d19a66", str: "#98c379", op: "#56b6c2", kw: "#c678dd", fn: "#61afef", regex: "#e06c75", codeBg: "#282c34" }
    : { text: "#383a42", comment: "#a0a1a7", punct: "#383a42", num: "#986801", str: "#50a14f", op: "#383a42", kw: "#a626a4", fn: "#4078f2", regex: "#e45649", codeBg: "#f4f4f4" };
  return `
code[class*="language-"], pre[class*="language-"] { color: ${c.text}; background: none; font-family: "Cascadia Code","Consolas",monospace; font-size: 0.9em; text-align: left; white-space: pre; line-height: 1.5; tab-size: 2; }
pre[class*="language-"] { background: ${c.codeBg}; padding: 12px; border-radius: 6px; overflow-x: auto; }
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: ${c.comment}; font-style: italic; }
.token.punctuation { color: ${c.punct}; }
.token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol, .token.deleted { color: ${c.num}; }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: ${c.str}; }
.token.operator, .token.entity, .token.url { color: ${c.op}; }
.token.atrule, .token.attr-value, .token.keyword { color: ${c.kw}; }
.token.function, .token.class-name { color: ${c.fn}; }
.token.regex, .token.important, .token.variable { color: ${c.regex}; }
.token.important, .token.bold { font-weight: bold; }
.token.italic { font-style: italic; }
/* 代码块容器样式（highlightCodeBlocksInHtml 生成的 <pre><code> 结构） */
pre > code[class*="language-"] { background: none; padding: 0; color: inherit; }
`;
}

export { resolveLanguage };
