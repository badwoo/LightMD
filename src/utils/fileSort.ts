/**
 * fileSort ── 文件树排序纯函数（v0.8.4 需求7）
 *
 * 排序语义（用户拍板 C2）：
 * - ↑ = 升序：name-asc（A-Z）、modified-asc（修改时间早-晚）、created-asc（创建时间早-晚）
 * - ↓ = 降序：name-desc（Z-A）、modified-desc（修改时间晚-早，新在前）、created-desc（创建时间晚-早）
 *
 * 排序规则：
 * - 文件与文件夹**混排**（不再强制文件夹在前，需求 7"对文件和子文件夹均生效"）；
 * - modified/created 时间为 0 或缺失（未知）时无论升降序都排最后；
 * - 相同时间（或双方均未知）回退名称 localeCompare，保证排序结果稳定。
 *
 * 本模块只做纯函数，不读 store / localStorage —— 排序模式的存取在 useSettingsStore，
 * 渲染统一出口在 FileTree 的 sortChildren。
 */
import type { FileNodeData } from "../components/sidebar/FileNode";

/** 文件树排序模式（6 种：名称 2 + 修改时间 2 + 创建时间 2） */
export type SortMode =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "created-desc"
  | "created-asc";

/** 全部排序模式（顺序即下拉菜单展示顺序：名称 → 修改时间 → 创建时间） */
export const SORT_MODES: SortMode[] = [
  "name-asc",
  "name-desc",
  "modified-desc",
  "modified-asc",
  "created-desc",
  "created-asc",
];

/** 名称升序比较器（也作为时间排序的稳定回退） */
function byNameAsc(a: FileNodeData, b: FileNodeData): number {
  return a.name.localeCompare(b.name);
}

/**
 * 按模式排序节点列表（不修改入参，返回新数组）。
 * 时间为 0（未知）排最后；相同时间回退名称序保证稳定。
 */
export function sortNodes(nodes: FileNodeData[], mode: SortMode): FileNodeData[] {
  if (mode === "name-asc") return [...nodes].sort(byNameAsc);
  if (mode === "name-desc") return [...nodes].sort((a, b) => b.name.localeCompare(a.name));

  // 时间模式：modified-* 用修改时间，created-* 用创建时间
  const key: "modifiedMs" | "createdMs" = mode.startsWith("modified") ? "modifiedMs" : "createdMs";
  // 降序（-desc）= 晚-早（新在前）；升序（-asc）= 早-晚
  const desc = mode.endsWith("-desc");
  return [...nodes].sort((a, b) => {
    const ta = a[key] ?? 0;
    const tb = b[key] ?? 0;
    const aUnknown = ta <= 0;
    const bUnknown = tb <= 0;
    // 未知时间（0/缺失）无论升降序都排最后；双方均未知时回退名称序
    if (aUnknown && bUnknown) return byNameAsc(a, b);
    if (aUnknown) return 1;
    if (bUnknown) return -1;
    const diff = desc ? tb - ta : ta - tb;
    // 相同时间回退名称 localeCompare 保证稳定
    return diff !== 0 ? diff : byNameAsc(a, b);
  });
}

/**
 * 模式 → 排序按钮徽标描述（v0.8.4 需求7，语义按 C2 拍板）：
 * ↑=升序（name-asc→↑A-Z；modified-asc→↑U；created-asc→↑C）
 * ↓=降序（name-desc→↓Z-A；modified-desc→↓U；created-desc→↓C）
 */
export function sortModeBadge(
  mode: SortMode
): { arrow: "up" | "down"; label: "A-Z" | "Z-A" | "U" | "C" } {
  switch (mode) {
    case "name-asc":
      return { arrow: "up", label: "A-Z" };
    case "name-desc":
      return { arrow: "down", label: "Z-A" };
    case "modified-asc":
      return { arrow: "up", label: "U" };
    case "modified-desc":
      return { arrow: "down", label: "U" };
    case "created-asc":
      return { arrow: "up", label: "C" };
    case "created-desc":
      return { arrow: "down", label: "C" };
  }
}
