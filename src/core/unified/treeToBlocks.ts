/**
 * src/core/unified/treeToBlocks.ts —— `MdNode[]` → `exportBlocks.Block[]`（B3 出口切换）。
 *
 * ## 为什么这条出口最先切
 *
 * 设计稿 §3.3 B3 给三个出口（Blocks / HTML / spm）都定义了切换动作，但**Block[] 收益最直接**：
 *
 * 1. tree 的 `definition_description.children` 已是**完整块级树**（B1 已做），
 *    而 `exportBlocks.parseDefList` 的 `collectRuns` 把 dd 内容**拍平成 inline** ——
 *    fuzz 实测 dd 内代码块/表格/列表在 Block[] 里被粘成一行（`": def x"`），
 *    那是**内容损失**（P0 基线根因清单的 R1，Lead 已批准"必须 B 线修"）。
 *    切到 tree 后这个缺陷自然消失（`DefItem.blocks` 终于被真正填上）。
 * 2. `unknownTokens` 机制保留 —— 但现在是"tree 里没映射的 kind"，
 *    比"token 落 default 分支"更接近语义层（不会漏掉已解析但未映射的块）。
 *
 * ## 为什么仍保留旧实现做回退
 *
 * `parseMarkdownToBlocks` 有 20+ 个既有测试（g12-export-formats 等）断言具体结构。
 * 切换后若某形态行为有变，需要能快速对照。故 `treeToBlocks` 是**新增**，
 * `parseMarkdownToBlocksDetailed` 内部切换由调用点决定（见 exportBlocks 的改动）。
 */

import type { Block, DefItem, InlineRun, ListItem } from "../../utils/exportBlocks";
import type { InlineNode, MdNode } from "./model";

/** InlineNode[] → InlineRun[]（导出侧的扁平化形态） */
export function inlineNodesToRuns(nodes: InlineNode[]): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const n of nodes) {
    switch (n.kind) {
      case undefined:
      case "text": {
        // HTML 白名单标签/注释：Block[] 不承载 HTML，但**不能丢内容** ——
        // 标签本身丢弃（与 exportBlocks 的 parseInlineTokens 同口径），
        // 内容由后续 text 节点承载。注释整体丢弃（导出不该出现注释）。
        const trimmed = n.text.trim();
        if (/^<!--[\s\S]*-->$/.test(trimmed)) {
          // HTML 注释是**旁路标注**（`<!-- lightmd:table-size -->` 这类指令也走这里），
          // 不是可见内容 —— 导出侧必须丢弃（既有 `parseInlineTokens` 同口径，
          // v0.13.0 需求6 明确「HTML 注释不出现在任何导出格式里」）。
          //
          // ⚠️ 这是我试错后的最终口径。最初我"保留注释内容以免丢块"，
          // 结果注释文本被写进 Block[] 再重建 → 变成普通文本可见内容，
          // **凭空多出内容**（实测 170 篇 corrupt）。注释不该进内容层。
          //
          // 那"注释块消失导致块序列断档"（doc#209）怎么解决？
          // 在**重建侧**解决：blocksToMarkdown 不为空内容块预留位置，
          // 且比较基准也把注释块视为"非内容"—— 见 BE-10 边界登记。
          break;
        }
        if (/^<\/?(?:u|br|sub|sup|mark)\s*\/?>$/i.test(trimmed)) {
          // `<br>` 是换行载体 → 导出侧记为换行 run（保持段落内的换行语义）
          if (/^<br\s*\/?>$/i.test(trimmed)) runs.push({ text: "\n" });
          break;
        }
        if (!n.text) break;
        runs.push({
          text: n.text,
          bold: n.marks?.bold || undefined,
          italic: n.marks?.italic || undefined,
          strike: n.marks?.strike || undefined,
          code: n.marks?.code || undefined,
          mark: n.marks?.mark || undefined,
          sub: n.marks?.sub || undefined,
          sup: n.marks?.sup || undefined,
          href: n.marks?.href,
        });
        break;
      }
      case "softbreak":
        // 导出侧沿既有口径：软换行 → 空格（段落内换行在 DOCX/LaTeX 里是空格）
        runs.push({ text: " " });
        break;
      case "hardbreak":
        runs.push({ text: "\n" });
        break;
      case "image": {
        const raw = n.text;
        const alt = raw.replace(/\\\|/g, "|");
        runs.push({
          text: alt ? `[图片: ${alt}]` : "[图片]",
          imageSrc: n.payload || undefined,
        });
        break;
      }
      case "mathInline":
        runs.push({ text: n.payload || n.text, math: n.payload || n.text });
        break;
      default:
        if (n.text) runs.push({ text: n.text });
        break;
    }
  }
  // 过滤空 run（保留带 imageSrc / math 的）
  return runs.filter((r) => r.text.length > 0 || r.imageSrc !== undefined);
}

/** 取块的首个段落 inline（列表项首行 / dd 首段用） */
function firstParagraphInline(children: MdNode[] | undefined): InlineRun[] {
  if (!children) return [];
  for (const c of children) {
    if (c.kind === "paragraph") return inlineNodesToRuns(c.inline || []);
  }
  return [];
}

/** 列表项：首段 runs + 嵌套列表 children */
function nodeToListItem(item: MdNode): ListItem {
  const runs = firstParagraphInline(item.children);
  // 嵌套子列表（只取列表类子块；其它子块（表格/代码）在 ListItem 里无处安放，
  // 且既有 exportBlocks 同样只承载嵌套列表 —— 与旧口径一致）
  // 嵌套子列表：**保留类型**（否则有序列表会降级成无序 —— 实测 doc#10/#56/#85 等 6 篇失真）
  const nested: ListItem[] = [];
  let nestedList: ListItem["nestedList"];
  for (const child of item.children || []) {
    if (child.kind === "bulletList" || child.kind === "orderedList" || child.kind === "taskList") {
      if (!nestedList) {
        nestedList =
          child.kind === "orderedList"
            ? { kind: "orderedList", start: Number(child.attrs.order ?? 1) || 1 }
            : { kind: child.kind };
      }
      for (const it of child.children || []) nested.push(nodeToListItem(it));
    }
  }
  const checked = item.attrs.checked;
  return {
    runs,
    children: nested.length > 0 ? nested : undefined,
    checked: typeof checked === "boolean" ? checked : undefined,
    nestedList,
  };
}

/** 定义列表项：term + 多个 dd（dd 内块填进 `blocks`，修掉 BE-03 内容粘合） */
function nodeToDefItems(list: MdNode): DefItem[] {
  const items: DefItem[] = [];
  const children = list.children || [];
  let i = 0;
  while (i < children.length) {
    const t = children[i]!;
    if (t.kind !== "definition_term") {
      i++;
      continue;
    }
    const descriptions: InlineRun[][] = [];
    const blocks: Block[] = [];
    i++;
    while (i < children.length && children[i]!.kind === "definition_description") {
      const dd = children[i]!;
      // 第一段作为 description（与既有 exportBlocks 的 CollectRuns 口径一致）
      descriptions.push(firstParagraphInline(dd.children));
      // **新增能力**：dd 内除首段外的块级内容进 blocks（此前被拍平丢弃）
      for (const c of dd.children || []) {
        if (c.kind === "paragraph") continue; // 首段已进 descriptions
        const b = nodeToBlock(c);
        if (b) blocks.push(b);
      }
      i++;
    }
    items.push({
      term: inlineNodesToRuns(t.inline || []),
      descriptions,
      blocks: blocks.length > 0 ? blocks : undefined,
    });
  }
  return items;
}

/** 单个 MdNode → Block（不含容器递归外的特判） */
export function nodeToBlock(node: MdNode): Block | null {
  switch (node.kind) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6;
      return { kind: "heading", level, runs: inlineNodesToRuns(node.inline || []) };
    }
    case "paragraph": {
      const runs = inlineNodesToRuns(node.inline || []);
      if (runs.length > 0) return { kind: "paragraph", runs };
      // ⚠️ **纯注释段落**（`<!-- x -->` 单独成块）在这里会变成空 runs。
      // 若直接返回空 paragraph，`blocksToMarkdown` 会把它当"用户空行"过滤掉 →
      // 该块的位置消失 → 相邻块合并、kinds 少一个 paragraph
      // （实测 doc#209/#378：paragraph 少一个、definition_list 被并成一个）。
      //
      // 注释本身不进内容层（导出不该出现注释），但它**占位一个块**是真实的：
      // 用零宽空格占位，保证块序列不塌陷，且渲染/导出时不可见。
      const hasOnlyComment = (node.inline || []).some((n) => /^<!--/.test(n.text.trim()));
      if (hasOnlyComment) return { kind: "paragraph", runs: [{ text: "\u200B" }] };
      return { kind: "paragraph", runs };
    }
    case "codeBlock": {
      const content = (node.inline || []).map((n) => n.text).join("");
      return {
        kind: "codeBlock",
        content,
        language: String(node.attrs.language || "").split(/\s+/)[0] || "",
      };
    }
    case "mathBlock":
      return { kind: "mathBlock", latex: String(node.attrs.latex || "") };
    case "hr":
      return { kind: "hr" };
    case "toc": {
      const headings = node.attrs.headings;
      return {
        kind: "toc",
        headings: Array.isArray(headings)
          ? (headings as Array<{ level: number; text: string; id: string }>)
          : [],
      };
    }
    case "bulletList":
      return { kind: "bulletList", items: (node.children || []).map(nodeToListItem) };
    case "orderedList":
      return {
        kind: "orderedList",
        items: (node.children || []).map(nodeToListItem),
        start: Number(node.attrs.order ?? 1) || 1,
        // 保真四项 §6.4：`1)` 与 `1.` 的分隔符必须透传，否则往返会归一化
        delim: node.attrs.delim === ")" ? ")" : ".",
      };
    case "taskList":
      return { kind: "taskList", items: (node.children || []).map(nodeToListItem) };
    case "defList":
      return { kind: "defList", items: nodeToDefItems(node) };
    case "table": {
      const rows = (node.attrs.rows as Array<Array<{ inline: InlineNode[]; header: boolean }>>) || [];
      const aligns = (node.attrs.aligns as Array<"left" | "center" | "right" | null>) || [];
      const headerRows = rows.filter((r) => r[0]?.header);
      const bodyRows = rows.filter((r) => !r[0]?.header);
      return {
        kind: "table",
        header: headerRows.map((r) => r.map((c) => inlineNodesToRuns(c.inline || []))),
        rows: bodyRows.map((r) => r.map((c) => inlineNodesToRuns(c.inline || []))),
        aligns: aligns.map((a) => a ?? null),
      };
    }
    case "blockquote": {
      const blocks: Block[] = [];
      for (const c of node.children || []) {
        const b = nodeToBlock(c);
        if (b) blocks.push(b);
      }
      return { kind: "blockquote", blocks };
    }
    case "footnote": {
      // 脚注定义：Block[] 不承载脚注语义（既有 STRUCTURAL_TOKENS 口径也是"不建 Block"），
      // 但**正文不能丢** —— 用它们的子块（段落）保持内容可见（与旧实现摊平行为一致）
      return null; // 由调用方决定是否展开子块
    }
    case "listItem":
    case "definition_term":
    case "definition_description":
      // 容器内部节点：不应作为顶层 Block 出现
      return null;
    default:
      return null;
  }
}

export interface TreeToBlocksResult {
  blocks: Block[];
  /** tree 里未能映射的 kind（去重） */
  unknownKinds: string[];
}

/**
 * `MdNode[]` → `Block[]`。
 *
 * 脚注节点特殊处理：其子块（段落等）**展开到顶层**（保持"内容不丢"的既有行为，
 * 同时结构上不再假装有 footnote 容器）。
 */
export function treeToBlocks(tree: MdNode[]): TreeToBlocksResult {
  const blocks: Block[] = [];
  const unknownKinds = new Set<string>();

  for (const node of tree) {
    if (node.kind === "footnote") {
      // 展开脚注定义的子块（内容不丢；与旧实现"摊平成段落"行为等价但更干净）
      for (const c of node.children || []) {
        const b = nodeToBlock(c);
        if (b) blocks.push(b);
        else if (c.kind !== "paragraph") unknownKinds.add(c.kind);
      }
      continue;
    }
    const b = nodeToBlock(node);
    if (b) blocks.push(b);
    else unknownKinds.add(node.kind);
  }

  return { blocks, unknownKinds: [...unknownKinds] };
}
