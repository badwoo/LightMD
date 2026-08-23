/**
 * SmartPaste —— N2 智能粘贴 URL→链接（v0.5.0）
 *
 * 粘贴的内容为单个 http(s) URL 时自动转换为 Markdown 链接：
 * - 无选区：插入 URL 文本并附加 link mark（光标置于链接之后）
 * - 有选区：选中文本作为链接文字，URL 作为 href
 * - 代码块/公式内不处理，交由编辑器默认粘贴
 * - 非 URL 文本不处理
 *
 * textarea（源码模式）的粘贴逻辑在 EditorContainer 中，共用本模块的 isHttpUrl。
 */
import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema } from "../schema";
import { inDisabledNode } from "./auto-pair";

/** 判断整段文本是否为单个 http(s) URL（首尾空白已 trim，中间不允许空白） */
export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text);
}

/** N2：智能粘贴 URL→链接插件 */
export function smartPastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste(view: EditorView, event: ClipboardEvent) {
        const text = event.clipboardData?.getData("text/plain")?.trim();
        if (!text || !isHttpUrl(text)) return false;
        if (inDisabledNode(view)) return false;

        const { state } = view;
        const { from, to, empty } = state.selection;
        const linkMark = lightMDSchema.marks.link.create({ href: text });
        const tr = state.tr;

        if (empty) {
          // 无选区：插入 URL 文本并加 link mark，光标置于链接之后
          tr.insertText(text, from, to);
          tr.addMark(from, from + text.length, linkMark);
          tr.setSelection(TextSelection.create(tr.doc, from + text.length));
        } else {
          // 有选区：选中文本作为链接文字，不删除内容
          tr.addMark(from, to, linkMark);
        }
        view.dispatch(tr);
        return true;
      },
    },
  });
}
