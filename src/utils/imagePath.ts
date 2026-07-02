/**
 * 图片路径解析工具
 *
 * 将 Markdown 中的相对图片路径（如 ./assets/xxx.png）转换为 Tauri webview 可访问的 URL。
 *
 * 背景：Tauri 2 webview 默认禁止通过相对路径访问本地文件系统。
 * 启用 assetProtocol 后，需用 convertFileSrc 把绝对路径转换为 asset:// URL。
 *
 * 设计：
 * - resolveImageSrc(src, docPath) 为纯函数，便于单元测试
 * - 模块级 currentDocPath 由 App.tsx 在文件切换时更新，供 schema.toDOM 等无法直接获取 docPath 的场景使用
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "../services/fileService";

let currentDocPath: string | null = null;

/** 设置当前文档路径（App.tsx 在 filePath 变化时调用） */
export function setCurrentDocPath(path: string | null): void {
  currentDocPath = path;
}

/** 获取当前文档路径 */
export function getCurrentDocPath(): string | null {
  return currentDocPath;
}

/**
 * 解析相对路径为绝对路径（基于 base 目录）
 *
 * @param base 文档所在目录的绝对路径（正斜杠格式）
 * @param rel 相对路径（如 ./assets/x.png 或 ../images/y.jpg）
 * @returns 绝对路径（正斜杠格式）
 */
function resolveRelativePath(base: string, rel: string): string {
  const baseParts = base.split("/").filter(Boolean);
  const relParts = rel.split("/");

  for (const part of relParts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }

  // 保留 Windows 盘符前缀（如 D:）
  if (base.includes(":") && baseParts.length > 0) {
    return baseParts.join("/");
  }
  return "/" + baseParts.join("/");
}

/**
 * 将图片 src 转换为 webview 可访问的 URL（纯函数）
 *
 * 转换规则：
 * - data:/https?:/asset:/blob: URL 原样返回
 * - 非 Tauri 环境原样返回
 * - 相对路径（./ 或 ../ 开头）基于 docPath 解析为绝对路径，再用 convertFileSrc 转换
 * - Windows 绝对路径（X:\...）转为正斜杠后用 convertFileSrc 转换
 * - Unix 绝对路径（/...）直接用 convertFileSrc 转换
 *
 * @param src 原始图片 src
 * @param docPath 当前文档的绝对路径（可选，默认使用全局 currentDocPath）
 */
export function resolveImageSrc(src: string, docPath: string | null = currentDocPath): string {
  if (!src) return src;

  // 已是 URL 的原样返回
  if (/^(data:|https?:|asset:|blob:|tauri:)/i.test(src)) return src;

  // 非 Tauri 环境原样返回
  if (!isTauri()) return src;

  let absPath: string;

  if (src.startsWith("./") || src.startsWith("../") || (!/^[A-Za-z]:[\\/]/.test(src) && !src.startsWith("/"))) {
    // 相对路径：基于文档目录解析
    if (!docPath) return src;
    const docDir = docPath.replace(/[\\/][^\\/]*$/, "").replace(/\\/g, "/");
    absPath = resolveRelativePath(docDir, src);
  } else if (/^[A-Za-z]:[\\/]/.test(src)) {
    // Windows 绝对路径
    absPath = src.replace(/\\/g, "/");
  } else if (src.startsWith("/")) {
    // Unix 绝对路径
    absPath = src;
  } else {
    return src;
  }

  return convertFileSrc(absPath);
}
