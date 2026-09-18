/**
 * v0.8.0 WP6 ePub 导出测试
 *
 * 使用 jsdom 环境（DOMParser / atob / crypto 可用）。
 *
 * 覆盖 exportEpub.buildEpubZip：
 * 1. 基本结构：mimetype 存在且为首个条目且 STORE 不压缩
 * 2. META-INF/container.xml 指向 OEBPS/content.opf
 * 3. OEBPS/content.opf：metadata（标题=文件名、language=zh-CN、uuid、date）+ manifest + spine
 * 4. OEBPS/nav.xhtml 目录存在且含章节标题
 * 5. 章节 XHTML 含正文与标题，含 XML 声明与 epub namespace
 * 6. 图片写入 OEBPS/images/ 且 <img src> 改写为相对路径
 * 7. 无 h1 时按 h2 拆分；两者皆无则单章
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildEpubZip, normalizeToXhtml } from "../utils/exportEpub";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/IDQAAAAAElFTkSuQmCC";

describe("v0.8.0 ePub 导出", () => {
  it("mimetype 是首个条目且为 STORE 不压缩", async () => {
    const data = await buildEpubZip("# 第一章\n\n正文。", "测试文档", null);
    const zip = await JSZip.loadAsync(data);

    // 首个条目必须是 mimetype
    const firstKey = Object.keys(zip.files)[0];
    expect(firstKey).toBe("mimetype");

    const mimeFile = zip.file("mimetype");
    expect(mimeFile).toBeTruthy();
    expect(await mimeFile!.async("string")).toBe("application/epub+zip");

    // STORE 不压缩：直接校验 zip 原始字节（本地文件头偏移 8 为压缩方法，0 = STORE）
    // 比读 jszip 内部字段更可靠，且与 epubcheck 的规范要求一致
    const buf = data;
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    const method = buf[8]! | (buf[9]! << 8);
    expect(method).toBe(0); // 0 = STORE（未压缩）
    const nameLen = buf[26]! | (buf[27]! << 8);
    expect(nameLen).toBe("mimetype".length);
    const firstName = String.fromCharCode(...buf.slice(30, 30 + nameLen));
    expect(firstName).toBe("mimetype");
  });

  it("包含 container.xml 且指向 content.opf", async () => {
    const data = await buildEpubZip("# 一\n\n内容。", "t", null);
    const zip = await JSZip.loadAsync(data);
    const container = zip.file("META-INF/container.xml");
    expect(container).toBeTruthy();
    const xml = await container!.async("string");
    expect(xml).toContain("OEBPS/content.opf");
    expect(xml).toContain('media-type="application/oebps-package+xml"');
  });

  it("content.opf 的 metadata / manifest / spine 正确", async () => {
    const data = await buildEpubZip("# 一\n\n内容。", "我的文档", null);
    const zip = await JSZip.loadAsync(data);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");

    // metadata
    expect(opf).toContain("<dc:title>我的文档</dc:title>");
    expect(opf).toContain("<dc:language>zh-CN</dc:language>");
    expect(opf).toContain("<dc:identifier id=\"bookid\">urn:uuid:");
    expect(opf).toContain("<dc:date>");
    // manifest
    expect(opf).toContain('href="chap1.xhtml"');
    expect(opf).toContain('href="nav.xhtml"');
    expect(opf).toContain('properties="nav"');
    // spine
    expect(opf).toContain('<itemref idref="chap1"/>');
  });

  it("nav.xhtml 目录包含章节标题", async () => {
    const data = await buildEpubZip("# 第一章\n\n内容。\n\n# 第二章\n\n更多。", "t", null);
    const zip = await JSZip.loadAsync(data);
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain("第一章");
    expect(nav).toContain("第二章");
  });

  it("章节 XHTML 含 XML 声明、epub namespace、标题与正文", async () => {
    const data = await buildEpubZip("# 第一章\n\n正文段落内容。", "t", null);
    const zip = await JSZip.loadAsync(data);
    const chap = await zip.file("OEBPS/chap1.xhtml")!.async("string");
    expect(chap).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(chap).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(chap).toContain('xmlns:epub="http://www.idpf.org/2007/ops"');
    expect(chap).toContain("第一章");
    expect(chap).toContain("正文段落内容。");
  });

  it("图片写入 OEBPS/images/ 且 src 改写为相对路径", async () => {
    const md = `# 第一章\n\n![图1](${PNG_DATA_URL})\n\n段落。`;
    const data = await buildEpubZip(md, "t", null);
    const zip = await JSZip.loadAsync(data);

    const imgKey = Object.keys(zip.files).find((k) => k.startsWith("OEBPS/images/"));
    expect(imgKey).toBeTruthy();

    const chap = await zip.file("OEBPS/chap1.xhtml")!.async("string");
    expect(chap).toContain("images/img1.png");
    expect(chap).not.toContain("data:image");

    // content.opf 的 manifest 含图片条目
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain('href="images/img1.png"');
    expect(opf).toContain('media-type="image/png"');
  });

  it("无 h1 时按 h2 拆分章节", async () => {
    const md = "## 小节一\n\n内容一。\n\n## 小节二\n\n内容二。";
    const data = await buildEpubZip(md, "t", null);
    const zip = await JSZip.loadAsync(data);
    expect(zip.file("OEBPS/chap1.xhtml")).toBeTruthy();
    expect(zip.file("OEBPS/chap2.xhtml")).toBeTruthy();
    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("小节一");
    expect(nav).toContain("小节二");
  });

  it("既无 h1 也无 h2 时单章", async () => {
    const md = "只是一段没有标题的文字。";
    const data = await buildEpubZip(md, "t", null);
    const zip = await JSZip.loadAsync(data);
    expect(zip.file("OEBPS/chap1.xhtml")).toBeTruthy();
    expect(zip.file("OEBPS/chap2.xhtml")).toBeFalsy();
    const chap = await zip.file("OEBPS/chap1.xhtml")!.async("string");
    expect(chap).toContain("只是一段没有标题的文字。");
  });

  it("P1-1：章节 XHTML 中 void 元素全部自闭合（合法 XML）", async () => {
    // 含软换行（<br>）、图片（<img>）、任务列表（<input>）的文档
    const md = `# 章\n\n甲\n乙\n\n![图](${PNG_DATA_URL})\n\n- [ ] 待办\n- [x] 完成`;
    const data = await buildEpubZip(md, "t", null);
    const zip = await JSZip.loadAsync(data);
    const chap = await zip.file("OEBPS/chap1.xhtml")!.async("string");
    // 不允许出现未自闭合的 void 元素
    expect(chap).not.toContain("<br>");
    expect(chap).toContain("<br />");
    expect(chap).toMatch(/<img [^<>]*\/>/);
    expect(chap).toMatch(/<input [^<>]*\/>/);
    // 章节正文仍在（规范化不能丢内容）
    expect(chap).toContain("待办");
    expect(chap).toContain("完成");
  });
});

describe("v0.8.0 修复 P1-1 normalizeToXhtml", () => {
  it("void 元素补自闭合斜杠，属性保留", () => {
    expect(normalizeToXhtml("<br>")).toBe("<br />");
    expect(normalizeToXhtml('<img src="a.png" alt="图">')).toBe('<img src="a.png" alt="图" />');
    expect(normalizeToXhtml("<hr>")).toBe("<hr />");
    expect(normalizeToXhtml('<input type="checkbox" data-checked="false">')).toBe(
      '<input type="checkbox" data-checked="false" />',
    );
  });

  it("已自闭合的写法不重复改写", () => {
    expect(normalizeToXhtml("<br/>")).toBe("<br/>");
    expect(normalizeToXhtml('<img src="a.png"/>')).toBe('<img src="a.png"/>');
  });

  it("非 void 元素不受影响", () => {
    expect(normalizeToXhtml("<div><span>文字</span></div>")).toBe("<div><span>文字</span></div>");
    expect(normalizeToXhtml("<p>a<b>b</b></p>")).toBe("<p>a<b>b</b></p>");
  });
});
