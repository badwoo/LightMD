/**
 * v0.13.0 需求1：块级复制 / 剪切 / 删除的核心逻辑（纯函数 + IO 分离）。
 *
 * ## 为什么不能只写 `text/plain`
 *
 * 阅读模式粘贴时若只有 Markdown 文本，要重新走「markdown → PM doc」解析，
 * 会丢失 B6 原文切片（未编辑块的原始字节）。带专用格式可在同应用内无损还原。
 *
 * ## 为什么必须同时写 `text/plain`
 *
 * WebView2 的 `navigator.clipboard.write` 对自定义 MIME 支持有限，且用户经常要
 * 粘到外部。纯 Markdown 是保底。
 *
 * ## 三份格式
 *
 * | 格式 | 内容 | 用途 |
 * | --- | --- | --- |
 * | `text/plain` | 该块的 Markdown 源码 | 粘到外部编辑器 / LightMD 源码模式 |
 * | `text/html` | 该块的渲染 HTML | 粘到网页 / Word |
 * | `application/x-lightmd-block` | JSON `{markdown, from, to}` | LightMD 阅读模式精确还原 |
 */

/** 专用 MIME：LightMD 自己识别的块数据 */
export const BLOCK_CLIPBOARD_MIME = "application/x-lightmd-block";

/** 写入剪贴板的完整载荷 */
export interface BlockClipboardData {
  /** 该块的 Markdown 源码（`docToMarkdown(node)`） */
  markdown: string;
  /** 该块的渲染 HTML（可选，跨应用粘贴用） */
  html?: string;
  /**
   * v0.13.2 需求1：写入系统剪贴板 `text/plain` 的那份文本。
   *
   * 大多数块的 `text/plain` 就是 markdown 本身（省略即可），但**代码块复制按钮**
   * 需要一份「纯代码」给外部编辑器（粘进 IDE/终端不该带围栏），而应用内粘贴
   * 又要还原成代码块。两者不同源时用本字段记录实际写入的纯文本，
   * `inAppBlockMarkdown` 据此仍能判定"这次粘贴的就是刚才复制的那一块"。
   */
  plain?: string;
  /** 块在文档中的起止位置（专用格式还原用） */
  from: number;
  to: number;
  /** 时间戳（调试/诊断用） */
  at: number;
}

/**
 * 从剪贴板条目里解析出 LightMD 块数据。
 *
 * @param entries 剪贴板条目列表（type + 内容）
 * @returns 解析结果；专用格式存在时优先
 */
export function parseBlockClipboard(
  entries: Array<{ type: string; content: string }>,
): BlockClipboardData | null {
  const custom = entries.find((e) => e.type === BLOCK_CLIPBOARD_MIME);
  if (custom) {
    try {
      const parsed = JSON.parse(custom.content) as Partial<BlockClipboardData>;
      if (parsed && typeof parsed.markdown === "string") {
        return {
          markdown: parsed.markdown,
          html: typeof parsed.html === "string" ? parsed.html : undefined,
          plain: typeof parsed.plain === "string" ? parsed.plain : undefined,
          from: typeof parsed.from === "number" ? parsed.from : 0,
          to: typeof parsed.to === "number" ? parsed.to : 0,
          at: typeof parsed.at === "number" ? parsed.at : 0,
        };
      }
    } catch {
      // 自定义格式损坏 → 落到 text/plain 分支
    }
  }
  const plain = entries.find((e) => e.type === "text/plain");
  if (plain && looksLikeMarkdown(plain.content)) {
    return { markdown: plain.content, from: 0, to: 0, at: 0 };
  }
  return null;
}

/** 围栏开行：0~3 空格缩进 + ``` 或 ~~~ + info string（info 串内容不限） */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*$/;
/** GFM 表格分隔行：每个单元格 ≥1 个 `-`（可带 `:` 对齐），两侧管道可省但至少一个 `|` */
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * 围栏代码块：行首开围栏 + 其后的同字符等长收围栏。
 *
 * v0.13.1 需求1：单独一个代码块（如 ```` ```js\ncode\n``` ````）只有 1 项特征，
 * 但它是一个**完整块构造**，必须按 Markdown 解析，否则粘贴到别的文档里就是
 * 一段字面反引号。
 */
function hasFencedCodeBlock(text: string): boolean {
  let open: { ch: string; len: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!open) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m) open = { ch: m[1][0], len: m[1].length };
      continue;
    }
    // 收围栏：整行只有同一种围栏字符，且不短于开围栏
    const t = line.trim();
    if (t.length >= open.len && open.ch.repeat(t.length) === t) return true;
  }
  return false;
}

/**
 * `$$` 定界块级公式：行首 `$$` + 同行或后续某行的 `$$` 收尾。
 *
 * 与 `katex-plugin.ts` 的 `mathBlock` 规则同口径（未闭合不算块）。
 */
function hasMathBlock(text: string): boolean {
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!open) {
      if (t.startsWith("$$")) {
        if (t.indexOf("$$", 2) !== -1) return true; // 同行闭合：$$x^2$$
        open = true;
      }
      continue;
    }
    if (t.endsWith("$$")) return true; // `$$` / `x^2$$` 收尾
  }
  return false;
}

/**
 * GFM 管道表格：分隔行（`| --- | --- |`）**且**其上一行是含管道的表头行。
 *
 * v0.13.1 需求1：表格成立与否取决于分隔行，而不是"管道行数 ≥2"——
 * `| a | b |` 单行（无分隔行）仍必须判 false（否则用户粘一行竖线文本会被强行解析成表格）。
 *
 * `clipboard-paste.ts` 复用本判定来甄别 turndown 是否把 HTML 表格拍平了。
 */
export function hasPipeTableMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row.includes("|") || !TABLE_DELIMITER_RE.test(row)) continue;
    const header = lines[i - 1];
    if (header.includes("|") && !TABLE_DELIMITER_RE.test(header)) return true;
  }
  return false;
}

/**
 * 纯文本是否**自身就是一个完整的 Markdown 块构造**（v0.13.1 需求1）。
 *
 * 三种块构造只要单独出现即成立（不需要凑够 2 项特征）：
 * 围栏代码块 / `$$` 公式块 / GFM 管道表格。
 *
 * 保守边界：单个成对标记的行内构造（`**bold**`、`*i*`）、单个列表项、单句引用
 * 都**不**在此判定内——它们与普通文本的边界模糊，必须走「≥2 项特征」那条线。
 */
export function isSelfContainedMarkdownBlock(text: string): boolean {
  if (!text) return false;
  return hasFencedCodeBlock(text) || hasMathBlock(text) || hasPipeTableMarkdown(text);
}

/**
 * 纯文本是否「像 Markdown」（本文件是**唯一**实现，`clipboard-paste.ts` 直接复用）。
 *
 * 两条判定线（v0.13.1 需求1 统一口径，取代原先两份各自维护的特征表）：
 *
 * 1. **自包含块结构**（`isSelfContainedMarkdownBlock`）：单个完整块构造即成立——
 *    阅读模式里复制一个代码块 / 表格 / 公式块再 Ctrl+V 粘贴，必须渲染出结构，
 *    不能因为"只命中 1 项特征"被当成字面文本。
 * 2. **特征累计 ≥2**：其余情况沿用保守口径，普通散文不会被误解析
 *    （`**粗体**`、`- 单个列表项`、`> 一句引用` 仍判 false）。
 *
 * 旧的「≥2 管道行 +2 分」口径已删除（表格由分隔行判定，管道行数不再加分）。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  if (isSelfContainedMarkdownBlock(text)) return true;
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(text)) score++;
  if (/^\s*[-*+]\s+\S/m.test(text)) score++;
  if (/^\s*\d{1,9}[.)]\s+\S/m.test(text)) score++;
  if (/^\s*>\s+\S/m.test(text)) score++;
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) score++;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) score++;
  if (/\*\*[^*\n]+\*\*/.test(text)) score++;
  // 斜体：两侧不能与 * 相邻，避免把 **粗体** 误判成斜体（否则单个粗体即凑满 2 项）
  if (/(?:^|[^*])\*[^*\s][^*\n]*\*(?:[^*]|$)/m.test(text)) score++;
  if (/~~[^~\n]+~~/.test(text)) score++;
  if (/`[^`\n]+`/.test(text)) score++;
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(text)) score++;
  return score >= 2;
}

/** 序列化专用 MIME 载荷（JSON 字符串） */
export function serializeBlockClipboard(data: BlockClipboardData): string {
  return JSON.stringify({
    markdown: data.markdown,
    html: data.html,
    plain: data.plain,
    from: data.from,
    to: data.to,
    at: data.at,
  });
}

/** 判断剪贴板条目里是否有可用的块数据（供「粘贴」菜单项 disabled 态） */
export function hasBlockClipboardData(
  entries: Array<{ type: string; content: string }>,
): boolean {
  return parseBlockClipboard(entries) !== null;
}
