/**
 * R1（v0.10.0）：统一渲染管线
 *
 * 背景（0.9.1 测评 R1）：同一文档存在三套 markdown-it 配置源——
 * 分屏预览（parser.ts 工厂实例）、导出 HTML/PDF/PNG（ExportDialog 独立实例）、
 * DOCX/LaTeX（exportBlocks 独立实例）。核验发现两处漂移：
 * ① 导出 typographer:true vs 编辑器 false → 弯引号不一致（所见非所得）；
 * ② 导出 validateLink 关闭 → `javascript:` 等危险 scheme URL 可进入导出 HTML（安全洞）。
 *
 * 统一决策（本文件为单一事实来源）：
 * - typographer 恒 false：导出与编辑所见即所得一致，导出不静默改写用户引号；
 * - validateLink 白名单全管线强制：sanitizeLinkHref 拒绝 javascript:/vbscript:/file:，
 *   放行 data:image（v0.9.5 起），base64 图片导出不受影响，无需再传 validateLink:false；
 * - HTML 白名单（E8）：编辑/分屏/导出 HTML·PDF·PNG 共用 html:true + htmlBlockDisabled
 *   （html_block 禁用、行内仅 <u>/<br>/<sub>/<sup>/<mark> 放行）；
 *   DOCX/LaTeX 例外维持 html:false——其 Block[] 中间结构无法承载 html token，
 *   开启会走 default 分支丢内容（E14 factory jsdoc 已述）。
 *
 * 调用方（新增语法只改此处 + parser.ts 工厂一处配置）：
 * - 分屏预览：EditorContainer.renderMarkdownToHtml → renderMarkdownHtml
 * - 导出 HTML/PDF/PNG：ExportDialog.renderMarkdownToHTML → renderMarkdownHtml
 * - DOCX/LaTeX：exportBlocks.createDefaultMarkdownIt → getDocxLatexMarkdownIt
 */
import type MarkdownIt from "markdown-it";
import { createMarkdownIt } from "./markdown/parser";
import { imageAlignCss } from "./schema";
import { useSettingsStore } from "../stores/useSettingsStore";
import { highlightCodeBlocksInHtml } from "../utils/highlight";

/**
 * v0.11.0 B1-3：图片 Typora 尺寸后缀 `![alt|300](src)` 的渲染层支持。
 *
 * 缺陷背景（P0）：`parser.ts` 的 **PM 解析层**支持 `![alt|300](src)`（v0.9.3 E11a，
 * 解析出 alt="alt" + width=300），但渲染管线（分屏预览 / HTML / PDF / PNG 导出）
 * 走 markdown-it，**markdown-it 原生不认识 `|W` 后缀** →
 * 实测输出 `<img src="a.png" alt="alt|300" />`：宽度丢失且 alt 被污染。
 *
 * 修复方式（**必须在 renderer 层做，而非 core rule**）：
 *   markdown-it 的 default_rules.image（renderer.mjs:77）在渲染时执行
 *   `token.attrs[attrIndex('alt')][1] = renderInlineAsText(token.children)`，
 *   即**用 children 重新计算 alt 并覆盖 attrs**。因此若只在 core rule 里改 attrs，
 *   会被这一步还原（这正是首版实现无效的原因）。
 *   故本插件做两件事：
 *   ① core rule：把 children[0].content 的尾部 `|数字` 拆掉（renderer 的数据源）；
 *   ② 包裹 renderer rule：在默认渲染结果上追加 width 属性。
 *
 * 判定规则与 PM 解析层严格一致（`/^(.*)\|(\d+)$/`），确保两种渲染路径同源：
 * 只有**以 `|数字` 结尾**才拆分，故 `![a|b](x.png)` 这类含竖线但非尺寸的 alt 不受影响。
 *
 * 作用域：只挂在渲染实例（分屏 + HTML/PDF/PNG 导出）；DOCX/LaTeX 走 exportBlocks
 * 的 Block[] 中间结构，不经过此路径。
 */
/**
 * 找出字符串中**最后一个未被反斜杠转义**的 `|` 下标（没有则 -1）。
 *
 * 为什么需要：序列化会把 alt 里的字面竖线写成 `\|`（见 serializer 的 image 分支），
 * 只有**未转义**的竖线才是宽度/对齐后缀的分隔符。若直接对内容做贪婪正则
 * （如 `^(.*)\|(center|right)$`），alt 结尾正好是 `\|center` 时会被误判成对齐后缀。
 */
function lastUnescapedPipe(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== "|") continue;
    let bs = 0;
    for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) bs++;
    if (bs % 2 === 0) return i;
  }
  return -1;
}

/**
 * v0.13.0 需求4 + 返修：拆出图片的 `|宽度` / `|对齐` 后缀。
 *
 * 后缀顺序与序列化一致：`![alt|300|center](src)` / `![alt|center](src)` /
 * `![alt|300](src)`。从尾部依次剥离「对齐」再「宽度」，且只认**合法值**——
 * 这样 alt 自身含竖线（`a|b`）不会被误当后缀。
 */
function splitImageSuffix(content: string): { alt: string; width?: string; align?: string } {
  let rest = content;
  let align: string | undefined;
  let width: string | undefined;
  let p = lastUnescapedPipe(rest);
  if (p >= 0) {
    const tail = rest.slice(p + 1).trim().toLowerCase();
    if (tail === "center" || tail === "right") {
      align = tail;
      rest = rest.slice(0, p);
    }
  }
  p = lastUnescapedPipe(rest);
  if (p >= 0) {
    const tail = rest.slice(p + 1).trim();
    if (/^\d+$/.test(tail)) {
      width = tail;
      rest = rest.slice(0, p);
    }
  }
  return { alt: rest, width, align };
}

export function imageSizePlugin(md: MarkdownIt): void {
  // ① core rule：拆掉 image token content 尾部的 `|宽度` / `|对齐` 后缀，
  //    把结果暂存到 token 上供 renderer 使用（renderer 会用 content 覆盖 alt，
  //    故必须改 content 本身，仅改 attrs 会被还原——见上方注释）。
  md.core.ruler.push("lightmd_image_size", (state) => {
    const handle = (token: { type: string; content?: string }) => {
      if (token.type !== "image") return;
      const parsed = splitImageSuffix(token.content || "");
      if (parsed.width === undefined && parsed.align === undefined) return;
      token.content = parsed.alt;
      (token as unknown as { __lightmdImage?: { width?: string; align?: string } }).__lightmdImage = {
        width: parsed.width,
        align: parsed.align,
      };
    };
    for (const token of state.tokens) {
      // image token 可能是 inline 的子 token，也可能在顶层（reference image）
      handle(token);
      if (token.type === "inline" && token.children) token.children.forEach(handle);
    }
    return true;
  });

  // ② renderer rule：把拆分后的 content 写回 alt，并追加 width / 对齐样式
  //
  // 不能在包装函数里用 this 取默认 rule（strict mode 下 this 为 undefined）。
  // 故在**安装时**先把原 rule 取出来存进闭包。
  const prevImageRule = md.renderer.rules.image;
  // markdown-it 的 default image rule：读 content 重算 alt 后 renderToken
  const fallbackImage = (tokens: any, idx: number, options: any, _env: any, slf: any): string => {
    const token = tokens[idx];
    const altIdx = token.attrIndex("alt");
    if (altIdx >= 0) {
      token.attrs[altIdx][1] = escapeHtml(token.content || "");
    }
    return slf.renderToken(tokens, idx, options);
  };
  const defaultImage = prevImageRule ?? fallbackImage;

  md.renderer.rules.image = (tokens, idx, options, env, slf) => {
    const token = tokens[idx];
    const meta = (token as unknown as { __lightmdImage?: { width?: string; align?: string } })
      .__lightmdImage;
    if (!meta) {
      // 无后缀：完全走默认行为（零回归）
      return defaultImage(tokens, idx, options, env, slf);
    }
    // 有后缀：content 已在 core rule 去掉后缀，此处写回 alt（并还原被转义的竖线）
    const altIdx = token.attrIndex("alt");
    if (altIdx >= 0) {
      token.attrs![altIdx][1] = escapeHtml((token.content || "").replace(/\\\|/g, "|"));
    }
    let rendered = slf.renderToken(tokens, idx, options);
    const extra: string[] = [];
    if (meta.width) extra.push(`width="${meta.width}"`);
    // v0.13.0 返修（需求4）：对齐此前只在 PM 编辑器内生效，分屏预览与
    // HTML/PDF/PNG 导出**全部丢失**（渲染管线只处理了 width 后缀）。
    // 这里补上与 PM 侧 `imageAlignCss` **同源**的样式，并写 data-align
    // 便于导出的 HTML 再被解析回编辑器时还原对齐。
    const style = imageAlignCss(meta.align);
    if (style) {
      extra.push(`style="${style}"`);
      extra.push(`data-align="${meta.align}"`);
    }
    if (extra.length > 0) {
      rendered = rendered.replace(/\s*\/>$/, ` ${extra.join(" ")} />`);
    }
    return rendered;
  };
}

/** HTML 转义（markdown-it 内部同名 utils 的本地实现，避免依赖 renderer 实例） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 段内换行语义（true=GFM 即换行；false=CommonMark），未传时读设置 */
export function getRenderBreaks(): boolean {
  return useSettingsStore.getState().paragraphBreaks !== "commonmark";
}

/**
 * 渲染/导出共用的 markdown-it 实例（分屏 + HTML/PDF/PNG 导出）。
 *
 * ─── v0.12.2 P2 修复：不得复用 parser 的共享单例 ───
 *
 * 原实现 `getRenderMarkdownIt` 直接 `return getMarkdownIt(breaks)`，拿到的是
 * `parser.ts` 的**模块级单例 `md`**——与 `markdownToDoc` 用的**同一个实例**。
 * 而 `imageSizePlugin` 的 core rule 会在**每次 parse** 时就地改写 `token.content`
 * （把 `"alt|300"` 改成 `"alt"`），于是污染是持久的：
 *
 *   实测：调用一次 renderMarkdownHtml 后，同一文档再走 PM 解析
 *        `![alt|300](a.png)` → width 由 300 变 **null**（宽度丢失）；
 *        若用户接着编辑该块，存盘即 **永久丢失 `|300`**（B6 原文快路径不再命中）。
 *
 * 修复：本管线使用**独立实例**（每次 `createMarkdownIt` 新建 + 装插件），
 * 与 PM 解析彻底隔离。配置仍来自同一工厂，因此"编辑器能解析的语法"与
 * "分屏/导出能渲染的语法"保持一致（R1 的统一目标不受影响）。
 *
 * 成本：模块级缓存一份实例（GFM / CommonMark 各一），不重复创建。
 */
const renderInstances: { gfm: MarkdownIt | null; commonmark: MarkdownIt | null } = {
  gfm: null,
  commonmark: null,
};

export function getRenderMarkdownIt(breaks: boolean = getRenderBreaks()): MarkdownIt {
  const slot = breaks ? "gfm" : "commonmark";
  const cached = renderInstances[slot];
  if (cached) return cached;
  // 独立实例：与 parser.ts 的共享单例隔离，避免 imageSizePlugin 就地改写污染 PM 解析
  const inst = createMarkdownIt({ breaks, html: true, htmlBlockDisabled: true });
  imageSizePlugin(inst);
  renderInstances[slot] = inst;
  return inst;
}

/**
 * DOCX/LaTeX 导出专用实例：HTML 关闭（Block[] 中间结构无法承载 html token，
 * 见模块 jsdoc），其余配置（typographer false + validateLink 白名单）与渲染管线一致。
 */
export function getDocxLatexMarkdownIt(breaks: boolean = getRenderBreaks()): MarkdownIt {
  return createMarkdownIt({ breaks, typographer: false, validateLink: true });
}

/** 渲染选项 */
export interface RenderMarkdownHtmlOptions {
  /** 是否对代码块做 Prism 高亮（默认 true；EPUB 等纯结构场景可关闭） */
  highlight?: boolean;
}

/**
 * 统一的 markdown → HTML 渲染入口。
 *
 * 步骤：markdown-it 渲染 → mermaid 代码块包装为 `<pre class="mermaid">`
 * （供 iframe 内 mermaid 脚本 / R2 导出替换器识别）→ Prism 代码高亮（跳过 mermaid）。
 * 此前三处调用方各自复制 mermaid 包装正则 + 高亮调用，是渲染不一致的温床。
 */
export function renderMarkdownHtml(markdown: string, opts?: RenderMarkdownHtmlOptions): string {
  let html = getRenderMarkdownIt().render(markdown);
  // 将 mermaid 代码块包装为可渲染的容器（iframe 脚本 / 导出替换器以此识别）
  html = html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    '<pre class="mermaid">$1</pre>',
  );
  // 对代码块进行 PrismJS 语法高亮（highlightCodeBlocksInHtml 内部跳过 mermaid 代码块）
  if (opts?.highlight !== false) {
    html = highlightCodeBlocksInHtml(html);
  }
  return html;
}

/**
 * v0.13.1 需求13（按块定位对齐）：**顶层块在源码中的起始行**（0-based，升序）。
 *
 * ## 用途
 * 分屏模式下要"按块"而非"按百分比"联动滚动：需要知道右侧预览里第 i 个顶层元素
 * 对应源码的第几行。markdown-it 的块级 token 自带 `.map = [startLine, endLine]`，
 * 而 token 顺序与渲染出的**顶层元素顺序**一致，因此这份行号表就是"元素下标 → 源码行"
 * 的映射。
 *
 * ## 与渲染元素的一一对应
 * - `nesting === 1`：成对块的开始标记（paragraph / heading / blockquote / 列表 / 表格…）；
 * - `nesting === 0`：自闭合块（fence / code_block / hr）。
 * `level === 0` 保证只取顶层（段落里的 `inline` 是 level 1，表格单元格里的是 level 2）。
 *
 * 实测（v0131-block-scroll-align.test.ts，jsdom 真解析 HTML 计数）：本渲染管线使用
 * `htmlBlockDisabled: true`，**原始 HTML 会被转义成段落**（`<div>` → `&lt;div&gt;`），
 * 因此不产生 `html_block` token，"一个块多个元素"的情形在当前管线里不会出现，
 * 本表长度与 `body.children.length` 一致。
 *
 * ⚠️ 尽管如此，使用方**仍必须**做数量自校验（见 `shouldTagPreview`）：这是应对
 * "插件新增了无 map 的 token / 将来开启 html" 这类变化的廉价保险 ——
 * 数量不符时整份放弃、退回百分比映射，绝不强行错位贴标。
 *
 * 本函数**不改变** `renderMarkdownHtml` 的输出（导出/预览的 HTML 逐字节不变），
 * 只额外提供一份行号表，供 iframe DOM 层贴 `data-src-line` 用。
 */
export function topLevelBlockStartLines(markdown: string): number[] {
  if (!markdown) return [];
  const tokens = getRenderMarkdownIt().parse(markdown, {});
  const lines: number[] = [];
  for (const token of tokens) {
    if (token.level !== 0) continue;
    if (!token.map || token.map.length < 1) continue;
    const isOpener = token.nesting === 1;
    const isSelfClosingBlock = token.nesting === 0;
    if (!isOpener && !isSelfClosingBlock) continue;
    const start = token.map[0];
    if (typeof start !== "number" || !Number.isFinite(start)) continue;
    lines.push(start);
  }
  return lines;
}
