// @vitest-environment jsdom
/**
 * v0.15.3 返修（缺陷 C）：跨面块索引「两把尺子」口径统一 + 源码行纠偏链路。
 *
 * ## 用户报告
 * 「以 `LightMD开发需求.md` 为例，双击 Ctrl 进行模式切换时文档没有对齐。」
 *
 * ## 根因（本文件要钉死的东西）
 * 跨面块定位用了**两把尺子**：
 * - 阅读面 PM 的 `collectPmBlockGeometry` 数 `root.children` → 用户文档 **429** 块；
 * - 另一侧（`topLevelBlockStartLines` / iframe `data-src-line` / 源码行轴）
 *   只数**真实渲染块** → **303** 块；
 * - 差的 **126** 个是解析器为**还原原文空行**造的空段落（段间 `\n\n\n` → gap=2 →
 *   多插 1 个；见 `parser.ts` 的"头部/块间空段落还原"与"末尾空行还原"）。
 * - 错位**逐块累积**，`blockIndex` 越走越偏，越界后只能退回百分比
 *   → 实测阅读面 `scrollTop` 31330 → 21898（偏 **9432px**）。
 *
 * ## 修复的四个面（本文件对应覆盖）
 * 1. `schema.ts`：paragraph 新增 `emptyLine`，`toDOM` 输出 `data-lmd-empty-line="1"`；
 * 2. `parser.ts`：四处造空段落的地方都传 `{ emptyLine: true }`；
 * 3. `src-line-tag.ts`：`computeSrcLineDecorations` 给每个**非结构**顶层块贴
 *    `data-src-line` / `data-lmd-block-index`；
 * 4. `contentScrollMap.ts`：`collectPmBlockGeometry` 默认跳过结构段落、并读
 *    `data-src-line` 填 `BlockGeometry.sourceLine`。
 *
 * ## 与实现核对后的偏差（以实现为准，已在此记录）
 * - `collectPmBlockGeometry` 的 DOM 判据**只认 `data-lmd-empty-line`**：
 *   `pad` 段落目前**没有** DOM 标记（`schema.paragraph.toDOM` 只输出 emptyLine 属性），
 *   所以"跳过 pad"在 DOM 层尚不可测。本文件的 A 组断言全部用 `markdownToDoc`
 *   （不经过 `trailingParagraphPlugin`，文档以 paragraph 结尾 → 无 pad），口径干净；
 *   DOM 层只覆盖 `emptyLine`。
 * - `SOURCE_LINE_TOLERANCE` 是 `contentScrollMap.ts` 的**模块内常量（值 1，未导出）**，
 *    C 组按字面量 1 写期望值（已注释标注来源，改动常量时该组必须同步改）。
 * - `Decoration.type` 在 prosemirror-view 的 d.ts 里是 `@internal`（不对外暴露），
 *   B 组读装饰属性时用局部类型断言 `as unknown as { type: { attrs } }`，不引入 any 泄漏。
 * - `computeSrcLineDecorations` 写入的 `data-lmd-block-index` **实际等于 PM 子节点下标
 *   （含结构段落）**，与插件注释"不含结构段落"不符；它是纯诊断属性
 *   （`collectPmBlockGeometry` 不读它、自己重新计数），故 B 组按**实现**断言并注明。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { topLevelBlockStartLines } from "../core/renderPipeline";
import { getBlockSource } from "../core/markdown/blockSourceMap";
import {
  computeSrcLineDecorations,
  srcLineTagPlugin,
} from "../core/plugins/src-line-tag";
import { isEmptyLineParagraph } from "../core/plugins/trailing-paragraph";
import {
  collectPmBlockGeometry,
  resolveAnchorBlock,
  type BlockGeometry,
} from "../utils/contentScrollMap";

// ═══════════════════════ 助手 ═══════════════════════

type TopLevel = { node: PMNode; offset: number; index: number };

/** 顶层块列表（与 `doc.childCount` / `doc.forEach` 同口径） */
function topLevel(doc: PMNode): TopLevel[] {
  const out: TopLevel[] = [];
  doc.forEach((node, offset, index) => out.push({ node, offset, index }));
  return out;
}

/** 该段落是否为"解析期还原原文空行"的结构段落（`emptyLine === true`） */
function isEmptyLine(node: PMNode): boolean {
  return node.type.name === "paragraph" && node.attrs.emptyLine === true;
}

/** 结构填充段落数（`emptyLine`；纯 `markdownToDoc` 路径不会出现 pad） */
function emptyLineCount(doc: PMNode): number {
  return topLevel(doc).filter((t) => isEmptyLine(t.node)).length;
}

/** 阅读面口径：非结构顶层块数（= 跨面块索引应看到的块数） */
function nonStructuralCount(doc: PMNode): number {
  return doc.childCount - emptyLineCount(doc);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
/** 用户真实文档（缺陷 C 的原始复现样本；不存在时整组 skip） */
const USER_DOC = join(repoRoot, "..", "LightMD开发需求.md");

function userDocMarkdown(): string | null {
  return existsSync(USER_DOC) ? readFileSync(USER_DOC, "utf-8") : null;
}

/** 构造一侧块表：sourceLine 升序、几何合法（`visible` 为真） */
function mkTable(sourceLines: number[]): BlockGeometry[] {
  return sourceLines.map((sourceLine, index) => ({
    index,
    top: index * 100,
    height: 80,
    visible: true,
    sourceLine,
  }));
}

/** 读 decoration 的 attrs（`Decoration.type` 是 PM 内部字段，d.ts 未公开） */
type DecoWithAttrs = {
  from: number;
  to: number;
  type: { attrs?: Record<string, string | undefined> };
};

function decoAttrsByOffset(doc: PMNode): Map<number, Record<string, string | undefined>> {
  const set = computeSrcLineDecorations(doc);
  const spans = set.find() as unknown as DecoWithAttrs[];
  const out = new Map<number, Record<string, string | undefined>>();
  for (const span of spans) out.set(span.from, span.type.attrs ?? {});
  return out;
}

/** 给 jsdom 元素打桩一个非零 rect（jsdom 无布局，默认全 0 → height 0） */
function stubRect(el: Element, height: number, top: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: top,
      top,
      left: 0,
      bottom: top + height,
      right: 100,
      width: 100,
      height,
      toJSON: () => ({}),
    }),
  });
}

// ═══════════════ A. 尺子统一（纯函数层，真实 parser / renderPipeline）══════════════════

describe("A · 尺子统一：PM 非结构块数 === 另一侧 topLevelBlockStartLines 数", () => {
  /**
   * A1：为什么是这条断言 —— 缺陷 C 的全部根因就是"两侧块数不等且逐块累积错位"。
   * 只要这个等式成立，`blockIndex` 就是**同一个块**的坐标，跨面定位不再累积偏移。
   *
   * 构造：`甲\n\n\n乙`（段间 2 空行 → gap=2 → 多插 1 个空段落）。
   * 文档以 paragraph 结尾、且不走 trailingParagraphPlugin → 不会出现 pad，
   * 因此"childCount - emptyLine 段数"直接就是非结构块数，断言干净。
   */
  it("段间 \n\n\n 文档：emptyLine 段数 > 0（且 childCount - 空行段数 === 顶层渲染块数）", () => {
    const md = ["甲", "", "", "乙", "", "", "丙", "", "丁", ""].join("\n");
    // 源码行：0 甲 / 1,2 空 / 3 乙 / 4,5 空 / 6 丙 / 7 空 / 8 丁
    const doc = markdownToDoc(md);
    expect(doc.childCount).toBe(6);
    expect(emptyLineCount(doc)).toBe(2); // 两个"2 空行"间隔各多 1 段
    expect(nonStructuralCount(doc)).toBe(4); // 甲 乙 丙 丁
    // ★ 口径相等的正面断言（缺陷 C 的验收条件）
    expect(nonStructuralCount(doc)).toBe(topLevelBlockStartLines(md).length);
    // 结构段落确实是"空段落"：没有文本内容（证明它们不是真实渲染块）
    for (const t of topLevel(doc)) {
      if (isEmptyLine(t.node)) expect(t.node.textContent).toBe("");
    }
  });

  /**
   * A2：`\n\n`（正常单空行分隔）**不得**被打上 emptyLine。
   * 为什么必须锁：解析器只应在 gap>1（即源码里真有连续 2+ 空行）时还原空段落。
   * 若把正常段间隔也标记成结构段落，阅读面会**漏掉真实段落**的块索引
   * （比原来更糟：不是偏移，是整块丢失）。
   */
  it("段间 \n\n（单空行）文档：不产生 emptyLine 段落（回归锁：别把所有空段落都标记）", () => {
    const md = ["甲", "", "乙", "", "丙", ""].join("\n");
    const doc = markdownToDoc(md);
    expect(doc.childCount).toBe(3);
    expect(emptyLineCount(doc)).toBe(0);
    expect(nonStructuralCount(doc)).toBe(topLevelBlockStartLines(md).length);
  });

  /**
   * A3：用户真实文档（缺陷 C 的原始复现样本）。
   * 修复前：PM 顶层 429 块（含 126 个还原空行的结构段落），另一侧 303 块 → 等式不成立。
   * 修复后必须相等（实测 303）。存在则跑、不存在则 skip（CI/其它机器上不误报）。
   */
  const userMd = userDocMarkdown();
  it.skipIf(!userMd)(
    "用户真实文档 LightMD开发需求.md：PM 非结构块数 === 顶层块表数（实测 303，修复前 429≠303）",
    () => {
      const md = userMd as string;
      const doc = markdownToDoc(md);
      expect(doc.childCount).toBeGreaterThan(0);
      // 该文档确实用了大量"2 空行"分段 → 确实存在结构段落（否则本断言无意义）
      expect(emptyLineCount(doc)).toBeGreaterThan(0);
      expect(nonStructuralCount(doc)).toBe(topLevelBlockStartLines(md).length);
      // 修复的量化证据：被剔除的结构段落数 > 0，且剔除后才与另一侧同口径
      expect(doc.childCount - emptyLineCount(doc)).toBe(303);
      expect(emptyLineCount(doc)).toBe(126);
      expect(doc.childCount).toBe(429);
    },
  );
});

// ═══════════════ B. 贴标与 collect（jsdom DOM 层）══════════════════

describe("B · 贴标与几何采集：只有非结构块带 data-src-line / 采集时跳过结构段落", () => {
  /**
   * B4：为什么断言"每个非结构顶层块都有 data-src-line 且值 === blockSource.start" ——
   * 这是跨面纠偏的**权威坐标**。之前 PM 面完全没有 sourceLine，
   * 于是 `finalizeIndexMatch` 永远直接放行、`resolveBySourceLine` 兜底永远不可用。
   * 值必须与解析期记录的源码起始行**逐块一致**，否则纠偏会把位置拉到错误块。
   *
   * 结构段落（emptyLine）必须**没有**该属性：它们不对应任何真实顶层渲染块。
   * 注意它们**也有** blockSource（parser 为还原空行记录的行区间）——
   * 所以"没有贴标"必须是**主动跳过**的结果，而不是"恰好没记录源码"。
   */
  it("computeSrcLineDecorations：非结构顶层块逐块贴 data-src-line（值 === getBlockSource().start），结构段落不贴", () => {
    const md = ["甲", "", "", "乙", "", "丙", ""].join("\n");
    const doc = markdownToDoc(md);
    const attrs = decoAttrsByOffset(doc);
    const nodes = topLevel(doc);

    const structural = nodes.filter((t) => isEmptyLine(t.node));
    expect(structural.length).toBeGreaterThan(0); // 本样本确实含结构段落

    let tagged = 0;
    for (const t of nodes) {
      const deco = attrs.get(t.offset);
      const info = getBlockSource(t.node);
      if (isEmptyLine(t.node)) {
        expect(deco, "结构段落不应贴 data-src-line").toBeUndefined();
        // 反证：它们其实有解析期源码区间（跳过是主动行为，不是"没数据"）
        expect(info).toBeDefined();
        continue;
      }
      expect(deco, "每个非结构顶层块都必须贴 data-src-line").toBeDefined();
      expect(info, "非结构顶层块应有解析期源码区间").toBeDefined();
      expect(Number(deco!["data-src-line"])).toBe((info as { start: number }).start);
      /**
       * 诊断属性 `data-lmd-block-index`：**以实现为准**它等于 `doc.forEach`
       * 的 PM 子节点下标（**含**结构段落），并非插件注释所称的"不含结构段落"。
       * 它只是诊断信息（`collectPmBlockGeometry` 自己重新计数、不读它），
       * 不影响跨面口径 —— 这里按实现断言，避免测试把错误注释固化成契约。
       */
      expect(Number(deco!["data-lmd-block-index"])).toBe(t.index);
      tagged++;
    }
    expect(tagged).toBe(nonStructuralCount(doc));
  });

  /**
   * B4b：贴标必须**真的落到 DOM**（而不只是生在 Decoration 对象里）。
   * 为什么：`collectPmBlockGeometry` 只读 DOM 属性；若 `Decoration.node` 的
   * from/to 与顶层块位置错位，PM 会静默丢弃该装饰（valid() 失败），
   * 数据层断言仍然通过但线上属性全无 —— 那正是"修复看起来做了、实际没生效"。
   */
  it("srcLineTagPlugin 接进真实 EditorView 后，DOM 上确实出现非结构块数量的 data-src-line", () => {
    const md = ["甲", "", "", "乙", "", "丙", ""].join("\n");
    const doc = markdownToDoc(md);
    const mount = document.createElement("div");
    const view = new EditorView({ mount }, {
      state: EditorState.create({ doc, plugins: [srcLineTagPlugin()] }),
    });
    try {
      const tagged = view.dom.querySelectorAll("p[data-src-line]");
      expect(tagged.length).toBe(nonStructuralCount(doc));
      // 结构段落不得带属性（否则 collectPmBlockGeometry 跳过判据会漏块/多块）
      const structuralInDom = view.dom.querySelectorAll("p[data-lmd-empty-line='1']");
      expect(structuralInDom.length).toBe(emptyLineCount(doc));
      for (const el of Array.from(tagged)) {
        expect(el.getAttribute("data-src-line")).toMatch(/^\d+$/);
        expect(Number(el.getAttribute("data-src-line"))).toBeGreaterThanOrEqual(0);
      }
      // 属性值必须与解析期源码区间同源（抽查首块：源码行 0）
      expect(tagged[0].getAttribute("data-src-line")).toBe("0");
    } finally {
      view.destroy();
    }
  });

  /**
   * B5：`collectPmBlockGeometry` 的三件套断言（数量 / index / sourceLine）。
   * - 默认 `skipStructuralFill: true` → 跳过 `data-lmd-empty-line` 元素，
   *   数量 === 非结构子元素数（跨面口径统一）；
   * - 每个块的 `sourceLine` === 该元素 `data-src-line`（纠偏链路的输入）；
   * - 显式 `skipStructuralFill: false` → **不跳过**（回归锁：默认值必须生效、
   *   显式关闭能还原旧行为，便于排查线上旧路径）。
   *
   * jsdom 无布局：默认 rect 全 0（height=0 → visible=false）。为不误判"因 height
   * 被跳过"，这里用 `getBoundingClientRect` 打桩给每个子元素非零高度。
   * 但仍**不断言** height/top（实现里 top 与 scrollTop 的组合口径不是本测试的点）。
   */
  it("collectPmBlockGeometry：默认跳过结构段落（数量/index/sourceLine 正确），显式 false 时不跳过", () => {
    // 子元素序列：h2(源码行 0) / p 结构 / p(2) / p 结构 / p(4)
    const children: Array<{ tag: string; attrs: Record<string, string> }> = [
      { tag: "h2", attrs: { "data-src-line": "0", "data-lmd-block-index": "0" } },
      { tag: "p", attrs: { "data-lmd-empty-line": "1" } },
      { tag: "p", attrs: { "data-src-line": "2", "data-lmd-block-index": "1" } },
      { tag: "p", attrs: { "data-lmd-empty-line": "1" } },
      { tag: "p", attrs: { "data-src-line": "4", "data-lmd-block-index": "2" } },
    ];
    const scroller = document.createElement("div");
    const root = document.createElement("div");
    root.className = "ProseMirror";
    children.forEach((c, i) => {
      const el = document.createElement(c.tag);
      for (const [k, v] of Object.entries(c.attrs)) el.setAttribute(k, v);
      stubRect(el, 80, i * 80); // 避免 height=0 干扰"是否被跳过"的判断
      root.appendChild(el);
    });
    scroller.appendChild(root);
    stubRect(scroller, 400, 0);

    // ── 默认：跳过结构段落 ──
    const blocks = collectPmBlockGeometry(scroller);
    expect(blocks).not.toBeNull();
    const def = blocks as BlockGeometry[];
    expect(def.length).toBe(3); // 非结构子元素数
    expect(def.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(def.map((b) => b.sourceLine)).toEqual([0, 2, 4]);
    for (const b of def) expect(Number.isFinite(b.sourceLine as number)).toBe(true);
    // 打桩 rect 被真实读到（height=80）：证明"跳过"是**判据命中**，
    // 而不是 jsdom 里 height=0 被 `rect.height >= 0` / `visible` 逻辑顺带丢掉
    expect(def[0].height).toBe(80);
    expect(def[0].visible).toBe(true);

    // ── 显式关闭：还原旧行为（含结构段落，sourceLine 缺失） ──
    const all = collectPmBlockGeometry(scroller, { skipStructuralFill: false }) as BlockGeometry[];
    expect(all.length).toBe(children.length);
    expect(all.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
    const structuralBlocks = [all[1], all[3]];
    for (const b of structuralBlocks) expect(b.sourceLine).toBeUndefined();
    // 非结构块即便在旧口径下也有 sourceLine（贴标与跳过是两件独立的事）
    expect(all[2].sourceLine).toBe(2);
  });
});

// ═══════════════ C. 纠偏链路真正可用（纯函数层）══════════════════

describe("C · resolveAnchorBlock：sourceLine 纠偏把错位的 blockIndex 拉回正确块", () => {
  const TARGET = mkTable([0, 2, 4, 6, 8]); // 另一侧口径：5 个真实块

  /**
   * C6：为什么这是缺陷 C 的"修复生效"证据 ——
   * 阅读面口径下（含 1 个额外的结构块位置）同一个真实块的下标是 3，
   * 而目标侧下标 3 的块是源码行 6 的块。两把尺子不一致时：
   * - 若锚点**没有** sourceLine（修复前的 PM 面）→ 直接按 index 命中错误块 **6**；
   * - 有 sourceLine 后 → `finalizeIndexMatch` 发现 |6-4|>容差，按源码行反查 → 块 **4**。
   * 两条断言成对出现，正面锁住"纠偏真的把结果拉回来了"，而不是"恰好没走这条路"。
   */
  it("同一真实块的阅读面下标 3 vs 目标侧下标 3：有 sourceLine → 拉回源码行 4 的块（无 sourceLine 则错到 6）", () => {
    // 无 sourceLine（= 修复前行为）：落到目标侧 index 3，即源码行 6 的块 —— 错位
    const broken = resolveAnchorBlock(TARGET, {
      blockIndex: 3,
      ratioWithinBlock: 0.5,
    });
    expect(broken).not.toBeNull();
    expect(broken!.via).toBe("index");
    expect(broken!.block.sourceLine).toBe(6);

    // 有 sourceLine：纠偏按源码行命中正确块（源码行 4 的块）
    const fixed = resolveAnchorBlock(TARGET, {
      blockIndex: 3,
      sourceLine: 4,
      ratioWithinBlock: 0.5,
    });
    expect(fixed).not.toBeNull();
    expect(fixed!.via).toBe("source-line"); // 走了纠偏/兜底，而不是直接放行
    expect(fixed!.block.sourceLine).toBe(4); // ★ 拉回正确块
    expect(fixed!.block.index).toBe(2);
    // 跨块纠偏一律 ratio=0（不臆造块内位置；见 resolveAnchorBlock 注释）
    expect(fixed!.ratio).toBe(0);
  });

  /**
   * C7（容差内）：`SOURCE_LINE_TOLERANCE = 1`（模块内常量，未导出）。
   * 空行/软换行可能让同一块的起始行漂 1 行，这属于"同一块"，必须**保留 index 命中**
   * 与块内比例（否则每次切模式都按源码行插值，视口会在块内抖）。
   */
  it("sourceLine 与命中块的源码行相差 ≤1（容差内）：仍走 index 且保留块内比例", () => {
    const res = resolveAnchorBlock(TARGET, {
      blockIndex: 2,
      sourceLine: 5, // 目标块 index 2 的源码行是 4 → 差 1，在容差内
      ratioWithinBlock: 0.5,
    });
    expect(res).not.toBeNull();
    expect(res!.via).toBe("index");
    expect(res!.block.index).toBe(2);
    expect(res!.block.sourceLine).toBe(4);
    expect(res!.ratio).toBeCloseTo(0.5, 6); // 块内比例必须保留
  });

  /**
   * C7（差得很远 / 下标越界）：两条兜底路径都要按源码行命中。
   * - 容差外 → `finalizeIndexMatch` 改用源码行（且只在"更接近"时替换）；
   * - blockIndex 越界（阅读面 429 > 目标侧 303 的线上形态）→ ④ `resolveBySourceLine`。
   */
  it("sourceLine 与命中块相差 >1 / blockIndex 越界：按源码行兜底命中正确块", () => {
    // 容差外：index 0 的块源码行是 0，锚点要 8 → 反查到源码行 8 的块
    const far = resolveAnchorBlock(TARGET, {
      blockIndex: 0,
      sourceLine: 8,
      ratioWithinBlock: 0.2,
    });
    expect(far).not.toBeNull();
    expect(far!.via).toBe("source-line");
    expect(far!.block.sourceLine).toBe(8);

    // 下标越界（线上 429 vs 303 的形态）：绝不返回 null 之外的东西，且必须落到正确块
    const oob = resolveAnchorBlock(TARGET, {
      blockIndex: 99,
      sourceLine: 4,
      ratioWithinBlock: 0.3,
    });
    expect(oob).not.toBeNull();
    expect(oob!.via).toBe("source-line");
    expect(oob!.block.sourceLine).toBe(4);
    expect(oob!.block.index).toBe(2);

    // 越界且无 sourceLine → 无法映射必须返回 null（绝不 0/首块兜底造成"进度归零"）
    expect(
      resolveAnchorBlock(TARGET, { blockIndex: 99, ratioWithinBlock: 0.3 }),
    ).toBeNull();
  });
});

// ═══════════════ D. 序列化不能丢内容（emptyLine 与 pad 的关键区别）══════════════════

describe("D · emptyLine 必须参与序列化（与 pad 相反）", () => {
  /**
   * D8：为什么这是回归锁 —— 修复的"跳过结构段落"只作用于**跨面块索引**，
   * 绝不能顺手把它们从 Markdown 里吃掉：`emptyLine` 代表原文空行，
   * 丢它就是**丢用户内容**（`pad` 才是结构补位、serde 跳过）。
   * 往返断言用最强形式：序列化结果**逐字节等于原文**。
   *
   * 注意：这里刻意不改 `src/`——`docToMarkdown` 走 B6 原文切片快路径，
   * 结构段落带 blockSource 且行号连续，因此原文必然原样返回。
   */
  it("含 \n\n\n 的文档 markdownToDoc → docToMarkdown 往返逐字节相等（空行未被吃掉）", () => {
    const md = ["甲", "", "", "乙", "", "丙", ""].join("\n");
    const doc = markdownToDoc(md);
    expect(emptyLineCount(doc)).toBeGreaterThan(0); // 样本确实含结构段落
    expect(docToMarkdown(doc)).toBe(md);

    // 末尾连续空行同理（末尾空行还原段落也带 emptyLine）
    const tailMd = "段落\n\n\n";
    const tailDoc = markdownToDoc(tailMd);
    expect(emptyLineCount(tailDoc)).toBeGreaterThan(0);
    expect(docToMarkdown(tailDoc)).toBe(tailMd);

    // 二次往返仍稳定（防止"每次编辑多一个空行"这类累积漂移）
    const twice = docToMarkdown(markdownToDoc(docToMarkdown(markdownToDoc(md))));
    expect(twice).toBe(md);
  });

  /**
   * D9：`isEmptyLineParagraph` 的判据必须**只认 emptyLine**（与 pad 区分）。
   * 为什么：`trailing-paragraph.ts` 用它在 `appendTransaction` 里清掉"已有内容"
   * 的 emptyLine 标记；若它把普通段落/pad 段落也判成 true，
   * 会把用户内容段落的标记乱摘（或把 pad 当空行保留），两套结构标记语义就混了。
   */
  it("isEmptyLineParagraph：emptyLine 段落 true / 普通空段落 false / pad 段落 false / 正文段落 false", () => {
    const p = schema.nodes.paragraph;
    expect(isEmptyLineParagraph(p.create({ emptyLine: true }))).toBe(true);
    expect(isEmptyLineParagraph(p.create())).toBe(false);
    expect(isEmptyLineParagraph(p.create({ pad: true }))).toBe(false);
    expect(isEmptyLineParagraph(p.create(null, schema.text("正文")))).toBe(false);
    // 非段落块（标题）也为 false（函数按 type.name === "paragraph" 收窄）
    expect(isEmptyLineParagraph(schema.nodes.heading.create({ level: 1 }))).toBe(false);

    // 与解析器产物一致：文本段落不是 emptyLine，还原空行的段落是
    const doc = markdownToDoc(["甲", "", "", "乙", ""].join("\n"));
    const nodes = topLevel(doc).map((t) => t.node);
    expect(nodes.filter(isEmptyLineParagraph).length).toBe(emptyLineCount(doc));
    // 有正文的段落绝不能被判成 emptyLine（否则 appendTransaction 会乱摘标记）
    const textParagraphs = nodes.filter(
      (n) => n.type.name === "paragraph" && n.textContent !== "",
    );
    expect(textParagraphs.length).toBeGreaterThan(0);
    expect(textParagraphs.some(isEmptyLineParagraph)).toBe(false);
  });
});
