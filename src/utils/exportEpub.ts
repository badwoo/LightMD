/**
 * v0.8.0 WP6 导出 ePub 工具
 *
 * 设计原则：
 * - 纯前端 + jszip（动态 import，避免首屏体积增大）
 * - 复用 ExportDialog 的 renderMarkdownToHTML 产物作为内容源
 * - 按 h1（无 h1 按 h2，再无则单章）拆分章节，每章一个 XHTML
 * - 图片经 convertImagesToDataUrlInHtml 内联为 data URL 后，还原为二进制写入 OEBPS/images/，
 *   并改写 <img src> 为相对路径
 *
 * 生成的 EPUB 结构：
 *   mimetype (首位, STORE 不压缩)
 *   META-INF/container.xml
 *   OEBPS/content.opf
 *   OEBPS/nav.xhtml
 *   OEBPS/chapN.xhtml
 *   OEBPS/images/imgN.ext
 *   OEBPS/style.css
 */

import { renderMarkdownToHTML, convertImagesToDataUrlInHtml } from "../components/dialogs/ExportDialog";
import { isTauri } from "../services/fileService";
import { notifyError, notifySuccess } from "../services/notificationService";
import { t } from "../i18n";

/** 从文件路径推导默认保存目录 */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

/** 生成 uuid（带降级方案，兼容无 crypto.randomUUID 的环境） */
function makeUuid(): string {
  try {
    // crypto.randomUUID 在浏览器 / Node 16+ 可用
    const c: any = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch { /* ignore */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** MIME → 扩展名 */
function mimeToExt(mime: string): string {
  const m = mime.split(";")[0]!.toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return map[m] || "png";
}

/** base64 → Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  const binary = typeof atob === "function" ? atob(b64) : "";
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** ePub 章节拆分：按 h1 / h2 切分 */
interface RawChapter {
  title: string;
  html: string;
}

function splitChapters(body: HTMLElement): RawChapter[] {
  const childNodes = Array.from(body.childNodes).filter(
    (n) => n.nodeType === 1,
  ) as Element[];

  if (childNodes.length === 0) {
    return [{ title: "", html: body.innerHTML }];
  }

  const hasH1 = childNodes.some((n) => n.tagName === "H1");
  const splitTag = hasH1
    ? "H1"
    : childNodes.some((n) => n.tagName === "H2")
      ? "H2"
      : null;

  if (!splitTag) {
    return [{ title: "", html: body.innerHTML }];
  }

  const doc = body.ownerDocument;
  const chapters: RawChapter[] = [];
  let current: HTMLElement | null = null;
  let title = "";

  for (const node of childNodes) {
    if (node.tagName === splitTag) {
      if (current) {
        chapters.push({ title, html: current.innerHTML });
      }
      current = doc.createElement("div");
      current.appendChild(node.cloneNode(true));
      title = node.textContent?.trim() || "";
    } else {
      if (!current) {
        // 第一个分隔标题之前的内容 → 作为前言章节
        current = doc.createElement("div");
        title = "";
      }
      current.appendChild(node.cloneNode(true));
    }
  }
  if (current) chapters.push({ title, html: current.innerHTML });

  return chapters;
}

interface EpubImage {
  name: string;
  data: Uint8Array;
  mime: string;
}

/** 将章节 HTML 中的 data URL 图片还原为二进制，并改写 src 为相对路径 */
function processChapterImages(html: string, images: EpubImage[], doc: Document): string {
  const container = doc.createElement("div");
  container.innerHTML = html;
  const imgs = Array.from(container.querySelectorAll("img"));
  for (const img of imgs) {
    const src = img.getAttribute("src") || "";
    const m = src.match(/^data:([^;]+);base64,(.*)$/);
    if (m) {
      const mime = m[1]!;
      const b64 = m[2]!;
      const name = `img${images.length + 1}.${mimeToExt(mime)}`;
      images.push({ name, data: base64ToBytes(b64), mime });
      img.setAttribute("src", `images/${name}`);
    }
  }
  return container.innerHTML;
}

/** 构造 XHTML 章节文件 */
function buildChapterXhtml(title: string, content: string): string {
  const safeTitle = escapeXml(title || "Chapter");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>${safeTitle}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${content}
</body>
</html>
`;
}

/** 构造 nav.xhtml 目录 */
function buildNavXhtml(chapters: { title: string }[]): string {
  const items = chapters
    .map((c, i) => {
      const title = escapeXml(c.title || `Chapter ${i + 1}`);
      return `    <li><a href="chap${i + 1}.xhtml">${title}</a></li>`;
    })
    .join("\n");
  const ol = chapters.length > 0 ? `<ol>\n${items}\n  </ol>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>目录</title>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>目录</h1>
${ol}
</nav>
</body>
</html>
`;
}

/** 构造 content.opf */
function buildContentOpf(opts: {
  title: string;
  uuid: string;
  date: string;
  chapterCount: number;
  imageManifests: string;
}): string {
  const manifestItems: string[] = [];
  manifestItems.push(
    `<item id="css" href="style.css" media-type="text/css"/>`,
  );
  manifestItems.push(
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
  );
  for (let i = 1; i <= opts.chapterCount; i++) {
    manifestItems.push(
      `<item id="chap${i}" href="chap${i}.xhtml" media-type="application/xhtml+xml"/>`,
    );
  }
  if (opts.imageManifests) {
    manifestItems.push(opts.imageManifests);
  }
  const spineItems = Array.from(
    { length: opts.chapterCount },
    (_, i) => `  <itemref idref="chap${i + 1}"/>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">urn:uuid:${opts.uuid}</dc:identifier>
  <dc:title>${escapeXml(opts.title)}</dc:title>
  <dc:language>zh-CN</dc:language>
  <dc:date>${opts.date}</dc:date>
  <meta property="dcterms:modified">${opts.date}T00:00:00Z</meta>
</metadata>
<manifest>
  ${manifestItems.join("\n  ")}
</manifest>
<spine>
${spineItems}
</spine>
</package>
`;
}

/** 构造 container.xml */
const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/** 最小内联 CSS（代码/引用/表格基础样式），供阅读器统一呈现 */
const STYLE_CSS = `body { font-family: "Noto Serif CJK SC", "Source Han Serif SC", serif; line-height: 1.8; padding: 0 1em; }
h1, h2, h3 { break-before: auto; }
pre { background: #f4f4f4; border-radius: 6px; padding: 1em; overflow-x: auto; font-family: "Cascadia Code", Consolas, monospace; font-size: 0.9em; }
code { background: #f4f4f4; color: #d63384; padding: 0.15em 0.4em; border-radius: 3px; }
blockquote { border-left: 4px solid #0078d4; margin: 1em 0; padding: 0.4em 1em; background: #f8f9fa; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
img { max-width: 100%; }
`;

/** XML 文本转义（用于标题/目录） */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * v0.8.0 修复 P1-1：XHTML 规范化——把 markdown-it 产物中的 void 元素
 * 改写为自闭合形式（EPUB 章节必须是合法 XML，否则 epubcheck 报错、
 * 严格阅读器打不开）。markdown-it 输出 <br>、<img>、<hr>、<input> 不带斜杠。
 * 已自闭合的写法（<br/>）不会被重复改写；markdown-it 会转义属性值里的 < > &，
 * 因此用 `[^<>]*` 约束属性区间是安全的。
 */
export function normalizeToXhtml(html: string): string {
  return html.replace(
    // 属性组末字符不允许是 / 或空白，避免把已自闭合的 <img ... /> 再改写成 <img .../ />
    /<(br|hr|img|input|col|source|wbr|meta|link|base|area|embed|track|param)(\s[^<>]*?[^/\s])?>/gi,
    "<$1$2 />",
  );
}

/**
 * 构建 ePub 的 zip 字节（Uint8Array），供测试与导出复用
 *
 * @param markdown markdown 源码
 * @param filename 文件名（不含扩展名）
 * @param filePath 当前编辑文件路径（用于图片相对路径解析）
 * @returns ePub 文件的二进制内容
 */
export async function buildEpubZip(
  markdown: string,
  filename: string,
  filePath?: string | null,
): Promise<Uint8Array> {
  const baseName = filename.replace(/\.md$/i, "") || "document";
  const title = baseName;

  // 1. 渲染 HTML（复用 ExportDialog 的渲染管线）
  let html = await renderMarkdownToHTML(markdown);
  // 2. 图片内联为 data URL
  html = await convertImagesToDataUrlInHtml(html, filePath);

  // 3. 解析为 DOM 并按标题拆分章节
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;
  const rawChapters = splitChapters(body);

  // 4. 处理图片 + 生成章节 XHTML
  const images: EpubImage[] = [];
  const chapterXhtmls = rawChapters.map((ch, i) => ({
    title: ch.title || `Chapter ${i + 1}`,
    href: `chap${i + 1}.xhtml`,
    // v0.8.0 修复 P1-1：章节内容注入 XHTML 前做自闭合规范化（合法 XML）
    content: normalizeToXhtml(processChapterImages(ch.html, images, doc)),
  }));

  // 5. 组装 ZIP（mimetype 必须为首个条目且 STORE 不压缩）
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);
  zip.file("OEBPS/style.css", STYLE_CSS);

  // 图片清单（用于 content.opf 的 manifest）
  const imageManifests = images
    .map(
      (img, i) =>
        `<item id="img${i + 1}" href="images/${img.name}" media-type="${img.mime}"/>`,
    )
    .join("\n  ");

  // 生成 content.opf（注入真实图片 manifest）
  const uuid = makeUuid();
  const date = new Date().toISOString().slice(0, 10);
  const opf = buildContentOpf({ title, uuid, date, chapterCount: chapterXhtmls.length, imageManifests });

  zip.file("OEBPS/content.opf", opf);
  zip.file("OEBPS/nav.xhtml", buildNavXhtml(chapterXhtmls));
  for (const ch of chapterXhtmls) {
    zip.file(`OEBPS/${ch.href}`, buildChapterXhtml(ch.title, ch.content));
  }
  for (let i = 0; i < images.length; i++) {
    zip.file(`OEBPS/images/${images[i]!.name}`, images[i]!.data);
  }

  return (await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    mimeType: "application/epub+zip",
  })) as Uint8Array;
}

/** 浏览器模式下载 Blob */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 导出 .epub 文件（Tauri 用 save 对话框，浏览器回退下载）
 *
 * @param markdown markdown 源码
 * @param filename 文件名（不含扩展名）
 * @param filePath 当前编辑文件路径
 * @returns 成功返回 true，失败返回 false
 */
export async function exportEpub(
  markdown: string,
  filename: string,
  filePath?: string | null,
): Promise<boolean> {
  try {
    const data = await buildEpubZip(markdown, filename, filePath);
    const finalName = filename.replace(/\.md$/i, "") + ".epub";

    if (isTauri()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const defaultDir = getDefaultDir(filePath);
        const selected = await save({
          defaultPath: defaultDir ? `${defaultDir}/${finalName}` : finalName,
          filters: [{ name: "EPUB", extensions: ["epub"] }],
        });
        if (selected) {
          await writeFile(selected, data);
          notifySuccess(t("export.epub.exported", { name: finalName }));
          return true;
        }
        return false; // 用户取消
      } catch (err) {
        console.error("Tauri 导出 EPUB 失败，回退到浏览器下载:", err);
      }
    }

    downloadBlob(new Blob([data], { type: "application/epub+zip" }), finalName);
    notifySuccess(t("export.epub.exported", { name: finalName }));
    return true;
  } catch (err) {
    console.error("EPUB 导出失败:", err);
    notifyError(
      t("export.epub.exportFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
