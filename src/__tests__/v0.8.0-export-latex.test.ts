/**
 * v0.8.0 WP6 LaTeX 导出测试
 *
 * 覆盖 exportLatex.ts：
 * 1. 普通文本特殊字符转义（# $ % & _ { } ~ ^ \）
 * 2. 行内格式映射 \textbf/\emph/\texttt/\href/\sout/\hl/\textsubscript/\textsuperscript/$...$
 * 3. Block 映射：heading/paragraph/list/codeBlock/blockquote/table/hr/mathBlock/image
 * 4. 关键正确性：代码块与公式内部**不转义**
 * 5. 集成：markdown → Block[] → LaTeX（含 mark/sub/sup/行内公式）
 */
import { describe, it, expect } from "vitest";
import MarkdownIt from "markdown-it";
import markPlugin from "markdown-it-mark";
import subPlugin from "markdown-it-sub";
import supPlugin from "markdown-it-sup";
import { mathPlugin } from "../core/markdown/katex-plugin";
import {
  escapeLatexText,
  inlineRunsToLatex,
  blocksToLatex,
  markdownToLatex,
  parseMarkdownToBlocks,
} from "../utils/exportLatex";
import type { Block, InlineRun } from "../utils/exportBlocks";

/** 构造带 mark/sub/sup/数学公式插件的 markdown-it 实例 */
function makeMd(): MarkdownIt {
  const md = new MarkdownIt("commonmark", {
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
  });
  md.enable(["table", "strikethrough"]);
  md.use(mathPlugin);
  md.use(markPlugin);
  md.use(subPlugin);
  md.use(supPlugin);
  return md;
}

describe("v0.8.0 LaTeX 导出", () => {
  // ─── 特殊字符转义 ──────────────────────────────────
  describe("escapeLatexText 特殊字符转义", () => {
    it("$100 → 转义为 \\$100", () => {
      expect(escapeLatexText("$100")).toBe("\\$100");
    });
    it("50% off → 转义为 50\\% off", () => {
      expect(escapeLatexText("50% off")).toBe("50\\% off");
    });
    it("a_b_c → 转义为 a\\_b\\_c", () => {
      expect(escapeLatexText("a_b_c")).toBe("a\\_b\\_c");
    });
    it("C:\\path → 反斜杠转义为 \\textbackslash{}", () => {
      expect(escapeLatexText("C:\\path")).toBe("C:\\textbackslash{}path");
    });
    it("x^2 → ^ 转义为 \\textasciicircum{}", () => {
      expect(escapeLatexText("x^2")).toBe("x\\textasciicircum{}2");
    });
    it("~ → 转义为 \\textasciitilde{}", () => {
      expect(escapeLatexText("~")).toBe("\\textasciitilde{}");
    });
    it("# & { } 均被转义", () => {
      expect(escapeLatexText("#")).toBe("\\#");
      expect(escapeLatexText("&")).toBe("\\&");
      expect(escapeLatexText("{")).toBe("\\{");
      expect(escapeLatexText("}")).toBe("\\}");
    });
    it("普通中英文不引入多余转义", () => {
      expect(escapeLatexText("你好 World")).toBe("你好 World");
    });
  });

  // ─── 行内格式映射 ──────────────────────────────────
  describe("inlineRunsToLatex 行内格式映射", () => {
    it("粗体 → \\textbf", () => {
      const runs: InlineRun[] = [{ text: "加粗", bold: true }];
      expect(inlineRunsToLatex(runs)).toContain("\\textbf{加粗}");
    });
    it("斜体 → \\emph", () => {
      const runs: InlineRun[] = [{ text: "倾斜", italic: true }];
      expect(inlineRunsToLatex(runs)).toContain("\\emph{倾斜}");
    });
    it("删除线 → \\sout", () => {
      const runs: InlineRun[] = [{ text: "删除", strike: true }];
      expect(inlineRunsToLatex(runs)).toContain("\\sout{删除}");
    });
    it("高亮 → \\hl", () => {
      const runs: InlineRun[] = [{ text: "高亮", mark: true }];
      expect(inlineRunsToLatex(runs)).toContain("\\hl{高亮}");
    });
    it("下标 → \\textsubscript", () => {
      const runs: InlineRun[] = [{ text: "x", sub: true }];
      expect(inlineRunsToLatex(runs)).toContain("\\textsubscript{x}");
    });
    it("上标 → \\textsuperscript", () => {
      const runs: InlineRun[] = [{ text: "2", sup: true }];
      expect(inlineRunsToLatex(runs)).toContain("\\textsuperscript{2}");
    });
    it("行内代码 → \\texttt 且不转义", () => {
      const runs: InlineRun[] = [{ text: "$100 50%", code: true }];
      const out = inlineRunsToLatex(runs);
      expect(out).toContain("\\texttt{$100 50%}");
      expect(out).not.toContain("\\$100");
    });
    it("链接 → \\href", () => {
      const runs: InlineRun[] = [{ text: "网站", href: "https://example.com" }];
      expect(inlineRunsToLatex(runs)).toContain("\\href{https://example.com}{网站}");
    });
    it("行内公式 → $...$ 不转义", () => {
      const runs: InlineRun[] = [{ text: "E=mc^2", math: "E=mc^2" }];
      expect(inlineRunsToLatex(runs)).toContain("$E=mc^2$");
    });
    it("图片 → \\includegraphics{原路径}", () => {
      const runs: InlineRun[] = [{ text: "[图片]", imageSrc: "img/fig1.png" }];
      expect(inlineRunsToLatex(runs)).toContain("\\includegraphics{img/fig1.png}");
    });
  });

  // ─── Block 映射 ────────────────────────────────────
  describe("blocksToLatex Block 映射", () => {
    it("heading 1-6 → \\section..\\subparagraph", () => {
      const blocks: Block[] = [1, 2, 3, 4, 5, 6].map((lvl) => ({
        kind: "heading",
        level: lvl as 1 | 2 | 3 | 4 | 5 | 6,
        runs: [{ text: `标题${lvl}` }],
      }));
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\section{标题1}");
      expect(out).toContain("\\subsection{标题2}");
      expect(out).toContain("\\subsubsection{标题3}");
      expect(out).toContain("\\paragraph{标题4}");
      expect(out).toContain("\\subparagraph{标题5}");
      expect(out).toContain("\\subparagraph{标题6}");
    });

    it("段落文本特殊字符被转义", () => {
      const blocks: Block[] = [{ kind: "paragraph", runs: [{ text: "价格 $100 与 a_b_c" }] }];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\$100");
      expect(out).toContain("a\\_b\\_c");
    });

    it("无序列表 → itemize", () => {
      const blocks: Block[] = [
        {
          kind: "bulletList",
          items: [
            { runs: [{ text: "项一" }] },
            { runs: [{ text: "项二" }] },
          ],
        },
      ];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{itemize}");
      expect(out).toContain("\\item 项一");
      expect(out).toContain("\\item 项二");
      expect(out).toContain("\\end{itemize}");
    });

    it("有序列表 → enumerate", () => {
      const blocks: Block[] = [
        { kind: "orderedList", items: [{ runs: [{ text: "一" }] }], start: 1 },
      ];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{enumerate}");
      expect(out).toContain("\\item 一");
      expect(out).toContain("\\end{enumerate}");
    });

    it("嵌套列表位于 \\item 内部", () => {
      const blocks: Block[] = [
        {
          kind: "bulletList",
          items: [
            {
              runs: [{ text: "外层" }],
              children: [{ runs: [{ text: "内层" }] }],
            },
          ],
        },
      ];
      const out = blocksToLatex(blocks);
      const itemIdx = out.indexOf("\\item 外层");
      const innerIdx = out.indexOf("\\item 内层");
      const endIdx = out.indexOf("\\end{itemize}");
      expect(itemIdx).toBeGreaterThan(-1);
      expect(innerIdx).toBeGreaterThan(itemIdx);
      expect(endIdx).toBeGreaterThan(innerIdx);
    });

    it("代码块 → lstlisting 且内部不转义", () => {
      const blocks: Block[] = [
        { kind: "codeBlock", content: "$100\n50% off", language: "javascript" },
      ];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{lstlisting}[language=javascript]");
      expect(out).toContain("$100");
      expect(out).toContain("50% off");
      expect(out).not.toContain("\\$100");
      expect(out).toContain("\\end{lstlisting}");
    });

    it("未知语言不写 language= 选项（避免编译错误）", () => {
      const blocks: Block[] = [{ kind: "codeBlock", content: "x", language: "unknownlang" }];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{lstlisting}");
      expect(out).not.toContain("language=");
    });

    it("引用块 → quote", () => {
      const blocks: Block[] = [
        { kind: "blockquote", blocks: [{ kind: "paragraph", runs: [{ text: "引用内容" }] }] },
      ];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{quote}");
      expect(out).toContain("引用内容");
      expect(out).toContain("\\end{quote}");
    });

    it("分割线 → \\hrule", () => {
      const blocks: Block[] = [{ kind: "hr" }];
      expect(blocksToLatex(blocks)).toContain("\\hrule");
    });

    it("块公式 → \\[...\\] 且内部不转义", () => {
      const blocks: Block[] = [{ kind: "mathBlock", latex: "x^2 + \\alpha" }];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\[");
      expect(out).toContain("x^2 + \\alpha");
      expect(out).toContain("\\]");
      expect(out).not.toContain("\\textasciicircum{}");
    });

    it("表格 → tabular + l 列 + booktabs", () => {
      const blocks: Block[] = [
        {
          kind: "table",
          header: [[[{ text: "姓名" }], [{ text: "年龄" }]]],
          rows: [[[{ text: "张三" }], [{ text: "25" }]]],
        },
      ];
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{tabular}{ll}");
      expect(out).toContain("\\toprule");
      expect(out).toContain("姓名");
      expect(out).toContain("张三");
      expect(out).toContain("\\bottomrule");
      expect(out).toContain("\\end{tabular}");
    });

    it("图片 run → \\includegraphics", () => {
      const blocks: Block[] = [
        {
          kind: "paragraph",
          runs: [{ text: "[图]", imageSrc: "img/fig.png" }],
        },
      ];
      expect(blocksToLatex(blocks)).toContain("\\includegraphics{img/fig.png}");
    });
  });

  // ─── 文档头与完整文档 ─────────────────────────────
  describe("markdownToLatex 完整文档", () => {
    it("生成 ctexart 文档头与 \\end{document}", () => {
      const latex = markdownToLatex("# 标题\n\n正文 $100", "测试文档");
      expect(latex).toContain("\\documentclass{ctexart}");
      expect(latex).toContain("\\usepackage{graphicx}");
      expect(latex).toContain("\\usepackage{hyperref}");
      expect(latex).toContain("\\usepackage{listings}");
      expect(latex).toContain("\\usepackage{booktabs}");
      expect(latex).toContain("\\usepackage{xcolor}");
      expect(latex).toContain("\\usepackage{ulem}");
      expect(latex).toContain("\\usepackage{soul}");
      expect(latex).toContain("\\usepackage{amsmath}");
      expect(latex).toContain("\\section{标题}");
      expect(latex).toContain("\\$100");
      expect(latex).toContain("\\end{document}");
      expect(latex).toContain("\\title{测试文档}");
    });

    it("标题中的特殊字符被转义", () => {
      const latex = markdownToLatex("# 100% 完成", "文档");
      expect(latex).toContain("\\section{100\\% 完成}");
    });
  });

  // ─── 集成：markdown → Block[] → LaTeX ─────────────
  describe("parseMarkdownToBlocks 集成（mark/sub/sup/公式）", () => {
    it("==高亮== / ~下标~ / ^上标^ / $公式$ 正确映射", () => {
      const md = makeMd();
      const blocks = parseMarkdownToBlocks(
        "==高亮==，~下标~，^上标^，公式 $E=mc^2$",
        md,
      );
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\hl{高亮}");
      expect(out).toContain("\\textsubscript{下标}");
      expect(out).toContain("\\textsuperscript{上标}");
      expect(out).toContain("$E=mc^2$");
    });

    it("代码块内特殊字符不转义（集成）", () => {
      const md = makeMd();
      const blocks = parseMarkdownToBlocks("```\n$100 #a_b\n```", md);
      const out = blocksToLatex(blocks);
      expect(out).toContain("\\begin{lstlisting}");
      expect(out).toContain("$100 #a_b");
      expect(out).not.toContain("\\$100");
    });
  });
});
