/**
 * image-paste 插件 —— 处理图片粘贴
 *
 * 粘贴图片时弹窗询问：保存到 assets/ 或 转为 Base64
 * 在浏览器模式下直接转为 Base64（无 Tauri 后端）
 */
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import type { Node } from "prosemirror-model";
import { lightMDSchema } from "../schema";

/**
 * E11c(v0.9.3):拖拽落点上下文。
 * drop 时刻的 doc 引用 + 落点 pos——弹窗确认插入前用 doc 引用比对做快照守卫
 * (PM doc 不可变,期间任何编辑都会产生新 doc 引用),防"插到已失效的位置"。
 */
export interface ImageDropContext {
  /** drop 时的 doc 引用 */
  doc: Node;
  /** drop 落点(view.posAtCoords);无法定位时为 null */
  pos: number | null;
}

type ImageHandler = (files: File[], dropCtx?: ImageDropContext | null) => void;
let globalImageHandler: ImageHandler | null = null;

/** 设置全局图片处理器（由 React 组件调用） */
export function setImageHandler(handler: ImageHandler | null) {
  globalImageHandler = handler;
}

/**
 * E11c(v0.9.3):判断 pos 处是否可插入 inline 图片。
 * 代码块/数学块等内容为纯文本的块内不可插入(否则 replaceWith 抛错),返回 false。
 */
export function canInsertImageAt(doc: Node, pos: number): boolean {
  try {
    const $pos = doc.resolve(pos);
    return $pos.parent.type.validContent(Fragment.from(lightMDSchema.nodes.image.create()));
  } catch {
    return false;
  }
}

/**
 * E11c(v0.9.3):计算图片插入目标 pos(纯函数,快照守卫)。
 * - drop 时记录的 doc 与当前 doc 引用一致(期间无编辑)且落点可插入 → 返回落点;
 * - 否则返回 null → 调用方降级为光标处插入
 */
export function resolveDropInsertPos(
  currentDoc: Node,
  dropCtx: ImageDropContext | null | undefined,
): number | null {
  if (!dropCtx || dropCtx.pos === null) return null;
  if (currentDoc !== dropCtx.doc) return null;
  return canInsertImageAt(currentDoc, dropCtx.pos) ? dropCtx.pos : null;
}

export const imagePastePlugin = new Plugin({
  props: {
    handleDOMEvents: {
      paste(view: EditorView, event: ClipboardEvent) {
        const items = event.clipboardData?.items;
        if (!items) return false;

        const imageFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) imageFiles.push(file);
          }
        }

        if (imageFiles.length > 0) {
          event.preventDefault();
          if (globalImageHandler) {
            globalImageHandler(imageFiles);
          }
          return true;
        }
        return false;
      },

      drop(view: EditorView, event: DragEvent) {
        const files = event.dataTransfer?.files;
        if (!files) return false;

        const imageFiles: File[] = [];
        const mdFiles: File[] = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file.type.startsWith("image/")) {
            imageFiles.push(file);
          } else if (
            file.name.endsWith(".md") ||
            file.name.endsWith(".markdown") ||
            file.name.endsWith(".mdown") ||
            file.name.endsWith(".mkd")
          ) {
            mdFiles.push(file);
          }
        }

        if (imageFiles.length > 0 || mdFiles.length > 0) {
          event.preventDefault();

          // 处理图片
          if (imageFiles.length > 0 && globalImageHandler) {
            // E11c(v0.9.3):记录释放落点与当时的 doc 快照,替代"一律插到光标处"
            let pos: number | null = null;
            try {
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
              pos = coords ? coords.pos : null;
            } catch {
              pos = null;
            }
            globalImageHandler(imageFiles, { doc: view.state.doc, pos });
          }

          // 处理 .md 文件拖入
          if (mdFiles.length > 0) {
            for (const file of mdFiles) {
              const reader = new FileReader();
              reader.onload = (e) => {
                const content = e.target?.result as string;
                window.dispatchEvent(
                  new CustomEvent("lightmd:openFile", {
                    detail: { path: file.name, content },
                  })
                );
              };
              reader.readAsText(file);
            }
          }

          return true;
        }
        return false;
      },
    },
  },
});

// ─── 工具函数：插入图片到编辑器 ──────────────────────────

export function insertImageAtCursor(
  view: EditorView,
  src: string,
  alt: string = ""
): void {
  const { state, dispatch } = view;
  const schema = lightMDSchema;
  const node = schema.nodes.image.create({ src, alt });
  const tr = state.tr.replaceSelectionWith(node);
  dispatch(tr);
}

/**
 * E11c(v0.9.3):在指定 pos 处插入图片(可多张,按顺序追加)。
 * 调用方须先用 resolveDropInsertPos 校验 pos 有效性(快照守卫)。
 */
export function insertImagesAtPos(
  view: EditorView,
  pos: number,
  images: Array<{ src: string; alt: string }>
): void {
  const tr = view.state.tr;
  let at = pos;
  for (const img of images) {
    const node = lightMDSchema.nodes.image.create({ src: img.src, alt: img.alt });
    tr.replaceWith(at, at, node);
    at += node.nodeSize;
  }
  view.dispatch(tr);
}

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
