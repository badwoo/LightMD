/**
 * v0.6.6 问题修复测试
 *
 * 问题1：空文档/文档末尾的多个空行（用户按回车产生的空段落）
 *        在 md → doc → md 往返后不再丢失（切换页签/重开文件场景）
 * 问题2：阅读模式（ProseMirror）Slash 命令面板触发检测与块级转换
 * 问题3：焦点在编辑器内按 Delete 不再误触发"关闭临时文件"快捷键
 * 问题4：base64 内联图片在编辑/分屏模式显示为短标记（存储格式不变）
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { isFocusInEditable } from "../components/sidebar/FileTree";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import {
  detectSlashState,
  applyMenuItem,
  createSlashCommandPlugin,
  type SlashState,
} from "../core/plugins/slash-command";
import {
  maskBase64Images,
  unmaskBase64Images,
  hasRawBase64Image,
  adjustCursorForMask,
  type Base64Tokens,
} from "../utils/base64ImageMask";

// ─── 问题1：空行往返一致性 ────────────────────────────────

describe("v0.6.6 问题1：空段落 md→doc→md 往返一致", () => {
  /** 统计 doc 顶层空段落数 */
  function emptyParaCount(markdown: string): number {
    const doc = markdownToDoc(markdown);
    let n = 0;
    doc.forEach((node) => {
      if (node.type.name === "paragraph" && node.content.size === 0) n++;
    });
    return n;
  }

  it("空文档按 3 次回车（3 个空行）→ 3 个空段落，序列化还原为 3 个空行", () => {
    const md = "\n\n\n"; // 3 个空行（4 个 \n 中末尾 1 个是行终结符）
    expect(emptyParaCount(md)).toBe(3);
    // 往返：doc → md 与原文一致
    expect(docToMarkdown(markdownToDoc(md))).toBe("\n\n\n");
  });

  it("文档末尾 2 个空行 → 2 个空段落，序列化保留尾部空行（原 trimEnd 会全部剪掉）", () => {
    const md = "hello\n\n\n\n"; // hello + 2 空行 + 尾换行
    expect(emptyParaCount(md)).toBe(2);
    expect(docToMarkdown(markdownToDoc(md))).toBe("hello\n\n\n\n");
  });

  it("块之间 2 个空行 → 1 个空段落，往返一致", () => {
    const md = "a\n\n\n\nb\n"; // a 与 b 之间 3 个空行 → 2 个空段落
    expect(emptyParaCount(md)).toBe(2);
    expect(docToMarkdown(markdownToDoc(md))).toBe("a\n\n\n\nb\n");
  });

  it("文档开头 2 个空行 → 2 个空段落，往返一致", () => {
    const md = "\n\np\n";
    expect(emptyParaCount(md)).toBe(2);
    expect(docToMarkdown(markdownToDoc(md))).toBe("\n\np\n");
  });

  it("正常文档（单空行分隔）不产生空段落——无行为回归", () => {
    const md = "# 标题\n\n段落一。\n\n段落二。\n";
    expect(emptyParaCount(md)).toBe(0);
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });

  it("空字符串 → 0 个空段落（PM 回退为默认单空段）", () => {
    expect(emptyParaCount("")).toBe(0);
  });

  it("单空行分隔的两个段落保持 1 个空行（往返不膨胀）", () => {
    const md = "a\n\nb\n";
    const doc = markdownToDoc(md);
    // 恰好 2 个段落，均非空
    let count = 0;
    doc.forEach(() => count++);
    expect(count).toBe(2);
    expect(docToMarkdown(doc)).toBe("a\n\nb\n");
  });

  it("多空行连续往返收敛（不发散）", () => {
    let md = "text\n\n\n\n\n\n"; // text + 4 空行 + 尾
    const first = docToMarkdown(markdownToDoc(md));
    const second = docToMarkdown(markdownToDoc(first));
    expect(first).toBe(md);
    expect(second).toBe(md);
  });
});

// ─── 问题3：Delete 快捷键焦点守卫 ─────────────────────────

describe("v0.6.6 问题3：isFocusInEditable 焦点守卫", () => {
  it("焦点在 textarea → true（编辑器打字删除时不触发快捷键）", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    expect(isFocusInEditable(document.activeElement)).toBe(true);
    ta.remove();
  });

  it("焦点在 input → true", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(isFocusInEditable(document.activeElement)).toBe(true);
    input.remove();
  });

  it("焦点在 contenteditable 元素 → true（ProseMirror 阅读模式）", () => {
    const div = document.createElement("div");
    // jsdom 未实现 contentEditable setter，用 setAttribute 设置（真实浏览器行为一致）
    div.setAttribute("contenteditable", "true");
    div.tabIndex = -1; // jsdom 中非表单元素需 tabIndex 才可聚焦
    document.body.appendChild(div);
    div.focus();
    expect(isFocusInEditable(document.activeElement)).toBe(true);
    div.remove();
  });

  it("焦点在普通元素（如文件树项）→ false（快捷键正常工作）", () => {
    const div = document.createElement("div");
    div.tabIndex = -1;
    document.body.appendChild(div);
    div.focus();
    expect(isFocusInEditable(document.activeElement)).toBe(false);
    div.remove();
  });

  it("activeElement 为 null → false", () => {
    expect(isFocusInEditable(null)).toBe(false);
  });
});

// ─── 问题2：阅读模式 Slash 命令面板 ─────────────────────────

/** 查找文本位置（与 translate-tooltip 测试的 helper 一致） */
function findTextPos(doc: PMNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isText || !node.text) return true;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) {
      found = { from: pos + idx, to: pos + idx + needle.length };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`text not found: ${needle}`);
  return found;
}

/** 构造光标位于 needle 末尾的 state */
function makeState(md: string, needle: string, plugin?: ReturnType<typeof createSlashCommandPlugin>) {
  const doc = markdownToDoc(md);
  const { to } = findTextPos(doc, needle);
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, to),
    plugins: plugin ? [plugin] : [],
  });
}

describe("v0.6.6 问题2：detectSlashState 触发检测", () => {
  it("段落行首 / 光标在其后 → 触发，from 指向 / 位置", () => {
    const state = makeState("普通段落\n\n/h2\n", "/h2");
    const s = detectSlashState(state);
    expect(s).not.toBeNull();
    expect(s!.query).toBe("h2");
    expect(s!.to).toBe(state.selection.from);
    // from 处的字符应为 /
    expect(state.doc.textBetween(s!.from, s!.from + 1)).toBe("/");
  });

  it("仅输入 /（无过滤词）→ 触发且 query 为空", () => {
    const state = makeState("abc\n\n/\n", "/");
    const s = detectSlashState(state);
    expect(s).not.toBeNull();
    expect(s!.query).toBe("");
  });

  it("/ 前有正文（非行首）→ 不触发", () => {
    const state = makeState("see /usr/bin\n", "/usr");
    expect(detectSlashState(state)).toBeNull();
  });

  it("光标在 /query 中间（/h|2）→ 仍触发，query 为光标前缀（与源码模式语义一致）", () => {
    const doc = markdownToDoc("/h2\n");
    const { from } = findTextPos(doc, "/h2");
    // 光标放在 /h 之后（"/h|"2）
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, from + 2) });
    const s = detectSlashState(state);
    expect(s?.query).toBe("h");
  });

  it("代码块内 → 不触发", () => {
    const state = makeState("```\n/code\n```\n", "/code");
    expect(detectSlashState(state)).toBeNull();
  });

  it("代码块后普通段落 /table → 触发（代码块判定不误伤后续段落）", () => {
    const state = makeState("```\nfoo\n```\n\n/table\n", "/table");
    expect(detectSlashState(state)?.query).toBe("table");
  });

  it("有选区 → 不触发", () => {
    const doc = markdownToDoc("/h2\n");
    const { from, to } = findTextPos(doc, "/h2");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, to),
    });
    expect(detectSlashState(state)).toBeNull();
  });

  it("前导空格 + / → 触发（与源码模式语义一致）", () => {
    const state = makeState("  /h1\n", "/h1");
    const s = detectSlashState(state);
    expect(s?.query).toBe("h1");
  });
});

describe("v0.6.6 问题2：applyMenuItem 块级转换", () => {
  /** 挂载 view，光标在 needle 末尾，应用菜单项并返回 doc */
  function applyFrom(md: string, itemId: string): PMNode {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const doc = markdownToDoc(md);
    const { to } = findTextPos(doc, itemId === "bold" ? md.trim() : "/h2");
    const view = new EditorView({ mount }, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, to) }),
    });
    const slash: SlashState = { from: to - "/h2".length + 1, to, query: "h2" };
    // from 应指向 /：修正为文本起点
    const { from } = findTextPos(doc, "/h2");
    slash.from = from;
    const item = { id: itemId };
    const ok = applyMenuItem(view, item, slash);
    const result = ok ? view.state.doc : null;
    view.destroy();
    mount.remove();
    return result as unknown as PMNode;
  }

  it("h2 → 段落转换为 heading level 2", () => {
    const doc = applyFrom("/h2\n", "h2");
    expect(doc.firstChild?.type.name).toBe("heading");
    expect(doc.firstChild?.attrs.level).toBe(2);
  });

  it("quote → 段落包进 blockquote", () => {
    const doc = applyFrom("/h2\n", "quote");
    expect(doc.firstChild?.type.name).toBe("blockquote");
    expect(doc.firstChild?.firstChild?.type.name).toBe("paragraph");
  });

  it("ul → 段落包进 bullet_list", () => {
    const doc = applyFrom("/h2\n", "ul");
    expect(doc.firstChild?.type.name).toBe("bullet_list");
    expect(doc.firstChild?.firstChild?.type.name).toBe("list_item");
  });

  it("task-done → 段落包进 task_list 且勾选", () => {
    const doc = applyFrom("/h2\n", "task-done");
    expect(doc.firstChild?.type.name).toBe("task_list");
    expect(doc.firstChild?.firstChild?.attrs.checked).toBe(true);
  });

  it("codeblock → 段落转换为 code_block", () => {
    const doc = applyFrom("/h2\n", "codeblock");
    expect(doc.firstChild?.type.name).toBe("code_block");
  });

  it("hr → 替换为 horizontal_rule + 空段落", () => {
    const doc = applyFrom("/h2\n", "hr");
    expect(doc.firstChild?.type.name).toBe("horizontal_rule");
    expect(doc.child(1)?.type.name).toBe("paragraph");
  });

  it("table → 替换为 table 节点（含表头表体）", () => {
    const doc = applyFrom("/h2\n", "table");
    expect(doc.firstChild?.type.name).toBe("table");
    expect(doc.child(1)?.type.name).toBe("paragraph");
  });

  it("math → 替换为 math_block", () => {
    const doc = applyFrom("/h2\n", "math");
    expect(doc.firstChild?.type.name).toBe("math_block");
  });

  it("mermaid → 替换为 mermaid_block 且含模板文本", () => {
    const doc = applyFrom("/h2\n", "mermaid");
    expect(doc.firstChild?.type.name).toBe("mermaid_block");
    expect(doc.firstChild?.textContent).toContain("graph TD");
  });

  it("inline 项（bold）→ 返回 false 不适用", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const doc = markdownToDoc("/h2\n");
    const { from, to } = findTextPos(doc, "/h2");
    const view = new EditorView({ mount }, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, to) }),
    });
    const item = { id: "bold" };
    expect(applyMenuItem(view, item, { from, to, query: "h2" })).toBe(false);
    view.destroy();
    mount.remove();
  });
});

describe("v0.6.6 问题2：插件状态回调", () => {
  it("dispatch 后状态变化触发回调（触发 → null）", () => {
    const states: (SlashState | null)[] = [];
    const plugin = createSlashCommandPlugin((s) => states.push(s));
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const doc = markdownToDoc("\n");
    const view = new EditorView({ mount }, {
      state: EditorState.create({ doc, plugins: [plugin] }),
    });
    // 输入 "/h"：在空段落起始插入文本（模拟输入）
    view.dispatch(view.state.tr.insertText("/h", 1));
    expect(states[states.length - 1]?.query).toBe("h");
    // 继续输入使触发失效（输入空格后不匹配 ^\s*/\w*$）
    view.dispatch(view.state.tr.insertText(" ", view.state.selection.from));
    expect(states[states.length - 1]).toBeNull();
    view.destroy();
    mount.remove();
  });
});

// ─── 问题4：base64 内联图片短标记（显示层精简） ────────────────

/** 构造超长 base64 data URL（重复字符凑长度，> MIN_MASK_LENGTH=512） */
function makeDataUrl(len = 600, mime = "image/png"): string {
  const payload = "A".repeat(len);
  return `data:${mime};base64,${payload}`;
}

describe("v0.6.6 问题4：maskBase64Images 短标记替换", () => {
  it("超长 base64 → 短标记 image-1.png，tokens 记录映射", () => {
    const tokens: Base64Tokens = new Map();
    const url = makeDataUrl();
    const { text, replacements } = maskBase64Images(`![图](${url})`, tokens);
    expect(text).toBe("![图](image-1.png)");
    expect(replacements).toHaveLength(1);
    expect(tokens.get("image-1.png")).toBe(url);
  });

  it("jpeg → image-1.jpg；未知 mime 回退 png", () => {
    const tokens: Base64Tokens = new Map();
    const { text: t1 } = maskBase64Images(`![](${makeDataUrl(600, "image/jpeg")})`, tokens);
    expect(t1).toBe("![](image-1.jpg)");
    const { text: t2 } = maskBase64Images(`![](${makeDataUrl(600, "image/x-avif")})`, tokens);
    expect(t2).toBe("![](image-2.png)");
  });

  it("短于 512 的 data URL 不替换（小图标展开无收益）", () => {
    const tokens: Base64Tokens = new Map();
    const short = makeDataUrl(100);
    const { text, replacements } = maskBase64Images(`![](${short})`, tokens);
    expect(text).toBe(`![](${short})`);
    expect(replacements).toHaveLength(0);
    expect(tokens.size).toBe(0);
  });

  it("相同 base64 复用同一标记；不同 base64 序号接续", () => {
    const tokens: Base64Tokens = new Map();
    const a = makeDataUrl();
    const b = makeDataUrl(601);
    const { text } = maskBase64Images(`![](${a})\n\n![](${a})\n\n![](${b})`, tokens);
    expect(text).toBe("![](image-1.png)\n\n![](image-1.png)\n\n![](image-2.png)");
    expect(tokens.size).toBe(2);
  });

  it("多次调用：已有标记的文本不受影响，新 base64 序号接续", () => {
    const tokens: Base64Tokens = new Map();
    const a = makeDataUrl();
    maskBase64Images(`![](${a})`, tokens);
    const c = makeDataUrl(602);
    const { text } = maskBase64Images(`![](image-1.png)![](${c})`, tokens);
    expect(text).toBe("![](image-1.png)![](image-2.png)");
  });

  it("纯文本不含 base64 时零开销原样返回", () => {
    const tokens: Base64Tokens = new Map();
    const { text, replacements } = maskBase64Images("# 标题\n\n正文", tokens);
    expect(text).toBe("# 标题\n\n正文");
    expect(replacements).toHaveLength(0);
  });
});

describe("v0.6.6 问题4：unmaskBase64Images 还原", () => {
  it("mask → unmask 往返与原文一致", () => {
    const tokens: Base64Tokens = new Map();
    const original = `# 文档\n\n![图](${makeDataUrl()})\n\n结尾`;
    const { text } = maskBase64Images(original, tokens);
    expect(text).not.toBe(original);
    expect(unmaskBase64Images(text, tokens)).toBe(original);
  });

  it("tokens 为空 / 文本无标记时原样返回", () => {
    expect(unmaskBase64Images("![](image-1.png)", new Map())).toBe("![](image-1.png)");
    const tokens: Base64Tokens = new Map([["image-1.png", makeDataUrl()]]);
    expect(unmaskBase64Images("普通文本", tokens)).toBe("普通文本");
  });

  it("标记被用户改坏（无对应 token）→ 按普通文本保留", () => {
    const tokens: Base64Tokens = new Map([["image-1.png", makeDataUrl()]]);
    expect(unmaskBase64Images("![](image-9.png)", tokens)).toBe("![](image-9.png)");
  });

  it("仅在 markdown URL 上下文还原（普通文本中的 image-1.png 不动）", () => {
    const tokens: Base64Tokens = new Map([["image-1.png", makeDataUrl()]]);
    expect(unmaskBase64Images("文件名是 image-1.png 的图", tokens)).toBe("文件名是 image-1.png 的图");
  });
});

describe("v0.6.6 问题4：adjustCursorForMask 光标补偿", () => {
  it("光标在替换区间之后 → 左移长度差", () => {
    // 替换：start=5, oldLen=620, newLen=11 → 差 609
    const r = [{ start: 5, oldLen: 620, newLen: 11 }];
    expect(adjustCursorForMask(700, r)).toBe(700 - 609);
  });

  it("光标在替换区间之前 → 不变", () => {
    const r = [{ start: 5, oldLen: 620, newLen: 11 }];
    expect(adjustCursorForMask(3, r)).toBe(3);
  });

  it("光标在被替换的 data URL 内部 → 贴到标记末尾", () => {
    const r = [{ start: 5, oldLen: 620, newLen: 11 }];
    expect(adjustCursorForMask(300, r)).toBe(5 + 11);
  });

  it("多个替换区间依次累计偏移", () => {
    const rs = [
      { start: 5, oldLen: 620, newLen: 11 },
      { start: 700, oldLen: 620, newLen: 11 },
    ];
    // 光标在两处替换之后：累计左移 (620-11)*2
    expect(adjustCursorForMask(1400, rs)).toBe(1400 - 609 * 2);
  });
});

describe("v0.6.6 问题4：hasRawBase64Image 快速检测", () => {
  it("含超长 base64 → true；短/无 → false", () => {
    expect(hasRawBase64Image(`![](${makeDataUrl()})`)).toBe(true);
    expect(hasRawBase64Image(`![](${makeDataUrl(100)})`)).toBe(false);
    expect(hasRawBase64Image("普通文本")).toBe(false);
    expect(hasRawBase64Image("提到 base64, 但没有图片")).toBe(false);
  });
});
