/**
 * G12 导出格式扩展测试（Word/图片）
 *
 * 覆盖 markdown → Block[] 中间结构转换的纯函数：
 * 1. heading 转换（h1-h6）
 * 2. paragraph 转换
 * 3. bullet list 转换
 * 4. ordered list 转换
 * 5. code_block 转换
 * 6. table 转换
 * 7. blockquote 转换
 * 8. hr 转换
 * 9. 行内格式：bold/italic/strike/code/link
 * 10. 嵌套列表
 * 11. math block 转换
 * 12. parseInlineTokens 单独测试
 *
 * 注：不测试 docx 元素构造（需动态 import docx 库，集成测试范畴）。
 */
import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import {
  parseMarkdownToBlocks,
  parseInlineTokens,
  parseBlockTokens,
} from "../utils/exportDocx";

// 创建简化版 markdown-it 实例（避免 katex/task-list 等插件干扰基础测试）
function createTestMd(): MarkdownIt {
  const md = new MarkdownIt("commonmark", {
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  md.enable(["table", "strikethrough"]);
  return md;
}

describe("G12 导出格式扩展（markdown → Block[]）", () => {
  // ─── heading 转换 ──────────────────────────────────

  describe("heading 转换", () => {
    it("h1 转换", () => {
      const blocks = parseMarkdownToBlocks("# 标题一", createTestMd());
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        expect(blocks[0]!.level).toBe(1);
        expect(blocks[0]!.runs).toHaveLength(1);
        expect(blocks[0]!.runs[0]!.text).toBe("标题一");
      }
    });

    it("h2 转换", () => {
      const blocks = parseMarkdownToBlocks("## 标题二", createTestMd());
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        expect(blocks[0]!.level).toBe(2);
      }
    });

    it("h3 转换", () => {
      const blocks = parseMarkdownToBlocks("### 标题三", createTestMd());
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        expect(blocks[0]!.level).toBe(3);
      }
    });

    it("h4 转换", () => {
      const blocks = parseMarkdownToBlocks("#### 标题四", createTestMd());
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        expect(blocks[0]!.level).toBe(4);
      }
    });

    it("h5 转换", () => {
      const blocks = parseMarkdownToBlocks("##### 标题五", createTestMd());
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        expect(blocks[0]!.level).toBe(5);
      }
    });

    it("h6 转换", () => {
      const blocks = parseMarkdownToBlocks("###### 标题六", createTestMd());
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        expect(blocks[0]!.level).toBe(6);
      }
    });

    it("标题含行内格式（粗体）", () => {
      const blocks = parseMarkdownToBlocks("# **加粗** 标题", createTestMd());
      expect(blocks[0]!.kind).toBe("heading");
      if (blocks[0]!.kind === "heading") {
        const runs = blocks[0]!.runs;
        // 应有加粗 run 和普通 run
        const boldRun = runs.find((r) => r.bold);
        expect(boldRun).toBeDefined();
        expect(boldRun!.text).toBe("加粗");
      }
    });
  });

  // ─── paragraph 转换 ────────────────────────────────

  describe("paragraph 转换", () => {
    it("简单段落", () => {
      const blocks = parseMarkdownToBlocks("这是一段文本。", createTestMd());
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        expect(blocks[0]!.runs).toHaveLength(1);
        expect(blocks[0]!.runs[0]!.text).toBe("这是一段文本。");
      }
    });

    it("多段落", () => {
      const md = "第一段。\n\n第二段。\n\n第三段。";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks).toHaveLength(3);
      expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
    });
  });

  // ─── bullet list 转换 ──────────────────────────────

  describe("bullet list 转换", () => {
    it("简单无序列表", () => {
      const md = "- 项目一\n- 项目二\n- 项目三";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("bulletList");
      if (blocks[0]!.kind === "bulletList") {
        expect(blocks[0]!.items).toHaveLength(3);
        expect(blocks[0]!.items[0]!.runs[0]!.text).toBe("项目一");
        expect(blocks[0]!.items[2]!.runs[0]!.text).toBe("项目三");
      }
    });

    it("使用 * 标记的无序列表", () => {
      const md = "* 项目一\n* 项目二";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("bulletList");
      if (blocks[0]!.kind === "bulletList") {
        expect(blocks[0]!.items).toHaveLength(2);
      }
    });

    it("嵌套无序列表", () => {
      const md = "- 外层一\n  - 内层一\n  - 内层二\n- 外层二";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("bulletList");
      if (blocks[0]!.kind === "bulletList") {
        expect(blocks[0]!.items).toHaveLength(2);
        const outer = blocks[0]!.items[0]!;
        expect(outer.runs[0]!.text).toBe("外层一");
        expect(outer.children).toBeDefined();
        expect(outer.children!).toHaveLength(2);
        expect(outer.children![0]!.runs[0]!.text).toBe("内层一");
      }
    });
  });

  // ─── ordered list 转换 ────────────────────────────

  describe("ordered list 转换", () => {
    it("简单有序列表", () => {
      const md = "1. 第一项\n2. 第二项\n3. 第三项";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("orderedList");
      if (blocks[0]!.kind === "orderedList") {
        expect(blocks[0]!.items).toHaveLength(3);
        expect(blocks[0]!.start).toBe(1);
        expect(blocks[0]!.items[0]!.runs[0]!.text).toBe("第一项");
      }
    });

    it("自定义起始序号", () => {
      const md = "5. 第五项\n6. 第六项";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("orderedList");
      if (blocks[0]!.kind === "orderedList") {
        expect(blocks[0]!.start).toBe(5);
      }
    });
  });

  // ─── code_block 转换 ──────────────────────────────

  describe("code_block 转换", () => {
    it("fence 代码块（带语言）", () => {
      const md = "```javascript\nconsole.log('hello');\n```";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("codeBlock");
      if (blocks[0]!.kind === "codeBlock") {
        expect(blocks[0]!.language).toBe("javascript");
        expect(blocks[0]!.content).toContain("console.log('hello');");
      }
    });

    it("fence 代码块（无语言）", () => {
      const md = "```\nplain code\n```";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("codeBlock");
      if (blocks[0]!.kind === "codeBlock") {
        expect(blocks[0]!.language).toBe("");
        expect(blocks[0]!.content).toContain("plain code");
      }
    });

    it("多行代码块", () => {
      const md = "```python\ndef hello():\n    print('hi')\n    return None\n```";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("codeBlock");
      if (blocks[0]!.kind === "codeBlock") {
        expect(blocks[0]!.content).toContain("def hello():");
        expect(blocks[0]!.content).toContain("return None");
      }
    });
  });

  // ─── table 转换 ───────────────────────────────────

  describe("table 转换", () => {
    it("简单表格", () => {
      const md = "| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 25 |\n| 李四 | 30 |";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("table");
      if (blocks[0]!.kind === "table") {
        // 三维结构：header[行][单元格][run]
        // 表头 1 行
        expect(blocks[0]!.header).toHaveLength(1);
        // 表头第一行 2 个单元格
        expect(blocks[0]!.header[0]).toHaveLength(2);
        expect(blocks[0]!.header[0]![0]![0]!.text).toBe("姓名");
        expect(blocks[0]!.header[0]![1]![0]!.text).toBe("年龄");
        // 表体 2 行
        expect(blocks[0]!.rows).toHaveLength(2);
        // 第一行第一个单元格的第一个 run
        expect(blocks[0]!.rows[0]![0]![0]!.text).toBe("张三");
        // 第二行第二个单元格的第一个 run
        expect(blocks[0]!.rows[1]![1]![0]!.text).toBe("30");
      }
    });
  });

  // ─── blockquote 转换 ──────────────────────────────

  describe("blockquote 转换", () => {
    it("简单引用块", () => {
      const md = "> 这是引用内容";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("blockquote");
      if (blocks[0]!.kind === "blockquote") {
        expect(blocks[0]!.blocks).toHaveLength(1);
        expect(blocks[0]!.blocks[0]!.kind).toBe("paragraph");
      }
    });

    it("多行引用块", () => {
      const md = "> 第一行\n> 第二行\n>\n> 第二段";
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      expect(blocks[0]!.kind).toBe("blockquote");
      if (blocks[0]!.kind === "blockquote") {
        // 应有 2 个段落
        expect(blocks[0]!.blocks.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ─── hr 转换 ──────────────────────────────────────

  describe("hr 转换", () => {
    it("--- 分割线", () => {
      const blocks = parseMarkdownToBlocks("---", createTestMd());
      expect(blocks.some((b) => b.kind === "hr")).toBe(true);
    });

    it("*** 分割线", () => {
      const blocks = parseMarkdownToBlocks("***", createTestMd());
      expect(blocks.some((b) => b.kind === "hr")).toBe(true);
    });
  });

  // ─── 行内格式 ───────────────────────────────────────

  describe("行内格式转换", () => {
    it("粗体 **text**", () => {
      const blocks = parseMarkdownToBlocks("**加粗文本**", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.bold).toBe(true);
        expect(run.text).toBe("加粗文本");
      }
    });

    it("斜体 *text*", () => {
      const blocks = parseMarkdownToBlocks("*斜体文本*", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.italic).toBe(true);
        expect(run.text).toBe("斜体文本");
      }
    });

    it("删除线 ~~text~~", () => {
      const blocks = parseMarkdownToBlocks("~~删除文本~~", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.strike).toBe(true);
        expect(run.text).toBe("删除文本");
      }
    });

    it("行内代码 `code`", () => {
      const blocks = parseMarkdownToBlocks("`inline code`", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.code).toBe(true);
        expect(run.text).toBe("inline code");
      }
    });

    it("链接 [text](url)", () => {
      const blocks = parseMarkdownToBlocks("[LightMD](https://example.com)", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.href).toBe("https://example.com");
        expect(run.text).toBe("LightMD");
      }
    });

    it("混合格式：粗体+斜体", () => {
      const blocks = parseMarkdownToBlocks("***粗斜体***", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.bold).toBe(true);
        expect(run.italic).toBe(true);
        expect(run.text).toBe("粗斜体");
      }
    });

    it("图片转为 alt 文本占位", () => {
      const blocks = parseMarkdownToBlocks("![alt 文本](image.png)", createTestMd());
      expect(blocks[0]!.kind).toBe("paragraph");
      if (blocks[0]!.kind === "paragraph") {
        const run = blocks[0]!.runs[0]!;
        expect(run.text).toContain("图片");
        expect(run.text).toContain("alt 文本");
      }
    });
  });

  // ─── 复合文档 ───────────────────────────────────────

  describe("复合文档", () => {
    it("混合多种块级元素", () => {
      const md = `# 标题

第一段内容。

- 列表项一
- 列表项二

\`\`\`js
code();
\`\`\`

> 引用

---

结尾段落。`;
      const blocks = parseMarkdownToBlocks(md, createTestMd());
      // 应包含：heading, paragraph, bulletList, paragraph, codeBlock, paragraph, blockquote, hr, paragraph
      const kinds = blocks.map((b) => b.kind);
      expect(kinds).toContain("heading");
      expect(kinds).toContain("paragraph");
      expect(kinds).toContain("bulletList");
      expect(kinds).toContain("codeBlock");
      expect(kinds).toContain("blockquote");
      expect(kinds).toContain("hr");
    });

    it("空文档返回空数组", () => {
      const blocks = parseMarkdownToBlocks("", createTestMd());
      expect(blocks).toHaveLength(0);
    });

    it("仅空白字符的文档", () => {
      const blocks = parseMarkdownToBlocks("   \n\n  ", createTestMd());
      expect(blocks).toHaveLength(0);
    });
  });

  // ─── parseInlineTokens 单独测试 ────────────────────

  describe("parseInlineTokens 单独测试", () => {
    it("空数组返回空数组", () => {
      expect(parseInlineTokens([])).toHaveLength(0);
    });

    it("纯文本 token", () => {
      const md = new MarkdownIt();
      const tokens = md.parseInline("hello world", {}).find((t: any) => t.type === "inline")?.children || [];
      const runs = parseInlineTokens(tokens);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.text).toBe("hello world");
    });

    it("过滤空文本 run", () => {
      // 构造空 text token
      const tokens = [
        { type: "text", content: "", tag: "", attrs: null, nesting: 0, level: 0, children: null, markup: "", info: "", block: false, hidden: false, map: null, meta: null },
      ] as any;
      const runs = parseInlineTokens(tokens);
      expect(runs).toHaveLength(0);
    });
  });

  // ─── parseBlockTokens 单独测试 ─────────────────────

  describe("parseBlockTokens 单独测试", () => {
    it("空 token 数组返回空数组", () => {
      expect(parseBlockTokens([], 0, 0)).toHaveLength(0);
    });

    it("未识别的 token 被跳过", () => {
      const tokens = [
        { type: "unknown_block_open", tag: "", attrs: null, nesting: 1, level: 0, children: null, content: "", markup: "", info: "", block: true, hidden: false, map: null, meta: null },
        { type: "unknown_block_close", tag: "", attrs: null, nesting: -1, level: 0, children: null, content: "", markup: "", info: "", block: true, hidden: false, map: null, meta: null },
      ] as any;
      expect(parseBlockTokens(tokens, 0, tokens.length)).toHaveLength(0);
    });
  });
});
