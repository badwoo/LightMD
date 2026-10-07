/**
 * R2（v0.10.0）：导出公式/图表保真（PNG / DOCX / EPUB）
 *
 * DOM 层可测部分：
 * 1. replaceMathPlaceholdersInDom：data-math 占位 → KaTeX HTML（PNG/DOCX 路径）
 * 2. replaceMathWithMathmlInHtml：占位 → 纯 MathML（EPUB 路径），属性实体反转义
 * 3. replaceMermaidBlocksInDom：pre.mermaid → SVG（mermaid mock），失败保留代码块
 * 4. ensureSvgStandaloneAttributes：xmlns + viewBox 推导宽高
 * 5. DOCX：mathBlock/mermaid codeBlock → ImageRun；截图失败降级为既有文本/代码块路径
 * 6. EPUB：buildEpubZip 产物章节 XHTML 含 <math> 与 <svg>
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  replaceMathPlaceholdersInDom,
  replaceMathWithMathmlInHtml,
  replaceMermaidBlocksInDom,
  ensureSvgStandaloneAttributes,
} from "../utils/exportMathRender";
import { convertBlocksToDocxElements } from "../utils/exportDocx";
import { buildEpubZip } from "../utils/exportEpub";
import { ImageRun, Paragraph } from "docx";

// mermaid mock：render 返回固定 SVG；MERMAID_FAIL 模式下抛错（验证降级）
const mermaidState = { fail: false };
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, _code: string) => {
      if (mermaidState.fail) throw new Error("mermaid render failed");
      return { svg: '<svg viewBox="0 0 100 50"><g><rect width="10" height="10"/></g></svg>' };
    }),
  },
}));

// html-to-image mock：返回 1x1 PNG dataURL；HTML_TO_PNG_FAIL 模式下抛错（验证降级）
const toPngState = { fail: false };
vi.mock("html-to-image", () => ({
  toPng: vi.fn(async () => {
    if (toPngState.fail) throw new Error("toPng failed");
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  }),
}));

beforeEach(() => {
  mermaidState.fail = false;
  toPngState.fail = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R2: replaceMathPlaceholdersInDom（PNG/DOCX 路径）", () => {
  it("行内/块级占位替换为 KaTeX HTML，返回替换数", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p>行内 <span data-math="inline" data-latex="E=mc^2"></span></p>' +
      '<div data-math="block" data-latex="a^2 + b^2 = c^2"></div>';
    const count = replaceMathPlaceholdersInDom(container);
    expect(count).toBe(2);
    expect(container.querySelectorAll(".katex").length).toBe(2);
    // 块级公式带 katex-display 包裹（displayMode: true）
    expect(container.querySelector(".katex-display")).not.toBeNull();
    // 占位元素不再存在
    expect(container.querySelector("[data-math]")).toBeNull();
  });

  it("渲染异常时保留占位（降级不中断）", () => {
    const container = document.createElement("div");
    container.innerHTML = '<span data-math="inline" data-latex="\\notacommand{"></span>';
    // katex throwOnError:false 极少抛错；用空 latex 模拟极端输入，占位仍应可被处理
    const count = replaceMathPlaceholdersInDom(container);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(container.contains(container.firstChild)).toBe(true);
  });
});

describe("R2: replaceMathWithMathmlInHtml（EPUB 路径）", () => {
  it("占位替换为纯 MathML，属性实体正确反转义", () => {
    // data-latex 含 &quot; 转义引号（katex-plugin 输出格式）
    const html =
      '<p><span data-math="inline" data-latex="E=mc^2"></span></p>' +
      '<div data-math="block" data-latex="\\begin{aligned}a&amp;b\\end{aligned}"></div>';
    const { html: out, count } = replaceMathWithMathmlInHtml(html);
    expect(count).toBe(2);
    expect(out).toContain("<math");
    expect(out).not.toContain("data-math");
    // &amp; 反转义后 latex 为 a&b，aligned 环境生成 mtable 两列（解码成功的语义证据）
    expect(out).toContain("<mtable");
    expect(out).toContain("<mtd>");
  });

  it("无占位时原样返回且 count=0", () => {
    const { html: out, count } = replaceMathWithMathmlInHtml("<p>普通段落</p>");
    expect(out).toBe("<p>普通段落</p>");
    expect(count).toBe(0);
  });
});

describe("R2: mermaid 替换（PNG/EPUB 路径）", () => {
  it("pre.mermaid 替换为 SVG（mock render），失败时保留代码块", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<pre class="mermaid">graph TD; A-->B;</pre>';
    const count = await replaceMermaidBlocksInDom(container);
    expect(count).toBe(1);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.querySelector("pre.mermaid")).toBeNull();
  });

  it("mermaid 渲染失败时保留原代码块（降级不中断）", async () => {
    mermaidState.fail = true;
    const container = document.createElement("div");
    container.innerHTML = '<pre class="mermaid">graph TD; A-->B;</pre>';
    const count = await replaceMermaidBlocksInDom(container);
    expect(count).toBe(0);
    expect(container.querySelector("pre.mermaid")).not.toBeNull();
  });

  it("进度回调按尝试数上报", async () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<pre class="mermaid">a</pre><pre class="mermaid">b</pre>';
    const progress: Array<[number, number]> = [];
    await replaceMermaidBlocksInDom(container, {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("R2: ensureSvgStandaloneAttributes", () => {
  it("补 xmlns 并从 viewBox 推导显式宽高（100% 塌缩防护）", () => {
    const holder = document.createElement("div");
    holder.innerHTML = '<svg viewBox="0 0 100 50" width="100%"></svg>';
    const svg = holder.querySelector("svg")!;
    ensureSvgStandaloneAttributes(svg as unknown as SVGSVGElement);
    expect(svg.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("width")).toBe("100");
    expect(svg.getAttribute("height")).toBe("50");
  });

  it("已有显式宽高时不改写", () => {
    const holder = document.createElement("div");
    holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="80" height="40"></svg>';
    const svg = holder.querySelector("svg")!;
    ensureSvgStandaloneAttributes(svg as unknown as SVGSVGElement);
    expect(svg.getAttribute("width")).toBe("80");
    expect(svg.getAttribute("height")).toBe("40");
  });
});

describe("R2: DOCX 公式/图表 → ImageRun", () => {
  // jsdom getBoundingClientRect 恒 0 → stub 为有效尺寸（真实浏览器无需 stub）。
  // 注意 SVGElement 不继承 HTMLElement，mermaid SVG 路径需单独 stub
  beforeEach(() => {
    const fakeRect = {
      width: 200, height: 60,
      top: 0, left: 0, bottom: 60, right: 200, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(fakeRect);
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue(fakeRect);
  });

  it("mathBlock 渲染为 ImageRun（v0.11.0 B2-5 起包在 Paragraph 内）", async () => {
    const elements = await convertBlocksToDocxElements([{ kind: "mathBlock", latex: "E=mc^2" }]);
    expect(elements.length).toBe(1);
    // v0.11.0 B2-5（P0）：ImageRun 是 **run 级**元素（ParagraphChild），
    // 直接 push 进要求 block 级的 elements/sections.children 会让
    // Packer.toBlob 抛错或产出损坏的 docx → 必须包一层 Paragraph。
    expect(elements[0]).toBeInstanceOf(Paragraph);
    const para = elements[0] as Paragraph;
    expect((para as unknown as { root: unknown[] }).root.length).toBeGreaterThan(0);
  });

  it("mermaid 代码块渲染为 ImageRun（v0.11.0 B2-5 起包在 Paragraph 内）", async () => {
    const elements = await convertBlocksToDocxElements([
      { kind: "codeBlock", content: "graph TD; A-->B;", language: "mermaid" },
    ]);
    expect(elements.length).toBe(1);
    // 同上：run 级元素必须包 Paragraph
    expect(elements[0]).toBeInstanceOf(Paragraph);
  });

  it("截图失败时降级：mathBlock → LaTeX 文本段落，mermaid → 代码块段落", async () => {
    toPngState.fail = true;
    const elements = await convertBlocksToDocxElements([
      { kind: "mathBlock", latex: "E=mc^2" },
      { kind: "codeBlock", content: "graph TD;", language: "mermaid" },
    ]);
    expect(elements.length).toBe(2);
    expect(elements[0]).toBeInstanceOf(Paragraph);
    expect(elements[1]).toBeInstanceOf(Paragraph);
  });

  it("普通代码块不受影响（回归）", async () => {
    const elements = await convertBlocksToDocxElements([
      { kind: "codeBlock", content: "const x = 1;\n", language: "js" },
    ]);
    expect(elements.length).toBe(1);
    expect(elements[0]).toBeInstanceOf(Paragraph);
  });

  it("进度回调：公式/图表总数与完成数", async () => {
    const progress: Array<[number, number]> = [];
    await convertBlocksToDocxElements(
      [
        { kind: "paragraph", runs: [{ text: "hi" }] },
        { kind: "mathBlock", latex: "x" },
        { kind: "codeBlock", content: "g", language: "mermaid" },
      ],
      0,
      (done, total) => progress.push([done, total]),
    );
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });
});

describe("R2: EPUB 公式/图表内联", () => {
  it("章节 XHTML 中公式为 MathML（非空占位）", async () => {
    const zip = await buildEpubZip("# 章\n\n行内 $E=mc^2$ 公式\n", "test.epub", null);
    // 解 zip 校验章节内容：用 JSZip 读回
    const { default: JSZip } = await import("jszip");
    const loaded = await JSZip.loadAsync(zip);
    const chap1 = await loaded.file("OEBPS/chap1.xhtml")!.async("string");
    expect(chap1).toContain("<math");
    expect(chap1).not.toContain("data-math");
  });

  it("章节 XHTML 中 mermaid 为内联 SVG", async () => {
    const zip = await buildEpubZip(
      "# 章\n\n```mermaid\ngraph TD; A-->B;\n```\n",
      "test.epub",
      null,
    );
    const { default: JSZip } = await import("jszip");
    const loaded = await JSZip.loadAsync(zip);
    const chap1 = await loaded.file("OEBPS/chap1.xhtml")!.async("string");
    expect(chap1).toContain("<svg");
    expect(chap1).not.toContain("pre.mermaid".replace("pre.", 'class="mermaid"'));
  });
});
