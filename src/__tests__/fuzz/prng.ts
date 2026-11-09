/**
 * v0.17.0 P0-3 —— 确定性伪随机数发生器（fuzz 用，零依赖）。
 *
 * 为什么不用 Math.random：往返 fuzz 的**基线必须可复现**。同一 seed + 同一
 * 文档序号 → 逐字节相同的 Markdown，否则「昨天 0 个 lossy / 今天 12 个 lossy」
 * 无法判断是实现退化了还是抽样变了。
 *
 * 算法：mulberry32（32 位状态，质量足够用于生成器抽样，实现 8 行）。
 */

export interface Rng {
  /** [0,1) 均匀分布 */
  next(): number;
  /** [0, n) 整数 */
  int(n: number): number;
  /** [min, max] 闭区间整数 */
  between(min: number, max: number): number;
  /** 以 p 概率返回 true */
  chance(p: number): boolean;
  /** 从数组等概率取一个（空数组抛错，避免静默 undefined 污染样本） */
  pick<T>(items: readonly T[]): T;
  /** 原地洗牌副本 */
  shuffled<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    between(min: number, max: number) {
      if (max <= min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    chance: (p: number) => next() < p,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("Rng.pick: 空数组");
      return items[Math.floor(next() * items.length)] as T;
    },
    shuffled<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}

/** 由 seed 与文档序号派生一个稳定子 seed（避免不同文档共用同一条随机流） */
export function deriveSeed(baseSeed: number, docIndex: number): number {
  let h = (baseSeed ^ Math.imul(docIndex + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}
