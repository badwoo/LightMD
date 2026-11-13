// @vitest-environment jsdom
/**
 * v0.17.0 第三轮 T4：格式栏 / 语法辅助栏三项（#2 / #3 / #10）
 *
 * 本文件是**契约锁**，对应探针 `scripts/v0170-r3-formatbar.mjs` 的浏览器实测。
 * 分工：
 * - 这里锁**纯逻辑**（结构、文案、i18n key、覆盖矩阵）——快、可复现、无 DOM 依赖；
 * - 浏览器实测锁**可见性**（ghost 帧数、mermaid 真渲染、焦点/键盘真实路径）。
 * 两者互不替代：本文件全绿**不能**推出"用户能看见 ghost"。
 *
 * 每个 describe 都写明它防的是哪一个**曾经真实发生**的缺陷。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { EditorState, TextSelection, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { runPreviewCommand } from "../core/pmCommands";
import {
  MERMAID_TEMPLATES,
  HEADING_GHOST_TEXTS,
  PREFIX_GHOST_TEXTS,
  CODEBLOCK_GHOST_TEXT,
  buildFormatReplacement,
  liftListLineToTask,
} from "../components/editor/sourceFormat";
import { SYNTAX_SECTIONS } from "../components/editor/SyntaxHelper";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";

// ─────────────────────────── 阅读模式工具 ───────────────────────────

function stubView(state: EditorState): { view: EditorView; get: () => EditorState } {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch: (tr: Transaction) => {
      current = current.apply(tr);
    },
    focus: () => {},
  } as unknown as EditorView;
  return { view, get: () => current };
}

function itemTextPos(doc: PMNode, listIndex: number, itemIndex: number): number {
  let seen = 0;
  let listPos = -1;
  doc.forEach((node, offset) => {
    if (listPos >= 0) return;
    if (["ordered_list", "bullet_list", "task_list"].includes(node.type.name)) {
      if (seen === listIndex) listPos = offset;
      seen++;
    }
  });
  if (listPos < 0) throw new Error(`找不到第 ${listIndex} 个列表`);
  const list = doc.nodeAt(listPos)!;
  let itemPos = listPos + 1;
  for (let i = 0; i < itemIndex; i++) itemPos += list.child(i).nodeSize;
  return itemPos + 2;
}

function liftAt(doc: PMNode, pos: number) {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  const { view, get } = stubView(state);
  const handled = runPreviewCommand("insert.taskList", view);
  return { handled, doc: get().doc };
}

/** 取文档里的所有"块结构快照"：顶层类型 + 有序列表的 order */
function structureOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((n) => {
    if (n.type.name === "ordered_list") {
      const order = Number(n.attrs.order) || 1;
      const delim = n.attrs.delim === ")" ? ")" : ".";
      out.push(`ol(order=${order}${delim})[${n.textContent}]`);
    } else if (n.type.name === "bullet_list") {
      out.push(`ul[${n.textContent}]`);
    } else if (n.type.name === "task_list") {
      out.push(`task[${n.textContent}]`);
    } else {
      out.push(`${n.type.name}[${n.textContent}]`);
    }
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// #2 Ctrl+T：C2 就地转换（用户裁决）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 防的缺陷（两层）：
 * 1. v0.13.2 之前：任务列表被塞进列表项**内部**（视觉上=回车换行）。
 * 2. v0.13.2：改成"提升到列表之前 + 序号写成字面文本"→ 3 项列表转第 2 项后
 *    阅读顺序成 `2. / 1. / 2.`，用户 v0.17.0 复测："破坏有序列表的顺序"。
 *
 * v0.17.0 第三轮用户裁决 **C2 就地转换**：
 * 原地变待办、原列表断成两段、序号不跳号/不重复/不复位。
 */
/**
 * v0.17.0 **R4 口径变更记录**（本 describe 的来历，别删）
 *
 * 本文件原先是第三轮 T4 的交付物，`#2` 的四段 describe 写的是 **C2 口径**
 * （任务项不带序号、后段 `order` 续号为 `ownOrder`）。
 *
 * **v0.17.0 第四轮（2026-11-12 17:07）用户裁决推翻了 C2**：
 * 用户原话「在有序列表上加任务待办会**把有序列表弄没**，正确例子如**在 2. 上加任务，
 * 那么结果应该是 `- [ ] 2.`**」→ 新口径 = **保留原列表 + 任务项带字面序号**。
 *
 * 因此这四段已按 R4 重写。**权威真值表在 `v0132-task-list-lift.test.ts`**
 * （36 个用例，含 8 种边界 × 四步对照 + 跨模式一致性）；
 * 这里只保留与 #3/#10 同文件的**冒烟级**契约，避免同一口径在两个文件里重复维护、
 * 下次改口径又漏掉一处。
 */
describe("#2 R4 · 快照契约（权威真值表见 v0132-task-list-lift.test.ts）", () => {
  it("★ 用户验收原话：`2. bb` 上 Ctrl+T → `- [ ] 2. bb`，且 `1. aa` / `3. cc` 原样保留", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { handled, doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    expect(handled).toBe(true);
    // 「把有序列表弄没」的反面：三行都在，序号逐字节不变
    expect(docToMarkdown(next)).toBe("1. aa\n\n- [ ] 2. bb\n\n3. cc\n");
  });

  it("块结构：三个顶层块（前段列表 + 待办 + 后段列表），后段 order = 原序号 + 1", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    // structureOf 的格式是 `ol(<order><delim>)[<text>]`，见其定义
    expect(structureOf(next)).toEqual(["ol(order=1.)[aa]", "task[2. bb]", "ol(order=3.)[cc]"]);
  });

  it("序列化往返稳定（修复后 → 再解析 → 再序列化，逐字节不变）", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    const once = docToMarkdown(next);
    expect(docToMarkdown(markdownToDoc(once))).toBe(once);
  });

  it("反例：C2 口径的产物（任务项**不带**序号）必须不再出现", () => {
    const doc = markdownToDoc("1. aa\n2. bb\n3. cc\n");
    const { doc: next } = liftAt(doc, itemTextPos(doc, 0, 1));
    // C2 是 `- [ ] bb`；R4 必须是 `- [ ] 2. bb`
    expect(docToMarkdown(next)).not.toMatch(/^- \[ \] bb$/m);
  });

  it("源码模式纯函数与阅读模式同口径（`- [ ] 2. two`，后段保持 `3.`）", () => {
    const text = ["1. one", "2. two", "3. three"].join("\n");
    const res = liftListLineToTask(text, 6)!;
    expect(res.replacement.replace(/\n+/g, "\n")).toBe("- [ ] 1. one\n2. two\n3. three");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #3 语法辅助栏 ghost 覆盖矩阵
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 防的缺陷：用户「语法辅助栏的 ghost 文本功能还缺失，例如代码块，请全面检查下
 * 格式栏和语法辅助栏，发现有漏的就补上。」
 *
 * 判定规则（本文件锁死，防止下次"顺手乱补"）：
 * - **有** ghost：插入后文档里只留语法骨架、且骨架中存在「本应由用户填写内容」的空位。
 * - **没有** ghost：① 插入即预填了可见内容（表格/公式）；② 结构里没有内容位（分割线）。
 */
describe("#3 ghost 覆盖矩阵：SyntaxHelper 的 35 项逐项判定", () => {
  /**
   * 直接遍历**真实数据表** `SYNTAX_SECTIONS`。
   *
   * ⚠️ 第一版用 `readFileSync` + 正则去抓 `{ name: "syntax.xxx", ... ghost: ... }`，
   * 只抓到 22/35 项 —— 断言在缺失项上"找不到就跳过"，等于**空跑 13 项漏检**。
   * 因此把 `SYNTAX_SECTIONS` 从模块私有改成导出（生产代码只有本组件自用），
   * 测试遍历真实对象：漏项会同时让"总数 35"和"逐项 ghost 判定"两条断言红。
   */
  type Item = { name: string; insert: string; cursorOffset: number; ghost?: string };
  const sections = SYNTAX_SECTIONS as unknown as Array<{ title: string; items: Item[] }>;
  const allItems: Item[] = sections.flatMap((s) => s.items);
  const byName = new Map(allItems.map((i) => [i.name, i]));

  it("能遍历到全部 35 项（防断言空跑：数据表被裁掉时这里先红）", () => {
    expect(allItems.length).toBe(35);
    expect(byName.size).toBe(35); // name 必须唯一
  });

  it("必须有 ghost 的 33 项：标题 H1~H6 / 行内格式 5 / 代码块 4 + 语言 11 / 列表 4 / 引用链接图片 3", () => {
    const mustHave = [
      // 标题 6（H4~H6 是本轮补的项本身）
      "syntax.h1", "syntax.h2", "syntax.h3", "syntax.h4", "syntax.h5", "syntax.h6",
      // 行内格式 5
      "syntax.bold", "syntax.italic", "syntax.boldItalic", "syntax.strikethrough", "syntax.inlineCode",
      // 代码块 4（用户点名的「例如代码块」）+ 语言围栏 11
      "syntax.codeblock", "syntax.jsCodeblock", "syntax.pythonCodeblock", "syntax.htmlCodeblock",
      "TypeScript", "Go", "Rust", "Java", "C++", "SQL", "JSON", "YAML", "Bash", "Markdown", "PHP",
      // 列表 4
      "syntax.unorderedList", "syntax.orderedList", "syntax.taskList", "syntax.taskDone",
      // 引用 / 链接 / 图片 3
      "syntax.quote", "syntax.link", "syntax.image",
    ];
    expect(mustHave).toHaveLength(33);
    const missing = mustHave.filter((n) => !byName.get(n)?.ghost);
    expect(missing, `这些项缺 ghost：${missing.join(", ")}`).toEqual([]);
  });

  it("**不该**有 ghost 的 2 项：表格（已预填内容）、分割线（无内容位）", () => {
    for (const n of ["syntax.table", "syntax.hr"]) {
      const item = byName.get(n);
      expect(item, `找不到 ${n}`).toBeTruthy();
      expect(item!.ghost, `${n} 不该有 ghost（判定规则的反例）`).toBeUndefined();
    }
    // 33 + 2 = 35：恰好覆盖全表，没有"既不在必补也不在反例"的漏网项
    expect(33 + 2).toBe(allItems.length);
  });

  it("有 ghost 的项，其 ghost 文案**不得**出现在 insert 里（不落盘）", () => {
    for (const item of allItems) {
      if (!item.ghost) continue;
      expect(item.insert, `${item.name} 把 ghost 文案写进了插入文本`).not.toContain(item.ghost);
    }
  });

  it("ghost 文案复用 sourceFormat 常量（两入口对同一操作必须同一句话）", () => {
    const src = readFileSync("src/components/editor/SyntaxHelper.tsx", "utf-8");
    // 标题 6 级全部引 HEADING_GHOST_TEXTS[i]
    for (let i = 0; i < 6; i++) {
      expect(src, `H${i + 1} 未复用 HEADING_GHOST_TEXTS[${i}]`).toContain(
        `ghost: HEADING_GHOST_TEXTS[${i}]`,
      );
    }
    // 列表/任务/引用/链接/图片
    for (const k of ["list", "task", "quote", "link", "image"]) {
      expect(src, `${k} 未复用 PREFIX_GHOST_TEXTS`).toContain(`ghost: PREFIX_GHOST_TEXTS.${k}`);
    }
    // 代码块（4 + 11 = 15 处引用 CODEBLOCK_GHOST_TEXT）
    const cbRefs = src.match(/ghost: CODEBLOCK_GHOST_TEXT/g) ?? [];
    expect(cbRefs.length, "代码块围栏应全部复用 CODEBLOCK_GHOST_TEXT").toBe(15);
    // 常量本身非空
    expect(CODEBLOCK_GHOST_TEXT.length).toBeGreaterThan(0);
    expect(PREFIX_GHOST_TEXTS.list.length).toBeGreaterThan(0);
    expect(HEADING_GHOST_TEXTS).toHaveLength(6);
  });

  it("每个有 ghost 的项，插入后光标落点都落在「语法骨架内部」（0 < cursorOffset < insert.length）", () => {
    for (const item of allItems) {
      if (!item.ghost) continue;
      expect(item.cursorOffset, `${item.name} cursorOffset 越界`).toBeGreaterThan(0);
      expect(item.cursorOffset, `${item.name} cursorOffset 越界`).toBeLessThanOrEqual(item.insert.length);
    }
  });

  it("格式栏（buildFormatReplacement）与语法栏对同一 action 的 ghost 文案一致", () => {
    for (let level = 1; level <= 6; level++) {
      expect(buildFormatReplacement(`h${level}`, "")!.ghostText).toBe(HEADING_GHOST_TEXTS[level - 1]);
    }
    expect(buildFormatReplacement("codeblock", "")!.ghostText).toBe(CODEBLOCK_GHOST_TEXT);
    expect(buildFormatReplacement("ul", "")!.ghostText).toBe(PREFIX_GHOST_TEXTS.list);
    expect(buildFormatReplacement("task", "")!.ghostText).toBe(PREFIX_GHOST_TEXTS.task);
    expect(buildFormatReplacement("quote", "")!.ghostText).toBe(PREFIX_GHOST_TEXTS.quote);
    expect(buildFormatReplacement("link", "")!.ghostText).toBe(PREFIX_GHOST_TEXTS.link);
    expect(buildFormatReplacement("image", "")!.ghostText).toBe(PREFIX_GHOST_TEXTS.image);
  });

  it("格式栏：表格/公式/分割线**不**返回 ghostText（与语法栏判定规则同口径）", () => {
    for (const action of ["table", "math", "hr"]) {
      expect(buildFormatReplacement(action, "")!.ghostText, `${action} 不该有 ghost`).toBeUndefined();
    }
  });

  it("ghost 文案**绝不落盘**：所有 ghostText 都不出现在 replacement 里", () => {
    const actions = [
      "bold", "italic", "bolditalic", "strikethrough", "code", "codeblock",
      "h1", "h2", "h3", "h4", "h5", "h6", "ul", "task", "task-circle", "ol", "quote", "link", "image",
    ];
    for (const a of actions) {
      const r = buildFormatReplacement(a, "")!;
      if (!r.ghostText) continue;
      expect(r.replacement, `${a} 把 ghost 文案写进了文档`).not.toContain(r.ghostText);
    }
  });

  it("语法栏 ghost 通道被正确门控（回归：无 ghost 的项不得建 ghost 记录）", () => {
    /**
     * 防本轮浏览器实测发现的**真实缺陷**：`ModeSync.insertHandler` 旧实现
     * `if (!selected)` 无条件建 ghost 记录，`text = opts?.ghost ?? ""` 可能为空串，
     * 却仍带 `tail` → 点「表格」后屏幕上多出一条灰色重影 `列1 | 列2 | 列3 |`。
     * 修法：只有 `opts?.ghost` 存在才走 ghost 通道，否则 clear。
     */
    const modeSync = readFileSync("src/components/editor/panes/modesync/ModeSync.tsx", "utf-8");
    expect(modeSync).toContain("if (!selected && opts?.ghost) {");
    expect(modeSync, "旧写法必须消失").not.toContain('text: opts?.ghost ?? ""');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #10 Mermaid：i18n key 完整性 + 模板结构
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 防的缺陷：
 * 1. 用户「mermaid 图标文字又变成英文了」—— `label` 是硬编码英文串，没走 i18n。
 * 2. 「检查下还有没有遗漏的类型图表请进行补全」—— 只有 7 种。
 */
describe("#10 Mermaid 模板：i18n key 完整性（zh-CN / en-US 双包）", () => {
  const zh = zhCN as Record<string, string>;
  const en = enUS as Record<string, string>;

  it("每个模板都有非空 id / labelKey / syntax", () => {
    for (const t of MERMAID_TEMPLATES) {
      expect(t.id, `模板缺 id：${t.label}`).toBeTruthy();
      expect(t.labelKey, `模板缺 labelKey：${t.id}`).toBeTruthy();
      expect(t.syntax, `模板缺 syntax：${t.id}`).toBeTruthy();
    }
  });

  it("id 唯一（React key 用）", () => {
    const ids = MERMAID_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labelKey 唯一", () => {
    const keys = MERMAID_TEMPLATES.map((t) => t.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每个 labelKey 在 zh-CN 与 en-US **两个语言包**都有非空词条（防漏译）", () => {
    const missing: string[] = [];
    for (const t of MERMAID_TEMPLATES) {
      if (!zh[t.labelKey]) missing.push(`zh-CN 缺 ${t.labelKey}`);
      if (!en[t.labelKey]) missing.push(`en-US 缺 ${t.labelKey}`);
    }
    expect(missing).toEqual([]);
  });

  it("中文词条必须真的含中文，英文词条必须不含中文（防「两边填了同一份」）", () => {
    for (const t of MERMAID_TEMPLATES) {
      expect(zh[t.labelKey], `zh-CN ${t.labelKey} 不含中文`).toMatch(/[\u4e00-\u9fff]/);
      expect(en[t.labelKey], `en-US ${t.labelKey} 含中文`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("labelKey 命名空间统一为 mermaid.type.*", () => {
    for (const t of MERMAID_TEMPLATES) {
      expect(t.labelKey.startsWith("mermaid.type.")).toBe(true);
    }
  });

  it("模板数量已从 7 补到 ≥20（覆盖 mermaid 11 主要类型）", () => {
    expect(MERMAID_TEMPLATES.length).toBeGreaterThanOrEqual(20);
  });

  it("渲染点必须调用 t(labelKey)，**不得**直接渲染 label（否则中文界面又变英文）", () => {
    const container = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");
    expect(container).toContain("{t(tpl.labelKey)}");
    // 反例：旧写法
    expect(container).not.toContain("{tpl.label}");
    // React key 用稳定 id
    expect(container).toContain("key={tpl.id}");
  });

  it("每个 syntax 都是 ```mermaid 围栏，且围栏内首个非空行是已知图表类型关键字", () => {
    const KNOWN = [
      "graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "stateDiagram",
      "erDiagram", "journey", "gantt", "pie", "quadrantChart", "timeline", "mindmap", "gitGraph",
      "C4Context", "block-beta", "packet-beta", "kanban", "xychart-beta", "sankey-beta",
      "radar-beta", "treemap-beta",
    ];
    for (const t of MERMAID_TEMPLATES) {
      expect(t.syntax, t.id).toContain("```mermaid");
      const inner = t.syntax.split("```mermaid\n")[1]?.split("```")[0] ?? "";
      const firstLine = inner.split("\n").find((l) => l.trim().length > 0) ?? "";
      const kw = firstLine.trim().split(/\s+/)[0];
      expect(KNOWN, `${t.id} 的图表关键字「${kw}」不在已知列表`).toContain(kw);
    }
  });

  it("每个 syntax 唯一（防复制粘贴重复项）", () => {
    const s = MERMAID_TEMPLATES.map((t) => t.syntax);
    expect(new Set(s).size).toBe(s.length);
  });

  it("用户裁决/实测剔除的类型不得出现在模板里（附原因，防下次「顺手加回来」）", () => {
    const types = MERMAID_TEMPLATES.map((t) => t.syntax);
    // requirementDiagram / architecture-beta：在本仓 mermaid 11.15.0 + strict 下，
    // **中文内容会解析失败**（英文可渲染）→ 加了等于给中文用户埋坑
    for (const t of types) {
      expect(t).not.toContain("requirementDiagram");
      expect(t).not.toContain("architecture-beta");
    }
  });
});
