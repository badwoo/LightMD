/**
 * v0.8.0 WP1 临时（未落盘）文件体系测试
 *
 * 覆盖：
 * 1. createUntitledTab：命名"新文件N"递增、path 为空、isUntitled、id、激活
 * 2. addTab 对临时标签不做 path 去重（多个临时标签可共存），同 id 去重
 * 3. promoteTab：另存为后写入真实路径并清除临时标识
 * 4. getTabById 定位
 * 5. untitledTabs 持久化：只存临时标签、往返一致、无临时标签时清除键
 * 6. useAutoSave：filePath 为空（临时标签）时不触发写盘；有路径时正常写
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import {
  saveUntitledTabs,
  loadUntitledTabs,
  clearUntitledTabs,
  isUntitledRestoreEnabled,
  UNTITLED_TABS_KEY,
} from "../utils/untitledTabs";
import { useAutoSave } from "../hooks/useAutoSave";

function resetStore() {
  useEditorStore.setState({
    openTabs: [],
    activeTabIdx: 0,
    filePath: null,
    isDirty: false,
    suppressAutoSave: false,
    viewMode: "edit",
  });
}

describe("v0.8.0 WP1 临时文件体系", () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
  });

  describe("createUntitledTab", () => {
    it("创建临时标签：path 为空、isUntitled、id 递增、自动激活", () => {
      act(() => useEditorStore.getState().createUntitledTab());
      let s = useEditorStore.getState();
      expect(s.openTabs).toHaveLength(1);
      const tab = s.openTabs[0];
      expect(tab.path).toBe("");
      expect(tab.isUntitled).toBe(true);
      expect(tab.id).toBe("untitled-1");
      expect(tab.name).toMatch(/1$/); // 新文件1 / Untitled 1
      expect(s.activeTabIdx).toBe(0);

      act(() => useEditorStore.getState().createUntitledTab());
      s = useEditorStore.getState();
      expect(s.openTabs).toHaveLength(2);
      expect(s.openTabs[1].id).toBe("untitled-2");
      expect(s.activeTabIdx).toBe(1);
    });

    it("序号不复用：关闭第一个后再新建得到 新文件3", () => {
      act(() => useEditorStore.getState().createUntitledTab());
      act(() => useEditorStore.getState().createUntitledTab());
      act(() => useEditorStore.getState().closeTab(0));
      act(() => useEditorStore.getState().createUntitledTab());
      const s = useEditorStore.getState();
      expect(s.openTabs.map((t) => t.id)).toEqual(["untitled-2", "untitled-3"]);
    });

    it("多个临时标签共存（path 均为空串也不被去重吞掉）", () => {
      act(() => useEditorStore.getState().createUntitledTab());
      act(() => useEditorStore.getState().createUntitledTab());
      act(() => useEditorStore.getState().createUntitledTab());
      expect(useEditorStore.getState().openTabs).toHaveLength(3);
    });

    it("同 id 的临时标签不会重复添加", () => {
      const { addTab } = useEditorStore.getState();
      act(() => {
        addTab({ id: "untitled-9", path: "", name: "新文件9", isUntitled: true, content: "a" });
        addTab({ id: "untitled-9", path: "", name: "新文件9", isUntitled: true, content: "b" });
      });
      expect(useEditorStore.getState().openTabs).toHaveLength(1);
    });
  });

  describe("promoteTab / getTabById", () => {
    it("另存为后晋升为正式文件（写路径、清临时标识）", () => {
      act(() => useEditorStore.getState().createUntitledTab());
      act(() => useEditorStore.getState().promoteTab(0, "D:/docs/a.md", "a.md"));
      const tab = useEditorStore.getState().openTabs[0];
      expect(tab.path).toBe("D:/docs/a.md");
      expect(tab.name).toBe("a.md");
      expect(tab.isUntitled).toBe(false);
      expect(tab.id).toBeUndefined();
    });

    it("getTabById 能定位到第二个临时标签（按 path 会永远命中第一个）", () => {
      act(() => useEditorStore.getState().createUntitledTab());
      act(() => useEditorStore.getState().createUntitledTab());
      expect(useEditorStore.getState().getTabById("untitled-2")).toBe(1);
      expect(useEditorStore.getState().getTabById("untitled-404")).toBe(-1);
      // 对照：按路径查找只会命中第一个临时标签——这正是改用 id 的原因
      expect(useEditorStore.getState().getTabByPath("")).toBe(0);
    });
  });

  describe("持久化（lightmd-untitled-tabs）", () => {
    it("只持久化临时标签，正式文件不入库", () => {
      saveUntitledTabs([
        { id: "untitled-1", path: "", name: "新文件1", content: "临时内容", isUntitled: true },
        { id: undefined, path: "D:/a.md", name: "a.md", content: "正式内容" },
      ]);
      const stored = loadUntitledTabs();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual({ id: "untitled-1", name: "新文件1", content: "临时内容" });
    });

    it("往返一致：编辑内容可恢复", () => {
      const tabs = [
        { id: "untitled-1", path: "", name: "新文件1", content: "第一行\n第二行", isUntitled: true },
        { id: "untitled-2", path: "", name: "新文件2", content: "", isUntitled: true },
      ];
      saveUntitledTabs(tabs);
      expect(loadUntitledTabs()).toEqual([
        { id: "untitled-1", name: "新文件1", content: "第一行\n第二行" },
        { id: "untitled-2", name: "新文件2", content: "" },
      ]);
    });

    it("没有临时标签时清除键；数据损坏时返回空数组", () => {      saveUntitledTabs([{ path: "D:/a.md", name: "a.md" }]);
      expect(localStorage.getItem(UNTITLED_TABS_KEY)).toBeNull();

      localStorage.setItem(UNTITLED_TABS_KEY, "{ 坏数据");
      expect(loadUntitledTabs()).toEqual([]);

      localStorage.setItem(UNTITLED_TABS_KEY, JSON.stringify([{ id: "x" }]));
      expect(loadUntitledTabs()).toEqual([]); // 缺 name 的条目被过滤

      clearUntitledTabs();
      expect(localStorage.getItem(UNTITLED_TABS_KEY)).toBeNull();
    });
  });

  describe("useAutoSave 对临时标签跳过", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      act(() => {
        useSettingsStore.setState({ autoSaveIntervalMs: 10 });
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      act(() => {
        useSettingsStore.setState({ autoSaveIntervalMs: 30000 });
      });
    });

    function makeRefs(content: string) {
      const viewRef = { current: {} as never };
      const sourceRef = { current: content };
      return { viewRef, sourceRef };
    }

    it("filePath 为空时不写盘（临时文件不受自动保存影响）", async () => {
      const { viewRef, sourceRef } = makeRefs("临时内容");
      renderHook(() => useAutoSave(viewRef as never, sourceRef as never));
      act(() => useEditorStore.setState({ filePath: "", isDirty: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(localStorage.getItem("lightmd-content")).toBeNull();
      // 脏标记也不应被清掉（保存根本没发生）
      expect(useEditorStore.getState().isDirty).toBe(true);
    });

    it("有真实路径时正常触发保存", async () => {
      const { viewRef, sourceRef } = makeRefs("正式内容");
      renderHook(() => useAutoSave(viewRef as never, sourceRef as never));
      act(() => useEditorStore.setState({ filePath: "D:/docs/a.md", isDirty: true }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(localStorage.getItem("lightmd-content")).toBe("正式内容");
      expect(useEditorStore.getState().isDirty).toBe(false);
    });
  });

  describe("P2-1：写盘与恢复共用 loadLastFileOnStartup 开关", () => {
    it("isUntitledRestoreEnabled 解析设置开关", () => {
      localStorage.removeItem("lightmd-settings");
      expect(isUntitledRestoreEnabled()).toBe(true); // 无设置 → 默认开启

      localStorage.setItem(
        "lightmd-settings",
        JSON.stringify({ state: { loadLastFileOnStartup: false } }),
      );
      expect(isUntitledRestoreEnabled()).toBe(false);

      localStorage.setItem(
        "lightmd-settings",
        JSON.stringify({ state: { loadLastFileOnStartup: true } }),
      );
      expect(isUntitledRestoreEnabled()).toBe(true);

      // 设置损坏 → 按开启处理（不能因为解析失败就丢内容）
      localStorage.setItem("lightmd-settings", "{坏数据");
      expect(isUntitledRestoreEnabled()).toBe(true);
    });

    it("开关关闭时 clearUntitledTabs 清空残留（模拟关闭后的写盘分支）", () => {
      saveUntitledTabs([
        { id: "untitled-1", path: "", name: "新文件1", content: "内容", isUntitled: true },
      ]);
      expect(loadUntitledTabs()).toHaveLength(1);
      clearUntitledTabs();
      expect(localStorage.getItem(UNTITLED_TABS_KEY)).toBeNull();
    });
  });
});
