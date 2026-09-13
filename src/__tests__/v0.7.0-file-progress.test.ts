/**
 * v0.7.0 bug修复测试：切换文件浏览进度保留
 *
 * 需求：切换不同打开的文件时浏览进度不重置；重新打开该文件时重置到顶部。
 *
 * 被测对象：
 * - fileScrollProgress 服务（Map 行为 / LRU 上限 / null 路径保护）
 * - computeRestoreScrollTop（恢复位置计算，复用既有纯函数验证百分比语义）
 */
import { describe, it, expect } from "vitest";
import { fileScrollProgress } from "../services/fileScrollProgress";
import { computeRestoreScrollTop } from "../utils/typewriter";

describe("v0.7.0 文件浏览进度：fileScrollProgress 服务", () => {
  it("set 后 get 返回记录的百分比", () => {
    const path = "test-progress-basic.md";
    fileScrollProgress.set(path, 0.5);
    expect(fileScrollProgress.get(path)).toBe(0.5);
  });

  it("同一路径重复 set 覆盖旧值（滚动实时更新）", () => {
    const path = "test-progress-update.md";
    fileScrollProgress.set(path, 0.2);
    fileScrollProgress.set(path, 0.8);
    expect(fileScrollProgress.get(path)).toBe(0.8);
  });

  it("无记录返回 null（首次打开/重新打开场景，不恢复）", () => {
    expect(fileScrollProgress.get("test-progress-none.md")).toBeNull();
  });

  it("null/undefined 路径 get 返回 null，set 不写入", () => {
    expect(fileScrollProgress.get(null)).toBeNull();
    expect(fileScrollProgress.get(undefined)).toBeNull();
    fileScrollProgress.set(null, 0.5);
    fileScrollProgress.set(undefined, 0.5);
    // 无法直接断言 Map 大小，但 get(null) 恒为 null 即语义正确
    expect(fileScrollProgress.get(null)).toBeNull();
  });

  it("clear 后 get 返回 null（重新打开/关闭标签重置）", () => {
    const path = "test-progress-clear.md";
    fileScrollProgress.set(path, 0.6);
    expect(fileScrollProgress.get(path)).toBe(0.6);
    fileScrollProgress.clear(path);
    expect(fileScrollProgress.get(path)).toBeNull();
    // 幂等：重复 clear 无副作用
    fileScrollProgress.clear(path);
    expect(fileScrollProgress.get(path)).toBeNull();
  });

  it("clear(null) 不抛错", () => {
    expect(() => fileScrollProgress.clear(null)).not.toThrow();
    expect(() => fileScrollProgress.clear(undefined)).not.toThrow();
  });

  it("不同文件路径进度相互独立（标签切换场景）", () => {
    const a = "test-progress-file-a.md";
    const b = "test-progress-file-b.md";
    fileScrollProgress.set(a, 0.1);
    fileScrollProgress.set(b, 0.9);
    expect(fileScrollProgress.get(a)).toBe(0.1);
    expect(fileScrollProgress.get(b)).toBe(0.9);
    // 切回 A：进度保留
    fileScrollProgress.set(a, 0.3);
    expect(fileScrollProgress.get(b)).toBe(0.9);
  });

  it("超过 60 条上限时淘汰最旧条目（内存保护）", () => {
    const oldest = "test-progress-lru-oldest.md";
    fileScrollProgress.set(oldest, 0.1);
    // 填满至 60 条（oldest + 59 条新路径）
    for (let i = 0; i < 59; i++) {
      fileScrollProgress.set(`test-progress-lru-${i}.md`, 0.5);
    }
    expect(fileScrollProgress.get(oldest)).toBe(0.1); // 未超限
    // 第 61 条触发淘汰最旧
    fileScrollProgress.set("test-progress-lru-new.md", 0.7);
    expect(fileScrollProgress.get(oldest)).toBeNull();
    expect(fileScrollProgress.get("test-progress-lru-new.md")).toBe(0.7);
  });
});

describe("v0.7.0 文件浏览进度：恢复位置计算语义", () => {
  // 复用与 EditorContainer 相同的纯函数，验证百分比 → scrollTop 的映射

  it("50% 进度恢复到可滚动区域中部", () => {
    // scrollHeight=2000, clientHeight=1000 → max=1000 → top=500
    expect(computeRestoreScrollTop(0.5, 2000, 1000)).toBe(500);
  });

  it("0% 进度恢复到顶部（重新打开后的默认位置）", () => {
    expect(computeRestoreScrollTop(0, 2000, 1000)).toBe(0);
  });

  it("100% 进度恢复到底部", () => {
    expect(computeRestoreScrollTop(1, 2000, 1000)).toBe(1000);
  });

  it("内容不足一屏（max<=0）返回 null，调用方不设置 scrollTop", () => {
    expect(computeRestoreScrollTop(0.5, 800, 800)).toBeNull();
  });
});
