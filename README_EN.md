# LightMD

> A **lightweight**, **high-performance**, **WYSIWYG** Markdown editor for Windows, built with Tauri v2 + React + ProseMirror.

**Current Version: v0.14.0**

[中文](./README.md) | English | [User Guide](./USER_GUIDE.md)

## ✨ About LightMD

LightMD is a **lightweight Markdown editor** purpose-built for Windows, combining the simplicity of traditional Markdown with the intuitiveness of modern WYSIWYG editors. With a tiny ~9MB installer and millisecond-fast startup, it delivers a deeply integrated Windows desktop experience.

## 🎯 Core Features

### 📝 Two Editing Modes (v0.14.0: three merged into two)

- **Preview Mode** — WYSIWYG with Markdown syntax hints on the cursor line
- **Edit Mode** — Source on the left, live preview on the right (this **is** the old Split view,
  now the default when you click Edit). The preview can be collapsed into a pure source view and
  slid back in from the vertical "Open preview" rail at the editor's right edge.
  - Double-tap `Ctrl`: toggle Preview ↔ Edit; double-tap `Shift`: toggle the preview pane
  - **Reading position is preserved**: when toggling between the two modes, and even after closing and reopening a tab (0.14.0 batch 2)
  - Hover the divider centre for the vertical, breathing "Close preview / Open preview" label

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
- 🔍 **Global Search & Replace** (`Ctrl+F` / `Ctrl+H`) — with **whole word / match case / in selection / regex** checkboxes (default off) and a **"Find in open files"** results banner listing file name + matched line with highlighted hits; works in both Preview and Edit mode (0.14.0). With the banner open, "Replace all" replaces **every matched file**, and switching documents makes the search follow (0.14.0 batch 2); **replacements are undoable** (including cross-file replaces — switch to the changed file and `Ctrl+Z` / `Ctrl+Y`), and replacing in Read mode takes effect **immediately** (0.14.0 batch 3)
- ⚡ **Quick file switcher** (`Ctrl+P`) — open tabs / recent files / workspace files in groups, subsequence fuzzy matching with highlighted hits (0.13.0)
- 📑 **Document Outline** with click-to-jump navigation and drag-to-reorder; collapsible headings (0.13.0) and per-document scroll memory (0.13.2)
- 📁 **File Tree** + drag-and-drop open
- 📋 **Recent Files** quick access
- 💾 **Auto-save** — periodically saves to disk, configurable interval or disable
- 🔄 **Check for updates** (0.14.0) — the last section of Settings: query the latest GitHub release, read its notes, download and launch the installer (with a progress bar)
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
- Click a code block / formula / Mermaid diagram / table cell to start editing immediately — no more "click once to activate, click again to edit"; blocks with no caret target (divider, `[toc]`) stay block-selected and can be deleted or dragged
- Clicking "Bold" / "Heading" without a selection inserts only syntax markers; the placeholder is a grey ghost hint replaced as soon as you type, never written to disk
- Reading focus preserved: collapsing the sidebar, resizing the window, dragging the split divider, or toggling the outline keeps the first visible paragraph in place
- Focus mode highlight expands to "previous / current / next" lines
- Heading level badges: an `H1`–`H6` dropdown changes the level with the outline following
- Auto-pairing: skips when the closing symbol already follows, wraps selections, one Backspace deletes an empty pair, `Tab` jumps out; scope configurable per brackets / quotes / CJK punctuation
- Enter = line break in reading mode (N presses = N line breaks), `Shift+Enter` = new paragraph; behavior inside lists / quotes / headings / tables / code blocks is unchanged
- Line height / paragraph spacing / content width settings apply in all three modes
- Multi-line comment toggle `Ctrl+/`: selected lines (across blocks) turn grey and struck through; with no selection the current block is toggled (Obsidian semantics); saved as `<!--comment-->` and omitted from all six export formats
- Also: `→` exits code blocks, a book button in editing mode, square / round task icons, an editor scrollbar flush right, creation time for open files, and "About LightMD" in Settings

### 🧱 Block-level Interaction

- Clicking a code block / block formula / Mermaid diagram / table cell enters editing directly; leaf blocks with no caret target (divider, `[toc]`) keep whole-block selection (`Delete`, draggable)
- Hovering a block, placing the caret inside it, or selecting it shows the left `⋮⋮` drag handle and the top-right `⋮` menu together; ordinary paragraphs / headings / lists / quotes never sprout handles
- The `⋮` menu has 8 entries: cut / copy / paste / delete block / format painter / select block / move up / move down — disabled automatically for an empty clipboard and for first / last blocks
- Block copy writes three formats: Markdown source (pastes into other editors), rendered HTML (pastes into web pages / Word), and LightMD-private data (pastes back into reading mode with the block structure and untouched bytes restored)
- Cut / delete / move are one transaction each, so a single `Ctrl+Z` restores everything; deleting every block re-adds an empty paragraph

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
- Auto-save reads the disk first and compares three paths; if a third party changed the file it abandons the write and warns, so external edits are never silently overwritten
- Three policies for externally modified files (notify only / choose between take-latest, keep-local, save-as / ask every time); single files outside any opened folder now receive change events too
- The filler paragraph after a trailing table / code block / formula / Mermaid block is never written to the `.md`, so saved files stay byte-identical
- Undo / redo is strictly per document: history is saved when you switch away and restored only when the content still matches

### ⌨️ Typewriter-Style Input

- Six input rules — inline formulas, block formulas, links, images, footnotes, and auto table of contents — convert as you type
- Emoji short-code completion: typing `:` plus letters opens ~1900 candidates; `↑↓` to select, `Enter` inserts the short code (still stored as a short code); times and ratios such as `3:1` / `12:30` never trigger it
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
- **Image interaction**: clicking an image selects it (the reading-mode lightbox still works), the small handle at the top-right opens the editor, and dragging any edge / corner resizes it — width only, height follows the aspect ratio, one drag = one undo
- **Image left/center/right alignment** (persisted as an `![alt|center](src)` suffix) and an **image manager panel** (one row per occurrence in document order, base64 ↔ assets conversion, rename updating every reference, unreferenced cleanup through the Recycle Bin, current document only)
- The image manager dialog scales out of its icon, can be dragged around and shrinks back on close; with no images the icon fades out and the "译" button slides up into place
- Code block language dropdown with instant re-highlighting; 34 built-in highlighting languages; **one-click copy in the top-right corner** — the clipboard receives a complete fenced block, so pasting into another document renders immediately
- In-paragraph line-break semantics selectable (GFM immediate break / CommonMark two spaces)

### 📋 Tables

- The insert dialog has a live Markdown preview and supports slash headers
- Column-width / row-height dragging, whole-column alignment, row/column add and delete, and a header row that cannot be deleted (so data never impersonates a header)
- `Enter` inside a cell moves to the cell below in the same column (appending a row at the bottom), `Shift+Enter` inserts a line break
- **Cell merge / split** (drag across cells → 🔗/✂️; both colspan and rowspan, structure survives reopening; ordinary tables round-trip with zero diff)

### ⚡ Navigation & Performance

- In-document link navigation: relative paths open the target document, `#anchor` smooth-scrolls, external links go to the system browser
- Split view sync is a **top-level block mapping** in both directions (no shared scrollbar): scrolling either side aligns the corresponding block to the top of the other, with a 250 ms direction lock to stop echo pushes
- Focus mode and Mermaid rendering caches keep hundred-thousand-character documents smooth
- Task items and footnotes keep a lossless content model, directly editable including nested lists and paragraphs

### 🪟 Immersive Fullscreen & Shortcut Experience

- `F11` immersive fullscreen collapses all four bars, `Esc` restores
- `Ctrl+,` is reclaimed by a Rust-level native hotkey so Chinese IMEs can no longer swallow it
- Settings dialog fades in/out; the custom shortcut dialog uses a 3×3 card layout with every shortcut visible in one screen

### 🪟 Multi-Window (added in 0.9.0)

- 🪟 **Peer multi-window** — `Ctrl+Shift+N` or the title-bar "Window" menu opens an auxiliary window (max 8); each window has its **own tabs, editor state, reading progress and AI chat window**
- 🔁 **Live global sync** — theme, font, sidebar width, AI settings, recent files and favourites sync instantly across windows
- 📂 **Many ways into a new window** — file-tree / open-files context menus, tab context menu "Move to new window" (scratch tabs carry their content), **dragging a tab out of the tab bar**, and `Ctrl+Alt+O` to pick a file and open it in a new window
- 🗂 **Title-bar "Window" menu** — lists every window and its tabs (with unsaved dots); clicking a window activates it, clicking a tab activates that window and switches to the tab; also offers "Merge into main window" (you can also drag an auxiliary window's tab onto the main tab bar and confirm the merge)
- 🪟 **Drag-to-merge** — hold an auxiliary window over the main window's tab bar and confirm "Merge back into the main window?" to move every tab over and close it (0.9.0 round 3)
- ⚔️ **File conflict detection** — if a file is already open in another window with unsaved changes, an in-app dialog offers read-only / force edit / switch to that window / cancel; read-only tabs show `[read-only]`
- 👀 **External change and delete handling** — clean tabs reload with a notice, dirty tabs are marked pending; deleting a file closes its tabs; **the app's own writes are never mistaken for external changes**
- 🤖 **AI task isolation** — translation / continue / polish / summary / chat in window A no longer cancels the task in window B (inside one window a new task still cancels the old one)
- 💾 **Session restore** — a "restore other windows at startup" switch (default off, main window only) plus "Quit LightMD" (`Ctrl+Q`, records only the **main** window so nothing else revives); windows merged into the main window do not duplicate
- ✅ **Smart close confirmation** — closing a window or quitting only prompts for **files already on disk with unsaved changes**; scratch (untitled) tabs are remembered and restored instead
- 🧹 **Backward compatible** — behaviour is identical to 0.8.5 when you never use multi-window; the main window keeps the old data file with zero migration

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
- 📊 **Table Visual Editing** — add/delete rows & columns, column alignment, draggable column width/row height, floating toolbar (0.3.0; 0.4.5 perfects column resizing: inner borders resize adjacent columns keeping total width unchanged, outermost border changes total width; 0.5.0 fixes unresponsive dragging in preview mode and supports the first column's left edge); **column widths / row heights persist with the document** (0.14.0, stored in a comment directive after the table — tables you never resized stay byte-identical)
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


## ⚠️ Not Supported (Do Not Assume These Work)

To avoid confusion, here is what LightMD genuinely does **not** do yet. The goal is "Typora's editing experience + lightweight file management", not a full Obsidian replacement (encryption / sync / plugin ecosystem).

**Knowledge organisation**

- Cross-file full-text search (only **file names** can be searched; `Ctrl+F` is limited to the current document)
- Tag system (`#tag` parsing / tag panel / filtering by tag)
- YAML frontmatter property panel (note: full-document translation skips the YAML header)
- Wiki links `[[wiki-link]]` / backlinks / unlinked mentions
- Graph view / bookmarks / Dataview-style inline queries

**Editing**

- Toggle a code block between editable and read-only
- Snippets / abbreviation expansion
- Setext headings (`===`) — parsed and displayed correctly, but normalised to ATX form after editing

**Extensions & misc**

- Third-party plugin system / theme marketplace
- Git integration
- Batch export of a whole folder
- Sidebar search inside folders that have not been expanded yet (expand the tree first)

> Some of these are on the roadmap; see "📋 Changelog" and the issue list.

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
|                                         | `Ctrl+/`                    | Toggle multi-line comment (`<!-- -->`); with no selection, toggle the current block (0.13.0) |
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
|                                         | `Ctrl+P`                    | Quick file switcher (open tabs / recent / workspace, 0.13.0)                          |
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

Visit the [Releases](../../releases) page to download the 0.14.0 installers:

- **`LightMD_0.14.0_x64_en-US.msi`** — MSI installer, for regular users, supports uninstall
- **`LightMD_0.14.0_x64-setup.exe`** — Self-extracting installer, single file, no admin required

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

### v0.14.0 (2026-10-23 ~ 10-25, including seven fix batches)

**Two modes instead of three, a complete search stack, a built-in update check, and real-machine defect convergence**

This release collapses the three modes (Read / Edit / Split) into **two** — Edit is now the old split view, and the right-hand preview can slide out and back. Find & replace becomes a complete stack (whole word / case / selection scope / across files / undoable), and a "Check for updates" panel is built into Settings. The previously planned CodeMirror 6 migration was dropped after re-evaluation. Six follow-up batches then cleared the 15 defects found during real-machine retesting; every batch was verified on the **packaged installer with real WebView2 mouse/keyboard gestures**.

**New features**

| Feature | Notes |
| --- | --- |
| Three modes merged into two | The title bar only offers Read / Edit. Clicking Edit gives the old split layout (source left, preview right). Double-`Ctrl` toggles Read↔Edit; double-`Shift` toggles the preview. The palette entry formerly called "Split mode" is now "Toggle preview pane (Edit mode)" |
| Preview slides out and back | Hovering the right pane or divider reveals a vertical breathing label "Close preview"; clicking slides the right pane to the left of the syntax rail and lets the editor fill the width, leaving an 18px rail to bring it back. The toggle state is remembered; files over 5MB open with the preview closed |
| Search options | Whole word (Unicode word boundaries) / match case / selection scope (captured when you tick the box, shifts with replacements, and never silently falls back to the whole document) / regex |
| Find in all open files | A results strip lists "file name + matching line" with highlights and a total of "N matches (M files)"; clicking a row jumps to that file and position. With the strip open, "Replace all" replaces every listed file |
| Undoable replace | Replacements enter the undo stack; a cross-file replace-all is **one whole-document step**, so `Ctrl+Z` / `Ctrl+Y` work after switching to the modified file (including the keyboard path in Read mode), guarded byte-for-byte so the record is dropped once you edit manually |
| Check for updates | A "Software update" section at the end of Settings: queries the latest GitHub release, shows collapsible notes, a download progress bar, launches the installer, and links to the release page |
| Table size persistence | Column widths and row heights survive save and reopen, stored in a side-channel HTML comment that other editors ignore; tables you never resized stay byte-identical |
| Block-level split alignment | Split scrolling maps **top-level blocks** instead of percentages, so both panes land on the same block and reach the bottom together (mermaid documents included) |

**Fixed**

| Issue | Fix |
| --- | --- |
| The divider could only be dragged one way | The divider sits next to the preview iframe, which swallowed `mousemove`/`mouseup` once the pointer entered it. Pointer capture, temporary `pointer-events` suppression on iframes, and a deduplicated pointer/mouse dual channel |
| The vertical "Close / Open preview" label was unclickable | It is a child of the divider and the drag's pointer capture redirected the `click`. Presses landing on the label are now passed through |
| Reading progress lost on Read↔Edit switch and on close/reopen | Never write `0` while the container cannot scroll, and retry until it can; the right pane restores independently; four "clear progress on close" call sites were removed |
| Reading focus shifted after closing the preview; repeated toggles drifted upward | The percentage `padding-inline` now transitions so `scrollHeight` never jumps; the linkage is frozen during the toggle and restored from a **viewport-center content anchor** (bottom stays bottom), with verification passes after closing |
| Read ↔ split progress linkage lost | The freeze window gained a `viewMode` gate so it only starts on a real preview toggle, and alignment after unfreezing uses block anchors |
| "Check for updates" misreported "cannot connect to GitHub" | Not a business-layer bug: `reqwest` trusted bundled roots only (no Windows certificate store) and had the system proxy disabled. Switched to `rustls-tls-native-roots` + `system-proxy`; network failures are now encoded separately so the UI shows "network unavailable" instead of falsely claiming "you are up to date" |
| The search box broke after undoing a replacement | In Read mode both replace and undo only change `state.doc`, so no dependency changed and results froze. A `MutationObserver` with a doc-identity gate and a 150ms debounce now re-syncs, and deferred re-searches always use the latest closure |
| Keyboard undo failed after switching to a cross-file-replaced document | Undo had two entry points and the keyboard one bypassed the cross-file record; focus also sat on the tab button. The PM keymap now delegates to the host when one exists, and the global handler routes by focus category, exclusively |
| The "Recent" panel did not appear when clicking the clock | It only mounted when recent *files* existed, and it could be mounted outside the scroll viewport. A single `recentHasData` rule plus at most one reveal scroll once layout settles |
| The folder pane showed only 7 rows | The default height is now **11 slots (10 file rows + 1 permanent blank slot)** measured from real row heights, and the "collapse a filled pane back to its natural content height" rule no longer shrinks the folder pane to 5–7 rows |
| Favorites / Recent animation stuttered and the sidebar jittered | Scrollbar appearance changed the content width, two height animations were out of sync, and the reveal kept stealing scroll. `scrollbar-gutter: stable`, one shared height transition, and at most one correction after layout settles |
| Title-bar menus were covered by the editor | A three-layer stacking-context failure; the title bar now creates its own layer (content containers deliberately get no `z-index`, which would trap inner fixed popovers) |
| The preview toggle animation felt abrupt | 0.28s → 0.42s with a symmetric easing; the left pane's width is derived by flex (an inline `auto`↔`calc()` width cannot interpolate and jumped on the first frame); the divider width transitions too |
| Panes of different length could not scroll together | Real line-axis measurement for soft-wrapped lines, a trailing anchor, the correct "line at max scroll", and filtering mermaid/katex injected nodes out of the anchor base |

Quality: `tsc --noEmit` exit 0 (strict); full suite **318 files / 5582 tests** passing; Rust `cargo test` 192 passed / 3 ignored; every batch verified on the **packaged installer with real mouse/keyboard gestures and CDP frame sampling** (103 checks in total); version **0.14.0** in `package.json` = `Cargo.toml` = `tauri.conf.json` = `Cargo.lock`.

Known trade-offs: (1) cross-file undo is **one whole-document step** and is dropped once you edit that file manually (better to under-undo than overwrite your edits); (2) reading progress lives in session memory, so closed files are not restored after a restart; (3) the table-size comment is a LightMD extension that other editors ignore; (4) the selection-scope snapshot is fixed when you tick the box; (5) an existing user who manually resized the folder pane keeps that height; (6) during the preview transition the right pane is briefly around 17 frames taller than its box, but the scrollbar gutter is reserved so nothing shifts.

### v0.13.2 (2026-10-17)

**Block-level interaction plus image / table polish — 26 fixes from two rounds of real-device retesting** (base: 0.13.1)

What these had in common: each piece worked alone but failed in combination — copying a single code block was fine, yet pasting it into another document did not render; the rendered layer could be viewed but not edited; per-document undo was correct but the order was not. Testing therefore moved down to the **real interaction chain** (real ProseMirror transactions, real mouse event sequences, real timers, real `localStorage`), with split-view sync, Mermaid top-half editing and cross-document code-block paste additionally verified in **real Chrome**.

| # | Problem | Fix |
| --- | --- | --- |
| 1 | Code block "copy" still pasted as plain text in another document | The clipboard now receives a complete fenced block (fence length = longest backtick run + 1); in-app paste matches the private payload and restores a code block. Same-origin detection compares CRLF/CR-normalised text, so Windows line endings no longer fall back to literal paste |
| 2 | `Ctrl+T` inside a list became a plain line break | Now "promote the current line to a task item": the whole item (second paragraph / nested sublist included) moves ahead of the list, and ordered lists **keep their original number** (`- [ ] 2. text`) |
| 3 | Mermaid's top half (rendered area) was not clickable and did not sync | The rendered layer is now an editing entry: a click maps the vertical position to a source line and places the caret; edits re-render after a 120 ms throttle, and a temporarily invalid diagram keeps the last successful render |
| 4 | With no images the "译" button did not close the gap; floating icons overlapped | The image-manager button is always mounted and merely fades / shrinks; slots are fixed at mode-switch 0 / image manager 1 / "译" 1 without images and 2 with, with a 0.22 s slide |
| 5 | Undo / redo must be strictly per document (the Word-style cross-document order was rejected) | Removed the cross-document ledger and tab-switch routing; `Ctrl+Z` / `Ctrl+Y` act on the current document only, with history saved on switch-away and restored only when the content matches |
| 6 | Closing the image manager threw React error #300 | All hooks moved above the early return, plus a real "open → close → reopen" regression test |
| 7 | The outline did not follow scrolling and did not remember its position | The visible band widened from the top 20% of the screen to the whole viewport; new per-document outline scroll memory (400 ms debounce, 5 s heartbeat, flush on unload, LRU 60) restores it without fighting manual scrolling for 0.6 s |
| 8 | Split view did not sync at all / both sides pushed each other to the bottom | Replaced with **two-way top-level block mapping**: source lines act as anchors in both directions, a 250 ms time-window direction lock ignores echo events, anchor coordinates fixed to `rect.top + scrollTop`, and the scrolling element is re-queried on every sync |
| 9 | After pasting a table into a new document the caret could not reach below it | Documents ending in a table / code block / formula / Mermaid block get a filler paragraph (`addToHistory:false`); it is **never written to the `.md`**, while user-typed trailing blank lines still save |
| 10 | Clicking an image opened the dialog, so it could not be selected or resized | New image NodeView: click selects (the reading-mode lightbox still works), the top-right handle opens the editor, six-direction dragging writes width only (min 24 px), one drag = one undo |
| 11 | The image manager window could not be dragged and had no closing animation | The panel stays mounted while closing so the shell can play the exit animation; title-bar dragging uses `left/top` (leaving `transform` to the animation), stays on screen and resets on reopen |
| 12 | The image-manager icon had no tooltip | `data-tip` plus a CSS `::after` tooltip: 120 ms fade, click-through, hidden while the icon is hidden |
| 13 | The image manager animation felt rough; the backdrop dimmed and flickered | Aligned with the search box: 0.48 s in / 0.38 s out, pure `transform` scaling; **backdrop removed**, zero translation, scale origin at the icon centre, closing shrinks back |
| 14 | The search box lost its "grows out of the button" animation | The anchor selector is narrowed to `[data-genie-anchor="search"]`, so the image-manager entry no longer hijacks it |
| 15 | `Enter` in a table cell inserted a new cell to the right | New `tableEnter` at the head of the Enter chain: move to the cell below in the same column, appending a row at the bottom |
| 16 | After merging cells and reopening, a row had an extra cell and the table structure broke | Parsed rows are trimmed using the same grid placement rules (trailing empty ordinary cells only); plain pipe tables keep a zero-diff round-trip |

**Tests**: 10 new behaviour-level suites (per-document undo, Mermaid rendered-layer editing, trailing paragraph, image resizing, `Ctrl+T` promotion, image-manager slots and genie dialog, outline follow and scroll memory, two-way split mapping, table Enter, merged-cell reopen); full regression **299 files / 5113 cases** green, `tsc --noEmit` clean; split sync, Mermaid top-half editing, CRLF code-block paste, dialog motion, table Enter and merged structure all verified in real Chrome.

### v0.13.1 (2026-10-16)

**16 real-device reports — all fixed**

| # | Problem | Fix |
| --- | --- | --- |
| 1 | Pasted blocks did not render immediately | `looksLikeMarkdown` became the single implementation: self-contained blocks (fence / `$$` / pipe table with separator row) parse on a single hit, everything else needs two or more signals; also fixed turndown's missing GFM table rule and the lost `language` |
| 2 | Empty cells could not be drag-selected, so they could not be merged | The trailing-cell trim criterion changed from "is it a space" to "is the placed logical column out of range", keeping real spaces and trimming only markdown-it filler cells |
| 3 | Backspace swallowed content across cells | `Backspace` / `Delete` at a cell content boundary are now swallowed (no transaction, no caret move), with `table_row` `isolating` as a second line of defence |
| 4 | Alignment only applied to selected cells | Alignment is written through the logical grid: a range selection changes only those cells, no selection keeps whole-column semantics |
| 5 | Dragging a column border selected text instead | The hotspot calls `preventDefault`, and arbitration uses the dominant axis (column hotspot + horizontal = width, row hotspot + vertical = height, otherwise range selection) |
| 6 | Formula / Mermaid editors were oversized, did not close on outside clicks and jittered | One shared inline editor: single-line types shrink to content, multi-line types cap at 45vh, outside clicks exit immediately, and double-click no longer fails to leave edit mode |
| 7 | The image-manager icon covered the "译" settings button | Floating-button slots re-laid out so mode switch / image manager / translate / gear / bubble never overlap |
| 8 | Undo leaked across documents | Tab-switch transactions use `addToHistory:false` + `resetHistory:true`, and source-mode undo / redo stacks reset per document |
| 9 | The image-manager "local file" badge did nothing | The badge is clickable and reveals the file in Explorer; remote / base64 sources stay non-clickable |
| 10 | The image-manager dialog animation was crude | Custom enter / exit keyframes, the scrim moved to a pseudo-element, closing runs through a `closing` state |
| 11 | Outline dragging greyed out and hid the title and drop target | Double fading replaced by a dashed outline, plus a `DragOverlay` ghost, drop indicator line, target-row highlight, and collapsed rows excluded from sorting |
| 12 | The outline did not follow document scrolling | The active heading scrolls into view (quiet for 1.2 s after manual interaction, collapsed rows skipped, already-visible rows skipped, reduced-motion respected), with listeners attached through a callback ref |
| 13 | Split view was rigidly bound | Right-to-left write-back removed, keeping left → right only; an explicit re-sync after content re-renders, plus top-level block anchoring |
| 14 | Switching tabs falsely reported "saved in another window" | `save()` mixed state from three different moments, which under race could write **B's content into A's file**; the path is now captured once, re-checked after every `await`, and tabs are identified by path |
| 15 | Two-digit ordered-list markers stacked vertically | Block markers now use `white-space: nowrap` |
| 16 | The context menu lacked the clipboard quartet | Cut / copy / paste / paste as plain text added at the top of the reading and source menus (plain text does not parse Markdown), with menu height computed from the real item count |

### v0.13.0 (2026-10-14 ~ 10-15, including three bug-fix rounds)

**Editing catch-up and data safety — 16 additions plus 32 real-device fixes** (base: 0.12.3)

Two user reports drove this release: "every click on a block activates it first, so I have to click again to edit", and "another program changed the md but auto-save wrote my stale content back". Both were closed out here.

**New features**

| # | Feature |
| --- | --- |
| 1 | **Click-to-edit blocks** — code blocks / formulas / Mermaid diagrams / table cells enter editing on a single click; leaf blocks with no caret target (divider, `[toc]`) keep whole-block selection |
| 2 | **Always-available handle and menu** — hovering, placing the caret inside, or selecting a block shows the left `⋮⋮` handle and the top-right `⋮` menu; handles appear only on code blocks / Mermaid / formulas / tables / image paragraphs |
| 3 | **Eight-entry block menu** — cut / copy / paste / delete block / format painter / select block / move up / move down, with automatic disabling for an empty clipboard and first / last blocks |
| 4 | **Block copy / cut** — the clipboard receives Markdown source, rendered HTML and LightMD-private data; pasting back into reading mode restores the block structure, and one `Ctrl+Z` undoes it |
| 5 | **Three-way auto-save check** — the disk is read before writing: equal to our last write saves normally, equal to the pending content skips, a third-party change aborts the write and warns; a failed read never writes |
| 6 | **External-change policy** — three settings: notify only / choose (take latest, keep local, save as) / ask every time |
| 7 | **Single files refresh too** — opening a file outside any workspace folder now watches its parent directory as a fallback (reference-counted) |
| 8 | **Image left / centre / right alignment** — three buttons in the image dialog, stored as an `![alt\|center](src)` suffix and honoured by preview and every export format |
| 9 | **Code block copy button** — one click copies the raw code (no line numbers, no language label) and the icon turns into ✓ for 1.5 s |
| 10 | **`Ctrl+P` quick file switcher** — open tabs / recent / workspace groups with subsequence fuzzy matching and highlighted hits |
| 11 | **Collapsible outline headings** — a ▾ toggle with a 420 ms animation, not persisted, and ignored while searching |
| 12 | **`Ctrl+/` multi-line comment** — selected lines turn grey and struck through; with no selection the current block toggles; saved as `<!--text-->` and excluded from all six export formats |
| 13 | **Block-level source markers** — lists / task lists / dividers / block formulas / `[toc]` / Mermaid show their source symbols while the caret is inside, absolutely positioned so text never shifts; ordered lists use the real number |
| 14 | **Emoji short-code completion** — typing `:` plus letters opens about 1900 candidates (lazy-loaded); `Enter` inserts the short code, which is still what gets saved |
| 15 | **Image manager panel** — one row per occurrence in document order, base64 / assets detection with two-way conversion, rename updating every reference, unreferenced cleanup through the Recycle Bin, current document only |
| 16 | **Table cell merge / split** — drag a rectangle across cells; both colspan and rowspan supported, and plain pipe tables keep a byte-identical `md → doc → md` round-trip |

**Three bug-fix rounds (32 items)**

- **Block interaction**: handles sprouting on every paragraph, the block menu opening in the window corner, most menu entries doing nothing, copying a block pasting the whole document, formulas and Mermaid not entering edit mode on click and flickering — all fixed at the root (coordinate mapping, in-app clipboard fallback, NodeView `ignoreMutation`, per-block line slicing)
- **Tables**: clicking a table selected the whole table, the merge button stayed permanently disabled, vertical range selection was impossible, two context menus overlapped, dragging a border selected text, Backspace ate content across cells, alignment ignored the selection, and **merging a header row made the whole table collapse into a paragraph on save** (header cell count must match the separator row)
- **Data safety**: auto-save "seemed dead" (one-shot timer, permanent pause, reset on every render — replaced by a self-renewing loop that re-checks the disk and self-heals), and false "saved in another window" warnings with no external change (new disk baseline; reading the disk never advances it)
- **Comments / Emoji**: comment bodies were rewritten on round-trip, comments containing `--` closed early, uncommenting in source mode ate characters; `3:1` / `12:30` triggered the emoji menu; accepting a candidate next to an inline atom rewrote that node
- **Images**: alignment lost in exports, width mis-parsed when the alt text contained `|`, the manager icon not appearing, base64 and assets not recognised, wrong order and counts, duplicated rename suffixes, batch renames failing halfway
- **Navigation and motion**: outline collapse had no animation, nested collapse levels overrode each other, the image dialog was clipped by an ancestor `overflow`, the search-box animation was anchored to the wrong button, and scrim animation caused backdrop flicker

**Quality**: after three rounds, **277 files / 4714 front-end cases** pass and `tsc --noEmit` is clean; every conclusion was first reproduced with real `markdown-it` round-trips or a real `createEditor` with real mouse events, then locked with behaviour-level assertions.

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
