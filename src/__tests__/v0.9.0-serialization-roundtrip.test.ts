/**
 * v0.9.0 序列化往返修复回归测试
 *
 * 对应缺陷清单（lightmd/.trae/documents/lightmd-serialization-roundtrip-bugs.md
 * 与 .trae/documents/plan-v0.9.0-serialization-roundtrip-fixes.md）：
 * - B1/B5 code 围栏长度选择（CommonMark：最长反引号连续段+1，首尾按需补空格）
 * - B2/B3/B4 mark 嵌套顺序（code 恒最内层）
 * - C1 文本转义层、C2 块级代码围栏、C3 link/image 目标转义、C4 引用内空行、
 *   C5 typographer 关闭
 * - D1 嵌套引用丢失、D2 列表后表格被吞、D3 脚注尾部空行膨胀、D4 有序列表起始号、
 *   D5 表格内管道转义、D6 deflist/脚注块级内容丢失、D7 CRLF 行尾、D8 ZWSP 泄漏、
 *   D9 emoji shortcode、D11 fence info
 * - B6 未编辑块原文保留（快路径逐字节返回源文本；编辑块走规范序列化）
 *
 * 验证方式：「往返恒等」= docToMarkdown(markdownToDoc(src)) === src；
 * 程序化节点（无解析期原文记录）走全量序列化路径，用 Node.fromJSON 深拷贝
 * （missCopy）模拟 miss 场景验证规范序列化行为。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc, md } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema as schema } from "../core/schema";
import { preserveEol } from "../utils/eolPreserve";
import { Node as PMNodeCtor } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

/** md → doc → md 往返一次 */
function roundtrip(src: string): string {
  return docToMarkdown(markdownToDoc(src));
}

/** 往返两次（验证收敛稳定性） */
function roundtrip2(src: string): string {
  return roundtrip(roundtrip(src));
}

/** 深拷贝重建 doc → 全部节点丢失原文记录（模拟 miss / 编辑后路径） */
function missCopy(doc: PMNode): PMNode {
  return PMNodeCtor.fromJSON(schema, doc.toJSON());
}

/** 将 doc 中第一个 textContent 匹配的顶层段落替换为新段落（模拟阅读模式编辑） */
function replaceTopParagraph(doc: PMNode, target: string, newText: string): PMNode {
  const children: PMNode[] = [];
  let replaced = false;
  doc.forEach((n) => {
    if (!replaced && n.type.name === "paragraph" && n.textContent === target) {
      children.push(schema.nodes.paragraph.create(null, schema.text(newText)));
      replaced = true;
    } else {
      children.push(n);
    }
  });
  return schema.topNodeType.create(null, children);
}

// ─── B1/B5：code 围栏长度选择 ───────────────────────────────

describe("B1/B5：行内 code 围栏长度按最长反引号连续段选择", () => {
  it("B1 表格单元格内 code 含尾部反引号：往返恒等", () => {
    const src = "| a | b |\n| --- | --- |\n| ``Ctrl+` `` | x |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("B5 相邻 code span（含单反引号 span）：往返恒等", () => {
    const src = "- 输入 `(` `[` `\"` `'` `` ` `` `*` 符号\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("code 内容含连续 2 个反引号：围栏升为 3 个且往返收敛", () => {
    const src = "- 代码 `a``b` 结束\n";
    const doc1 = markdownToDoc(src);
    // 未编辑 doc：B6 快路径逐字节返回原文
    expect(docToMarkdown(doc1)).toBe(src);
    // miss 路径（编辑过的块）：内容最长反引号段为 2 → 围栏 3
    const md1 = docToMarkdown(missCopy(doc1));
    expect(md1).toContain("```a``b```");
    const doc2 = markdownToDoc(md1);
    expect(doc1.eq(doc2)).toBe(true);
    expect(docToMarkdown(doc2)).toBe(md1);
    // code 文本内容不丢
    let codeText = "";
    doc1.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "code")) codeText += n.text;
      return true;
    });
    expect(codeText).toBe("a``b");
  });

  it("code 内容以反引号开头：首尾补空格后往返恒等", () => {
    const src = "- `` `x `` y\n";
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── B2/B3/B4：mark 嵌套顺序（code 恒最内层） ───────────────

describe("B2/B3/B4：strong/em/link/strike/mark 与 code 嵌套往返", () => {
  it("B2 粗体内含行内代码：往返恒等", () => {
    const src = "- **滚动监听全部声明 `passive`**\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("B3 行内代码包粗体语义（strong>code）：往返恒等", () => {
    const src = "- **`x.msi`** — MSI 安装包\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("B4 粗体伪标题里括号内行内代码：往返恒等", () => {
    const src = "**F1 · AI 对话浮动窗口（`Ctrl+K`）**\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("link 与 code 嵌套：往返恒等", () => {
    const src = "[`x`](url)\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("strike/mark 与 code 嵌套：往返恒等", () => {
    expect(roundtrip("~~`x`~~\n")).toBe("~~`x`~~\n");
    expect(roundtrip("==`x`==\n")).toBe("==`x`==\n");
  });
});

// ─── C3：link/image 目标转义 ────────────────────────────────

describe("C3：link/image 目标含特殊字符", () => {
  it("href 含配对括号：未编辑走快路径原文，miss 路径序列化为 <...> 形式", () => {
    const src = "[x](file(1).md)\n";
    const doc1 = markdownToDoc(src);
    expect(docToMarkdown(doc1)).toBe(src);
    const md1 = docToMarkdown(missCopy(doc1));
    expect(md1).toBe("[x](<file(1).md>)\n");
    const doc2 = markdownToDoc(md1);
    expect(doc1.eq(doc2)).toBe(true);
    expect(docToMarkdown(doc2)).toBe(md1);
  });

  it("image src 含配对括号：同上", () => {
    const src = "![a](img(1).png)\n";
    const doc1 = markdownToDoc(src);
    expect(docToMarkdown(doc1)).toBe(src);
    const md1 = docToMarkdown(missCopy(doc1));
    expect(md1).toBe("![a](<img(1).png>)\n");
    expect(markdownToDoc(md1).eq(doc1)).toBe(true);
  });

  it("href 含空格（程序化节点）：用 <...> 包裹后可重新解析", () => {
    const para = schema.nodes.paragraph.create(null, [
      schema.text("x", [schema.mark("link", { href: "my file.md", title: "" })]),
    ]);
    const doc = schema.topNodeType.create(null, [para]);
    const md1 = docToMarkdown(doc);
    expect(md1).toBe("[x](<my file.md>)\n");
    const doc2 = markdownToDoc(md1);
    let href = "";
    doc2.descendants((n) => {
      const link = n.marks.find((m) => m.type.name === "link");
      if (link) href = link.attrs.href;
      return true;
    });
    // markdown-it 的 normalizeLink 会把空格编码为 %20（存储层语义等价，渲染一致）
    expect(href).toBe("my%20file.md");
  });
});

// ─── C4：blockquote 引用内空行 ──────────────────────────────

describe("C4：引用内多段落往返", () => {
  it("引用内两段落：往返恒等（空行写成 >）", () => {
    const src = "> a\n>\n> b\n";
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── C1：文本转义层 ─────────────────────────────────────────

describe("C1：普通文本特殊字符往返不变义", () => {
  /** 断言：往返后 doc 结构与纯文本内容不变，且二次往返字节稳定 */
  function expectTextStable(src: string, expectedText?: string) {
    const doc1 = markdownToDoc(src);
    const md1 = docToMarkdown(doc1);
    const doc2 = markdownToDoc(md1);
    expect(doc1.eq(doc2)).toBe(true);
    expect(docToMarkdown(doc2)).toBe(md1);
    if (expectedText !== undefined) {
      let text = "";
      doc1.descendants((n) => {
        if (n.isText) text += n.text;
        return true;
      });
      expect(text).toBe(expectedText);
    }
  }

  it("成对星号字面量不变义（探针实锤场景）", () => {
    // 源文转义形态（text node 内容是 "*"）：往返恒等
    expect(roundtrip("星号 \\* 不强调 a \\_ b\n")).toBe("星号 \\* 不强调 a \\_ b\n");
    // 2*3*4 会被 CommonMark 解析为词内强调（em("3")），验证该结构往返保真
    expect(roundtrip("2*3*4\n")).toBe("2*3*4\n");
    // 转义层（miss 路径）：text 内成对星号被转义，重解析还原为字面星号
    const md1 = docToMarkdown(missCopy(markdownToDoc("a \\* b \\* c\n")));
    expect(md1).toBe("a \\* b \\* c\n");
    let text = "";
    markdownToDoc(md1).descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toBe("a * b * c");
  });

  it("词内下划线不转义（零噪音），边界下划线转义", () => {
    expect(roundtrip("snake_case\n")).toBe("snake_case\n");
    expect(roundtrip("a_b_c\n")).toBe("a_b_c\n");
    expect(roundtrip("\\_foo\\_ bar\n")).toBe("\\_foo\\_ bar\n");
  });

  it("== 高亮形态字面量不变义", () => {
    // a==b==c 被 mark 插件解析为高亮（==b==），验证该结构往返保真
    expect(roundtrip("a==b==c\n")).toBe("a==b==c\n");
    expect(roundtrip("a=b=c\n")).toBe("a=b=c\n");
    // 转义层（miss 路径）：text 内 == 被转义，重解析还原为字面
    const md1 = docToMarkdown(missCopy(markdownToDoc("a\\=\\=b\\=\\=c\n")));
    expect(md1).toBe("a\\=\\=b\\=\\=c\n");
    let text = "";
    markdownToDoc(md1).descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toBe("a==b==c");
  });

  it("实体引用形态 & 转义后往返收敛（探针 &amp; &copy; &#65; 场景）", () => {
    // 未编辑：B6 快路径逐字节返回原文
    const src = "&amp; &copy; &#65;\n";
    expect(roundtrip(src)).toBe(src);
    // miss 路径：doc 层已解码为字符 "& © A"，序列化后内容不变且二次往返收敛
    const md1 = docToMarkdown(missCopy(markdownToDoc(src)));
    expect(md1).toBe("& © A\n");
    expect(roundtrip2(md1)).toBe(md1);
    // 转义层：text 内字面 entity 形态被转义，重解析还原为字面
    const md2 = docToMarkdown(missCopy(markdownToDoc("\\&copy; x\n")));
    expect(md2).toBe("\\&copy; x\n");
    let text = "";
    markdownToDoc(md2).descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toBe("&copy; x");
    expect(roundtrip("AT&T\n")).toBe("AT&T\n");
  });

  it("$ 字符转义，防意外配对成行内公式", () => {
    expect(roundtrip("5\\$ 价格\n")).toBe("5\\$ 价格\n");
    // "价格 $5 和 $10" 会被 math 插件解析为行内公式（$5 和 $），验证公式结构往返；
    // 转义形态的字面 $（miss 路径转义层）重解析保持字面
    expect(roundtrip("价格 $5 和 $10\n")).toBe("价格 $5 和 $10\n");
    const md1 = docToMarkdown(missCopy(markdownToDoc("价格 \\$5 和 \\$10\n")));
    expect(md1).toBe("价格 \\$5 和 \\$10\n");
  });

  it("方括号非链接形态零噪音，链接形态转义", () => {
    expect(roundtrip("[TODO] 待办\n")).toBe("[TODO] 待办\n");
    // 程序化 text node（用户在编辑器打出的字面 "![a](b)"）：
    // miss 路径转义后重解析还原为字面文本
    const para = schema.nodes.paragraph.create(null, [schema.text("![a](b)")]);
    const doc = schema.topNodeType.create(null, [para]);
    const md1 = docToMarkdown(doc);
    expect(md1).toBe("\\!\\[a\\](b)\n");
    let text = "";
    markdownToDoc(md1).descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toBe("![a](b)");
  });

  it("autolink 形态 < 转义，普通 < 零噪音", () => {
    expect(roundtrip("a < b\n")).toBe("a < b\n");
  });

  it("~ 与 ^ 字面量不变义", () => {
    expectTextStable("a ~ b ~ c\n", "a ~ b ~ c");
    expectTextStable("a ^ b ^ c\n", "a ^ b ^ c");
  });
});

// ─── C5：typographer 关闭 ───────────────────────────────────

describe("C5：直引号往返不被改写为弯引号", () => {
  it("双引号与单引号往返恒等", () => {
    const src = '"quoted" and \'single\'\n';
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── B6：未编辑块原文保留 ───────────────────────────────────

describe("B6：块级原文保留", () => {
  it("未编辑文档（含表格/列表/引用/末尾空行）：逐字节恒等", () => {
    const src = [
      "# 标题",
      "",
      "- a",
      "- b",
      "",
      "| x | y |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> 引用",
      "",
      "尾段",
      "",
      "",
      "",
    ].join("\n");
    expect(roundtrip(src)).toBe(src);
  });

  it("表格分隔行非规范形式（|---|）不被重排", () => {
    const src = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("列表前不插入空行（B6 主诉场景）", () => {
    const src = "**F1 · 快捷键**\n- 项目一\n- 项目二\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("标题后空行不被删除", () => {
    const src = "## 标题\n\n正文\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("模拟阅读模式编辑一段：其余块逐字节保真，diff 最小化", () => {
    const src = "# H\n\n段落一\n\n段落二\n\n段落三\n";
    const doc1 = markdownToDoc(src);
    const edited = replaceTopParagraph(doc1, "段落二", "新文本");
    expect(docToMarkdown(edited)).toBe("# H\n\n段落一\n\n新文本\n\n段落三\n");
  });

  it("编辑列表项后表格不被吞（D2 + B6 协同）", () => {
    const src = "- item\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const doc1 = markdownToDoc(src);
    // 程序化重建 = 全部块 miss → 全量序列化路径（含 D2 修复：表格前必须有空行）
    const edited = missCopy(doc1);
    const md1 = docToMarkdown(edited);
    // 表格前有空行，重解析表格仍存在
    const doc2 = markdownToDoc(md1);
    let tableCount = 0;
    doc2.descendants((n) => {
      if (n.type.name === "table") tableCount++;
      return true;
    });
    expect(tableCount).toBe(1);
    // 二次往返收敛
    expect(roundtrip2(md1)).toBe(md1);
  });
});

// ─── D1：嵌套引用 ───────────────────────────────────────────

describe("D1：嵌套引用内容保留", () => {
  it("两层嵌套引用：往返恒等", () => {
    const src = "> 外层\n> > 内层\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("三层嵌套引用：内层内容全部保留", () => {
    const src = "> a\n> > b\n> > > c\n";
    const doc1 = markdownToDoc(src);
    let text = "";
    doc1.descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("c");
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── D2：列表后表格 ─────────────────────────────────────────

describe("D2：列表块后的表格不被吞", () => {
  it("未编辑：原文保留（B6 快路径）", () => {
    const src = "- item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("miss 路径：表格前补空行，重解析表格存在且二次往返收敛", () => {
    const src = "- item\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const md1 = docToMarkdown(missCopy(markdownToDoc(src)));
    const doc2 = markdownToDoc(md1);
    let tableCount = 0;
    doc2.descendants((n) => {
      if (n.type.name === "table") tableCount++;
      return true;
    });
    expect(tableCount).toBe(1);
    expect(roundtrip2(md1)).toBe(md1);
  });
});

// ─── D5：表格内管道转义 ─────────────────────────────────────

describe("D5：表格单元格内管道字符", () => {
  it("code span 内管道：写为 \\| 且往返恒等", () => {
    const src = "| `x\\|y` | b |\n| --- | --- |\n| c | d |\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("普通文本内管道：写为 \\| 且往返恒等", () => {
    const src = "| a \\| b | c |\n| --- | --- |\n| d | e |\n";
    expect(roundtrip(src)).toBe(src);
  });
});

// ─── D3：脚注 ───────────────────────────────────────────────

describe("D3：脚注定义往返", () => {
  it("含脚注定义的文档：往返恒等（尾部空行不膨胀）", () => {
    const src = "正文[^1]\n\n[^1]: 单段定义\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("脚注定义内多段落：内容不丢且二次往返收敛", () => {
    const src = "正文[^1]\n\n[^1]: 第一段\n\n    第二段\n";
    const doc1 = markdownToDoc(src);
    let text = "";
    doc1.descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toContain("第一段");
    expect(text).toContain("第二段");
    const md1 = docToMarkdown(doc1);
    expect(md1.endsWith("\n\n\n")).toBe(false);
    expect(roundtrip2(md1)).toBe(md1);
  });

  it("miss 路径：脚注文档全量序列化尾部不膨胀", () => {
    const src = "正文[^1]\n\n[^1]: 单段定义\n";
    const md1 = docToMarkdown(missCopy(markdownToDoc(src)));
    expect(md1).not.toMatch(/\n{3,}$/);
    expect(md1).toContain("[^1]: 单段定义");
    expect(roundtrip2(md1)).toBe(md1);
  });
});

// ─── D4：有序列表起始号 ─────────────────────────────────────

describe("D4：有序列表起始号", () => {
  it("起始号 5：往返恒等", () => {
    const src = "5. five\n6. six\n7. seven\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("miss 路径：起始号仍为 5", () => {
    const src = "5. five\n6. six\n7. seven\n";
    const md1 = docToMarkdown(missCopy(markdownToDoc(src)));
    expect(md1).toBe(src);
  });
});

// ─── D6：deflist / 脚注内块级内容 ───────────────────────────

describe("D6：定义列表 dd 内块级内容不丢", () => {
  it("dd 内代码块：内容文本保留", () => {
    const src = "term\n: 定义内容\n\n      code in dd\n";
    const doc1 = markdownToDoc(src);
    let text = "";
    doc1.descendants((n) => {
      if (n.isText) text += n.text;
      return true;
    });
    expect(text).toContain("定义内容");
    expect(text).toContain("code in dd");
    const md1 = docToMarkdown(doc1);
    expect(md1).toContain("code in dd");
    expect(roundtrip2(md1)).toBe(md1);
  });
});

// ─── D7：CRLF 行尾 ──────────────────────────────────────────

describe("D7：CRLF 行尾保真", () => {
  it("preserveEol：CRLF 原文的 LF 序列化输出转换为 CRLF", () => {
    const original = "para1\r\n\r\npara2\r\n";
    expect(preserveEol("para1\n\npara2\n", original)).toBe(original);
  });

  it("preserveEol：LF 原文不改动", () => {
    expect(preserveEol("a\nb\n", "a\nb\n")).toBe("a\nb\n");
  });

  it("preserveEol：混合行尾输出只补缺失的 \\r", () => {
    // B6 快路径已返回 CRLF 原文，miss 块为 LF → 混合形态
    const mixed = "kept\r\nedited\n";
    expect(preserveEol(mixed, "x\r\ny\r\n")).toBe("kept\r\nedited\r\n");
  });

  it("miss 路径 + preserveEol：CRLF 文档全量序列化后行尾保持", () => {
    const original = "para1\r\n\r\npara2\r\n";
    // parser 按行解析，\r 会留在行尾被 trim 掉——markdownToDoc 输入需先归一化为 LF
    const lf = original.replace(/\r\n/g, "\n");
    const mdLF = docToMarkdown(missCopy(markdownToDoc(lf)));
    expect(preserveEol(mdLF, original)).toBe(original);
  });
});

// ─── D8：ZWSP 占位符 ────────────────────────────────────────

describe("D8：空代码块/空数学块不泄漏零宽空格", () => {
  it("空代码块：往返恒等（快路径）", () => {
    expect(roundtrip("```\n```\n")).toBe("```\n```\n");
  });

  it("miss 路径：空代码块/mermaid/数学块输出不含 \\u200B", () => {
    expect(docToMarkdown(missCopy(markdownToDoc("```\n```\n")))).toBe("```\n```\n");
    expect(docToMarkdown(missCopy(markdownToDoc("$$\n$$\n")))).toBe("$$\n$$\n");
  });
});

// ─── D9：emoji shortcode ────────────────────────────────────

describe("D9：emoji shortcode 保留原文", () => {
  it(":smile: 往返恒等（doc 层保留 shortcode）", () => {
    const src = "表情 :smile: 和 :+1: 测试\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("分屏预览 md.render 仍将 shortcode 渲染为 emoji", () => {
    const html = md.render(":smile:");
    expect(html).toContain("😄");
  });
});

// ─── D11：fence info 完整保留 ───────────────────────────────

describe("D11：fence info 附加参数", () => {
  it("```js {highlight}：往返恒等", () => {
    const src = "```js {highlight}\ncode\n```\n";
    expect(roundtrip(src)).toBe(src);
  });

  it("miss 路径：info 完整输出，语言仍取首词", () => {
    const src = "```js {highlight}\ncode\n```\n";
    const md1 = docToMarkdown(missCopy(markdownToDoc(src)));
    expect(md1).toBe(src);
    const doc = markdownToDoc(src);
    let lang = "";
    doc.descendants((n) => {
      if (n.type.name === "code_block") lang = n.attrs.language;
      return true;
    });
    expect(lang).toBe("js");
  });
});

// ─── 综合回归 ───────────────────────────────────────────────

describe("综合：README 风格混合文档往返恒等", () => {
  it("标题/列表/表格/代码块/引用/行内格式混合文档逐字节恒等", () => {
    const src = [
      "# LightMD",
      "",
      "**F1 · AI 对话浮动窗口（`Ctrl+K`）**",
      "- **滚动监听全部声明 `passive`**",
      "- 普通 `code` 项",
      "",
      "| 功能 | 快捷键 |",
      "| --- | --- |",
      "| 复制 | ``Ctrl+C`` |",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "> 引用内容",
      "> 第二行",
      "",
      "结尾段落 ~5MB 文档 2*3*4 示例",
      "",
    ].join("\n");
    expect(roundtrip(src)).toBe(src);
  });
});
