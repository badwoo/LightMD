/**
 * markdown-it TOC（自动目录）插件
 *
 * 识别 `[toc]` 或 `[[toc]]` 语法（不区分大小写），自动生成嵌套目录列表。
 *
 * 设计：
 * - block rule：单独占一行时匹配 `[toc]` / `[[toc]]`，生成 toc token
 * - renderer 规则：从 env.__headings 读取 heading 列表（由 heading-anchor 插件收集），
 *   生成嵌套 <ul><li><a href="#id">文本</a></li></ul>
 * - 若 env 无缓存（heading-anchor 插件未启用），则就地扫描 tokens 兜底
 *
 * 效率：依赖 heading-anchor 插件缓存，全文只扫描一次，多个 [toc] 共享结果。
 * 内存安全：不持有任何引用，结果随 env 生命周期释放。
 */
import type MarkdownIt from "markdown-it";
import { collectHeadings, type TocHeading } from "./heading-anchor";

// 匹配单独占一行的 [toc] 或 [[toc]]（不区分大小写，允许前后空白）
const TOC_RE = /^\s*\[\[?toc\]?\]\s*$/i;

function tocBlock(state: any, startLine: number, _endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const line = state.src.slice(pos, max);

  if (!TOC_RE.test(line)) return false;
  if (silent) return true;

  const token = state.push("toc", "div", 0);
  token.block = true;
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 根据标题列表生成嵌套 <nav class="toc"><ul>...</ul></nav>。
 * 跳级（h1 后直接 h3）会生成嵌套 <ul> 以保持语义层级。
 */
function renderToc(headings: TocHeading[]): string {
  if (headings.length === 0) return '<nav class="toc"></nav>\n';

  const minLevel = Math.min(...headings.map((h) => h.level));
  let html = '<nav class="toc">\n<ul>\n';
  let prevLevel = minLevel;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level > prevLevel) {
      // 进入子级，每深一级开启一个 <ul>
      html += '<ul>\n'.repeat(h.level - prevLevel);
    } else if (h.level < prevLevel) {
      // 返回父级，每浅一级关闭一个 </ul></li>
      html += '</li>\n</ul>\n'.repeat(prevLevel - h.level);
      html += '</li>\n'; // 闭合上一个同级 li
    } else if (i > 0) {
      // 同级，闭合上一个 li
      html += '</li>\n';
    }
    html += `<li><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a>`;
    prevLevel = h.level;
  }

  // 闭合最后一项
  html += '</li>\n';
  // 关闭剩余的嵌套 <ul>
  for (let l = prevLevel; l > minLevel; l--) {
    html += '</ul>\n</li>\n';
  }
  html += '</ul>\n</nav>\n';
  return html;
}

export function tocPlugin(md: MarkdownIt): void {
  // 在 paragraph 之前匹配，避免 [toc] 被当成普通段落
  md.block.ruler.before("paragraph", "toc", tocBlock);

  // 渲染规则：输出嵌套目录
  md.renderer.rules.toc = (tokens: any[], _idx: number, _options: any, env: any) => {
    // 优先使用 heading-anchor 插件缓存的 headings，避免重复扫描
    let headings: TocHeading[] | undefined = env.__headings;
    if (!headings) {
      // 兜底：未启用 heading-anchor 插件时，就地扫描 tokens
      headings = collectHeadings(tokens);
      env.__headings = headings;
    }
    return renderToc(headings);
  };
}
