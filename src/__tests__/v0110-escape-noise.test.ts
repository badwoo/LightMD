/**
 * v0.11.0 B3-4：`~` / `^` 转义噪音修复。
 *
 * 缺陷背景（P1）：
 *   `escapeText` 对 `~` / `^` / `$` 做**无条件裸替换**，导致单字符场景产生
 *   用户没写过的反斜杠（git diff 噪音）：
 *     `a ~ b` → `a \~ b`（单个 ~ 在 CommonMark 中构不成任何标记）
 *     `a ^ b` → `a \^ b`（同上）
 *   对照 `*`（count>=2 才转）、`_`（词内判断）本就有条件判断，只有这两条是裸的。
 *
 * ⚠️ **B6 原文保留陷阱**（本测试必须规避，否则是恒通过的假测试）：
 *   `serializer.ts` 的 B6 机制（blockSourceMap WeakMap）会对**未被编辑的块**
 *   逐字节返回源文本 —— 直接断言 markdownToDoc(x) 的序列化结果**恒通过**，
 *   测的是原文而不是序列化器。故本测试一律用 `reparse` 构造**新节点对象**
 *   （WeakMap 未命中 → 走真实序列化路径）。
 *
 * ⚠️ **判定口径不是「出现 ≥2 次」而是「存在可配对」**（实测得出）：
 *   markdown-it 的标记规则是 `~sub~` / `^sup^`（中间不允许再出现同字符）。
 *   实测 `x^2 + y^2` 有 3 个 `^`，回读时 `^2 + y^` **确实会配对成上标** →
 *   必须转义，否则内容在模式切换后变成 `x<sup>2 + y</sup>2` 而改变语义。
 *   而 `a^b^c` 会被解析成三个独立 text 节点（每个仅 1 个 `^`）→ 各自不转义。
 *   故实现采用「≥2 次才转义」，与 marker 正则的配对要求一致。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";

/**
 * 模拟「用户编辑过该块」：重建顶层块节点使其脱离 B6 原文映射，
 * 从而强制 docToMarkdown 走真实的 escapeText 序列化路径。
 */
function reparse(md: string): string {
  const doc = markdownToDoc(md);
  const kids = [];
  for (let i = 0; i < doc.childCount; i++) {
    const c = doc.child(i);
    kids.push(c.type.create(c.attrs, c.content, c.marks));
  }
  const fresh = doc.type.create(doc.attrs, kids, doc.marks);
  return docToMarkdown(fresh);
}

describe("v0.11.0 B3-4 转义噪音（绕过 B6 原文保留）", () => {
  it("单个 ~ 不转义（波浪号不被污染）", () => {
    expect(reparse("tilde ~ here")).toBe("tilde ~ here\n");
  });

  it("单个 ^ 不转义（脱字符不被污染）", () => {
    expect(reparse("a ^ b")).toBe("a ^ b\n");
  });

  it("波浪号两侧有其它内容时也不转义", () => {
    expect(reparse("a ~ b")).toBe("a ~ b\n");
  });

  it("可配对的 ^ 仍转义（防回读时变成上标而改变语义）", () => {
    // 实测：x^2 + y^2 回读时 ^2 + y^ 会配对成上标 → 必须转义
    const out = reparse("x^2 + y^2");
    expect(out).toContain("\\^");
  });

  it("可配对的 ~ 仍转义（防回读时变成删除线/下标）", () => {
    const out = reparse("a ~ b ~ c");
    expect(out).toContain("\\~");
  });

  it("已是 mark 的 ~del~~ 不走 escapeText（由 applyMark 处理，格式无损）", () => {
    // 解析后是 strike mark 而非纯文本 → escapeText 不参与
    const out = reparse("~~del~~");
    expect(out).toBe("~~del~~\n");
  });

  it("已是 mark 的 _em_ 不被二次转义（规范化为 *em*，既有行为）", () => {
    // CommonMark 中 _em_ 与 *em* 等价，serializer 统一输出 `*` 形式（既有行为，
    // 与 v0.11.0 无关）。关键是不产生 `\_` 这类无意义转义。
    const out = reparse("_em_");
    expect(out).toBe("*em*\n");
    expect(out).not.toContain("\\_");
  });

  it("$ 保持无条件转义（两个裸 $ 会配对成行内公式）", () => {
    // 即便只有一个 $ 也转义：金额($100)与公式($x$)在不看重上下文时无法区分
    const out = reparse("价格 $100");
    expect(out).toContain("\\$");
  });

  it("行内代码内的 ~ ^ $ 不受影响（不叠加二次转义）", () => {
    const out = reparse("`a~b`");
    expect(out).toContain("a~b");
  });

  it("既有的 * 与 _ 判定不回归", () => {
    // 单个 * 不转义（count>=2 才转）
    expect(reparse("2*3*4")).toBe("2*3*4\n");
    // 词内下划线不转义
    expect(reparse("snake_case_name")).toBe("snake_case_name\n");
  });

  it("往返一致性：转义后的输出再解析，内容与语义均不变", () => {
    for (const md of ["a ~ b", "a ^ b", "x^2 + y^2", "价格 $100", "2*3*4"]) {
      const out = reparse(md);
      // 再解析一次，文本内容应与原文本一致（转义符不改变语义）
      const reparsed = markdownToDoc(out);
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      expect(norm(reparsed.textContent)).toBe(norm(markdownToDoc(md).textContent));
    }
  });
});
