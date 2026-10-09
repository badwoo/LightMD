/**
 * v0.12.0 需求1：格式栏 ghost 占位文本测试
 *
 * 覆盖：
 * 1. 无选区行内格式/标题 → replacement 只含语法符号 + ghostText 返回占位提示
 * 2. 有选区 → 完整包裹、无 ghostText（行为不变）
 * 3. 块级模板（代码块/表格/引用等）保持预填（无 ghostText）
 * 4. shouldClearFormatGhost 清除时机表：input/escape/切文件/切模式 → true；光标移动 → false
 */
import { describe, it, expect } from "vitest";
import {
  buildFormatReplacement,
  wrapSelection,
  shouldClearFormatGhost,
  HEADING_GHOST_TEXTS,
  computeGhostTail,
} from "../components/editor/sourceFormat";

describe("v0.12.0 需求1：行内格式 ghostText", () => {
  it("无选区：replacement 只含语法符号，光标居中，ghostText 为占位提示", () => {
    const r = buildFormatReplacement("bold", "")!;
    expect(r.replacement).toBe("****");
    expect(r.cursorOffset).toBe(2);
    expect(r.ghostText).toBe("粗体文本");

    expect(buildFormatReplacement("italic", "")!.replacement).toBe("**");
    expect(buildFormatReplacement("italic", "")!.ghostText).toBe("斜体文本");
    expect(buildFormatReplacement("bolditalic", "")!.replacement).toBe("******");
    expect(buildFormatReplacement("strikethrough", "")!.replacement).toBe("~~~~");
    expect(buildFormatReplacement("underline", "")!.replacement).toBe("<u></u>");
    expect(buildFormatReplacement("code", "")!.replacement).toBe("``");
  });

  it("有选区：完整包裹、无 ghostText（既有行为不变）", () => {
    const r = buildFormatReplacement("bold", "abc")!;
    expect(r.replacement).toBe("**abc**");
    expect(r.cursorOffset).toBe(7);
    expect(r.ghostText).toBeUndefined();
  });

  it("wrapSelection 直接验证：无选区不把 placeholder 写进 replacement", () => {
    const r = wrapSelection("", "**", "**", "粗体文本");
    expect(r.replacement).toBe("****");
    expect(r.replacement).not.toContain("粗体文本");
    expect(r.ghostText).toBe("粗体文本");
  });
});

describe("v0.12.0 需求1：标题 ghostText", () => {
  it("H1~H6 无选区：只插前缀 `# `，ghostText 为对应标题名", () => {
    for (let level = 1; level <= 6; level++) {
      const r = buildFormatReplacement(`h${level}`, "")!;
      expect(r.replacement).toBe("#".repeat(level) + " ");
      expect(r.cursorOffset).toBe(level + 1);
      expect(r.ghostText).toBe(HEADING_GHOST_TEXTS[level - 1]);
    }
  });

  it("H1 有选区：完整标题、无 ghostText", () => {
    const r = buildFormatReplacement("h1", "标题")!;
    expect(r.replacement).toBe("# 标题");
    expect(r.ghostText).toBeUndefined();
  });
});

describe("v0.12.0 需求1 返修：前缀/包裹类格式 ghostText（列表/任务/引用/链接/图片）", () => {
  it("无选区：列表/任务/有序/引用只插前缀符号，占位走 ghostText（不落盘）", () => {
    expect(buildFormatReplacement("ul", "")).toEqual({
      replacement: "- ", cursorOffset: 2, ghostText: "列表项",
    });
    expect(buildFormatReplacement("task", "")).toEqual({
      replacement: "- [ ] ", cursorOffset: 6, ghostText: "任务项",
    });
    expect(buildFormatReplacement("ol", "")).toEqual({
      replacement: "1. ", cursorOffset: 3, ghostText: "列表项",
    });
    expect(buildFormatReplacement("quote", "")).toEqual({
      replacement: "> ", cursorOffset: 2, ghostText: "引用文本",
    });
  });

  it("无选区：链接/图片只插语法骨架，ghost 文本在括号中间", () => {
    const link = buildFormatReplacement("link", "")!;
    expect(link.replacement).toBe("[](url)");
    expect(link.cursorOffset).toBe(1); // 光标在 [] 中间
    expect(link.ghostText).toBe("链接文本");
    const img = buildFormatReplacement("image", "")!;
    expect(img.replacement).toBe("![](url)");
    expect(img.cursorOffset).toBe(2); // 光标在 [] 中间
    expect(img.ghostText).toBe("图片描述");
  });

  it("有选区：完整包裹/前缀 + 选中文字（既有行为不变）", () => {
    expect(buildFormatReplacement("ul", "abc")!.replacement).toBe("- abc");
    expect(buildFormatReplacement("link", "abc")!.replacement).toBe("[abc](url)");
    expect(buildFormatReplacement("quote", "abc")!.ghostText).toBeUndefined();
  });

  it("块级模板：代码块改为 ghost（内容不再落盘）；表格/公式/分割线仍预填", () => {
    // v0.12.0 返修：代码块与行内格式一致——只插围栏结构，占位提示走 ghost
    const cb = buildFormatReplacement("codeblock", "")!;
    expect(cb.replacement).toBe("\n```\n\n```\n");
    expect(cb.replacement).not.toContain("代码内容");
    expect(cb.cursorOffset).toBe(5);
    expect(cb.ghostText).toBe("代码内容");
    // 有选区时内容为用户选中文本，无 ghost
    expect(buildFormatReplacement("codeblock", "foo")!.ghostText).toBeUndefined();
    // 表格/公式/分割线为结构模板，保持预填
    const cases: Array<[string, string]> = [
      ["table", "列1"],
      ["math", "\\sum"],
      ["hr", "---"],
    ];
    for (const [action, placeholder] of cases) {
      const r = buildFormatReplacement(action, "")!;
      expect(r.replacement, action).toContain(placeholder);
      expect(r.ghostText, action).toBeUndefined();
    }
  });
});

describe("v0.12.0 需求1 返修：computeGhostTail（占位落在格式符中间）", () => {
  it("行内成对符号：光标后的尾符号取出，行尾无其它内容 → 启用遮罩", () => {
    // 空行插入 `****`，光标在 2 → 尾符号 `**`，行尾即文末
    expect(computeGhostTail("****", 2, "**")).toEqual({ tail: "**", maskTail: true });
    // 行尾还有换行（下一行有内容）同样安全
    expect(computeGhostTail("****\nnext", 2, "**")).toEqual({ tail: "**", maskTail: true });
  });

  it("行内成对符号：行尾仍有用户内容 → 不启用遮罩（避免遮住已有文字）", () => {
    expect(computeGhostTail("****abc", 2, "**")).toEqual({ tail: "**", maskTail: false });
  });

  it("斜体/行内代码：单字符尾符号", () => {
    expect(computeGhostTail("**", 1, "*")).toEqual({ tail: "*", maskTail: true });
    expect(computeGhostTail("``", 1, "`")).toEqual({ tail: "`", maskTail: true });
  });

  it("链接/图片：尾符号为 `](url)`（同一行，整体重绘）", () => {
    expect(computeGhostTail("[](url)", 1, "](url)")).toEqual({ tail: "](url)", maskTail: true });
    expect(computeGhostTail("![](url)", 2, "](url)")).toEqual({ tail: "](url)", maskTail: true });
  });

  it("跨行模板（代码块）：尾部以换行开头 → 无可见尾符号、不遮罩", () => {
    expect(computeGhostTail("\n```\n\n```\n", 5, "\n```\n")).toEqual({ tail: "", maskTail: false });
  });

  it("无尾符号（列表/引用/标题前缀）→ 均为空", () => {
    expect(computeGhostTail("- ", 2, "")).toEqual({ tail: "", maskTail: false });
    expect(computeGhostTail("# ", 2, "")).toEqual({ tail: "", maskTail: false });
  });
});

describe("v0.12.0 需求1：shouldClearFormatGhost 清除时机表", () => {
  it("input / escape / undo / 切文件 / 切模式 → 清除", () => {
    expect(shouldClearFormatGhost("input")).toBe(true);
    expect(shouldClearFormatGhost("escape")).toBe(true);
    expect(shouldClearFormatGhost("undo")).toBe(true); // 返修②：撤销/恢复后清除
    expect(shouldClearFormatGhost("file-switch")).toBe(true);
    expect(shouldClearFormatGhost("mode-switch")).toBe(true);
  });

  it("方向键 / 点击移动光标（其它 kind）→ 保留", () => {
    expect(shouldClearFormatGhost("arrow")).toBe(false);
    expect(shouldClearFormatGhost("click")).toBe(false);
    expect(shouldClearFormatGhost("")).toBe(false);
  });
});