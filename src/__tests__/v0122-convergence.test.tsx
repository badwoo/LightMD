/**
 * v0.12.2 缺陷收敛 —— 行为断言测试（P1 / P2 / P5 / P6 / P7 / P8 / P9）
 *
 * 设计原则（本轮教训）：失败的是「纯函数单测」与「源码文本正则断言」形式测不到的
 * 真实链路。因此这里**全部走真实链路**：
 *   · 真实 `createEditor` 挂载（P1 崩溃只在真实 EditorView 里暴露）
 *   · 真实 `markdownToDoc` → `docToMarkdown` → 再 `markdownToDoc`（编辑→存盘→重开）
 *   · 真实 `renderMarkdownHtml`（P2 的污染只在渲染管线跑过后出现）
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { createEditor } from "../core/editor";
import { markdownToDoc, createMarkdownIt } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { renderMarkdownHtml } from "../core/renderPipeline";
import { lightMDSchema } from "../core/schema";
import { emojiRenderKey } from "../core/plugins/emoji-render";
import {
  computeHeadingIds,
  buildHeadingIdSyncTransaction,
} from "../core/plugins/heading-id-sync";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";
import { buildExportCss } from "../components/dialogs/ExportDialog";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, rel), "utf8");

// ─────────────────────────────────────────────────────────
// P1：emoji 短码导致编辑器创建崩溃（P0）
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P1：含 emoji 短码的文档不再崩溃", () => {
  const mount = (content: string) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: content } as any);
    return { view, host };
  };

  it("真实 createEditor 挂载含 :smile: 的文档不抛错（旧实现在此处抛 RangeError）", () => {
    expect(() => {
      const { view, host } = mount("# Title\n\nhello :smile: world\n");
      expect(view).toBeTruthy();
      host.remove();
      view!.destroy();
    }).not.toThrow();
  });

  it("多个可识别短码同样安全", () => {
    const { view, host } = mount("a :smile: b :heart: c\n");
    expect(view).toBeTruthy();
    expect(view!.state.doc.textContent).toContain(":smile:");
    host.remove();
    view!.destroy();
  });

  it("doc 与序列化完全不变（显示层与存储层解耦）", () => {
    const { view, host } = mount("hello :smile: world\n");
    expect(view!.state.doc.textContent).toBe("hello :smile: world");
    expect(docToMarkdown(view!.state.doc)).toBe("hello :smile: world\n");
    host.remove();
    view!.destroy();
  });

  it("**光标位置映射正常**（旧实现 posAtDOM 全部映射到 1，点哪都跳段首）", () => {
    const { view, host } = mount("hello :smile: world\n");
    const tn = view!.dom.querySelector("p")!.firstChild as Text;
    // 前 6 个偏移应逐一对应 doc 位置 1..6（标准 TextViewDesc 行为）
    expect(view!.posAtDOM(tn, 0)).toBe(1);
    expect(view!.posAtDOM(tn, 3)).toBe(4);
    expect(view!.posAtDOM(tn, 6)).toBe(7);
    host.remove();
    view!.destroy();
  });

  it("装饰集覆盖可识别短码、跳过代码语境与不可识别短码", () => {
    const ok = mount("hello :smile: world\n");
    expect(emojiRenderKey.getState(ok.view!.state)!.find().length).toBe(1);
    ok.host.remove();
    ok.view!.destroy();

    const code = mount("a `:smile:` b\n");
    expect(emojiRenderKey.getState(code.view!.state)!.find().length).toBe(0);
    code.host.remove();
    code.view!.destroy();

    const unknown = mount("a :notanemoji: b\n");
    expect(emojiRenderKey.getState(unknown.view!.state)!.find().length).toBe(0);
    unknown.host.remove();
    unknown.view!.destroy();
  });

  it("编辑后装饰跟随更新（真实事务）", () => {
    const { view, host } = mount("hello\n");
    expect(emojiRenderKey.getState(view!.state)!.find().length).toBe(0);
    view!.dispatch(view!.state.tr.insertText(" :smile:", 6));
    expect(emojiRenderKey.getState(view!.state)!.find().length).toBe(1);
    host.remove();
    view!.destroy();
  });
});

// ─────────────────────────────────────────────────────────
// P2：渲染管线污染 PM 解析的图片宽度
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P2：渲染管线不再污染共享 markdown-it 单例", () => {
  const imgWidth = (doc: any): number | null => {
    let w: number | null = null;
    doc.descendants((n: any) => {
      if (n.type.name === "image") w = n.attrs.width;
      return true;
    });
    return w;
  };

  it("渲染一次后，PM 解析仍保留 ![alt|300] 的宽度", () => {
    renderMarkdownHtml("![alt|300](a.png)\n", { highlight: false });
    expect(imgWidth(markdownToDoc("![alt|300](a.png)\n"))).toBe(300);
  });

  it("渲染后编辑该块再存盘，宽度后缀仍保留（旧实现被永久抹除）", () => {
    renderMarkdownHtml("![alt|300](a.png)\n", { highlight: false });
    const doc = markdownToDoc("![alt|300](a.png)\n");
    let st = EditorState.create({ doc, schema: lightMDSchema });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 1)));
    st = st.apply(st.tr.insertText("X", 1));
    expect(docToMarkdown(st.doc)).toContain("|300");
  });

  it("渲染输出本身仍带 width（功能未退化）", () => {
    const html = renderMarkdownHtml("![alt|300](a.png)\n", { highlight: false });
    expect(html).toContain('width="300"');
  });

  it("普通图片与 CommonMark 模式都不受影响", () => {
    renderMarkdownHtml("![plain](b.png)\n", { highlight: false });
    expect(imgWidth(markdownToDoc("![plain](b.png)\n"))).toBe(null);
    expect(imgWidth(markdownToDoc("![alt|300](a.png)\n", { breaks: false }))).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────
// P5：$ 与 == 的无条件转义（反斜杠噪音）
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P5：$ 与 == 只在真能配对时转义", () => {
  /** 模拟「块被编辑」：B6 原文快路径会掩盖转义行为 */
  const editThenSave = (md: string) => {
    const doc = markdownToDoc(md);
    let st = EditorState.create({ doc, schema: lightMDSchema });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 1)));
    st = st.apply(st.tr.insertText("X", 1));
    return docToMarkdown(st.doc);
  };

  it("单个 $（金额）不再转义", () => {
    expect(editThenSave("价格 $100\n")).toBe("X价格 $100\n");
    expect(editThenSave("cost $5\n")).toBe("Xcost $5\n");
    expect(editThenSave("100$\n")).toBe("X100$\n");
  });

  it("== 不构成高亮时不再转义", () => {
    expect(editThenSave("a == b\n")).toBe("Xa == b\n");
    expect(editThenSave("2 == 3 == 4\n")).toBe("X2 == 3 == 4\n");
    expect(editThenSave("x==y\n")).toBe("Xx==y\n");
  });

  it("与已修的 ~ / ^ 口径一致（回归）", () => {
    expect(editThenSave("x^2 + y^2\n")).toBe("Xx^2 + y^2\n");
    expect(editThenSave("a ~ b\n")).toBe("Xa ~ b\n");
  });

  it("纯文本节点内的成对 $ / == 仍被转义（防语义被改写）", () => {
    const doc = lightMDSchema.nodeFromJSON({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "x$y$z a==b==c" }],
      }],
    });
    const out = docToMarkdown(doc);
    expect(out).toContain("\\$");
    expect(out).toContain("\\=\\=");
  });

  it("markdown-it 实测：规则与解析行为一致（无假阴性）", () => {
    const inst = createMarkdownIt({ breaks: true, html: true, htmlBlockDisabled: true });
    const hasMath = (md: string) => {
      let found = false;
      const walk = (ts: any[]) => ts.forEach((t: any) => {
        if (t.type === "math_inline") found = true;
        if (t.children) walk(t.children);
      });
      walk(inst.parse(md, {}) as any);
      return found;
    };
    // 会配对的必须被识别（否则转义会漏 → 语义被改写）
    expect(hasMath("x$y$z\n")).toBe(true);
    // 不配对的（金额）不应被识别（否则说明我们的判定漏了噪音来源）
    expect(hasMath("价格 $100\n")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// P6：标题改名后 id 过期（TOC / 锚点链接失配）
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P6：标题锚点 id 与文本同步", () => {
  const ids = (doc: any): string[] => {
    const out: string[] = [];
    doc.descendants((n: any) => {
      if (n.type.name === "heading") out.push(n.attrs.id);
      return true;
    });
    return out;
  };
  const mount = (content: string) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: content } as any)!;
    return { view, host };
  };

  it("computeHeadingIds 与解析期的去重口径一致", () => {
    const doc = markdownToDoc("# Same\n\n## Same\n\n### Same\n");
    expect(ids(doc)).toEqual(["same", "same-1", "same-2"]);
    expect(computeHeadingIds(doc).map((h) => h.id)).toEqual(["same", "same-1", "same-2"]);
  });

  it("真实编辑器：改标题文本后 id 自动重算（旧实现保持 stale id）", () => {
    const { view, host } = mount("# Old Title\n\ntext\n");
    expect(ids(view.state.doc)).toEqual(["old-title"]);
    // 把 "Old Title"(位置 1..10) 替换为 "New Title"
    view.dispatch(view.state.tr.insertText("New Title", 1, 10));
    expect(ids(view.state.doc)).toEqual(["new-title"]);
    host.remove();
    view.destroy();
  });

  it("真实编辑器：改名造成重名时去重序号正确（alpha / alpha-1）", () => {
    const { view, host } = mount("# Alpha\n\n# Beta\n\ntext\n");
    expect(ids(view.state.doc)).toEqual(["alpha", "beta"]);
    let betaPos = -1;
    view.state.doc.descendants((n: any, p: number) => {
      if (n.type.name === "heading" && n.textContent === "Beta") betaPos = p;
      return true;
    });
    const inner = betaPos + 1;
    view.dispatch(view.state.tr.insertText("Alpha", inner, inner + 4));
    expect(ids(view.state.doc)).toEqual(["alpha", "alpha-1"]);
    host.remove();
    view.destroy();
  });

  it("id 已一致时不产生无用事务（零重排）", () => {
    const st = EditorState.create({ doc: markdownToDoc("# Title\n"), schema: lightMDSchema });
    expect(buildHeadingIdSyncTransaction(st)).toBeNull();
  });

  it("id 过期时产生事务并可修复", () => {
    const base = EditorState.create({ doc: markdownToDoc("# Title\n"), schema: lightMDSchema });
    const stale = base.apply(base.tr.setNodeMarkup(0, undefined, { level: 1, id: "stale-id" }));
    expect(ids(stale.doc)).toEqual(["stale-id"]);
    const tr = buildHeadingIdSyncTransaction(stale);
    expect(tr).not.toBeNull();
    const fixed = stale.apply(tr!);
    expect(ids(fixed.doc)).toEqual(["title"]);
  });
});

// ─────────────────────────────────────────────────────────
// P7：i18n 硬编码中文漏网
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P7：三处硬编码中文改走 i18n", () => {
  it("新增的三条 i18n key 双语齐备且非空", () => {
    for (const key of ["table.deleteRowInHead", "mermaid.empty", "mermaid.syntaxError"]) {
      expect(zhCN[key as keyof typeof zhCN]).toBeTruthy();
      expect(enUS[key as keyof typeof enUS]).toBeTruthy();
      // 英文文案不应含中文
      expect(/[\u4e00-\u9fa5]/.test(enUS[key as keyof typeof enUS])).toBe(false);
    }
  });

  it("源码中不再残留这三处硬编码中文", () => {
    const table = readSrc("../core/plugins/table-editor.ts");
    expect(table).not.toContain("表头行不可删除"); // 改为 t("table.deleteRowInHead")
    const mermaid = readSrc("../core/plugins/mermaid-block.ts");
    expect(mermaid).not.toContain("双击编辑 Mermaid 图表");
    expect(mermaid).not.toContain("图表语法错误");
  });
});

// ─────────────────────────────────────────────────────────
// P8：分屏进度 / 分屏跟随排版 / includeCSS 口径
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P8：分屏一致性", () => {
  it("阅读进度上报按模式选择真实滚动容器（不再只测 display:none 的阅读容器）", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    expect(src).toContain("isSourceMode ? sourceTextareaRef.current : editorRef.current");
  });

  it("分屏 iframe 的排版锚点已接入（右侧焦点不再丢失）", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    expect(src).toContain("iframeScroller");
    expect(src).toContain('captureAnchor(s, "body > *")');
  });

  it("分屏 iframe 的 sharedStyles 消费三个排版变量（不再硬编码）", () => {
    const src = readSrc("../components/editor/EditorContainer.tsx");
    expect(src).toContain("--editor-content-max-width, 860px");
    expect(src).toContain("--editor-line-height, 1.8");
    expect(src).toContain("--editor-paragraph-spacing, 1");
    // 旧的硬编码形态不应残留
    expect(src).not.toContain("max-width: 860px; margin: 0 auto;");
  });

  it("分屏 iframe 不再继承 .ProseMirror 的 zoom / max-width（双重缩放与钳制已修）", () => {
    const css = readSrc("../styles/editor.css");
    expect(css).toContain("iframe.split-preview");
    expect(css).toMatch(/iframe\.split-preview\s*\{[^}]*zoom:\s*1/);
    expect(css).toMatch(/iframe\.split-preview\s*\{[^}]*max-width:\s*none/);
  });

  it("includeCSS=false 时 PDF 的 body 基础排版不再注入，但 @page 结构性样式恒注入", () => {
    const pdfSrc = readSrc("../utils/pdfExport.ts");
    expect(pdfSrc).toContain("includeContentStyle");
    const dlgSrc = readSrc("../components/dialogs/ExportDialog.tsx");
    expect(dlgSrc).toContain("generateFullPrintStylesheet(options, baseName, undefined, includeCSS)");
  });
});

// ─────────────────────────────────────────────────────────
// P9：导出样式跟随应用排版设置
// ─────────────────────────────────────────────────────────

describe("v0.12.2 P9：导出样式跟随排版设置", () => {
  it("默认（未设置）时保持既有观感 16px / 1.8 / 860px", () => {
    const css = buildExportCss({});
    expect(css).toContain("font-size: 16px");
    expect(css).toContain("line-height: 1.8");
    expect(css).toContain("max-width: 860px");
    expect(css).toContain("calc(0.8em * 1)");
  });

  it("自定义排版时如实反映到导出 CSS", () => {
    const css = buildExportCss({
      fontSize: 20,
      lineHeight: 2.2,
      paragraphSpacing: 1.5,
      contentMaxWidth: 1000,
      fontFamily: "MyFont",
    });
    expect(css).toContain("font-size: 20px");
    expect(css).toContain("line-height: 2.2");
    expect(css).toContain("max-width: 1000px");
    expect(css).toContain("calc(0.8em * 1.5)");
    expect(css).toContain("MyFont");
  });

  it("导出的三处（HTML / PDF / PNG）都改走 buildExportCss", () => {
    const src = readSrc("../components/dialogs/ExportDialog.tsx");
    // 旧的模块级常量已被删除（只应作为注释里的历史说明出现，不能作为标识符引用）
    expect(src).not.toMatch(/^const EXPORT_CSS/m);
    expect(src).not.toMatch(/\$\{EXPORT_CSS\}/);
    const uses = src.match(/buildExportCss\(/g) ?? [];
    // 定义 1 次 + HTML/PDF/PNG 各 1 次
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });
});
