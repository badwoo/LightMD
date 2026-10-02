/**
 * FileTree ── 侧边栏文件树（带工具栏和最近文件）
 */
import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { useFileStore } from "../../stores/useFileStore";
import { useEditorStore } from "../../stores/useEditorStore";
import { fileService, isTauri, type FileEntry } from "../../services/fileService";
import { FileEntryNode, type FileNodeData } from "./FileNode";
import { RecentFiles } from "./RecentFiles";
import { Favorites } from "./Favorites";
import { useT } from "../../i18n";
import { isSupportedTextFile } from "../../utils/constants";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useSectionSplit, SectionSizeContext, beginSectionDrag, computeMaxSelfHeight, computeExtendableMaxHeight, MIN_SECTION_HEIGHT, findSectionByKey, measureSectionContentHeight } from "../../hooks/useSectionSplit";
import { SidebarScrollArrows } from "./SidebarScrollArrows";
// v0.8.0 WP2 需求6：打开所在文件夹工作区（纯逻辑，UI 注入 deps）
import { openContainingWorkspace } from "../../utils/workspace";
// v0.8.0 WP2 需求4(2)：新建文件夹弹框
// v0.8.4 需求5+9（WP5）：新建文件弹框（替代原生 prompt，居中 overlay）
import { NewFolderDialog } from "../dialogs/NewFolderDialog";
import { NewFileDialog } from "../dialogs/NewFileDialog";
// v0.8.1 需求3：文件属性对话框（替代原生 alert，避免系统提示音）
import { FilePropertiesDialog, type FilePropertiesData } from "../dialogs/FilePropertiesDialog";
// v0.8.0 WP2 需求1：文件复制/粘贴（内存剪贴板 + 重名自动副本）
// v0.8.4 需求3 修复：自嵌套守卫改由 dropTarget.canDropIntoTarget 按源类型分流
// （目录源才套用 isDescendantDir；文件源一律放行）——见下方 transferTo / handleFileDragStart
// v0.8.4 需求5（WP5）：makeUniqueName 为新建文件预填不冲突默认名
import { setClipboard, getClipboard, hasClipboard, clearClipboard, clipboardTransferMode, resolveTransferName, resolvePasteTargetDir, makeUniqueName } from "../../utils/fileClipboard";
// v0.8.0 修复 P3：自制鼠标拖拽（HTML5 DnD 被 Tauri 原生拖放拦截）
// v0.8.4 需求3：onReorder 同目录重排回调（D5 落点三分流）
import { beginFileDrag, DROP_DIR_ATTR, type FileDragPayload } from "../../utils/fileDragMouse";
// v0.8.4 需求3：拖拽重排的插入位置计算（elementFromPoint 命中 → 行前/行后/末尾）
// v0.8.4 需求3 修复：canDropIntoTarget 按源类型分流落点准入（文件源不再被误拒）
import { resolveInsertPlace, canDropIntoTarget } from "../../utils/dropTarget";
// v0.8.4 需求3：源所在目录计算（path.ts 版本已归一 `\` → `/`，与树内路径口径一致）
import { getParentDir as getParentDirOf } from "../../utils/path";
import { syncOpenTabsAfterRename } from "../../services/renameService";
// v0.8.2：「打开的文件」栏条目与打开的标签严格同步（数量/选中一致根因修复）
import { syncTempFilesWithTabs } from "../../utils/tempFilesSync";
// v0.8.3 需求2：栏内键盘选中项（selectedTempIdx）的失效判定（双高亮修复）
import { shouldResetTempSelection } from "../../utils/tempSelection";
// v0.8.4 需求7：排序纯函数（sortNodes 混排）+ 徽标描述（sortModeBadge，按钮/菜单图标用）
import { sortNodes, sortModeBadge, type SortMode } from "../../utils/fileSort";
import { getManualOrder, applyManualOrder, renameInOrder, reorderList, setManualOrder } from "../../utils/dragOrder";
import "./FileTree.css";

/** 将 Rust 返回的 FileEntry (snake_case) 转为 store 的 FileNode (camelCase) */
function mapToFileNode(entry: FileEntry): FileNodeData {
  return {
    name: entry.name,
    path: entry.path,
    isDir: entry.is_dir,
    size: entry.size,
    // v0.8.4 需求7：时间字段透传（snake_case → camelCase），供排序使用；缺失/0 = 未知
    modifiedMs: entry.modified_ms ?? 0,
    createdMs: entry.created_ms ?? 0,
    children: [],
  };
}

// ─── 工具函数 ──────────────────────────────────────────

/**
 * v0.6.6 问题3：焦点是否在可编辑元素上（textarea / input / contenteditable）。
 * 用于 Delete 关闭临时文件快捷键的守卫——焦点在编辑器内打字删除时
 * 不应触发 window 级快捷键误关文件。
 */
export function isFocusInEditable(active: Element | null): boolean {
  return (
    active instanceof HTMLElement &&
    (active.tagName === "TEXTAREA" ||
      active.tagName === "INPUT" ||
      // isContentEditable 在 jsdom 中未实现（undefined），用属性兜底判断
      active.isContentEditable === true ||
      active.hasAttribute("contenteditable"))
  );
}

// 文件类型判断统一使用 constants.ts 中的 isSupportedTextFile

/** 递归排序文件树（文件夹在前，字母序） */
function sortTree(tree: FileNodeData[]): FileNodeData[] {
  return [...tree]
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) => ({
      ...node,
      children: node.children ? sortTree(node.children) : node.children,
    }));
}

/** 从路径中提取父目录（兼容 Windows 和 Unix 路径） */
function getParentDir(path: string): string {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? path.substring(0, idx) : path;
}

/** 拼接路径（兼容 Windows） */
function joinPath(...parts: string[]): string {
  return parts.join("/");
}

/** 路径归一化：反斜杠统一为正斜杠（Windows 下 watch 事件与 listDir 分隔符可能混用） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * v0.8.4 需求10：把 watch 事件的变更路径映射到「childrenMap 中已加载的最深祖先目录」。
 * - 路径自身已在已加载集合 → 直接命中；
 * - 否则逐级向上找父目录，第一个已加载的即为命中（展开时自然读最新，只需刷它）；
 * - 找不到任何已加载祖先（未展开的深层目录内部变更）→ 忽略，返回结果不含它。
 * 纯函数（便于单测）；命中返回的是 loadedDirs 中的原始写法（与 childrenMap key 一致）。
 */
export function resolveRefreshDirs(paths: string[], loadedDirs: Iterable<string>): string[] {
  // 归一化 → 原始写法 的映射：比较用归一化形式，返回用 childrenMap 的原始 key
  const byNorm = new Map<string, string>();
  for (const d of loadedDirs) byNorm.set(normalizePath(d), d);
  const result = new Set<string>();
  for (const raw of paths) {
    let cur = normalizePath(raw);
    // 先查自身，再逐级向上查父目录
    for (;;) {
      const hit = byNorm.get(cur);
      if (hit) {
        result.add(hit);
        break;
      }
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break; // 到盘符根仍无命中 → 忽略
      cur = cur.slice(0, idx);
    }
  }
  return Array.from(result);
}

/** v0.8.4 需求10：前端 watch 事件按目录去抖窗口（同 root 连续事件合并为一次刷新） */
export const WATCH_DEBOUNCE_MS = 300;
/** v0.8.4 需求10：watch 刷新在途目录集合（模块级：同一目录的刷新进行中不重复发起，防抖动） */
export const refreshDirInFlight = new Set<string>();

/** v0.8.2 功能3：section 滑出动画时长（ms），与 FileTree.css 中 animation 时长保持一致。
 * v0.8.2 调整：动画放慢 50%，0.24s → 0.36s */
const SECTION_SLIDE_OUT_MS = 360;
/** v0.8.2 动画优化：滑入展开时长（ms），与 FileTree.css section-slide-in 0.33s 同步 */
const SECTION_SLIDE_IN_MS = 330;
/**
 * v0.8.2 动画优化：section 关闭动画第二阶段（高度收起）时长（ms）。
 * 关闭动画串行化——先水平滑出（SECTION_SLIDE_OUT_MS），滑出完成后再收起高度
 * （下方栏平滑顶上），避免两个动画同时发生显得杂乱。
 */
const SECTION_COLLAPSE_MS = 480;
/** v0.8.2 动画优化：收起前的停顿（ms）——滑出结束后先停一拍再收起，
 * 让"先滑出、再顶上"两个阶段在视觉上彻底分离（否则看起来仍像同时发生）。 */
const SECTION_COLLAPSE_DELAY_MS = 120;
/** v0.8.2：「打开的文件」条目滑出动画时长（ms），与 FileTree.css item-slide-out 同步。
 * v0.8.2 调整：再放慢 50%，0.3s → 0.6s */
const ITEM_SLIDE_OUT_MS = 600;
/** v0.8.2：「打开的文件」条目滑入动画时长（ms），与 FileTree.css item-slide-in 同步。
 * v0.8.2 调整：再放慢 50%，0.25s → 0.5s */
const ITEM_SLIDE_IN_MS = 500;
/** v0.8.2：条目关闭第二阶段（高度收起）时长（ms） */
const ITEM_COLLAPSE_MS = 400;
/** v0.8.2：条目收起前的停顿（ms），同 SECTION_COLLAPSE_DELAY_MS 语义 */
const ITEM_COLLAPSE_DELAY_MS = 120;
/** v0.9.5 问题6 修订2：侧栏列表条目行高（px）。
 * 与 FileTree.css 中 `.filetree-node`（含 compact 单行条目）30px 对齐；
 * 「打开的文件」栏在收藏/最近打开时收缩为「列表内容自然高度 + 本值」，
 * 即预留一个条目位空档，收藏/最近面板整体（标题栏 + 列表）因此从
 * 列表末尾的下一个条目位开始（5 条文件 → 面板顶部位于第 8 行）。 */
export const SIDEBAR_ITEM_HEIGHT = 30;

/** v0.8.2：section 关闭动画总时长（滑出 + 停顿 + 收起），到点后卸载 DOM */
export const SECTION_OUT_TOTAL_MS =
  SECTION_SLIDE_OUT_MS + SECTION_COLLAPSE_DELAY_MS + SECTION_COLLAPSE_MS;
/** v0.8.2：条目关闭动画总时长（滑出 + 停顿 + 收起），到点后移除快照 */
export const ITEM_OUT_TOTAL_MS =
  ITEM_SLIDE_OUT_MS + ITEM_COLLAPSE_DELAY_MS + ITEM_COLLAPSE_MS;
/** v0.8.2 动画优化：文件树「文件夹展开/收起」子节点动画时长（ms），与 CSS 同步 */
export const TREE_SLIDE_EXPAND_MS = 450;
export const TREE_SLIDE_COLLAPSE_MS = 420;
/** v0.8.5 需求4：搜索面板展开动画时长（ms），与 FileTree.css search-panel-in 同步 */
export const SEARCH_PANEL_IN_MS = 220;
/** v0.8.5 需求4：搜索面板收回动画时长（ms），与 FileTree.css search-panel-out 同步；
 * 收回动画播完才延迟卸载面板（setShowSearch(false) 推迟到此时执行） */
export const SEARCH_PANEL_OUT_MS = 180;

/**
 * v0.8.5 反馈7：「打开的文件」条目图标 —— 打开的小书本形状（替代原"纸张"path）。
 * emoji 无法指定颜色，故用自绘单色剪影 SVG：左右两页对称（中缝在 x=8，两页间留
 * 1px 缝隙露出底色形成书脊凹口），页顶向中缝下斜、页底向中缝下垂，呈现翻开书本轮廓；
 * 颜色由调用处传入 —— 真实文件蓝 #5c9dff、未落盘临时文件黄 #e0a458（保持原配色）。
 */
function OpenBookIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      {/* 左页：书脊外缘 x=1.5，右缘为中缝 x=7.5（与右页间留缝） */}
      <path d="M7.5 3.7C6.4 2.6 4.3 2.2 2.2 2.4l-.7.1v9.4l.7.1c2.1-.1 4 .4 5.3 1.4V3.7z" fill={color} />
      {/* 右页：与左页镜像对称（书脊外缘 x=14.5，左缘为中缝 x=8.5） */}
      <path d="M8.5 3.7v9.7c1.3-1 3.2-1.5 5.3-1.4l.7-.1V2.5l-.7-.1c-2.1-.2-4.2.2-5.3 1.3z" fill={color} />
    </svg>
  );
}

/**
 * v0.8.2 修复：命令总线 id —— 标题栏「新建 > 新建文件夹」通过它触发侧栏的新建文件夹弹框。
 *
 * 此前 App.tsx 收到标题栏菜单事件后走的是原生 `prompt()` + 保存对话框，
 * 既不是应用内弹框、也无法选择/确认目标路径（"点击新建文件夹没反应"的根因）。
 * 现统一改为：App 派发命令 → FileTree 打开应用内 NewFolderDialog
 * （输入名称 + 勾选已打开文件夹或自定义路径，弹框居中显示）。
 */
const CMD_NEW_FOLDER = "filetree.newFolder";

/**
 * v0.8.2 动画优化：把"正在播放关闭动画的条目"按**原始位置**插回当前列表。
 *
 * 关闭中间一条时，下方的条目要先平滑上移补位——因此滑出快照必须留在它原来的
 * 位置上；若统一追加到列表末尾，视觉上就变成"底部凭空滑出一条"。
 *
 * 插入槽位定义（与渲染期合并循环一致）：存活条目把列表切成 `存活数 + 1` 个槽位
 * ——槽位 k 表示"已渲染 k 个存活条目之后"。因此：
 *   槽位 = 在**变更前顺序**中，排在它前面的存活条目个数。
 *   （每个关闭块各占一个槽位，先出现的关闭块插入更靠前的槽位，
 *    相对顺序与关闭前一致。）
 */
export function buildClosingSlotPositions(
  ids: readonly string[],
  aliveIdSet: ReadonlySet<string>,
): Map<string, number> {
  const pos = new Map<string, number>();
  let aliveBefore = 0;
  for (const id of ids) {
    if (aliveIdSet.has(id)) {
      aliveBefore += 1;
    } else {
      pos.set(id, aliveBefore);
    }
  }
  return pos;
}

/**
 * v0.8.2 动画优化：文件树子节点容器——文件夹展开/收起的串行动画。
 *
 * ①展开：子节点轻微下沉淡入（CSS filetree-children-slide），容器高度 0 → 内容高，
 *   下方节点被平滑推下去（v0.8.4 需求6：方向由水平滑入改为垂直向下展开）；
 * ②收起：子节点先轻微上浮淡出（CSS filetree-children-slide-out，占位高度保持），
 *   淡出完成后容器高度再平滑收起到 0，下方节点上移补位；
 * ③收起动画播完才卸载子节点（快照保留在 snapshotRef 中）。
 *
 * 关键：本组件实例必须由**父节点按路径固定 key** 持有，父组件重渲染
 * （加载完子目录、刷新、其它区域动画触发）时不能重置动画计时。
 */
function TreeChildrenWrap({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(visible);
  const snapshotRef = useRef<React.ReactNode>(null);
  /**
   * v0.8.2 修复（卡死）：`rendered` 的状态更新**必须全部放在 effect 里**。
   * 此前写成"渲染期 setState"（`if (visible) setRendered(true)`）——
   * 展开一个含子目录的文件夹时会触发"渲染 → setState → 再渲染 → 再 setState"
   * 的无限循环，React 抛 "Too many re-renders" 使整棵侧栏卡死。
   */
  useEffect(() => {
    if (visible) setRendered(true);
  }, [visible]);

  // 收起时保留一份子节点快照：React 侧 children 已随 isExpanded=false 变化，
  // 但滑出动画期间仍需要"有内容可渲染"。
  useEffect(() => {
    if (visible) snapshotRef.current = children;
  }, [visible, children]);

  // 高度动画（阶段①展开 / 阶段③收起）
  const firstPassRef = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const firstPass = firstPassRef.current;
    firstPassRef.current = false;
    if (visible) {
      // 阶段①：展开时容器高度 0 → 内容高，下方节点被平滑推下去
      // （初始即展开时不播动画，避免启动恢复时整棵树一起"长出来"）
      if (firstPass) return;
      const target = el.scrollHeight;
      if (target <= 0) return;
      el.style.overflow = "hidden";
      el.style.transition = "none";
      el.style.height = "0px";
      void el.offsetHeight; // 强制 reflow，确保起始高度 0 生效后再开始过渡
      el.style.transition = `height ${TREE_SLIDE_EXPAND_MS}ms ease`;
      el.style.height = `${target}px`;
      const timer = window.setTimeout(() => {
        el.style.transition = "";
        el.style.overflow = "";
        el.style.height = "";
      }, TREE_SLIDE_EXPAND_MS + 20);
      return () => window.clearTimeout(timer);
    }
    // 阶段③：滑出完成后把高度锁到当前值再过渡到 0（下方节点上移补位）
    const target = el.offsetHeight;
    if (target <= 0) return;
    el.style.overflow = "hidden";
    el.style.transition = "none";
    el.style.height = `${target}px`;
    void el.offsetHeight; // 强制 reflow，锁定起始高度后再开始收起
    el.style.transition = `height ${TREE_SLIDE_COLLAPSE_MS}ms ease`;
    el.style.height = "0px";
  }, [visible]);

  // 动画播完后卸载子节点
  useEffect(() => {
    if (visible) return;
    const timer = window.setTimeout(() => {
      snapshotRef.current = null;
      setRendered(false);
    }, TREE_SLIDE_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!rendered) return null;
  // 收起动画期间用快照兜底（children 已随展开状态变化，快照保持关闭前一帧的内容）
  const content = visible ? children : (snapshotRef.current ?? children);
  return (
    <div
      ref={ref}
      className={visible ? "filetree-children-slide" : "filetree-children-slide-out"}
    >
      {content}
    </div>
  );
}

/**
 * v0.8.2 动画优化：文件树子节点动画容器工厂。
 *
 * 容器实例按**父文件夹路径**固定 key，保证 FileEntryNode 因加载子目录 / 刷新 /
 * 其它区域动画而重渲染时，动画计时不被重置——这正是"关闭中间条目时滑出与
 * 上移补位看起来同时发生"一类问题的根因模式。
 */
export function makeTreeChildrenWrap() {
  return (path: string, visible: boolean, children: React.ReactNode) => (
    <TreeChildrenWrap key={path} visible={visible}>
      {children}
    </TreeChildrenWrap>
  );
}

/**
 * v0.8.2：全局唯一的树节点动画容器工厂。
 * 必须是稳定引用——若在渲染期每次新建，React 会因组件类型变化而整棵子树重新挂载，
 * 展开动画反而变成"整体闪一下"。
 */
const treeChildrenWrap = makeTreeChildrenWrap();

/**
 * v0.8.2：「打开的文件」条目滑出 wrapper——关闭动画串行三拍：
 * ①水平滑出+淡出（CSS animation item-slide-out，占位高度保持）；
 * ②停顿 ITEM_COLLAPSE_DELAY_MS（视觉上把两个阶段分开）；
 * ③高度平滑收起到 0（下方条目上移补位）。结束后随 DOM 卸载移除。
 * 渲染的 children 是关闭前一帧的条目快照（数据已从 store 移除）。
 */
function ItemSlideOut({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 阶段②+③：水平滑出完成、停顿一拍后，锁定当前高度并过渡到 0
    const timer = window.setTimeout(() => {
      const current = el.offsetHeight;
      if (current <= 0) return;
      el.style.overflow = "hidden";
      el.style.transition = "none";
      el.style.height = `${current}px`;
      void el.offsetHeight; // 强制 reflow，锁定起始高度后再开始收起
      el.style.transition = `height ${ITEM_COLLAPSE_MS}ms ease`;
      el.style.height = "0px";
    }, ITEM_SLIDE_OUT_MS + ITEM_COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div ref={ref} className="item-slide-out">
      {children}
    </div>
  );
}

/**
 * v0.8.2 动画优化：滑入中的 wrapper——挂载时从 0 高度平滑过渡到内容高度，
 * 下方的栏被"平滑推下去"（与 CSS 水平滑入同步，产生平滑插销感）。
 * 结束后清除内联样式，高度恢复由 section 自身驱动。
 * （jsdom 无布局：scrollHeight 为 0 时自动跳过，不影响测试）
 */
export function SlideInWrap({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.scrollHeight;
    if (target <= 0) return;
    el.style.overflow = "hidden";
    el.style.transition = "none";
    el.style.height = "0px";
    void el.offsetHeight; // 强制 reflow，确保起始高度 0 生效后再开始过渡
    el.style.transition = `height ${SECTION_SLIDE_IN_MS}ms ease`;
    el.style.height = `${target}px`;
    const timer = window.setTimeout(() => {
      el.style.transition = "";
      el.style.overflow = "";
      el.style.height = "";
    }, SECTION_SLIDE_IN_MS + 20);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div ref={ref} className="section-slide">
      {children}
    </div>
  );
}

/**
 * v0.8.2 动画优化：滑出中的 wrapper——关闭动画串行三拍：
 * ①水平滑出+淡出（CSS animation section-slide-out，占位高度保持）；
 * ②停顿 SECTION_COLLAPSE_DELAY_MS（视觉上把两个阶段分开）；
 * ③锁定当前高度并平滑过渡到 0，下方栏"平滑地顶上来"。
 * 结束后 DOM 随卸载移除。
 */
export function SlideOutWrap({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // 阶段②+③：水平滑出完成、停顿一拍后，锁定当前高度并过渡到 0
    const timer = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const current = el.offsetHeight;
      if (current <= 0) return;
      el.style.overflow = "hidden";
      el.style.transition = "none";
      el.style.height = `${current}px`;
      void el.offsetHeight; // 强制 reflow，锁定起始高度后再开始收起
      el.style.transition = `height ${SECTION_COLLAPSE_MS}ms ease`;
      el.style.height = "0px";
    }, SECTION_SLIDE_OUT_MS + SECTION_COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div ref={ref} className="section-slide-out">
      {children}
    </div>
  );
}

/**
 * v0.8.2 功能3：section 滑入/滑出动画包装。
 *
 * - visible=true：挂载并播放"从左侧滑入 + 高度展开"（SlideInWrap）；
 * - visible=false：不立即卸载，渲染关闭前一帧快照并播放"滑向左侧消失 + 高度收起"
 *   （SlideOutWrap），滑出+高度收起总时长后卸载；
 * - closing 由渲染期派生（mounted && !visible），不依赖 effect 调度时序；
 * - 关闭动画期间渲染 children 的**快照**：此时该栏已移出 ordered 布局列表，
 *   prevOf/nextOf 等派生 props 会突变，用快照保持视觉稳定。
 */
export function SlideWrap({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(visible);
  const snapshotRef = useRef<React.ReactNode>(null);
  if (visible) snapshotRef.current = children;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    // 从未显示过 → 无需播放退出动画
    if (!snapshotRef.current) return;
    // 延迟卸载：串行三拍（水平滑出 → 停顿 → 高度收起）播完后移除
    const timer = window.setTimeout(() => {
      snapshotRef.current = null;
      setMounted(false);
    }, SECTION_OUT_TOTAL_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;
  if (!visible) return <SlideOutWrap>{snapshotRef.current}</SlideOutWrap>;
  return <SlideInWrap>{children}</SlideInWrap>;
}

// ─── 组件 ────────────────────────────────────────────────

export function FileTree() {
  const rootPath = useFileStore((s) => s.rootPath);
  const openFolders = useFileStore((s) => s.openFolders);
  const tempFiles = useFileStore((s) => s.tempFiles);
  // v0.4.0：多文件夹操作
  const addOpenFolder = useFileStore((s) => s.addOpenFolder);
  const removeOpenFolder = useFileStore((s) => s.removeOpenFolder);
  const updateFolderTree = useFileStore((s) => s.updateFolderTree);
  const isPathInOpenFolders = useFileStore((s) => s.isPathInOpenFolders);
  const addRecentFile = useFileStore((s) => s.addRecentFile);
  const addTempFile = useFileStore((s) => s.addTempFile);
  const removeTempFile = useFileStore((s) => s.removeTempFile);
  // v0.8.2：整表写入「打开的文件」栏条目（与打开的标签严格同步）
  const setTempFiles = useFileStore((s) => s.setTempFiles);
  // G7：收藏操作（addFavorite/isFavorite 用于右键菜单切换文案）
  const addFavorite = useFileStore((s) => s.addFavorite);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const favorites = useFileStore((s) => s.favorites);
  // v0.8.0 修复 P12-4：布局列表需要知道"最近打开"栏是否会真正渲染（空列表时该栏返回 null）
  const recentFiles = useFileStore((s) => s.recentFiles);
  const renameFileEntry = useFileStore((s) => s.renameFileEntry);
  const t = useT();
  // 同步全局 filePath，确保关闭文件时能正确判断当前活跃文件
  const globalFilePath = useEditorStore((s) => s.filePath);
  // v0.8.0 WP1：临时（未落盘）标签需一并显示在"打开的文件"面板中
  const editorOpenTabs = useEditorStore((s) => s.openTabs);
  const editorActiveTabIdx = useEditorStore((s) => s.activeTabIdx);
  const untitledTabs = useMemo(
    () => editorOpenTabs
      .map((tab, idx) => ({ tab, idx }))
      .filter((item) => item.tab.isUntitled),
    [editorOpenTabs],
  );

  // ─── v0.8.2：栏条目与打开的标签严格同步（数量/选中不一致的根因修复） ──────
  // 「打开的文件」栏条目改以 openTabs 为唯一真相源：打开文件夹内的文件、另存为
  // 晋升（promoteTab）后的文件同样属于"打开的文件"；关闭标签的任何路径
  // （标签栏 ×、Ctrl+W、批量关闭、lightmd:closeFile、文件删除联动）都会在下一帧
  // 被对齐，不再残留"栏里有、标签已关"的幽灵条目。
  // 同时订阅 tempFiles：任何外部写入也会被立即纠正（对齐后 changed=false 自然收敛，
  // 不会形成写入循环）。
  useEffect(() => {
    const { next, changed } = syncTempFilesWithTabs(tempFiles, editorOpenTabs);
    if (changed) setTempFiles(next);
  }, [editorOpenTabs, tempFiles, setTempFiles]);

  // v0.8.2：激活条目的**统一判定键**。此前未落盘标签按 activeTabIdx、真实文件按
  // 路径两套标准判定，且真实文件条目依赖 tempFiles（可能缺条目）——于是出现
  // "激活的文件在栏中没有任何条目显示选中色"。现统一用条目 key 判定（与
  // buildTempItems 构造条目时使用的 key 一致）。
  const activeItemKey = useMemo(() => {
    const tab = editorOpenTabs[editorActiveTabIdx];
    if (!tab) return null;
    if (tab.isUntitled) return `untitled-${tab.id ?? editorActiveTabIdx}`;
    return tab.path ? `temp-${tab.path}` : null;
  }, [editorOpenTabs, editorActiveTabIdx]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const expandedPathsRef = useRef<Set<string>>(new Set());
  // 同步 expandedPaths 到 ref
  useEffect(() => { expandedPathsRef.current = expandedPaths; }, [expandedPaths]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // 直接使用 globalFilePath 作为 activePath，避免 useEffect 延迟导致双高亮
  const activePath = globalFilePath;
  const setActivePath = (path: string | null) => {
    // activePath 现在直接从 store 派生，setActivePath 仅在需要即时更新时调用
    // 实际更新通过 openFile/store 完成
  };
  
  // v0.8.0 修复 P1-2：文件粘贴的目标文件夹。
  // 旧实现只用"当前活跃文件所在目录 / 第一个打开文件夹"，与用户点选的文件夹无关，
  // 导致"在某个打开的文件夹里 Ctrl+V 却不生效（文件跑到别处）"。
  // 现在点击任一文件夹区域（标题栏、空白处、文件项）即把该文件夹设为粘贴目标。
  const [pasteTargetDir, setPasteTargetDir] = useState<string | null>(null);

  // v0.8.0 修复 P12-1：文件夹空白区右键菜单（粘贴）
  // v0.8.4 反馈1：去掉 canPaste 快照 —— 粘贴项的 disabled 改为渲染期实时读取 hasClipboard()。
  // 剪贴板是模块级变量、不进 React 状态，而"打开菜单"本身必然触发一次渲染，
  // 因此渲染期读到的就是最新值，"复制/剪切后重开菜单即为可用态"，与节点右键菜单行为统一。
  const [folderCtxMenu, setFolderCtxMenu] = useState<
    { x: number; y: number; dir: string } | null
  >(null);
  // v0.8.4 反馈1：记录"打开本菜单的那一次"原生 contextmenu 事件。
  // React 离散事件同步 flush：section 的 onContextMenu 先 setState 打开新菜单，
  // 事件随后继续冒泡到 window 时会被下面的"右键关闭"监听立刻关掉——表现为
  // "菜单已打开时右键另一文件夹，菜单闪一下就没了（需再点一次）"。
  // 用 ref 记住本次打开事件，关闭监听跳过与之相同的那一次即可。
  const folderCtxOpenEventRef = useRef<Event | null>(null);

  // v0.8.0 修复 P11-8：侧栏文件操作的浮动提示（显示在侧栏右侧，不占布局、不抖动）
  const rootRef = useRef<HTMLDivElement>(null);
  const toastSeq = useRef(0);
  const [toasts, setToasts] = useState<{ id: number; msg: string; error: boolean }[]>([]);
  const [toastLeft, setToastLeft] = useState(272);

  // v0.8.0 WP2 需求4(2)：新建文件夹弹框状态（preselected = 从具体文件夹入口进入时的预选）
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderPreselected, setNewFolderPreselected] = useState<string | null>(null);
  // v0.8.4 需求5+9（WP5）：新建文件弹框状态（parentPath=落点目录；defaultName=预填避让名）
  const [newFileDialog, setNewFileDialog] = useState<{ parentPath: string; defaultName: string } | null>(null);
  // 缓存已加载的子目录
  const [childrenMap, setChildrenMap] = useState<Map<string, FileNodeData[]>>(new Map());

  // v0.8.0 修复 P1-2：粘贴目标必须仍是"已打开的文件夹"，关闭该文件夹后自动失效
  useEffect(() => {
    if (pasteTargetDir && !openFolders.some((f) => f.path === pasteTargetDir)) {
      setPasteTargetDir(null);
    }
  }, [openFolders, pasteTargetDir]);

  // v0.4.1：收藏/最近区域显示开关（标题栏 toggle 按钮控制）
  // Issue 2 修复：收藏栏默认改为关闭状态
  // v0.9.2 需求：「最近打开」区块同样默认关闭（点击标题栏时钟图标开启）
  const [showFavorites, setShowFavorites] = useState(false);
  const [showRecent, setShowRecent] = useState(false);

  // v0.8.2 功能1：「打开的文件」栏标题栏缩小/放大状态（与文件夹栏一致）。
  // v0.8.2 调整：去掉标题栏"关闭"按钮——本栏随文件数据自动出现/消失
  // （所有文件都关闭后 tempVisible=false 自动滑出），无需手动关闭入口。
  const [tempCollapsed, setTempCollapsed] = useState(false);
  const [tempMaximized, setTempMaximized] = useState(false);
  // v0.8.2 功能3：正在播放"滑出消失"动画的文件夹（关闭后数据已出 store，
  // 保留 folder+nodes 快照供动画期间渲染，动画结束后清除）
  const [closingFolders, setClosingFolders] = useState<
    Array<{ folder: { path: string; name: string }; nodes: FileNodeData[] }>
  >([]);

  // v0.4.3 Issue 2：全局文件搜索
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  // v0.8.5 需求4：搜索面板收回动画状态（true = 正在播放收回动画，动画结束才真正卸载）
  const [searchClosing, setSearchClosing] = useState(false);
  const searchCloseTimerRef = useRef<number | null>(null);

  // v0.8.5 需求4：展开搜索面板（若收回动画进行中则取消收回、立即重新展开）
  const openSearchPanel = useCallback(() => {
    if (searchCloseTimerRef.current !== null) {
      window.clearTimeout(searchCloseTimerRef.current);
      searchCloseTimerRef.current = null;
    }
    setSearchClosing(false);
    setShowSearch(true);
  }, []);

  // v0.8.5 需求4：收起搜索面板——先播收回动画（SEARCH_PANEL_OUT_MS），
  // 播完才 setShowSearch(false) 卸载（保持输入过滤/Esc 等既有逻辑不变，仅卸载时机后移）
  const closeSearchPanel = useCallback(() => {
    if (searchCloseTimerRef.current !== null) return; // 收回已在进行 → 幂等
    setSearchClosing(true);
    searchCloseTimerRef.current = window.setTimeout(() => {
      searchCloseTimerRef.current = null;
      setShowSearch(false);
      setSearchClosing(false);
    }, SEARCH_PANEL_OUT_MS);
  }, []);

  // v0.8.5 需求4：卸载时清理未触发的收回定时器（避免卸载后 setState）
  useEffect(
    () => () => {
      if (searchCloseTimerRef.current !== null) window.clearTimeout(searchCloseTimerRef.current);
    },
    [],
  );

  // v0.8.0 WP4 修复1：相邻配对分配的分栏拖拽（替代旧 useResizable 垂直分支）
  // 各 section 高度集中管理；拖拽时本区+delta、下区-delta，总和守恒，双向钳制 80px。
  const settingsSectionSizes = useSettingsStore((s) => s.sidebarSectionSizes);
  const setSidebarSectionSizes = useSettingsStore((s) => s.setSidebarSectionSizes);
  const [sectionSizes, setSectionSizes] = useState<Record<string, number>>(
    () => ({ ...settingsSectionSizes }),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  /** v0.9.5 问题6 修订2：收藏/最近打开期间「打开的文件」栏收缩前的记忆高度
   * （null = 未处于收缩态）。同时用于持久化排除——收缩高度是运行时布局产物，
   * 不应写回设置，否则在收藏/最近打开状态下退出应用，下次启动该栏会残留空档。 */
  const prevTempSizeRef = useRef<number | null>(null);

  const sizeOf = useCallback(
    (key: string) => sectionSizes[key] ?? (key.startsWith("folder:") ? 250 : 200),
    [sectionSizes],
  );
  const setPair = useCallback(
    (topKey: string, bottomKey: string, top: number, bottom: number) => {
      setSectionSizes((prev) => ({ ...prev, [topKey]: top, [bottomKey]: bottom }));
    },
    [],
  );
  // 拖拽过程中去抖持久化，避免每帧写 localStorage
  const persistTimer = useRef<number | null>(null);
  useEffect(() => {
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      // v0.9.5 问题6 修订2：收缩态下「打开的文件」栏高度不持久化（写回收缩前记忆值）
      const toSave =
        prevTempSizeRef.current !== null
          ? { ...sectionSizes, temp: prevTempSizeRef.current }
          : sectionSizes;
      setSidebarSectionSizes(toSave);
    }, 250);
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
    };
  }, [sectionSizes, setSidebarSectionSizes]);

  // 可见 section 的顺序（决定相邻配对与分隔条位置）
  const tempVisible = tempFiles.length > 0 || untitledTabs.length > 0;
  // v0.9.5 问题6：收藏/最近打开任一栏展开时,「打开的文件」栏高度收缩为内容自适应,
  // 收藏/最近面板以紧凑内嵌形态(无标题栏、单行条目)紧贴其列表之下(空一个条目位)
  const favRecentCompact = showFavorites || (showRecent && recentFiles.length > 0);
  const ordered: string[] = [];
  if (openFolders.length > 0) {
    openFolders.forEach((f) => ordered.push(`folder:${f.path}`));
  } else if (tempVisible) {
    ordered.push("temp");
  }
  if (openFolders.length > 0 && tempVisible) ordered.push("temp");
  if (showFavorites) ordered.push("favorites");
  // v0.8.0 修复 P12-4：最近文件为空时该栏不渲染（RecentFiles 返回 null），
  // 布局列表需与"实际渲染的栏"一致，否则分隔条/拖拽配对与自动填充会指向不存在的栏。
  if (showRecent && recentFiles.length > 0) ordered.push("recent");
  const indexOfKey = (k: string) => ordered.indexOf(k);
  const prevOf = (k: string) => {
    const i = indexOfKey(k);
    return i > 0 ? ordered[i - 1] : undefined;
  };
  // v0.8.2 功能4：下方相邻可见区 key（第一个可见区域的标题栏改拖「本区 + 下区」）
  const nextOf = (k: string) => {
    const i = indexOfKey(k);
    return i !== -1 && i < ordered.length - 1 ? ordered[i + 1] : undefined;
  };
  // v0.8.0 修复 P11-4：分隔条高度（用于计算末区可扩展空间）
  const RESIZER_HEIGHT = 4;
  /**
   * v0.8.0 修复 P12-4/5：拖拽时"下方区域"的高度上限，仅**最后一个可见区域**给出。
   *
   * 上限取"守恒上限"与"容器上限"的较大值（见 computeExtendableMaxHeight）：
   * - 容器已溢出（多区域叠加超出可视区）时仍可通过压缩上区放大本区
   *   → 修复"收藏 + 最近打开同时打开时最近打开拖不动"、
   *     "只有一个文件夹 + 打开的文件时打开的文件栏拖不动"；
   * - 容器还有空白时可一直放大到填满底部。
   */
  const maxBottomFor = (topKey: string | undefined, bottomKey: string): number | undefined => {
    if (!topKey) return undefined;
    if (ordered.length === 0 || ordered[ordered.length - 1] !== bottomKey) return undefined;
    const el = scrollRef.current;
    if (!el) return undefined;
    const others = ordered
      .filter((k) => k !== topKey && k !== bottomKey)
      .map((k) => sizeOf(k));
    return computeExtendableMaxHeight(
      el.clientHeight,
      sizeOf(topKey),
      sizeOf(bottomKey),
      others,
      RESIZER_HEIGHT,
      Math.max(0, ordered.length - 1),
      MIN_SECTION_HEIGHT,
    );
  };
  const resizerDrag = (topKey: string, bottomKey: string) => (e: React.MouseEvent) => {
    const maxBottom = maxBottomFor(topKey, bottomKey);
    beginSectionDrag(
      topKey,
      bottomKey,
      () => ({ top: sizeOf(topKey), bottom: sizeOf(bottomKey) }),
      setPair,
      MIN_SECTION_HEIGHT,
      e,
      undefined,
      undefined,
      maxBottom !== undefined ? { maxBottom } : undefined,
    );
  };

  // v0.8.0 修复 P12-4 / P13-2：可见区域集合变化后的高度自适应。
  // ① 关闭末栏 → 上一栏自动撑满到底部；
  // ② 之后再打开一个栏 → 先把之前被撑满的栏**还原为原高度**，
  //    让新开的栏紧跟在上一栏内容之后出现（否则上一栏占满整屏，新栏被挤到可视区外，
  //    用户只能看到"栏没出现"或需要滚动）。
  // 仅响应"区域集合变化"（不含首次挂载，避免改变既有默认布局）。
  const orderedKey = ordered.join("|");
  const skipAutoFillRef = useRef(true);
  /** 记录上一次由自适应撑满的栏及其原高度，便于下次集合变化时还原 */
  const autoFillRef = useRef<{ key: string; prevHeight: number; filledHeight: number } | null>(
    null,
  );
  // v0.9.5 问题6 修订2：收藏/最近打开任一栏展开时,「打开的文件」栏**显式收缩**为
  // 「列表内容自然高度 + 一个条目位(SIDEBAR_ITEM_HEIGHT)」并写入 sizeOf(与分区/
  // 拖拽体系一致)。空档由本栏高度承担(不再在面板内部塞 spacer),收藏/最近面板
  // 整体(标题栏 + 列表)因此从列表末尾的下一个条目位开始——5 条文件时第 7 行为
  // 空档、面板标题栏位于第 8 行。关闭时恢复收缩前的记忆高度。
  // 不依赖 autoFill 的还原路径——temp 从未被撑满过(autoFillRef 为空)时
  // autoFill 不会收缩,显式收缩保证任何状态下都成立。
  const sizeOfRef = useRef(sizeOf);
  sizeOfRef.current = sizeOf;
  useEffect(() => {
    if (!favRecentCompact) {
      // 关闭收藏/最近打开:恢复收缩前记忆高度(随后 autoFill 会按需重新撑满)
      const restore = prevTempSizeRef.current;
      if (restore !== null) {
        prevTempSizeRef.current = null;
        setSectionSizes((prev) => ({ ...prev, temp: restore }));
      }
      return;
    }
    const raf = requestAnimationFrame(() => {
      const tempEl = findSectionByKey(document, "temp");
      const contentH = tempEl ? measureSectionContentHeight(tempEl) : null;
      setSectionSizes((prev) => {
        const next = { ...prev };
        const cur = next.temp ?? sizeOfRef.current("temp");
        if (prevTempSizeRef.current === null) prevTempSizeRef.current = cur;
        const target =
          contentH !== null
            ? Math.max(MIN_SECTION_HEIGHT, contentH + SIDEBAR_ITEM_HEIGHT)
            : cur;
        next.temp = target;
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [favRecentCompact]);
  useEffect(() => {
    if (skipAutoFillRef.current) {
      skipAutoFillRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el || ordered.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const container = el.clientHeight;
      if (container <= 0) return;
      const resizerCount = Math.max(0, ordered.length - 1);
      const lastKey = ordered[ordered.length - 1];
      setSectionSizes((prev) => {
        const next = { ...prev };
        const heightOf = (k: string) => next[k] ?? sizeOf(k);

        // ① 之前被撑满的栏不再是末栏 → 还原它的原高度
        const filled = autoFillRef.current;
        if (filled && filled.key !== lastKey) {
          // 用户已手动拖拽过则尊重用户设置（当前值 ≠ 撑满值时不还原）
          if (heightOf(filled.key) === filled.filledHeight) {
            // v0.8.2 功能5：还原时收缩到"内容自然高度"（不超过原高度），
            // 让新打开的栏紧接在上一栏最后一条内容之后（如上一栏 5 个文档，
            // 新栏标题栏出现在第 6 个文档位置），而不是顶着大片空白。
            const contentH = measureSectionContentHeight(
              findSectionByKey(document, filled.key),
            );
            next[filled.key] =
              contentH !== null
                ? Math.max(MIN_SECTION_HEIGHT, Math.min(filled.prevHeight, contentH))
                : filled.prevHeight;
          }
          autoFillRef.current = null;
        }

        // ② 末栏总高不足容器时撑满到底部（已溢出则保持现状，交给滚动条）
        // v0.9.5 问题6 修订2：末栏**无条件**撑满——收藏/最近作为末尾栏时其列表
        // 同样撑满至底部（需求：侧栏末尾栏的列表范围自动撑满到底部），向上拖拽
        // 因此可吞掉剩余空间一直拖到底部。条目位空档由「打开的文件」栏高度承担，
        // 与末栏是否撑满无关，故不再跳过收藏/最近。
        const total =
          ordered.reduce((sum, k) => sum + heightOf(k), 0) + RESIZER_HEIGHT * resizerCount;
        if (total < container) {
          const others = ordered.filter((k) => k !== lastKey).map(heightOf);
          const target = computeMaxSelfHeight(
            container,
            others,
            RESIZER_HEIGHT,
            resizerCount,
            MIN_SECTION_HEIGHT,
          );
          const current = heightOf(lastKey);
          if (target > current) {
            autoFillRef.current = { key: lastKey, prevHeight: current, filledHeight: target };
            next[lastKey] = target;
          }
        }
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedKey]);
  // v0.8.0 修复 P9-1：context 额外提供 sizeOf（含默认高度），
  // 保证标题栏拖拽以"渲染中的实际高度"为起点，不会从 0 起算而跳变
  const sectionSplitCtx = { sizes: sectionSizes, sizeOf, setPair, minHeight: MIN_SECTION_HEIGHT };

  // v0.8.4 需求7（C5）：排序模式按文件夹根记忆（settings persist），整树统一应用根的模式
  const fileTreeSort = useSettingsStore((s) => s.fileTreeSort);
  // v0.8.4 需求7：排序按钮 → 写入记忆（setFileTreeSort 内部归一化分隔符 + null 删除 key）
  const setFileTreeSort = useSettingsStore((s) => s.setFileTreeSort);

  /**
   * v0.8.4：推导路径所属的已打开文件夹根（排序模式的归属方）。
   * 未命中（理论上不会发生：树内节点必属于某个已打开文件夹）时回退路径自身，
   * 此时查不到排序模式 → 自然走手动顺序/默认排序，行为安全。
   */
  const findFolderRootOf = (path: string): string => {
    const norm = path.replace(/\\/g, "/");
    const hit = useFileStore
      .getState()
      .openFolders.find((f) => {
        const root = f.path.replace(/\\/g, "/");
        return norm === root || norm.startsWith(root + "/");
      });
    return hit?.path ?? path;
  };

  /**
   * v0.8.4 需求3+7：排序统一出口。
   * rootPath = 所属文件夹根路径（排序模式归属，整树统一）；dir = 该列表所在目录
   * （手动顺序归属，逐目录独立）。
   * - 排序模式激活 → sortNodes 混排（文件与文件夹不分组）；
   * - 未激活 → 有手动顺序表则 applyManualOrder(sortTree(...))（表外新文件尾插、
   *   死项惰性清理），否则退化为默认"文件夹在前+字母序"。
   * 纯函数（读 localStorage / store 快照，无写副作用），可在 useMemo 中调用。
   */
  const sortChildren = useCallback(
    (rootPath: string, dir: string, nodes: FileNodeData[]): FileNodeData[] => {
      const mode = fileTreeSort[rootPath.replace(/\\/g, "/")] ?? null;
      const sortLevel = (list: FileNodeData[], levelDir: string): FileNodeData[] => {
        const ordered = mode
          ? sortNodes(list, mode)
          : (() => {
              const order = getManualOrder(levelDir);
              return order ? applyManualOrder(sortTree(list), order) : sortTree(list);
            })();
        // 递归子层：mode 仍取根的，手动顺序按各子目录自身路径取
        return ordered.map((n) =>
          n.isDir && n.children && n.children.length > 0
            ? { ...n, children: sortLevel(n.children, n.path) }
            : n
        );
      };
      return sortLevel(nodes, dir);
    },
    [fileTreeSort]
  );

  // v0.4.0：按文件夹分别计算 treeData（每个文件夹独立合并已加载的子目录）
  const treeDataByFolder = useMemo(() => {
    const mergeChildren = (nodes: FileNodeData[]): FileNodeData[] => {
      return nodes.map((f) => {
        const cached = childrenMap.get(f.path);
        return {
          // v0.8.4 需求7：展开透传（modifiedMs/createdMs 等新增字段随对象保留，供排序使用）
          ...f,
          // v0.8.2 动画优化：children 递归挂到**任意深度的目录节点**上。
          // 展开/收起动画按路径取子节点缓存（childrenByPath），深一层的目录
          // （如 a/b）折叠后其子节点缓存必须仍可获取，否则收起动画没有内容可渲染。
          children: f.isDir && cached ? mergeChildren(cached) : [],
        };
      });
    };
    return openFolders.map((folder) => ({
      folder,
      // v0.8.4 需求3+7：排序统一出口（rootPath=folder.path 根，dir=folder.path 根层目录）
      nodes: sortChildren(folder.path, folder.path, mergeChildren(folder.fileTree)),
    }));
    // childrenMap 存原始 listDir 顺序，排序只在渲染派生层（sortChildren）做，
    // 避免双处排序打架（同一出口保证逻辑单源）
  }, [openFolders, childrenMap, sortChildren]);

  // v0.8.5 反馈（第二版）：NewFolderDialog 的可选目标文件夹列表。
  // 必须 memo —— 旧写法在 JSX 里直接 `openFolders.map(...)`，每次 FileTree 重渲染
  // 都会产生新数组引用，触发弹窗内 useEffect([openFolders]) 重新跑一遍表单重置，
  // 在打开动画进行中多出一次无谓的重渲染与 DOM 变更。
  const newFolderTargets = useMemo(
    () => openFolders.map((f) => ({ path: f.path, name: f.name })),
    [openFolders],
  );

  // v0.4.3 Issue 2：全局文件搜索结果（递归遍历所有打开文件夹的文件树 + 临时文件 + 收藏文件）
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results: Array<{ name: string; path: string }> = [];
    const seenPaths = new Set<string>();
    // 递归遍历文件树节点（treeDataByFolder 已合并 childrenMap 缓存的子目录）
    const collect = (nodes: FileNodeData[]) => {
      for (const node of nodes) {
        if (node.isDir) {
          if (node.children) collect(node.children);
        } else {
          if (node.name.toLowerCase().includes(query) && !seenPaths.has(node.path)) {
            seenPaths.add(node.path);
            results.push({ name: node.name, path: node.path });
          }
        }
      }
    };
    for (const { nodes } of treeDataByFolder) collect(nodes);
    for (const file of tempFiles) {
      if (file.name.toLowerCase().includes(query) && !seenPaths.has(file.path)) {
        seenPaths.add(file.path);
        results.push({ name: file.name, path: file.path });
      }
    }
    for (const fav of favorites) {
      if (fav.name.toLowerCase().includes(query) && !seenPaths.has(fav.path)) {
        seenPaths.add(fav.path);
        results.push({ name: fav.name, path: fav.path });
      }
    }
    return results;
  }, [searchQuery, treeDataByFolder, tempFiles, favorites]);

  // v0.4.3 Issue 2：搜索框激活时自动聚焦
  useEffect(() => {
    if (showSearch) {
      searchInputRef.current?.focus();
    } else {
      setSearchQuery("");
    }
  }, [showSearch]);

  // ─── 打开文件夹 ──────────────────────────────

  // 打开指定路径的文件夹（核心逻辑，供按钮点击和拖拽打开复用）
  // v0.4.0：改用 addOpenFolder + updateFolderTree，支持同时打开多个文件夹
  const openFolderAt = useCallback(async (selected: string) => {
    try {
      addOpenFolder(selected);
      const entries = await fileService.listDir(selected);
      const nodes = entries.map(mapToFileNode);
      updateFolderTree(selected, nodes);
      // 缓存根目录子节点（保留其他文件夹的缓存）
      // v0.8.4 需求3+7：排序统一出口 —— FileNode 渲染子节点优先取 childrenMap
      // （childrenByPath），因此缓存必须已按根排序模式/手动顺序排好
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(selected, sortChildren(selected, selected, nodes));
        return next;
      });
      setExpandedPaths(new Set());
      // v0.8.4 需求10：注册文件夹 watcher（递归监听子树变更 → 定向刷新）。
      // 失败（网络盘/权限等）仅提示兜底方案，不阻断打开流程
      try {
        await fileService.watchFolder(selected);
      } catch {
        showError(t("filetree.watchUnavailable"));
      }
    } catch (err) {
      showError(t("filetree.openFolderFailed"));
      console.error(err);
    }
  }, [addOpenFolder, updateFolderTree, sortChildren, t]);

  const openFolder = useCallback(async () => {
    if (isTauri()) {
      try {
        const selected = await dialogOpen({ directory: true, multiple: false });
        if (selected) {
          await openFolderAt(selected);
        }
      } catch (err) {
        showError(t("filetree.openFolderFailed"));
        console.error(err);
      }
    } else {
      const mockPath = "/demo-project";
      addOpenFolder(mockPath);
      const mockTree: FileNodeData[] = [
        { name: "docs", path: "/demo-project/docs", isDir: true, size: 0, children: [] },
        { name: "src", path: "/demo-project/src", isDir: true, size: 0, children: [] },
        { name: "README.md", path: "/demo-project/README.md", isDir: false, size: 2048 },
        { name: "notes.md", path: "/demo-project/notes.md", isDir: false, size: 512 },
        { name: "guide.md", path: "/demo-project/guide.md", isDir: false, size: 1024 },
      ];
      updateFolderTree(mockPath, mockTree);
    }
  }, [addOpenFolder, updateFolderTree, t]);

  // ─── 关闭文件夹 ──────────────────────────────
  // v0.4.0：移除指定文件夹，清理该文件夹相关的 childrenMap 和 expandedPaths
  // v0.8.2 功能3：关闭时保留一帧渲染快照播放"滑向左侧消失"动画（数据已出 store，
  // 快照由 closingFolders 承载，动画结束后清除）。
  const closeFolder = useCallback((folderPath: string) => {
    // 快照：关闭前该文件夹的渲染数据（folder + nodes），供退出动画渲染
    const closing = treeDataByFolder.find((x) => x.folder.path === folderPath);
    if (closing) {
      setClosingFolders((prev) => [
        ...prev.filter((x) => x.folder.path !== folderPath),
        closing,
      ]);
      // v0.8.2 动画优化：必须等"滑出 + 停顿 + 高度收起"整条串行动画播完再清除快照。
      // 此前这里用的是 SECTION_SLIDE_OUT_MS（360ms）——快照在高度收起前就被卸载，
      // 下方栏会在瞬间直接跳到新位置，看起来像"左滑消失"和"上移补位"同时发生。
      window.setTimeout(() => {
        setClosingFolders((prev) => prev.filter((x) => x.folder.path !== folderPath));
      }, SECTION_OUT_TOTAL_MS);
    }
    removeOpenFolder(folderPath);
    // v0.8.4 需求10：注销该文件夹的 watcher（与 removeOpenFolder/缓存清理同处；
    // Rust 端未注册时 no-op；失败不影响关闭流程）
    fileService.unwatchFolder?.(folderPath)?.catch(() => {});
    // 清理该文件夹路径前缀下的缓存和展开状态
    setChildrenMap((prev) => {
      const next = new Map(prev);
      for (const key of Array.from(next.keys())) {
        if (key === folderPath || key.startsWith(folderPath + "/") || key.startsWith(folderPath + "\\")) {
          next.delete(key);
        }
      }
      return next;
    });
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const key of Array.from(next)) {
        if (key === folderPath || key.startsWith(folderPath + "/") || key.startsWith(folderPath + "\\")) {
          next.delete(key);
        }
      }
      return next;
    });
  }, [removeOpenFolder, treeDataByFolder]);

  // ─── 拖拽文件夹打开（监听 App.tsx 派发的事件）─────────
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.path) {
        openFolderAt(detail.path);
      }
    };
    window.addEventListener("lightmd:openFolder", handler);
    return () => window.removeEventListener("lightmd:openFolder", handler);
  }, [openFolderAt]);

  // v0.8.2 修复：标题栏「新建 > 新建文件夹」→ 打开应用内新建文件夹弹框。
  // App.tsx 不再走原生 prompt() + 保存对话框（那套既不是应用内弹框，
  // 也无法选择目标路径）。此处与侧栏工具栏按钮复用同一个 handleNewFolder。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === CMD_NEW_FOLDER) {
        // 不预选具体文件夹：由弹框按"只有一个已打开文件夹时默认勾选"的规则处理，
        // 用户也可自行勾选或填写自定义路径
        handleNewFolder("");
      }
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, [handleNewFolder]);

  // ─── v0.8.0 WP2 需求6：打开所在文件夹工作区 ──────────────────────────
  // 已在侧栏挂载 → 仅展开定位；未挂载 → 挂载该文件夹为工作区并定位
  /**
   * v0.8.4 S1 修复（WP5 必修）：展开到目标目录并逐级加载中间层。
   * 旧 expandAncestors 只把祖先路径塞进 expandedPaths，不加载 childrenMap，
   * 且 toggleExpand 对"已展开"路径只做收起（L1063-1064）→ 深层文件定位后
   * 树中显示"空文件夹"（a 展开但内容空，b 根本不可见）。
   * 现改为从根到目标逐级 listDir：每层经 sortChildren 统一出口写入 childrenMap
   * （与 toggleExpand / refreshTree 的写入口径一致），并在 setState updater 内
   * 同步双写 expandedPathsRef（S2 修复，不等 useEffect）。
   */
  const expandTo = useCallback(
    async (target: string) => {
      if (!target) return;
      // 定位目标所属的已打开文件夹根（归一比对，与 findFolderRootOf 同口径）
      const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const t2 = norm(target);
      const root = useFileStore
        .getState()
        .openFolders.find((f) => {
          const r = norm(f.path);
          return t2 === r || t2.startsWith(r + "/");
        })?.path;
      if (!root) {
        // 未命中已打开文件夹（openContainingWorkspace 的未挂载分支才会发生）：
        // 退化为仅塞展开路径，与旧行为一致（同样显式双写 ref，保证后续刷新可见）
        const next = new Set(expandedPathsRef.current);
        let cur = target;
        for (let i = 0; i < 64 && cur; i++) {
          next.add(cur);
          const parent = getParentDir(cur);
          if (!parent || parent === cur) break;
          cur = parent;
        }
        expandedPathsRef.current = next;
        setExpandedPaths(next);
        return;
      }
      // 构造 root 下第一层 → target 的目录链（target 自身也要展开，文件才可见）
      const chain: string[] = [];
      let cur = norm(t2) === norm(root) ? "" : target;
      while (cur) {
        chain.unshift(cur);
        const parent = getParentDir(cur);
        if (!parent || parent === cur || norm(parent) === norm(root)) break;
        cur = parent;
      }
      // 基于最新 ref 计算展开集，逐级加载中间层（串行，保证父层先就绪）
      const next = new Set(expandedPathsRef.current);
      for (const dir of chain) {
        next.add(dir);
        // 已有缓存（childrenMap）的层不重复 IO（幂等：重复加载也无害，但省一次）
        if (isTauri() && !childrenMap.has(dir)) {
          try {
            const entries = await fileService.listDir(dir);
            // 经 sortChildren 统一出口写入（WP2 约定：childrenMap 缓存必须已排序）
            const childNodes = sortChildren(root, dir, entries.map(mapToFileNode));
            setChildrenMap((prev) => {
              const m = new Map(prev);
              m.set(dir, childNodes);
              return m;
            });
          } catch (err) {
            // 逐级加载失败不阻断后续层（该层留给用户手动展开时自然重试）
            console.error("逐级加载目录失败:", err);
          }
        }
      }
      // S2：setState 与 ref 同步双写，后续 refreshTree 立即可见新展开目录
      expandedPathsRef.current = next;
      setExpandedPaths(new Set(next));
    },
    [childrenMap, sortChildren],
  );

  const handleOpenWorkspace = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      const store = useFileStore.getState();
      const result = openContainingWorkspace(filePath, {
        openFolders: store.openFolders,
        isPathInOpenFolders: store.isPathInOpenFolders,
        expandTo,
        openFolder: (p) =>
          window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: p } })),
        setActive: (p) => setActivePath(p),
      });
      const name = result.parentDir.split(/[\\/]/).pop() || result.parentDir;
      showMessage(t("filetree.workspaceOpened", { name }));
    },
    [expandTo, t],
  );

  // v0.8.0 WP2 需求6：标签栏等外部入口通过命令总线复用同一套"打开所在文件夹工作区"逻辑
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id === "workspace.open" && typeof detail.path === "string") {
        handleOpenWorkspace(detail.path);
      }
    };
    window.addEventListener("lightmd:command", handler);
    return () => window.removeEventListener("lightmd:command", handler);
  }, [handleOpenWorkspace]);

  // ─── 打开文件 ────────────────────────────────

  const handleSelectFile = useCallback(
    async (node: FileNodeData) => {
      if (node.isDir) return;
      if (!isSupportedTextFile(node.name)) {
        showError(t("filetree.unsupportedFileType"));
        return;
      }

      setActivePath(node.path);

      try {
        let content = "";
        if (isTauri()) {
          content = await fileService.readFile(node.path);
        } else {
          content = localStorage.getItem("lightmd-content") || "";
        }

        // 空文件使用默认内容
        if (!content.trim()) {
          content = `# ${node.name.replace(/\.md$/i, "")}\n\n`;
        }

        window.dispatchEvent(
          new CustomEvent("lightmd:openFile", {
            detail: { path: node.path, name: node.name, content },
          })
        );

        addRecentFile({ path: node.path, name: node.name });

        // v0.4.0：如果文件不在任一已打开文件夹下，添加为临时文件
        if (!isPathInOpenFolders(node.path)) {
          addTempFile({ name: node.name, path: node.path, isDir: false, size: 0 });
        }
      } catch (err) {
        showError(t("filetree.openFileFailed"));
        console.error(err);
      }
    },
    [addRecentFile, addTempFile, isPathInOpenFolders, t]
  );

  // v0.4.3 Issue 2：点击搜索结果打开文件
  const handleSearchResultClick = useCallback((result: { name: string; path: string }) => {
    handleSelectFile({ name: result.name, path: result.path, isDir: false, size: 0 });
    setShowSearch(false);
    setSearchQuery("");
  }, [handleSelectFile]);

  // ─── 展开/折叠 ───────────────────────────────

  const toggleExpand = useCallback(
    async (path: string) => {
      const next = new Set(expandedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // 首次展开时，加载子目录
        if (isTauri() && !childrenMap.has(path)) {
          try {
            const entries = await fileService.listDir(path);
            // v0.8.4 需求3+7：排序统一出口（rootPath=所属文件夹根；childrenMap 缓存
            // 供 FileNode 直接渲染，必须已排序）
            const childNodes = sortChildren(
              findFolderRootOf(path),
              path,
              entries.map(mapToFileNode)
            );
            setChildrenMap((prev) => {
              const next = new Map(prev);
              next.set(path, childNodes);
              return next;
            });
          } catch (err) {
            console.error("加载子目录失败:", err);
          }
        }
      }
      setExpandedPaths(next);
    },
    [expandedPaths, childrenMap, sortChildren]
  );

  // ─── 刷新文件树（递归刷新所有已展开的子目录）──────────
  // 注意：refreshTree 必须在其他 useCallback 之前声明，因为它们依赖 refreshTree
  // v0.4.0：支持指定文件夹路径刷新，不传则刷新所有打开的文件夹

  const refreshTree = useCallback(async (folderPath?: string) => {
    if (!isTauri()) return;
    // v0.4.0：不传 folderPath 时刷新所有打开的文件夹；传参时仅刷新指定文件夹
    const targetPaths = folderPath ? [folderPath] : openFolders.map((f) => f.path);
    if (targetPaths.length === 0) return;
    // 使用 ref 获取最新的 expandedPaths，避免闭包问题
    const currentExpanded = expandedPathsRef.current;

    // 递归加载目录内容
    // v0.8.4 需求3+7：排序统一出口（rootPath=本次刷新的文件夹根，整树统一其排序模式）
    const loadDir = async (rootPath: string, dirPath: string): Promise<FileNodeData[]> => {
      const entries = await fileService.listDir(dirPath);
      return sortChildren(rootPath, dirPath, entries.map(mapToFileNode));
    };

    // 串行刷新每个文件夹（避免并发 IO 导致状态混乱）
    for (const targetPath of targetPaths) {
      try {
        // 加载根目录
        const rootNodes = await loadDir(targetPath, targetPath);

        // 构建新的 childrenMap
        const newChildrenMap = new Map<string, FileNodeData[]>();
        newChildrenMap.set(targetPath, rootNodes);

        // 递归刷新已展开的子目录
        const refreshExpanded = async (items: FileNodeData[]) => {
          for (const item of items) {
            if (item.isDir && currentExpanded.has(item.path)) {
              try {
                const childNodes = await loadDir(targetPath, item.path);
                newChildrenMap.set(item.path, childNodes);
                await refreshExpanded(childNodes);
              } catch (err) {
                console.error(`刷新子目录失败 ${item.path}:`, err);
              }
            }
          }
        };

        await refreshExpanded(rootNodes);

        // 清除不再存在的子目录路径
        const validPaths = new Set<string>();
        const collectPaths = (items: FileNodeData[]) => {
          for (const item of items) {
            validPaths.add(item.path);
            if (item.isDir && newChildrenMap.has(item.path)) {
              collectPaths(newChildrenMap.get(item.path)!);
            }
          }
        };
        collectPaths(rootNodes);
        for (const [key] of newChildrenMap) {
          if (key !== targetPath && !validPaths.has(key)) {
            newChildrenMap.delete(key);
          }
        }

        // v0.4.0：更新 store 中该文件夹的 fileTree，并合并到 childrenMap（保留其他文件夹缓存）
        updateFolderTree(targetPath, rootNodes);
        // v0.8.2 动画优化：仅清除"整棵子树里都不再存在"的目录缓存。
        // 此前这里无条件清空本文件夹下的全部缓存，导致**已折叠**目录的子目录缓存
        // 一并丢失——收起动画随即失去子节点快照可渲染（动画直接跳变）。
        // 折叠状态不影响磁盘存在性，故按递归收集出的真实路径集合判定。
        const liveDirs = new Set<string>();
        const collectLiveDirs = (items: FileNodeData[]) => {
          for (const item of items) {
            if (!item.isDir) continue;
            liveDirs.add(item.path);
            collectLiveDirs(item.children ?? []);
          }
        };
        collectLiveDirs(rootNodes);
        setChildrenMap((prev) => {
          const next = new Map(prev);
          // 删除该文件夹下已不存在于磁盘的旧缓存（保留折叠目录的有效缓存）
          for (const key of Array.from(next.keys())) {
            if (
              (key === targetPath ||
                key.startsWith(targetPath + "/") ||
                key.startsWith(targetPath + "\\")) &&
              !liveDirs.has(key)
            ) {
              next.delete(key);
            }
          }
          // 加入新缓存
          for (const [k, v] of newChildrenMap) {
            next.set(k, v);
          }
          return next;
        });
      } catch (err) {
        console.error(`刷新文件夹失败 ${targetPath}:`, err);
      }
    }
  }, [openFolders, updateFolderTree, sortChildren]);

  // ─── v0.8.4 需求10：watch 事件定向刷新 ──────────────────────

  // childrenMap 的 ref 镜像：watch 事件回调（去抖后触发）需读取最新已加载目录集合，
  // 不能依赖 effect 闭包中的旧 state
  const childrenMapRef = useRef(childrenMap);
  useEffect(() => { childrenMapRef.current = childrenMap; }, [childrenMap]);

  /**
   * 定向刷新单个目录：listDir → 经 sortChildren 统一出口写 childrenMap（与 WP2/5 约定一致：
   * childrenMap 缓存必须已排序）→ 若 dir 恰为某打开文件夹的根则同步 updateFolderTree。
   * 在途去重：同一目录的刷新进行中不重复发起（refreshDirInFlight 模块级 Set）。
   */
  const refreshDir = useCallback(async (dir: string) => {
    const norm = normalizePath(dir);
    if (refreshDirInFlight.has(norm)) return;
    refreshDirInFlight.add(norm);
    try {
      // dir 所属的打开文件夹根：排序模式整树统一取根的（v0.8.4 需求7 语义）；
      // 文件夹已全部关闭时（事件在途）直接忽略
      const folders = useFileStore.getState().openFolders;
      const rootPath = folders.find((f) => {
        const rootNorm = normalizePath(f.path);
        return norm === rootNorm || norm.startsWith(rootNorm + "/");
      })?.path;
      if (!rootPath) return;
      const entries = await fileService.listDir(dir);
      const nodes = entries.map(mapToFileNode);
      const sorted = sortChildren(rootPath, dir, nodes);
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(dir, sorted);
        return next;
      });
      // dir 为文件夹根 → store 的 fileTree 是 treeDataByFolder 的数据源，需同步
      if (normalizePath(rootPath) === norm) updateFolderTree(dir, sorted);
    } catch (err) {
      // 目录可能已被外部删除/移出：树在全局刷新（Ctrl+R）时收敛，此处静默不打断 watch 循环
      console.error(`watch 刷新目录失败 ${dir}:`, err);
    } finally {
      refreshDirInFlight.delete(norm);
    }
  }, [sortChildren, updateFolderTree]);

  // watch 事件回调经 ref 调用最新的 refreshDir / t / showError，
  // 订阅 effect 仅挂载一次（避免重复 subscribe/unsubscribe 开销）
  const refreshDirRef = useRef(refreshDir);
  useEffect(() => { refreshDirRef.current = refreshDir; }, [refreshDir]);
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const showErrorRef = useRef<(msg: string) => void>(() => {});
  useEffect(() => { showErrorRef.current = showError; }, [showError]);

  // 订阅 Rust watcher 聚合事件：
  // 1. 前端 300ms 按 root 去抖（同 root 连续事件合并为一个定时器）；
  // 2. 刷新范围 = 事件 paths 中各路径「childrenMap 已加载的最深祖先目录」（resolveRefreshDirs）；
  // 3. hasRemove → 最近打开/收藏条目标 stale（§3.1b 第 4 点，P2 拍板收藏夹同标）；
  // 4. 根目录自身被外部删除 → 保持该栏 + toast，不自动关闭（P4 拍板）。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    /** 按 root 聚合的待处理事件：paths 合并、hasRemove 取或、单一定时器 */
    const pending = new Map<string, { paths: Set<string>; hasRemove: boolean; timer: number }>();
    const flush = (root: string) => {
      const item = pending.get(root);
      if (!item) return;
      pending.delete(root);
      const paths = Array.from(item.paths);
      if (item.hasRemove) {
        // 删除事件 → stale 联动（markRecentStale/markRecentFolderStale/markFavoriteStale
        // 仅匹配各自清单，数据层已做归一化匹配；成功重新打开同路径时天然清除。
        // v0.8.5：最近打开为纯历史——外部删除/移出只标 ⚠，永不移除条目）
        const fileStore = useFileStore.getState();
        for (const p of paths) {
          fileStore.markRecentStale(p);
          fileStore.markRecentFolderStale(p);
          fileStore.markFavoriteStale(p);
        }
        // 根目录自身在删除事件中且该栏仍打开 → toast 提示（不自动关闭）
        const rootNorm = normalizePath(root);
        const rootRemoved = paths.some((p) => normalizePath(p) === rootNorm);
        const stillOpen = useFileStore.getState().openFolders.some(
          (f) => normalizePath(f.path) === rootNorm
        );
        if (rootRemoved && stillOpen) {
          showErrorRef.current(tRef.current("filetree.folderRemovedExternally"));
        }
      }
      // 定向刷新：命中「已加载的最深祖先目录」（未展开区域忽略，展开时自然读最新）
      const dirs = resolveRefreshDirs(paths, childrenMapRef.current.keys());
      // 未命中任何已加载目录（变更全在未展开区域，或启动恢复的文件夹 childrenMap
      // 尚无缓存——根层渲染自 store.fileTree）→ 兜底刷新根层一次：
      // 聚合去抖保证每窗口至多一次 listDir，幂等无害；文件夹已关闭时 refreshDir 内部忽略
      if (dirs.length === 0) dirs.push(root);
      for (const d of dirs) refreshDirRef.current(d);
    };
    fileService.onFolderChanged((payload) => {
      if (!payload?.root) return;
      const existing = pending.get(payload.root);
      if (existing) {
        // 同 root 的事件在去抖窗口内到达：合并 paths / hasRemove，不重置定时器
        for (const p of payload.paths ?? []) existing.paths.add(p);
        existing.hasRemove = existing.hasRemove || !!payload.hasRemove;
      } else {
        const timer = window.setTimeout(() => flush(payload.root), WATCH_DEBOUNCE_MS);
        pending.set(payload.root, { paths: new Set(payload.paths ?? []), hasRemove: !!payload.hasRemove, timer });
      }
    }).then((fn) => {
      // 组件可能在订阅建立前已卸载（StrictMode 竞态，与 App.tsx drag-drop 同款防护）
      if (disposed) fn();
      else unlisten = fn;
    });
    // v0.9.5 问题1：应用自身「另存为」落盘后派发的定向刷新事件。
    // 另存为写盘不依赖 OS 目录 watcher 回声（watcher 注册失败/在途去抖丢事件时
    // 新文件只能手动刷新才能看到），由写入方主动通知，走同一条 resolveRefreshDirs
    // → refreshDir 定向刷新链；目录不在任何打开文件夹下时 refreshDir 内部忽略。
    const onRefreshFolder = (e: Event) => {
      const dir = (e as CustomEvent).detail?.dir as string | undefined;
      if (!dir) return;
      const dirs = resolveRefreshDirs([dir], childrenMapRef.current.keys());
      if (dirs.length === 0) dirs.push(dir);
      for (const d of dirs) refreshDirRef.current(d);
    };
    window.addEventListener("lightmd:refresh-folder", onRefreshFolder);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("lightmd:refresh-folder", onRefreshFolder);
      for (const { timer } of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // ─── 重命名 ──────────────────────────────────

  const handleRenameStart = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleRenameConfirm = useCallback(
    async (path: string, newName: string) => {
      setRenamingPath(null);
      try {
        const parentDir = getParentDir(path);
        const newPath = joinPath(parentDir, newName);

        if (isTauri()) {
          await fileService.renameFile(path, newPath);
        }

        // 联动更新收藏和最近文件中的路径和名称
        renameFileEntry(path, newPath, newName);
        // v0.8.4 需求3（S5）：手动顺序表同步原地换名，避免重命名后文件跳到列表末尾
        renameInOrder(parentDir, path.split(/[\\/]/).pop() || path, newName);
        // 同步更新已打开标签页的路径和名称
        const { openTabs, activeTabIdx } = useEditorStore.getState();
        const tabIdx = openTabs.findIndex((t) => t.path === path);
        if (tabIdx !== -1) {
          useEditorStore.setState((s) => ({
            openTabs: s.openTabs.map((t, i) =>
              i === tabIdx ? { ...t, path: newPath, name: newName } : t
            ),
          }));
        }
        // 同步全局 filePath（如果当前活跃文件被重命名）
        if (useEditorStore.getState().filePath === path) {
          useEditorStore.getState().openFile(newPath);
        }

        showMessage(t("filetree.renamed", { name: newName }));
        await refreshTree();
      } catch (err) {
        showError(t("filetree.renameFailed"));
        console.error(err);
      }
    },
    [refreshTree, renameFileEntry, t]
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // ─── 新建文件/文件夹 ──────────────────────────

  // v0.8.4 需求5+9（WP5）：改为 NewFileDialog 弹框（原生 prompt 在 WebView2 下贴顶显示）。
  // 打开弹框前 silent listDir 目标目录，用 makeUniqueName 预填不冲突的默认名
  // （"新文档.md" → "新文档 - 副本.md"…，与复制副本命名风格一致）；
  // listDir 失败不提示（静默降级为默认名）。
  const handleNewFile = useCallback(
    (parentPath: string) => {
      const defaultName = t("filetree.newDocName");
      setNewFileDialog({ parentPath, defaultName });
      void (async () => {
        try {
          const entries = await fileService.listDir(parentPath);
          const unique = makeUniqueName(
            defaultName,
            entries.map((e) => e.name),
          );
          // 仅当弹框仍停留在同一目标目录时应用避让名（期间用户取消/换目录则忽略）
          setNewFileDialog((prev) =>
            prev && prev.parentPath === parentPath ? { ...prev, defaultName: unique } : prev,
          );
        } catch {
          // 静默：预填失败就用默认名，创建时 Rust 端仍会兜底重名报错
        }
      })();
    },
    [t],
  );

  // v0.8.4 需求5+9（WP5）：NewFileDialog 确认回调。
  // createFile 抛错（如重名"文件已存在"）直接向上传递 → 弹框内联显示并保持打开；
  // 成功后：展开父目录（ref 双写，S2）→ refreshTree → 派发 openFile（"新建即打开"语义不变）。
  const handleCreateFileConfirm = useCallback(
    async (name: string) => {
      if (!newFileDialog) return;
      const parentPath = newFileDialog.parentPath;
      const filePath = joinPath(parentPath, name);

      if (isTauri()) {
        await fileService.createFile(filePath);
      }

      setNewFileDialog(null);
      showMessage(t("filetree.created", { name }));
      // 确保父目录展开 —— S2 修复：同步双写 ref（基于 ref 算出新集合 → 立即写回 →
      // 再 setState）。不能用"setState updater 内写 ref"：React 18 中 updater 延迟
      // 到 re-render 才执行，而下方 refreshTree 在首个 await 前同步读 ref，
      // 拿不到新展开目录 → 展开后内容为空（测试实测确认）
      const next = new Set(expandedPathsRef.current);
      next.add(parentPath);
      expandedPathsRef.current = next;
      setExpandedPaths(next);
      // 刷新目录树（会递归刷新已展开的目录）
      await refreshTree();
      // v0.8.0 WP2 需求7：在具体文件夹下新建的文件直接打开（落盘语义，
      // 与工具栏"新建临时文件"区分：用户已在目标文件夹上操作，意图明确）
      window.dispatchEvent(
        new CustomEvent("lightmd:openFile", { detail: { path: filePath, content: "" } }),
      );
    },
    [newFileDialog, refreshTree, t],
  );

  // v0.8.0 WP2 需求4(2)：改为自定义弹框（支持多选目标文件夹 + 自定义路径），
  // 不再用原生 prompt()（原生无法选择落点，且无文件夹打开时直接失败）
  /**
   * v0.8.2 修复：改为普通函数声明（而非 useCallback 常量）。
   * 命令总线监听 effect 位于组件前部，需要在此之前就能引用它；
   * 该函数只做两个 setState，没有闭包依赖，无需 memo。
   */
  function handleNewFolder(_parentPath: string) {
    setNewFolderPreselected(_parentPath || null);
    setShowNewFolderDialog(true);
  }

  // v0.8.4 需求2：树内节点右键"复制/剪切"（文件与文件夹通用）。
  // 与「打开的文件」面板右键一致：写内存剪贴板 + toast 反馈
  // （FileNode 无 toast 通道，经 props 注入，点击后由 FileNode 自行关闭菜单）。
  const handleCopyNode = useCallback((node: FileNodeData) => {
    // v0.8.4 需求3 修复：写入 isDir，供粘贴时自嵌套守卫按源类型分流
    setClipboard({ path: node.path, name: node.name, isDir: node.isDir });
    showMessage(t("filetree.copied", { name: node.name }));
  }, [t]);

  const handleCutNode = useCallback((node: FileNodeData) => {
    setClipboard({ path: node.path, name: node.name, mode: "cut", isDir: node.isDir });
    showMessage(t("filetree.cutted", { name: node.name }));
  }, [t]);

  // 弹框确认：对每个目标目录创建同名文件夹，部分失败给出明细
  const handleCreateFolder = useCallback(
    async (targets: string[], folderName: string) => {
      const failed: string[] = [];
      for (const dir of targets) {
        try {
          if (isTauri()) {
            await fileService.createDir(joinPath(dir, folderName));
          }
        } catch (err) {
          failed.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setShowNewFolderDialog(false);
      if (failed.length === 0) {
        showMessage(t("newFolder.created", { name: folderName }));
      } else {
        showError(t("newFolder.partialFailed", { detail: failed.join("; ") }));
      }
      // 展开目标目录并刷新文件树
      // S2/需求4 修复：同步双写 ref（基于 ref 算出新集合 → 立即写回 → 再 setState）。
      // 旧实现靠 useEffect 同步 ref，"setState updater 内写 ref"也不可靠——
      // React 18 中 updater 延迟到 re-render 才执行，而 refreshTree 在首个
      // await 前同步读 ref → 新展开目录不进刷新范围，展开后显示为空。
      const next = new Set(expandedPathsRef.current);
      targets.forEach((d) => next.add(d));
      expandedPathsRef.current = next;
      setExpandedPaths(next);
      await refreshTree();
    },
    [refreshTree, t],
  );

  // ─── 删除文件（v0.8.5 需求2：删除 = 移到系统回收站，文案同步回收站语义） ────────────────────────────────

  const handleDelete = useCallback(
    async (node: FileNodeData) => {
      const confirmed = confirm(t("filetree.confirmDelete", { type: node.isDir ? t("filetree.folderType") : t("filetree.fileType"), name: node.name }));
      if (!confirmed) return;

      try {
        if (isTauri()) {
          await fileService.deleteFile(node.path);
        }

        showMessage(t("filetree.deleted", { name: node.name }));
        await refreshTree();
        // v0.8.0 WP2 修复2：通知 App 关闭该文件（或该文件夹下所有文件）已打开的标签，
        // 否则被删除的文件仍停留在编辑器里形成"幽灵标签"
        window.dispatchEvent(
          new CustomEvent("lightmd:command", { detail: { id: "file.deleted", path: node.path } }),
        );
      } catch (err) {
        showError(t("filetree.deleteFailed"));
        console.error(err);
      }
    },
    [refreshTree, t]
  );

  // ── 拖拽（图片等） ──────────────────────────
  // 说明：v0.8.0 修复 P3 起，绘制拖拽统一走自制鼠标拖拽（见下方 handleFileDragStart），
  // 原 HTML5 onDragStart 在 Tauri 下不会触发，已移除。

  // ─── 状态消息 ────────────────────────────────

  // v0.8.0 修复 P11-8：侧栏所有文件操作的提示统一显示在"侧栏旁边"
  // （fixed 定位于侧栏右侧、不占布局 → 既不抖动，也不会跑到软件右下角）。
  function pushToast(msg: string, error = false) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect?.right) setToastLeft(rect.right + 12);
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, error }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3000);
  }

  function showMessage(msg: string) {
    pushToast(msg, false);
  }

  /** 失败/警告类提示（错误色） */
  function showError(msg: string) {
    pushToast(msg, true);
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ─── 临时文件右键菜单 ────────────────────────────

  const [tempContextMenu, setTempContextMenu] = useState<{ x: number; y: number; file: FileNodeData } | null>(null);

  // 关闭临时文件：从列表移除，同步关闭对应标签，如果当前活跃则切换到下一个/上一个文件
  const closeTempFile = useCallback((file: FileNodeData) => {
    const currentIdx = tempFiles.findIndex(f => f.path === file.path);
    removeTempFile(file.path);

    // 同步关闭对应的标签页
    const { openTabs, closeTab, activeTabIdx } = useEditorStore.getState();
    const tabIdx = openTabs.findIndex(t => t.path === file.path);
    if (tabIdx !== -1) {
      closeTab(tabIdx);
      // 如果关闭的是当前激活标签，需要切换内容
      if (tabIdx === activeTabIdx) {
        const remainingTabs = useEditorStore.getState().openTabs;
        const newActiveIdx = useEditorStore.getState().activeTabIdx;
        if (remainingTabs.length > 0 && remainingTabs[newActiveIdx]) {
          // 切换到新的活跃标签
          const activeTab = remainingTabs[newActiveIdx];
          window.dispatchEvent(new CustomEvent("lightmd:openFile", {
            detail: { path: activeTab.path, content: activeTab.content || "" },
          }));
        } else {
          // 没有剩余标签，清空编辑器
          window.dispatchEvent(new CustomEvent("lightmd:closeFile"));
        }
      }
    }

    if (activePath === file.path) {
      // 查找下一个或上一个文件
      const remaining = tempFiles.filter(f => f.path !== file.path);
      let nextFile: FileNodeData | undefined;
      if (currentIdx < remaining.length) {
        nextFile = remaining[currentIdx]; // 下一个
      } else if (currentIdx > 0) {
        nextFile = remaining[currentIdx - 1]; // 上一个
      }

      if (nextFile) {
        setActivePath(nextFile.path);
        // 打开下一个/上一个文件（仅当标签页没有处理时）
        if (tabIdx === -1) {
          handleSelectFile({ ...nextFile, children: [] });
        }
      } else {
        setActivePath(null);
        // 没有其他文件且标签页也没有处理时，清空编辑器
        if (tabIdx === -1) {
          window.dispatchEvent(new CustomEvent("lightmd:closeFile"));
        }
      }
    }
  }, [removeTempFile, activePath, tempFiles, handleSelectFile]);

  // 重命名临时文件
  const [tempRenamingPath, setTempRenamingPath] = useState<string | null>(null);
  const [tempRenameValue, setTempRenameValue] = useState("");
  const tempRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tempRenamingPath && tempRenameInputRef.current) {
      tempRenameInputRef.current.focus();
      const dotIdx = tempRenameValue.lastIndexOf(".");
      tempRenameInputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : tempRenameValue.length);
    }
  }, [tempRenamingPath, tempRenameValue]);

  const handleTempRenameConfirm = useCallback(async (file: FileNodeData) => {
    const newName = tempRenameValue.trim();
    setTempRenamingPath(null);
    if (!newName || newName === file.name) return;
    try {
      const parentDir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
      const newPath = joinPath(parentDir, newName);
      if (isTauri()) {
        await fileService.renameFile(file.path, newPath);
      }
      // 联动更新收藏和最近文件中的路径和名称
      renameFileEntry(file.path, newPath, newName);
      // v0.8.4 需求3（S5）：手动顺序表同步原地换名，避免重命名后文件跳到列表末尾
      renameInOrder(parentDir, file.name, newName);
      removeTempFile(file.path);
      addTempFile({ name: newName, path: newPath, isDir: false, size: 0 });
      // 同步更新已打开标签页的路径和名称
      const { openTabs } = useEditorStore.getState();
      const tabIdx = openTabs.findIndex((t) => t.path === file.path);
      if (tabIdx !== -1) {
        useEditorStore.setState((s) => ({
          openTabs: s.openTabs.map((t, i) =>
            i === tabIdx ? { ...t, path: newPath, name: newName } : t
          ),
        }));
      }
      // 同步全局 filePath
      if (useEditorStore.getState().filePath === file.path) {
        useEditorStore.getState().openFile(newPath);
      }
      if (activePath === file.path) setActivePath(newPath);
      showMessage(t("filetree.renamed", { name: newName }));
    } catch (err) {
      showError(t("filetree.renameFailed"));
      console.error(err);
    }
  }, [tempRenameValue, removeTempFile, addTempFile, activePath, renameFileEntry, t]);

  // v0.8.1 需求3：文件属性对话框数据（null = 不展示）
  const [propFile, setPropFile] = useState<FilePropertiesData | null>(null);

  // 查看文件属性
  // v0.8.1 需求3：改为应用内对话框——原生 alert 在 WebView2 下会播放系统提示音
  const handleViewProperties = useCallback((file: FileNodeData) => {
    const parentDir = file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    setPropFile({
      name: file.name,
      path: file.path,
      dir: parentDir,
      ext,
      sizeText: file.size > 0 ? formatFileSize(file.size) : "",
    });
  }, []);

  // 关闭临时文件右键菜单
  useEffect(() => {
    if (!tempContextMenu) return;
    const close = () => setTempContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [tempContextMenu]);

  // v0.8.0 修复 P12-1：关闭文件夹空白区右键菜单
  useEffect(() => {
    if (!folderCtxMenu) return;
    const onWindowClick = () => setFolderCtxMenu(null);
    // v0.8.4 反馈1：跳过"打开本菜单的那一次右键事件"。
    // 菜单已打开时右键另一文件夹 → section 的 onContextMenu 已把新菜单打开，
    // 该事件冒泡到 window 时不能把它关掉，否则表现为菜单直接消失。
    // 其余右键（标题栏/工具栏等非本菜单打开源）仍按原逻辑关闭菜单。
    const onWindowContextMenu = (e: Event) => {
      if (e === folderCtxOpenEventRef.current) return;
      setFolderCtxMenu(null);
    };
    window.addEventListener("click", onWindowClick);
    window.addEventListener("contextmenu", onWindowContextMenu);
    return () => {
      window.removeEventListener("click", onWindowClick);
      window.removeEventListener("contextmenu", onWindowContextMenu);
    };
  }, [folderCtxMenu]);

  // 选中的临时文件索引（用于快捷键）
  const [selectedTempIdx, setSelectedTempIdx] = useState<number>(-1);

  /**
   * v0.8.3 需求2：「打开的文件」栏双高亮修复。
   *
   * selectedTempIdx 只在栏内点击时被设置，此前从不随激活条目变化失效 →
   * "点击 A → 从标签栏切到 B"后 A 仍带 selected 背景，与 B 的 active 背景
   * 形成两个高亮块。
   *
   * 这里在 activeItemKey（统一激活判定键）变化时清空键盘选中；
   * 唯一例外是本次激活由栏内点击产生（sidebarClickKeyRef 记录），
   * 否则"点击 A → 直接按 Delete/Ctrl+2"会失去关闭目标。
   * 判定逻辑在 utils/tempSelection.ts（纯函数，可单测）。
   */
  const sidebarClickKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldResetTempSelection(activeItemKey, sidebarClickKeyRef.current)) return;
    setSelectedTempIdx(-1);
  }, [activeItemKey]);

  // Delete键/Backspace 快捷键关闭临时文件（v0.9.0：等效键由 Ctrl+2 改为 Backspace，
  // 释放 Ctrl+2 给编辑器「标题 2」，消除跨场景共存）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // v0.6.6 问题3修复：焦点在可编辑元素（源码 textarea / ProseMirror / 输入框）时
      // 不响应 Delete 快捷键——此前 window 级监听会在用户编辑文字按 Delete 删字时
      // 误触发 closeTempFile，把正在编辑的文件关闭
      if (isFocusInEditable(document.activeElement)) {
        return;
      }
      // Delete 键关闭选中的临时文件（带修饰键的组合不在此语义内，
      // 避免与用户自定义的 Ctrl+Delete / Ctrl+Backspace 等绑定同时触发）
      if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && selectedTempIdx >= 0 && selectedTempIdx < tempFiles.length) {
        e.preventDefault();
        closeTempFile(tempFiles[selectedTempIdx]);
        setSelectedTempIdx(-1);
        return;
      }
      // Backspace 关闭选中的临时文件（v0.9.0）
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && selectedTempIdx >= 0 && selectedTempIdx < tempFiles.length) {
        e.preventDefault();
        closeTempFile(tempFiles[selectedTempIdx]);
        setSelectedTempIdx(-1);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedTempIdx, tempFiles, closeTempFile]);

  // ─── v0.8.0 WP2 需求1：复制 / 移动（粘粘贴与拖拽共用）──────────────────
  // 重名时自动生成" - 副本"后缀，避免覆盖目标目录已有文件。
  const transferTo = useCallback(
    async (
      srcPath: string,
      targetDir: string,
      mode: "copy" | "move",
      opts?: { isClipboardPaste?: boolean; srcIsDir?: boolean },
    ) => {
      if (!srcPath || !targetDir) return;
      if (!isTauri()) return;
      // v0.8.4 需求1（P0）：自嵌套守卫——文件夹复制/移动到自身内部任何层级一律拒绝
      // （copy 同样拒绝，避免递归无限复制）。拖拽路径的高亮阶段已由 canDrop 前置拦截，
      // 此处覆盖剪切→粘贴与标签栏拖入等不经三分流的路径，是最后防线。
      // v0.8.4 需求3 修复：守卫按源类型分流（canDropIntoTarget）——只有**目录源**才判自嵌套；
      // 文件源一律放行（文件不可能是目录祖先），仅防御性拒绝与源完全同路径。
      // 修复前对文件源也套用 isDescendantDir，会把"子文件夹里的文件复制/移动到所属文件夹根"
      // （targetDir 是文件的祖先）误判为自嵌套而失败，这是真实 bug。
      if (!canDropIntoTarget(srcPath, opts?.srcIsDir === true, targetDir)) {
        showError(t("filetree.cannotMoveIntoSelf"));
        return;
      }
      // 不允许把文件放回它自己所在的目录（移动语义下是 no-op，复制语义下会生成副本）
      const name = srcPath.split(/[\\/]/).pop() || "";
      try {
        let existing = new Set<string>();
        try {
          const entries = await fileService.listDir(targetDir);
          existing = new Set(entries.map((en) => en.name));
        } catch {
          // 目标目录读取失败时不阻断，直接尝试原始名字
        }
        // v0.8.0 修复 P1-7：移动到自身所在目录 → resolveTransferName 返回 null（no-op）
        const unique = resolveTransferName(srcPath, targetDir, mode, existing);
        if (!unique) return;
        const dst = joinPath(targetDir, unique);
        if (mode === "move") {
          // v0.8.4 需求1：改用 moveFile——Rust 端 rename 失败（跨盘）时降级为
          // 递归复制 + 删除源，支持 D:→C: 等跨卷移动（原 renameFile 跨盘必败）
          await fileService.moveFile(srcPath, dst);
          // v0.8.0 修复 P11-1：移动后打开的文件自动变成"新路径下的文件"——
          // 同步标签 path/name、全局 filePath（编辑器跟随）以及侧栏"打开的文件"条目
          syncOpenTabsAfterRename(srcPath, dst, unique);
          // v0.8.4 需求1b：renameFileEntry 已是 stale 双条目语义——最近打开旧条目
          // 保留标 stale（⚠ 提示）+ 新路径条目头插入列。拖拽移动与剪切粘贴共用
          // 本函数，两条路径的 stale 联动由此统一成立。
          useFileStore.getState().renameFileEntry(srcPath, dst, unique);
          // 移动后内存剪贴板里的路径失效（把剪贴板更新为新路径，isDir 保持不变）
          const clip = getClipboard();
          if (clip?.path === srcPath) setClipboard({ path: dst, name: unique, mode: clip.mode, isDir: clip.isDir });
          // 移动语义使用专用提示（此前误用"已粘贴到"）
          showMessage(t("filetree.moved", { name: targetDir }));
        } else {
          await fileService.copyFile(srcPath, dst);
          showMessage(t("filetree.pasted", { name: targetDir }));
        }
        // v0.8.0 修复 P13-1：来自剪贴板的"剪切"粘贴成功后清空剪贴板
        // （与系统资源管理器的"剪切→粘贴后就清空"行为一致）
        if (opts?.isClipboardPaste && mode === "move") clearClipboard();
        await refreshTree();
      } catch (err) {
        showError(
          t("filetree.copyFailed", { error: err instanceof Error ? err.message : String(err) }),
        );
        console.error(err);
      }
    },
    [refreshTree, t],
  );

  // v0.8.4 反馈1：剪贴板粘贴到指定文件夹——文件夹空白区右键菜单与
  // 文件夹节点右键菜单共用的唯一链路（模式由剪贴板决定：copy → 复制，cut → 移动）。
  const handlePasteIntoDir = useCallback(
    (targetDir: string) => {
      const clip = getClipboard();
      // v0.8.0 修复 P13-1：剪贴板为"剪切"时粘贴 = 移动（cut → move），成功后清空剪贴板
      // v0.8.4 需求3 修复：srcIsDir 取自剪贴板（目录源才判自嵌套）
      if (clip) {
        void transferTo(clip.path, targetDir, clipboardTransferMode(clip), {
          isClipboardPaste: true,
          srcIsDir: clip.isDir === true,
        });
      }
    },
    [transferTo],
  );

  // ─── v0.8.4 需求3：同目录拖拽重排（D5 分支③）──────────────────
  /**
   * v0.8.4 需求3 修复：childrenMap 的 key 来源不统一——
   * 文件夹根 key 为 store 的 folder.path（Tauri 目录对话框在 Windows 可能返回**反斜杠**），
   * 子目录 key 为 node.path（Rust list_dir 已归一为 `/`）；而 handleReorder 的 dir
   * 来自 getParentDirOf（必然已归一为 `/`）。若直接 childrenMap.get(dir)，在"根路径带
   * 反斜杠"的真实场景会落空 → 走到 findDirNodesInStore（严格相等）同样落空 → 重排静默无效。
   * 这里**比对时归一化、返回实际 key**，写入时继续用该 key，避免同一目录出现两份缓存。
   */
  const findChildrenMapKey = (map: Map<string, FileNodeData[]>, dir: string): string | null => {
    if (map.has(dir)) return dir;
    const norm = normalizePath(dir).replace(/\/+$/, "").toLowerCase();
    for (const k of map.keys()) {
      if (normalizePath(k).replace(/\/+$/, "").toLowerCase() === norm) return k;
    }
    return null;
  };

  /** 从 store 的打开文件夹树中递归查找 dir 的子节点列表（childrenMap 缺失时的回退源；路径归一比对） */
  const findDirNodesInStore = (dir: string): FileNodeData[] | null => {
    const norm = normalizePath(dir).replace(/\/+$/, "").toLowerCase();
    const isDirMatch = (p: string) => normalizePath(p).replace(/\/+$/, "").toLowerCase() === norm;
    const find = (nodes: FileNodeData[]): FileNodeData[] | null => {
      for (const n of nodes) {
        if (isDirMatch(n.path)) return n.children ?? null;
        if (n.isDir && n.children && n.children.length > 0) {
          const hit = find(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    for (const f of useFileStore.getState().openFolders) {
      const hit = find(f.fileTree as FileNodeData[]);
      if (hit) return hit;
    }
    return null;
  };

  /**
   * 同目录重排：把 srcName 移动到 targetName 前/后（place = "end" 时移除后追加到末尾）。
   *
   * UI 即时生效机制（最简可靠路径）：写入 localStorage 手动顺序表后，对该目录的
   * childrenMap 缓存按新顺序重算并写回——childrenMap 引用变化触发 treeDataByFolder
   * 重算：dir 为子目录时 FileNode 渲染直接取 childrenByPath（新顺序）立即生效；
   * dir 为根时根层列表经 sortChildren 统一出口重新读取新手动顺序，同样立即生效。
   * 后续 refreshTree / watch 定向刷新都经 sortChildren 读表，重排顺序不会丢。
   */
  const handleReorder = useCallback(
    (dir: string, srcName: string, targetName: string | null, place: "before" | "after" | "end") => {
      // 当前渲染顺序：childrenMap 缓存即排序后的渲染源；缺失（如 mock/未加载）时回退 store。
      // v0.8.4 需求3 修复：key 归一化比对并从缓存取实际 key（根路径可能为反斜杠），
      // 写入时用实际 key（命中）或归一后的 dir（未命中），避免同一目录两份缓存。
      const cacheKey = findChildrenMapKey(childrenMap, dir) ?? dir;
      const base = childrenMap.get(cacheKey) ?? findDirNodesInStore(dir);
      if (!base || base.length === 0) return; // 目录不在任何已打开文件夹内 → 无从重排（如纯临时文件所在目录）
      const names = base.map((n) => n.name);
      const nextOrder =
        place === "end"
          ? [...names.filter((n) => n !== srcName), srcName]
          : reorderList(names, srcName, targetName ?? "", place);
      // 顺序无实际变化不写库，避免无意义的重渲染
      if (nextOrder.length === names.length && nextOrder.every((n, i) => n === names[i])) return;
      setManualOrder(dir, nextOrder);
      // 排序激活时发生同目录拖拽 → 自动退出该根的排序（D4：不打断用户操作）
      const root = findFolderRootOf(dir);
      const settings = useSettingsStore.getState();
      if (settings.fileTreeSort[root.replace(/\\/g, "/")]) {
        settings.setFileTreeSort(root, null);
        showMessage(t("filetree.switchedToManual"));
      }
      // UI 立即生效：目录缓存按新手动顺序重排（排序已退出，直接走 applyManualOrder）
      setChildrenMap((prev) => {
        const cur = prev.get(cacheKey) ?? base;
        const next = new Map(prev);
        next.set(cacheKey, applyManualOrder(sortTree(cur), nextOrder));
        return next;
      });
    },
    // findDirNodesInStore / findFolderRootOf 为每次渲染重建的普通函数（项目惯例不入依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [childrenMap, t],
  );

  /**
   * 拖拽 onReorder 落点处理（fileDragMouse 三分流回调）：
   * 由松手坐标命中目标行计算插入位置，再交给 handleReorder。
   * S12：「打开的文件」面板条目与树内节点共用（面板条目落在源所在目录同样重排）。
   */
  const handleDragReorder = useCallback(
    (payload: FileDragPayload, ev: MouseEvent) => {
      const hit =
        typeof document !== "undefined" && typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(ev.clientX, ev.clientY)
          : null;
      const { targetName, place } = resolveInsertPlace(hit, ev.clientY, payload.name);
      handleReorder(getParentDirOf(payload.path), payload.name, targetName, place);
    },
    [handleReorder],
  );

  // v0.8.0 修复 P3：拖拽源启动（自制鼠标拖拽）——默认复制，按住 Shift 移动
  const handleFileDragStart = useCallback(
    (node: FileNodeData, e: React.MouseEvent) => {
      // v0.8.4 需求3 修复：canDrop 准入谓词**只对目录源注入**。
      // isDescendantDir 的语义是「srcPath 是目录，targetDir 是否为其自身或后代」，
      // 对文件源套用会在"同目录重排"（targetDir 为文件的父目录）场景产生误判（误判为自嵌套）。
      // 文件源不注入 canDrop（等价恒真），落点一律放行，交由 resolveDropAction 判断重排/传输。
      const handlers = node.isDir
        ? { canDrop: (targetDir: string) => canDropIntoTarget(node.path, true, targetDir) }
        : {};
      beginFileDrag({ path: node.path, name: node.name }, e, {
        ...handlers,
        // srcIsDir 供 transferTo 的自嵌套守卫按源类型分流（文件源不再误判）
        onDrop: (payload, targetDir, mode) =>
          void transferTo(payload.path, targetDir, mode, { srcIsDir: node.isDir }),
        // v0.8.4 需求3：落在源所在目录 → 同目录重排
        onReorder: handleDragReorder,
      });
    },
    [transferTo, handleDragReorder],
  );

  // v0.8.0 修复 P3：接收标签栏拖拽的落点（跨组件用事件解耦，避免把 transferTo 提升到 App）
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.srcPath || !d?.targetDir) return;
      void transferTo(d.srcPath, d.targetDir, d.mode === "move" ? "move" : "copy");
    };
    window.addEventListener("lightmd:fileDrop", handler);
    return () => window.removeEventListener("lightmd:fileDrop", handler);
  }, [transferTo]);

  // Ctrl+C 复制选中项；Ctrl+V 粘贴到点选的文件夹
  // （目标解析见 utils/fileClipboard.resolvePasteTargetDir，优先级：点选 > 当前文件所在目录 > 首个文件夹）
  const currentPasteTarget = useCallback(
    (): string =>
      resolvePasteTargetDir(pasteTargetDir, activePath, openFolders.map((f) => f.path)),
    [pasteTargetDir, activePath, openFolders],
  );

  // v0.8.0 修复 P1-6：文件复制/粘贴快捷键的作用域门控（仅悬停侧栏时生效）
  const sidebarHoverRef = useRef(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 焦点在编辑器/输入框时不拦截（与 Delete 快捷键同一守卫）
      if (isFocusInEditable(document.activeElement)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      // v0.8.0 修复 P1-5：Ctrl+Alt+V 是版本快照快捷键，不能触发文件粘贴
      if (e.altKey) return;
      // v0.8.0 修复 P1-6：仅鼠标悬停在侧栏内时才接管文件级 Ctrl+C/V，
      // 避免全局劫持文本复制、避免在不知情时向文件夹复制文件
      if (!sidebarHoverRef.current) return;
      const key = e.key.toLowerCase();

      if (key === "c") {
        const selected = selectedTempIdx >= 0 ? tempFiles[selectedTempIdx] : undefined;
        const src = selected?.path || activePath || "";
        if (!src) return;
        e.preventDefault();
        const name = src.split(/[\\/]/).pop() || src;
        setClipboard({ path: src, name });
        showMessage(t("filetree.copied", { name }));
        return;
      }

      if (key === "v") {
        const clip = getClipboard();
        if (!clip) return;
        const targetDir = currentPasteTarget();
        if (!targetDir) return;
        e.preventDefault();
        // v0.8.0 修复 P13-1：剪贴板为"剪切"时粘贴 = 移动
        // v0.8.4 需求3 修复：srcIsDir 取自剪贴板（目录源才判自嵌套）
        void transferTo(clip.path, targetDir, clipboardTransferMode(clip), {
          isClipboardPaste: true,
          srcIsDir: clip.isDir === true,
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedTempIdx, tempFiles, activePath, currentPasteTarget, transferTo, t]);

  // v0.8.0 WP2 任务2.5：标签栏重命名文件后刷新侧栏文件树（否则树中仍是旧名）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.newPath) return;
      void refreshTree();
    };
    window.addEventListener("lightmd:fileRenamed", handler);
    return () => window.removeEventListener("lightmd:fileRenamed", handler);
  }, [refreshTree]);

  // ─── Ctrl+R 刷新文件树 ────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        refreshTree();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshTree]);

  // ─── 渲染 ────────────────────────────────────

  // ─── v0.8.2：「打开的文件」条目滑入/滑出动画（渲染层 diff） ──────────
  // 条目关闭的路径很多（侧栏 ×、标签栏、Ctrl+W、批量关闭、文件删除联动），
  // 全部表现为 openTabs/tempFiles 数据变化——因此在渲染层 diff 前后两帧的条目集，
  // 消失的条目用关闭前一帧的快照补渲染滑出动画（水平滑出 + 高度收起），
  // 不侵入任何业务关闭路径。重命名（path 变化）也会呈现旧条目滑出、新条目滑入。
  const prevItemsRef = useRef<Map<string, React.ReactNode>>(new Map());
  /**
   * v0.8.2 动画优化：**上一个"条目集合发生变化"的帧**的条目顺序
   * （关闭前那一帧的完整列表顺序）。
   *
   * 关闭中间一条时，滑出块必须留在它原来的位置，下方条目才会"上移补位"。
   * 该顺序仅在条目集合变化或顺序变化时更新，因此"关闭前的位置"始终可查。
   */
  const mergedOrderRef = useRef<string[]>([]);
  /**
   * v0.8.2 动画优化：上一次渲染的**文件夹栏顺序**（含正在播放滑出动画的栏）。
   * 关闭中间那一栏时，用它定位滑出快照的原位置（下方栏上移补位）。
   */
  const folderOrderRef = useRef<string[]>([]);
  const [closingItems, setClosingItems] = useState<
    Array<{ key: string; el: React.ReactNode; slot: number }>
  >([]);

  /**
   * v0.8.2 需求：**新打开的**条目排在最上方。
   *
   * 用"最近打开顺序表"实现（而不是渲染计数器），保证**幂等**：
   * 同一份输入在同一帧内被计算多次，结果完全一致（否则一次渲染里
   * 重复调用会把序号累加，导致顺序忽前忽后）。
   *
   * v0.8.2 调整：**只有"新打开"才置顶**——在「打开的文件」栏里点击切换
   * 到另一个已打开的文件，不应把该条目重新提到第一位（用户明确要求），
   * 因此这里不再跟随 activeItemKey。
   *
   * - 本帧首次出现的条目（新打开的文件）插到最前；
   * - 其余条目保持上一次的相对顺序；
   * - 已关闭的条目顺带从表中清除，避免长会话下无界增长。
   */
  const recentOrderRef = useRef<string[]>([]);
  const orderKeysByRecency = (keys: string[]): string[] => {
    const present = new Set(keys);
    // 上一次的顺序里仍存在的键（保持相对顺序 = 稳定）
    const kept = recentOrderRef.current.filter((k) => present.has(k));
    const keptSet = new Set(kept);
    // 本帧首次出现的键（新打开），按传入顺序视为"刚打开" → 插到最前
    const fresh = keys.filter((k) => !keptSet.has(k));
    const next = [...fresh, ...kept];
    recentOrderRef.current = next;
    // 按"最近打开顺序"给条目排名（越前越新）
    const rank = new Map(next.map((k, i) => [k, next.length - i]));
    return [...keys].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0));
  };

  /** 统一构造「打开的文件」条目（key + element），供渲染与滑出 diff 共用 */
  const buildTempItems = (): Array<{ key: string; el: React.ReactNode }> => {
    const items: Array<{ key: string; el: React.ReactNode }> = [];
    // v0.8.2：两类条目合并后按"最近使用"排序（最新打开/切换者置顶），
    // 再按最终顺序构造条目 —— 这样条目顺序即渲染顺序，无需二次排序。
    const untitledKeys = untitledTabs.map(({ tab, idx }) => `untitled-${tab.id ?? idx}`);
    const recencyRank = new Map(
      orderKeysByRecency([
        ...untitledKeys,
        ...tempFiles.map((f) => `temp-${f.path}`),
      ]).map((k, i) => [k, i]),
    );
    // 真实文件按"最近使用"重排：**保留其在 tempFiles 中的原始下标**，
    // 因为 selectedTempIdx（Delete/Ctrl+2 关闭目标、右键菜单）仍以 tempFiles 为索引。
    const orderedTempEntries = tempFiles
      .map((file, idx) => ({ file, idx }))
      .sort(
        (a, b) =>
          (recencyRank.get(`temp-${a.file.path}`) ?? 0) -
          (recencyRank.get(`temp-${b.file.path}`) ?? 0),
      );
    // v0.8.0 WP1：临时（未落盘）标签 —— 无磁盘路径，点击切换、× 关闭
    untitledTabs.forEach(({ tab, idx }) => {
      // v0.8.2：统一按条目 key 判定激活（与真实文件条目同一套标准）
      const itemKey = `untitled-${tab.id ?? idx}`;
      const isActive = itemKey === activeItemKey;
      items.push({
        key: itemKey,
        el: (
          <div
            key={itemKey}
            className={`filetree-node filetree-temp-node filetree-untitled-node ${isActive ? "active" : ""}`}
            style={{ paddingLeft: "8px" }}
            onClick={() => {
              // v0.8.3 需求2：未落盘条目不可作为 Delete/Ctrl+2 的关闭目标，
              // 置空点击来源键 → 激活变化时清空栏内键盘选中（避免残留的
              // selected 指示线停留在旧的真实文件条目上）。
              sidebarClickKeyRef.current = null;
              window.dispatchEvent(
                new CustomEvent("lightmd:command", { detail: { id: "tab.activate", index: idx } }),
              );
            }}
            title={t("filetree.untitledHint")}
          >
            <span className="filetree-icon">
              {/* v0.8.5 反馈7：图标改为打开的小书本（未落盘临时文件 = 黄色） */}
              <OpenBookIcon color="#e0a458" />
            </span>
            <span className="filetree-name">{tab.name}</span>
            {tab.isDirty ? <span className="filetree-untitled-dirty">●</span> : null}
            <button
              className="filetree-temp-close"
              title={t("filetree.closeTitle")}
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent("lightmd:command", { detail: { id: "tab.close", index: idx } }),
                );
              }}
            >
              ×
            </button>
          </div>
        ),
      });
    });
    // 未挂载到打开文件夹的真实文件（v0.8.2 起 = 所有已打开的真实文件标签）
    // 按"最近使用优先"的顺序渲染；idx 仍是 tempFiles 中的原始下标
    orderedTempEntries.forEach(({ file, idx }) => {
      // v0.8.2：统一按条目 key 判定激活，与未落盘标签同一套标准
      const itemKey = `temp-${file.path}`;
      const isActive = itemKey === activeItemKey;
      const isSelected = selectedTempIdx === idx;
      const isRenaming = tempRenamingPath === file.path;
      items.push({
        key: itemKey,
        el: (
          <div
            key={itemKey}
            className={`filetree-node filetree-temp-node ${isActive ? "active" : ""} ${isSelected ? "selected" : ""}`}
            style={{ paddingLeft: "8px" }}
            onClick={() => {
              // v0.8.3 需求2：记录"本次激活由栏内点击产生"的来源键，
              // 使键盘选中项（selectedTempIdx）在本次激活下不被清空
              sidebarClickKeyRef.current = itemKey;
              handleSelectFile({ ...file, children: [] });
              setSelectedTempIdx(idx);
            }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTempContextMenu({ x: e.clientX, y: e.clientY, file }); }}
            // v0.8.0 修复 P3：自制鼠标拖拽（默认复制 / 按住 Shift 移动）
            // v0.8.4 需求3（S12）：面板条目落在源文件所在目录 → 同目录重排（预期行为，
            // 与树内节点一致）；目录不属于任何已打开文件夹时 handleReorder 自动 no-op
            onMouseDown={(e) => {
              beginFileDrag({ path: file.path, name: file.name }, e, {
                onDrop: (payload, targetDir, mode) =>
                  void transferTo(payload.path, targetDir, mode),
                onReorder: handleDragReorder,
              });
            }}
            title={file.path}
          >
            <span className="filetree-icon">
              {/* v0.8.5 反馈7：图标改为打开的小书本（真实文件 = 蓝色） */}
              <OpenBookIcon color="#5c9dff" />
            </span>
            {isRenaming ? (
              <input
                ref={tempRenameInputRef}
                className="filetree-rename-input"
                value={tempRenameValue}
                onChange={(e) => setTempRenameValue(e.target.value)}
                onBlur={() => handleTempRenameConfirm(file)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTempRenameConfirm(file);
                  if (e.key === "Escape") setTempRenamingPath(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="filetree-name">{file.name}</span>
            )}
            {/* 关闭按钮 */}
            <button
              className="filetree-temp-close"
              title={t("filetree.closeTitle")}
              onClick={(e) => { e.stopPropagation(); closeTempFile(file); }}
            >
              ×
            </button>
          </div>
        ),
      });
    });
    return items;
  };
  const tempItems = buildTempItems();
  const tempItemKeys = new Set(tempItems.map((it) => it.key));

  // 前后两帧条目 diff（useLayoutEffect：paint 前补上滑出快照，避免关闭瞬间闪一帧空白）。
  // 无依赖数组：每次渲染后 diff（条目列表小，开销可忽略）；diff 无变化时不会触发重渲染。
  useLayoutEffect(() => {
    const current = new Map(tempItems.map((it) => [it.key, it.el]));
    const curOrder = tempItems.map((it) => it.key);
    const prev = prevItemsRef.current;
    const gone: string[] = [];
    prev.forEach((_el, k) => {
      if (!current.has(k)) gone.push(k);
    });
    if (gone.length > 0) {
      // 关闭块的原位置（槽位）＝ 在"关闭前那一帧的完整顺序"里排在它前面的存活条目个数；
      // 槽位 k 表示"渲染 k 个存活条目之后"，与下方合并循环一致。
      const slots = buildClosingSlotPositions(mergedOrderRef.current, new Set(curOrder));
      setClosingItems((ci) => [
        // 保留仍在播放且未与当前条目重叠的（快速关闭+重开同一文件时去重）
        ...ci.filter((x) => !current.has(x.key) && !gone.includes(x.key)),
        ...gone.map((k) => ({ key: k, el: prev.get(k)!, slot: slots.get(k) ?? 0 })),
      ]);
      for (const k of gone) {
        // 串行三拍（水平滑出 → 停顿 → 高度收起）播完后移除
        window.setTimeout(() => {
          setClosingItems((ci) => ci.filter((x) => x.key !== k));
        }, ITEM_OUT_TOTAL_MS);
      }
    }
    prevItemsRef.current = current;
    // 顺序基准：仅在"条目集合变化"或"顺序确实变了"时更新。
    // 关闭中的条目此时已不在 current 里 —— 保留旧顺序，其原位置才可还原；
    // 若本帧只是顺序变化（如最近使用置顶），则以新顺序为下一帧基准。
    const orderChanged =
      curOrder.length !== mergedOrderRef.current.length ||
      curOrder.some((k, i) => k !== mergedOrderRef.current[i]);
    if (gone.length === 0 || orderChanged) {
      mergedOrderRef.current = curOrder;
    }
  });

  // v0.4.5 修复：提取 tempFiles 栏渲染为函数，避免在两个位置（顶部/底部）重复 JSX
  // 根据 openFolders 状态决定渲染位置：
  // - 不打开文件夹：渲染在顶部（FolderSection 之前）
  // - 打开文件夹：渲染在 FolderSection 之后
  const renderTempFilesSection = (): React.ReactNode => {
    // v0.8.0 WP1：面板同时承载"临时标签（未落盘）"与"未挂载到打开文件夹的真实文件"
    if (tempFiles.length === 0 && untitledTabs.length === 0) return null;
    // v0.8.0 修复 P9-1：temp 区标题栏拖动改变「上方邻区 + temp」的高度分配
    // v0.8.2 功能4：temp 是第一个可见区域时改拖「temp + 下方邻区」
    const tempPrevKey = prevOf("temp");
    const tempNextKey = nextOf("temp");
    // v0.8.2 功能1：折叠/最大化状态下的高度（折叠 = 高度自适应，最大化 = 固定 500px）
    const tempSectionStyle: React.CSSProperties = {};
    if (tempMaximized) {
      tempSectionStyle.height = 500;
    } else if (tempCollapsed) {
      // 折叠：高度自适应标题栏
    } else {
      // v0.9.5 问题6 修订：temp 恢复 sizeOf 固定分区高度。收藏/最近打开展开时
      // 的收缩由下方显式收缩 effect 写入 sizeOf("temp") 完成——temp 显示值与
      // 分区系统一致,保证 temp-favorites 之间的分隔条拖拽跟手
      tempSectionStyle.height = sizeOf("temp");
    }
    return (
      <>
        <div
          className={`filetree-temp-section ${tempCollapsed ? "collapsed" : ""} ${tempMaximized ? "maximized" : ""}`}
          style={tempSectionStyle}
          data-section-key="temp"
        >
          {/* 标题栏绑定相邻配对拖拽：有上方邻区拖「上区+temp」（标题栏随之上/下移动）；
              v0.8.2 功能4：无上方邻区时拖「temp+下区」（往下拖 temp 变高） */}
          <div
            className="filetree-temp-header"
            onMouseDown={(e) => {
              // v0.8.2 功能2：折叠/放大时标题栏不触发拖拽——
              // 折叠时高度被 CSS !important 固定；放大时高度固定 500px，
              // 两种状态下拖拽都会"显示没反应但内部高度被改"，故统一禁用
              if (tempCollapsed || tempMaximized) return;
              if (tempPrevKey) {
                // v0.8.0 修复 P11-4 / P12-4/5：temp 是最后一个可见区域时可一直拖到底部
                const maxBottom = maxBottomFor(tempPrevKey, "temp");
                beginSectionDrag(
                  tempPrevKey,
                  "temp",
                  () => ({ top: sizeOf(tempPrevKey), bottom: sizeOf("temp") }),
                  setPair,
                  MIN_SECTION_HEIGHT,
                  e,
                  undefined,
                  undefined,
                  maxBottom !== undefined ? { maxBottom } : undefined,
                );
              } else if (tempNextKey) {
                beginSectionDrag(
                  "temp",
                  tempNextKey,
                  () => ({ top: sizeOf("temp"), bottom: sizeOf(tempNextKey) }),
                  setPair,
                  MIN_SECTION_HEIGHT,
                  e,
                );
              }
            }}
            // v0.8.2 功能2：双击标题栏切换缩小/放大
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              setTempCollapsed((c) => !c);
              setTempMaximized(false);
            }}
          >
            <div className="filetree-temp-header-left">
              <span className="filetree-title">{t("filetree.openedFiles")}</span>
              {/* Issue 5：查看版本快照按钮入口（临时文件也支持快照功能）
                  v0.8.2 调整：快照图标紧跟「打开的文件」标题右侧 */}
              <button
                className="filetree-btn filetree-temp-snapshot-btn"
                title={t("snapshot.viewSnapshots")}
                onClick={(e) => {
                  e.stopPropagation();
                  // 优先使用当前活跃文件路径，否则用第一个临时文件路径
                  const targetPath = activePath || tempFiles[0]?.path;
                  if (targetPath) {
                    window.dispatchEvent(new CustomEvent("lightmd:showSnapshotDialog", { detail: { filePath: targetPath } }));
                  }
                }}
              >
                {/* Issue 5 修复：更换为相机/快照图标，避免与"最近打开"的时钟图标重复 */}
                <svg width="14" height="14" viewBox="0 0 16 16">
                  <path d="M5 3h6l1 2h2v8H2V5h2z" fill="none" stroke="currentColor" strokeWidth="1.2"/>
                  <circle cx="8" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
              </button>
            </div>
            <div className="section-controls">
              <button
                className="section-btn section-minimize"
                title={t("filetree.minimize")}
                onClick={(e) => { e.stopPropagation(); setTempCollapsed((c) => !c); setTempMaximized(false); }}
              >
                ▾
              </button>
              <button
                className="section-btn section-maximize"
                title={t("filetree.maximize")}
                onClick={(e) => { e.stopPropagation(); setTempMaximized((m) => !m); setTempCollapsed(false); }}
              >
                ▴
              </button>
            </div>
          </div>
          {/* v0.4.1：临时文件列表独立滚动容器 */}
          <div className="filetree-temp-content">
            {/* v0.8.2：条目渲染统一由 buildTempItems 构造（mount 时播放滑入动画）；
                刚关闭的条目按其**原位置**插回列表，下方条目先平滑上移补位 */}
            {(() => {
              const alive = closingItems.filter((c) => !tempItemKeys.has(c.key));
              // 按检测关闭时就记录好的原位置（slot）插回列表：
              // slot = 在"变更前顺序"里排在它前面的存活条目个数。
              const merged: React.ReactNode[] = [];
              for (let i = 0; i <= tempItems.length; i++) {
                for (const c of alive) {
                  if (c.slot === i) {
                    merged.push(
                      <ItemSlideOut key={`out-${c.key}`}>{c.el}</ItemSlideOut>,
                    );
                  }
                }
                if (i < tempItems.length) merged.push(tempItems[i].el);
              }
              return merged;
            })()}
          </div>
        </div>
      </>
    );
  };

  // v0.8.2 功能3/4：文件夹 section 统一渲染（正常 / 滑出动画快照两种模式）。
  // - 正常：Fragment[resizer + 滑入动画 wrapper + FolderSection]；
  // - closing：数据已出 store，无配对/分隔条，仅保留一帧滑出动画。
  const renderFolderSection = (
    folder: { path: string; name: string },
    nodes: FileNodeData[],
    opts?: { closing?: boolean },
  ): React.ReactNode => {
    const fkey = `folder:${folder.path}`;
    const section = (
      <FolderSection
        folder={folder}
        nodes={nodes}
        activePath={activePath}
        renamingPath={renamingPath}
        expandedPaths={expandedPaths}
        onSelect={handleSelectFile}
        onToggleExpand={toggleExpand}
        onRenameStart={handleRenameStart}
        onRenameConfirm={handleRenameConfirm}
        onRenameCancel={handleRenameCancel}
        onDelete={handleDelete}
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onCopyNode={handleCopyNode}
        onCutNode={handleCutNode}
        // v0.8.4 反馈1：节点右键"粘贴"（仅文件夹节点）——以右键目标路径为落点，复用同一粘贴链路
        onPasteInto={handlePasteIntoDir}
        onFileDragStart={handleFileDragStart}
        onRefresh={refreshTree}
        onClose={opts?.closing ? () => {} : closeFolder}
        // v0.8.4 需求7：标题栏排序 —— 读本文件夹根的记忆模式，写回走 setFileTreeSort；
        // 排序变化经 fileTreeSort 订阅 → sortChildren 重算 → 渲染层自动生效，无需手动刷新
        sortMode={fileTreeSort[folder.path.replace(/\\/g, "/")] ?? null}
        onSortChange={(mode) => {
          setFileTreeSort(folder.path, mode);
          // 取消排序（再次点击激活项）时 toast 反馈；激活新模式无需提示（按钮徽标即反馈）
          if (!mode) showMessage(t("filetree.sortCancelled"));
        }}
        onOpenWorkspace={handleOpenWorkspace}
        onActivateFolder={setPasteTargetDir}
        onFolderContextMenu={(dir, x, y, nativeEvent) => {
          setPasteTargetDir(dir);
          // v0.8.4 反馈1：记住本次打开事件（供 window 关闭监听跳过，见 folderCtxOpenEventRef 注释）
          folderCtxOpenEventRef.current = nativeEvent ?? null;
          setFolderCtxMenu({ x, y, dir });
        }}
        height={sizeOf(fkey)}
        sectionKey={fkey}
        prevSectionKey={opts?.closing ? undefined : prevOf(fkey)}
        nextSectionKey={opts?.closing ? undefined : nextOf(fkey)}
        maxHeight={opts?.closing ? undefined : maxBottomFor(prevOf(fkey), fkey)}
        childrenByPath={childrenMap}
        childrenWrap={treeChildrenWrap}
      />
    );
    if (opts?.closing) {
      // v0.8.2 动画优化：关闭快照经 SlideOutWrap 播放"高度收起 + 水平滑出"，
      // 下方栏平滑地顶上来
      return (
        <SlideOutWrap key={`closing-${folder.path}`}>{section}</SlideOutWrap>
      );
    }
    return (
      <Fragment key={folder.path}>
        {prevOf(fkey) && (
          <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf(fkey)!, fkey)} />
        )}
        {/* v0.8.2 动画优化：SlideInWrap 挂载时 0→内容高展开，下方栏被平滑推下去 */}
        <SlideInWrap>{section}</SlideInWrap>
      </Fragment>
    );
  };

  return (
    <div
      ref={rootRef}
      className="filetree"
      // v0.8.0 修复 P1-6：Ctrl+C/V 文件复制粘贴仅在鼠标悬停侧栏时接管，
      // 不再全局劫持（配合下方 keydown 里的 sidebarHoverRef 门控）
      onMouseEnter={() => { sidebarHoverRef.current = true; }}
      onMouseLeave={() => { sidebarHoverRef.current = false; }}
    >
      {/* 头部工具栏 */}
      <div className="filetree-header">
        <span className="filetree-title">{t("filetree.title")}</span>
        <div className="filetree-actions">
          {/* v0.8.0 修复 P4-1：工具栏"新增文件"改为立即新建临时（未落盘）文件，
              不再固定落到第一个打开的文件夹；保存时才由用户选择路径与命名。
              复用 App 的 file.new 命令（与 Ctrl+N 同一路径，保证编辑器上下文同步） */}
          <button
            className="filetree-btn"
            title={t("filetree.newFileTitle")}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "file.new" } }));
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M9.5 1.1l3.4 3.5.1.4v4h-1V6H8V2H3v12h5v1H2.5l-.5-.5v-13l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2z" fill="#5c9dff"/><path d="M14 8v2h2v1h-2v2h-1v-2h-2v-1h2V8h1z" fill="#4caf50"/></svg>
          </button>
          {/* v0.4.1：新建文件夹图标重设计——蓝色文件夹 + 绿色加号（右下角叠加） */}
          <button className="filetree-btn" title={t("filetree.newFolderTitle")} onClick={() => handleNewFolder(rootPath || "")}>
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M1.5 2h4.3l1 1H14.5l.5.5v9l-.5.5h-13l-.5-.5v-10l.5-.5z" fill="#42a5f5"/>
              <path d="M2 3v8h12V4H6.7l-1-1H2z" fill="#90caf9"/>
              <path d="M10 9v2h2v1h-2v2H9v-2H7v-1h2V9z" fill="#4caf50"/>
            </svg>
          </button>
          {/* v0.4.1：打开文件夹图标重设计——橙色文件夹 + 放大镜（区别于新建文件夹） */}
          <button className="filetree-btn" title={t("filetree.openFolderTitle")} onClick={openFolder}>
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M1.5 2h4.3l1 1H14.5l.5.5v9l-.5.5h-13l-.5-.5v-10l.5-.5z" fill="#ff9800"/>
              <path d="M2 3v8h12V4H6.7l-1-1H2z" fill="#ffb74d"/>
              <circle cx="10" cy="9" r="2" fill="none" stroke="#e65100" strokeWidth="1.2"/>
              <path d="M11.5 10.5l1.8 1.8" stroke="#e65100" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
            </svg>
          </button>
          {/* v0.8.5 需求1：移除工具栏全局刷新按钮（v0.8.4 需求10 的兜底入口）。
              刷新入口保留：搜索按钮右侧不设刷新、空白右键菜单「刷新」、Ctrl+R、
              FileNode 文件夹右键「刷新」，且 watch 实时刷新兜底 */}
          {/* v0.4.3 Issue 2：全局文件搜索按钮
              v0.8.5 需求4：toggle 改走 openSearchPanel/closeSearchPanel——
              收回动画进行中再点 = 取消收回重新展开 */}
          <button
            className={`filetree-btn ${showSearch ? "active" : ""}`}
            title={t("filetree.searchTitle")}
            onClick={() => {
              if (showSearch && !searchClosing) closeSearchPanel();
              else openSearchPanel();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke={showSearch ? "#5c9dff" : "#888"} strokeWidth="1.5"/><path d="M10.5 10.5l3 3" stroke={showSearch ? "#5c9dff" : "#888"} strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
          {/* v0.4.1：收藏/最近区域 toggle 按钮（点击切换显示，再点关闭） */}
          <button
            className={`filetree-btn ${showFavorites ? "active" : ""}`}
            title={t("filetree.favoritesToggle")}
            onClick={() => setShowFavorites((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 1l2.2 4.5 5 .7-3.6 3.5.9 5L8 12.8 3.5 14.7l.9-5L.8 6.2l5-.7z" fill={showFavorites ? "#ffa726" : "#888"}/></svg>
          </button>
          <button
            className={`filetree-btn ${showRecent ? "active" : ""}`}
            title={t("filetree.recentToggle")}
            onClick={() => setShowRecent((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke={showRecent ? "#5c9dff" : "#888"} strokeWidth="1.5"/><path d="M8 4v4l3 2" fill="none" stroke={showRecent ? "#5c9dff" : "#888"} strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      {/* v0.4.3 Issue 2：全局文件搜索面板
          v0.8.5 需求4：挂载即播展开动画（search-panel-open），关闭先播收回动画
          （search-panel-closing，收回期间 pointer-events:none 防误交互），
          动画播完才由 closeSearchPanel 延迟卸载 */}
      {showSearch && (
        <div
          className={`filetree-search-panel ${
            searchClosing ? "search-panel-closing" : "search-panel-open"
          }`}
        >
          <div className="filetree-search-box">
            <input
              ref={searchInputRef}
              type="text"
              className="filetree-search-input"
              placeholder={t("filetree.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              // v0.8.5 需求4：Esc 关闭改走 closeSearchPanel（先播收回动画再延迟卸载）
              onKeyDown={(e) => { if (e.key === "Escape") closeSearchPanel(); }}
            />
            {searchQuery && (
              <button className="filetree-search-clear" onClick={() => setSearchQuery("")}>✕</button>
            )}
          </div>
          {searchQuery && searchResults.length > 0 && (
            <div className="filetree-search-results">
              {searchResults.map((result) => (
                <div
                  key={result.path}
                  className={`filetree-search-result ${result.path === activePath ? "active" : ""}`}
                  onClick={() => handleSearchResultClick(result)}
                >
                  <span className="filetree-search-result-name">{result.name}</span>
                  <span className="filetree-search-result-path">{result.path}</span>
                </div>
              ))}
            </div>
          )}
          {searchQuery && searchResults.length === 0 && (
            <div className="filetree-search-empty">{t("filetree.searchNoResult")}</div>
          )}
        </div>
      )}

      

      {/* v0.8.0 WP2 需求4(2)：新建文件夹弹框（多选目标文件夹 / 自定义路径） */}
      <NewFolderDialog
        open={showNewFolderDialog}
        openFolders={newFolderTargets}
        preselected={newFolderPreselected}
        onBrowse={async () => {
          try {
            const picked = await dialogOpen({ directory: true, multiple: false });
            return typeof picked === "string" ? picked : null;
          } catch {
            return null;
          }
        }}
        onClose={() => setShowNewFolderDialog(false)}
        onConfirm={handleCreateFolder}
      />

      {/* v0.8.4 需求5+9（WP5）：新建文件弹框（parentPath 只读展示，默认名已避让重名） */}
      <NewFileDialog
        open={!!newFileDialog}
        parentPath={newFileDialog?.parentPath ?? ""}
        defaultName={newFileDialog?.defaultName ?? ""}
        onClose={() => setNewFileDialog(null)}
        onConfirm={handleCreateFileConfirm}
      />

      {/* v0.8.1 需求3：文件属性对话框（替代原生 alert，无系统提示音） */}
      <FilePropertiesDialog file={propFile} onClose={() => setPropFile(null)} />

      <SectionSizeContext.Provider value={sectionSplitCtx}>
        <div className="filetree-scroll" ref={scrollRef}>
          {/* v0.4.5 修复：左侧栏「打开的文件」和「文档」栏显示位置逻辑（见 WP4 施工图）
              v0.8.2 功能3：SlideWrap 提供"从左侧滑入/滑向左侧消失"动画（关闭时延迟卸载） */}
          <SlideWrap visible={openFolders.length === 0 && tempVisible}>
            {prevOf("temp") && (
              <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("temp")!, "temp")} />
            )}
            {renderTempFilesSection()}
          </SlideWrap>

          {/* Issue 1 修复：每个文件夹独立浏览区域，含放大缩小按钮，支持上下拖拽调整高度
              v0.8.2 功能3：正常渲染走 renderFolderSection（滑入动画）；
              closingFolders 为刚关闭的文件夹快照（滑出动画，动画结束自动清除）。
              v0.8.2 动画优化：关闭快照按**原位置**插回列表——关闭中间那一栏时，
              它留在原位滑出、下方栏平滑上移补位；若统一追加到末尾，
              视觉上会变成"底部凭空滑出一条"。 */}
          {(() => {
            const closingSnapshots = closingFolders.map((c) => ({
              closing: true as const,
              folder: c.folder,
              nodes: c.nodes,
            }));
            const liveSections = treeDataByFolder.map((c) => ({
              closing: false as const,
              folder: c.folder,
              nodes: c.nodes,
            }));
            // 关闭快照的原位置：
            // 用"上一次渲染的文件夹栏顺序"当坐标源（它同时含存活栏与刚关闭的栏），
            // 取该栏在其中的下标，再扣掉排在他前面的关闭中栏个数
            // （它们在同一帧各占一个插入槽位）→ 即渲染期合并循环的插入槽位。
            // 若本帧顺序已被其它操作改写（坐标源与当前存活顺序不一致），
            // 则退回"按存活栏切槽"的近似解，避免位置错乱。
            const aliveSet = new Set(treeDataByFolder.map((x) => x.folder.path));
            const prevCols = folderOrderRef.current;
            const prevAlive = prevCols.filter((p) => aliveSet.has(p));
            const curCols = treeDataByFolder.map((x) => x.folder.path);
            const prevUsable =
              prevAlive.length === curCols.length &&
              prevAlive.every((p, i) => p === curCols[i]);
            const sourceOrder = prevUsable
              ? prevCols
              : [
                  ...closingFolders.map((c) => c.folder.path),
                  ...curCols,
                ];
            const insertAt = buildClosingSlotPositions(sourceOrder, aliveSet);
            folderOrderRef.current = sourceOrder.filter(
              (p) => aliveSet.has(p) || closingFolders.some((c) => c.folder.path === p),
            );
            const merged = [];
            const mergedKeys: string[] = [];
            for (let i = 0; i <= liveSections.length; i++) {
              for (const c of closingSnapshots) {
                if (insertAt.get(c.folder.path) === i) {
                  merged.push(c);
                  mergedKeys.push(`closing:${c.folder.path}`);
                }
              }
              if (i < liveSections.length) {
                merged.push(liveSections[i]);
                mergedKeys.push(`live:${liveSections[i].folder.path}`);
              }
            }
            if (merged.length === 0) {
              /* v0.4.5 修复：不打文件夹且无 temp/未落盘标签时才显示 placeholder */
              return tempFiles.length === 0 && untitledTabs.length === 0 ? (
                <div className="filetree-list">
                  <div className="filetree-placeholder">
                    <p>{t("filetree.clickToOpen")}</p>
                    <p className="filetree-hint">{t("filetree.dragHint")}</p>
                  </div>
                </div>
              ) : null;
            }
            return merged.map((x, idx) => (
              <Fragment key={mergedKeys[idx]}>
                {renderFolderSection(x.folder, x.nodes, { closing: x.closing })}
              </Fragment>
            ));
          })()}

          {/* v0.4.5 修复：打开文件夹后，tempFiles 栏渲染在 FolderSection 之后 */}
          <SlideWrap visible={openFolders.length > 0 && tempVisible}>
            {prevOf("temp") && (
              <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("temp")!, "temp")} />
            )}
            {renderTempFilesSection()}
          </SlideWrap>

      {/* 临时文件右键菜单（fixed 定位，放在 filetree 容器中不影响布局） */}
      {tempContextMenu && (
        <div
          className="filetree-context-menu"
          style={{
            left: tempContextMenu.x,
            top: tempContextMenu.y,
            position: "fixed",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* G7：收藏切换项（已收藏显示"从收藏移除"，未收藏显示"添加到收藏"） */}
          {favorites.some((f) => f.path === tempContextMenu.file.path) ? (
            <button
              className="context-menu-item"
              onClick={() => {
                removeFavorite(tempContextMenu.file.path);
                setTempContextMenu(null);
              }}
            >
              {t("sidebar.removeFromFavorites")}
            </button>
          ) : (
            <button
              className="context-menu-item"
              onClick={() => {
                addFavorite({ path: tempContextMenu.file.path, name: tempContextMenu.file.name });
                setTempContextMenu(null);
              }}
            >
              {t("sidebar.addToFavorites")}
            </button>
          )}
          {/* v0.9.0 第三轮（需求1）：在新窗口中打开（与文件树右键同一命令，
              由 App 统一处理：新窗口打开该文件，本窗口标签保持不变） */}
          <button
            className="context-menu-item"
            data-testid="temp-open-in-new-window"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("lightmd:command", {
                  detail: { id: "filetree.openInNewWindow", path: tempContextMenu.file.path },
                }),
              );
              setTempContextMenu(null);
            }}
          >
            {t("multiwindow.openInNewWindow")}
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => {
              closeTempFile(tempContextMenu.file);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.closeFile")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              setTempRenamingPath(tempContextMenu.file.path);
              setTempRenameValue(tempContextMenu.file.name);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.rename")}
          </button>
          {/* v0.8.0 WP2 需求1：复制（配合 Ctrl+V 粘贴到任一打开的文件夹） */}
          <button
            className="context-menu-item"
            onClick={() => {
              setClipboard({ path: tempContextMenu.file.path, name: tempContextMenu.file.name });
              showMessage(t("filetree.copied", { name: tempContextMenu.file.name }));
              setTempContextMenu(null);
            }}
          >
            {t("filetree.copy")}
          </button>
          {/* v0.8.0 修复 P13-1：剪切（粘贴时移动原文件，成功后清空剪贴板） */}
          <button
            className="context-menu-item"
            onClick={() => {
              setClipboard({
                path: tempContextMenu.file.path,
                name: tempContextMenu.file.name,
                mode: "cut",
              });
              showMessage(t("filetree.cutted", { name: tempContextMenu.file.name }));
              setTempContextMenu(null);
            }}
          >
            {t("filetree.cut")}
          </button>
          {/* v0.4.1：查看版本快照（修复临时文件缺少入口的问题5） */}
          <button
            className="context-menu-item"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("lightmd:showSnapshotDialog", { detail: { filePath: tempContextMenu.file.path } }));
              setTempContextMenu(null);
            }}
          >
            {t("snapshot.viewSnapshots")}
          </button>
          {/* v0.8.0 WP2 需求6：在左侧栏打开该文件所在的文件夹工作区 */}
          <button
            className="context-menu-item"
            onClick={() => {
              handleOpenWorkspace(tempContextMenu.file.path);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.openWorkspace")}
          </button>
          {/* N5：在资源管理器中显示并选中该文件 */}
          <button
            className="context-menu-item"
            onClick={() => {
              fileService.revealInFolder(tempContextMenu.file.path).catch(() => {});
              setTempContextMenu(null);
            }}
          >
            {t("common.revealInFolder")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => {
              handleViewProperties(tempContextMenu.file);
              setTempContextMenu(null);
            }}
          >
            {t("filetree.viewProperties")}
          </button>
        </div>
      )}

      {/* v0.4.1：收藏区段（toggle 按钮控制显示，分隔条拖拽调整高度）
          v0.8.2 功能3：SlideWrap 滑入/滑出动画 */}
      <SlideWrap visible={showFavorites}>
        <>
          {prevOf("favorites") && (
            <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("favorites")!, "favorites")} />
          )}
          <Favorites
            onOpen={handleSelectFile}
            height={sizeOf("favorites")}
            sectionKey="favorites"
            prevSectionKey={prevOf("favorites")}
            nextSectionKey={nextOf("favorites")}
            maxHeight={maxBottomFor(prevOf("favorites"), "favorites")}
            onClose={() => setShowFavorites(false)}
            compact={favRecentCompact}
          />
        </>
      </SlideWrap>

      {/* v0.4.1：最近文件（toggle 按钮控制显示，分隔条拖拽调整高度）
          v0.8.2 功能3：SlideWrap 滑入/滑出动画 */}
      <SlideWrap visible={showRecent && recentFiles.length > 0}>
        <>
          {prevOf("recent") && (
            <div className="filetree-v-resizer" onMouseDown={resizerDrag(prevOf("recent")!, "recent")} />
          )}
          <RecentFiles
            onOpen={handleSelectFile}
            height={sizeOf("recent")}
            sectionKey="recent"
            prevSectionKey={prevOf("recent")}
            nextSectionKey={nextOf("recent")}
            maxHeight={maxBottomFor(prevOf("recent"), "recent")}
            onClose={() => setShowRecent(false)}
            compact={favRecentCompact}
          />
        </>
      </SlideWrap>
        </div>
        <SidebarScrollArrows scrollRef={scrollRef} />
      </SectionSizeContext.Provider>

      {/* v0.8.0 修复 P12-1：文件夹空白区右键菜单（粘贴；剪贴板为空时置灰）
          v0.8.4 需求8：扩为四项——新建文件 / 新建文件夹 / 刷新 / 粘贴，
          前三项均以右键所在目录（folderCtxMenu.dir）为操作目标 */}
      {folderCtxMenu && (
        <div
          className="filetree-context-menu"
          style={{ left: folderCtxMenu.x, top: folderCtxMenu.y, position: "fixed" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 新建文件：落点为本文件夹（现有 prompt 流程，后续 WP 将替换为居中弹窗） */}
          <button
            className="context-menu-item"
            onClick={() => {
              void handleNewFile(folderCtxMenu.dir);
              setFolderCtxMenu(null);
            }}
          >
            {t("titlebar.newFile")}
          </button>
          {/* 新建文件夹：NewFolderDialog 预选本文件夹 */}
          <button
            className="context-menu-item"
            onClick={() => {
              handleNewFolder(folderCtxMenu.dir);
              setFolderCtxMenu(null);
            }}
          >
            {t("titlebar.newFolder")}
          </button>
          {/* 刷新：需求10 的右键兜底入口（刷新本目录子树） */}
          <button
            className="context-menu-item"
            onClick={() => {
              void refreshTree(folderCtxMenu.dir);
              setFolderCtxMenu(null);
            }}
          >
            {t("filetree.refreshTitle")}
          </button>
          <button
            className="context-menu-item"
            // v0.8.4 反馈1：渲染期实时读取剪贴板（打开菜单必然触发一次渲染 → 必为最新值），
            // 不再用"打开菜单那一刻"的 canPaste 快照，避免复制后重开菜单仍旧置灰
            disabled={!hasClipboard()}
            title={hasClipboard() ? t("filetree.paste") : t("filetree.pasteEmpty")}
            onClick={() => {
              handlePasteIntoDir(folderCtxMenu.dir);
              setFolderCtxMenu(null);
            }}
          >
            {t("filetree.paste")}
          </button>
        </div>
      )}

      {/* v0.8.0 修复 P11-8：侧栏文件操作的浮动提示（贴侧栏右侧显示，fixed 不占布局） */}
      {toasts.length > 0 && (
        <div className="filetree-toast-stack" style={{ left: toastLeft }}>
          {toasts.map((item) => (
            <div
              key={item.id}
              className={`filetree-toast ${item.error ? "error" : ""}`}
            >
              {item.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Issue 1 修复：每个文件夹独立浏览区域子组件 ──────────
// useSectionSplit 是 hook，不能在 map 中调用，故提取为子组件

// ─── v0.8.4 需求7：排序按钮 / 下拉菜单的图标与常量 ──────────
/**
 * v0.8.4 反馈5：排序图标分组与尺寸（标题栏按钮激活态与下拉菜单项共用同一套值）。
 * - time 组（U=修改 / C=创建）：徽标是**单个大写字母**，箭头用短箭头，
 *   长度≈大写字高 → 箭头与字母对齐成一条水平线（见 CSS .sort-icon-time）。
 * - name 组（A-Z / Z-A 竖排）：徽标字母显示为**小写**（CSS text-transform），
 *   箭头改用 elongate 长箭头，长度≈竖排徽标总高 → 箭头与徽标柱视觉等高（见 .sort-icon-name）。
 * SVG 等比缩放（stroke 随之缩放），两组的"箭头缩短/拉长"仅由这里的尺寸差体现。
 */
export const SORT_ARROW_SIZE = { time: 9, name: 11 } as const;

/** 箭头语义（C2 拍板）：↑ = 升序（A-Z / 早-晚），↓ = 降序（Z-A / 晚-早） */
function SortArrowIcon({
  dir,
  size = 12,
  /** v0.8.4 反馈5：true = 长箭头（viewBox 16×28，用于名称组竖排徽标） */
  elongate = false,
}: {
  dir: "up" | "down";
  size?: number;
  elongate?: boolean;
}) {
  if (elongate) {
    // 长箭头：宽度仍为 size，高度 = size × 28/16（等比，故 stroke 同步缩放）
    const long = Math.round(size * 1.75);
    return (
      <svg
        className={`sort-arrow sort-arrow-${dir} sort-arrow-long`}
        width={size}
        height={long}
        viewBox="0 0 16 28"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {dir === "up"
          ? <path d="M8 26.5V1.5M4.2 5.3L8 1.5 11.8 5.3" />
          : <path d="M8 1.5v25M4.2 22.7L8 26.5 11.8 22.7" />}
      </svg>
    );
  }
  return (
    <svg
      className={`sort-arrow sort-arrow-${dir}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {dir === "up" ? <path d="M8 13.5V2.5M4.5 6L8 2.5 11.5 6" /> : <path d="M8 2.5v11M4.5 10L8 13.5 11.5 10" />}
    </svg>
  );
}

/** v0.8.4 反馈5：名称组（竖排 A-Z / Z-A）判定 —— 决定徽标是否小写、箭头是否拉长 */
function isNameSortMode(mode: SortMode): boolean {
  return mode === "name-asc" || mode === "name-desc";
}

/** 默认态图标：上下双箭头（↑↓ 竖排，提示"可排序"，当前未激活） */
function SortBothIcon() {
  return (
    <svg
      className="sort-arrow-both"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 7V1.5M5.8 3.7L8 1.5l2.2 2.2" />
      <path d="M8 9v5.5M5.8 12.3L8 14.5l2.2-2.2" />
    </svg>
  );
}

/** 竖排徽标（A-Z / Z-A / U / C）：逐字符 <span> 纵排，不用 writing-mode（兼容性最稳） */
function SortBadge({ label }: { label: string }) {
  return (
    <span className="sort-badge">
      {label.split("").map((ch, i) => (
        <span key={i}>{ch}</span>
      ))}
    </span>
  );
}

/** 排序下拉菜单 3 组 6 项（组间 divider；同组内 desc 在前，符合"晚-早/早-晚"文案顺序） */
const SORT_MENU_GROUPS: readonly SortMode[][] = [
  ["name-asc", "name-desc"],
  ["modified-desc", "modified-asc"],
  ["created-desc", "created-asc"],
];

/** 菜单项文案 i18n key（与 SortMode 一一对应） */
const SORT_MENU_KEYS: Record<SortMode, string> = {
  "name-asc": "filetree.sortNameAsc",
  "name-desc": "filetree.sortNameDesc",
  "modified-desc": "filetree.sortModifiedDesc",
  "modified-asc": "filetree.sortModifiedAsc",
  "created-desc": "filetree.sortCreatedDesc",
  "created-asc": "filetree.sortCreatedAsc",
};

/** v0.8.5 需求5：排序下拉展开动画时长（ms），与 FileTree.css sort-menu-in 同步 */
const SORT_MENU_IN_MS = 200;
/** v0.8.5 需求5：排序下接收回动画时长（ms），与 FileTree.css sort-menu-out 同步；
 * 收回动画播完才延迟卸载菜单（setSortMenu(null) 推迟到此时执行）。
 * 仅排序下拉有动画：右键菜单（folderCtxMenu/FileNode contextMenu）保持即时出现，
 * 符合右键交互惯例 */
const SORT_MENU_OUT_MS = 160;

interface FolderSectionProps {
  folder: { path: string; name: string };
  nodes: FileNodeData[];
  activePath: string | null;
  renamingPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (node: FileNodeData) => void;
  onToggleExpand: (path: string) => void;
  onRenameStart: (path: string) => void;
  onRenameConfirm: (path: string, newName: string) => void;
  onRenameCancel: () => void;
  onDelete: (node: FileNodeData) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  /** v0.8.4 需求2：树内节点右键"复制/剪切"（写剪贴板 + toast，由 FileTree 注入） */
  onCopyNode?: (node: FileNodeData) => void;
  onCutNode?: (node: FileNodeData) => void;
  /**
   * v0.8.4 反馈1：树内**文件夹**节点右键"粘贴"——以该文件夹路径为落点执行粘贴，
   * 复用 FileTree 的 handlePasteIntoDir（剪贴板 → copy/move → transferTo）。
   */
  onPasteInto?: (targetDir: string) => void;
  /**
   * v0.8.0 修复 P3：文件节点按下鼠标 → 启动自制拖拽
   */
  onFileDragStart?: (node: FileNodeData, e: React.MouseEvent) => void;
  /**
   * v0.8.4 需求10 S7 修复：文件夹右键"刷新"的目标目录。
   * 直传 FileTree 的 refreshTree（folderPath 缺省 = 刷全部），
   * FileNode 调 onRefresh(node.path) —— 右键谁刷谁的子树，
   * 不再是旧实现闭包固定为 section 根导致"刷错对象"。
   */
  onRefresh?: (folderPath?: string) => void;
  onClose: (folderPath: string) => void;
  /** 当前高度（px），由父组件按 sectionSizes 注入 */
  height?: number;
  /** 本区 key（用于相邻配对拖拽） */
  sectionKey?: string;
  /** 上方相邻可见区 key（为空说明本区是最上面一个区域 → 标题栏拖拽看 nextSectionKey） */
  prevSectionKey?: string;
  /** v0.8.2 功能4：下方相邻可见区 key（本区最靠上时标题栏改拖「本区+下区」） */
  nextSectionKey?: string;
  /** v0.8.0 修复 P11-4：本区高度上限（仅最后一个可见区域给出 → 可拖到底部） */
  maxHeight?: number;
  /** v0.8.0 WP2 需求6：在左侧栏打开文件所在文件夹工作区 */
  onOpenWorkspace?: (filePath: string) => void;
  /** v0.8.0 修复 P1-2：点击本区域（含空白处）即把本文件夹设为粘贴目标 */
  onActivateFolder?: (dir: string) => void;
  /** v0.8.0 修复 P12-1：在文件夹空白区右键 → 打开"粘贴"菜单
   *  v0.8.4 反馈1：第 4 参传入原生事件，供 FileTree 记录"本次打开事件"（见 folderCtxOpenEventRef） */
  onFolderContextMenu?: (dir: string, x: number, y: number, nativeEvent?: Event) => void;
  /** v0.8.2 动画优化：子目录缓存（按父路径），供树节点展开/收起动画取子节点 */
  childrenByPath?: Map<string, FileNodeData[]>;
  /** v0.8.2 动画优化：树节点子容器动画包装（由 FileTree 注入） */
  childrenWrap?: (path: string, visible: boolean, children: React.ReactNode) => React.ReactNode;
  /** v0.8.4 需求7：本文件夹根的排序模式（null = 未激活，回退手动/默认顺序） */
  sortMode?: SortMode | null;
  /** v0.8.4 需求7：切换排序模式；mode=null 表示取消排序（FileTree 层负责写记忆 + toast） */
  onSortChange?: (mode: SortMode | null) => void;
}

function FolderSection(props: FolderSectionProps) {
  const { folder, nodes, activePath, renamingPath, expandedPaths, onSelect,
    onToggleExpand, onRenameStart, onRenameConfirm, onRenameCancel,
    onDelete, onNewFile, onNewFolder, onCopyNode, onCutNode, onPasteInto, onFileDragStart, onRefresh, onClose,
    height, sectionKey, prevSectionKey, nextSectionKey, maxHeight, onOpenWorkspace, onActivateFolder,
    onFolderContextMenu, childrenByPath, childrenWrap, sortMode, onSortChange } = props;
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // v0.8.4 需求7：排序下拉菜单（null = 关闭；值 = fixed 定位坐标，取自按钮 rect）
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  // v0.8.5 需求5：排序下接收回动画状态（true = 正在播收回动画，动画结束才真正卸载）
  const [sortClosing, setSortClosing] = useState(false);
  const sortCloseTimerRef = useRef<number | null>(null);

  // v0.8.5 需求5：在指定坐标展开排序下拉（若收回动画进行中则取消收回、原地重新展开）
  const openSortMenuAt = useCallback((x: number, y: number) => {
    if (sortCloseTimerRef.current !== null) {
      window.clearTimeout(sortCloseTimerRef.current);
      sortCloseTimerRef.current = null;
    }
    setSortClosing(false);
    setSortMenu({ x, y });
  }, []);

  /**
   * v0.8.5 需求5：收起排序下拉——先播收回动画（SORT_MENU_OUT_MS），播完才卸载。
   * 三条关闭路径统一走此函数：点击外部（window click/contextmenu）、点击菜单项、
   * 再次点击排序按钮 toggle。幂等：收回已在进行时重复调用直接忽略。
   */
  const closeSortMenu = useCallback(() => {
    if (sortCloseTimerRef.current !== null) return;
    setSortClosing(true);
    sortCloseTimerRef.current = window.setTimeout(() => {
      sortCloseTimerRef.current = null;
      setSortMenu(null);
      setSortClosing(false);
    }, SORT_MENU_OUT_MS);
  }, []);

  // v0.8.5 需求5：卸载时清理未触发的收回定时器（避免卸载后 setState）
  useEffect(
    () => () => {
      if (sortCloseTimerRef.current !== null) window.clearTimeout(sortCloseTimerRef.current);
    },
    [],
  );

  // v0.8.4 需求7：点击外部 / 右键关闭排序下拉（与 folderCtxMenu 相同的 window 监听模式；
  // 菜单与按钮内部点击均 stopPropagation，不会误触发本监听）
  // v0.8.5 需求5：关闭改走 closeSortMenu（先播收回动画再延迟卸载）
  useEffect(() => {
    if (!sortMenu) return;
    const close = () => closeSortMenu();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [sortMenu, closeSortMenu]);

  // v0.8.0 修复 P9-1：标题栏在本区顶部，拖动它移动的是本区上边界，
  // 因此配对为「上方邻区 + 本区」；第一个区域无上方邻区 → 标题栏不可拖
  // v0.8.2 功能4：无上方邻区时改拖「本区 + 下区」（nextSectionKey）
  const { onMouseDown } = useSectionSplit({
    selfKey: sectionKey ?? `folder:${folder.path}`,
    prevKey: prevSectionKey,
    nextKey: nextSectionKey,
    maxHeight,
  });

  const sectionStyle: React.CSSProperties = {};
  if (maximized) {
    sectionStyle.height = 500;
  } else if (height !== undefined && !collapsed) {
    sectionStyle.height = height;
  }

  return (
    <div
      className={`filetree-folder-section ${collapsed ? "collapsed" : ""} ${maximized ? "maximized" : ""}`}
      style={sectionStyle}
      // v0.8.2 功能5：data-section-key 供内容高度测量（重新打开栏时上一栏收缩到内容高度）
      data-section-key={sectionKey ?? `folder:${folder.path}`}
      // v0.8.0 修复 P1-2：capture 阶段记录"当前点选的文件夹"作为 Ctrl+V 粘贴目标
      // （capture 先于标题栏拖拽的 stopPropagation，点标题栏/空白处/文件项都能生效）
      onMouseDownCapture={() => onActivateFolder?.(folder.path)}
      // v0.8.0 修复 P3：本区整体作为自制拖拽的落点（拖到标题栏/空白处也算）
      {...{ [DROP_DIR_ATTR]: folder.path }}
    >
      <div
        className="filetree-root-path"
        title={folder.path}
        onMouseDown={(e) => {
          // v0.8.2 功能2：折叠/放大时标题栏不触发拖拽（高度被 CSS 固定，
          // 拖拽会"显示没反应但内部高度被改"）
          if (!collapsed && !maximized) onMouseDown(e);
        }}
        // v0.8.2 功能2：双击标题栏切换缩小/放大（对应缩小按钮）
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          setCollapsed((c) => !c);
          setMaximized(false);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{verticalAlign:"middle",marginRight:"4px"}}><path d="M8 1.5l.354.353 6 6-.708.708L13 7.707V13.5l-.5.5h-9l-.5-.5V7.707l-.646.354-.708-.708 6-6L8 1.5zM4 7v6h3V9.5l.5-.5h1l.5.5V13h3V7L8 2.707 4 7z"/></svg>
        <span className="filetree-root-name">{folder.name}</span>
        {/* Issue 1：放大缩小按钮 + 关闭，统一放在 section-controls 中 */}
        {/* v0.8.0 WP2 需求7：增加"新建文件/新建文件夹"入口（针对本文件夹，直接落盘） */}
        {/* v0.8.4 需求10（D6 拍板）：移除标题栏刷新按钮（watch 实时刷新 + 工具栏全局刷新/
            Ctrl+R/空白右键刷新已兜底），其余按钮全部保留 */}
        <div className="section-controls">
          <button
            className="section-btn section-new-file"
            title={t("filetree.newFileTitle")}
            onClick={(e) => { e.stopPropagation(); onNewFile(folder.path); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16"><path d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5V2z" fill="currentColor"/></svg>
          </button>
          <button
            className="section-btn section-new-folder"
            title={t("filetree.newFolderTitle")}
            onClick={(e) => { e.stopPropagation(); onNewFolder(folder.path); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16"><path d="M1.5 3h4.6l1.4 1.6h6.9l.6.5v8l-.5.5h-13l-.5-.5v-9.6l.5-.5zm.5 1v8.6h12V5.6H7.1L5.7 4H2z" fill="currentColor"/><path d="M7.5 7h1v1.5H10v1H8.5V11h-1V9.5H6v-1h1.5V7z" fill="currentColor"/></svg>
          </button>
          {/* v0.8.4 需求7：排序按钮 —— 默认态上下双箭头；激活态箭头+竖排徽标（↑A-Z/↓Z-A/↑U/↓U/↑C/↓C）。
              onClick stopPropagation：防打开动作冒泡到 window 立即关闭菜单，也防触发标题栏双击折叠。
              mousedown 无需处理：useSectionSplit.beginSectionDrag 已按 closest("button") 排除，
              不会误启动分栏拖拽（与 section-new-folder 等现有按钮同规则）
              v0.8.5 需求5：toggle 改走 openSortMenuAt/closeSortMenu——收回动画进行中再点 = 取消收回 */}
          <button
            className={`section-btn section-sort${sortMode ? " sort-active" : ""}`}
            title={t("filetree.sort")}
            onClick={(e) => {
              e.stopPropagation();
              if (sortMenu) {
                if (sortClosing) openSortMenuAt(sortMenu.x, sortMenu.y);
                else closeSortMenu();
                return;
              }
              // position: fixed 定位到按钮下方（fixed 不受 section overflow:hidden 裁剪，
              // 多栏高度受限时菜单依然完整可见）；右缘越出视口时回拉
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const menuWidth = 190;
              const x = Math.max(0, Math.min(rect.left, window.innerWidth - menuWidth));
              openSortMenuAt(x, rect.bottom + 4);
            }}
          >
            {sortMode
              ? (() => {
                  const badge = sortModeBadge(sortMode);
                  // v0.8.4 反馈5：按组套类名——.sort-icon-time（箭头短、字母大写，
                  // 一条水平线）/ .sort-icon-name（箭头长、字母小写竖排，两柱等高）。
                  // 与下拉菜单项共用同一套类名规则（见 .sort-menu-icon 同时带 .sort-icon）。
                  const nameGroup = isNameSortMode(sortMode);
                  return (
                    <span className={`sort-icon ${nameGroup ? "sort-icon-name" : "sort-icon-time"}`}>
                      <SortArrowIcon
                        dir={badge.arrow}
                        size={nameGroup ? SORT_ARROW_SIZE.name : SORT_ARROW_SIZE.time}
                        elongate={nameGroup}
                      />
                      <SortBadge label={badge.label} />
                    </span>
                  );
                })()
              : <SortBothIcon />}
          </button>
          <button
            className="section-btn section-minimize"
            title={t("filetree.minimize")}
            onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); setMaximized(false); }}
          >
            ▾
          </button>
          <button
            className="section-btn section-maximize"
            title={t("filetree.maximize")}
            onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); setCollapsed(false); }}
          >
            ▴
          </button>
          <button
            className="section-btn section-close"
            title={t("filetree.closeFolderTitle")}
            onClick={(e) => { e.stopPropagation(); onClose(folder.path); }}
          >
            ×
          </button>
        </div>
      </div>
      {!collapsed && (
        <div
          className="filetree-folder-content"
          // 拖拽落点由根节点的 data-drop-dir 统一承载（v0.8.0 修复 P3 自制拖拽）
          // v0.8.0 修复 P12-1：空白区右键 → "粘贴"菜单（文件项自身的右键会 stopPropagation）
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onFolderContextMenu?.(folder.path, e.clientX, e.clientY, e.nativeEvent);
          }}
        >
          {nodes.length > 0 ? (
            nodes.map((node) => (
              <FileEntryNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                renamingPath={renamingPath}
                expandedPaths={expandedPaths}
                childrenByPath={childrenByPath}
                childrenWrap={childrenWrap}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                onRenameStart={onRenameStart}
                onRenameConfirm={onRenameConfirm}
                onRenameCancel={onRenameCancel}
                onDelete={onDelete}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onCopyNode={onCopyNode}
                onCutNode={onCutNode}
                // v0.8.4 反馈1：文件夹节点右键"粘贴"（落到该文件夹）
                onPasteInto={onPasteInto}
                onFileDragStart={onFileDragStart}
                // v0.8.4 需求10 S7 修复：直传 refreshTree，FileNode 以 node.path 调用
                onRefresh={onRefresh}
                onOpenWorkspace={onOpenWorkspace}
              />
            ))
          ) : (
            <div className="filetree-placeholder">{t("filetree.emptyFolder")}</div>
          )}
        </div>
      )}
      {/* v0.8.4 需求7：排序下拉菜单 —— position: fixed 定位到按钮下方（不受栏高/overflow 裁剪）；
          3 组 6 项组间 divider，每项文字右侧放语义小图标（箭头 + 竖排徽标）；
          当前激活项高亮，再次点击激活项 = 取消排序（onSortChange(null) → toast "已取消排序"）。
          菜单容器 onClick stopPropagation，防止内部点击冒泡到 window 误关。
          v0.8.5 需求5：挂载即播展开动画（sort-menu-open），三条关闭路径统一先播收回动画
          （sort-menu-closing，收回期间 pointer-events:none 防误交互），播完延迟卸载 */}
      {sortMenu && (
        <div
          className={`filetree-context-menu filetree-sort-menu ${
            sortClosing ? "sort-menu-closing" : "sort-menu-open"
          }`}
          style={{ left: sortMenu.x, top: sortMenu.y, position: "fixed" }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {SORT_MENU_GROUPS.map((group, gi) => (
            <Fragment key={group[0]}>
              {gi > 0 && <div className="context-menu-divider" />}
              {group.map((mode) => {
                const badge = sortModeBadge(mode);
                const active = sortMode === mode;
                // v0.8.4 反馈5：菜单项图标与标题栏按钮激活态共用同一套类名规则
                // （.sort-icon + .sort-icon-time / .sort-icon-name）与同一组尺寸常量
                const nameGroup = isNameSortMode(mode);
                return (
                  <button
                    key={mode}
                    className={`context-menu-item sort-menu-item${active ? " sort-active" : ""}`}
                    onClick={() => {
                      // 再次点击激活项 = 取消排序，恢复手动/默认顺序
                      // v0.8.5 需求5：关闭改走 closeSortMenu（先播收回动画再延迟卸载）
                      onSortChange?.(active ? null : mode);
                      closeSortMenu();
                    }}
                  >
                    <span className="sort-menu-label">{t(SORT_MENU_KEYS[mode])}</span>
                    <span
                      className={`sort-icon sort-menu-icon ${nameGroup ? "sort-icon-name" : "sort-icon-time"}`}
                    >
                      <SortArrowIcon
                        dir={badge.arrow}
                        size={nameGroup ? SORT_ARROW_SIZE.name : SORT_ARROW_SIZE.time}
                        elongate={nameGroup}
                      />
                      <SortBadge label={badge.label} />
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
