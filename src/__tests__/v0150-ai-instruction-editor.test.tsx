/**
 * @vitest-environment jsdom
 *
 * v0.15.0 R3c：AiInstructionEditor 组件行为测试。
 *
 * 覆盖（对应设计 §5.2 与任务卡验收项）：
 * 1. 增删改/复制/排序都正确写回 `ai.instructions`；
 * 2. 内建 7 个模板**只读**：只能"复制为我的指令"，复制品进用户指令列表且是新 id；
 * 3. 变量插入按钮只插入 `{{selection}}` / `{{document}}`；
 * 4. 未知变量给 warning（不阻止保存），名称/模板为空给 error；
 * 5. 空态与选中态引导。
 *
 * 全程用 mock 的 i18n（key 原样返回），文案由 Lead 统一加入 locales。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../i18n", () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (!params) return key;
    const args = Object.entries(params)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(",");
    return `${key}[${args}]`;
  },
}));

import { AiInstructionEditor } from "../components/settings/AiInstructionEditor";
import { AI_BUILTIN_INSTRUCTIONS } from "../components/settings/aiInstructionOps";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { AiInstruction, AiSettings } from "../services/aiProfiles";
import { createBlankProfile } from "../components/settings/aiProfileOps";

function instruction(patch: Partial<AiInstruction> = {}): AiInstruction {
  return { id: "i1", name: "指令一", scope: "selection", userTemplate: "改写：{{selection}}", ...patch };
}

/** 设置 store 的 ai 段（只关心 instructions，profile 占位一个） */
function setAi(instructions: AiInstruction[]) {
  const ai: AiSettings = {
    profiles: [createBlankProfile("p", "id-p")],
    activeProfileId: "id-p",
    instructions,
  };
  useSettingsStore.setState({ ai });
  return ai;
}

function ai(): AiSettings {
  return useSettingsStore.getState().ai;
}

function mount(props?: { scopeFilter?: AiInstruction["scope"] }) {
  return render(<AiInstructionEditor {...props} />);
}

beforeEach(() => {
  cleanup();
  setAi([]);
});

afterEach(() => {
  cleanup();
});

describe("空态与选中", () => {
  it("无指令时显示空列表提示，编辑区提示先选/先建", () => {
    mount();
    expect(screen.getByTestId("ai-inst-empty")).toBeTruthy();
    expect(screen.getByTestId("ai-inst-select-tip")).toBeTruthy();
  });

  it("新增按钮建出空白指令并自动选中", () => {
    mount();
    fireEvent.click(screen.getByTestId("ai-inst-add"));

    const list = ai().instructions;
    expect(list).toHaveLength(1);
    expect(list[0]!.scope).toBe("selection");
    expect(list[0]!.userTemplate).toBe("");
    // 自动选中 → 编辑区出现
    expect((screen.getByTestId("ai-inst-name") as HTMLInputElement).value).toBe(
      "settings.ai.instruction.newName",
    );
  });

  it("有多条时默认选中第一条，点列表可切换", () => {
    setAi([instruction(), instruction({ id: "i2", name: "指令二" })]);
    mount();
    expect((screen.getByTestId("ai-inst-name") as HTMLInputElement).value).toBe("指令一");
    fireEvent.click(screen.getByTestId("ai-inst-item-i2"));
    expect((screen.getByTestId("ai-inst-name") as HTMLInputElement).value).toBe("指令二");
  });

  it("scopeFilter 只显示该作用域的指令", () => {
    setAi([
      instruction({ id: "i1", name: "选区指令", scope: "selection" }),
      instruction({ id: "i2", name: "全文指令", scope: "document" }),
    ]);
    mount({ scopeFilter: "document" });
    expect(screen.queryByTestId("ai-inst-item-i1")).toBeNull();
    expect(screen.getByTestId("ai-inst-item-i2")).toBeTruthy();
  });
});

describe("编辑字段", () => {
  it("改名写入 store", () => {
    setAi([instruction()]);
    mount();
    fireEvent.change(screen.getByTestId("ai-inst-name"), { target: { value: "新名" } });
    expect(ai().instructions[0]!.name).toBe("新名");
  });

  it("改作用域写入 store", () => {
    setAi([instruction()]);
    mount();
    fireEvent.change(screen.getByTestId("ai-inst-scope"), { target: { value: "document" } });
    expect(ai().instructions[0]!.scope).toBe("document");
  });

  it("改模板写入 store", () => {
    setAi([instruction()]);
    mount();
    fireEvent.change(screen.getByTestId("ai-inst-template"), { target: { value: "新模板 {{document}}" } });
    expect(ai().instructions[0]!.userTemplate).toBe("新模板 {{document}}");
  });

  it("systemSuffix 可空：填写写入，清空回到 undefined", () => {
    setAi([instruction()]);
    mount();
    fireEvent.change(screen.getByTestId("ai-inst-system-suffix"), { target: { value: "后缀" } });
    expect(ai().instructions[0]!.systemSuffix).toBe("后缀");

    fireEvent.change(screen.getByTestId("ai-inst-system-suffix"), { target: { value: "" } });
    expect("systemSuffix" in ai().instructions[0]!).toBe(false);
  });
});

describe("变量：仅 selection / document", () => {
  it("只有两个插入按钮", () => {
    setAi([instruction()]);
    mount();
    expect(screen.getByTestId("ai-inst-insert-selection")).toBeTruthy();
    expect(screen.getByTestId("ai-inst-insert-document")).toBeTruthy();
    expect(screen.queryByTestId("ai-inst-insert-other")).toBeNull();
  });

  it("点插入按钮把 token 追加到模板", () => {
    setAi([instruction({ userTemplate: "前缀" })]);
    mount();
    fireEvent.click(screen.getByTestId("ai-inst-insert-document"));
    expect(ai().instructions[0]!.userTemplate).toBe("前缀{{document}}");
  });

  it("已用变量提示列出当前模板里的变量", () => {
    setAi([instruction({ userTemplate: "{{selection}} 和 {{document}}" })]);
    mount();
    const hint = screen.getByTestId("ai-inst-used-vars").textContent!;
    expect(hint).toContain("{{selection}}");
    expect(hint).toContain("{{document}}");
  });

  it("【核心】未知变量给 warning 但不阻止保存（指令仍在 store 里）", () => {
    setAi([instruction({ userTemplate: "{{date}} {{selection}}" })]);
    mount();
    const warn = screen.getByTestId("ai-inst-unknown-vars");
    expect(warn.textContent).toContain("settings.ai.instruction.warn.unknownVariable");
    expect(warn.textContent).toContain("date");
    // 不出现 error 列表
    expect(screen.queryByTestId("ai-inst-errors")).toBeNull();
    // 内容仍完整保存在 store
    expect(ai().instructions[0]!.userTemplate).toBe("{{date}} {{selection}}");
  });
});

describe("必填校验", () => {
  it("名称清空 → 报 name.required", () => {
    setAi([instruction()]);
    mount();
    fireEvent.change(screen.getByTestId("ai-inst-name"), { target: { value: "  " } });
    const errors = screen.getByTestId("ai-inst-errors");
    expect(errors.textContent).toContain("settings.ai.instruction.error.nameRequired");
  });

  it("模板清空 → 报 template.required", () => {
    setAi([instruction()]);
    mount();
    fireEvent.change(screen.getByTestId("ai-inst-template"), { target: { value: "" } });
    const errors = screen.getByTestId("ai-inst-errors");
    expect(errors.textContent).toContain("settings.ai.instruction.error.templateRequired");
  });

  it("合法指令无错误列表", () => {
    setAi([instruction()]);
    mount();
    expect(screen.queryByTestId("ai-inst-errors")).toBeNull();
  });
});

describe("增删复制排序", () => {
  it("复制指令：新 id + 名字带副本标记", () => {
    setAi([instruction({ id: "i1", name: "甲" })]);
    mount();
    fireEvent.click(screen.getByTestId("ai-inst-duplicate"));
    const list = ai().instructions;
    expect(list).toHaveLength(2);
    expect(list[1]!.id).not.toBe("i1");
    expect(list[1]!.name).toContain("settings.ai.instruction.copyName");
    expect(list[1]!.name).toContain("name=甲");
  });

  it("删除当前指令", () => {
    setAi([instruction({ id: "i1" }), instruction({ id: "i2", name: "乙" })]);
    mount();
    fireEvent.click(screen.getByTestId("ai-inst-remove"));
    expect(ai().instructions.map((i) => i.id)).toEqual(["i2"]);
  });

  it("删到空列表回到空态", () => {
    setAi([instruction({ id: "only" })]);
    mount();
    fireEvent.click(screen.getByTestId("ai-inst-remove"));
    expect(ai().instructions).toEqual([]);
    expect(screen.getByTestId("ai-inst-empty")).toBeTruthy();
  });

  it("上下移改变顺序", () => {
    setAi([instruction({ id: "a" }), instruction({ id: "b" })]);
    mount();
    fireEvent.click(screen.getByTestId("ai-inst-move-down"));
    expect(ai().instructions.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("内建模板：只读可复制", () => {
  it("渲染 7 个内建模板，每个都有复制按钮（没有编辑/删除按钮）", () => {
    mount();
    expect(screen.getByTestId("ai-inst-builtin")).toBeTruthy();
    for (const builtin of AI_BUILTIN_INSTRUCTIONS) {
      expect(screen.getByTestId(`ai-inst-copy-builtin-${builtin.id}`), builtin.id).toBeTruthy();
    }
    // 模板区不提供删除当前模板的能力（复制按钮之外没有别的操作）
    expect(screen.queryByTestId("ai-inst-builtin-remove")).toBeNull();
    expect(screen.queryByTestId("ai-inst-builtin-edit")).toBeNull();
  });

  it("复制内建模板 → 用户指令列表 +1，且新 id 与模板 id 不同", () => {
    mount();
    const builtin = AI_BUILTIN_INSTRUCTIONS[0]!;
    fireEvent.click(screen.getByTestId(`ai-inst-copy-builtin-${builtin.id}`));

    const list = ai().instructions;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).not.toBe(builtin.id);
    // 内容取当前语言的模板正文（代码常量，非 i18n key：变量是双花括号）
    expect(list[0]!.userTemplate).toBe(builtin.userTemplate.zh);
    expect(list[0]!.scope).toBe(builtin.scope);
    // 模板常量本身未被修改（冻结 + 内容不变）
    expect(AI_BUILTIN_INSTRUCTIONS[0]).toBe(builtin);
    expect(AI_BUILTIN_INSTRUCTIONS).toHaveLength(7);
  });

  it("带 systemSuffix 的模板复制后带上 systemSuffix", () => {
    const withSuffix = AI_BUILTIN_INSTRUCTIONS.find((item) => item.systemSuffixKey)!;
    expect(withSuffix).toBeTruthy();
    mount();
    fireEvent.click(screen.getByTestId(`ai-inst-copy-builtin-${withSuffix.id}`));
    const copied = ai().instructions[0]!;
    expect(copied.systemSuffix).toBe(withSuffix.systemSuffixKey);
  });

  it("scopeFilter 下只显示该作用域的内建模板", () => {
    mount({ scopeFilter: "document" });
    const documentBuiltins = AI_BUILTIN_INSTRUCTIONS.filter((item) => item.scope === "document");
    const selectionBuiltins = AI_BUILTIN_INSTRUCTIONS.filter((item) => item.scope === "selection");
    for (const builtin of documentBuiltins) {
      expect(screen.getByTestId(`ai-inst-copy-builtin-${builtin.id}`), builtin.id).toBeTruthy();
    }
    for (const builtin of selectionBuiltins) {
      expect(screen.queryByTestId(`ai-inst-copy-builtin-${builtin.id}`), builtin.id).toBeNull();
    }
  });
});
