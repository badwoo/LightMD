/**
 * ProseMirror 文档 → Markdown 字符串序列化器
 */
import type { Node, Mark } from "prosemirror-model";
import { getBlockSource, type BlockSourceInfo } from "./blockSourceMap";
// v0.13.0 需求12：表格合并/拆分（逻辑列网格）
import { buildTableGridFromTable, gridColumnCount, tableHasSpan, type TableGrid } from "../tableGrid";

/**
 * v0.13.0 需求1：把**单个块节点**序列化为 Markdown（块级复制/剪切用）。
 *
 * v0.13.0 返修第三轮（问题4）：**不再包临时 doc 走 `docToMarkdown`**。
 *
 * 缺陷背景（用户报告「复制某个块再粘贴会把整个文档都粘贴了」）：
 * 旧实现把该块包进一个临时 doc 再调 `docToMarkdown`，而后者的 **B6 快路径**
 * 判定是 `typed[0].start === 0`（首个块从源码第 0 行开始且全部块都有原文记录）
 * → 对「只含一个块的临时 doc」来说，只要该块在原文里从第 0 行开始（**文档首块**，
 * 或任何被 `start === 0` 命中的块）就整篇命中快路径，直接返回
 * `typed[0].source` —— 也就是**整份源文档**，而不是那一个块。
 * 实测：对 `"AAA\n\nBBB\n"` 复制首段得到 `"AAA\n\nBBB\n"`（整篇）。
 * 粘贴时 `replaceWith(insertPos, insertPos, doc.content)` 会把载荷里的**每个块**
 * 都插入 → 用户看到「粘贴把整篇文档都粘进来了」。
 *
 * 现改为：命中 B6 原文记录时**只切该块自己的行区间**（不含块后空行）；
 * 未命中（编辑过/程序化构造）时走单块规范序列化。
 *
 * @param node 顶层块节点（code_block / table / paragraph / …）
 * @returns 该块的 Markdown 源码（含尾部换行）
 */
export function nodeToMarkdown(node: Node): string {
  if (!node) return "";
  const info = getBlockSource(node);
  if (info) {
    // B6：该块在原文里的行区间 [start, end)。end 已被 parser 收缩到内容结束行
    // （列表类会掉块后空行），故这里**不要**再补到文档尾——只要这一个块。
    const lines = info.source.split("\n");
    const start = Math.max(0, Math.min(info.start, lines.length));
    const end = Math.max(start + 1, Math.min(info.end, lines.length));
    return lines.slice(start, end).join("\n") + "\n";
  }
  const md = blockToMarkdown(node, true);
  if (md === null) return "";
  return md.endsWith("\n") ? md : md + "\n";
}

/**
 * 将 ProseMirror 文档序列化为 Markdown 字符串
 *
 * v0.6.6 问题1：空段落（空行）往返一致性
 * - 空段落序列化为单个空行（"\n"）；空段之后紧跟的块不再追加间隔换行
 *   （否则每个空段膨胀为 2 个空行，md→doc→md 往返不收敛）
 * - 去掉原 trimEnd()：它会把用户显式输入的尾部空行（空段落）全部剪掉，
 *   导致切换页签/重开后换行丢失；现在仅保证恰好以单个换行结尾
 *
 * v0.9.0 B6：块级原文保留
 * - 快路径：全部顶层块携带解析期记录的原文行号（= doc 未被编辑）→
 *   逐字节返回源文本，未编辑文档保存零 diff
 * - 逐块路径：命中的块输出原文切片（含原尾随空行），未命中的块（编辑过/
 *   程序化构造）走规范序列化，块间按规范规则补空行
 * - v0.9.0 D2：删除「表格前不加块间空行」特判——列表块后的 "|" 行会被
 *   lazy continuation 吸进列表项导致表格丢失，统一走块间空行逻辑
 */
export function docToMarkdown(doc: Node): string {
  const blocks: Node[] = [];
  doc.forEach((node) => blocks.push(node));

  // ── B6 快路径：全部块命中且行号连续覆盖 → 原文逐字节返回 ──
  if (blocks.length > 0) {
    const infos = blocks.map(getBlockSource);
    if (infos.every(Boolean)) {
      const typed = infos as BlockSourceInfo[];
      let ok = typed[0].start === 0;
      for (let i = 1; ok && i < typed.length; i++) {
        if (typed[i].start <= typed[i - 1].start) ok = false;
      }
      if (ok) return typed[0].source;
    }
  }

  // ── 逐块路径 ──
  // v0.7.0 修复5：识别末尾连续空段落（仅 miss 的空段；hit 的尾段走原文切片）
  let trailing = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!getBlockSource(b) && b.type.name === "paragraph" && b.content.size === 0) trailing++;
    else break;
  }
  const bodyCount = blocks.length - trailing;

  const parts: string[] = [];
  let prevWasMiss = false;
  let srcLines: string[] | null = null;
  let srcRef: string | null = null;
  const countLines = (s: string) => {
    const l = s.split("\n");
    return s.endsWith("\n") ? l.length - 1 : l.length;
  };

  blocks.forEach((node, index) => {
    const info = getBlockSource(node);
    if (info) {
      // 命中：输出原文行区间切片（含块间原有空行），不加规范间隔
      let end = info.end;
      const nextInfo = index + 1 < blocks.length ? getBlockSource(blocks[index + 1]) : undefined;
      if (nextInfo && nextInfo.start > end) end = nextInfo.start;
      if (index === blocks.length - 1) end = countLines(info.source);
      if (srcRef !== info.source) {
        srcRef = info.source;
        srcLines = info.source.split("\n");
      }
      const slice = (srcLines as string[]).slice(info.start, end).join("\n") + "\n";
      // 前一块是重新序列化的块：规范补一个空行分隔（原间隔未知，取规范形式）
      if (prevWasMiss && parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last !== "\n" && !last.endsWith("\n\n")) parts.push("\n");
      }
      parts.push(slice);
      prevWasMiss = false;
      return;
    }

    const md = blockToMarkdown(node, true);
    if (md !== null) {
      // 在块之间添加空行（v0.9.0 D2：表格不再豁免——列表后的表格必须有空行隔开）
      if (index < bodyCount && parts.length > 0) {
        const last = parts[parts.length - 1];
        // 上一块为空段落（"\n"）时其自身已构成空行，无需再加间隔
        if (last !== "\n" && !last.endsWith("\n\n")) {
          parts.push("\n");
        }
      }
      parts.push(md);
    }
    prevWasMiss = true;
  });
  let out = parts.join("");
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

// ─── 块级序列化 ──────────────────────────────────────────

function blockToMarkdown(node: Node, topLevel = false): string | null {
  switch (node.type.name) {
    case "paragraph": {
      // v0.12.3（二轮反馈）：顶层段落的段末硬换行写成 `"  \n"`（源码无 <br>）后，**不再追加段落
      // 终止换行** —— 否则 `"A  \n"` + `"\n"` = `"A  \n\n"` 会被解析成两个段落
      // （中间那个空行构成段落边界，实测往返后 doc 多出一个空段落）。
      const body = inlineToMarkdown(node, topLevel ? "top" : undefined);
      return body.endsWith("\n") ? body : body + "\n";
    }
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
    case "footnote_definition":
      return footnoteDefinitionToMarkdown(node);
    case "definition_list":
      return definitionListToMarkdown(node);
    case "toc":
      // 目录节点序列化回 [toc] 标记
      return "[toc]\n";
    default:
      return null;
  }
}

// ─── 脚注定义 ──────────────────────────────────────────

/**
 * E15：脚注定义内容模型为 block+，多段落/块级内容输出为 4 空格缩进续行
 * （段落前空行），markdown-it-footnote 解析端认可该形式，往返分段保持。
 */
function footnoteDefinitionToMarkdown(node: Node): string {
  const label = node.attrs.label || "";
  const lines: string[] = [];
  let headerDone = false;
  node.forEach((child) => {
    const childMd = blockToMarkdown(child);
    if (!childMd) return;
    if (!headerDone && child.type.name === "paragraph") {
      // 首段与 [^label]: 同行（内容可能为空 → "[^label]: " 空脚注形式）
      lines.push(`[^${label}]: ${inlineToMarkdown(child)}`);
      headerDone = true;
    } else {
      if (!headerDone) {
        // 首块非段落：先输出定义头行，内容走缩进续行
        lines.push(`[^${label}]:`);
        headerDone = true;
      } else if (child.type.name === "paragraph") {
        // 后续段落前插空行，避免缩进续行被当作同段软换行
        lines.push("");
      }
      const trimmed = childMd.trimEnd();
      trimmed.split("\n").forEach((line) => {
        lines.push(line ? `    ${line}` : "");
      });
    }
  });
  // 空脚注占位：[^label]: 单独成行
  if (lines.length === 0) return `[^${label}]:\n`;
  return lines.join("\n") + "\n";
}

// ─── 定义列表 ──────────────────────────────────────────

function definitionListToMarkdown(node: Node): string {
  const lines: string[] = [];
  node.forEach((child) => {
    if (child.type.name === "definition_term") {
      lines.push(inlineToMarkdown(child));
    } else if (child.type.name === "definition_description") {
      lines.push(`: ${inlineToMarkdown(child)}`);
    }
  });
  return lines.join("\n") + "\n";
}

// ─── 标题 ────────────────────────────────────────────────

function headingToMarkdown(node: Node): string {
  const level = node.attrs.level;
  const prefix = "#".repeat(level);
  const content = inlineToMarkdown(node);
  return `${prefix} ${content}\n`;
}

// ─── 引用块 ──────────────────────────────────────────────

/**
 * v0.9.0 C4：引用内空行不再丢弃。
 * 旧实现 filter(Boolean) 把引用内段落间空行吞掉，多段落往返后被合并成一段。
 * 现在：段落间输出 ">" 空行，行内空行输出 ">"（CommonMark 引用内空行形式）。
 */
function blockquoteToMarkdown(node: Node): string {
  const childBlocks: string[] = [];
  node.forEach((child) => {
    const childMd = blockToMarkdown(child);
    if (childMd) childBlocks.push(childMd.replace(/\n$/, ""));
  });
  if (childBlocks.length === 0) return ">\n";
  const lines: string[] = [];
  childBlocks.forEach((childMd, idx) => {
    if (idx > 0) lines.push(">");
    childMd.split("\n").forEach((line) => {
      lines.push(line ? "> " + line : ">");
    });
  });
  return lines.join("\n") + "\n";
}

// ─── 代码块 ──────────────────────────────────────────────

/** v0.9.0 D8：仅剥「整体占位」的零宽空格（parser 对空代码内容的占位），不碰真实内容 */
function stripZwsp(text: string): string {
  return text === "\u200B" ? "" : text;
}

/**
 * v0.9.0 C2：块级围栏长度按内容动态选择（CommonMark）。
 * 围栏长 = max(3, 最长反引号连续段+1, 行首反引号连续段+1)，
 * 保证内容中的反引号串不会被误认为围栏开/闭标记。
 */
function fenceBlock(content: string, info: string): string {
  let maxRun = 0;
  let run = 0;
  for (const ch of content) {
    if (ch === "`") {
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  let fenceLen = Math.max(3, maxRun + 1);
  for (const line of content.split("\n")) {
    let r = 0;
    while (line[r] === "`") r++;
    if (r >= fenceLen) fenceLen = r + 1;
  }
  const f = "`".repeat(fenceLen);
  // 空内容时省略内容行（避免多出空行，"```\n```" 往返保真）
  return f + info + "\n" + (content ? content + "\n" : "") + f + "\n";
}

function codeBlockToMarkdown(node: Node): string {
  // v0.9.0 D11：info 保留完整信息串（如 "js {highlight}"），language 仍取首词
  const info = node.attrs.info || node.attrs.language || "";
  return fenceBlock(stripZwsp(node.textContent), info);
}

// ─── Mermaid 图表块 ──────────────────────────────────────

function mermaidBlockToMarkdown(node: Node): string {
  const info = node.attrs.info || "mermaid";
  return fenceBlock(stripZwsp(node.textContent), info);
}

// ─── 块级数学公式 ──────────────────────────────────────

function mathBlockToMarkdown(node: Node): string {
  const content = stripZwsp(node.textContent || node.attrs.latex || "");
  // 空内容时省略内容行（避免多出空行，"$$\n$$" 往返保真）
  return "$$\n" + (content ? content + "\n" : "") + "$$\n";
}

// ─── 列表 ────────────────────────────────────────────────

function listToMarkdown(
  node: Node,
  marker: string
): string {
  const lines: string[] = [];
  // v0.9.0 D4：有序列表起始号从 attrs.order 取（parser 已读 markdown-it 的 start）
  // v0.11.0 B3-6：编号分隔符从 attrs.delim 取（`1)` / `1.`），
  // 修复「能解析 `1)` 但编辑后被改写成 `1.`」的不对称
  const isOrdered = marker === "1." || marker === "1)";
  const delim = node.attrs?.delim === ")" ? ")" : ".";
  let idx = isOrdered ? (node.attrs.order || 1) : 1;

  node.forEach((listItem) => {
    // 对于有序列表，使用递增数字
    const prefix = isOrdered ? `${idx}${delim}` : marker;

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
        // v0.8.0 修复 P11-6：后续**段落**前必须先插入空行，否则 markdown-it 会把
        // 缩进续行当作同一段落的软换行 → 多段落降级成"单段落 + hard_break"
        // （模式切换回来后段落结构丢失）。嵌套列表等块级节点不需要空行。
        if (child.type.name === "paragraph") lines.push("");
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

  // E15：任务项内非首段内容不再压平进首行——嵌套普通列表/段落/代码块等
  // 输出为 4 空格缩进续行（段落前空行，与 listToMarkdown 的 P11-6 规则一致），
  // task-list-plugin 解析端会收集缩进续行做子文档解析，往返无损。
  // 递归序列化任务列表，支持任意层级嵌套
  const serializeItems = (taskListNode: Node, indent: string) => {
    taskListNode.forEach((taskItem) => {
      const checked = taskItem.attrs.checked ? "x" : " ";
      // v0.12.1 需求5：列表符号即样式（`-` 方形 / `*` 圆形），往返由
      // task-list-plugin 的 taskStyleFromBullet 逆向还原
      const bullet = taskItem.attrs.style === "circle" ? "*" : "-";
      let isFirstChild = true;
      taskItem.forEach((child) => {
        if (isFirstChild && child.type.name === "paragraph") {
          const content = inlineToMarkdown(child);
          lines.push(`${indent}${bullet} [${checked}] ${content}`);
          isFirstChild = false;
        } else if (child.type.name === "task_list") {
          // 嵌套任务列表：递归序列化，增加 2 空格缩进
          serializeItems(child, indent + "  ");
          isFirstChild = false;
        } else {
          // E15：其余块级内容输出 2 空格缩进续行(与嵌套任务列表的缩进一致,
          // 保证「与子任务平级的普通列表」解析时按缩进树正确归属父任务项;
          // CommonMark 中列表项内容列即 marker 宽度,2 空格为合法嵌套缩进)
          const childMd = blockToMarkdown(child);
          if (childMd) {
            // 后续**段落**前插入空行，否则子文档解析会把缩进续行当作同段软换行
            if (child.type.name === "paragraph") lines.push("");
            const trimmed = childMd.trimEnd();
            trimmed.split("\n").forEach((line) => {
              lines.push(line ? `${indent}  ${line}` : "");
            });
          }
          isFirstChild = false;
        }
      });
    });
  };

  serializeItems(node, "");
  return lines.join("\n") + "\n";
}

// ─── 表格 ────────────────────────────────────────────────

/**
 * v0.13.0 需求12：表格序列化 —— **逻辑列网格**模型。
 *
 * ─── 为什么重写 ───
 * 原实现假设「每行等长」（colCount = rows[0].length），合并单元格后
 * （`| <td colspan="2">A</td> | B |`）该假设立刻失效：
 *   · 行长度不等 → 短行被 `while (cells.length < colCount)` 补空串，
 *     合并格与后续格的**列对应关系错位**；
 *   · 更糟的是补空串会凭空造出列，重开文档后表格列数变化。
 *
 * ─── 双管道（回归锁）──
 * ① 纯管道表格（无任何 colspan/rowspan）→ **走原算法逐字输出**，
 *    `md → doc → md` 零 diff（v0.11.0 回归锁的最高优先级）；
 * ② 含合并的表格 → 逻辑列网格：展开为 grid[row][col]，跨格按
 *    `<td colspan rowspan>` 输出，被占位的空洞不输出，
 *    分隔行**始终按逻辑列数**输出（合并不影响列数）。
 *
 * 合并形态与 `parser.extractTdWrapper` 同源（v1 决策 B/3：
 * HTML `<td colspan>` + 声明不跨编辑器保真）。
 */
function tableToMarkdown(node: Node): string {
  const hasSpan = tableHasSpan(node);
  if (!hasSpan) return tableToMarkdownPlain(node);
  return tableToMarkdownMerged(node);
}

/** 原实现（纯管道表格零 diff 路径）——v0.13.0 需求12 起更名保留 */
function tableToMarkdownPlain(node: Node): string {
  const rows: string[][] = [];
  const aligns: string[] = [];

  // v0.11.0 B1-2（P0 防线②）：记录是否存在真正的 table_head。
  // schema 的 table content 是 `table_head? table_body`（head 可选），因此当
  // table_head 缺失时（历史上 deleteRow 删整个 thead 会造成此状态，v0.11.0 已
  // 在 editor 侧拒绝该操作）**不得**把 tbody 首行当表头输出——那会让数据行被
  // 伪装成表头、原表头内容静默丢失。此处是数据安全的最后一道闸：即使未来新增
  // 某条路径删除了 table_head，输出也只是"缺表头"而非"丢数据 + 数据伪装表头"。
  let hasHead = false;

  // 收集所有行
  node.forEach((section) => {
    if (section.type.name === "table_head") hasHead = true;
    section.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell, _offset, colIdx) => {
        cells.push(inlineToMarkdown(cell, "table").trim());
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

  // v0.11.0 B1-2：表头行。
  // 正常情况 hasHead 为 true，rows[0] 即表头行。
  // 无 table_head 时（防御分支）：补一行空表头，rows 全部作为数据行输出，
  // 绝不把首行数据当表头（那会造成「原表头丢失 + 数据被伪装成表头」的双重损坏）。
  if (hasHead) {
    result.push("| " + rows[0].map((c) => c || " ").join(" | ") + " |");
  } else {
    result.push("| " + new Array(colCount).fill(" ").join(" | ") + " |");
  }

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

  // 数据行（无表头时从第 0 行开始；有表头时跳过已被当作表头的 rows[0]）
  for (let r = hasHead ? 1 : 0; r < rows.length; r++) {
    const cells = rows[r];
    while (cells.length < colCount) cells.push("");
    result.push("| " + cells.map((c) => c || " ").join(" | ") + " |");
  }

  return result.join("\n") + "\n";
}

/**
 * v0.13.0 需求12：含合并单元格的表格序列化（逻辑列网格管道）。
 *
 * 输出规则：
 * - 分隔行**始终按逻辑列数**输出（合并不改变列数）；
 * - 跨格输出 `<td colspan="N" [rowspan="M"]>inner</td>`（表头跨格用 `<th>`）；
 * - 被 rowspan/colspan 占位的**空洞不输出**（行内 cell 数因此可变，
 *   由 parser 的网格展开还原）；
 * - 普通格与纯管道表格的输出形态完全一致（`| A | B |`）。
 *
 * 对齐：按**逻辑列**取表头行该列的对齐值；表头行因合并而少于逻辑列数时，
 * 未覆盖的列回落 "left"（与纯管道表格的补齐行为一致）。
 */
function tableToMarkdownMerged(node: Node): string {
  // 收集全部行（文档顺序）+ 每行的 isHead 标记（网格本身由
  // buildTableGridFromTable 统一构建，保证与合并/拆分事务同口径）
  const rowCount: number[] = [];
  const headFlags: boolean[] = [];
  let hasHead = false;
  node.forEach((section) => {
    const isHead = section.type.name === "table_head";
    if (isHead) hasHead = true;
    section.forEach(() => {
      rowCount.push(1);
      headFlags.push(isHead);
    });
  });

  if (rowCount.length === 0) return "";

  const grid = buildTableGridFromTable(node, 0);
  // 列数取**网格宽度**（最长行）而不是表头物理格数：
  // 表头被合并后它的物理格数会变少（`| <th colspan="2">A</th> | C |` 只有 2 格），
  // 但 markdown-it 要求表头行的物理格数与分隔行**相等**（见下方补位注释），
  // 且数据行仍各有 3 格 —— 若按表头格数输出，数据行的第 3 格会被 markdown-it
  // 按 columnCount 截断而**丢内容**（实测 textContent 由 AC123 变 AC12）。
  const colCount = Math.max(gridColumnCount(grid), 1);

  // 表头行的每列对齐（按逻辑列索引；合并格的对齐取其起始列的值）
  const aligns: string[] = new Array(colCount).fill("left");
  if (hasHead) {
    const headRow = grid[0] ?? [];
    for (let c = 0; c < colCount; c++) {
      const cell = headRow[c];
      if (cell) aligns[c] = (cell.node.attrs.align as string) || "left";
    }
  }

  const result: string[] = [];

  // 表头行（无 table_head 时补一行空表头——与纯管道管道的 B1-2 防线一致）
  //
  // v0.13.0 返修（问题12 BLOCKER）：表头行必须补足到与分隔行**相同的物理单元格数**。
  //
  // 缺陷背景：`serializeGridRow` 会跳过被 colspan/rowspan 占位的空洞，而分隔行按
  // **逻辑列数** `colCount` 生成。markdown-it 的表格规则硬性要求
  // `columnCount === aligns.length`（见 markdown-it/lib/rules_block/table.mjs），
  // 于是「表头含合并格」时表头物理格数 < 逻辑列数 → **整张表不再是表格**，
  // 回读变成一个段落，所有行与单元格内容一次性丢失。
  // 实测旧输出：`| <th colspan="2">A</th> | C |` + 3 列分隔行 → 重新解析得到
  // paragraph（childCount=1），内容整体变成字面 Markdown。
  //
  // 补位用空串（与纯管道空单元格一致）；行尾的空单元格会被
  // `trimRowTrailingEmpties` 在网格构建时裁掉，故不会让列数逐次膨胀（往返稳定）。
  // 无合并的普通表格本就行数相等 → 不触发补位，纯管道零 diff 回归锁不受影响。
  if (hasHead) {
    const headCells = serializeGridRow(grid[0] ?? [], true);
    while (headCells.length < colCount) headCells.push(" ");
    result.push("| " + headCells.join(" | ") + " |");
  } else {
    result.push("| " + new Array(colCount).fill(" ").join(" | ") + " |");
  }

  // 分隔行：逻辑列数
  const sep = aligns.map((a) => {
    switch (a) {
      case "center": return ":---:";
      case "right": return "---:";
      default: return "---";
    }
  });
  while (sep.length < colCount) sep.push("---");
  result.push("| " + sep.join(" | ") + " |");

  // 数据行
  for (let r = hasHead ? 1 : 0; r < grid.length; r++) {
    result.push("| " + serializeGridRow(grid[r] ?? [], headFlags[r] === true).join(" | ") + " |");
  }

  return result.join("\n") + "\n";
}

/**
 * 把网格中的一行序列化为单元格文本数组（跳过被占位的空洞）。
 *
 * 空单元格输出 " "（与纯管道管道的 `c || " "` 一致，保证 `| A |  | B |`
 * 的管道形态稳定；markdown-it 对空 cell 的解析与原路径同源）。
 */
function serializeGridRow(gridRow: TableGrid[number], isHead: boolean): string[] {
  const out: string[] = [];
  for (const cell of gridRow) {
    if (!cell) continue; // 被 rowspan/colspan 占位的空洞
    const inner = inlineToMarkdown(cell.node, "table").trim();
    const isSpan = cell.colspan > 1 || cell.rowspan > 1;
    if (!isSpan) {
      out.push(inner || " ");
      continue;
    }
    const tag = cell.node.type.name === "table_header" || isHead ? "th" : "td";
    const attrs: string[] = [];
    if (cell.colspan > 1) attrs.push(`colspan="${cell.colspan}"`);
    if (cell.rowspan > 1) attrs.push(`rowspan="${cell.rowspan}"`);
    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    out.push(`<${tag}${attrStr}>${inner || " "}</${tag}>`);
  }
  return out;
}

// ─── Inline 序列化 ───────────────────────────────────────

/**
 * v0.9.0 B2/B3/B4：mark 包裹显式优先级。
 * PM 的 marks 是扁平集合，其数组顺序不代表嵌套包含关系。CommonMark 规定
 * code span 内是字面文本（不能含其他强调），因此 code 恒为最内层；link
 * 承载 URL 语义放最外层。按此优先级排序后再包裹，嵌套关系不再颠倒。
 */
const MARK_OUTER_ORDER: Record<string, number> = {
  link: 0,
  strong: 1,
  em: 2,
  strike: 3,
  // E8(v0.9.3):下划线无 Markdown 原生语法,以 <u> 包裹,层级紧邻 strike
  underline: 4,
  mark: 5,
  subscript: 6,
  superscript: 7,
  code: 99,
};

function inlineToMarkdown(node: Node, context?: "table" | "top"): string {
  const parts: string[] = [];
  const childCount = node.childCount;

  // v0.11.0 B3-4：`~`/`^` 的转义判定需要**整段行内文本**作为上下文——
  // 标记可能被 mark 拆散到多个文本节点，但回读时仍能跨节点配对。
  let pairContext = "";
  node.forEach((c) => {
    if (c.isText) pairContext += c.text || "";
    else if (c.type.name === "image") pairContext += (c.attrs.alt as string) || "";
    else pairContext += c.textContent;
  });

  node.forEach((child, _offset, index) => {
    if (child.type.name === "text") {
      let text = child.text || "";

      const marks = child.marks;
      // v0.9.0 C1：非 code 文本走转义层（code 内容是字面文本不转义；
      // 表格上下文的管道转义见 applyMark/code 与 escapeText 的 inTableCell）
      const hasCode = marks.some((m) => m.type.name === "code");
      // v0.13.0 返修：注释体不得走 markdown 转义。
      //
      // 缺陷背景：注释体在 HTML 注释里，markdown-it **不会**解释其中的 markdown，
      // 因此转义毫无意义；而读取端只是原样取注释内文（不做反转义），
      // 于是 `<!--a\*\*b-->` 回读后文本变成 `a\*\*b`（反斜杠永久残留、内容被改写）。
      // 实测受影响：`*`、`` ` ``、`$` 等一切会被 escapeText 转义的字符。
      const hasComment = marks.some((m) => m.type.name === "comment");
      if (!hasCode && !hasComment) text = escapeText(text, context === "table", pairContext);

      // 从外到内按优先级应用标记（B2/B3/B4 修复）
      const ordered = [...marks].sort(
        (a, b) =>
          (MARK_OUTER_ORDER[a.type.name] ?? 50) - (MARK_OUTER_ORDER[b.type.name] ?? 50)
      );
      for (const m of ordered) {
        text = applyMark(text, m, context === "table");
      }

      parts.push(text);
    } else if (child.type.name === "image") {
      const { src, alt, title, width, align } = child.attrs;
      const titlePart = title ? ` "${escapeTitle(title)}"` : "";
      // E11a(v0.9.3):宽度以 Typora 风格 |W 后缀表达;无宽度保持旧语法兼容旧文档
      const widthPart = typeof width === "number" && width > 0 ? `|${width}` : "";
      // v0.13.0 需求4：对齐沿用**同一套 `|` 后缀约定** → `![alt|300|center](src)`。
      // 为什么不用 `<img style>`：编辑管线的行内 HTML 白名单只放行 u/br/sub/sup/mark，
      // `<img>` 会被整段剥掉（实测 doc 里只剩空段落）→ **图片直接丢失**。
      // `|` 后缀由 parser 同源解析，往返稳定；未设对齐时不追加，文档零 diff。
      const alignPart = align && align !== "left" ? `|${align}` : "";
      // v0.9.0 C3：目标地址含空格/括号/尖括号时用 <...> 包裹
      //
      // v0.13.0 返修：**alt 里的竖线必须转义**。
      // 宽度/对齐沿用 `|` 后缀（`![alt|300|center](src)`），而 alt 自身也可能含 `|`
      // （如「表格 | 图」）。不转义时回读会把 alt 里的段误当后缀：
      //   alt="a|b" + width=300 → `![a|b|300](x)` → 回读 alt="a|b|300"、宽度丢失；
      //   alt="a|1"（无宽度）   → `![a|1](x)`     → 回读 alt="a"、**凭空多出宽度 1**。
      // 读端按「未转义的竖线」切分并把 `\|` 还原为 `|`（见 parser 的 image 分支），
      // 故这是一次**无损**往返。
      const altEscaped = escapeText(alt || "").replace(/\|/g, "\\|");
      parts.push(
        `![${altEscaped}${widthPart}${alignPart}](${escapeDest(src)}${titlePart})`,
      );
    } else if (child.type.name === "hard_break") {
      // v0.12.3 需求12：回车 = 换行后，"段内换行"成为高频形态，补齐三类
      // **用 "  \n" 无法表达**的边界（实测：只有 <br> 能原样往返）：
      //   · 段首：行首两空格会被当作空行（实测 `"  \nA"` 直接拆成两个段落）；
      //   · 相邻硬换行（连续两次回车）：中间行只剩空白 → 被判定为段落边界，
      //     重开后一个段落被拆成两个；
      //   · 表格单元格：真实换行会截断 GFM 表格行（v0.8.0 修复 P0-1 同源）。
      // parser 的 HTML 白名单把 <br> 还原为同一个 hard_break 节点，往返稳定。
      //
      // v0.12.3（二轮反馈）：**顶层段落的段末换行改用两空格换行**，源码里不再出现
      // `<br>`（源码看起来就是"多了一个换行"，与用户的直觉一致）。
      // 为什么只在顶层：段末换行在 Markdown 里**无法表达**（行尾两空格会被解析器吞掉），
      // 而列表项/引用/脚注的序列化会把段落内容**嵌进带前缀的行**（`- ` / `> ` / 缩进），
      // 内嵌换行会把块拆开（实测 `"- A  \n\n"` → 列表被截断 + 多出一个游离段落），
      // 故这些上下文仍用 <br> 保结构；顶层段落靠 `blockToMarkdown` 不再追加段落终止换行，
      // 避免 `"A  \n"` + `"\n"` = `"A  \n\n"` 被解析成两个段落。
      // 代价（与 CommonMark/其他编辑器一致）：段末那个空行不随文件重开保留；
      // 一旦继续输入下一行，它就成为段中换行，完全保真。
      const prevIsBreak = index > 0 && node.child(index - 1).type.name === "hard_break";
      const nextIsBreak =
        index + 1 < childCount && node.child(index + 1).type.name === "hard_break";
      const isTrailing = index === childCount - 1;
      const useBr =
        context === "table" ||
        index === 0 ||
        prevIsBreak ||
        nextIsBreak ||
        (isTrailing && context !== "top");
      parts.push(useBr ? "<br>" : "  \n");
    } else if (child.type.name === "math_inline") {
      // 行内数学公式（v0.9.0 D8：剥整体 ZWSP 占位）
      const latex = stripZwsp(child.textContent || child.attrs.latex || "");
      parts.push(`$${latex}$`);
    } else if (child.type.name === "footnote_ref") {
      // 脚注引用 [^label]
      parts.push(`[^${child.attrs.label || ""}]`);
    }
  });

  const out = parts.join("");
  // 表格单元格内不出现真实换行（换行统一写成 <br>），无需续行转义
  return context === "table" ? out : escapeContinuationLines(out);
}

/**
 * v0.12.3 需求12：段内换行（`hard_break` → `"  \n"`）的**续行行首转义**。
 *
 * ─── 缺陷背景（v0.12.1 P3 实测复现，回退后同源风险仍在） ───
 *
 * Markdown 的**块级起始判定只看行首**，与上一行如何结尾无关 —— 于是用户
 * "回车换行后写一条分隔线 / 列表 / 标题"时，续行会被块级规则劫持：
 *
 *   实测（真实 markdown-it + 本项目 parser）：
 *     "abc  \n---\n"     → [heading:2("abc")]   段落升格为 Setext 标题，`---` 文本丢失
 *     "abc  \n===\n"     → [heading:1("abc")]
 *     "abc  \n- item\n"  → [paragraph, bullet_list]   块结构被拆
 *     "abc  \n# h\n"     → [paragraph, heading:1]
 *
 * ─── 为什么不能改换行编码 ───
 *
 * 三种编码（两空格 `"  \n"` / 反斜杠 `"\\\n"` / 裸换行 `"\n"`）**全部同样失败**：
 * Setext 与块起始是块级解释，与上一行结尾无关。故唯一可行修复是**转义续行行首字符**。
 * （v0.12.3 另已把段首/段末/相邻换行改用 `<br>`，但那解决的是"换行本身丢失"，
 *   与"续行被块级规则劫持"是两个独立问题。）
 *
 * ─── 规则 ───
 *
 * 对每个续行（第一个 `\n` 之后的行）：先剥离行首空白，若首个非空白字符会触发块级
 * 解释，则在其前插入 `\`。已以 `\` 开头的行跳过（`escapeText` 已转义过，避免叠加）。
 */
function escapeContinuationLines(inline: string): string {
  // 无换行 → 绝大多数段落在此短路，零开销
  if (!inline.includes("\n")) return inline;

  const lines = inline.split("\n");
  for (let i = 1; i < lines.length; i++) {
    lines[i] = escapeContinuationLine(lines[i]);
  }
  return lines.join("\n");
}

/** 续行危险行首：`{re, esc}` —— esc 接收「行首空白 + 正文」，返回转义后的行 */
const CONTINUATION_GUARDS: Array<{
  re: RegExp;
  esc: (lead: string, body: string) => string;
}> = [
  // Setext 下划线（`=`）—— 单字符即可把上一行升格为 H1
  { re: /^=+\s*$/, esc: (lead, body) => lead + "\\" + body },
  // Setext 下划线（`-`）与主题分隔线 —— 单字符即可升格为 H2
  { re: /^-+\s*$/, esc: (lead, body) => lead + "\\" + body },
  // 主题分隔线（`*` / `_`，3 个以上；escapeText 已处理成对星号，此处兜底）
  { re: /^([*_])(\s*\1)*\s*$/, esc: (lead, body) => lead + "\\" + body },
  // ATX 标题
  { re: /^#{1,6}(\s|$)/, esc: (lead, body) => lead + "\\" + body },
  // 引用
  { re: /^>/, esc: (lead, body) => lead + "\\" + body },
  // 无序列表（含缩进场景：先剥空白再判定）
  { re: /^[-+*](\s|$)/, esc: (lead, body) => lead + "\\" + body },
  // 有序列表（只转义分隔符，保持 `1.` 可读）
  {
    re: /^(\d{1,9})([.)])(\s|$)/,
    esc: (lead, body) => lead + body.replace(/^(\d{1,9})([.)])/, "$1\\$2"),
  },
  // 围栏代码块
  { re: /^(`{3,}|~{3,})/, esc: (lead, body) => lead + "\\" + body },
  // HTML 块（`<div>` / `<!--` / `<!DOCTYPE` / `<?xml`）
  { re: /^<(\/?[a-zA-Z][a-zA-Z0-9-]*|[!?])/, esc: (lead, body) => lead + "\\" + body },
  // 链接引用定义 / 脚注定义
  { re: /^\[[^\]]*\]:/, esc: (lead, body) => lead + "\\" + body },
];

function escapeContinuationLine(line: string): string {
  if (!line) return line;
  const m = /^(\s*)/.exec(line)!;
  const lead = m[1];
  const body = line.slice(lead.length);
  if (!body) return line;
  // 已被 escapeText 转义过 → 跳过，避免叠加反斜杠
  if (body.startsWith("\\")) return line;
  for (const g of CONTINUATION_GUARDS) {
    if (g.re.test(body)) return g.esc(lead, body);
  }
  return line;
}

function applyMark(text: string, mark: Mark, inTableCell = false): string {
  switch (mark.type.name) {
    case "strong":
      return `**${text}**`;
    case "em":
      return `*${text}*`;
    case "code":
      return inlineCodeWrap(text, inTableCell);
    case "strike":
      return `~~${text}~~`;
    case "underline":
      // E8(v0.9.3):下划线序列化为 HTML <u> 标签(Markdown 无原生语法)
      return `<u>${text}</u>`;
    case "mark":
      // 高亮标记 ==text==
      return `==${text}==`;
    case "subscript":
      // 下标 ~sub~
      return `~${text}~`;
    case "superscript":
      // 上标 ^sup^
      return `^${text}^`;
    case "comment": {
      // v0.13.0 返修：注释体必须让 markdown-it 的 html_inline 注释规则**整体**命中，
      // 否则该段退化为普通文本（mark 丢失）且文本被改写。
      //
      // 规则（markdown-it/lib/common/html_re.mjs）：
      //   `<!--(?:[^-]|-[^-]|--[^>])*-->`
      // 由该表达式可推出两个会让整体失配的形态：
      //   ① 体内出现 `-->`  → 注释被**提前闭合**，后半段变成普通文本；
      //   ② 体以 `-` 结尾   → 与闭合符拼成 `--->`，整个注释不再匹配。
      // 这两类在 `-` 之间插入零宽字符断开连写（不改变可见内容），
      // 读取端（parser）会去掉零宽字符 → **无损往返**。
      let body = text;
      body = body.replace(/--(?=>)/g, "-\u200B-");
      if (body.endsWith("-")) body += "\u200B";
      return `<!--${body}-->`;
    }
    case "link": {
      const { href, title } = mark.attrs;
      const titlePart = title ? ` "${escapeTitle(title)}"` : "";
      return `[${text}](${escapeDest(href)}${titlePart})`;
    }
    default:
      return text;
  }
}

/**
 * v0.9.0 B1/B5：行内 code 围栏按 CommonMark 规则选择。
 * - 围栏长度 = 内容中最长反引号连续段 + 1（旧实现只做「含反引号→双反引号」
 *   二分，多 span 相邻时产生多连反引号损坏）
 * - 内容以反引号开头/结尾、或首尾皆空格时，首尾各补一个空格
 *   （否则解析时会因围栏粘连/首尾空格剥离而丢字符）
 * - v0.9.0 D5：表格上下文中内容里的 "|" 写成 "\|"
 *   （GFM 允许 \| 穿透 code span，markdown-it 遵循）
 */
function inlineCodeWrap(content: string, inTableCell: boolean): string {
  let inner = inTableCell ? content.replace(/\|/g, "\\|") : content;
  let max = 0;
  let run = 0;
  for (const ch of inner) {
    if (ch === "`") {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(max + 1);
  if (
    inner.startsWith("`") ||
    inner.endsWith("`") ||
    (inner.startsWith(" ") && inner.endsWith(" "))
  ) {
    inner = " " + inner + " ";
  }
  return fence + inner + fence;
}

/**
 * v0.9.0 C3：链接/图片目标地址转义。
 * 含空白、括号或尖括号的地址用 <...> 包裹（CommonMark pointy 形式），
 * 内部的 < > \ 用反斜杠转义；markdown-it 原生支持该形式，往返闭合。
 */
function escapeDest(dest: string): string {
  if (!dest) return dest;
  if (!/[\s()<>]/.test(dest)) return dest;
  return "<" + dest.replace(/([<>\\])/g, "\\$1") + ">";
}

/** v0.9.0 C3：link/image title 中的引号转义 */
function escapeTitle(title: string): string {
  return title.replace(/"/g, '\\"');
}

/**
 * v0.9.0 C1：普通文本转义层（仅应用于无 code mark 的 text 节点）。
 *
 * text token 的 content 是已解码形态（源文 "\*" 进 doc 后就是 "*"），
 * 不转义直接输出会被重新解析变义（如 "2*3*4" → 强调）。转义规则按
 * 「确实会被重新解析变义才转义」的最小必要原则，避免全量转义的噪音：
 * - 反斜杠最先把已有序列转义为字面
 * - "*"：同 run 内 ≥2 个才可能配对成强调，转义；单个不转义（零噪音）
 * - "_"：CommonMark 词内下划线无法构成强调，仅转义词外的
 * - "=="、"!["、实体引用 &name;、autolink 形态 <scheme:、链接形态 ](：
 *   按语法形态条件转义
 * - "~"、"^"：只在**真的能被子/上标插件配对**时转义（见 PAIRABLE_SUB/SUP）
 * - "$"：无条件转义（两个裸 $ 会配成行内公式，金额场景无法区分）
 * - 表格上下文中 "|" 转义（GFM）
 *
 * @param text 待转义文本
 * @param inTableCell 表格上下文（额外转义 `|`）
 * @param pairContext 整段行内文本，用于 `~`/`^` 的跨节点配对判定；
 *                    省略时退化为按本节点文本判定
 */
/**
 * sub/sup 的**真实配对**判定，与 markdown-it-sub / markdown-it-sup 的实现对齐：
 * 分隔符之间必须非空、且不含未转义空白（`\\.` 允许转义字符，含转义空格）。
 * 只要文本里存在这样一对，该标记就有被回读成子/上标的风险，需要转义。
 */
const PAIRABLE_SUB = /~([^\s~]|\\.)+~/;
const PAIRABLE_SUP = /\^([^\s^]|\\.)+\^/;

/**
 * v0.12.2 P5：`$`（行内公式）与 `==`（高亮）的真实配对判定。
 *
 * 口径来自本机实测（markdown-it + 本项目 katex-plugin / markdown-it-mark）：
 * - `$`：两个 `$` 之间**至少一个字符**即配对（空白也算内容，与 sub/sup 不同）；
 *   故只需排除「`$$` 相邻」这一种不配对形态。
 * - `==`：闭合 `==` 之间的内容必须**非空白、非 `=`**（markdown-it-mark 的 scanDelims
 *   要求 `can_open`/`can_close`）；`a == b`、`2 == 3 == 4`、`a===b` 都不配对。
 */
const PAIRABLE_MATH = new RegExp("\\$(?!\\$)[\\s\\S]*?\\$");
const PAIRABLE_MARK = /==([^\s=]|\\.)+==/;

function escapeText(text: string, inTableCell = false, pairContext?: string): string {
  if (!text) return text;
  let out = text.replace(/\\/g, "\\\\");

  // 反引号：任何出现都可能与其他 run 的反引号配对成 code span
  out = out.replace(/`/g, "\\`");

  // 星号：≥2 个才可能构成强调对
  if ((out.match(/\*/g) || []).length >= 2) {
    out = out.replace(/\*/g, "\\*");
  }

  // 下划线：仅转义词外的（前后不同时为字母数字）
  if (out.includes("_")) {
    const isWord = (c: string | undefined) => c !== undefined && /[a-zA-Z0-9]/.test(c);
    let s = "";
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if (ch === "_" && isWord(out[i - 1]) && isWord(out[i + 1])) {
        s += ch;
      } else if (ch === "_") {
        s += "\\_";
      } else {
        s += ch;
      }
    }
    out = s;
  }

  // v0.12.2 P5：高亮 `==` 的转义移到下方「按真实配对判定」处统一处理
  // （原实现在此无条件 `out.replace(/==/g,"\\=\\=")`，产生 `a \=\= b` 噪音）。

  // 图片起始 ![（仅在后随 [ 时有意义）
  out = out.replace(/!(?=\[)/g, "\\!");

  // 链接/引用形态的方括号：存在 ]( 或 ][ 配对时才转义
  if (/\]\s*\(/.test(out) || /\]\[/.test(out)) {
    out = out.replace(/[[\]]/g, "\\$&");
  }

  // 实体引用形态的 &（防 &copy; 类被解码变义）
  out = out.replace(/&(?=[a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, "\\&");

  // autolink 形态的 <（防 <scheme:...> 被解析为链接）
  out = out.replace(/<(?=[a-zA-Z][a-zA-Z0-9.+-]*:)/g, "\\<");

  // v0.11.0 B3-4（返修）：波浪线 / 脱字符**只在真的能配对时**才转义。
  //
  // 缺陷背景（P1）：最初是无条件裸替换 → `x^2` 存成 `x\^2`、`a ~ b` 存成 `a \~ b`，
  // 凭空多出反斜杠 + git diff 噪音。
  //
  // 首版修复改成「节点内出现 ≥2 次就转义」，**口径仍然不对**：判定必须与
  // markdown-it-sub / markdown-it-sup 的真实配对规则一致。两处插件的规则是
  // （见 node_modules/markdown-it-sub|sup/index.mjs）：分隔符之间必须**非空**，
  // 且不能含未转义空白，否则 `content.match(/(^|[^\\])(\\\\)*\s/)` 直接否决配对。
  //
  // 本机实测（markdown-it + sub/sup 探针）：
  //   `x^2 + y^2` → 2 个 `^`，中间含空格 → **不配对** → 不该转义（首版却转了）
  //   `x^2+y^2`   → 中间无空白 → 配对成上标 → **必须转义**
  //   `a ~ b ~ c` → 含空格 → 不配对；`a~b~c` → 配对成下标 → 必须转义
  //
  // 判定使用 pairContext（整段行内文本）而非单个文本节点，避免
  // `a~**b**~c` 这类「标记被 mark 拆到不同节点、回读时仍能跨节点配对」的漏转义。
  const pairSource = pairContext ?? out;
  if (PAIRABLE_SUB.test(pairSource)) {
    out = out.replace(/~/g, "\\~");
  }
  if (PAIRABLE_SUP.test(pairSource)) {
    out = out.replace(/\^/g, "\\^");
  }
  // v0.12.2 P5：`$` 与 `==` 同样改为**只在真的能配对时**才转义。
  //
  // 缺陷背景（P5，与已修的 P1-6 同类）：原实现对这两个符号**无条件裸替换**
  // （`out.replace(/\$/g,"\\$")` 与 `out.replace(/==/g,"\\=\\=")`），于是
  //   `价格 $100` → `价格 \$100`、`a == b` → `a \=\= b`
  // 凭空多出反斜杠（git diff 噪音），而这两处根本不会配对。
  //
  // 本机实测（markdown-it + 本项目 katex-plugin，判定与解析口径一致）：
  //   `$`：两个 `$` 且**中间至少一个字符**才配对（空白也算内容）
  //        `$x$` `$ x $` `x$y$z` `a $5 and $6` → 配对（必须转义）
  //        `价格 $100` `cost $5` `100$` `$` `$$` `5$ off` → 不配对（不该转义）
  //   `==`：闭合 `==` 的两侧内容必须**非空白且非 `=`**
  //        `a==b==c` `==x==` `x ==y== z` → 配对（必须转义）
  //        `a == b` `x==y` `2 == 3 == 4` `a===b` `a ==` → 不配对（不该转义）
  if (PAIRABLE_MATH.test(pairSource)) {
    out = out.replace(/\$/g, "\\$");
  }
  if (PAIRABLE_MARK.test(pairSource)) {
    out = out.replace(/==/g, "\\=\\=");
  }

  if (inTableCell) {
    out = out.replace(/\|/g, "\\|");
  }
  return out;
}
