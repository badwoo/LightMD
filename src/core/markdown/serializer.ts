/**
 * ProseMirror 文档 → Markdown 字符串序列化器
 */
import type { Node, Mark } from "prosemirror-model";

/**
 * 将 ProseMirror 文档序列化为 Markdown 字符串
 */
export function docToMarkdown(doc: Node): string {
  const parts: string[] = [];
  doc.forEach((node, _offset, index) => {
    const md = blockToMarkdown(node);
    if (md !== null) {
      // 在块之间添加空行（分割线、列表项之间特殊处理）
      if (index > 0 && !md.startsWith("|") && parts.length > 0) {
        const last = parts[parts.length - 1];
        if (!last.endsWith("\n\n") && last !== "") {
          parts.push("\n");
        }
      }
      parts.push(md);
    }
  });
  return parts.join("").trimEnd() + "\n";
}

// ─── 块级序列化 ──────────────────────────────────────────

function blockToMarkdown(node: Node): string | null {
  switch (node.type.name) {
    case "paragraph":
      return inlineToMarkdown(node) + "\n";
    case "heading":
      return headingToMarkdown(node);
    case "blockquote":
      return blockquoteToMarkdown(node);
    case "code_block":
      return codeBlockToMarkdown(node);
    case "mermaid_block":
      return mermaidBlockToMarkdown(node);
    case "math_block":
      return mathBlockToMarkdown(node);
    case "bullet_list":
      return listToMarkdown(node, "-");
    case "ordered_list":
      return listToMarkdown(node, "1.");
    case "task_list":
      return taskListToMarkdown(node);
    case "horizontal_rule":
      return "---\n";
    case "table":
      return tableToMarkdown(node);
    default:
      return null;
  }
}

// ─── 标题 ────────────────────────────────────────────────

function headingToMarkdown(node: Node): string {
  const level = node.attrs.level;
  const prefix = "#".repeat(level);
  const content = inlineToMarkdown(node);
  return `${prefix} ${content}\n`;
}

// ─── 引用块 ──────────────────────────────────────────────

function blockquoteToMarkdown(node: Node): string {
  const lines: string[] = [];
  node.forEach((child) => {
    const childMd = blockToMarkdown(child);
    if (childMd) {
      // 每行前面加 "> "
      childMd.split("\n").filter(Boolean).forEach((line) => {
        lines.push(`> ${line}`);
      });
    }
  });
  return lines.join("\n") + "\n";
}

// ─── 代码块 ──────────────────────────────────────────────

function codeBlockToMarkdown(node: Node): string {
  const language = node.attrs.language || "";
  const content = node.textContent;
  return "```" + language + "\n" + content + "\n```\n";
}

// ─── Mermaid 图表块 ──────────────────────────────────────

function mermaidBlockToMarkdown(node: Node): string {
  const content = node.textContent;
  return "```mermaid\n" + content + "\n```\n";
}

// ─── 块级数学公式 ──────────────────────────────────────

function mathBlockToMarkdown(node: Node): string {
  const content = node.textContent || node.attrs.latex || "";
  return "$$\n" + content + "\n$$\n";
}

// ─── 列表 ────────────────────────────────────────────────

function listToMarkdown(
  node: Node,
  marker: string
): string {
  const lines: string[] = [];
  let idx = 1;

  node.forEach((listItem) => {
    // 对于有序列表，使用递增数字
    const prefix = marker === "1." ? `${idx}.` : marker;

    // 遍历列表项的所有子节点
    let isFirstChild = true;
    listItem.forEach((child) => {
      const childMd = blockToMarkdown(child);
      if (!childMd) return;

      if (isFirstChild && child.type.name === "paragraph") {
        // 第一个段落：与列表标记同行
        const content = inlineToMarkdown(child);
        lines.push(`${prefix} ${content}`);
        isFirstChild = false;
      } else {
        // 后续内容：4空格缩进（标准 Markdown 续行）
        const indent = "    ";
        const trimmed = childMd.trimEnd();
        trimmed.split("\n").forEach((line) => {
          if (line) {
            lines.push(`${indent}${line}`);
          }
        });
        isFirstChild = false;
      }
    });

    idx++;
  });

  return lines.join("\n") + "\n";
}

// ─── 任务列表 ──────────────────────────────────────────

function taskListToMarkdown(node: Node): string {
  const lines: string[] = [];

  node.forEach((taskItem) => {
    const checked = taskItem.attrs.checked ? "x" : " ";
    // 遍历 task_item 的子节点（第一个是 paragraph）
    let isFirstChild = true;
    taskItem.forEach((child) => {
      const childMd = blockToMarkdown(child);
      if (!childMd) return;

      if (isFirstChild && child.type.name === "paragraph") {
        const content = inlineToMarkdown(child);
        lines.push(`- [${checked}] ${content}`);
        isFirstChild = false;
      } else {
        // 后续内容：4空格缩进
        const indent = "    ";
        const trimmed = childMd.trimEnd();
        trimmed.split("\n").forEach((line) => {
          if (line) lines.push(`${indent}${line}`);
        });
        isFirstChild = false;
      }
    });
  });

  return lines.join("\n") + "\n";
}

// ─── 表格 ────────────────────────────────────────────────

function tableToMarkdown(node: Node): string {
  const rows: string[][] = [];
  const aligns: string[] = [];

  // 收集所有行
  node.forEach((section) => {
    section.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell, _offset, colIdx) => {
        cells.push(inlineToMarkdown(cell).trim());
        // 从第一个thead行提取对齐
        if (aligns.length <= colIdx && section.type.name === "table_head") {
          aligns[colIdx] = cell.attrs.align || "left";
        }
      });
      rows.push(cells);
    });
  });

  if (rows.length === 0) return "";

  const colCount = rows[0]?.length || 0;
  if (colCount === 0) return "";

  const result: string[] = [];

  // 表头（第一行）
  result.push("| " + rows[0].map((c) => c || " ").join(" | ") + " |");

  // 分隔行
  const sep = aligns.map((a) => {
    switch (a) {
      case "center": return ":---:";
      case "right": return "---:";
      default: return "---";
    }
  });
  // 补齐缺少的对齐
  while (sep.length < colCount) sep.push("---");
  result.push("| " + sep.join(" | ") + " |");

  // 数据行
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    while (cells.length < colCount) cells.push("");
    result.push("| " + cells.map((c) => c || " ").join(" | ") + " |");
  }

  return result.join("\n") + "\n";
}

// ─── Inline 序列化 ───────────────────────────────────────

function inlineToMarkdown(node: Node): string {
  const parts: string[] = [];

  node.forEach((child) => {
    if (child.type.name === "text") {
      let text = child.text || "";

      // 从内到外应用标记
      const marks = child.marks;
      // 反转顺序：先处理外层标记
      for (let i = marks.length - 1; i >= 0; i--) {
        text = applyMark(text, marks[i]);
      }

      parts.push(text);
    } else if (child.type.name === "image") {
      const { src, alt, title } = child.attrs;
      const titlePart = title ? ` "${title}"` : "";
      parts.push(`![${alt || ""}](${src}${titlePart})`);
    } else if (child.type.name === "hard_break") {
      parts.push("\n");
    } else if (child.type.name === "math_inline") {
      // 行内数学公式
      const latex = child.textContent || child.attrs.latex || "";
      parts.push(`$${latex}$`);
    }
  });

  return parts.join("");
}

function applyMark(text: string, mark: Mark): string {
  switch (mark.type.name) {
    case "strong":
      return `**${text}**`;
    case "em":
      return `*${text}*`;
    case "code":
      // 如果文本包含反引号，使用双反引号包裹
      if (text.includes("`")) {
        return `\`\`${text}\`\``;
      }
      return `\`${text}\``;
    case "strike":
      return `~~${text}~~`;
    case "link": {
      const { href, title } = mark.attrs;
      const titlePart = title ? ` "${title}"` : "";
      return `[${text}](${href}${titlePart})`;
    }
    default:
      return text;
  }
}
