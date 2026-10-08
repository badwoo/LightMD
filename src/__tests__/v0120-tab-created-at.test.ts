/**
 * v0.12.0 需求7：临时文件创建日期 + 真实文件创建时间透传测试
 *
 * 覆盖：
 * 1. formatFileTime：有效时间戳 → "YYYY-MM-DD HH:mm"；0/undefined/NaN/负数 → 空串
 * 2. saveUntitledTabs / loadUntitledTabs：createdAt roundtrip；存量数据（无字段）兼容
 * 3. syncTempFilesWithTabs：createdMs 从旧条目透传；无旧条目 → 0
 * 4. createUntitledTab：写入 createdAt（number）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { formatFileTime } from "../utils/datetime";
import { saveUntitledTabs, loadUntitledTabs, clearUntitledTabs } from "../utils/untitledTabs";
import { syncTempFilesWithTabs, type TempFileLike } from "../utils/tempFilesSync";
import { useEditorStore } from "../stores/useEditorStore";

describe("formatFileTime", () => {
  it("有效时间戳 → YYYY-MM-DD HH:mm（补零）", () => {
    // 用本地时区构造，避免时区差异导致断言不稳定
    const d = new Date(2026, 9, 8, 21, 30); // 2026-10-08 21:30
    expect(formatFileTime(d.getTime())).toBe("2026-10-08 21:30");
  });

  it("个位数月/日/时/分 → 补零", () => {
    const d = new Date(2026, 0, 5, 9, 7); // 2026-01-05 09:07
    expect(formatFileTime(d.getTime())).toBe("2026-01-05 09:07");
  });

  it("0 / undefined / NaN / 负数 → 空串（渲染层隐藏）", () => {
    expect(formatFileTime(0)).toBe("");
    expect(formatFileTime(undefined)).toBe("");
    expect(formatFileTime(NaN)).toBe("");
    expect(formatFileTime(-1)).toBe("");
    expect(formatFileTime(Infinity)).toBe("");
  });
});

describe("untitledTabs createdAt 持久化", () => {
  beforeEach(() => {
    clearUntitledTabs();
  });

  it("save/load roundtrip：createdAt 保留", () => {
    const ts = new Date(2026, 9, 8, 21, 30).getTime();
    saveUntitledTabs([
      { path: "", name: "新文件1", content: "hello", isUntitled: true, id: "untitled-1", createdAt: ts },
    ]);
    const stored = loadUntitledTabs();
    expect(stored).toHaveLength(1);
    expect(stored[0].createdAt).toBe(ts);
  });

  it("存量数据（无 createdAt）→ load 不报错且无该字段（不显示日期）", () => {
    // 模拟旧版本写入的数据
    localStorage.setItem(
      "lightmd-untitled-tabs",
      JSON.stringify([{ id: "untitled-9", name: "旧会话", content: "legacy" }]),
    );
    const stored = loadUntitledTabs();
    expect(stored).toEqual([{ id: "untitled-9", name: "旧会话", content: "legacy" }]);
    expect(stored[0].createdAt).toBeUndefined();
  });

  it("无效 createdAt（0/字符串）→ load 丢弃该字段", () => {
    localStorage.setItem(
      "lightmd-untitled-tabs",
      JSON.stringify([
        { id: "untitled-1", name: "a", content: "", createdAt: 0 },
        { id: "untitled-2", name: "b", content: "", createdAt: "not-a-number" },
      ]),
    );
    const stored = loadUntitledTabs();
    expect(stored[0].createdAt).toBeUndefined();
    expect(stored[1].createdAt).toBeUndefined();
  });
});

describe("syncTempFilesWithTabs createdMs 透传", () => {
  const tab = { path: "D:/a.md", name: "a.md" };

  it("旧条目有 createdMs → 透传保留", () => {
    const old: TempFileLike[] = [{ name: "a.md", path: "D:/a.md", isDir: false, size: 10, createdMs: 12345 }];
    const { next, changed } = syncTempFilesWithTabs(old, [tab]);
    expect(next[0].createdMs).toBe(12345);
    expect(next[0].size).toBe(10);
    expect(changed).toBe(false);
  });

  it("无旧条目 → createdMs 为 0（不显示日期）", () => {
    const { next } = syncTempFilesWithTabs<TempFileLike>([], [tab]);
    expect(next[0].createdMs).toBe(0);
  });

  it("createdMs 变化 → changed=true（写入 store）", () => {
    const old: TempFileLike[] = [{ name: "a.md", path: "D:/a.md", isDir: false, size: 10, createdMs: 0 }];
    const withMs: TempFileLike[] = [{ name: "a.md", path: "D:/a.md", isDir: false, size: 10, createdMs: 999 }];
    const { next } = syncTempFilesWithTabs(old, [tab]);
    expect(next[0].createdMs).toBe(0); // 只透传旧条目值
    expect(syncTempFilesWithTabs(withMs, [tab]).changed).toBe(false);
  });
});

describe("createUntitledTab 写入 createdAt", () => {
  it("新建临时标签带 createdAt（number）", () => {
    const before = Date.now();
    useEditorStore.getState().createUntitledTab();
    const tabs = useEditorStore.getState().openTabs;
    const tab = tabs[tabs.length - 1];
    expect(tab.isUntitled).toBe(true);
    expect(typeof tab.createdAt).toBe("number");
    expect(tab.createdAt! >= before).toBe(true);
  });
});