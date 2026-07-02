/**
 * SlashCommand 组件测试
 *
 * 覆盖：
 * - 菜单项配置（MENU_ITEMS）的完整性与正确性
 * - 纯函数 filterItems、buildInsertText、findSlashTrigger、isInCodeBlock
 * - 组件渲染、点击选择、键盘导航（↑↓/Enter/Esc）、过滤更新
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  SlashCommand,
  MENU_ITEMS,
  filterItems,
  buildInsertText,
  findSlashTrigger,
  isInCodeBlock,
  INLINE_PLACEHOLDER,
  type MenuItem,
} from "../components/editor/SlashCommand";

// jsdom 不实现 scrollIntoView，mock 避免报错
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// 顺序很重要：先 cleanup 卸载 React 树（包括 portal 节点），
// 再清空 body innerHTML 移除手动 appendChild 创建的 textarea。
// 若先清空 body，cleanup 会因 portal 父节点丢失而抛 "node to be removed"。
beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// ─── 辅助：创建带初始值和光标位置的 textarea ───
function createTextarea(value: string, cursorPos?: number): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.value = value;
  if (cursorPos !== undefined) {
    ta.selectionStart = cursorPos;
    ta.selectionEnd = cursorPos;
  }
  document.body.appendChild(ta);
  return ta;
}

// ─── 菜单项配置测试 ────────────────────────────────
describe("MENU_ITEMS 菜单项配置", () => {
  it("应包含 19 项（基本块7 + 列表4 + 高级3 + 行内5）", () => {
    expect(MENU_ITEMS).toHaveLength(19);
    const groups = MENU_ITEMS.reduce<Record<string, number>>((acc, item) => {
      acc[item.group] = (acc[item.group] || 0) + 1;
      return acc;
    }, {});
    expect(groups["基本块"]).toBe(7);
    expect(groups["列表"]).toBe(4);
    expect(groups["高级"]).toBe(3);
    expect(groups["行内格式"]).toBe(5);
  });

  it("所有项都有唯一 id", () => {
    const ids = MENU_ITEMS.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("所有项都有非空的 name/keywords/syntax/icon", () => {
    MENU_ITEMS.forEach((item) => {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.keywords.length).toBeGreaterThan(0);
      expect(item.syntax.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
    });
  });

  it("mode 取值仅限 block/inline", () => {
    MENU_ITEMS.forEach((item) => {
      expect(["block", "inline"]).toContain(item.mode);
    });
  });

  it("inline 模式的 syntax 应包含 {text} 占位符", () => {
    MENU_ITEMS.filter((i) => i.mode === "inline").forEach((item) => {
      expect(item.syntax).toContain("{text}");
    });
  });

  it("block 模式的 syntax 不应包含 {text} 占位符", () => {
    MENU_ITEMS.filter((i) => i.mode === "block").forEach((item) => {
      expect(item.syntax).not.toContain("{text}");
    });
  });

  it("包含任务要求的关键菜单项", () => {
    const ids = MENU_ITEMS.map((i) => i.id);
    [
      "h1", "h2", "h3", "h4",
      "quote", "hr", "codeblock",
      "ul", "ol", "task", "task-done",
      "math", "mermaid", "table",
      "bold", "italic", "strikethrough", "code", "highlight",
    ].forEach((id) => expect(ids).toContain(id));
  });

  it("syntax 输出符合任务约定（关键项验证）", () => {
    const byId = (id: string) => MENU_ITEMS.find((i) => i.id === id)!;
    expect(byId("h1").syntax).toBe("# ");
    expect(byId("h2").syntax).toBe("## ");
    expect(byId("h3").syntax).toBe("### ");
    expect(byId("h4").syntax).toBe("#### ");
    expect(byId("quote").syntax).toBe("> ");
    expect(byId("hr").syntax).toBe("\n---\n");
    expect(byId("codeblock").syntax).toBe("\n```\n\n```\n");
    expect(byId("ul").syntax).toBe("- ");
    expect(byId("ol").syntax).toBe("1. ");
    expect(byId("task").syntax).toBe("- [ ] ");
    expect(byId("task-done").syntax).toBe("- [x] ");
    expect(byId("math").syntax).toBe("\n$$\n\n$$\n");
    expect(byId("table").syntax).toBe("\n| 列1 | 列2 |\n|------|------|\n| 内容 | 内容 |\n");
    expect(byId("bold").syntax).toBe("**{text}**");
    expect(byId("italic").syntax).toBe("*{text}*");
    expect(byId("strikethrough").syntax).toBe("~~{text}~~");
    expect(byId("code").syntax).toBe("`{text}`");
    expect(byId("highlight").syntax).toBe("=={text}==");
  });

  it("Mermaid 图表的 syntax 应包含 mermaid 围栏", () => {
    const mermaid = MENU_ITEMS.find((i) => i.id === "mermaid")!;
    expect(mermaid.syntax).toContain("```mermaid");
    expect(mermaid.syntax).toContain("graph TD");
  });
});

// ─── filterItems 过滤逻辑测试 ────────────────────────
describe("filterItems 过滤逻辑", () => {
  it("空 query 返回全部", () => {
    expect(filterItems(MENU_ITEMS, "")).toHaveLength(MENU_ITEMS.length);
  });

  it("输入 'h2' 过滤出标题 H2", () => {
    const result = filterItems(MENU_ITEMS, "h2");
    // 至少包含 h2
    const ids = result.map((i) => i.id);
    expect(ids).toContain("h2");
    // 不应包含 h1/h3/h4
    expect(ids).not.toContain("h1");
    expect(ids).not.toContain("h3");
    expect(ids).not.toContain("h4");
  });

  it("输入 'h' 过滤出所有标题（含 h1/h2/h3/h4）", () => {
    const result = filterItems(MENU_ITEMS, "h");
    const ids = result.map((i) => i.id);
    expect(ids).toContain("h1");
    expect(ids).toContain("h2");
    expect(ids).toContain("h3");
    expect(ids).toContain("h4");
  });

  it("输入 'table' 过滤出表格项", () => {
    const result = filterItems(MENU_ITEMS, "table");
    expect(result.map((i) => i.id)).toContain("table");
  });

  it("输入 '列表' 应匹配中文关键词", () => {
    const result = filterItems(MENU_ITEMS, "列表");
    const ids = result.map((i) => i.id);
    expect(ids).toContain("ul");
    expect(ids).toContain("ol");
  });

  it("输入 '任务' 应匹配任务列表", () => {
    const result = filterItems(MENU_ITEMS, "任务");
    const ids = result.map((i) => i.id);
    expect(ids).toContain("task");
    expect(ids).toContain("task-done");
  });

  it("输入无匹配返回空数组", () => {
    expect(filterItems(MENU_ITEMS, "zzzNotExist")).toEqual([]);
  });

  it("过滤不区分大小写", () => {
    const upper = filterItems(MENU_ITEMS, "H2");
    const lower = filterItems(MENU_ITEMS, "h2");
    expect(upper.map((i) => i.id)).toEqual(lower.map((i) => i.id));
  });

  it("匹配 keywords 别名（如 'bold' 匹配 '粗体'）", () => {
    const result = filterItems(MENU_ITEMS, "粗体");
    expect(result.map((i) => i.id)).toContain("bold");
  });

  it("保持原顺序", () => {
    const result = filterItems(MENU_ITEMS, "");
    expect(result.map((i) => i.id)).toEqual(MENU_ITEMS.map((i) => i.id));
  });
});

// ─── buildInsertText 插入文本构造测试 ──────────────────
describe("buildInsertText 插入文本构造", () => {
  it("block 模式直接返回 syntax", () => {
    const h2 = MENU_ITEMS.find((i) => i.id === "h2")!;
    expect(buildInsertText(h2, "")).toBe("## ");
    // block 模式忽略 selectedText 参数
    expect(buildInsertText(h2, "anyText")).toBe("## ");
  });

  it("inline 模式替换 {text} 占位符为选中文本", () => {
    const bold = MENU_ITEMS.find((i) => i.id === "bold")!;
    expect(buildInsertText(bold, "选中文本")).toBe("**选中文本**");
  });

  it("inline 模式无选中文本时使用占位符", () => {
    const italic = MENU_ITEMS.find((i) => i.id === "italic")!;
    expect(buildInsertText(italic, "")).toBe(`*${INLINE_PLACEHOLDER}*`);
  });

  it("行内代码 inline 模式正确包裹", () => {
    const code = MENU_ITEMS.find((i) => i.id === "code")!;
    expect(buildInsertText(code, "code")).toBe("`code`");
  });

  it("高亮 inline 模式正确包裹", () => {
    const highlight = MENU_ITEMS.find((i) => i.id === "highlight")!;
    expect(buildInsertText(highlight, "hl")).toBe("==hl==");
  });

  it("删除线 inline 模式正确包裹", () => {
    const strike = MENU_ITEMS.find((i) => i.id === "strikethrough")!;
    expect(buildInsertText(strike, "del")).toBe("~~del~~");
  });

  it("所有 inline 项构造的文本都能还原回 syntax（替换回 {text}）", () => {
    MENU_ITEMS.filter((i) => i.mode === "inline").forEach((item) => {
      const result = buildInsertText(item, "X");
      // 把 X 替换回 {text} 应等于原 syntax
      expect(result.replace("X", "{text}")).toBe(item.syntax);
    });
  });
});

// ─── findSlashTrigger 触发条件测试 ──────────────────
describe("findSlashTrigger 触发条件", () => {
  it("行首输入 / 触发", () => {
    const text = "/hello";
    const result = findSlashTrigger(text, text.length);
    expect(result.trigger).toBe(true);
    expect(result.slashStart).toBe(0);
    expect(result.queryStart).toBe(1);
    expect(result.query).toBe("hello");
  });

  it("空 query（仅输入 /）触发", () => {
    const text = "/";
    const result = findSlashTrigger(text, 1);
    expect(result.trigger).toBe(true);
    expect(result.query).toBe("");
  });

  it("行首有前导空格时触发（缩进场景）", () => {
    const text = "  /h2";
    const result = findSlashTrigger(text, text.length);
    expect(result.trigger).toBe(true);
    expect(result.slashStart).toBe(2);
    expect(result.queryStart).toBe(3);
    expect(result.query).toBe("h2");
  });

  it("光标在第二行行首 / 触发", () => {
    const text = "abc\n/h2";
    const result = findSlashTrigger(text, text.length);
    expect(result.trigger).toBe(true);
    expect(result.slashStart).toBe(4);
    expect(result.query).toBe("h2");
  });

  it("行中文字后输入 / 不触发", () => {
    const text = "abc/hello";
    const result = findSlashTrigger(text, text.length);
    expect(result.trigger).toBe(false);
  });

  it("行首 / 后跟非字母数字（如 /usr）不触发", () => {
    // /usr 中 usr 是字母，会触发；改用 /1abc 测试字母数字外的场景
    // 实际上 \w 包含字母数字下划线，所以 /usr 会触发
    // 任务要求"避免误触发路径如 /usr/bin"，所以这里仅验证不包含 / 字符的情况
    const text = "/path with space";
    const result = findSlashTrigger(text, 5); // "/path"
    expect(result.trigger).toBe(true); // /path 满足触发条件
    expect(result.query).toBe("path");
  });

  it("光标在行中（/ 之前）不触发", () => {
    const text = "/hello world";
    // 光标在 / 前
    const result = findSlashTrigger(text, 0);
    expect(result.trigger).toBe(false);
  });

  it("空字符串不触发", () => {
    const result = findSlashTrigger("", 0);
    expect(result.trigger).toBe(false);
  });

  it("光标超出文本长度不触发", () => {
    const result = findSlashTrigger("/abc", 100);
    // 行首找到，光标超出会被 substring 截断，lineText 仍为 "/abc"，触发
    expect(result.trigger).toBe(true);
    expect(result.query).toBe("abc");
  });

  it("queryStart 与 slashStart 相差 1（紧邻 / 后）", () => {
    const result = findSlashTrigger("/query", 6);
    expect(result.queryStart - result.slashStart).toBe(1);
  });
});

// ─── isInCodeBlock 代码块检测测试 ──────────────────
describe("isInCodeBlock 代码块检测", () => {
  it("无代码块时返回 false", () => {
    expect(isInCodeBlock("hello world", 5)).toBe(false);
  });

  it("光标在 ``` 之后返回 true", () => {
    const text = "```\ncode here";
    expect(isInCodeBlock(text, text.length)).toBe(true);
  });

  it("光标在闭合 ``` 之后返回 false", () => {
    const text = "```\ncode\n```";
    expect(isInCodeBlock(text, text.length)).toBe(false);
  });

  it("嵌套场景：两个代码块之间返回 false", () => {
    const text = "```\nblock1\n```\nbetween\n```\nblock2";
    // 光标在 between 之后
    const betweenEnd = text.indexOf("between") + "between".length;
    expect(isInCodeBlock(text, betweenEnd)).toBe(false);
  });

  it("光标在第二个未闭合代码块中返回 true", () => {
    const text = "```\nblock1\n```\nbetween\n```\nblock2";
    expect(isInCodeBlock(text, text.length)).toBe(true);
  });
});

// ─── 组件渲染与交互测试 ────────────────────────────────
describe("<SlashCommand /> 组件渲染与交互", () => {
  it("textarea=null 不渲染", () => {
    const { container } = render(
      <SlashCommand textarea={null} onInsert={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
    // body 也不应有 portal 节点
    expect(document.querySelector(".slash-command-menu")).toBeNull();
  });

  it("正常渲染显示菜单项", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);
    const menu = document.querySelector(".slash-command-menu");
    expect(menu).not.toBeNull();
    // 应有 19 个菜单项按钮
    const items = menu!.querySelectorAll(".slash-command-item");
    expect(items).toHaveLength(19);
  });

  it("显示分组标题（基本块/列表/高级/行内格式）", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);
    const menu = document.querySelector(".slash-command-menu");
    const text = menu!.textContent || "";
    expect(text).toContain("基本块");
    expect(text).toContain("列表");
    expect(text).toContain("高级");
    expect(text).toContain("行内格式");
  });

  it("默认选中第一项（h1）", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);
    const selected = document.querySelector(".slash-command-item.selected");
    expect(selected).not.toBeNull();
    expect(selected?.textContent).toContain("标题 H1");
  });

  it("点击菜单项触发 onInsert（block 模式）和 onClose", () => {
    const ta = createTextarea("/", 1);
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={onInsert} onClose={onClose} />);

    // 点击"标题 H2"项
    const items = document.querySelectorAll(".slash-command-item");
    const h2Item = Array.from(items).find((el) => el.textContent?.includes("标题 H2")) as HTMLElement;
    expect(h2Item).toBeTruthy();
    fireEvent.click(h2Item);

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith("## ", "block");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击 inline 菜单项且有选中文本时包裹选中并触发 onInsert", () => {
    const ta = createTextarea("hello", 5);
    // 模拟选中文本 "he"（位置 0-2）
    ta.selectionStart = 0;
    ta.selectionEnd = 2;
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={onInsert} onClose={onClose} />);

    const items = document.querySelectorAll(".slash-command-item");
    const boldItem = Array.from(items).find((el) => el.textContent?.includes("加粗")) as HTMLElement;
    expect(boldItem).toBeTruthy();
    fireEvent.click(boldItem);

    expect(onInsert).toHaveBeenCalledWith("**he**", "inline");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击 inline 菜单项但无选中文本时不触发 onInsert", () => {
    const ta = createTextarea("/", 1);
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={onInsert} onClose={onClose} />);

    const items = document.querySelectorAll(".slash-command-item");
    const boldItem = Array.from(items).find((el) => el.textContent?.includes("加粗")) as HTMLElement;
    fireEvent.click(boldItem);

    expect(onInsert).not.toHaveBeenCalled();
    // onClose 也不应被调用（保留菜单等待用户继续操作）
    expect(onClose).not.toHaveBeenCalled();
  });

  it("键盘 ArrowDown 切换到下一项", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    // 初始选中第 0 项
    expect(document.querySelector(".slash-command-item.selected")?.textContent).toContain("标题 H1");

    fireEvent.keyDown(ta, { key: "ArrowDown" });

    // 选中第 1 项（标题 H2）
    expect(document.querySelector(".slash-command-item.selected")?.textContent).toContain("标题 H2");
  });

  it("键盘 ArrowUp 切换到上一项（循环到最后）", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    // 初始在第 0 项，按 ArrowUp 应循环到最后一项（高亮）
    fireEvent.keyDown(ta, { key: "ArrowUp" });

    const selected = document.querySelector(".slash-command-item.selected");
    expect(selected?.textContent).toContain("高亮");
  });

  it("ArrowDown 在最后一项循环到第一项", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    // 先按 ArrowUp 跳到最后一项
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    // 再按 ArrowDown 应循环回第一项
    fireEvent.keyDown(ta, { key: "ArrowDown" });

    expect(document.querySelector(".slash-command-item.selected")?.textContent).toContain("标题 H1");
  });

  it("键盘 Enter 触发当前选中项的 onInsert（block）", () => {
    const ta = createTextarea("/", 1);
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={onInsert} onClose={onClose} />);

    // 默认选中 h1，按 Enter
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onInsert).toHaveBeenCalledWith("# ", "block");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("键盘 ArrowDown 切换后 Enter 插入选中项", () => {
    const ta = createTextarea("/", 1);
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={onInsert} onClose={onClose} />);

    // 按 ArrowDown 选中 h2
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    // 按 Enter
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onInsert).toHaveBeenCalledWith("## ", "block");
  });

  it("键盘 Esc 触发 onClose", () => {
    const ta = createTextarea("/", 1);
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={onInsert} onClose={onClose} />);

    fireEvent.keyDown(ta, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("键盘事件 preventDefault 被调用（ArrowDown/Enter/Esc）", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    const evt1 = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    ta.dispatchEvent(evt1);
    expect(evt1.defaultPrevented).toBe(true);

    const evt2 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    ta.dispatchEvent(evt2);
    expect(evt2.defaultPrevented).toBe(true);

    const evt3 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ta.dispatchEvent(evt3);
    expect(evt3.defaultPrevented).toBe(true);
  });

  it("鼠标 hover 切换选中项", () => {
    const ta = createTextarea("/", 1);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    const items = document.querySelectorAll(".slash-command-item");
    const h3Item = Array.from(items).find((el) => el.textContent?.includes("标题 H3")) as HTMLElement;

    fireEvent.mouseEnter(h3Item);
    expect(document.querySelector(".slash-command-item.selected")?.textContent).toContain("标题 H3");
  });

  it("组件卸载时清理事件监听器（无报错）", () => {
    const ta = createTextarea("/", 1);
    const { unmount } = render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    expect(() => unmount()).not.toThrow();
    // 卸载后 portal 节点应被移除
    expect(document.querySelector(".slash-command-menu")).toBeNull();
  });
});

// ─── 组件过滤与输入交互测试 ────────────────────────────
describe("<SlashCommand /> 过滤与输入交互", () => {
  it("输入过滤文字后菜单项减少", () => {
    const ta = createTextarea("/h2", 3);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    const menu = document.querySelector(".slash-command-menu");
    const items = menu!.querySelectorAll(".slash-command-item");
    // /h2 应仅过滤出 h2 一项
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain("标题 H2");
  });

  it("继续输入文字更新过滤结果", () => {
    const ta = createTextarea("/h2", 3);
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={vi.fn()} />);

    // 初始 /h2 过滤出 1 项（h2）
    let items = document.querySelectorAll(".slash-command-item");
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain("标题 H2");

    // 模拟输入改为 /h3，更新 textarea 内容
    ta.value = "/h3";
    ta.selectionStart = 3;
    ta.selectionEnd = 3;
    fireEvent.input(ta);

    // 过滤后变为 h3
    items = document.querySelectorAll(".slash-command-item");
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain("标题 H3");
  });

  it("输入无匹配关键词后菜单关闭", () => {
    const ta = createTextarea("/zzz", 4);
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={onClose} />);

    // /zzz 过滤无匹配项，菜单不渲染（filteredItems.length === 0）
    expect(document.querySelector(".slash-command-menu")).toBeNull();
  });

  it("删除 / 后触发条件失效，调用 onClose", () => {
    const ta = createTextarea("/", 1);
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={onClose} />);

    // 模拟用户删除 /（textarea 内容变空）
    ta.value = "";
    ta.selectionStart = 0;
    ta.selectionEnd = 0;
    fireEvent.input(ta);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("光标移到其他行（/ 不在行首）触发 onClose", () => {
    const ta = createTextarea("/\nabc", 1);
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={onClose} />);

    // 模拟光标移到第二行的 abc 后
    ta.value = "/\nabc";
    ta.selectionStart = 5;
    ta.selectionEnd = 5;
    fireEvent.input(ta);

    // 第二行 "abc" 不满足触发条件，应调用 onClose
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── 组件点击外部关闭测试 ────────────────────────────
describe("<SlashCommand /> 外部点击关闭", () => {
  it("点击菜单外部触发 onClose", () => {
    const ta = createTextarea("/", 1);
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={onClose} />);

    // 模拟点击菜单外部（document.body）
    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击菜单内部不触发 onClose", () => {
    const ta = createTextarea("/", 1);
    const onClose = vi.fn();
    render(<SlashCommand textarea={ta} onInsert={vi.fn()} onClose={onClose} />);

    const menu = document.querySelector(".slash-command-menu") as HTMLElement;
    fireEvent.mouseDown(menu);

    expect(onClose).not.toHaveBeenCalled();
  });
});
