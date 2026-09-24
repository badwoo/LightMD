/**
 * v0.8.3 WP1 需求1：最近打开列表扩容至 66 条 + hover 显示打开日期
 *
 * 覆盖：
 * 1. 数据层 MAX_RECENT_FILES = 66（头插 + 去重 + 超限丢最旧）
 * 2. 绝对时间格式化 formatDateTime（YYYY/MM/DD HH:mm，本地时区）
 * 3. UI 层不再截断前 10 条；tooltip 含完整路径 + "最近打开：..."
 * 4. i18n 键齐备（中/英）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_RECENT_FILES, useFileStore } from "../stores/useFileStore";
import { formatDateTime } from "../components/sidebar/RecentFiles";
import { t } from "../i18n/state";

const zhSrc = readFileSync(resolve(__dirname, "../i18n/locales/zh-CN.ts"), "utf-8");
const enSrc = readFileSync(resolve(__dirname, "../i18n/locales/en-US.ts"), "utf-8");
const recentSrc = readFileSync(
  resolve(__dirname, "../components/sidebar/RecentFiles.tsx"),
  "utf-8",
);

beforeEach(() => {
  localStorage.removeItem("lightmd-file-store");
  useFileStore.setState({ recentFiles: [] });
});

describe("v0.8.3 需求1：MAX_RECENT_FILES 上限 66", () => {
  it("常量值为 66", () => {
    expect(MAX_RECENT_FILES).toBe(66);
  });

  it("连续打开 67 个不同文件 → 长度 66、最新在首位、最早那条被清除", () => {
    const { addRecentFile } = useFileStore.getState();
    for (let i = 1; i <= 67; i++) {
      addRecentFile({ path: `C:/docs/f${i}.md`, name: `f${i}.md` });
    }
    const list = useFileStore.getState().recentFiles;
    expect(list).toHaveLength(66);
    // 最新在首位
    expect(list[0].path).toBe("C:/docs/f67.md");
    // 最早打开的那条（f1）已被清除
    expect(list.some((f) => f.path === "C:/docs/f1.md")).toBe(false);
    // 列表末位 = 次早的一条（f2）
    expect(list[65].path).toBe("C:/docs/f2.md");
  });

  it("重复打开同一路径 → 头插去重，不增长长度且刷新 accessedAt", () => {
    const { addRecentFile } = useFileStore.getState();
    addRecentFile({ path: "C:/a.md", name: "a.md" });
    addRecentFile({ path: "C:/b.md", name: "b.md" });
    const before = useFileStore.getState().recentFiles.find((f) => f.path === "C:/a.md")!.accessedAt;
    addRecentFile({ path: "C:/a.md", name: "a.md" });
    const list = useFileStore.getState().recentFiles;
    expect(list).toHaveLength(2);
    expect(list[0].path).toBe("C:/a.md");
    expect(list[0].accessedAt).toBeGreaterThanOrEqual(before);
  });

  it("50 条以上的历史数据不会被写入时截断到旧上限", () => {
    const { addRecentFile } = useFileStore.getState();
    for (let i = 1; i <= 55; i++) addRecentFile({ path: `C:/x${i}.md`, name: `x${i}.md` });
    expect(useFileStore.getState().recentFiles).toHaveLength(55);
  });
});

describe("v0.8.3 需求1：formatDateTime 绝对时间格式化", () => {
  it("输出 YYYY/MM/DD HH:mm（本地时区，补零）", () => {
    expect(formatDateTime(new Date(2026, 8, 22, 9, 5).getTime())).toBe("2026/09/22 09:05");
    expect(formatDateTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026/12/31 23:59");
  });

  it("非法/缺失时间戳返回占位符而不抛错", () => {
    expect(formatDateTime(0)).toBe("-");
    expect(formatDateTime(-1)).toBe("-");
    expect(formatDateTime(Number.NaN)).toBe("-");
    expect(formatDateTime(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("v0.8.3 需求1：源码接线（UI 结构锁定）", () => {
  it("渲染全量 recentFiles，不再 slice(0, 10)", () => {
    expect(recentSrc).toContain("recentFiles.map(");
    expect(recentSrc).not.toContain("recentFiles.slice(0, 10)");
  });

  it("tooltip = 完整路径 + 最近打开时间", () => {
    expect(recentSrc).toContain("recent.lastOpenedAt");
    expect(recentSrc).toContain("formatDateTime(file.accessedAt)");
    // 标题为两行：路径换行 + "最近打开：…"
    expect(recentSrc).toMatch(/title=\{`\$\{file\.path\}\\n\$\{t\(/);
  });

  it("列表容器具备独立滚动（栏内可滚动浏览 66 条）", () => {
    const css = readFileSync(
      resolve(__dirname, "../components/sidebar/FileTree.css"),
      "utf-8",
    );
    expect(css).toMatch(/\.recent-files-list\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.recent-files-list\s*\{[^}]*min-height:\s*0/);
  });

  it("i18n 键 recent.lastOpenedAt 在中英文均存在", () => {
    expect(zhSrc).toContain('"recent.lastOpenedAt": "最近打开：{time}"');
    expect(enSrc).toContain('"recent.lastOpenedAt": "Last opened: {time}"');
    // 运行时插值可用
    expect(t("recent.lastOpenedAt", { time: "2026/09/22 09:05" })).toContain("2026/09/22 09:05");
  });
});
