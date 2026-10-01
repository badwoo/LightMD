/**
 * E17(v0.9.4)：代码块语言下拉 / 自动换行开关 / 高亮语言文案
 *
 * 修复前：代码块无语言修改入口（语言仅靠 CSS 显示）；双层结构硬编码 pre-wrap
 * 无横向滚动选项；highlight.ts 实际静态注册 27 种，README 宣称 200+。
 * 修复后：CodeBlockView 顶部语言下拉（setNodeMarkup 写回 attrs）、设置项
 * 「代码块自动换行」（双层同步）、语言清单与 README 声明一致。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { EditorView } from "prosemirror-view";
import { createEditor } from "../core/editor";
import { docToMarkdown } from "../core/markdown/serializer";
import { SUPPORTED_HIGHLIGHT_LANGUAGES, highlightCode } from "../utils/highlight";
import { useSettingsStore } from "../stores/useSettingsStore";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let view: EditorView | null = null;
let parent: HTMLDivElement;

function mountEditor(md: string): EditorView {
  parent = document.createElement("div");
  document.body.appendChild(parent);
  view = createEditor({ parent, initialContent: md })!;
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
  parent?.remove();
  useSettingsStore.getState().setCodeBlockWrap(true);
});

describe("E17：高亮语言清单", () => {
  it("清单无重复项", () => {
    expect(new Set(SUPPORTED_HIGHLIGHT_LANGUAGES).size).toBe(SUPPORTED_HIGHLIGHT_LANGUAGES.length);
  });

  it("包含本次新增语言（toml/docker/ini/graphql/makefile/diff）", () => {
    for (const lang of ["toml", "docker", "ini", "graphql", "makefile", "diff"]) {
      expect(SUPPORTED_HIGHLIGHT_LANGUAGES).toContain(lang);
    }
  });

  it("新增语言实际可高亮（Prism 语法已注册）", () => {
    const html = highlightCode('title = "x"', "toml");
    expect(html).toContain("token");
  });

  it("README 声明数量与清单一致（文案与实现对齐）", () => {
    const readme = readFileSync(join(root, "README.md"), "utf-8");
    const m = /静态注册 (\d+) 种/.exec(readme);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(SUPPORTED_HIGHLIGHT_LANGUAGES.length);
  });
});

describe("E17：代码块语言下拉", () => {
  it("NodeView 渲染语言下拉，且含自动检测 + 当前语言选项", () => {
    const v = mountEditor("```js\nconst a = 1;\n```\n");
    const select = v.dom.querySelector<HTMLSelectElement>(".code-lang-select");
    expect(select).not.toBeNull();
    expect(select!.value).toBe("js");
    const values = Array.from(select!.options).map((o) => o.value);
    expect(values).toContain(""); // 自动检测
    expect(values).toContain("plaintext");
    expect(values).toContain("python");
  });

  it("切换语言 → 节点 attrs 更新并序列化保留", () => {
    const v = mountEditor("```js\nconst a = 1;\n```\n");
    const select = v.dom.querySelector<HTMLSelectElement>(".code-lang-select")!;
    select.value = "python";
    select.dispatchEvent(new Event("change"));

    expect(v.state.doc.firstChild!.attrs.language).toBe("python");
    expect(docToMarkdown(v.state.doc)).toContain("```python");
  });

  it("切换到「自动检测」→ 语言清空，序列化为无标识围栏", () => {
    const v = mountEditor("```js\nx\n```\n");
    const select = v.dom.querySelector<HTMLSelectElement>(".code-lang-select")!;
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(v.state.doc.firstChild!.attrs.language).toBe("");
    const md = docToMarkdown(v.state.doc);
    expect(md.startsWith("```\n")).toBe(true);
  });
});

describe("E17：代码块自动换行设置", () => {
  it("默认开启 → 双层 pre-wrap", () => {
    const v = mountEditor("```js\nx\n```\n");
    const codes = v.dom.querySelectorAll<HTMLElement>(".code-block-wrapper code");
    expect(codes[0].style.whiteSpace).toBe("pre-wrap");
    expect(codes[1].style.whiteSpace).toBe("pre-wrap");
  });

  it("关闭后 → 双层同步切到 pre + 横向滚动（避免错位）", () => {
    const v = mountEditor("```js\nx\n```\n");
    useSettingsStore.getState().setCodeBlockWrap(false);
    const codes = v.dom.querySelectorAll<HTMLElement>(".code-block-wrapper code");
    expect(codes[0].style.whiteSpace).toBe("pre");
    expect(codes[1].style.whiteSpace).toBe("pre");
    expect(codes[0].style.overflowX).toBe("auto");
    expect(codes[1].style.overflowX).toBe("auto");
  });

  it("设置项默认开启", () => {
    expect(useSettingsStore.getState().codeBlockWrap).toBe(true);
  });
});
