/**
 * v0.8.3 WP4 需求5/6：启动恢复增强（上次活跃标签定位 + 跨会话阅读位置）
 *
 * 覆盖：
 * 1. utils/tabKey：进度键约定（真实文件 = path，临时标签 = untitled:<id>）
 * 2. utils/lastActiveTab：序列化 / 损坏容错 / 恢复定位
 * 3. services/fileScrollProgress：快照落盘、读回注入、清理、变更检测、键迁移
 * 4. App/EditorContainer 源码接线：会话恢复期守卫、last-active 写入时机、
 *    progressKeyRef 与 activeFileRef 语义隔离
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  tabProgressKey,
  tabsProgressKeys,
  untitledProgressKey,
  UNTITLED_PROGRESS_PREFIX,
} from "../utils/tabKey";
import {
  LAST_ACTIVE_TAB_KEY,
  saveLastActiveTab,
  loadLastActiveTab,
  clearLastActiveTab,
  resolveLastActiveIndex,
} from "../utils/lastActiveTab";
import { fileScrollProgress, SCROLL_PROGRESS_KEY } from "../services/fileScrollProgress";
import type { TabInfo } from "../stores/useEditorStore";

const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
const containerSrc = readFileSync(
  resolve(__dirname, "../components/editor/EditorContainer.tsx"),
  "utf-8",
);

const tab = (over: Partial<TabInfo>): TabInfo =>
  ({ path: "", name: "t", content: "", ...over }) as TabInfo;

beforeEach(() => {
  localStorage.removeItem(LAST_ACTIVE_TAB_KEY);
  fileScrollProgress.clearAll();
  localStorage.removeItem(SCROLL_PROGRESS_KEY);
});

describe("v0.8.3 需求6：进度键约定（utils/tabKey）", () => {
  it("真实文件用 path（与历史快照兼容）", () => {
    expect(tabProgressKey(tab({ path: "C:/a.md" }))).toBe("C:/a.md");
  });

  it("临时标签用 untitled:<id>", () => {
    expect(tabProgressKey(tab({ path: "", isUntitled: true, id: "untitled-3" })))
      .toBe(`${UNTITLED_PROGRESS_PREFIX}untitled-3`);
    expect(untitledProgressKey("untitled-3")).toBe("untitled:untitled-3");
    expect(untitledProgressKey(undefined)).toBeNull();
  });

  it("临时标签无 id 时用兜底序号；无路径且无 id 返回 null", () => {
    expect(tabProgressKey(tab({ isUntitled: true }), 4)).toBe("untitled:4");
    expect(tabProgressKey(tab({ path: "" }))).toBeNull();
    expect(tabProgressKey(null)).toBeNull();
  });

  it("tabsProgressKeys 过滤空键并保持标签顺序", () => {
    expect(
      tabsProgressKeys([
        tab({ path: "C:/a.md" }),
        tab({ path: "", isUntitled: true, id: "untitled-1" }),
        tab({ path: "" }),
      ]),
    ).toEqual(["C:/a.md", "untitled:untitled-1"]);
  });
});

describe("v0.8.3 需求5：lastActiveTab 序列化与容错", () => {
  it("真实文件往返（kind=file, path）", () => {
    saveLastActiveTab(tab({ path: "C:/docs/a.md" }));
    expect(loadLastActiveTab()).toEqual({ kind: "file", path: "C:/docs/a.md" });
  });

  it("临时标签往返（kind=untitled, id）——path 为空串不能作为标识", () => {
    saveLastActiveTab(tab({ path: "", isUntitled: true, id: "untitled-7" }));
    expect(loadLastActiveTab()).toEqual({ kind: "untitled", id: "untitled-7" });
  });

  it("null / 无 id 的临时标签 / 无路径 → 清除记录", () => {
    saveLastActiveTab(tab({ path: "C:/a.md" }));
    saveLastActiveTab(null);
    expect(loadLastActiveTab()).toBeNull();
    saveLastActiveTab(tab({ path: "", isUntitled: true }));
    expect(loadLastActiveTab()).toBeNull();
    saveLastActiveTab(tab({ path: "C:/a.md" }));
    saveLastActiveTab(tab({ path: "" }));
    expect(loadLastActiveTab()).toBeNull();
  });

  it("数据损坏 / 未知 kind → 返回 null（不抛错）", () => {
    localStorage.setItem(LAST_ACTIVE_TAB_KEY, "{{not json");
    expect(loadLastActiveTab()).toBeNull();
    localStorage.setItem(LAST_ACTIVE_TAB_KEY, JSON.stringify({ kind: "weird" }));
    expect(loadLastActiveTab()).toBeNull();
    localStorage.setItem(LAST_ACTIVE_TAB_KEY, JSON.stringify({ kind: "file", path: "" }));
    expect(loadLastActiveTab()).toBeNull();
  });

  it("clearLastActiveTab 移除键", () => {
    saveLastActiveTab(tab({ path: "C:/a.md" }));
    clearLastActiveTab();
    expect(localStorage.getItem(LAST_ACTIVE_TAB_KEY)).toBeNull();
  });
});

describe("v0.8.3 需求5：resolveLastActiveIndex 恢复定位", () => {
  const tabs = [
    tab({ path: "", isUntitled: true, id: "untitled-1" }),
    tab({ path: "C:/a.md" }),
    tab({ path: "C:/b.md" }),
  ];

  it("临时标签按 id 命中（重启后仍定位到最后停留的临时文件）", () => {
    expect(resolveLastActiveIndex({ kind: "untitled", id: "untitled-1" }, tabs)).toBe(0);
  });

  it("真实文件按 path 命中（不局限于第一个恢复的文件）", () => {
    expect(resolveLastActiveIndex({ kind: "file", path: "C:/b.md" }, tabs)).toBe(2);
  });

  it("未命中 / 无记录 → -1（调用方回退到既有逻辑）", () => {
    expect(resolveLastActiveIndex({ kind: "file", path: "C:/gone.md" }, tabs)).toBe(-1);
    expect(resolveLastActiveIndex({ kind: "untitled", id: "untitled-9" }, tabs)).toBe(-1);
    expect(resolveLastActiveIndex(null, tabs)).toBe(-1);
  });

  it("kind=file 不会误命中临时标签（path 为空串）", () => {
    expect(resolveLastActiveIndex({ kind: "file", path: "" }, tabs)).toBe(-1);
  });
});

describe("v0.8.3 需求6：fileScrollProgress 跨会话快照", () => {
  it("saveSnapshot 只写指定键（不落盘已关闭标签的残留）", () => {
    fileScrollProgress.set("C:/a.md", 0.5);
    fileScrollProgress.set("untitled:untitled-1", 0.25);
    fileScrollProgress.set("C:/closed.md", 0.9);

    fileScrollProgress.saveSnapshot(["C:/a.md", "untitled:untitled-1"]);
    const stored = JSON.parse(localStorage.getItem(SCROLL_PROGRESS_KEY)!);
    expect(stored).toEqual({ "C:/a.md": 0.5, "untitled:untitled-1": 0.25 });
  });

  it("loadSnapshot 把快照注入内存 Map（启动恢复路径）", () => {
    fileScrollProgress.set("C:/a.md", 0.66);
    fileScrollProgress.saveSnapshot(["C:/a.md"]);
    // 模拟重启：内存清空但 localStorage 保留
    fileScrollProgress.clear("C:/a.md");
    expect(fileScrollProgress.get("C:/a.md")).toBeNull();

    fileScrollProgress.loadSnapshot();
    expect(fileScrollProgress.get("C:/a.md")).toBeCloseTo(0.66, 10);
  });

  it("破损快照 / 非数字值不影响启动", () => {
    localStorage.setItem(SCROLL_PROGRESS_KEY, "not-json");
    expect(() => fileScrollProgress.loadSnapshot()).not.toThrow();
    localStorage.setItem(SCROLL_PROGRESS_KEY, JSON.stringify({ "C:/a.md": "x", "C:/b.md": 0.4 }));
    fileScrollProgress.loadSnapshot();
    expect(fileScrollProgress.get("C:/a.md")).toBeNull();
    expect(fileScrollProgress.get("C:/b.md")).toBeCloseTo(0.4, 10);
  });

  it("clearAll 同时清内存与落盘（开关关闭后无残留）", () => {
    fileScrollProgress.set("C:/a.md", 0.5);
    fileScrollProgress.saveSnapshot(["C:/a.md"]);
    fileScrollProgress.clearAll();
    expect(fileScrollProgress.get("C:/a.md")).toBeNull();
    expect(fileScrollProgress.size()).toBe(0);
    expect(localStorage.getItem(SCROLL_PROGRESS_KEY)).toBeNull();
  });

  it("hasUnsavedChanges 驱动 5s 心跳：无变化时跳过 localStorage 写", () => {
    fileScrollProgress.clearAll();
    expect(fileScrollProgress.hasUnsavedChanges()).toBe(false);
    fileScrollProgress.set("C:/a.md", 0.1);
    expect(fileScrollProgress.hasUnsavedChanges()).toBe(true);
    fileScrollProgress.saveSnapshot(["C:/a.md"]);
    expect(fileScrollProgress.hasUnsavedChanges()).toBe(false);
  });

  it("clear 不存在的键不产生无意义的落盘标记", () => {
    fileScrollProgress.clearAll();
    fileScrollProgress.clear("C:/never.md");
    expect(fileScrollProgress.hasUnsavedChanges()).toBe(false);
  });

  it("move 把进度从 untitled:<id> 迁移到晋升后的真实路径", () => {
    fileScrollProgress.set("untitled:untitled-2", 0.42);
    fileScrollProgress.move("untitled:untitled-2", "C:/saved.md");
    expect(fileScrollProgress.get("untitled:untitled-2")).toBeNull();
    expect(fileScrollProgress.get("C:/saved.md")).toBeCloseTo(0.42, 10);
    // 同键 / 空键 → no-op
    fileScrollProgress.move("C:/saved.md", "C:/saved.md");
    fileScrollProgress.move(null, "C:/x.md");
    expect(fileScrollProgress.get("C:/x.md")).toBeNull();
  });
});

describe("v0.8.3 WP4：App / EditorContainer 源码接线", () => {
  it("需求5：恢复末尾按 last-active 定位，未命中才回退第一个真实文件", () => {
    expect(appSrc).toContain("resolveLastActiveIndex(loadLastActiveTab(), openTabs)");
    expect(appSrc).toContain(": openTabs.findIndex((tb) => !tb.isUntitled && tb.path);");
    // 激活块支持临时标签（path 为空串 → openFile(null)、currentDocPath 清空）
    expect(appSrc).toContain('setCurrentDocPath(targetTab.path || "")');
    expect(appSrc).toContain("openFile(targetTab.path || null)");
  });

  it("需求5：写入时机覆盖 防抖 / beforeunload / 标签切换 三条路径", () => {
    expect(appSrc).toMatch(/saveLastActiveTab\(st\.openTabs\[st\.activeTabIdx\] \?\? null\)/);
    // handleTabSwitch 内显式调用（切标签不会改变 openTabs 引用）
    expect(appSrc).toContain("saveLastActiveTab(tab);");
    // 开关关闭时一并清理
    expect(appSrc).toContain("clearLastActiveTab()");
  });

  it("需求6：会话恢复期守卫阻止 openFile 处理里的 clear 清掉刚注入的进度", () => {
    expect(appSrc).toContain("!alreadyOpen && !sessionRestoringRef.current");
    expect(appSrc).toContain("const sessionRestoringRef = useRef(true);");
    expect(appSrc).toContain("sessionRestoringRef.current = false;");
  });

  it("需求6：启动注入快照 + 开关关闭时清理 + 5s 心跳落盘", () => {
    expect(appSrc).toContain("fileScrollProgress.loadSnapshot();");
    expect(appSrc).toContain("fileScrollProgress.clearAll();");
    expect(appSrc).toContain("fileScrollProgress.saveSnapshot(tabsProgressKeys(useEditorStore.getState().openTabs))");
    expect(appSrc).toContain("setInterval(snapshot, 5000)");
    expect(appSrc).toContain("fileScrollProgress.hasUnsavedChanges()");
  });

  it("需求6：关闭临时标签 / 另存为晋升 分别清理与迁移进度键", () => {
    expect(appSrc).toContain("fileScrollProgress.clear(untitledProgressKey(tab.id))");
    expect(appSrc).toContain("fileScrollProgress.clear(closedTab.path || untitledProgressKey(closedTab.id))");
    expect(appSrc).toContain("fileScrollProgress.move(untitledProgressKey(oldTab?.id), selected)");
  });

  it("需求6：EditorContainer 用独立 progressKeyRef，activeFileRef 语义保持不动", () => {
    expect(containerSrc).toContain("const progressKeyRef = useRef<string | null>(null);");
    expect(containerSrc).toContain("fileScrollProgress.set(progressKeyRef.current, percent);");
    expect(containerSrc).toContain("fileScrollProgress.get(progressKeyRef.current)");
    // activeFileRef 仍是"真实磁盘路径"（AI 上下文 / 翻译快照归属判断依赖）
    expect(containerSrc).toContain("const activeFileRef = useRef<string | null | undefined>(undefined);");
    expect(containerSrc).toContain("activeFileRef.current = filePath;");
    // 进度相关的三处调用不应再读 activeFileRef
    expect(containerSrc).not.toContain("fileScrollProgress.set(activeFileRef.current");
    expect(containerSrc).not.toContain("fileScrollProgress.get(activeFileRef.current");
  });
});
