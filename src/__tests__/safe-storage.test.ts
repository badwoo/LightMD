/**
 * localStorage 容量保护测试
 *
 * 测试 safeSetItem 在不同内容大小下的行为
 * 确保超限内容不会导致 QuotaExceededError
 *
 * 使用 mock localStorage 避免依赖 jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { safeSetItem } from "../utils/safeStorage";

// Mock localStorage
const mockStorage: Record<string, string> = {};

// 在导入 safeStorage 之前设置全局 localStorage
(globalThis as any).localStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  }),
};

describe("safeSetItem 容量保护", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    vi.clearAllMocks();
  });

  it("应该成功写入小内容", () => {
    const result = safeSetItem("test-key", "小内容");
    expect(result).toBe(true);
    expect(mockStorage["test-key"]).toBe("小内容");
  });

  it("应该成功写入空内容", () => {
    const result = safeSetItem("test-key", "");
    expect(result).toBe(true);
    expect(mockStorage["test-key"]).toBe("");
  });

  it("应该跳过超限内容（>2MB）", () => {
    // 生成超过 2MB 的内容（UTF-16 编码，每个字符 2 字节，需要超过 100 万字符）
    const largeContent = "a".repeat(1100000); // 约 2.2MB
    const result = safeSetItem("test-key", largeContent);
    expect(result).toBe(false);
    // 不应该写入
    expect(mockStorage["test-key"]).toBeUndefined();
  });

  it("应该接受刚好在阈值内的内容", () => {
    // 生成接近但不超过 2MB 的内容（100 万字符 = 2MB）
    const content = "a".repeat(1000000);
    const result = safeSetItem("test-key", content);
    expect(result).toBe(true);
    expect(mockStorage["test-key"]?.length).toBe(1000000);
  });

  it("应该正确覆盖已有内容", () => {
    safeSetItem("test-key", "旧内容");
    const result = safeSetItem("test-key", "新内容");
    expect(result).toBe(true);
    expect(mockStorage["test-key"]).toBe("新内容");
  });

  it("应该正确处理中文内容", () => {
    const chineseContent = "你好世界".repeat(100);
    const result = safeSetItem("test-key", chineseContent);
    expect(result).toBe(true);
    expect(mockStorage["test-key"]).toBe(chineseContent);
  });

  it("应该在 setItem 抛出异常时返回 false", () => {
    // 模拟 QuotaExceededError
    const originalSetItem = (globalThis as any).localStorage.setItem;
    (globalThis as any).localStorage.setItem = vi.fn(() => {
      throw new DOMException("QuotaExceededError");
    });

    const result = safeSetItem("test-key", "test");
    expect(result).toBe(false);

    // 恢复
    (globalThis as any).localStorage.setItem = originalSetItem;
  });
});
