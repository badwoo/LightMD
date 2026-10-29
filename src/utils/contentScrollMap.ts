/**
 * v0.15.0 需求7（R7a）：阅读模式 ↔ 编辑模式的**共享内容坐标系**（纯函数层）。
 *
 * ## 为什么要有这一层
 * 用户症状：「阅读模式下滚到某一节，切回编辑/分屏，眼前的内容完全不是那一节；
 * 切几次就漂到别处去了。」
 *
 * 旧实现按**滚动百分比**恢复（`planScrollRestore` / `applyScroll`）：
 * `scrollTop` 比例差不多，但两侧排版完全不同 —— 阅读侧表格/图片/代码块渲染后很高，
 * 源码侧同样的内容只有几行；同一个百分比指向的**内容**必然不同。设计稿 §3.1 因此
 * 明确「禁止用百分比一致作为通过条件」，要求切换后**同一个顶层块/标题**仍落在目标
 * 视口中央邻域。
 *
 * 本层就是两侧共用的坐标系：
 * - **采集**（`captureContentAnchor`）：把来源视口中央的顶层块 + 块内比例记成
 *   `ContentAnchor`（另带 headingId / sourceLine 作为跨渲染复算后的定位线索）；
 * - **恢复**（`restoreContentAnchor`）：在目标侧同一份 `BlockGeometry` 上反算
 *   `scrollTop`，把同一块的同一相对位置放回视口中央。
 *
 * ## 分层（与 `blockScrollAlign.ts` 同一套纪律）
 * - 本模块**只做算术与选择**：输入是 `BlockGeometry[]`（调用方实测/测算出的块几何），
 *   输出是数字或 null。无 React、无 DOM、无 import 副作用 → 可在 Node 环境精确单测；
 * - DOM 测量与 `scrollTop` 写入留在 `EditorContainer`（本任务不接线，由 Lead 做）。
 *
 * ## 与 `blockScrollAlign` 的复用关系
 * - `maxScrollOf` / `clamp` 从 `./blockScrollAlign` **抽取复用**（v0.14.0 时是模块私有，
 *   0.15.0 仅加 `export`，签名与行为不变），保证"可滚动上限"口径全局唯一；
 * - 分屏联动那份 `PreviewAnchorSet`（源码行 ↔ 预览锚点）是**行 → 块**的连续映射，
 *   本层是**块 → 块**的离散锚点 + 块内比例：两套坐标不同用途，不做二次映射，
 *   但同样遵守「按实测几何插值，不按线性百分比估算」（软换行/异步变高场景）。
 *
 * ## 三条硬纪律（设计稿 §3.2/§3.3）
 * 1. **无法映射返回 `null`，绝不返回 0 兜底**。旧实现 `newTop ?? 0` 正是"进度归零"
 *    的根因；调用方拿到 null 时应当**放弃本次写入**（保留原位 / 交给重试窗口），
 *    而不是写 0。
 * 2. **贴顶/贴底走专门分支**：两端由 `atTop` / `atBottom` 标志表示，恢复时直接落到
 *    0 / 可滚动上限；绝不用"把末尾的块硬摆到中央"来近似（那会把文末空行区域滚出
 *    视野，用户感知为"到底了又跳上去")。
 * 3. **折叠支持**：`visible === false` 的块一律跳过；被折叠块无法映射时**落到最近
 *    可见祖先标题**，再退到最近可见块，仍不可得才 null —— 绝不返回 0。
 *
 * ## 几何坐标约定
 * `BlockGeometry.top` / `height` 全部是**内容坐标系**（相对滚动内容顶部，px），
 * 与 `scrollTop` 同一口径：`块在视口中的顶部 = block.top - viewportTop`。
 * 调用方须传"当前实际测量值"（`getBoundingClientRect().top + scroller.scrollTop`），
 * 而不是任何按行号推算的估算值 —— 这是本层不做线性假设的前提。
 */

import { clamp, maxScrollOf } from "./blockScrollAlign";

/**
 * 一个顶层块的实测几何（内容坐标系）。
 *
 * `index` 必须与源码顶层块同源（`topLevelBlockStartLines` 的下标口径），
 * 这样两个模式（ProseMirror 阅读区 / iframe 或源码侧）才能谈"同一个块"。
 */
export interface BlockGeometry {
  /** 顶层块下标（与 `topLevelBlockStartLines` 同源） */
  index: number;
  /** 块顶部在内容坐标系中的偏移（px） */
  top: number;
  /** 块高（px；被折叠的块可为 0） */
  height: number;
  /** 是否可见（折叠生效时 `false` 表示被 `display:none` 隐藏） */
  visible: boolean;
  /**
   * 该块若是标题，其稳定锚点 id（沿用 `heading-id-sync.ts` 口径）。
   *
   * 定位优先级最高：内容被编辑（插入/删除前面的块）后 `blockIndex` 会整体位移，
   * 而标题 id 仍能指回同一节。
   */
  headingId?: string;
  /**
   * 标题级别（1~6；非标题块省略）。
   *
   * 本层**不参与**定位决策（"最近前置标题"就是包含该块的节标题，无需比较层级），
   * 但它是调用方接线的必要元数据：折叠集成时 `headingFold.expandAncestors` 需要
   * 知道祖先链的层级才能决定"展开到第几级"，因此随几何一起采集、随解析结果带出。
   * 见 `visibleHeadingChain`。
   */
  headingLevel?: number;
  /** 块的源码起始行（0-based；来自 `topLevelBlockStartLines`）。辅助校验/兜底用 */
  sourceLine?: number;
}

/**
 * 共享内容锚点：来源视口中央的顶层块 + 块内比例。
 *
 * 与设计稿 §1.2 的 `ContentAnchor`（撤销历史的 before/after 锚点）**同一形状**，
 * 可双向赋值（本类型只多了两个可选边缘标志，结构上仍是它的超集）。
 */
export interface ContentAnchor {
  /** 锚点块下标（采集时视口中央所在块） */
  blockIndex: number;
  /** 锚点块若是标题，则记下其稳定 id（定位优先级最高） */
  headingId?: string;
  /** 锚点内容点在该块内的比例（0~1；`block.top + ratio * block.height` 即内容点） */
  ratioWithinBlock: number;
  /** 锚点块的源码起始行（辅助校验：块表整体位移时用来纠偏） */
  sourceLine?: number;
  /**
   * 贴顶标志（v0.15.0 增补，专用分支）。
   *
   * 为什么不能只靠块内比例表达"贴顶"：贴顶时视口中央落在**第一屏中间**的某个块，
   * 按中央锚点恢复会把用户看到的"文档开头"推到屏幕下方 —— 用户预期继续贴顶。
   * 采集到 true 时恢复直接返回 0。
   */
  atTop?: boolean;
  /**
   * 贴底标志（v0.15.0 增补，专用分支）。
   *
   * 为什么必须单独表示：文末空行不产生块（预览渲染会吞掉），"视口中央块"在底部
   * 附近是**倒数第几个块**，按中央锚点恢复会停在末块中央而离底还有一段 ——
   * 用户刚滚到底、切模式后又"浮上来一截"。采集到 true 时恢复直接返回可滚动上限。
   */
  atBottom?: boolean;
}

/** `captureContentAnchor` 的可选覆盖项（不传则按几何自动判定贴顶/贴底） */
export interface CaptureContentAnchorOptions {
  /** 强制视为贴顶（恢复时落 0） */
  atTop?: boolean;
  /** 强制视为贴底（恢复时落可滚动上限；优先级高于 `atTop`） */
  atBottom?: boolean;
  /**
   * 调用方实测的内容总高（= 目标滚动容器的 `scrollHeight`）。
   *
   * 为什么需要覆盖：纯函数只能按"可见块最大底部"聚合，而真实 `scrollHeight` 含容器
   * padding 与块间外边距的尾部部分，两者通常差几 px ~ 几十 px。贴底/可滚动上限
   * 精确与否直接决定"切模式后是否离底一截"，故允许调用方用实测值覆盖。
   */
  contentHeight?: number;
}

/** `restoreContentAnchor` 的可选覆盖项（第 4 参，向后兼容） */
export interface RestoreContentAnchorOptions {
  /** 调用方实测的内容总高（= 目标滚动容器的 `scrollHeight`），覆盖块聚合值 */
  contentHeight?: number;
}

/**
 * 判定"贴顶/贴底"的像素容差。
 *
 * 与 `EditorContainer` 冻结窗口里的口径一致（2px）：浏览器对 `scrollTop` 会取整、
 * 亚像素滚动也会落在 ±1 附近，容差过小会漏判、过大则把"几乎到底"当成到底。
 */
export const CONTENT_ANCHOR_EDGE_TOLERANCE_PX = 2;

/**
 * 源码行校验容差（行）。
 *
 * `headingId` / `blockIndex` 命中后，若实测 `sourceLine` 与锚点记录的相差超过此值，
 * 视为"块表已因内容编辑而位移"，改用 `sourceLine` 重新定位并比较谁更接近。
 * 取 1 是因为空行/软换行可能让同一块的起始行漂 1 行，超过就不是同一块了。
 */
const SOURCE_LINE_TOLERANCE = 1;

/** 锚点块的定位途径（诊断用；也便于单测断言走了哪条优先级） */
export type AnchorResolveVia =
  | "heading" // headingId 命中（最高优先）
  | "index" // blockIndex 命中
  | "ancestor-heading" // 目标块被折叠 → 最近可见祖先标题
  | "nearest-visible" // 目标块被折叠且无可见祖先标题 → 最近可见块
  | "source-line"; // 兜底：按源码行反查

/** `resolveAnchorBlock` 的结果：落在哪个可见块、块内比例多少、走的哪条规则 */
export interface ResolvedContentAnchor {
  block: BlockGeometry;
  /** 块内比例（0~1）；跨块兜底时为 0（只对齐目标块顶部，不臆造块内位置） */
  ratio: number;
  via: AnchorResolveVia;
}

/** 数值可信（排除 NaN/Infinity/undefined） */
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 块是否可参与映射：`visible` 为真且几何可信 */
function isUsable(b: BlockGeometry | null | undefined): b is BlockGeometry {
  return !!b && b.visible === true && isNum(b.top) && isNum(b.height) && b.height >= 0;
}

/**
 * 解析"用于可滚动上限的内容总高"：优先用调用方实测 `scrollHeight`，否则按可见块聚合。
 *
 * 为什么允许覆盖：纯函数层拿不到容器 padding / 尾部外边距，块聚合值通常略小于真实
 * `scrollHeight`；贴底分支对它很敏感（差 20px 就是"离底一截"）。
 */
function resolveContentHeight(
  blocks: BlockGeometry[],
  override?: number,
): number {
  if (isNum(override) && override > 0) return override;
  return contentHeightOf(blocks);
}

/**
 * 内容总高（内容坐标系）：**可见块** `top + height` 的最大值。
 *
 * 只算可见块的原因（折叠语义）：被折叠的块是 `display:none`，**不占空间**。
 * 若把它的折叠前几何也算进来，总高会虚高，贴底分支就会滚到折叠内容留下的空白里
 * （用户看到"切模式后凭空多出一屏空白"）。可见块的最大底部就是真实内容底部的
 * 最佳纯函数近似（调用方若已知真实 `scrollHeight`，用 `contentHeight` 覆盖更精确，
 * 见 `CaptureContentAnchorOptions.contentHeight`）。
 */
export function contentHeightOf(blocks: BlockGeometry[]): number {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  let height = 0;
  for (const b of blocks) {
    if (!isUsable(b)) continue;
    const bottom = b.top + b.height;
    if (bottom > height) height = bottom;
  }
  return height > 0 ? height : 0;
}

/** 可见块（保持入参顺序） */
export function visibleBlocksOf(blocks: BlockGeometry[]): BlockGeometry[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => isUsable(b));
}

/** 可见块按内容坐标升序（同 top 时按 index 升序），供"Y → 块"二分使用 */
function sortedVisible(blocks: BlockGeometry[]): BlockGeometry[] {
  return visibleBlocksOf(blocks).sort((a, b) =>
    a.top === b.top ? a.index - b.index : a.top - b.top,
  );
}

/**
 * 在**非递减**的块顶部轴上二分：最后一个 `top <= y` 的块下标（返回数组下标）。
 * 表为空返回 -1；`y` 在首块之前返回 -1。
 */
function lastBlockAtOrBefore(tops: number[], y: number): number {
  if (tops.length === 0) return -1;
  if (y < tops[0]) return -1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 找到内容坐标 `y` 落在哪个**可见块**、块内比例多少。
 *
 * 三类边界（都返回非 null，因为"最近邻"总有语义）：
 * - `y` 在首块之前 → 首块 ratio 0（文档开头的空行区域：视觉上等于首块顶）；
 * - `y` 落在两块之间的空隙（块间外边距/空行被吞）→ 取前一块 ratio 1
 *   （"刚过这一块"），保证单调；
 * - `y` 越过末块底部 → 末块 ratio 1（文末尾部空行区域）。
 *
 * @returns 块与比例；无可见块或 `y` 非有限时 null
 */
export function findBlockAtY(
  blocks: BlockGeometry[],
  y: number,
): { block: BlockGeometry; ratio: number } | null {
  if (!isNum(y)) return null;
  const vis = sortedVisible(blocks);
  if (vis.length === 0) return null;
  const tops = vis.map((b) => b.top);
  const at = lastBlockAtOrBefore(tops, y);
  if (at < 0) return { block: vis[0], ratio: 0 };
  const block = vis[at];
  const height = Math.max(0, block.height);
  const ratio = height > 0 ? clamp((y - block.top) / height, 0, 1) : 0;
  return { block, ratio };
}

/**
 * 距离 `index` 最近的可见块（优先向前：内容流向上"同一节"更可能是前一块）。
 *
 * 用于"目标块被折叠、且其所在节没有可见标题"时的兜底：至少让目标视口贴着
 * 同一相邻内容，而不是 null / 0。
 */
export function findNearestVisible(
  blocks: BlockGeometry[],
  index: number,
): BlockGeometry | null {
  if (!Array.isArray(blocks) || !isNum(index)) return null;
  let before: BlockGeometry | null = null;
  let after: BlockGeometry | null = null;
  for (const b of blocks) {
    if (!isUsable(b) || !isNum(b.index)) continue;
    if (b.index <= index) {
      if (!before || b.index > before.index) before = b;
    } else if (!after || b.index < after.index) {
      after = b;
    }
  }
  return before ?? after;
}

/**
 * 目标块被折叠时，其**最近可见祖先标题**（严格在目标块之前，含目标块下标自身——
 * 目标块若正是那个标题则它不可能被判定为隐藏，故此参数等价于"index 之前"）。
 *
 * 祖先判定用"最近的前置标题"而不是按 level 向上收窄：
 * 折叠只按标题分节，最近的前置标题就是包含该块的节标题；跨节时它的 level 更浅，
 * 同样是对的落点（设计稿 §2.4/§3.2 的"落到最近可见祖先标题"）。
 *
 * 注意这与 `visibleHeadingChain`（返回**完整的**由外到内祖先链，供展开用）不同：
 * 本函数只回答"落点选哪一个"，链式展开由调用方决定。详见 `visibleHeadingChain`。
 */
export function findVisibleAncestorHeading(
  blocks: BlockGeometry[],
  index: number,
): BlockGeometry | null {
  if (!Array.isArray(blocks) || !isNum(index)) return null;
  let best: BlockGeometry | null = null;
  for (const b of blocks) {
    if (!isUsable(b) || !isNum(b.index)) continue;
    if (!b.headingId || b.index > index) continue;
    if (!best || b.index > best.index) best = b;
  }
  return best;
}

/**
 * 目标块之前的**可见标题链**（按文档顺序，从最外层到最内层）。
 *
 * ## 用途（Lead 接线的必备动作，设计稿 §2.3/§2.4）
 * 折叠生效时，`restoreContentAnchor` 只能落到"最近的可见祖先标题"，但如果用户
 * 切模式后想回到**被折叠的**那一节，必须先 `headingFold.expandAncestors` 展开祖先链
 * 再滚动 —— 否则目标块仍然是 `visible:false`，映射只能退化到标题。
 *
 * 本函数把"该展开哪些标题"算成纯数据（按 level 收窄的祖先链：遇到 level 更深的
 * 标题就压栈、更浅或相等的就弹栈），调用方拿 id 列表直接喂给折叠层即可。
 *
 * @returns 祖先标题（自外向内）；无标题块 / 目标块之前没有任何可见标题时返回空数组
 */
export function visibleHeadingChain(
  blocks: BlockGeometry[],
  index: number,
): BlockGeometry[] {
  if (!Array.isArray(blocks) || !isNum(index)) return [];
  const chain: BlockGeometry[] = [];
  for (const b of blocks) {
    if (!isUsable(b) || !isNum(b.index) || !b.headingId || b.index >= index) continue;
    const level = isNum(b.headingLevel) && b.headingLevel > 0 ? b.headingLevel : 1;
    // 弹出层级 >= 当前标题的祖先（它们是"上一条分支"）
    while (chain.length > 0) {
      const top = chain[chain.length - 1];
      const topLevel =
        isNum(top.headingLevel) && top.headingLevel > 0 ? top.headingLevel : 1;
      if (topLevel < level) break;
      chain.pop();
    }
    chain.push(b);
  }
  return chain;
}

/** 可见块里挑一个 index 最接近 `target` 的（同距离取更靠前的） */
function pickClosestByIndex(
  candidates: BlockGeometry[],
  target: number,
): BlockGeometry {
  if (!isNum(target) || candidates.length === 1) return candidates[0];
  let best = candidates[0];
  let bestGap = Math.abs(best.index - target);
  for (let i = 1; i < candidates.length; i++) {
    const gap = Math.abs(candidates[i].index - target);
    if (gap < bestGap || (gap === bestGap && candidates[i].index < best.index)) {
      best = candidates[i];
      bestGap = gap;
    }
  }
  return best;
}

/**
 * 按源码行反查块（`blockIndex`/`headingId` 都不可用，或需要纠偏时用）。
 *
 * 规则：取 `sourceLine <= 目标行` 的**最后一个可见块**（目标行所属块）；
 * 目标行在本表首块之前 → 首块。块内比例按"本块起始行 → 下一可见块起始行"线性
 * 插值 —— 这里允许按行插值，因为输入是**同一块表内的源码行**（不含软换行视觉
 * 高度），且只用于"块级兜底"，最终落点仍由块几何决定。
 */
function resolveBySourceLine(
  blocks: BlockGeometry[],
  sourceLine: number,
): ResolvedContentAnchor | null {
  if (!isNum(sourceLine)) return null;
  const vis = sortedVisible(blocks).filter((b) => isNum(b.sourceLine));
  if (vis.length === 0) return null;
  let at = 0;
  for (let i = 0; i < vis.length; i++) {
    if ((vis[i].sourceLine as number) <= sourceLine) at = i;
    else break;
  }
  const block = vis[at];
  const from = block.sourceLine as number;
  const next = vis[at + 1];
  const to = next ? Math.max(from + 1, next.sourceLine as number) : from + 1;
  const ratio = to > from ? clamp((sourceLine - from) / (to - from), 0, 1) : 0;
  return { block, ratio, via: "source-line" };
}

/**
 * `blockIndex` 直接命中可见块后，用 `sourceLine` 做**辅助校验**。
 *
 * 何时会不一致：模式切换期间目标侧可能因异步渲染（mermaid/katex 撑高、图片解码）
 * 产生中间态，或内容刚被编辑导致块表整体位移。此时"块下标相同但源码行差很远"
 * 说明下标已经不可信；改为按源码行重新定位，并只在**更接近**时才替换。
 */
function finalizeIndexMatch(
  blocks: BlockGeometry[],
  block: BlockGeometry,
  anchor: ContentAnchor,
  ratio: number,
): ResolvedContentAnchor {
  const direct: ResolvedContentAnchor = { block, ratio, via: "index" };
  if (!isNum(anchor.sourceLine) || !isNum(block.sourceLine)) return direct;
  const want = anchor.sourceLine as number;
  const got = block.sourceLine as number;
  const diff = Math.abs(got - want);
  if (diff <= SOURCE_LINE_TOLERANCE) return direct;
  const byLine = resolveBySourceLine(blocks, want);
  if (!byLine) return direct;
  const altGot = byLine.block.sourceLine as number;
  return Math.abs(altGot - want) < diff ? byLine : direct;
}

/**
 * 把锚点解析到一个**可见块 + 块内比例**（恢复的核心）。定位优先级：
 *
 * 1. `headingId`：标题 id 稳定，内容编辑后仍指回同一节（最高优先）；
 * 2. `blockIndex`：普通段落/代码块等无标题块的定位主力；命中后若带 `sourceLine`
 *    再做一次校验纠偏（见 `finalizeIndexMatch`）；
 * 3. 目标块被折叠（`visible:false`）→ 最近**可见祖先标题**；无则最近可见块；
 * 4. 以上都不成（块表整体换过 / 下标越界）→ 按 `sourceLine` 反查；
 * 5. 仍不可得 → **`null`**（调用方放弃写入，绝不当成 0）。
 *
 * 跨块兜底（祖先标题/最近可见块/源码行）一律用 `ratio = 0`：原块内比例只对原块
 * 有意义，套到别的块上会凭空造出一个视口位置 —— 只对齐目标块顶部即可。
 */
export function resolveAnchorBlock(
  blocks: BlockGeometry[],
  anchor: ContentAnchor | null | undefined,
): ResolvedContentAnchor | null {
  if (!Array.isArray(blocks) || !anchor) return null;
  const vis = sortedVisible(blocks);
  if (vis.length === 0) return null;

  const ratio = isNum(anchor.ratioWithinBlock)
    ? clamp(anchor.ratioWithinBlock, 0, 1)
    : 0;

  // ① headingId 优先（内容编辑后仍稳定；sourceLine 会被前面插入的内容推偏）
  if (anchor.headingId) {
    const matches = vis.filter((b) => b.headingId === anchor.headingId);
    if (matches.length > 0) {
      const picked = pickClosestByIndex(matches, anchor.blockIndex);
      // 标题块自身命中：保留块内比例（标题被采集成锚点时比例可能非 0）
      return {
        block: picked,
        ratio: picked.index === anchor.blockIndex ? ratio : 0,
        via: "heading",
      };
    }
  }

  /**
   * ② blockIndex（主力），命中后由 `finalizeIndexMatch` 用 `sourceLine` 做纠偏。
   *
   * v0.15.3 返修（缺陷 C）的**真正修法在这里的前置条件**：
   * 之前 PM 面采不到 `sourceLine`（`collectPmBlockGeometry` 没填），
   * 于是 `finalizeIndexMatch` 的校验**永远在第一步 `if (!isNum(...)) return direct`
   * 就放行** —— 纠偏形同虚设；一旦两侧下标口径不同（阅读面多出 126 个还原空行的
   * 结构段落），跨面定位就整体位移、再也纠不回来。
   * 现在 PM 面由 `src-line-tag` 贴标、且结构段落被剔除，双向都有 sourceLine，
   * 这条纠偏路径才真正生效（见下面 ⑤ 兜底）。
   */
  const direct = isNum(anchor.blockIndex)
    ? blocks.find((b) => b && b.index === anchor.blockIndex)
    : undefined;
  if (direct) {
    if (isUsable(direct)) {
      return finalizeIndexMatch(blocks, direct, anchor, ratio);
    }
    // ③ 目标块被折叠 → 最近可见祖先标题，其次最近可见块
    const ancestor = findVisibleAncestorHeading(blocks, anchor.blockIndex);
    if (ancestor) return { block: ancestor, ratio: 0, via: "ancestor-heading" };
    const nearest = findNearestVisible(blocks, anchor.blockIndex);
    if (nearest) return { block: nearest, ratio: 0, via: "nearest-visible" };
    return null;
  }

  // ④ sourceLine 兜底（块表换过 / 下标越界）
  const byLine = resolveBySourceLine(blocks, anchor.sourceLine as number);
  if (byLine) return byLine;

  // ⑤ 无法映射：返回 null（绝不返回 0）
  return null;
}

/**
 * 「块 + 其后的排版空隙」构成的**连续区域**（v0.15.1 需求3 第四次返修核心）。
 *
 * ## 为什么不能直接用块的 `height`
 *
 * 两个渲染面的"块高"口径不同：
 * - 阅读面（PM）：`height` = 元素 `getBoundingClientRect().height`，**不含**外边距 →
 *   块与块之间留着真实空隙（`.ProseMirror p` 的段间距等）；
 * - 源码面（textarea）：`blockGeometryFromLineAxis` 让每块延伸到**下一块起始行**，
 *   空行/margin 被算进上一块 → 块与块**首尾相接**。
 *
 * 于是"块内比例"在两套排版里不可比：视口中央落在 PM 的空隙里时，
 * `findBlockAtY` 只能把比例钳到前一块的 `1`，空隙里那段真实偏移被抹掉。
 * 实机表现（v0.15.1 探针）：把视口停在段落空隙里往返切换一次，阅读面
 * `scrollTop` 一次性跳 11px（不累积，但"切一下视野挪了一行"）。
 *
 * ## 口径
 *
 * 取「本块顶 → **下一可见块**顶」为一个连续区域，比例在区域内连续：
 * 空隙因此被算进前一块的区域（与源码面的块高口径一致），两侧归一化方式相同 →
 * 同一几何内往返**像素级幂等**，跨排版时也不会在空隙处丢一段。
 *
 * 末块没有"下一块"，沿用自身 `height`（其后是文末空白，由 `atBottom` 分支负责，
 * 不在这里臆造延伸——否则贴底精度会被内容高估计误差污染）。
 *
 * ⚠️ 只在本模块的**采集/恢复**内部使用：`findBlockAtY` 的对外语义
 * （"空隙 → 前一块 ratio=1"）保持不变，那是被单测锁定的契约。
 */
interface ContentRegion {
  block: BlockGeometry;
  top: number;
  /** 区域高度：块顶 → 下一可见块顶（末块用自身 height） */
  extent: number;
}

function contentRegionsOf(blocks: BlockGeometry[]): ContentRegion[] {
  const vis = sortedVisible(blocks);
  const out: ContentRegion[] = [];
  for (let i = 0; i < vis.length; i++) {
    const block = vis[i];
    const next = vis[i + 1];
    const rawExtent = next ? next.top - block.top : Math.max(0, block.height);
    out.push({ block, top: block.top, extent: Number.isFinite(rawExtent) ? Math.max(0, rawExtent) : 0 });
  }
  return out;
}

/** 区域表里定位内容坐标 `y`（非递减 `top` 上二分；`y` 在首块前 → 首区 ratio 0） */
function regionAtY(
  regions: ContentRegion[],
  y: number,
): { region: ContentRegion; ratio: number } | null {
  if (!isNum(y) || regions.length === 0) return null;
  const tops = regions.map((r) => r.top);
  const at = lastBlockAtOrBefore(tops, y);
  if (at < 0) return { region: regions[0], ratio: 0 };
  const region = regions[at];
  const ratio = region.extent > 0 ? clamp((y - region.top) / region.extent, 0, 1) : 0;
  return { region, ratio };
}

/**
 * **采集**内容锚点：来源视口中央所在块 + 块内比例；贴顶/贴底走专门分支。
 *
 * ## 为什么锚视口中央
 * 用户判断"我读到哪了"看的是屏幕中间那一段，不是屏幕顶部（顶部那块往往只露出
 * 半行）。`viewport.ts` 的 `captureTextAnchor(ta, clientHeight/2)` 在同一版里也是
 * 这个口径（预览开合保持"眼前中间的内容"），本层与之对齐。
 *
 * ## 贴顶/贴底
 * 两端不能退化成中央锚点：贴顶时中央块在"第一屏中间"，恢复后文档开头会掉到
 * 屏幕下半部；贴底时末块不一定伸到视口底（文末空行被吞），恢复后会"离底一截"。
 * 因此采集时记 `atTop` / `atBottom` 标志，恢复时直接落 0 / 可滚动上限。
 *
 * @param blocks      顶层块几何（内容坐标系，调用方实测）
 * @param viewportTop 当前 `scrollTop`（内容坐标）
 * @param viewportHeight 视口高（`clientHeight`）
 * @param opts        显式覆盖贴顶/贴底判定（不传则按几何自动判定）
 * @returns 锚点；**内容不足一屏 / 几何不可信 / 全块隐藏时返回 null**
 *   （无映射需求，调用方保持原位即可）
 */
export function captureContentAnchor(
  blocks: BlockGeometry[],
  viewportTop: number,
  viewportHeight: number,
  opts?: CaptureContentAnchorOptions,
): ContentAnchor | null {
  if (!Array.isArray(blocks) || !isNum(viewportTop)) return null;
  if (!isNum(viewportHeight) || viewportHeight <= 0) return null;
  const vis = sortedVisible(blocks);
  if (vis.length === 0) return null;
  const contentHeight = resolveContentHeight(blocks, opts?.contentHeight);
  if (!(contentHeight > 0)) return null;
  const maxScroll = maxScrollOf(contentHeight, viewportHeight);
  // 内容不足一屏：没有可滚动的映射空间，锚点无意义（恢复侧也只会得到 0）
  if (maxScroll <= 0) return null;

  const top = clamp(viewportTop, 0, maxScroll);
  const edge = CONTENT_ANCHOR_EDGE_TOLERANCE_PX;
  const atTop = typeof opts?.atTop === "boolean" ? opts.atTop : top <= edge;
  const atBottom =
    typeof opts?.atBottom === "boolean" ? opts.atBottom : top >= maxScroll - edge;

  const centerY = top + viewportHeight / 2;
  /**
   * v0.15.1 需求3（第四次返修）：中央按**连续区域**（本块顶 → 下一块顶）取比例，
   * 而不是按元素 rect 高 —— 否则中央落在块间空隙时比例被钳成 1，空隙宽度丢失，
   * 往返切换一次视野就跳一个空隙（实测 11px）。
   */
  const regions = contentRegionsOf(blocks);
  const hit = regionAtY(regions, centerY) ?? { region: regions[0], ratio: 0 };
  return {
    blockIndex: hit.region.block.index,
    headingId: hit.region.block.headingId,
    // 保留原始浮点比例：往返恒等依赖"同一份几何下 ratio 不变"
    ratioWithinBlock: hit.ratio,
    sourceLine: isNum(hit.region.block.sourceLine) ? hit.region.block.sourceLine : undefined,
    atTop,
    atBottom,
  };
}

/**
 * 从**实测按行轴**反推源码/预览侧每个顶层块的几何（内容坐标系）。
 *
 * ## 为什么需要这个适配器
 * 设计稿 §3.2 明确：「空行/软换行：源码侧沿用 `measureSourceLineAxis`（含 `scrollHeight`
 * 缓存键），阅读侧用真实 block rect；不再用线性百分比估算。」
 *
 * 阅读侧（PM / iframe）可以直接量每个块的 `getBoundingClientRect()` —— 那边每块都是
 * 真实 DOM 元素。但**源码侧（textarea）没有任何子元素**，只能靠
 * `blockScrollAlign.measureSourceLineAxis` 量到"每个块起始行的真实 Y"（mirror div，
 * 软换行感知）。于是这里把「块起始行 → 实测顶部」还原成 `BlockGeometry`：
 *
 * - 块的 `top` = 该块起始行的实测行顶（轴上的值）；
 * - 块的 `height` = 下一块起始行的实测行顶 − 本块起始行行顶（最后一块用内容高收尾）；
 * - **块间空隙按行空间的真实比例**计入上一块的高度（而不是按逻辑行数线性分摊）——
 *   这正是"软换行段落比短段落高得多"能被如实表达的原因。
 *
 * 之所以不用线性百分比：长行软换行后视觉行数 ≠ 逻辑行数，线性估算实测偏 10 个块。
 *
 * @param args.totalLines   源码逻辑行数（`lineAxis.length` 应与之一致；不一致时返回 null）
 * @param args.lineAxis     实测按行轴（`measureSourceLineAxis(...).axis`；非递减）
 * @param args.blockLines   顶层块起始行（`topLevelBlockStartLines`，升序）
 * @param args.contentHeight 实测内容总高（scrollHeight）；用于最后一块收尾
 * @param args.maxScroll    可滚动上限（可选；仅用于标记"几何可信"，不参与计算）
 * @returns 块几何数组；数据不可用（轴长度不符 / 无有效块行）时 **null**
 */
export function blockGeometryFromLineAxis(args: {
  totalLines: number;
  lineAxis: number[] | null | undefined;
  blockLines: number[];
  contentHeight: number;
  maxScroll?: number;
}): BlockGeometry[] | null {
  const { lineAxis, blockLines, contentHeight } = args;
  const total = Math.floor(args.totalLines);
  if (!Array.isArray(lineAxis) || lineAxis.length < 2) return null;
  if (total <= 1 || lineAxis.length !== total) return null;
  if (!Array.isArray(blockLines) || blockLines.length === 0) return null;
  if (!isNum(contentHeight) || contentHeight <= 0) return null;

  // 有效块行：整数、在 [0, total-1] 内、严格递增（同一行被两个块占用时取首个）
  const lines: number[] = [];
  for (const raw of blockLines) {
    const line = Math.floor(raw);
    if (!Number.isFinite(line) || line < 0 || line >= total) continue;
    if (lines.length > 0 && line <= lines[lines.length - 1]) continue;
    lines.push(line);
  }
  if (lines.length === 0) return null;

  const out: BlockGeometry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const top = lineAxis[line];
    if (!isNum(top)) return null;
    const nextTop =
      i + 1 < lines.length ? lineAxis[lines[i + 1]] : contentHeight;
    if (!isNum(nextTop)) return null;
    out.push({
      index: i,
      top: Math.max(0, top),
      height: Math.max(0, nextTop - Math.max(0, top)),
      visible: true,
      sourceLine: line,
    });
  }
  // 防御：测量噪声可能让 top 回退 → 强制非递减并重算高度
  let prevTop = 0;
  for (const b of out) {
    if (b.top < prevTop) b.top = prevTop;
    prevTop = b.top;
    if (!(b.height >= 0)) b.height = 0;
  }
  // 最后一块必须延伸到内容底（否则贴底/尾部锚点会落在半空）
  const last = out[out.length - 1];
  last.height = Math.max(last.height, Math.max(0, contentHeight - last.top));
  return out;
}

/**
 * **恢复**内容锚点：算出"把锚点内容点放回视口中央"所需的 `scrollTop`。
 *
 * 三种口径（与设计稿 §3.2/§3.3 一致）：
 * - `atBottom` → 可滚动上限（`contentHeight - viewportHeight`，贴底语义）；
 * - `atTop` → 0（贴顶语义）；
 * - 其余 → `block.top + ratio * block.height - viewportHeight / 2`，钳到 `[0, max]`。
 *
 * ## 为什么必须可能返回 null
 * 设计稿 §3.3 与 `planScrollRestore` 的既有契约：**容器不可滚动/无法定位时绝不写 0**。
 * 旧实现 `newTop ?? 0` 让"阅读 50% → 切编辑"掉到顶部（P1 实测）。这里区分得很干净：
 * - 映射成功 → 返回数值（内容不足一屏时是合法的 0，因为唯一位置就是顶部）；
 * - 映射失败 → **null**，调用方放弃写入并进入重试窗口。
 *
 * @param blocks      目标侧顶层块几何（内容坐标系，调用方实测）
 * @param anchor      `captureContentAnchor` 的结果（允许来自其它模式/历史快照）
 * @param viewportHeight 目标视口高（`clientHeight`）
 * @param opts        可选：实测 `contentHeight` 覆盖（贴底精度）
 * @returns 目标 `scrollTop`；无法映射返回 **null**
 */
export function restoreContentAnchor(
  blocks: BlockGeometry[],
  anchor: ContentAnchor | null | undefined,
  viewportHeight: number,
  opts?: RestoreContentAnchorOptions,
): number | null {
  if (!Array.isArray(blocks) || !anchor) return null;
  if (!isNum(viewportHeight) || viewportHeight <= 0) return null;
  const contentHeight = resolveContentHeight(blocks, opts?.contentHeight);
  if (!(contentHeight > 0)) return null;
  const maxScroll = maxScrollOf(contentHeight, viewportHeight);

  // 贴底专用分支（优先级高于贴顶：内容不足一屏时两者都为 0，无歧义）
  if (anchor.atBottom === true) return maxScroll;
  // 贴顶专用分支
  if (anchor.atTop === true) return 0;

  const resolved = resolveAnchorBlock(blocks, anchor);
  // ★ 无法映射 → null，绝不 0 兜底
  if (!resolved) return null;
  /**
   * v0.15.1 需求3（第四次返修）：比例按**连续区域**（块顶 → 下一块顶）换算，
   * 与 `captureContentAnchor` 同一口径。用元素 rect 高会让"空隙里的比例"在
   * 阅读面（rect 高、有空隙）与源码面（块高含空行、无空隙）之间来回丢一个空隙，
   * 实测表现为"往返切换一次视野跳 11px"。
   */
  const region = contentRegionsOf(blocks).find((r) => r.block.index === resolved.block.index);
  const extent = region ? region.extent : Math.max(0, resolved.block.height);
  const contentPoint = resolved.block.top + resolved.ratio * extent;
  return clamp(contentPoint - viewportHeight / 2, 0, maxScroll);
}

// ─── v0.15.0 需求（阅读↔编辑内容对齐）：DOM 侧块几何采集 ────────────────
//
// 为什么要单独一层：本模块其余部分是**纯函数**（入参出参、Node 可测）；
// 而"从真实 DOM 量出 BlockGeometry[]"必然要碰 DOM。把它关在下面两个函数里，
// 保持核心算法可在无 DOM 环境完整单测（已有 52 用例覆盖算法本身）。
//
// 两个渲染面的口径差异（踩过坑，必须按面区分）：
// - PM 阅读面：`.ProseMirror > *`；标题 id 取自 `data-lmd-fold-id`（折叠装饰写入）
//   或 `heading-id-sync` 生成的 `id` 属性。
// - iframe 预览面：`body > *`，且**必须过滤非内容节点**（`<script>`、mermaid 的
//   `.mermaidTooltip` 等），否则下标与 `topLevelBlockStartLines` 错位 —— 复用
//   `blockScrollAlign.isAnchorablePreviewChild` 的同一判据，不再复制一份。

/**
 * v0.15.3 返修（缺陷 C）：结构段落（解析期还原空行 / 尾部补位）在 DOM 上的标记属性。
 *
 * 与 `schema.ts` 的 `paragraph.toDOM` 和 `trailing-paragraph.ts` 的补位段落
 * 保持同一份字符常量（避免拼写漂移）。
 */
const EMPTY_LINE_ATTR = "data-lmd-empty-line";
/** 末尾补位段落（`trailing-paragraph.ts` 的 `pad`）在 DOM 上的标记属性 */
const PAD_ATTR = "data-lmd-pad";
/** 顶层块的源码起始行（`src-line-tag.ts` 贴标写入；iframe 面用 `data-src-line`） */
const SRC_LINE_ATTR = "data-src-line";

/** 该顶层元素是否"结构填充段落"（不参与跨面块索引） */
function isStructuralFillElement(el: Element): boolean {
  return el.hasAttribute(EMPTY_LINE_ATTR) || el.hasAttribute(PAD_ATTR);
}

/** PM 阅读面：把顶层块量成 BlockGeometry[]（scrollTop 为 0 时的内容坐标） */
export function collectPmBlockGeometry(
  scroller: Element | null | undefined,
  opts?: {
    /**
     * v0.15.3 返修（缺陷 C）：**是否跳过结构填充段落**（默认 `true`）。
     *
     * ## 为什么必须跳过（「双击 Ctrl 切模式文档没有对齐」的真因）
     * 解析器为还原原文空行会在顶层插空段落（段间 `\n\n\n` → 多 1 个；
     * 末尾空行同理），而另一侧的块表（`topLevelBlockStartLines` /
     * iframe `data-src-line` / 源码行轴块表）**只统计真实渲染块**。
     * 若不跳过，两侧 `index` 会**逐块累积错位**：
     * 实测用户文档 `LightMD开发需求.md` —— PM 顶层 **429** 块（其中 **126** 个是
     * 空行段落），另一侧只有 **303** 块。跨面按 `blockIndex` 定位必然越走越偏，
     * 越界后只能退回百分比（实测阅读面 `scrollTop` 31330 → 21898，偏 9432px）。
     *
     * 判据用 DOM 上的 `data-lmd-empty-line` / pad 标记（`toDOM` 写入），
     * **不用"是否空段落"** —— 用户自己敲出来的空段落也是"空"，但它**是真实块**
     * （另一侧同样会渲染出一个空块），不能排除。
     */
    skipStructuralFill?: boolean;
  },
): BlockGeometry[] | null {
  if (!scroller) return null;
  const root = scroller.querySelector?.(".ProseMirror") as HTMLElement | null;
  if (!root) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  // 内容坐标 = 元素相对 scroller 视口的 top + 当前 scrollTop
  const scrollTop = Number((scroller as HTMLElement).scrollTop) || 0;
  const skipFill = opts?.skipStructuralFill !== false;
  const out: BlockGeometry[] = [];
  let index = 0;
  for (const el of Array.from(root.children) as HTMLElement[]) {
    // v0.15.3（缺陷 C）：跳过结构填充段落（emptyLine / pad）—— 它们不参与跨面块索引
    if (skipFill && isStructuralFillElement(el)) continue;
    const rect = el.getBoundingClientRect();
    if (!(rect.height >= 0)) continue;
    const top = rect.top - scrollerRect.top + scrollTop;
    const headingId = el.getAttribute("data-lmd-fold-id") || el.id || undefined;
    const levelRaw = el.tagName && /^H([1-6])$/.exec(el.tagName);
    /**
     * v0.15.3（缺陷 C 配套）：**给 PM 面补上 `sourceLine`**。
     *
     * 之前只有 iframe 面有（`data-src-line`）、源码面有（`blockGeometryFromLineAxis`），
     * PM 面没有 → 从阅读面采集的锚点缺这道跨面权威坐标：
     * `finalizeIndexMatch` 的校验永远直接放行、④ `resolveBySourceLine` 兜底永远不可用。
     * 补上之后，一旦 `blockIndex` 口径不一致（例如上面那些结构段落），
     * 两条纠偏路径都能按**源码行**把位置拉回来。
     */
    const srcLineRaw = el.getAttribute(SRC_LINE_ATTR);
    const srcLine = srcLineRaw === null ? undefined : Number(srcLineRaw);
    out.push({
      index,
      top,
      height: rect.height,
      // 折叠块 display:none → height 0；未加载图片也可能 0，
      // 折叠属性是更明确的判据，优先用它
      visible: !el.hasAttribute("data-lmd-fold-hidden") && rect.height > 0,
      headingId,
      headingLevel: levelRaw ? Number(levelRaw[1]) : undefined,
      sourceLine: Number.isFinite(srcLine as number) ? (srcLine as number) : undefined,
    });
    index++;
  }
  return out.length > 0 ? out : null;
}

/** iframe 预览面：把 body 顶层块量成 BlockGeometry[]（过滤脚本/浮层） */
export function collectIframeBlockGeometry(
  doc: Document | null | undefined,
  opts?: { isAnchorable?: (tagName: string, className?: string | null) => boolean },
): BlockGeometry[] | null {
  const body = doc?.body;
  if (!body) return null;
  const scroller =
    (doc.scrollingElement ?? doc.documentElement ?? body) as HTMLElement;
  const view = doc.defaultView;
  if (!view) return null;
  const scrollTop = Number(scroller.scrollTop) || 0;
  const isAnchorable = opts?.isAnchorable ?? (() => true);
  const out: BlockGeometry[] = [];
  let index = 0;
  for (const el of Array.from(body.children) as HTMLElement[]) {
    if (!isAnchorable(el.tagName, typeof el.className === "string" ? el.className : null)) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    const headingId = el.getAttribute("data-lmd-fold-id") || el.id || undefined;
    const levelRaw = /^H([1-6])$/.exec(el.tagName);
    out.push({
      index,
      // ⚠️ 这里**只加 scrollTop、不减 scrollerRect.top**（与 PM 面不同）：
      // iframe 的 scroller 是根元素，`getBoundingClientRect().top === -scrollTop`
      // （根元素随滚动整体上移），再减一次等于 `rect.top + 2*scrollTop`
      // —— 正是 v0.13.2 实测踩过并修掉的"越滚越偏、反算回左屏变 0"。
      // 元素 rect 本就相对 iframe 视口，加 scrollTop 即内容坐标。
      top: rect.top + scrollTop,
      height: rect.height,
      // 折叠块 display:none → height 0；未加载图片也可能 height 0，
      // 折叠属性是更明确的判据，优先用它（字面量，避免反向 import 折叠模块）
      visible: !el.hasAttribute("data-lmd-fold-hidden") && rect.height > 0,
      headingId,
      headingLevel: levelRaw ? Number(levelRaw[1]) : undefined,
      sourceLine: el.dataset?.srcLine ? Number(el.dataset.srcLine) : undefined,
    });
    index++;
  }
  return out.length > 0 ? out : null;
}

/**
 * v0.15.0 需求（阅读↔编辑内容对齐）：把内容锚点换回 **textarea 的 scrollTop**。
 *
 * 源码面没有子元素可量，只能借实测按行轴（`measureSourceLineAxis`）还原块几何；
 * 这里的 `blockGeometryFromLineAxis` 由调用方传入已算好的块几何（含缓存），
 * 本函数只负责"取块几何 → 恢复锚点 → 返回 scrollTop"。
 *
 * @returns 目标 scrollTop；块几何不可用或无法映射时 null（**绝不返回 0**）
 */
export function restoreTextareaContentAnchor(
  blocks: BlockGeometry[] | null | undefined,
  anchor: ContentAnchor | null | undefined,
  metrics: { scrollHeight: number; clientHeight: number },
): number | null {
  if (!blocks || !anchor) return null;
  if (!(metrics.clientHeight > 0)) return null;
  return restoreContentAnchor(blocks, anchor, metrics.clientHeight, {
    contentHeight: metrics.scrollHeight,
  });
}
