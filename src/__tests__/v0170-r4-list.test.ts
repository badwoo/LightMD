// @vitest-environment jsdom
/**
 * v0.17.0 R4 · #6 切回编辑自动重编号（有序列表归一化）
 *
 * ## 用户原话
 * 「我在编辑模式下输入有序列表，例如上下两行输入各输入 `1.`，阅读模式下是能成功渲染成
 * `1.` 和 `2.` 了，但切换回编辑模式还是两个 `1.`。我要求切回编辑模式后要**自动编号**。」
 *
 * ## 用户裁决（2026-11-12 17:07）
 * **自动合并并重编号成 `1.` `2.`（改写磁盘文本）**。
 *
 * ## 根因（**实测推翻了 Lead 的初始假设**，这是一条重要的订正）
 *
 * 初始假设是"`serializer.ts` 的 `listToMarkdown` 内部 `idx++` 没递增"。
 * 实测证明**递增逻辑是对的**：
 * ```
 * A. 手搓 order=1 两项（无 blockSource）→ "1. 甲\n2. 乙"   ← idx++ 正常
 * B. 解析 "1.甲\n1.乙" 后序列化        → "1. 甲\n1. 乙"   ← 两个 1.
 * ```
 *
 * 真因是 **`docToMarkdown` 的 B6「原文保留」快路径**（`serializer.ts`）：
 * 解析期用 `blockSourceMap`（WeakMap）给每个顶层块记了原文行号，
 * 未编辑文档序列化时**逐字节返回原文**（v0.9.0 为"保存零 diff"做的优化）
 * → `listToMarkdown` 的递增**根本没被执行**。
 *
 * 而且**不止一处**绕过（本文件逐一锁住，防下次只修一半）：
 * 1. `docToMarkdown` 的**整篇快路径**（全部块命中且行号连续 → 返回 `info.source`）
 * 2. `docToMarkdown` 逐块路径里的**块级原文切片**（`if (info) { ...slice... }`）
 * 3. `getMarkdownFromDoc` 的**序列化缓存**（只按 doc 引用做键，不区分选项）
 * 4. `nodeToMarkdown`（单块导出/粘贴路径）也有同样的 `getBlockSource` 快路径
 * 5. `core/editor.ts` 的 `onDocChange` 上报（走默认 `docToMarkdown`）
 *
 * ## 修法（按 Lead 要求"只在明确需要时启用"）
 * `docToMarkdown(doc, { normalizeOrderedLists: true })`：
 * - **默认不传 → 行为与历史完全一致**（B6 快路径生效，未编辑文档保存零 diff）
 * - `true` 时跳过上面 ①② 两条快路径，强制所有块走规范序列化 → 有序列表按
 *   `attrs.order` 逐项递增输出
 * - `getMarkdownFromDoc(doc, opts)` 透传；**带选项时不读不写缓存**（防污染保存/导出）
 *
 * ## 为什么用参数而不是改默认
 * `serializer` 是**所有路径的公共出口**（保存、导出、撤销时间线、滚动内容锚、AI 翻译…）。
 * 改默认会把"保存零 diff"契约连根拔掉，还可能把其它成员刚修好的滚动类问题弄回去。
 */
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown, nodeToMarkdown } from "../core/markdown/serializer";
import { getMarkdownFromDoc, clearSerializationCache } from "../core/editor";

const NORM = { normalizeOrderedLists: true } as const;

/** 便捷：解析 → 归一化序列化 */
function norm(md: string): string {
  return docToMarkdown(markdownToDoc(md), NORM);
}

describe("#6 · 默认路径行为零变化（回归护栏：改动不能影响其它调用点）", () => {
  it("不传选项时，两个 `1.` 仍原样返回（B6 快路径照旧生效）", () => {
    expect(docToMarkdown(markdownToDoc("1. 甲\n1. 乙\n"))).toBe("1. 甲\n1. 乙\n");
  });

  it("不传选项时，未编辑文档逐字节返回原文（B6「保存零 diff」契约仍在）", () => {
    const src = "# 标题\n\n正文段落\n\n1. a\n1. b\n\n- x\n- y\n";
    expect(docToMarkdown(markdownToDoc(src))).toBe(src);
  });

  it("不传选项时，nodeToMarkdown 的单块原文切片仍在", () => {
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    // 单块路径命中 blockSource → 返回原文切片
    expect(nodeToMarkdown(doc.child(0))).toBe("1. 甲\n1. 乙\n");
  });
});

describe("#6 · 归一化：两个 `1.` → `1.` `2.`", () => {
  it("★ 用户场景：`1. 甲 / 1. 乙` → `1. 甲 / 2. 乙`", () => {
    expect(norm("1. 甲\n1. 乙\n")).toBe("1. 甲\n2. 乙\n");
  });

  it("三项同理：`1./1./1.` → `1./2./3.`", () => {
    expect(norm("1. 甲\n1. 乙\n1. 丙\n")).toBe("1. 甲\n2. 乙\n3. 丙\n");
  });

  it("已经连号的 `1./2.` 不被改写（幂等，不产生 diff）", () => {
    expect(norm("1. 甲\n2. 乙\n")).toBe("1. 甲\n2. 乙\n");
  });

  it("中间列表 + 前后段落：只改编号，其余逐字节不变", () => {
    const md = "正常段落\n\n1. 甲\n1. 乙\n\n尾段\n";
    expect(norm(md)).toBe("正常段落\n\n1. 甲\n2. 乙\n\n尾段\n");
  });
});

describe("#6 · 边界", () => {
  it("起始非 1（`3. 甲/3. 乙`）→ 保持起点 3、后续递增（`3.` `4.`），不得改成 `1.` `2.`", () => {
    expect(norm("3. 甲\n3. 乙\n")).toBe("3. 甲\n4. 乙\n");
  });

  it("`)` 分隔符保留：`1) 甲/1) 乙` → `1) 甲/2) 乙`", () => {
    expect(norm("1) 甲\n1) 乙\n")).toBe("1) 甲\n2) 乙\n");
  });

  it("空行分隔的两个 `1.`：**也合并**（用户裁决：A 方案）", () => {
    // 实测证明 PM 层无法区分：两种写法解析出**同一个结构**
    // （1 个 ordered_list、2 项），只有 blockSource.end 不同（2 vs 3）。
    // 用户裁决「要自动编号」→ 两种写法都该编号。
    // ⚠️ 用 blockSource 的行距去区分会得到"编辑过就不合并"的**不可预测**行为，明确否决。
    expect(norm("1. 甲\n\n1. 乙\n")).toBe("1. 甲\n2. 乙\n");
  });

  it("嵌套列表：内外层都按各自起点递增", () => {
    const out = norm("1. 外层\n   1. 内层a\n   1. 内层b\n");
    expect(out).toContain("内层a");
    expect(out).toContain("内层b");
    // 内层第二项应从 2 开始
    expect(out).toMatch(/2[.)] 内层b/);
  });

  it("无序列表不受影响（没有序号可重排）", () => {
    expect(norm("- a\n- b\n")).toBe("- a\n- b\n");
  });

  it("列表中间夹代码块：代码块内容不被改写", () => {
    const md = "1. 甲\n1. 乙\n\n```\n1. 这是代码里的 1.\n```\n";
    const out = norm(md);
    expect(out).toContain("1. 这是代码里的 1.");
    expect(out).toContain("2. 乙");
  });
});

describe("#6 · 幂等性（重复切换不得累积改写）", () => {
  it("★ 归一化 → 再解析 → 再归一化：结果不变（切两次仍是 `1./2.`）", () => {
    for (const md of [
      "1. 甲\n1. 乙\n",
      "1. 甲\n1. 乙\n1. 丙\n",
      "3. 甲\n3. 乙\n",
      "1) 甲\n1) 乙\n",
      "正常段落\n\n1. 甲\n1. 乙\n\n尾段\n",
    ]) {
      const once = norm(md);
      const twice = norm(once);
      expect(twice, `不幂等：${md}`).toBe(once);
      const thrice = norm(twice);
      expect(thrice, `三轮仍应稳定：${md}`).toBe(once);
    }
  });
});

describe("#6 · getMarkdownFromDoc 的选项透传与缓存隔离", () => {
  it("带 normalizeOrderedLists 时返回归一化结果", () => {
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    expect(getMarkdownFromDoc(doc, NORM)).toBe("1. 甲\n2. 乙\n");
  });

  it("★ 带选项时**不写缓存**：随后默认调用仍返回原文（保存/导出不被污染）", () => {
    clearSerializationCache();
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    // 先走归一化
    expect(getMarkdownFromDoc(doc, NORM)).toBe("1. 甲\n2. 乙\n");
    // 再走默认（模拟保存/导出）→ 必须是原文，不能拿到被改写的文本
    expect(getMarkdownFromDoc(doc)).toBe("1. 甲\n1. 乙\n");
  });

  it("★ 带选项时**不读缓存**：先有默认缓存，归一化仍必须生效", () => {
    clearSerializationCache();
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    // 先建立默认缓存
    expect(getMarkdownFromDoc(doc)).toBe("1. 甲\n1. 乙\n");
    // 归一化不能命中该缓存
    expect(getMarkdownFromDoc(doc, NORM)).toBe("1. 甲\n2. 乙\n");
  });
});

describe("#6 · 归一化不得破坏 #2 的产物（两项联合）", () => {
  /**
   * #2 的产物是 `1. aa / - [ ] 2. bb / 3. cc`：
   * 三个独立块（ordered_list / task_list / ordered_list），
   * 序号已经"字面保持"且任务项自带 `2.`。
   * 归一化**绝不能**把它改成 `1./2./3.`，也不能抹掉任务项的 `2.`。
   */
  it("★ `1.` / `- [ ] 2.` / `3.` 经归一化后**序号与内容逐字节不变**", () => {
    for (const md of [
      "1. aa\n\n- [ ] 2. bb\n\n3. cc\n",
      "3. aa\n\n- [ ] 4. bb\n\n5. cc\n",
      "1) aa\n\n- [ ] 2) bb\n\n3) cc\n",
    ]) {
      expect(norm(md), `归一化破坏了 #2 产物：${md}`).toBe(md);
    }
  });

  it("★ 无空行版本的 #2 产物：序号/内容不变，但归一化会**补上块间空行**（已知格式差异）", () => {
    /**
     * 归一化跳过快路径 → 走逐块规范序列化 → 块与块之间会补一个空行。
     * 这不是"序号被破坏"，而是**格式规范化**：
     * ```
     * 归一化前： 1. aa / - [ ] 2. bb / 3. cc          （三行紧贴）
     * 归一化后： 1. aa / ⏎ / - [ ] 2. bb / ⏎ / 3. cc  （块间空行）
     * ```
     * 序号 `1.` / `2.` / `3.` 完全保持，任务项 `2.` 也保持。
     * 语义上两者解析出**完全相同的三个块**，视觉一致。
     * 报告里已记录：这是 #6 归一化的**唯一可见副作用**（仅影响"无空行写法"）。
     */
    const out = norm("1. aa\n- [ ] 2. bb\n3. cc\n");
    // 序号与内容不变
    expect(out).toContain("1. aa");
    expect(out).toContain("- [ ] 2. bb");
    expect(out).toContain("3. cc");
    // 归一化后带块间空行（规范形式）
    expect(out).toBe("1. aa\n\n- [ ] 2. bb\n\n3. cc\n");
    // 关键：解析出的块结构与归一化前完全相同（视觉不变）
    const before = markdownToDoc("1. aa\n- [ ] 2. bb\n3. cc\n");
    const after = markdownToDoc(out);
    const shape = (d: typeof before) => {
      const t: string[] = [];
      d.forEach((n) => t.push(`${n.type.name}:${n.textContent}`));
      return t;
    };
    expect(shape(after)).toEqual(shape(before));
  });

  it("★ 任务项首段的 `2. ` 是**文本**，序列化时必须原样保留", () => {
    const out = norm("1. aa\n\n- [ ] 2. bb\n\n3. cc\n");
    expect(out).toContain("- [ ] 2. bb");
    // 不得被归一化成 `- [ ] 2. 2. bb` 或 `- [ ] bb`
    expect(out).not.toContain("2. 2.");
  });
});

describe("#6 · 快路径清单（5 处，逐一锁住，防下次只修一半）", () => {
  // 这组断言的价值：下次有人加"归一化"需求时，按这份清单逐条排查，
  // 而不是像本轮一样"改一处、测出假绿、再改一处"。
  it("① 整篇快路径：归一化模式下不返回 info.source（看输出是否真的递增了）", () => {
    // 若整篇快路径没跳过，输出会是原文 `1. 甲\n1. 乙`
    expect(norm("1. 甲\n1. 乙\n")).toBe("1. 甲\n2. 乙\n");
  });

  it("② 块级原文切片：归一化模式下也不返回切片（否则 ① 修了仍无效）", () => {
    // 单块文档最能暴露：只有一个块时，"整篇快路径"与"块级切片"输出完全相同，
    // 必须靠**递增是否发生**来区分。实测第一版只修 ① 时本条失败。
    expect(norm("1. 甲\n1. 乙\n")).toBe("1. 甲\n2. 乙\n");
  });

  it("③ 序列化缓存：带选项时不读不写（见 getMarkdownFromDoc 那组）", () => {
    clearSerializationCache();
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    getMarkdownFromDoc(doc); // 建立默认缓存
    expect(getMarkdownFromDoc(doc, NORM)).toBe("1. 甲\n2. 乙\n");
  });

  it("④ nodeToMarkdown 单块路径：默认仍走原文切片（本函数未加归一化选项）", () => {
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    expect(nodeToMarkdown(doc.child(0))).toBe("1. 甲\n1. 乙\n");
  });

  it("⑤ onDocChange 上报：由调用方决定是否传选项（本文件锁 serializer 层契约）", () => {
    // core/editor.ts 的 onDocChange 走 `docToMarkdown(newState.doc)`（默认路径），
    // 因此它上报的是原文。**归一化必须由「阅读→编辑」那条路径的调用方传选项**。
    // 这里只锁"serializer 提供了这个能力且默认为关"。
    const doc = markdownToDoc("1. 甲\n1. 乙\n");
    expect(docToMarkdown(doc)).toBe("1. 甲\n1. 乙\n");
    expect(docToMarkdown(doc, NORM)).toBe("1. 甲\n2. 乙\n");
  });
});
