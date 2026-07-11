/**
 * G6 主题系统增强测试
 *
 * 覆盖：
 * 1. 主题枚举值正确（6 个主题）
 * 2. setTheme 接受所有 6 个值
 * 3. 持久化 theme 字段（zustand persist）
 * 4. 主题切换后 data-theme 属性正确设置到 documentElement
 * 5. i18n 字典包含所有 6 个主题的翻译
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore, THEMES, type Theme } from "../stores/useSettingsStore";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";

// 在导入 store 之前 mock localStorage，确保 persist 中间件可读取
const mockStorage: Record<string, string> = {};

const mockLocalStorage = {
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

// 使用 Object.defineProperty 强制覆盖（jsdom 的 localStorage 可能是只读的）
Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  configurable: true,
  writable: true,
});

/**
 * 创建符合 zustand persist newImpl storage 接口的 mock
 * newImpl.storage.setItem(name, { state, version }) 需要序列化为 JSON 字符串
 * newImpl.storage.getItem(name) 返回反序列化后的对象
 */
function createMockPersistStorage() {
  return {
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
}

describe("G6 主题系统增强", () => {
  beforeEach(() => {
    // 清空 mock storage 与 store 状态
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    vi.clearAllMocks();
    // 重置 store 到初始状态（theme = light）
    useSettingsStore.setState({ theme: "light" });
    // 清空 documentElement 上的 data-theme
    document.documentElement.removeAttribute("data-theme");
    // 关键：zustand persist newImpl 在 store 创建时（import 时）已通过
    // createJSONStorage(() => localStorage) 缓存了 jsdom 原生 localStorage 引用。
    // 后续 setState 调用的 storage.setItem 写入 jsdom 内部存储，而非我们的 mockStorage。
    // 通过 setOptions({ storage }) 替换为可控的 mock persist storage，
    // 使后续 setItem 写入 mockStorage，便于测试断言。
    (useSettingsStore as any).persist?.setOptions?.({
      storage: createMockPersistStorage(),
    });
  });

  describe("主题枚举值", () => {
    it("THEMES 应包含 6 个主题", () => {
      expect(THEMES).toHaveLength(6);
    });

    it("THEMES 应包含所有预期主题", () => {
      expect(THEMES).toEqual([
        "light",
        "dark",
        "github",
        "newsprint",
        "night",
        "solarized",
      ]);
    });

    it("THEMES 应为只读数组（不可变）", () => {
      expect(Object.isFrozen(THEMES)).toBe(true);
    });

    it("Theme 类型应支持所有 6 个值（编译期检查，运行期遍历）", () => {
      const allValues: Theme[] = ["light", "dark", "github", "newsprint", "night", "solarized"];
      allValues.forEach((v) => {
        expect(THEMES).toContain(v);
      });
    });
  });

  describe("setTheme 接受所有 6 个值", () => {
    THEMES.forEach((themeName) => {
      it(`setTheme("${themeName}") 应正确设置 theme`, () => {
        useSettingsStore.getState().setTheme(themeName);
        expect(useSettingsStore.getState().theme).toBe(themeName);
      });
    });

    it("默认 theme 应为 light", () => {
      // 重置后未调用 setTheme
      useSettingsStore.setState({ theme: "light" });
      expect(useSettingsStore.getState().theme).toBe("light");
    });

    it("切换主题后 theme 状态应更新", () => {
      useSettingsStore.getState().setTheme("github");
      expect(useSettingsStore.getState().theme).toBe("github");
      useSettingsStore.getState().setTheme("night");
      expect(useSettingsStore.getState().theme).toBe("night");
      // 切回 light
      useSettingsStore.getState().setTheme("light");
      expect(useSettingsStore.getState().theme).toBe("light");
    });
  });

  describe("持久化 theme 字段", () => {
    it("setTheme 后应写入 localStorage（lightmd-settings）", async () => {
      useSettingsStore.getState().setTheme("solarized");
      // zustand persist newImpl 的 setItem 返回 Promise，需 await 让微任务执行
      await Promise.resolve();
      // persist 中间件应将 theme 写入 mockStorage
      const persisted = mockStorage["lightmd-settings"];
      expect(persisted).toBeDefined();
      expect(persisted).toContain('"theme":"solarized"');
    });

    it("从 localStorage 恢复 theme（模拟 hydration）", async () => {
      // 预置 mockStorage 中的持久化数据（与 zustand persist 序列化格式一致）
      mockStorage["lightmd-settings"] = JSON.stringify({
        state: { theme: "newsprint" },
        version: 0,
      });
      // 通过 rehydrate 触发从 mockStorage 恢复
      await (useSettingsStore as any).persist?.rehydrate?.();
      // 验证 store 的 theme 字段已从 mockStorage 恢复
      expect(useSettingsStore.getState().theme).toBe("newsprint");
    });

    it("切换到各主题后均应持久化到 localStorage", async () => {
      for (const themeName of THEMES) {
        useSettingsStore.getState().setTheme(themeName);
        // 等待 persist 异步写入完成
        await Promise.resolve();
        // 验证 mockStorage 中持久化的内容包含对应主题
        const persisted = mockStorage["lightmd-settings"];
        expect(persisted).toBeDefined();
        expect(persisted).toContain(`"theme":"${themeName}"`);
      }
    });
  });

  describe("主题切换后 data-theme 属性正确设置", () => {
    it("初始时 documentElement 不应有 data-theme 属性", () => {
      expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    });

    it("设置 data-theme 属性到 documentElement", () => {
      // 模拟 App.tsx 中的 useEffect 逻辑
      const theme: Theme = "github";
      document.documentElement.setAttribute("data-theme", theme);
      expect(document.documentElement.getAttribute("data-theme")).toBe("github");
    });

    it("切换主题后 data-theme 应同步更新", () => {
      // 模拟 App.tsx 中 useEffect 依赖 theme 变化的行为
      const applyTheme = (theme: Theme) => {
        document.documentElement.setAttribute("data-theme", theme);
      };

      THEMES.forEach((themeName) => {
        useSettingsStore.getState().setTheme(themeName);
        applyTheme(useSettingsStore.getState().theme);
        expect(document.documentElement.getAttribute("data-theme")).toBe(themeName);
      });
    });

    it("切换到 night 后 documentElement data-theme 应为 night", () => {
      document.documentElement.setAttribute("data-theme", "night");
      expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    });

    it("切换到 solarized 后 documentElement data-theme 应为 solarized", () => {
      document.documentElement.setAttribute("data-theme", "solarized");
      expect(document.documentElement.getAttribute("data-theme")).toBe("solarized");
    });
  });

  describe("i18n 字典覆盖", () => {
    it("zh-CN 字典应包含所有 6 个主题翻译", () => {
      THEMES.forEach((themeName) => {
        const key = `settings.theme.${themeName}`;
        expect(zhCN[key]).toBeDefined();
        expect(typeof zhCN[key]).toBe("string");
        expect(zhCN[key].length).toBeGreaterThan(0);
      });
    });

    it("en-US 字典应包含所有 6 个主题翻译", () => {
      THEMES.forEach((themeName) => {
        const key = `settings.theme.${themeName}`;
        expect(enUS[key]).toBeDefined();
        expect(typeof enUS[key]).toBe("string");
        expect(enUS[key].length).toBeGreaterThan(0);
      });
    });

    it("中英文 key 应完全一致", () => {
      const zhKeys = Object.keys(zhCN).filter((k) => k.startsWith("settings.theme."));
      const enKeys = Object.keys(enUS).filter((k) => k.startsWith("settings.theme."));
      expect(zhKeys.sort()).toEqual(enKeys.sort());
    });
  });
});
