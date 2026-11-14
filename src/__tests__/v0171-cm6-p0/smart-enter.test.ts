// @vitest-environment jsdom
/**
 * v0.17.1 A1：智能回车（`insertNewlineContinueMarkup`）与标记退格
 * （`deleteMarkupBackward`）的**行为**契约。
 *
 * 背景：0.17.0 及之前 `markdown({ addKeymap: false })` 把 markdownKeymap 整体
 * 关闭，Enter 只是普通换行 —— 列表/引用/任务项不续行、空项不退出、行首
 * Backspace 粘连上一行。本组用例按 VS Code / Typora 语义逐场景锁行为。
 *
 * 与硬约束的关系：
 * - 硬约束 1（撤销归统一时间线）：智能回车命令直接 dispatch 事务、**不装 history()**，
 *   变更经 updateListener 归类 typing —— 一次回车 = 一步撤销（由统一时间线
 *   的既有测试守护，这里不断言）。
 * - 智能绑定前置在 defaultKeymap 同键绑定之前：未命中（返回 false）必须
 *   fallthrough 到 defaultKeymap 的 insertNewline / deleteCharBackward。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;

function mount(text: string): SourceSurface {
  surface = createSourceSurface({ impl: "cm6" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  surface.mount(host, { initialText: text });
  return surface;
}

afterEach(() => {
  surface?.destroy();
  surface = null;
  document.body.innerHTML = "";
});

/** 在 `.cm-content` 上派发真实 keydown（与 v0170-cm6/tab-behavior 同模式） */
function press(key: string, opts: KeyboardEventInit = {}): void {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  expect(content, "CM6 的 .cm-content 必须存在").toBeTruthy();
  content!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key === "Enter" ? "Enter" : key === "Backspace" ? "Backspace" : key,
      bubbles: true,
      cancelable: true,
      ...opts,
    }),
  );
}

describe("A1 智能回车（insertNewlineContinueMarkup）", () => {
  it("无序列表行尾 Enter → 自动续出下一个 `- `", () => {
    const s = mount("- item");
    s.setSelection(6, 6);
    press("Enter");
    expect(s.getText()).toBe("- item\n- ");
  });

  it("任务项行尾 Enter → 续出 `- [ ] `（复选框重置为未勾选）", () => {
    const s = mount("- [x] done");
    s.setSelection(10, 10);
    press("Enter");
    expect(s.getText()).toBe("- [x] done\n- [ ] ");
  });

  it("有序列表行尾 Enter → 编号自动递增（3. → 4.）", () => {
    const s = mount("3. step");
    s.setSelection(7, 7);
    press("Enter");
    expect(s.getText()).toBe("3. step\n4. ");
  });

  it("★ 三项列表的空末项按 Enter → 退标记、退出列表", () => {
    const s = mount("- a\n- b\n- ");
    s.setSelection(10, 10); // 第三行行尾（空项）
    press("Enter");
    // 空项被吃掉：末尾不再是列表项（不以 "- " 结尾）
    const text = s.getText();
    expect(text.startsWith("- a\n- b\n")).toBe(true);
    expect(text.endsWith("- ")).toBe(false);
  });

  it("★ 单项列表的空项按 Enter → 退标记（列表清空）", () => {
    const s = mount("- ");
    s.setSelection(2, 2);
    press("Enter");
    expect(s.getText()).toBe("");
  });

  it("两项 tight 列表的空第二项按 Enter → 插空行变松散（CM6 官方语义，非退标记）", () => {
    /**
     * `insertNewlineContinueMarkup` 的"Empty line in list"分支有刻意设计：
     * 光标恰好在**两项 tight 列表的第二项**时走 "Move second item down,
     * making tight two-item list non-tight"（插空行），其余空项才退标记。
     * 这是 @codemirror/lang-markdown 的官方语义（与 VS Code 的"一律退出"略有
     * 差异），此处锁住实际行为防止无声漂移。
     */
    const s = mount("- item\n- ");
    s.setSelection(9, 9); // 第二行行尾（空项）
    press("Enter");
    expect(s.getText()).toBe("- item\n\n- ");
  });

  it("引用行尾 Enter → 自动续出 `> `", () => {
    const s = mount("> quote");
    s.setSelection(7, 7);
    press("Enter");
    expect(s.getText()).toBe("> quote\n> ");
  });

  it("普通段落 Enter → 普通换行（智能回车不命中，fallthrough 到 defaultKeymap）", () => {
    const s = mount("hello");
    s.setSelection(5, 5);
    press("Enter");
    expect(s.getText()).toBe("hello\n");
  });

  it("IME 组合中按 Enter 不续行（交输入法确认候选）", () => {
    const s = mount("- item");
    s.setSelection(6, 6);
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    press("Enter");
    // 组合中智能回车返回 false → 不产生 "- " 续行
    expect(s.getText()).not.toContain("\n- ");
  });
});

describe("A1 标记退格（deleteMarkupBackward）", () => {
  it("★ 光标在列表标记后行首按 Backspace → 一次删净标记（不粘连上一行）", () => {
    const s = mount("- item");
    s.setSelection(2, 2); // "- " 之后、正文之前
    press("Backspace");
    expect(s.getText()).toBe("item");
  });

  it("引用标记行首 Backspace → 删掉 `> `", () => {
    const s = mount("> quote");
    s.setSelection(2, 2);
    press("Backspace");
    expect(s.getText()).toBe("quote");
  });

  it("普通文本 Backspace → 正常删字符（fallthrough 到 deleteCharBackward）", () => {
    const s = mount("ab");
    s.setSelection(1, 1);
    press("Backspace");
    expect(s.getText()).toBe("b");
  });

  it("行中（非行首）Backspace 不吃标记 —— 只删前一字符", () => {
    const s = mount("- item");
    s.setSelection(5, 5); // "ite|m"（'e' 与 'm' 之间）
    press("Backspace");
    expect(s.getText()).toBe("- itm"); // 删掉的是 'e'
  });
});
