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
  /**
   * 该命中在**本文件全部命中**中的序号（0 基）。
   *
   * 为什么跨文本空间定位要靠它而不是行号：
   * 搜索结果是在源码空间算的（collectFiles 的 getText 返回 markdown 源码），
   * 而跳过去之后目标文档可能处于阅读模式，当前文本空间是 PM 渲染文本（语法记号已被
   * 解析掉/重排），行号必然对不上。而关键词出现的**次序**在两个空间里是稳定的
   * （渲染文本是源码去掉语法记号后的子序列），所以用「第 N 次出现」定位。
   */
  occurrence: number;
  /**
   * 该命中是**所在行内**的第几处（0 基；省略 = 0）。
   *
   * 为什么需要它（v0.15.1 需求4 续修）：结果条幅是「一行一条」（同一行的多处命中合并进
   * 一条，见 `SearchFileResult` 注释），而 `occurrence` 只记录了该行**首个**命中的
   * 全局序号。用户点同一行里的第 2/3 处时，若只有 `occurrence`，定位必然落回该行第一处
   * —— 这就是「每一处都跳到第一个搜索」的第二个成因。
   *
   * 口径约定：`occurrence + hitIndex` = 该命中在**全文**中的 0 基全局序号
   * （行内命中按出现顺序排列，行内第 k 处的全局序号必然是首处 + k）。
   * 跨文本空间定位时用 `jumpOccurrenceOf(target)` 取这个和，不要自己相加。
   */
  hitIndex?: number;
  /**
   * 请求自增序号（由 `requestSearchJump` 赋，每次请求 +1）。
   *
   * 为什么需要它：接收端过去只靠「docKey 变化」判断要不要消费 pending。目标文档
   * **已经是当前文档**时 docKey 不变、消费 effect 不重跑，第 2/3/4 次点击就永远没人处理
   * （用户看到「点了没反应」）。带上 seq 后接收端可以按 seq 去重 / 作为 effect 的额外
   * 触发器，同一请求既不会漏兑现也不会被重复兑现。
   */
  seq?: number;
}

/** 跨组件跳转事件名（App 侧监听它切标签；常量导出避免两侧字符串写岔） */
export const SEARCH_JUMP_EVENT = "lightmd:search-jump";

/**
 * 跳转目标对应的**全局 0 基命中序号**。
 *
 * 单独抽函数的理由：`occurrence + hitIndex` 这个换算会被接收端（SearchReplace 的
 * 事件监听 + effect）与 `performSearch` 的兑现分支同时用到，写两遍必然有一天只改一处
 * （改漏的那一侧会静默跳回行首，且没有任何报错）。
 */
export function jumpOccurrenceOf(t: Pick<SearchJumpTarget, "occurrence" | "hitIndex">): number {
  const occ = Number.isFinite(t.occurrence) ? t.occurrence : 0;
  const hit = Number.isFinite(t.hitIndex as number) ? Math.max(0, t.hitIndex as number) : 0;
  return Math.max(0, occ) + hit;
}

/** 自增序号（模块级；只用于「同一请求是否已处理过」的判定，不跨进程/不持久化） */
let seqCounter = 0;

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
  // 每次请求都带一个新 seq：接收端用它判断「这条请求处理过没有」，
  // 不再依赖 docKey 变化（目标已是当前文档时 docKey 不变，见 SearchJumpTarget.seq 注释）。
  seqCounter += 1;
  const withSeq: SearchJumpTarget = { ...t, seq: seqCounter };
  pending = withSeq;
  try {
    window.dispatchEvent(new CustomEvent<SearchJumpTarget>(SEARCH_JUMP_EVENT, { detail: withSeq }));
  } catch {
    // 非 DOM 环境（如 node 单测里没装 jsdom）：pending 已写入，接收方可直接 take
  }
}

/** 查看待处理目标（不清空）。用于「是否轮到我处理」的判断。 */
export function peekSearchJump(): SearchJumpTarget | null {
  return pending;
}

/**
 * 只读查看当前 seq（无 pending 时为 0）。
 *
 * 用途：接收端把「seq」当作 effect 的额外触发器时，需要一个**稳定且在无 pending 时
 * 不变化**的值。直接依赖 `peekSearchJump()?.seq` 会让"消费后 pending 变 null"
 * 也触发一次 effect（值从 N 变成 undefined），白跑一轮且语义混乱。
 */
export function peekSearchJumpSeq(): number {
  return pending?.seq ?? 0;
}

/**
 * 取走待处理目标（消费即清空）。
 *
 * @param fileKey 可选的过滤条件：只有目标文件的 fileKey 匹配时才取走。
 *   不传则无条件取走。为什么要过滤：多个 EditorContainer 实例（多窗口）或切换过程中
 *   新旧两次挂载都会调 take，若不校验 fileKey，可能由**错误的文档**消费掉跳转请求
 *   （表现为「点了结果但跳到别处」）。
 * @param seq 可选的 seq 过滤（v0.15.1 追加）：只有 pending 的 seq 相等时才取走。
 *   为什么要它：事件监听与 docKey effect 两条通道都会尝试消费，若没有 seq 校验，
 *   先到的那条会取走目标、后到的那条拿不到（不会重复跳，但也没法判断"这条请求
 *   到底处理过没有"）。带 seq 后两条通道可以安全地「抢同一条请求」而不会互相截断。
 * @returns 取走的目标；无 pending 或过滤条件不匹配时返回 null
 */
export function takeSearchJump(fileKey?: string, seq?: number): SearchJumpTarget | null {
  if (!pending) return null;
  if (fileKey !== undefined && pending.fileKey !== fileKey) return null;
  if (seq !== undefined && pending.seq !== seq) return null;
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
  seqCounter = 0;
}
