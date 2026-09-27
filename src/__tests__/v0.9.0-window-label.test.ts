/**
 * v0.9.0 WP0/WP3：窗口身份与窗口级 localStorage key 的隔离契约。
 *
 * 覆盖：
 * - `getWindowLabel` 的三级来源（URL query → Tauri metadata → main 回退）
 * - `withWindowSuffix`：main 沿用旧 key（零迁移），sec-* 加后缀
 * - `isValidWindowLabel`：非法 label 不入 key 空间
 * - untitledTabs / lastActiveTab / fileScrollProgress 三个模块按键隔离
 * - `clearSlotResidue`：槽位复用时清理残留、且**绝不清理 main**
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockStorage: Record<string, string> = {};

function installStorage() {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
    clear: () => {
      for (const k of Object.keys(mockStorage)) delete mockStorage[k];
    },
    key: (i: number) => Object.keys(mockStorage)[i] ?? null,
    get length() {
      return Object.keys(mockStorage).length;
    },
  };
}

installStorage();

import {
  getWindowLabel,
  isMainWindow,
  isValidWindowLabel,
  withWindowSuffix,
  __setWindowLabelForTest,
  MAIN_WINDOW_LABEL,
  MAX_WINDOWS,
} from "../utils/windowLabel";
import {
  saveUntitledTabs,
  loadUntitledTabs,
  clearUntitledTabsForLabel,
  UNTITLED_TABS_KEY,
} from "../utils/untitledTabs";
import {
  saveLastActiveTab,
  loadLastActiveTab,
  clearLastActiveTabForLabel,
  LAST_ACTIVE_TAB_KEY,
} from "../utils/lastActiveTab";
import { fileScrollProgress, clearScrollProgressForLabel, SCROLL_PROGRESS_KEY } from "../services/fileScrollProgress";
import { clearSlotResidue } from "../utils/windowSlot";
import type { TabInfo } from "../stores/useEditorStore";

function untitled(id: string, content: string): TabInfo {
  return { id, path: "", name: `新文件${id}`, content, isUntitled: true, isDirty: true };
}

beforeEach(() => {
  installStorage();
  __setWindowLabelForTest(null);
  vi.unstubAllGlobals();
});

afterEach(() => {
  __setWindowLabelForTest(null);
  vi.unstubAllGlobals();
});

describe("v0.9.0 窗口身份", () => {
  it("非 Tauri 环境（jsdom）回退 main", () => {
    expect(getWindowLabel()).toBe(MAIN_WINDOW_LABEL);
    expect(isMainWindow()).toBe(true);
  });

  it("Tauri metadata 提供 label 时以其为准", () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWebview: { label: "sec-2" } },
    };
    __setWindowLabelForTest(null);
    expect(getWindowLabel()).toBe("sec-2");
    expect(isMainWindow()).toBe(false);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("withWindowSuffix：main 沿用无后缀旧 key（v0.8.5 数据零迁移）", () => {
    __setWindowLabelForTest("main");
    expect(withWindowSuffix("lightmd-settings")).toBe("lightmd-settings");
    expect(withWindowSuffix(UNTITLED_TABS_KEY)).toBe(UNTITLED_TABS_KEY);
  });

  it("withWindowSuffix：sec-* 追加 -{label} 后缀", () => {
    __setWindowLabelForTest("sec-3");
    expect(withWindowSuffix("lightmd-settings")).toBe("lightmd-settings-sec-3");
    expect(withWindowSuffix(UNTITLED_TABS_KEY)).toBe(`${UNTITLED_TABS_KEY}-sec-3`);
  });

  it("isValidWindowLabel 只接受 main 与 sec-1..sec-7", () => {
    expect(isValidWindowLabel("main")).toBe(true);
    expect(isValidWindowLabel("sec-1")).toBe(true);
    expect(isValidWindowLabel(`sec-${MAX_WINDOWS - 1}`)).toBe(true);
    // 超出槽位上限 / 非法字符 / 空串
    expect(isValidWindowLabel(`sec-${MAX_WINDOWS}`)).toBe(false);
    expect(isValidWindowLabel("sec-0")).toBe(false);
    expect(isValidWindowLabel("sec-x")).toBe(false);
    expect(isValidWindowLabel("")).toBe(false);
    expect(isValidWindowLabel("main-x")).toBe(false);
    expect(isValidWindowLabel("../../etc")).toBe(false);
  });
});

describe("v0.9.0 WP3：临时标签按窗口隔离", () => {
  it("窗口 A 的临时标签不出现在窗口 B（AC-12）", () => {
    __setWindowLabelForTest("main");
    saveUntitledTabs([untitled("untitled-1", "主窗口内容")]);
    __setWindowLabelForTest("sec-1");
    expect(loadUntitledTabs()).toEqual([]);
    saveUntitledTabs([untitled("untitled-2", "辅助窗口内容")]);
    expect(loadUntitledTabs().map((t) => t.content)).toEqual(["辅助窗口内容"]);
    // 切回 main：原数据仍在（互不覆盖）
    __setWindowLabelForTest("main");
    expect(loadUntitledTabs().map((t) => t.content)).toEqual(["主窗口内容"]);
    // key 层面确认隔离
    expect(mockStorage[UNTITLED_TABS_KEY]).toContain("主窗口内容");
    expect(mockStorage[`${UNTITLED_TABS_KEY}-sec-1`]).toContain("辅助窗口内容");
  });

  it("main 窗口沿用 v0.8.5 旧 key（旧数据原地可读）", () => {
    mockStorage[UNTITLED_TABS_KEY] = JSON.stringify([
      { id: "untitled-9", name: "旧会话", content: "legacy" },
    ]);
    __setWindowLabelForTest("main");
    expect(loadUntitledTabs()).toEqual([{ id: "untitled-9", name: "旧会话", content: "legacy" }]);
  });

  it("清除指定槽位只删该槽位的 key", () => {
    __setWindowLabelForTest("main");
    saveUntitledTabs([untitled("untitled-1", "main")]);
    __setWindowLabelForTest("sec-2");
    saveUntitledTabs([untitled("untitled-2", "sec2")]);
    clearUntitledTabsForLabel("sec-2");
    expect(mockStorage[`${UNTITLED_TABS_KEY}-sec-2`]).toBeUndefined();
    expect(mockStorage[UNTITLED_TABS_KEY]).toContain("main");
  });
});

describe("v0.9.0 WP3：上次活跃标签按窗口隔离", () => {
  it("各窗口记录各自的活跃标签", () => {
    __setWindowLabelForTest("main");
    saveLastActiveTab({ path: "D:/a.md", name: "a.md", isUntitled: false });
    __setWindowLabelForTest("sec-1");
    saveLastActiveTab({ path: "D:/b.md", name: "b.md", isUntitled: false });
    expect(loadLastActiveTab()).toEqual({ kind: "file", path: "D:/b.md" });
    __setWindowLabelForTest("main");
    expect(loadLastActiveTab()).toEqual({ kind: "file", path: "D:/a.md" });
  });

  it("清除指定槽位只删该槽位的 key", () => {
    __setWindowLabelForTest("sec-3");
    saveLastActiveTab({ path: "D:/c.md", name: "c.md", isUntitled: false });
    clearLastActiveTabForLabel("sec-3");
    expect(mockStorage[`${LAST_ACTIVE_TAB_KEY}-sec-3`]).toBeUndefined();
  });
});

describe("v0.9.0 WP3：浏览进度按窗口隔离（AC-13）", () => {
  it("同一文件在两个窗口的滚动进度互不影响", () => {
    __setWindowLabelForTest("main");
    fileScrollProgress.set("D:/a.md", 0.1);
    fileScrollProgress.saveSnapshot(["D:/a.md"]);
    __setWindowLabelForTest("sec-1");
    fileScrollProgress.set("D:/a.md", 0.9);
    fileScrollProgress.saveSnapshot(["D:/a.md"]);
    // 两个 key 各自记录各自进度
    expect(JSON.parse(mockStorage[SCROLL_PROGRESS_KEY])["D:/a.md"]).toBeCloseTo(0.1);
    expect(JSON.parse(mockStorage[`${SCROLL_PROGRESS_KEY}-sec-1`])["D:/a.md"]).toBeCloseTo(0.9);
  });

  it("清除指定槽位的落盘快照", () => {
    __setWindowLabelForTest("sec-1");
    fileScrollProgress.set("D:/a.md", 0.5);
    fileScrollProgress.saveSnapshot(["D:/a.md"]);
    clearScrollProgressForLabel("sec-1");
    expect(mockStorage[`${SCROLL_PROGRESS_KEY}-sec-1`]).toBeUndefined();
  });
});

describe("v0.9.0 WP3/WP8：槽位残留清理", () => {
  it("清理 sec 槽位的四类残留 key", () => {
    __setWindowLabelForTest("sec-1");
    saveUntitledTabs([untitled("untitled-1", "stale")]);
    saveLastActiveTab({ path: "D:/a.md", name: "a.md", isUntitled: false });
    fileScrollProgress.set("D:/a.md", 0.5);
    fileScrollProgress.saveSnapshot(["D:/a.md"]);
    mockStorage["lightmd-content-sec-1"] = "scratch";
    mockStorage["lightmd-last-file-sec-1"] = "D:/a.md";

    clearSlotResidue("sec-1");

    expect(mockStorage[`${UNTITLED_TABS_KEY}-sec-1`]).toBeUndefined();
    expect(mockStorage[`${LAST_ACTIVE_TAB_KEY}-sec-1`]).toBeUndefined();
    expect(mockStorage[`${SCROLL_PROGRESS_KEY}-sec-1`]).toBeUndefined();
    expect(mockStorage["lightmd-content-sec-1"]).toBeUndefined();
    expect(mockStorage["lightmd-last-file-sec-1"]).toBeUndefined();
  });

  it("绝不清理 main 槽位（保护 v0.8.5 旧数据）", () => {
    __setWindowLabelForTest("main");
    saveUntitledTabs([untitled("untitled-1", "keep me")]);
    saveLastActiveTab({ path: "D:/a.md", name: "a.md", isUntitled: false });
    fileScrollProgress.set("D:/a.md", 0.5);
    fileScrollProgress.saveSnapshot(["D:/a.md"]);
    mockStorage["lightmd-content"] = "scratch";

    clearSlotResidue("main");

    expect(loadUntitledTabs()).toHaveLength(1);
    expect(loadLastActiveTab()).toEqual({ kind: "file", path: "D:/a.md" });
    expect(mockStorage[SCROLL_PROGRESS_KEY]).toBeDefined();
    expect(mockStorage["lightmd-content"]).toBe("scratch");
  });

  it("清理不影响其他槽位", () => {
    __setWindowLabelForTest("sec-2");
    saveUntitledTabs([untitled("untitled-2", "other")]);
    clearSlotResidue("sec-1");
    expect(mockStorage[`${UNTITLED_TABS_KEY}-sec-2`]).toContain("other");
  });
});
