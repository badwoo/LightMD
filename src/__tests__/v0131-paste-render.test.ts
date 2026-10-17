/**
 * v0.13.1 需求1（行为断言）：阅读模式复制块 → 粘贴到别的文档**自动渲染**。
 *
 * ## 修复前的两条断链
 *
 * 1. `clipboard-paste.ts` 的 `looksLikeMarkdown` 要求**命中 ≥2 项特征**才按 Markdown
 *    解析纯文本，而单个被复制的块（代码块 / 表格 / 公式块）往往只有 1 项 →
 *    粘贴退化为字面文本（文档里出现一排反引号）。
 * 2. `application/x-lightmd-block` 专用 MIME 只有三点菜单的
 *    `pasteBlockAtSelection` 认得，`handlePaste`（普通 Ctrl+V）完全不看它，
 *    于是同应用内复制块再 Ctrl+V 也走不到结构还原。
 *
 * ## 本文件的断言口径
 *
 * 全部断言**文档结构**（节点类型名），不断言源码文本——用户看到的是渲染结果，
 * "粘贴出 code_block 节点"才是需求本身。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";

import { lightMDSchema as schema } from "../core/schema";
import { useSettingsStore } from "../stores/useSettingsStore";
import { clipboardPastePlugin } from "../core/plugins/clipboard-paste";
import { BLOCK_CLIPBOARD_MIME, looksLikeMarkdown } from "../utils/blockClipboard";
import {
  writeBlockClipboard,
  writeCodeBlockClipboard,
  __resetInAppBlockClipboardForTest,
} from "../utils/blockClipboardOps";

/** 构造伪 ClipboardEvent（只用 getData / types / items） */
function clipEvent(map: Record<string, string>, types?: string[]): ClipboardEvent {
  const typeList = types ?? Object.keys(map);
  return {
    clipboardData: {
      types: typeList,
      items: [],
      getData: (t: string) => map[t] ?? "",
    },
  } as unknown as ClipboardEvent;
}

/** stub EditorView：state getter + dispatch 应用事务（与 E9 测试同一套 harness） */
function pasteView(doc: Node, from: number, to = from): { view: EditorView; get: () => EditorState } {
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: import("prosemirror-state").Transaction) => {
      state = state.apply(tr);
    },
    focus: () => {},
  } as unknown as EditorView;
  return { view, get: () => state };
}

function paraDoc(text: string): Node {
  return schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
  ]);
}

// handlePaste 是 Plugin 的 props 方法（this 绑定 Plugin），此处包一层以便直接调用
const pastePlugin = clipboardPastePlugin();
const handlePaste = (view: EditorView, event: ClipboardEvent): boolean =>
  !!pastePlugin.props.handlePaste!.call(pastePlugin, view, event, null as never);

/** 文档里出现过的所有节点类型名 */
function nodeTypes(doc: Node): Set<string> {
  const seen = new Set<string>();
  doc.descendants((n) => {
    seen.add(n.type.name);
  });
  return seen;
}

/** 首个指定类型节点（结构断言用） */
function firstOf(doc: Node, name: string): Node | null {
  let found: Node | null = null;
  doc.descendants((n) => {
    if (!found && n.type.name === name) found = n;
  });
  return found;
}

/** 指定类型节点的个数 */
function countOf(doc: Node, name: string): number {
  let count = 0;
  doc.descendants((n) => {
    if (n.type.name === name) count++;
  });
  return count;
}

/** 从空段落文档出发粘贴一段剪贴板内容，返回结果文档（结构断言的原料） */
function pasteIntoFreshDoc(map: Record<string, string>, types?: string[]): { handled: boolean; doc: Node } {
  const { view, get } = pasteView(paraDoc("x"), 2);
  const handled = handlePaste(view, clipEvent(map, types));
  return { handled, doc: get().doc };
}

beforeEach(() => {
  // 应用内块兜底是模块级单例，测试间必须清空，否则前一个用例的残留会被当成本次剪贴板
  __resetInAppBlockClipboardForTest();
  useSettingsStore.getState().setPasteMarkdownEnabled(true);
});

afterEach(() => {
  __resetInAppBlockClipboardForTest();
  useSettingsStore.getState().setPasteMarkdownEnabled(true);
});

describe("v0.13.1 需求1：块结构判定（looksLikeMarkdown 统一口径）", () => {
  it("单个围栏代码块（含/不含 info string、~~~）即判定为 Markdown", () => {
    expect(looksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("```js\nconst a = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("~~~python\nprint(1)\n~~~")).toBe(true);
  });

  it("单个 $$ 公式块即判定为 Markdown（同行 $$x$$ 也算）", () => {
    expect(looksLikeMarkdown("$$\nE = mc^2\n$$")).toBe(true);
    expect(looksLikeMarkdown("$$x^2$$")).toBe(true);
  });

  it("单个管道表格（表头 + 分隔行）即判定为 Markdown", () => {
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| :--- | ---: |\n| 1 | 2 |")).toBe(true);
  });

  it("单个 mermaid 围栏落入同一围栏判定", () => {
    expect(looksLikeMarkdown("```mermaid\ngraph TD\nA-->B\n```")).toBe(true);
  });

  it("保守边界保持：普通散文 / 单项行内构造 / 单列表项 / 单句引用 → false", () => {
    expect(looksLikeMarkdown("今天天气不错，出去走走吧。")).toBe(false);
    expect(looksLikeMarkdown("这是 **粗体**")).toBe(false);
    expect(looksLikeMarkdown("- 单个列表项")).toBe(false);
    expect(looksLikeMarkdown("> 只有一句引用")).toBe(false);
    expect(looksLikeMarkdown("| a | b |")).toBe(false);
    expect(looksLikeMarkdown("a | b")).toBe(false);
  });

  it("未闭合围栏 / 未闭合 $$ → false（不把普通文本当块）", () => {
    expect(looksLikeMarkdown("```\n没有收围栏")).toBe(false);
    expect(looksLikeMarkdown("$$\n没有收尾")).toBe(false);
  });
});

describe("v0.13.1 需求1：Ctrl+V 粘贴块即渲染（结构断言）", () => {
  it("代码块 → 目标文档出现 code_block（不是一段字面反引号）", () => {
    const md = "```js\nconst a = 1;\n```";
    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": md });
    expect(handled).toBe(true);
    const code = firstOf(doc, "code_block");
    expect(code).not.toBeNull();
    expect(code!.attrs.language).toBe("js");
    expect(code!.textContent).toContain("const a = 1;");
    // 不应留下 "```" 字面量（旧行为：整段按纯文本插入）
    expect(doc.textContent).not.toContain("```");
  });

  it("管道表格 → 目标文档出现 table 且单元格数量正确", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": md });
    expect(handled).toBe(true);
    const table = firstOf(doc, "table");
    expect(table).not.toBeNull();
    // 表头 2 格 + 表体 2 格
    expect(countOf(doc, "table_row")).toBe(2);
    expect(countOf(doc, "table_cell")).toBe(2);
    expect(countOf(doc, "table_header")).toBe(2);
    expect(doc.textContent).toContain("a");
  });

  it("$$ 公式块 → 目标文档出现 math_block（不是字面 $$）", () => {
    const md = "$$\nE = mc^2\n$$";
    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": md });
    expect(handled).toBe(true);
    const math = firstOf(doc, "math_block");
    expect(math).not.toBeNull();
    expect(math!.attrs.latex).toContain("E = mc^2");
    expect(doc.textContent).not.toContain("$$");
  });

  it("mermaid 围栏 → 目标文档出现 mermaid_block", () => {
    const md = "```mermaid\ngraph TD\n  A --> B\n```";
    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": md });
    expect(handled).toBe(true);
    const mermaid = firstOf(doc, "mermaid_block");
    expect(mermaid).not.toBeNull();
    expect(mermaid!.textContent).toContain("A --> B");
  });

  it("X-lightmd-block MIME 载荷 → 按其中的 markdown 结构还原", () => {
    const payload = JSON.stringify({
      markdown: "| a | b |\n| --- | --- |\n| 1 | 2 |",
      html: "",
      from: 0,
      to: 0,
      at: 1,
    });
    const { handled, doc } = pasteIntoFreshDoc({
      [BLOCK_CLIPBOARD_MIME]: payload,
      "text/plain": "| a | b |\n| --- | --- |\n| 1 | 2 |",
    });
    expect(handled).toBe(true);
    expect(firstOf(doc, "table")).not.toBeNull();
  });

  it("专用 MIME 存在但 JSON 损坏 → 落到 text/plain，仍按块结构解析", () => {
    const { handled, doc } = pasteIntoFreshDoc({
      [BLOCK_CLIPBOARD_MIME]: "{ 坏 JSON",
      "text/plain": "```\ncode\n```",
    });
    expect(handled).toBe(true);
    expect(firstOf(doc, "code_block")).not.toBeNull();
  });

  it("text/plain 已是块构造时不让 HTML 抢先（turndown 会降级，结构优先）", () => {
    // 用户复制代码块时剪贴板常同时带渲染 HTML；turndown 对 <pre><code> 的转换
    // 又会丢掉 info string 之外的语境，用 HTML 覆盖无损 Markdown 等于自毁结构
    const md = "```js\nconst a = 1;\n```";
    const { handled, doc } = pasteIntoFreshDoc({
      "text/plain": md,
      "text/html": `<pre><code>${"const a = 1;"}</code></pre>`,
    });
    expect(handled).toBe(true);
    const code = firstOf(doc, "code_block");
    expect(code).not.toBeNull();
    expect(code!.attrs.language).toBe("js"); // HTML 侧无 language → 只有 Markdown 侧能给
  });

  it("剪贴板 HTML 含表格 → 不交给 turndown（它没有表格规则，会拍平成散文本）", () => {
    // 表格 HTML + 无可用 text/plain → 宁可返回 false 交默认粘贴，也不拍平
    const { view } = pasteView(paraDoc("x"), 2);
    const handled = handlePaste(
      view,
      clipEvent({
        "text/html": "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
      }),
    );
    expect(handled).toBe(false);
  });

  it("HTML 表格 + 有效管道表格文本 → 以文本重建 table 节点", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const { handled, doc } = pasteIntoFreshDoc({
      "text/plain": md,
      "text/html": "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
    });
    expect(handled).toBe(true);
    expect(firstOf(doc, "table")).not.toBeNull();
    expect(countOf(doc, "table_cell")).toBe(2);
  });

  it("应用内块兜底：无专用 MIME 且 text/plain 与兜底同源 → 结构还原", async () => {
    // 模拟 WebView2：写系统剪贴板被拒，只有应用内兜底留了数据
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn().mockRejectedValue(new Error("denied")),
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });
    const md = "```js\nconst a = 1;\n```";
    await writeBlockClipboard({ markdown: md, from: 0, to: 5, at: 1 });

    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": md });
    expect(handled).toBe(true);
    expect(firstOf(doc, "code_block")).not.toBeNull();
  });

  /**
   * v0.13.2 返修（需求1）：代码块复制按钮 → 跨文档 Ctrl+V 必须还原成代码块。
   *
   * 用户复测反馈：三点菜单的复制/粘贴正常，但代码块右上角复制按钮复制后，
   * 到别的文档粘贴仍是普通文本。根因是系统剪贴板把多行代码的 `\n` 规范化成
   * `\r\n`，而应用内兜底的同源判定按逐字节比较 → 判不出这是同一次复制。
   */
  it("代码块复制按钮 + Windows CRLF 剪贴板 → 仍还原为 code_block（需求1 返修）", async () => {
    const code = "const a = 1;\nconst b = 2;";
    // 模拟 WebView2 写入系统剪贴板失败 / 只走应用内兜底的场景
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: vi.fn().mockRejectedValue(new Error("denied")),
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    await writeCodeBlockClipboard(code, "js");

    // Windows 剪贴板读回来是 CRLF（这不是同一个字符串，但确实是同一次复制）
    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": code.replace(/\n/g, "\r\n") });
    expect(handled).toBe(true);
    const block = firstOf(doc, "code_block");
    expect(block).not.toBeNull();
    expect(block!.textContent).toBe(code);
    expect(block!.attrs.language).toBe("js");
  });

  it("应用内块兜底不得误用：text/plain 与兜底不同源 → 走普通粘贴（返回 false）", async () => {
    await writeBlockClipboard({ markdown: "```js\nconst a = 1;\n```", from: 0, to: 5, at: 1 });
    // 这次粘贴的是普通散文，绝不能把上次复制的代码块塞进文档
    const { view } = pasteView(paraDoc("x"), 2);
    expect(handlePaste(view, clipEvent({ "text/plain": "普通一句话，不是上次复制的块" }))).toBe(false);
  });
});

describe("v0.13.1 需求1：负例与既有守卫（必须仍是字面粘贴）", () => {
  it("普通散文 → handlePaste 返回 false（交回 PM 字面粘贴）", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "今天天气不错，出去走走吧。" }))).toBe(false);
  });

  it("单个 **粗体** → false", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "这是 **粗体**" }))).toBe(false);
  });

  it("单个 - 列表项 → false", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "- 单个列表项" }))).toBe(false);
  });

  it("单行 | a | b |（无分隔行）→ false", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "| a | b |" }))).toBe(false);
  });

  it("设置 pasteMarkdownEnabled = false → 全部路径关闭（含专用 MIME）", () => {
    useSettingsStore.getState().setPasteMarkdownEnabled(false);
    const withPlain = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(withPlain.view, clipEvent({ "text/plain": "```\ncode\n```" }))).toBe(false);

    const withMime = pasteView(paraDoc("hello"), 6);
    expect(
      handlePaste(
        withMime.view,
        clipEvent({
          [BLOCK_CLIPBOARD_MIME]: JSON.stringify({ markdown: "```\ncode\n```", from: 0, to: 0, at: 1 }),
          "text/plain": "```\ncode\n```",
        }),
      ),
    ).toBe(false);
  });

  it("代码块内粘贴 → 仍是字面（返回 false）", () => {
    const doc = schema.topNodeType.create(null, [
      schema.nodes.code_block.create({ language: "", info: "" }, schema.text("code")),
    ]);
    const { view } = pasteView(doc, 2);
    expect(handlePaste(view, clipEvent({ "text/plain": "```\nx\n```" }))).toBe(false);
  });

  it("剪贴板含文件 → 放行给 image-paste（返回 false）", () => {
    const { view } = pasteView(paraDoc("hello"), 6);
    expect(handlePaste(view, clipEvent({ "text/plain": "```\nx\n```" }, ["Files", "text/plain"]))).toBe(false);
  });

  it("inline 段落粘贴仍合并进当前段落（buildPasteSlice 语义未被破坏）", () => {
    const { handled, doc } = pasteIntoFreshDoc({ "text/plain": "**bold**\n\n- x\n- y" });
    expect(handled).toBe(true);
    expect(nodeTypes(doc).has("bullet_list")).toBe(true);
  });
});
