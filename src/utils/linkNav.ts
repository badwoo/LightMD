/**
 * v0.9.5 问题3:文档内链接点击导航
 *
 * 此前全项目无链接点击处理——阅读模式 <a href> 点击被 WebView2 当作页面内导航,
 * 相对路径链接点击无任何反应。此处提供 href 分类与内部路径解析纯函数,
 * 供 EditorContainer(阅读模式点击/分屏 iframe 桥接)统一分发:
 * - 锚点(#xxx) → 同文档滚动到标题
 * - http(s)/mailto/ftp → 外部打开(tauri shell / window.open)
 * - 相对/绝对路径 → 内部文件打开(lightmd:open-path → App openFileByPath)
 * - 其余协议(javascript:/file:/未知)→ 不动作(与 sanitizeLinkHref 白名单对齐)
 */
import { resolveRelativePath, stripExtendedPathPrefix } from "./imagePath";
import { getParentDir, normalizePath } from "./path";
import { slugify } from "../core/markdown/heading-anchor";

export type LinkAction =
  | { kind: "open-internal"; path: string }
  | { kind: "open-external"; href: string }
  | { kind: "scroll-anchor"; anchor: string }
  | { kind: "none" };

/** 外部浏览器/邮件协议白名单 */
const EXTERNAL_PROTOCOLS = new Set(["http", "https", "mailto", "ftp"]);

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function resolveLinkAction(href: string, docPath: string): LinkAction {
  const h = href.trim();
  if (!h) return { kind: "none" };
  // 同文档锚点:滚动到标题(slug 匹配规则与渲染层 heading-anchor 一致)
  if (h.startsWith("#")) {
    return { kind: "scroll-anchor", anchor: decodeURIComponentSafe(h.slice(1)) };
  }
  const m = /^([a-z][a-z0-9.+-]*):/i.exec(h);
  if (m && !/^[a-z]$/i.test(m[1])) {
    // 单字母 scheme 是 Windows 盘符（D:\...），按路径处理而非协议
    const protocol = m[1].toLowerCase();
    if (EXTERNAL_PROTOCOLS.has(protocol)) return { kind: "open-external", href: h };
    // 其余协议(file:/javascript:/data:/未知 scheme)一律不动作——安全策略与
    // 编辑器渲染白名单(sanitizeLinkHref)一致,点击不产生导航面
    return { kind: "none" };
  }
  // 无 scheme:相对路径或绝对路径 → 内部文件
  const normalized = normalizePath(stripExtendedPathPrefix(h));
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("/")) {
    // Windows 绝对路径(X:/...)或 POSIX 绝对路径:直接打开
    return { kind: "open-internal", path: normalized };
  }
  if (!docPath) {
    // 临时文件(无路径)的相对链接无从解析
    return { kind: "none" };
  }
  // 相对路径基于当前文档所在目录解析(图片路径同款语义)
  const resolved = resolveRelativePath(getParentDir(docPath), normalized);
  return { kind: "open-internal", path: stripExtendedPathPrefix(resolved) };
}

/** 锚点是否命中标题文本(id 规则与 slugify 一致,PM 编辑器内标题 DOM 无 id 时按文本匹配) */
export function anchorMatchesHeading(anchor: string, headingText: string): boolean {
  return slugify(headingText) === slugify(anchor);
}
