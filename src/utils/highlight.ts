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

// 语言别名映射
const langAliases: Record<string, string> = {
  js: "javascript", ts: "typescript", jsx: "jsx", tsx: "tsx",
  html: "markup", xml: "markup", svg: "markup",
  py: "python", rs: "rust", sh: "bash", shell: "bash", zsh: "bash",
  md: "markdown", yml: "yaml", "c++": "cpp", golang: "go",
  mermaid: "markdown", // mermaid 语法高亮使用 markdown 语法
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { resolveLanguage };
