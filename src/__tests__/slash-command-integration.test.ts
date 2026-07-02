/**
 * SlashCommand 接入 EditorContainer 的集成测试
 *
 * 目的：验证 EditorContainer.tsx 中接入 SlashCommand 的关键逻辑
 *
 * 覆盖两部分接入逻辑：
 * 1. 触发条件检测 —— 复刻 handleSourceChange 中的判定：
 *    行首输入 / 且不在代码块内（findSlashTrigger + isInCodeBlock 组合）
 * 2. 插入逻辑 —— 验证 computeSlashInsert 纯函数：
 *    - mode="block"：删除当前行从行首（含 / 和过滤文字）到光标的内容，在行首插入 markdown
 *    - mode="inline"：用 markdown 替换选中文本
 *
 * 注：SlashCommand 组件本身的渲染/交互测试见 slash-command.test.tsx
 */
import { describe, it, expect } from "vitest";
import { findSlashTrigger, isInCodeBlock } from "../components/editor/SlashCommand";
import { computeSlashInsert } from "../components/editor/EditorContainer";

// ─── 复刻 handleSourceChange 中的触发判定 ────────────
// 源码位置：EditorContainer.tsx handleSourceChange 中
//   const trigger = findSlashTrigger(newContent, cursorPos);
//   if (trigger.trigger && !isInCodeBlock(newContent, cursorPos)) {
//     setSlashCommandOpen(true);
//   }
function shouldTriggerSlash(text: string, cursorPos: number): boolean {
  const result = findSlashTrigger(text, cursorPos);
  return result.trigger && !isInCodeBlock(text, cursorPos);
}

// ─── 触发条件检测（接入逻辑：handleSourceChange） ──────────
describe("SlashCommand 触发条件检测（handleSourceChange 接入逻辑）", () => {
  it("行首输入 / 触发", () => {
    expect(shouldTriggerSlash("/", 1)).toBe(true);
  });

  it("行首输入 /h2 触发", () => {
    expect(shouldTriggerSlash("/h2", 3)).toBe(true);
  });

  it("行中文字后输入 / 不触发（行首非空白）", () => {
    expect(shouldTriggerSlash("abc/hello", "abc/hello".length)).toBe(false);
  });

  it("代码块内行首输入 / 不触发", () => {
    const text = "```\n/some code";
    expect(shouldTriggerSlash(text, text.length)).toBe(false);
  });

  it("代码块闭合后行首输入 / 触发", () => {
    const text = "```\ncode\n```\n/h2";
    expect(shouldTriggerSlash(text, text.length)).toBe(true);
  });

  it("第二行行首输入 / 触发", () => {
    const text = "abc\n/h2";
    expect(shouldTriggerSlash(text, text.length)).toBe(true);
  });

  it("前导空格 + / 触发（缩进场景）", () => {
    const text = "  /h2";
    expect(shouldTriggerSlash(text, text.length)).toBe(true);
  });

  it("空字符串不触发", () => {
    expect(shouldTriggerSlash("", 0)).toBe(false);
  });

  it("两个代码块之间行首 / 触发（不在代码块内）", () => {
    const text = "```\nblock1\n```\n/h2\n```\nblock2";
    // 光标在 /h2 之后（第 18 个字符位置）
    const slashPos = text.indexOf("/h2") + "/h2".length;
    expect(shouldTriggerSlash(text, slashPos)).toBe(true);
  });

  it("未闭合的第二个代码块内行首 / 不触发", () => {
    const text = "```\nblock1\n```\nbetween\n```\n/h2";
    expect(shouldTriggerSlash(text, text.length)).toBe(false);
  });
});

// ─── 插入逻辑（接入逻辑：handleSlashInsert）─────────────
// 验证 computeSlashInsert 纯函数，与 handleSlashInsert 内部调用一致
describe("computeSlashInsert 插入逻辑（handleSlashInsert 接入逻辑）", () => {
  // ─── block 模式 ───
  describe("block 模式", () => {
    it("删除行首 / 和过滤文字，在行首插入 markdown（行首 /h2 → ## ）", () => {
      // 模拟任务验收场景：行首输入 /h2，Enter 插入 ## （标题 H2）
      const text = "/h2";
      const result = computeSlashInsert(text, 3, 3, "## ", "block");
      expect(result.newContent).toBe("## ");
      expect(result.newCursorPos).toBe(3);
    });

    it("保留 / 前行的内容", () => {
      const text = "abc\n/h2";
      const result = computeSlashInsert(text, 7, 7, "## ", "block");
      expect(result.newContent).toBe("abc\n## ");
      expect(result.newCursorPos).toBe(7);
    });

    it("保留光标后的内容（同行后续文本不被删除）", () => {
      // 注意：block 模式只删除 [lineStart, cursorPos)，光标后的文本保留
      const text = "/h2\nnext";
      const result = computeSlashInsert(text, 3, 3, "## ", "block");
      expect(result.newContent).toBe("## \nnext");
      expect(result.newCursorPos).toBe(3);
    });

    it("前导空格的 / 触发后，删除从行首到光标的内容（含前导空格）", () => {
      // 任务约定：mode="block" 删除「从行首」到光标的内容，前导空格也属于行首部分
      const text = "  /h2";
      const result = computeSlashInsert(text, 5, 5, "## ", "block");
      // 删除 [0, 5)（"  /h2"），在行首插入 "## "
      expect(result.newContent).toBe("## ");
      expect(result.newCursorPos).toBe(3);
    });

    it("block 模式光标在中间行触发，不影响其他行", () => {
      const text = "line1\n/h2\nline3";
      // 光标在第二行的 /h2 之后（位置 9）
      const result = computeSlashInsert(text, 9, 9, "## ", "block");
      expect(result.newContent).toBe("line1\n## \nline3");
      expect(result.newCursorPos).toBe(9);
    });

    it("插入多行 markdown（如代码块）", () => {
      const text = "/code";
      const markdown = "\n```\n\n```\n";
      const result = computeSlashInsert(text, 5, 5, markdown, "block");
      expect(result.newContent).toBe(markdown);
      expect(result.newCursorPos).toBe(markdown.length);
    });

    it("插入表格 markdown", () => {
      const text = "/table";
      const markdown = "\n| 列1 | 列2 |\n|------|------|\n| 内容 | 内容 |\n";
      const result = computeSlashInsert(text, 6, 6, markdown, "block");
      expect(result.newContent).toBe(markdown);
      expect(result.newCursorPos).toBe(markdown.length);
    });

    it("行首仅 / 无过滤文字，插入标题前缀", () => {
      const text = "/";
      const result = computeSlashInsert(text, 1, 1, "# ", "block");
      expect(result.newContent).toBe("# ");
      expect(result.newCursorPos).toBe(2);
    });

    it("第三行行首 / 触发，前两行内容完整保留", () => {
      const text = "first\nsecond\n/h3";
      // cursorPos = text.length（光标在 /h3 之后），删除 [13, 16) 即 "/h3"
      const result = computeSlashInsert(text, text.length, text.length, "### ", "block");
      expect(result.newContent).toBe("first\nsecond\n### ");
      // "first\nsecond\n" (13) + "### " (4) = 17
      expect(result.newCursorPos).toBe(17);
    });
  });

  // ─── inline 模式 ───
  describe("inline 模式", () => {
    it("用 markdown 替换选中文本（行首选中）", () => {
      const text = "hello world";
      // 选中 "hello"（位置 0-5）
      const result = computeSlashInsert(text, 0, 5, "**hello**", "inline");
      expect(result.newContent).toBe("**hello** world");
      expect(result.newCursorPos).toBe(9);
    });

    it("用 markdown 替换选中文本（行中选中）", () => {
      const text = "hello world";
      // 选中 "world"（位置 6-11）
      const result = computeSlashInsert(text, 6, 11, "**world**", "inline");
      expect(result.newContent).toBe("hello **world**");
      expect(result.newCursorPos).toBe(15);
    });

    it("选中整行文本替换", () => {
      const text = "text";
      const result = computeSlashInsert(text, 0, 4, "**text**", "inline");
      expect(result.newContent).toBe("**text**");
      expect(result.newCursorPos).toBe(8);
    });

    it("行内代码包裹选中", () => {
      const text = "var x = 1";
      // 选中 "x"（位置 4-5）
      const result = computeSlashInsert(text, 4, 5, "`x`", "inline");
      expect(result.newContent).toBe("var `x` = 1");
      expect(result.newCursorPos).toBe(7);
    });

    it("高亮包裹选中（== 语法）", () => {
      const text = "mark this";
      // 选中 "mark"（位置 0-4）
      const result = computeSlashInsert(text, 0, 4, "==mark==", "inline");
      expect(result.newContent).toBe("==mark== this");
      expect(result.newCursorPos).toBe(8);
    });

    it("多行文本中间选中替换", () => {
      const text = "line1\nline2\nline3";
      // 选中第二行的 "line2"（位置 6-11）
      const result = computeSlashInsert(text, 6, 11, "**line2**", "inline");
      expect(result.newContent).toBe("line1\n**line2**\nline3");
      expect(result.newCursorPos).toBe(15);
    });
  });

  // ─── 端到端：触发 → 插入的完整流程验证 ───
  describe("触发 → 插入完整流程（任务验收场景）", () => {
    it("实测场景：行首输入 /，输入 h2 过滤，Enter 插入 ## ", () => {
      // Step 1: 用户在空 textarea 行首输入 /
      let text = "/";
      let cursorPos = 1;
      expect(shouldTriggerSlash(text, cursorPos)).toBe(true);

      // Step 2: 继续输入 h2（textarea 内容变为 /h2）
      text = "/h2";
      cursorPos = 3;
      expect(shouldTriggerSlash(text, cursorPos)).toBe(true);

      // Step 3: 按 Enter，SlashCommand 通过 buildInsertText 构造 "## "，
      //         handleSlashInsert 调用 computeSlashInsert 计算 newContent
      const result = computeSlashInsert(text, cursorPos, cursorPos, "## ", "block");
      expect(result.newContent).toBe("## ");
      expect(result.newCursorPos).toBe(3);
    });

    it("实测场景：选中文字后用 / 触发行内加粗（不会触发，行中不触发 / 菜单）", () => {
      // 行内格式通过工具栏/快捷键触发，/ 菜单只在行首触发
      // 此测试验证：行中输入 / 不触发，避免误以为 inline 也走 / 菜单
      const text = "hello /bold";
      expect(shouldTriggerSlash(text, text.length)).toBe(false);
    });

    it("代码块内 / 不触发：避免在代码中误触发菜单", () => {
      // 用户在代码块内输入 /path，不应触发菜单
      const text = "```\nconst p = /path/to\n```";
      // 光标在 /path 后
      const cursor = text.indexOf("/path") + "/path".length;
      expect(shouldTriggerSlash(text, cursor)).toBe(false);
    });
  });
});
