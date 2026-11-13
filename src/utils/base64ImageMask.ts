/**
 * base64ImageMask —— 源码模式 base64 内联图片的短格式展示（v0.6.6 问题4）
 *
 * 需求：base64 内联图片（![alt](data:image/png;base64,...)）在编辑/分屏模式
 * 的 textarea 中占用大量篇幅。存储格式不变（磁盘上仍写完整 base64），
 * 仅在源码显示层替换为短标记，保存/预览/导出前还原。
 *
 * 设计（虚拟内容方案）：
 * - mask：把超长 data URL 替换为短标记（`lmd-b64-1.png`），token 存于会话内 Map
 * - unmask：把短标记还原为完整 data URL（写盘/预览/上层同步前调用）
 * - adjustCursor：mask 后的光标补偿（token 远短于原文，光标需左移）
 * - 全部为纯函数，tokens 由调用方持有（EditorContainer 的 ref）
 *
 * 边界语义：
 * - 用户修改标记文本（如删改 `lmd-b64-1.png`）→ unmask 找不到 token 时按普通
 *   文本保留（等同删除图片引用，与直接改坏 URL 行为一致，不会静默损坏数据）
 * - 相同 base64 重复出现 → 复用同一标记（tokens 值反向查找去重）
 *
 * ## ═══ v0.17.0 第四轮 T6：标记命名必须**不可与真实文件撞名** ═══
 *
 * ### 旧命名的缺陷（静默数据损坏，P1）
 * v0.6.6 起的标记形如 `image-1.png`，而 unmask 靠
 * `/\]\((image-\d+\.(?:png|…))\)/g` 匹配 —— **只看 `](...)` 内部，不看标记来源**。
 * 于是当文档同时满足：
 * 1. 有 base64 内联图 → mask 生成 `image-1.png`
 * 2. 另有一张**真实本地图**，引用恰好写成**裸文件名** `image-1.png`（无 `./` / `assets/` 前缀）
 * 3. 走到任何 unmask 出口（切模式 / 保存 / `onContentChange` / 预览）
 *
 * → 那张**真实图被替换成另一张图的完整 base64**。实测（jsdom + 真实 EditorContainer）：
 * ```
 * 展示层 = "# 标题\n\n![img](image-1.png)\n\n![real](image-1.png)\n\n正文\n"
 * 切到 preview 后 onContentChange:
 *   真实引用仍在? false    被吞成 base64? true
 * ```
 * 用户视角：编辑模式看图正常 → 切阅读模式 / 一保存 → 真图变别的图或被塞进 base64。
 * **不报错、不提示**，是最危险的一类。
 *
 * ### 为什么选"改标记命名"而不是"unmask 只替换本次插入位置"
 * 后者需要把 `replacements` 一路传到 unmask，而 unmask 有 **40+ 调用点**，
 * 其中多处在 `contentRef` / `sourceContentRef` 上**直接 unmask，根本拿不到 mask 返回值**
 * （如 `EditorContainer.tsx:767/917/941`）；且位置信息在跨模式/跨文档后必然失效
 * （用户可能已编辑文本）。→ 架构上不可行。
 *
 * ### 新命名的选型理由
 * `lmd-b64-<n>.<ext>`：
 * - **含连字符的非自然文件名**：真实图片几乎不会叫 `lmd-b64-1.png`（前缀是本项目专用缩写）；
 * - **固定、无随机数**：保证 `mask → unmask → mask` **幂等**，测试可重放
 *   （随机/时间戳前缀会让每轮生成不同标记，tokens 无限膨胀且断言不可复现）；
 * - **保留序号 + 扩展名**：仍符合"短格式"观感（用户看得出是一张 png），
 *   且序号接续逻辑（相同图复用、新图递增）完全不变；
 * - 只用 `[a-z0-9-]`：不会与 markdown 语法字符（`()[]*_\` 等）冲突，URL 内无需转义。
 *
 * ⚠️ 旧格式 `image-N.ext` 现在**一律不再被还原**（当作普通文本/真实文件名保留）。
 * 这是**故意的行为改变**：它可能是用户文档里真实存在的文件，宁可不动也不能猜。
 * 标记从不落盘（见上"存储格式不变"），所以不存在"旧文档里的标记失效"问题；
 * 会话内的旧 tokens 随 `new Map()`（换文档）一起被 GC，无泄漏、无误还原风险。
 */

/** 匹配 base64 data URL（png/jpeg/gif/webp/svg+xml 等常见 image mime） */
const DATA_URL_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/**
 * 短标记的前缀（**改这里等于改协议**，必须与 `MARKER_IN_URL_RE` 同步）。
 *
 * 见文件头「新命名的选型理由」。不可用随机/时间戳段 —— 会破坏幂等性。
 */
const MARKER_PREFIX = "lmd-b64-";

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
  // ⚠️ 只认**新前缀**的标记：旧格式 `image-N.ext` 可能是真实文件名（见文件头 T6 说明），
  // 不能拿它续序号，否则会和用户自己的文件抢号。
  let nextId = 1;
  for (const marker of tokens.keys()) {
    const m = marker.match(/^lmd-b64-(\d+)\./);
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
      marker = `${MARKER_PREFIX}${nextId++}.${ext}`;
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
 * 短标记在 markdown URL 上下文中的形态（unmask 与 countBase64Markers **共用**，禁止各写一份）
 *
 * ## 正则为什么长这样（v0.17.0 第四轮 T6）
 * 1. 前缀固定为 `MARKER_PREFIX`（`lmd-b64-`），不是宽泛的 `image-` ——
 *    这是"不撞真实文件名"的第一层保证；
 * 2. 只匹配 `](...)` 形式（markdown 图片/链接的 URL 位）→ 普通正文里出现
 *    `lmd-b64-1.png` 字样不会被误替换（既有契约，测试锁死）；
 * 3. **仍需靠 tokens 存在性兜底**：用户理论上可以自己建一个叫
 *    `lmd-b64-1.png` 的文件 —— 那种情形下 `tokens.get()` 找不到 → 原样保留。
 *    两层（命名不可撞 + tokens 兜底）叠加才安全，只靠任何一层都不够。
 *
 * ⚠️ 与 `maskBase64Images` 里生成标记的模板串**必须**用同一个 `MARKER_PREFIX`。
 */
const MARKER_IN_URL_RE = new RegExp(
  String.raw`\]\((${MARKER_PREFIX}\d+\.(?:png|jpg|gif|webp|svg|bmp|ico))\)`,
  "g",
);

/**
 * 把短标记还原为完整 data URL（写盘/预览/传给上层前调用）
 *
 * 快速路径：tokens 为空或文本不含任何标记时原样返回（零开销）
 */
export function unmaskBase64Images(text: string, tokens: Base64Tokens): string {
  // 快速路径：tokens 为空，或文本里连标记前缀都没有 → 原样返回（零开销）。
  // ⚠️ 这里必须用 `MARKER_PREFIX` 而不是旧的 `"image-"`：新命名下
  // `image-` 这个词在绝大多数文档里都会命中（比如正文提到"图片 image-"），
  // 那样快速路径等于失效，每次调用都要跑一遍全文正则。
  if (tokens.size === 0 || !text.includes(MARKER_PREFIX)) return text;
  // 仅替换 markdown URL 上下文中的标记（](lmd-b64-N.ext)），降低误替换普通文本的概率。
  // ⚠️ 匹配式与 `countBase64Markers` **共用同一个常量** —— 两处口径一旦分叉，
  // "校验通过但还原不出来"（或反之）就会成为静默数据损坏的来源。
  MARKER_IN_URL_RE.lastIndex = 0;
  const out = text.replace(MARKER_IN_URL_RE, (full, marker: string) => {
    const dataUrl = tokens.get(marker);
    return dataUrl ? `](${dataUrl})` : full;
  });
  MARKER_IN_URL_RE.lastIndex = 0;
  return out;
}

/**
 * 统计文本里每个短标记出现的次数（多重集）。
 *
 * ## 为什么需要它（v0.17.0 第三轮 #9-C 数据安全）
 *
 * AI 全文翻译的**最危险失败模式**不是"翻译质量差"，而是：
 * 译文把 `lmd-b64-1.png` 当普通文本改掉（译成"图片-1.png"），于是 `unmask`
 * 在返回文本里找不到任何标记 —— 图片**静默变成一行坏链接**，用户保存后
 * 磁盘上的 base64 就永久丢了。
 *
 * 所以回写前必须能回答"译文里每个标记都还在吗"。这里返回多重集（Map），
 * 让调用方可以逐标记比对次数（同一张图被引用两次，就必须剩两次），
 * 而不是只看"有没有出现过标记前缀"这种恒真的弱判据。
 *
 * 与 `unmaskBase64Images` 使用**同一个**匹配式，避免"计数的口径"
 * 与"还原的口径"分叉（那会让校验通过、还原失败）。
 */
export function countBase64Markers(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text.includes(MARKER_PREFIX)) return counts;
  MARKER_IN_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_IN_URL_RE.exec(text)) !== null) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  MARKER_IN_URL_RE.lastIndex = 0;
  return counts;
}

/**
 * 两个文本的短标记**多重集**是否完全一致。
 *
 * 用于「译文回写前的图片完整性闸门」：不一致 → 拒绝回写（保留原文），
 * 宁可这一轮白翻译，也不能写出丢了图片引用的文档。
 */
export function sameBase64Markers(a: string, b: string): boolean {
  const ca = countBase64Markers(a);
  const cb = countBase64Markers(b);
  if (ca.size !== cb.size) return false;
  for (const [marker, n] of ca) {
    if (cb.get(marker) !== n) return false;
  }
  return true;
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
