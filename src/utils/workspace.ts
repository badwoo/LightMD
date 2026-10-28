/**
 * v0.8.0 WP2 需求6：打开所在文件夹工作区
 * v0.15.0 F2：路径比较统一走 `utils/path.ts`（禁止本地再写前缀匹配），并支持
 *            「多根嵌套取包含该文件的最深已打开根」。
 *
 * 纯逻辑（不依赖 React），便于单测。UI 组件把 store / 事件派发注入为 deps。
 */
import { getParentDir, isSameOrInsidePath, normalizePath } from "./path";

export interface OpenWorkspaceDeps {
  /** 当前已打开的文件夹列表（仅需 path 字段） */
  openFolders: { path: string }[];
  /** 判断某路径是否已挂载在侧栏（含其祖先） */
  isPathInOpenFolders: (p: string) => boolean;
  /** 展开某路径及其所有祖先目录 */
  expandTo: (p: string) => void;
  /** 未挂载时挂载该文件夹（通常 dispatch `lightmd:openFolder` 事件） */
  openFolder: (p: string) => void;
  /** 定位高亮某个文件（可选） */
  setActive?: (p: string) => void;
}

export interface OpenWorkspaceResult {
  /** true=已在侧栏挂载（仅展开定位）；false=触发了挂载事件 */
  mounted: boolean;
  /** 文件所在父目录（即要挂载/已挂载的工作区根） */
  parentDir: string;
  /**
   * v0.15.0 F2：定位/挂载所用的工作区根。
   * - mounted=true：包含该文件的最深已打开根（多根嵌套时用它作定位上下文）；
   * - mounted=false：等同 parentDir（即将挂载的新根）。
   * 供调用方取「工作区名」拼提示文案。
   */
  rootDir: string;
}

/** 路径深度比较键：归一分隔符 + 去尾斜杠（仅比长度选最深，不做匹配判断） */
function depthKey(p: string): string {
  return normalizePath(p).replace(/\/+$/, "");
}

/**
 * v0.15.0 F2：在已打开根中选出「包含该文件的最深根」。
 *
 * 匹配复用 `isSameOrInsidePath`（大小写不敏感、分隔符/尾斜杠归一、`/a/foo` 不误匹配 `/a/foobar`）；
 * 命中多个（多根嵌套）时取归一化后路径最长的一个 = 最深根。
 * 无命中返回 null（调用方回退）。
 */
export function findDeepestContainingRoot(
  filePath: string,
  openFolders: { path: string }[],
): string | null {
  if (!filePath) return null;
  let best: string | null = null;
  let bestLen = -1;
  for (const folder of openFolders) {
    const rootPath = folder?.path;
    if (!rootPath) continue;
    if (!isSameOrInsidePath(filePath, rootPath)) continue;
    const len = depthKey(rootPath).length;
    if (len > bestLen) {
      bestLen = len;
      best = rootPath;
    }
  }
  return best;
}

/**
 * 计算文件所在父目录，并决定是"仅展开定位"还是"派发挂载事件"。
 *
 * v0.15.0 F2：mounted 分支只做 expandTo(parentDir) + setActive(filePath)——
 * 不新增 folder、不重复 watchFolder、不整树刷新；未挂载分支才走 openFolder(parentDir)。
 * 返回 mounted / rootDir 供调用方决定提示文案（已定位 vs 已打开）。
 */
export function openContainingWorkspace(
  filePath: string,
  deps: OpenWorkspaceDeps,
): OpenWorkspaceResult {
  const parentDir = getParentDir(filePath);
  if (deps.isPathInOpenFolders(parentDir)) {
    // 多根嵌套：定位上下文取最深根；openFolders 缺失/不一致时回退 parentDir
    const rootDir = findDeepestContainingRoot(filePath, deps.openFolders) ?? parentDir;
    deps.expandTo(parentDir);
    deps.setActive?.(filePath);
    return { mounted: true, parentDir, rootDir };
  }
  deps.openFolder(parentDir);
  return { mounted: false, parentDir, rootDir: parentDir };
}
