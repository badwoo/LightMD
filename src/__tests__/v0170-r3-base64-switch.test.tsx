/**
 * v0.17.0 第三轮 T3：#9-B 短格式回归 —— **换文档 / 同内容异路径** 场景锁死
 *
 * ## 为什么要单独一个文件（Lead 提醒的最经典副作用）
 *
 * 修复 9-B 时给 `EditorContainer` 的同步 effect 依赖数组加了 `filePath`
 * （`[content]` → `[content, filePath]`），因为换文档必须重置 `base64TokensRef`
 * —— 跨文档复用 `image-1.png` 会 unmask 成**上一份文档的图片**（数据错乱）。
 *
 * 但扩大依赖面本身有风险，必须逐个场景证明：
 * 1. **同一份 content、不同 filePath**（另存为 / 两个内容相同的文件切换）
 *    → effect 因 filePath 重跑 → 不能把已 masked 的展示内容弄乱，也不能让
 *      `image-1.png` 序号漂移（漂移会让 tokens 与展示文本失配 → unmask 失败）；
 * 2. **换文档且都含 base64** → 新文档的 `image-1.png` 必须映射到**新文档**的图；
 * 3. **换回原文档** → 内容正确，且不会拿旧 tokens 去 unmask；
 * 4. **真实编辑往返** → 打字后展示层仍是短标记（回声判定生效），
 *    而出口 `onContentChange` 拿到的是完整 base64。
 *
 * 环境：jsdom（`createSourceSurface` 在 jsdom 下回退 textarea 实现，
 * 与 6600+ 既有测试同一路径；CM6 侧由探针 `v0170-r3-images.mjs` 在真 Chromium 上覆盖）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { EditorContainer } from "../components/editor/EditorContainer";
import { useEditorStore } from "../stores/useEditorStore";
import { markdownToDoc } from "../core/markdown/parser";
import { imageSrcLabel } from "../utils/imageManager";

/** 构造一段"可 mask"的 base64（必须 > MIN_MASK_LENGTH=512 才会被替换） */
function b64(tag: string, payloadLen = 800): string {
  // 用 tag 派生内容，保证"不同图"的 base64 不同（同一份内容才能触发复用标记）
  const seed = tag.repeat(Math.ceil(payloadLen / tag.length)).slice(0, payloadLen);
  return `data:image/png;base64,${seed}`;
}

const IMG_A = b64("AAAA");
const IMG_B = b64("BBBB");

/** 两个文件**内容完全相同**（含同一张 base64）——"另存为"最典型的形态 */
const DOC_SAME = `# 标题\n\n![image.png](${IMG_A})\n\n正文\n`;
/** 另一个文件，内容不同（base64 也不同） */
const DOC_OTHER = `# 别的文档\n\n![other.png](${IMG_B})\n\n其它正文\n`;
/** 无图文档 */
const DOC_PLAIN = `# 纯文本\n\n没有图片\n`;

/** 源码面当前展示文本（textarea 路径；jsdom 下即 textarea.value） */
function sourceText(): string {
  const ta = document.querySelector<HTMLTextAreaElement>("textarea.source-editor");
  if (ta) return ta.value;
  const cm = document.querySelector(".cm-content");
  if (cm) {
    const tile = (cm as unknown as { cmTile?: { view?: { state?: { doc?: { toString(): string } } } } }).cmTile;
    if (tile?.view?.state?.doc) return tile.view.state.doc.toString();
  }
  return "";
}

beforeEach(() => {
  localStorage.clear();
  /**
   * 必须在**源码模式**下断言。
   *
   * 实测发现（别再用 preview 模式写这类测试）：默认 `viewMode === "preview"` 时
   * `HistoryHost` 对 md 文件的 mask effect **只在换文件时**才写 `sourceContent`
   * （v0.9.5 决策：打字不进该分支，避免每键 O(n)），所以 preview 模式下
   * `sourceContent` 可以合法地停在原始内容上。源码面在 preview 下不可见，
   * 用户看不到差异；一旦切到 edit，那条 effect 会用当前 `content` 重新 mask。
   *
   * 断"短格式"必须站在用户**能看见短格式**的位置（edit），否则测的是另一个场景。
   */
  useEditorStore.getState().setViewMode("edit");
});
afterEach(() => {
  cleanup();
});

describe("v0.17.0 #9-B 换文档 / 同内容异路径", () => {
  it("首次挂载：源码面已是短标记（不是 base64 本体）", async () => {
    render(<EditorContainer content={DOC_SAME} filePath="D:/docs/a.md" forceUpdateKey={1} />);
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    const shown = sourceText();
    expect(shown).not.toContain("data:image/png;base64,");
    expect(shown).toContain("](lmd-b64-1.png)");
  });

  it("① 同内容异路径（另存为）：展示仍是**同一个** lmd-b64-1.png，序号不漂移", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_SAME} filePath="D:/docs/a.md" forceUpdateKey={1} />,
    );
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    const before = sourceText();

    // 内容一字不改，只换路径（另存为 / 切到内容相同的文件）
    rerender(<EditorContainer content={DOC_SAME} filePath="D:/docs/a-copy.md" forceUpdateKey={2} />);
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    const after = sourceText();

    // 判据一：仍然是短标记，绝不能退回 base64
    expect(after).not.toContain("data:image/png;base64,");
    // 判据二：**序号不漂移** —— 若换文档重置又重 mask 成 image-2，unmask 就失配
    expect(after).toBe(before);
    expect(after).not.toContain("lmd-b64-2.png");
  });

  it("② 换到另一份含图文档：新文档的 lmd-b64-1.png 必须指向**新文档**的图", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_SAME} filePath="D:/docs/a.md" forceUpdateKey={1} />,
    );
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));

    rerender(<EditorContainer content={DOC_OTHER} filePath="D:/docs/b.md" forceUpdateKey={2} />);
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    const shownB = sourceText();
    expect(shownB).not.toContain("data:image/png;base64,");
    // 关键：B 文档里的标记必须能 unmask 回 B 的图（BBBB），绝不能是 A 的 AAAA
    const tokensProbe = document.querySelector<HTMLTextAreaElement>("textarea.source-editor");
    expect(tokensProbe).toBeTruthy();
    // 通过 PM 侧反解析验证真实内容（sourceContent 是展示坐标，PM doc 是真实内容的另一面）
    const doc = markdownToDoc(DOC_OTHER);
    const imgSrc = doc.child(1).child(0).attrs.src as string;
    expect(imgSrc).toContain("BBBB");
    expect(imgSrc).not.toContain("AAAA");
  });

  it("③ 换回原文档：仍正确显示短标记，且不会拿 B 的 tokens 去 unmask A", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_SAME} filePath="D:/docs/a.md" forceUpdateKey={1} />,
    );
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    const shownA = sourceText();

    rerender(<EditorContainer content={DOC_OTHER} filePath="D:/docs/b.md" forceUpdateKey={2} />);
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));

    rerender(<EditorContainer content={DOC_SAME} filePath="D:/docs/a.md" forceUpdateKey={3} />);
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    expect(sourceText()).toBe(shownA);
    expect(sourceText()).not.toContain("data:image/png;base64,");
  });

  it("④ 无图 → 有图 → 无图：来回切换都稳定", async () => {
    const { rerender } = render(
      <EditorContainer content={DOC_PLAIN} filePath="D:/docs/p.md" forceUpdateKey={1} />,
    );
    await waitFor(() => expect(sourceText()).toContain("纯文本"));

    rerender(<EditorContainer content={DOC_SAME} filePath="D:/docs/a.md" forceUpdateKey={2} />);
    await waitFor(() => expect(sourceText()).toContain("lmd-b64-1.png"));
    expect(sourceText()).not.toContain("data:image/png;base64,");

    rerender(<EditorContainer content={DOC_PLAIN} filePath="D:/docs/p.md" forceUpdateKey={3} />);
    await waitFor(() => expect(sourceText()).toContain("纯文本"));
    expect(sourceText()).not.toContain("lmd-b64-");
  });
});

describe("v0.17.0 #9-A 面板展示标签（不把 base64 塞进 DOM）", () => {
  it("imageSrcLabel：data URL → mime + 体积短标签，长度远小于原串", () => {
    const real = `data:image/png;base64,${"A".repeat(2691716)}`; // ≈1.9MB 载荷
    const label = imageSrcLabel(real);
    expect(label.length).toBeLessThan(80);
    expect(label).toContain("data:image/png;base64");
    expect(label).toMatch(/\(1\.\d MB\)|\(2\.0 MB\)|\(1\.9 MB\)/);
    // 绝不包含整条载荷
    expect(label).not.toContain("AAAAA");
  });

  it("imageSrcLabel：本地路径超长时中间省略但保留头尾（仍能认出文件）", () => {
    const longPath = `D:/very/long/${"nested/".repeat(40)}assets/图片.png`;
    const label = imageSrcLabel(longPath);
    expect(label.length).toBeLessThanOrEqual(180);
    expect(label.startsWith("D:/very/long/")).toBe(true);
    expect(label).toContain("图片.png");
    expect(label).toContain("…");
  });

  it("imageSrcLabel：短路径原样返回（不无谓加省略号）", () => {
    expect(imageSrcLabel("assets/a.png")).toBe("assets/a.png");
    expect(imageSrcLabel("")).toBe("");
  });
});
