/**
 * image-paste 插件 —— 处理图片粘贴
 *
 * 粘贴图片时弹窗询问：保存到 assets/ 或 转为 Base64
 * 在浏览器模式下直接转为 Base64（无 Tauri 后端）
 */
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema } from "../schema";

type ImageHandler = (files: File[]) => void;
let globalImageHandler: ImageHandler | null = null;

/** 设置全局图片处理器（由 React 组件调用） */
export function setImageHandler(handler: ImageHandler | null) {
  globalImageHandler = handler;
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
            file.name.endsWith(".markdown")
          ) {
            mdFiles.push(file);
          }
        }

        if (imageFiles.length > 0 || mdFiles.length > 0) {
          event.preventDefault();

          // 处理图片
          if (imageFiles.length > 0 && globalImageHandler) {
            globalImageHandler(imageFiles);
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

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
