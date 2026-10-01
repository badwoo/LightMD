/**
 * E11(v0.9.3):图片体验三件套
 *
 * 11a 尺寸属性:![alt|300](src) → image.attrs.width,渲染 style width,序列化带 |300 后缀
 * 11b alt/尺寸编辑:ImageEditDialog 顶部 alt 文本框 + 宽度数字输入,确认后 setNodeMarkup 写回
 * 11c 拖拽落点:drop 用 posAtCoords 记录落点 + doc 快照守卫;确认时 doc 未变插落点,
 *     已变化降级光标处(纯函数 resolveDropInsertPos 可单测)
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Node } from "prosemirror-model";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import {
  resolveDropInsertPos,
  canInsertImageAt,
} from "../core/plugins/image-paste";
import { ImageEditDialog } from "../components/dialogs/ImageEditDialog";

afterEach(cleanup);

function findImage(doc: Node): Node | null {
  let found: Node | null = null;
  doc.descendants((n) => {
    if (n.type.name === "image" && !found) found = n;
  });
  return found;
}

describe("E11a: 图片尺寸属性解析与序列化", () => {
  it("![a|300](x.png) → width=300、alt=a", () => {
    const doc = markdownToDoc("![a|300](x.png)");
    const img = findImage(doc)!;
    expect(img).toBeTruthy();
    expect(img!.attrs.alt).toBe("a");
    expect(img!.attrs.width).toBe(300);
    expect(img!.attrs.src).toBe("x.png");
  });

  it("旧语法 ![a](x.png) → width=null,往返不变", () => {
    const doc = markdownToDoc("![a](x.png)");
    const img = findImage(doc)!;
    expect(img!.attrs.width).toBeNull();
    // B6:未编辑块逐字节返回原文
    expect(docToMarkdown(doc)).toBe("![a](x.png)");
  });

  it("带尺寸语法 B6 往返:逐字节返回原文", () => {
    const doc = markdownToDoc("前文\n\n![a|300](x.png)");
    expect(docToMarkdown(doc)).toBe("前文\n\n![a|300](x.png)");
  });

  it("手工构造 width 节点 → 序列化输出 ![a|300](x.png)", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.nodes.image.create({ src: "x.png", alt: "a", width: 300 }),
      ]),
    ]);
    expect(docToMarkdown(doc)).toBe("![a|300](x.png)\n");
  });

  it("手工构造无 width 节点 → 序列化输出旧语法(无后缀)", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.nodes.image.create({ src: "x.png", alt: "a" }),
      ]),
    ]);
    expect(docToMarkdown(doc)).toBe("![a](x.png)\n");
  });

  it("toDOM 渲染 style width;无宽度时无 style", () => {
    const withW = schema.nodes.image.create({ src: "x.png", alt: "a", width: 300 });
    const dom = withW.type.spec.toDOM!(withW) as [string, Record<string, string>];
    expect(dom[1].style).toBe("width:300px");
    const noW = schema.nodes.image.create({ src: "x.png", alt: "a" });
    const dom2 = noW.type.spec.toDOM!(noW) as [string, Record<string, string>];
    expect(dom2[1].style).toBeUndefined();
  });

  it("parseDOM:粘贴富文本 <img style='width:120px'> 还原 width", () => {
    const spec = schema.nodes.image.spec.parseDOM![0]!;
    const el = document.createElement("img");
    el.setAttribute("src", "x.png");
    el.setAttribute("alt", "a");
    el.style.width = "120px";
    const attrs = spec.getAttrs!(el) as Record<string, unknown>;
    expect(attrs.width).toBe(120);
    const el2 = document.createElement("img");
    el2.setAttribute("src", "x.png");
    const attrs2 = schema.nodes.image.spec.parseDOM![0]!.getAttrs!(el2) as Record<string, unknown>;
    expect(attrs2.width).toBeNull();
  });

  it("alt 含 | 但结尾非数字 → 不误判宽度", () => {
    const doc = markdownToDoc("![a|b](x.png)");
    const img = findImage(doc)!;
    expect(img!.attrs.alt).toBe("a|b");
    expect(img!.attrs.width).toBeNull();
  });
});

describe("E11c: 拖拽落点快照守卫(纯函数)", () => {
  const mkDoc = (text: string): Node =>
    schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
    ]);

  it("doc 未变且落点在段落内 → 使用落点 pos", () => {
    const doc = mkDoc("hello");
    expect(resolveDropInsertPos(doc, { doc, pos: 3 })).toBe(3);
  });

  it("drop 后文档发生过编辑(doc 引用变化)→ 返回 null 降级光标", () => {
    const dropDoc = mkDoc("hello");
    const currentDoc = mkDoc("hello edited");
    expect(resolveDropInsertPos(currentDoc, { doc: dropDoc, pos: 3 })).toBeNull();
  });

  it("落点无法定位(pos=null)→ 返回 null", () => {
    const doc = mkDoc("hello");
    expect(resolveDropInsertPos(doc, { doc, pos: null })).toBeNull();
    expect(resolveDropInsertPos(doc, null)).toBeNull();
    expect(resolveDropInsertPos(doc, undefined)).toBeNull();
  });

  it("落点在代码块内(不允许 inline 图片)→ 返回 null", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create(null, schema.text("t")),
      schema.nodes.code_block.create({ language: "" }, schema.text("code")),
    ]);
    // code_block 文本内位置(段落占 [0,3],code_block 从 3 开始)
    expect(canInsertImageAt(doc, 5)).toBe(false);
    expect(resolveDropInsertPos(doc, { doc, pos: 5 })).toBeNull();
    expect(canInsertImageAt(doc, 2)).toBe(true);
  });
});

describe("E11b: ImageEditDialog alt/宽度编辑", () => {
  it("输入 alt 与宽度,确认回调携带 meta", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ImageEditDialog
        open={true}
        imageSrc="data:image/png;base64,x"
        imageAlt="旧描述"
        imageWidth={100}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const altInput = screen.getByLabelText("替代文本") as HTMLInputElement;
    const widthInput = screen.getByLabelText("宽度(px)") as HTMLInputElement;
    expect(altInput.value).toBe("旧描述");
    expect(widthInput.value).toBe("100");
    fireEvent.change(altInput, { target: { value: "新描述" } });
    fireEvent.change(widthInput, { target: { value: "240" } });
    fireEvent.click(screen.getByText("确认"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("data:image/png;base64,x", {
      alt: "新描述",
      width: 240,
    });
  });

  it("宽度清空 → width=null;非法输入降级 null", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEditDialog
        open={true}
        imageSrc="data:image/png;base64,x"
        imageAlt="a"
        imageWidth={100}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    const widthInput = screen.getByLabelText("宽度(px)") as HTMLInputElement;
    fireEvent.change(widthInput, { target: { value: "" } });
    fireEvent.click(screen.getByText("确认"));
    expect(onConfirm).toHaveBeenCalledWith("data:image/png;base64,x", {
      alt: "a",
      width: null,
    });
  });

  it("未传 alt/width(旧调用方)→ 输入框为空,确认 width=null", () => {
    const onConfirm = vi.fn();
    render(
      <ImageEditDialog
        open={true}
        imageSrc="data:image/png;base64,x"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    const altInput = screen.getByLabelText("替代文本") as HTMLInputElement;
    expect(altInput.value).toBe("");
    fireEvent.click(screen.getByText("确认"));
    expect(onConfirm).toHaveBeenCalledWith("data:image/png;base64,x", {
      alt: "",
      width: null,
    });
  });
});
