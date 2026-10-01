# LightMD v0.9.0 默认快捷键基线表（已确认版）

> 本文档是「自定义快捷键」功能的**默认键位数据源**。  
> 实施时原样录入 `src/core/shortcuts.ts` 默认表；如需再改键位，直接改本表并同步计划文档。  
> 扫描日期：2026-09-29（基于 `main` 分支 v0.9.0 源码逐项核对，非 README 转述）；2026-09-30 按用户决策更新。

## 图例

| 标记  | 含义                                                  |
| --- | --------------------------------------------------- |
| ✅   | 纳入自定义（v0.9.0 交付范围）                                  |
| 🔒  | 保留不自定义（行为键/系统键/上下文键，原因见备注）                          |
| 富文本 | 仅在 ProseMirror 编辑模式生效（`core/keymap.ts`）             |
| 源码  | 仅在源码模式 textarea 生效（`sourceFormat.ts parseShortcut`） |
| 全局  | App.tsx window 级监听，任何焦点下生效                          |
| 🆕  | 伴随新功能（该命令当前不存在，需先实现功能再绑定键位）                       |

---

## 一、文件（5 项）

| 命令 ID       | 功能         | 作用域 | 默认键位         | 纳入 | 备注               |
| ----------- | ---------- | --- | ------------ | -- | ---------------- |
| file.new    | 新建文件（临时标签） | 全局  | Ctrl+N       | ✅  |                  |
| file.open   | 打开文件到当前窗口  | 全局  | Ctrl+O       | ✅  |                  |
| file.save   | 保存         | 全局  | Ctrl+S       | ✅  |                  |
| file.saveAs | 另存为        | 全局  | Ctrl+Shift+S | ✅  |                  |
| export.html | 导出         | 全局  | Ctrl+Shift+E | ✅  | 命令面板中属 export 分组 |

## 二、编辑（8 项）

| 命令 ID                  | 功能         | 作用域    | 默认键位         | 纳入 | 备注                    |
| ---------------------- | ---------- | ------ | ------------ | -- | --------------------- |
| edit.undo              | 撤销         | 全局+编辑器 | Ctrl+Z       | ✅  | textarea/PM 内走自定义撤销栈  |
| edit.redo              | 恢复         | 全局+编辑器 | Ctrl+Y       | ✅  |                       |
| edit.redo2             | 恢复（等效第二绑定） | 全局+编辑器 | Ctrl+Shift+Z | ✅  | 与 edit.redo 同一动作，两条绑定 |
| edit.find              | 查找         | 全局     | Ctrl+F       | ✅  |                       |
| edit.replace           | 查找替换       | 全局     | Ctrl+H       | ✅  |                       |
| edit.translate         | AI 翻译选中内容  | 全局     | F6           | ✅  |                       |
| edit.translateDocument | AI 全文翻译    | 全局     | Shift+F6     | ✅  |                       |
| ai.chat                | AI 对话窗     | 全局     | Ctrl+K       | ✅  | macOS 为 Cmd+K（Mod 等价） |

## 三、格式（14 项）

| 命令 ID              | 功能       | 作用域    | 默认键位         | 纳入 | 备注                                  |
| ------------------ | -------- | ------ | ------------ | -- | ----------------------------------- |
| format.bold        | 加粗       | 富文本+源码 | Ctrl+B       | ✅  |                                     |
| format.italic      | 斜体       | 富文本+源码 | Ctrl+I       | ✅  |                                     |
| format.strikethrough | 删除线   | 富文本+源码 | Ctrl+Alt+S   | ✅  | D1 已拍板：两作用域统一（原富文本 Ctrl+Shift+S 废弃） |
| format.inlineCode  | 行内代码     | 富文本+源码 | Ctrl+`       | ✅  | 反引号键                                |
| format.math        | 块级公式     | 源码     | Ctrl+Shift+M | ✅  | 富文本模式无此快捷键（工具栏插入）                    |
| format.heading1    | 标题 1     | 富文本+源码 | Ctrl+1       | ✅  |                                     |
| format.heading2    | 标题 2     | 富文本+源码 | Ctrl+2       | ✅  | |
| format.heading3    | 标题 3     | 富文本+源码 | Ctrl+3       | ✅  |                                     |
| format.heading4    | 标题 4     | 富文本+源码 | Ctrl+4       | ✅  |                                     |
| format.heading5    | 标题 5     | 富文本+源码 | Ctrl+5       | ✅  |                                     |
| format.heading6    | 标题 6     | 富文本+源码 | Ctrl+6       | ✅  |                                     |
| format.paragraph   | 正文（移除标题） | 富文本+源码 | Ctrl+0       | ✅  |                                     |
| format.bulletList  | 无序列表     | 富文本    | Ctrl+Shift+8 | ✅  | 源码模式无                               |
| format.orderedList | 有序列表     | 富文本    | Ctrl+Shift+9 | ✅  | 源码模式无                               |
| format.blockquote  | 引用       | 富文本    | Ctrl+Shift+. | ✅  | 源码模式无                               |

## 四、视图（11 项）

| 命令 ID                 | 功能        | 作用域 | 默认键位         | 纳入 | 备注                                    |
| --------------------- | --------- | --- | ------------ | -- | ------------------------------------- |
| view.toggleTheme      | 循环切换主题    | 全局  | Ctrl+Shift+T | ✅  | 6 主题循环                               |
| view.toggleFocusMode  | 专注模式      | 全局  | F8           | ✅  |                                       |
| view.toggleTypewriter | 打字机模式     | 全局  | F9           | ✅  |                                       |
| view.toggleOutline    | 切换大纲栏     | 全局  | Ctrl+Shift+O | ✅  |                                       |
| view.commandPalette   | 命令面板      | 全局  | Ctrl+Shift+P | ✅  |                                       |
| view.snapshot         | 版本快照      | 全局  | Ctrl+Alt+V   | ✅  | v0.8.0 由 Ctrl+Shift+V 改来                 |
| view.settings         | 打开设置      | 全局  | Ctrl+,       | ✅  |                                       |
| view.togglePreview    | 阅读/编辑模式切换 | 全局  | 双击 Ctrl      | 🔒 | D2：不纳入自定义；**判定阈值 300ms→220ms**，防与编辑中复制粘贴冲突 |
| view.toggleSplit      | 分屏模式切换    | 全局  | 双击 Shift     | 🔒 | D2：同上，阈值同步调整                         |
| view.toggleLeft       | 左侧栏展开/收缩  | 全局  | Ctrl+Alt+←   | ✅  | 🆕 折叠功能已存在（AppShell），打通快捷键即可（原 Ctrl+← 与编辑器词跳转冲突，已调整） |
| view.toggleRight      | 大纲栏展开/收缩  | 全局  | Ctrl+Alt+→   | ✅  | 🆕 同上                                   |
| view.toggleTag        | 标签栏展开/收缩  | 全局  | Ctrl+Shift+B | ✅  | 🆕 标签栏折叠为全新功能                        |

## 五、标签（3 项）

| 命令 ID     | 功能     | 作用域 | 默认键位           | 纳入 | 备注                     |
| --------- | ------ | --- | -------------- | -- | ---------------------- |
| tab.next  | 下一个标签  | 全局  | Ctrl+Tab       | ✅  | Ctrl+Shift+Tab 为其变体，见下 |
| tab.prev  | 上一个标签  | 全局  | Ctrl+Shift+Tab | ✅  |                        |
| tab.close | 关闭当前标签 | 全局  | Ctrl+W         | ✅  |                        |

## 六、窗口（5 项）

| 命令 ID              | 功能       | 作用域 | 默认键位         | 纳入 | 备注                                          |
| ------------------ | -------- | --- | ------------ | -- | ------------------------------------------- |
| window.new         | 新建窗口     | 全局  | Ctrl+Shift+N | ✅  | v0.9.0 多窗口                                 |
| window.close       | 关闭当前窗口   | 全局  | Ctrl+Shift+W | ✅  |                                             |
| window.openInNew   | 打开文件到新窗口 | 全局  | Ctrl+Alt+O   | ✅  |                                             |
| window.quit        | 退出应用     | 全局  | Ctrl+Q       | ✅  |                                             |
| window.mergeToPrimary | 合并到主窗口 | 全局  | Ctrl+Shift+C | ✅  | 由补充区转正（命令面板已有该命令，此前无键位）                  |
| window.full        | 窗口全屏     | 全局  | F11          | 🔒 | 🆕 新增功能：类浏览器沉浸式全屏；不纳入自定义，进保留占用清单；Tauri webview 待实测 |

## 七、插入（2 项，由补充区转正）

| 命令 ID          | 功能   | 作用域    | 默认键位    | 纳入 | 备注                                                     |
| -------------- | ---- | ------ | ------- | -- | ------------------------------------------------------ |
| insert.table   | 插入表格 | 富文本+源码 | Ctrl+Alt+T | ✅  | R1 已确认；已核实与 Ctrl+Alt+S/O/V 无冲突 |
| insert.taskList | 插入任务列表 | 富文本+源码 | Ctrl+T | ✅  | 已确认无占用冲突                                             |
| format.underline | 下划线 | 富文本+源码 | Ctrl+U | ✅  | v0.9.3 E8 追加；已核实 Ctrl+U 无占用冲突（Markdown 无原生下划线语法，统一 <u> 表达） |
| insert.link | 插入链接 | 富文本+源码 | Ctrl+Shift+K | ✅  | v0.9.3 E8 追加；Ctrl+K 已被 ai.chat 占用，按任务卡取 Ctrl+Shift+K |

## 八、文件树（保留项，D4：不纳入自定义）

| 命令 ID           | 功能           | 作用域  | 默认键位   | 纳入 | 备注                                |
| --------------- | ------------ | ---- | ------ | -- | --------------------------------- |
| tree.refresh    | 刷新文件树        | 全局   | Ctrl+R | 🔒 | 通用约定，误改风险低收益低                     |
| tree.copyFile   | 复制文件（到内部剪贴板） | 侧栏悬停 | Ctrl+C | 🔒 | 与文本复制语义冲突，靠作用域门控共存                |
| tree.pasteFile  | 粘贴文件         | 侧栏悬停 | Ctrl+V | 🔒 | 同上                                |
| tree.closeTemp  | 关闭选中临时文件     | 侧栏选中 | Delete | 🔒 | 裸功能键                              |
| tree.closeTemp2 | 关闭选中临时文件（等效） | 侧栏选中 | Backspace | 🔒 | 原 Ctrl+2 释放（改键后不再与 format.heading2 跨场景共存） |

---

## 九、编辑器行为键（🔒 全部保留，不在自定义范围）

这些键是编辑行为本身而非「命令快捷键」，自定义会破坏输入预期，一律保留：

| 键位                       | 行为                     | 位置              |
| ------------------------ | ---------------------- | --------------- |
| Enter                    | 列表项/任务项分割              | core/keymap.ts  |
| Shift+Enter              | 段内硬换行                  | core/keymap.ts  |
| Tab / Shift+Tab          | 列表项缩进/反缩进              | core/keymap.ts  |
| Alt+↑ / Alt+↓            | 移动块（joinUp/lift）       | core/keymap.ts  |
| Tab / Esc                | 采纳/取消 AI 续写幽灵文本        | EditorContainer |
| Esc                      | 取消全文翻译 / 恢复原文 / 关闭各对话框 | 各组件             |
| Enter / Shift+Enter      | AI 对话窗发送 / 换行          | AiChatDialog    |
| Ctrl+C / Ctrl+X / Ctrl+V | 文本剪贴板（编辑器内，浏览器原生）      | 系统              |

---

## 十、补充区（仍无默认键位，用户可在设置里自行绑定）

| 命令 ID                 | 功能            | 建议默认键位 |
| --------------------- | ------------- | ------- |
| view.preview          | 切换到阅读模式       |         |
| view.edit             | 切换到编辑模式       |         |
| view.split            | 切换到分屏模式       |         |
| format.highlight      | 高亮            |         |
| insert.link           | 插入链接          |         |
| insert.image          | 插入图片          |         |
| insert.codeblock      | 插入代码块         |         |
| insert.mermaid        | 插入 Mermaid 图表 |         |
| insert.footnote       | 插入脚注          |         |
| export.pdf            | 导出 PDF        |         |
| ai.continue / ai.polish / ai.summary | AI 续写/润色/摘要 |         |

---

## 已确认决策记录（2026-09-30）

| #  | 事项 | 结论 |
| -- | --- | --- |
| D1 | 删除线键位不一致 | ✅ 已拍板：富文本/源码统一为 **Ctrl+Alt+S**（keymap.ts 的 `Shift-Mod-s` 改为 `Mod-Alt-s`） |
| D2 | 双击 Ctrl/双击 Shift 纳入自定义？ | ❌ 不纳入；**阈值 300ms→220ms**，防与编辑中复制粘贴冲突 |
| D3 | 录入方式 | 物理键盘捕获：激活条目后直接按组合键即录入（**无虚拟键盘**）；录制中 Esc 取消、Backspace 清除 |
| D4 | 文件树键位纳入自定义？ | ❌ 不纳入（第八节 🔒） |
| D5 | 裸键绑定限制 | ✅ 仅允许 F1~F12 裸绑；字母/数字/符号必须带 Ctrl 或 Alt（Shift 单独不构成有效修饰，防吞输入） |

## 遗留确认项

无。R1 已确认：insert.table = **Ctrl+Alt+T**（2026-09-30）。基线表定稿，可启动 WP0。
