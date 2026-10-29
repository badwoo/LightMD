/**
 * v0.15.3 返修 —— **文本变更下的字符偏移重映射 + 源码面滚动恢复决策**（纯逻辑，无 DOM / 无 React）。
 *
 * ## 为什么需要（两个实机缺陷的共同底层）
 *
 * ### 缺陷 1：跨模式撤销后源码面「贴底」
 * 用户在**阅读模式（ProseMirror）**里编辑几步 → 切到**源码模式** → 按 Ctrl+Z。
 * 统一时间线（`services/documentHistory`）里那条条目是 PM 条目，
 * `HistoryEntry.beforeSelection` 是 **undefined**（PM 侧只有 `beforeAnchor`，而
 * `buildAnchor` 至今没接线，见 `editorHstory/pmAdapter.ts` 的注释）。
 * 于是 `EditorContainer.applyHistoryText` 源码分支的 `if (sel)` 不成立 →
 * **完全不恢复滚动位置**；而 `setSourceContent(更短文本)` 让 `scrollHeight` 变小，
 * 浏览器把 `scrollTop` 钳到新 max =**贴底**。
 * 实机取证（打包产物 v0.15.2，`scripts/v0153-probe-undo-big.mjs`）：
 * 撤销前 `ta.scrollTop=21531 / max=21948`，撤销后 `top=21112 / max=21113`
 * —— 距底 **1px**，61 帧采样里 **57 帧贴底**；接着切回阅读面
 * `top=11485 / max=11485`（全贴底）。这就是用户报的「撤销/恢复文档会抖动」
 * 与「双击 Ctrl 漂移」的直接来源（贴底之后再切模式，内容锚点已经被钳坏）。
 *
 * ### 缺陷 2：不同长度的历史条目无法用像素恢复
 * 源码面历史条目记录的是 **`scrollTop` 像素**（`sourceAdapter.ts` 的
 * `beforeSelection.scrollTop`）。而撤销会把文本改成**别的长度**，
 * 同一像素在变短后的文本上指向完全不同的内容（语义地图 §4-31 已踩过同款，
 * 实测同像素偏移 1152 / 3744px）。所以像素只在「文本长度不变」时可信。
 *
 * ## 解法：锚**内容**，不锚像素
 * 1. 写入**之前**：`captureTextAnchor(textarea, clientHeight/2)` 拿
 *    `{ offset, viewportY }` —— `offset` 是 textarea.value 里的**字符偏移**；
 * 2. 用 `remapOffsetAcrossTextChange` 把这个 offset 从「写入前的文本」映射到
 *    「写入后的文本」（字符偏移不随排版、字号、软换行、文档长度变化）；
 * 3. 写入**之后**：`restoreTextAnchor(textarea, { offset 重映射后, viewportY })`
 *    把那一行字符拉回原来的视口 Y；
 * 4. 只有「文本长度不变」时才允许退回像素，且**永不写 0**（写 0 是"丢进度"的老 bug）。
 */

/** 源码面滚动恢复的决策结果 */
export type SourceScrollRestoreDecision =
  | { kind: "anchor"; anchor: { offset: number; viewportY: number } }
  | { kind: "pixel"; scrollTop: number }
  | { kind: "none" };

/**
 * 把字符偏移从 `fromText` 重映射到 `toText`。
 *
 * ## 语义（用「公共前缀 + 公共后缀」定义唯一的最小变更区间）
 *
 * 令 `P` = 两串公共前缀长度，`S` = 两串公共后缀长度（并夹到不越过 `P`，
 * 避免「aaaa」→「aa」这类前后缀重叠导致区间算反）。于是变更区间是：
 * - 删除侧：`[P, fromText.length - S)`
 * - 插入侧：`[P, toText.length - S)`
 *
 * 三条规则：
 * - `offset <= P`：变更点之前（**含**变更区间起点）→ 原地不动；
 * - `offset >= fromText.length - S`：落在尾部未变部分 → 整体平移
 *   `offset - (fromText.length - toText.length)`；
 * - 其余（`offset` 落在被替换的那段里）→ 贴到变更区间起点 `P`。
 *   为什么是 `P` 而不是「按比例」：被替换区间里**没有**可靠的内容对应关系，
 *   按比例会凭空造出一个位置（比贴边更糟）。贴边至少保证「离用户眼前内容最近」。
 *
 * ## 边界
 * - `offset` 越界 → clamp；
 * - `fromText === toText` → 原样返回；
 * - 任一为空串 → 由前缀/后缀规则自然得出（纯插入 → `P` = 0 或前缀长；纯删除 →
 *   尾部整体左移），不需要特判；
 * - CRLF / CJK / base64 长串都按**码元**处理（与 `textarea.selectionStart` 同口径，
 *   `\r` 也各算 1 —— 这是 textarea 的真实行为，别按"字符"算）。
 */
export function remapOffsetAcrossTextChange(
  offset: number,
  fromText: string,
  toText: string,
): number {
  const from = String(fromText ?? "");
  const to = String(toText ?? "");
  const fromLen = from.length;
  const toLen = to.length;
  if (fromLen === 0) return clampOffset(offset, toLen);
  if (toLen === 0) return 0;
  if (from === to) return clampOffset(offset, toLen);

  // 公共前缀
  let p = 0;
  const minCommon = Math.min(fromLen, toLen);
  while (p < minCommon && from.charCodeAt(p) === to.charCodeAt(p)) p++;

  // 公共后缀（不得越过前缀，避免重叠）
  let s = 0;
  const suffixLimit = minCommon - p;
  while (
    s < suffixLimit &&
    from.charCodeAt(fromLen - 1 - s) === to.charCodeAt(toLen - 1 - s)
  ) {
    s++;
  }

  const off = clampOffset(offset, fromLen);
  if (off <= p) return Math.min(off, toLen);
  const fromTailStart = fromLen - s;
  if (off >= fromTailStart) {
    const mapped = off - (fromLen - toLen);
    return clampOffset(mapped, toLen);
  }
  return Math.min(p, toLen);
}

/** clamp 到 `[0, len]`，非有限数按 0（调用方传 NaN 时不要产生 NaN 坐标） */
export function clampOffset(offset: number, len: number): number {
  const n = Number.isFinite(offset) ? offset : 0;
  const limit = Number.isFinite(len) && len > 0 ? len : 0;
  if (n < 0) return 0;
  if (n > limit) return limit;
  return Math.floor(n);
}

/**
 * 决策：源码面撤销/恢复后该用**哪种**滚动恢复口径。
 *
 * 优先级（都有实机/历史缺陷支撑，不要调换）：
 * 1. `anchor` 存在 → **永远**用内容锚（字符偏移与排版无关，长度变了也准）；
 * 2. 否则 `pixelScrollTop` 非 null **且** 文本长度未变 → 用像素（同长度时像素最精确、
 *    且能保住"字节级"的滚动位置，例如撤销一个等长替换）；
 * 3. 否则 `none` —— **绝不返回 0**。返回 0 会让"撤销一次就滚到顶"，
 *    那正是 v0.14.0 需求2 P1 的老 bug（`newTop ?? 0`）。
 */
export function decideSourceScrollRestore(args: {
  textLengthChanged: boolean;
  anchor: { offset: number; viewportY: number } | null | undefined;
  pixelScrollTop: number | null | undefined;
}): SourceScrollRestoreDecision {
  const { anchor, pixelScrollTop, textLengthChanged } = args;
  if (anchor && Number.isFinite(anchor.offset) && Number.isFinite(anchor.viewportY)) {
    return { kind: "anchor", anchor: { offset: anchor.offset, viewportY: anchor.viewportY } };
  }
  if (!textLengthChanged && Number.isFinite(pixelScrollTop as number)) {
    return { kind: "pixel", scrollTop: Number(pixelScrollTop) };
  }
  return { kind: "none" };
}

/**
 * 右屏（iframe 预览）在**模式切换进编辑**后需要延时重对齐的时点（ms）。
 *
 * ## 为什么必须有（实机缺陷 B）
 * 从阅读模式双击 Ctrl 进编辑模式时，右侧预览 iframe **此刻还在异步写入**：
 * 实测（打包产物 v0.15.2，`scripts/v0153-probe-align-async.mjs`，含 mermaid 的文档）
 * - t=0ms：`[data-src-line]` 贴标 **0 个**、右屏 `scrollHeight=0` → 无法对齐；
 * - t=480ms：贴标 78 个、右屏 `scrollHeight=7868`、mermaid SVG 已渲染 5 个；
 * - 稳定后左右仍差 **5.1 个源码行**，用户手动滚一下左屏立刻降到 **0.09 行**。
 * 也就是说块锚点映射本身是对的，**只是没人再触发一次对齐** ——
 * `syncPreviewAfterToggleRef` 的 0/160/480/1000ms 重试只挂在「预览开合冻结窗」的
 * `finalize` 里（`EditorContainer.tsx` 的 `finalize`），模式切换走不到那条路径。
 *
 * 时点取值依据：需覆盖 iframe 的 `doc.close()` → body 就绪 → 贴标 → mermaid/katex
 * 异步渲染撑高（§4-31 实测到 1427ms 仍有几何动作），故末点取 1600ms。
 * 这些点**全部幂等**（`syncToPreview(force)` 只读左屏位置写右屏），重复执行无副作用。
 */
export const PREVIEW_REALIGN_DELAYS = [0, 160, 480, 1000, 1600] as const;

/** 延时重对齐的总窗口（超过即停止，防"永远在纠"） */
export const PREVIEW_REALIGN_WINDOW_MS = 2500;

/**
 * 是否继续执行第 N 次延时重对齐（纯函数，便于单测）。
 *
 * 三条终止条件（缺一不可）：
 * - `cancelled`：调用方已卸载 / 新一轮切换接管（代际 token 不符）；
 * - `userScrolled`：用户主动滚动左屏 → **用户意图优先**，绝不再把手里的位置改掉
 *   （这与 `scrollFreezeRef` 的"用户接管即放弃还原"是同一条口径）；
 * - `elapsedMs >= PREVIEW_REALIGN_WINDOW_MS`：兜底，防定时器链失控。
 */
export function shouldContinuePreviewRealign(args: {
  cancelled: boolean;
  userScrolled: boolean;
  elapsedMs: number;
}): boolean {
  if (args.cancelled) return false;
  if (args.userScrolled) return false;
  return Number.isFinite(args.elapsedMs) && args.elapsedMs < PREVIEW_REALIGN_WINDOW_MS;
}
