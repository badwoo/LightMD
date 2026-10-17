// @vitest-environment jsdom
/**
 * v0.13.2 需求8：分屏滚动的**双向映射**契约。
 *
 * ## 用户最新要求
 * 「分屏模式联动滚动优化要继续，左右屏滚动要跟着联动，但左右屏不是共用滚动条，
 *  而是映射关系。因为左屏的文档长度会比右屏渲染的文档长度小，如果共用滚动条就
 *  导致左右看到的内容不一致或有偏差，所以你要实现这个左右两屏能联动滚动，
 *  但左右两屏看到的内容尽量能对齐。」
 *
 * ## 与 v0.13.1 的差别
 * v0.13.1 只保留「左 → 右」（右屏可自由独立滚动）；本轮**恢复双向**，
 * 但两侧都不再用"共用百分比"，而是走**块锚点映射**：
 *   · 左 → 右：源码行 → 所属顶层块 → 该块在右侧的块内比例位置；
 *   · 右 → 左：右侧视口顶 → 所属顶层块 → 块内比例 → 反算源码行 → textarea scrollTop。
 * 因为两侧都锚在同一个块的同一相对位置，块高差异再大也能对齐。
 *
 * ## 为什么这里仍是源码契约锁
 * 分屏联动发生在真实 `EditorContainer` effect 里，依赖真实 iframe 文档与防抖渲染；
 * jsdom 的 iframe `contentDocument` 不参与布局（scrollHeight 恒 0），
 * 行为断言会**空过**。映射数学另有 `v0132-split-scroll-mapping.test.ts` 精确覆盖。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const containerSrc = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");

describe("v0.13.2 需求8：分屏滚动方向契约（双向映射）", () => {
  it("左屏滚动**驱动**右屏（左→右映射存在）", () => {
    expect(containerSrc).toContain("mapSourceLineToPreviewScroll(");
    expect(containerSrc).toContain("textarea.addEventListener(\"scroll\", syncToPreview");
  });

  it("右屏滚动**回推**左屏（右→左映射存在）", () => {
    expect(containerSrc).toContain("mapPreviewScrollToSourceLine(");
    expect(containerSrc).toContain("mapSourceLineToScrollTop(");
    expect(containerSrc).toContain("syncToSource");
    expect(containerSrc).toContain("previewWin?.addEventListener(\"scroll\", syncToSource");
  });

  it("左右两侧**不共用滚动条**：各自写自己的 scrollTop，不互相赋值同一个值", () => {
    // 左→右只写 preview.scrollTop；右→左只写 textarea.scrollTop
    expect(containerSrc).toContain("preview.scrollTop = next;");
    expect(containerSrc).toContain("textarea.scrollTop = top;");
    // 不得出现"把两侧设成同一个值"的旧式共用写法
    expect(containerSrc).not.toMatch(/textarea\.scrollTop\s*=\s*preview\.scrollTop/);
    expect(containerSrc).not.toMatch(/preview\.scrollTop\s*=\s*textarea\.scrollTop/);
  });

  it("防拉扯：两个方向共用同一个重入标记", () => {
    // syncToPreview 与 syncToSource 都必须以 isSyncingScrollRef 做重入守卫
    const previewFn = containerSrc.slice(
      containerSrc.indexOf("const syncToPreview = () =>"),
      containerSrc.indexOf("const syncToSource = () =>"),
    );
    const sourceFn = containerSrc.slice(
      containerSrc.indexOf("const syncToSource = () =>"),
      containerSrc.indexOf("textarea.addEventListener(\"scroll\", syncToPreview"),
    );
    expect(previewFn).toContain("if (isSyncingScrollRef.current) return;");
    expect(sourceFn).toContain("if (isSyncingScrollRef.current) return;");
  });

  it("右屏内容更新后主动重同步（解决'要往下拉一拉才看到'）", () => {
    expect(containerSrc).toContain("}, [viewMode, previewHtml, previewSourceMarkdown]);");
    expect(containerSrc).toContain("syncToPreview();");
  });

  it("清理干净：effect 卸载时移除两个方向的监听并复位同步标记（不泄漏）", () => {
    expect(containerSrc).toContain('textarea.removeEventListener("scroll", syncToPreview)');
    expect(containerSrc).toContain("previewWin?.removeEventListener(\"scroll\", syncToSource)");
    expect(containerSrc).toContain("preview.removeEventListener(\"scroll\", syncToSource)");
    expect(containerSrc).toContain("isSyncingScrollRef.current = false;");
  });

  it("模式切换的滚动恢复不受影响（computeRestoreScrollTop 仍在用）", () => {
    expect(containerSrc).toContain("computeRestoreScrollTop(percent");
  });
});
