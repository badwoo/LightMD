/**
 * src/core/unified/model.ts —— 统一文档模型（UnifiedDoc）类型定义
 *
 * ## 职责边界
 *
 * 本文件在 P0-2（v0.17.0）**只冻结类型**，不含任何解析/序列化实现 ——
 * 实现归 B 线（`src/core/unified/*` 的构建器与出口适配）。
 *
 * 它回答一件事：**"这份 Markdown 到底是什么"** 有没有一个带源码区间的单一事实源。
 * 现状是四套出口各自从 `source` 字符串重新解析：
 * `markdownToDoc`（阅读面）、`renderMarkdownHtml`（预览/导出）、`exportBlocks`（DOCX/LaTeX/EPUB）、
 * `docToMarkdown`（写回）。四套解析器语义同构、实现异构，是序列化漂移的根源
 * （评估报告 §2.2 实测的"图片后缀双实现"就是同构异构的典型）。
 *
 * UnifiedDoc 的定位（设计稿 §2.1 要点 1）：**不替代 PM doc**。阅读模式继续用
 * ProseMirror；UnifiedDoc 只是"解析/序列化/导出的单一事实源"，PM doc ↔ UnifiedDoc
 * 通过 `PmSync` 双向映射（写回时只重序列化受影响的块，避免 DOM 编辑时全量
 * `docToMarkdown` 的 O(n) 惩罚）。
 *
 * ## 依赖方向
 *
 * ```
 * components/** → core/unified/model.ts（只读类型）
 * core/unified/*（B 线实现）→ model.ts
 * ```
 *
 * 本文件不 import 任何运行时模块（全部 `import type`），可被任何层安全引用。
 */

// ────────────────────────────────────────────────────────────────
// 节点种类
// ────────────────────────────────────────────────────────────────

/**
 * 语义节点的 kind 集合。
 *
 * 口径来源：`utils/exportBlocks.ts` 的 `Block` 判别联合（导出侧的既有 kind 集）
 * **加** PM schema 专有节点（`core/schema.ts` 中 `exportBlocks` 不产出的那些）。
 *
 * 为什么不直接复用 `Block["kind"]`：`Block` 是"导出口"的中间结构，缺少 PM 侧节点
 * （如 `toc` / `image` 作为独立块、`footnote` 容器）。UnifiedDoc 要同时喂两个出口，
 * 必须取**并集**；差异通过 `attrs` + `raw` 承载，不通过新增 kind 制造分叉。
 */
export type NodeKind =
  // ── 导出侧（exportBlocks.Block 的 kind 集）─────────────────
  | "heading"
  | "paragraph"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "defList"
  | "codeBlock"
  | "table"
  | "blockquote"
  | "hr"
  | "toc"
  | "mathBlock"
  // ── PM 侧专有（schema 有、exportBlocks 不单列的）────────────
  | "image"
  | "footnote"
  | "frontmatter"
  // ── 兜底：解析器无法归类时保留原文，绝不静默丢弃 ──────────
  | "unknown";

/** 源码区间（`UnifiedDoc.source` 的 UTF-16 偏移，**闭开区间** `[start, end)`） */
export interface MdSpan {
  start: number;
  end: number;
}

/**
 * 源码行区间（0 基，**闭区间** `[start, end]`）。
 *
 * 为什么与 `MdSpan` 口径不同：行区间直接来自 markdown-it 的 `token.map`（本身就是
 * 0 基闭区间的 `[startLine, endLine)` 语义 —— 注意 `map[1]` 是"末行 + 1"），
 * 而 `data-src-line` 贴标、滚动对齐、大纲都用**行号**。为避免两种"半开/闭"混淆，
 * 这里显式规定：`lines.start` 是块首行，`lines.end` 是**块末行**（含），
 * 由 `token.map[1] - 1` 换算而来。B1 实现必须遵守，测试需锁死。
 */
export interface MdLineRange {
  start: number;
  end: number;
}

/** 行内子树节点（含 marks）。与 `exportBlocks.InlineRun` 同构 —— 后者就是它的扁平化 */
export interface InlineNode {
  /** 文本内容（`text` / `softbreak` / `hardbreak` 等等） */
  text: string;
  /** 行内类型：文本、软/硬换行、图片、行内公式 */
  kind?: "text" | "softbreak" | "hardbreak" | "image" | "mathInline";
  /** 格式标记（对齐 `exportBlocks.InlineRun` 的布尔字段 + 链接） */
  marks?: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    code?: boolean;
    mark?: boolean;
    sub?: boolean;
    sup?: boolean;
    href?: string;
  };
  /** 行内源码区间（用于"只重序列化受影响行内段"的增量更新） */
  span?: MdSpan;
  /** 图片原始 src / 行内公式 LaTeX 源码 */
  payload?: string;
}

/**
 * 保真标记（设计稿 §6.2 / G5「保真四项」）。
 *
 * 为什么要它：Markdown 有大量**语义等价但写法不同**的形态（Setext 标题 vs ATX、
 * `*` vs `-` 列表符、对齐写法、末尾空行数）。往返序列化若无这些标记，就会
 * "语义正确但文本变形"，用户在文件里看到自己没写过的格式（保真失败的典型投诉）。
 */
export interface MdRaw {
  /** Setext 标题（`===` / `---` 下划线式）—— 序列化时必须写回下划线式 */
  setext?: boolean;
  /** 原始分隔符（列表 `*`/`-`/`+`、代码块 ``` 或 ~~~ 的长度等） */
  delim?: string;
  /** 末尾空行数（原本有 N 个，序列化后要保持 N 个） */
  trailingBlankLines?: number;
  /** 表格对齐写法原文（`|:--|--:|` 的原始形态，避免被规范化成默认形态） */
  alignSyntax?: string;
}

/**
 * 统一语义节点：带源码区间，是四出口（PM / HTML / DOCX-LaTeX-EPUB / 写回）共用的唯一树。
 *
 * 构建策略（设计稿 §2.3，B1 实现者必读）：**不自己写解析器**。
 * 构建 = `createMarkdownIt` 工厂 + 现有插件 → token 流 → `MdNode[]`，
 * 转换器是把 `exportBlocks.ts` 的 token→Block 逻辑扩展为"保留 span / lines / raw"。
 * 理由：markdown-it 已被 6 个版本的往返测试锤炼、插件齐备；`token.map` 天然提供
 * 行区间（`renderPipeline.ts` 已依赖此性质），字符区间由行区间 + 行首 offset 表推出。
 */
export interface MdNode {
  /** 节点种类 */
  kind: NodeKind;
  /** 源码字符区间（`UnifiedDoc.source` 的 UTF-16 偏移，闭开区间） */
  span: MdSpan;
  /** 源码行区间（0 基，块末行**含**，见 `MdLineRange` 的说明） */
  lines: MdLineRange;
  /**
   * 节点属性（`level` / `align` / `colspan` / `info` / `latex` / …）。
   *
   * 用 `Record<string, unknown>` 而不是判别联合的精细字段：不同 kind 的字段差异极大，
   * 用精细联合会让"读 attrs 的通用代码"（如大纲、导出遍历）到处断言。
   * 各 kind 的必需字段由 B1 的构建器测试锁死，本文件只保证形状可容纳。
   */
  attrs: Record<string, unknown>;
  /** 子块（容器节点：blockquote / 列表项等） */
  children?: MdNode[];
  /** 行内子树（含 marks）；叶子块才有 */
  inline?: InlineNode[];
  /** 原文写法标记（保真用，见 `MdRaw`） */
  raw?: MdRaw;
}

// ────────────────────────────────────────────────────────────────
// 源码位置索引
// ────────────────────────────────────────────────────────────────

/**
 * 块/行/偏移 双向索引。
 *
 * 三处共用同一份索引（现状是各自算各自的，这是跨面错位的温床）：
 * - 分屏对齐（`utils/blockScrollAlign`）：块 → 起始行 → 实测行盒顶部；
 * - 搜索 offsetMap（`utils/textOffsetRemap` / `SearchReplace`）：行号 ↔ 字符偏移；
 * - 撤销锚点（`services/documentHistory.SourceSelection`）：选区像素 → 偏移还原。
 *
 * 现状的 `topLevelBlockStartLines(markdown)`（`core/renderPipeline.ts:282`）就是
 * `blockStartLines` 的非模型化版本 —— B1 应让它成为本结构的唯一产出者，
 * 而不是再实现一遍。
 */
export interface SourcePosMap {
  /**
   * 顶层块 i 的源码起始行（升序；= `topLevelBlockStartLines` 的模型化）。
   *
   * ⚠️ 与 `MdNode.lines.start` 的对应关系必须由 B1 测试锁死：
   * 现状 `topLevelBlockStartLines` 只统计"一个 token 恰好产出一个顶层元素"的块
   * （见 `renderPipeline.ts:282` 与 `blockScrollAlign.ts:401` 的 `shouldTagPreview`
   * 数量自校验），UnifiedDoc 的顶层 `tree` 则可能包含更多节点。两者混用会让
   * `data-src-line` 贴标整体错位 —— 这是比"退回百分比映射"严重得多的后果。
   */
  blockStartLines: number[];
  /** 源码 offset → 顶层块下标（落在块间空白时归到前一块；首个块之前返回 -1） */
  blockAtOffset(off: number): number;
  /** 源码 offset → 行号（0 基） */
  lineAtOffset(off: number): number;
  /** 行号 → 该行首 offset（越界时钳到 `[0, source.length]`） */
  offsetOfLine(line: number): number;
}

// ────────────────────────────────────────────────────────────────
// UnifiedDoc
// ────────────────────────────────────────────────────────────────

/**
 * 统一文档：**唯一事实源**是 `source` 字符串，`tree` / `spm` 是懒构建的派生索引。
 *
 * ## 懒构建与失效（关键决策，设计稿 §2.3）
 *
 * 由 `DocStore` 持有（每 docKey 一份，LRU 40 与 `docHistoryStore.MAX_DOCS` 对齐）。
 * `source` 变化时只 `revision++` 并**标记 tree 脏**；`tree` 在**首次被出口请求**时
 * 构建（预览防抖之后、导出时、模式切换时）。因此 CM6 编辑期间**零解析成本** ——
 * 源码面输入延迟与文档大小脱钩，直接回应评估 §6.1 的"大文档无增量渲染"P0 项。
 *
 * ## 为什么 `source` 是 readonly
 *
 * 所有出口都从 `source` 读"当前文本"，不允许各自维护一份字符串状态（现状
 * `sourceContent` / `sourceContentRef` / `textarea.value` / `lastContentRef` 四份）。
 * 变更只能通过 DocStore 的更新入口产生新 revision —— 编译期就挡住"偷偷改一份副本"。
 *
 * ## 为什么 tree/spm 不是可选字段
 *
 * 若写成 `tree?: MdNode[]`，调用方就得处处判空，最终退化成"每次都重建"。
 * 本结构约定：**读 tree 的一律走 DocStore 的 getter**（内部完成懒构建），
 * 拿到的 `UnifiedDoc` 快照里 tree 一定已就绪。快照的 `revision` 用于失效判定。
 */
export interface UnifiedDoc {
  /** 唯一事实源（真实内容，**未 mask** —— mask 是 source 面对宿主层的展示优化） */
  readonly source: string;
  /** 顶层块 */
  readonly tree: MdNode[];
  /** 块/行/偏移双向索引 */
  readonly spm: SourcePosMap;
  /**
   * 语义代际：`source` 每变一次 +1；`tree`/`spm` 懒重建时**不变**
   * （重建是派生动作，不改变"文档是哪一版"这一事实）。
   *
   * 用途：出口适配层用它做缓存键（`RenderSync` 的 html 缓存、`PmSync` 的块级
   * 序列化缓存），避免"内容没变却重新渲染"。
   */
  readonly revision: number;
}
