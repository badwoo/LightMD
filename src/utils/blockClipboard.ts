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

/**
 * 纯文本是否「像 Markdown」（≥2 项特征）。
 *
 * 与 `clipboard-paste.ts` 保持同一组特征口径，避免两处判定漂移。
 *
 * 例外：**管道表格**（≥2 行管道行）单独出现即判定为 Markdown——它几乎不可能
 * 是普通文本（普通文本不会出现成排的 `|`），且表格块复制后粘贴回阅读模式
 * 必须走 Markdown 解析，不能按纯文本插入。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(text)) score++;
  if (/```/.test(text)) score++;
  if (/^\s*[-*+]\s+\S/m.test(text)) score++;
  if (/^\s*\d{1,9}[.)]\s+\S/m.test(text)) score++;
  if (/^\s*>\s/m.test(text)) score++;
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) score++;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) score++;
  if (/\*\*[^*]+\*\*/.test(text)) score++;
  if (/^\s*---\s*$/m.test(text)) score++;
  // 管道表格：≥2 行管道行 → 单独算 2 项（普通文本不会长这样）
  const pipeLines = text.split("\n").filter((l) => /\|/.test(l)).length;
  if (pipeLines >= 2) score += 2;
  else if (pipeLines === 1) score++;
  return score >= 2;
}

/** 序列化专用 MIME 载荷（JSON 字符串） */
export function serializeBlockClipboard(data: BlockClipboardData): string {
  return JSON.stringify({
    markdown: data.markdown,
    html: data.html,
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
