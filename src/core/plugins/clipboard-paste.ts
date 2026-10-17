/**
 * E9(v0.9.4)：Markdown 感知粘贴 + 富文本粘贴
 *
 * 粘贴优先级（handlePaste）：
 *   1. 剪贴板含文件（图片等）→ 交给 image-paste 插件处理（返回 false 放行）；
 *   2. 代码块 / 数学公式内 → 一律字面粘贴，不转换；
 *   3. LightMD 块专用格式 / 应用内块兜底 → `markdownToDoc` 结构还原（v0.13.1 需求1）；
 *   4. `text/html` → turndown 转 Markdown → markdownToDoc → 插入富文本结构；
 *   5. `text/plain` → 块结构判定 / Markdown 特征启发式命中时按 Markdown 解析插入，
 *      否则返回 false 交回 ProseMirror 默认（字面）粘贴。
 *
 * v0.13.1 需求1（阅读模式复制块 → 粘贴到别的文档自动渲染）：
 * - 判定口径与 `blockClipboard.ts` **统一为同一个 `looksLikeMarkdown`**
 *   （本文件不再维护第二份特征表），单个完整块构造（代码块 / 表格 / 公式块）
 *   即使只命中 1 项特征也按 Markdown 解析；
 * - 剪贴板携带 `application/x-lightmd-block` 时优先按其中的 `markdown` 还原，
 *   与 `blockClipboardOps.pasteBlockAtSelection` 口径一致（无损、结构不丢）；
 * - WebView2 下 `navigator.clipboard.read()` 可能被拒，`event.clipboardData`
 *   也读不到自定义 MIME → 用应用内块兜底 `getInAppBlockClipboard()`，
 *   且仅当其 markdown 与本次 `text/plain` 同源（trim 相等）时才采用，
 *   避免把"上次复制的块"误当成"这次粘贴的内容"。
 *
 * 转换失败（turndown 异常 / 解析异常）一律降级返回 false，不阻塞粘贴。
 * 设置项 `pasteMarkdownEnabled`（默认开）关闭时整体不介入。
 */
import { Plugin } from "prosemirror-state";
import { Slice } from "prosemirror-model";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import TurndownService from "turndown";
import { markdownToDoc } from "../markdown/parser";
import { inDisabledNode } from "./auto-pair";
import { useSettingsStore } from "../../stores/useSettingsStore";
import {
  BLOCK_CLIPBOARD_MIME,
  isSelfContainedMarkdownBlock,
  looksLikeMarkdown,
  parseBlockClipboard,
} from "../../utils/blockClipboard";
import { getInAppBlockClipboard } from "../../utils/blockClipboardOps";

/**
 * 是否"看起来像 Markdown"（供纯文本粘贴判定）。
 *
 * v0.13.1 需求1：**唯一实现已迁到 `utils/blockClipboard.ts`**（两处判定曾各写一份
 * 互相漂移：表格在那边算 2 分、在这边只算 1 分）。此处保留同名导出，既维持既有
 * 调用方/测试的导入路径，也保证全仓只有一套口径。
 */
export { looksLikeMarkdown };

// ─── HTML → Markdown ─────────────────────────────────────
let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
    });
    // 表格/任务列表等复杂结构默认由 turndown 按文本展开（不引入 GFM 插件，保持轻量）
  }
  return turndown;
}

/**
 * HTML 片段 → Markdown 字符串。转换失败返回空串（调用方降级）。
 */
export function htmlToMarkdown(html: string): string {
  try {
    return getTurndown().turndown(html);
  } catch {
    return "";
  }
}

// ─── 插入 ────────────────────────────────────────────────

/**
 * 由解析出的文档构造可插入的 Slice。
 * - 单个段落（行内型内容）→ openStart/openEnd = 1，与光标所在段落合并（行内粘贴）；
 * - 其余（多块 / 标题 / 列表 / 表格 / 代码块）→ 0，按块插入并拆分当前段落。
 */
export function buildPasteSlice(doc: Node): Slice | null {
  const frag = doc.content;
  if (frag.childCount === 0 || frag.size === 0) return null;
  const singleParagraph =
    frag.childCount === 1 && frag.firstChild?.type.name === "paragraph";
  const open = singleParagraph ? 1 : 0;
  return new Slice(frag, open, open);
}

/** 尝试把 Markdown 文本插入到当前选区，成功返回 true */
function insertMarkdown(view: EditorView, markdown: string): boolean {
  if (!markdown.trim()) return false;
  let doc: Node;
  try {
    doc = markdownToDoc(markdown);
  } catch {
    return false;
  }
  const slice = buildPasteSlice(doc);
  if (!slice) return false;
  try {
    const tr = view.state.tr.replaceSelection(slice);
    if (!tr.docChanged) return false;
    view.dispatch(tr.scrollIntoView());
    return true;
  } catch {
    return false;
  }
}

/** 剪贴板是否携带文件（图片等由 image-paste 处理） */
function hasClipboardFiles(data: DataTransfer): boolean {
  const types = data.types;
  if (types) {
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
  }
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file") return true;
    }
  }
  return false;
}

/**
 * v0.13.1 需求1：取 LightMD 块专用载荷里的 Markdown。
 *
 * `text/plain` 同传，因为 `parseBlockClipboard` 的降级链是
 * 「专用格式 → 像 Markdown 的 text/plain」，这里把两者一起喂进去即可。
 */
function lightmdBlockMarkdown(data: DataTransfer, text: string): string | null {
  let custom = "";
  try {
    custom = data.getData(BLOCK_CLIPBOARD_MIME);
  } catch {
    // 部分宿主对未注册 MIME 会抛错 → 视为没有
  }
  if (!custom) return null;
  const parsed = parseBlockClipboard([
    { type: BLOCK_CLIPBOARD_MIME, content: custom },
    { type: "text/plain", content: text },
  ]);
  return parsed?.markdown ?? null;
}

/**
 * v0.13.1 需求1：应用内块兜底（WebView2 读不到自定义 MIME 时的同应用回退）。
 *
 * 只在 `event.clipboardData` 的 `text/plain` 与兜底载荷**同源**时采用，
 * 否则宁可走普通粘贴分支——避免把上次复制、这次并未粘贴的块塞进文档。
 *
 * v0.13.2 需求1：同源判定要同时接受 `plain`（代码块复制按钮写进 text/plain 的
 * 是**纯代码**，而载荷里的 `markdown` 是围栏形态）——只比对 markdown 会让
 * 「复制代码块 → 粘贴」在同应用内失效，退回字面粘贴（正是用户报的现象）。
 */
function inAppBlockMarkdown(text: string): string | null {
  const data = getInAppBlockClipboard();
  if (!data?.markdown) return null;
  const trimmed = text.trim();
  if (trimmed === data.markdown.trim()) return data.markdown;
  if (data.plain !== undefined && trimmed === data.plain.trim()) return data.markdown;
  return null;
}

/**
 * HTML 片段是否含表格标签。
 *
 * turndown **没有 GFM 表格规则**（本插件刻意不引 `turndown-plugin-gfm`），
 * `<table>` 会被拍平成 `"a\n\nb\n\n1\n\n2"` —— 结构彻底丢失。
 * 因此这种 HTML 不能交给 `text/html` 那一支去转换。
 */
function htmlHasTable(html: string): boolean {
  return /<table[\s>]/i.test(html) || /<tr[\s>]/i.test(html);
}

/** E9：Markdown 感知粘贴插件 */
export function clipboardPastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste(view: EditorView, event: ClipboardEvent) {
        if (!useSettingsStore.getState().pasteMarkdownEnabled) return false;
        const data = event.clipboardData;
        if (!data) return false;
        // 图片/文件交由 image-paste 处理
        if (hasClipboardFiles(data)) return false;
        // 代码块 / 公式内一律字面粘贴
        if (inDisabledNode(view)) return false;

        const text = data.getData("text/plain") ?? "";

        // ⓪ v0.13.1 需求1：LightMD 块载荷（专用 MIME / 应用内兜底）优先，无损还原
        const blockMd = lightmdBlockMarkdown(data, text) ?? inAppBlockMarkdown(text);
        if (blockMd && insertMarkdown(view, blockMd)) return true;

        // ① 富文本（HTML）优先
        //
        // v0.13.1 需求1：`text/plain` 已经是一个自包含块构造时，**不让** HTML 抢先——
        // 用户复制代码块/表格/公式块时剪贴板常同时带渲染 HTML，而 turndown 对这种
        // HTML 是降级转换（表格被拍平、公式块变片段），用它覆盖无损的 Markdown
        // 等于自毁结构。HTML 含表格时同理直接跳过（turndown 无表格规则）。
        const textIsBlock = isSelfContainedMarkdownBlock(text);
        const html = data.getData("text/html");
        if (html && !textIsBlock && !htmlHasTable(html)) {
          const md = htmlToMarkdown(html);
          if (md && insertMarkdown(view, md)) return true;
        }

        // ② 纯文本：块结构判定 / Markdown 特征启发式
        if (!text) return false;
        if (looksLikeMarkdown(text) && insertMarkdown(view, text)) return true;

        // 兜底：交回 ProseMirror 默认粘贴（字面）
        return false;
      },
    },
  });
}
