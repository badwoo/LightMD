/**
 * v0.16.0 需求（Tab 与缩进体系）B4：源码（编辑）模式 Tab / Shift+Tab 缩进 —— 修 D2【P0】
 *
 * D2 现象（真实浏览器实测）：textarea 内 value 不变、defaultPrevented=false、
 * 焦点从 `.source-editor` 逃到 `.split-divider-label`；列表行、多行选区、
 * 围栏代码块内全都不缩进。根因：`handleSourceKeyDown` 里 Tab 只有「配对跳出」
 * 一个分支，无任何缩进落地，且未 preventDefault → 焦点按浏览器默认 Tab 顺序逃逸。
 *
 * 本文件覆盖两层：
 * 1. **纯规划器**（utils/sourceIndent）——最重要的部分，不依赖 DOM：
 *    折叠光标 / 单行选区 / 多行选区 / 行首缩进精度 / 单次替换计划。
 * 2. **EditorContainer 接线**——组件依赖 ProseMirror + Tauri + 大量 store，
 *    直测成本过高；这里用源码静态断言（本项目既有做法，见 v0.3.0-fixes /
 *    v0.5.0-auto-pair 的 readSrc）：断言缩进分支存在、位置在配对跳出之后、
 *    且 `preventDefault` **无条件**执行（不是只在有编辑时）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  planSourceIndent,
  planSourceOutdent,
  type SourceIndentInput,
} from "../utils/sourceIndent";
import type { SourcePairPlan } from "../utils/sourceAutoPair";
// 落地函数与编辑器同源（同一份 execCommand 路径）
import { applySourcePairPlan } from "../components/editor/EditorContainer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}

/** 取 EditorContainer 里新增的源码缩进分支源码（锚点 → 该 if 分支结束后的既有注释） */
const INDENT_ANCHOR = "// v0.16.0 需求（Tab 与缩进体系）：源码模式缩进（Tab / Shift+Tab）";
function indentBranchSrc(srcText: string): string {
  const at = srcText.indexOf(INDENT_ANCHOR);
  expect(at).toBeGreaterThan(-1);
  const end = srcText.indexOf("// ─── v0.12.1 需求4：删除/跳过类交互", at);
  expect(end).toBeGreaterThan(at);
  return srcText.slice(at, end);
}

/** 把计划落地到一段文本（模拟 applySourcePairPlan 的文本效果，便于断言最终 value） */
function applyPlan(value: string, plan: SourcePairPlan): { value: string; caret: number; caretEnd: number } {
  if (plan.kind !== "edit") return { value, caret: -1, caretEnd: -1 };
  const { from, to, text, caret, caretEnd } = plan.edit;
  return {
    value: value.slice(0, from) + text + value.slice(to),
    caret,
    caretEnd: caretEnd ?? caret,
  };
}

function indentAt(value: string, start: number, end: number, unit = "  "): SourcePairPlan {
  const input: SourceIndentInput = { value, start, end, unit };
  return planSourceIndent(input);
}

function outdentAt(value: string, start: number, end: number, unit = "  "): SourcePairPlan {
  const input: SourceIndentInput = { value, start, end, unit };
  return planSourceOutdent(input);
}

// ─── 1. planSourceIndent ────────────────────────────────────────────

describe("v0.16.0 B4：planSourceIndent 缩进规划", () => {
  it("整段选中（选区覆盖所有行）→ 每行行首各加一个单位", () => {
    const res = applyPlan("alpha\nbeta", indentAt("alpha\nbeta", 0, 10));
    expect(res.value).toBe("  alpha\n  beta");
  });

  it("折叠光标 → 在光标处插入单位（不是跳到行首）", () => {
    const res = applyPlan("hello", indentAt("hello", 2, 2));
    expect(res.value).toBe("he  llo");
    expect(res.caret).toBe(4);
    // 单次替换计划：一个 edit、区间折叠
    const plan = indentAt("hello", 2, 2);
    expect(plan.kind).toBe("edit");
  });

  it("折叠光标在行首（空行 / 块首）→ 插入单位且光标右移", () => {
    const res = applyPlan("ab\ncd", indentAt("ab\ncd", 3, 3));
    expect(res.value).toBe("ab\n  cd");
    expect(res.caret).toBe(5);
  });

  it("多行选区只覆盖一行 → 只缩进那一行", () => {
    const res = applyPlan("aaa\nbbb\nccc", indentAt("aaa\nbbb\nccc", 4, 7));
    expect(res.value).toBe("aaa\n  bbb\nccc");
  });

  it("选区终点落在下一行行首 → 该行不算选区内（不缩进该行）", () => {
    // end = 3 恰为第二行行首（"aaa" 后），用户选中的是 `aaa` 本身
    const res = applyPlan("aaa\nbbb", indentAt("aaa\nbbb", 0, 3));
    expect(res.value).toBe("  aaa\nbbb");
  });

  it("多行选区 → 产出的仍是**单次** replace（一次撤销）", () => {
    const plan = indentAt("a\nb\nc", 0, 5);
    expect(plan.kind).toBe("edit");
    if (plan.kind !== "edit") throw new Error("expected edit");
    // 计划里只有一组 from/to/text：任何区间内插入都被合并进这一次替换
    expect(typeof plan.edit.from).toBe("number");
    expect(typeof plan.edit.to).toBe("number");
    expect(plan.edit.from).toBe(0);
  });

  it("多行选区缩进后，原选中文本仍保持选中（两端各右移插入量）", () => {
    const value = "alpha\nbeta";
    const start = 0;
    const end = 10; // 覆盖全文
    const plan = indentAt(value, start, end);
    const res = applyPlan(value, plan);
    expect(res.value).toBe("  alpha\n  beta");
    // 起点本来就落在行首（插入点 == 起点）→ 起点不动，新插入的缩进进入选区；
    // 终点右移 2 个单位（4）→ 选区覆盖完整的缩进后文本（与 VS Code 整行选中一致）
    expect(res.caret).toBe(0);
    expect(res.caretEnd).toBe(14);
    expect(res.value.slice(res.caret, res.caretEnd)).toBe("  alpha\n  beta");
  });

  it("unit=4 空格 / tab 均按单位长度插入", () => {
    expect(applyPlan("a", indentAt("a", 0, 0, "    ")).value).toBe("    a");
    expect(applyPlan("a", indentAt("a", 0, 0, "\t")).value).toBe("\ta");
  });

  it("围栏代码块内（只是普通行）同样缩进 —— 规划器不判上下文", () => {
    const value = "```ts\nconst a = 1;\n```";
    // 光标在 `const` 前（行首）
    const at = value.indexOf("const");
    const res = applyPlan(value, indentAt(value, at, at));
    expect(res.value).toBe("```ts\n  const a = 1;\n```");
  });

  it("空文本 / 空选区不产生异常（行首 = 0）", () => {
    expect(applyPlan("", indentAt("", 0, 0)).value).toBe("  ");
  });

  it("连续 Tab：选区保持稳定（不塌缩、不把缩进挤出选区）", () => {
    let value = "aa\nbb";
    let selStart = 0;
    let selEnd = value.length;
    for (let i = 0; i < 3; i++) {
      const plan = planSourceIndent({ value, start: selStart, end: selEnd, unit: "  " });
      if (plan.kind !== "edit") throw new Error("expected edit");
      value = value.slice(0, plan.edit.from) + plan.edit.text + value.slice(plan.edit.to);
      selStart = plan.edit.caret;
      selEnd = plan.edit.caretEnd ?? plan.edit.caret;
    }
    expect(value).toBe("      aa\n      bb");
    // 三次 Tab 后仍是整段选中（选区没有塌缩到行首，也没有把新缩进挤到选区外）
    expect(selStart).toBe(0);
    expect(selEnd).toBe(value.length);
  });
});

// ─── 2. planSourceOutdent ───────────────────────────────────────────

describe("v0.16.0 B4：planSourceOutdent 反缩进规划", () => {
  it("折叠光标在 4 空格行首 → 只删一个单位（4→2，不是清零）", () => {
    const res = applyPlan("    a", outdentAt("    a", 4, 4));
    expect(res.value).toBe("  a");
    expect(res.caret).toBe(2);
  });

  it("行首是 \\t → 识别为制表符缩进并删 1 个字符（即使当前单位是空格）", () => {
    const res = applyPlan("\ta", outdentAt("\ta", 1, 1));
    expect(res.value).toBe("a");
  });

  it("光标到行首之间不是纯空白（行中）→ 返回 none（上层吞键但不产生编辑）", () => {
    expect(outdentAt("a b", 2, 2).kind).toBe("none");
  });

  it("行首无缩进 → none（不吞掉行首字符）", () => {
    expect(outdentAt("abc", 1, 1).kind).toBe("none");
  });

  it("光标在行首（缩进已删净）→ none", () => {
    expect(outdentAt("  a", 0, 0).kind).toBe("none");
  });

  it("多行选区 → 每行各删一个单位，合并为单次 replace", () => {
    const res = applyPlan("    a\n    b", outdentAt("    a\n    b", 0, 11));
    expect(res.value).toBe("  a\n  b");
  });

  it("多行选区中夹杂无缩进行 → 该行保持原样（不吞字符）", () => {
    const res = applyPlan("  a\nb\n  c", outdentAt("  a\nb\n  c", 0, 8));
    expect(res.value).toBe("a\nb\nc");
  });

  it("选区只覆盖一行 → 只反缩进那一行", () => {
    // 选区终点不落在下一行行首，否则该行不被算进选区（见 lineStartsInRange 口径）
    const res = applyPlan("  a\n  b", outdentAt("  a\n  b", 4, 6));
    expect(res.value).toBe("  a\nb");
  });

  it("选区内有缩进行均以 \\t 起始时，同样逐行删 1 字符", () => {
    const res = applyPlan("\ta\n\tb", outdentAt("\ta\n\tb", 0, 5));
    expect(res.value).toBe("a\nb");
  });
});

// ─── 3. EditorContainer 接线（源码静态断言） ───────────────────────────

describe("v0.16.0 B4：EditorContainer handleSourceKeyDown 接线", () => {
  const src = readSrc("src/components/editor/EditorContainer.tsx");

  it("handleSourceKeyDown 内调用两个缩进规划器", () => {
    const start = src.indexOf("const handleSourceKeyDown = useCallback");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("}, [isSourceMode, isMdFile, autoPairEnabled]", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toMatch(/planSourceIndent\(/);
    expect(body).toMatch(/planSourceOutdent\(/);
  });

  it("缩进分支在「Tab 配对跳出」之后、parseShortcut 之前（优先级链不变）", () => {
    const start = src.indexOf("const handleSourceKeyDown = useCallback");
    const tabOut = src.indexOf("planSourceTab(", start);
    const indent = src.indexOf("planSourceIndent(", start);
    const parse = src.indexOf("parseShortcut(e.nativeEvent)", start);
    expect(tabOut).toBeGreaterThan(-1);
    expect(indent).toBeGreaterThan(tabOut);
    expect(parse).toBeGreaterThan(indent);
  });

  it("e.preventDefault() 在缩进分支内**无条件**执行（不是只在 plan.kind === \"edit\" 时）", () => {
    const seg = indentBranchSrc(src);
    const prevent = seg.indexOf("e.preventDefault()");
    const editCheck = seg.indexOf('plan.kind === "edit"');
    expect(prevent).toBeGreaterThan(-1);
    // preventDefault 不能只写在 plan.kind 判定内 → 无条件 + 分支末尾无条件 return
    expect(editCheck === -1 || prevent < editCheck).toBe(true);
    expect(seg).toMatch(/return;\s*\/\/\s*无论 edit 还是 none 都吞键/);
  });

  it("缩进分支覆盖 Shift+Tab（不排除 e.shiftKey）且排除 Ctrl/Meta/Alt 组合键", () => {
    const seg = indentBranchSrc(src);
    expect(seg).toMatch(/e\.key === "Tab"/);
    expect(seg).toMatch(/!e\.ctrlKey/);
    expect(seg).toMatch(/!e\.metaKey/);
    expect(seg).toMatch(/!e\.altKey/);
    // Shift 用于区分正/反缩进，不能被排除
    expect(seg).not.toMatch(/!e\.shiftKey &&/);
    expect(seg).toMatch(/e\.shiftKey/);
  });

  it("使用 indentUnitString(useSettingsStore...indentUnit) 作为唯一缩进口径", () => {
    const seg = indentBranchSrc(src);
    expect(seg).toMatch(/indentUnitString\(/);
    expect(seg).toMatch(/indentUnit/);
    expect(seg).toMatch(/useSettingsStore\.getState\(\)\.indentUnit/);
  });

  it("ghost 活跃时不接管（sourceGhostActiveRef 守卫）", () => {
    const seg = indentBranchSrc(src);
    expect(seg).toMatch(/sourceGhostActiveRef\.current/);
  });

  it("落地复用 applySourcePairPlan（一次 execCommand = 一次撤销）", () => {
    const seg = indentBranchSrc(src);
    expect(seg).toMatch(/applySourcePairPlan\(ta, plan\)/);
  });
});

// ─── 4. 落地行为：applySourcePairPlan 落到真实 textarea（jsdom） ──────────
//
// 上一节是源码静态断言；这里用真实 `<textarea>` 验证「规划 → 落地」的可观测结果：
// value 真的变了、光标真的落在预期位置、一次编辑只触发**一次** input 事件
// （= 撤销栈一条记录，与 PM 侧一致）。jsdom 没有 execCommand 实现，按既有测试做法打桩。

describe("v0.16.0 B4：plan → applySourcePairPlan 真实 textarea 落地", () => {
  let originalExec: typeof document.execCommand;

  beforeEach(() => {
    originalExec = document.execCommand;
  });

  afterEach(() => {
    document.execCommand = originalExec;
  });

  function mount(value: string, start: number, end = start) {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setSelectionRange(start, end);
    document.body.appendChild(ta);
    // jsdom 无 execCommand：实现 insertText 语义（替换选区 + 触发一次 input）
    let inputs = 0;
    (document as unknown as { execCommand: unknown }).execCommand = (
      cmd: string,
      _ui?: boolean,
      text?: string,
    ) => {
      if (cmd !== "insertText") return false;
      const from = ta.selectionStart ?? 0;
      const to = ta.selectionEnd ?? 0;
      ta.value = ta.value.slice(0, from) + (text ?? "") + ta.value.slice(to);
      inputs++;
      return true;
    };
    return { ta, inputCount: () => inputs, cleanup: () => ta.remove() };
  }

  it("Tab：源码模式 Tab 真的改变 value（D2 核心症状：此前 value 不变）", () => {
    const { ta, inputCount, cleanup } = mount("alpha\nbeta", 0, 10);
    const plan = planSourceIndent({ value: ta.value, start: 0, end: 10, unit: "  " });
    applySourcePairPlan(ta, plan);
    expect(ta.value).toBe("  alpha\n  beta");
    expect(inputCount()).toBe(1); // 一次 execCommand = 一条撤销记录
    // 起点本就在行首 → 起点不动（新插入缩进进入选区），终点右移两行缩进量
    expect(ta.selectionStart).toBe(0);
    expect(ta.selectionEnd).toBe(14);
    cleanup();
  });

  it("Shift+Tab：4 空格行首删一个单位（value 变为 2 空格）", () => {
    const { ta, inputCount, cleanup } = mount("    a", 4);
    const plan = planSourceOutdent({ value: ta.value, start: 4, end: 4, unit: "  " });
    applySourcePairPlan(ta, plan);
    expect(ta.value).toBe("  a");
    expect(inputCount()).toBe(1);
    expect(ta.selectionStart).toBe(2);
    cleanup();
  });

  it("plan 为 none 时 applySourcePairPlan 不改 value（吞键责任在 keydown 分支）", () => {
    const { ta, inputCount, cleanup } = mount("a b", 2);
    const plan = planSourceOutdent({ value: ta.value, start: 2, end: 2, unit: "  " });
    expect(plan.kind).toBe("none");
    applySourcePairPlan(ta, plan);
    expect(ta.value).toBe("a b");
    expect(inputCount()).toBe(0);
    cleanup();
  });
});
