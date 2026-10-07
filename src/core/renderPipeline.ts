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
import { createMarkdownIt, getMarkdownIt } from "./markdown/parser";
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
export function imageSizePlugin(md: MarkdownIt): void {
  // ① core rule：拆分 image token 的 content（alt 原文存放在 content，attrs.alt 初始为空）
  //
  // 实测结构（md.parse("![alt|300](a.png)"))：
  //   inline > image token，content="alt|300"，attrs=[["src","a.png"],["alt",""]]
  // 渲染时 markdown-it 用 content 覆盖 attrs.alt（见 renderer.mjs default_rules.image），
  // 故必须改 content 本身，仅改 attrs 会被还原。
  md.core.ruler.push("lightmd_image_size", (state) => {
    for (const token of state.tokens) {
      // image token 可能是 inline 的子 token，也可能在顶层（reference image）
      if (token.type === "image") {
        const m = /^(.*)\|(\d+)$/.exec(token.content || "");
        if (m) {
          token.content = m[1];
          (token as unknown as { __lightmdWidth?: string }).__lightmdWidth = m[2];
        }
        continue;
      }
      if (token.type === "inline" && token.children) {
        for (const child of token.children) {
          if (child.type !== "image") continue;
          const m = /^(.*)\|(\d+)$/.exec(child.content || "");
          if (m) {
            child.content = m[1];
            (child as unknown as { __lightmdWidth?: string }).__lightmdWidth = m[2];
          }
        }
      }
    }
    return true;
  });

  // ② renderer rule：把拆分后的 content 写回 alt，并追加 width 属性
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
    const w = (token as unknown as { __lightmdWidth?: string }).__lightmdWidth;
    if (!w) {
      // 无尺寸后缀：完全走默认行为（零回归）
      return defaultImage(tokens, idx, options, env, slf);
    }
    // 有尺寸后缀：content 已在 core rule 去掉 |W，此处写回 alt 并追加 width
    const altIdx = token.attrIndex("alt");
    if (altIdx >= 0) {
      token.attrs![altIdx][1] = escapeHtml(token.content || "");
    }
    const rendered = slf.renderToken(tokens, idx, options);
    // 在自闭合 /> 前插入 width 属性
    return rendered.replace(/\s*\/>$/, ` width="${w}" />`);
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
 * 直接委托 parser.ts 的 getMarkdownIt——与编辑器 PM 解析共用同一工厂配置，
 * 保证"编辑器里能解析的语法"与"分屏/导出里渲染的语法"一致。
 *
 * v0.11.0 B1-3：注册 imageSizePlugin（图片 |W 尺寸后缀）。
 * 用模块级 flag 保证只包装一次 renderer rule（避免多次 push core rule 重复拆分）。
 */
let imageSizeInstalled = false;
export function getRenderMarkdownIt(breaks: boolean = getRenderBreaks()): MarkdownIt {
  const inst = getMarkdownIt(breaks);
  if (!imageSizeInstalled) {
    imageSizePlugin(inst);
    imageSizeInstalled = true;
  }
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
