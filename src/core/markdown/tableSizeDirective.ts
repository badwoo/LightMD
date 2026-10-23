/**
 * v0.14.0 需求7：表格列宽/行高持久化 —— 注释指令的编解码（纯函数层）。
 *
 * ## 背景
 * 用户拖拽调整表格列宽/行高后，关闭文档重新打开尺寸失效。根因：
 * 尺寸只写在 PM 节点 attrs（`table.attrs.columnWidths` / `rowHeights`），
 * 而 GFM 管道表格语法**无法表达**列宽/行高，序列化时这两个 attrs 被整体丢弃。
 *
 * ## 方案：旁路注释指令
 * 在表格**之后**输出一行 HTML 注释，把尺寸随 markdown 一起存盘：
 *
 * ```markdown
 * | A | B |
 * | --- | --- |
 * | 1 | 2 |
 *
 * <!-- lightmd-table-size: {"columnWidths":[120,240],"rowHeights":[40,40,60]} -->
 * ```
 *
 * ## 位置：实测结论（必须保留在代码里，否则后人会「顺手挪到紧贴表格」）
 *
 * 本项目的编辑管线是 `html: true` + `disable("html_block")`（parser.ts 的
 * `createMarkdownIt`）。实测（markdown-it 14.x）：
 *
 * 1. **紧贴表格下一行**（无空行）：
 *    ```
 *    | A | B |
 *    | --- | --- |
 *    | 1 | 2 |
 *    <!-- lightmd-table-size: {...} -->
 *    ```
 *    注释行被 GFM 表格规则当成**第 4 个数据行**（lazy continuation），
 *    token 流里多出一个 `tr_open`，`<!-- … -->` 变成该行的 `html_inline`。
 *    → 表格**凭空多一行**，指令还会被当正文渲染进单元格。**不可用**。
 * 2. **表格后空一行再输出**（本实现采用）：
 *    token 流为 `table_close` → `paragraph_open`(map 指向注释行) → `inline`
 *    （唯一 child 是 `html_inline` 注释）→ `paragraph_close`。
 *    → 指令是独立块，可在解析阶段整段吞掉，不影响表格结构。
 * 3. **紧贴表格前一行**：同样是独立 paragraph，但指令在表格**之前**会让
 *    B6 原文切片快路径（`blocks[0].start === 0`）与块级原文行区间都变得别扭，
 *    且表格块自身的行区间不含指令行 → 未编辑块走逐块切片时指令会丢。故不采用。
 *
 * ## 零 diff 契约
 * 无尺寸（两个 attrs 均为 null）时 `encodeTableSizeDirective` 返回 `""`，
 * 序列化器一行都不追加 → 既有文档 / 纯管道表格序列化**逐字节不变**。
 */
import type { Node } from "prosemirror-model";

/** 指令键名（注释内 JSON 之前的固定前缀） */
export const TABLE_SIZE_DIRECTIVE_KEY = "lightmd-table-size:";

/**
 * 整行指令的识别正则（**宽容**：JSON 坏了也算指令行）。
 *
 * 解析端用「先识别行、再尽力解析 JSON」两步：识别决定**是否吞掉这一行**
 * （坏指令也不能漏成正文），JSON 解析决定**是否应用尺寸**（坏了静默忽略）。
 */
const DIRECTIVE_LINE_RE = /^<!--\s*lightmd-table-size:[\s\S]*-->$/;

/**
 * 该行是否是本项目的表格尺寸指令行（不看 JSON 是否合法）。
 *
 * 用途：parser 用它决定「这一行注释必须从正文里吞掉」——
 * 即便 JSON 损坏（`<!-- lightmd-table-size: {bad json} -->`），
 * 也不能让它变成用户可见的段落文本。
 */
export function isTableSizeDirectiveLine(line: string): boolean {
  return DIRECTIVE_LINE_RE.test(line.trim());
}

/**
 * 把尺寸数组规范化为「正整数数组」，并按需要做长度校正。
 *
 * 口径（写死在这里，序列化/解析两端共用，保证往返稳定）：
 * - 非数组 → `null`（= 没有尺寸信息）；
 * - 每个元素：`Number` 化后 `Math.round`；非有限数或四舍五入后 `< 1` 的**丢弃该元素**
 *   （像素尺寸最小 1，0/负数/NaN 无意义）；
 * - 全部元素都被丢弃 → `null`；
 * - `expectedLen` 给出时：
 *   · **超长截断**——多余宽度会被 `applyColumnWidths` 计入 table 总宽 → 表格被撑宽，
 *     必须裁掉（这是「数组比列数长」的唯一安全处理）；
 *   · **不足补齐**（仅当给了 `padValue`）——`number[]` 契约下没有 null 占位，
 *     缺失列/行只能取编辑器默认值（列 100px / 行 30px，与 `updateColumnWidth`
 *     初始化一致）。补齐后长度恒等于 `expectedLen`，下游按 index 取值不再有
 *     `undefined` 歧义，且第二次序列化与第一次逐字节一致（稳定）。
 */
export function sanitizeSizeArray(
  v: unknown,
  expectedLen?: number,
  padValue?: number,
): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const item of v) {
    let n: number;
    if (typeof item === "number") n = item;
    else if (typeof item === "string" && item.trim() !== "") n = Number(item);
    else continue;
    if (!Number.isFinite(n)) continue;
    const rounded = Math.round(n);
    if (rounded < 1) continue;
    out.push(rounded);
  }
  if (out.length === 0) return null;
  if (typeof expectedLen === "number" && expectedLen > 0) {
    if (out.length > expectedLen) return out.slice(0, expectedLen);
    if (typeof padValue === "number" && padValue >= 1 && out.length < expectedLen) {
      const pad = Math.round(padValue);
      while (out.length < expectedLen) out.push(pad);
    }
  }
  return out;
}

/**
 * 编码表格尺寸指令行（不含换行符）。
 *
 * - 两个数组都无有效值时返回 `""`（**零 diff 的关键**：不输出任何东西）；
 * - JSON 单行紧凑（`JSON.stringify`，无缩进），键顺序固定 columnWidths → rowHeights；
 * - 只有有值的那一侧才出现在 JSON 里（不会写 `"rowHeights":null`）。
 *
 * @example
 * encodeTableSizeDirective([120, 240], null)
 * // → '<!-- lightmd-table-size: {"columnWidths":[120,240]} -->'
 */
export function encodeTableSizeDirective(
  columnWidths: number[] | null,
  rowHeights: number[] | null,
): string {
  const cw = sanitizeSizeArray(columnWidths);
  const rh = sanitizeSizeArray(rowHeights);
  if (!cw && !rh) return "";
  const payload: { columnWidths?: number[]; rowHeights?: number[] } = {};
  if (cw) payload.columnWidths = cw;
  if (rh) payload.rowHeights = rh;
  return `<!-- ${TABLE_SIZE_DIRECTIVE_KEY} ${JSON.stringify(payload)} -->`;
}

/**
 * 解析表格尺寸指令行。
 *
 * **完全容错**：不是指令行 / JSON 坏 / 不是对象 / 值不是数组 / 全部值非法
 * → 返回 `null`（静默忽略，绝不影响表格本身的解析）。
 *
 * @returns 至少一侧有有效尺寸时返回 `{ columnWidths, rowHeights }`（无值的一侧为 null）
 */
export function parseTableSizeDirective(
  line: string,
): { columnWidths: number[] | null; rowHeights: number[] | null } | null {
  const trimmed = line.trim();
  if (!isTableSizeDirectiveLine(trimmed)) return null;
  // 取 `lightmd-table-size:` 与结尾 `-->` 之间的 JSON 文本
  const m = /^<!--\s*lightmd-table-size:([\s\S]*?)-->$/.exec(trimmed);
  if (!m) return null;
  const jsonText = m[1].trim();
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return null; // 坏 JSON：静默忽略（行仍会被 parser 吞掉，不会进正文）
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const columnWidths = sanitizeSizeArray(obj.columnWidths);
  const rowHeights = sanitizeSizeArray(obj.rowHeights);
  if (!columnWidths && !rowHeights) return null;
  return { columnWidths, rowHeights };
}
