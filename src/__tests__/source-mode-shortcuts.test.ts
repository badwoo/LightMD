/**
 * 源码模式快捷键测试
 *
 * 覆盖 sourceFormat.ts 的纯函数：
 * - parseShortcut：快捷键 → action 映射（含 Ctrl+Alt+S 避冲突、Ctrl+1~6/0 行首标题）
 * - wrapSelection：选中文本包裹（含光标偏移）
 * - getHeadingPrefix：标题前缀生成
 * - setLinePrefix：行首插入/替换标题（已有标题先移除）
 * - removeLinePrefix：移除行首标题前缀
 * - hasModifier：修饰键检测
 *
 * 任务来源：P1 源码模式快捷键
 */
import { describe, it, expect } from "vitest";
import {
  parseShortcut,
  wrapSelection,
  getHeadingPrefix,
  setLinePrefix,
  removeLinePrefix,
  getLineRange,
  hasModifier,
} from "../components/editor/sourceFormat";

/** 构造键盘事件对象（仅含 parseShortcut 关心的字段） */
function kbd(key: string, opts: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return {
    key,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
  };
}

// ─── hasModifier ──────────────────────────────────
describe("hasModifier", () => {
  it("Ctrl 按下应返回 true", () => {
    expect(hasModifier(kbd("b", { ctrl: true }))).toBe(true);
  });
  it("Cmd 按下应返回 true", () => {
    expect(hasModifier(kbd("b", { meta: true }))).toBe(true);
  });
  it("无修饰键应返回 false", () => {
    expect(hasModifier(kbd("b"))).toBe(false);
  });
});

// ─── parseShortcut ───────────────────────────────
describe("parseShortcut - 快捷键映射", () => {
  // 加粗
  it("Ctrl+B → bold", () => {
    expect(parseShortcut(kbd("b", { ctrl: true }))).toBe("bold");
  });
  it("Cmd+B → bold（Mac 兼容）", () => {
    expect(parseShortcut(kbd("b", { meta: true }))).toBe("bold");
  });
  it("Ctrl+Shift+B 不应映射为 bold（避免与可能的全局冲突）", () => {
    expect(parseShortcut(kbd("b", { ctrl: true, shift: true }))).toBeNull();
  });

  // 斜体
  it("Ctrl+I → italic", () => {
    expect(parseShortcut(kbd("i", { ctrl: true }))).toBe("italic");
  });
  it("Cmd+I → italic", () => {
    expect(parseShortcut(kbd("i", { meta: true }))).toBe("italic");
  });

  // 删除线（避冲突：使用 Ctrl+Alt+S 而非 Ctrl+Shift+S）
  it("Ctrl+Alt+S → strikethrough（避开 App.tsx 的 Ctrl+Shift+S 另存为）", () => {
    expect(parseShortcut(kbd("s", { ctrl: true, alt: true }))).toBe("strikethrough");
  });
  it("Ctrl+Shift+S 不应映射为删除线（已被 App.tsx 占用为另存为）", () => {
    expect(parseShortcut(kbd("S", { ctrl: true, shift: true }))).toBeNull();
  });
  it("Ctrl+S（无 Alt）不应映射为删除线", () => {
    expect(parseShortcut(kbd("s", { ctrl: true }))).toBeNull();
  });

  // 行内代码
  it("Ctrl+` → code", () => {
    expect(parseShortcut(kbd("`", { ctrl: true }))).toBe("code");
  });
  it("Cmd+` → code", () => {
    expect(parseShortcut(kbd("`", { meta: true }))).toBe("code");
  });

  // 块级公式
  it("Ctrl+Shift+M → math", () => {
    expect(parseShortcut(kbd("m", { ctrl: true, shift: true }))).toBe("math");
  });
  it("Ctrl+M（无 Shift）不应映射", () => {
    expect(parseShortcut(kbd("m", { ctrl: true }))).toBeNull();
  });

  // 标题 1~6
  it("Ctrl+1~6 → heading1~6", () => {
    for (let i = 1; i <= 6; i++) {
      expect(parseShortcut(kbd(String(i), { ctrl: true }))).toBe(`heading${i}`);
    }
  });
  it("Cmd+1 → heading1", () => {
    expect(parseShortcut(kbd("1", { meta: true }))).toBe("heading1");
  });
  it("Ctrl+Shift+1 不应映射（避免冲突）", () => {
    expect(parseShortcut(kbd("1", { ctrl: true, shift: true }))).toBeNull();
  });

  // 移除标题
  it("Ctrl+0 → paragraph", () => {
    expect(parseShortcut(kbd("0", { ctrl: true }))).toBe("paragraph");
  });

  // 非快捷键
  it("无修饰键应返回 null", () => {
    expect(parseShortcut(kbd("b"))).toBeNull();
  });
  it("Ctrl+S（无 Alt）应返回 null", () => {
    expect(parseShortcut(kbd("s", { ctrl: true }))).toBeNull();
  });
  it("Ctrl+O 不应被映射（App.tsx 已占用为打开文件）", () => {
    expect(parseShortcut(kbd("o", { ctrl: true }))).toBeNull();
  });
  it("Ctrl+S 不应被映射（App.tsx 已占用为保存）", () => {
    expect(parseShortcut(kbd("s", { ctrl: true }))).toBeNull();
  });
  it("Ctrl+N 不应被映射（App.tsx 已占用为新建）", () => {
    expect(parseShortcut(kbd("n", { ctrl: true }))).toBeNull();
  });
  it("Ctrl+F 不应被映射（App.tsx 已占用为搜索）", () => {
    expect(parseShortcut(kbd("f", { ctrl: true }))).toBeNull();
  });
  it("Ctrl+7/8/9 不应映射（仅 1~6 + 0 有效）", () => {
    expect(parseShortcut(kbd("7", { ctrl: true }))).toBeNull();
    expect(parseShortcut(kbd("8", { ctrl: true }))).toBeNull();
    expect(parseShortcut(kbd("9", { ctrl: true }))).toBeNull();
  });
});

// ─── wrapSelection ────────────────────────────────
describe("wrapSelection - 选中文本包裹", () => {
  it("有选中文本时完整包裹，光标到末尾", () => {
    const r = wrapSelection("hello", "**", "**", "粗体文本");
    expect(r.replacement).toBe("**hello**");
    expect(r.cursorOffset).toBe(9); // 9 = "**hello**".length
  });
  it("无选中文本时插入占位，光标停在占位之前", () => {
    const r = wrapSelection("", "**", "**", "粗体文本");
    expect(r.replacement).toBe("**粗体文本**");
    expect(r.cursorOffset).toBe(2); // 2 = "**".length，便于直接键入替换占位
  });
  it("斜体：选中包裹 *text*，光标到末尾", () => {
    const r = wrapSelection("ab", "*", "*", "斜体文本");
    expect(r.replacement).toBe("*ab*");
    expect(r.cursorOffset).toBe(4);
  });
  it("粗斜体：选中包裹 ***text***", () => {
    const r = wrapSelection("x", "***", "***", "粗斜体");
    expect(r.replacement).toBe("***x***");
    expect(r.cursorOffset).toBe(7);
  });
  it("删除线：选中包裹 ~~text~~", () => {
    const r = wrapSelection("del", "~~", "~~", "删除线");
    expect(r.replacement).toBe("~~del~~");
    expect(r.cursorOffset).toBe(7);
  });
  it("行内代码：选中包裹 `code`", () => {
    const r = wrapSelection("c", "`", "`", "代码");
    expect(r.replacement).toBe("`c`");
    expect(r.cursorOffset).toBe(3);
  });
});

// ─── getHeadingPrefix ─────────────────────────────
describe("getHeadingPrefix - 标题前缀生成", () => {
  it("level=1 → '# '", () => {
    expect(getHeadingPrefix(1)).toBe("# ");
  });
  it("level=3 → '### '", () => {
    expect(getHeadingPrefix(3)).toBe("### ");
  });
  it("level=6 → '###### '", () => {
    expect(getHeadingPrefix(6)).toBe("###### ");
  });
  it("level=0 自动 clamp 到 1", () => {
    expect(getHeadingPrefix(0)).toBe("# ");
  });
  it("level=10 自动 clamp 到 6", () => {
    expect(getHeadingPrefix(10)).toBe("###### ");
  });
  it("负数自动 clamp 到 1", () => {
    expect(getHeadingPrefix(-3)).toBe("# ");
  });
});

// ─── getLineRange ─────────────────────────────────
describe("getLineRange - 行区间查找", () => {
  it("单行文本返回 [0, len]", () => {
    expect(getLineRange("hello", 2)).toEqual({ start: 0, end: 5 });
  });
  it("多行文本首行", () => {
    expect(getLineRange("abc\ndef\nghi", 1)).toEqual({ start: 0, end: 3 });
  });
  it("多行文本中间行", () => {
    expect(getLineRange("abc\ndef\nghi", 5)).toEqual({ start: 4, end: 7 });
  });
  it("多行文本末行", () => {
    expect(getLineRange("abc\ndef\nghi", 9)).toEqual({ start: 8, end: 11 });
  });
  it("光标在行首（紧邻 \\n 之后）", () => {
    expect(getLineRange("abc\ndef", 4)).toEqual({ start: 4, end: 7 });
  });
});

// ─── setLinePrefix ────────────────────────────────
describe("setLinePrefix - 行首插入/替换标题", () => {
  it("空行插入 H1 前缀", () => {
    const r = setLinePrefix("", 0, "# ");
    expect(r.replacement).toBe("# ");
  });
  it("普通行插入 H3 前缀", () => {
    const r = setLinePrefix("hello world", 5, "### ");
    expect(r.replacement).toBe("### hello world");
  });
  it("多行文本：仅修改光标所在行", () => {
    const text = "line1\nline2\nline3";
    const r = setLinePrefix(text, 8, "## ");
    expect(r.replacement).toBe("line1\n## line2\nline3");
  });
  it("已有 H1 前缀替换为 H3", () => {
    const r = setLinePrefix("# old", 3, "### ");
    expect(r.replacement).toBe("### old");
  });
  it("已有 H6 前缀替换为 H2", () => {
    const r = setLinePrefix("###### title", 8, "## ");
    expect(r.replacement).toBe("## title");
  });
  it("已有 H3 前缀替换为 H3（幂等）", () => {
    const r = setLinePrefix("### same", 4, "### ");
    expect(r.replacement).toBe("### same");
  });
  it("仅替换标题前缀，保留行内 # 不被误处理", () => {
    const r = setLinePrefix("# text # with hash", 5, "### ");
    expect(r.replacement).toBe("### text # with hash");
  });
});

// ─── removeLinePrefix ─────────────────────────────
describe("removeLinePrefix - 移除行首标题", () => {
  it("H1 行移除前缀", () => {
    const r = removeLinePrefix("# title", 3);
    expect(r.replacement).toBe("title");
  });
  it("H6 行移除前缀", () => {
    const r = removeLinePrefix("###### deep", 8);
    expect(r.replacement).toBe("deep");
  });
  it("非标题行无变化（返回原文本，cursorOffset=0）", () => {
    const r = removeLinePrefix("plain text", 3);
    expect(r.replacement).toBe("plain text");
    expect(r.cursorOffset).toBe(0);
  });
  it("多行文本仅移除光标所在行的标题", () => {
    const text = "# keep\n# remove\n# keep";
    const r = removeLinePrefix(text, 9);
    expect(r.replacement).toBe("# keep\nremove\n# keep");
  });
  it("保留行内 # 不被误处理", () => {
    const r = removeLinePrefix("# text # with hash", 5);
    expect(r.replacement).toBe("text # with hash");
  });
  it("标题后无空格（如 #title）也能移除", () => {
    const r = removeLinePrefix("#title", 3);
    expect(r.replacement).toBe("title");
  });
});
