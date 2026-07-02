/**
 * 上下标功能测试（P8）
 *
 * 验证：
 * 1. ~sub~ 解析为 subscript mark
 * 2. ^sup^ 解析为 superscript mark
 * 3. ~~删除线~~ 不与 ~下标~ 冲突
 * 4. 序列化与往返一致
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema } from "../core/schema";

describe("下标 ~sub~", () => {
  it("应该正确解析 ~sub~ 为 subscript mark", () => {
    const md = "H~2~O 是水\n";
    const doc = markdownToDoc(md);
    const para = doc.firstChild!;
    // 找到带 subscript mark 的节点
    let found = false;
    para.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "subscript")) {
        expect(child.text).toBe("2");
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("应该正确序列化 subscript 为 ~text~", () => {
    const doc = lightMDSchema.topNodeType.create(null, [
      lightMDSchema.nodes.paragraph.create(null, [
        lightMDSchema.text("H"),
        lightMDSchema.text("2", [lightMDSchema.mark("subscript")]),
        lightMDSchema.text("O"),
      ]),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toContain("H~2~O");
  });

  it("往返序列化应保持一致", () => {
    const src = "H~2~O\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    expect(out.trim()).toBe("H~2~O");
  });
});

describe("上标 ^sup^", () => {
  it("应该正确解析 ^sup^ 为 superscript mark", () => {
    const md = "E=mc^2^\n";
    const doc = markdownToDoc(md);
    const para = doc.firstChild!;
    let found = false;
    para.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "superscript")) {
        expect(child.text).toBe("2");
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("应该正确序列化 superscript 为 ^text^", () => {
    const doc = lightMDSchema.topNodeType.create(null, [
      lightMDSchema.nodes.paragraph.create(null, [
        lightMDSchema.text("E=mc"),
        lightMDSchema.text("2", [lightMDSchema.mark("superscript")]),
      ]),
    ]);
    const md = docToMarkdown(doc);
    expect(md).toContain("E=mc^2^");
  });

  it("往返序列化应保持一致", () => {
    const src = "E=mc^2^\n";
    const doc = markdownToDoc(src);
    const out = docToMarkdown(doc);
    expect(out.trim()).toBe("E=mc^2^");
  });
});

describe("删除线与下标不冲突", () => {
  it("~~text~~ 解析为 strike，不是 subscript", () => {
    const md = "~~删除线~~\n";
    const doc = markdownToDoc(md);
    const para = doc.firstChild!;
    let strikeFound = false;
    let subFound = false;
    para.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "strike")) strikeFound = true;
      if (child.marks.some((m) => m.type.name === "subscript")) subFound = true;
    });
    expect(strikeFound).toBe(true);
    expect(subFound).toBe(false);
  });

  it("混合使用删除线和下标应各自正确解析", () => {
    const md = "~~删除~~ 和 H~2~O\n";
    const doc = markdownToDoc(md);
    const para = doc.firstChild!;
    let strikeCount = 0;
    let subCount = 0;
    para.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "strike")) strikeCount++;
      if (child.marks.some((m) => m.type.name === "subscript")) subCount++;
    });
    expect(strikeCount).toBe(1);
    expect(subCount).toBe(1);
  });
});
