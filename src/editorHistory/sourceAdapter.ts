/**
 * sourceAdapter —— v0.15.0 WP-B1 阶段 2：源码 textarea 编辑的**归并适配器**
 *
 * ## 职责边界
 *
 * 本模块只做一件事：把「textarea 的一次 onChange」翻译成「时间线需要的一条或多个
 * HistoryEntry」，并给出归并决策（连续打字合并、IME 一步、自动配对一步、粘贴一步）。
 * **它不碰 DOM、不写 textarea、不 dispatch** —— 落地由 coordinator + 宿主完成。
 * 因此可以在 Node 里用纯字符串把归并规则完整单测（见 `sourceAdapter.test.ts`）。
 *
 * ## 为什么归并要自己算（不能用 diff 猜）
 *
 * 设计文档 §1.3 的归并表靠**输入意图**，不靠文本形态：同样是「插入 1 个字符」，
 * 连续打字要合并，而一次 IME composition 提交是**独立一步**，粘贴又是另一步。
 * 只靠 `before/after` 的 diff 无法区分这几种，因此归并判定必须由调用方（EditorContainer）
 * 在事件现场给出 `kind`，本模块据 kind 决定 groupId 与是否合并。
 *
 * ## 与旧实现的关系（迁移必须保留的行为）
 *
 * `EditorContainer.tsx:890-913` 的 `pushUndoEntry` 已经有一套合并策略（连续纯插入 /
 * 连续退格 / Delete 键）。那套逻辑对**同一模式内**是够用的，但它按**文本形态**合并，
 * 无法表达"IME 一步"。本模块用 groupId 表达同一意图，并把「是否与上一条合并」交给
 * 时间线（`documentHistory.commit` 的同 groupId 合并），旧实现的形态匹配因此可以退役。
 */

import type { HistoryEntry, SourceSelection } from "../services/documentHistory";

/**
 * 一次源码编辑的**输入意图**。决定归并粒度（设计文档 §1.3 归并表左列）。
 *
 * - `typing`：连续键入。相邻偏移 + 900ms 内 + 无光标跳转 → 合并为一步；
 * - `ime`：IME composition 提交（`compositionstart → compositionend` 整段）→ 一步；
 * - `pair`：自动配对（`SourcePairPlan` 一次 `execCommand`）→ 一步；
 * - `paste`：粘贴 / 拖拽插入 / 块粘贴 → 一步；
 * - `delete`：连续退格 / Delete（同样按 typing 规则合并）；
 * - `replace`：搜索替换 current/replaceAll → 一步（origin="replace"）；
 * - `ai`：AI 整篇替换 / 续写采纳 → 一步（origin="ai"）；
 * - `external`：程序化写回（翻译回写、格式刷等 addToHistory:false 的整篇替换）→ 一步；
 * - `selection`：纯选区/滚动/高亮 → **不产生历史**。
 */
export type SourceEditKind =
  | "typing"
  | "ime"
  | "pair"
  | "paste"
  | "delete"
  | "replace"
  | "ai"
  | "external"
  | "selection";

/** 归并参数（设计文档 §1.3 冻结：连续 typing 900ms 内合并） */
export const TYPING_MERGE_WINDOW_MS = 900;

/** kind → 时间线 origin 的映射（归并粒度与安全护栏都看 origin） */
const ORIGIN_OF: Record<SourceEditKind, HistoryEntry["origin"] | null> = {
  typing: "source",
  delete: "source",
  ime: "source",
  pair: "source",
  paste: "source",
  replace: "replace",
  ai: "ai",
  external: "external",
  selection: null, // 不产生历史
};

/**
 * 归并上下文：**上一条**源码编辑的现场，用于判定"这次能否并进上一步"。
 *
 * 由 adapter 自己维护（`reset()` / 每次 commit 后更新），不依赖时间线内部状态 ——
 * 时间线只知道 groupId，不知道"上一次键击发生在几毫秒前、光标有没有跳过"。
 */
export interface SourceMergeState {
  /** 上一条的 groupId（无上一条 = null） */
  groupId: string | null;
  /** 上一条的 kind */
  kind: SourceEditKind | null;
  /** 上一条结束时的文本（= 本次 before 才能合并） */
  lastText: string | null;
  /** 上一条结束时的光标位置（判定"相邻偏移"、"无光标跳转"） */
  lastCaret: number | null;
  /** 上一条的时刻（`Date.now()` 口径，注入时钟便于测试） */
  lastAt: number;
  /**
   * 当前归并组的**起始现场**（v0.15.1 需求1）。
   *
   * 同组内后续事件不带 beforeSelection，只有开新组时才有；把它记下来，
   * 让同组后续 plan 也回填同一个起点 —— 这样即使 `documentHistory.commit`
   * 把多条合并成一条（只保留第一条的 beforeSelection），撤销位置也是对的。
   */
  groupStartSelection: SourceSelection | null;
}

/** 一个 adapter 实例（每文档一份；切换文档时 `reset()`） */
export interface SourceAdapter {
  /** 复位归并上下文（切文档 / 模式切换 / 外部重载后调用，防止跨文档合并） */
  reset(): void;
  /**
   * 把一次 textarea 内容变化翻译成时间线条目输入。
   *
   * @returns `null` = 本次变化不产生历史（纯选区 / 无变化）；否则返回可直接喂
   *          `documentHistory.commit()` 的入参（已算好 before/after/groupId/选区）。
   */
  plan(ev: SourceEditEvent): SourcePlan | null;
  /** 供诊断：当前归并上下文快照 */
  state(): SourceMergeState;
}

/** 一次 textarea 编辑事件的现场（由 EditorContainer 在 onChange / 事件钩子里采集） */
export interface SourceEditEvent {
  /**
   * 编辑**之后**的真实文本。必须是 unmask 过的真实内容（含完整 base64）：
   * 时间线绝不存 mask 后的展示文本（设计文档 §1.2 硬要求）。
   */
  text: string;
  /** 编辑前的真实文本（= 时间线当前文本，调用方从 ref 取，避免再读 textarea.value） */
  before: string;
  /**
   * 编辑**之前**的选区（光标 + scrollTop）。
   *
   * v0.15.1 需求1 修复：**必须采集**。旧实现只给了 `selection`（编辑后），
   * 于是 `HistoryEntry.beforeSelection` 永远为空 → 撤销时
   * `coordinator.restoreOf(entry, "undo")` 拿到 undefined → 源码模式撤销后
   * 光标跳到 0、滚动位置不恢复（用户实测"撤销后文档滚到底"的一半成因）。
   */
  beforeSelection?: SourceSelection;
  /** 编辑后的选区（textarea.selectionStart/End + scrollTop） */
  selection?: SourceSelection;
  /** 编辑后的光标位置（判定"相邻偏移"用；缺省取 selection.start） */
  caret?: number;
  /** 输入意图 */
  kind: SourceEditKind;
  /** 显式 groupId（调用方已知成组时给，例如同一 composition 的多条事件） */
  groupId?: string;
}

/** 计划产物：直接可作为 `documentHistory.commit()` 的入参 */
export interface SourcePlan {
  before: string;
  after: string;
  origin: HistoryEntry["origin"];
  groupId?: string;
  /**
   * v0.15.1 需求1：编辑**前**的现场（撤销目标位置）。
   * 归并进上一条时**保留上一条的 beforeSelection**（不覆盖）：一条历史代表
   * 「从 before 到 after」，撤销要回到的是**整组开始时**的光标位置。
   */
  beforeSelection?: SourceSelection;
  afterSelection?: SourceSelection;
}

/**
 * 判定「本次编辑能否并进上一条」。
 *
 * 设计文档 §1.3 的判据（**必须全部满足**）：
 * 1. 两条 kind 都属于「可合并连续键入族」（typing / delete）；
 * 2. 上一条文本 = 本次 before（时间线链连续）；
 * 3. 间隔 ≤ 900ms；
 * 4. 无光标跳转：本次光标 = 上一条光标 + 文本长度增量。
 *
 * 注意 delete 与 typing **可以互相合并**（"打字→退格→继续打字"在用户心智里是连续操作），
 * 但它们不并入 IME / 粘贴 / 自动配对（那些是独立的一步）。
 */
function canMergeTyping(
  state: SourceMergeState,
  before: string,
  after: string,
  caret: number,
  kind: SourceEditKind,
): boolean {
  if (kind !== "typing" && kind !== "delete") return false;
  if (state.kind !== "typing" && state.kind !== "delete") return false;
  if (state.lastText === null || state.lastText !== before) return false;
  if (state.lastCaret === null) return false;
  const delta = after.length - before.length;
  if (caret !== state.lastCaret + delta) return false; // 光标跳转过 → 独立一步
  return true;
}

/**
 * 创建一个源码编辑归并适配器。
 *
 * @param opts.now 注入时钟（测试用；生产用 `Date.now`）。**不读全局 Date** 是为了让
 *                 「900ms 窗口」在单测里可精确复现（否则只能靠 sleep，必然 flaky）。
 */
export function createSourceAdapter(opts?: { now?: () => number }): SourceAdapter {
  const now = opts?.now ?? (() => Date.now());
  const emptyState = (): SourceMergeState => ({
    groupId: null,
    kind: null,
    lastText: null,
    lastCaret: null,
    lastAt: 0,
    groupStartSelection: null,
  });
  let state: SourceMergeState = emptyState();
  /** 归并组序号（每次开新组 +1，groupId 因此全局不重复） */
  let seq = 0;

  return {
    reset(): void {
      state = emptyState();
    },

    state(): SourceMergeState {
      return { ...state };
    },

    plan(ev: SourceEditEvent): SourcePlan | null {
      const origin = ORIGIN_OF[ev.kind];
      // 纯选区/滚动：不产生历史，也**不打断**归并组（用户只是点了下别处又回来继续打）
      if (origin === null) return null;
      if (ev.text === ev.before) return null; // 无变化

      const t = now();
      const caret = ev.caret ?? ev.selection?.start ?? 0;
      const mergeable = canMergeTyping(state, ev.before, ev.text, caret, ev.kind);
      const inWindow = t - state.lastAt <= TYPING_MERGE_WINDOW_MS;

      let groupId: string | undefined;
      /** 本条的"编辑前现场"：合并进上一组时沿用整组起点（见 SourcePlan 注释） */
      let beforeSelection: SourceSelection | undefined;
      if (mergeable && inWindow && state.groupId) {
        // 并入上一条：沿用同一 groupId（时间线据此合并成一步）
        groupId = state.groupId;
        beforeSelection = state.groupStartSelection ?? ev.beforeSelection;
      } else if (ev.groupId) {
        groupId = ev.groupId; // 调用方显式成组（IME composition 多事件）
        beforeSelection = ev.beforeSelection;
      } else if (ev.kind === "typing" || ev.kind === "delete") {
        groupId = `src-typing-${++seq}`; // 开新归并组
        beforeSelection = ev.beforeSelection;
      } else {
        groupId = undefined; // IME/粘贴/配对/替换/AI：一次性一步，不需要 groupId
        beforeSelection = ev.beforeSelection;
      }

      // 更新归并上下文（下一次判定的"上一条"）
      state = {
        groupId: groupId ?? null,
        kind: ev.kind,
        lastText: ev.text,
        lastCaret: caret,
        lastAt: t,
        // 开新组时记下起点；同组内保持不变（撤销要回到整组开始的位置）
        groupStartSelection: beforeSelection ?? null,
      };

      return {
        before: ev.before,
        after: ev.text,
        origin,
        groupId,
        beforeSelection,
        afterSelection: ev.selection,
      };
    },
  };
}

/**
 * 从一次 textarea 变化推导**输入意图**（供 EditorContainer 在 onChange 里调用）。
 *
 * 这是纯函数，`onChange` 里拿不到"用户按了什么键"，只能拿 `inputType`（beforeinput）
 * 或自身维护的「composition / paste 标记」。这里的判据只覆盖可以从**文本形态 + 上下文
 * 标记**可靠推出的部分，其余一律退化为 `typing`（保守：宁可多一步，也不漏一步）。
 *
 * @param ctx.composing 是否处于 IME composition 中（compositionstart 至 compositionend 之间）
 * @param ctx.justPaired 上一步是自动配对落地（`applySourcePairPlan` 后立即置位）
 * @param ctx.justPasted 上一步是粘贴落地（paste 事件最近一次）
 */
export function inferSourceEditKind(ctx: {
  before: string;
  after: string;
  composing?: boolean;
  justPaired?: boolean;
  justPasted?: boolean;
}): SourceEditKind {
  if (ctx.composing) return "ime";
  if (ctx.justPasted) return "paste";
  if (ctx.justPaired) return "pair";
  // 纯删除（after 是 before 的子序列且更短）→ delete，可与 typing 合并
  if (ctx.after.length < ctx.before.length && ctx.before.includes(ctx.after)) return "delete";
  return "typing";
}
