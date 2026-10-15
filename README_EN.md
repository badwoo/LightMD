# LightMD

> A **lightweight**, **high-performance**, **WYSIWYG** Markdown editor for Windows, built with Tauri v2 + React + ProseMirror.

**Current Version: v0.12.3**

[中文](./README.md) | English | [User Guide](./USER_GUIDE.md)

## ✨ About LightMD

LightMD is a **lightweight Markdown editor** purpose-built for Windows, combining the simplicity of traditional Markdown with the intuitiveness of modern WYSIWYG editors. With a tiny ~9MB installer and millisecond-fast startup, it delivers a deeply integrated Windows desktop experience.

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

### 🚰 Unified Render Pipeline & Export Fidelity

- Split preview and all export formats (HTML / PDF / PNG / DOCX / LaTeX / ePub) share a single markdown-it configuration source: straight quotes are no longer rewritten to curly quotes, and `javascript:` and other dangerous links are blocked on every export path
- Formulas render as KaTeX typesetting (native MathML in ePub) and Mermaid diagrams as vector graphics in exports — no more blank placeholders or raw source
- Regex search & replace with `$1` / `$&` capture-group references; invalid patterns are flagged in red without crashing
- Outline limit raised to 1000 so long documents are no longer truncated

### 🖱 Editing Experience Upgrades

- Document-wide zoom via `Ctrl+wheel` or the bottom-right slider (click a tick to jump, draggable), working in all three modes at 50%–200%, remembered across restarts
- Format painter: click to apply once, double-click for continuous application (remaining count in the status bar, `Esc` to exit); works on block-level and inline formats
- Click a code block / Mermaid diagram / formula / table / divider in reading mode to select the whole block, then `Delete` it or drag the `⋮⋮` handle to reposition
- Clicking "Bold" / "Heading" without a selection inserts only syntax markers; the placeholder is a grey ghost hint replaced as soon as you type, never written to disk
- Reading focus preserved: collapsing the sidebar, resizing the window, dragging the split divider, or toggling the outline keeps the first visible paragraph in place
- Focus mode highlight expands to "previous / current / next" lines
- Heading level badges: an `H1`–`H6` dropdown changes the level with the outline following
- Auto-pairing: skips when the closing symbol already follows, wraps selections, one Backspace deletes an empty pair, `Tab` jumps out; scope configurable per brackets / quotes / CJK punctuation
- Enter = line break in reading mode (N presses = N line breaks), `Shift+Enter` = new paragraph; behavior inside lists / quotes / headings / tables / code blocks is unchanged
- Line height / paragraph spacing / content width settings apply in all three modes
- Also: `→` exits code blocks, a book button in editing mode, square / round task icons, an editor scrollbar flush right, creation time for open files, and "About LightMD" in Settings

### 📖 Reading Experience Enhancements

- Image lightbox: click any image for a full-screen view with zoom, prev/next navigation and `Esc` to close
- Typography settings (content width / line height / paragraph spacing) really applied, with reading progress as a percentage in the status bar
- Heading anchors jump correctly; `[toc]` updates live; emoji short codes render as graphics (source text preserved on save)
- Zero-shift heading symbols — no more jitter when the cursor enters or leaves headings / quotes / code blocks

### 🛡 Data Safety & Stability

- `Shift+Enter` inside code / math blocks no longer splits the block; "delete row" on a table header no longer loses data
- Image sizing `![alt|300](src)` works in split preview and all export formats, and the width is no longer erased by the export pipeline
- Line-break round-trip fidelity: breaks at paragraph starts, adjacent hard breaks, and inside tables / lists / quotes are saved as `<br>`, with 21 dangerous line-leading constructs auto-escaped
- Exported HTML is self-contained offline (KaTeX inlined, mermaid side-loaded to `_assets/`)
- PDF headers/footers appear on every page without leaking internal temp paths
- DOCX no longer silently drops task lists / definition lists / images / list numbering / formulas / table alignment
- Documents containing Emoji short codes no longer white-screen; `$`, `==`, `~`, `^` are only escaped when a pair can actually form

### ⌨️ Typewriter-Style Input

- Six input rules — inline formulas, block formulas, links, images, footnotes, and auto table of contents — convert as you type
- Minimal HTML whitelist: `<u>` `<br>` `<sub>` `<sup>` `<mark>` parse into the corresponding formats
- Underline via `Ctrl+U`, insert link via `Ctrl+Shift+K`

### 🖍 Inline Markers, Paste & Undo

- Markdown source symbols appear instantly when the cursor enters a bold / italic / inline code / link range, and hide on leave
- Markdown-aware paste restores real structure from Markdown text or web rich text
- Undo history stays consistent across modes with no empty steps

### 🧹 Editing Consistency

- Reading-mode format commands share the same source as keyboard shortcuts — no more literal-text "fake commands"
- Typing `---` or `` ``` `` inside nested blocks (list items / quotes) no longer mis-converts; header rows no longer offer "delete row"
- The command palette gains the missing format commands; `Ctrl+Shift+8/9/.` really work in source mode
- `Alt+↑/↓` is a true block move (old merge / lift semantics moved to `Alt+Shift+↑/↓`)

### 🖼 Images & Code Blocks

- Image sizing `![alt|300](src)`, alt text, and drop-point insertion for dragged-in images
- **Image left/center/right alignment** (persisted as an `![alt|center](src)` suffix) and an **image manager panel** (list images / move to assets / rename / clean unreferenced, current document only)
- Code block language dropdown with instant re-highlighting; 34 built-in highlighting languages; **one-click copy in the top-right corner**
- In-paragraph line-break semantics selectable (GFM immediate break / CommonMark two spaces)

### 📋 Tables

- The insert dialog has a live Markdown preview and supports slash headers
- Column-width / row-height dragging, whole-column alignment, row/column add and delete, and a header row that cannot be deleted (so data never impersonates a header)
- **Cell merge / split** (drag across cells → 🔗/✂️; both colspan and rowspan; ordinary tables round-trip with zero diff)

### ⚡ Navigation & Performance

- In-document link navigation: relative paths open the target document, `#anchor` smooth-scrolls, external links go to the system browser
- Focus mode and Mermaid rendering caches keep hundred-thousand-character documents smooth
- Task items and footnotes keep a lossless content model, directly editable including nested lists and paragraphs

### 🪟 Immersive Fullscreen & Shortcut Experience

- `F11` immersive fullscreen collapses all four bars, `Esc` restores
- `Ctrl+,` is reclaimed by a Rust-level native hotkey so Chinese IMEs can no longer swallow it
- Settings dialog fades in/out; the custom shortcut dialog uses a 3×3 card layout with every shortcut visible in one screen

### 🗂 Tabs & File Management (strengthened throughout 0.8.0 ~ 0.8.5)

- 🆕 **Untitled scratch tabs** — create with `Ctrl+N` or by double-clicking the empty tab-bar area; nothing is written to disk until the first save, and unsaved scratch tabs are restored on restart
- 📌 **Tab bar upgrades** — left/right scroll buttons plus smooth wheel scrolling when tabs overflow; pin a tab (pin icon shown); 9-item context menu (Rename / Pin / Print / Save As / Close Others / Close Others Except Pinned / Close to the Left / Close to the Right / Close Unmodified)
- 📋 **File tree copy / cut / paste / drag** — copy or cut from the context menu or with `Ctrl+C` / `Ctrl+V`; drag onto a folder to copy, hold `Shift` to move (tab paths follow automatically); name clashes get a " - Copy" suffix
- 🗑 **Delete closes its tabs** — removing a file or folder also closes the matching open tabs
- 🧭 **Open containing folder as workspace** — from the tab/file/recent-item context menu
- 🖱 **Redesigned sidebar layout** — drag a section header to resize (neighbouring sections trade height, and the last one can be dragged all the way down); floating scroll arrows and a slimmer, subtler scrollbar
- 🖱 **File tree drag & ordering upgrades (0.8.4)** — drag a file/folder onto a folder to copy, hold `Shift` to move (cross-drive supported); drag within the same folder to reorder (manual order survives restart); copy/cut in the node context menu, and new file / new folder / refresh / paste on the empty-area menu; per-folder sort button in the folder header (name / modified / created × ascending / descending, remembered per folder); external changes sync into the tree automatically (`Ctrl+R` as a fallback refresh)
- 🗑 **Delete goes to the Recycle Bin (0.8.5)** — deleting files / folders no longer removes them permanently; they land in the system Recycle Bin and can be restored anytime
- 🕐 **"Recent" upgrades (0.8.3 / 0.8.5)** — shows the full list (capped at 66 entries) with in-panel scrolling, files and folders interleaved by time; hovering reveals the full path and the open date; kept as a **pure history** that is only flagged ⚠ when a path goes stale, never deleted automatically
- 🪟 **Window size & position memory (0.8.3)** — maximized on first install; afterwards the app opens with the size and position it was closed in, including on a second monitor
- 📍 **Reading position survives restarts (0.8.3)** — a document restored at startup returns to where you stopped reading, unsaved scratch documents included
- 📐 **Cursor position in the status bar (0.8.3)** — shows `Line N, Col M` live, plus `N selected` while text is selected

### 🪟 Window & Motion (0.8.1 ~ 0.8.5)

- 🪟 **Frameless window (0.8.1)** — the native title bar is gone; minimize / maximize / close moved next to the settings button (macOS traffic-light colors, symbols on hover)
- 🗔 **Everything in-app (0.8.1 / 0.8.4)** — file properties and the New File / New Folder dialogs no longer use native system popups: no system beep, and paths can be selected and copied
- 🎞 **Transitions (0.8.2 ~ 0.8.5)** — folder panels and "Open Files" rows open by sliding in and close with a strictly serial three-beat (slide out → pause → collapse height); file-tree nodes expand/collapse; the search box, sort dropdown, new-item dialog and the status-bar search panel (grows out of / retracts into its button) are all animated
- 🌿 **Reduced-motion support** — all motion degrades to a plain show/hide when the system "reduce motion" preference is on, and uses only compositor properties (transform / opacity)
- 📏 **Slimmer scrollbars, wider default panels (0.8.1)** — both sidebars use a 2px scrollbar (transparent at rest, visible on hover), and each default sidebar is 0.5cm wider

### ✍️ Editing Experience (strengthened in 0.8.0)

- ↩️ **Line-break fidelity** — `Shift+Enter` inside table cells, multi-paragraph list items, nested lists and indented code blocks survive saving intact
- 🔤 **CJK punctuation pairing** — `「」『』《》【】（）` and friends auto-close, `Backspace` deletes in pairs, and typing a closing mark next to an existing one just moves the caret (no more quadruple quotes)
- 🎯 **Typewriter mode centers immediately** when switched on
- 🧭 **Mode-switch anchor** — switching between preview/source/split keeps you at the same editing position instead of jumping

### ✨ AI Translation

- **Selection & Full-Document Translation** — select text and translate it from the context menu or the "Translate" button; with no selection the whole document is translated (`Shift+F6`, the floating button, or the command palette)
- **Result Modes** — "Replace in place" or "Bilingual comparison"
- **Translation Bubble** — streaming results with cancel (`Esc`) and one-click restore of the original (0.6.1)
- **Efficiency** — symbol-only / URL / email / image-only paragraphs are skipped; links, inline code, and images are protected as placeholders so they are never mistranslated (0.6.2/0.6.4/0.6.5); full-document translation runs 3-way concurrent (0.7.3)
- **API Key Security** — stored in Windows Credential Manager and removed on uninstall (0.6.1); warnings for non-local URL endpoints (0.6.3); stored per provider (0.7.2)

### 🤖 AI Assistant & AI Chat

- **Selection AI Bubbles** — selecting text shows one floating row of \[译\]\[续\]\[润\]\[摘\]\[问] bubbles (added in 0.7.4, extended in 0.7.5): continue writing (ghost preview at the caret, `Tab` to accept / `Esc` to discard), polish (replaces the selection), summarize (draggable floating window), and chat
- **AI Chat Floating Window** (0.7.5, `Ctrl+K`) — free-form multi-turn chat with a one-click `Selection / Document / No context` scope chip, six quick templates (Diagram / Formula / Summary / Title & tags / Rewrite all / Analyze), and a draggable, resizable window that remembers its position
- **Result Action Bar** — each answer can be inserted at the cursor, replace the selection, replace the whole document, copied, or regenerated; replacing the whole document first verifies the document was not edited, so your changes are never overwritten
- **What You Insert Is What You See** — \`\`\`mermaid fences and `$$` formulas produced by the model render immediately as diagrams and formulas once inserted
- **Per-Bubble Visibility & Colors** — the four AI bubbles can be hidden and restored individually and colored individually; the "译" bubble color is configurable too (0.7.5)

### 🛠 Advanced Features

- 🎨 **6 Themes** — light / dark / GitHub / newsprint / night / solarized (cycle with `Ctrl+Shift+T`)
- 🔤 **Custom Font** and Size
- 🖼 **Image Paste** — paste image and choose insertion method via dialog, with option to save to `assets/` folder
- 📤 **Export HTML** (preserves Mermaid / KaTeX rendering)
- 📤 **Export ePub** — chapters split by heading, bundled images, code-block styling (0.8.0)
- 📤 **Export LaTeX** — generates a `.tex` source (ctexart + XeLaTeX, Chinese-ready) (0.8.0)
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

| Category                                | Shortcut                    | Action                                                                                |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| **File**                                | `Ctrl+N`                    | New scratch (untitled) tab — writes to disk only on first save                        |
|                                         | `Ctrl+O`                    | Open file                                                                             |
|                                         | `Ctrl+S`                    | Save                                                                                  |
|                                         | `Ctrl+Shift+S`              | Save as                                                                               |
|                                         | `Ctrl+Shift+E`              | Open the export dialog                                                                |
| **Edit**                                | `Ctrl+Z` / `Ctrl+Y`         | Undo / Redo                                                                           |
|                                         | `Ctrl+F`                    | Search                                                                                |
|                                         | `Ctrl+H`                    | Find & Replace                                                                        |
|                                         | `Ctrl+K`                    | Open the AI chat window (0.7.5)                                                       |
| **Format (Source Mode)**                | `Ctrl+B`                    | Bold `**text**` (0.2.0)                                                               |
|                                         | `Ctrl+I`                    | Italic `*text*` (0.2.0)                                                               |
|                                         | `` Ctrl+` ``                | Inline code `` `code` `` (0.2.0)                                                      |
|                                         | `Ctrl+Alt+S`                | Strikethrough `~~text~~` (0.2.0)                                                      |
|                                         | `Ctrl+Shift+M`              | Block math `$$...$$` (0.2.0)                                                          |
|                                         | `Ctrl+1` ~ `Ctrl+6`         | Set heading level H1 ~ H6 (0.2.0)                                                     |
|                                         | `Ctrl+0`                    | Remove heading (to paragraph) (0.2.0)                                                 |
| **Format (Preview Mode / ProseMirror)** | `Ctrl+Alt+S`                | Strikethrough (unified with source mode in 0.9.0; the old `Ctrl+Shift+S` is gone)     |
| **Lists**                               | `Tab`                       | Increase indent                                                                       |
|                                         | `Shift+Tab`                 | Decrease indent                                                                       |
|                                         | `Ctrl+Shift+8`              | Bullet list                                                                           |
|                                         | `Ctrl+Shift+9`              | Ordered list                                                                          |
|                                         | `Ctrl+Shift+.`              | Blockquote                                                                            |
| **Quick Insert**                        | `/` at line start           | Trigger Slash command menu (0.2.0)                                                    |
| **Tabs**                                | `Ctrl+W`                    | Close current tab                                                                     |
|                                         | `Ctrl+Tab`                  | Switch to next tab                                                                    |
|                                         | `Ctrl+Shift+Tab`            | Switch to previous tab                                                                |
|                                         | `Ctrl+Alt+V`                | Open the version snapshot window (0.8.0, was `Ctrl+Shift+V`)                          |
| **Sidebar file tree**                   | `Ctrl+C` / `Ctrl+V`         | Copy / paste (or move after cut) the selected file, when focus is in the sidebar      |
|                                         | `Ctrl+R`                    | Refresh the file tree (fallback when external changes are not synced, added in 0.8.4) |
| **View**                                | `Ctrl+Shift+T`              | Toggle theme                                                                          |
|                                         | `Ctrl+Shift+O`              | Toggle outline / syntax helper                                                        |
|                                         | `Ctrl+Shift+P`              | Command palette                                                                       |
|                                         | `Ctrl+Alt+←` / `Ctrl+Alt+→` | Collapse / expand the sidebar / outline (0.9.0)                                       |
|                                         | `Ctrl+Shift+B`              | Collapse / expand the tab bar (0.9.0)                                                 |
|                                         | `F11`                       | Full screen (0.9.0; the command palette entry is the mouse path)                      |
|                                         | `F8`                        | Focus mode                                                                            |
|                                         | `F9`                        | Typewriter mode                                                                       |
|                                         | `Ctrl+,`                    | Open settings                                                                         |
| **Mode**                                | Double `Ctrl`               | Toggle preview / edit (double-press threshold 220 ms as of 0.9.0)                     |
|                                         | Double `Shift`              | Toggle split mode                                                                     |

> **Custom shortcuts (0.9.0)**: every customizable shortcut listed above is shown by category (File / Edit / Format / View / Tabs / Window / Insert) under **Settings → Editor → Customize Shortcuts**. Click an entry and press the new combination; conflicts report the current owner and are not written. Per-entry and global reset are supported, and the shortcut labels in the command palette, context menu and toolbar tooltips follow your changes (synced across windows). Reserved keys such as `F11`, the file-tree keys and editor behaviour keys are not customizable.

## 📥 Installation

### Windows (Recommended)

Visit the [Releases](../../releases) page to download the 0.12.3 installers:

- **`LightMD_0.12.3_x64_en-US.msi`** — MSI installer, for regular users, supports uninstall
- **`LightMD_0.12.3_x64-setup.exe`** — Self-extracting installer, single file, no admin required

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

| Layer             | Technology            |
| ----------------- | --------------------- |
| Desktop Framework | Tauri v2              |
| Backend           | Rust (Edition 2021)   |
| Frontend          | React 18 + TypeScript |
| Build Tool        | Vite 5                |
| Editor Core       | ProseMirror           |
| Markdown Parser   | markdown-it           |
| Diagrams          | Mermaid 11            |
| Math              | KaTeX 0.17            |
| Code Highlighting | PrismJS               |
| State Management  | Zustand               |

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

### v0.13.0 bug-fix round 2 (2026-10-15)

**Defects found by auditing all 12 requirements line by line — two of them "the feature effectively does not exist"**

Round 1 fixed the eight problems the user hit on a real device. Round 2 re-verified **every** v0.13.0 requirement against the source (reproducing each claim with the real `markdown-it` and real ProseMirror under jsdom) and found ten more defects. They all share one pattern: **the pure-function unit tests were green while the real call chain was unusable or silently corrupted data.**

| Severity | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| **BLOCKER** | **"Merge cells" had no usable path in the UI at all**: dragging across cells highlighted nothing and the toolbar 🔗 button stayed permanently disabled | `cellCoordOf` compared `view.posAtDOM(cellEl, 0)` against the *cell node start*, but ProseMirror's `posAtDOM(dom, 0)` returns the position of the cell's **first child** (= start + 1). Measured: 9/9 cells failed to match → returned `null` → `rangeAnchor` was never set → `cellRange` was never assigned → neither the drag highlight nor the merge button could ever trigger. The existing `v0130-table-merge-ops` test called `mergeCells` directly and **never went through coordinate conversion**, so it stayed green | Added `cellPositionsOfGrid` (built on `buildTableGridFromTable`, i.e. the **same grid definition** the merge and serializer use) as the single source of truth for "cell position ↔ grid coordinate"; both `cellCoordOf` and `cellPosOfCoord` now query it. Also fixed the old implementation's `return`-inside-`forEach` which failed to stop the traversal and corrupted row indices |
| **BLOCKER** | **Merging header cells, then saving, turned the whole table into a paragraph** (every row and every cell lost at once) | The serializer emitted the header using **physical** cells (skipping colspan-occupied holes) while the separator line used the **logical** column count. markdown-it's table rule hard-requires `columnCount === aligns.length`; with fewer header cells than separator columns the file **no longer parses as a table** | Pad the header row to the same physical cell count as the separator (with blank cells; trailing blanks are removed by the grid's existing trimming, so a second serialization is stable and the column count cannot grow). Plain tables without spans never trigger the padding, so the **byte-identical pipe-table regression lock is unaffected** |
| HIGH | After a `Ctrl+/` comment round-trip the **text was permanently rewritten**: `<!--a**b-->` came back as `a\*\*b` | The comment body sits inside an HTML comment where markdown-it interprets no markdown, yet the serializer still escaped it; the parser takes the raw inner text and **never unescapes** → backslashes persisted forever | The comment body no longer goes through markdown escaping |
| HIGH | A comment body containing `--` or ending in `-` caused the comment to be **closed early** and the `mark` to be lost | markdown-it's comment regex `<!--(?:[^-]|-[^-]|--[^>])*-->` forbids `-->` inside the body and forbids ending in `-` (which forms `--->` with the closing delimiter) | Only in those two shapes, a zero-width character is inserted between the dashes and removed on read → **lossless round-trip** |
| HIGH | Un-commenting in source mode **ate characters or emptied the text** (`<!--TODO-->` → `OD`) | The old code took `trim()` of the line but then sliced by **fixed lengths** (`"<!-- "` = 5 chars, `" -->"` = 4 chars), while real comments do not always carry those spaces | Slice by the **actual indices** of `<!--` / `-->`, stripping only the one space the wrapper adds; also fixed the length guard that classified `<!--a-->` as "not commented" and kept re-wrapping it |
| HIGH | **Image left/center/right alignment was completely lost in preview and in HTML/PDF/PNG export** (and the alt was polluted into `alt\|center`) | The render pipeline's `imageSizePlugin` only recognised a trailing `\|digits` (width) suffix and had no notion of alignment | Suffix parsing extended to "width + alignment", emitting the **same** `imageAlignCss` style the editor uses plus `data-align` (so exported HTML re-parsed back into the editor keeps its alignment) |
| HIGH | With a pipe in the image alt, **width/alignment were lost on save or fabricated out of nowhere** | Width/alignment use `\|` as the separator while the alt itself may contain `\|`; the serializer did not escape it, so the reader split in the wrong places (`alt="a\|1"` fabricated a width of 1) | The serializer writes a literal pipe in the alt as `\\\|`; the reader splits on **unescaped** pipes and restores them |
| MEDIUM | With inline formatting inside a merged cell (bold/link/inline code) the DOCX/LaTeX output contained a **literal `<td colspan="2">`** | The old guard only stripped tags when a token *started with* `<td`/`<th`, but inline formatting makes markdown-it split the wrapper into several tokens (open tag / formatting / close tag), so single tag fragments passed the "no change" check and leaked into the body | Fragments that are exactly one td/th wrapper tag are now recognised and dropped |
| MEDIUM | Writing a time or ratio in prose (`3:1`, `12:30`, `John 3:16`) **popped the emoji menu** (sometimes an empty one) | The trigger only required "the character before the colon is not a colon" while the query allowed digits | Added "the character immediately before the colon is not a digit" — covers every time/ratio form while keeping genuine shortcodes like `:100` working |
| MEDIUM | With an inline atom (e.g. a formula) before the caret, accepting an emoji candidate **overwrote that node's content** (`$x^2$ :sm` → the formula became `x^2:smile:`) | `from` was computed as "content start + string index", but an inline atom's `nodeSize` differs from its text length (formula `nodeSize` 5, text `x^2` length 3) → the range was too short and swallowed the atom | Convert by accumulating each child's `nodeSize`, replicating `textBetween`'s real semantics (text → raw text, leaf → leafText, **non-leaf → its textContent**) |
| LOW | A list written as `3. c` / `4. d` showed markers `1. ` / `2. ` in the editor | The ordered-list marker only used "which sibling is this" and ignored `ordered_list.attrs.order` | The list's start number is now added (no offset when it is the default 1, so existing documents are unchanged) |
| LOW | In the outline, collapsing a heading that is **already inside a collapsed ancestor** made the outer collapse stop working early | A single scalar tracked "the currently effective collapsed level" and could not represent several nested collapses; a hidden node's own collapse state also narrowed the range | Replaced with a **stack of collapsed levels**; a hidden node's own collapse state no longer takes effect |
| LOW | Renaming several images to the same name in one batch **failed part-way**, leaving a partially completed state | `planRename` only checked that the new name was non-empty | Added rejection of a colliding target name (case-insensitive) and of no-op same-name renames |

**How this round was verified**: every conclusion was reproduced with the real `markdown-it` 14.1.0 and the real `prosemirror-model/state/view` under jsdom (rather than inferred from reading code), and the fixes are asserted the same way — real round-trips and real DOM events. This adds **31 behavioural regressions** in `v0130-fix-round2`; the table-merge one mounts a **real `createEditor` and dispatches real DOM mouse events** to prove that dragging across cells actually highlights a range — exactly the link the old unit test never covered.

**Quality verification**: frontend **273 files / 4576 cases all passing**; `tsc --noEmit` clean.

### v0.13.0 bug-fix round (2026-10-15)

**Eight defects found in real-device testing — all of the form "implemented but unusable"**

All 12 v0.13.0 requirements had code written for them, but the original tests were entirely **source-string assertions** (`readSrc` + `toContain`): they only checked that a sentence existed in the code, never that the interaction worked. That is how the eight defects below slipped through. This round converts those tests to **behavioural** ones (build a real view, dispatch real events, apply real transactions) and fixes the root causes.

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | A single click on a table **selected the entire table**; cells could not be selected, so drag-to-merge was impossible | `blockAcceptsCaret` only looked at `table`'s own `content` (`table_row+`, which contains no `inline/text`) → judged "cannot hold a caret" → the click built a whole-table `NodeSelection` | Now judges **container blocks recursively** (`table → table_row → table_cell` is `inline*`); `table-editor.stopEvent` explicitly returns `false` for in-cell clicks so PM places the caret. **Clicking the table's outer edge still selects the whole table** |
| 2 | Math / Mermaid blocks **ignored a single click**; a double click was required | Their editing layer (`contentDOM`) defaults to `display:none`, so PM found no visible editable position. v0.13.0 only made `stopEvent` stop intercepting; it never actually revealed the editing layer | Added `mousedown → enterEditMode + placeCaretInsideBlock`, matching code blocks; also handled the "single click enters edit, then the trailing dblclick exits it again" window (ignored within 600 ms). Double click still switches back to preview |
| 3 | The block's left **drag handle disappeared**, so blocks could not be dragged | The handle was drawn only in the selected state (`.pm-block-selected::after`), and after v0.13.0's "single click to edit" ordinary blocks almost never enter a `NodeSelection`. The generic handle rule also covered only 5 wrapper classes, while `pm-block-wrapper` is **referenced only by CSS — no code ever adds it** | The handle is now `.ProseMirror > *::after`, **covering every top-level block**; the `block-drag` plugin no longer requires a prior `NodeSelection` and instead finds the block by coordinates plus a left-edge hot zone. Also fixed `overflow:hidden` on three wrappers clipping the handle in **hover/active** states |
| 4 | The kebab menu popped up at the **window's top-left corner** | The event was dispatched from the NodeView's container `dom`, so `e.target` was the container → the listener's `closest(".block-kebab")` returned `null` → the anchor degraded to `(0,4)` | The event is now dispatched **from the button itself**, carrying its rect in `detail.anchor`, so positioning no longer depends on the shape of `e.target` |
| 5 | In the kebab menu, **everything except "Delete block" failed** | Four independent defects: ① move up/down passed the direction `-1/1` as a **document position** to `buildBlockMoveTr` → invalid structure, swallowed by `catch` → silent no-op; ② format painter returned early when the selection was collapsed (`from===to`), and clicking the menu normally leaves only a caret → never worked; ③ copy/paste relied on `navigator.clipboard.read()`, which **WebView2 denies by default** → paste always failed; ④ the menu items' `disabled`/`danger`/`separatorBefore` were **dropped entirely** when mapped to the popup, which also did not support `disabled` | Added `buildBlockMoveByDir` to compute the insert position from the direction; format painter now calls `selectBlockAt` before sampling; added an **in-app clipboard fallback** (copy→paste works even when the system clipboard is unavailable); `MiniContextMenu` now supports and forwards `disabled`/`danger`/separators |
| 6 | The command palette found "Image Manager" but **Enter did nothing**, and there was no visible entry point | `App.tsx`'s `lightmd:command` router had **no** `view.imageManager` branch (only the keyboard path had one) → the event fell through to the format/insert dual dispatch, which does not know that id → silent return. `view.quickOpen` was missing too | Added both `view.imageManager` and `view.quickOpen` to that router; added a **floating top-right entry point** (`ImageManagerButton`) below the AI-translate icon, or below the mode-switch icon when AI translate is off, **shown only when the document actually contains an image** (source mode strips image syntax inside code fences to avoid a false entry). All three floating icons now share one size and centre alignment |
| 7 | Outline heading collapse had **no animation** | Collapsing removed nodes from the DOM outright — an instant disappearance with nothing to transition | Collapsed rows now **stay in the DOM** (`.outline-hidden` collapses `max-height`/`opacity`) with a 420 ms smooth transition, a rotating-arrow cue, and `visibility:hidden` only after the animation (moving hidden rows out of the tab order); respects the system "reduce motion" setting |
| 8 | With no external program touching the file, LightMD still warned "**…was saved in another window; auto-save paused**" | `judgeAutoSaveWrite` used `getLastSelfWritten` (**TTL only 10 seconds**) to decide whether the disk had been changed by a third party, while the default auto-save interval is **60 seconds**. So after "open a file → edit → never save manually", or once 10 seconds had passed since the last save, it returned `null` → it could not prove the disk was untouched → judged `conflict` → skipped auto-save and showed the pause warning | Added a **disk baseline** (`noteDiskBaseline`/`getKnownDiskContent`, long TTL): registered on file open, advanced on every write by this app, and advanced when adopting external content (auto-reload / "take latest"). Disk equal to baseline means **no third-party change**, so writing is safe. Genuine conflicts are still blocked |

**Two notes on defect 8**

- **Reading the disk must not advance the baseline**: the pre-write check itself reads the disk, so if reading advanced the baseline the check would always see "disk === baseline" → always writable → **external edits silently overwritten**. The baseline is therefore advanced only on "file opened" and "this app wrote successfully"; `fileService.readFile` deliberately does not register one (locked by a regression test).
- **Requirements 2 / 3 semantics are preserved**: an external program modifying the currently open document refreshes it immediately (clean tabs auto-reload; dirty tabs prompt or show the three-way dialog per the configured policy); auto-save applies only to documents LightMD has open with unsaved changes; and **with no external modification there is no prompt at all**.

**Quality verification**: frontend **272 files / 4545 cases all passing** (this round adds 38 behavioural regressions in `v0130-fix-round1`); `tsc --noEmit` clean. Three baseline tests that had **pinned the old defects** were also corrected (`v0120-block-drag`'s overflow assertion, `v0130-outline-collapse`'s visible-row counting).

### v0.13.0 (2026-10-14)

**Editing catch-up and data safety — batches 1 + 2** (baseline 0.12.3)

Two user reports drove this batch: "clicking a block always activates the block first, so I have to click a second time before I can edit its contents", and "another program changed my .md file, yet auto-save overwrote it and my content went backwards". Both are fixed here.

**Block interaction (reading mode)**

| Item | Detail |
| --- | --- |
| **One click to edit** | Blocks that **can hold a caret** (code blocks, math blocks, Mermaid, table cells) go straight into editing on a single click — no more "click once to activate the block, click again to edit". Leaf blocks that **cannot hold a caret** (horizontal rules, `[toc]`) still select as a whole block, so Delete and drag still work |
| **Handle and kebab menu stay visible** | While the mouse hovers a block, or the caret/selection is inside it, or the whole block is selected, the drag handle `⋮⋮` on the left and the `⋮` button in the top-right corner **appear together**; they hide when none of those hold. They stay put (no flicker) while you type inside the block |
| **Kebab menu** | The top-right `⋮` opens 8 items: Cut / Copy / Paste / Delete block / Format painter / Select block / Move up / Move down. "Paste" is disabled when the clipboard holds no LightMD block data, and "Move up/down" are disabled on the first/last block |
| **Block-level copy / cut** | Copying a block writes **three** clipboard entries: `text/plain` (the block's Markdown source, for external editors / source mode), `text/html` (rendered HTML, for web pages / Word), and `application/x-lightmd-block` (a LightMD-specific JSON that lets reading-mode paste **restore the original source of unedited blocks exactly**) |
| **Three entries, one core** | The kebab menu, the right-click menu (its block branch gained cut/copy/paste), and the shortcuts (`Ctrl+C`/`Ctrl+X` with a block selected) all share one implementation. **Text selections are always passed through to the browser default**, so ordinary copying is never hijacked |
| **Deleting never empties the document** | If deleting a block would leave the document empty, an empty paragraph is inserted automatically (ProseMirror requires at least one block); cut and delete are each **a single transaction, so one `Ctrl+Z` restores everything** |
| **Failures are never silent** | When the clipboard is unavailable or permission is denied a toast is shown instead of failing silently |

**Data safety (consistent across all three modes)**

| Item | Detail |
| --- | --- |
| **Auto-save no longer overwrites external edits** | Auto-save now **reads the disk once before writing** and applies a three-way check: disk content == our last written content → save normally; disk content == the content about to be written → skip (saves a pointless write); **anything else (a third party changed it) → abandon this auto-save**, flag the tab as externally changed and notify, leaving you to press `Ctrl+S` and choose "Overwrite / Save as". The previous `externallyChanged` flag depended on the watcher event arriving first, and events can be **late or missing** (directory not mounted, mtime dedupe hit, or the Rust callback scheduled after the timer) — which silently reverted external edits |
| **A failed disk read aborts the save** | If the file was deleted or is locked so the read fails, auto-save **never writes** (safety first); the dirty flag stays and your content is still in memory, ready for Save as |
| **External-change policy** | New setting "When a file changes on disk" with three choices (the default preserves the old behaviour): ① reload clean tabs, only notify when there are unsaved edits; ② reload clean tabs and **ask "Take latest / Keep local / Save as" when there are unsaved edits** (honours "prefer the newest version on disk" without silently dropping local edits); ③ ask on every external change |
| **Single files get external updates too** | Opening a file that is not inside any open folder now also mounts that file's **parent directory** as a watcher fallback (using the existing reference count, released automatically at zero). Previously the watcher only watched directories, so such files **never refreshed** when changed externally |
| **Self-saves are not misreported** | Regression-locked with the `selfWriteGuard` content fingerprint: if the disk content equals what this app just wrote, the event is treated as our own save echo and no "changed externally" warning appears |

**Low-risk, high-visibility (batch 2)**

| Item | Detail |
| --- | --- |
| **Image left/center/right alignment** | The image edit dialog gains three alignment buttons. Centering and right alignment are persisted with an `\|align` suffix (`![fig\|center](src)` / `![fig\|300\|center](src)`), the same convention as the existing `\|W` width suffix. **Documents without alignment are byte-identical**; the standard `![alt](src)` syntax stays fully compatible |
| **Code block copy button** | A copy button sits in the code block's top-right corner (left of the language dropdown). Clicking copies the block's plain text (**no line numbers, no language name**); the icon briefly turns into ✓ for 1.5s, and a toast appears if the clipboard is unavailable |
| **`Ctrl+P` quick open** | A new file switcher with three grouped sources (**open tabs first**, then recent files, then workspace files), de-duplicated by path. Subsequence fuzzy matching with scoring (contiguous runs, word starts, position decay) and hit highlighting; ↑↓ to move, Enter to open, Esc to close. Does not interfere with the `Ctrl+Shift+P` command palette |
| **Outline heading collapse** | Every heading with children gets a collapse arrow (▾/▸); clicking hides/shows its deeper levels. Collapse state is **not persisted**; search, filtering and dragging keep working, and **search ignores collapse** so a match is always shown |

**Medium-risk (batch 3)**

| Item | Detail |
| --- | --- |
| **Batch comment across a multi-line selection `Ctrl+/`** | Select several lines (possibly across blocks) in reading mode and press `Ctrl+/` → greyed out with a strikethrough. **With no selection** it toggles the whole current block (Obsidian semantics); press again to uncomment. Serialised as `<!--text-->`, matching source mode. **None of the six export formats include commented content** (HTML/PDF/PNG: browsers ignore comments; DOCX/EPUB/LaTeX: explicitly stripped) |
| **Block-level source markers, completed** | Moving the caret into a **list / task list / horizontal rule / block formula / `[toc]` / Mermaid diagram** shows the matching source marker on the left (`- ` / `1. ` / `1) ` / `- [ ] ` / `- [x] ` / `---` / `$$` / `[toc]` / ` ```mermaid `). Ordered lists show the **real ordinal**; task lists follow the checkbox state. Markers are absolutely-positioned pseudo-elements, so **text geometry never shifts** when the caret enters or leaves (no regression of the v0.12.0 heading jitter). Tables and images are explicitly out of scope |
| **Emoji shortcode completion** | Typing `:` plus letters in reading mode opens a candidate list (data from `markdown-it-emoji`'s full table, ~1900 entries, **lazy-loaded so it stays out of the main bundle**); ↑↓ to move, Enter inserts the `:name:` shortcode (immediately rendered as a glyph while **the file still stores the shortcode** — source stays reversible), Esc to close; more than 50 candidates are truncated with a hint. `::` does not trigger; code blocks do not trigger |
| **Shortcut baseline** | 50 → **52**: new `Ctrl+/` (batch comment) and `Ctrl+P` (quick open file) |

**High-risk (batch 4)**

| Item | Detail |
| --- | --- |
| **Image manager panel** | Open it from the command palette ("Image Manager"); scope is the **current document only**. Two tabs: ① Document images — every image with its reference count (same src merged into one row); ② Unused files — files in `assets/` that are **not referenced by this document**. Three actions: **Move to assets** (external sources are copied into `assets/` next to the document and references rewritten to `assets/<name>`, **the original file is kept**), **Rename** (updates every reference in the document, one transaction = one undo), **Clean unused** (multi-select → confirmation → goes to the recycle bin). Every write registers a self-write fingerprint, so it is **never** misreported as an external change |
| **Table cell merge / split** | **Drag across cells** to draw a rectangle (cells highlight), then click 🔗 in the toolbar or right-click "Merge Cells"; put the caret on a merged cell and click ✂️ or right-click "Split Cell". **Both horizontal (colspan) and vertical (rowspan)** are supported. The on-disk form embeds HTML inside the cell: `\| <td colspan="2">A</td> \| B \|`, and the merge survives reopening.<br>**Plain pipe tables (no merges) round-trip byte-for-byte** (`md → doc → md`) — this is the single most important regression lock for this feature, so merging cannot affect how ordinary tables are stored |
| **Merge safety boundaries** | ① A selection that **partially overlaps** an existing merged cell is rejected with "split it first" (never cuts a span in half); ② merging keeps only the **top-left cell's content** (the covered cells' content is discarded, same as Typora/Word); ③ splitting restores the structure and re-adds placeholder cells (columns do not shift) but cannot restore discarded content; ④ header deletion, column alignment and column-width dragging all keep working on tables that contain merges |
| **Export degradation** | DOCX / LaTeX **strip the `<td>` tags but keep the content** — no literal HTML in the output and not a single character of content lost; the visual merge itself is not carried into Word/LaTeX (a declared non-portable aspect) |

**Quality verification**: frontend **271 files / 4507 tests all pass** (baseline 265/4376). New: `v0130-image-manager` 30 tests (counting truth table + name-collision resolution + difference set), `v0130-image-manager-dialog` 12 tests (real component + Tauri stubs), `v0130-table-grid` 33 tests (grid expansion + placeholder recognition), `v0130-table-merge` 21 tests (**plain-pipe zero-diff regression lock** + round-trips for three table shapes + schema toDOM), `v0130-table-merge-ops` 27 tests (real documents + merge/split/validation transactions), `v0130-table-merge-export` 8 tests (export degradation loses no content); `tsc --noEmit` clean.

**Upgrade notes**: overwrite the install in place; no breaking changes. Two new entry points (the command palette's "Image Manager" and the table toolbar's 🔗/✂️) and **no new shortcuts**. Table serialization is **byte-identical to the previous version for tables without merged cells**; a table with merges is upgraded from plain text to the `<td colspan>` form on its first save, since that is the only carrier for merge information. The image manager is scoped to the **current document** — its "unused" list means "not referenced by this document", not "unused by every document".

**Quality verification**: frontend **265 files / 4376 tests all pass** (baseline 262/4284). New: `v0130-block-clipboard` 24 tests, `v0130-block-interaction` 15 tests (**real `createEditor` mounts**), `v0130-autosave-conflict` 19 tests (driving the real `useAutoSave`), `v0130-external-refresh` 13 tests, `v0130-image-align` 31 tests (schema / serialization / round-trip / dialog), `v0130-code-copy` 7 tests, `v0130-outline-collapse` 19 tests (collapse-stack truth table + RTL component behaviour), `v0130-quick-open` 39 tests (fuzzy-match truth table + component + shortcut registration), `v0130-toggle-comment` 32 tests (including the real-editor `Ctrl+/` path), `v0130-block-markers` 34 tests (marker truth table for 10 block types + real mounts), `v0130-emoji-complete` 26 tests (trigger truth table + lazy filtering + adopt→render→save consistency); `tsc --noEmit` clean.

**Upgrade notes**: overwrite the install in place; no breaking changes. The old habit of "click once to select the whole block, click again to edit" changes — **a single click now edits directly**; to select a whole block use the kebab menu's "Select block", press `Esc`, or double-click. Auto-save behaves exactly as before in normal use (it only abandons the write and notifies when a third-party change is detected on disk). The shortcut count goes 50 → 52 (new `Ctrl+P` and `Ctrl+/`).

### v0.12.3 (2026-10-12)

**Enter = line break — line-break counts now match across the three modes, and line spacing is back to default** (baseline 0.12.2)

Two user reports: ① editing in reading mode and pressing Enter **once** produced an extra blank line after switching to edit/split mode; ② text edited in reading mode had **much looser line spacing** than other documents. Both have the same root cause: Enter in reading mode ran `baseKeymap.splitBlock` (a new paragraph), and Markdown paragraphs must be separated by a blank line.

**Fixes**

| Item                                                     | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phantom blank line in source                             | Inside a **top-level paragraph**, Enter now inserts an **in-paragraph line break** (`hard_break`): one Enter = **one newline** in the source (two adjacent lines, no blank line), two Enters = **one blank line**, N Enters = N newlines — exactly as many line breaks as you see in reading mode. Scope is strictly limited to top-level paragraphs, so lists / task items / quotes / headings / tables / code blocks are unchanged (Enter inside a list still splits the item)                                                                                                                                                |
| Line spacing was loose                                   | The old "new paragraph" behaviour also stacked the `.ProseMirror > p` 0.8em top/bottom margins — measured in headless Chrome the paragraph gap was **41px** against a **28.8px** line height. With an in-paragraph break the spacing returns to the line height (**29px** in the same probe ≈ 28.8px in the source editor), identical across all three modes                                                                                                                                                                                                                                                                    |
| "New paragraph" keeps a one-key entry                    | `Shift+Enter` and `Enter` are **swapped**: inside a top-level paragraph `Shift+Enter` creates a new paragraph (a blank line in the source); lists / quotes / headings keep their original in-paragraph break behaviour. Pressing Enter at the start of a paragraph, or pressing Enter **twice**, also yields a new paragraph                                                                                                                                                                                                                                                                                                    |
| In-paragraph break round-trip (data integrity)           | `hard_break` serialisation now covers the boundaries a two-space break **cannot** express (they lose the break or split the block on re-open): paragraph start, adjacent hard breaks, and table cells → they use `<br>`. **Continuation-line escaping** is restored as well: typing `---`/`===`/`- `/`# `/`> `/` ``` `/`1. ` after a break is no longer hijacked by block rules (previously the paragraph could be swallowed into a Setext heading and literal text lost forever)                                                                                                                                               |
| No more `<br>` for a paragraph-end break (round 2)       | When you have just pressed Enter and not yet typed the next line, a trailing break in a **top-level paragraph** is now written as a two-space hard break — edit/split mode simply shows "one extra newline", with no `<br>` marker (the top-level paragraph also no longer appends its own terminating newline, which would turn `"A  \n"`+`"\n"` into two paragraphs). Trailing breaks inside list items / quotes **still use `<br>`**: those serialisers embed paragraph content into a `- ` / `> ` prefixed line, and an embedded newline splits the block (measured: the list got truncated and a stray paragraph appeared) |
| Line-height setting applies to all three modes (round 2) | The edit-mode textarea's `line-height` used to be **hard-coded to 1.8**, so only the reading pane and the split preview followed the setting; the split iframe is a separate document and **does not inherit CSS variables from the parent**, so its `var(--editor-line-height, 1.8)` always fell back. The textarea now consumes the same variable, and **line height / paragraph spacing / content width** are injected into the iframe's own `:root`. Measured in headless Chrome with the line height set to 2.2: reading / edit / split all report **35.2px** (previously the editor and the split pane stayed at 28.8px)  |

**Quality verification**: frontend **254 files / 4115 tests all pass** (baseline 253/4092); the new `v0123-enter-linebreak` suite (23 cases) drives a **real `createEditor` mount and the real keymap plugin chain** (`someProp("handleKeyDown")`, the same path a browser key event takes) plus real serialisation/re-open assertions — covering 1–4 Enters, trailing breaks (two-space at top level / `<br>` in lists and quotes) and adjacent break round-trips, dangerous continuation lines, marks across a break, list/quote regressions, and the line-height wiring; `tsc --noEmit` clean; `vite build` succeeds.

**Upgrade notes**: overwrite-install, no breaking change. Documents that were already "paragraph-split" with Enter keep their content (their source already has blank lines); only new Enter presses follow the new semantics. To create a real paragraph (a blank line in the source) press `Shift+Enter`, or press Enter twice. **Cost of a paragraph-end break**: if you save/close right after pressing Enter, that trailing empty line does not survive a re-open (Markdown cannot express a paragraph-final hard break — CommonMark and other editors drop it too); press Enter twice or `Shift+Enter` instead if you want it persisted as a real paragraph.


### v0.12.2 (2026-10-12)

**Defect convergence — 9 fixes (1 P0 crash, 2 data-loss/corruption)** (baseline 0.12.1)

Based on the [LightMD 0.12.1 assessment report](../_plan/lightmd-0.12.1-assessment-report.md), this release adds **no new features** — it only converges defects and consistency.

**Fixes**

| Priority               | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 crash**           | **Documents containing emoji shortcodes could not be opened (blank screen)** — the old implementation registered a NodeView for `text` nodes and returned a `<span>`, but ProseMirror requires text nodes to render as DOM text nodes (`RangeError: Text must be rendered as a DOM text node`). Testing further showed a text-node NodeView is *also* unusable: it becomes a `CustomNodeViewDesc`, which does not implement `localPosFromDOM`, so `posAtDOM` degrades (all 15 offsets map to position 1 — clicking anywhere jumps to the paragraph start). Rewritten to use **Decorations**: the shortcode is collapsed with `font-size:0` and the glyph is drawn via `::before`, keeping DOM text length identical to the doc so position mapping stays correct. Also added a `createEditor` try/catch fallback and an app-level ErrorBoundary |
| **Data loss**          | **Image `![alt\|300](src)` width silently erased** — `getRenderMarkdownIt` returned the *shared singleton* from `parser.ts`, and `imageSizePlugin` mutated `token.content` in place. After one preview render or export, PM parsing saw the stripped content, so `width` became `null`; editing that block then **permanently lost the width** on save. Now uses a dedicated instance, fully isolated from PM parsing                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Data corruption**    | **Continuation lines after an in-paragraph break hijacked by block constructs** — typing `---`/`===` after `Shift+Enter` **swallowed the paragraph into a Setext heading** and lost literal text; `- `/`+ `/`* `/`1. `/`# `/`> `/`~~~`/`[^1]:` split the paragraph into lists/headings/quotes. This release briefly added continuation-line escaping, but it was **reverted together with the Enter-semantics change** (the result did not meet expectations) — behaviour is back to what it was before v0.12.1. **As of v0.12.3 the escaping is restored together with Enter = in-paragraph break** (see the v0.12.3 section)                                                                                                                                                                                                                  |
| Enter semantics        | **Enter on a cross-block selection no longer merges paragraphs** (added the missing empty-selection guard). Enter/Shift+Enter semantics are unchanged from before v0.12.1 — the v0.12.1 change was reverted in this release. **v0.12.3 re-introduces it in a more complete form**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Source noise           | **`$` and `==` now use real pairing detection** — `价格 $100` is no longer saved as `价格 \$100`, nor `a == b` as `a \=\= b`, while genuine formula/highlight pairs are still escaped (same rule as the previously fixed `~`/`^`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Anchor mismatch        | **Heading `id` is recomputed on rename** — new `heading-id-sync` plugin (appendTransaction, O(headings)) re-derives ids with the parser's own slugify + dedup rule, so `[toc]` and `#anchor` links no longer break                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Split geometry         | **Split pane was double-zoomed and clamped** — the iframe reused the `.ProseMirror` class and inherited both `zoom: var(--doc-zoom)` (multiplying with the inner body zoom: 200% rendered ~400%) and `max-width:860px; margin:0 auto` (overriding the inline width and centring it). Now explicitly reset; zoom and width are owned solely by the inner document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Three-mode consistency | **Focus retention completed + progress fixed** — ① the split iframe previously took no part in typography anchor compensation (focus was lost on the right when adjusting line-height/paragraph-spacing/content-width), now wired to the same block-anchor mechanism; ② the status-bar reading percentage previously measured only the `display:none` reading container, so it always showed 100% in split mode — it now selects the real scroll container per mode                                                                                                                                                                                                                                                                                                                                                                             |
| Export consistency     | **Export styling follows app settings** — HTML/PDF/PNG font size, line height, paragraph spacing, content width and font family now come from settings (previously hard-coded 16px/1.8/860px); also corrected the `includeCSS` comment/implementation mismatch and clarified the contract: `@page` and header/footer are structural and always injected; `includeCSS` controls content typography only                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| i18n                   | Added English for the table toolbar disabled hint and Mermaid empty/syntax-error hints (previously hard-coded Chinese)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Quality verification**: frontend **253 files / 4092 tests all pass** (`v0122-convergence` adds **behavioural** assertions for P1/P2/P5/P6/P7/P8/P9 — real `createEditor` mounts, real edit→save→reopen round-trips, real render pipeline — not pure functions or source-text regex; 2 legacy assertions adapted); `tsc --noEmit` clean.

**Known scope**: per request, P4 (`pairTabOut` winning Tab inside table cells) is **not** changed — it was confirmed to be the desired behaviour. DOCX/EPUB/LaTeX still have no style-customisation entry (PDF does); that is an unimplemented feature, not a defect.




### v0.12.1 (2026-10-09, round 2 on 2026-10-10)

**Heading-level badge / auto-pair rewritten / edit-mode scrollbar at the far right / folder animation 50% slower** (baseline 0.12.0)

#### Round 2 (2026-10-10): 11 experience fixes

**New capabilities**

- **Two task-list icons** — square / circle checkboxes: pick one from the toolbar `☑` dropdown; in reading mode each task item shows a **light `::` handle** on the left that opens the same picker. A circle item is written as `* [ ] ` (still a standard task-list item, other editors are unaffected). The **format painter** also carries the style over (source mode rewrites the prefix, reading mode updates the node attribute)
- **Live typography preview** — dragging font size / family / line height / paragraph spacing / content width in Settings updates the document **immediately** (a non-persisted preview store; nothing is written to localStorage and no cross-window broadcast is sent while dragging). Save commits; Cancel / `✕` / Esc restores instantly
- **Frosted settings panel + focus preservation while dragging** — the panel background becomes translucent with a backdrop blur while you drag a typography slider: **85% transparent** (panel alpha 0.15) with sliders and text staying crisp. The **reading focus is preserved** by the same anchor mechanism used for window/sidebar resizing: the block anchor (reading mode), the textarea content anchor (edit / split left) and the split iframe anchor are measured *before* the CSS variables are written and compensated *immediately after*, inside one `useLayoutEffect`. Measured drift across the four sliders: ≤0.3px
- **Back to reading from edit mode** — edit mode now also shows the floating **book** button (reading = quill, split/edit = book)

**Fixes**

- **Heading badge alignment / wrapping** — the badge is now centred on the heading line (`top:50%` + `translateY(-50%)`; it used to sit 7px too high) and can no longer break `H1` into two lines: `clamp(9px,0.42em,13px)` sizing, a roomy box and `white-space:nowrap` replace the old `min-width:1.7em` rule that could not fit a 600-weight `H1`
- **Outline now follows the level** — the outline's heading de-duplication key includes `level` (it used to be `pos:text` only, so changing the level through the badge left `pos`/`text` unchanged and the outline never re-rendered)
- **Images no longer vanish after switching documents** — the global document path is synced from `filePath` right before the content is parsed (once in the file-switch effect, once on first mount, plus a third safety net in the App tab switch): child effects run before parent effects, so the old code resolved image paths against the *previous* document's folder
- **Task checkbox alignment** — the first paragraph inside a task item has its top margin zeroed (the paragraph-spacing rule used to push it 13–14px down) and the checkbox is drawn by hand and centred on the first line box (computed from line-height × font-size) instead of a hard-coded `margin-top:5px`
- **Getting out of a code block** — (1) block selection now calls `view.focus()` (the `preventDefault` swallowed the browser's auto-focus, leaving `activeElement` on `BODY`, so no key ever reached the editor); (2) a new `ArrowRight` command exits to the next block when the whole block is selected or the caret is at the end of its content, creating a paragraph when the block is the last one
- **Enter semantics restored** — the v0.12.1 change (Enter = in-paragraph break, Shift+Enter = new paragraph) was **reverted in 0.12.2**: `Enter` again creates a new paragraph and `Shift+Enter` inserts a hard line break; lists, quotes, headings and tables keep their original behaviour. The cross-block-selection guard from this release is kept. (**v0.12.3 restores the in-paragraph-break semantics, with the source/appearance issues fixed** — see the v0.12.3 section)
- **Settings animations** — opening slides in from **off-screen above** (`translateY(calc(-50vh - 50%))`) and overshoots to +14px before settling (jelly bounce, 640 ms); closing presses down +14px ("wind-up") and then **purely translates** out of the viewport over 520 ms (`SETTINGS_CLOSE_MS` 180 → 540). Second-round revision per user feedback: **the panel itself no longer fades** (it used to move and fade out at the same time) — brightness is handled only by the scrim, which is now **delayed by 200 ms** so it fades after the panel has slid away
- **Format painter icon** — redrawn as a recognisable little paint brush (handle + ferrule + tapered bristles)

**Verification**: **252 files / 4065 tests** pass (new `v0121-round2-requests` with 45 contract + runtime cases — including the second-round animation-purity, transparency and focus-anchor wiring assertions — and `v0121-image-doc-switch` with 3 regression cases that provably fail without the fix; 3 older assertions updated); `tsc --noEmit` clean; `vite build` succeeds; on the packaged app driven through WebView2 CDP **20/20 checks PASS** (`scripts/real-machine-v0121-round2.mjs`): images still render (`naturalWidth=565`) after switching away and back, badge centre offset 0px with a single text line box, outline padding 12px → 40px, checkbox alignment off by 0.4px, handle → circle writes `* [ ]`, ArrowRight leaves the code block into a new paragraph, `Enter` produces `<br>` with no blank line in the source, the edit-mode book button returns to reading mode, open animation `-1252.8 → +14 → 0`, close animation `+14 → -1252.8`, dragging the font size 16px → 25px with `blur(12px)` and `alpha=0.15` (85% transparent), cancel rolls back to 16px, **panel opacity stays exactly 1 throughout (pure translation, no fade)**, and the anchored paragraph drifts by only 0 / 0 / +0.1 / -0.3px while dragging the four typography sliders

**Heading-level badge / auto-pair rewritten / edit-mode scrollbar at the far right / folder animation 50% slower** (baseline 0.12.0)

- **Heading-level badge (H1–H6)** — headings no longer show the `#` syntax marker; a clickable `H1`/`H2`… badge appears instead (absolutely positioned, still zero layout shift). Clicking it opens an **H1–H6** level menu (200 ms smooth expand animation, current level highlighted, equivalent `#` syntax shown, `prefers-reduced-motion` respected). Changing the level is a single transaction that keeps the heading text and anchor `id`; typing `#` characters still changes the level as before
- **Auto-pair rewritten** — a single rule source (`core/autoPairRules.ts`, pure functions) plus a textarea planner now drive **all three modes** (reading / edit / split) identically: auto-close pairs, type-over an existing closer, surround a selection, delete a pair with Backspace, `Tab` to jump out, and close a pair after an IME composition commits. A pair insertion is **one edit = one undo**
- **Pair scope settings** — three new switches (brackets / quotes / CJK punctuation) so quotes can be disabled while brackets stay on
- **No more false completions** — mid-word (`abc|def`), right before an existing closer, orphan closers, English apostrophes (`don't`), escaped characters (`\(`), code blocks / inline code / math, and active IME composition are all left alone
- **Edit-mode scrollbar at the far right** — the scrollable area is now the whole editing region (matching reading mode); the text column stays pixel-identical to the previous version
- **Folder animation 50% slower again** — expand 0.675s → 1.013s, collapse 0.63s → 0.945s

### v0.12.0 (2026-10-08)

**Reading & editing experience — 11 requirements**

- **Document zoom** — `Ctrl+wheel` or the bottom-right zoom ruler (appears on hover; push up to zoom in, pull down to zoom out; click a tick to jump, draggable) works in reading / edit / split modes, 50%–200%, persisted across restarts
- **Format Painter (all three modes)** — via the new reading-mode context menu or the toolbar brush button: single-click entry applies once (Word default), **double-click entry stays active** for repeated application (status-bar hint with remaining count, auto-exit at zero, `Esc` to quit); overwrite-style apply (clears then applies, never stacks); works across modes
- **Block selection & mouse drag** — in reading mode click a code block / Mermaid diagram / math block / table to select the whole block (`outline` border), `Delete` or right-click "Delete XX" to remove it; drag from the `⋮⋮` handle at the block's left edge to reorder blocks (insertion indicator line shown), one `Ctrl+Z` restores everything
- **Placeholder ghost text** — clicking Bold/Heading with no selection inserts only the syntax markers (`****`, `# `); the placeholder word appears as grey ghost text and is replaced as soon as you type — never written to the file
- **Viewport focus kept on resize** — collapsing the sidebar, dragging the window / split divider, or toggling the outline pane keeps the first visible paragraph at the same screen position (including the split-preview iframe)
- **3-line focus window** — focus mode in edit / split modes highlights previous / current / next line
- **No heading-marker jitter** — source markers (`#`, `>`, ```` ``` ````) are now absolutely positioned, so text never shifts horizontally
- **"Open Files" creation time** — grey `YYYY-MM-DD HH:mm` on the right of each entry (temp files keep their timestamp across restarts)
- **"About LightMD" in settings** — shows the app version and the GitHub link (opens in the system browser)
- **Folder expand animation 50% slower** (0.45s → 0.675s)

### v0.11.0 (2026-10-07)

**Defect-convergence release — 42 fixes and additions**

- **Data safety**: `Shift+Enter` inside code / math blocks no longer splits the block and rewrites content to disk; table "delete row" on the header row no longer loses data; Typora-style image sizing `![alt|300](src)` now works in split preview and all export formats
- **Export fidelity**: exported HTML is truly self-contained (KaTeX fully inlined, mermaid side-loaded to `_assets/`) and works offline; PDF header/footer present on every page and no longer leaks temp paths; DOCX no longer silently drops task lists / definition lists / images / list numbering / formulas; PNG export embeds formula fonts correctly
- **Reading experience**: image lightbox in reading mode (zoom / navigate / `Esc`); typography settings (content width / line height / paragraph spacing) now take effect; reading progress in the status bar; heading anchors work in reading mode; `[toc]` updates live; emoji short codes render as graphics
- **Editing consistency**: command palette gains 7 missing format commands; `Ctrl+Shift+8/9/.` work in source mode; `Alt+↑/↓` is now a real block move (old semantics moved to `Alt+Shift+↑/↓`); `~`/`^` only escape when a pair can actually form

### v0.10.0 (2026-10-07)

**Unified rendering & export**

- **Unified render pipeline** — split preview and all export formats share one markdown-it config: straight quotes are no longer rewritten to curly quotes; `javascript:` and other dangerous schemes are blocked in every export path (security fix)
- **Formula & diagram fidelity in exports** — PNG / DOCX / ePub render KaTeX math (native MathML in ePub) and Mermaid diagrams as vector graphics; per-item progress during export
- **Regex search & replace** — `.*` toggle for regex matching, `$1` / `$&` capture-group references, invalid regex reported inline
- **Outline limit 100 → 1000**; PDF export hardened (longer virtual-time budget, clearer browser errors)

### v0.9.5 (2026-10-02)

**Correctness & performance wrap-up + six usability fixes** (baseline 0.9.4)

- **Lossless content model for task items and footnotes** — nested lists / multiple paragraphs / code blocks inside a task item are no longer flattened; multi-paragraph footnotes keep their structure; both are directly editable
- **Focus mode & Mermaid performance** — decoration set cached in plugin state (O(1) large-document check, local-only recalculation), so typing in 100k-character documents no longer stutters; Mermaid renders are cache-hit by content, so unrelated operations no longer trigger a full re-render
- **Fixes**: the file tree now shows a file immediately after "Save As"; syntax highlighting switches instantly after saving a scratch file as `.py`; clicking links inside a document opens the target file / scrolls to the anchor / hands external links to the browser; pasted images in scratch files render after a restart; split preview no longer shows the previous document; the Favorites / Recent panels sit flush under "Open Files" while keeping their headers; startup restore no longer revives manually closed tabs and no longer toasts red errors for deleted files

### v0.9.4 (2026-10-01)

**Display & paste catch-up** (baseline 0.9.3)

- **Inline syntax markers** — moving the caret into bold / italic / strikethrough / highlight / sub / sup / underline / inline code / link reveals the surrounding Markdown symbols, and hides when you leave
- **Markdown-aware paste** — rich text is converted back to real structure; plain text with ≥2 Markdown traits is parsed as Markdown; inside code blocks / math everything stays literal (toggleable in settings)
- **Undo history across modes** — no more empty undo steps, no more wrongly cleared history, and an explicit "undo boundary" notice in source mode
- **Code block language dropdown & wrap toggle** — switch language from the block corner and re-highlight instantly; highlight languages 27 → 34

### v0.9.3 (2026-10-01)

**Input & formatting catch-up** (baseline 0.9.2)

- **Underline** — `Ctrl+U` toggles for real in preview mode; source mode inserts `<u></u>`
- **Six input rules (type-to-see)** — `$math$`, `$$`, `[text](url)`, `![alt|300](src)`, `[^1]` / `[^1]:`, `[toc]`, and two-line table syntax all convert as you type
- **Minimal HTML whitelist** — `<u>` `<br>` `<sub>` `<sup>` `<mark>` become real formatting; other inline tags are stripped but keep their text; block-level HTML stays literal
- **Image experience** — `![alt|300](src)` width syntax, alt/width fields in the image dialog, drop-point insertion
- **`Ctrl+Shift+K`** inserts a link

### v0.9.2 (2026-10-01)

**P0 editing defects cleared + title bar & sidebar polish** (baseline 0.9.1)

- **Format commands in preview mode were fakes** — the toolbar / palette inserted literal `****`, `## `; they now run the same real commands as the shortcuts
- **Tab now works in code blocks, task lists and tables** — cell-by-cell navigation (last cell appends a row), 2-space indent in code blocks, task nesting
- **`---` and triple-backtick fences inside list items / quotes no longer mis-convert** — conversion only triggers at the start of a top-level paragraph / heading
- **Table context menu i18n + header rows can no longer be deleted**; IME composing Backspace no longer deletes paired symbols
- **Paragraph-break setting** — GFM (soft break, default) vs CommonMark (two trailing spaces), honoured across preview and all exports; **"Recent" is collapsed by default**; the title-bar filename is now centred in the whole title bar

### v0.9.0 (2026-09-30)

**Peer multi-window + custom keyboard shortcuts** (baseline 0.8.5)

**Multi-window**

- **Peer windows (up to 8)** — `Ctrl+Shift+N` / the title-bar "Window" menu / the command palette create a window; each window owns its tab set, editor state, scroll progress and AI chat window, while theme, font, sidebar width, AI config, recent files and favourites sync live across all windows
- **Open in a new window** — file-tree / sidebar context menu, tab "Move to New Window" (scratch tabs migrate with their content), `Ctrl+Alt+O`, and external double-click routing (current window / new window / ask, default current window)
- **Title-bar "Window" menu** — dynamic window list with each window's tabs (unsaved dot), "New Window", "Close Window", "Merge into Main Window"
- **Conflict detection** — opening a file already open with unsaved changes elsewhere offers read-only / force-edit / switch-to-that-window / cancel; read-only tabs show `[read-only]`
- **External changes & deletion** — clean tabs reload automatically with a notice; dirty tabs are flagged and confirmed on save; deleting a file closes its tab
- **Session restore** — windows, tabs, active tab and opened folders are restored precisely after a restart

**Custom keyboard shortcuts**

- **Settings → Editor → Customize Shortcuts** — 48 customizable commands grouped by File / Edit / Format / View / Tabs / Window / Insert, with search. Click an entry and press the new combination; `Esc` cancels and `Backspace` clears a single binding
- **Conflict protection** — a conflict with another command or a reserved key reports "Already used by X" and is not written; letters/digits require `Ctrl` or `Alt` (`F1`~`F12` may be bound bare); system keys such as `Alt+F4` are accepted with a warning
- **Restore** — per-entry ↺ restore (refused with the current owner if that default key is taken, which used to create a permanently unreachable duplicate) and "Restore All Defaults" with confirmation
- **Immediate effect + cross-window sync** — shortcut labels in the command palette, context menu, title-bar window menu and toolbar tooltips follow your changes
- **Reserved keys are not customizable** — `F11`, the file-tree keys, editor behaviour keys and clipboard shortcuts
- **Companion features** — `Ctrl+Alt+←` / `Ctrl+Alt+→` sidebar & outline, `Ctrl+Shift+B` tab bar, `F11` full screen (also in the command palette), `Ctrl+Alt+T` table, `Ctrl+T` task list, `Ctrl+Shift+C` merge into main window
- **Interaction changes** — the double-`Ctrl` / double-`Shift` threshold is now **220 ms** (was 300 ms); the file-tree "close temporary file" key is `Backspace` (was `Ctrl+2`); strikethrough in preview mode is now `Ctrl+Alt+S` (the old `Ctrl+Shift+S` is gone)

**Code review fixes (round 6)**

- Conflict messages no longer render stray braces (i18n placeholder syntax)
- The shortcuts dialog now follows the active theme (it was unreadable in dark/night themes)
- Restoring a single binding can no longer create a duplicate, unreachable shortcut
- `Ctrl+Alt+←/→` and `Ctrl+Shift+B` now work while the editor has focus
- Corrupted persisted shortcut tables are sanitized on both the migrate and merge paths
- `AltGr` layouts no longer treat `AltGr+S` as `Ctrl+Alt+S`; non-Latin layouts keep `Ctrl+S` for save
- `F11` uses the Tauri window API (the DOM Fullscreen API does not fullscreen the window under WebView2)
- The editor context menu and command palette now relabel shortcuts immediately after a rebind

### v0.8.5 (2026-09-26)

**Safer deletion / UI motion polish** (baseline 0.8.4; 8 additions and fixes)

**New Features**

- **Recycle Bin deletion** — deleting files / folders from the file tree no longer removes them permanently; they are moved to the system Recycle Bin and can be restored anytime; the delete confirmation message was updated accordingly
- **"Recent" now includes folders** — the Recent list shows recently opened files and folders side by side; clicking a folder entry opens it as a folder panel

**UI Improvements**

- **File icons** — Markdown files keep the 📝 icon; entries in the "Open Files" panel now use a hand-drawn open-book icon (blue for real files, yellow for unsaved scratch files) so the two kinds of entries are distinguishable at a glance
- **File tree search box animation** — the search box slides in from the left (220ms) and collapses back to the left (180ms); clicks during the collapse are ignored
- **Sort dropdown animation** — the sort menu in folder headers now expands / collapses smoothly, with all three close paths (click outside / click an item / click the button again) running the collapse animation
- **New-item dialog transition** — the New Folder / New File dialogs rise and settle with a slight scale; the dialog is fully opaque from the very first frame, so the background can never flicker through it
- **Status-bar search panel open / close animation** — the search window grows smoothly out of the status-bar search button (it starts flush against the button, squashed and narrowed towards it, then expands into the middle of the screen); closing flattens it back into the same button. The direction follows the panel's current position, and it degrades to a plain show/hide when the system "reduce motion" preference is on

**Interaction Changes**

- **Global refresh button removed from the file-management toolbar** — refresh is now available via the right-click "Refresh" menu and the `Ctrl+R` shortcut; external changes still sync into the tree automatically, with `Ctrl+R` as a fallback
- **"Recent" is now a pure history list** — closing a file or folder no longer removes its entry; an entry is only marked with ⚠ when the file was moved or deleted (including external changes) and is **never removed automatically**. Folders restored at startup now use a separate session snapshot, fully decoupled from the Recent history (older data migrates automatically)
- **New-item dialog background flicker fixed** — the dialog's entrance is carried by `transform` alone (opaque from the first frame) and the overlay fade moved to its own pseudo-element layer, so the background no longer flickers through the dialog and the whole-screen brightness jump is gone

### v0.8.4 (2026-09-24)

**Sidebar file tree milestone: drag system / manual ordering / live refresh** (baseline 0.8.3; 11 additions and fixes)

**New Features**

- **File / folder drag-to-copy and move** — dragging onto a folder **copies**; hold `Shift` to **move** (tab paths follow automatically); works for folders too; moving **across drives** is supported (automatically performed as "copy to target + delete source"); dropping into its own subfolder is rejected with a notice
- **Same-folder drag reordering** — drag items up/down within the same folder to set a manual display order that survives restart; "Opened Files" panel entries land in the source file's folder and participate in the same reordering
- **Copy / cut in the node context menu** — new "Copy / Cut" items in the file tree context menu, working with the existing paste for cross-folder copy & move
- **Empty-area context menu** — right-clicking the tree's empty area offers: New File / New Folder / Refresh / Paste
- **Centered New File dialog** — type a name to create: name clashes are avoided automatically (numbered suffix), a missing extension gets `.md` appended; the parent folder expands and the new file opens right away
- **6 sort modes in the folder header** — each folder header gains a sort button: name / modified time / created time × ascending / descending (6 modes), **remembered per folder** across restarts; switching to manual order shows a notice

**Changes**

- **Live file tree refresh** — external additions / deletions / renames / modifications (e.g. from Explorer) sync into the tree automatically (notify watcher); the header refresh button is removed, with right-click "Refresh" / toolbar button / `Ctrl+R` as fallbacks; explicit notices when the watcher is unavailable or a folder was deleted externally; right-clicking "Refresh" on a deep subfolder refreshes only its own subtree
- **Verticalized expand/collapse animation** — child items now enter/exit top-down (vertical height animation) instead of sliding horizontally, matching the expansion direction
- **Outline hover search** — hovering the outline panel reveals a search box for quick filtering and jumping to headings
- **Stale hint in Recent** — when an open file is moved, its old-path entry in "Recent" shows a light-yellow ⚠ marker; favorites update their path in place and are unaffected

**Legacy Fixes (S1 / S2 / S7)**

- **S1 deep-file location lost folders** — opening a deeply nested file expanded ancestors by only writing the expanded set without loading intermediate levels, leaving them empty; now levels are loaded step by step
- **S2 lagging expanded-paths ref** — expansion was synced to the ref only via `useEffect`, so an immediately following refresh missed the newly expanded folders; state and ref are now written in sync (also fixes new-folder / new-file / paste flows)
- **S7 wrong refresh scope** — right-clicking "Refresh" on a deep subfolder refreshed the root; it now targets the clicked folder's own path and refreshes only its subtree

**Other**

- Version bumped in all four places: `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`

### v0.8.3 (2026-09-22)

**Interaction polish, bug fixes & small features** (baseline 0.8.2; 7 additions and fixes)

**New features**

- **Live cursor line/column in the status bar** — shows `Line N Col M`; when text is selected it appends `N selected` (and disappears again on deselect). Works in both reading mode (ProseMirror) and source mode (textarea)
- **Window size memory** — a fresh install still starts maximized; after that, closing the app in a smaller window reopens it at the same size and position (multi-monitor positions included). Uses the official `tauri-plugin-window-state`, with the state flags narrowed to size / position / maximized only, so an accidental fullscreen never sticks
- **Reading position remembered across sessions** — scroll to the middle of a document, close the app, reopen: the restored document is back at the same position. Other restored documents and unsaved (untitled) tabs are remembered too. Positions are keyed per tab and flushed on a 5-second heartbeat plus window close, adding zero cost to the scroll path

**Changes**

- **"Recent" list expanded to 66 entries + shows the opened date** — the UI used to show only the first 10; it now renders the full list with in-panel scrolling, newest on top, and drops the oldest once past 66. Hovering an entry shows the full path plus `Last opened: YYYY/MM/DD HH:mm`
- **Startup restore activates the tab you actually left active** — the restore flow used to hardcode "activate the first real file", so leaving an **untitled** document active forced a switch to a real file on restart (users saw this as "restore doesn't work for untitled files"). It now resolves the last active tab (untitled by id, real files by path) and falls back to the old logic when no record exists

**Fixes**

- **Double highlight in the "Open Files" panel** — after clicking entry A in the panel and switching to B from the tab bar, A's leftover keyboard-selection background and B's active background both lit up (they shared the same colour). The keyboard selection now expires when the active entry changes (the "clicked it myself" case is preserved so `Delete`/`Ctrl+2` still targets A), and the keyboard indicator changed from a same-colour background to a **2px accent bar on the left** — no state combination can produce two highlighted rows again
- **Status bar line number was always 1** — the old formula `doc.textBetween(0, pos).split("\n").length` never gets block separators from `textBetween`, so ordinary Markdown documents always reported line 1. Line numbers are now computed structurally (one line per block, one per hard break inside a block, one per table row) and no longer concatenate the text before the cursor

**Performance**

- **No more full-document serialization on every selection change** — each cursor move/keystroke used to run `doc.textContent`; it is now lazy and runs once inside the 300ms word-count debounce. Measured on an 18k-line (660k character) document: **0.778ms → 0.072ms** per selection change (~1/11)
- **Lazy image loading** — image nodes emit `loading="lazy"` + `decoding="async"`, so large decodes no longer block compositor frames
- **All scroll listeners are `passive`**
- **Scroll performance evaluation (requirement 7)** — measured with real Chromium on an 18k-line / 9000 top-level-block document: the baseline scrolls at avg **16.67ms (60fps, zero long tasks)**, so the bottleneck is neither the Tauri/WebView2 layer nor "the whole DOM". The planned `content-visibility: auto` approach actually **slowed scrolling to avg 70.4ms (14fps, one ~70ms long task per frame)** — thousands of top-level blocks keep being lazily laid out while scrolling, and estimated intrinsic sizes diverging from real heights (scrollHeight inflated by 36%) triggers wide reflow. **The approach was rejected**; the data and reasoning live in the CSS comments so nobody re-adds it blindly

### v0.8.2 (2026-09-21)

**Sidebar open/close animations, ordering & follow-up fixes** (baseline 0.8.1; 3 animation improvements + 2 ordering changes + 9 fixes)

**Animation**

- **Opening slides in smoothly from left to right** — opening a folder panel, expanding a directory inside the tree, or opening a file entry now all slide in from the left while their height expands, gently pushing the content below downwards
- **Closing is now strictly sequential** — slide out horizontally first, **pause a beat**, then collapse the height so the items/panels below glide upwards to fill the gap. This fixes the flaw where the slide-out and the fill-up appeared to happen at the same time (root cause: the closing snapshot was unmounted after only 360 ms while the full sequence needs 960 ms)
- **Closing a middle item keeps it in place** — when a middle folder panel or file entry closes, its slide-out block stays at its original position and the content below moves up to fill the gap, instead of jumping to the end of the list
- **New expand/collapse animation for tree nodes** — expanding a directory slides its children in from the left and expands the height; collapsing slides them out first and then collapses the height. The animation container is keyed by folder path, so parent re-renders cannot interrupt it

**Ordering**

- **Newest opened folder panel goes first** — a newly opened folder is inserted at the top (when the 5-folder limit is exceeded, the least recently opened one is dropped)
- **"Open files" entries move to the top only when newly opened** — a newly opened file goes first; clicking to switch between already-open files no longer re-orders the list (only the active highlight changes)

**Fixes**

- **Clicking a subfolder froze the app** — root cause: the tree-node animation container called `setState` **during render**, so expanding a folder that contains subdirectories triggered a "render → setState → render" infinite loop; React then threw `Too many re-renders` and the whole sidebar was unmounted. State updates now happen inside effects. **This crash was also the root cause of "the sidebar sometimes cannot be dragged" and "images do not render for files opened through a folder"** (an unmounted sidebar cannot be dragged and its tree no longer responds)
- **"New > New Folder" in the menu did nothing** — the old implementation used a native `prompt()` plus a save dialog: not an in-app dialog, and it could not choose a target path. It now opens the in-app **New Folder dialog** (centered; enter a name and either tick an open folder or type a custom path)
- **Sidebar occasionally not draggable** — resolved by the crash fix above; the drag fallbacks (clearing listeners and the `section-dragging` flag when buttons are released or the window loses focus) remain in place
- Fixed collapsed directories losing their cached children when a folder was reopened, which left the collapse animation with nothing to render
- Fixed the "Open files" panel getting out of sync with the open tabs (count and active highlight)
- Fixed the "Open files" panel header structure not matching the new styling
- Fixed the closing folder snapshot being unmounted too early (360 ms → the full 960 ms sequence)
- Version bumped in all three places: `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`

### v0.8.1 (2026-09-19)

**Detail & interaction polish** (baseline 0.8.0; 6 improvements)

- **Native title bar removed** — the window is now frameless; minimize / maximize / close moved next to the Settings button at the top right, styled as macOS traffic lights (yellow / green / red) with symbols appearing on hover
- **Starts maximized** — opens maximized (taskbar kept); restore size is 1200×800
- **Thinner sidebar scrollbars** — both side panels (file tree / outline) now use a uniform **2px** scrollbar: transparent when idle, softly visible on panel hover
- **Default panel widths +0.5 cm** — sidebar 260 → 279px, outline 240 → 259px (custom widths are preserved)
- **File properties use an in-app dialog** — no more native system popups, eliminating the alert sound; values such as paths are selectable
- **Smooth re-centering when the AI entry is pinned** — with "Fixed" enabled the AI drawer takes up layout space, so the status bar buttons glide into a re-centered position without covering the word count

### v0.8.0 (2026-09-18)

**Deep interaction & editing-experience polish** (baseline 0.7.5; 16 requested items/fixes, plus pre-release review fixes and three rounds of follow-up feedback fixes)

**New features**

- **Untitled scratch tabs** — `Ctrl+N` or double-click the empty tab-bar area; nothing hits the disk until the first save, and unsaved scratch tabs survive a restart
- **Tab bar upgrades** — overflow scroll buttons + smooth wheel scrolling, tab pinning with a pin icon, and a 9-item context menu (Rename / Pin / Print / Save As / Close Others / Close Others Except Pinned / Close to the Left / Close to the Right / Close Unmodified)
- **File tree copy / cut / paste / drag** — via the context menu or `Ctrl+C` / `Ctrl+V`; drag onto a folder copies, `Shift`+drag moves and updates tab paths; clashing names get " - Copy"
- **New folder dialog** — multiple target folders plus a custom path (takes priority), with a per-item failure report
- **Open containing folder as workspace** — from the tab/file/recent-item context menu
- **Redesigned sidebar layout** — section headers resize with conserved neighbouring heights and can be dragged to the bottom; floating scroll arrows; slimmer scrollbar
- **Export ePub / LaTeX** — ePub splits chapters by heading and bundles images; LaTeX emits a compilable ctexart + XeLaTeX source

**Fixes**

- **Line-break fidelity (data correctness)** — multi-paragraph list items, nested lists and indented code blocks no longer merge or vanish across mode switches and saves; `Shift+Enter` inside table cells now serializes as `<br>` and no longer corrupts the table
- **CJK punctuation pairing + paired deletion** — new `「」『』《》【】（）` pairs, `Backspace` deletes both halves and skips inline code / math, and typing a closer next to an existing one only moves the caret
- **Typewriter mode centers immediately**; **mode-switch anchor** keeps the same editing position across preview/source/split
- **Deleting a file closes its tabs** (recursive for parent folders); **tab hover close-button jitter** fixed
- **Startup race** — scratch tabs no longer steal activation from the last opened file
- **Shortcut scope fixes** — `Ctrl+C` / `Ctrl+V` only act inside the sidebar tree and no longer hijack text copying; version snapshot moved to `Ctrl+Alt+V` (the old `Ctrl+Shift+V` clashed with paste); `Shift`+dragging a file into its own folder no longer renames it
- **Printing** — switches to preview mode and waits for render, so it no longer prints the previous tab or a truncated source view
- **ePub** chapter XHTML is normalized (`<br>` / `<img>` / `<hr>` / `<input>` self-close correctly, so strict readers can open it)
- Plus assorted polish: cut in the "Open Files" list, unsaved content preserved when switching files, sidebar toasts anchored next to the sidebar, and more

### v0.7.5 (2026-09-13)

**AI chat window and floating-bubble system** (baseline 0.7.4):

**AI chat floating window (`Ctrl+K`)**
- One window, three entry points: the "AI Chat" button in the status-bar AI drawer, `Ctrl+K` (`Cmd+K` on macOS), and the new "问" selection bubble; `ai.chat` is also registered in the command palette
- Hand-rolled lightweight floating layer: drag by the title bar, resize from the bottom-right corner (min 360×280), `[—]` collapses to an input strip, `[×]`/`Esc` closes; closing clears the session (no chat persistence in this release)
- Multi-turn chat: the last 3 turns are carried (older turns dropped, history always starts with a user message) and the document context is attached only to the current turn, so token cost does not grow linearly with turns
- Context chip cycles through three scopes: `Selection 128 chars` / `Document 5,231 chars` / `No context`; a lost selection degrades to the document (shown explicitly), and documents over 20,000 chars are truncated with a marker
- Six quick templates (Diagram / Formula / Summary / Title & tags / Rewrite all / Analyze) prefill the input box for editing before sending
- Per-answer action bar: Insert at cursor / Replace selection (only when a selection was captured) / Replace document (rewrite template or right-click) / Copy / Regenerate
- **What you insert is what you see**: ```mermaid fences and `$$` formulas produced by the model render immediately through the existing mermaid/math live-preview plugins — no extra rendering code
- Safety chain: writes always use the **snapshot taken at send time** (never the live selection) to prevent misplacement; "Replace document" runs a DOC_CHANGED check and refuses when the document was edited during the chat; `Esc` restores the original text after a write
- Window position/size memory: persisted on drag/resize end, restored on reopen, and falls back to centered when the display layout changes
- Also fixes the silent-failure report (U1): the AI chat entry now shows a toast when `aiEnabled` is false

**Per-bubble visibility + new "问" bubble**
- The selection trigger row grew from [译][续][润][摘] to **[译][续][润][摘][问]**
- The right-click menu no longer hides all AI bubbles at once; it hides only the one you clicked ("Hide \"润\" bubble"), and the row width is computed from the visible count so positioning never drifts
- The status-bar AI gear panel gained four per-bubble checkboxes for individual restore, plus a master toggle that restores everything
- Migration: `aiAssistBubbleHidden=true` now hides all four bubbles (each restorable individually); the legacy field is kept for rollback compatibility

**"译" bubble color**
- Both the settings page and the translate entry's quick-settings panel write the same field; empty means "follow theme", and clearing removes the CSS variable so the theme color returns
- The floating-button refresh loop re-reads both translate and AI bubble colors, so changes apply instantly

**Quality**: full frontend suite 2131+ tests across 110 files (serial mode), `cargo test` 74 passing, `tsc --noEmit` clean.

#### v0.7.5 detail optimizations (same day)

**1. Fixed the document jumping back to the top after pressing Esc**
- Root cause: bubble Esc handling calls `stopPropagation()` in the window capture phase, so the editor DOM never sees the **capture-phase keydown** — but the keyup still reaches it. The scroll-follow logic then used the stale `savedScrollTop / savedCursorY` from the *previous* keystroke and restored `scrollTop` to an old value; when that previous keystroke happened near the top of the document, the view jumped back to the top. Whether it jumped depended on the gap between the last keystroke and the current scroll position, hence "sometimes".
- Fix: new `ScrollKeyBaseline` (recorded on keydown, consumed on keyup) — **a keyup may only run scroll-follow when its matching keydown was seen**. The baseline is invalidated on editor blur; both ProseMirror (read mode) and textarea (source mode) typewriter scrolling are fixed.

**2. Bubble colors now reach the status-bar AI buttons**
- The four drawer buttons (continue / polish / summary / chat) inject `--ai-entry-color` from their own bubble color and highlight with it on hover and press; unset colors fall back to the theme accent, so the default look is unchanged.

**3. Immediate feedback for AI continue**
- Clicking continue now renders a grey placeholder ghost "续写中..." at the caret right away (with a breathing animation), replaced by the real text as soon as the first chunk arrives.
- The placeholder cannot be accepted: Tab is consumed without inserting (the hint text can never be written into the document) and the "Tab to accept · Esc to discard" hint is hidden.
- Read mode and source mode behave identically.

**4. AI translation embedded in the chat window**
- New "**AI Translate**" quick template: when the window was opened from a selection, clicking it translates that selection (target language comes from the translate settings; `auto` means zh↔en) and the result can be written back with "Replace selection".
- Each answer gains a "译" button that translates it in place and toggles back to the original; while translated, "Insert at cursor / Replace selection / Copy" act on the translation, giving a full in-window flow: selection → 问 → AI Translate → Replace selection.
- Answers over 4000 chars show a notice instead of failing silently; "译" is disabled during streaming so it cannot preempt the shared task slot.

**5. Chat window drag limit removed**
- Dragging is no longer constrained to the viewport — the window can be moved anywhere (off-screen, second monitor). Only size is clamped (min 360×280, max the viewport).
- The position memory keeps a safety net: on the **next open**, a remembered rect that lies entirely outside the viewport (new monitor / smaller resolution) falls back to centered.

**Quality**: full frontend suite **2159 tests across 111 files**, `tsc --noEmit` clean, `cargo test` 74 passing.

### v0.7.4 (2026-09-13)

**Selection AI bubbles and assistant enhancements**:
- Three AI bubble buttons ([续][润][摘]) next to the "译" trigger, floating as one row above the selection
- AI summary became a Word-comment-style floating window: draggable, resizable from the bottom-right, auto-growing with content (up to the status bar), with a dashed connector anchored to the selection
- A "译" button in the summary window header translates the window content in place and toggles back to the original
- AI bubbles are filtered by owning document, so switching tabs no longer mixes content; unsaved (path-less) files discard stale bubbles on switch
- Status-bar AI gear panel (bubble switch / delay / three per-task colors) and "Pin AI entry"

### v0.7.3 (2026-09-12)

**Experience and stability fixes**:
- Silent failures converted to toasts (disabled AI entries, full-document translation conflicts, non-translatable selections)
- New temperature setting forwarded to the provider (fixes `400 invalid temperature` on kimi and similar)
- Full-document translation runs 3-way concurrent with targeted cancellation and current-segment progress
- Fixed misplaced translation write-back by using the selection snapshot taken at task start instead of the live selection
- Fixed missing continuation ghost in source mode: a textarea overlay preview with `Tab` to accept / `Esc` to discard
- Fixed `http://` endpoint warning logic and a dead error-classification branch

### v0.7.2 (2026-09-10)

**AI model configuration overhaul**:
- **22 provider presets** — Added Kimi Code, Tencent Hunyuan, iFlytek Spark, StepFun, Baidu ERNIE, 01.AI, Baichuan, SenseTime SenseNova, and Ant Ling Studio; refreshed all model catalogs to vendors' current lineups (Sep 2026); MiniMax switched to the China endpoint `api.minimax.cn`
- **Per-provider API key storage** — Each provider gets its own Credential Manager entry; keys no longer overwrite each other when switching providers (legacy global key auto-migrates)
- **Dynamic model list fetching** — New "Fetch models" button pulls the vendor's live model list (`GET /models`), with automatic fallback to the static preset list on failure
- **Model candidate panel fix** — Fixed the datalist filtering bug where only one of the fetched models was selectable: a full candidate panel now shows all fetched models for one-click selection

### v0.7.1 (2026-09-08)

**AI assistant experience polish**:
- The floating selection button row grew to **[译][续][润][摘]**: continue writing (streaming grey-italic ghost preview, `Tab` to accept / `Esc` to discard), polish (one-click replace of the selection from the result bubble), and summarize (150–300 characters, with a dashed connector anchored to the selection)
- The translation-bubble delay setting now actually applies (default 500 ms, adjustable 0–2000 ms): the bubble used to be made visible during drag-selection, which defeated the delay; visibility is now driven only by the delayed `mouseup` timer
- AI bubble token usage changed from a single combined number to separate **↑ input / ↓ output** counters (system prompt + input text vs. model output), making the breakdown obvious
- Hardened the streaming continuation ghost pipeline (chunks append live at the caret, with de-duplication so hint text can never linger)

### v0.7.0 (2026-09-07)

**The AI assistant system arrives (first 0.7.x release)**:
- **AI continue / polish / summarize** assistant tasks, triggered from the floating selection bubbles with streaming output and cancel (`Esc`), sharing the single provider configuration, the single task slot, and the error-code protocol with AI translation
- Floating "译" trigger plus **a row of AI bubbles**, with a right-click menu to hide/restore them; the floating buttons support a **delay before appearing**, adjustable via a slider in the "译" entry panel
- New **AI entry drawer** in the status bar (continue / polish / summarize) with corrected expand/collapse behavior: it stays open when the pointer leaves and only closes on an outside click or when the AI task finishes
- Global **AI master switch** (`aiEnabled`) linked to the translate sub-switch: turning the master switch off also turns translation off, while turning it back on does not force translation on
- Fixed: switching between open files **no longer resets your reading position** (tracked per path, up to 60 entries); reopening a file still starts from the top
- Fixed: trailing empty paragraphs at the end of a document were lost on round-trip (the serializer now keeps trailing blank lines and the parser rebuilds empty paragraphs)

### v0.6.6 (2026-09-01)

**Four experience fixes**:
- **Empty-document newlines preserved** — repeated Enter newlines are no longer lost after switching tabs, reopening, or saving (serializer keeps trailing newlines + parser rebuilds empty paragraphs)
- **Slash `/` panel works in Read mode** — the ProseMirror plugin activates the same menu as Source mode
- **Delete no longer closes files** — a focus guard prevents the "close temporary file" shortcut from firing while editing
- **Inline base64 images collapsed** — Edit/Split mode shows a short marker `![alt](image-1.png)` instead of huge base64 blobs, dramatically reducing screen usage; the file on disk still stores full base64 and restores it before save/preview/translation, so content never changes

**Quality**: 1880/1880 frontend tests pass, `tsc --noEmit` clean.

### v0.6.5 (2026-08-29)

**P0 critical fix (full translation only translated the tail segment)**: placeholders for links/inline code/images must be extracted BEFORE the request is built and sent as `{{N}}`. Previously tokens were generated only after the LLM reply arrived, so any segment containing those elements failed validation and kept its original text. Now those segments translate correctly and links/code/images are restored verbatim.

### v0.6.4 (2026-08-29)

- Failed translation segments are shown as a red bubble at the top of the document (auto-hide 5s); the status bar only shows progress and then "Translation completed ✓", reset on document switch
- Pure-image blocks skip translation; inline image alt text & URL are fully protected by placeholders

### v0.6.3 (2026-08-29)

**Data-safety & robustness hardening** (per code review):
- **P0**: full-translation tab-switch abort actually enforced; undo snapshot cleaned across tabs/files bound to document context; write-back aborts if the document was edited meanwhile (DOC_CHANGED)
- **P1**: frontmatter misdetection fixed, long-block split boundaries improved, rate-limit exponential backoff with retry, error-code passthrough
- **P2**: image/link syntax removal, error-code wiring, dead-code cleanup
- **Security**: warning for non-localhost / non-HTTPS translate endpoints, credential hardening, boundary checks

### v0.6.2 (2026-08-27)

**Translation efficiency + uninstall cleanup**:
- Pure-symbol / pure-URL / pure-email segments no longer generate translation requests, cutting wasted tokens
- Uninstalling now clears the translate API key (Windows Credential Manager) and enables-state; translation is off by default for new installs

### v0.6.1 (2026-08-26)

**Full-document translation + UX polish**:
- **Full translation** — floating button / `Shift+F6` / command palette; auto-splits paragraphs and translates serially, skipping code fences, formulas, frontmatter; tolerant of segment failures
- **Undo translation** — click the "Undo translation" bubble to restore the original text (bound to document context)
- **Translated content is not auto-saved** — waits for your confirm or further editing
- Mode-switch button (pen / book icons); fixed long-press Ctrl accidentally triggering mode switch

### v0.6.0 (2026-08-23)

**AI Translation (core new feature)**:
- **Selected / Full translation** — context menu, translate button, command palette; defaults to full translation when nothing is selected
- **Result mode** — direct replace or bilingual side-by-side
- **Translate bubble** — streaming results with i18n error codes
- **Settings** — "AI Translation" group (provider presets / API Key / baseUrl / model / source language / tone / result mode / prompt) plus connection test
- **API Key stored in Windows Credential Manager**
- **Backend** — Rust translate command (single-task model, streaming channel, error-code protocol)

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
