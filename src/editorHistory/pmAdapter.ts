/**
 * pmAdapter —— v0.15.0 WP-B1 阶段 2：ProseMirror 事务 → 时间线条目的**归并适配器**
 *
 * ## 三条硬约束（违反任何一条都会造成用户可见故障）
 *
 * ### ① 必须忽略 `historyBridge` 事务
 *
 * coordinator 应用撤销时，会用 `tr.replaceWith(0, size, markdownToDoc(text))` +
 * `setMeta("addToHistory", false)` + `setMeta("historyBridge", true)` 整篇写回。
 * 这条事务**本身就是撤销动作的落地**，如果被 pmAdapter 当成"一次新编辑"提交，
 * 时间线会立刻多出一条 `A→B`，然后：
 * - 用户再按一次撤销 → 撤的是刚写进去的那一步 → 内容在两点间来回弹；
 * - 最坏情况无限循环（撤销 → 写回 → 记录 → 撤销…）。
 *
 * 因此判据是 `tr.getMeta("historyBridge")`，**整批事务里只要有一条带它，整批忽略**。
 *
 * ### ② 序列化必须节流（禁止每次按键同步全篇 `docToMarkdown`）
 *
 * `docToMarkdown` 是 O(文档长度) 的：5MB 文档每次按键同步跑一次 = 输入直接卡死
 * （v0.8.3 已经为字数统计踩过同款坑，见 `Encoder` 的 300ms 防抖）。
 * 本模块把「取 after 文本」推迟到**防抖窗口末尾 + 最大等待上限**：
 * - `DEBOUNCE_MS`：最后一次变化后安静这么久才序列化（连续打字 = 只序列化一次）；
 * - `MAX_WAIT_MS`：即使一直不停地打，也最多攒这么久就切一步 —— 否则用户打一整段
 *   才松手，一次 Ctrl+Z 会把整段全撤掉（与 prosemirror-history 的 500ms 分组语义背离）。
 *
 * ### ③ `addToHistory:false` 的事务不能变成用户可见的一步
 *
 * `fileSwitch` / 翻译回写 / trailing-paragraph 补位事务都带这个 meta。它们改了 doc
 * 但不是"用户的编辑"。处理方式是 **rebase**：只把 baseline 文本前移到新文本，
 * 不产生条目（否则用户会在撤销栈里撞到莫名其妙的一步）。
 *
 * ## 为什么不直接读 `view.state.doc` 而是注入 `serialize`
 *
 * 本模块**不 import prosemirror**，也不碰 `EditorView`：`serialize(doc)` 由接线方传入
 * （生产 = `getMarkdownFromDoc`，测试 = 假函数）。这样归并/节流/忽略规则可以在 Node
 * 里用纯逻辑完整单测，且不会把 PM 拖进 `services` 层的依赖图。
 */

/** 防抖窗口：最后一次变化后安静这么久才序列化提交（连续打字合并为一步） */
export const DEBOUNCE_MS = 350;

/**
 * 最大等待：即使持续输入也最多攒这么久就切一步。
 * 取 900ms 与设计文档 §1.3「连续 typing 900ms 内合并为一步」的口径对齐。
 */
export const MAX_WAIT_MS = 900;

/** 一次被忽略的原因（诊断/测试用） */
export type PmSkipReason = "bridge" | "no-change" | "rebase";

/** 提交计划：直接喂 `documentHistory.commit()`（before 缺省 = 时间线已知文本） */
export interface PmCommitPlan {
  before: string;
  after: string;
  origin: "pm";
}

export interface PmAdapterOptions {
  /** 把 PM doc 序列化成 Markdown（生产传 `getMarkdownFromDoc`，测试传假函数） */
  serialize(doc: unknown): string;
  /** 收到一个需要入库的提交计划（生产 = `coordinator.commitFromPm`） */
  commit(plan: PmCommitPlan): void;
  /**
   * 收到一个「不产生条目、但宿主文本已变」的通知（rebase 用）。
   * 生产 = `documentHistory.rebaseText(docKey, text)`。
   */
  rebase?(text: string): void;
  /** 可注入时钟（测试用；生产缺省 `Date.now`） */
  now?(): number;
  /** 可注入定时器（测试用；缺省浏览器 `setTimeout/clearTimeout`） */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  debounceMs?: number;
  maxWaitMs?: number;
  /** 可选：从 state 采集恢复锚点（阅读侧 scrollTop 反查，失败返回 undefined） */
  buildAnchor?(state: unknown): import("../services/documentHistory").ContentAnchor | undefined;
}

export interface PmAdapter {
  /**
   * 处理一批事务（在 `dispatchTransaction` 里、`view.state` 已更新后调用）。
   *
   * @param stateBefore 事务应用**前**的 state（只为取 anchor / 兼容不同调用点，可为 null）
   * @param trs         本次 dispatch 的事务数组（可能是 `applyTransaction` 合并后的一条）
   * @param stateAfter  事务应用**后**的 state（取新 doc 用）
   * @returns 忽略原因（`null` = 已受理，可能已排入节流队列）
   */
  handleTransactions(
    stateBefore: unknown,
    trs: readonly PmTrLike[],
    stateAfter: unknown,
  ): PmSkipReason | null;
  /**
   * **立即**把待提交的变化落地（序列化 + commit）。
   *
   * 必须在任何「需要读到最新时间线」的操作前调用：undo/redo 入口、模式切换、
   * 保存、切文档。否则会丢最后一段打字（它还在防抖窗口里）。
   *
   * @returns 是否真的提交了一条
   */
  flush(): boolean;
  /** 是否有待提交的变化（防抖窗口内） */
  pending(): boolean;
  /** 复位（切文档 / 外部重载）：丢弃待提交队列，baseline 重设为给定文本 */
  reset(baselineText: string): void;
  /**
   * v0.15.1 需求1：**外部改了宿主文本**（统一时间线的 undo/redo 落地）后同步基线。
   *
   * 为什么必须单独一个方法：撤销/重做走的是 bridge 事务（`historyBridge` meta），
   * `handleTransactions` 对它们**整批忽略**（否则会把撤销动作本身记成新编辑）。
   * 但忽略的副作用是 `baseline` 仍停在**撤销前**的文本 —— 用户随后一打字，
   * `commit({ before: 旧文本, after: 新文本 })` 的 before 与时间线 knownText 不符，
   * 协调器只好 `rebaseText(force:true)` 强制对齐，而 force 会 **truncateRedo**，
   * 把 redo 分支整段删掉。用户看到的就是「撤了几次之后撤销/恢复全都不能用了」。
   *
   * 因此 coordinator 每次落地 undo/redo 后都必须调它，把 baseline 前移到实际文本。
   */
  setBaseline(text: string): void;
}

/** PM 事务里本模块用到的**最小**结构（避免 import prosemirror 类型） */
export interface PmTrLike {
  docChanged?: boolean;
  getMeta?(key: string): unknown;
}

/**
 * v0.15.1 需求1（**关键修复**）：把「state 或 doc」统一成「doc」再交给 `serialize`。
 *
 * ## 缺陷背景（这是「阅读模式编辑完全不进撤销栈」的真凶）
 *
 * 接线方（`core/editor.ts` 的 `dispatchTransaction`）传进来的 `stateAfter` 是
 * **`EditorState`**（`onTransactions?.(state, [tr], view.state)`），而 `serialize`
 * 的生产实现是 `getMarkdownFromDoc(doc)` —— 它把入参当 **PM doc** 用（读
 * `doc.content` 做 `docToMarkdown`）。
 *
 * 两者形状不同：`EditorState` 没有 `content` 字段 → `docToMarkdown(state)` 抛错
 * （被 `catch` 吞掉返回 `""`），或产出空串。于是：
 * - `baseline` 被写成 `""`；
 * - `commit({ before: "", after: "" })` → `before === after` → **返回 null，不入库**；
 * - 用户在阅读模式打的每一个字都**不会**进统一时间线 → 切到编辑模式按 Ctrl+Z
 *   撤不掉刚才的编辑（用户实测的「跨模式撤销还是有问题」）。
 *
 * 修法：本模块自己剥一层 —— 有 `.doc` 就取 `.doc`（`EditorState` / 带 doc 的包装），
 * 没有就原样传（测试里直接传字符串/假 doc，行为不变）。
 */
function unwrapDoc(stateOrDoc: unknown): unknown {
  if (stateOrDoc && typeof stateOrDoc === "object" && "doc" in (stateOrDoc as object)) {
    const doc = (stateOrDoc as { doc?: unknown }).doc;
    if (doc !== undefined) return doc;
  }
  return stateOrDoc;
}

/** 判定一条事务是否是 coordinator 写回（bridge 事务） */
export function isBridgeTransaction(tr: PmTrLike): boolean {
  return tr.getMeta?.("historyBridge") === true;
}

/** 判定一条事务是否被显式排除出撤销历史 */
export function isHistoryExcluded(tr: PmTrLike): boolean {
  return tr.getMeta?.("addToHistory") === false;
}

/**
 * 创建一个 PM 归并适配器。
 *
 * 节流算法（**leading=false / trailing=true + maxWait**）：
 * 1. 首次变化：记 `pendingSince = now()`，启动 debounce 定时器；
 * 2. 后续变化：只刷新 `pendingDoc`，**不重新计算 pendingSince**，并把 debounce 定时器
 *    重置为「距 pendingSince 最多还剩 maxWait」与「now + debounce」的较小值；
 * 3. 定时器触发 → `flush()`：序列化最后一次 doc，与 baseline 比对，不同才提交一条；
 * 4. 因此连续打字每 ~900ms 出一"步"，停顿 ~350ms 后立即出最后一步。
 */
export function createPmAdapter(opts: PmAdapterOptions): PmAdapter {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const now = opts.now ?? (() => Date.now());
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  /** 时间线认为的宿主文本（提交/rebase 后前移） */
  let baseline: string | null = null;
  /** 防抖窗口内最新的 doc（只保留引用，不序列化） */
  let pendingDoc: unknown = null;
  let hasPending = false;
  let pendingSince = 0;
  let timer: unknown = null;
  let timerHandleSet = false;

  function cancelTimer(): void {
    if (timerHandleSet) {
      clearTimer(timer);
      timer = null;
      timerHandleSet = false;
    }
  }

  function schedule(): void {
    cancelTimer();
    const elapsed = now() - pendingSince;
    const remainingMax = Math.max(0, maxWaitMs - elapsed);
    const wait = Math.min(debounceMs, remainingMax);
    timer = setTimer(() => {
      timerHandleSet = false;
      flushInternal();
    }, wait);
    timerHandleSet = true;
  }

  /** 真正落地：序列化 + 提交。返回是否提交了一条 */
  function flushInternal(): boolean {
    if (!hasPending) return false;
    const doc = pendingDoc;
    hasPending = false;
    pendingDoc = null;
    cancelTimer();
    let text: string;
    try {
      text = opts.serialize(unwrapDoc(doc));
    } catch {
      // 序列化失败：保持 baseline 不动，宁可丢这一步也不能把错误文本写进历史
      return false;
    }
    const before = baseline;
    baseline = text;
    if (before === null || before === text) return false;
    opts.commit({ before, after: text, origin: "pm" });
    return true;
  }

  return {
    handleTransactions(stateBefore, trs, stateAfter) {
      // ① bridge 事务：coordinator 的撤销落地，整批忽略（见文件头 ①）
      if (trs.some(isBridgeTransaction)) return "bridge";
      if (!trs.some((tr) => tr.docChanged)) return "no-change";

      // ③ 全部变化事务都 addToHistory:false → 不产生条目，只 rebase baseline
      const changed = trs.filter((tr) => tr.docChanged);
      if (changed.every(isHistoryExcluded)) {
        try {
          const text = opts.serialize(unwrapDoc(stateAfter));
          baseline = text;
          opts.rebase?.(text);
        } catch {
          /* 序列化失败：baseline 保持，下次正常变化时仍能提交 */
        }
        // 未提交的历史变化被 rebase 覆盖后，防抖队列里的旧 doc 也失效了
        hasPending = false;
        pendingDoc = null;
        cancelTimer();
        return "rebase";
      }

      // ② 需要提交：只记 doc 引用，序列化推迟到定时器（见文件头 ②）
      if (!hasPending) {
        pendingSince = now();
        hasPending = true;
      }
      pendingDoc = stateAfter;
      schedule();
      return null;
    },

    flush(): boolean {
      return flushInternal();
    },

    pending(): boolean {
      return hasPending;
    },

    reset(baselineText: string): void {
      cancelTimer();
      hasPending = false;
      pendingDoc = null;
      baseline = baselineText;
    },

    setBaseline(text: string): void {
      // 基线前移，并**丢弃**防抖队列里残留的旧 doc：
      // 那些 doc 是撤销前的状态（coordinator 落地 undo/redo 前已 flush 过，
      // 正常路径下队列本来就是空的）。若真的还有残留，它是"被撤销掉的内容"，
      // 提交上去会立刻把用户刚撤销的东西又写回时间线。
      cancelTimer();
      hasPending = false;
      pendingDoc = null;
      baseline = text;
    },
  };
}
