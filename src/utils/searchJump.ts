/**
 * searchJump —— 搜索结果的「跨组件跳转」契约（v0.14.0 需求2）
 *
 * 场景：搜索面板里的「查找所有打开文件」条幅列出了一堆命中，用户点其中一条时，
 * 需要「先切到那个文件所在的标签页，再在该文件的对应位置定位并高亮」。
 * 但**切标签**这件事只有 App/EditorContainer 层能做（它们持有标签栏与 store），
 * 搜索面板（SearchReplace）不持有这些能力，也不允许直接改 store（模块边界）。
 *
 * 所以这里用一个极小的双向通道：
 * 1. 面板调 `requestSearchJump(target)` —— 顺手派发 window 事件 `lightmd:search-jump`，
 *    App 监听该事件做「切标签」；
 * 2. 目标文档内容就绪后（标签切换完成、编辑器重新挂载），接收方调
 *    `takeSearchJump(fileKey)` 取走待处理目标，执行真正的定位/高亮。
 *
 * 为什么要模块级 pending 而不只用事件：
 * 事件是「一次性广播」，监听方可能在标签切换过程中重挂载（EditorContainer 的大 useMemo
 * 依赖链会重建 effect），错过广播就再也拿不到目标。pending 是「拉取式」的，
 * 谁最后持有目标文档谁去取，天然对时序不敏感。
 *
 * 注意：pending 是**模块级单例**（同一时刻只处理一个跳转），够用且不会泄漏；
 * 多个跳转请求以最后一次为准（用户连点两条结果时，跳到最后点的那条是正确直觉）。
 */

/** 跳转目标：由结果条幅的 hit 生成，接收方据此定位 */
export interface SearchJumpTarget {
  /** 文件稳定标识（当前标签用 `tab.id ?? tab.path`；路径为空串时也用 fileKey 兜底） */
  fileKey: string;
  /** 文件绝对路径（空串 = 未落盘的临时文件） */
  filePath: string;
  /** 1 基行号 */
  line: number;
  /** 1 基列号 */
  column: number;
  /** 命中长度（用于判断在本文本里是否已能直接定位） */
  length: number;
  /** 搜索关键词（原文大小写；接收方用小写比较做二次校验） */
  query: string;
}

/** 跨组件跳转事件名（App 侧监听它切标签；常量导出避免两侧字符串写岔） */
export const SEARCH_JUMP_EVENT = "lightmd:search-jump";

/**
 * 当前待处理的跳转目标（模块级单例）。
 * 用 `let` 而非 store：它只在「点击结果 → 目标文档接管」这一瞬间有值，不需要订阅/持久化。
 */
let pending: SearchJumpTarget | null = null;

/**
 * 请求跳转：先写 pending，再广播事件。
 *
 * 顺序很重要：**先写 pending 再派发事件**。原因是 App 的监听器如果在事件回调里同步
 * 完成标签切换（React 18 的自动批处理下可能同步重渲染），EditorContainer 的
 * 挂载 effect 会立刻尝试 `takeSearchJump()`；若此时 pending 还没写入就会扑空。
 *
 * 事件派发失败（非浏览器环境 / window 不存在）不应影响 pending 的写入，
 * 因此 try/catch 只包 dispatchEvent。
 *
 * @param t 跳转目标
 */
export function requestSearchJump(t: SearchJumpTarget): void {
  pending = t;
  try {
    window.dispatchEvent(new CustomEvent<SearchJumpTarget>(SEARCH_JUMP_EVENT, { detail: t }));
  } catch {
    // 非 DOM 环境（如 node 单测里没装 jsdom）：pending 已写入，接收方可直接 take
  }
}

/** 查看待处理目标（不清空）。用于「是否轮到我处理」的判断。 */
export function peekSearchJump(): SearchJumpTarget | null {
  return pending;
}

/**
 * 取走待处理目标（消费即清空）。
 *
 * @param fileKey 可选的过滤条件：只有目标文件的 fileKey 匹配时才取走。
 *   不传则无条件取走。为什么要过滤：多个 EditorContainer 实例（多窗口）或切换过程中
 *   新旧两次挂载都会调 take，若不校验 fileKey，可能由**错误的文档**消费掉跳转请求
 *   （表现为「点了结果但跳到别处」）。
 * @returns 取走的目标；无 pending 或 fileKey 不匹配时返回 null
 */
export function takeSearchJump(fileKey?: string): SearchJumpTarget | null {
  if (!pending) return null;
  if (fileKey !== undefined && pending.fileKey !== fileKey) return null;
  const t = pending;
  pending = null;
  return t;
}

/**
 * 清空 pending（仅测试用）。
 * 生产代码不应调用——会影响用户正在进行的跳转。
 */
export function __resetSearchJumpForTest(): void {
  pending = null;
}
