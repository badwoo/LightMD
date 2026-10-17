/**
 * v0.12.1 第二轮（用户 11 项需求）验收
 *
 * 需求1：标题徽标 H1~H6 —— 与标题垂直对齐 + 不再把 "H" 与数字折成两行
 * 需求2：点徽标改标题级别后，右侧大纲栏必须跟着改层级缩进
 * 需求3：带图片的文档切走再切回，图片仍可见（图片相对路径按**当前文档**解析）
 * 需求4：任务列表复选框与首行文字对齐
 * 需求5：任务列表方形/圆形两种图标样式（源码 `- [ ]` / `* [ ]`）+ 阅读模式手柄下拉
 *        + 格式栏下拉 + 格式刷套用样式
 * 需求6：代码块末尾按 → 退出代码块（末块则新建空段落）
 * 需求7：格式刷图标重绘为小油漆刷
 * 需求8：设置窗口开启「从上方滑下 + 果冻回弹」、关闭「下压蓄力 + 上滑」
 * 需求9：排版四项实时预览 + 拖动时设置窗口玻璃透明 + 取消回滚
 * 需求11：编辑模式右上角也有小书本悬浮按钮，点击跳阅读模式
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import React from "react";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readSrc = (rel: string) => readFileSync(join(root, rel), "utf-8");

const editorCss = readSrc("src/styles/editor.css");
const settingsCss = readSrc("src/components/dialogs/SettingsDialog.css");
const settingsSrc = readSrc("src/components/dialogs/SettingsDialog.tsx");
const containerSrc = readSrc("src/components/editor/EditorContainer.tsx");
const outlineSrc = readSrc("src/components/editor/Outline.tsx");
const keymapSrc = readSrc("src/core/keymap.ts");
const taskPluginSrc = readSrc("src/core/markdown/task-list-plugin.ts");
const serializerSrc = readSrc("src/core/markdown/serializer.ts");
const schemaSrc = readSrc("src/core/schema.ts");
const painterSrc = readSrc("src/utils/formatPainter.ts");
const modeBtnSrc = readSrc("src/components/editor/ModeSwitchButton.tsx");

// ─── 需求1：标题徽标 ────────────────────────────────────────

describe("v0.12.1 需求1：标题徽标对齐 + 不折行", () => {
  const badge = (() => {
    const idx = editorCss.indexOf(".ProseMirror .pm-heading-badge {");
    return editorCss.slice(idx, editorCss.indexOf("}", idx));
  })();

  it("垂直居中：top:50% + translateY(-50%)（旧实现缺 top，基线对齐导致偏高 7px）", () => {
    expect(badge).toMatch(/top:\s*50%/);
    expect(badge).toMatch(/transform:\s*translateY\(-50%\)/);
    // 绝对定位 + 贴标题左缘的既有契约不变
    expect(badge).toMatch(/position:\s*absolute/);
    expect(badge).toMatch(/right:\s*100%/);
  });

  it("不再折行：white-space: nowrap + 宽高够放 H1（旧 min-width:1.7em 装不下 600 字重的 H1）", () => {
    expect(badge).toMatch(/white-space:\s*nowrap/);
    expect(badge).toMatch(/min-width:\s*22px/);
    expect(badge).toMatch(/height:\s*17px/);
    // 旧实现：min-width: 1.7em / height: 1.35em / padding: 0 0.28em / font-size: 0.62em
    expect(badge).not.toMatch(/min-width:\s*1\.7em/);
    expect(badge).not.toMatch(/font-size:\s*0\.62em/);
  });

  it("字号随级别小幅递减（clamp 9~13px），H1 不再得到近 20px 的大徽标", () => {
    expect(badge).toMatch(/font-size:\s*clamp\(9px,\s*0\.42em,\s*13px\)/);
  });
});

// ─── 需求2：大纲层级缩进 ────────────────────────────────────

describe("v0.12.1 需求2：改标题级别后大纲层级要跟随", () => {
  it("标题去重键必须含 level（旧键只有 pos:text，改级别不发 setState）", () => {
    expect(outlineSrc).toContain("${h.pos}:${h.level}:${h.text}");
    // 旧键形态不得残留
    expect(outlineSrc).not.toContain("${h.pos}:${h.text}`).join");
  });
});

// ─── 需求3：图片切文档后消失 ────────────────────────────────

describe("v0.12.1 需求3：文档切换时图片路径按当前文档解析", () => {
  it("EditorContainer 在解析文档前同步全局文档路径（内容与路径同源）", () => {
    // 解析入口必须是 `const newDoc = markdownToDoc(content)`。
    // v0.13.2 需求9 起外面包了一层 `withTrailingParagraph(...)`（尾部垫段落），
    // 因此这里只锁「newDoc 由 markdownToDoc(content) 得到」这个**意图**，
    // 不再锁死字面量（否则实现加一层包装就误报，而行为意图其实没变）。
    const idxParse = containerSrc.indexOf("const newDoc = ");
    const idxSync = containerSrc.indexOf('setCurrentDocPath(filePath || "")');
    expect(idxSync).toBeGreaterThan(-1);
    expect(idxParse).toBeGreaterThan(-1);
    expect(containerSrc.slice(idxParse, idxParse + 160)).toContain("markdownToDoc(content)");
    expect(idxSync).toBeLessThan(idxParse);
  });

  it("首次挂载（createEditor）同样先设路径", () => {
    const idxCreate = containerSrc.indexOf("const view = createEditor({");
    expect(idxCreate).toBeGreaterThan(-1);
    const before = containerSrc.slice(Math.max(0, idxCreate - 600), idxCreate);
    expect(before).toContain('setCurrentDocPath(filePath || "")');
  });

  it("App 层切标签也同步设置（与 handleOpenFile 同款，双保险）", () => {
    const appSrc = readSrc("src/App.tsx");
    const idx = appSrc.indexOf("const handleTabSwitch = useCallback(");
    expect(idx).toBeGreaterThan(-1);
    const body = appSrc.slice(idx, idx + 1600);
    expect(body).toContain("setCurrentDocPath(tab.path || \"\")");
  });
});

// ─── 需求4：任务列表对齐 ────────────────────────────────────

describe("v0.12.1 需求4：复选框与首行文字对齐", () => {
  it("任务项首段上边距归零（段间距规则曾把它顶下去 13px）", () => {
    expect(editorCss).toMatch(
      /\.ProseMirror li\.task-item > \.task-content > p:first-child \{\s*margin-top:\s*0;/,
    );
  });

  it("复选框按「行高 × 字号」算出首行盒中线，而不再是硬编码 5px", () => {
    const idx = editorCss.indexOf(".ProseMirror .task-checkbox {");
    const block = editorCss.slice(idx, editorCss.indexOf("}", idx));
    expect(block).toMatch(
      /margin-top:\s*calc\(\(var\(--editor-line-height,\s*1\.8\) \* 1em - 15px\) \/ 2\)/,
    );
    expect(block).toMatch(/font:\s*inherit/); // 1em = 正文字号
    expect(editorCss).not.toContain("margin-top: 5px;");
  });

  it("分屏预览（iframe 内联样式）同步同款口径", () => {
    expect(containerSrc).toContain("li.task-item > .task-content > p:first-child { margin-top: 0; }");
    expect(containerSrc).toContain('margin-top: calc((1.8 * 1em - 15px) / 2)');
  });
});

// ─── 需求5：方形 / 圆形两种任务图标样式 ─────────────────────

describe("v0.12.1 需求5：任务列表方形/圆形样式", () => {
  it("口径单一事实源：`-` 方形、`*` 圆形（task-style.ts）", () => {
    const styleSrc = readSrc("src/core/markdown/task-style.ts");
    expect(styleSrc).toContain('square: "-"');
    expect(styleSrc).toContain('circle: "*"');
    expect(styleSrc).toMatch(/return bullet === "\*" \? "circle" : "square"/);
  });

  it("解析端接受 * / + 符号并落到 data-style", () => {
    expect(taskPluginSrc).toContain("const TASK_ITEM_RE = /^(\\s*)([-*+])\\s+\\[([ xX])\\]\\s+/;");
    expect(taskPluginSrc).toContain('taskStyleFromBullet(itemMatch[2])');
    expect(taskPluginSrc).toContain('["data-style", node.style]');
    // 分屏渲染规则也要带圆形 class
    expect(taskPluginSrc).toContain("taskItemClassName(node.style)");
  });

  it("文档模型：task_item.attrs.style + li class/data-style（阅读模式与预览同构）", () => {
    expect(schemaSrc).toMatch(/task_item:[\s\S]{0,400}?style: \{ default: "square" \}/);
    expect(schemaSrc).toContain('class: style === "circle" ? "task-item task-item-circle" : "task-item"');
  });

  it("序列化：圆形写 `* [ ]`，方形写 `- [ ]`", () => {
    expect(serializerSrc).toContain('const bullet = taskItem.attrs.style === "circle" ? "*" : "-";');
    expect(serializerSrc).toContain("${indent}${bullet} [${checked}] ${content}");
  });

  it("阅读模式手柄：NodeView 渲染 .task-style-handle + 下拉菜单挂 body", () => {
    const viewSrc = readSrc("src/core/plugins/task-list.ts");
    expect(viewSrc).toContain('this.styleHandle.className = "task-style-handle"');
    expect(viewSrc).toContain("document.body.appendChild(menu)");
    expect(viewSrc).toContain('setNodeMarkup(pos, undefined, { ...this.node.attrs, style })');
    expect(viewSrc).toContain("stopEvent");
    // 手柄样式：浅色 + hover 提亮 + 不进文档流
    expect(editorCss).toMatch(/\.ProseMirror \.task-style-handle \{[\s\S]*?opacity:\s*0\.38/);
    expect(editorCss).toMatch(/\.ProseMirror li\.task-item:hover \.task-style-handle \{\s*opacity:\s*0\.95/);
  });

  it("格式栏任务按钮改为下拉（方形 / 圆形）", () => {
    expect(containerSrc).toContain('className="task-style-dropdown-wrap"');
    expect(containerSrc).toContain('data-testid="task-style-dropdown"');
    expect(containerSrc).toContain('handleTaskStyleSelect("circle")');
    const fmt = readSrc("src/components/editor/sourceFormat.ts");
    expect(fmt).toContain('case "task-circle"');
    expect(fmt).toContain("`* [ ] ${selected}`");
  });

  it("格式刷套用任务样式（源码前缀 + PM 节点属性两条路径）", () => {
    expect(painterSrc).toContain("taskStyle?: TaskStyle | null");
    expect(painterSrc).toContain("taskStyle = taskStyleFromBullet(taskMatch[1])");
    expect(painterSrc).toContain("TASK_STYLE_BULLET[taskStyle]");
    expect(painterSrc).toContain("if (snapshot.taskStyle)");
    expect(containerSrc).toContain("snapshot.blockType, snapshot.taskStyle");
  });
});

// ─── 需求6：代码块末尾退出 ──────────────────────────────────

describe("v0.12.1 需求6：代码块末尾按 → 退出", () => {
  it("keymap 绑定 ArrowRight → exitCodeBlockForward", () => {
    expect(keymapSrc).toContain("ArrowRight: exitCodeBlockForward");
  });

  it("命令实现：块内容末尾 → 下一个块；末块 → 新建空段落（单事务）", () => {
    const src = readSrc("src/core/plugins/code-block-exit.ts");
    expect(src).toContain('new Set(["code_block", "math_block"])');
    expect(src).toContain("$from.parentOffset !== parent.content.size");
    expect(src).toContain("TextSelection.near($after, 1)");
    expect(src).toContain("tr.insert(blockEnd, state.schema.nodes.paragraph.create())");
    // 整块选中（NodeSelection）也接管——阅读模式单击代码块的默认状态
    expect(src).toContain("if (selection instanceof NodeSelection)");
    expect(src).toContain("return exitAfterBlock(state, dispatch, selection.from);");
  });
});

// ─── 需求7：格式刷图标 ──────────────────────────────────────

describe("v0.12.1 需求7：格式刷图标重绘为小油漆刷", () => {
  it("旧图形（Lucide 抽象笔刷）已替换为「刷柄 + 刷箍 + 收口刷头」", () => {
    expect(containerSrc).not.toContain("m14.622 17.897-10.68-2.913");
    expect(containerSrc).toContain("20.4 3.6a2.1 2.1 0 0 0-3 0"); // 刷柄
    expect(containerSrc).toContain("M12.1 8.9 15.1 11.9"); // 刷箍
    expect(containerSrc).toContain("10.9 10.1c-.6-.6-1.5-.6-2.1 0"); // 刷头
    expect(containerSrc).toContain('width="15"');
  });
});

// ─── 需求8：设置窗口开关动画 ────────────────────────────────

describe("v0.12.1 需求8：设置窗口开关动画", () => {
  const kfIn = settingsCss.match(/@keyframes settings-dialog-in \{[\s\S]*?\n\}/)![0];
  const kfOut = settingsCss.match(/@keyframes settings-dialog-out \{[\s\S]*?\n\}/)![0];

  it("打开：从视口上方之外滑进来（calc(-50vh - 50%)）并落位果冻回弹", () => {
    expect(kfIn).toContain("translateY(calc(-50vh - 50%))");
    expect(kfIn).toContain("translateY(14px)");
    expect(kfIn).toContain("translateY(-7px)");
    expect(kfIn).toContain("translateY(3px)");
    expect(kfIn).toContain("translateY(-1px)");
    // 每段各自指定缓动，回弹才不会被默认缓动抹平
    expect((kfIn.match(/animation-timing-function/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("二轮修订：纯位移，弹窗本体不再有透明度动画（明暗只由遮罩负责）", () => {
    // 用户明确"应该是平滑移动进来和平滑移动出去，而不是移动中淡化消失"
    expect(kfIn).not.toMatch(/opacity/);
    expect(kfOut).not.toMatch(/opacity/);
    expect(settingsCss).toMatch(/\.settings-dialog \{[\s\S]*?will-change:\s*transform;/);
    expect(settingsCss).not.toMatch(/will-change:\s*opacity,\s*transform/);
    // 遮罩仍负责明暗过渡，且退场**延迟到弹窗滑走之后**才淡出
    expect(settingsCss).toMatch(/animation: settings-scrim-out 320ms ease-in 200ms both/);
  });

  it("关闭：先下压蓄力（+14px），再纯位移滑出视口上方", () => {
    expect(kfOut).toContain("translateY(14px)");
    expect(kfOut).toContain("translateY(calc(-50vh - 50%))");
  });

  it("时长稍放慢且与 JS 常量对齐（640ms 入场 / 520ms 退场 / 常量 540ms）", () => {
    expect(settingsCss).toMatch(/animation: settings-dialog-in 640ms both/);
    expect(settingsCss).toMatch(/animation: settings-dialog-out 520ms both/);
    expect(settingsSrc).toContain("const SETTINGS_CLOSE_MS = 540");
  });

  it("尊重 prefers-reduced-motion（时长压到 1ms 且不做位移）", () => {
    const reduce = settingsCss.slice(settingsCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toContain("animation-duration: 1ms");
    expect(reduce).toContain("transform: none");
  });
});

// ─── 需求9：实时预览 + 玻璃透明 + 取消回滚 ──────────────────

describe("v0.12.1 需求9：排版实时预览", () => {
  it("新增非持久化预览 store（拖动不写 localStorage、不发跨窗口广播）", () => {
    const storeSrc = readSrc("src/stores/useTypographyPreviewStore.ts");
    expect(storeSrc).toContain("create<TypographyPreviewState>");
    expect(storeSrc).not.toContain("persist(");
    expect(storeSrc).toContain("export function withPreview");
  });

  it("EditorContainer 用预览值覆盖 CSS 变量（字号/字体/行高/段间距/内容宽）", () => {
    expect(containerSrc).toContain("withPreview(fontSize, typographyPreview?.fontSize)");
    expect(containerSrc).toContain("withPreview(lineHeight, typographyPreview?.lineHeight)");
    expect(containerSrc).toContain("withPreview(paragraphSpacing, typographyPreview?.paragraphSpacing)");
    expect(containerSrc).toContain("withPreview(contentMaxWidth, typographyPreview?.contentMaxWidth)");
  });

  it("分屏预览：纯排版变化只刷新 iframe 样式表，不重排正文", () => {
    expect(containerSrc).toContain("typoChanged && !htmlChanged");
    expect(containerSrc).toContain('styleEl.textContent = sharedStyles + getPrismCss(isDarkTheme(theme))');
  });

  it("拖动时 overlay 加 .previewing：面板变毛玻璃，且透明度 >80%（滑条本身不淡化）", () => {
    expect(settingsSrc).toContain('previewing ? " previewing" : ""');
    const block = settingsCss.slice(
      settingsCss.indexOf(".settings-overlay.previewing .settings-dialog {"),
    );
    const rule = block.slice(0, block.indexOf("}"));
    // 二轮修订：底板不透明度 34% → 15%（= 85% 透明，满足"透明度 80% 以上"）
    expect(rule).toContain("color-mix(in srgb, var(--bg-primary) 15%, transparent)");
    expect(rule).toContain("backdrop-filter: blur(12px)");
    // 明确不用 opacity（否则滑条也会跟着变淡，与需求"滑条颜色不变"冲突）
    expect(rule).not.toMatch(/^\s*opacity:/m);
  });

  it("透明度量化断言：底板 alpha ≤ 0.2（即透明度 ≥ 80%）", () => {
    const m = settingsCss.match(
      /\.settings-overlay\.previewing \.settings-dialog \{[\s\S]*?color-mix\(in srgb, var\(--bg-primary\) (\d+)%, transparent\)/,
    );
    expect(m).toBeTruthy();
    const alpha = Number(m![1]) / 100;
    expect(alpha).toBeLessThanOrEqual(0.2);
    // 遮罩压暗也同步降下来（否则背后的文档看不清）
    expect(settingsCss).toMatch(/\.settings-overlay\.previewing::before \{\s*background: rgba\(0, 0, 0, 0\.0[0-9]/);
  });

  it("二轮修订（焦点保持）：排版变量写入前后做视口锚点补偿，且走 layout effect", () => {
    // 捕获 → 写变量 → 立刻补偿：三段必须在同一个 effect 内
    expect(containerSrc).toContain("const captureTypographyAnchor = useCallback(");
    expect(containerSrc).toContain("const restoreTypographyAnchor = useCallback(");
    const fontEffect = containerSrc.slice(
      containerSrc.indexOf('root.style.setProperty("--editor-font-size"'),
    );
    expect(fontEffect.slice(0, 900)).toContain("restoreTypographyAnchor(anchor)");
    const typoEffect = containerSrc.slice(
      containerSrc.indexOf('setOrClear("--editor-line-height"'),
    );
    expect(typoEffect.slice(0, 600)).toContain("restoreTypographyAnchor(anchor)");
    // 不能用 useEffect —— 那会在绘制之后补偿，用户会看到一帧跳动
    expect(containerSrc).toMatch(/useLayoutEffect\(\(\) => \{\s*const anchor = captureTypographyAnchor\(\);/);
    expect(containerSrc).toContain("captureAnchor(container, \".ProseMirror > *\")");
    expect(containerSrc).toContain("captureTextAnchor(ta)");
    expect(containerSrc).toContain("restoreAnchor(anchor.container, anchor.blockAnchor)");
    expect(containerSrc).toContain("restoreTextAnchor(anchor.ta, anchor.textAnchor)");
  });

  it("二轮修订（焦点保持）：分屏预览换样式表前后同样补偿 iframe 滚动", () => {
    const idx = containerSrc.indexOf("typoChanged && !htmlChanged");
    const block = containerSrc.slice(idx, idx + 900);
    expect(block).toContain('captureAnchor(scroller, "body > *")');
    expect(block).toContain("restoreAnchor(scroller, anchor)");
    // 捕获必须在写样式表之前、补偿在之后
    expect(block.indexOf("captureAnchor(scroller")).toBeLessThan(block.indexOf("styleEl.textContent"));
    expect(block.indexOf("restoreAnchor(scroller")).toBeGreaterThan(block.indexOf("styleEl.textContent"));
  });

  it("取消/✕/遮罩/Esc 走 requestCancel：清预览并回滚本地受控值", () => {
    expect(settingsSrc).toContain("const requestCancel = useCallback(");
    expect(settingsSrc).toMatch(/const requestCancel[\s\S]{0,600}?useTypographyPreviewStore\.getState\(\)\.clear\(\)/);
    expect(settingsSrc).toMatch(/const requestCancel[\s\S]{0,900}?setFontSize\(settings\.fontSize\)/);
    // 三个关闭入口都接 requestCancel
    expect(settingsSrc).toContain('className={`settings-overlay${closing ? " closing" : ""}${previewing ? " previewing" : ""}`}');
    expect(settingsSrc).toContain('onClick={requestCancel}');
    expect(settingsSrc).toContain('className="settings-close" onClick={requestCancel}');
  });

  it("保存走 handleSave：写入持久化设置并清预览", () => {
    expect(settingsSrc).toMatch(/const handleSave = \(\) => \{[\s\S]{0,700}?useTypographyPreviewStore\.getState\(\)\.clear\(\)/);
  });
});

// ─── 需求11：编辑模式的书本悬浮按钮 ─────────────────────────

describe("v0.12.1 需求11：编辑模式也有跳阅读模式的悬浮按钮", () => {
  it("ModeSwitchButton 支持 edit 模式（走书本图标 + 跳 preview）", () => {
    expect(modeBtnSrc).toContain('const toPreview = viewMode === "split" || viewMode === "edit";');
    expect(modeBtnSrc).toContain('onSwitch(toPreview ? "preview" : "split")');
  });

  it("EditorContainer 在三种模式下都渲染该按钮（不限 preview/split）", () => {
    expect(containerSrc).toMatch(/\{isMdFile && \(\s*<ModeSwitchButton/);
    expect(containerSrc).not.toContain('(viewMode === "preview" || viewMode === "split") && isMdFile && (');
  });

  it("i18n 文案齐备（zh/en）", () => {
    for (const key of ["task.style.handle", "task.style.square", "task.style.circle", "task.style.squareTitle", "task.style.circleTitle"]) {
      expect(readSrc("src/i18n/locales/zh-CN.ts")).toContain(`"${key}"`);
      expect(readSrc("src/i18n/locales/en-US.ts")).toContain(`"${key}"`);
    }
  });
});

// ─── 需求2/5/6/10 的运行时行为（真编辑器） ─────────────────

describe("v0.12.1 运行时：任务样式往返与键位行为", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("markdown → doc → markdown：`* [ ]` 解析为 circle 并原样写回，`- [ ]` 保持方形", async () => {
    const { markdownToDoc } = await import("../core/markdown/parser");
    const { docToMarkdown } = await import("../core/markdown/serializer");
    const md = "- [ ] 方形项\n* [ ] 圆形项\n- [x] 已完成\n";
    const doc = markdownToDoc(md);
    const styles: Array<{ text: string; style: string; checked: boolean }> = [];
    doc.descendants((n) => {
      if (n.type.name === "task_item") {
        styles.push({ text: n.textContent, style: n.attrs.style, checked: n.attrs.checked });
      }
    });
    expect(styles).toEqual([
      { text: "方形项", style: "square", checked: false },
      { text: "圆形项", style: "circle", checked: false },
      { text: "已完成", style: "square", checked: true },
    ]);
    expect(docToMarkdown(doc)).toBe(md);
  });

  it("改 style 属性后序列化符号随之变化（阅读模式手柄的落地链路）", async () => {
    const { markdownToDoc } = await import("../core/markdown/parser");
    const { docToMarkdown } = await import("../core/markdown/serializer");
    const { lightMDSchema } = await import("../core/schema");
    const { EditorState } = await import("prosemirror-state");
    const doc = markdownToDoc("- [ ] 条目\n");
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === "task_item") pos = p;
    });
    expect(pos).toBeGreaterThan(-1);
    const item = doc.nodeAt(pos)!;
    // NodeType 的 TS 类型未声明 attrs（运行时存在），测试内做一次窄化
    const taskItemAttrs = (
      lightMDSchema.nodes.task_item as unknown as {
        attrs: Record<string, { default: unknown }>;
      }
    ).attrs;
    expect(taskItemAttrs.style.default).toBe("square");
    // 与 NodeView 手柄完全同一条链路：setNodeMarkup 改 style 属性
    let state = EditorState.create({ doc, schema: lightMDSchema });
    state = state.apply(
      state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, style: "circle" }),
    );
    expect(state.doc.nodeAt(pos)!.attrs.style).toBe("circle");
    expect(docToMarkdown(state.doc)).toBe("* [ ] 条目\n");
  });

  it("格式刷：源码侧把普通行刷成圆形任务项（`* [ ] `）", async () => {
    const { applyBlockTypeToLine } = await import("../utils/formatPainter");
    expect(applyBlockTypeToLine("abc", 0, 3, "bullet_list", "circle")!.text).toBe("* [ ] abc");
    expect(applyBlockTypeToLine("abc", 0, 3, "bullet_list", "square")!.text).toBe("- [ ] abc");
    // 旧的任务项前缀也能被剥离（方形 → 圆形）
    expect(applyBlockTypeToLine("- [ ] abc", 0, 9, "bullet_list", "circle")!.text).toBe("* [ ] abc");
    // 非任务项采集（taskStyle 为空）仍是普通无序列表
    expect(applyBlockTypeToLine("abc", 0, 3, "bullet_list")!.text).toBe("- abc");
  });

  it("格式刷采集：源码任务项 → taskStyle", async () => {
    const { collectSourceSnapshot } = await import("../utils/formatPainter");
    expect(collectSourceSnapshot("* [ ] 甲", 0, 8).taskStyle).toBe("circle");
    expect(collectSourceSnapshot("- [x] 甲", 0, 8).taskStyle).toBe("square");
    expect(collectSourceSnapshot("- 普通列表", 0, 8).taskStyle).toBeNull();
  });

  it("需求6 命令：光标在代码块末尾按 → 落到下一个块 / 末块新建段落", async () => {
    const { exitCodeBlockForward } = await import("../core/plugins/code-block-exit");
    const { lightMDSchema: schema } = await import("../core/schema");
    const { EditorState, TextSelection } = await import("prosemirror-state");

    // 场景 A：代码块后面还有段落
    const docA = schema.node("doc", null, [
      schema.node("code_block", { language: "js" }, [schema.text("const a = 1;")]),
      schema.node("paragraph", null, [schema.text("后面")]),
    ]);
    const endOfCode = 1 + "const a = 1;".length;
    let stateA = EditorState.create({ doc: docA, schema });
    stateA = stateA.apply(stateA.tr.setSelection(TextSelection.create(docA, endOfCode)));
    const dispatched: unknown[] = [];
    expect(exitCodeBlockForward(stateA, (tr) => dispatched.push(tr))).toBe(true);
    const afterA = stateA.apply(dispatched[0] as never);
    expect(afterA.doc.child(0).type.name).toBe("code_block");
    expect(afterA.selection.$from.parent.type.name).toBe("paragraph");
    expect(afterA.doc.childCount).toBe(2); // 结构未变

    // 场景 B：代码块是最后一个块 → 新建空段落
    const docB = schema.node("doc", null, [
      schema.node("code_block", { language: "js" }, [schema.text("x")]),
    ]);
    let stateB = EditorState.create({ doc: docB, schema });
    stateB = stateB.apply(stateB.tr.setSelection(TextSelection.create(docB, 2)));
    const dispatchedB: unknown[] = [];
    expect(exitCodeBlockForward(stateB, (tr) => dispatchedB.push(tr))).toBe(true);
    const afterB = stateB.apply(dispatchedB[0] as never);
    expect(afterB.doc.childCount).toBe(2);
    expect(afterB.doc.child(1).type.name).toBe("paragraph");
    expect(afterB.selection.$from.parent.type.name).toBe("paragraph");

    // 场景 D：不在块末尾 / 不在代码块内 → 不接管
    let stateC = EditorState.create({ doc: docB, schema });
    stateC = stateC.apply(stateC.tr.setSelection(TextSelection.create(docB, 1)));
    expect(exitCodeBlockForward(stateC, () => {})).toBe(false);
    const docD = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("正文")])]);
    let stateD = EditorState.create({ doc: docD, schema });
    stateD = stateD.apply(stateD.tr.setSelection(TextSelection.create(docD, 3)));
    expect(exitCodeBlockForward(stateD, () => {})).toBe(false);

    // 场景 E：**整块选中**（阅读模式单击代码块 → NodeSelection）时按 → 也要退出。
    // 这是用户"点一下代码块、按 → 想继续在下面打字"的主路径：真机上按默认行为只会把
    // DOM 光标留在块内（甚至落进高亮覆盖层），走不出去。
    const { NodeSelection } = await import("prosemirror-state");
    const docE = schema.node("doc", null, [
      schema.node("code_block", { language: "js" }, [schema.text("x")]),
      schema.node("paragraph", null, [schema.text("后面")]),
    ]);
    let stateE = EditorState.create({ doc: docE, schema });
    stateE = stateE.apply(stateE.tr.setSelection(NodeSelection.create(docE, 0)));
    const dispatchedE: unknown[] = [];
    expect(exitCodeBlockForward(stateE, (tr) => dispatchedE.push(tr))).toBe(true);
    const afterE = stateE.apply(dispatchedE[0] as never);
    expect(afterE.selection.$from.parent.type.name).toBe("paragraph");
    expect(afterE.doc.childCount).toBe(2);

    // 场景 F：整块选中的代码块是最后一个块 → 同样新建空段落
    let stateF = EditorState.create({ doc: docB, schema });
    stateF = stateF.apply(stateF.tr.setSelection(NodeSelection.create(docB, 0)));
    const dispatchedF: unknown[] = [];
    expect(exitCodeBlockForward(stateF, (tr) => dispatchedF.push(tr))).toBe(true);
    const afterF = stateF.apply(dispatchedF[0] as never);
    expect(afterF.doc.childCount).toBe(2);
    expect(afterF.doc.child(1).type.name).toBe("paragraph");

    // 场景 G：整块选中的是普通段落 → 不接管（交回默认的方向键行为）
    const docG = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("正文")])]);
    let stateG = EditorState.create({ doc: docG, schema });
    stateG = stateG.apply(stateG.tr.setSelection(NodeSelection.create(docG, 0)));
    expect(exitCodeBlockForward(stateG, () => {})).toBe(false);
  });
});
