/**
 * v0.13.0 需求9：大纲面板标题折叠（纯逻辑层）。
 *
 * ## 范围边界（用户已确认）
 *
 * **只做大纲面板折叠**，编辑区折叠推迟到 0.14.0——折叠区间内的光标/选区/删除
 * 边界处理风险明显更高。
 *
 * ## 约定
 *
 * - 折叠态以「被折叠标题的 pos」为键（pos 在文档未变时稳定，文本变化时由
 *   `extractHeadings` 重新提取自然失效）；
 * - 折叠**不持久化**（不新增存储 key，重开文档重置）；
 * - 折叠态下搜索/过滤/拖拽**照常工作**（过滤优先于折叠：命中的标题即使在被
 *   折叠的子树里也会显示，否则「搜索不到内容」比「不折叠」更难理解）。
 */

/** 一个可折叠的大纲节点 */
export interface OutlineNode {
  /** 标题在文档中的位置（唯一键） */
  pos: number;
  /** 标题级别 1~6 */
  level: number;
}

/**
 * 计算每个标题应当显示还是隐藏。
 *
 * 规则：从第一个标题开始顺序扫描，维护一个「折叠栈」——遇到**可见**且被折叠的
 * 标题 H 后压入 H.level；所有级别 > 栈顶的后续标题被隐藏，直到遇到级别 <= 栈顶
 * 的标题（它与某个折叠祖先同级或更高），此时弹栈（可能连续弹多级）。
 *
 * v0.13.0 返修：旧实现用一个**标量** `hiddenBelow` 表示「当前生效的折叠级别」，
 * 无法表达「多层折叠同时生效」。当被折叠的节点本身又落在外层折叠的隐藏区间内时，
 * 标量会被这个隐藏节点**收窄**，导致外层折叠提前失效：
 *   nodes = H1@0(L1), H3@10(L3), H2@20(L2), H1@30(L1)，collapsed = {0, 10}
 *   旧结果：H2@20 被判为**可见**（H1@0 明明还折叠着，H2 必须隐藏）
 *   新结果：H2@20 隐藏 ✓
 * 另外，隐藏节点自身的折叠态不应生效（它根本不可见），否则会收窄外层区间。
 *
 * @param nodes 全部标题（按文档顺序）
 * @param collapsed 被折叠标题的 pos 集合
 * @returns pos → 是否可见
 */
export function computeOutlineVisibility(
  nodes: OutlineNode[],
  collapsed: ReadonlySet<number>,
): Map<number, boolean> {
  const visible = new Map<number, boolean>();
  /** 生效中的折叠级别栈（自浅至深） */
  const stack: number[] = [];
  for (const node of nodes) {
    // 弹出不再管辖本节点的折叠级别（本节点不比它更深）
    while (stack.length > 0 && node.level <= stack[stack.length - 1]) stack.pop();
    const isHidden = stack.length > 0;
    visible.set(node.pos, !isHidden);
    // 只有可见的被折叠标题才生效
    if (!isHidden && collapsed.has(node.pos)) stack.push(node.level);
  }
  return visible;
}

/**
 * 切换某个标题的折叠态（返回新的集合，不改原集合）。
 */
export function toggleCollapsed(
  collapsed: ReadonlySet<number>,
  pos: number,
): Set<number> {
  const next = new Set(collapsed);
  if (next.has(pos)) next.delete(pos);
  else next.add(pos);
  return next;
}

/**
 * 该标题是否能被折叠（没有子级就无需折叠箭头）。
 *
 * @param nodes 全部标题
 * @param index 该标题在 nodes 中的下标
 */
export function canCollapse(nodes: OutlineNode[], index: number): boolean {
  const node = nodes[index];
  if (!node) return false;
  const next = nodes[index + 1];
  return !!next && next.level > node.level;
}

/**
 * 折叠态下过滤搜索结果时，是否需要临时展开命中的子树。
 *
 * 约定：**过滤优先于折叠**——搜索时忽略折叠态，命中的标题一律显示。
 * 这样「搜不到」永远不会因为折叠而发生。无关键字时才应用折叠。
 */
export function shouldApplyCollapse(query: string): boolean {
  return query.trim() === "";
}
