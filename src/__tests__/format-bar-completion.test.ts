/**
 * 格式栏补全测试（P5）+ Mermaid 模板下拉测试（P20）
 *
 * 覆盖：
 * - FORMAT_BUTTONS 数组包含 H4/H5/H6/粗斜体/删除线按钮，且顺序符合任务要求
 * - buildFormatReplacement 对 h4/h5/h6/strikethrough/bolditalic 的输出正确
 * - buildFormatReplacement 对原有 action（bold/italic/code 等）保持向后兼容
 * - MERMAID_TEMPLATES 包含 7 个模板，每个 syntax 都是合法 mermaid 代码块
 * - 按钮顺序：撤销/恢复 | 分隔 | H1-H6 | 粗体/斜体/粗斜体/删除线/行内代码 | 代码块 | 列表/任务 | 引用/链接/图片/表格 | Mermaid/数学公式/分割线
 */
import { describe, it, expect } from "vitest";
import {
  FORMAT_BUTTONS,
  buildFormatReplacement,
  MERMAID_TEMPLATES,
} from "../components/editor/sourceFormat";

/** 获取所有非分隔符按钮的 action 列表 */
function getActions() {
  return FORMAT_BUTTONS.filter((b) => !b.isSeparator).map((b) => b.action);
}

/** 获取所有非分隔符按钮的 label 列表 */
function getLabels() {
  return FORMAT_BUTTONS.filter((b) => !b.isSeparator).map((b) => b.label);
}

// ─── FORMAT_BUTTONS 数组结构 ─────────────────────
describe("FORMAT_BUTTONS - 按钮配置完整性", () => {
  it("应包含 H4/H5/H6 按钮", () => {
    const actions = getActions();
    expect(actions).toContain("h4");
    expect(actions).toContain("h5");
    expect(actions).toContain("h6");
  });

  it("应包含粗斜体按钮（bolditalic）", () => {
    expect(getActions()).toContain("bolditalic");
  });

  it("应包含删除线按钮（strikethrough）", () => {
    expect(getActions()).toContain("strikethrough");
  });

  it("H4/H5/H6 按钮应显示对应标签", () => {
    const h4 = FORMAT_BUTTONS.find((b) => b.action === "h4");
    const h5 = FORMAT_BUTTONS.find((b) => b.action === "h5");
    const h6 = FORMAT_BUTTONS.find((b) => b.action === "h6");
    expect(h4?.label).toBe("H4");
    expect(h5?.label).toBe("H5");
    expect(h6?.label).toBe("H6");
  });

  it("粗斜体按钮 label 应为 'BI'", () => {
    const bi = FORMAT_BUTTONS.find((b) => b.action === "bolditalic");
    expect(bi?.label).toBe("BI");
  });

  it("Mermaid 按钮应标记 hasDropdown=true", () => {
    const mermaid = FORMAT_BUTTONS.find((b) => b.action === "mermaid");
    expect(mermaid?.hasDropdown).toBe(true);
  });

  it("其他按钮 hasDropdown 应为 undefined 或 false", () => {
    const others = FORMAT_BUTTONS.filter((b) => b.action !== "mermaid" && !b.isSeparator);
    others.forEach((b) => {
      expect(!!b.hasDropdown).toBe(false);
    });
  });
});

// ─── 按钮顺序 ────────────────────────────────────
describe("FORMAT_BUTTONS - 按钮顺序", () => {
  it("H1~H6 应连续排列", () => {
    const actions = getActions();
    const h1Idx = actions.indexOf("h1");
    const h6Idx = actions.indexOf("h6");
    expect(h1Idx).toBeGreaterThanOrEqual(0);
    expect(h6Idx).toBe(h1Idx + 5); // H1~H6 连续 6 个
  });

  it("粗体/斜体/粗斜体/删除线/行内代码 应连续排列", () => {
    const actions = getActions();
    const boldIdx = actions.indexOf("bold");
    expect(actions[boldIdx + 1]).toBe("italic");
    expect(actions[boldIdx + 2]).toBe("bolditalic");
    expect(actions[boldIdx + 3]).toBe("strikethrough");
    expect(actions[boldIdx + 4]).toBe("code");
  });

  it("第一个分隔符应在 undo/redo 之后", () => {
    const sepIdx = FORMAT_BUTTONS.findIndex((b) => b.isSeparator);
    const redoIdx = FORMAT_BUTTONS.findIndex((b) => b.action === "redo");
    expect(sepIdx).toBeGreaterThan(redoIdx);
  });

  it("撤销/恢复在最前面", () => {
    expect(FORMAT_BUTTONS[0].action).toBe("undo");
    expect(FORMAT_BUTTONS[1].action).toBe("redo");
  });
});

// ─── buildFormatReplacement：新增 action ────────
describe("buildFormatReplacement - 新增格式 action", () => {
  // H4/H5/H6
  it("h4 选中 → '#### text'，光标到末尾", () => {
    const r = buildFormatReplacement("h4", "标题")!;
    expect(r.replacement).toBe("#### 标题");
    expect(r.cursorOffset).toBe(7); // 5 + 2
  });
  it("h4 无选中 → '#### 标题四'，光标在 '#### ' 之后", () => {
    const r = buildFormatReplacement("h4", "")!;
    expect(r.replacement).toBe("#### 标题四");
    expect(r.cursorOffset).toBe(5);
  });
  it("h5 选中 → '##### text'", () => {
    const r = buildFormatReplacement("h5", "x")!;
    expect(r.replacement).toBe("##### x");
    expect(r.cursorOffset).toBe(7); // 6 + 1
  });
  it("h5 无选中 → '##### 标题五'", () => {
    const r = buildFormatReplacement("h5", "")!;
    expect(r.replacement).toBe("##### 标题五");
    expect(r.cursorOffset).toBe(6);
  });
  it("h6 选中 → '###### text'", () => {
    const r = buildFormatReplacement("h6", "title")!;
    expect(r.replacement).toBe("###### title");
    expect(r.cursorOffset).toBe(12); // 7 + 5
  });
  it("h6 无选中 → '###### 标题六'", () => {
    const r = buildFormatReplacement("h6", "")!;
    expect(r.replacement).toBe("###### 标题六");
    expect(r.cursorOffset).toBe(7);
  });

  // 粗斜体
  it("bolditalic 选中 → '***text***'，光标到末尾", () => {
    const r = buildFormatReplacement("bolditalic", "x")!;
    expect(r.replacement).toBe("***x***");
    expect(r.cursorOffset).toBe(7); // 3 + 1 + 3
  });
  it("bolditalic 无选中 → '***粗斜体***'，光标在 *** 之后", () => {
    const r = buildFormatReplacement("bolditalic", "")!;
    expect(r.replacement).toBe("***粗斜体***");
    expect(r.cursorOffset).toBe(3);
  });

  // 删除线
  it("strikethrough 选中 → '~~text~~'，光标到末尾", () => {
    const r = buildFormatReplacement("strikethrough", "del")!;
    expect(r.replacement).toBe("~~del~~");
    expect(r.cursorOffset).toBe(7); // 2 + 3 + 2
  });
  it("strikethrough 无选中 → '~~删除线~~'，光标在 ~~ 之后", () => {
    const r = buildFormatReplacement("strikethrough", "")!;
    expect(r.replacement).toBe("~~删除线~~");
    expect(r.cursorOffset).toBe(2);
  });
});

// ─── buildFormatReplacement：原有 action 向后兼容 ─
describe("buildFormatReplacement - 原有 action 兼容", () => {
  it("bold 选中 → '**text**'", () => {
    const r = buildFormatReplacement("bold", "x")!;
    expect(r.replacement).toBe("**x**");
    expect(r.cursorOffset).toBe(5);
  });
  it("bold 无选中 → '**粗体文本**'，光标在 ** 之后", () => {
    const r = buildFormatReplacement("bold", "")!;
    expect(r.replacement).toBe("**粗体文本**");
    expect(r.cursorOffset).toBe(2);
  });
  it("italic 选中 → '*text*'", () => {
    const r = buildFormatReplacement("italic", "x")!;
    expect(r.replacement).toBe("*x*");
    expect(r.cursorOffset).toBe(3);
  });
  it("code 选中 → '`text`'", () => {
    const r = buildFormatReplacement("code", "x")!;
    expect(r.replacement).toBe("`x`");
    expect(r.cursorOffset).toBe(3);
  });
  it("h1 选中 → '# text'", () => {
    const r = buildFormatReplacement("h1", "标题")!;
    expect(r.replacement).toBe("# 标题");
    expect(r.cursorOffset).toBe(4); // 2 + 2
  });
  it("h1 无选中 → '# 标题一'", () => {
    const r = buildFormatReplacement("h1", "")!;
    expect(r.replacement).toBe("# 标题一");
    expect(r.cursorOffset).toBe(2);
  });
  it("math → 块级公式模板", () => {
    const r = buildFormatReplacement("math", "")!;
    expect(r.replacement).toContain("$$");
    expect(r.replacement).toContain("\\sum");
  });
  it("table → Markdown 表格模板", () => {
    const r = buildFormatReplacement("table", "")!;
    expect(r.replacement).toContain("| 列1 |");
    expect(r.replacement).toContain("|------|");
  });
  it("link 选中 → '[text](url)'", () => {
    const r = buildFormatReplacement("link", "示例")!;
    expect(r.replacement).toBe("[示例](url)");
  });
  it("image 选中 → '![text](url)'", () => {
    const r = buildFormatReplacement("image", "图")!;
    expect(r.replacement).toBe("![图](url)");
  });
  it("hr → 分割线", () => {
    const r = buildFormatReplacement("hr", "")!;
    expect(r.replacement).toBe("\n---\n");
  });
  it("未知 action 返回 null", () => {
    expect(buildFormatReplacement("unknown", "")).toBeNull();
  });
});

// ─── MERMAID_TEMPLATES ────────────────────────────
describe("MERMAID_TEMPLATES - Mermaid 模板下拉", () => {
  it("应包含 7 个模板", () => {
    expect(MERMAID_TEMPLATES).toHaveLength(7);
  });

  it("应包含 Flowchart/Sequence/State/Gantt/Pie/ER图/Gitgraph", () => {
    const labels = MERMAID_TEMPLATES.map((t) => t.label);
    expect(labels).toContain("Flowchart");
    expect(labels).toContain("Sequence");
    expect(labels).toContain("State");
    expect(labels).toContain("Gantt");
    expect(labels).toContain("Pie");
    expect(labels).toContain("ER图");
    expect(labels).toContain("Gitgraph");
  });

  it("每个模板 syntax 都是合法 mermaid 代码块（包裹在 ```mermaid 中）", () => {
    MERMAID_TEMPLATES.forEach((t) => {
      expect(t.syntax).toContain("```mermaid");
      // 至少有一个换行后的 mermaid 关键字
      expect(t.syntax).toMatch(/```mermaid\n(\w+)/);
    });
  });

  it("Flowchart 模板使用 graph TD 语法", () => {
    const flow = MERMAID_TEMPLATES.find((t) => t.label === "Flowchart")!;
    expect(flow.syntax).toContain("graph TD");
    expect(flow.syntax).toContain("A[开始]");
    expect(flow.syntax).toContain("-->");
  });

  it("Sequence 模板使用 sequenceDiagram", () => {
    const seq = MERMAID_TEMPLATES.find((t) => t.label === "Sequence")!;
    expect(seq.syntax).toContain("sequenceDiagram");
    expect(seq.syntax).toContain("participant");
  });

  it("State 模板使用 stateDiagram-v2", () => {
    const st = MERMAID_TEMPLATES.find((t) => t.label === "State")!;
    expect(st.syntax).toContain("stateDiagram-v2");
  });

  it("Gantt 模板使用 gantt", () => {
    const g = MERMAID_TEMPLATES.find((t) => t.label === "Gantt")!;
    expect(g.syntax).toContain("gantt");
    expect(g.syntax).toContain("title");
  });

  it("Pie 模板使用 pie title", () => {
    const p = MERMAID_TEMPLATES.find((t) => t.label === "Pie")!;
    expect(p.syntax).toContain("pie title");
  });

  it("ER图 模板使用 erDiagram", () => {
    const er = MERMAID_TEMPLATES.find((t) => t.label === "ER图")!;
    expect(er.syntax).toContain("erDiagram");
    expect(er.syntax).toContain("CUSTOMER");
  });

  it("Gitgraph 模板使用 gitGraph", () => {
    const gg = MERMAID_TEMPLATES.find((t) => t.label === "Gitgraph")!;
    expect(gg.syntax).toContain("gitGraph");
    expect(gg.syntax).toContain("branch develop");
  });

  it("每个模板 label 唯一", () => {
    const labels = MERMAID_TEMPLATES.map((t) => t.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });

  it("每个模板 syntax 唯一（不重复）", () => {
    const syntaxes = MERMAID_TEMPLATES.map((t) => t.syntax);
    const unique = new Set(syntaxes);
    expect(unique.size).toBe(syntaxes.length);
  });
});
