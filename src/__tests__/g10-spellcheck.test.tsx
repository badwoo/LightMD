/**
 * G10 拼写检查 - 单元测试
 *
 * 覆盖：
 * 1. useSettingsStore.spellcheckEnabled
 *    - 默认值 false
 *    - setSpellcheckEnabled 切换状态
 *    - 持久化到 localStorage
 * 2. createEditor 的 spellcheck 属性设置
 *    - spellcheckEnabled=false 时 .ProseMirror spellcheck="false"
 *    - spellcheckEnabled=true 时 .ProseMirror spellcheck="true"
 * 3. SettingsDialog 渲染开关
 *    - 默认渲染开关（关闭状态）
 *    - 点击开关调用 setSpellcheckEnabled
 * 4. i18n 字典包含 settings.spellcheck
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useSettingsStore } from "../stores/useSettingsStore";
import { createEditor } from "../core/editor";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { t, _setCurrentLanguage } from "../i18n/state";

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

// mock matchMedia（SettingsDialog 中的 CSS 可能依赖）
(globalThis as any).matchMedia =
  (globalThis as any).matchMedia ||
  ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

describe("G10 useSettingsStore.spellcheckEnabled", () => {
  beforeEach(() => {
    // 清空 mock storage 与 store 状态
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    vi.clearAllMocks();
    // 每个测试前重置 spellcheckEnabled 为默认值 false
    useSettingsStore.setState({ spellcheckEnabled: false });
    // 关键：zustand persist newImpl 在 store 创建时（import 时）已通过
    // createJSONStorage(() => localStorage) 缓存了 jsdom 原生 localStorage 引用。
    // 后续 setState 调用的 storage.setItem 写入 jsdom 内部存储，而非我们的 mockStorage。
    // 通过 setOptions({ storage }) 替换为可控的 mock persist storage，
    // 使后续 setItem 写入 mockStorage，便于测试断言。
    (useSettingsStore as any).persist?.setOptions?.({
      storage: createMockPersistStorage(),
    });
  });

  it("默认值为 false", () => {
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(false);
  });

  it("setSpellcheckEnabled(true) 后变为 true", () => {
    useSettingsStore.getState().setSpellcheckEnabled(true);
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
  });

  it("切换开关 false -> true -> false", () => {
    useSettingsStore.getState().setSpellcheckEnabled(true);
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
    useSettingsStore.getState().setSpellcheckEnabled(false);
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(false);
  });

  it("setter 存在 setSpellcheckEnabled", () => {
    expect(typeof useSettingsStore.getState().setSpellcheckEnabled).toBe("function");
  });

  it("持久化 spellcheckEnabled 到 localStorage", async () => {
    // 设置 spellcheckEnabled = true，触发 persist 写入
    useSettingsStore.getState().setSpellcheckEnabled(true);
    // zustand persist newImpl 的 setItem 返回 Promise，需 await 让微任务执行
    await Promise.resolve();
    // 从 mockStorage 读取持久化数据
    const persisted = mockStorage["lightmd-settings"];
    expect(persisted).toBeDefined();
    const parsed = JSON.parse(persisted);
    // zustand persist 默认将 state 嵌套在 state 字段下
    expect(parsed.state.spellcheckEnabled).toBe(true);
  });

  it("关闭状态也会持久化 false", async () => {
    useSettingsStore.getState().setSpellcheckEnabled(false);
    // 等待 persist 异步写入完成
    await Promise.resolve();
    const persisted = mockStorage["lightmd-settings"];
    expect(persisted).toBeDefined();
    const parsed = JSON.parse(persisted);
    expect(parsed.state.spellcheckEnabled).toBe(false);
  });
});

describe("G10 createEditor spellcheck 属性设置", () => {
  beforeEach(() => {
    useSettingsStore.setState({ spellcheckEnabled: false });
  });

  it("spellcheckEnabled=false 时 .ProseMirror spellcheck='false'", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = createEditor({
      parent,
      spellcheckEnabled: false,
      initialContent: "# test",
    });
    expect(view).not.toBeNull();
    const pmDom = parent.querySelector(".ProseMirror") as HTMLElement;
    expect(pmDom).not.toBeNull();
    expect(pmDom.getAttribute("spellcheck")).toBe("false");
    view?.destroy();
    parent.remove();
  });

  it("spellcheckEnabled=true 时 .ProseMirror spellcheck='true'", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = createEditor({
      parent,
      spellcheckEnabled: true,
      initialContent: "# test",
    });
    expect(view).not.toBeNull();
    const pmDom = parent.querySelector(".ProseMirror") as HTMLElement;
    expect(pmDom).not.toBeNull();
    expect(pmDom.getAttribute("spellcheck")).toBe("true");
    view?.destroy();
    parent.remove();
  });

  it("未传 spellcheckEnabled 时默认 'false'", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = createEditor({
      parent,
      initialContent: "# test",
    });
    const pmDom = parent.querySelector(".ProseMirror") as HTMLElement;
    expect(pmDom.getAttribute("spellcheck")).toBe("false");
    view?.destroy();
    parent.remove();
  });
});

describe("G10 SettingsDialog 渲染开关", () => {
  beforeEach(() => {
    useSettingsStore.setState({ spellcheckEnabled: false, language: "zh-CN" });
    _setCurrentLanguage("zh-CN");
    cleanup();
  });

  it("渲染设置对话框时包含拼写检查开关（中文文案）", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    // 查找"拼写检查"文案
    expect(screen.getByText("拼写检查")).toBeTruthy();
  });

  it("默认开关状态为关闭（显示关闭文案）", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    // 在开关 label 内查找"关闭"文案
    const switchLabels = screen.getAllByText("关闭");
    // 拼写检查开关应包含"关闭"（其他开关如代码行号也可能是"开启"）
    expect(switchLabels.length).toBeGreaterThan(0);
  });

  it("点击拼写检查开关调用 setSpellcheckEnabled(true)", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    // 找到"拼写检查"对应的 checkbox（在 label 文案之后的 settings-switch 内）
    const spellcheckField = screen.getByText("拼写检查").closest(".settings-field");
    expect(spellcheckField).not.toBeNull();
    const checkbox = spellcheckField?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    // 点击切换
    fireEvent.click(checkbox);
    expect(useSettingsStore.getState().spellcheckEnabled).toBe(true);
  });

  it("开关开启后显示开启文案", () => {
    useSettingsStore.setState({ spellcheckEnabled: true });
    render(<SettingsDialog onClose={vi.fn()} />);
    const spellcheckField = screen.getByText("拼写检查").closest(".settings-field");
    const switchLabel = spellcheckField?.querySelector(".settings-switch-label");
    expect(switchLabel?.textContent).toBe("开启");
  });

  it("英文文案渲染 'Spell Check'", () => {
    useSettingsStore.setState({ language: "en-US" });
    _setCurrentLanguage("en-US");
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByText("Spell Check")).toBeTruthy();
  });
});

describe("G10 i18n 字典包含 settings.spellcheck", () => {
  it("中文翻译 'settings.spellcheck' = '拼写检查'", () => {
    _setCurrentLanguage("zh-CN");
    expect(t("settings.spellcheck")).toBe("拼写检查");
  });

  it("英文翻译 'settings.spellcheck' = 'Spell Check'", () => {
    _setCurrentLanguage("en-US");
    expect(t("settings.spellcheck")).toBe("Spell Check");
  });
});
