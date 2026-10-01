/**
 * E9(v0.9.4)：Markdown 感知粘贴 + 富文本粘贴
 *
 * 粘贴优先级（handlePaste）：
 *   1. 剪贴板含文件（图片等）→ 交给 image-paste 插件处理（返回 false 放行）；
 *   2. 代码块 / 数学公式内 → 一律字面粘贴，不转换；
 *   3. `text/html` → turndown 转 Markdown → markdownToDoc → 插入富文本结构；
 *   4. `text/plain` → Markdown 特征启发式命中 ≥2 项时按 Markdown 解析插入，
 *      否则返回 false 交回 ProseMirror 默认（字面）粘贴。
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

/** Markdown 特征正则（命中 ≥2 项才按 Markdown 解析纯文本） */
const MD_FEATURE_RES: RegExp[] = [
  /^#{1,6}\s/m, // ATX 标题
  /^\s*[-*+]\s+\S/m, // 无序列表
  /^\s*\d+\.\s+\S/m, // 有序列表
  /^\s*>\s+\S/m, // 引用
  /```/, // 围栏代码
  /\*\*[^*\n]+\*\*/, // 粗体
  // 斜体：两侧不能与 * 相邻，避免把 **粗体** 误判成斜体（否则单个粗体即凑满 2 项特征）
  /(?:^|[^*])\*[^*\s][^*\n]*\*(?:[^*]|$)/m,
  /~~[^~\n]+~~/, // 删除线
  /`[^`\n]+`/, // 行内代码
  /\[[^\]\n]+\]\([^)\n]+\)/, // 链接
  /^\s*\|.*\|\s*$/m, // 表格行
  /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m, // 分隔线
];

/**
 * 是否"看起来像 Markdown"（供纯文本粘贴判定）。
 * 命中特征类别数 ≥ 2 才认定为 Markdown，避免把普通文本误转。
 */
export function looksLikeMarkdown(text: string): boolean {
  let hits = 0;
  for (const re of MD_FEATURE_RES) {
    if (re.test(text)) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

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

        // ① 富文本（HTML）优先
        const html = data.getData("text/html");
        if (html) {
          const md = htmlToMarkdown(html);
          if (md && insertMarkdown(view, md)) return true;
        }

        // ② 纯文本：Markdown 特征启发式
        const text = data.getData("text/plain");
        if (!text) return false;
        if (looksLikeMarkdown(text) && insertMarkdown(view, text)) return true;

        // 兜底：交回 ProseMirror 默认粘贴（字面）
        return false;
      },
    },
  });
}
