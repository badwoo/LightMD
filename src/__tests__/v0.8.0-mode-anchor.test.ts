/**
 * v0.8.0 WP5 修复3：模式切换编辑锚点优先定位
 *
 * 背景：模式切换（预览↔源码，含分屏）后恢复滚动位置时只按滚动百分比恢复，
 * 但若在编辑中途切换模式，光标所在"行"与百分比对应的行可能错位，体感跳动。
 *
 * 修复：编辑时记录"编辑锚点行号"（anchorLine，源码 markdown 行号），
 * 切换模式后 applyScroll 优先用锚点定位（预览：行号→doc pos→coordsAtPos
 * 落到视口上 1/3；源码：行号→字符偏移→measureTextareaCursorY），无锚点回退百分比。
 *
 * 验收：锚点行号→偏移/pos 映射正确且越界安全（sourceLineToPos、docBlockLineToPos）；
 *      fileScrollProgress 数据结构扩为含 anchorLine 且既有百分比 API 兼容。
 */
import { describe, it, expect, afterEach } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { sourceLineToPos, docBlockLineToPos } from "../components/editor/EditorContainer";
import { fileScrollProgress } from "../services/fileScrollProgress";
import type { Node as PMNode } from "prosemirror-model";

describe("v0.8.0 修复3：sourceLineToPos 行号→字符偏移", () => {
  it("多行长短不一：每行起始偏移精确", () => {
    const text = "a\nbb\nccc";
    // 行0: 0 | 行1: "a\n"=2 | 行2: "a\nbb\n"=5
    expect(sourceLineToPos(text, 0)).toBe(0);
    expect(sourceLineToPos(text, 1)).toBe(2);
    expect(sourceLineToPos(text, 2)).toBe(5);
  });

  it("空字符串返回 0", () => {
    expect(sourceLineToPos("", 0)).toBe(0);
    expect(sourceLineToPos("", 3)).toBe(0);
  });

  it("行号越界：钳制到末行起始，不越界", () => {
    const text = "a\nbb\nccc"; // 末行起始 = 5
    expect(sourceLineToPos(text, 99)).toBe(5);
    expect(sourceLineToPos(text, 2)).toBe(5);
  });
});

describe("v0.8.0 修复3：docBlockLineToPos 行号→doc pos", () => {
  /** 构造含单段 + 多行代码块 + 单段的 doc，行号：p0=0, 代码块=1~3, p2=4 */
  function buildDoc(): PMNode {
    return markdownToDoc("p0\n\n```\na\nb\nc\n```\n\np2\n");
  }

  it("命中块首行→返回该块 pos（不为 null）", () => {
    const doc = buildDoc();
    expect(docBlockLineToPos(doc, 0)).not.toBeNull(); // p0
    expect(docBlockLineToPos(doc, 4)).not.toBeNull(); // p2
  });

  it("命中块内行→返回该块 pos（代码块内行 2 映射到代码块）", () => {
    const doc = buildDoc();
    const posInBlock = docBlockLineToPos(doc, 2);
    expect(posInBlock).not.toBeNull();
    // 不同行的 pos 单调递增，证明映射到不同/正确块位置
    const pos0 = docBlockLineToPos(doc, 0)!;
    const pos4 = docBlockLineToPos(doc, 4)!;
    expect(pos0).toBeLessThan(posInBlock!);
    expect(posInBlock!).toBeLessThan(pos4);
  });

  it("行号越界→返回 null（调用方回退百分比）", () => {
    const doc = buildDoc();
    expect(docBlockLineToPos(doc, 50)).toBeNull();
  });
});

describe("v0.8.0 修复 P1-2：fileScrollProgress 回归纯百分比存储", () => {
  const path = "__mode_anchor_test_path__";
  afterEach(() => fileScrollProgress.clear(path));

  it("无记录：get 返回 null（不恢复，保持顶部）", () => {
    expect(fileScrollProgress.get(path)).toBeNull();
  });

  it("set 后 get 返回百分比（既有 API 行为不变）", () => {
    fileScrollProgress.set(path, 0.42);
    expect(fileScrollProgress.get(path)).toBe(0.42);
    fileScrollProgress.set(path, 0.8);
    expect(fileScrollProgress.get(path)).toBe(0.8);
  });

  it("锚点 API 已移除（模式切换改为切换瞬间现算，不再按文件持久化）", () => {
    // 旧 API 写入后无人读取，属死代码，v0.8.0 修复 P1-2 一并删除
    expect((fileScrollProgress as Record<string, unknown>).setAnchorLine).toBeUndefined();
    expect((fileScrollProgress as Record<string, unknown>).getAnchorLine).toBeUndefined();
  });

  it("clear 后进度清空", () => {
    fileScrollProgress.set(path, 0.6);
    fileScrollProgress.clear(path);
    expect(fileScrollProgress.get(path)).toBeNull();
  });

  it("空路径不写入（防止 null key 污染 Map）", () => {
    fileScrollProgress.set(null, 0.5);
    fileScrollProgress.set("", 0.5);
    expect(fileScrollProgress.get(null)).toBeNull();
  });
});
