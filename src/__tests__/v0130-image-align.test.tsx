/**
 * v0.13.0 需求4：图片左/中/右对齐。
 *
 * 覆盖：
 * - schema：`align` attr 默认 left；三种对齐的 toDOM CSS；
 * - 序列化：非左对齐走 `|align` 后缀（与 E11a 的 `|W` 同一套约定）；
 *   **未设对齐的文档零 diff**（回归锁）；
 * - roundtrip：md → doc → md（三种对齐往返稳定）；
 * - 工具函数：`normalizeImageAlign` / `imageAlignCss` / `parseImageAlign`；
 * - 对话框：三按钮与确认回调把 align 写回（真实 RTL 渲染）。
 *
 * ## 关键设计决策（本版修正）
 *
 * 初版方案是「序列化为 `<img style>`」，**实测不可行**：编辑管线的行内 HTML
 * 白名单只放行 `u|br|sub|sup|mark`，`<img>` 会被整段剥掉 → 重新打开时图片
 * **直接丢失**（doc 里只剩空段落）。故改为 `|` 后缀（`![alt|center](src)` /
 * `![alt|300|center](src)`），由 parser 同源解析，往返稳定。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import {
  lightMDSchema,
  normalizeImageAlign,
  imageAlignCss,
  parseImageAlign,
  IMAGE_ALIGN_VALUES,
  type ImageAlign,
} from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { ImageEditDialog } from "../components/dialogs/ImageEditDialog";

const schema = lightMDSchema;

// RTL 不会自动 cleanup（项目未开 vitest globals），显式在用例间卸载，
// 否则多个 render 的 DOM 同时挂在 body 上 → getByTestId 命中多个元素。
afterEach(cleanup);

function docWithImage(md: string) {
  return markdownToDoc(md);
}

function roundTrip(md: string): string {
  return docToMarkdown(docWithImage(md));
}

/** 用节点直接构造 doc（不经 markdown，用于断言 toDOM / 序列化输出） */
function docFromImageNode(attrs: Record<string, unknown>) {
  const node = schema.nodes.image.create({ src: "a.png", alt: "图", ...attrs });
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, node));
}

/** 找 doc 里第一个 image 节点 */
function findImage(doc: ReturnType<typeof docWithImage>): { attrs: Record<string, unknown> } | null {
  let found: { attrs: Record<string, unknown> } | null = null;
  doc.descendants((n) => {
    if (!found && n.type.name === "image") {
      found = { attrs: n.attrs as Record<string, unknown> };
      return false;
    }
    return true;
  });
  return found;
}

describe("schema：image.align attr 与 toDOM", () => {
  it("默认 left（既有文档零行为变化）", () => {
    const node = schema.nodes.image.create({ src: "a.png", alt: "" });
    expect(node.attrs.align).toBe("left");
  });

  it("toDOM：left 不加对齐样式（保持旧 DOM 结构，零 diff）", () => {
    const node = schema.nodes.image.create({ src: "a.png", alt: "", align: "left" });
    const dom = node.type.spec.toDOM?.(node) as [string, Record<string, string>];
    expect(dom[1].style).toBeUndefined();
    expect(dom[1]["data-align"]).toBeUndefined();
  });

  it("toDOM：center → display:block + 左右 margin auto + data-align", () => {
    const node = schema.nodes.image.create({ src: "a.png", alt: "", align: "center" });
    const dom = node.type.spec.toDOM?.(node) as [string, Record<string, string>];
    expect(dom[1].style).toContain("display:block");
    expect(dom[1].style).toContain("margin-left:auto");
    expect(dom[1].style).toContain("margin-right:auto");
    expect(dom[1]["data-align"]).toBe("center");
  });

  it("toDOM：right → display:block + 左 margin auto", () => {
    const node = schema.nodes.image.create({ src: "a.png", alt: "", align: "right" });
    const dom = node.type.spec.toDOM?.(node) as [string, Record<string, string>];
    expect(dom[1].style).toContain("display:block");
    expect(dom[1].style).toContain("margin-left:auto");
    expect(dom[1].style).not.toContain("margin-right:auto");
    expect(dom[1]["data-align"]).toBe("right");
  });

  it("width 与 align 可同时生效（两者拼进同一 style）", () => {
    const node = schema.nodes.image.create({ src: "a.png", alt: "", width: 300, align: "center" });
    const dom = node.type.spec.toDOM?.(node) as [string, Record<string, string>];
    expect(dom[1].style).toContain("width:300px");
    expect(dom[1].style).toContain("display:block");
    expect(dom[1].style).toContain("margin-left:auto");
  });

  it("parseDOM：从 data-align 还原", () => {
    const el = document.createElement("img");
    el.setAttribute("src", "a.png");
    el.setAttribute("data-align", "right");
    expect(parseImageAlign(el)).toBe("right");
  });

  it("parseDOM：从 style margin 还原（富文本粘贴场景）", () => {
    const el = document.createElement("img");
    el.setAttribute("src", "a.png");
    el.style.marginLeft = "auto";
    el.style.marginRight = "auto";
    expect(parseImageAlign(el)).toBe("center");
  });

  it("parseDOM：无对齐信息 → left", () => {
    const el = document.createElement("img");
    el.setAttribute("src", "a.png");
    expect(parseImageAlign(el)).toBe("left");
  });
});

describe("纯函数：normalizeImageAlign / imageAlignCss", () => {
  it("normalizeImageAlign：非法值回落 left", () => {
    expect(normalizeImageAlign("center")).toBe("center");
    expect(normalizeImageAlign("right")).toBe("right");
    expect(normalizeImageAlign("left")).toBe("left");
    expect(normalizeImageAlign("middle")).toBe("left");
    expect(normalizeImageAlign(undefined)).toBe("left");
    expect(normalizeImageAlign(3)).toBe("left");
  });

  it("imageAlignCss：left → 空串（不加样式，零 diff 关键）", () => {
    expect(imageAlignCss("left")).toBe("");
    expect(imageAlignCss("bogus")).toBe("");
  });

  it("imageAlignCss：center/right → 非空且含 display:block", () => {
    for (const a of ["center", "right"] as ImageAlign[]) {
      expect(imageAlignCss(a)).toContain("display:block");
    }
    expect(imageAlignCss("center")).toContain("margin-right:auto");
    expect(imageAlignCss("right")).not.toContain("margin-right:auto");
  });

  it("IMAGE_ALIGN_VALUES 覆盖三种取值", () => {
    expect([...IMAGE_ALIGN_VALUES].sort()).toEqual(["center", "left", "right"]);
  });
});

describe("序列化：未设对齐零 diff（回归锁）", () => {
  it("纯图片 markdown → doc → markdown 逐字节一致", () => {
    const md = "![图](a.png)\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("带宽度图片同理零 diff", () => {
    const md = "![图|300](a.png)\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("含图片的整篇文档零 diff", () => {
    const md = "# 标题\n\n段落一\n\n![图](a.png)\n\n段落二\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("未设对齐的图片不产生任何后缀", () => {
    expect(docToMarkdown(docFromImageNode({ align: "left" }))).toBe("![图](a.png)\n");
  });
});

describe("序列化：非左对齐走 |align 后缀", () => {
  it("center → ![图|center](a.png)", () => {
    expect(docToMarkdown(docFromImageNode({ align: "center" }))).toBe("![图|center](a.png)\n");
  });

  it("right → ![图|right](a.png)", () => {
    expect(docToMarkdown(docFromImageNode({ align: "right" }))).toBe("![图|right](a.png)\n");
  });

  it("width + center → ![图|300|center](a.png)", () => {
    expect(docToMarkdown(docFromImageNode({ align: "center", width: 300 }))).toBe(
      "![图|300|center](a.png)\n",
    );
  });

  it("**不输出 <img> HTML**——编辑管线白名单会剥掉它导致图片丢失（回归锁）", () => {
    const out = docToMarkdown(docFromImageNode({ align: "center" }));
    expect(out).not.toContain("<img");
    // 反证：若真输出 <img>，重新解析后图片节点会消失（实测只剩空段落）
    expect(findImage(docWithImage(out))).not.toBeNull();
  });
});

describe("roundtrip：三种对齐往返稳定", () => {
  it("center：md → doc → md 逐字节一致", () => {
    const md = "![图|center](a.png)\n";
    expect(roundTrip(md)).toBe(md);
  });

  it("right：往返后仍是 right", () => {
    const md = "![图|right](a.png)\n";
    expect(roundTrip(md)).toBe(md);
    expect(findImage(docWithImage(md))?.attrs.align).toBe("right");
  });

  it("left：往返后仍是 left（无后缀，标准语法）", () => {
    const md = "![图](a.png)\n";
    expect(roundTrip(md)).toBe(md);
    expect(findImage(docWithImage(md))?.attrs.align).toBe("left");
  });

  it("width + center 同时往返（两者都不丢）", () => {
    const md = "![图|300|center](a.png)\n";
    expect(roundTrip(md)).toBe(md);
    const img = findImage(docWithImage(md));
    expect(img?.attrs.align).toBe("center");
    expect(img?.attrs.width).toBe(300);
  });

  it("alt 里本身含竖线时不会被误判（第二段非数字且非合法对齐 → 原样保留）", () => {
    const img = findImage(docWithImage("![a|b](x.png)\n"));
    expect(img?.attrs.align).toBe("left");
    expect(img?.attrs.width).toBeNull();
    expect(String(img?.attrs.alt)).toBe("a|b");
  });

  it("第三段不是合法对齐值 → 回落 left（不抛错，宽度仍生效）", () => {
    const img = findImage(docWithImage("![图|300|middle](x.png)\n"));
    expect(img?.attrs.align).toBe("left");
    expect(img?.attrs.width).toBe(300);
  });

  it("parseDOM 路径：从 data-align 还原（EditorState 用）", () => {
    const el = document.createElement("img");
    el.setAttribute("src", "a.png");
    el.setAttribute("alt", "图");
    el.setAttribute("data-align", "center");
    const spec = schema.nodes.image.spec.parseDOM?.[0];
    expect(spec?.tag).toBe("img[src]");
    const attrs = spec?.getAttrs?.(el) as Record<string, unknown>;
    expect(attrs.align).toBe("center");
  });
});

describe("ImageEditDialog：对齐三按钮", () => {
  it("渲染三个对齐按钮，默认 left 选中", () => {
    const { getByTestId } = render(
      <ImageEditDialog open imageSrc="a.png" onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(getByTestId("image-align-left").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("image-align-center").getAttribute("aria-pressed")).toBe("false");
    expect(getByTestId("image-align-right").getAttribute("aria-pressed")).toBe("false");
  });

  it("点 center → 选中态切换，确认回调带 align=center", () => {
    let confirmed: { alt: string; width: number | null; align: string } | null = null;
    const { getByTestId, getByText } = render(
      <ImageEditDialog
        open
        imageSrc="a.png"
        imageAlign="left"
        onConfirm={(_s, meta) => {
          confirmed = meta;
        }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(getByTestId("image-align-center"));
    expect(getByTestId("image-align-center").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("image-align-left").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(getByText("确认"));
    expect(confirmed).not.toBeNull();
    expect(confirmed!.align).toBe("center");
  });

  it("初始 imageAlign=right → right 按钮预选中", () => {
    const { getByTestId } = render(
      <ImageEditDialog
        open
        imageSrc="a.png"
        imageAlign="right"
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(getByTestId("image-align-right").getAttribute("aria-pressed")).toBe("true");
  });

  it("align 与 width/alt 一起写回（三个 meta 字段齐全）", () => {
    let confirmed: { alt: string; width: number | null; align: string } | null = null;
    const { getByTestId, getByLabelText, getByText } = render(
      <ImageEditDialog
        open
        imageSrc="a.png"
        imageAlt="旧描述"
        imageWidth={200}
        onConfirm={(_s, meta) => {
          confirmed = meta;
        }}
        onClose={() => {}}
      />,
    );
    fireEvent.change(getByLabelText("替代文本"), { target: { value: "新描述" } });
    fireEvent.change(getByLabelText("宽度(px)"), { target: { value: "400" } });
    fireEvent.click(getByTestId("image-align-right"));
    fireEvent.click(getByText("确认"));
    expect(confirmed).toEqual({ alt: "新描述", width: 400, align: "right" });
  });
});
