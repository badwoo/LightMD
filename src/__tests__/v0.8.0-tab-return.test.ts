/**
 * v0.8.0 修复 P2（需求2）单元测试
 *
 * 问题1：标签栏空白处双击新建临时文件后没有立即跳转、也无法编辑
 *        → 根因是双击路径只调了 store.createUntitledTab()，未同步 content/filePath/forceUpdateKey
 * 问题2：关闭该临时标签应回到"新建前所在的文件"，且阅读位置不变
 *        → 由临时标签的 returnToId 记录 + closeTab 优先回到该标签实现
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";

const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
const tabBarSrc = readFileSync(
  resolve(__dirname, "../components/layout/TabBar.tsx"),
  "utf-8",
);

function resetStore(tabs: TabInfo[], activeTabIdx: number) {
  useEditorStore.setState({ openTabs: tabs, activeTabIdx });
}

const tabA: TabInfo = { path: "D:/a.md", name: "a.md" };
const tabB: TabInfo = { path: "D:/b.md", name: "b.md" };

describe("v0.8.0 修复 P2 临时标签记录返回目标", () => {
  beforeEach(() => resetStore([tabA, tabB], 0));

  it("在 A 上新建临时标签时记录 returnToId = A 的标识", () => {
    useEditorStore.getState().createUntitledTab();
    const s = useEditorStore.getState();
    const created = s.openTabs[s.openTabs.length - 1];
    expect(created.isUntitled).toBe(true);
    expect(created.returnToId).toBe("D:/a.md");
  });

  it("临时标签之间的新建记录的是上一个临时标签", () => {
    useEditorStore.getState().createUntitledTab();
    useEditorStore.getState().createUntitledTab();
    const s = useEditorStore.getState();
    expect(s.openTabs[3].returnToId).toBe("untitled-1");
  });
});

describe("v0.8.0 修复 P2 关闭临时标签回到原文件", () => {
  beforeEach(() => resetStore([tabA, tabB], 0));

  it("在 A 上新建后关闭临时标签 → 回到 A（而不是相邻的 B）", () => {
    useEditorStore.getState().createUntitledTab();
    expect(useEditorStore.getState().activeTabIdx).toBe(2);

    const closed = useEditorStore.getState().closeTab(2);
    expect(closed?.isUntitled).toBe(true);
    // 旧的"优先右侧否则左侧"会落到 B（索引 1），修复后应回到 A（索引 0）
    expect(useEditorStore.getState().activeTabIdx).toBe(0);
  });

  it("关闭非活跃标签不影响当前激活项", () => {
    useEditorStore.getState().createUntitledTab();
    useEditorStore.getState().closeTab(0);
    expect(useEditorStore.getState().activeTabIdx).toBe(1);
    expect(useEditorStore.getState().openTabs[1].isUntitled).toBe(true);
  });

  it("返回目标已不存在时回退到相邻标签策略", () => {
    useEditorStore.getState().createUntitledTab();
    const s0 = useEditorStore.getState();
    // 模拟 A 已被关闭：移除 A 并把 returnToId 置为不存在的路径
    useEditorStore.setState({
      openTabs: [
        { ...tabB },
        { ...s0.openTabs[2], returnToId: "D:/gone.md" },
      ],
      activeTabIdx: 1,
    });
    useEditorStore.getState().closeTab(1);
    expect(useEditorStore.getState().activeTabIdx).toBe(0);
  });
});

describe("v0.8.0 修复 P2 入口接线", () => {
  it("TabBar 双击优先调用 App 提供的 onNewUntitled", () => {
    expect(tabBarSrc).toContain("onNewUntitled");
    expect(tabBarSrc).toContain("if (onNewUntitled) {");
  });

  it("App 提供 handleNewUntitled 并同步编辑器上下文", () => {
    expect(appSrc).toContain("handleNewUntitled");
    expect(appSrc).toContain("onNewUntitled={handleNewUntitled}");
    // 同步 content / filePath / forceUpdateKey（否则新建后无法编辑）
    expect(appSrc).toContain("const createUntitledTabAndSync");
    expect(appSrc).toContain("setForceUpdateKey((k) => k + 1)");
  });

  it("新建临时标签后立即持久化（启动恢复能拿到最新内容）", () => {
    expect(appSrc).toMatch(/createUntitledTabAndSync[\s\S]{0,600}saveUntitledTabs\(useEditorStore\.getState\(\)\.openTabs\)/);
  });
});