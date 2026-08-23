# LightMD

> A **lightweight**, **high-performance**, **WYSIWYG** Markdown editor for Windows, built with Tauri v2 + React + ProseMirror.

**Current Version: v0.5.0**

[中文](./README.md) | English | [User Guide](./USER_GUIDE.md)

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
- ✅ **Mermaid Diagrams** (flowchart, sequence, gantt, class, state, and 20+ more; 7 built-in templates in the toolbar for one-click insertion)
- ✅ **KaTeX Math** (inline `$...$` and block `$$...$$`; live preview for block math while editing, 0.5.0)
- ✅ **Syntax Highlighting** (PrismJS, 200+ languages; 0.2.0 adds PHP/Swift/Kotlin/Dart/Lua/Ruby/R/Scala/Perl/PowerShell; 0.5.0 adds automatic language detection for unlabeled code blocks)
- ✅ **Highlight** `==text==` (0.2.0)
- ✅ **Superscript / Subscript** `^text^` / `~text~` (0.2.0)
- ✅ **Emoji** `:smile:` auto-completion (0.2.0)
- ✅ **Footnotes** `[^1]` + `[^1]: note` (0.2.0)
- ✅ **Definition Lists** `term\n: definition` (0.2.0)
- ✅ **Auto Table of Contents** `[toc]` or `[[toc]]` (0.2.0)
- ✅ **Anchor Links** — headings auto-generate ids, supports `[link](#heading)` jump (0.2.0)

### ⚡ Productivity Boosters
- 🗂 **Multi-Tab** with file tree sync (`Ctrl+W` to close, `Ctrl+Tab` to switch; right-click a tab/file/recent item to "Open file location", 0.5.0)
- 🔍 **Global Search & Replace** (`Ctrl+F` / `Ctrl+H`)
- 📑 **Document Outline** with click-to-jump navigation
- 📁 **File Tree** + drag-and-drop open
- 📋 **Recent Files** quick access
- 💾 **Auto-save** — periodically saves to disk, configurable interval or disable
- ⚡ **Slash Commands** — type `/` at line start to trigger the quick-insert menu (headings/lists/code blocks/tables/Mermaid/math, etc.) (0.2.0)
- 🖱 **Editor Context Menu** — undo/cut/copy/paste/quick insert (0.2.0)
- ⌨️ **Auto-Pair Completion** — brackets/quotes/asterisks auto-close as you type, toggleable in settings (0.5.0)
- 🔗 **Smart URL Paste** — pasting a URL creates `[link](URL)`, or turns selected text into a hyperlink (0.5.0)
- 🖱 **Table Context Menu** — right-click a table in preview mode to insert/delete rows and columns (0.2.0)

### 🛠 Advanced Features
- 🎨 **Light / Dark Theme** (toggle with `Ctrl+Shift+T`)
- 🔤 **Custom Font** and Size
- 🖼 **Image Paste** — paste image and choose insertion method via dialog, with option to save to `assets/` folder
- 📤 **Export HTML** (preserves Mermaid / KaTeX rendering)
- 🎯 **Focus Mode** (toggle with `F8`, dims inactive paragraphs)
- ⌨️ **Typewriter Mode** (toggle with `F9`, cursor always centered)
- 🔗 **Link Insert Dialog** — text/URL/title inputs with live preview (0.2.0)
- 📊 **Table Visual Editing** — add/delete rows & columns, column alignment, draggable column width/row height, floating toolbar (0.3.0; 0.4.5 perfects column resizing: inner borders resize adjacent columns keeping total width unchanged, outermost border changes total width; 0.5.0 fixes unresponsive dragging in preview mode and supports the first column's left edge)
- 📊 **Table Insert Dialog** — custom rows/columns + header toggle (0.2.0)
- 🖼 **Image-from-File Dialog** — file picker + Base64 / assets insertion modes (0.2.0)
- 🧩 **Mermaid Template Dropdown** — Flowchart / Sequence / State / Gantt / Pie / ER / Gitgraph one-click insertion (0.2.0)
- 🧰 **Format Bar Buttons** — H4/H5/H6, strikethrough, bold-italic buttons (0.2.0)
- 🧰 **Syntax Helper Code Block Templates** — TypeScript/Go/Rust/Java/C++/SQL/JSON/YAML/Bash/Markdown/PHP one-click insertion (0.2.0)

### ⚡ Performance
- **Tauri 2** Rust backend — fast startup, low memory, tiny installer
- **ProseMirror** editor core — smooth editing of large documents
- **iframe-isolated preview** — preview DOM isolated from main document, significantly reducing GC pressure
- **Incremental diff undo stack** — stores only diffs instead of full snapshots, greatly saving memory

## ⌨️ Keyboard Shortcuts

| Category | Shortcut | Action |
|----------|----------|--------|
| **File** | `Ctrl+N` | New file |
| | `Ctrl+O` | Open file |
| | `Ctrl+S` | Save |
| | `Ctrl+Shift+S` | Save as (strikethrough inside editor, see below) |
| | `Ctrl+Shift+E` | Export HTML |
| **Edit** | `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| | `Ctrl+F` | Search |
| | `Ctrl+H` | Find & Replace |
| **Format (Source Mode)** | `Ctrl+B` | Bold `**text**` (0.2.0) |
| | `Ctrl+I` | Italic `*text*` (0.2.0) |
| | `` Ctrl+` `` | Inline code `` `code` `` (0.2.0) |
| | `Ctrl+Alt+S` | Strikethrough `~~text~~` (0.2.0) |
| | `Ctrl+Shift+M` | Block math `$$...$$` (0.2.0) |
| | `Ctrl+1` ~ `Ctrl+6` | Set heading level H1 ~ H6 (0.2.0) |
| | `Ctrl+0` | Remove heading (to paragraph) (0.2.0) |
| **Format (Preview Mode / ProseMirror)** | `Ctrl+Shift+S` | Strikethrough (0.2.0) |
| **Lists** | `Tab` | Increase indent |
| | `Shift+Tab` | Decrease indent |
| | `Ctrl+Shift+8` | Bullet list |
| | `Ctrl+Shift+9` | Ordered list |
| | `Ctrl+Shift+.` | Blockquote |
| **Quick Insert** | `/` at line start | Trigger Slash command menu (0.2.0) |
| **Tabs** | `Ctrl+W` | Close current tab |
| | `Ctrl+Tab` | Switch to next tab |
| | `Ctrl+Shift+Tab` | Switch to previous tab |
| **View** | `Ctrl+Shift+T` | Toggle theme |
| | `Ctrl+Shift+O` | Toggle outline / syntax helper |
| | `F8` | Focus mode |
| | `F9` | Typewriter mode |
| | `Ctrl+,` | Open settings |
| **Mode** | Double `Ctrl` | Toggle preview / edit |
| | Double `Shift` | Toggle split mode |

## 📥 Installation

### Windows (Recommended)

Visit the [Releases](../../releases) page to download the 0.5.0 installers:

- **`LightMD_0.5.0_x64_en-US.msi`** — MSI installer, for regular users, supports uninstall
- **`LightMD_0.5.0_x64-setup.exe`** — Self-extracting installer, single file, no admin required

### System Requirements

- Windows 10 / 11 (64-bit)
- No additional runtime required

## 🚀 Quick Start

1. **Download and install** LightMD
2. **Create or open** a Markdown file
3. Start typing — Markdown syntax renders on the cursor line automatically
4. Type `/` at line start to invoke **Slash Commands** for quick insertion of headings/lists/code blocks/tables/Mermaid diagrams, etc.
5. **Double-tap Ctrl** to switch modes, **F8** for focus mode, **F9** for typewriter mode
6. See the [User Guide](USER_GUIDE.md) for full usage

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
git clone https://github.com/badwoo/LightMD.git
cd LightMD

# Install dependencies
npm install

# Development mode
npm run tauri dev

# Build release version
npm run tauri build
```

Build artifacts are located in `src-tauri/target/release/bundle/`.

## 📋 Changelog

### v0.5.0 (2026-08-23)

**5 new features**:
- **Auto-Pair Completion** — typing `(` `[` `{` `"` `'` `` ` `` `*` auto-closes the pair and places the cursor inside; works in preview & source modes, toggleable in settings (default on)
- **Smart URL Paste** — pasting a bare URL inserts `[link](URL)` with link styling; with text selected, pasting a URL turns the selection into a hyperlink; skipped inside code blocks
- **Live Math Preview** — block `$$...$$` formulas show an editing area on top and a KaTeX-rendered preview below, updating as you type
- **Silent Language Detection** — code blocks without a language tag are auto-detected (heuristic scoring, 16 languages including Python/JavaScript/TypeScript/Rust/Go), used only for highlighting, never written back to the document
- **Open File Location** — right-click a tab, a file in the tree, or a recent-file entry to reveal it in the system file manager

**Fixes & optimizations**:
- Fixed table column borders being unresponsive to dragging in preview mode: dragging any inner border keeps the total table width unchanged while adjacent columns adjust complementarily; unified hit detection and enabled dragging the first column's left edge (no dead zone)
- Removed file-association registration for script files (.bat/.cmd/.vbs) from the installer (returns default open behavior to users), and cleans up registry leftovers on uninstall/upgrade via NSIS hooks
- TableCellView ignores attributes mutations to avoid cell re-render flicker while dragging

**Quality**: 1552/1552 tests pass (75 test files), `tsc --noEmit` with zero errors.

### v0.4.5 (2026-07-16)

**Table column resize improvements**:
- Dragging an inner column border resizes the two adjacent columns while keeping the total table width unchanged
- Dragging the outermost border changes the total table width
- Cell left edge (8px) also triggers the resize hotspot; fixed unresponsive drag and table collapse issues

**Search fixes**:
- Fixed search highlight mismatch in non-Markdown code/text files across read/edit/split modes (newline normalization `\r\n` → `\n`)

**UI fixes & optimizations**:
- Outline panel auto-closes when switching from a Markdown file to a non-Markdown file
- Optimized sidebar "Opened Files" / "Documents" section display logic
- Closed folders/files are no longer restored on next startup
- Idle-state logo animation performance: opacity-only animation (compositor layer, CPU≈0), auto-pauses on window blur, respects `prefers-reduced-motion`

### v0.4.0 ~ v0.4.4 (2026-07-12 ~ 2026-07-15)

- **v0.4.0**: Multi-folder sidebar, code file syntax highlighting (PrismJS), draggable splitters (sidebar width & split ratio), version snapshots (auto-record up to 5 versions with diff & restore)
- **v0.4.1**: Sidebar section minimize/maximize/close buttons with height resizing; snapshot dialog maximize/restore, scroll sync
- **v0.4.2**: Search & replace for non-Markdown files; content preservation across mode switches; adjacent-column-only table resize; various sidebar fixes
- **v0.4.3**: Global file search in sidebar; per-folder independent browse sections; camera icon for snapshots entry
- **v0.4.4**: Table collapse fix (`table.width = cellWidthSum`); search highlight offset fix

## 🤝 Contributing

Issues and Pull Requests are welcome!

## 📄 License

[MIT License](LICENSE) © LightMD

---

<p align="center">
  Made with ❤️ for Markdown enthusiasts
</p>
