import { create } from "zustand";
import type { WordCountResult } from "../utils/wordCount";
// 直接从 i18n/state 引入（不经过 i18n/index，避免 index → useSettingsStore 的依赖回环）
import { t } from "../i18n/state";
import { safeSetItem } from "../utils/safeStorage";
import { withWindowSuffix } from "../utils/windowLabel";

/**
 * 视图模式（v0.14.0 需求1：由三模式合并为二模式）。
 *
 * 旧口径是 `"preview" | "edit" | "split"`：阅读 / 编辑（纯源码） / 分屏（左源码右预览）。
 * 用户要求「菜单入口只留阅读和编辑两个模式，点击编辑模式默认进入的是原来的分屏模式」，
 * 因此：
 * - `"edit"` = 编辑模式，**默认带右侧预览**（即旧 `split` 的观感）；
 * - 右侧预览的开关是独立状态 `splitPreviewOpen`（编辑模式内可关，关掉后就是旧 `edit`）。
 *
 * ⚠️ 全仓判据统一为：
 * - 是否源码编辑区可见 → `viewMode !== "preview"`（**不要再写 `=== "edit" || === "split"`**）
 * - 是否显示右侧预览   → `viewMode === "edit" && splitPreviewOpen`
 */
export type ViewMode = "preview" | "edit";

/* ══════════════════════════════════════════════════════════════════════════
 * v0.17.0 第二轮（#10「编辑模式下关软件，重开没保持编辑模式」）：
 * **视图模式的跨会话记忆**
 *
 * ## 为什么不用 zustand `persist`
 *
 * `useEditorStore` 里有 `openTabs` / `activeTabIdx` / `isDirty` / `openTabs[].content`
 * 等**与 `useFileStore`、`untitledTabs`、`open-file-tabs` 三处持久化重复的字段**。
 * 给整个 store 挂 `persist` 就必须写一份巨型 `partialize` 排除清单，
 * 且任何一次漏排除都会造成"两套持久化互相覆盖"（标签顺序抖动、脏标记错乱）——
 * 风险远大于收益。这里只做**两个字段**的手写持久化，读写都是 O(1)，零依赖。
 *
 * ## key 口径（与 `fileScrollProgress` / `lastActiveTab` 完全一致）
 * 视图模式是**窗口级**数据：main 用无后缀旧 key（将来若要从别的 key 迁移也零成本），
 * `sec-*` 用 `-{label}` 后缀，遵循 v0.9.0「同一文件在不同窗口可各自阅读/编辑」的决策。
 * 多窗口语义 = **每个窗口各记各的**（不做全局统一：窗口 A 在阅读、窗口 B 在编辑是合法状态）。
 *
 * ## ⚠️ 已知边界（本文件内无法处理，需 `utils/windowSlot.ts` 补一行）
 * 辅助窗口的**槽位复用**（sec-3 关闭后重建为 sec-3）不会清掉本 key，
 * 新窗口会继承上一轮该槽位的模式。`clearSlotResidue()` 是唯一清理点，但它在
 * `App.tsx` 启动分流里调用、本文件无权改。影响仅为「新窗口初始模式」这一处观感，
 * 不涉及数据。修复方式：在 `clearSlotResidue` 里加一行删除 `LIGHTMD_VIEW_MODE_KEY-{label}`。
 * 主窗口（`main`）不受影响。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 视图模式持久化的基键（窗口后缀由 `withWindowSuffix` 追加） */
export const VIEW_MODE_PREF_KEY = "lightmd-view-mode";

/**
 * 视图模式变更的**来源标记**（v0.17.0 第二轮，可选）。
 *
 * 用途：区分"用户主动切换"与"程序强制降级"。持久化侧据此决定
 * `splitPreviewOpen` 是否跟随写入（强制降级时**不**覆盖用户偏好）。
 *
 * 当前只有 `"large-file"`：`App.tsx` 打开 >`HUGE_FILE_THRESHOLD` 的文件时
 * 强制 `edit` + 关预览。
 *
 * ⚠️ 不传 = 普通用户操作，行为与既有完全一致（现存 30+ 调用点零改动）。
 * 新增其它强制路径时在这里加值，并在调用点显式传入 —— 否则形状判据可能误伤
 * （见 `schedulePersist` 上方的"失效条件"清单）。
 */
export type ViewModeChangeReason = "large-file";

/** `setViewMode` / `setSplitPreviewOpen` 的可选第二参（向后兼容） */
export interface ViewModeChangeOptions {
  reason?: ViewModeChangeReason;
}

/** 持久化载荷版本：字段口径变化时递增，旧版本静默丢弃（回默认值，不崩） */
const VIEW_MODE_PREF_VERSION = 1;

/** 持久化载荷形状 */
interface ViewModePref {
  v: number;
  viewMode: ViewMode;
  splitPreviewOpen: boolean;
}

/** 本窗口的持久化 key */
function viewModePrefKey(): string {
  return withWindowSuffix(VIEW_MODE_PREF_KEY);
}

/**
 * 启动时读回上次会话的视图模式。
 *
 * 容错策略（老用户升级 / localStorage 被手改 / 隐私模式下读写抛异常）：
 * **任何异常或非法值 → 返回 null**，调用方落回既有默认值（阅读模式 + 预览开）。
 * 绝不因为读失败就抛，也绝不"部分采信"（例如只认 viewMode 不认 splitPreviewOpen）——
 * 半个状态比默认值更难解释。
 */
export function loadViewModePref(): { viewMode: ViewMode; splitPreviewOpen: boolean } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(viewModePrefKey());
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ViewModePref> | null;
    if (!p || typeof p !== "object") return null;
    const mode = p.viewMode === "edit" || p.viewMode === "preview" ? p.viewMode : null;
    if (!mode) return null;
    return {
      viewMode: mode,
      // 缺失/非法 → 与 store 默认值一致（true）
      splitPreviewOpen: typeof p.splitPreviewOpen === "boolean" ? p.splitPreviewOpen : true,
    };
  } catch {
    return null;
  }
}

/** 写回视图模式（内部用；`safeSetItem` 自带配额/异常兜底） */
function saveViewModePref(pref: ViewModePref): void {
  try {
    if (typeof localStorage === "undefined") return;
    safeSetItem(viewModePrefKey(), JSON.stringify(pref));
  } catch {
    // 忽略：持久化失败不影响当前会话使用
  }
}

/**
 * 持久化写入的**合批器**（v0.17.0 第二轮的关键细节，别删）。
 *
 * ## 为什么需要"合批 + 强制降级识别"
 *
 * 大文件（> `HUGE_FILE_THRESHOLD`）打开时，`App.tsx` 会**强制**
 * `setViewMode("edit")` + `setSplitPreviewOpen(false)`（同一同步块内两次 set）。
 * 若无脑跟着写盘，用户的真实偏好「编辑 + 带预览」会被这一次强制降级**永久覆盖**：
 * 之后每次重启都是「编辑 + 无预览」，要重新点一次预览开关。
 *
 * ## 识别方式：**显式来源标记优先，形状判据兜底**
 *
 * ① **首选（精确）**：调用方通过 `setViewMode(mode, { reason: "large-file" })` 显式声明
 *    这是强制降级。此时**只**记 `viewMode`，`splitPreviewOpen` 保留上一次落盘的用户偏好。
 *    - `ViewModeChangeOptions.reason` 是**可选第二参**，现存的 30+ 个调用点零改动、
 *      行为完全不变（不传 reason = 普通用户操作）。
 *    - **升级路径**：`App.tsx` 的大文件分支将来只需补一个 `{ reason: "large-file" }`，
 *      下面的形状判据即可退役（届时删除 `looksLikeForcedDowngrade` 与 `splitChanged` 字段）。
 *
 * ② **兜底（形状推断）**：调用方没传 reason 时，按"同一合批里**同时**出现
 *    `viewMode: preview → edit` **且** `splitPreviewOpen: true → false`"判定。
 *    用户手动关预览（点「关闭预览」/双击 Shift）**不会**改变 `viewMode`
 *    → 不满足条件 → 正常持久化，行为符合预期。
 *
 * ## ⚠️ 形状判据的失效条件（未来出现这些路径就必须改用 ①）
 * 只要出现**任何一个**"用户在单次操作里既进编辑、又关预览"的路径，形状判据就会把
 * 用户的真实选择误判成强制降级，导致"关预览重启后又变回带预览"：
 * - 新增「进编辑模式但默认不带预览」的偏好设置；
 * - 新增「阅读模式下直接切到纯源码编辑」的快捷入口（一条命令里 set 两次）；
 * - 大文件提示里加"以后都用纯编辑打开"的一键选项。
 * 出现上述任一情况时，**必须**让对应调用点传 `{ reason: ... }`，否则本条启发式会误伤。
 * 这条注释是有意的"未来反例"标记 —— 见单测
 * `v0170-r2-mode-persist.test.ts` 的同名反例说明。
 */
const FLUSH_DELAY_MS = 600;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 本次合批内观测到的原始状态（用于强制降级识别） */
let batch: {
  viewMode: ViewMode;
  splitPreviewOpen: boolean;
  /** 合批期间 viewMode 是否发生过变化 */
  modeChanged: boolean;
  /** 合批期间 splitPreviewOpen 是否发生过变化（仅形状判据用） */
  splitChanged: boolean;
  /** 合批开始时（= 上次落盘）的 splitPreviewOpen */
  prevSplitPreviewOpen: boolean;
  /** 合批内是否出现过**显式**的强制降级标记（优先于形状判据） */
  explicitForced: boolean;
} | null = null;

/**
 * 形状判据：本次合批是否**看起来**是强制降级。
 * 仅在调用方没给 `reason` 时使用（见上方 ②）。
 */
function looksLikeForcedDowngrade(b: NonNullable<typeof batch>): boolean {
  return (
    b.modeChanged &&
    b.splitChanged &&
    b.viewMode === "edit" &&
    b.splitPreviewOpen === false &&
    b.prevSplitPreviewOpen === true
  );
}

function schedulePersist(
  next: { viewMode: ViewMode; splitPreviewOpen: boolean },
  prev: { viewMode: ViewMode; splitPreviewOpen: boolean },
  /** 显式来源标记（`"large-file"` 等）；缺省走形状判据 */
  reason?: ViewModeChangeReason,
): void {
  // 第一次真正要写的时候才装监听（避免 import 即注册，单测环境更干净）
  installUnloadHook();
  if (!batch) {
    batch = {
      viewMode: next.viewMode,
      splitPreviewOpen: next.splitPreviewOpen,
      modeChanged: false,
      splitChanged: false,
      prevSplitPreviewOpen: prev.splitPreviewOpen,
      explicitForced: false,
    };
  }
  batch.viewMode = next.viewMode;
  batch.splitPreviewOpen = next.splitPreviewOpen;
  if (next.viewMode !== prev.viewMode) batch.modeChanged = true;
  if (next.splitPreviewOpen !== prev.splitPreviewOpen) batch.splitChanged = true;
  if (reason === "large-file") batch.explicitForced = true;

  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const b = batch;
    batch = null;
    if (!b) return;
    // ① 显式标记优先；② 无标记时退回形状判据
    const forcedDowngrade = b.explicitForced || looksLikeForcedDowngrade(b);
    saveViewModePref({
      v: VIEW_MODE_PREF_VERSION,
      viewMode: b.viewMode,
      splitPreviewOpen: forcedDowngrade ? true : b.splitPreviewOpen,
    });
  }, FLUSH_DELAY_MS);
}

/**
 * 立即冲刷待写状态（窗口关闭前调用，避免最后 600ms 内的切换丢失）。
 *
 * **通常不需要手动调用**：`installUnloadHook()` 已在 `beforeunload` / `pagehide`
 * 上自注册。保留本导出是为了让"先刷再跳转"的极端场景（如外部协议跳转）能显式收尾。
 * 未被调用时最坏丢失一次"关软件前 0.6 秒内做的模式切换"，不影响正确性。
 */
export function flushViewModePref(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const b = batch;
  batch = null;
  if (!b) return;
  const forcedDowngrade = b.explicitForced || looksLikeForcedDowngrade(b);
  saveViewModePref({
    v: VIEW_MODE_PREF_VERSION,
    viewMode: b.viewMode,
    splitPreviewOpen: forcedDowngrade ? true : b.splitPreviewOpen,
  });
}

/** 测试用：清掉待写状态（不写盘） */
export function __resetViewModePrefForTest(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  batch = null;
}

/**
 * 关闭窗口前自动冲刷（**模块自注册**，不需要 `App.tsx` 接线）。
 *
 * ## 为什么放这里而不是 App.tsx
 * 视图模式是 store 自己的字段，冲刷逻辑应当与它同处一个模块（否则 `App.tsx`
 * 每加一处退出路径都要记得补一行，漏一次就丢一笔）。注册是幂等的，
 * 用模块级 `unloadHookInstalled` 防重复（StrictMode / HMR / 单测多次 import）。
 *
 * ## 为什么同时听 `beforeunload` 和 `pagehide`
 * WebView2 在某些关闭路径（尤其 Rust 侧 `app.exit()`）只派发 `pagehide`；
 * 只挂 `beforeunload` 会丢掉"关软件前 0.6 秒内的模式切换"。
 * 与本项目大纲滚动位置冲刷（`App.tsx`）同一套兜底理由。
 *
 * ⚠️ 监听器**只**做"把待写状态落盘"，不修改任何 store 字段 —— 在卸载期改状态
 * 会触发 React 警告，且没有任何收益。
 */
let unloadHookInstalled = false;
function installUnloadHook(): void {
  if (unloadHookInstalled) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  unloadHookInstalled = true;
  const flush = () => flushViewModePref();
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
}

/**
 * 启动期的视图模式（模块求值期读一次，`create()` 初始化时直接用）。
 * 读失败恒为默认值，绝不会让 store 创建失败。
 */
const DEFAULT_VIEW_MODE_PREF = { viewMode: "preview" as ViewMode, splitPreviewOpen: true };
const viewModePrefAtBoot = loadViewModePref() ?? DEFAULT_VIEW_MODE_PREF;

export interface TabInfo {
  path: string;
  name: string;
  content?: string;
  isDirty?: boolean;
  /**
   * v0.8.0 WP1：临时（未落盘）文件标识。
   * 为 true 时 path 恒为空串（""）——空串是 falsy，自动保存
   * （useAutoSave 的 !filePath 守卫）、版本快照、recentFiles 等
   * 既有按路径判断的逻辑天然跳过，无需把 path 改成可空类型。
   * 用户另存为获得真实路径后置回 false（见 promoteTab）。
   */
  isUntitled?: boolean;
  /** v0.8.0 WP1：临时文件稳定标识（untitled-N），用于持久化恢复与去重 */
  id?: string;
  /** v0.8.0 WP3 需求8：固定标签页。固定标签排到最前、不显示关闭按钮、关闭其他/左/右时豁免 */
  pinned?: boolean;
  /**
   * v0.8.0 修复 P2：临时标签记录"新建它之前所在的标签"（id ?? path）。
   * 需求2 问题2：双击新建临时文件后若反悔关闭它，应回到原来的文件（阅读位置不变），
   * 而不是按"优先右侧否则左侧"跳到相邻标签。
   */
  returnToId?: string;
  /**
   * v0.9.0 WP9：只读打开标记。
   *
   * 同一文件已在其他窗口以未保存修改（dirty）状态打开时，本窗口可选择「只读打开」：
   * ProseMirror `editable() => false`、源码 textarea readOnly、标题栏显示 `[只读]`。
   * 标签级（非全局）——同一窗口内其他标签不受影响。
   */
  isReadonly?: boolean;
  /**
   * v0.9.0 WP9：该标签在**脏**状态下被外部修改过（`lightmd:fileChanged` 检测到）。
   *
   * 此时磁盘内容已不是本标签编辑所基于的版本，保存会静默覆盖外部改动。
   * 保存前弹「覆盖 / 另存为 / 取消」三选一（N22）。
   */
  isExternallyChanged?: boolean;
  /**
   * v0.12.0 需求7：文件条目创建时间戳（ms）。
   * 临时（未落盘）标签在 createUntitledTab 时写入 Date.now()，并随
   * untitledTabs 持久化（重启后与重启前一致）；真实文件不使用本字段
   * （其创建时间来自 FileNode.createdMs）。
   * 可选：兼容存量标签与测试 mock，缺失时侧栏不显示日期。
   */
  createdAt?: number;
}

/**
 * v0.6.3 P0-2：翻译撤销快照——绑定文档上下文。
 * 恢复原文前校验 filePath/key 与当前文档一致，防止跨文件/跨版本恢复（A 的原文灌进 B）。
 */
export interface TranslateUndoSnapshot {
  /** 回写前的原文全文 */
  content: string;
  /** 回写时的文件路径（null = 未保存的新文件） */
  filePath: string | null;
  /**
   * 回写时的 forceUpdateKey（保留字段，仅作记录）。
   * v0.7.4 问题4：不再用于归属校验——切标签会递增该计数（App.handleTabSwitch），
   * "全文翻译 → 切走 → 切回" 属正常操作却会让 key 变化，用它校验会导致
   * "取消翻译"按钮可见但点击无效。归属判定统一走 isTranslateSnapshotForFile。
   */
  key: number;
}

/**
 * v0.7.4 问题4：判断翻译撤销快照是否属于指定文档。
 *
 * 只按 filePath 判定归属：filePath 是文档的稳定标识，而 key（forceUpdateKey）
 * 会因切换标签/窗口等外部更新递增，不能代表"换了文档"。
 * 该判定被"取消翻译"气泡渲染（TranslateUndoToast）与恢复逻辑（undoTranslation）
 * 共用，避免两处规则不一致导致按钮可见却点击无效。
 *
 * filePath 为 null 时（未保存的新文件，仅浏览器演示态可能出现）仅有一个文档实例，
 * 同为 null 即视为归属一致。
 */
export function isTranslateSnapshotForFile(
  snapshot: TranslateUndoSnapshot | null,
  filePath: string | null | undefined,
): boolean {
  return snapshot !== null && snapshot.filePath === (filePath ?? null);
}

interface EditorState {
  filePath: string | null;
  isDirty: boolean;
  /**
   * v0.6.1 问题3：翻译回写（直接替换/双语对照）产生的修改不自动保存，
   * 仅在用户手动保存（Ctrl+S / 菜单）或继续手动编辑后恢复自动保存
   */
  suppressAutoSave: boolean;
  /**
   * v0.6.1 问题2：翻译回写前的原文全文快照。
   * 非空时显示浮动"取消翻译"气泡，点击恢复原文；
   * 用户手动编辑/手动保存/切换文件后清除
   * v0.6.3 P0-2：绑定文档上下文（filePath/key），恢复前校验归属
   */
  translateUndoSnapshot: TranslateUndoSnapshot | null;
  cursorLine: number;
  // v0.11.0 B4-10：阅读进度（0~100，状态栏显示；0 = 不可用/无滚动）
  scrollProgress: number;
  /** v0.8.3 需求3：光标列号（1 起，源码模式与阅读模式均生效） */
  cursorColumn: number;
  /** v0.8.3 需求3：当前选中字符数（无选区为 0） */
  selectedChars: number;
  /** 字数统计详情（G11：扩展为对象，含字数/字符数/行数/段落数/阅读时长） */
  wordCount: WordCountResult;
  viewMode: ViewMode;
  /**
   * v0.14.0 需求1：编辑模式内「右侧预览面板」是否展开。
   *
   * 语义：`viewMode === "edit" && splitPreviewOpen` 等价于旧的三模式里的 `split`；
   * `viewMode === "edit" && !splitPreviewOpen` 等价于旧的 `edit`（纯源码）。
   * 与 viewMode 分开存，是为了「切到阅读再切回编辑」能恢复用户上次的预览开关状态。
   */
  splitPreviewOpen: boolean;
  /**
   * @deprecated v0.14.0 需求1：三模式合并后不再有「上一个非分屏模式」。
   * 保留字段只是为了让既有测试/外部引用不炸，业务代码**不应再读它**。
   */
  prevViewMode: ViewMode;
  focusMode: boolean;
  // 源码模式下的语法插入回调，由 EditorContainer 注册
  //
  // v0.11.0 B3-3：新增第 3 参 `opts.label`。
  // 脚注定义需要动态 label（源码模式原固定 `[^1]:`，连续插入两次会产生重复
  // label 导致后者覆盖前者、内容丢失）。label 由持有源码 textarea ref 的
  // EditorContainer 计算（内部有当前文本），App 侧无需感知文本。
  sourceInsertHandler:
    | ((syntax: string, cursorOffset?: number, opts?: { label?: string; ghost?: string }) => void)
    | null;
  // 撤销/恢复回调，由 EditorContainer 注册
  undoHandler: (() => void) | null;
  redoHandler: (() => void) | null;
  // 搜索/替换
  showSearch: boolean;
  showSearchReplace: boolean;
  /** 搜索框聚焦触发器：每次开启搜索时递增，SearchReplaceDialog 监听变化重新聚焦 */
  searchFocusKey: number;
  // 多标签页
  openTabs: TabInfo[];
  activeTabIdx: number;
  /** v0.4.0：当前文件语言标识（如 "javascript"/"python"/"markdown"），用于代码文件语法高亮 */
  currentLanguage: string;

  openFile: (path: string | null) => void;
  /** v0.4.0：设置当前文件语言标识（由 App.tsx 在打开文件时根据扩展名设置） */
  setCurrentLanguage: (lang: string) => void;
  setDirty: (dirty: boolean) => void;
  /** v0.6.1 问题3：设置翻译回写后的自动保存抑制标志 */
  setSuppressAutoSave: (v: boolean) => void;
  /** v0.6.1 问题2：设置/清除翻译取消快照（v0.6.3 P0-2：绑定文档上下文） */
  setTranslateUndoSnapshot: (v: TranslateUndoSnapshot | null) => void;
  setCursorLine: (line: number) => void;
  /** v0.11.0 B4-10：设置阅读进度（0~100） */
  setScrollProgress: (pct: number) => void;
  /** v0.8.3 需求3：设置光标列号 */
  setCursorColumn: (column: number) => void;
  /** v0.8.3 需求3：设置选中字符数 */
  setSelectedChars: (count: number) => void;
  /** 更新字数统计详情（接收 calculateWordCount 的结果） */
  setWordCount: (count: WordCountResult) => void;
  /**
   * 设置视图模式（v0.14.0 二模式：`preview` | `edit`）。
   *
   * v0.17.0 第二轮（#10）：本 action 额外把模式**持久化**（600ms 合批落盘）。
   * `opts.reason` 可选：传 `"large-file"` 表示"程序强制降级"，
   * 此时持久化侧**不会**用降级后的 `splitPreviewOpen=false` 覆盖用户偏好。
   * 不传 = 用户主动切换（现存 30+ 调用点零改动）。
   */
  setViewMode: (mode: ViewMode, opts?: ViewModeChangeOptions) => void;
  /**
   * v0.14.0 需求1：设置编辑模式内右侧预览面板的展开状态。
   * 非编辑模式下调用只记状态、不产生视觉影响（切回编辑时按此恢复）。
   *
   * v0.17.0 第二轮（#10）：同样纳入持久化。`opts.reason` 同 `setViewMode`。
   */
  setSplitPreviewOpen: (open: boolean, opts?: ViewModeChangeOptions) => void;
  /** v0.14.0 需求1：双击 Shift / 分割条上的「关闭预览 / 打开预览」共用的开关 */
  toggleSplitPreview: () => void;
  toggleFocusMode: () => void;
  setSourceInsertHandler: (handler: ((syntax: string, cursorOffset?: number, opts?: { label?: string; ghost?: string }) => void) | null) => void;
  setUndoHandler: (handler: (() => void) | null) => void;
  setRedoHandler: (handler: (() => void) | null) => void;
  setShowSearch: (show: boolean) => void;
  /** 切换搜索框开关（底部栏按钮使用） */
  toggleSearch: () => void;
  setShowSearchReplace: (show: boolean) => void;
  markSaved: () => void;
  addTab: (tab: TabInfo) => void;
  setActiveTab: (idx: number) => void;
  closeTab: (idx: number) => TabInfo | null;
  updateTabContent: (idx: number, content: string) => void;
  updateTabDirty: (idx: number, isDirty: boolean) => void;
  getTabByPath: (path: string) => number;
  /**
   * v0.8.0 WP1：新建临时（未落盘）标签并激活。
   * 命名"新文件N"，N 取现存临时标签最大序号 +1（不复用被关闭的序号）。
   */
  createUntitledTab: () => void;
  /**
   * v0.8.0 WP1：把临时标签晋升为正式文件（另存为成功后调用）。
   * 写入真实路径与文件名、清除 isUntitled/id。
   */
  promoteTab: (idx: number, path: string, name: string) => void;
  /** v0.8.0 WP1：按 id 查找临时标签下标（持久化恢复去重用） */
  getTabById: (id: string) => number;
  /**
   * v0.8.0 WP3 需求8：固定/取消固定标签。
   * 固定后标签排到最前（"固定区在前"），用稳定排序保持各组内相对顺序；
   * activeTabIdx 重映射回切换前的活跃标签，避免固定操作改变当前编辑位置。
   */
  togglePin: (idx: number) => void;
  /** v0.8.0 WP3 需求8：重命名未落盘（untitled）标签，仅改 name 不落盘 */
  renameUntitledTab: (idx: number, name: string) => void;
  /**
   * v0.9.0 WP9：设置标签的只读标记（「只读打开」冲突处理选项）。
   * 只读标签禁止编辑，但仍可阅读/复制/导出。
   */
  setTabReadonly: (idx: number, isReadonly: boolean) => void;
  /** v0.9.0 WP9：标记/清除「脏状态下被外部修改」（保存前的竞态确认） */
  setTabExternallyChanged: (idx: number, changed: boolean) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  filePath: null,
  isDirty: false,
  suppressAutoSave: false,
  translateUndoSnapshot: null,
  cursorLine: 0,
  // v0.11.0 B4-10
  scrollProgress: 0,
  cursorColumn: 0,
  selectedChars: 0,
  wordCount: { words: 0, chars: 0, charsNoSpaces: 0, lines: 0, paragraphs: 0, readingTimeMin: 0 },
  /**
   * v0.17.0 第二轮（#10）：启动时读回上次会话的视图模式。
   * 无持久化数据 / 数据非法 / 老用户升级 → 落回既有默认（阅读模式 + 预览开）。
   * ⚠️ 必须写在这里（模块求值期）而不是 hydration effect：首帧就要正确，
   * 否则会先渲染阅读面再跳编辑面（用户看到一闪）。读一次 JSON.parse，开销可忽略。
   */
  viewMode: viewModePrefAtBoot.viewMode,
  // v0.14.0 需求1：编辑模式默认带右侧预览（= 旧的三模式里的「分屏」）
  // v0.17.0 第二轮（#10）：同上，按上次会话恢复（缺省 true）
  splitPreviewOpen: viewModePrefAtBoot.splitPreviewOpen,
  /** @deprecated 三模式合并后无意义，仅为兼容既有引用保留 */
  prevViewMode: "preview",
  focusMode: false,
  sourceInsertHandler: null,
  undoHandler: null,
  redoHandler: null,
  showSearch: false,
  showSearchReplace: false,
  searchFocusKey: 0,
  openTabs: [],
  activeTabIdx: 0,
  // v0.4.0：默认 markdown，打开非 md 文件时由 App.tsx 设置为对应语言
  currentLanguage: "markdown",

  // v0.7.4 修复：不再清 translateUndoSnapshot——全文翻译/润色的"取消"快照应
  // 跨标签切换保留（切走再切回同一文档、且文档未编辑/未关闭时气泡仍在）。
  // 快照本身绑定 filePath/key，恢复时按归属校验；Toast 显示也按文件归属过滤，
  // 故跨文档不会误恢复/误显示。
  // v0.8.3 需求3：切换文件时同步重置光标列号与选中字符数（行号原有行为不变）
  openFile: (path) => set({
    filePath: path,
    isDirty: false,
    suppressAutoSave: false,
    cursorLine: 0,
    cursorColumn: 0,
    selectedChars: 0,
  }),
  setCurrentLanguage: (lang) => set({ currentLanguage: lang }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  setSuppressAutoSave: (v) => set({ suppressAutoSave: v }),
  setTranslateUndoSnapshot: (v) => set({ translateUndoSnapshot: v }),
  setCursorLine: (line) => set({ cursorLine: line }),
  // v0.11.0 B4-10：钳制到 0~100，避免异常值影响 UI
  setScrollProgress: (pct) =>
    set({ scrollProgress: Math.max(0, Math.min(100, Math.round(pct))) }),
  setCursorColumn: (column) => set({ cursorColumn: column }),
  setSelectedChars: (count) => set({ selectedChars: count }),
  setWordCount: (count) => set({ wordCount: count }),
  /**
   * v0.17.0 第二轮（#10）：视图模式变化 → 合批持久化。
   *
   * 只做「记下来」这一个副作用，**不改变任何 UI 语义**：
   * 所有既有调用点（菜单 / 命令总线 / 双击 Ctrl / 大文件降级）都不用改。
   * 写盘走 600ms 合批，滚动/切换不会产生额外 localStorage 压力。
   */
  setViewMode: (mode, opts) => {
    const prev = { viewMode: get().viewMode, splitPreviewOpen: get().splitPreviewOpen };
    set({ viewMode: mode });
    if (prev.viewMode !== mode) {
      schedulePersist({ viewMode: mode, splitPreviewOpen: prev.splitPreviewOpen }, prev, opts?.reason);
    }
  },
  // v0.14.0 需求1：预览面板开关。
  // 只改 splitPreviewOpen，**不动 viewMode**——用户在编辑模式里关预览是为了腾出宽度，
  // 不应该因此掉回阅读模式；切到阅读再切回编辑时按此状态恢复。
  // v0.17.0 第二轮（#10）：同时纳入跨会话记忆（强制降级识别见 schedulePersist 注释）
  setSplitPreviewOpen: (open, opts) => {
    const prev = { viewMode: get().viewMode, splitPreviewOpen: get().splitPreviewOpen };
    set({ splitPreviewOpen: open });
    if (prev.splitPreviewOpen !== open) {
      schedulePersist({ viewMode: prev.viewMode, splitPreviewOpen: open }, prev, opts?.reason);
    }
  },
  toggleSplitPreview: () => {
    const prev = { viewMode: get().viewMode, splitPreviewOpen: get().splitPreviewOpen };
    const next = !prev.splitPreviewOpen;
    set({ splitPreviewOpen: next });
    schedulePersist({ viewMode: prev.viewMode, splitPreviewOpen: next }, prev);
  },
  toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),
  setSourceInsertHandler: (handler) => set({ sourceInsertHandler: handler }),
  setUndoHandler: (handler) => set({ undoHandler: handler }),
  setRedoHandler: (handler) => set({ redoHandler: handler }),
  // 开启搜索时递增 searchFocusKey，触发 SearchReplaceDialog 重新聚焦（解决 Ctrl+F 重复按无反应）
  setShowSearch: (show) => set((s) => show
    ? { showSearch: true, showSearchReplace: false, searchFocusKey: s.searchFocusKey + 1 }
    : { showSearch: false }),
  // 底部栏按钮切换：已开启则关闭，未开启则开启并聚焦
  toggleSearch: () => set((s) => s.showSearch
    ? { showSearch: false }
    : { showSearch: true, showSearchReplace: false, searchFocusKey: s.searchFocusKey + 1 }),
  setShowSearchReplace: (show) => set((s) => show
    ? { showSearchReplace: true, showSearch: true, searchFocusKey: s.searchFocusKey + 1 }
    : { showSearchReplace: false }),
  // 手动保存完成：同时解除翻译回写的自动保存抑制与取消快照（v0.6.1 问题2/3）
  markSaved: () => set({ isDirty: false, suppressAutoSave: false, translateUndoSnapshot: null }),
  addTab: (tab) => set((s) => {
    // v0.8.0 WP1：临时标签的 path 恒为空串，不能参与 path 去重（否则第二个临时
    // 文件会被当成第一个而被吞掉）。按 id 去重，保证同 id 恢复不重复开标签。
    if (tab.isUntitled) {
      const existIdx = tab.id ? s.openTabs.findIndex((t) => t.id === tab.id) : -1;
      if (existIdx !== -1) return { activeTabIdx: existIdx };
      return { openTabs: [...s.openTabs, tab], activeTabIdx: s.openTabs.length };
    }
    // 如果标签已存在（path 相同），切换到该标签并同步更新 name/content
    // 修复：通过文件夹打开文件时，旧逻辑仅切换不更新 name，导致标签显示目录名
    const existIdx = s.openTabs.findIndex((t) => t.path === tab.path);
    if (existIdx !== -1) {
      const existTab = s.openTabs[existIdx];
      const needUpdateName = existTab.name !== tab.name && tab.name;
      const needUpdateContent = tab.content !== undefined && existTab.content !== tab.content;
      if (needUpdateName || needUpdateContent) {
        return {
          openTabs: s.openTabs.map((t, i) =>
            i === existIdx
              ? {
                  ...t,
                  name: needUpdateName ? tab.name! : t.name,
                  content: needUpdateContent ? tab.content : t.content,
                }
              : t
          ),
          activeTabIdx: existIdx,
        };
      }
      return { activeTabIdx: existIdx };
    }
    // 否则添加新标签
    return {
      openTabs: [...s.openTabs, tab],
      activeTabIdx: s.openTabs.length,
    };
  }),
  // v0.6.3 P0-2/P2-4：切换激活标签时清除翻译撤销快照并解除自动保存抑制。……
  // v0.7.4 修复：切换激活标签不再清 translateUndoSnapshot——"取消翻译"气泡应
  // 在切走再切回同一文档时保留（恢复时按 filePath/key 归属校验，跨文档不会误恢复）。
  setActiveTab: (idx) =>
    set((s) => (idx === s.activeTabIdx
      ? { activeTabIdx: idx }
      : { activeTabIdx: idx, suppressAutoSave: false })),
  closeTab: (idx) => {
    const state = get();
    const closedTab = state.openTabs[idx] || null;
    // v0.7.4：清翻译快照仅当关闭的就是快照所属文件——保证"取消翻译"气泡跨标签
    // 切换保留（恢复时按 filePath/key 归属校验），且该文档被真正关闭后快照不残留
    const closedPath = closedTab?.path ?? null;
    const snap = state.translateUndoSnapshot;
    const clearTranslateState =
      idx === state.activeTabIdx || (snap !== null && snap.filePath === closedPath);
    set((s) => {
      const newTabs = s.openTabs.filter((_, i) => i !== idx);
      // 调整激活索引
      let newActiveIdx = s.activeTabIdx;
      if (idx < s.activeTabIdx) {
        newActiveIdx = s.activeTabIdx - 1;
      } else if (idx === s.activeTabIdx) {
        // 关闭当前标签，优先激活右侧，否则激活左侧
        newActiveIdx = Math.min(idx, Math.max(0, newTabs.length - 1));
        // v0.8.0 修复 P2：临时标签回到"新建它之前所在的标签"（需求2 问题2：
        // 双击新建临时文件后反悔关闭，应跳回原文件且阅读位置不变）
        const returnToId = closedTab?.returnToId;
        if (returnToId) {
          const target = newTabs.findIndex((t) => (t.id || t.path) === returnToId);
          if (target !== -1) newActiveIdx = target;
        }
      }
      if (newActiveIdx >= newTabs.length) {
        newActiveIdx = Math.max(0, newTabs.length - 1);
      }
      return {
        openTabs: newTabs,
        activeTabIdx: newActiveIdx,
        ...(clearTranslateState ? { translateUndoSnapshot: null, suppressAutoSave: false } : {}),
      };
    });
    return closedTab;
  },
  updateTabContent: (idx, content) => set((s) => ({
    openTabs: s.openTabs.map((t, i) => i === idx ? { ...t, content } : t),
  })),
  updateTabDirty: (idx, isDirty) => set((s) => ({
    openTabs: s.openTabs.map((t, i) => i === idx ? { ...t, isDirty } : t),
  })),
  getTabByPath: (path) => {
    return get().openTabs.findIndex((t) => t.path === path);
  },
  // v0.8.0 WP1：新建临时标签。序号取现存临时标签（按 id 的 untitled-N）最大 N + 1，
  // 不复用已关闭的序号，避免用户在同一会话里看到重名标签。
  createUntitledTab: () => set((s) => {
    let maxN = 0;
    for (const tab of s.openTabs) {
      const m = tab.id?.match(/^untitled-(\d+)$/);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    const n = maxN + 1;
    // v0.8.0 修复 P2：记录新建前的活跃标签，关闭本临时标签时回到它（需求2 问题2）
    const prevActive = s.openTabs[s.activeTabIdx];
    const returnToId = prevActive ? (prevActive.id || prevActive.path || undefined) : undefined;
    const tab: TabInfo = {
      id: `untitled-${n}`,
      path: "",
      name: t("app.untitledN", { n }),
      content: "",
      isDirty: false,
      isUntitled: true,
      returnToId,
      // v0.12.0 需求7：记录创建时间（侧栏条目右侧显示日期；随 untitledTabs 持久化）
      createdAt: Date.now(),
    };
    return { openTabs: [...s.openTabs, tab], activeTabIdx: s.openTabs.length };
  }),
  promoteTab: (idx, path, name) => set((s) => ({
    openTabs: s.openTabs.map((tab, i) =>
      i === idx
        ? { ...tab, path, name, isUntitled: false, id: undefined, isDirty: false }
        : tab
    ),
  })),
  getTabById: (id) => get().openTabs.findIndex((t) => t.id === id),
  togglePin: (idx) =>
    set((s) => {
      const tab = s.openTabs[idx];
      if (!tab) return {};
      const updated = s.openTabs.map((t, i) =>
        i === idx ? { ...t, pinned: !t.pinned } : t
      );
      // 固定区在前的稳定排序：pinned 排到前面，组内保持原有相对顺序
      const reordered = [...updated].sort(
        (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      );
      // 重新映射 activeTabIdx 到切换前的活跃标签（用 id/path 作为稳定标识）
      const activeTab = s.openTabs[s.activeTabIdx];
      const activeId = activeTab ? (activeTab.id ?? activeTab.path) : undefined;
      let newActive = s.activeTabIdx;
      if (activeId !== undefined) {
        const found = reordered.findIndex((t) => (t.id ?? t.path) === activeId);
        if (found !== -1) newActive = found;
      }
      return { openTabs: reordered, activeTabIdx: newActive };
    }),
  renameUntitledTab: (idx, name) =>
    set((s) => {
      if (!name) return {};
      return {
        openTabs: s.openTabs.map((t, i) => (i === idx ? { ...t, name } : t)),
      };
    }),
  // v0.9.0 WP9：只读标记（仅改目标标签，其余标签不受影响）
  setTabReadonly: (idx, isReadonly) =>
    set((s) => ({
      openTabs: s.openTabs.map((t, i) => (i === idx ? { ...t, isReadonly } : t)),
    })),
  // v0.9.0 WP9：外部修改标记（保存前的「覆盖 / 另存为 / 取消」确认依据）
  setTabExternallyChanged: (idx, changed) =>
    set((s) => ({
      openTabs: s.openTabs.map((t, i) => (i === idx ? { ...t, isExternallyChanged: changed } : t)),
    })),
}));
