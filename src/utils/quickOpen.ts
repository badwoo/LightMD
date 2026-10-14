/**
 * v0.13.0 需求8：`Ctrl+P` 快速切换器的纯逻辑层。
 *
 * ## 三类来源（按优先级去重）
 *
 * 1. **已打开标签**（置顶）——切标签是最常见诉求，命中应最靠前；
 * 2. **最近文件**——跨会话找回；
 * 3. **当前工作区文件**——文件树全量。
 *
 * 同一路径在三类里重复时只保留优先级最高的那条。
 *
 * ## 匹配算法
 *
 * 子序列模糊匹配（`fuzzyMatch`）+ 打分：
 * - 连续子串得分最高（`abc` 命中 `xxabcxx`）；
 * - 词首（`-` / `_` / 空格 / 路径分隔符之后）命中的字符加权；
 * - 越靠前的匹配位置分越高；
 * - 完全相等（忽略大小写）额外加分。
 *
 * 拼音首字母匹配**本版不做**（需引入拼音库，记录为后续）。
 */

/** 一个可切换的条目 */
export interface QuickOpenItem {
  /** 文件路径（唯一键） */
  path: string;
  /** 显示名（文件名） */
  name: string;
  /** 所属目录（展示用，工作区文件分组时显示） */
  dir?: string;
  /** 来源分组 */
  group: "openTabs" | "recent" | "workspace";
  /** 是否当前活跃标签 */
  isActive?: boolean;
}

export interface FuzzyMatchResult {
  /** 是否匹配 */
  matched: boolean;
  /** 总分（越高越靠前；未匹配为 0） */
  score: number;
  /** 命中的字符下标（用于高亮） */
  positions: number[];
}

/** 词首字符判定：这些字符之后的字符视为「词首」，加权 */
const WORD_BOUNDARY = /[\s\-_/\\.,()[\]{}]/;

/**
 * 子序列模糊匹配 + 打分。
 *
 * @param query 用户输入（已转小写）
 * @param target 目标字符串（已转小写）
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult {
  if (!query) return { matched: true, score: 1, positions: [] };
  if (!target) return { matched: false, score: 0, positions: [] };

  const positions: number[] = [];
  let ti = 0;
  let score = 0;
  let prevMatchIdx = -2;

  for (const qc of query) {
    // 从 ti 起找下一个匹配字符
    let found = -1;
    for (let i = ti; i < target.length; i++) {
      if (target[i] === qc) {
        found = i;
        break;
      }
    }
    if (found === -1) return { matched: false, score: 0, positions: [] };

    positions.push(found);
    // 连续匹配（紧挨上一个命中）大幅加分
    if (found === prevMatchIdx + 1) score += 8;
    // 词首命中加分
    if (found === 0 || WORD_BOUNDARY.test(target[found - 1] ?? "")) score += 6;
    // 位置越靠前分越高（线性衰减）
    score += Math.max(0, 10 - found);
    prevMatchIdx = found;
    ti = found + 1;
  }

  // 完全相等额外加分
  if (target === query) score += 50;
  return { matched: true, score, positions };
}

/**
 * 去掉路径的盘符前缀（`C:/` / `C:\`）。
 *
 * 为什么必须去：路径兜底匹配会把盘符也算进去——查询 "d.md" 会成为
 * "d:/a.md" 的子序列（d=0, .=4, m=5, d=6）→ **D 盘上每个文件都命中**，
 * 用户输入文件名却得到全盘结果。去掉盘符后 "d.md" 只匹配真正的
 * "…/d.md"。
 */
function stripDrivePrefix(path: string): string {
  return path.replace(/^[a-zA-Z]:[\\/]/, "");
}

/**
 * 对单个条目打分（文件名优先，路径作为次要匹配）。
 *
 * 文件名命中的得分远高于仅在路径里命中——用户输入的是文件名的一部分。
 */
export function scoreItem(query: string, item: QuickOpenItem): FuzzyMatchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { matched: true, score: 1, positions: [] };
  const byName = fuzzyMatch(q, item.name.toLowerCase());
  if (byName.matched && byName.score >= 50) {
    // 文件名几乎完全匹配 → 直接用
    return byName;
  }
  // 路径匹配作为兜底（例如输入目录名）；**去掉盘符**避免全盘误命中
  const byPath = fuzzyMatch(q, stripDrivePrefix(item.path).toLowerCase());
  if (!byName.matched && !byPath.matched) {
    return { matched: false, score: 0, positions: [] };
  }
  // 文件名命中权重更高；仅路径命中时降权
  const nameScore = byName.matched ? byName.score * 2 : 0;
  const pathScore = byPath.matched ? byPath.score : 0;
  return {
    matched: true,
    score: Math.max(nameScore, pathScore),
    positions: nameScore >= pathScore ? byName.positions : [],
  };
}

/** 一个条目打完分的完整结果（含高亮位置） */
export interface ScoredItem {
  item: QuickOpenItem;
  score: number;
  /** 文件名中命中的字符下标（高亮用） */
  positions: number[];
}

/**
 * 聚合三类来源并按查询过滤排序（返回带高亮位置的条目）。
 *
 * @param query 用户输入
 * @param sources 三类条目（可含重复路径）
 * @returns 去重 + 过滤 + 排序后的列表
 */
export function buildQuickOpenItems(
  query: string,
  sources: {
    openTabs: QuickOpenItem[];
    recent: QuickOpenItem[];
    workspace: QuickOpenItem[];
  },
): ScoredItem[] {
  // ① 合并 + 按路径去重（保留最高优先级分组）
  const byPath = new Map<string, QuickOpenItem>();
  const all = [
    ...sources.openTabs.map((i) => ({ ...i, group: "openTabs" as const })),
    ...sources.recent.map((i) => ({ ...i, group: "recent" as const })),
    ...sources.workspace.map((i) => ({ ...i, group: "workspace" as const })),
  ];
  for (const item of all) {
    const prev = byPath.get(item.path);
    if (!prev || GROUP_ORDER[item.group] < GROUP_ORDER[prev.group]) {
      byPath.set(item.path, item);
    }
  }

  // ② 打分 + 过滤
  const scored: ScoredItem[] = [];
  for (const item of byPath.values()) {
    const r = scoreItem(query, item);
    if (!r.matched) continue;
    scored.push({
      item,
      score: r.score + (item.isActive ? 5 : 0),
      positions: r.positions,
    });
  }

  // ③ 排序：分数优先，同分按分组序，再按名称
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ga = GROUP_ORDER[a.item.group];
    const gb = GROUP_ORDER[b.item.group];
    if (ga !== gb) return ga - gb;
    return a.item.name.localeCompare(b.item.name);
  });

  return scored;
}

/** 三类来源的分组序（数字越小越靠前） */
const GROUP_ORDER: Record<QuickOpenItem["group"], number> = {
  openTabs: 0,
  recent: 1,
  workspace: 2,
};

/** 从路径取文件名 */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 从路径取父目录 */
export function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? "" : path.slice(0, idx);
}

/** 快速切换器的分组标题 i18n key */
export const QUICK_OPEN_GROUP_KEYS: Record<QuickOpenItem["group"], string> = {
  openTabs: "quickOpen.group.openTabs",
  recent: "quickOpen.group.recent",
  workspace: "quickOpen.group.workspace",
};

/** 文件树节点的最小结构（`useFileStore` 的 FileNode 未导出，这里按结构取用） */
export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
}

/**
 * 把文件树摊平为文件列表（只保留文件，目录只作为遍历容器）。
 *
 * 有深度上限保护：异常深的树（或循环引用）不会导致无限递归。
 */
export function flattenFileTree(
  nodes: FileTreeNode[],
  maxDepth = 12,
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const walk = (list: FileTreeNode[], depth: number) => {
    if (depth > maxDepth) return;
    for (const n of list) {
      if (n.isDir) {
        if (n.children?.length) walk(n.children, depth + 1);
      } else {
        out.push({ name: n.name, path: n.path });
      }
    }
  };
  walk(nodes, 0);
  return out;
}
