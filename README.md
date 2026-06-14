# LightMD

> 一款**轻量级**、**高性能**、**所见即所得**的 Windows Markdown 编辑器，基于 Tauri v2 + React + ProseMirror 构建。

<p align="center">
  <img alt="LightMD" src="https://img.shields.io/badge/LightMD-v0.1.0-5c9dff?style=for-the-badge">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0078d4?style=for-the-badge&logo=windows">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-v2-24c8db?style=for-the-badge&logo=tauri">
  <img alt="React" src="https://img.shields.io/badge/React-18-61dafb?style=for-the-badge&logo=react">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge">
</p>

## ✨ 为什么选择 LightMD？

LightMD 是一款**专为 Windows 平台**打造的轻量级 Markdown 编辑器，融合了传统 Markdown 的简洁和现代 WYSIWYG 编辑器的直观。安装包仅 **~5MB**，启动毫秒级，深度集成 Windows 桌面体验。

## 🎯 核心特性

### 📝 三种编辑模式
- **预览模式** — 所见即所得，光标所在行显示 Markdown 语法标记
- **源码模式** — 纯文本编辑，配合工具栏快捷插入语法
- **分屏模式** — 左右同步滚动，编辑与预览实时联动

### 📊 富文本支持
- ✅ 标准 Markdown（标题、列表、引用、代码块、表格、链接、图片）
- ✅ **GFM 任务列表**（`- [x]` / `- [ ]`）
- ✅ **Mermaid 图表**（流程图、时序图、甘特图、类图、状态图等 20+ 种）
- ✅ **KaTeX 数学公式**（行内 `$...$` 与块级 `$$...$$`）
- ✅ **代码语法高亮**（PrismJS，200+ 语言）

### ⚡ 高效交互
- 🗂 **多标签页** + 文件双向联动（`Ctrl+W` 关闭、`Ctrl+Tab` 切换）
- 🔍 **全局搜索与替换**（`Ctrl+F` / `Ctrl+H`）
- 📑 **文档大纲** — 实时同步，点击跳转
- 📁 **文件树** + 拖拽打开
- 📋 **最近文件** 快速访问
- 💾 **自动保存** + 手动保存双保险

### 🛠 高级功能
- 🎨 **亮色 / 暗色主题**（`Ctrl+Shift+T` 切换）
- 🔤 **自定义字体** 与字号
- 🖼 **图片粘贴**自动保存到本地
- 📤 **导出 HTML**（保留 Mermaid / KaTeX 渲染）
- 🎯 **专注模式**（`F8` 切换，dim 非活跃段落）
- ⌨️ **打字机模式**（光标始终居中）

### ⚡ 性能优势
- **Tauri 2** Rust 后端 — 启动快、内存低、安装小
- **ProseMirror** 编辑器核心 — 大文档流畅编辑
- **iframe 隔离预览** — DOM 节点数降低 80%，GC 压力减少
- **增量 diff 撤销栈** — 内存占用降低 90%

## ⌨️ 快捷键

| 类别 | 快捷键 | 功能 |
|------|--------|------|
| **文件** | `Ctrl+N` | 新建文件 |
| | `Ctrl+O` | 打开文件 |
| | `Ctrl+S` | 保存 |
| | `Ctrl+Shift+S` | 另存为 |
| **编辑** | `Ctrl+Z` / `Ctrl+Y` | 撤销 / 恢复 |
| | `Ctrl+F` | 搜索 |
| | `Ctrl+H` | 查找替换 |
| **标签** | `Ctrl+W` | 关闭当前标签 |
| | `Ctrl+Tab` | 切换到下一个标签 |
| | `Ctrl+Shift+Tab` | 切换到上一个标签 |
| **视图** | `Ctrl+Shift+T` | 切换主题 |
| | `F8` | 专注模式 |
| | `Ctrl+,` | 打开设置 |
| **模式** | 双击 `Ctrl` | 切换预览 / 编辑 |
| | 双击 `Shift` | 切换分屏模式 |

## 📥 安装

### Windows 用户（推荐）

前往 [Releases](https://github.com/OWNER/lightmd/releases) 页面下载：

- **`.msi` 安装包** — 适合普通用户，支持卸载
- **`.exe` 自解压安装包** — 单文件安装，免管理员权限

### 系统要求

- Windows 10 / 11（64 位）
- 无需安装额外运行库

## 🚀 快速上手

1. **下载并安装** LightMD
2. **新建 / 打开** Markdown 文件
3. 开始书写 — 在光标所在行直接输入 Markdown 语法
4. **双击 Ctrl** 切换模式，`F8` 进入专注写作

## 🏗 技术栈

| 层级 | 技术 |
|------|------|
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
git clone https://github.com/OWNER/lightmd.git
cd lightmd/lightmd

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

<p align="center">
  Made with ❤️ for Markdown enthusiasts
</p>
