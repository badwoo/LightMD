/**
 * @vitest-environment jsdom
 *
 * v0.15.0 R3c：AI 指令库纯操作函数单测（aiInstructionOps）。
 *
 * 重点锁定设计 §5.2 的三条硬约束：
 * 1. 内建 7 个模板只读（只能复制成用户指令，复制品是新 id）；
 * 2. 变量**仅** `{{selection}}` / `{{document}}`；其他 `{{...}}` 原样保留、不执行；
 * 3. 展开替换必须把值当**字面量**（文档里含 `$&` 不能被正则替换模式吞掉）。
 */
import { describe, it, expect } from "vitest";
import {
  AI_BUILTIN_INSTRUCTIONS,
  AI_INSTRUCTION_VARIABLES,
  appendInstruction,
  collectUnknownVariables,
  collectUsedVariables,
  createBlankInstruction,
  createInstructionFromBuiltin,
  duplicateInstruction,
  expandInstructionTemplate,
  moveInstruction,
  newInstructionId,
  removeInstruction,
  scopeLabelKey,
  updateInstruction,
  validateInstruction,
} from "../components/settings/aiInstructionOps";
import type { AiInstruction } from "../services/aiProfiles";

function instruction(patch: Partial<AiInstruction> = {}): AiInstruction {
  return { id: "i1", name: "指令", scope: "selection", userTemplate: "改写：{{selection}}", ...patch };
}

describe("AI_BUILTIN_INSTRUCTIONS：内建模板", () => {
  it("恰好 7 个模板，id 唯一", () => {
    expect(AI_BUILTIN_INSTRUCTIONS).toHaveLength(7);
    const ids = new Set(AI_BUILTIN_INSTRUCTIONS.map((item) => item.id));
    expect(ids.size).toBe(7);
  });

  it("每个模板都有名称 i18n key、双语模板正文，且作用域合法", () => {
    for (const builtin of AI_BUILTIN_INSTRUCTIONS) {
      expect(builtin.nameKey, builtin.id).toBeTruthy();
      // 模板正文是**代码常量**（双语），不走 i18n key：变量语法是双花括号，
      // 与 t() 的单花括号占位符冲突（见 aiInstructionOps 的注释）
      expect(builtin.userTemplate.zh, builtin.id).toBeTruthy();
      expect(builtin.userTemplate.en, builtin.id).toBeTruthy();
      expect(["selection", "document", "none"]).toContain(builtin.scope);
    }
  });

  it("模板是冻结的（只读语义在类型层面也有保障）", () => {
    expect(Object.isFrozen(AI_BUILTIN_INSTRUCTIONS)).toBe(true);
  });
});

describe("AI_INSTRUCTION_VARIABLES：变量白名单", () => {
  it("【核心】只有 selection / document 两个变量", () => {
    expect([...AI_INSTRUCTION_VARIABLES]).toEqual(["selection", "document"]);
  });
});

describe("createBlankInstruction / createInstructionFromBuiltin", () => {
  it("新建空白指令：默认选区作用域，模板留空", () => {
    const created = createBlankInstruction("新指令", "ins-1");
    expect(created).toEqual({ id: "ins-1", name: "新指令", scope: "selection", userTemplate: "" });
  });

  it("【核心】从内建模板复制：新 id，内容按传入文案落库，与模板无绑定", () => {
    const builtin = AI_BUILTIN_INSTRUCTIONS[0]!;
    const copied = createInstructionFromBuiltin(builtin, "我的摘要", "总结：{{selection}}", "只输出要点", "ins-2");
    expect(copied.id).toBe("ins-2");
    expect(copied.name).toBe("我的摘要");
    expect(copied.scope).toBe(builtin.scope);
    expect(copied.userTemplate).toBe("总结：{{selection}}");
    expect(copied.systemSuffix).toBe("只输出要点");
    // 复制品是普通用户指令，可自由修改（模板本身仍是冻结常量）
    expect(AI_BUILTIN_INSTRUCTIONS.map((item) => item.userTemplate.zh)).not.toContain(copied.userTemplate);
  });

  it("复制模板时无 systemSuffix → 字段不出现（而不是空串）", () => {
    const builtin = AI_BUILTIN_INSTRUCTIONS[0]!;
    const copied = createInstructionFromBuiltin(builtin, "n", "t", undefined, "ins-3");
    expect("systemSuffix" in copied).toBe(false);
  });

  it("newInstructionId 生成互不相同的 id", () => {
    expect(newInstructionId()).not.toBe(newInstructionId());
  });
});

describe("duplicateInstruction / append / remove", () => {
  it("复制指令用新 id，其余字段继承", () => {
    const source = instruction({ systemSuffix: "后缀" });
    const copied = duplicateInstruction(source, "指令（副本）", "i2");
    expect(copied.id).toBe("i2");
    expect(copied.name).toBe("指令（副本）");
    expect(copied.systemSuffix).toBe("后缀");
    expect(copied.userTemplate).toBe(source.userTemplate);
  });

  it("append 不修改原数组", () => {
    const list = [instruction()];
    const next = appendInstruction(list, instruction({ id: "i2" }));
    expect(next).toHaveLength(2);
    expect(list).toHaveLength(1);
  });

  it("remove 不存在的 id 原样返回同一引用", () => {
    const list = [instruction()];
    expect(removeInstruction(list, "nope")).toBe(list);
  });

  it("remove 移除目标项", () => {
    const list = [instruction(), instruction({ id: "i2" })];
    expect(removeInstruction(list, "i1").map((i) => i.id)).toEqual(["i2"]);
  });
});

describe("updateInstruction", () => {
  it("局部更新字段，id 不被覆盖", () => {
    const list = [instruction()];
    const next = updateInstruction(list, "i1", { name: "改名", id: "hacked" });
    expect(next[0]!.name).toBe("改名");
    expect(next[0]!.id).toBe("i1");
  });

  it("【核心】显式清空 systemSuffix 时移除字段（不是留空串）", () => {
    const list = [instruction({ systemSuffix: "有后缀" })];
    const next = updateInstruction(list, "i1", { systemSuffix: undefined });
    expect("systemSuffix" in next[0]!).toBe(false);
  });

  it("设置 systemSuffix 时正常写入", () => {
    const next = updateInstruction([instruction()], "i1", { systemSuffix: "新后缀" });
    expect(next[0]!.systemSuffix).toBe("新后缀");
  });

  it("未提供 systemSuffix 时不改动原值", () => {
    const next = updateInstruction([instruction({ systemSuffix: "保留" })], "i1", { name: "改名" });
    expect(next[0]!.systemSuffix).toBe("保留");
  });

  it("不存在的 id 不改动", () => {
    const list = [instruction()];
    const next = updateInstruction(list, "nope", { name: "x" });
    expect(next[0]!.name).toBe("指令");
  });
});

describe("moveInstruction：排序", () => {
  const list = () => [instruction({ id: "a" }), instruction({ id: "b" }), instruction({ id: "c" })];

  it("上移", () => {
    expect(moveInstruction(list(), "b", -1).map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("下移", () => {
    expect(moveInstruction(list(), "b", 1).map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("边界处原样返回同一引用", () => {
    const items = list();
    expect(moveInstruction(items, "a", -1)).toBe(items);
    expect(moveInstruction(items, "c", 1)).toBe(items);
  });

  it("不存在的 id 原样返回", () => {
    const items = list();
    expect(moveInstruction(items, "nope", 1)).toBe(items);
  });
});

describe("collectUsedVariables / collectUnknownVariables", () => {
  it("识别已用变量（按白名单顺序）", () => {
    expect(collectUsedVariables("{{document}} + {{selection}}")).toEqual(["selection", "document"]);
    expect(collectUsedVariables("只有 {{selection}}")).toEqual(["selection"]);
    expect(collectUsedVariables("没有变量")).toEqual([]);
  });

  it("识别未知变量（去重、保出现顺序）", () => {
    expect(collectUnknownVariables("{{date}} 和 {{selection}} 和 {{date}}")).toEqual(["date"]);
    expect(collectUnknownVariables("{{a}}{{b b}}")).toEqual(["a", "b b"]);
    expect(collectUnknownVariables("{{selection}}{{document}}")).toEqual([]);
  });

  it("非 {{}} 形式的花括号不误判", () => {
    expect(collectUnknownVariables("{单个} {{ok}}")).toEqual(["ok"]);
    expect(collectUnknownVariables("{{}}")).toEqual([]);
  });
});

describe("validateInstruction：错误与警告分级", () => {
  it("名称/模板必填 → error", () => {
    const issues = validateInstruction(instruction({ name: "   ", userTemplate: "" }));
    expect(issues.filter((i) => i.level === "error").map((i) => i.code)).toEqual([
      "name.required",
      "template.required",
    ]);
  });

  it("【核心】未知变量只是 warning（不阻止保存，用户可能就是写字面量）", () => {
    const issues = validateInstruction(instruction({ userTemplate: "{{date}} {{selection}}" }));
    const warnings = issues.filter((i) => i.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "variable.unknown", variables: ["date"] });
    // 无 error
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("正常指令无任何 issue", () => {
    expect(validateInstruction(instruction())).toEqual([]);
  });
});

describe("expandInstructionTemplate：只做字面替换", () => {
  it("替换 selection / document", () => {
    expect(
      expandInstructionTemplate("改写 {{selection}}；全文 {{document}}", {
        selection: "选中文字",
        document: "全文内容",
      }),
    ).toBe("改写 选中文字；全文 全文内容");
  });

  it("缺值时替换为空串（调用方负责决定是否传）", () => {
    expect(expandInstructionTemplate("A{{selection}}B", {})).toBe("AB");
  });

  it("【核心】其他 {{...}} 原样保留，不报错、不删除", () => {
    expect(expandInstructionTemplate("{{date}} {{selection}}", { selection: "S" })).toBe("{{date}} S");
  });

  it("【核心】替换值按字面量处理（含 $& / $1 不被当作正则模式）", () => {
    expect(expandInstructionTemplate("X{{selection}}Y", { selection: "$&$1$`" })).toBe("X$&$1$`Y");
  });

  it("同一个变量出现多次全部替换", () => {
    expect(expandInstructionTemplate("{{selection}}/{{selection}}", { selection: "S" })).toBe("S/S");
  });

  it("不含变量时原样返回", () => {
    expect(expandInstructionTemplate("纯文本", { selection: "S" })).toBe("纯文本");
  });

  it("不执行任何代码（模板里的 JS 片段只是文本）", () => {
    const template = "console.log(1) {{selection}}";
    expect(expandInstructionTemplate(template, { selection: "k" })).toBe("console.log(1) k");
  });
});

describe("scopeLabelKey：作用域 → i18n key", () => {
  it("三种作用域各有独立 key，无兜底串", () => {
    expect(scopeLabelKey("selection")).toBe("settings.ai.instruction.scope.selection");
    expect(scopeLabelKey("document")).toBe("settings.ai.instruction.scope.document");
    expect(scopeLabelKey("none")).toBe("settings.ai.instruction.scope.none");
  });
});
