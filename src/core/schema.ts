import { Schema, type DOMOutputSpec, type NodeSpec, type MarkSpec } from "prosemirror-model";
import type { Node, Mark } from "prosemirror-model";

// ─── 内联标记 ────────────────────────────────────────────

const markSpecs: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b" },
    ],
    toDOM(): DOMOutputSpec {
      return ["strong", 0];
    },
  },

  em: {
    parseDOM: [
      { tag: "em" },
      { tag: "i" },
    ],
    toDOM(): DOMOutputSpec {
      return ["em", 0];
    },
  },

  code: {
    parseDOM: [{ tag: "code" }],
    toDOM(): DOMOutputSpec {
      return ["code", { class: "inline-code" }, 0];
    },
  },

  link: {
    attrs: {
      href: { default: "" },
      title: { default: "" },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return {
            href: el.getAttribute("href") || "",
            title: el.getAttribute("title") || "",
          };
        },
      },
    ],
    toDOM(node: Mark): DOMOutputSpec {
      const { href, title } = node.attrs;
      const attrs: Record<string, string> = { href };
      if (title) attrs.title = title;
      return ["a", attrs, 0];
    },
  },

  strike: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      { tag: "strike" },
    ],
    toDOM(): DOMOutputSpec {
      return ["s", 0];
    },
  },
};

// ─── 块级节点 ────────────────────────────────────────────

const nodeSpecs: Record<string, NodeSpec> = {
  doc: {
    content: "block+",
  },

  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM(): DOMOutputSpec {
      return ["p", 0];
    },
  },

  heading: {
    content: "inline*",
    group: "block",
    attrs: {
      level: { default: 1 },
    },
    defining: true,
    parseDOM: [
      { tag: "h1", attrs: { level: 1 } },
      { tag: "h2", attrs: { level: 2 } },
      { tag: "h3", attrs: { level: 3 } },
      { tag: "h4", attrs: { level: 4 } },
      { tag: "h5", attrs: { level: 5 } },
      { tag: "h6", attrs: { level: 6 } },
    ],
    toDOM(node: Node): DOMOutputSpec {
      return [`h${node.attrs.level}`, 0];
    },
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM(): DOMOutputSpec {
      return ["blockquote", 0];
    },
  },

  code_block: {
    content: "text*",
    group: "block",
    marks: "",
    code: true,
    defining: true,
    attrs: {
      language: { default: "" },
    },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          const code = el.querySelector("code");
          const lang = code?.getAttribute("class")?.replace("language-", "") || "";
          return { language: lang };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const { language } = node.attrs;
      const attrs: Record<string, string> = {};
      if (language) attrs["data-language"] = language;
      const codeAttrs: Record<string, string> = {};
      if (language) codeAttrs.class = `language-${language}`;
      return ["pre", attrs, ["code", codeAttrs, 0]];
    },
  },

  // Mermaid 图表块：编辑态显示源码，预览态渲染为 SVG
  mermaid_block: {
    content: "text*",
    group: "block",
    marks: "",
    code: true,
    defining: true,
    attrs: {
      language: { default: "mermaid" },
    },
    parseDOM: [
      {
        tag: "pre[data-language='mermaid']",
        preserveWhitespace: "full",
        getAttrs() {
          return { language: "mermaid" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      return ["pre", { "data-language": "mermaid" }, ["code", { class: "language-mermaid" }, 0]];
    },
  },

  // 数学公式 - 行内公式 $...$
  math_inline: {
    content: "text*",
    group: "inline",
    inline: true,
    marks: "",
    code: true,
    attrs: {
      latex: { default: "" },
    },
    parseDOM: [
      {
        tag: "span[data-math='inline']",
        preserveWhitespace: "full",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return { latex: el.getAttribute("data-latex") || "" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      return ["span", { "data-math": "inline", "data-latex": node.attrs.latex }, 0];
    },
  },

  // 数学公式 - 块级公式 $$...$$
  math_block: {
    content: "text*",
    group: "block",
    marks: "",
    code: true,
    defining: true,
    attrs: {
      latex: { default: "" },
    },
    parseDOM: [
      {
        tag: "div[data-math='block']",
        preserveWhitespace: "full",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return { latex: el.getAttribute("data-latex") || "" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      return ["div", { "data-math": "block", "data-latex": node.attrs.latex }, 0];
    },
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM(): DOMOutputSpec {
      return ["hr", { class: "hr" }];
    },
  },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM(): DOMOutputSpec {
      return ["br"];
    },
  },

  bullet_list: {
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM(): DOMOutputSpec {
      return ["ul", 0];
    },
  },

  ordered_list: {
    content: "list_item+",
    group: "block",
    attrs: {
      order: { default: 1 },
    },
    parseDOM: [
      {
        tag: "ol",
        getAttrs(dom: string | HTMLElement) {
          return { order: Number((dom as HTMLElement).getAttribute("start")) || 1 };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const attrs: Record<string, string> = {};
      if (node.attrs.order !== 1) attrs.start = String(node.attrs.order);
      return ["ol", attrs, 0];
    },
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM(): DOMOutputSpec {
      return ["li", 0];
    },
  },

  // 任务列表
  task_list: {
    content: "task_item+",
    group: "block",
    parseDOM: [{ tag: "ul.task-list" }],
    toDOM(): DOMOutputSpec {
      return ["ul", { class: "task-list" }, 0];
    },
  },

  task_item: {
    content: "paragraph block*",
    defining: true,
    attrs: {
      checked: { default: false },
    },
    parseDOM: [
      {
        tag: "li.task-item",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return { checked: el.getAttribute("data-checked") === "true" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      return ["li", { class: "task-item", "data-checked": String(node.attrs.checked) }, 0];
    },
  },

  image: {
    inline: true,
    group: "inline",
    draggable: true,
    attrs: {
      src: { default: "" },
      alt: { default: "" },
      title: { default: "" },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || "",
            title: el.getAttribute("title") || "",
          };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const { src, alt, title } = node.attrs;
      return ["img", { src, alt, title }];
    },
  },

  // ─── 表格节点 ──────────────────────────────

  table: {
    content: "table_head? table_body",
    group: "block",
    isolating: true,
    parseDOM: [{ tag: "table" }],
    toDOM(): DOMOutputSpec {
      return ["table", { class: "pm-table" }, 0];
    },
  },

  table_head: {
    content: "table_row",
    parseDOM: [{ tag: "thead" }],
    toDOM(): DOMOutputSpec {
      return ["thead", 0];
    },
  },

  table_body: {
    content: "table_row+",
    parseDOM: [{ tag: "tbody" }],
    toDOM(): DOMOutputSpec {
      return ["tbody", 0];
    },
  },

  table_row: {
    content: "(table_cell | table_header)*",
    parseDOM: [{ tag: "tr" }],
    toDOM(): DOMOutputSpec {
      return ["tr", 0];
    },
  },

  table_cell: {
    content: "inline*",
    attrs: {
      align: { default: "left" },
    },
    parseDOM: [
      {
        tag: "td",
        getAttrs(dom: string | HTMLElement) {
          return { align: (dom as HTMLElement).style.textAlign || "left" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const style = node.attrs.align !== "left" ? `text-align:${node.attrs.align}` : "";
      return ["td", style ? { style } : {}, 0];
    },
  },

  table_header: {
    content: "inline*",
    attrs: {
      align: { default: "left" },
    },
    parseDOM: [
      {
        tag: "th",
        getAttrs(dom: string | HTMLElement) {
          return { align: (dom as HTMLElement).style.textAlign || "left" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const style = node.attrs.align !== "left" ? `text-align:${node.attrs.align}` : "";
      return ["th", style ? { style } : {}, 0];
    },
  },

  text: {
    group: "inline",
  },
};

export const lightMDSchema = new Schema({
  nodes: nodeSpecs,
  marks: markSpecs,
});
