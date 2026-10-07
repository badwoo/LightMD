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
 * ⚠️ **判定口径 = sub/sup 插件的真实配对规则**（本机 markdown-it 探针实测）：
 *   插件（node_modules/markdown-it-sub|sup/index.mjs）要求分隔符之间**非空**
 *   且**不含未转义空白**，否则直接否决配对：
 *     `x^2 + y^2` → 2 个 `^`，中间含空格 → **不配对** → 不转义（首版误判为要转义）
 *     `x^2+y^2`   → 中间无空白 → 配对成上标 → **必须转义**
 *     `a ~ b ~ c` → 不配对；`a~b~c` → 配对成下标 → 必须转义
 *   [返修记录] 首版写成「节点内 ≥2 次就转义」，并把 `x^2 + y^2` 的转义结果
 *   当成期望锁进了测试，与 PLAN B3-4 验收①相反；现按真实配对语义实现并改正期望。
 *   判定使用整段行内文本，故 `a~**b**~c` 这类跨节点配对也能覆盖。
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

  it("【验收①】x^2 + y^2 含空格 → 不配对 → 不得产生反斜杠", () => {
    // [返修] 此前本用例断言 out.toContain("\\^")，即把「凭空多出反斜杠」这一
    // 缺陷本身写成了期望，与 PLAN B3-4 验收①（`x^2 + y^2` 存盘后无反斜杠）相反。
    // 实测确认：`x^2 + y^2` 只有 2 个 `^` 且中间含空格，sub/sup 插件直接否决配对。
    expect(reparse("x^2 + y^2")).toBe("x^2 + y^2\n");
  });

  it("a ~ b ~ c 含空格 → 不配对 → 不得产生反斜杠", () => {
    expect(reparse("a ~ b ~ c")).toBe("a ~ b ~ c\n");
  });

  it("可配对的 ^ 仍转义（源文本 x\\^2+y\\^2 是字面 ^，不转义会被回读成上标）", () => {
    // 真实风险用例：`\^` 转义源 → doc 里是**字面文本** "x^2+y^2"（无 sup 标记），
    // 若不转义直接写出 `x^2+y^2`，回读会被 sub/sup 插件配对成 `x<sup>2+y</sup>2`，
    // 语义被静默改变。故字面量中能配对的标记必须转义。
    const out = reparse("x\\^2+y\\^2");
    expect(out).toContain("\\^");
    // 且往返稳定
    expect(reparse(out)).toContain("\\^");
  });

  it("可配对的 ~ 仍转义（源文本 a\\~b\\~c 是字面 ~，不转义会被回读成下标）", () => {
    const out = reparse("a\\~b\\~c");
    expect(out).toContain("\\~");
    expect(reparse(out)).toContain("\\~");
  });

  it("已被插件解析成上下标标记的文本无需再转义（x^2+y^2 往返稳定）", () => {
    // 说明：`x^2+y^2` 解析后是 sup 标记（^ 是标记分隔符，不在 text 节点里），
    // 序列化时由 applyMark 输出 `^...^`，escapeText 不参与 → 不应出现反斜杠。
    expect(reparse("x^2+y^2")).toBe("x^2+y^2\n");
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
