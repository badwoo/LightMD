// @vitest-environment jsdom
/**
 * v0.17.1 P0 视图小件包与补全键位契约：
 * - A2 代码块内嵌语言高亮（`codeLanguages: languages`，结构 + 依赖面）
 * - C1 选中词即高亮（`highlightSelectionMatches`，行为）
 * - C2 Mod-d 选中下一处（`selectNextOccurrence`，行为 + Ctrl-d 冲突过滤）
 * - E4 空文档占位提示（`placeholder()`，行为；textarea 回退走原生属性）
 * - E5 拖放插入光标（`dropCursor`，结构）
 * - E6 文末留白（`scrollPastEnd`，结构 + cm-content 留白生效）
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createSourceSurface } from "../../editor/createSourceSurface";
import { TextareaSourceSurface } from "../../editor/surface/TextareaSourceSurface";
import type { SourceSurface } from "../../editor/types";

const SRC = readFileSync("src/editor/cm6/CmSourceSurface.ts", "utf-8");

let surface: SourceSurface | null = null;

function mount(text: string, placeholderText?: string): SourceSurface {
  surface = createSourceSurface({ impl: "cm6" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  surface.mount(host, { initialText: text, placeholderText });
  return surface;
}

afterEach(() => {
  surface?.destroy();
  surface = null;
  document.body.innerHTML = "";
});

describe("A2 代码块内嵌语言高亮", () => {
  it("markdown() 必须配置 codeLanguages（否则围栏代码块永远单色）", () => {
    expect(SRC, "必须从 @codemirror/language-data 导入 languages").toMatch(
      /import \{ languages \} from "@codemirror\/language-data"/,
    );
    expect(SRC, "markdown() 调用必须带 codeLanguages: languages").toMatch(
      /markdown\(\{[^}]*codeLanguages:\s*languages/,
    );
  });

  it("language-data 依赖面：常见语言的 LanguageDescription 都在（懒加载注册表）", async () => {
    const { languages } = await import("@codemirror/language-data");
    const names = languages.map((l) => l.name.toLowerCase());
    for (const expected of ["javascript", "python", "html", "css", "json", "yaml", "rust", "go"]) {
      expect(names, `language-data 应注册 ${expected}`).toContain(expected);
    }
  });
});

describe("C1 选中词即高亮（highlightSelectionMatches）", () => {
  it("选中一个词 → 其余相同文本出现 .cm-selectionMatch 高亮（选区自身不重复标）", () => {
    const s = mount("foo bar foo baz foo");
    s.setSelection(0, 3); // 选中第一个 foo
    // 官方语义（getDeco）：与选区自身重叠的匹配**不**加 mark（选区高亮已由
    // drawSelection 画），只标其余 2 处。
    const matches = document.querySelectorAll(".cm-selectionMatch");
    expect(matches.length, "其余 2 处 foo 应被高亮").toBe(2);
    for (const el of Array.from(matches)) {
      expect(el.textContent).toBe("foo");
    }
    // highlightWordAroundCursor 未开 → main 类不出现
    expect(document.querySelectorAll(".cm-selectionMatch-main").length).toBe(0);
  });

  it("取消选区（光标落点）→ 高亮消失", () => {
    const s = mount("foo bar foo");
    s.setSelection(0, 3);
    expect(document.querySelectorAll(".cm-selectionMatch").length).toBe(1);
    s.setSelection(5, 5); // 光标（空选区）
    expect(document.querySelectorAll(".cm-selectionMatch").length).toBe(0);
  });

  it("Mod-d 多选区后 C1 高亮自动让位（官方行为：ranges>1 → none）", () => {
    const s = mount("foo bar foo");
    s.setSelection(0, 3);
    expect(document.querySelectorAll(".cm-selectionMatch").length).toBe(1);
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "d", code: "KeyD", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    // 多选区态下 highlightSelectionMatches 返回 Decoration.none（避免与多光标
    // 视觉叠加），这是 @codemirror/search 的刻意设计
    expect(document.querySelectorAll(".cm-selectionMatch").length).toBe(0);
  });
});

describe("C2 Mod-d 选中下一处（selectNextOccurrence）", () => {
  it("Mod-d 后选区数 +1，第二处相同文本被选中", () => {
    const s = mount("foo bar foo");
    s.setSelection(0, 3);
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    // 主选区仍是主选区，但内部多选区已累加（接口只暴露主选区，探内部 view）
    const view = (s as unknown as { view: { state: { selection: { ranges: unknown[] } } } }).view;
    expect(view.state.selection.ranges.length, "Mod-d 应累加一个选区").toBe(2);
  });

  it("★ defaultKeymap 的 Ctrl-d（emacs deleteCharForward）必须被过滤，否则 Win/Linux 上抢 Mod-d", () => {
    // 过滤集合里显式声明了 Ctrl-d
    expect(SRC).toMatch(/"Ctrl-d"/);
    // 且 Mod-d 绑定的是 selectNextOccurrence
    expect(SRC).toMatch(/key:\s*"Mod-d",\s*run:\s*selectNextOccurrence/);
  });
});

describe("E4 空文档占位提示（placeholder）", () => {
  it("空文档 + placeholderText → .cm-placeholder 显示提示文案", () => {
    mount("", "开始输入 Markdown…");
    const ph = document.querySelector(".cm-placeholder");
    expect(ph, "空文档应有占位元素").toBeTruthy();
    expect(ph!.textContent).toBe("开始输入 Markdown…");
  });

  it("文档非空 → 不显示占位", () => {
    mount("hello", "开始输入 Markdown…");
    expect(document.querySelector(".cm-placeholder")).toBeNull();
  });

  it("空文档输入内容 → 占位消失（setText 模拟首次输入）", () => {
    const s = mount("", "开始输入 Markdown…");
    expect(document.querySelector(".cm-placeholder")).toBeTruthy();
    s.setText("x");
    expect(document.querySelector(".cm-placeholder")).toBeNull();
  });

  it("textarea 回退实现走原生 placeholder 属性（双实现契约）", () => {
    const ta = new TextareaSourceSurface();
    const host = document.createElement("div");
    document.body.appendChild(host);
    ta.mount(host, { initialText: "", placeholderText: "hint…" });
    const el = host.querySelector("textarea") ?? (host as unknown as HTMLTextAreaElement);
    expect(el.placeholder).toBe("hint…");
    ta.destroy();
  });

  it("未传 placeholderText → 不装 placeholder 扩展（行为向后兼容）", () => {
    mount("");
    expect(document.querySelector(".cm-placeholder")).toBeNull();
  });
});

describe("E5/E6 拖放光标与文末留白", () => {
  it("dropCursor / scrollPastEnd 必须在扩展装配里", () => {
    expect(SRC, "dropCursor 必须装配").toMatch(/\bdropCursor\(\)/);
    expect(SRC, "scrollPastEnd 必须装配").toMatch(/\bscrollPastEnd\(\)/);
  });

  it("scrollPastEnd 生效：cm-content 带底部留白 padding（每行可滚到顶）", () => {
    mount("line1\nline2");
    const content = document.querySelector(".cm-content") as HTMLElement;
    // scrollPastEnd 通过 contentAttributes 注入 padding-bottom
    expect(content.style.paddingBottom, "cm-content 应有底部留白").toMatch(/px$/);
  });
});
