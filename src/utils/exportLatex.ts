/**
 * v0.8.0 WP6 导出 LaTeX（.tex）工具
 *
 * 设计原则：
 * - 自研 markdown-it token → LaTeX 转换器，复用 exportBlocks.ts 的 Block[] / InlineRun[] 中间结构
 * - 不引入 pandoc / 外部进程，纯前端字符串拼接，离线可用
 * - 动态 import 无（jszip 仅 ePub 使用），依赖 markdown-it（已在主项目）
 *
 * 关键正确性点（最容易出 bug）：
 * - 普通文本中的 LaTeX 特殊字符 # $ % & _ { } ~ ^ \ 必须转义
 * - 代码块（lstlisting）与数学公式（\[...\] / $...$）内部**不转义**
 *
 * 头模板：\documentclass{ctexart} + graphicx/hyperref/listings/booktabs/xcolor/ulem/soul/amsmath
 *
 * v0.8.0 图片：仅写出 \includegraphics{原始路径}，不负责拷贝图片文件（见文档头注释）。
 */

import { isTauri } from "../services/fileService";
import { notifyError, notifySuccess } from "../services/notificationService";
import { t } from "../i18n";
import { parseMarkdownToBlocks } from "./exportBlocks";
import type { Block, InlineRun, ListItem } from "./exportBlocks";

// 对外统一出口：LaTeX 导出消费方无需直接依赖 exportBlocks
export { parseMarkdownToBlocks } from "./exportBlocks";

/** 从文件路径推导默认保存目录 */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

/**
 * 转义 LaTeX 普通文本中的特殊字符。
 *
 * 单遍正则替换（替换串不再二次扫描），确保 \textbackslash{} 等转义产物不被二次转义。
 * 注意：此函数**仅用于普通文本**；代码块与公式内容不应调用本函数。
 */
export function escapeLatexText(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => {
    switch (ch) {
      case "\\": return "\\textbackslash{}";
      case "&": return "\\&";
      case "%": return "\\%";
      case "$": return "\\$";
      case "#": return "\\#";
      case "_": return "\\_";
      case "{": return "\\{";
      case "}": return "\\}";
      case "~": return "\\textasciitilde{}";
      case "^": return "\\textasciicircum{}";
      default: return ch;
    }
  });
}

/** 行内 runs → LaTeX（含格式包裹与转义规则） */
export function inlineRunsToLatex(runs: InlineRun[]): string {
  let out = "";
  for (const run of runs) {
    // 行内公式：保留原始 LaTeX，不加转义
    if (run.math) {
      out += `$${run.math}$`;
      continue;
    }
    // 图片：写出 \includegraphics（原始路径，不转义，v0.8.0 限制见文档头注释）
    if (run.imageSrc) {
      out += `\\includegraphics{${run.imageSrc}}`;
      continue;
    }
    // 行内代码：原始内容不转义，包裹 \texttt
    if (run.code) {
      out += `\\texttt{${run.text}}`;
      continue;
    }
    // 普通文本：转义特殊字符
    let inner = escapeLatexText(run.text);
    if (run.bold) inner = `\\textbf{${inner}}`;
    if (run.italic) inner = `\\emph{${inner}}`;
    if (run.strike) inner = `\\sout{${inner}}`;
    if (run.mark) inner = `\\hl{${inner}}`;
    if (run.sub) inner = `\\textsubscript{${inner}}`;
    if (run.sup) inner = `\\textsuperscript{${inner}}`;
    if (run.href) inner = `\\href{${run.href}}{${inner}}`;
    out += inner;
  }
  return out;
}

/** 标题级别 → LaTeX 章节命令 */
const HEADING_COMMANDS = [
  "\\section",
  "\\subsection",
  "\\subsubsection",
  "\\paragraph",
  "\\subparagraph",
  "\\subparagraph",
];

/** listings 已知语言白名单（避免未知 language= 导致编译错误） */
const KNOWN_LISTINGS_LANGS = new Set([
  "python", "py", "c", "cpp", "c++", "c#", "java", "javascript", "js",
  "typescript", "ts", "bash", "sh", "shell", "html", "xml", "tex", "latex",
  "ruby", "php", "perl", "make", "sql", "go", "rust", "r", "scala", "kotlin",
  "yaml", "json", "dockerfile", "fortran", "matlab", "octave",
]);

function normalizeLang(lang: string): string {
  const l = lang.toLowerCase().trim();
  if (KNOWN_LISTINGS_LANGS.has(l)) return l;
  // 常见的别名归一
  if (l === "ts") return "typescript";
  if (l === "py") return "python";
  if (l === "sh" || l === "shell") return "bash";
  return "";
}

/** 单元格 runs → LaTeX（表格内换行需替换为空格，避免破坏 tabular） */
function cellToLatex(runs: InlineRun[]): string {
  return inlineRunsToLatex(runs).replace(/\n/g, " ");
}

/** 列表渲染（支持嵌套，item 的 children 视为嵌套列表） */
function renderListItems(items: ListItem[], ordered: boolean): string {
  const env = ordered ? "enumerate" : "itemize";
  const lines: string[] = [`\\begin{${env}}`];
  for (const item of items) {
    let itemText = "\\item " + inlineRunsToLatex(item.runs);
    if (item.children && item.children.length > 0) {
      // 嵌套列表必须位于 \item 内部（在该 item 文本之后、下一个 \item 之前）
      itemText += "\n" + renderListItems(item.children, ordered);
    }
    lines.push(itemText);
  }
  lines.push(`\\end{${env}}`);
  return lines.join("\n");
}

/** 表格渲染：tabular + l 列 + booktabs 规则 */
function renderTable(block: Extract<Block, { kind: "table" }>): string {
  const colCount = block.header[0]?.length || block.rows[0]?.length || 1;
  const spec = "l".repeat(colCount);
  const rows: string[] = [];
  rows.push(`\\begin{tabular}{${spec}}`);
  rows.push("\\toprule");
  // 表头
  for (const headerRow of block.header) {
    rows.push(headerRow.map((cell) => cellToLatex(cell)).join(" & "));
  }
  rows.push("\\\\");
  rows.push("\\midrule");
  // 表体
  block.rows.forEach((row, idx) => {
    rows.push(row.map((cell) => cellToLatex(cell)).join(" & "));
    if (idx < block.rows.length - 1) rows.push("\\\\");
  });
  rows.push("\\\\");
  rows.push("\\bottomrule");
  rows.push("\\end{tabular}");
  return `\\begin{table}[h]\n\\centering\n${rows.join("\n")}\n\\end{table}`;
}

/**
 * 将单个 Block 渲染为 LaTeX 片段（不含文档头/尾）
 */
function blockToLatex(block: Block): string {
  switch (block.kind) {
    case "heading": {
      const cmd = HEADING_COMMANDS[block.level - 1] || "\\section";
      return `${cmd}{${inlineRunsToLatex(block.runs)}}`;
    }
    case "paragraph": {
      const text = inlineRunsToLatex(block.runs);
      return text.length > 0 ? `${text}\n\n` : "";
    }
    case "bulletList":
      return renderListItems(block.items, false) + "\n";
    case "orderedList":
      return renderListItems(block.items, true) + "\n";
    case "codeBlock": {
      const lang = normalizeLang(block.language);
      const opt = lang ? `[language=${lang}]` : "";
      // 代码块内容**不转义**，原样写入 lstlisting
      const content = block.content.replace(/\n$/, "");
      return `\\begin{lstlisting}${opt}\n${content}\n\\end{lstlisting}\n`;
    }
    case "blockquote":
      return `\\begin{quote}\n${blocksToLatex(block.blocks)}\\end{quote}\n`;
    case "hr":
      return "\\hrule\n";
    case "mathBlock":
      // 块公式内部**不转义**，原样写入
      return `\\[\n${block.latex}\n\\]\n`;
    case "table":
      return renderTable(block) + "\n";
    // v0.11.0 B2-4：新增两种 kind 的 LaTeX 渲染（此前落 default 被丢弃）
    case "taskList": {
      // 任务列表 → itemize + \(\square\) / \(\boxtimes\)（amssymb 提供 \square）
      const items = block.items
        .map((item) => {
          const mark = item.checked ? "\\boxtimes" : "\\square";
          const text = inlineRunsToLatex(item.runs);
          return `  \\item[${mark}] ${text}`;
        })
        .join("\n");
      return `\\begin{itemize}\n${items}\n\\end{itemize}\n`;
    }
    case "defList": {
      // 定义列表 → description 环境（LaTeX 原生支持）
      const items = block.items
        .map((item) => {
          const term = inlineRunsToLatex(item.term);
          const descs = item.descriptions
            .map((d) => inlineRunsToLatex(d))
            .join("\n\n");
          return `  \\item[${term}] ${descs}`;
        })
        .join("\n");
      return `\\begin{description}\n${items}\n\\end{description}\n`;
    }
    case "toc": {
      // 自动目录内容 → 转为章节列表（LaTeX 真实目录应用 \tableofcontents，此处输出静态列表）
      if (block.headings.length === 0) return "";
      const items = block.headings
        .map((h) => {
          const indent = "  ".repeat(Math.max(0, h.level - 1));
          return `${indent}\\item ${h.text}`;
        })
        .join("\n");
      return `\\begin{itemize}\n${items}\n\\end{itemize}\n`;
    }
  }
}

/** 将 Block[] 渲染为 LaTeX 正文（不含文档头/尾） */
export function blocksToLatex(blocks: Block[]): string {
  return blocks.map(blockToLatex).join("").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** 文档头模板 */
function latexPreamble(title: string): string {
  const safeTitle = title.replace(/\.md$/i, "").replace(/[\\&%$#_{}~^]/g, "\\$&");
  return `\\documentclass{ctexart}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{booktabs}
\\usepackage{xcolor}
\\usepackage{ulem}
\\usepackage{soul}
\\usepackage{amsmath}
\\usepackage{amssymb}
% v0.8.0 限制：图片以 \\includegraphics{原始路径} 形式写出，未自动拷贝图片文件。
% 请将图片放置于 .tex 同目录（或修改路径）后再用 XeLaTeX 编译。
\\begin{document}
\\title{${safeTitle}}
\\author{}
\\date{}
\\maketitle
`;
}

/**
 * 将 markdown 转换为完整 LaTeX 文档字符串
 *
 * @param markdown markdown 源码
 * @param title 文档标题（用于 \\title）
 * @returns 完整 .tex 内容
 */
export function markdownToLatex(markdown: string, title: string = "Document"): string {
  const blocks = parseMarkdownToBlocks(markdown);
  const body = blocksToLatex(blocks);
  return `${latexPreamble(title)}${body}\\end{document}\n`;
}

/** 浏览器模式下载 Blob */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 导出 .tex 文件（Tauri 用 save 对话框，浏览器回退下载）
 *
 * @param markdown markdown 源码
 * @param filename 文件名（不含扩展名）
 * @param filePath 当前编辑文件路径，用于推导默认保存目录
 * @returns 成功返回 true，失败返回 false
 */
export async function exportLatex(
  markdown: string,
  filename: string,
  filePath?: string | null,
): Promise<boolean> {
  try {
    const latex = markdownToLatex(markdown, filename.replace(/\.md$/i, ""));
    const finalName = filename.replace(/\.md$/i, "") + ".tex";

    if (isTauri()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const defaultDir = getDefaultDir(filePath);
        const selected = await save({
          defaultPath: defaultDir ? `${defaultDir}/${finalName}` : finalName,
          filters: [{ name: "LaTeX", extensions: ["tex"] }],
        });
        if (selected) {
          const encoder = new TextEncoder();
          await writeFile(selected, encoder.encode(latex));
          notifySuccess(t("export.latex.exported", { name: finalName }));
          return true;
        }
        return false; // 用户取消
      } catch (err) {
        console.error("Tauri 导出 LaTeX 失败，回退到浏览器下载:", err);
      }
    }

    // 浏览器模式：触发下载
    downloadBlob(new Blob([latex], { type: "application/x-tex;charset=utf-8" }), finalName);
    notifySuccess(t("export.latex.exported", { name: finalName }));
    return true;
  } catch (err) {
    console.error("LaTeX 导出失败:", err);
    notifyError(
      t("export.latex.exportFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
