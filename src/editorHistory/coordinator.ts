/**
 * coordinator —— v0.15.0 WP-B1 阶段 2：**撤销/恢复的唯一决策出口**
 *
 * 设计文档 §1.4。本模块不含任何 DOM / React / ProseMirror 代码：它只做决策，落地
 * 通过注入的 `HistoryHost` 完成。好处是「护栏、桥接标记、边界提示、丢弃条目」这些
 * 最容易出错的分支可以在 Node 里逐条单测（见 `coordinator.test.ts`）。
 *
 * ## 应用流程（undo，redo 对称 —— 设计文档 §1.4 原文）
 *
 * 1. `peekUndo()`：**先看后消费**。空 → `notifyBoundary()` 并返回 false；
 * 2. `origin === "cross-file"` 且 `currentText() !== entry.after` → **丢弃该条目**并提示
 *    "文档已被修改，无法应用该撤销"，**绝不覆盖用户编辑**（返回 false，游标不动）；
 * 3. `host.applyText(entry.before, 恢复现场, { bridge: true })` 落地；
 * 4. bridge 事务必须被 pmAdapter 忽略（`tr.getMeta("historyBridge")`），否则撤销动作
 *    本身会被记成新历史 → 无限循环；
 * 5. `entry` 消费掉（此时才 `undo()`），宿主负责 setDirty / 同步 lastContentRef。
 *
 * 为什么"先 peek 后消费"而不是直接 `undo()`：设计文档要求护栏不过时**丢弃该条目**。
 * 若先 `undo()` 再校验，失败时游标已经后退，时间线就与宿主内容脱节了（redo 分支被打乱），
 * 后续每一次撤销都会错位。因此本模块的失败路径**绝不推进游标**。
 *
 * ## cross-file 护栏为什么只对 cross-file 生效
 *
 * 同文档内的 source/pm 条目天然连续（每次 commit 都要求 before 与时间线已知文本逐字节
 * 相等），不存在"宿主被别的路径改过"的情况。而 cross-file 条目是**往未激活文档**记的
 * （用户当时在别的标签里替换），中间完全可能被第三方/自动保存/窗口间同步改动 →
 * 必须逐字节比对 `after` 才能确认"这份内容还是我记录的那份"。
 */

import type {
  ContentAnchor,
  DocumentHistoryApiEx,
  HistoryEntry,
  SourceSelection,
} from "../services/documentHistory";

/** 恢复现场：源码用 selection，阅读用 anchor；两者互斥（谁有给谁） */
export type RestoreTarget = SourceSelection | ContentAnchor;

/** 落地元信息：`bridge: true` 表示这是 coordinator 的写回（必须带 historyBridge meta） */
export interface BridgeMeta {
  bridge: true;
  /** 本次是撤销还是恢复（宿主据此决定是否滚动到目标/聚焦） */
  direction: "undo" | "redo";
  /** 目标文本的来源（诊断 / 埋点用） */
  origin: HistoryEntry["origin"];
}

/**
 * 宿主接口（设计文档 §1.4 冻结）。
 *
 * 实现方（EditorContainer 接线）负责：源码写 `setSourceContent` + rAF 恢复 selection；
 * 阅读模式 dispatch bridge 事务。coordinator 不关心细节，只要求"落地后宿主文本 == 目标"。
 */
export interface HistoryHost {
  /** 当前文档键（真实文件 = 路径 / 临时标签 = untitled:<id>） */
  docKey(): string;
  /**
   * 宿主**当前的真实文本**（源码 unmask 后 / 阅读 `getMarkdownFromDoc`）。
   * 护栏与 baseline 同步都以此为唯一事实来源。
   */
  currentText(): string;
  currentMode(): "source" | "pm";
  /** 把 text 写进宿主，并恢复现场。**必须带 bridge meta**（阅读模式）。 */
  applyText(text: string, restore: RestoreTarget | undefined, meta: BridgeMeta): void;
  /**
   * 边界提示（撤到底 / 无可恢复）。
   * @param kind 边界类型；`cross-file-stale` = 跨文件条目过期被丢弃（文案不同）
   */
  notifyBoundary(kind: "undo" | "redo" | "cross-file-stale"): void;
  /**
   * 可选：在消费游标后同步宿主侧状态（setDirty / lastContentRef / onContentChange）。
   * 单独一个钩子的原因：applyText 已经改内容，而"脏标记 + 向上层报新内容"是宿主自己的事，
   * 混进 applyText 会让阅读模式的 bridge 事务与 setState 顺序耦合（难测）。
   */
  afterApply?(text: string, direction: "undo" | "redo"): void;
}

/** coordinator 对外 API（设计文档 §1.4） */
export interface HistoryCoordinator {
  /** App/PM keymap/菜单的**唯一** undo 入口（替换 doLocalUndo 的实现体） */
  handleUndo(): boolean;
  handleRedo(): boolean;
  /** sourceAdapter 的提交结果喂进来（内部做 baseline 同步 + 时间线入库） */
  commitFromSource(plan: {
    before: string;
    after: string;
    origin: HistoryEntry["origin"];
    groupId?: string;
    /**
     * v0.15.1 需求1：编辑**前**的现场。必须一路透传到 `documentHistory.commit`，
     * 否则 `HistoryEntry.beforeSelection` 永远为空 → 撤销时光标/滚动位置无处可恢复
     * （用户实测"撤销后文档滚到底"的源码侧成因）。
     */
    beforeSelection?: SourceSelection;
    afterSelection?: SourceSelection;
  }): HistoryEntry | null;
  /** pmAdapter 的提交结果喂进来 */
  commitFromPm(plan: { before: string; after: string; origin: HistoryEntry["origin"] }): HistoryEntry | null;
  /** 当前文档还能撤销/恢复吗（菜单禁用态用） */
  canUndo(): boolean;
  canRedo(): boolean;
}

export interface CoordinatorOptions {
  api: DocumentHistoryApiEx;
  host: HistoryHost;
  /**
   * 可选：每次成功持久化一条历史后回调（接线方用来 setDirty / 刷新菜单禁用态）。
   * 与 `host.afterApply` 分开：那条只在 undo/redo 后触发。
   */
  onCommitted?(entry: HistoryEntry): void;
  /**
   * 可选：**消费游标前**把各 adapter 的节流队列清空（`pmAdapter.flush()` 等）。
   *
   * 为什么必须有：pmAdapter 把序列化推迟到防抖窗口末尾（350ms/900ms）。用户在阅读模式
   * 打了几个字后**立刻**按 Ctrl+Z（间隔 < 350ms）时，最后那次输入还在队列里：
   * - 不 flush：撤销会撤掉**上一个**条目，而用户看到的文档却已经被"撤回一步 + 又少了
   *   最后几个字"的混合态（内容跳变、且那次输入永久丢失）；
   * - flush：先把它落一条条目，再撤销 → 撤掉的正是用户刚打的那一步。
   *
   * 同时它也是「先 flush 再 peek」的唯一正确顺序：flush 会改变游标位置，必须早于 peek。
   */
  flushPending?(): void;
  /**
   * 可选：undo/redo **落地之后**把各 adapter 的基线同步到目标文本。
   *
   * 为什么必须有（v0.15.1 需求1 的核心缺陷）：撤销/重做在阅读模式走的是 bridge 事务，
   * pmAdapter 按设计**整批忽略**它（否则"撤销动作本身"会被记成新编辑 → 死循环）。
   * 忽略是对的，但它内部的 `baseline` 仍停在撤销前的文本。用户随后一打字，
   * `commit({ before: 撤销前的旧文本, after: 新文本 })` 与时间线 knownText 不符，
   * 协调器只能 `rebaseText(force:true)` 强制对齐 —— 而 force 会 **truncateRedo**，
   * 把 redo 分支整段删掉。用户看到的就是：
   *   ① 撤几次之后「恢复」彻底失效；
   *   ② 再撤几次连「撤销」也失效（时间线被推平），并弹「已到本模式撤销边界」。
   * 因此落地成功后必须把 adapter 基线前移到实际文本。
   */
  syncAdapterBaseline?(text: string): void;
}

/**
 * 判定跨文件条目的护栏：宿主当前文本是否**逐字节等于该条目"将要被替换掉"的那一端**。
 *
 * - undo：要回到 `before`，因此宿主必须还等于 `after`（否则说明替换之后又被改过）；
 * - redo：要回到 `after`，因此宿主必须还等于 `before`。
 *
 * 方向参数不是可有可无的：只比对 `after` 会让"撤销后再恢复"永远失败（撤销后宿主已变成
 * `before`，与 `after` 必然不等）—— 那正是本函数第一版写错的地方，由测试当场抓住。
 *
 * 单独导出成纯函数便于单测（这是数据安全的最后一道闸）。
 */
export function crossFileEntryStillValid(
  entry: HistoryEntry,
  currentText: string,
  direction: "undo" | "redo" = "undo",
): boolean {
  if (entry.origin !== "cross-file") return true; // 非跨文件条目不做此校验
  const expected = direction === "undo" ? entry.after : entry.before;
  return currentText === expected;
}

/**
 * 创建一个 coordinator。
 *
 * @param opts.api  时间线 API（生产 = `documentHistory` 单例；测试可注入替身）
 * @param opts.host 宿主（生产 = EditorContainer 适配层；测试 = 假宿主记录调用）
 */
export function makeHistoryCoordinator(opts: CoordinatorOptions): HistoryCoordinator {
  const { api, host } = opts;

  /** 取恢复现场：源码优先 selection，阅读优先 anchor */
  function restoreOf(entry: HistoryEntry, direction: "undo" | "redo"): RestoreTarget | undefined {
    if (direction === "undo") {
      return entry.beforeSelection ?? entry.beforeAnchor;
    }
    return entry.afterSelection ?? entry.afterAnchor;
  }

  /** undo/redo 的共同实现（对称，唯一差别是方向与目标文本字段） */
  function apply(direction: "undo" | "redo"): boolean {
    const docKey = host.docKey();
    if (!docKey) return false;

    // ⓪ 先清空 adapter 的节流队列：顺序必须早于 peek（flush 会改变游标，见 flushPending 注释）
    opts.flushPending?.();

    // ① 先 peek：空 → 边界，且**不动游标**
    const entry =
      direction === "undo" ? api.peekUndo(docKey) : api.peekRedo(docKey);
    if (!entry) {
      host.notifyBoundary(direction);
      return false;
    }

    // ② 跨文件护栏：内容已被改过 → 丢弃该条目并提示，绝不覆盖用户编辑
    const hostText = host.currentText();
    if (!crossFileEntryStillValid(entry, hostText, direction)) {
      api.drop(docKey, entry.id);
      // 时间线的 knownText 已被用户编辑推偏：同步一次（force，宿主确实变了 → redo 应失效）
      api.rebaseText(docKey, hostText, { force: true });
      host.notifyBoundary("cross-file-stale");
      return false;
    }

    // ③ 落地（bridge 事务 → pmAdapter 忽略 → 不会产生新历史）
    const target = direction === "undo" ? entry.before : entry.after;
    host.applyText(target, restoreOf(entry, direction), {
      bridge: true,
      direction,
      origin: entry.origin,
    });

    // ④ 消费游标（落地成功后才推进；顺序很重要，见文件头"先 peek 后消费"）
    const consumed = direction === "undo" ? api.undo(docKey) : api.redo(docKey);
    if (consumed && consumed.id !== entry.id) {
      // 理论不可达（peek 与 consume 之间无线程/无重入）；保守起见按错过处理
      return false;
    }

    // ④b adapter 基线必须前移到落地后的文本（v0.15.1 需求1）：
    // 不做的后果见 CoordinatorOptions.syncAdapterBaseline 的注释（redo 分支被 force-rebase 推平）。
    opts.syncAdapterBaseline?.(target);

    // ⑤ 宿主侧状态同步（setDirty / lastContentRef / 向上层报内容）
    host.afterApply?.(target, direction);
    return true;
  }

  /** 入库前同步 baseline：时间线 knownText 与宿主当前文本失配时，用宿主文本纠正 */
  function syncBaseline(docKey: string, before: string): void {
    const known = api.currentText(docKey);
    if (known !== null && known !== before) {
      // 宿主文本已偏离时间线（非编辑类动作改过内容）：以宿主为准，避免 commit 被拒后
      // 用户"再也撤不回来"（丢一步历史远好于永久失去撤销能力）
      api.rebaseText(docKey, before, { force: true });
    }
  }

  return {
    handleUndo(): boolean {
      return apply("undo");
    },

    handleRedo(): boolean {
      return apply("redo");
    },

    commitFromSource(plan): HistoryEntry | null {
      const docKey = host.docKey();
      if (!docKey) return null;
      syncBaseline(docKey, plan.before);
      const entry = api.commit(
        {
          before: plan.before,
          after: plan.after,
          origin: plan.origin,
          groupId: plan.groupId,
          beforeSelection: plan.beforeSelection,
          afterSelection: plan.afterSelection,
        },
        docKey,
      );
      if (entry) opts.onCommitted?.(entry);
      return entry;
    },

    commitFromPm(plan): HistoryEntry | null {
      const docKey = host.docKey();
      if (!docKey) return null;
      syncBaseline(docKey, plan.before);
      const entry = api.commit(
        { before: plan.before, after: plan.after, origin: plan.origin },
        docKey,
      );
      if (entry) opts.onCommitted?.(entry);
      return entry;
    },

    canUndo(): boolean {
      const docKey = host.docKey();
      return docKey ? api.canUndo(docKey) : false;
    },

    canRedo(): boolean {
      const docKey = host.docKey();
      return docKey ? api.canRedo(docKey) : false;
    },
  };
}

/**
 * 把一次性整篇替换（搜索替换 / 跨文件替换 / AI / 翻译）记进时间线。
 *
 * 单独一个函数而不是塞进 coordinator 的原因：**跨文件替换的目标文档不是当前活跃文档**
 * （用户此刻在别的标签里），因此不能走 `commitFromSource`（它用 `host.docKey()`）。
 * 这个函数显式接收 `docKey`，是对设计文档 §1.1「跨文件替换作为目标文档时间线上的普通
 * 条目」的直接实现。
 *
 * @returns 入库的条目；无效输入（before===after / 文档不存在）返回 null
 */
export function commitWholeText(
  api: DocumentHistoryApiEx,
  docKey: string,
  before: string,
  after: string,
  origin: HistoryEntry["origin"],
): HistoryEntry | null {
  if (!docKey || before === after) return null;
  // 跨文件替换往未激活文档记：先确认该文档时间线的 knownText 与 before 是否一致。
  // 不一致时以 before 为准 rebase（调用方已从 store 读到该标签的真实内容），
  // 否则 K 系列条目会被静默拒绝、用户切过去后无从撤销。
  const known = api.currentText(docKey);
  if (known === null) {
    api.begin(docKey, before);
  } else if (known !== before) {
    api.rebaseText(docKey, before, { force: true });
  }
  return api.commit({ before, after, origin }, docKey);
}
