# LightMD

> 一款**轻量级**、**高性能**、**所见即所得**的 Windows Markdown 编辑器，基于 Tauri v2 + React + ProseMirror 构建。

**当前版本：v0.2.0**

中文 | [English](./README_EN.md) | [用户指南](./USER_GUIDE.md)

## ✨ 为什么选择 LightMD？

LightMD 是一款**专为 Windows 平台**打造的轻量级 Markdown 编辑器，融合了传统 Markdown 的简洁和现代 WYSIWYG 编辑器的直观。安装包仅 **~5MB**，启动毫秒级，深度集成 Windows 桌面体验。

## 🎯 核心特性

### 📝 三种编辑模式

- **阅读模式** — 所见即所得，光标所在行显示 Markdown 语法标记
- **源码模式** — 纯文本编辑，配合工具栏快捷插入语法
- **分屏模式** — 左右同步滚动，编辑与预览实时联动

### 📊 富文本支持

- ✅ 标准 Markdown（标题、列表、引用、代码块、表格、链接、图片）
- ✅ **GFM 任务列表**（`- [x]` / `- [ ]`）
- ✅ **Mermaid 图表**（流程图、时序图、甘特图、类图、状态图等 20+ 种，工具栏内置 7 种模板一键插入）
- ✅ **KaTeX 数学公式**（行内 `$...$` 与块级 `$$...$$`）
- ✅ **代码语法高亮**（PrismJS，200+ 语言，0.2.0 新增 PHP/Swift/Kotlin/Dart/Lua/Ruby/R/Scala/Perl/PowerShell）
- ✅ **高亮标记** `==文本==`（0.2.0 新增）
- ✅ **上标 / 下标** `^文本^` / `~文本~`（0.2.0 新增）
- ✅ **Emoji 表情** `:smile:` 自动补全（0.2.0 新增）
- ✅ **脚注** `[^1]` + `[^1]: 说明`（0.2.0 新增）
- ✅ **定义列表** `术语\n: 定义`（0.2.0 新增）
- ✅ **自动目录** `[toc]` 或 `[[toc]]`（0.2.0 新增）
- ✅ **锚点链接** — 标题自动生成 id，支持 `[链接](#标题)` 跳转（0.2.0 新增）

### ⚡ 高效交互

- 🗂 **多标签页** + 文件双向联动（`Ctrl+W` 关闭、`Ctrl+Tab` 切换）
- 🔍 **全局搜索与替换**（`Ctrl+F` / `Ctrl+H`）
- 📑 **文档大纲** — 实时同步，点击跳转
- 📁 **文件树** + 拖拽打开
- 📋 **最近文件** 快速访问
- 💾 **自动保存** — 定时保存到磁盘，可配置间隔或关闭
- ⚡ **Slash 命令** — 行首输入 `/` 触发快速插入菜单（标题/列表/代码块/表格/Mermaid/公式等）（0.2.0 新增）
- 🖱 **编辑器右键菜单** — 撤销/剪切/复制/粘贴/快速插入（0.2.0 新增）
- 🖱 **表格右键菜单** — 阅读模式下右键表格可插入/删除行与列（0.2.0 新增）

### 🛠 高级功能

- 🎨 **亮色 / 暗色主题**（`Ctrl+Shift+T` 切换）
- 🔤 **自定义字体** 与字号
- 🖼 **图片粘贴** — 粘贴图片后弹窗选择插入方式，支持保存到 `assets/` 文件夹
- 📤 **导出 HTML**（保留 Mermaid / KaTeX 渲染）
- 🎯 **专注模式**（`F8` 切换，dim 非活跃段落；阅读/编辑/分屏三模式通用）
- ⌨️ **打字机模式**（`F9` 切换，光标始终居中；阅读/编辑/分屏三模式通用）
- 🔗 **链接插入对话框** — 文本/URL/标题输入 + 实时预览（0.2.0 新增）
- 📊 **表格插入对话框** — 行列数自定义 + 表头勾选（0.2.0 新增）
- 🖼 **图片从文件选择对话框** — 文件选择 + Base64 / assets 两种插入模式（0.2.0 新增）
- 🧩 **Mermaid 模板下拉** — Flowchart / Sequence / State / Gantt / Pie / ER / Gitgraph 一键插入（0.2.0 新增）
- 🧰 **格式栏按钮补全** — H4/H5/H6、删除线、粗斜体按钮（0.2.0 新增）
- 🧰 **语法辅助栏代码块模板** — TypeScript/Go/Rust/Java/C++/SQL/JSON/YAML/Bash/Markdown/PHP 一键插入（0.2.0 新增）

### ⚡ 性能优势

- **Tauri 2** Rust 后端 — 启动快、内存低、安装小
- **ProseMirror** 编辑器核心 — 大文档流畅编辑
- **iframe 隔离预览** — 预览 DOM 与主文档隔离，显著降低 GC 压力
- **增量 diff 撤销栈** — 仅存储差异而非全量快照，大幅节省内存

## ⌨️ 快捷键

| 类别 | 快捷键 | 功能 |
| --- | --- | --- |
| **文件** | `Ctrl+N` | 新建文件 |
|   | `Ctrl+O` | 打开文件 |
|   | `Ctrl+S` | 保存 |
|   | `Ctrl+Shift+S` | 另存为（编辑器内为删除线，见下） |
|   | `Ctrl+Shift+E` | 导出 HTML |
| **编辑** | `Ctrl+Z` / `Ctrl+Y` | 撤销 / 恢复 |
|   | `Ctrl+F` | 搜索 |
|   | `Ctrl+H` | 查找替换 |
| **格式（源码模式）** | `Ctrl+B` | 加粗 `**文本**`（0.2.0 新增） |
|   | `Ctrl+I` | 斜体 `*文本*`（0.2.0 新增） |
|   | `` Ctrl+` `` | 行内代码 `` `代码` ``（0.2.0 新增） |
|   | `Ctrl+Alt+S` | 删除线 `~~文本~~`（0.2.0 新增） |
|   | `Ctrl+Shift+M` | 块级公式 `$$...$$`（0.2.0 新增） |
|   | `Ctrl+1` ~ `Ctrl+6` | 设置标题级别 H1 ~ H6（0.2.0 新增） |
|   | `Ctrl+0` | 移除标题（转为段落）（0.2.0 新增） |
| **格式（阅读模式 ProseMirror）** | `Ctrl+Shift+S` | 删除线（0.2.0 新增） |
| **列表** | `Tab` | 增加缩进 |
|   | `Shift+Tab` | 减少缩进 |
|   | `Ctrl+Shift+8` | 无序列表 |
|   | `Ctrl+Shift+9` | 有序列表 |
|   | `Ctrl+Shift+.` | 引用块 |
| **快速插入** | 行首 `/` | 触发 Slash 命令菜单（0.2.0 新增） |
| **标签** | `Ctrl+W` | 关闭当前标签 |
|   | `Ctrl+Tab` | 切换到下一个标签 |
|   | `Ctrl+Shift+Tab` | 切换到上一个标签 |
| **视图** | `Ctrl+Shift+T` | 切换主题 |
|   | `Ctrl+Shift+O` | 切换大纲 / 语法辅助 |
|   | `F8` | 专注模式 |
|   | `F9` | 打字机模式 |
|   | `Ctrl+,` | 打开设置 |
| **模式** | 双击 `Ctrl` | 切换阅读 / 编辑 |
|   | 双击 `Shift` | 切换分屏模式 |

## 📥 安装

### Windows 用户（推荐）

前往 [Releases](../../releases) 页面下载 0.2.0 版本安装包：

- **`LightMD_0.2.0_x64_en-US.msi`** — MSI 安装包，适合普通用户，支持卸载
- **`LightMD_0.2.0_x64-setup.exe`** — 自解压安装包，单文件安装，免管理员权限

### 系统要求

- Windows 10 / 11（64 位）
- 无需安装额外运行库

## 🚀 快速上手

1. **下载并安装** LightMD
2. **新建 / 打开** Markdown 文件
3. 开始书写 — 在光标所在行直接输入 Markdown 语法
4. 行首输入 `/` 唤起 **Slash 命令**，快速插入标题/列表/代码块/表格/Mermaid 图表等
5. **双击 Ctrl** 切换模式，`F8` 进入专注写作，`F9` 开启打字机模式
6. 详细用法见 [用户指南](./USER_GUIDE.md)

## 🏗 技术栈
| 层级 | 技术 |
| --- | --- |
| 桌面框架 | Tauri v2 |
| 后端 | Rust（Edition 2021） |
| 前端 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 编辑器核心 | ProseMirror |
| Markdown 解析 | markdown-it |
| 图表 | Mermaid 11 |
| 数学公式 | KaTeX 0.17 |
| 代码高亮 | PrismJS |
| 状态管理 | Zustand |

## 🛠 从源码构建

```bash
# 克隆项目
git clone https://github.com/badwoo/lightmd.git
cd lightmd

# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 打包发布版本
npm run tauri build



```

打包产物位于 `src-tauri/target/release/bundle/`。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 开源协议

[MIT License](LICENSE) © LightMD

---

<p align="center"> Made with ❤️ for Markdown enthusiasts </p>
