/**
 * v0.9.5 问题4:临时文件粘贴图片重启后不渲染
 *
 * 根因:sanitizeLinkHref 把 data: scheme 整体拒绝,重启后 markdownToDoc 重新
 * 解析 base64 内联图片时 src 被清空,图片退化为 alt 字符。
 * 修复:data:image(安全 MIME)放行,与 markdown-it 默认 GOOD_DATA_RE 对齐;
 * data:text/html 等仍拒绝。
 */
import { describe, it, expect } from "vitest";
import { sanitizeLinkHref, markdownToDoc } from "../core/markdown/parser";

const PNG_B64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("v0.9.5 问题4 data:image 放行", () => {
  it("sanitizeLinkHref 放行 data:image(png/jpeg/webp/gif/svg/avif/bmp)", () => {
    expect(sanitizeLinkHref(PNG_B64)).toBe(PNG_B64);
    expect(sanitizeLinkHref("data:image/jpeg;base64,xxx")).toBe("data:image/jpeg;base64,xxx");
    expect(sanitizeLinkHref("data:image/webp;base64,xxx")).toBe("data:image/webp;base64,xxx");
    expect(sanitizeLinkHref("data:image/svg+xml;base64,xxx")).toBe("data:image/svg+xml;base64,xxx");
    expect(sanitizeLinkHref("data:image/avif;base64,xxx")).toBe("data:image/avif;base64,xxx");
  });

  it("非图片 data: 仍被拒绝(无脚本注入面)", () => {
    expect(sanitizeLinkHref("data:text/html;base64,SSA=")).toBeNull();
    expect(sanitizeLinkHref("data:text/javascript,alert(1)")).toBeNull();
    expect(sanitizeLinkHref("data:application/pdf;base64,x")).toBeNull();
  });

  it("其他危险 scheme 仍被拒绝(既有行为回归)", () => {
    expect(sanitizeLinkHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeLinkHref("vbscript:x")).toBeNull();
    expect(sanitizeLinkHref("file:///C:/x")).toBeNull();
  });

  it("base64 内联图片经 markdownToDoc 解析后 src 保留(重启恢复场景)", () => {
    const src = `正文\n\n![截图](${PNG_B64})\n`;
    const doc = markdownToDoc(src);
    let srcAttr: string | null = null;
    doc.descendants((n) => {
      if (n.type.name === "image") srcAttr = n.attrs.src as string;
    });
    expect(srcAttr).toBe(PNG_B64);
  });

  it("base64 图片 markdown 往返不丢失(模拟重启后重新打开临时文件)", () => {
    const src = `![截图](${PNG_B64})\n`;
    const doc = markdownToDoc(src);
    // 模拟重启:重新走 markdownToDoc(首次解析结果重新解析)
    const again = markdownToDoc(src);
    let src1: string | null = null;
    let src2: string | null = null;
    doc.descendants((n) => {
      if (n.type.name === "image") src1 = n.attrs.src as string;
    });
    again.descendants((n) => {
      if (n.type.name === "image") src2 = n.attrs.src as string;
    });
    expect(src1).toBe(PNG_B64);
    expect(src2).toBe(PNG_B64);
  });
});
