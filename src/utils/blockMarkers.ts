/**
 * v0.13.0 需求7：块级源码标记的**文本计算**（纯逻辑层）。
 *
 * ## 范围（本版做 5 类；表格/图片明确不做）
 *
 * | 块类型 | 显示的源码符号 |
 * | --- | --- |
 * | `bullet_list` / `ordered_list` | 光标所在 `list_item` 的 marker（`- ` / `1. ` / `1) `） |
 * | `task_list` | `- [ ] ` / `- [x] `（含方形/圆形样式） |
 * | `horizontal_rule` | `---` |
 * | `math_block` | `$$` |
 * | `toc` | `[toc]` |
 *
 * 表格与图片**不做**：二者本身是可视化 NodeView，加源码标记会与列宽拖拽 /
 * 图片编辑对话框冲突。
 *
 * ## 为什么 marker 要挂在不同的节点上
 *
 * - heading / blockquote / code_block / hr / math_block / toc 的 marker 属于
 *   **块节点自身** → 装饰挂该节点（既有路径）；
 * - 列表的 marker（`- ` / `1. `）在 Markdown 里属于**列表节点**，但 PM 的 schema
 *   把它放在 `list_item`/`task_item` 上（attrs 有 `style`/`checked`）→ 装饰挂
 *   `list_item`，视觉上显示的是光标所在那一项的 marker。
 */

/** 一个可标记块的输入信息 */
export interface BlockMarkerInput {
  /** 块类型名 */
  type: string;
  /** 块节点的 attrs（按类型取不同字段） */
  attrs: Record<string, unknown>;
  /** 该块在文档中的深度（用于判定列表项是否顶层，本版只用于诊断） */
  depth?: number;
  /** 有序列表项在其列表中的序号（1-based）；无序/任务列表不需要 */
  ordinal?: number;
  /**
   * v0.13.0 需求7：list_item 的**父列表类型**（`bullet_list` / `ordered_list`）。
   * 光标落在列表项里时，最近的可标记块是 list_item，但 marker 的「有序/无序」
   * 语义在父节点上——不传就无法区分 `- ` 与 `1. `。
   */
  parentType?: string;
}

/** 计算结果：null = 该块不需要标记 */
export interface BlockMarkerResult {
  /** 显示的源码符号（CSS ::before 的 content 取值来源） */
  marker: string;
  /** 是否需要 `position:relative` 之类的定位上下文 class（与既有路径一致） */
  needsPositioning: boolean;
}

/** v0.13.0 需求7 新增的可标记块类型（其余仍由既有路径处理） */
export const MARKABLE_TYPES = [
  "heading",
  "blockquote",
  "code_block",
  "mermaid_block",
  "bullet_list",
  "ordered_list",
  "list_item",
  "task_list",
  "task_item",
  "horizontal_rule",
  "math_block",
  "toc",
] as const;

/** 该类型是否由本模块计算 marker（title/heading 等仍需既有路径） */
export function isMarkableType(type: string): boolean {
  return (MARKABLE_TYPES as readonly string[]).includes(type);
}

/**
 * 有序列表 marker 的分隔符（schema 的 `delim`：`.` 或 `)`）。
 * 非法值回落 `.`（与 schema 默认一致）。
 */
export function listDelimiter(attrs: Record<string, unknown>): "." | ")" {
  return attrs.delim === ")" ? ")" : ".";
}

/**
 * 有序列表项的 marker 文本：`1. ` / `12) `。
 *
 * v0.13.0 返修：必须带上**列表自身的起始序号**。
 * `ordinal` 只是「同级第几项」（1-based），而 Markdown 的有序列表可以从任意
 * 序号开始（`3. c` / `4. d`）。旧实现忽略 `ordered_list.attrs.order`，于是源码
 * 写 `3. c` 时编辑器左侧标记却显示 `1. `——与源码互相矛盾。
 *
 * @param ordinal 1-based 序号（同级第几项）
 * @param attrs 列表节点或列表项的 attrs（取 `delim` 与 `order`）
 */
export function orderedListMarker(ordinal: number, attrs: Record<string, unknown>): string {
  const n = Number.isFinite(ordinal) && ordinal > 0 ? Math.floor(ordinal) : 1;
  const start = Number(attrs.order);
  // order 缺省 / 非法 / 1 → 不偏移（未从中间开始的列表零变化）
  const offset = Number.isFinite(start) && start > 1 ? Math.floor(start) - 1 : 0;
  return `${n + offset}${listDelimiter(attrs)} `;
}

/** 无序列表 marker：`- `（固定短横，与 LightMD 序列化口径一致） */
export function bulletListMarker(): string {
  return "- ";
}

/**
 * 任务列表 marker：`- [ ] ` / `- [x] `，方形/圆形样式都显示方括号
 * （LightMD 序列化对两种样式都写 `- [ ]`，圆形仅在视觉上不同）。
 */
export function taskListMarker(attrs: Record<string, unknown>): string {
  const checked = attrs.checked === true;
  return checked ? "- [x] " : "- [ ] ";
}

/**
 * 计算某个块的源码标记文本。
 *
 * @returns marker 结果；该类型不需要标记时返回 null
 */
export function computeBlockMarker(input: BlockMarkerInput): BlockMarkerResult | null {
  const { type, attrs, ordinal = 1 } = input;
  const base = { needsPositioning: true };

  switch (type) {
    case "blockquote":
      return { marker: "> ", ...base };
    case "code_block":
      return { marker: `\`\`\`${(attrs.language as string) || ""}`, ...base };
    case "mermaid_block":
      return { marker: "```mermaid", ...base };
    case "horizontal_rule":
      return { marker: "---", ...base };
    case "math_block":
      return { marker: "$$", ...base };
    case "toc":
      return { marker: "[toc]", ...base };
    case "ordered_list":
      // 有序列表的 marker 挂 list_item；若直接命中列表节点（光标在列表与项之间），
      // 用 ordinal 或默认 1
      return { marker: orderedListMarker(ordinal, attrs), ...base };
    case "bullet_list":
      return { marker: bulletListMarker(), ...base };
    case "task_list":
      return { marker: taskListMarker(attrs), ...base };
    // v0.13.0 需求7：光标在 list_item / task_item 内时（最常见路径）。
    // list_item 的 marker 语义由**父列表类型**决定（PM 的 list_item 自身无 attrs）；
    // task_item 自身带 checked，可独立判断。
    case "list_item":
      return input.parentType === "ordered_list"
        ? { marker: orderedListMarker(ordinal, attrs), ...base }
        : { marker: bulletListMarker(), ...base };
    case "task_item":
      return { marker: taskListMarker(attrs), ...base };
    default:
      return null;
  }
}

/**
 * 列表项的序号：在父列表的所有同级 `list_item` 中排第几（1-based）。
 *
 * 有序列表必须按**实际序号**显示（`1.` `2. `3. `），不能全部显示 `1.`。
 *
 * @param parent 列表节点
 * @param itemPos 列表项节点在文档中的位置
 */
export function computeListItemOrdinal(
  parent: { forEach: (cb: (node: { type: { name: string } }, offset: number) => void) => void } | null | undefined,
  itemPos: number,
): number {
  if (!parent) return 1;
  let ordinal = 1;
  parent.forEach((node, offset) => {
    if (offset >= itemPos) return;
    if (node.type.name === "list_item" || node.type.name === "task_item") ordinal++;
  });
  return ordinal;
}

/** 源码模式下「当前行是否在代码块内」不需要本模块（由 inlineContext 负责） */
export const BLOCK_MARKER_SOURCE_HINT = "v0.13.0 需求7";
