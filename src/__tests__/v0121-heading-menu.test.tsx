/**
 * v0.12.1 需求1：标题级别徽标 + H1~H6 级别下拉菜单
 *
 * 需求原文：
 *  - 标题文字点击后出现的不再是 `#` 语法井号，而是 H1/H2…（二级标题显示 H2）；
 *  - 点击 H2 徽标展开 H1~H8 供选择来改变标题级别；
 *  - 原「输入 # 数量改级别」的输入方式保持不变；
 *  - 展开要带顺滑的动画。
 *
 * 范围确认（用户拍板）：Markdown 标准只有 6 级标题（markdown-it 仅把 1~6 个 `#`
 * 解析为标题，7 个 `#` 是普通段落），故菜单只列 **H1~H6**，不生成无法往返的语法。
 *
 * 覆盖：
 * 1. 徽标 DOM（H1/H2…、可点击、不抢光标）与只读态拦截
 * 2. 插件装饰：标题不再输出 `#` 标记，改为 .pm-heading-marker + 徽标 widget
 * 3. 真实 EditorView 里点击徽标 → 回调带出标题位置与当前级别
 * 4. 级别下拉菜单：6 项、当前项高亮、点击改级别、i18n 文案
 * 5. applyHeadingLevelToView：一次事务改 level、非标题/同级别安全退出
 * 6. 动画：关键帧 + reduced-motion；原输入 `#` 的 inputrule 保持不变
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { createEditor } from "../core/editor";
import { createHeadingBadge, createWysiwygPlugin } from "../core/plugins/wysiwyg";
import { applyHeadingLevelToView } from "../components/editor/EditorContainer";
import { HeadingLevelMenu, HEADING_LEVELS } from "../components/editor/HeadingLevelMenu";
import type { EditorView } from "prosemirror-view";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string) => readFileSync(join(root, rel), "utf-8");
const editorCss = readSrc("src/styles/editor.css");

describe("v0.12.1 需求1：标题级别徽标 DOM", () => {
  it("徽标文本为 H<level>，带菜单语义与提示文案", () => {
    const badge = createHeadingBadge(2, () => 5, {});
    expect(badge.className).toBe("pm-heading-badge");
    expect(badge.textContent).toBe("H2");
    expect(badge.dataset.headingLevel).toBe("2");
    expect(badge.getAttribute("aria-haspopup")).toBe("menu");
    // i18n：zh 文案含当前级别
    expect(badge.getAttribute("aria-label")).toContain("H2");
    expect(badge.getAttribute("title")).toContain("H2");
  });

  it("mousedown 被阻止（点徽标不移动光标、不打断选区）", () => {
    const badge = createHeadingBadge(1, () => 1, {});
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    badge.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("点击回调带出「标题节点位置 + 当前级别 + 锚点矩形」", () => {
    const onHeadingBadgeClick = vi.fn();
    // widget 插在标题内容起点（start+1）→ 标题节点位置 = getPos() - 1
    const badge = createHeadingBadge(3, () => 8, { onHeadingBadgeClick });
    badge.click();
    expect(onHeadingBadgeClick).toHaveBeenCalledTimes(1);
    const [pos, level, anchor] = onHeadingBadgeClick.mock.calls[0];
    expect(pos).toBe(7);
    expect(level).toBe(3);
    expect(anchor).toBeTruthy();
  });

  it("只读标签（view.editable === false）点击不触发回调", () => {
    const onHeadingBadgeClick = vi.fn();
    const badge = createHeadingBadge(2, () => 5, { onHeadingBadgeClick });
    (badge as HTMLElement & { __pmView?: unknown }).__pmView = { editable: false };
    badge.click();
    expect(onHeadingBadgeClick).not.toHaveBeenCalled();
  });
});

describe("v0.12.1 需求1：真实编辑器中的徽标", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null = null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
    cleanup();
  });

  it("光标在标题内 → DOM 出现 .pm-heading-badge（H2）且不再有井号标记", () => {
    const onHeadingBadgeClick = vi.fn();
    view = createEditor({ parent, initialContent: "## 标题", onHeadingBadgeClick }) as EditorView;
    const badge = parent.querySelector<HTMLElement>(".pm-heading-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("H2");
    // 旧实现：标题节点装饰带 data-md-block-open = "## "（CSS ::before 显示井号）
    const heading = parent.querySelector("h2")!;
    expect(heading.getAttribute("data-md-block-open")).toBeNull();
    expect(heading.className).toContain("pm-heading-marker");
  });

  it("点击 DOM 中的徽标 → 回调收到标题节点位置与级别", () => {
    const onHeadingBadgeClick = vi.fn();
    view = createEditor({ parent, initialContent: "# 标题", onHeadingBadgeClick }) as EditorView;
    const badge = parent.querySelector<HTMLElement>(".pm-heading-badge")!;
    badge.click();
    expect(onHeadingBadgeClick).toHaveBeenCalledTimes(1);
    const [pos, level] = onHeadingBadgeClick.mock.calls[0];
    expect(pos).toBe(0); // 文档首个块 → 节点起始位置 0
    expect(level).toBe(1);
  });

  it("无回调的默认实例（wysiwygPlugin）不抛错：徽标照常可见", () => {
    view = createEditor({ parent, initialContent: "### 标题" }) as EditorView;
    const badge = parent.querySelector<HTMLElement>(".pm-heading-badge")!;
    expect(badge.textContent).toBe("H3");
    expect(() => badge.click()).not.toThrow();
  });

  it("工厂实例：createWysiwygPlugin({ onHeadingBadgeClick }) 可独立构造", () => {
    expect(typeof createWysiwygPlugin).toBe("function");
    const plugin = createWysiwygPlugin({ onHeadingBadgeClick: () => undefined });
    expect(plugin.spec.props?.decorations).toBeTruthy();
  });
});

describe("v0.12.1 需求1：H1~H6 级别下拉菜单", () => {
  afterEach(cleanup);

  it("菜单列出 H1~H6（Markdown 标准 6 级）", () => {
    render(
      <HeadingLevelMenu open anchor={null} current={2} onSelect={() => undefined} onClose={() => undefined} />,
    );
    // portal 渲染到 body → 用 document.body 查询
    const items = document.body.querySelectorAll(".heading-level-item");
    expect(items).toHaveLength(6);
    expect([...HEADING_LEVELS]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...items].map((el) => el.textContent?.startsWith(`H${el.getAttribute("data-level")}`))).toEqual([
      true, true, true, true, true, true,
    ]);
  });

  it("当前级别高亮并标记 aria-checked", () => {
    render(
      <HeadingLevelMenu open anchor={null} current={2} onSelect={() => undefined} onClose={() => undefined} />,
    );
    const active = document.body.querySelector(".heading-level-item.active")!;
    expect(active.getAttribute("data-level")).toBe("2");
    expect(active.getAttribute("aria-checked")).toBe("true");
  });

  it("点击某项 → onSelect(level) 且菜单关闭", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <HeadingLevelMenu open anchor={null} current={2} onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(document.body.querySelector('[data-level="4"]')!);
    expect(onSelect).toHaveBeenCalledWith(4);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("open=false 不渲染", () => {
    render(
      <HeadingLevelMenu open={false} anchor={null} current={1} onSelect={() => undefined} onClose={() => undefined} />,
    );
    expect(document.body.querySelector(".heading-level-menu")).toBeNull();
  });

  it("Esc 关闭菜单", () => {
    const onClose = vi.fn();
    render(
      <HeadingLevelMenu open anchor={null} current={1} onSelect={() => undefined} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("v0.12.1 需求1：改级别（applyHeadingLevelToView）", () => {
  let parent: HTMLDivElement;
  let view: EditorView | null = null;

  beforeEach(() => {
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    parent.remove();
  });

  it("二级标题改为四级：一次事务、内容保留", () => {
    const v = createEditor({ parent, initialContent: "## 标题内容" }) as EditorView;
    view = v;
    let dispatches = 0;
    const orig = v.dispatch.bind(v);
    v.dispatch = (tr) => {
      dispatches++;
      return orig(tr);
    };
    expect(applyHeadingLevelToView(v, 0, 4)).toBe(true);
    expect(dispatches).toBe(1);
    expect(v.state.doc.firstChild!.attrs.level).toBe(4);
    expect(v.state.doc.textContent).toBe("标题内容");
  });

  it("同级别 / 非标题位置 → 不产生事务", () => {
    const v = createEditor({ parent, initialContent: "## 标题\n\n正文" }) as EditorView;
    view = v;
    let dispatches = 0;
    const orig = v.dispatch.bind(v);
    v.dispatch = (tr) => {
      dispatches++;
      return orig(tr);
    };
    expect(applyHeadingLevelToView(v, 0, 2)).toBe(false); // 同级别
    expect(applyHeadingLevelToView(v, v.state.doc.firstChild!.nodeSize + 1, 3)).toBe(false); // 段落
    expect(dispatches).toBe(0);
  });

  it("H1~H6 全部可达（含 H5/H6）", () => {
    const v = createEditor({ parent, initialContent: "# 标题" }) as EditorView;
    view = v;
    // 起点是 H1，从 H2 开始逐个切换，最后再切回 H1
    for (const level of [2, 3, 4, 5, 6, 1]) {
      expect(applyHeadingLevelToView(v, 0, level)).toBe(true);
      expect(v.state.doc.firstChild!.attrs.level).toBe(level);
    }
  });
});

describe("v0.12.1 需求1：样式与接线契约", () => {
  it("徽标样式：绝对定位于标题左缘外（脱离文档流，零位移）", () => {
    const idx = editorCss.indexOf(".ProseMirror .pm-heading-badge {");
    expect(idx).toBeGreaterThan(-1);
    const block = editorCss.slice(idx, editorCss.indexOf("}", idx));
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/right:\s*100%/);
  });

  it("级别菜单有展开关键帧 + 缓动，并尊重 prefers-reduced-motion", () => {
    expect(editorCss).toMatch(/@keyframes heading-menu-in \{/);
    expect(editorCss).toMatch(/animation:\s*heading-menu-in 200ms cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
    const kf = editorCss.match(/@keyframes heading-menu-in \{[\s\S]*?\n\}/)![0];
    expect(kf).toMatch(/scaleY\(0\.86\)/); // 顺滑展开：缩放 + 位移 + 淡入
    expect(kf).toMatch(/translateY\(-6px\)/);
    expect(kf).toMatch(/opacity:\s*0/);
    expect(editorCss).toMatch(/\.heading-level-menu \{\s*animation: none;/);
  });

  it("旧标题井号标记不再生成（仅引用/代码块保留）", () => {
    const src = readSrc("src/core/plugins/wysiwyg.ts");
    expect(src).not.toMatch(/marker = "#"/);
    expect(src).toMatch(/marker = "> "/);
    expect(src).toMatch(/marker = "```" \+ lang/);
  });

  it("EditorContainer 接线：回调 → 菜单状态 → 改级别；并渲染菜单", () => {
    const src = readSrc("src/components/editor/EditorContainer.tsx");
    expect(src).toMatch(/onHeadingBadgeClick: \(headingPos, currentLevel, anchor\)/);
    expect(src).toMatch(/<HeadingLevelMenu/);
    expect(src).toMatch(/applyHeadingLevelToView\(view, pos, level\)/);
  });

  it("原「输入 # 数量改级别」的 inputrule 保持不变", () => {
    const rules = readSrc("src/core/inputrules.ts");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(rules).toContain(`blockRule(/^#{${n}}\\s$/, schema.nodes.heading, () => ({ level: ${n} }))`);
    }
  });

  it("i18n 文案齐备（zh/en）", () => {
    for (const key of ["heading.badge.title", "heading.menu.title", "heading.menu.hint", "heading.menu.current"]) {
      expect(readSrc("src/i18n/locales/zh-CN.ts")).toContain(`"${key}"`);
      expect(readSrc("src/i18n/locales/en-US.ts")).toContain(`"${key}"`);
    }
  });
});
