/**
 * G8 命令面板测试
 *
 * 覆盖命令注册中心（src/core/commands.ts）的纯函数逻辑：
 * - 命令注册数量正确
 * - searchCommands 模糊匹配（"保存"匹配"保存文件"，"save"匹配"Save File"）
 * - 空查询返回全部命令
 * - 无匹配返回空数组
 * - 命令分组正确
 * - 快捷键属性
 * - 分组顺序和 key 映射
 *
 * 测试策略：纯函数测试，通过模拟翻译函数 t 验证中英文搜索匹配；
 * 命令 action 派发事件测试需要 jsdom 环境提供 window 对象。
 */
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  commands,
  searchCommands,
  GROUP_ORDER,
  GROUP_TITLE_KEYS,
  type CommandGroup,
} from "../core/commands";

/** 模拟中文翻译函数 */
const tZh = (key: string): string => {
  const dict: Record<string, string> = {
    "command.file.new": "新建文件",
    "command.file.open": "打开文件",
    "command.file.save": "保存文件",
    "command.file.saveAs": "另存为",
    "command.edit.undo": "撤销",
    "command.edit.redo": "恢复",
    "command.edit.find": "查找",
    "command.edit.replace": "替换",
    "command.edit.translate": "AI 翻译选中内容",
    "command.edit.translateDocument": "AI 全文翻译",
    "command.view.preview": "阅读模式",
    "command.view.edit": "编辑模式",
    "command.view.split": "分屏模式",
    "command.view.toggleTheme": "切换主题",
    "command.view.toggleFocusMode": "切换专注模式",
    "command.view.toggleTypewriter": "切换打字机模式",
    "command.view.toggleOutline": "切换大纲",
    "command.view.settings": "打开设置",
    "command.format.bold": "加粗",
    "command.format.italic": "斜体",
    "command.format.strikethrough": "删除线",
    "command.format.inlineCode": "行内代码",
    "command.format.highlight": "高亮",
    "command.format.heading1": "标题 1",
    "command.format.heading2": "标题 2",
    "command.format.heading3": "标题 3",
    "command.insert.table": "插入表格",
    "command.insert.link": "插入链接",
    "command.insert.image": "插入图片",
    "command.insert.codeblock": "插入代码块",
    "command.insert.mermaid": "插入 Mermaid 图表",
    "command.insert.taskList": "插入任务列表",
    "command.insert.footnote": "插入脚注",
    "command.export.html": "导出 HTML",
    "command.export.pdf": "导出 PDF",
  };
  return dict[key] ?? key;
};

/** 模拟英文翻译函数 */
const tEn = (key: string): string => {
  const dict: Record<string, string> = {
    "command.file.new": "New File",
    "command.file.open": "Open File",
    "command.file.save": "Save File",
    "command.file.saveAs": "Save As",
    "command.edit.undo": "Undo",
    "command.edit.redo": "Redo",
    "command.edit.find": "Find",
    "command.edit.replace": "Replace",
    "command.edit.translate": "AI Translate Selection",
    "command.edit.translateDocument": "AI Translate Document",
    "command.view.preview": "Read Mode",
    "command.view.edit": "Edit Mode",
    "command.view.split": "Split Mode",
    "command.view.toggleTheme": "Toggle Theme",
    "command.view.toggleFocusMode": "Toggle Focus Mode",
    "command.view.toggleTypewriter": "Toggle Typewriter",
    "command.view.toggleOutline": "Toggle Outline",
    "command.view.settings": "Open Settings",
    "command.format.bold": "Bold",
    "command.format.italic": "Italic",
    "command.format.strikethrough": "Strikethrough",
    "command.format.inlineCode": "Inline Code",
    "command.format.highlight": "Highlight",
    "command.format.heading1": "Heading 1",
    "command.format.heading2": "Heading 2",
    "command.format.heading3": "Heading 3",
    "command.insert.table": "Insert Table",
    "command.insert.link": "Insert Link",
    "command.insert.image": "Insert Image",
    "command.insert.codeblock": "Insert Code Block",
    "command.insert.mermaid": "Insert Mermaid Diagram",
    "command.insert.taskList": "Insert Task List",
    "command.insert.footnote": "Insert Footnote",
    "command.export.html": "Export HTML",
    "command.export.pdf": "Export PDF",
  };
  return dict[key] ?? key;
};

describe("G8: 命令注册中心", () => {
  it("命令注册数量 ≥ 20（覆盖五大分组）", () => {
    expect(commands.length).toBeGreaterThanOrEqual(20);
    // 实际注册 35 条命令（v0.6.0 新增 edit.translate；v0.6.1 新增 edit.translateDocument）
    expect(commands.length).toBe(35);
  });

  it("edit.translate 命令快捷键为 F6", () => {
    const cmd = commands.find((c) => c.id === "edit.translate");
    expect(cmd?.shortcut).toBe("F6");
  });

  it("edit.translateDocument 命令快捷键为 Shift+F6（v0.6.1 全文翻译）", () => {
    const cmd = commands.find((c) => c.id === "edit.translateDocument");
    expect(cmd?.shortcut).toBe("Shift+F6");
    expect(cmd?.group).toBe("edit");
  });

  it("每条命令都有必填字段（id/titleKey/group/action）", () => {
    for (const cmd of commands) {
      expect(typeof cmd.id).toBe("string");
      expect(cmd.id.length).toBeGreaterThan(0);
      expect(typeof cmd.titleKey).toBe("string");
      expect(cmd.titleKey.startsWith("command.")).toBe(true);
      expect(typeof cmd.group).toBe("string");
      expect(typeof cmd.action).toBe("function");
    }
  });

  it("命令 id 唯一", () => {
    const ids = commands.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("命令分组覆盖 file/edit/view/format/insert/export", () => {
    const groups = new Set(commands.map((c) => c.group));
    expect(groups.has("file")).toBe(true);
    expect(groups.has("edit")).toBe(true);
    expect(groups.has("view")).toBe(true);
    expect(groups.has("format")).toBe(true);
    expect(groups.has("insert")).toBe(true);
    expect(groups.has("export")).toBe(true);
    expect(groups.size).toBe(6);
  });

  it("GROUP_ORDER 包含全部 6 个分组且顺序正确", () => {
    expect(GROUP_ORDER).toEqual([
      "file",
      "edit",
      "view",
      "format",
      "insert",
      "export",
    ]);
  });

  it("GROUP_TITLE_KEYS 为每个分组提供 i18n key", () => {
    const groups: CommandGroup[] = ["file", "edit", "view", "format", "insert", "export"];
    for (const g of groups) {
      expect(GROUP_TITLE_KEYS[g]).toBeDefined();
      expect(GROUP_TITLE_KEYS[g]).toBe(`command.group.${g}`);
    }
  });

  it("部分命令包含快捷键属性", () => {
    const withShortcut = commands.filter((c) => c.shortcut);
    // 至少 10 条命令带快捷键
    expect(withShortcut.length).toBeGreaterThanOrEqual(10);
    // 验证已知快捷键
    const fileNew = commands.find((c) => c.id === "file.new");
    expect(fileNew?.shortcut).toBe("Ctrl+N");
    const fileSave = commands.find((c) => c.id === "file.save");
    expect(fileSave?.shortcut).toBe("Ctrl+S");
    const viewFocus = commands.find((c) => c.id === "view.toggleFocusMode");
    expect(viewFocus?.shortcut).toBe("F8");
  });
});

describe("G8: searchCommands 搜索算法", () => {
  it("空查询返回全部命令", () => {
    const result = searchCommands("");
    expect(result.length).toBe(commands.length);
    // 返回的是副本，不应是同一引用
    expect(result).not.toBe(commands);
    // 但内容一致
    expect(result.map((c) => c.id).sort()).toEqual(
      commands.map((c) => c.id).sort()
    );
  });

  it("仅空白字符的查询返回全部命令", () => {
    expect(searchCommands("   ").length).toBe(commands.length);
    expect(searchCommands("\t").length).toBe(commands.length);
  });

  it('"保存" 匹配 "保存文件"（中文标题匹配）', () => {
    const result = searchCommands("保存", tZh);
    // 应匹配到 file.save（保存文件）
    const ids = result.map((c) => c.id);
    expect(ids).toContain("file.save");
    // 另存为也包含"存"字但 keywords 含"另存为"，不应匹配"保存"
    // 但 file.saveAs 的 keywords 含 "save as"，不匹配"保存"
    // 验证 file.save 排在结果中
    expect(result.length).toBeGreaterThan(0);
  });

  it('"save" 匹配 "Save File"（英文标题匹配）', () => {
    const result = searchCommands("save", tEn);
    const ids = result.map((c) => c.id);
    // 应匹配 file.save（Save File）和 file.saveAs（Save As）
    expect(ids).toContain("file.save");
    expect(ids).toContain("file.saveAs");
  });

  it('"Save" 大写也能匹配（大小写不敏感）', () => {
    const result = searchCommands("Save", tEn);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("file.save");
  });

  it("keywords 匹配：'mermaid' 匹配 insert.mermaid", () => {
    const result = searchCommands("mermaid", tEn);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("insert.mermaid");
  });

  it("id 匹配：'format.bold' 匹配 format.bold", () => {
    const result = searchCommands("format.bold", tEn);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("format.bold");
  });

  it("无匹配返回空数组", () => {
    expect(searchCommands("xyz_not_exist", tEn)).toEqual([]);
    expect(searchCommands("不存在的命令xyz", tZh)).toEqual([]);
  });

  it("开头匹配排序优先于包含匹配", () => {
    // "insert" 开头匹配的命令应排在前面
    const result = searchCommands("insert", tEn);
    expect(result.length).toBeGreaterThan(0);
    // 所有 insert.* 命令的 id 都以 "insert." 开头
    const insertCmds = result.filter((c) => c.id.startsWith("insert."));
    expect(insertCmds.length).toBeGreaterThan(0);
    // 验证第一条结果以 insert 开头（开头匹配 score=3）
    expect(result[0].id.startsWith("insert")).toBe(true);
  });

  it("无 t 参数时仅匹配 keywords 和 id", () => {
    // 不提供 t，应通过 keywords 匹配
    const result = searchCommands("保存");
    // file.save 的 keywords 包含 "保存"
    const ids = result.map((c) => c.id);
    expect(ids).toContain("file.save");
  });

  it("无 t 参数时英文 keywords 匹配", () => {
    const result = searchCommands("bold");
    const ids = result.map((c) => c.id);
    // format.bold 的 keywords 包含 "bold"
    expect(ids).toContain("format.bold");
  });

  it("中文 keywords 匹配：'表格' 匹配 insert.table", () => {
    const result = searchCommands("表格", tZh);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("insert.table");
  });

  it("结果按分数降序排序（开头匹配在前）", () => {
    // "view" 开头匹配的命令排在前面
    const result = searchCommands("view", tEn);
    // 第一条应该是 view.* 命令（开头匹配 score=3）
    expect(result[0].id.startsWith("view")).toBe(true);
  });
});

describe("G8: 命令 action 派发事件", () => {
  it("命令 action 调用 window.dispatchEvent 派发 lightmd:command 事件", () => {
    // 收集派发的事件
    const dispatched: Array<{ id: string }> = [];
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id) dispatched.push({ id: detail.id });
    };
    window.addEventListener("lightmd:command", handler);

    // 找到 file.new 命令并执行
    const fileNew = commands.find((c) => c.id === "file.new");
    expect(fileNew).toBeDefined();
    fileNew!.action();

    window.removeEventListener("lightmd:command", handler);
    expect(dispatched).toEqual([{ id: "file.new" }]);
  });
});
