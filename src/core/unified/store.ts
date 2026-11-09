/**
 * src/core/unified/store.ts —— UnifiedDoc 的持有者（DocStore）。
 *
 * 设计稿 §2.3「懒构建与失效」的落地：
 * - 每 `docKey` 一份 `UnifiedDoc`，LRU 40（与 `services/docHistoryStore.MAX_DOCS`
 *   对齐，迁移期两边口径一致）。
 * - `source` 变化只 `revision++` 并**标记 tree 脏**；tree 在**首次被出口请求**时
 *   才构建（预览防抖后、导出时、模式切换时）。
 * - 因此 CM6 编辑期间**零解析成本** —— 源码面输入延迟与文档大小脱钩，
 *   直接回应评估 §6.1「大文档无增量渲染」的 P0 项。
 *
 * ## 缓存键为什么必须含 paragraphBreaks
 *
 * `paragraphBreaks`（gfm / commonmark）决定**同一份源码**的解析结果不同：
 * gfm 下裸换行 = `<br>`（hardbreak），commonmark 下 = 空格。
 * 若缓存键只有 `docKey + revision`，用户切换设置后仍会拿到**旧语义的树** →
 * 预览/导出"所见非所得"（这是设计稿复检第 7 条点名补的疏漏）。
 *
 * ## 与 React 数据流的关系（设计稿 §3.4 C1 的定位修正）
 *
 * DocStore 是**EditorContainer 内部的权威缓存层**，不是 React 数据流的替代。
 * 所有写路径仍镜像走既有 `setSourceContent` + `onContentChangeRef` 通知链
 * （App 层 content state 回路、useAutoSave、脏标记全不动）。
 * 让 DocStore 取代 React state 会牵动 App.tsx 全链路重写，超出本版风险预算。
 */

import { parseUnified, type UnifiedParseResult } from "./parse";
import type { MdNode, SourcePosMap, UnifiedDoc } from "./model";

/** LRU 上限，与 `services/docHistoryStore.MAX_DOCS = 40` 对齐 */
export const MAX_DOCS = 40;

/** 段内换行语义（缓存键的一部分） */
export type ParagraphBreaks = "gfm" | "commonmark";

/**
 * DocStore 的缓存条目。
 *
 * `doc` 是**快照**：`tree`/`spm` 在构建后不可变（source 变了就换新快照），
 * 这让出口适配层可以安全持有引用做缓存（不需要每次判空）。
 */
interface Entry {
  docKey: string;
  /** 构建时的 source（用于判断"是否真的变了"） */
  source: string;
  revision: number;
  paragraphBreaks: ParagraphBreaks;
  /** 已构建的解析结果（懒建：首次 get 时才填） */
  parsed: UnifiedParseResult | null;
  /** 对外暴露的快照（含已就绪的 tree/spm） */
  doc: UnifiedDoc | null;
}

/** 一次 get 的返回值：doc 保证 tree/spm 已就绪 */
export interface DocSnapshot extends UnifiedDoc {
  /** 未映射 token 类型（导出"部分内容无法导出"提示用） */
  readonly unknownTokens: string[];
  /** 标题列表（[toc] / 大纲共用） */
  readonly headings: UnifiedParseResult["headings"];
  /** 文档级 raw（尾部空行数等） */
  readonly raw: UnifiedParseResult["raw"];
}

function makeDoc(e: Entry, parsed: UnifiedParseResult): DocSnapshot {
  return {
    source: e.source,
    tree: parsed.tree,
    spm: parsed.spm,
    revision: e.revision,
    unknownTokens: parsed.unknownTokens,
    headings: parsed.headings,
    raw: parsed.raw,
  };
}

/** 供 spm 复用（避免重复 parse） */
export type { SourcePosMap, MdNode };

class DocStoreImpl {
  private entries = new Map<string, Entry>();
  /** 访问顺序（LRU 用；Map 的迭代顺序本身是插入序，命中时需重插到末尾） */
  private readonly limit: number;

  constructor(limit = MAX_DOCS) {
    this.limit = limit;
  }

  /**
   * 更新（或首次登记）某文档的 source。
   *
   * **只在 source 真的变了**才 `revision++`；同文本重复 set 是幂等的
   * （避免"每秒 setText 几十次"把 revision 刷到无意义的大数，导致下游缓存全失效）。
   */
  update(docKey: string, source: string, opts?: { paragraphBreaks?: ParagraphBreaks }): DocSnapshot {
    const breaks = opts?.paragraphBreaks ?? this.entries.get(docKey)?.paragraphBreaks ?? "gfm";
    const existing = this.entries.get(docKey);

    if (existing && existing.source === source && existing.paragraphBreaks === breaks) {
      // 完全没变：命中缓存（懒建也可能还没建 → 交给下面的 getOrBuild）
      this.touch(docKey);
      return this.getOrBuild(docKey, source, breaks, existing.revision);
    }

    // revision++ 的两种触发条件合并成**一次 +1**：
    //   ① source 变了；② paragraphBreaks 变了（它改变解析语义，
    //   下游渲染 html 缓存 / PmSync 序列化缓存必须跟着失效）。
    // 不能各 +1 一次（那会让 revision 跳号，且"变一个维度 = 一代"的语义被破坏）。
    const nextRevision = existing ? existing.revision + 1 : 0;
    this.entries.set(docKey, {
      docKey,
      source,
      revision: nextRevision,
      paragraphBreaks: breaks,
      parsed: null,
      doc: null,
    });
    this.evictIfNeeded();
    return this.getOrBuild(docKey, source, breaks, nextRevision);
  }

  /** 只登记 source、不触发解析（编辑期高频调用：只要 revision 推进，不解析） */
  touchSource(docKey: string, source: string, opts?: { paragraphBreaks?: ParagraphBreaks }): number {
    const breaks = opts?.paragraphBreaks ?? this.entries.get(docKey)?.paragraphBreaks ?? "gfm";
    const existing = this.entries.get(docKey);
    if (existing && existing.source === source && existing.paragraphBreaks === breaks) {
      this.touch(docKey);
      return existing.revision;
    }
    // 同 update：两种触发条件合并成一次 +1
    const nextRevision = existing ? existing.revision + 1 : 0;
    // 关键：这里**不解析**（parsed/doc 留空），保持编辑期零解析成本
    this.entries.set(docKey, {
      docKey,
      source,
      revision: nextRevision,
      paragraphBreaks: breaks,
      parsed: null,
      doc: null,
    });
    this.evictIfNeeded();
    return nextRevision;
  }

  /**
   * 取快照（**唯一读取入口**）。tree/spm 在此懒构建。
   *
   * 为什么读口只给这一个：设计稿 §2.3 明确"读 tree 的一律走 DocStore 的 getter"，
   * 拿到的快照里 tree 一定已就绪，调用方不必处处判空（否则会退化成"每次都重建"）。
   */
  get(docKey: string): DocSnapshot | null {
    const e = this.entries.get(docKey);
    if (!e) return null;
    this.touch(docKey);
    return this.getOrBuild(docKey, e.source, e.paragraphBreaks, e.revision);
  }

  /** 已登记的 revision（不触发解析）；未登记返回 null */
  revisionOf(docKey: string): number | null {
    return this.entries.get(docKey)?.revision ?? null;
  }

  /** 是否已有构建好的快照（不触发解析；用于"要不要重新渲染"的判定） */
  hasBuilt(docKey: string): boolean {
    const e = this.entries.get(docKey);
    return !!e && e.parsed !== null;
  }

  /** 删除某文档（关闭标签时调用，防止 LRU 里留死数据） */
  delete(docKey: string): boolean {
    return this.entries.delete(docKey);
  }

  /** 清空（测试 / clearAll） */
  clear(): void {
    this.entries.clear();
  }

  /** 当前条目数与键（测试 / 诊断用） */
  size(): number {
    return this.entries.size;
  }
  keys(): string[] {
    return [...this.entries.keys()];
  }

  // ── 内部 ──

  private getOrBuild(docKey: string, source: string, breaks: ParagraphBreaks, revision: number): DocSnapshot {
    const e = this.entries.get(docKey)!;
    if (!e.parsed || !e.doc) {
      e.parsed = parseUnified(source, {
        breaks: breaks === "gfm",
      });
      e.doc = makeDoc(e, e.parsed);
    }
    return makeDoc(e, e.parsed);
  }

  /** LRU：命中时把条目移到末尾（Map 迭代序即 LRU 序） */
  private touch(docKey: string): void {
    const e = this.entries.get(docKey);
    if (!e) return;
    this.entries.delete(docKey);
    this.entries.set(docKey, e);
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** 全局单例（与 docHistoryStore 的定位一致：跨组件共享的权威缓存） */
export const docStore = new DocStoreImpl();

/** 测试用：新建独立实例（避免用例间互相污染全局单例） */
export function createDocStore(limit = MAX_DOCS): DocStoreImpl {
  return new DocStoreImpl(limit);
}

export type { DocStoreImpl };
