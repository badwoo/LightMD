/**
 * v0.15.3 返修（缺陷 C）：把**每个顶层块的源码起始行**输出到阅读面 DOM。
 *
 * ## 为什么需要（这是「双击 Ctrl 切模式文档没有对齐」的根因修复之一）
 *
 * 跨面定位（`contentScrollMap`）靠 `BlockGeometry.sourceLine` 做**同源坐标系**对齐：
 * - iframe 预览面：`[data-src-line]`（贴标时写入）；
 * - 源码 textarea：`blockGeometryFromLineAxis` 的 `blockLines`；
 * - **PM 阅读面：之前完全没有** —— `collectPmBlockGeometry` 只填 `index/top/height`。
 *
 * 后果：从阅读面采集的 `ContentAnchor` 缺 `sourceLine`，于是
 * `resolveAnchorBlock` 的 ④ `resolveBySourceLine` 纠偏**永远不可用**、
 * `finalizeIndexMatch` 的辅助校验**永远直接放行**。一旦两侧 `blockIndex` 口径不同
 * （例如阅读面顶层多出 126 个"还原空行"的结构段落），定位就只能越走越偏，
 * 越界后一律退回百分比 —— 实测导致阅读面 `scrollTop` 31330 → 21898（偏 9432px）。
 *
 * ## 实现
 * 解析期 `parser.ts` 已用 `blockSourceMap` 把 `[start,end)` 源码区间记在每个顶层块上
 * （B6 原文切片快路径的同一张表，零额外成本）。本插件把它转成 `Decoration.node`
 * 的 `data-src-line` 属性，随 view 渲染直接落到 DOM —— 与 iframe 面 `data-src-line`
 * **同名同义**，`collectPmBlockGeometry` 直接读即可。
 *
 * ## 不变量
 * - **不碰文档内容**：只用 `Decoration.node`（纯属性装饰），doc 不变、不产生历史；
 * - **幂等**：装饰集按 `doc` 对象同一性缓存，同一 doc 只建一次；
 * - **bad-case 安全**：未命中 `blockSourceMap` 的块（用户新敲出来的块、
 *   或经过 `appendTransaction` 结构补位的块）**不写属性** → `sourceLine` 为
 *   `undefined`，调用方按"无源码坐标"处理（不会写入错误坐标）；
 * - 结构段落（`emptyLine` / `pad`）不写 `data-src-line`：前者不参与块索引，
 *   后者根本不对应任何源码行。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { getBlockSource } from "../markdown/blockSourceMap";

export const srcLineTagKey = new PluginKey("srcLineTag");

/** 顶层块是否需要被排除在"跨面块索引"之外（结构填充，不是真实渲染块） */
export function isStructuralFillBlock(node: PMNode): boolean {
  if (node.type.name !== "paragraph") return false;
  const attrs = node.attrs as { emptyLine?: boolean; pad?: boolean };
  return attrs.emptyLine === true || attrs.pad === true;
}

/**
 * 计算装饰集（纯函数，便于单测）。
 *
 * 只处理**顶层块**：跨面块索引只统计顶层块（`topLevelBlockStartLines`
 * 与 `root.children` 都是顶层口径）。
 */
export function computeSrcLineDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, offset, index) => {
    // v0.15.3：结构段落不参与跨面块索引 → 不贴源码行（避免把它们的行号混进口径）
    if (isStructuralFillBlock(node)) return;
    const info = getBlockSource(node);
    if (!info || !Number.isFinite(info.start)) return;
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, {
        "data-src-line": String(info.start),
        // 便于诊断/断言：顶层块序号（与 collectPmBlockGeometry 的 index 同口径，
        // 都不含结构段落）。注意它**不是** PM 的 childIndex（后者含结构段落）。
        "data-lmd-block-index": String(index),
      }),
    );
  });
  return DecorationSet.create(doc, decos);
}

/** 阅读面顶层块源码行贴标插件（零文档改动、零历史） */
export function srcLineTagPlugin(): Plugin {
  let cachedDoc: PMNode | null = null;
  let cached: DecorationSet = DecorationSet.empty;
  return new Plugin({
    key: srcLineTagKey,
    props: {
      decorations(state: EditorState): DecorationSet {
        // 按 doc 对象同一性缓存：PM 每按键换 doc，但纯选区变化不换
        if (cachedDoc === state.doc) return cached;
        cached = computeSrcLineDecorations(state.doc);
        cachedDoc = state.doc;
        return cached;
      },
    },
  });
}
