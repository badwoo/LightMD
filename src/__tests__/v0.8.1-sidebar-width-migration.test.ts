/**
 * v0.8.1 需求4：左右侧栏默认宽度 +0.5cm（260/240 → 279/259）及老数据迁移
 *
 * 覆盖：
 * 1. store 初始默认值 = 279 / 259
 * 2. 老数据（version 0，仍是旧默认值）→ 迁移为新默认值
 * 3. 老数据（version 0，用户手动改过）→ 保持不变
 * 4. 已是 version 1 的数据（用户把宽度调回 260/240）→ 不被二次迁移
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../stores/useSettingsStore";

const STORAGE_KEY = "lightmd-settings";
const mockStorage: Record<string, string> = {};

/** 预置一份 localStorage 内容（结构同 zustand persist：{ state, version }） */
function setPersisted(state: Record<string, unknown>, version: number) {
  mockStorage[STORAGE_KEY] = JSON.stringify({ state, version });
}

const mockPersistStorage = {
  getItem: (name: string) =>
    Promise.resolve(mockStorage[name] ? JSON.parse(mockStorage[name]) : null),
  setItem: (name: string, value: { state: unknown; version: number }) => {
    mockStorage[name] = JSON.stringify(value);
    return Promise.resolve();
  },
  removeItem: (name: string) => {
    delete mockStorage[name];
    return Promise.resolve();
  },
};

describe("v0.8.1 需求4：侧栏默认宽度 +0.5cm", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    // store 创建时已缓存 localStorage 引用，此处替换为可控 storage 才能预置持久化数据
    (useSettingsStore as any).persist.setOptions({ storage: mockPersistStorage });
  });

  it("store 初始默认值：sidebarWidth=279, outlineWidth=259", () => {
    const initial = useSettingsStore.getInitialState();
    expect(initial.sidebarWidth).toBe(279);
    expect(initial.outlineWidth).toBe(259);
  });

  it("version 0 且仍是旧默认值(260/240) → 迁移到 279/259", async () => {
    setPersisted({ sidebarWidth: 260, outlineWidth: 240 }, 0);
    await (useSettingsStore as any).persist.rehydrate();
    expect(useSettingsStore.getState().sidebarWidth).toBe(279);
    expect(useSettingsStore.getState().outlineWidth).toBe(259);
  });

  it("version 0 但用户手动改过宽度(300/220) → 保持不动", async () => {
    setPersisted({ sidebarWidth: 300, outlineWidth: 220 }, 0);
    await (useSettingsStore as any).persist.rehydrate();
    expect(useSettingsStore.getState().sidebarWidth).toBe(300);
    expect(useSettingsStore.getState().outlineWidth).toBe(220);
  });

  it("已是 version 1 的数据 → 不再触发迁移（用户可自由调回旧值）", async () => {
    setPersisted({ sidebarWidth: 260, outlineWidth: 240 }, 1);
    await (useSettingsStore as any).persist.rehydrate();
    expect(useSettingsStore.getState().sidebarWidth).toBe(260);
    expect(useSettingsStore.getState().outlineWidth).toBe(240);
  });

  it("迁移后持久化版本号写回当前版本（v0.8.4 起 version=3）", async () => {
    setPersisted({ sidebarWidth: 260, outlineWidth: 240 }, 0);
    await (useSettingsStore as any).persist.rehydrate();
    // 触发一次写入，确认落盘版本号已升级（避免每次启动重复迁移）
    useSettingsStore.getState().setSidebarWidth(279);
    const saved = JSON.parse(mockStorage[STORAGE_KEY]);
    expect(saved.version).toBe(3);
  });

  it("拖拽范围 180~480 覆盖新默认值（279/259 不被钳制）", () => {
    useSettingsStore.getState().setSidebarWidth(279);
    expect(useSettingsStore.getState().sidebarWidth).toBe(279);
    useSettingsStore.getState().setOutlineWidth(259);
    expect(useSettingsStore.getState().outlineWidth).toBe(259);
  });
});
