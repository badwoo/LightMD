# LightMD

> A **lightweight**, **high-performance**, **WYSIWYG** Markdown editor for Windows, built with Tauri v2 + React + ProseMirror.

<p align="center">
  <img alt="LightMD" src="https://img.shields.io/badge/LightMD-v0.1.0-5c9dff?style=for-the-badge">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0078d4?style=for-the-badge&logo=windows">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-v2-24c8db?style=for-the-badge&logo=tauri">
  <img alt="React" src="https://img.shields.io/badge/React-18-61dafb?style=for-the-badge&logo=react">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge">
</p>

[中文文档](README.md) | English

## ✨ Why LightMD?

LightMD is a **lightweight Markdown editor** purpose-built for Windows, combining the simplicity of traditional Markdown with the intuitiveness of modern WYSIWYG editors. With a tiny ~5MB installer and millisecond-fast startup, it delivers a deeply integrated Windows desktop experience.

## 🎯 Core Features

### 📝 Three Editing Modes
- **Preview Mode** — WYSIWYG with Markdown syntax hints on the cursor line
- **Source Mode** — Pure text editing with a toolbar for quick syntax insertion
- **Split Mode** — Side-by-side editing with synchronized scrolling

### 📊 Rich Content Support
- ✅ Standard Markdown (headings, lists, quotes, code blocks, tables, links, images)
- ✅ **GFM Task Lists** (`- [x]` / `- [ ]`)
- ✅ **Mermaid Diagrams** (flowchart, sequence, gantt, class, state, and 20+ more)
- ✅ **KaTeX Math** (inline `$...$` and block `$$...$$`)
- ✅ **Syntax Highlighting** (PrismJS, 200+ languages)

### ⚡ Productivity Boosters
- 🗂 **Multi-Tab** with file tree sync (`Ctrl+W` to close, `Ctrl+Tab` to switch)
- 🔍 **Global Search & Replace** (`Ctrl+F` / `Ctrl+H`)
- 📑 **Document Outline** with click-to-jump navigation
- 📁 **File Tree** + drag-and-drop open
- 📋 **Recent Files** quick access
- 💾 **Auto-save** + manual save

### 🛠 Advanced Features
- 🎨 **Light / Dark Theme** (toggle with `Ctrl+Shift+T`)
- 🔤 **Custom Font** and Size
- 🖼 **Image Paste** auto-saves to local disk
- 📤 **Export HTML** (preserves Mermaid / KaTeX rendering)
- 🎯 **Focus Mode** (toggle with `F8`, dims inactive paragraphs)
- ⌨️ **Typewriter Mode** (cursor always centered)

### ⚡ Performance
- **Tauri 2** Rust backend — fast startup, low memory, tiny installer
- **ProseMirror** editor core — smooth editing of large documents
- **iframe-isolated preview** — 80% fewer DOM nodes, less GC pressure
- **Incremental diff undo stack** — 90% less memory usage

## ⌨️ Keyboard Shortcuts

| Category | Shortcut | Action |
|----------|----------|--------|
| **File** | `Ctrl+N` | New file |
| | `Ctrl+O` | Open file |
| | `Ctrl+S` | Save |
| | `Ctrl+Shift+S` | Save as |
| **Edit** | `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| | `Ctrl+F` | Search |
| | `Ctrl+H` | Find & Replace |
| **Tabs** | `Ctrl+W` | Close current tab |
| | `Ctrl+Tab` | Switch to next tab |
| | `Ctrl+Shift+Tab` | Switch to previous tab |
| **View** | `Ctrl+Shift+T` | Toggle theme |
| | `F8` | Focus mode |
| | `Ctrl+,` | Open settings |
| **Mode** | Double `Ctrl` | Toggle preview / edit |
| | Double `Shift` | Toggle split mode |

## 📥 Installation

### Windows (Recommended)

Visit the [Releases](https://github.com/OWNER/lightmd/releases) page to download:

- **`.msi` installer** — for regular users, supports uninstall
- **`.exe` self-extracting installer** — single file, no admin required

### System Requirements

- Windows 10 / 11 (64-bit)
- No additional runtime required

## 🚀 Quick Start

1. **Download and install** LightMD
2. **Create or open** a Markdown file
3. Start typing — Markdown syntax renders on the cursor line automatically
4. **Double-tap Ctrl** to switch modes, **F8** for focus mode

## 🏗 Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Framework | Tauri v2 |
| Backend | Rust (Edition 2021) |
| Frontend | React 18 + TypeScript |
| Build Tool | Vite 5 |
| Editor Core | ProseMirror |
| Markdown Parser | markdown-it |
| Diagrams | Mermaid 11 |
| Math | KaTeX 0.17 |
| Code Highlighting | PrismJS |
| State Management | Zustand |

## 🛠 Building from Source

```bash
# Clone the repository
git clone https://github.com/OWNER/lightmd.git
cd lightmd/lightmd

# Install dependencies
npm install

# Development mode
npm run tauri dev

# Build release version
npm run tauri build
```

Build artifacts are located in `src-tauri/target/release/bundle/`.

## 🤝 Contributing

Issues and Pull Requests are welcome!

## 📄 License

[MIT License](LICENSE) © LightMD

---

<p align="center">
  Made with ❤️ for Markdown enthusiasts
</p>
