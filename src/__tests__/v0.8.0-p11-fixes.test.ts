/**
 * v0.8.0 第二轮修复（P11-1 ~ P11-9）测试
 *
 * P11-1 Shift 拖拽 = 移动（提示语义 + 移动后路径联动）
 * P11-2 临时文件按 Markdown 处理（新建后立即跳转且可编辑）
 * P11-4 侧栏最下方区域可一直拖到底部
 * P11-6 模式切换丢换行（列表项内多段落粘连 / 嵌套列表与代码块丢失 / Enter 键位顺序）
 * P11-7 切换文件保留未保存内容
 * P11-8 侧栏提示显示在侧栏旁边
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import {
  computeSplitExtendable,
  computeMaxSelfHeight,
  MIN_SECTION_HEIGHT,
} from "../hooks/useSectionSplit";
import { useFileStore } from "../stores/useFileStore";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");

describe("P11-6 列表结构往返（parser 不再粘连/丢失内容）", () => {
  it("列表项内多段落解析为两个段落，不再粘成一段", () => {
    const doc = markdownToDoc("- 第一行\n\n  第二行\n");
    const item = doc.firstChild!.firstChild!;
    expect(item.childCount).toBe(2);
    expect(item.child(0).textContent).toBe("第一行");
    expect(item.child(1).textContent).toBe("第二行");
  });

  it("列表项内多段落 doc→md→doc 往返保真（serializer 用空行 + 缩进续行）", () => {
    const doc = markdownToDoc("- 第一行\n\n  第二行\n");
    const md = docToMarkdown(doc);
    expect(md).toContain("- 第一行\n\n");
    expect(markdownToDoc(md).eq(doc)).toBe(true);
  });

  it("嵌套列表不再丢失（旧实现只保留首行文字）", () => {
    const doc = markdownToDoc("- 第一行\n  - 嵌套项\n  - 嵌套项2\n");
    const item = doc.firstChild!.firstChild!;
    expect(item.childCount).toBe(2);
    expect(item.child(1).type.name).toBe("bullet_list");
    expect(item.child(1).childCount).toBe(2);
    expect(item.child(1).child(0).textContent).toBe("嵌套项");
  });

  it("列表项内缩进代码块不再丢失（新增 code_block token 解析）", () => {
    const doc = markdownToDoc("- 第一行\n\n      code\n");
    const item = doc.firstChild!.firstChild!;
    expect(item.child(1).type.name).toBe("code_block");
    expect(item.child(1).textContent).toBe("code");
  });

  it("顶层缩进代码块不再丢失", () => {
    const doc = markdownToDoc("    code line\n");
    expect(doc.firstChild!.type.name).toBe("code_block");
    expect(doc.firstChild!.textContent).toBe("code line");
  });
});

describe("P11-6 Enter / Shift+Enter 键位", () => {
  it("自定义 keymap 注册顺序先于 baseKeymap（否则列表内 Enter 变成段内段落）", () => {
    const src = read("../core/editor.ts");
    const iCustom = src.indexOf("buildKeymap()");
    const iBase = src.indexOf("keymap(baseKeymap)");
    expect(iCustom).toBeGreaterThan(-1);
    expect(iBase).toBeGreaterThan(-1);
    expect(iCustom).toBeLessThan(iBase);
  });

  it("Enter 同时支持任务项与列表项分割", () => {
    const src = read("../core/keymap.ts");
    expect(src).toContain("splitListItem(schema.nodes.task_item)");
    expect(src).toContain("splitListItem(schema.nodes.list_item)");
    expect(src).toContain("chainCommands");
  });

  it("Shift+Enter 插入段内硬换行", () => {
    expect(read("../core/keymap.ts")).toContain('"Shift-Enter": insertHardBreak');
  });
});

describe("P11-4 侧栏末区可拖到底部", () => {
  it("向下拖（delta>=0）保持守恒分配", () => {
    expect(computeSplitExtendable(200, 200, 50, 80, 600)).toEqual({ top: 250, bottom: 150 });
  });

  it("向上拖可吞掉剩余空间，直到 maxBottom", () => {
    // 上区 200、下区 200，向上拖 150 → 下区 350、上区 50 但钳到 80
    expect(computeSplitExtendable(200, 200, -150, 80, 600)).toEqual({ top: 80, bottom: 350 });
    // 继续向上拖：上区已触底，下区继续增大直到上限 600
    expect(computeSplitExtendable(200, 200, -600, 80, 600)).toEqual({ top: 80, bottom: 600 });
  });

  it("上限低于当前高度时不会反向压缩本区（P12-4/5 修复）", () => {
    // 旧实现直接用 maxBottom(40) 钳制 → 向上拖反而把本区压到 40/80；现应保持不动
    expect(computeSplitExtendable(200, 200, -500, 80, 40).bottom).toBe(200);
    expect(computeSplitExtendable(200, 200, -500, 80, 40).top).toBe(200);
  });

  it("computeMaxSelfHeight = 容器高 - 其他区域 - 分隔条", () => {
    expect(computeMaxSelfHeight(800, [200, 200], 4, 2, MIN_SECTION_HEIGHT)).toBe(392);
    // 其他区域过高时不低于 minHeight
    expect(computeMaxSelfHeight(300, [400, 400], 4, 2, MIN_SECTION_HEIGHT)).toBe(MIN_SECTION_HEIGHT);
  });

  it("FileTree 只为最后一个可见区域给出 maxHeight（P12-4/5 后改用 maxBottomFor）", () => {
    const src = read("../components/sidebar/FileTree.tsx");
    expect(src).toContain("ordered[ordered.length - 1] !== bottomKey");
    // v0.8.2 功能3 起 FolderSection 渲染收拢进 renderFolderSection（closing 快照传 undefined）
    expect(src).toContain("maxHeight={opts?.closing ? undefined : maxBottomFor(prevOf(fkey), fkey)}");
    expect(src).toContain('maxHeight={maxBottomFor(prevOf("recent"), "recent")}');
  });
});

describe("P11-1 移动语义与路径联动", () => {
  it("移动使用 filetree.moved 提示（不再复用已粘贴到）", () => {
    const src = read("../components/sidebar/FileTree.tsx");
    expect(src).toContain('showMessage(t("filetree.moved"');
    expect(src).toContain('showMessage(t("filetree.pasted"');
  });

  it("中英文都提供 filetree.moved 文案", () => {
    expect(read("../i18n/locales/zh-CN.ts")).toContain('"filetree.moved": "已移动到');
    expect(read("../i18n/locales/en-US.ts")).toContain('"filetree.moved": "Moved to');
  });

  it("renameFileEntry 同步更新侧栏「打开的文件」条目", () => {
    useFileStore.setState({
      tempFiles: [{ name: "a.md", path: "D:/old/a.md", isDir: false, size: 0 }],
    });
    useFileStore.getState().renameFileEntry("D:/old/a.md", "D:/new/a.md", "a.md");
    expect(useFileStore.getState().tempFiles[0].path).toBe("D:/new/a.md");
  });

  it("移动后同步标签路径 / 全局 filePath（打开的文件变成新路径下的文件）", () => {
    const src = read("../components/sidebar/FileTree.tsx");
    // v0.8.4 适配：move 块内新增了 moveFile（跨盘降级）与 stale 双条目联动的
    // 说明注释，600 字符窗口不再覆盖到 renameFileEntry 调用，故扩大到 1200。
    // 断言强度不变：仍要求两个联动调用存在于 move 分支内。
    const moveBlock = src.slice(src.indexOf('if (mode === "move")'), src.indexOf('if (mode === "move")') + 1200);
    expect(moveBlock).toContain("syncOpenTabsAfterRename(srcPath, dst, unique)");
    expect(moveBlock).toContain("renameFileEntry(srcPath, dst, unique)");
  });
});

describe("P11-2 临时文件按 Markdown 处理", () => {
  it("未命名文档（filePath 为空）视为 markdown，可正常编辑", () => {
    const src = read("../components/editor/EditorContainer.tsx");
    expect(src).toContain("const isMdFile = filePath ? isMarkdownFile(filePath) : true;");
  });

  it("空状态（Logo 遮罩）只在没有任何已打开标签时显示", () => {
    const src = read("../components/editor/EditorContainer.tsx");
    expect(src).toContain("openTabCount === 0");
    expect(src).toContain("const openTabCount = useEditorStore((s) => s.openTabs.length);");
  });

  it("新建临时文件后自动聚焦编辑器（可直接输入）", () => {
    expect(read("../App.tsx")).toContain("editorViewRef.current?.focus()");
  });

  it("App 在临时标签下也把语言设为 markdown（含启动恢复路径）", () => {
    const src = read("../App.tsx");
    expect(src).toContain('!tab.path || isMarkdownFile(tab.path) ? "markdown"');
    // v0.8.3 WP4 需求5：启动恢复的激活目标由 firstTab 泛化为 targetTab
    // （可能是上次活跃的临时标签或任意真实文件），"临时文档按 markdown 处理"语义不变
    expect(src).toContain('!targetTab.path || isMarkdownFile(targetTab.path) ? "markdown"');
  });

  it("临时文档同样显示大纲栏", () => {
    expect(read("../App.tsx")).toContain("showOutline && (!filePath || isMarkdownFile(filePath))");
  });
});

describe("P11-7 切换文件保留未保存内容", () => {
  it("openFile handler 先写回当前标签，已打开文件沿用标签内容", () => {
    const src = read("../App.tsx");
    expect(src).toContain("st0.updateTabContent(st0.activeTabIdx, contentRef.current)");
    expect(src).toContain("const existingIdx = detail.path ? st0.getTabByPath(detail.path) : -1");
    expect(src).toContain("setContent(targetContent)");
    expect(src).toContain("updateTabContent(newIdx, targetContent)");
  });

  it("切回已打开文件时保留脏标记，且不清除浏览进度", () => {
    const src = read("../App.tsx");
    expect(src).toContain("const wasDirty = alreadyOpen ? !!st0.openTabs[existingIdx].isDirty : false");
    // v0.8.3 WP4 需求6：追加"会话恢复期"守卫（恢复期间跳过 clear，
    // 否则刚注入的跨会话阅读位置会被当场清掉）；「已打开文件不清进度」语义不变
    expect(src).toContain("if (detail.path && !alreadyOpen && !sessionRestoringRef.current)");
  });
});

describe("P11-8 侧栏提示位置", () => {
  it("提示层 fixed 定位在侧栏右侧（贴侧栏旁边，不在软件右下角）", () => {
    const css = read("../components/sidebar/FileTree.css");
    const block = css.slice(css.indexOf(".filetree-toast-stack"), css.indexOf(".filetree-toast {"));
    expect(block).toContain("position: fixed");
    expect(block).toContain("bottom:");
  });

  it("提示 left 由组件按侧栏实际右边缘注入", () => {
    const src = read("../components/sidebar/FileTree.tsx");
    expect(src).toContain("setToastLeft(rect.right + 12)");
  });
});