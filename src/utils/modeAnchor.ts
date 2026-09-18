/**
 * v0.8.0 修复 P10（重点问题2）：模式切换的"编辑锚点"定位计算
 *
 * 目标：阅读 / 编辑（源码）/ 分屏三种模式切换时，尽量保持"编辑符号（光标/插入符）
 * 所在位置"在两个模式下的视觉位置一致，同时避免位置跳变。
 *
 * 规则（与用户确认）：
 * - 光标在源模式视口内 → 记录它在视口中的相对位置 ratio，切到目标模式后把同一
 *   内容位置放到相同 ratio 处（视觉焦点一致，不跳动）；
 * - 光标不在视口内（用户正在浏览别处，或在视口外编辑）→ 不使用锚点，
 *   回退到既有的"滚动百分比"恢复（保持原有阅读进度，不强制滚动）。
 *
 * 全部为纯函数，便于单测。
 */

/** 源模式捕捉到的编辑锚点 */
export interface EditAnchor {
  /** 光标所在行号（0-based，按 \n 切分） */
  line: number;
  /** 光标行在源视口内的相对位置（0~1）；null 表示不在视口内（应回退百分比） */
  ratio: number | null;
}

/**
 * 计算内容坐标在视口中的相对位置。
 *
 * @param contentY     光标的 Y 坐标（相对内容顶部，单位 px）
 * @param scrollTop    当前滚动位置
 * @param clientHeight 视口高度
 * @returns 0~1 的比例；光标不在视口内或视口高度无效时返回 null
 */
export function computeViewportRatio(
  contentY: number,
  scrollTop: number,
  clientHeight: number,
): number | null {
  if (!Number.isFinite(contentY) || clientHeight <= 0) return null;
  const viewportY = contentY - scrollTop;
  if (viewportY < 0 || viewportY > clientHeight) return null;
  return viewportY / clientHeight;
}

/**
 * 按相对位置反算目标滚动位置（把 contentY 处的锚点放在视口 ratio 处）。
 * 结果按可滚动范围 [0, scrollHeight - clientHeight] 钳制。
 *
 * @returns 目标 scrollTop；参数无效时返回 null（调用方回退百分比）
 */
export function computeAnchorScrollTop(
  contentY: number,
  ratio: number,
  clientHeight: number,
  scrollHeight: number,
): number | null {
  if (!Number.isFinite(contentY) || contentY < 0 || clientHeight <= 0) return null;
  const max = Math.max(0, scrollHeight - clientHeight);
  const target = contentY - ratio * clientHeight;
  return Math.min(max, Math.max(0, target));
}

/**
 * 统计字符偏移之前出现过的换行符数量（即 0-based 行号）。
 *
 * 与 `text.slice(0, offset).split("\n").length - 1` 等价，但不分配中间数组，
 * 大文档下内存与耗时都更优。
 */
export function lineIndexOfOffset(text: string, offset: number): number {
  if (!text) return 0;
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}