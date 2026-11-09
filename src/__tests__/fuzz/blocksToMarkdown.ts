/**
 * v0.17.0 P0-3 —— Block[] → Markdown 重建器（导出 oracle 的必需件）。
 *
 * 为什么必须自己写：`src/utils/exportBlocks.ts` 只做 `md → Block[]`，
 * 没有反向。要构成 `md → Blocks → md` 的闭环 oracle，必须在测试侧提供
 * Block[] → md。**这是测试基建，不是业务实现**（不碰 src/ 业务文件）。
 *
 * 重建口径：只输出 Block[] 结构**能承载**的信息。哪些承载不了，是 B 线要
 * 处理/声明的能力边界（见 fuzz 白名单的 boundary 条目），不是本文件要补偿的
 * —— 补偿会让 oracle 失去检测能力（自己补回去就永远发现不了导出丢信息）。
 */

import type { Block, InlineRun, ListItem, DefItem } from "../../utils/exportBlocks";
import { stripTdWrapperText } from "../../utils/exportBlocks";

/** InlineRun[] → markdown 行内文本 */
export function runsToMarkdown(runs: InlineRun[]): string {
  let out = "";
  for (const r of runs) {
    let text = r.text;
    if (r.imageSrc !== undefined) {
      // parseInlineTokens 的占位形态：`[图片: <alt+后缀>]` → 还原成图片语法
      const m = /^\[图片(?::\s*(.+))?\]$/.exec(text);
      const alt = m && m[1] ? m[1].replace(/\\\|/g, "|") : "";
      out += `![${alt}](${r.imageSrc})`;
      continue;
    }
    if (r.math !== undefined) {
      out += `$${r.math}$`;
      continue;
    }
    if (r.code) {
      // 行内 code 围栏按 CommonMark：最长反引号段 +1
      const longest = (text.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0);
      const fence = "`".repeat(longest + 1);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      text = fence + pad + text + pad + fence;
    }
    // 格式标记的嵌套顺序与 serializer 的 MARK_OUTER_ORDER 近似（顺序不影响解析语义）
    if (r.strike) text = `~~${text}~~`;
    if (r.mark) text = `==${text}==`;
    if (r.sub) text = `~${text}~`;
    if (r.sup) text = `^${text}^`;
    if (r.italic) text = `*${text}*`;
    if (r.bold) text = `**${text}**`;
    if (r.href !== undefined && r.href) text = `[${text}](${r.href})`;
    out += text;
  }
  return out;
}

/** 行内容器的文本（列表项首行用：不带块级前缀） */
function itemFirstLine(item: ListItem | DefItem): string {
  if ("runs" in item) return runsToMarkdown(item.runs);
  return runsToMarkdown(item.term);
}

function renderListItems(
  items: ListItem[],
  marker: (idx: number) => string,
  indent: string,
  lines: string[],
): void {
  items.forEach((item, idx) => {
    const head = `${indent}${marker(idx)} ${itemFirstLine(item)}`.trimEnd();
    lines.push(head);
    if (item.children && item.children.length > 0) {
      renderListItems(item.children, marker, indent + "    ", lines);
    }
  });
}

function renderBlock(block: Block, lines: string[]): void {
  switch (block.kind) {
    case "heading":
      lines.push("#".repeat(block.level) + " " + runsToMarkdown(block.runs));
      break;
    case "paragraph":
      lines.push(runsToMarkdown(block.runs));
      break;
    case "bulletList":
      renderListItems(block.items, () => "-", "", lines);
      break;
    case "orderedList":
      renderListItems(
        block.items,
        (i) => `${(block.start || 1) + i}.`,
        "",
        lines,
      );
      break;
    case "taskList":
      renderTaskItems(block.items, "", lines);
      break;
    case "defList": {
      for (const item of block.items) {
        lines.push(runsToMarkdown(item.term));
        for (const d of item.descriptions) lines.push(": " + runsToMarkdown(d));
        if (item.blocks) {
          lines.push("");
          for (const b of item.blocks) {
            const sub: string[] = [];
            renderBlock(b, sub);
            for (const l of sub) lines.push(l ? "    " + l : "");
          }
        }
      }
      break;
    }
    case "codeBlock": {
      // content 通常以尾换行结束（markdown-it 的 fence.content 约定）。
      // 直接 split 会多出一个空行 → 围栏内凭空多一行空行。先剥净尾部换行。
      const body = block.content.replace(/\n+$/, "");
      lines.push("```" + (block.language || ""));
      if (body) lines.push(...body.split("\n"));
      lines.push("```");
      break;
    }
    case "table": {
      const header = block.header[0] || [];
      lines.push("| " + header.map((cell) => runsToMarkdown(cell).replace(/\|/g, "\\|")).join(" | ") + " |");
      const aligns = block.aligns || [];
      const n = Math.max(header.length, aligns.length);
      const sep: string[] = [];
      for (let i = 0; i < n; i++) {
        const a = aligns[i];
        sep.push(a === "left" ? ":--" : a === "center" ? ":-:" : a === "right" ? "--:" : "---");
      }
      lines.push("|" + sep.join("|") + "|");
      for (const row of block.rows) {
        lines.push("| " + row.map((cell) => runsToMarkdown(cell).replace(/\|/g, "\\|")).join(" | ") + " |");
      }
      break;
    }
    case "blockquote": {
      const sub: string[] = [];
      block.blocks.forEach((b, i) => {
        // 块间必须有一个 `>` 空行，否则引用内两个段落会被 lazy continuation
        // 粘成一段（v0.9.0 C4 已在 serializer 侧修过同一问题）。
        if (i > 0) sub.push("");
        renderBlock(b, sub);
      });
      for (const l of sub) lines.push(l ? "> " + l : ">");
      break;
    }
    case "hr":
      lines.push("---");
      break;
    case "toc":
      lines.push("[toc]");
      break;
    case "mathBlock":
      lines.push("$$", block.latex.replace(/\n$/, ""), "$$");
      break;
    default:
      break;
  }
}

function renderTaskItems(items: ListItem[], indent: string, lines: string[]): void {
  for (const item of items) {
    const box = item.checked ? "[x]" : "[ ]";
    lines.push(`${indent}- ${box} ${runsToMarkdown(item.runs)}`.trimEnd());
    if (item.children && item.children.length > 0) renderTaskItems(item.children, indent + "    ", lines);
  }
}

/** Block[] → Markdown（块间一个空行） */
export function blocksToMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) out.push("");
    const lines: string[] = [];
    renderBlock(b, lines);
    out.push(...lines);
  });
  if (out.length === 0) return "";
  const md = out.join("\n");
  return md.endsWith("\n") ? md : md + "\n";
}

/** 该 Block 是否承载了 td/th 包裹（合并格语法），供边界判定复用 */
export function blockHasTdWrapper(blocks: Block[]): boolean {
  let found = false;
  const scanRuns = (runs: InlineRun[]) => {
    for (const r of runs) if (/^<\/?(?:td|th)\b/i.test(stripTdWrapperText(r.text))) found = true;
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      switch (b.kind) {
        case "heading":
        case "paragraph":
          scanRuns(b.runs);
          break;
        case "bulletList":
        case "orderedList":
        case "taskList":
          for (const item of b.items) {
            scanRuns(item.runs);
            if (item.children) walk([{ kind: "bulletList", items: item.children }]);
          }
          break;
        case "table":
          for (const row of b.header) for (const cell of row) scanRuns(cell);
          for (const row of b.rows) for (const cell of row) scanRuns(cell);
          break;
        case "blockquote":
          walk(b.blocks);
          break;
        case "defList":
          for (const item of b.items) {
            scanRuns(item.term);
            for (const d of item.descriptions) scanRuns(d);
            if (item.blocks) walk(item.blocks);
          }
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return found;
}
