/**
 * 打字机模式工具函数
 *
 * 设计目标（修复屏幕跳动 bug）：
 * 1. 普通字符输入不触发滚动 —— 仅在导航键（回车/方向键/翻页键）抬起时触发
 * 2. 内容未超出视口时不滚动 —— 单行/少量内容时屏幕保持稳定
 * 3. 阈值检查避免微小抖动 —— 与当前滚动位置差距小于阈值时不滚动
 *
 * 将这些纯判断逻辑提取出来，便于单元测试。
 */

/** 应触发打字机滚动的导航键集合 */
const NAV_KEYS = new Set([
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/** 修饰键集合（单独按下时不输入字符，不应触发打字机滚动） */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

/**
 * 判断按键是否应触发打字机滚动
 *
 * 普通字符（如 a-z、数字、空格）返回 false，避免每输入一个字符就跳动；
 * 仅导航键（回车换行、方向键切换光标位置、翻页键）返回 true。
 *
 * @param key KeyboardEvent.key
 * @returns 是否应触发滚动
 */
export function isTypewriterTriggerKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/**
 * 判断按键是否为修饰键（Shift/Control/Alt/Meta）
 *
 * 修复快捷键切换模式时滚动位置丢失 bug 的核心逻辑：
 * 双击 Ctrl/Shift 切换模式时，keyup 事件在 textarea/ProseMirror 上触发
 * （事件冒泡），若不跳过则会调用 scrollCursorToCenter 或
 * scrollTo({behavior: "smooth"})，smooth 滚动会覆盖 applyScroll 的
 * instant 设置，导致模式切换后滚动位置丢失。
 *
 * 修饰键本身不会移动光标或输入字符，不应触发任何打字机滚动。
 * 此函数作为 isRestoringScrollRef 检查的双重保护，应对 applyScroll
 * effect（useEffect，异步）尚未执行、isRestoringScrollRef 仍为 false
 * 的时序竞争场景。
 *
 * @param key KeyboardEvent.key
 * @returns true 表示该键是修饰键，应跳过滚动处理
 */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/**
 * 判断普通字符输入时是否应跳过滚动
 *
 * 修复阅读模式屏幕闪烁抖动 bug 的核心逻辑：
 * 软换行（white-space: pre-wrap）时，输入字符后行 N-1 的内容被挤到行 N，
 * 光标跟随内容上移，cursorY 减小一行高度（约 28.8px）。此时光标仍在视口内，
 * 不应触发 scrollToVisible 强制滚动，否则 scrollTop 大幅跳跃造成屏幕闪烁。
 *
 * 判定规则：
 * - 导航键（回车/方向键/翻页键）：不跳过，始终触发滚动，确保光标可见
 * - 普通字符输入：光标在视口内时跳过，光标离开视口时仍触发滚动
 *
 * @param key KeyboardEvent.key
 * @param cursorTop 光标顶部相对编辑器视口的 Y 坐标（coords.top - editorRect.top）
 * @param cursorBottom 光标底部相对编辑器视口的 Y 坐标
 * @param viewportHeight 编辑器视口高度（editorDom.clientHeight）
 * @returns true 表示跳过滚动
 */
export function shouldSkipScrollForCharInput(
  key: string,
  cursorTop: number,
  cursorBottom: number,
  viewportHeight: number
): boolean {
  // 导航键不跳过，始终触发滚动
  if (isTypewriterTriggerKey(key)) return false;
  // 普通字符输入：光标在视口内时跳过滚动（避免软换行 cursorY 减小误触发）
  return cursorTop >= 0 && cursorBottom <= viewportHeight;
}

/**
 * 判断光标是否在编辑器视口外
 *
 * 修复阅读模式编辑闪烁抖动 bug 的核心逻辑（cursorWasOutside）：
 * 光标在视口外时按键，浏览器原生 selection 变化会触发 scrollIntoView，
 * 把 scrollTop 改为光标位置。如果 keyup 恢复 scrollTop 到旧值，
 * 用户会看到抖动（scrollTop 跳到光标位置再跳回）。
 * 由于光标仍在视口外（scrollTop 被恢复），下次按键再次抖动，
 * 造成"每按一下都抖动"。
 *
 * 判定规则：
 * - cursorTop < 0：光标顶部在视口上方 → 视口外
 * - cursorBottom > viewportHeight：光标底部在视口下方 → 视口外
 * - 否则：光标在视口内
 *
 * @param cursorTop 光标顶部相对编辑器视口的 Y 坐标（coords.top - editorRect.top）
 * @param cursorBottom 光标底部相对编辑器视口的 Y 坐标
 * @param viewportHeight 编辑器视口高度（editorDom.clientHeight）
 * @returns true 表示光标在视口外，keyup 时不应恢复 scrollTop
 */
export function isCursorOutsideViewport(
  cursorTop: number,
  cursorBottom: number,
  viewportHeight: number
): boolean {
  return cursorTop < 0 || cursorBottom > viewportHeight;
}

/**
 * 计算滚动同步的目标 scrollTop（用于 split 模式左右联动）
 *
 * 修复 split 模式下 iframe 预览滚动不联动 textarea 的 bug：
 * 原代码 onPreviewScroll 监听 documentElement 的 scroll 事件，但 iframe 的
 * scroll 事件触发在 contentDocument 上，导致 onPreviewScroll 永远不触发。
 * 修复后将监听改到 contentDocument，同时提取此纯函数封装百分比映射逻辑。
 *
 * 算法：
 * - 源元素 max <= 0（内容未超出视口）：返回 0（不滚动）
 * - 计算源元素滚动百分比 = sourceScrollTop / sourceMax
 * - 目标元素 max <= 0：返回 0（目标无需滚动）
 * - 否则返回 percent * targetMax
 *
 * @param sourceScrollTop 源元素当前 scrollTop
 * @param sourceScrollHeight 源元素 scrollHeight
 * @param sourceClientHeight 源元素 clientHeight
 * @param targetScrollHeight 目标元素 scrollHeight
 * @param targetClientHeight 目标元素 clientHeight
 * @returns 目标元素应设置的 scrollTop
 */
export function computeSyncScrollTop(
  sourceScrollTop: number,
  sourceScrollHeight: number,
  sourceClientHeight: number,
  targetScrollHeight: number,
  targetClientHeight: number
): number {
  const sourceMax = sourceScrollHeight - sourceClientHeight;
  if (sourceMax <= 0) return 0;
  const percent = sourceScrollTop / sourceMax;
  const targetMax = targetScrollHeight - targetClientHeight;
  return targetMax > 0 ? percent * targetMax : 0;
}

/**
 * 计算滚动百分比（用于模式切换时恢复滚动位置）
 *
 * 修复模式切换后滚动位置丢失 bug 的核心逻辑：
 * 当元素变为 display:none 时（切换到其他模式后原模式元素被隐藏），
 * scrollHeight 和 clientHeight 均为 0，max = 0。
 * 若此时仍更新百分比，会被错误地置为 0（除以 0 得 NaN，原代码用
 * 三元运算 fallback 为 0），导致模式切换回来后滚动位置丢失。
 *
 * 判定规则：
 * - max > 0：正常计算百分比 = scrollTop / max
 * - max <= 0：元素不可见或内容未超出视口，返回 null 表示不更新
 *
 * @param scrollHeight 元素的 scrollHeight
 * @param clientHeight 元素的 clientHeight
 * @param scrollTop 元素当前的 scrollTop
 * @returns 滚动百分比（0-1），或 null 表示不更新
 */
export function computeScrollPercent(
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number
): number | null {
  const max = scrollHeight - clientHeight;
  // max <= 0 表示元素不可见（display:none）或内容未超出视口，跳过更新
  if (max <= 0) return null;
  return scrollTop / max;
}

/**
 * 判断打字机 effect 的初始 scrollToCenter 是否应该跳过
 *
 * 修复打字机模式下模式切换滚动位置丢失 bug：
 * 打字机 effect 的 scrollToCenter 使用 smooth 滚动（异步多帧），
 * 会在 applyScroll（instant 设置）之后继续滚动，覆盖滚动位置。
 * 模式切换时 applyScroll 正在恢复滚动位置（isRestoringScroll=true），
 * 此时应跳过 scrollToCenter，让 applyScroll 的 instant 设置生效。
 *
 * 判定规则：
 * - 正在恢复滚动位置（isRestoringScroll=true）：跳过
 * - 打字机模式关闭：跳过（不需要居中）
 * - 否则：执行 scrollToCenter（文件切换等场景需要光标居中）
 *
 * @param isRestoringScroll 是否正在恢复滚动位置（模式切换后 applyScroll 尚未执行完）
 * @param isTypewriterMode 打字机模式是否开启
 * @returns true 表示应跳过初始 scrollToCenter
 */
export function shouldSkipInitialScrollToCenter(
  isRestoringScroll: boolean,
  isTypewriterMode: boolean
): boolean {
  // 正在恢复滚动位置时跳过：避免 smooth 滚动覆盖 applyScroll 的 instant 设置
  if (isRestoringScroll) return true;
  // 打字机关闭时跳过：不需要光标居中
  if (!isTypewriterMode) return true;
  return false;
}

/**
 * 计算打字机模式的目标滚动位置
 *
 * 算法：
 * - 内容未超出视口 → 返回 null（不滚动）
 * - 计算目标位置：使光标所在行位于视口垂直中央
 *   targetY = cursorY - viewportHeight / 2
 * - 与当前滚动位置差距小于阈值 → 返回 null（避免微小抖动）
 * - 否则返回 Math.max(0, targetY)，避免负值
 *
 * @param cursorY 光标所在行的 Y 坐标（相对内容顶部）
 * @param viewportHeight 视口高度
 * @param contentHeight 内容总高度
 * @param currentScrollTop 当前滚动位置
 * @param threshold 抖动阈值，默认 5px
 * @returns 目标滚动位置（Math.max(0, targetY)），或 null 表示不滚动
 */
export function computeTypewriterScrollTop(
  cursorY: number,
  viewportHeight: number,
  contentHeight: number,
  currentScrollTop: number,
  threshold = 5
): number | null {
  // 内容未超出视口：不滚动（单行/少量内容时保持稳定）
  if (contentHeight <= viewportHeight) return null;

  // 计算使光标居中所需的目标滚动位置
  const targetY = cursorY - viewportHeight / 2;

  // 阈值检查：与当前滚动位置差距小于阈值时不滚动，避免微小抖动
  if (Math.abs(currentScrollTop - targetY) <= threshold) return null;

  // 避免负值（光标在第一行时 targetY 可能为负）
  return Math.max(0, targetY);
}

/**
 * 根据滚动百分比计算恢复的 scrollTop（computeScrollPercent 的逆运算）
 *
 * 用于模式切换后恢复滚动位置：
 * - applyScroll 中根据百分比计算 textarea/ProseMirror/iframe 的 scrollTop
 * - 分屏模式下 iframe 内容异步加载，写入完成后根据待恢复百分比设置 scrollTop
 *
 * 判定规则：
 * - max > 0：返回 percent * max
 * - max <= 0：返回 null（元素不可见或内容未超出视口，不设置 scrollTop）
 *
 * @param percent 滚动百分比（0-1）
 * @param scrollHeight 元素的 scrollHeight
 * @param clientHeight 元素的 clientHeight
 * @returns 目标 scrollTop，或 null 表示不设置
 */
export function computeRestoreScrollTop(
  percent: number,
  scrollHeight: number,
  clientHeight: number
): number | null {
  const max = scrollHeight - clientHeight;
  if (max <= 0) return null;
  // 钳制百分比到 [0, 1] 区间，避免越界
  const clampedPercent = Math.max(0, Math.min(1, percent));
  return clampedPercent * max;
}

/**
 * 计算元素视口中央的屏幕坐标
 *
 * 用于专注模式进入时光标不在可视区域的场景：
 * - 通过 view.posAtCoords(center) 找到屏幕中央对应的文档位置
 * - 将 selection 设置到该位置，使 focus-mode 插件高亮屏幕中央的块
 *
 * @param rect 元素的 getBoundingClientRect 结果
 * @returns { left, top } 屏幕中央坐标
 */
export function computeViewportCenter(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): { left: number; top: number } {
  return {
    left: rect.left + rect.width / 2,
    top: rect.top + rect.height / 2,
  };
}
