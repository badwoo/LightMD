/**
 * v0.4.0 功能4：版本快照测试
 *
 * 覆盖：
 * 1. hashString：相同内容相同 hash，不同内容不同 hash
 * 2. diffContent：LCS diff 正确性（新增/删除/context 行）
 * 3. diffContent 大文件截断：超过 5000 行只 diff 前 5000 行
 * 4. recordSnapshot：首次 initial、内容去重、超过 5 条保留 initial
 * 5. getSnapshots：按时间升序，第1条为 initial
 * 6. 快照策略边界：0条、正好5条、6条的情况
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 用 vi.hoisted 创建 mock 函数，确保 vi.mock 工厂能引用（hoisted 优先执行）
const { mockInvoke, mockAppDataDir } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockAppDataDir: vi.fn(),
}));

// mock @tauri-apps 模块（必须在 import 之前）
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: mockAppDataDir }));
vi.mock("../services/fileService", () => ({
  fileService: {},
  isTauri: () => true,
}));

import {
  versionSnapshotService,
  hashString,
} from "../services/versionSnapshotService";

// 用递增计数器模拟 Date.now，确保每次 recordSnapshot 的 timestamp 唯一
let timeCounter = 1000;

describe("v0.4.0 版本快照", () => {
  beforeEach(() => {
    localStorage.clear();
    // 每次测试前重置 mock 实现（vi.restoreAllMocks 会清除上一轮的实现）
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockAppDataDir.mockReset();
    mockAppDataDir.mockResolvedValue("/test/appdata");
    timeCounter = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => (timeCounter += 1000));
  });

  afterEach(() => {
    // 恢复所有 spy（vi.hoisted 的 mock 在 beforeEach 会重新设置实现）
    vi.restoreAllMocks();
  });

  // ─── hashString ────────────────────────────────────────────
  describe("hashString", () => {
    it("相同内容产生相同 hash", () => {
      expect(hashString("hello world")).toBe(hashString("hello world"));
    });

    it("不同内容产生不同 hash", () => {
      expect(hashString("hello")).not.toBe(hashString("world"));
    });

    it("空字符串有固定 hash", () => {
      expect(hashString("")).toBe(hashString(""));
      expect(typeof hashString("")).toBe("string");
    });

    it("hash 为十六进制字符串", () => {
      expect(hashString("test")).toMatch(/^[0-9a-f]+$/);
    });
  });

  // ─── diffContent ───────────────────────────────────────────
  describe("diffContent - LCS diff 正确性", () => {
    it("检测新增行", () => {
      const old = "a\nb";
      const now = "a\nc\nb";
      const diff = versionSnapshotService.diffContent(old, now);
      expect(diff.added).toBe(1);
      expect(diff.removed).toBe(0);
      const addLines = diff.lines.filter((l) => l.type === "add");
      expect(addLines.length).toBe(1);
      expect(addLines[0].content).toBe("c");
      expect(addLines[0].newLineNo).toBe(2);
    });

    it("检测删除行", () => {
      const old = "a\nb\nc";
      const now = "a\nc";
      const diff = versionSnapshotService.diffContent(old, now);
      expect(diff.removed).toBe(1);
      expect(diff.added).toBe(0);
      const removeLines = diff.lines.filter((l) => l.type === "remove");
      expect(removeLines.length).toBe(1);
      expect(removeLines[0].content).toBe("b");
      expect(removeLines[0].oldLineNo).toBe(2);
    });

    it("内容相同全部为 context 行", () => {
      const old = "a\nb\nc";
      const now = "a\nb\nc";
      const diff = versionSnapshotService.diffContent(old, now);
      expect(diff.added).toBe(0);
      expect(diff.removed).toBe(0);
      expect(diff.lines.every((l) => l.type === "context")).toBe(true);
      expect(diff.lines.length).toBe(3);
    });

    it("检测修改行（一删一增）", () => {
      const old = "a\nb\nc";
      const now = "a\nB\nc";
      const diff = versionSnapshotService.diffContent(old, now);
      expect(diff.removed).toBe(1);
      expect(diff.added).toBe(1);
      const removeLine = diff.lines.find((l) => l.type === "remove");
      const addLine = diff.lines.find((l) => l.type === "add");
      expect(removeLine?.content).toBe("b");
      expect(addLine?.content).toBe("B");
    });

    it("空内容 diff", () => {
      const diff = versionSnapshotService.diffContent("", "");
      expect(diff.added).toBe(0);
      expect(diff.removed).toBe(0);
      // "" split("\n") 得到 [""], 1 行 context
      expect(diff.lines.length).toBe(1);
    });

    it("从空到有内容：空行被替换为新增行", () => {
      // "".split("\n") = [""]（1 个空字符串元素），所以空行被视为删除
      const diff = versionSnapshotService.diffContent("", "a\nb");
      expect(diff.added).toBe(2);
      expect(diff.removed).toBe(1);
    });
  });

  // ─── diffContent 大文件截断 ────────────────────────────────
  describe("diffContent - 大文件截断", () => {
    it("超过 5000 行只 diff 前 5000 行", () => {
      // 构造 5001 行：前 5000 行相同，第 5001 行不同
      const lines = Array.from({ length: 5001 }, (_, i) => `line ${i}`);
      const old = lines.join("\n");
      const newLines = [...lines];
      newLines[5000] = "different line";
      const now = newLines.join("\n");
      const diff = versionSnapshotService.diffContent(old, now);
      // 截断后前 5000 行完全相同，不应检测到差异
      expect(diff.added).toBe(0);
      expect(diff.removed).toBe(0);
    });

    it("差异在前 5000 行内能被检测到", () => {
      // 5000 行，第 100 行不同
      const old = Array.from({ length: 5000 }, (_, i) =>
        i === 99 ? "old line" : `line ${i}`
      ).join("\n");
      const now = Array.from({ length: 5000 }, (_, i) =>
        i === 99 ? "new line" : `line ${i}`
      ).join("\n");
      const diff = versionSnapshotService.diffContent(old, now);
      expect(diff.added).toBe(1);
      expect(diff.removed).toBe(1);
    });
  });

  // ─── recordSnapshot ────────────────────────────────────────
  describe("recordSnapshot", () => {
    it("首次记录 isInitial=true", async () => {
      await versionSnapshotService.recordSnapshot("/test/file.md", "content", true);
      const snapshots = versionSnapshotService.getSnapshots("/test/file.md");
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].isInitial).toBe(true);
      expect(snapshots[0].contentHash).toBe(hashString("content"));
      expect(snapshots[0].filePath).toBe("/test/file.md");
      expect(snapshots[0].size).toBe("content".length);
    });

    it("内容相同（hash 相同）不重复记录", async () => {
      await versionSnapshotService.recordSnapshot("/test/file.md", "content", true);
      await versionSnapshotService.recordSnapshot("/test/file.md", "content");
      const snapshots = versionSnapshotService.getSnapshots("/test/file.md");
      expect(snapshots.length).toBe(1);
    });

    it("初始版本去重：已有 initial 时不重复记录", async () => {
      await versionSnapshotService.recordSnapshot("/test/file.md", "content", true);
      await versionSnapshotService.recordSnapshot("/test/file.md", "content", true);
      const snapshots = versionSnapshotService.getSnapshots("/test/file.md");
      expect(snapshots.length).toBe(1);
      expect(snapshots.filter((m) => m.isInitial).length).toBe(1);
    });

    it("内容变化时正常记录", async () => {
      await versionSnapshotService.recordSnapshot("/test/file.md", "v1", true);
      await versionSnapshotService.recordSnapshot("/test/file.md", "v2");
      const snapshots = versionSnapshotService.getSnapshots("/test/file.md");
      expect(snapshots.length).toBe(2);
      expect(snapshots[0].contentHash).toBe(hashString("v1"));
      expect(snapshots[1].contentHash).toBe(hashString("v2"));
    });

    it("调用 invoke 写入内容文件和创建目录", async () => {
      await versionSnapshotService.recordSnapshot("/test/file.md", "content", true);
      // 应调用 create_dir（两级目录）
      const createDirCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "create_dir"
      );
      expect(createDirCalls.length).toBeGreaterThanOrEqual(1);
      // 应调用 write_file 写入快照内容
      const writeFileCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "write_file"
      );
      expect(writeFileCalls.length).toBe(1);
      expect(writeFileCalls[0][1]).toMatchObject({ content: "content" });
      expect(writeFileCalls[0][1].path).toContain("lightmd-snapshots");
    });

    it("超过 5 条时保留第1条 + 最近4条", async () => {
      const path = "/test/file.md";
      await versionSnapshotService.recordSnapshot(path, "initial", true);
      for (let i = 1; i <= 5; i++) {
        await versionSnapshotService.recordSnapshot(path, `content ${i}`);
      }
      const snapshots = versionSnapshotService.getSnapshots(path);
      expect(snapshots.length).toBe(5);
      // 第1条是 initial（受保护）
      expect(snapshots[0].isInitial).toBe(true);
      expect(snapshots[0].contentHash).toBe(hashString("initial"));
      // 最后一条是 content 5（最近修改）
      expect(snapshots[4].contentHash).toBe(hashString("content 5"));
    });

    it("第1条 isInitial 不被销毁", async () => {
      const path = "/test/file.md";
      await versionSnapshotService.recordSnapshot(path, "initial", true);
      // 记录 10 次修改，触发多次 trim
      for (let i = 1; i <= 10; i++) {
        await versionSnapshotService.recordSnapshot(path, `content ${i}`);
      }
      const snapshots = versionSnapshotService.getSnapshots(path);
      expect(snapshots.length).toBe(5);
      expect(snapshots[0].isInitial).toBe(true);
      expect(snapshots[0].contentHash).toBe(hashString("initial"));
      // 最后一条是 content 10
      expect(snapshots[4].contentHash).toBe(hashString("content 10"));
    });

    it("trim 时调用 delete_file 删除最旧快照内容文件", async () => {
      const path = "/test/file.md";
      await versionSnapshotService.recordSnapshot(path, "initial", true);
      for (let i = 1; i <= 5; i++) {
        await versionSnapshotService.recordSnapshot(path, `content ${i}`);
      }
      // 第6次 record 触发 trim，应调用 delete_file
      const deleteCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "delete_file"
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── getSnapshots ──────────────────────────────────────────
  describe("getSnapshots", () => {
    it("按时间升序排列，第1条为 initial", async () => {
      const path = "/test/file.md";
      await versionSnapshotService.recordSnapshot(path, "v1", true);
      await versionSnapshotService.recordSnapshot(path, "v2");
      await versionSnapshotService.recordSnapshot(path, "v3");
      const snapshots = versionSnapshotService.getSnapshots(path);
      expect(snapshots.length).toBe(3);
      expect(snapshots[0].isInitial).toBe(true);
      expect(snapshots[0].timestamp).toBeLessThanOrEqual(snapshots[1].timestamp);
      expect(snapshots[1].timestamp).toBeLessThanOrEqual(snapshots[2].timestamp);
    });

    it("不同文件的快照互不影响", async () => {
      await versionSnapshotService.recordSnapshot("/test/a.md", "a content", true);
      await versionSnapshotService.recordSnapshot("/test/b.md", "b content", true);
      const aSnapshots = versionSnapshotService.getSnapshots("/test/a.md");
      const bSnapshots = versionSnapshotService.getSnapshots("/test/b.md");
      expect(aSnapshots.length).toBe(1);
      expect(bSnapshots.length).toBe(1);
      expect(aSnapshots[0].filePath).toBe("/test/a.md");
      expect(bSnapshots[0].filePath).toBe("/test/b.md");
    });
  });

  // ─── 快照策略边界 ──────────────────────────────────────────
  describe("快照策略边界", () => {
    it("0条：无快照时返回空数组", () => {
      expect(versionSnapshotService.getSnapshots("/no/snap.md")).toEqual([]);
    });

    it("正好5条不触发 trim", async () => {
      const path = "/test/file.md";
      await versionSnapshotService.recordSnapshot(path, "v0", true);
      for (let i = 1; i <= 4; i++) {
        await versionSnapshotService.recordSnapshot(path, `v${i}`);
      }
      const snapshots = versionSnapshotService.getSnapshots(path);
      expect(snapshots.length).toBe(5);
      // 5条不触发 trim，无 delete_file 调用
      const deleteCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === "delete_file"
      );
      expect(deleteCalls.length).toBe(0);
    });

    it("6条时 trim 到5条，销毁第2条（保留第1条 initial）", async () => {
      const path = "/test/file.md";
      await versionSnapshotService.recordSnapshot(path, "v0", true);
      for (let i = 1; i <= 5; i++) {
        await versionSnapshotService.recordSnapshot(path, `v${i}`);
      }
      const snapshots = versionSnapshotService.getSnapshots(path);
      expect(snapshots.length).toBe(5);
      // 第1条是 initial
      expect(snapshots[0].isInitial).toBe(true);
      expect(snapshots[0].contentHash).toBe(hashString("v0"));
      // 第2条是 v2（v1 被销毁）
      expect(snapshots[1].contentHash).toBe(hashString("v2"));
      // 最后一条是 v5
      expect(snapshots[4].contentHash).toBe(hashString("v5"));
    });
  });
});
