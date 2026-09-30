/**
 * v0.9.0 自定义快捷键：持久化与生效注入（jsdom 集成）。
 *
 * 覆盖评审发现的「只有 migrate 清洗、已是 v4 的脏数据走 merge 不清洗」缺口，
 * 以及「覆盖表注入 core 运行时」这条关键链路（A7 的本地侧）。
 * 用真实 localStorage + `persist.rehydrate()`，走的是应用启动时的同一条路径。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { useSettingsStore } from "../stores/useSettingsStore";
import { effectiveCombo, getShortcutDef, setShortcutOverrides } from "../core/shortcuts";

const KEY = "lightmd-settings";

function seed(payload: unknown, version: number) {
  localStorage.setItem(KEY, JSON.stringify({ state: payload, version }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  localStorage.clear();
  useSettingsStore.setState({ shortcuts: {} });
  setShortcutOverrides({});
  await useSettingsStore.persist.rehydrate();
});

describe("v0.9.0 review：覆盖表持久化（migrate / merge 双路径清洗）", () => {
  it("version 4（merge 路径）的脏覆盖被清洗：非法键位/未登记 id 不生效", async () => {
    seed(
      {
        theme: "dark",
        shortcuts: {
          "format.bold": "B", // D5 违规：裸字母会吞掉编辑器里每个 b 键
          "hack.id": "Ctrl+H", // 未登记 id
          "file.saveAs": "Ctrl+R", // 保留占用（文件树刷新）
          "file.new": "Ctrl+J", // 合法
        },
      },
      4,
    );
    await useSettingsStore.persist.rehydrate();
    const state = useSettingsStore.getState();
    expect(state.shortcuts).toEqual({ "file.new": "Ctrl+J" });
    // 其他设置不丢
    expect(state.theme).toBe("dark");
  });

  it("version 3（migrate 路径）缺字段归一为 {}，其余设置保留", async () => {
    seed({ theme: "github", fontSize: 18, shortcuts: { "file.new": "Ctrl+J" } }, 3);
    await useSettingsStore.persist.rehydrate();
    const state = useSettingsStore.getState();
    // v3 数据里的快捷键字段是同一套格式，合法项保留
    expect(state.shortcuts).toEqual({ "file.new": "Ctrl+J" });
    expect(state.theme).toBe("github");
    expect(state.fontSize).toBe(18);
  });

  it("清洗后的覆盖表注入 core 运行时（生效键位随落盘数据恢复）", async () => {
    seed({ shortcuts: { "file.new": "Ctrl+J" } }, 4);
    await useSettingsStore.persist.rehydrate();
    const def = getShortcutDef("file.new")!;
    expect(effectiveCombo(def)).toBe("Ctrl+J");
  });

  it("脏覆盖不会进入运行时（避免按键被静默吞掉）", async () => {
    seed({ shortcuts: { "format.bold": "B" } }, 4);
    await useSettingsStore.persist.rehydrate();
    const def = getShortcutDef("format.bold")!;
    expect(effectiveCombo(def)).toBe("Ctrl+B");
  });
});
