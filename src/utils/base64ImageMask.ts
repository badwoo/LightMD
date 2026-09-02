/**
 * base64ImageMask —— 源码模式 base64 内联图片的短格式展示（v0.6.6 问题4）
 *
 * 需求：base64 内联图片（![alt](data:image/png;base64,...)）在编辑/分屏模式
 * 的 textarea 中占用大量篇幅。存储格式不变（磁盘上仍写完整 base64），
 * 仅在源码显示层替换为短标记 ![alt](image-1.png)，保存/预览/导出前还原。
 *
 * 设计（虚拟内容方案）：
 * - mask：把超长 data URL 替换为短标记（image-N.ext），token 存于会话内 Map
 * - unmask：把短标记还原为完整 data URL（写盘/预览/上层同步前调用）
 * - adjustCursor：mask 后的光标补偿（token 远短于原文，光标需左移）
 * - 全部为纯函数，tokens 由调用方持有（EditorContainer 的 ref）
 *
 * 边界语义：
 * - 用户修改标记文本（如删改 image-1.png）→ unmask 找不到 token 时按普通
 *   文本保留（等同删除图片引用，与直接改坏 URL 行为一致，不会静默损坏数据）
 * - 相同 base64 重复出现 → 复用同一标记（tokens 值反向查找去重）
 */

/** 匹配 base64 data URL（png/jpeg/gif/webp/svg+xml 等常见 image mime） */
const DATA_URL_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** data URL 短于该长度不替换（小图标展开后收益低，徒增映射开销） */
const MIN_MASK_LENGTH = 512;

/** mime → 扩展名（标记展示更真实；未知类型回退 png） */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

/** 标记 → 完整 data URL 的映射（会话内有效，不持久化） */
export type Base64Tokens = Map<string, string>;

/** 单次替换的位置信息（masked 坐标系，用于光标补偿） */
export interface MaskReplacement {
  /** 被替换的 data URL 在原文中的起点 */
  start: number;
  /** 原文（真实内容）中被替换的长度 */
  oldLen: number;
  /** 替换后标记的长度 */
  newLen: number;
}

/** 快速检测文本是否含未替换的 base64 data URL（不分配匹配数组） */
export function hasRawBase64Image(text: string): boolean {
  if (!text.includes("base64,")) return false;
  DATA_URL_RE.lastIndex = 0;
  const m = DATA_URL_RE.exec(text);
  DATA_URL_RE.lastIndex = 0;
  return m !== null && m[0].length >= MIN_MASK_LENGTH;
}

/**
 * 把文本中的超长 base64 data URL 替换为短标记 image-N.ext
 *
 * @param text 原文（可能已含此前生成的标记，不受影响）
 * @param tokens 既有标记表（累积写入；新标记序号接续现有最大值）
 * @returns masked 文本 + 替换位置列表（无替换时 replacements 为空）
 */
export function maskBase64Images(
  text: string,
  tokens: Base64Tokens
): { text: string; replacements: MaskReplacement[] } {
  if (!text.includes("base64,")) return { text, replacements: [] };

  // 反向索引：dataUrl → marker（相同图片复用标记）
  const reverse = new Map<string, string>();
  for (const [marker, dataUrl] of tokens) reverse.set(dataUrl, marker);

  // 计算下一个序号（接续现有最大值）
  let nextId = 1;
  for (const marker of tokens.keys()) {
    const m = marker.match(/^image-(\d+)\./);
    if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
  }

  const replacements: MaskReplacement[] = [];
  // 先收集所有匹配（避免边替换边匹配的位置错位）
  const matches: { start: number; dataUrl: string }[] = [];
  DATA_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATA_URL_RE.exec(text)) !== null) {
    if (m[0].length >= MIN_MASK_LENGTH) {
      matches.push({ start: m.index, dataUrl: m[0] });
    }
  }
  DATA_URL_RE.lastIndex = 0;
  if (matches.length === 0) return { text, replacements: [] };

  // 正序分配标记（文档中先出现的 base64 拿小序号，重复内容复用同一标记）
  const markerOf: string[] = matches.map(({ dataUrl }) => {
    let marker = reverse.get(dataUrl);
    if (!marker) {
      const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
      const ext = MIME_EXT[mime] || "png";
      marker = `image-${nextId++}.${ext}`;
      tokens.set(marker, dataUrl);
      reverse.set(dataUrl, marker);
    }
    return marker;
  });

  // 从后往前替换（保证前面的偏移不受影响）
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, dataUrl } = matches[i];
    const marker = markerOf[i];
    result =
      result.slice(0, start) + marker + result.slice(start + dataUrl.length);
    replacements.push({
      start,
      oldLen: dataUrl.length,
      newLen: marker.length,
    });
  }
  // replacements 反转为正序（与文本顺序一致，便于光标补偿遍历）
  replacements.reverse();
  return { text: result, replacements };
}

/**
 * 把短标记还原为完整 data URL（写盘/预览/传给上层前调用）
 *
 * 快速路径：tokens 为空或文本不含任何标记时原样返回（零开销）
 */
export function unmaskBase64Images(text: string, tokens: Base64Tokens): string {
  if (tokens.size === 0 || !text.includes("image-")) return text;
  // 仅替换 markdown URL 上下文中的标记（](image-N.ext)），降低误替换普通文本的概率
  return text.replace(
    /\]\((image-\d+\.(?:png|jpg|gif|webp|svg|bmp|ico))\)/g,
    (full, marker: string) => {
      const dataUrl = tokens.get(marker);
      return dataUrl ? `](${dataUrl})` : full;
    }
  );
}

/**
 * mask 后的光标补偿：光标在替换区间之后则左移长度差，在区间内则贴到标记末尾
 *
 * @param cursor mask 前的光标位置（原文坐标）
 * @param replacements mask 返回的替换列表（正序）
 */
export function adjustCursorForMask(
  cursor: number,
  replacements: MaskReplacement[]
): number {
  let delta = 0;
  for (const r of replacements) {
    if (cursor >= r.start + r.oldLen) {
      delta += r.oldLen - r.newLen;
    } else if (cursor > r.start) {
      // 光标在被替换的 data URL 内部 → 贴到标记末尾
      return r.start + r.newLen;
    }
  }
  return cursor - delta;
}
