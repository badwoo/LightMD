/**
 * v0.17.0 B1 —— 图片 `|WIDTH|ALIGN` 后缀解析单点化：**用真实实现做差异锁死**。
 *
 * ## 这个测试存在的理由
 *
 * 评估报告 §2.2："`splitImageSuffix` 双实现"的说法与源码不符 ——
 * 只有 `core/renderPipeline.ts:77` 一份同名函数，PM 侧是
 * `core/markdown/parser.ts:1318-1360` 的**另一套内联实现**（segs 切分）。
 * 收敛时最危险的做法是"删掉一份就宣布完成"：那会把两套实现在**畸形输入**上的
 * 行为差异悄悄抹平，且没有任何测试记录差异。
 *
 * ## 为什么这个版本用真实实现而不是复刻副本
 *
 * 第一版我用"手抄两套旧实现的副本"做对照，结果**测试自己错了 3 处**；
 * 换成真实实现后又错了 1 处（我以为 `a|b|center` 两边一致，实测 renderPipeline
 * 会剥 `center` 而 parser 不会）。两次错误都说明同一件事：
 * **手写基准 = 把自己的理解当成事实**。只有读真实实现，差异才是证据。
 * 现在直接读**真实实现**：
 * - renderPipeline：`getRenderMarkdownIt().parse()` → 读插件写入的 `token.content` + `__lightmdImage`
 * - parser：`markdownToDoc()` → 读 PM image 节点 attrs
 * 这样差异是**实测证据**，不是我的记忆。
 */
import { describe, it, expect } from "vitest";
import { parseImageSuffix, escapeImageAlt } from "../../core/unified/imageSuffix";
import { getRenderMarkdownIt } from "../../core/renderPipeline";
import { markdownToDoc } from "../../core/markdown/parser";

/** 用真实 renderPipeline 解析 `![content](x.png)`，取插件产出的 {content, width, align} */
function realRenderPipeline(content: string): {
  /** 剥离后缀后的 alt 原文（仍含 `\|` 转义） */
  content: string;
  width?: string;
  align?: string;
} {
  const md = getRenderMarkdownIt();
  const tokens = md.parse(`![${content}](x.png)`, {}) as unknown as Array<{
    type: string;
    children?: Array<{ type: string; content: string; __lightmdImage?: { width?: string; align?: string } }>;
  }>;
  for (const t of tokens) {
    if (t.type !== "inline" || !t.children) continue;
    for (const c of t.children) {
      if (c.type !== "image") continue;
      const extra = c.__lightmdImage || {};
      return { content: c.content, width: extra.width, align: extra.align };
    }
  }
  return { content };
}

/** 用真实 parser 解析 `![content](x.png)`，取 PM image 节点 attrs（`align` 默认 "left"） */
function realParser(content: string): { alt: string; width: number | null; align: "left" | "center" | "right" } {
  const doc = markdownToDoc(`![${content}](x.png)`);
  let out: { alt: string; width: number | null; align: "left" | "center" | "right" } = {
    alt: "",
    width: null,
    align: "left",
  };
  doc.descendants((n) => {
    if (n.type.name !== "image") return;
    out = {
      alt: String(n.attrs.alt ?? ""),
      width: typeof n.attrs.width === "number" ? n.attrs.width : null,
      align: (n.attrs.align as "left" | "center" | "right") ?? "left",
    };
  });
  return out;
}

/** 把三种实现的输出归一化成可比形状（消除"表达差异"：string vs number、undefined vs "left"） */
function shape(
  alt: string,
  width: string | number | null | undefined,
  align: string | undefined,
): { alt: string; width: number | undefined; align: "center" | "right" | undefined } {
  const w = width === null || width === undefined || width === "" ? undefined : Number(width);
  // `left` 是 schema 默认值 / 旧实现 A 的无值形态 → 统一成 undefined（"源码没声明"）
  const a = align === "center" || align === "right" ? align : undefined;
  return { alt: alt.replace(/\\\|/g, "|"), width: w, align: a };
}

const fromRenderPipeline = (c: string) => {
  const r = realRenderPipeline(c);
  return shape(r.content, r.width, r.align);
};
const fromParser = (c: string) => {
  const r = realParser(c);
  return shape(r.alt, r.width, r.align);
};
const fromUnified = (c: string) => {
  const r = parseImageSuffix(c);
  return shape(r.alt, r.width, r.align);
};

describe("合法输入：三处实现（真实 renderPipeline / 真实 parser / 新单点）必须一致", () => {
  const LEGAL = [
    "alt",
    "alt|300",
    "alt|center",
    "alt|right",
    "alt|300|center",
    "alt|300|right",
    "中文 alt|640|center",
    "a\\|b", // alt 含字面竖线（序列化写成 \|）
    "a\\|b|300",
    "a\\|b|300|center",
  ];

  it.each(LEGAL)("合法形态 %s：renderPipeline 与 parser 一致", (content) => {
    expect(fromRenderPipeline(content)).toEqual(fromParser(content));
  });

  it.each(LEGAL)("合法形态 %s：新单点实现 == 两者（收口不引入行为变化）", (content) => {
    const expected = fromParser(content);
    expect(fromUnified(content)).toEqual(expected);
  });
});

/**
 * 收口前的真实分叉（历史记录，由 `git log` 的 B1 提交可查）。
 *
 * 下表是**收口前**实测到的差异，保留在注释里作为"为什么必须收口"的证据：
 *
 * | content | 收口前 renderPipeline（尾剥离） | 收口前 parser（segs） |
 * |---|---|---|
 * | `a|1|b` | alt=`a|1|b`, 无 width | alt=`a`, width=1 |
 * | `a|300|400` | alt=`a|300`, width=400 | alt=`a`, width=300 |
 * | `a|0` | alt=`a`, width=0（接受 0） | alt=`a|0`, 无 width（要求 >0） |
 * | `a|b|center` | alt=`a|b`, align=center | alt=`a|b|center`, 无 align |
 *
 * 收口后两者**必须完全一致** —— 这个 describe 就是"收口真的生效了"的机械化证明。
 * 若将来有人把某处改回独立实现，这里会立刻红。
 */
describe("收口验证：同一输入在 renderPipeline 与 parser 必须给出完全相同的结果", () => {
  const MALFORMED = ["a|1|b", "a|300|400", "a|0", "a|b|center", "a|1|2|3", "a||b", "|300|"];

  it.each(MALFORMED)("畸形形态 %s：renderPipeline == parser（分叉已消除）", (content) => {
    expect(fromRenderPipeline(content)).toEqual(fromParser(content));
  });

  it.each(MALFORMED)("畸形形态 %s：单点实现 == 两者（唯一事实源）", (content) => {
    expect(fromUnified(content)).toEqual(fromParser(content));
  });

  it("`a|0`：收口后统一为 parser 语义（拒绝 width=0，alt 整串保留）", () => {
    // 这条是**唯一一处渲染行为变化**：旧 renderPipeline 会输出 width="0"，
    // 收口后遵循 parser 的 `w > 0` 规则，alt 保持 `a|0`、无 width。
    // width=0 的图片本就不可见，且 `![a|0]` 更可能本意是 alt 含竖线 —— 收口是改善。
    expect(fromRenderPipeline("a|0")).toEqual({ alt: "a|0", width: undefined, align: undefined });
    expect(fromParser("a|0")).toEqual({ alt: "a|0", width: undefined, align: undefined });
  });
});

describe("写回链路护栏：往返必须可逆（这是 serializer ↔ parser 的地基）", () => {
  it("无后缀时 alt 中的 `\\|` 被还原为 `|`", () => {
    expect(parseImageSuffix("a\\|b").alt).toBe("a|b");
  });

  it("escapeImageAlt / parseImageSuffix 互逆（含竖线的纯 alt 往返无损）", () => {
    for (const alt of ["a|b", "x|y|z", "表格 | 图"]) {
      expect(parseImageSuffix(escapeImageAlt(alt)).alt).toBe(alt);
    }
  });

  it("宽度必须是正整数：0 / 负数 / 小数 / 带单位都不认", () => {
    expect(parseImageSuffix("a|0").width).toBeUndefined();
    expect(parseImageSuffix("a|-5").width).toBeUndefined();
    expect(parseImageSuffix("a|1.5").width).toBeUndefined();
    expect(parseImageSuffix("a|300px").width).toBeUndefined();
    // 没消费任何后缀段 → alt 保持整串
    expect(parseImageSuffix("a|0").alt).toBe("a|0");
    expect(parseImageSuffix("a|300px").alt).toBe("a|300px");
  });

  it("对齐只认 center/right（大小写不敏感）；`left` 是默认值，写了不消费", () => {
    expect(parseImageSuffix("a|left").align).toBeUndefined();
    expect(parseImageSuffix("a|left").alt).toBe("a|left");
    expect(parseImageSuffix("a|center").align).toBe("center");
    expect(parseImageSuffix("a|RIGHT").align).toBe("right");
  });

  it("空 content 不炸（image token content 可为空）", () => {
    expect(parseImageSuffix("")).toEqual({ alt: "" });
    expect(parseImageSuffix("|300").alt).toBe("");
    expect(parseImageSuffix("|300").width).toBe(300);
  });

  it("`\\|` 不当作分隔符（含竖线 alt + 后缀共存）", () => {
    // `a\|b|300`：`\|` 属于 alt，`|300` 才是后缀
    expect(parseImageSuffix("a\\|b|300")).toEqual({ alt: "a|b", width: 300 });
  });
});
