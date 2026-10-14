/**
 * v0.13.0 需求10：Emoji 短码补全的数据访问层（懒加载 + 过滤 + 截断）。
 *
 * ## 数据源
 *
 * 直接用 `markdown-it-emoji` 自带的 `lib/data/full.mjs`（约 1900 条）——
 * **不自行维护表**：与渲染层（`emoji-render.ts` 经 `md.render()` 解析）
 * 同源，避免「补全列表里有、渲染不出来」或反之的不一致。
 *
 * ## 为什么懒加载
 *
 * 该模块约 50KB（1900 条映射）。补全只在用户输入 `:` 后才需要，
 * 静态引入会让它进入主包并拖慢首屏。故用动态 `import()`，首次触发时
 * 才拉取；Vite 会把它拆成独立 chunk。
 *
 * ## 截断
 *
 * 候选数上限 [`MAX_CANDIDATES`]（默认 50）：既防止长列表卡顿，
 * 也避免 DOM 节点爆炸（与 Outline 的 MAX_OUTLINE_ITEMS 同思路）。
 */
import type MarkdownIt from "markdown-it";

/** 一个补全候选 */
export interface EmojiCandidate {
  /** 短码（不含冒号），如 "smile" */
  name: string;
  /** unicode 字符，如 "😄" */
  unicode: string;
}

/** 候选数上限（超出截断，防卡顿与 DOM 爆炸） */
export const MAX_CANDIDATES = 50;

/** 已加载的短码→unicode 表（null = 尚未加载） */
let table: Record<string, string> | null = null;

/** 进行中的加载 Promise（避免并发重复加载） */
let loading: Promise<Record<string, string>> | null = null;

/**
 * 懒加载完整 emoji 表。
 *
 * 动态 import 的路径写死为包内数据文件：markdown-it-emoji 只在这个版本
 * 提供该文件，且它是包的公共数据出口（bare/light/full 三个变体共用目录）。
 */
export function loadEmojiTable(): Promise<Record<string, string>> {
  if (table) return Promise.resolve(table);
  if (loading) return loading;
  loading = import("markdown-it-emoji/lib/data/full.mjs")
    .then((mod) => {
      const data = (mod as { default?: Record<string, string> }).default ?? {};
      table = data;
      loading = null;
      return data;
    })
    .catch(() => {
      loading = null;
      return {} as Record<string, string>;
    });
  return loading;
}

/** 表是否已加载（测试/诊断用） */
export function isEmojiTableLoaded(): boolean {
  return table !== null;
}

/** 测试用：重置加载状态 */
export function __resetEmojiTableForTest(): void {
  table = null;
  loading = null;
}

/**
 * 按前缀过滤候选（同步口径：**前缀匹配**而非子序列）。
 *
 * 为什么用前缀：用户刚输入 `:sm` 时期望看到 `smile`/`smiley` 这类
 * 「以 sm 开头」的，模糊子序列会掺入 `some...` 之类噪音。
 * 命中数相同时按**名称长度**升序（短的更贴近输入意图），再按字母序。
 *
 * @param query 已输入的过滤词（不含冒号）
 * @param limit 候选上限（默认 MAX_CANDIDATES）
 */
export function filterCandidates(
  query: string,
  limit: number = MAX_CANDIDATES,
): EmojiCandidate[] {
  if (!table) return [];
  const q = query.trim().toLowerCase();
  const out: EmojiCandidate[] = [];
  for (const [name, unicode] of Object.entries(table)) {
    if (!q || name.toLowerCase().startsWith(q)) {
      out.push({ name, unicode });
    }
  }
  out.sort((a, b) => {
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out.slice(0, Math.max(0, limit));
}

/**
 * 异步版过滤（表未加载时会先加载）。
 */
export async function filterCandidatesAsync(
  query: string,
  limit: number = MAX_CANDIDATES,
): Promise<EmojiCandidate[]> {
  await loadEmojiTable();
  return filterCandidates(query, limit);
}

/** 候选数被截断时，实际被截掉的条数（供 UI 显示「还有 N 个」） */
export function countBeyondLimit(query: string, limit: number = MAX_CANDIDATES): number {
  if (!table) return 0;
  const q = query.trim().toLowerCase();
  let n = 0;
  for (const name of Object.keys(table)) {
    if (!q || name.toLowerCase().startsWith(q)) n++;
  }
  return Math.max(0, n - Math.max(0, limit));
}

/**
 * 用 markdown-it 实例校验短码可渲染（补全列表与渲染层双保险）。
 *
 * 正常不会用到（数据同源），但若某天升级 markdown-it-emoji 导致
 * 两份数据不一致，这里能把「渲染不出来」的候先滤掉。
 */
export function isRenderable(md: MarkdownIt, name: string): boolean {
  try {
    const html = md.render(`:${name}:`).trim();
    return !html.includes(`:${name}:`);
  } catch {
    return false;
  }
}
