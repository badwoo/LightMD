/**
 * v0.11.0 B5-7：导出对话框仅在成功时关闭。
 *
 * 缺陷背景（P2）：
 *   `ExportDialog.handleExport` / `handlePdfOptionsConfirm` 在 `finally` 里
 *   **无条件** `onClose()` → 两个问题：
 *   ① 用户在「保存」对话框点**取消**时，导出对话框也被关掉 —— 看起来像导出完成；
 *   ② 导出失败（catch 分支已 notifyError）后同样关窗，错误提示与失败现场
 *      同时消失，用户无法原地重试。
 *
 * 修复：各导出函数返回 boolean（用户取消 = false），仅 `if (succeeded) onClose()`。
 * 另加 handleCancel：导出中不响应关闭，避免半途中断。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const raw = readFileSync("src/components/dialogs/ExportDialog.tsx", "utf-8");

/** 剔除注释（块注释 + 行注释），只留代码 —— 注释里会引用旧写法作为背景说明 */
const src = (() => {
  let out = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.split("\n").map((l) => {
    const i = l.indexOf("//");
    return i >= 0 ? l.slice(0, i) : l;
  }).join("\n");
  return out;
})();

describe("v0.11.0 B5-7 导出对话框关闭时机", () => {
  it("handleExport 收集 succeeded 标志", () => {
    expect(src).toContain("let succeeded = false");
    expect(src).toMatch(/succeeded\s*=\s*await\s+exportHTML/);
    expect(src).toMatch(/succeeded\s*=\s*await\s+exportImage/);
  });

  it("不再在 finally 里无条件 onClose", () => {
    // finally 块内应只有 setExporting(false) / setProgressText("")
    const finallyBlocks = src.match(/finally \{[\s\S]*?\n    \}/g) || [];
    expect(finallyBlocks.length).toBeGreaterThan(0);
    for (const block of finallyBlocks) {
      expect(block).not.toContain("onClose()");
    }
  });

  it("仅成功时关闭（两处导出路径）", () => {
    const matches = src.match(/if \(succeeded\) onClose\(\);/g) || [];
    expect(matches.length).toBe(2);
  });

  it("HTML 导出返回 boolean：用户取消为 false", () => {
    expect(src).toMatch(/async function exportHTML\([\s\S]*?\): Promise<boolean>/);
    // 取消分支：save() 返回 null（falsy）时走 return false
    expect(src).toMatch(/if \(selected\) \{[\s\S]{0,400}?return true;[\s\S]{0,200}?\}\s*\n\s*return false;/);
  });

  it("PDF 导出返回 boolean（取消 false / 失败 false）", () => {
    expect(src).toMatch(/async function exportPDFWithOptions\([\s\S]*?\): Promise<boolean>/);
  });

  it("图片导出透传底层成功标志", () => {
    expect(src).toMatch(/async function exportImage\([\s\S]*?\): Promise<boolean>/);
    expect(src).toContain("const ok = await exportElementAsPng");
    expect(src).toMatch(/return ok;/);
  });

  it("handleCancel 在导出中不响应（避免半途中断）", () => {
    expect(src).toContain("const handleCancel = useCallback");
    expect(src).toMatch(/const handleCancel = useCallback\(\(\) => \{\s*if \(exporting\) return;/);
  });

  it("关闭按钮与取消按钮均走 handleCancel", () => {
    expect(src).toContain('className="export-close" onClick={handleCancel}');
    expect(src).toContain('className="export-btn secondary" onClick={handleCancel}');
    // 不应再有裸的 onClick={onClose}
    expect(src).not.toContain("onClick={onClose}");
  });

  it("取消按钮在导出中被禁用", () => {
    expect(src).toMatch(/export-btn secondary" onClick=\{handleCancel\} disabled=\{exporting\}/);
  });
});
