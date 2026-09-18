/**
 * v0.8.0 第四轮修复（P13-1 ~ P13-3）测试
 *
 * P13-1 "打开的文件"右键剪切 + 文件夹空白区粘贴 → 移动到该目录
 * P13-2 关闭末栏后上一栏自动撑满；再打开新栏时新栏紧跟上一栏出现
 * P13-3 侧栏滚动条宽度收窄到上一版的 30%
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeMaxSelfHeight, MIN_SECTION_HEIGHT } from "../hooks/useSectionSplit";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");
const fileTreeSrc = read("../components/sidebar/FileTree.tsx");

// ─── P13-1 剪切 / 粘贴移动 ───────────────────────────────
describe("P13-1 打开的文件右键剪切", () => {
  it("右键菜单提供「剪切」项，写入剪贴板时带 cut 模式", () => {
    expect(fileTreeSrc).toContain('t("filetree.cut")');
    expect(fileTreeSrc).toMatch(/mode: "cut"/);
  });

  it("剪切后给出提示文案（中英）", () => {
    expect(fileTreeSrc).toContain('showMessage(t("filetree.cutted"');
    expect(read("../i18n/locales/zh-CN.ts")).toContain('"filetree.cutted": "已剪切');
    expect(read("../i18n/locales/en-US.ts")).toContain('"filetree.cutted": "Cut:');
  });

  it("文件夹空白区粘贴按剪贴板模式决定复制或移动", () => {
    expect(fileTreeSrc).toMatch(
      /void transferTo\(clip\.path, folderCtxMenu\.dir, clipboardTransferMode\(clip\)/,
    );
  });

  it("Ctrl+V 同样按剪贴板模式决定复制或移动", () => {
    expect(fileTreeSrc).toMatch(/void transferTo\(clip\.path, targetDir, clipboardTransferMode\(clip\)/);
  });

  it("剪切粘贴（移动）成功后清空剪贴板（与系统资源管理器一致）", () => {
    expect(fileTreeSrc).toContain("isClipboardPaste: true");
    expect(fileTreeSrc).toMatch(/if \(opts\?\.isClipboardPaste && mode === "move"\) clearClipboard\(\)/);
  });

  it("移动后剪贴板保留原有模式（路径更新而非丢失模式）", () => {
    expect(fileTreeSrc).toMatch(/setClipboard\(\{ path: dst, name: unique, mode: clip\.mode \}\)/);
  });
});

// ─── P13-2 栏位高度自适应与位置 ──────────────────────────
describe("P13-2 关闭末栏撑满 / 重开新栏紧跟上一栏", () => {
  it("记录被撑满的栏及其原高度，集合变化时还原", () => {
    expect(fileTreeSrc).toContain("autoFillRef");
    expect(fileTreeSrc).toMatch(/autoFillRef\.current = \{ key: lastKey, prevHeight: current, filledHeight: target \}/);
    expect(fileTreeSrc).toMatch(/if \(filled && filled\.key !== lastKey\)/);
    expect(fileTreeSrc).toMatch(/next\[filled\.key\] = filled\.prevHeight/);
  });

  it("用户手动拖拽过则不还原（尊重用户设置）", () => {
    expect(fileTreeSrc).toMatch(/if \(heightOf\(filled\.key\) === filled\.filledHeight\)/);
  });

  it("还原后重新计算末栏是否撑满（新栏紧跟上一栏）", () => {
    // 还原发生在撑满判定之前，因此新栏的高度基于"还原后的上一栏"计算
    const revertIdx = fileTreeSrc.indexOf("next[filled.key] = filled.prevHeight");
    const fillIdx = fileTreeSrc.indexOf("if (total < container)");
    expect(revertIdx).toBeGreaterThan(-1);
    expect(fillIdx).toBeGreaterThan(revertIdx);
  });

  it("撑满目标高度 = 容器高 - 其他栏 - 分隔条（不预留）", () => {
    // 收藏 200 关闭末栏后撑满：容器 600 → 600 - 200 - 4 = 396
    expect(computeMaxSelfHeight(600, [200], 4, 1, MIN_SECTION_HEIGHT)).toBe(396);
  });

  it("重开新栏后：上一栏回到 200，新栏紧接其后（总高不足则新栏撑满）", () => {
    const container = 600;
    const resizer = 4;
    const resizerCount = 1;
    // 还原上一栏
    const favorites = 200;
    const recentBefore = 200;
    const total = favorites + recentBefore + resizer * resizerCount;
    expect(total).toBeLessThan(container);
    const target = computeMaxSelfHeight(container, [favorites], resizer, resizerCount, MIN_SECTION_HEIGHT);
    expect(target).toBe(396); // 新栏撑满，紧跟上一栏之后
  });
});

// ─── P13-3 滚动条宽度 ────────────────────────────────────
describe("P13-3 侧栏滚动条宽度为上一版的 30%", () => {
  it("4px 的 30% → 1.2px", () => {
    const css = read("../components/sidebar/FileTree.css");
    expect(css).toMatch(/\.filetree-scroll::-webkit-scrollbar\s*\{[^}]*width:\s*1\.2px/);
    expect(css).toMatch(/\.filetree-scroll::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*1px/);
  });
});
