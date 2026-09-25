/**
 * dropTarget ── 同目录拖拽重排的插入位置计算（v0.8.4 需求3）
 *
 * 从 elementFromPoint 的命中元素向上定位 .filetree-node-wrapper 目标行，
 * 依鼠标 Y 与该行垂直中点的比较决定插入到目标行之前（before）/之后（after）；
 * 未命中行（拖到标题栏/空白处）或命中源自身行 → place = "end"（追加到列表末尾）。
 *
 * 抽成纯函数便于单测：hitEl 由调用方注入（jsdom 未实现 elementFromPoint，
 * 测试通过覆盖 getBoundingClientRect 注入行几何信息），本模块不做命中测试。
 */
import { isDescendantDir } from "./fileClipboard";
import { normalizePath } from "./path";

/** 归一化目录路径（统一 `/`、去尾斜杠、Windows 大小写不敏感） */
function normDir(p: string): string {
  return normalizePath(p).replace(/\/+$/, "").toLowerCase();
}

/**
 * v0.8.4 需求3 修复：拖拽落点准入谓词（canDrop）。
 *
 * 语义按**源类型**分流（这是本次修复的核心）：
 * - 目录源（srcIsDir=true）：拒绝落到自身或其内部（`!isDescendantDir`），
 *   防止把文件夹放进自身后代造成递归无限复制（P0）；
 * - 文件源（srcIsDir=false）：文件不可能是任何目录的祖先，一律放行；
 *   仅防御性排除"targetDir 与源文件完全同路径"（归一化后比较，实际不可能发生——
 *   投放目录来自 data-drop-dir 必为目录）。
 *
 * 修复前对文件源也套用 isDescendantDir 会在"同目录重排"场景产生误判（详见测试
 * v0.8.4-dropTarget.test.ts 的 canDropIntoTarget 用例），本次仅让目录源套用目录语义。
 */
export function canDropIntoTarget(
  srcPath: string,
  srcIsDir: boolean,
  targetDir: string,
): boolean {
  if (srcIsDir) return !isDescendantDir(srcPath, targetDir);
  return normDir(srcPath) !== normDir(targetDir);
}

export interface InsertPlace {
  /** 目标行的显示名（未命中行时为 null） */
  targetName: string | null;
  /** 插入位置：目标行前/后；end = 把源移除后追加到列表末尾 */
  place: "before" | "after" | "end";
}

/** 树节点行的最外层 wrapper（FileNode.tsx 渲染结构） */
const NODE_ROW_CLASS = ".filetree-node-wrapper";

/**
 * 解析拖拽松手位置的插入意图。
 *
 * @param hitEl   elementFromPoint 的命中元素（可为 null）
 * @param mouseY  松手时的鼠标垂直坐标（clientY）
 * @param srcName 被拖拽项的显示名（用于"命中源自身行 → end"判定，可省略）
 */
export function resolveInsertPlace(
  hitEl: Element | null,
  mouseY: number,
  srcName?: string,
): InsertPlace {
  const row =
    hitEl && typeof (hitEl as Element).closest === "function"
      ? hitEl.closest(NODE_ROW_CLASS)
      : null;
  // 空白处/非行元素 → 追加到末尾（D5：同栏空白命中根目录 = 重排到末尾）
  if (!row) return { targetName: null, place: "end" };
  // 行内显示名（.filetree-name 为树节点与「打开的文件」条目共用的名字元素）
  const nameEl = row.querySelector(".filetree-name");
  const targetName = nameEl?.textContent ?? null;
  // 命中源自身行 → 追加到末尾（语义：把 src 移除后 push，见 dragOrder.reorderList）
  if (srcName != null && targetName === srcName) {
    return { targetName: null, place: "end" };
  }
  const rect = (row as HTMLElement).getBoundingClientRect?.();
  // 无有效几何信息（如 jsdom 默认全 0）→ 保守放到目标行之后
  if (!rect || rect.height <= 0) return { targetName, place: "after" };
  return mouseY < rect.top + rect.height / 2
    ? { targetName, place: "before" }
    : { targetName, place: "after" };
}
