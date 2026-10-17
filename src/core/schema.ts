import { Schema, type DOMOutputSpec, type NodeSpec, type MarkSpec } from "prosemirror-model";
import type { Node, Mark } from "prosemirror-model";
import { resolveImageSrc } from "../utils/imagePath";

// ─── v0.13.0 需求12：表格 colspan/rowspan 属性解析 ──────────────────

/**
 * 解析 DOM 的 colspan/rowspan 属性为整数（下限 1）。
 *
 * 为什么单独抽函数而不是内联在 getAttrs 里：
 * - `td` 与 `th` 两份 parseDOM 需要**同源**判定（漏一份会导致粘贴的表格
 *   表头/表体跨度不一致）；
 * - 非法值（"abc" / "0" / "-1" / ""）必须回落 1，否则 schema 校验会拒绝
 *   整个表格节点（实测 `<td colspan="0">` 会让 PM 抛 "Invalid content"）。
 */
function parseSpanAttr(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

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

  // 下划线标记，对应 HTML <u> 标签（E8,v0.9.3）。
  // Markdown 无原生下划线语法，序列化统一为 <u> 包裹（见 serializer.applyMark）
  underline: {
    parseDOM: [{ tag: "u" }],
    toDOM(): DOMOutputSpec {
      return ["u", 0];
    },
  },

  // 高亮标记 ==text==，对应 HTML <mark> 标签
  mark: {
    parseDOM: [{ tag: "mark" }],
    toDOM(): DOMOutputSpec {
      return ["mark", 0];
    },
  },

  // 下标 ~sub~，对应 HTML <sub> 标签
  subscript: {
    parseDOM: [{ tag: "sub" }],
    toDOM(): DOMOutputSpec {
      return ["sub", 0];
    },
  },

  // 上标 ^sup^，对应 HTML <sup> 标签
  superscript: {
    parseDOM: [{ tag: "sup" }],
    toDOM(): DOMOutputSpec {
      return ["sup", 0];
    },
  },

  // v0.13.0 需求6：注释标记 <!--text-->。
  //
  // 为什么用 mark 而不是「源码侧插前缀」：三模式必须行为一致——
  // 只在源码模式做行首/行尾插 `<!-- `/` -->` 的话，阅读模式做不到同样的事
  // （那里的选区是 PM 选区，不是文本行）。用 mark 后两模式都能表达。
  //
  // toDOM 用 <span data-comment> 而非 <span style>：CSS 统一置灰，
  // 且导出层可按标签名过滤（见 utils/exportBlocks 与 renderPipeline）。
  comment: {
    parseDOM: [{ tag: "span[data-comment]" }],
    toDOM(): DOMOutputSpec {
      return ["span", { "data-comment": "" }, 0];
    },
  },
};

// ─── TOC 辅助函数 ────────────────────────────────────────────

/** TOC 标题项（与 heading-anchor.ts 的 TocHeading 保持结构一致） */
interface TocHeadingItem {
  level: number;
  text: string;
  id: string;
}

/** 安全解析 headings JSON 字符串，失败时返回空数组 */
function safeParseHeadings(json: string): TocHeadingItem[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (h): h is TocHeadingItem =>
        h && typeof h.level === "number" && typeof h.text === "string" && typeof h.id === "string"
    );
  } catch {
    return [];
  }
}

/**
 * 根据标题列表构造嵌套的 <ul><li><a>...</a></li></ul> DOMOutputSpec
 *
 * 算法：
 * 1. 先将扁平的标题列表构建为树（基于 level 层级）
 * 2. 递归遍历树构造嵌套的 DOMOutputSpec
 *
 * 跳级（h1 后直接 h3）会把 h3 作为 h1 的直接子节点（单层嵌套），
 * 与 toc-plugin.ts 的 renderToc 行为略有差异但更简洁，阅读体验更优。
 */
function buildTocListSpec(headings: TocHeadingItem[]): DOMOutputSpec {
  if (headings.length === 0) return ["ul", {}];

  interface TreeNode {
    heading: TocHeadingItem;
    children: TreeNode[];
  }

  // 构建标题树
  const root: TreeNode = { heading: null as unknown as TocHeadingItem, children: [] };
  const stack: TreeNode[] = [root];

  for (const h of headings) {
    const node: TreeNode = { heading: h, children: [] };
    // 弹出栈直到找到 level 严格小于当前的节点作为父节点
    while (stack.length > 1 && stack[stack.length - 1].heading.level >= h.level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  // 递归构造 DOMOutputSpec
  function buildList(nodes: TreeNode[]): DOMOutputSpec {
    const items: DOMOutputSpec[] = nodes.map((n) => {
      const liChildren: DOMOutputSpec[] = [
        ["a", { href: `#${n.heading.id}` }, n.heading.text],
      ];
      if (n.children.length > 0) {
        liChildren.push(buildList(n.children));
      }
      return ["li", {}, ...liChildren];
    });
    return ["ul", {}, ...items];
  }

  return buildList(root.children);
}

// ─── 块级节点 ────────────────────────────────────────────

const nodeSpecs: Record<string, NodeSpec> = {
  doc: {
    content: "block+",
  },

  paragraph: {
    content: "inline*",
    group: "block",
    attrs: {
      /**
       * v0.13.2 需求9：**结构补位标记**（不写进 Markdown）。
       *
       * `trailingParagraphPlugin` 在文档以表格/代码块/图表/公式结尾时补一个空段落，
       * 让"块之后的空白处"有可放光标的位置（否则用户点空白处没有插入符）。
       * 该段落是编辑器为了让块后可达而加的结构，不是用户内容：
       * - `docToMarkdown` 见到 `pad: true` 的段落直接跳过（不写进文件）；
       * - 用户一旦在里面打字，`appendTransaction` 会把标记清掉
       *   （见插件的 `stripPadFlagPlugin` 逻辑），此后它就是普通段落。
       *
       * 为什么不用"丢弃末尾空段落"：末尾空段落也可能是用户显式输入的
       * （`v0.7.0-fix2-trailing-newline` 锁定了该往返行为），不能一刀切。
       */
      pad: { default: false },
    },
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
      // v0.11.0 B4-5：标题锚点 id。
      //
      // 缺陷背景（P1）：锚点此前只存在于 markdown-it 的**渲染输出**
      // （heading-anchor 插件写 token.attrs），而阅读模式走 PM 的 toDOM
      // → 渲染出的 <h1>~<h3> **没有 id 属性** → 文内 `[链接](#标题)`
      // 在阅读模式点不动；文档内锚点跳转只在 markdown-it 路径（分屏/导出）有效。
      //
      // 修复：把 id 提升为节点 attr，三处口径统一 —— parser 从 token.attrs
      // 读入写入节点、toDOM 输出、serializer 忽略（不写回 Markdown 源码，
      // 因为 `## 标题` 的标准语法不带 id，自定义 id 属扩展）。
      //
      // 默认空串：旧文档/无标题文本时为空，toDOM 据此不输出 id 属性。
      id: { default: "" },
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
      // id 为空时不输出该属性（保持与旧渲染结果一致）
      const id = String(node.attrs.id || "");
      if (id) return [`h${node.attrs.level}`, { id }, 0];
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
      // v0.9.0 D11：保留 fence 完整信息串（如 "js {highlight}"），language 仍取首词
      info: { default: "" },
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
      // v0.9.0 D11：同 code_block，保留完整 fence info
      info: { default: "" },
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

  // 脚注引用 [^id]，inline 不可编辑节点，渲染为上标链接 [id] → 跳转到脚注定义
  footnote_ref: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: {
      label: { default: "" },
    },
    parseDOM: [
      {
        tag: "sup[data-footnote-ref]",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return { label: el.getAttribute("data-label") || "" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const label = node.attrs.label;
      return ["sup", { class: "footnote-ref", "data-footnote-ref": "", "data-label": label },
        ["a", { href: `#fn${label}` }, `[${label}]`]];
    },
  },

  // 脚注定义 [^id]: content，block 节点，id="fn{id}" 供脚注引用链接跳转
  // E15：内容模型 inline* → block+，脚注内多段落/块级内容不再压平为单行
  footnote_definition: {
    content: "block+",
    group: "block",
    defining: true,
    attrs: {
      label: { default: "" },
    },
    parseDOM: [
      {
        tag: "div[data-footnote-def]",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return { label: el.getAttribute("data-label") || "" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const label = node.attrs.label;
      return ["div", { class: "footnote-def", "data-footnote-def": "", "data-label": label, id: `fn${label}` }, 0];
    },
  },

  // 目录节点 [toc]：atom 节点，attrs.headings 存储标题列表 JSON，toDOM 渲染嵌套导航列表
  toc: {
    group: "block",
    atom: true,
    isolating: true,
    attrs: {
      headings: { default: "[]" },
    },
    parseDOM: [
      {
        tag: "nav[data-toc]",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return { headings: el.getAttribute("data-headings") || "[]" };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const headings = safeParseHeadings(node.attrs.headings);
      return ["nav", { class: "toc", "data-toc": "", "data-headings": node.attrs.headings }, buildTocListSpec(headings)];
    },
  },

  // 定义列表容器
  definition_list: {
    content: "(definition_term | definition_description)+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "dl" }],
    toDOM(): DOMOutputSpec {
      return ["dl", 0];
    },
  },

  // 定义列表项 - 术语
  definition_term: {
    content: "inline*",
    defining: true,
    parseDOM: [{ tag: "dt" }],
    toDOM(): DOMOutputSpec {
      return ["dt", 0];
    },
  },

  // 定义列表项 - 描述
  definition_description: {
    content: "inline*",
    defining: true,
    parseDOM: [{ tag: "dd" }],
    toDOM(): DOMOutputSpec {
      return ["dd", 0];
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
      // v0.11.0 B3-6：原始分隔符（来自 markdown-it token.markup）。
      // 缺陷背景（P1·不对称）：解析端支持 `1)` 语法，但 inputrules 只接受 `1.`
      // → 能打开、不能输入；且 serializer 固定用 `1.` → 编辑后 `)` 被改写丢失。
      // 记录原始分隔符，使序列化能还原原文/用户写法。
      // 默认 "." 保持既有文档兼容（旧节点无该 attr 时回退）。
      delim: { default: "." },
    },
    parseDOM: [
      {
        tag: "ol",
        getAttrs(dom: string | HTMLElement) {
          return {
            order: Number((dom as HTMLElement).getAttribute("start")) || 1,
            // DOM 本身不携带分隔符信息，只能回退默认
            delim: ".",
          };
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
      // v0.12.1 需求5：复选框样式（square 方形 = 源码 `- [ ]`；circle 圆形 = 源码 `* [ ]`）
      style: { default: "square" },
    },
    parseDOM: [
      {
        tag: "li.task-item",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          return {
            checked: el.getAttribute("data-checked") === "true",
            // 富文本粘贴 / HTML 往返：优先读 data-style，退化用 class 判定
            style:
              el.getAttribute("data-style") === "circle" ||
              el.classList.contains("task-item-circle")
                ? "circle"
                : "square",
          };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const style = node.attrs.style === "circle" ? "circle" : "square";
      return [
        "li",
        {
          class: style === "circle" ? "task-item task-item-circle" : "task-item",
          "data-checked": String(node.attrs.checked),
          "data-style": style,
        },
        0,
      ];
    },
  },

  image: {
    inline: true,
    group: "inline",
    draggable: true,    attrs: {
      src: { default: "" },
      alt: { default: "" },
      title: { default: "" },
      // E11a(v0.9.3):显示宽度(px),markdown 语法 ![alt|300](src);null=未指定
      width: { default: null },
      // v0.13.0 需求4：水平对齐（left/center/right）。
      // **不跨编辑器保真**——Markdown 无标准图片对齐语法，序列化为
      // `<img style>` 形态（见 serializer 的 image 分支）。
      align: { default: "left" },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs(dom: string | HTMLElement) {
          const el = dom as HTMLElement;
          // E11a:富文本粘贴的 <img style="width:120px"> / <img width> 还原为 width 属性
          const styleWidth = el.style?.width ? Number.parseFloat(el.style.width) : NaN;
          const attrWidth = el.getAttribute("width");
          const raw =
            Number.isFinite(styleWidth) ? styleWidth : attrWidth ? Number.parseFloat(attrWidth) : NaN;
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || "",
            title: el.getAttribute("title") || "",
            width: Number.isFinite(raw) ? Math.round(raw) : null,
            // v0.13.0 需求4：从 style 还原对齐（margin auto 形态）
            align: parseImageAlign(el),
          };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const { src, alt, title, width, align } = node.attrs;
      // 将相对路径转换为 Tauri webview 可访问的 asset:// URL
      // data-editable="true" 标记图片为可编辑，供阅读模式注入点击监听（G3）
      // v0.8.3 WP5 需求7：loading="lazy" + decoding="async"——大图同步解码会阻塞
      // 合成帧（滚动掉帧的常见来源），懒加载让视口外图片完全不参与解码。
      const attrs: Record<string, string> = {
        src: resolveImageSrc(src),
        alt,
        title,
        "data-editable": "true",
        loading: "lazy",
        decoding: "async",
      };
      // E11a:宽度在编辑器显示层即时生效;markdown 表达见 serializer 的 |W 后缀
      if (typeof width === "number" && width > 0) attrs.style = `width:${width}px`;
      // v0.13.0 需求4：非左对齐时用 margin auto 把图片推到中间/右侧。
      // 图片是 inline 节点，需要 display:block 才能让 margin auto 生效。
      const alignStyle = imageAlignCss(align);
      if (alignStyle) {
        attrs.style = attrs.style ? `${attrs.style};${alignStyle}` : alignStyle;
      }
      if (align && align !== "left") attrs["data-align"] = align;
      return ["img", attrs];
    },
  },

  // ─── 表格节点 ──────────────────────────────

  table: {
    content: "table_head? table_body",
    group: "block",
    isolating: true,
    attrs: {
      // columnWidths 存储每列像素宽度，null 表示等宽（默认）
      // 仅在编辑器内生效，不影响 markdown 输出
      columnWidths: { default: null },
      // rowHeights 存储每行像素高度，null 表示自动高度（默认）
      rowHeights: { default: null },
    },
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
    /**
     * v0.13.1 需求3：**行级隔离**，作为"退格不得跨格"的**第二道**防线。
     *
     * 主防线是 `core/keymap.ts` 的显式守卫（Backspace / Mod-Backspace /
     * Delete / Mod-Delete 在单元格**内容边界**上直接吞键）。本标记只是补充。
     *
     * ⚠️ 实测（`v0131-table-cell-editing.test.ts`）：`isolating` 有**位置覆盖盲区**——
     * 它挡得住"有内容的格首退格"（`| 1 | 2 |` 里在 "2" 格首按退格 → 结构不动），
     * 却挡不住"前邻是空格"的格首（`|  | 2 |` 里把光标放到 "2" 格首按退格，
     * 未加固 schema 上 4 格变 3 格、右格内容左移；加本标记后该路径**仍会合并**）。
     * 因此**不要**把它当成完整保证 —— 完整保证来自 keymap 守卫，那条守卫只看
     * "光标是否贴在格的內容边界"，与前后邻格是什么无关，故没有盲区。
     *
     * 为什么不给 table_cell / table_header 加：`isolating` 也会让
     * `liftTarget` / `canSplit` / `deleteRange` 在**格内**放弃跨格能力，
     * 而单元格内容模型是 `inline*`（本身已是文本块层级），加在格上会连
     * "格内正常编辑回流"一起限制；落在行上语义更贴切 —— 行之间本就不该连通。
     *
     * table 节点原本已有 `isolating: true`，但 `deleteBarrier` 只看**直接相邻**
     * 的两个节点，不会回溯到更外层的 table，故在这一层补上仍有价值。
     */
    isolating: true,
    parseDOM: [{ tag: "tr" }],
    toDOM(): DOMOutputSpec {
      return ["tr", 0];
    },
  },

  table_cell: {
    content: "inline*",
    attrs: {
      align: { default: "left" },
      // v0.13.0 需求12：合并单元格（横向）。1=普通格。
      // 序列化走 `<td colspan="N">`（声明不跨编辑器保真）。
      colspan: { default: 1 },
      // v0.13.0 需求12：合并单元格（纵向）。1=普通格。
      rowspan: { default: 1 },
    },
    parseDOM: [
      {
        tag: "td",
        getAttrs(dom: string | HTMLElement) {
          return {
            align: (dom as HTMLElement).style.textAlign || "left",
            colspan: parseSpanAttr((dom as HTMLElement).getAttribute("colspan")),
            rowspan: parseSpanAttr((dom as HTMLElement).getAttribute("rowspan")),
          };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const attrs: Record<string, string | number> = {};
      if (node.attrs.align !== "left") attrs.style = `text-align:${node.attrs.align}`;
      // v0.13.0 需求12：只在 >1 时输出属性——未合并的表格 DOM 与旧版完全一致
      // （HTML 粘贴/既有测试的 DOM 快照零变化）
      const cs = Number(node.attrs.colspan) || 1;
      if (cs > 1) attrs.colspan = cs;
      const rs = Number(node.attrs.rowspan) || 1;
      if (rs > 1) attrs.rowspan = rs;
      return ["td", attrs, 0];
    },
  },

  table_header: {
    content: "inline*",
    attrs: {
      align: { default: "left" },
      colspan: { default: 1 },
      rowspan: { default: 1 },
    },
    parseDOM: [
      {
        tag: "th",
        getAttrs(dom: string | HTMLElement) {
          return {
            align: (dom as HTMLElement).style.textAlign || "left",
            colspan: parseSpanAttr((dom as HTMLElement).getAttribute("colspan")),
            rowspan: parseSpanAttr((dom as HTMLElement).getAttribute("rowspan")),
          };
        },
      },
    ],
    toDOM(node: Node): DOMOutputSpec {
      const attrs: Record<string, string | number> = {};
      if (node.attrs.align !== "left") attrs.style = `text-align:${node.attrs.align}`;
      const cs = Number(node.attrs.colspan) || 1;
      if (cs > 1) attrs.colspan = cs;
      const rs = Number(node.attrs.rowspan) || 1;
      if (rs > 1) attrs.rowspan = rs;
      return ["th", attrs, 0];
    },
  },

  text: {
    group: "inline",
  },
};

// ─── v0.13.0 需求4：图片对齐工具 ────────────────────────────────

/** 图片对齐取值（与 schema image.attrs.align 一致） */
export type ImageAlign = "left" | "center" | "right";

/** 合法对齐值集合（解析/写回时校验用） */
export const IMAGE_ALIGN_VALUES: readonly ImageAlign[] = ["left", "center", "right"];

/** 归一化任意输入为合法对齐值（非法值回落 left） */
export function normalizeImageAlign(v: unknown): ImageAlign {
  return v === "center" || v === "right" ? v : "left";
}

/**
 * 对齐 → CSS 片段（空串 = 左对齐，不加样式）。
 *
 * 图片是 **inline** 节点，`margin:auto` 只在 `display:block` 时生效，
 * 因此三个值都要带上 display。左对齐不加样式——正文默认流式布局即左对齐，
 * 这样未设对齐的文档零 diff（B6 原文快路径与 roundtrip 都不受影响）。
 */
export function imageAlignCss(align: unknown): string {
  const a = normalizeImageAlign(align);
  if (a === "left") return "";
  if (a === "center") return "display:block;margin-left:auto;margin-right:auto";
  return "display:block;margin-left:auto";
}

/**
 * 从 DOM 元素还原对齐值（parseDOM 的 getAttrs 用）。
 *
 * 同时认三种形态，保证从本应用自己的序列化结果 / 富文本粘贴 / 手写 HTML
 * 都能还原：`data-align` 属性、style 里的 margin auto、style 里的 float。
 */
export function parseImageAlign(el: HTMLElement): ImageAlign {
  const attr = el.getAttribute("data-align");
  if (attr === "center" || attr === "right") return attr;
  const style = el.style;
  if (!style) return "left";
  const ml = style.marginLeft;
  const mr = style.marginRight;
  // 左右都 auto = 居中；仅左侧 auto = 右对齐（把元素推到右边）
  if (ml === "auto" && mr === "auto") return "center";
  if (ml === "auto") return "right";
  return "left";
}

export const lightMDSchema = new Schema({
  nodes: nodeSpecs,
  marks: markSpecs,
});
