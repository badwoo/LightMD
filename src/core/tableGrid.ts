/**
 * v0.13.0 需求12：表格单元格合并/拆分 —— 纯函数层
 *
 * 三层职责：
 * ① 形态识别：`extractTdWrapper(content)` 从单元格行内内容中识别
 *    `<td colspan="N" rowspan="M">inner</td>` 包裹（markdown-it 把 HTML 标签
 *    留在 cell 的 inline 流里，td_open/th_open 本身不带 attrs——实测见
 *    `probe-td.mjs`）；
 * ② 逻辑列网格：`buildTableGrid(rows)` 把「每行 cell 列表」展开为
 *    grid[row][col]，colspan/rowspan 占位；
 * ③ 合并/拆分事务：`mergeCells` / `splitCell` 基于 grid 计算目标位置。
 *
 * 设计红线（v1 决策 + 回归锁）：
 * - **纯管道表格（无合并）必须零 diff** —— serializer 检测到"无任何 span"
 *   时走原管道，一行不改；
 * - 合并/拆分都通过单个 transaction 完成（一次撤销）；
 * - 所有函数不依赖 DOM，可在 node 环境下单测。
 */
import type { Node } from "prosemirror-model";

/** 单元格跨度（colspan/rowspan 的统称） */
export interface CellSpan {
  colspan: number;
  rowspan: number;
}

/** 网格中的一个格子：null = 被上方/左方的跨度占位 */
export type GridCell = (CellSpan & { node: Node; rowIdx: number; colIdx: number }) | null;

/** 逻辑列网格：[row][col] */
export type TableGrid = GridCell[][];

/** 归一化跨度：非正整数回落 1 */
export function normalizeSpan(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/** 从节点 attrs 读跨度（缺省 1） */
export function spanOf(node: Node): CellSpan {
  return {
    colspan: normalizeSpan(node.attrs.colspan),
    rowspan: normalizeSpan(node.attrs.rowspan),
  };
}

/**
 * ① 从单元格行内内容中提取 `<td colspan rowspan>inner</td>` 包裹。
 *
 * markdown-it（html:true + html_block 禁用）的实测形态：
 *   inline.children = [html_inline "<td colspan=\"2\">", text "A", html_inline "</td>"]
 *   inline.content   = "<td colspan=\"2\">A</td>"
 *
 * 因此判定放在 **content 字符串**上（children 会被 markdown-it 重排/合并），
 * 只有**整体就是一层 td 包裹**才识别——单元格里手写的其它 HTML 不受影响。
 *
 * @returns 识别成功时给出跨度与内层内容；否则 null
 */
export function extractTdWrapper(
  content: string,
): { span: CellSpan; inner: string; tag: "td" | "th" } | null {
  const trimmed = content.trim();
  const m = /^<(td|th)\b([^>]*)>([\s\S]*)<\/\1\s*>$/i.exec(trimmed);
  if (!m) return null;
  const tag = m[1].toLowerCase() === "th" ? "th" : "td";
  const attrs = m[2] ?? "";
  const inner = m[3] ?? "";
  const cs = /colspan\s*=\s*['"]?(\d+)['"]?/i.exec(attrs);
  const rs = /rowspan\s*=\s*['"]?(\d+)['"]?/i.exec(attrs);
  // 内层再含 td/th = 嵌套表格，本格式不表达（只取最外层一层）
  if (/<(td|th)\b/i.test(inner)) return null;
  return {
    tag,
    span: { colspan: normalizeSpan(cs?.[1]), rowspan: normalizeSpan(rs?.[1]) },
    inner,
  };
}

/** 表格中所有行（含 thead/tbody 的行），按文档顺序 */
export interface TableRowRef {
  row: Node;
  /** 行在 table 节点内的绝对位置 */
  pos: number;
  /** 是否表头行（thead 内） */
  isHead: boolean;
}

/** 收集 table 的全部行（thead + tbody，文档顺序） */
export function collectTableRows(table: Node, tablePos: number): TableRowRef[] {
  const out: TableRowRef[] = [];
  let sectionPos = tablePos + 1;
  table.forEach((section) => {
    if (section.type.name === "table_head" || section.type.name === "table_body") {
      const isHead = section.type.name === "table_head";
      let rowPos = sectionPos + 1;
      section.forEach((row) => {
        out.push({ row, pos: rowPos, isHead });
        rowPos += row.nodeSize;
      });
    }
    sectionPos += section.nodeSize;
  });
  return out;
}

/**
 * 表格 → 逻辑列网格（含行尾幻影空格裁剪，见 trimRowTrailingEmpties）。
 *
 * 合并/拆分/合并序列化三条路径**共用**这一个入口，保证「网格宽」的
 * 口径唯一（否则序列化按 3 列输出、合并事务按 4 列算，必然错位）。
 */
export function buildTableGridFromTable(table: Node, tablePos = 0): TableGrid {
  const rows: Node[] = [];
  // v0.13.1 需求2：裁剪必须带**逻辑列上界**——否则行尾的**真实空单元格**会被当成
  // markdown-it 补齐的幻影格一起丢掉，它就拿不到网格坐标、拖拽永远选不中（见
  // tableLogicalColumnCount 的说明）。
  const logicalCols = tableLogicalColumnCount(table, tablePos);
  // 用裁剪后的行重建轻量 row 桩（forEach 语义与 PM Node 一致），
  // 避免为裁剪而真的改文档
  const trimmed = collectTableRows(table, tablePos).map((ref) => ({
    ref,
    cells: trimRowTrailingEmpties(ref.row, logicalCols),
  }));
  for (const t of trimmed) {
    rows.push({
      forEach(f: (n: Node, offset: number, index: number) => void) {
        t.cells.forEach((n, i) => f(n, 0, i));
      },
    } as unknown as Node);
  }
  return buildTableGrid(rows);
}

/**
 * ② 构建逻辑列网格。
 *
 * 算法（与 HTML 表格的规范占位一致）：
 * - 逐行扫描，维护 `occupied: boolean[]`（当前行已被 rowspan 占据的列）；
 * - 每行的 cell 按序填入「第一个空闲列」，随后按 colspan 占据右侧若干列；
 * - rowspan > 1 时把下方若干行的同列区间标记为已占据。
 *
 * 结果：grid[row][col] 为格子对象或被占位 null；列数取所有行的**最大值**
 * （表头行通常最长，但含合并时可能由数据行决定）。
 */
export function buildTableGrid(rows: Node[]): TableGrid {
  const grid: TableGrid = [];
  /** 每行已被 rowspan 占据的列集合（长度动态增长） */
  const pending: boolean[][] = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!pending[r]) pending[r] = [];
    const occupied = pending[r];
    const gridRow: GridCell[] = grid[r] ?? [];
    let col = 0;

    row.forEach((cell) => {
      const { colspan, rowspan } = spanOf(cell);
      // ── 占位空格识别 ──
      // 序列化纵向合并时，被 rowspan 覆盖的列在后续行里以**一个空单元格**
      // 占位（`|  | 4 |` 的第一个空格）。回读时它会被"第一个空闲列"规则
      // 推到正确列的**右边**，导致整行右移、列数超宽（重开文档后数据错位，
      // 且 markdown-it 会按表头列数截断 → 内容丢失）。
      // 判定：空格 + 当前列正是 rowspan 空洞 → 它是占位符，跳过并让 col
      // 前进到空洞之后。非空洞处的空格仍是真实空单元格。
      if (col < occupied.length && occupied[col] && isEmptyPlainCell(cell)) {
        col++;
        return;
      }
      // 找第一个空闲列
      while (occupied[col]) col++;
      // 记录主格
      gridRow[col] = { ...spanOf(cell), node: cell, rowIdx: r, colIdx: col };
      // 占据本列自身（否则后续 cell 的「第一个空闲列」判定永远回到 col）
      occupied[col] = true;
      // 占据本行右侧（colspan）
      for (let c = col + 1; c < col + colspan; c++) occupied[c] = true;
      // 占据下方行的同列区间（rowspan）
      for (let rr = r + 1; rr < r + rowspan; rr++) {
        if (!pending[rr]) pending[rr] = [];
        for (let c = col; c < col + colspan; c++) pending[rr][c] = true;
      }
      col += colspan;
    });

    // 补齐本行的占位 null：让 grid[r] 的长度 = 该行实际占用的列数，
    // 且被 rowspan 占据的空位显式为 null（调用方据此区分"空格"与"越界"）
    const width = Math.max(occupied.length, gridRow.length);
    for (let c = 0; c < width; c++) {
      if (occupied[c] && !gridRow[c]) gridRow[c] = null;
    }
    grid[r] = gridRow;
  }

  return grid;
}

/** 空普通格（无内容、无跨度）——纵向合并占位符的判定 */
function isEmptyPlainCell(cell: Node): boolean {
  const { colspan, rowspan } = spanOf(cell);
  if (colspan > 1 || rowspan > 1) return false;
  // content 可能不存在（测试桩/非常规节点）——此时按"非空"处理，
  // 避免把真实格误判成占位符而丢掉
  const size = (cell as unknown as { content?: { size?: number } }).content?.size;
  return typeof size === "number" && size === 0;
}

/** 网格的逻辑列数（最长行的宽度） */
export function gridColumnCount(grid: TableGrid): number {
  let n = 0;
  for (const row of grid) n = Math.max(n, row.length);
  return n;
}

/**
 * v0.13.1 需求2：表格的**逻辑列数**——即 markdown-it 的 `columnCount`。
 *
 * ─── 为什么需要它 ───
 * markdown-it 的表格规则（`lib/rules_block/table.mjs`）先由**表头行源文本**算出
 * `columnCount`（第 129 行 `const columnCount = columns.length`），然后对**每一行**
 * 恒定输出 `columnCount` 个 `<td>`（第 202-213 行）：
 *
 * ```js
 * for (let i = 0; i < columnCount; i++) {
 *   const token_tdo = state.push('td_open', 'td', 1)
 *   const token_il = state.push('inline', '', 0)
 *   token_il.content = columns[i] ? columns[i].trim() : ''   // ← 源文少写的列补空
 * ```
 *
 * 结论：**源文件少写了几格，解析后一定被补齐**，而且补出来的空格与用户手写的
 * 真实空单元格**在节点层面完全同形**（都是 `content.size === 0`、span 1/1）——
 * 这正是 [`trimRowTrailingEmpties`] 无法只靠"空格"识别幻影格的根因。
 *
 * ─── 判据 ───
 * 幻影格是"补齐到 columnCount"的产物，因此它**布点后的逻辑列必然 ≥ columnCount**；
 * 真实空单元格一定落在 `[0, columnCount)` 内。
 * ⚠️ 判据必须是**逻辑列**而不是物理下标：`| X(cs3) | | |` 里两个补齐格的物理下标
 * 是 1、2（都 < 3），但被 cs3 挤到逻辑列 3、4 —— 按物理下标会把它们当真实格留下，
 * 网格被撑成 5 列（实测），列错位、序列化漂移。
 *
 * ─── columnCount 怎么取 ───
 * markdown-it 为表头行也恒定输出 `columnCount` 个 cell，所以**表头行的物理子节点数
 * 就等于 columnCount**。（注意：**不能**用 colspan 展开后的贪婪宽度——markdown-it 的
 * `columnCount` 数的是源文本的管道格数，`<td colspan="2">` 只算一格。）
 *
 * 表头缺失（schema 的 `table_head?`）时退化为所有行的最大物理宽度（防御取值）。
 *
 * @returns 逻辑列数；无行时 0
 */
export function tableLogicalColumnCount(table: Node, tablePos = 0): number {
  const rows = collectTableRows(table, tablePos);
  if (rows.length === 0) return 0;
  const head = rows.find((r) => r.isHead);
  if (head) return head.row.childCount;
  // 防御：无 thead 时取所有行的最大物理宽度（与旧裁剪口径一致，不会把真实格裁掉）
  let w = 0;
  for (const r of rows) w = Math.max(w, r.row.childCount);
  return w;
}

/**
 * 一行的每个 cell 布点后的**逻辑列**（与 [`buildTableGrid`] 同一套"第一个空闲列"规则）。
 *
 * v0.13.1 需求2：用于判定"这个行尾空格是用户真实写的空单元格，还是 markdown-it
 * 补齐出来的幻影格"。对**未裁剪**的全部 cell 计算，因此与裁剪结果无关（不递归）。
 */
function greedyRowColumns(row: Node): number[] {
  const out: number[] = [];
  const occupied: boolean[] = [];
  let col = 0;
  row.forEach((cell) => {
    const { colspan } = spanOf(cell);
    while (occupied[col]) col++;
    out.push(col);
    for (let c = col; c < col + colspan; c++) occupied[c] = true;
    col += colspan;
  });
  return out;
}

/** 表格是否含任何合并（colspan>1 或 rowspan>1） */
export function tableHasSpan(table: Node): boolean {
  let found = false;
  table.forEach((section) => {
    if (section.type.name !== "table_head" && section.type.name !== "table_body") return;
    section.forEach((row) => {
      row.forEach((cell) => {
        const { colspan, rowspan } = spanOf(cell);
        if (colspan > 1 || rowspan > 1) found = true;
      });
    });
  });
  return found;
}

/**
 * 去掉行尾的**空普通格**（content 为空且 span 为 1/1）。
 *
 * ─── 为什么需要 ───
 * markdown-it 的 GFM 表格规则会把每个数据行**补齐到表头列数**
 * （`| <td colspan="2">M</td> | C |` 源码只有 2 格，解析后是 3 格：
 * 末格是自动补的空格）。这些幻影空格会把逻辑网格撑宽——
 * 实测 `| A|B|C |` + `| M(2) | C |` 的网格宽变成 4 而不是 3，
 * 导致分隔行列数错误、列错位、拆分时重复补格。
 *
 * 语义上无损：GFM 规定缺失的单元格即空单元格，去掉行尾空格
 * 与"这一行末尾本来就是空的"完全等价。
 *
 * ─── 为什么不在 parser 里做 ───
 * parser 是**纯管道表格零 diff 回归锁**的核心路径：在那里丢行尾空格
 * 会改变 `| 1 |  |` 这类文档的往返结果。故只在本模块
 * （合并/拆分/合并序列化专用）做裁剪，纯管道管道一行不受影响。
 */
export function trimRowTrailingEmpties(row: Node, logicalCols?: number): Node[] {
  const cells: Node[] = [];
  row.forEach((c) => cells.push(c));
  // v0.13.1 需求2：只有**逻辑列上界**能区分幻影格与真实空格（见 tableLogicalColumnCount）。
  // 未传上界时退化为旧口径（裁剪所有行尾空格）——保持既有调用点的行为不变。
  if (logicalCols === undefined) {
    let end = cells.length;
    while (end > 0) {
      const c = cells[end - 1];
      if (!c) break;
      const { colspan, rowspan } = spanOf(c);
      if (colspan > 1 || rowspan > 1) break;
      if (c.content.size > 0) break;
      end--;
    }
    return cells.slice(0, end);
  }
  // markdown-it 对每行恒定输出 `columnCount` 个 cell，且**只对缺失的列补空**
  // （`table.mjs` 第 209 行 `columns[i] ? ... : ''`）。补出来的幻影格与用户真实写的
  // 空单元格在节点层面完全同形，**唯一可靠的判据是布点后的逻辑列**：
  //
  //   · 幻影格是"补齐到 columnCount"的产物 → 它的**逻辑列必然 ≥ logicalCols**；
  //   · 真实空单元格一定落在 [0, logicalCols) 内。
  //
  // 注意**不能**用物理下标判断：`| X(cs3) |  |  |` 里两个补齐格的物理下标是 1、2
  // （都 < 3），但它们的逻辑列是 3、4（被 cs3 挤到列数之外）——用物理下标会把它们
  // 当真实格留下，网格被撑成 5 列（实测），列错位、序列化漂移。
  //
  // 也不能只按"行尾空格"裁（旧口径）：那会把 `| 1 | 2 |  |` 里用户真实写的末尾空格
  // 一起丢掉，它拿不到网格坐标 → cellCoordOf 返回 null → 拖拽永远选不中、无法合并
  // （需求2 的根因）。
  const logicalColsOf = greedyRowColumns(row);
  let end = cells.length;
  while (end > 0) {
    const c = cells[end - 1];
    if (!c) break;
    const { colspan, rowspan } = spanOf(c);
    if (colspan > 1 || rowspan > 1) break;
    if (c.content.size > 0) break;
    if (logicalColsOf[end - 1] < logicalCols) break; // 逻辑列内 → 真实空单元格，保留
    end--; // 逻辑列外 → 补齐的幻影格，丢弃
  }
  return cells.slice(0, end);
}

/**
 * v0.13.0 返修（问题12）：cell 的**文档位置** → 网格坐标 映射。
 *
 * 缺陷背景：`TableView.cellCoordOf` 原先用
 * `view.posAtDOM(cellEl, 0)` 去和「cell 节点起点」比较，但 PM 的
 * `posAtDOM(dom, 0)` 返回的是 **cell 第一个子节点的位置**（= cell 起点 + 1），
 * 于是**每个单元格都匹配不上** → 返回 null → `rangeAnchor` 永不设置 →
 * `cellRange` 永不赋值 → 拖拽跨格选不出范围 → 合并按钮永久禁用。
 * 即：需求12 的合并在 UI 上完全没有可用路径（纯函数单测却是绿的，
 * 因为它们直接调用 mergeCells，不经过坐标换算）。
 *
 * 本函数复用 [`buildTableGridFromTable`] 的同一套网格口径（含行尾幻影裁剪），
 * 因此不会与合并/序列化产生第二套列宽解释。cell 位置用
 * [`collectTableRows`] 的行位置逐格累加得到（与网格构建同源）。
 *
 * @returns Map<cell 节点在文档中的起始位置, 网格坐标>
 */
export function cellPositionsOfGrid(
  table: Node,
  tablePos = 0,
): Map<number, { rowIdx: number; colIdx: number }> {
  const out = new Map<number, { rowIdx: number; colIdx: number }>();
  // v0.13.1 需求2：位置累加必须与网格构建用**同一套裁剪口径**（带逻辑列上界的），
  // 否则被裁剪的空格没有条目 → cellCoordOf 查不到 → 拖拽选不中空单元格。
  const logicalCols = tableLogicalColumnCount(table, tablePos);
  // ① 逐行累加，得到每个（裁剪后的）cell 节点的 doc 起始位置
  const posOfNode = new Map<Node, number>();
  for (const ref of collectTableRows(table, tablePos)) {
    let acc = ref.pos + 1;
    for (const cell of trimRowTrailingEmpties(ref.row, logicalCols)) {
      posOfNode.set(cell, acc);
      acc += cell.nodeSize;
    }
  }
  // ② 用网格（唯一口径）反查每个主格的坐标
  const grid = buildTableGridFromTable(table, tablePos);
  for (const row of grid) {
    if (!row) continue;
    for (const gc of row) {
      if (!gc) continue;
      const pos = posOfNode.get(gc.node);
      if (pos !== undefined) out.set(pos, { rowIdx: gc.rowIdx, colIdx: gc.colIdx });
    }
  }
  return out;
}

/**
 * ③ 合并选区判定：给定若干 cell 的网格坐标，计算合并矩形。
 *
 * @param cells 网格坐标数组（至少 2 个）
 * @returns 合并矩形的行列范围；输入非法时 null
 */
export function computeMergeRect(
  cells: Array<{ rowIdx: number; colIdx: number }>,
): { r0: number; c0: number; r1: number; c1: number } | null {
  if (cells.length < 2) return null;
  let r0 = Infinity;
  let c0 = Infinity;
  let r1 = -Infinity;
  let c1 = -Infinity;
  for (const c of cells) {
    r0 = Math.min(r0, c.rowIdx);
    c0 = Math.min(c0, c.colIdx);
    r1 = Math.max(r1, c.rowIdx);
    c1 = Math.max(c1, c.colIdx);
  }
  if (!Number.isFinite(r0) || !Number.isFinite(c0)) return null;
  return { r0, c0, r1, c1 };
}

/**
 * 合并矩形内的 cell 数（按 grid 展开后的真实格子数，占位 null 不计）。
 * 用于「合并 N 个单元格」的提示与禁用判定。
 */
export function countCellsInRect(grid: TableGrid, rect: { r0: number; c0: number; r1: number; c1: number }): number {
  let n = 0;
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = rect.c0; c <= rect.c1; c++) {
      if (row[c]) n++;
    }
  }
  return n;
}

/**
 * 判定合并某矩形是否会**破坏既有合并**。
 *
 * 语义（这才是"能不能直接合并"的真正判据）：
 * 对网格中每个已占位的格子，算出它实际占据的矩形区域
 * （rowspan/colspan 展开后）。若该区域与目标矩形**相交**，
 * 且它不是「完整落在目标矩形内」→ 合并会把一个跨度格切碎，
 * 必须拒绝（提示先拆分）。
 *
 * 注意锚点格自身可以带跨度（它就是合并目标），只要它完整落在矩形内。
 */
export function rectContainsSpan(
  grid: TableGrid,
  rect: { r0: number; c0: number; r1: number; c1: number },
): boolean {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      // 只处理主格（占位 null 与主格重复项都跳过）
      if (!cell || cell.rowIdx !== r || cell.colIdx !== c) continue;
      const cr1 = cell.rowIdx + cell.rowspan - 1;
      const cc1 = cell.colIdx + cell.colspan - 1;
      // 与目标矩形相交？
      const intersects =
        cell.rowIdx <= rect.r1 && cr1 >= rect.r0 && cell.colIdx <= rect.c1 && cc1 >= rect.c0;
      if (!intersects) continue;
      // 完整落在目标矩形内 → 合并只是吞掉它，不算破坏
      const fullyInside =
        cell.rowIdx >= rect.r0 && cr1 <= rect.r1 && cell.colIdx >= rect.c0 && cc1 <= rect.c1;
      if (!fullyInside) return true;
    }
  }
  return false;
}

/**
 * 拆分：把某格的 colspan/rowspan 复位为 1。
 *
 * @returns 该格的新跨度（恒为 {1,1}）与是否需要事务；
 *          输入非法（无此格 / 已是普通格）时 null
 */
export function planSplit(cell: GridCell): CellSpan | null {
  if (!cell) return null;
  if (cell.colspan <= 1 && cell.rowspan <= 1) return null;
  return { colspan: 1, rowspan: 1 };
}

// ─── v0.13.2 返修：合并单元格回读后的「多余单元格」 ───────────────────────
//
// 用户实测：「表格合并正常，但关闭文档重新打开后，合并的那一行会多出一个单元格，
// 破坏表格整体结构。」
//
// 根因（markdown-it 的表格规则决定，见 `lib/rules_block/table.mjs`）：
//   · 表头行的**源管道格数** = `columnCount`；
//   · 数据行**恒定输出 `columnCount` 个 td**（`columns[i] ? ... : ''`），
//     源文里少写的列会被补成空单元格。
// 而合并序列化会**跳过被占位的空洞**（`| <td colspan="2">1</td> | 3 |` 只有 2 格，
// 或纵向合并时 `| 4 | 5 |` 只有 2 格）——于是回读时被补齐出来的空单元格
// 变成了 PM 文档里**真实存在的第 3 个 cell**：
//   · 横向合并行：多出的空格落在**逻辑列 ≥ columnCount**（被 colspan 挤出表外）；
//   · 纵向合并行：多出的空格正好落在**被 rowspan 占据的列**（占位符）。
// 两者在网格层都被识别（所以合并/序列化本身是对的），但**节点仍留在文档里**，
// 表格 NodeView 会把它渲染成一个真实单元格 → 用户看到"合并的那行多一格"。
//
// 修法：解析后把这些「补齐出来的尾巴」从文档里删掉（只删行尾、只删空普通格，
// 且必须命中上面两种判据之一）。纯管道表格没有跨度、逻辑列也不会超出 columnCount，
// 因此本函数对其**恒为空操作**（零 diff 回归锁不受影响）。

/**
 * 计算每一行应当丢弃的**行尾 cell 下标**（0-based，升序）。
 *
 * @param table     table 节点
 * @param tablePos  表格起始位置（仅用于行位置计算，传 0 亦可）
 */
export function planTableRowTrim(table: Node, tablePos = 0): number[][] {
  const rows = collectTableRows(table, tablePos);
  const columnCount = tableLogicalColumnCount(table, tablePos);
  const pending: boolean[][] = [];
  const plan: number[][] = rows.map(() => []);

  for (let r = 0; r < rows.length; r++) {
    if (!pending[r]) pending[r] = [];
    const occupied = pending[r];
    const cells: Node[] = [];
    rows[r].row.forEach((c) => cells.push(c));

    // 与 buildTableGrid 同一套「第一个空闲列」布点规则（口径必须唯一）
    const placed: Array<{ col: number; placeholder: boolean }> = [];
    let col = 0;
    for (const cell of cells) {
      const { colspan, rowspan } = spanOf(cell);
      if (col < occupied.length && occupied[col] && isEmptyPlainCell(cell)) {
        placed.push({ col, placeholder: true });
        col++;
        continue;
      }
      while (occupied[col]) col++;
      placed.push({ col, placeholder: false });
      for (let c = col; c < col + colspan; c++) occupied[c] = true;
      for (let rr = r + 1; rr < r + rowspan; rr++) {
        if (!pending[rr]) pending[rr] = [];
        for (let c = col; c < col + colspan; c++) pending[rr][c] = true;
      }
      col += colspan;
    }

    // 只裁**行尾**：占位符（rowspan 空洞）或逻辑列超出 columnCount 的空普通格
    const drop: number[] = [];
    for (let i = cells.length - 1; i >= 0; i--) {
      const p = placed[i];
      if (!p) break;
      if (p.placeholder) {
        drop.push(i);
        continue;
      }
      if (!isEmptyPlainCell(cells[i])) break;
      if (p.col < columnCount) break;
      drop.push(i);
    }
    plan[r] = drop.reverse();
  }
  return plan;
}

/**
 * 从表格节点里删掉 markdown-it 补齐出来的行尾空单元格（见上方根因说明）。
 *
 * @returns 新的 table 节点；无需裁剪时**返回原节点**（引用相等，调用方可据此跳过）
 */
export function trimTablePlaceholderCells(table: Node): Node {
  if (!tableHasSpan(table)) return table; // 纯管道表格零 diff
  const plan = planTableRowTrim(table, 0);
  if (!plan.some((d) => d.length > 0)) return table;

  let rowIdx = 0;
  const sections: Node[] = [];
  table.forEach((section) => {
    if (section.type.name !== "table_head" && section.type.name !== "table_body") {
      sections.push(section);
      return;
    }
    const rows: Node[] = [];
    section.forEach((row) => {
      const drop = plan[rowIdx] ?? [];
      rowIdx++;
      if (drop.length === 0) {
        rows.push(row);
        return;
      }
      const keep: Node[] = [];
      row.forEach((cell, _offset, index) => {
        if (!drop.includes(index)) keep.push(cell);
      });
      // 全被裁掉时保留一个空格（表格行不能为空）
      rows.push(row.type.create(row.attrs, keep.length > 0 ? keep : [row.child(0)]));
    });
    sections.push(section.type.create(section.attrs, rows));
  });
  return table.type.create(table.attrs, sections);
}
