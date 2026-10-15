/**
 * 图片管理面板 —— 纯函数层（v0.13.0 需求11）
 *
 * 作用域：**只管当前文档**（v1 用户确认）。面板扫当前 PM doc 的 image 节点，
 * 给出「转 assets / 重命名 / 清理未引用」三个操作所需的全部计算结果；
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
}

/** 外部图片（不在文档目录内的相对引用之外的形态） */
const DATA_URL_RE = /^data:/i;
const REMOTE_URL_RE = /^(?:https?:|asset:|blob:|tauri:)/i;
const ABS_WIN_RE = /^[A-Za-z]:[\\/]/;

/**
 * 扫描 doc 中全部 image 节点，按 src 合并为 DocImage[]。
 *
 * 顺序按**首次出现顺序**（面板展示与用户的直觉一致：文档第 3 张图
 * 排在列表第 3 位，而不是按哈希乱序）。
 */
export function collectDocImages(doc: Node): DocImage[] {
  const bySrc = new Map<string, DocImage>();
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
    const existing = bySrc.get(src);
    if (existing) {
      existing.count += 1;
      existing.nodeCount += 1;
      // 首个非空 alt / 首个 width / 首个非 left 对齐才覆盖（保持"首张"语义）
      if (!existing.alt && alt) existing.alt = alt;
      if (existing.width === null && width !== null) existing.width = width;
      if (existing.align === "left" && align !== "left") existing.align = align;
    } else {
      bySrc.set(src, { src, alt, count: 1, nodeCount: 1, width, align });
    }
    return false;
  });
  return [...bySrc.values()];
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

/**
 * 转 assets 是否需要用户确认（外部图片）。
 *
 * 判定：**相对路径之外**的引用（http(s)/data/绝对路径）需要复制到 assets。
 * 相对路径（./ / ../ / 不带协议与盘符的裸文件名）已经在文档目录内，
 * 转 assets 只是把文件搬进 assets/ 子目录，仍可安全提示。
 */
export function isExternalImageSrc(src: string): boolean {
  if (!src) return false;
  return DATA_URL_RE.test(src) || REMOTE_URL_RE.test(src) || ABS_WIN_RE.test(src);
}

/**
 * 从 src 取文件名（含扩展名）。
 * 相对路径与绝对路径都按 / 与 \ 的最后一段取；query/hash 一并剥掉。
 */
export function imageFileNameOf(src: string): string {
  if (!src) return "";
  // data URL 没有文件名（末段是 base64 载荷），返回空串让调用方拒绝迁移
  if (/^data:/i.test(src)) return "";
  const cleaned = src.split(/[?#]/)[0];
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
 * 磁盘文件中未被**本文档**引用的图片。
 *
 * @param diskNames assets 目录中的文件名字符串（不含子目录）
 * @param docImages collectDocImages 的结果
 * @returns 未被引用的文件名（保持 diskNames 原顺序）
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
 * @param src 原引用
 * @param newName 新文件名（不含目录；调用方已校验）
 * @returns 新引用；src 无文件名时返回 null
 */
export function planRename(src: string, newName: string): RenamePlan | null {
  const trimmed = newName.trim();
  if (!trimmed) return null;
  const oldName = imageFileNameOf(src);
  if (!oldName) return null;
  // 保留原引用的目录前缀（./ / ../ / 绝对目录 / assets/）
  const dir = src.slice(0, src.length - oldName.length);
  return { oldSrc: src, newSrc: `${dir}${trimmed}`, fileName: trimmed };
}

/** 面板条目在文档中的删除结果统计 */
export interface ReplaceRefsSummary {
  /** 替换发生的次数 */
  replaced: number;
}

/**
 * 汇总文档中 oldSrc → newSrc 的替换计划（不执行，仅统计）。
 * 组件侧据此提示「N 处引用已更新」。
 */
export function countRefsOf(docImages: DocImage[], src: string): number {
  const hit = docImages.find((i) => i.src === src);
  return hit ? hit.count : 0;
}

/** 供测试断言的空统计（保持接口对称） */
export function emptyReplaceSummary(): ReplaceRefsSummary {
  return { replaced: 0 };
}
