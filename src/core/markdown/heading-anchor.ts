/**
 * heading-anchor 插件
 *
 * 为 markdown-it 渲染的标题自动生成 id（锚点），
 * 使 `[链接](#标题)` 能跳转到对应标题（对标 Typora 默认行为）。
 *
 * 设计：
 * - 通过 core rule（inline 之后）扫描 token 流，提取所有 heading 文本
 * - 基于 GitHub slugify 规则生成 id：小写、空格转连字符、移除特殊字符、保留中文
 * - 同名标题去重：第二次出现加 -1，第三次加 -2 ...
 * - 将 id 写入 heading_open token.attrs，markdown-it 默认渲染器会输出 id 属性
 *
 * 侵入性最小：不修改 schema/parser，仅作用于 HTML 渲染输出。
 * 同时把收集的 headings 列表缓存到 env，供 TOC 插件复用，避免重复扫描。
 */
import type MarkdownIt from "markdown-it";

/** TOC / 锚点共用的标题信息 */
export interface TocHeading {
  level: number;
  text: string;
  id: string;
}

/**
 * GitHub 风格 slugify：生成标题 id
 * - 小写
 * - 移除非字母/数字/空格/连字符的字符（保留中文等 Unicode 字母）
 * - 空格转连字符
 * - 合并连续连字符，去除首尾连字符
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 从 inline token 提取纯文本（保留 code_inline 内容，换行转空格） */
function extractText(token: any): string {
  if (!token) return "";
  if (token.children) {
    let text = "";
    for (const child of token.children) {
      if (child.type === "text" || child.type === "code_inline") {
        text += child.content;
      } else if (child.type === "softbreak" || child.type === "hardbreak") {
        text += " ";
      }
    }
    return text;
  }
  return token.content || "";
}

/**
 * 扫描 token 流，收集所有 heading 信息并为 heading_open 注入 id 属性。
 * 同时返回去重后的 headings 列表，供 TOC 插件复用。
 *
 * 注意：该函数会修改 token.attrs（写入 id），需在 core rule 阶段调用。
 */
export function collectHeadings(tokens: any[]): TocHeading[] {
  const headings: TocHeading[] = [];
  // 原始 slug → 已使用次数，用于去重
  const usedIds = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open") continue;

    const level = parseInt(t.tag?.slice(1) || "1", 10);
    const inline = tokens[i + 1];
    const text = extractText(inline);
    const rawId = slugify(text) || "heading";

    // 去重：第一次出现不加后缀，第二次加 -1，第三次加 -2 ...
    const used = usedIds.get(rawId) || 0;
    const id = used === 0 ? rawId : `${rawId}-${used}`;
    usedIds.set(rawId, used + 1);

    headings.push({ level, text, id });

    // 写入 token.attrs，markdown-it 默认渲染器会输出 id 属性
    if (!t.attrs) {
      t.attrs = [];
    } else {
      // 移除已有 id，避免重复（collectHeadings 可能被调用多次）
      t.attrs = t.attrs.filter((pair: [string, string]) => pair[0] !== "id");
    }
    t.attrs.push(["id", id]);
  }

  return headings;
}

export function headingAnchorPlugin(md: MarkdownIt): void {
  // 在 inline 解析完成后扫描，此时 inline token.children 已就绪
  md.core.ruler.after("inline", "heading_anchor", (state: any) => {
    const headings = collectHeadings(state.tokens);
    // 缓存到 env，供 TOC 插件复用，避免重复扫描全文
    state.env.__headings = headings;
    return true;
  });
}
