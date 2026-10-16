/**
 * 图片管理面板 —— 纯函数层（v0.13.0 需求11）
 *
 * 作用域：**只管当前文档**（v1 用户确认）。面板扫当前 PM doc 的 image 节点，
 * 给出「转 assets / 转 base64 / 重命名 / 清理未引用」四个操作所需的全部计算结果；
 * 真正落盘的 IO（读源 / 写 assets / rename / 删除）由组件侧完成。
 *
 * 设计约束（v1 决策 + v0.9.0 问题3 教训）：
 * 1. 删除**必须**走回收站（file_ops::delete_file → trash），本模块不碰删除；
 * 2. 「转 assets」**不删源文件**，只改引用；
 * 3. 所有写盘由调用方 noteSelfWrittenFile，本模块同样不碰 IO。
 *
 * 为什么抽纯函数：面板的三个操作各有一次「算 → 做」两步，计算部分是
 * 可枚举的真值表（计数、差集、目标路径冲突消解），用单测锁死；
 * IO 部分在 jsdom 里不可测，留给组件层的既有 mock 机制。
 *
 * ─── v0.13.0 第三轮返修（⑩⑪⑫⑬）───────────────────────────────
 * ⑩ 面板必须**逐图自动判定**引用形态（内联 base64 / 磁盘文件 / 真远程），
 *    并给出**相反方向**的转换按钮；同时 Tauri 的 `asset.localhost` URL
 *    必须解码回本地绝对路径（旧实现按 `http:` 前缀判定 → 本地文件被当成
 *    远程图，重命名 / 转存 / 转 base64 全部拿不到磁盘路径而失败）。
 * ⑪⑫ 列表必须**按文档顺序、一次出现一行**；旧实现按 src 合并，
 *    同一文件引用两次就少一行（用户的文档因此 5 处引用只列出 3 行）。
 * ⑬ 重命名只让用户编辑**主名**，扩展名保持原样。
 */
import type { Node } from "prosemirror-model";

/** 面板中的一张图片（同 src 合并计数） */
export interface DocImage {
  /** 文档中的原始引用串（如 ./assets/a.png / data:... / D:/x/y.png） */
  src: string;
  /** 首个命中的 alt（同 src 多引用时取第一个非空 alt） */
  alt: string;
  /** 该 src 在文档中的出现次数 */
  count: number;
  /** 该 src 在文档中的 image 节点数（与 count 同义，保留便于断言） */
  nodeCount: number;
  /** 首个命中的 width（px；null=未设置） */
  width: number | null;
  /** 首个命中的对齐（left=未设置） */
  align: "left" | "center" | "right";
  /**
   * ⑫ 该引用在文档中的出现序号（0 基，按文档顺序）。
   *
   * collectDocImages 合并行取**首次出现**的序号；collectDocImageOccurrences
   * 每行一个出现，序号即行序。面板用稳定序号做 React key 与「序号」列，
   * 保证同一 src 的多行不会互相顶掉。
   */
  docIndex: number;
}

/** 外部图片（不在文档目录内的相对引用之外的形态） */
const DATA_URL_RE = /^data:/i;
const REMOTE_URL_RE = /^(?:https?:|asset:|blob:|tauri:)/i;
const ABS_WIN_RE = /^[A-Za-z]:[\\/]/;

/** 图片扩展名（用于「只编辑主名」时宽容地剥掉用户顺手打进来的后缀） */
const IMAGE_EXT_RE = /^\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;

/** mime ↔ 扩展名（转 base64 / base64 转 assets 两个方向都要用） */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/**
 * 扫描 doc 中全部 image 节点，按 src 合并为 DocImage[]。
 *
 * 顺序按**首次出现顺序**（面板展示与用户的直觉一致：文档第 3 张图
 * 排在列表第 3 位，而不是按哈希乱序）。
 *
 * 注意：面板**不再使用**本函数（⑫ 要求一次出现一行），保留它是为了
 * 兼容既有的合并语义与单测；面板走 collectDocImageOccurrences。
 */
export function collectDocImages(doc: Node): DocImage[] {
  const bySrc = new Map<string, DocImage>();
  let occurrence = 0;
  doc.descendants((node) => {
    if (node.type.name !== "image") return true;
    const src = String(node.attrs.src ?? "");
    if (!src) return true;
    const docIndex = occurrence;
    occurrence += 1;
    const alt = String(node.attrs.alt ?? "");
    const widthRaw = node.attrs.width;
    const width = typeof widthRaw === "number" && widthRaw > 0 ? widthRaw : null;
    const alignRaw = node.attrs.align;
    const align =
      alignRaw === "center" || alignRaw === "right" ? alignRaw : "left";
    const existing = bySrc.get(src);
    if (existing) {
      existing.count += 1;
      existing.nodeCount += 1;
      // 首个非空 alt / 首个 width / 首个非 left 对齐才覆盖（保持"首张"语义）
      if (!existing.alt && alt) existing.alt = alt;
      if (existing.width === null && width !== null) existing.width = width;
      if (existing.align === "left" && align !== "left") existing.align = align;
    } else {
      bySrc.set(src, { src, alt, count: 1, nodeCount: 1, width, align, docIndex });
    }
    return false;
  });
  return [...bySrc.values()];
}

/**
 * ⑪⑫ 面板数据源：**一次出现一行**，严格按文档顺序。
 *
 * 缺陷背景（⑫）：旧面板用 collectDocImages，它按 src 合并。
 * 用户的文档里 `./assets/image-4.png` 被引用两次，于是「文档里 5 处图片引用」
 * 在面板上只显示 3 行，用户数不出自己文档里的图片。
 *
 * 每行的 `count` 仍然是**该 src 在全文的出现次数**（面板「引用」列），
 * 因此「重命名 / 转 assets / 转 base64 / 清理未引用」依旧作用于同一 src 的
 * **全部出现**（引用改写走整串替换，见 App.handleImageRefsRewrite）。
 */
export function collectDocImageOccurrences(doc: Node): DocImage[] {
  const rows: DocImage[] = [];
  const totalBySrc = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name !== "image") return true;
    const src = String(node.attrs.src ?? "");
    if (!src) return true;
    const alt = String(node.attrs.alt ?? "");
    const widthRaw = node.attrs.width;
    const width = typeof widthRaw === "number" && widthRaw > 0 ? widthRaw : null;
    const alignRaw = node.attrs.align;
    const align =
      alignRaw === "center" || alignRaw === "right" ? alignRaw : "left";
    rows.push({ src, alt, count: 1, nodeCount: 1, width, align, docIndex: rows.length });
    totalBySrc.set(src, (totalBySrc.get(src) ?? 0) + 1);
    return false;
  });
  // 回填同一 src 的引用总数：同一 src 的每一行都显示同一个总数，
  // 用户既能数出「文档里有几处」，也知道「这一行代表的那张图被引用了几次」。
  for (const row of rows) {
    const total = totalBySrc.get(row.src) ?? 1;
    row.count = total;
    row.nodeCount = total;
  }
  return rows;
}

/**
 * v0.13.0 返修（问题6）：文档中是否至少有一张图片。
 *
 * 用于决定右上角「图片管理」悬浮入口是否显示——用户明确要求
 * **只有文档中有图片才会显示该图标**。
 *
 * 纯函数 + 早停（找到第一张即返回），不做整篇收集，避免大文档每次渲染都全量遍历。
 */
export function docHasImage(doc: Node | null | undefined): boolean {
  if (!doc) return false;
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "image" && String(node.attrs.src ?? "")) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** Markdown 图片语法：`![alt](src)`；src 不可为空 */
const IMAGE_SYNTAX_RE = /!\[[^\]]*\]\(\s*[^)\s][^)]*\)/;

/**
 * v0.13.0 返修（问题6）：**源码模式**下文档是否含图片。
 *
 * 源码模式（edit）没有 ProseMirror 视图，拿不到文档树，只能在 Markdown 文本上判断。
 * 先剔除围栏代码块（``` / ~~~）与行内代码，避免把「代码示例里的 `![x](y)`」
 * 误判成真实图片——那正是用户会看到的假入口。
 */
export function markdownHasImage(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  const stripped = markdown
    // 围栏代码块（含语言标识与缩进），整体删除
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, "")
    // 行内代码
    .replace(/`[^`\n]*`/g, "");
  return IMAGE_SYNTAX_RE.test(stripped);
}

// ─── ⑩ 引用形态判定 / asset.localhost 解码 ─────────────────────

/**
 * ⑩ 把 Tauri 的 asset 协议 URL 解码回**本地绝对路径**。
 *
 * 缺陷背景：webview 渲染图片时，schema.toDOM 会用 `convertFileSrc()` 把
 * 本地绝对路径转成 `http://asset.localhost/<百分号编码的绝对路径>`。
 * 用户从渲染结果里复制/粘贴（或文档本身就是这么存的）时，Markdown 里留下的
 * 就是这种 URL。旧面板只按 `http:` 前缀判定 → 把它当成**远程图片**：
 *   · 重命名 / 转 assets 拿不到磁盘路径（拼出 `D:/docs/http://asset.localhost/...`）；
 *   · 「转 base64」更是永远不出现（远程图不提供该操作）。
 *
 * 解码规则：剥掉 `http(s)://asset.localhost/`（或 `asset://localhost/`）前缀，
 * 再 `decodeURIComponent`（`%3A` → `:`、`%2F` → `/`）。
 *
 * @returns 本地绝对路径（正斜杠）；不是 asset URL 或解码失败时返回 null
 */
export function decodeAssetLocalhostSrc(src: string): string | null {
  if (!src) return null;
  const m =
    /^https?:\/\/asset\.localhost\/([^?#]*)/i.exec(src) ??
    /^asset:\/\/localhost\/([^?#]*)/i.exec(src);
  if (!m) return null;
  const raw = m[1];
  if (!raw) return null;
  return percentDecode(raw).replace(/\\/g, "/");
}

/**
 * 百分号解码：非法序列**原样保留**而不是整体放弃。
 *
 * 用 `decodeURIComponent` 的话，一个畸形 `%ZZ` 就会让整个串退回未解码状态，
 * 于是 `D%3A%2F...` 这种"大部分合法、个别非法"的路径连盘符都还原不出来。
 * 这里逐段解码：能解的解，解不了的留原样。
 */
function percentDecode(input: string): string {
  return input.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** 与 percentDecode 对应的整体编码（asset URL 的路径段约定：/ 与 : 都要编码） */
function percentEncodePath(path: string): string {
  return encodeURIComponent(path);
}

/**
 * ⑩ 把 asset.localhost URL 的**路径部分**换成新文件名后重新编码。
 *
 * 关键：asset URL 里没有真实的分隔斜杠（`D%3A%2F...%2Fassets%2Fimage-3.png`），
 * 所以不能按字面 `/` 切前缀——那样只会得到 `http://asset.localhost/renamed.png`，
 * 把整个目录信息丢掉。必须先解码 → 换名 → 按原约定重新编码。
 */
function rebuildAssetSrc(src: string, newFileName: string): string | null {
  const decoded = decodeAssetLocalhostSrc(src);
  if (!decoded) return null;
  const dir = decoded.slice(0, decoded.lastIndexOf("/") + 1);
  const prefix = /^https?:\/\//i.test(src) ? "http://asset.localhost/" : "asset://localhost/";
  return `${prefix}${percentEncodePath(`${dir}${newFileName}`)}`;
}

/**
 * ⑩ 生成「换了文件名之后」的新引用（保留原引用的形态与目录前缀）。
 *
 * - asset.localhost URL → 解码换名再重新编码（保留 URL 形态）；
 * - 其它（相对 / 绝对 / 裸文件名）→ 原样保留目录前缀。
 */
export function renameSrcTo(src: string, newFileName: string): string {
  const rebuilt = rebuildAssetSrc(src, newFileName);
  if (rebuilt) return rebuilt;
  return `${dirPrefixOf(src)}${newFileName}`;
}

/** ⑩ 图片引用的来源形态 */
export type ImageSourceKind = "base64" | "file" | "remote";

/**
 * ⑩ 逐图判定引用形态（面板据此决定显示哪个转换按钮）。
 *
 * - `base64`：内联 data URL；
 * - `file`  ：磁盘上的真实文件（相对 / 绝对路径，以及解码后的 asset.localhost）；
 * - `remote`：真远程（http(s) / blob: / tauri: / 非 localhost 的 asset:）。
 */
export function imageSourceKind(src: string): ImageSourceKind {
  if (!src) return "file";
  if (DATA_URL_RE.test(src)) return "base64";
  // 必须先于 REMOTE_URL_RE 判定：asset.localhost 是本地文件
  if (decodeAssetLocalhostSrc(src)) return "file";
  if (REMOTE_URL_RE.test(src)) return "remote";
  return "file";
}

/** ⑩ 每张图给出的**相反方向**转换 */
export type OppositeConversion = "toAssets" | "toBase64";

/**
 * ⑩ 该图的相反转换：base64 / 远程 → 转 assets；磁盘文件 → 转 base64。
 */
export function oppositeConversionOf(src: string): OppositeConversion {
  return imageSourceKind(src) === "file" ? "toBase64" : "toAssets";
}

/**
 * 转 assets 是否需要用户确认（外部图片）。
 *
 * 判定：**相对路径之外**的引用（http(s)/data/绝对路径）需要复制到 assets。
 * 相对路径（./ / ../ / 不带协议与盘符的裸文件名）已经在文档目录内，
 * 转 assets 只是把文件搬进 assets/ 子目录，仍可安全提示。
 *
 * ⑩ 修正：`asset.localhost` 是**本地文件的 URL 形态**，解码后属于本地文件，
 * 不能被 `http:` 前缀误判为远程（否则 planAssetsMigration 会走"先读源"分支，
 * 而那个源路径是拼错的 URL）。真远程（`https://a.com/x.png`）行为不变。
 */
export function isExternalImageSrc(src: string): boolean {
  if (!src) return false;
  if (decodeAssetLocalhostSrc(src)) return false;
  return DATA_URL_RE.test(src) || REMOTE_URL_RE.test(src) || ABS_WIN_RE.test(src);
}

/**
 * 从 src 取文件名（含扩展名）。
 * 相对路径与绝对路径都按 / 与 \ 的最后一段取；query/hash 一并剥掉。
 * ⑩ 修正：asset.localhost 先解码再取末段（否则拿到的是百分号编码串）。
 */
export function imageFileNameOf(src: string): string {
  if (!src) return "";
  // data URL 没有文件名（末段是 base64 载荷），返回空串让调用方拒绝迁移
  if (DATA_URL_RE.test(src)) return "";
  const decoded = decodeAssetLocalhostSrc(src) ?? src;
  const cleaned = decoded.split(/[?#]/)[0];
  // 以 / 或 \ 结尾 = 目录形态，没有文件名（面板只处理真实图片引用，
  // 但 planRename 等纯函数不能因此产出 "./ab.png" 这种错位路径）
  if (/[\\/]$/.test(cleaned)) return "";
  const segs = cleaned.split(/[\\/]/).filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : "";
}

/** 主名（不含扩展名） */
function baseNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** 扩展名（含点；无扩展名返回空串） */
function extNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : "";
}

/** ⑬ 面板只编辑主名：取主名（不含扩展名） */
export function imageBaseNameOf(src: string): string {
  return baseNameOf(imageFileNameOf(src));
}

/** ⑬ 面板只编辑主名：取扩展名（含点；无扩展名返回空串） */
export function imageExtNameOf(src: string): string {
  return extNameOf(imageFileNameOf(src));
}

/**
 * 引用串的目录前缀（保留原始形态：`./` / `../` / `assets/` / asset URL 前缀）。
 *
 * 用**原始串**（未解码）的最后一段切分，避免文件名含百分号编码时错位：
 * `http://asset.localhost/D%3A%2F...%2Fassets%2F%E5%9B%BE.png` 的前缀必须原样保留。
 */
function dirPrefixOf(src: string): string {
  const cleaned = src.split(/[?#]/)[0];
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? src.slice(0, idx + 1) : "";
}

/**
 * 消解目标文件名冲突（与 ImagePasteDialog.generateUniqueFileName 同规则：
 * name.png → name-1.png → name-2.png）。
 *
 * @param existingNames assets 目录中已存在的文件名集合
 * @param desired 期望文件名
 */
export function resolveUniqueFileName(
  existingNames: Iterable<string>,
  desired: string,
): string {
  const taken = new Set(existingNames);
  if (!taken.has(desired)) return desired;
  const base = baseNameOf(desired);
  const ext = extNameOf(desired);
  let idx = 1;
  let candidate = `${base}-${idx}${ext}`;
  while (taken.has(candidate)) {
    idx += 1;
    candidate = `${base}-${idx}${ext}`;
  }
  return candidate;
}

/**
 * ⑩ 该引用指向的文件是否**已经住在某个 assets/ 目录里**（判断「转 assets」是否还有意义）。
 *
 * 先解码 asset.localhost（否则拿到的是百分号编码串，看不出目录结构），
 * 再取目录部分判断末段是否为 `assets`。
 *
 * 真远程与内联图不算——它们的 URL/载荷里即使出现 `assets/` 也不是本地目录。
 */
export function livesInAssetsDir(src: string): boolean {
  if (!src) return false;
  const decoded = decodeAssetLocalhostSrc(src);
  // 真远程 / 内联图不是"本地 assets 目录里的文件"，即便 URL 路径里含 /assets/
  if (!decoded && (DATA_URL_RE.test(src) || REMOTE_URL_RE.test(src))) return false;
  const clean = (decoded ?? src).split(/[?#]/)[0].replace(/\\/g, "/");
  const dir = clean.slice(0, clean.lastIndexOf("/") + 1);
  return /(?:^|\/)assets\/$/i.test(dir);
}

/** 迁移计划：转 assets 的目标相对引用 + 需要写入的目标文件名 */
export interface AssetsMigrationPlan {
  /** 相对引用（assets/<name>，与 ImagePasteDialog 的 assets 模式一致） */
  newSrc: string;
  /** assets 目录中的目标文件名（已做冲突消解） */
  fileName: string;
  /** 是否需要真的复制文件（外部图源） */
  needsCopy: boolean;
}

/**
 * 计算「转 assets」计划：目标文件名 + 新的相对引用。
 *
 * 规则（与 ImageInsertDialog/ImagePasteDialog 的 assets 模式对齐）：
 * - 新引用统一为 `assets/<name>`（**不带** `./`，与既有插入形态一致）；
 * - 文件名保留原名，冲突时追加 -1/-2；
 * - data/远程/绝对路径 → needsCopy=true（必须先读源再写）。
 *
 * 兼容语义：data URL 没有文件名 → 返回 null（历史行为，单测锁定）。
 * 面板走 planConvertToAssets（⑩ 要求 base64 也能转 assets）。
 */
export function planAssetsMigration(
  img: Pick<DocImage, "src">,
  existingNames: Iterable<string>,
): AssetsMigrationPlan | null {
  const fileName = imageFileNameOf(img.src);
  if (!fileName) return null;
  const unique = resolveUniqueFileName(existingNames, fileName);
  return {
    newSrc: `assets/${unique}`,
    fileName: unique,
    needsCopy: isExternalImageSrc(img.src),
  };
}

/**
 * ⑩ 面板用的「转 assets」计划：与 planAssetsMigration 的唯一差别是
 * **data URL 也能转**（按 mime 合成 `image.png` 之类的文件名）。
 *
 * 缺陷背景：base64 图片在旧面板上点「转 assets」永远得到「转存失败」——
 * 因为 data URL 取不出文件名。而 ⑩ 明确要求 base64 的相反操作就是转 assets，
 * 即"把内联图落盘成 assets 里的文件"。
 */
export function planConvertToAssets(
  src: string,
  existingNames: Iterable<string>,
): AssetsMigrationPlan | null {
  const fileName = suggestedFileNameForSrc(src);
  if (!fileName) return null;
  const unique = resolveUniqueFileName(existingNames, fileName);
  return {
    newSrc: `assets/${unique}`,
    fileName: unique,
    // ⑩ asset.localhost 解码后是本地文件：只改引用，不复制（避免自我复制）
    needsCopy: isExternalImageSrc(src) || !isLocalFileRef(src),
  };
}

/** 引用是否指向一个**本地文件**（相对路径 / 绝对路径 / asset.localhost 解码结果） */
export function isLocalFileRef(src: string): boolean {
  if (!src) return false;
  if (DATA_URL_RE.test(src)) return false;
  if (decodeAssetLocalhostSrc(src)) return true;
  if (REMOTE_URL_RE.test(src)) return false;
  return true;
}

/**
 * ⑩ 目标文件名建议值：普通引用取原名；data URL 按 mime 合成 `image.<ext>`。
 * 取不到任何名字时返回空串（调用方据此提示失败）。
 */
export function suggestedFileNameForSrc(src: string): string {
  const name = imageFileNameOf(src);
  if (name) return name;
  const parsed = parseDataUrl(src);
  if (parsed) return `image.${extensionForMime(parsed.mime)}`;
  return "";
}

/**
 * 磁盘文件中未被**本文档**引用的图片。
 *
 * @param diskNames assets 目录中的文件名字符串（不含子目录）
 * @param docImages collectDocImages / collectDocImageOccurrences 的结果
 * @returns 未被引用的文件名（保持 diskNames 原顺序）
 *
 * ⑫：入参可能是「一次出现一行」的列表，用 Set 去重后语义不变。
 */
export function findUnreferenced(
  diskNames: string[],
  docImages: DocImage[],
): string[] {
  const referenced = new Set<string>();
  for (const img of docImages) {
    const name = imageFileNameOf(img.src);
    if (name) referenced.add(name);
  }
  return diskNames.filter((name) => !referenced.has(name));
}

/** 重命名计划：新引用 + 旧引用（供全局替换） */
export interface RenamePlan {
  oldSrc: string;
  newSrc: string;
  fileName: string;
}

/**
 * 计算重命名后的引用。
 *
 * v0.13.0 返修：补上**目标名冲突**与**同名空操作**的拒绝。
 * 缺陷背景：旧实现只校验「新名非空」，于是
 *   · 批量把多张图改成同一个名字 → 第二张开始 Rust `rename_file` 报错，
 *     批量操作**中途失败**、留下部分完成的状态；
 *   · 改成与原名相同 → 产生一次无意义的 rename（部分文件系统上直接报错）。
 *
 * @param src 原引用
 * @param newName 新文件名（不含目录；调用方已校验）
 * @param existingNames 已存在的文件名集合（可选；传入时启用冲突检查）
 * @returns 新引用；非法 / 同名 / 冲突时返回 null
 */
export function planRename(
  src: string,
  newName: string,
  existingNames?: Iterable<string>,
): RenamePlan | null {
  const trimmed = newName.trim();
  if (!trimmed) return null;
  const oldName = imageFileNameOf(src);
  if (!oldName) return null;
  // 同名 → 无操作（不产生事务，也不调 rename_file）
  if (trimmed === oldName) return null;
  if (existingNames) {
    const lower = trimmed.toLowerCase();
    for (const n of existingNames) {
      // 忽略自身（大小写不敏感，与文件系统常见行为一致）
      if (typeof n === "string" && n !== oldName && n.toLowerCase() === lower) return null;
    }
  }
  // 保留原引用的目录前缀（./ / ../ / 绝对目录 / assets/）
  return { oldSrc: src, newSrc: `${dirPrefixOf(src)}${trimmed}`, fileName: trimmed };
}

/**
 * ⑬ 只编辑**主名**的重命名计划：扩展名保持原样（"图片格式后缀名保持原样"）。
 *
 * 缺陷背景：旧面板把「a.png」整个放进输入框，用户想改个名字就得把
 * `.png` 一起重打一遍；漏打后缀 → 图片变成无扩展名文件，Markdown 也
 * 不再是图片语法（编辑器里直接裂图）。
 *
 * 规则：
 * - 只接收主名；后缀自动沿用原名（原名无后缀则保持无后缀）；
 * - 宽容处理：用户顺手把后缀（原后缀或常见图片后缀）打进来时自动剥掉，
 *   不会产出 `b.png.png`；
 * - 空主名 / 与原名相同（无操作）/ 与其它文件重名 → null。
 *
 * @param src 原引用
 * @param newBaseName 新主名（不含扩展名；调用方已 trim）
 * @param existingNames 已存在的文件名集合（可选；传入时启用冲突检查）
 */
export function planRenameBaseName(
  src: string,
  newBaseName: string,
  existingNames?: Iterable<string>,
): RenamePlan | null {
  const oldName = imageFileNameOf(src);
  if (!oldName) return null;
  const oldBase = baseNameOf(oldName);
  const oldExt = extNameOf(oldName);

  let base = newBaseName.trim();
  if (!base) return null;
  // 用户把后缀一起打进来了（旧习惯）：剥掉，后缀由原名决定
  const typedExt = extNameOf(base);
  if (typedExt && IMAGE_EXT_RE.test(typedExt) && base.length > typedExt.length) {
    base = base.slice(0, base.length - typedExt.length);
  }
  // 只打了后缀（".png"）/ 只剩点号 / 空 → 没有可用的主名，判非法。
  // （以点开头的隐藏文件名也不是图片的合理主名，一并拒绝。）
  if (!base || base.startsWith(".")) return null;
  // 主名没变 → 无操作（与 planRename 的同名拒绝同源）
  if (base === oldBase) return null;

  const newName = `${base}${oldExt}`;
  if (existingNames) {
    const lower = newName.toLowerCase();
    for (const n of existingNames) {
      if (typeof n === "string" && n !== oldName && n.toLowerCase() === lower) return null;
    }
  }
  return { oldSrc: src, newSrc: renameSrcTo(src, newName), fileName: newName };
}

/** 面板条目在文档中的删除结果统计 */
export interface ReplaceRefsSummary {
  /** 替换发生的次数 */
  replaced: number;
}

/**
 * 汇总文档中 oldSrc → newSrc 的替换计划（不执行，仅统计）。
 * 组件侧据此提示「N 处引用已更新」。
 *
 * ⑫：入参为「一次出现一行」时，find 命中的首行 count 即该 src 的总出现次数。
 */
export function countRefsOf(docImages: DocImage[], src: string): number {
  const hit = docImages.find((i) => i.src === src);
  return hit ? hit.count : 0;
}

/** 供测试断言的空统计（保持接口对称） */
export function emptyReplaceSummary(): ReplaceRefsSummary {
  return { replaced: 0 };
}

// ─── ⑩ 路径解析 / base64 编解码 / mime 推断 ────────────────────

/**
 * ⑩ 把图片引用解析为**磁盘绝对路径**（正斜杠）。
 *
 * - asset.localhost URL → 解码后的本地绝对路径；
 * - Windows 绝对路径 / Unix 绝对路径 → 归一化；
 * - 相对路径 → 基于 docDir 拼接（处理 `.` 与 `..`）；
 * - data / 真远程 / 无 docDir 的相对路径 → null（调用方据此禁用按钮）。
 */
export function resolveImageAbsPath(
  src: string,
  docDir: string | null,
): string | null {
  if (!src) return null;
  if (DATA_URL_RE.test(src)) return null;
  const decoded = decodeAssetLocalhostSrc(src);
  if (decoded) return decoded;
  // 到这里仍是 http(s)/blob/tauri → 真远程，没有本地路径
  if (REMOTE_URL_RE.test(src)) return null;
  const clean = src.split(/[?#]/)[0].replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(clean)) return clean;
  if (clean.startsWith("/")) return clean;
  if (!docDir) return null;
  return joinPosix(docDir, clean);
}

/** 纯字符串路径拼接（保留盘符，处理 `.` / `..`） */
function joinPosix(base: string, rel: string): string {
  const parts = base.replace(/\\/g, "/").split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * ─── v0.13.1 需求9：「本地文件」徽标点击 → 资源管理器定位 ──────────────
 *
 * 「本地文件」徽标要能一键在系统资源管理器中打开该图片所在目录并选中它
 * （既有链路：fileService.revealInFolder → Rust `reveal_in_folder` →
 * `explorer /select,<path>`）。该命令要的是**绝对路径**，而文档里的引用可能是
 * 相对路径（`./assets/a.png`）、Tauri 的 asset.localhost URL（解码后才是真实
 * 路径），也可能形态上像文件但其实**没有本地落点**。
 *
 * 本函数把「某一行引用的 src」解析成可交给 reveal_in_folder 的绝对路径：
 * - `file` 形态（相对 / 绝对 / 解码后的 asset.localhost）→ 绝对路径；
 * - `base64`（data: URL）与 `remote`（http(s) / blob: / tauri:）→ null：
 *   它们没有本地文件，调用方据此禁用按钮并说明原因（不联网抓远程图）；
 * - 文档未保存（docDir === null）时的相对路径 → null，与面板其它 IO 操作
 *   （转 assets / 转 base64 / 重命名）的禁用条件保持一致。
 *
 * 纯函数：复用 resolveImageAbsPath，形态判定复用 imageSourceKind，
 * 面板与单测共用同一份真值，避免组件里再写一套前缀判断。
 */
export function revealTargetOf(src: string, docDir: string | null): string | null {
  // 只有磁盘上的真实文件才谈得上「在资源管理器中定位」。
  // 必须先走 imageSourceKind 而不是朴素前缀判断：data URL 的逗号载荷、
  // asset.localhost 的百分号编码路径都能骗过 startsWith 式的检查。
  if (imageSourceKind(src) !== "file") return null;
  return resolveImageAbsPath(src, docDir);
}

/** data URL 的解析结果 */
export interface DataUrlParts {
  /** 声明的 mime（缺省 image/png） */
  mime: string;
  /** 逗号之后的载荷 */
  payload: string;
  /** 是否 `;base64` 编码（否则是 URL 编码的文本，如 SVG） */
  isBase64: boolean;
}

/** ⑩ 解析 data URL（拿 mime 与载荷，供转 assets / 转 base64 双向使用） */
export function parseDataUrl(src: string): DataUrlParts | null {
  if (!DATA_URL_RE.test(src)) return null;
  const comma = src.indexOf(",");
  if (comma < 0) return null;
  const head = src.slice(5, comma);
  const payload = src.slice(comma + 1);
  const mime = (head.split(";")[0] || "").trim().toLowerCase() || "image/png";
  return { mime, payload, isBase64: /;base64/i.test(head) };
}

/** mime → 扩展名（未知类型回落 png，保证总能合成一个可用的文件名） */
export function extensionForMime(mime: string): string {
  const key = (mime || "").trim().toLowerCase();
  return MIME_TO_EXT[key] ?? "png";
}

/** 文件名 → mime（未知类型回落 image/png） */
export function mimeForFileName(fileName: string): string {
  const ext = extNameOf(fileName).replace(/^\./, "").toLowerCase();
  return EXT_TO_MIME[ext] ?? "image/png";
}

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * ⑩ 字节 → base64（纯实现）。
 *
 * 不用 `btoa`：jsdom/浏览器对超长字符串会抛 "Invalid character"，
 * 且面板要处理 700KB 级的图片；纯实现行为一致、可在 node 下单测。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_CHARS[(n >> 18) & 63] +
      B64_CHARS[(n >> 12) & 63] +
      B64_CHARS[(n >> 6) & 63] +
      B64_CHARS[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64_CHARS[(n >> 18) & 63] +
      B64_CHARS[(n >> 12) & 63] +
      B64_CHARS[(n >> 6) & 63] +
      "=";
  }
  return out;
}

/** ⑩ base64 → 字节（与 bytesToBase64 互逆；容忍换行/空白） */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = (b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const outLen = Math.max(0, Math.floor((len * 3) / 4) - pad);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i]);
    const c1 = B64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === "=" ? 0 : B64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === "=" ? 0 : B64_CHARS.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0) break;
    const n =
      (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    if (o < outLen) out[o++] = (n >> 16) & 255;
    if (o < outLen) out[o++] = (n >> 8) & 255;
    if (o < outLen) out[o++] = n & 255;
  }
  return out;
}

/** ⑩ 转 base64 计划：新引用 = `data:<mime>;base64,...` */
export interface InlineConversionPlan {
  oldSrc: string;
  /** 内联后的 data URL */
  newSrc: string;
  mime: string;
  /** 源文件名（用于提示文案） */
  fileName: string;
}

/**
 * ⑩ 计算「转 base64」计划：读到的字节 + 原文件名 → data URL。
 *
 * @param src 原引用（必须能取到文件名，即磁盘文件；远程/无效引用返回 null）
 * @param bytes 文件内容
 */
export function planConvertToBase64(
  src: string,
  bytes: Uint8Array,
): InlineConversionPlan | null {
  const fileName = imageFileNameOf(src);
  if (!fileName) return null;
  if (!bytes || bytes.length === 0) return null;
  const mime = mimeForFileName(fileName);
  return {
    oldSrc: src,
    newSrc: `data:${mime};base64,${bytesToBase64(bytes)}`,
    mime,
    fileName,
  };
}
