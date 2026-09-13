/**
 * v0.7.3 改进6(S2)：链接 URL scheme 白名单测试
 *
 * 覆盖：
 * 1. sanitizeLinkHref：白名单 scheme 放行 / 危险 scheme 拒绝 / 相对路径与锚点放行
 * 2. markdownToDoc：javascript:/data: 链接不渲染为 link mark（降级纯文本）
 * 3. 正常 http/https/mailto 链接仍渲染为 link mark（回归）
 */
import { describe, it, expect } from "vitest";
import { sanitizeLinkHref, markdownToDoc } from "../core/markdown/parser";

/** 在文档中收集 href，返回数组 */
function collectHrefs(md: string): string[] {
  const doc = markdownToDoc(md);
  const hrefs: string[] = [];
  doc.descendants((node) => {
    // 返回 undefined（不显式 false）以继续下探 text 子节点收集 link mark
    if (node.isText && node.marks) {
      for (const m of node.marks) {
        if (m.type.name === "link" && typeof m.attrs.href === "string") {
          hrefs.push(m.attrs.href);
        }
      }
    }
  });
  return hrefs;
}

describe("v0.7.3 S2 - sanitizeLinkHref", () => {
  it("白名单 scheme 放行", () => {
    expect(sanitizeLinkHref("https://example.com")).toBe("https://example.com");
    expect(sanitizeLinkHref("http://api.example.com/v1")).toBe("http://api.example.com/v1");
    expect(sanitizeLinkHref("mailto:test@example.com")).toBe("mailto:test@example.com");
    expect(sanitizeLinkHref("ftp://files.example.com/a.txt")).toBeTruthy();
  });

  it("危险 scheme 拒绝", () => {
    expect(sanitizeLinkHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeLinkHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(sanitizeLinkHref("data:text/html;base64,SSA")).toBeNull();
    expect(sanitizeLinkHref("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeLinkHref("file:///etc/passwd")).toBeNull();
  });

  it("相对路径与锚点放行", () => {
    expect(sanitizeLinkHref("/docs/guide")).toBe("/docs/guide");
    expect(sanitizeLinkHref("./relative.md")).toBe("./relative.md");
    expect(sanitizeLinkHref("#section-2")).toBe("#section-2");
    expect(sanitizeLinkHref("guide.md")).toBe("guide.md");
  });

  it("空/纯空白返回 null", () => {
    expect(sanitizeLinkHref("")).toBeNull();
    expect(sanitizeLinkHref("   ")).toBeNull();
  });
});

describe("v0.7.3 S2 - markdownToDoc 链接降级", () => {
  it("javascript: 链接不渲染为 link mark（保留文本但降级纯文本）", () => {
    const hrefs = collectHrefs("[点我](javascript:alert(1))");
    expect(hrefs).toEqual([]);
    // 文本仍保留
    const doc = markdownToDoc("[点我](javascript:alert(1))");
    expect(doc.textContent).toContain("点我");
  });

  it("data: 链接降级纯文本", () => {
    expect(collectHrefs("[图](data:text/html,x)")).toEqual([]);
  });

  it("正常 https 链接仍渲染为 link mark（回归）", () => {
    expect(collectHrefs("[官网](https://example.com)")).toEqual(["https://example.com"]);
  });

  it("mailto 链接仍渲染（回归）", () => {
    expect(collectHrefs("[联系](mailto:a@b.com)")).toEqual(["mailto:a@b.com"]);
  });
});