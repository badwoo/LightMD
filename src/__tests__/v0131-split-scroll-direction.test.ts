// @vitest-environment jsdom
/**
 * v0.13.1 需求13：分屏滚动的**方向契约**——只保留左 → 右，右屏可独立滚动。
 *
 * ## 用户报告
 * 「当前分屏模式下左右两屏滚动是联动的，但当前有个问题是，左屏编辑、右屏渲染因为
 *  篇幅问题会出现阅读位置偏差，例如左侧编辑图表，但右侧渲染要把屏幕往下拉一拉
 *  才能看到。所以这个滚动进度不能改为强绑定，右侧屏应该可以单独滚动，但滚动左屏时
 *  可以联动右屏进行滚动。」
 *
 * ## 旧行为（bug）
 * 双向百分比联动：`textarea` 的 scroll 带 `preview`，`previewDoc` 的 scroll 又
 * **回写** `textarea.scrollTop`。后果：
 *   · 用户为了看右屏下方的渲染结果而向下滚右屏时，左屏被一起拖走，光标行滚出视野；
 *   · 左右两屏的"内容高度比例"并不一致（图表/公式/图片在右侧高得多），
 *     百分比互推必然错位，形成来回拉扯。
 * 另外右屏正文是被**防抖整段替换**的（`doc.body.innerHTML = previewHtml`），
 * mermaid/katex 之后还会异步撑高内容；替换后 iframe 只保留**像素** scrollTop，
 * 而 mode-switch 之外的路径**从不重同步** → 内容一变位置就漂。
 *
 * ## 新契约（本文件锁定）
 * 1. 右屏滚动**绝不回写**左屏（用户可自由滚动右屏）；
 * 2. 左屏滚动**驱动**右屏；
 * 3. 右屏内容更新后**主动重同步一次**（含异步渲染后的补一帧）。
 *
 * ## 为什么用源码断言
 * 分屏联动发生在真实的 `EditorContainer` effect 里，依赖真实的 iframe 文档、
 * 防抖渲染与 mermaid/katex 异步渲染 —— 在 jsdom 里无法真实复现（iframe 的
 * contentDocument 不参与 jsdom 的 layout，`scrollHeight` 恒为 0，任何 scrollTop
 * 都是 0，写出来的行为断言会**空过**）。因此这里采用与 `v0122-convergence.test.tsx`
 * 同款的源码契约锁：直接断言**回写左屏的那行代码已不存在**，
 * 以及**左→右映射与内容重同步存在**。百分比换算的数学另有
 * `split-scroll-sync.test.ts` 覆盖。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const containerSrc = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");

describe("v0.13.1 需求13：分屏滚动方向契约", () => {
  it("右屏滚动**不得回写**左屏（回写代码已删除）", () => {
    // 旧实现的反向同步：把 preview 的滚动位置写回 textarea
    expect(containerSrc).not.toContain("textarea.scrollTop = computeSyncScrollTop(");
    // 反向监听器本身也不应再存在
    expect(containerSrc).not.toContain("onPreviewScroll");
    expect(containerSrc).not.toContain('previewDoc.addEventListener("scroll"');
  });

  it("左屏滚动**驱动**右屏（左→右映射保留）", () => {
    expect(containerSrc).toContain("preview.scrollTop = computeSyncScrollTop(");
    expect(containerSrc).toContain('textarea.addEventListener("scroll", syncToPreview)');
  });

  it("右屏内容更新后主动重同步（解决'要往下拉一拉才看到'）", () => {
    // effect 依赖 previewHtml（每次内容更新都重跑）
    expect(containerSrc).toContain("}, [viewMode, previewHtml]);");
    // 绑定后立刻同步一次，并在下一帧补一次（覆盖 mermaid/katex 异步撑高）
    expect(containerSrc).toContain("syncToPreview();");
    expect(containerSrc).toContain("requestAnimationFrame(() => {");
  });

  it("清理干净：effect 卸载时移除监听并复位同步标记（不泄漏）", () => {
    expect(containerSrc).toContain('textarea.removeEventListener("scroll", syncToPreview)');
    expect(containerSrc).toContain("isSyncingScrollRef.current = false;");
  });

  it("模式切换的滚动恢复不受影响（computeRestoreScrollTop 仍在用）", () => {
    // v0.8.0-mode-anchor-ratio.test.ts 也锁了这条；这里再加一道，防止有人为了
    // 需求13 把"模式切换恢复"和"分屏联动"一起删掉。
    expect(containerSrc).toContain("computeRestoreScrollTop(percent");
  });
});
