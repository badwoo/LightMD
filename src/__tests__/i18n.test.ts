/**
 * i18n 国际化核心模块测试
 *
 * 覆盖：
 * 1. t() 函数基础翻译
 * 2. {name} 参数替换
 * 3. 缺失 key 回退到 key 本身并 console.warn
 * 4. 语言切换（中→英 / 英→中）
 * 5. getCurrentLanguage 返回正确
 * 6. useT Hook 响应 language 变化
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSettingsStore } from "../stores/useSettingsStore";

// 在导入 i18n 之前先 mock localStorage，确保 useSettingsStore persist 能读取
const mockStorage: Record<string, string> = {};

(globalThis as any).localStorage = {
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

// 导入要测试的模块
import { t, getCurrentLanguage, _setCurrentLanguage } from "../i18n/state";
import { useT } from "../i18n";
import { renderHook, act } from "@testing-library/react";

describe("i18n t() 函数", () => {
  beforeEach(() => {
    // 每个测试前重置语言为中文
    _setCurrentLanguage("zh-CN");
    useSettingsStore.setState({ language: "zh-CN" });
    mockStorage["lightmd-settings"] = JSON.stringify({
      state: { language: "zh-CN" },
    });
  });

  it("默认使用中文翻译", () => {
    expect(t("settings.title")).toBe("偏好设置");
    expect(t("settings.appearance")).toBe("外观");
    expect(t("settings.editor")).toBe("编辑器");
    expect(t("settings.language")).toBe("界面语言");
  });

  it("英文翻译", () => {
    _setCurrentLanguage("en-US");
    expect(t("settings.title")).toBe("Preferences");
    expect(t("settings.appearance")).toBe("Appearance");
    expect(t("settings.editor")).toBe("Editor");
    expect(t("settings.language")).toBe("Interface Language");
  });

  it("支持 {name} 参数替换", () => {
    // 字典里没有带 {name} 的 key，构造一个临时测试
    // 直接在 zh-CN 字典里查找简单 key 验证参数替换逻辑
    // 这里通过自定义 params 测试参数替换机制
    _setCurrentLanguage("zh-CN");
    // 用一个不存在的 key 触发回退，再验证 params 替换
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = t("hello.{name}", { name: "world" });
    expect(result).toBe("hello.world");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("缺失 key 回退到 key 本身并 console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = t("nonexistent.key.test");
    expect(result).toBe("nonexistent.key.test");
    expect(warn).toHaveBeenCalledWith("[i18n] missing key: nonexistent.key.test");
    warn.mockRestore();
  });

  it("中英文 key 集合完全一致", async () => {
    // 动态导入字典，比较 key 集合
    const { zhCN } = await import("../i18n/locales/zh-CN");
    const { enUS } = await import("../i18n/locales/en-US");
    const zhKeys = Object.keys(zhCN).sort();
    const enKeys = Object.keys(enUS).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("参数替换支持数字类型", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = t("count.{n}", { n: 42 });
    expect(result).toBe("count.42");
    warn.mockRestore();
  });

  it("参数替换支持多个参数", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = t("{a}-{b}-{c}", { a: "x", b: "y", c: "z" });
    expect(result).toBe("x-y-z");
    warn.mockRestore();
  });
});

describe("getCurrentLanguage", () => {
  beforeEach(() => {
    _setCurrentLanguage("zh-CN");
  });

  it("默认返回 zh-CN", () => {
    expect(getCurrentLanguage()).toBe("zh-CN");
  });

  it("切换后返回新语言", () => {
    _setCurrentLanguage("en-US");
    expect(getCurrentLanguage()).toBe("en-US");
    _setCurrentLanguage("zh-CN");
    expect(getCurrentLanguage()).toBe("zh-CN");
  });
});

describe("useT Hook", () => {
  beforeEach(() => {
    _setCurrentLanguage("zh-CN");
    useSettingsStore.setState({ language: "zh-CN" });
  });

  afterEach(() => {
    _setCurrentLanguage("zh-CN");
    useSettingsStore.setState({ language: "zh-CN" });
  });

  it("返回 t 函数并正确翻译", () => {
    const { result } = renderHook(() => useT());
    const t = result.current;
    expect(t("settings.title")).toBe("偏好设置");
  });

  it("language 变化时触发组件重渲染", () => {
    let renderCount = 0;
    const { result, rerender } = renderHook(() => {
      renderCount++;
      return useT();
    });
    expect(renderCount).toBe(1);
    expect(result.current("settings.title")).toBe("偏好设置");

    // 切换到英文：通过 store setter 触发订阅
    act(() => {
      useSettingsStore.getState().setLanguage("en-US");
    });
    // 触发重渲染
    rerender();
    expect(result.current("settings.title")).toBe("Preferences");

    // 切换回中文
    act(() => {
      useSettingsStore.getState().setLanguage("zh-CN");
    });
    rerender();
    expect(result.current("settings.title")).toBe("偏好设置");
  });
});

describe("useSettingsStore setLanguage 集成", () => {
  beforeEach(() => {
    _setCurrentLanguage("zh-CN");
    useSettingsStore.setState({ language: "zh-CN" });
  });

  it("setLanguage 同步更新 i18n 模块缓存", () => {
    // 切换到英文
    useSettingsStore.getState().setLanguage("en-US");
    expect(getCurrentLanguage()).toBe("en-US");
    expect(t("settings.title")).toBe("Preferences");

    // 切换回中文
    useSettingsStore.getState().setLanguage("zh-CN");
    expect(getCurrentLanguage()).toBe("zh-CN");
    expect(t("settings.title")).toBe("偏好设置");
  });
});

// ─── 阶段 2f：扩展 key 翻译验证（核心 UI 组件 i18n 覆盖）──────────
describe("阶段 2f 扩展 key 翻译验证", () => {
  // 验证新增的各模块 key 在两种语言下都有非空翻译
  // 覆盖：titlebar/filetree/outline/recent/appshell/tabbar/editor/app/menu/command/search/syntax 等模块
  const SAMPLE_KEYS = [
    // 标题栏
    "titlebar.read", "titlebar.edit", "titlebar.split", "titlebar.newFile",
    // 文件树
    "filetree.title", "filetree.newFileTitle", "filetree.confirmDelete",
    // 大纲
    "outline.title", "outline.empty", "outline.more",
    // 最近文件
    "recent.title", "recent.justNow", "recent.minutesAgo",
    // AppShell
    "appshell.expandSidebar", "appshell.collapseSidebar",
    // 标签栏
    "tabbar.close",
    // 编辑器
    "editor.renderFailed", "editor.emptyHint", "editor.preview",
    // App
    "app.untitled", "app.confirmNewWithUnsaved", "app.largeFileNotify",
    // 菜单
    "menu.undo", "menu.redo", "menu.bold", "menu.insertLink",
    // 命令菜单
    "command.group.basic", "command.h1.name", "command.bold.name", "command.ariaLabel",
    // 搜索替换
    "search.placeholder", "search.caseSensitive", "search.replace", "search.replaceAll",
    // 语法辅助
    "syntax.title", "syntax.section.heading", "syntax.h1", "syntax.bold",
    // 状态栏
    "statusbar.words", "statusbar.focusMode", "statusbar.typewriter", "statusbar.line",
    // 通用
    "common.ok", "common.cancel", "common.save",
  ];

  it("所有样例 key 在中文字典中都有非空翻译", () => {
    _setCurrentLanguage("zh-CN");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const key of SAMPLE_KEYS) {
      const result = t(key);
      expect(result, `中文 key "${key}" 应有非空翻译`).toBeTruthy();
      expect(result, `中文 key "${key}" 不应回退到 key 本身`).not.toBe(key);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("所有样例 key 在英文字典中都有非空翻译", () => {
    _setCurrentLanguage("en-US");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const key of SAMPLE_KEYS) {
      const result = t(key);
      expect(result, `英文 key "${key}" 应有非空翻译`).toBeTruthy();
      expect(result, `英文 key "${key}" 不应回退到 key 本身`).not.toBe(key);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    // 恢复中文
    _setCurrentLanguage("zh-CN");
  });

  it("参数替换在两种语言下都正常工作", () => {
    _setCurrentLanguage("zh-CN");
    expect(t("outline.more", { count: 5 })).toBe("还有 5 个标题...");
    expect(t("statusbar.line", { line: 42 })).toBe("行 42");
    expect(t("filetree.confirmDelete", { type: "文件", name: "test.md" })).toBe("确认删除 文件 \"test.md\"？");

    _setCurrentLanguage("en-US");
    expect(t("outline.more", { count: 5 })).toBe("5 more headings...");
    expect(t("statusbar.line", { line: 42 })).toBe("Line 42");
    expect(t("filetree.confirmDelete", { type: "file", name: "test.md" })).toBe("Confirm delete file \"test.md\"?");
    // 恢复中文
    _setCurrentLanguage("zh-CN");
  });

  it("字典 key 数量充足（至少 150 个）", async () => {
    const { zhCN } = await import("../i18n/locales/zh-CN");
    const { enUS } = await import("../i18n/locales/en-US");
    expect(Object.keys(zhCN).length).toBeGreaterThanOrEqual(150);
    expect(Object.keys(enUS).length).toBeGreaterThanOrEqual(150);
  });
});
