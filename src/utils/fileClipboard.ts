/**
 * v0.8.0 WP2 需求1：文件复制的"内存剪贴板"
 *
 * 注意：**不使用系统剪贴板**——避免与编辑器内文本的 Ctrl+C/Ctrl+V 冲突。
 * 这里只是一块模块级内存，存放"待粘贴的文件路径 + 名称"。
 */
import { getParentDir, isSameOrInsidePath } from "./path";
/**
 * v0.8.0 修复 P13-1：剪贴板操作模式。
 * - copy：粘贴时生成副本（重名自动加" - 副本"后缀）
 * - cut ：粘贴时移动原文件（粘贴成功后剪贴板清空，与系统资源管理器一致）
 */
export type ClipboardMode = "copy" | "cut";

export interface ClipboardItem {
  path: string;
  name: string;
  mode: ClipboardMode;
}

let clipboard: ClipboardItem | null = null;

/** 写入剪贴板（未指定 mode 时按 copy 处理，兼容既有调用） */
export function setClipboard(item: { path: string; name: string; mode?: ClipboardMode }): void {
  clipboard = {
    path: item.path,
    name: item.name,
    mode: item.mode === "cut" ? "cut" : "copy",
  };
}

export function getClipboard(): ClipboardItem | null {
  return clipboard;
}

/** v0.8.0 修复 P13-1：剪贴板对应的文件传输语义（cut → move） */
export function clipboardTransferMode(item: ClipboardItem | null): "copy" | "move" {
  return item?.mode === "cut" ? "move" : "copy";
}

export function clearClipboard(): void {
  clipboard = null;
}

export function hasClipboard(): boolean {
  return clipboard !== null;
}

/**
 * v0.8.0 修复 P1-2：解析 Ctrl+V 的粘贴目标目录（纯函数，便于单测）。
 *
 * 优先级：用户点选的文件夹 > 当前活跃文件所在目录 > 第一个已打开文件夹。
 * 旧实现缺少第一项，导致"在某个打开的文件夹里 Ctrl+V 却不生效（文件粘到别处）"。
 */
export function resolvePasteTargetDir(
  pickedDir: string | null | undefined,
  activeFilePath: string | null | undefined,
  openFolderPaths: readonly string[],
): string {
  if (pickedDir) return pickedDir;
  if (activeFilePath) return getParentDir(activeFilePath);
  return openFolderPaths[0] || "";
}

/**
 * v0.8.4 需求1：自嵌套判定——targetDir 是否为 srcPath 自身或其内部目录
 * （统一 `/` 归一后：targetDir === srcPath 或 targetDir 以 "srcPath/" 为前缀）。
 * 复用 path.isSameOrInsidePath（归一 + 忽略尾斜杠 + Windows 大小写不敏感语义）。
 * 用于拖拽/粘贴守卫：防止把文件夹放进自身后代造成递归无限复制/数据损坏（P0）。
 * srcPath 为文件时，除 targetDir 与其完全同路径（防御性拒绝）外恒返回 false
 * （文件不可能是任何目录的祖先），可与文件夹统一调用。
 */
export function isDescendantDir(srcPath: string, targetDir: string): boolean {
  return isSameOrInsidePath(targetDir, srcPath);
}

/** v0.8.0 WP2 需求1：拖拽载荷的 MIME（标签栏 / 打开的文件面板 → 文件夹） */
export const FILE_DRAG_MIME = "application/x-lightmd-file";

/** 拖拽事件是否携带"文件"载荷（用于 dragover 放行判定） */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  const list = Array.from(types);
  return list.includes(FILE_DRAG_MIME) || list.includes("text/plain");
}

/** 从拖拽事件中读取被拖拽的源路径（兼容纯路径与 JSON 载荷） */
export function readDragPath(e: { dataTransfer: DataTransfer | null }): string {
  const dt = e.dataTransfer;
  if (!dt) return "";
  const custom = dt.getData(FILE_DRAG_MIME);
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (parsed?.path) return String(parsed.path);
    } catch {
      return custom;
    }
  }
  return dt.getData("text/plain") || "";
}

/**
 * v0.8.0 WP2 需求1：在已有名字集合中为 name 生成一个不冲突的名字。
 *
 * 冲突时追加 " - 副本"、" - 副本2"…（保留扩展名前缀）。
 * 纯函数，便于单测覆盖递增逻辑。
 *
 * @param name 期望的名字（含或不含扩展名）
 * @param existing 目标目录已有的名字集合（Set 或数组均可）
 */
export function makeUniqueName(name: string, existing: Iterable<string>): string {
  const set = existing instanceof Set ? existing : new Set(existing);
  if (!set.has(name)) return name;
  const dotIdx = name.lastIndexOf(".");
  const hasExt = dotIdx > 0 && dotIdx < name.length - 1;
  const base = hasExt ? name.slice(0, dotIdx) : name;
  const ext = hasExt ? name.slice(dotIdx) : "";
  let i = 1;
  let candidate = `${base} - 副本${ext}`;
  while (set.has(candidate)) {
    i += 1;
    candidate = `${base} - 副本${i}${ext}`;
  }
  return candidate;
}

/**
 * 决定"把 src 复制/移动到 targetDir"应使用的目标文件名。
 *
 * - 复制：重名时自动生成" - 副本"后缀（需求1 的明确语义）
 * - 移动：**目标目录就是源文件所在目录时返回 null（no-op）**——
 *   v0.8.0 修复 P1-7：旧实现会把文件误改名为" - 副本"
 *
 * @returns null 表示无需执行任何操作；否则返回目标文件名
 */
export function resolveTransferName(
  srcPath: string,
  targetDir: string,
  mode: "copy" | "move",
  existing: Iterable<string>,
): string | null {
  const name = srcPath.split(/[\\/]/).pop() || "";
  if (!name) return null;
  if (mode === "move") {
    const srcDir = getParentDir(srcPath).replace(/\\/g, "/").replace(/\/+$/, "");
    const dir = targetDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (srcDir === dir) return null;
  }
  const set = existing instanceof Set ? existing : new Set(existing);
  return set.has(name) ? makeUniqueName(name, set) : name;
}
