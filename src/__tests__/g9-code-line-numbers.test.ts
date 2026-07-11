/**
 * G9 代码块行号 - 单元测试
 *
 * 覆盖：
 * 1. generateLineNumbers 纯函数
 *    - 空代码 / 单行 / 多行 / 末尾换行 / 长代码块（100+ 行）
 * 2. useSettingsStore.showCodeLineNumbers
 *    - 默认值 / setter / 切换
 * 3. CodeBlockView 行号层 DOM
 *    - 行号层存在
 *    - showLineNumbers 切换 display 状态
 *    - 行号内容与代码行数对应
 *    - 空代码块不显示行号
 *    - 单行代码块行号 "1"
 *    - 订阅 store 实时响应
 *    - 复制时不包含行号（user-select:none 由 CSS class 保证）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore } from "../stores/useSettingsStore";
import { lightMDSchema } from "../core/schema";
import { CodeBlockView, generateLineNumbers } from "../core/plugins/code-block";

// 在导入 store 之前 mock localStorage，确保 persist 中间件可读取
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

/** 构造 mock EditorView（CodeBlockView 构造中未实际使用 view 字段） */
function createMockView() {
  return {} as any;
}

/** 构造 code_block 节点 */
function createCodeBlockNode(code: string, language = "") {
  const textNode = code ? lightMDSchema.text(code) : null;
  return lightMDSchema.nodes.code_block.create(
    { language },
    textNode ? [textNode] : []
  );
}

describe("G9 generateLineNumbers 纯函数", () => {
  it("空代码返回空字符串", () => {
    expect(generateLineNumbers("")).toBe("");
  });

  it("单行代码返回 '1'", () => {
    expect(generateLineNumbers("const x = 1;")).toBe("1");
  });

  it("10 行代码生成 1-10 行号", () => {
    const code = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const expected = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10";
    expect(generateLineNumbers(code)).toBe(expected);
  });

  it("多行代码行号正确（3 行）", () => {
    expect(generateLineNumbers("a\nb\nc")).toBe("1\n2\n3");
  });

  it("末尾换行不算一行", () => {
    // 两行内容 + 末尾换行 -> 仍只有 2 个行号
    expect(generateLineNumbers("a\nb\n")).toBe("1\n2");
    // 单行 + 末尾换行 -> 1 个行号
    expect(generateLineNumbers("a\n")).toBe("1");
  });

  it("长代码块（150 行）生成正确", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `line${i + 1}`);
    const code = lines.join("\n");
    const result = generateLineNumbers(code);
    const expected = Array.from({ length: 150 }, (_, i) => String(i + 1)).join("\n");
    expect(result).toBe(expected);
    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(150);
    expect(resultLines[0]).toBe("1");
    expect(resultLines[149]).toBe("150");
  });
});

describe("G9 useSettingsStore.showCodeLineNumbers", () => {
  beforeEach(() => {
    useSettingsStore.setState({ showCodeLineNumbers: true });
  });

  it("默认值为 true", () => {
    expect(useSettingsStore.getState().showCodeLineNumbers).toBe(true);
  });

  it("setShowCodeLineNumbers(false) 后变为 false", () => {
    useSettingsStore.getState().setShowCodeLineNumbers(false);
    expect(useSettingsStore.getState().showCodeLineNumbers).toBe(false);
  });

  it("切换开关 true -> false -> true", () => {
    useSettingsStore.getState().setShowCodeLineNumbers(false);
    expect(useSettingsStore.getState().showCodeLineNumbers).toBe(false);
    useSettingsStore.getState().setShowCodeLineNumbers(true);
    expect(useSettingsStore.getState().showCodeLineNumbers).toBe(true);
  });
});

describe("G9 CodeBlockView 行号层 DOM", () => {
  beforeEach(() => {
    useSettingsStore.setState({ showCodeLineNumbers: true });
  });

  it("构造后 dom 包含 .code-line-numbers 元素", () => {
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers");
    expect(lineNumbersLayer).not.toBeNull();
    codeBlockView.destroy();
  });

  it("showLineNumbers=true 时行号层 display:block", () => {
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.style.display).toBe("block");
    codeBlockView.destroy();
  });

  it("showLineNumbers=false 时行号层 display:none", () => {
    useSettingsStore.getState().setShowCodeLineNumbers(false);
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.style.display).toBe("none");
    codeBlockView.destroy();
  });

  it("行号内容与代码行数对应（10 行代码生成 1-10）", () => {
    const code = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const node = createCodeBlockNode(code, "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.textContent).toBe("1\n2\n3\n4\n5\n6\n7\n8\n9\n10");
    codeBlockView.destroy();
  });

  it("空代码块不显示行号（textContent 为空字符串）", () => {
    const node = createCodeBlockNode("", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.textContent).toBe("");
    codeBlockView.destroy();
  });

  it("单行代码块行号为 '1'", () => {
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.textContent).toBe("1");
    codeBlockView.destroy();
  });

  it("切换开关实时响应（subscribe 触发 display 切换）", () => {
    // 初始 true
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.style.display).toBe("block");
    // 切换为 false
    useSettingsStore.getState().setShowCodeLineNumbers(false);
    expect(lineNumbersLayer.style.display).toBe("none");
    // 切换回 true
    useSettingsStore.getState().setShowCodeLineNumbers(true);
    expect(lineNumbersLayer.style.display).toBe("block");
    codeBlockView.destroy();
  });

  it("行号层 className 为 code-line-numbers（CSS 中 user-select:none 由此 class 保证）", () => {
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    const lineNumbersLayer = codeBlockView.dom.querySelector(".code-line-numbers") as HTMLElement;
    expect(lineNumbersLayer.className).toBe("code-line-numbers");
    codeBlockView.destroy();
  });

  it("destroy 后取消订阅（不抛异常）", () => {
    const node = createCodeBlockNode("const x = 1;", "javascript");
    const view = createMockView();
    const codeBlockView = new CodeBlockView(node, view, () => 0);
    expect(() => codeBlockView.destroy()).not.toThrow();
    // destroy 后切换开关不应再触发任何异常
    expect(() => useSettingsStore.getState().setShowCodeLineNumbers(false)).not.toThrow();
  });
});
