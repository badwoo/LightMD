# LightMD

> A lightweight, high-performance, WYSIWYG Markdown editor for Windows, built with Tauri v2 + React + ProseMirror (reading surface) + CodeMirror 6 (source surface).

**Current version: v0.17.1**

[中文](./README.md) | English | [User Guide](./USER_GUIDE.md) | [Changelog](./CHANGELOG_EN.md)

## Overview

LightMD for Windows combines the simplicity of Markdown with the immediacy of a rich-text editor: reading shows a typeset document, editing shows source and live preview side by side. The installer is about 9MB, starts in milliseconds, and needs no extra runtime.

- **Two modes**: Read mode (WYSIWYG, syntax markers shown on the cursor line) and Edit mode (source on the left, live preview on the right)
- **One timeline per document**: read, edit and preview share a single undo history, so undo keeps working across modes
- **Content-anchored alignment**: read ↔ edit and source ↔ preview align by content anchors, so the same paragraph stays in the same place
- **Local first**: documents, images and snapshots stay on your machine; nothing is uploaded

## Interface and Modes

- **Read mode**: typeset view where headings, lists, tables, diagrams and formulas look final; the line holding the cursor reveals its Markdown syntax.
- **Edit mode**: source editor on the left with live preview on the right; the preview can collapse to plain source and slide back from the right edge.
- **Switching**: double `Ctrl` toggles read / edit; double `Shift` toggles the preview inside edit mode; the title bar and status bar offer the same actions.
- **Position kept**: switching modes, closing and reopening a tab, or restarting the app keeps your reading position.
- **Synced panes**: scrolling either pane aligns the matching content at the top of the other pane.

## Features

### Editing and Input

- **Source editor**: syntax highlighting, line numbers, code folding, bracket matching, active-line highlight, rectangular selection, multi-cursor, search highlights and soft wrap.
- **Smart Enter**: lists, task items and quotes continue their markup; ordered-list numbers increment; an empty item exits the list; `Backspace` at line start removes the marker in one step.
- **Code-block language highlighting**: fenced blocks are colored per language, common languages built in and others loaded on demand.
- **Selection and multi-cursor editing**: double-clicking a word highlights every occurrence; `Ctrl+D` adds a cursor per occurrence to edit them all at once.
- **Auto pairing**: brackets, quotes and Chinese punctuation are paired automatically, with selection wrapping, `Tab` jump-out and paired deletion; each category can be toggled.
- **Type-as-you-get**: inline math, block math, links, images, footnotes and tables of contents convert as you type; emoji shortcodes such as `:smile:` complete inline.
- **Markdown-aware paste**: pasted Markdown text or rich HTML is restored to real structure; a pasted URL becomes a link.
- **Format Painter**: click once for a single application, double-click to stay armed; works on inline formatting for a selection, and can strip formatting as well as apply it.
- **Block operations**: code blocks, formulas, diagrams, tables and image paragraphs can be dragged, copied, cut and deleted, each as one undo step.
- **Batch comments**: `Ctrl+/` comments the selected lines or the current block; comments are dropped from exports.
- **Document zoom**: `Ctrl+wheel` or the zoom ruler, 50%–200%, applied across all three surfaces.

### Reading and Preview

- **Heading folding**: collapse everything under a heading; display only, never modifies the file.
- **Heading level badges**: click the `H1`–`H6` badge to change a heading level.
- **Image lightbox**: double-click an image for full-screen viewing with zoom, pan and previous / next navigation.
- **Outline panel**: live in sync with the document, click to jump, foldable, drag-sortable and searchable on hover.
- **In-document links**: relative paths open the target file, `#anchors` scroll smoothly, external links go to the system browser.
- **Typography settings**: content width, line height, paragraph spacing, font size and family take effect immediately.

### Rich Content and Insertion

- **Tables**: visual row / column editing, draggable column widths and row heights, column alignment, cell merge and split; sizes are saved with the document.
- **Images**: paste, insert from file or drop in place; alt text, width and left / center / right alignment; an image manager converts inline and file-backed images, renames with reference updates, and cleans up unreferenced files.
- **Mermaid**: 20+ diagram types with built-in templates for one-click insertion.
- **Math**: inline `$...$` and block `$$...$$`, previewed live while editing.
- **Code blocks**: language picker, one-click copy, automatic language detection when unlabeled.
- **Other syntax**: task lists, highlight, superscript / subscript, footnotes, definition lists, `[toc]`, anchor links and emoji.

### Files and Workspace

- **Tabs**: multiple tabs, pinning, and a context menu (rename / print / save as / close others); untitled documents are not written to disk until saved.
- **File tree**: several folders open at once, each with its own pane; create, rename, delete to the recycle bin, drag to copy / move, reorder within a folder, and live sync with external changes.
- **Quick switcher**: `Ctrl+P` fuzzy-matches open tabs, recent files and workspace files.
- **Favorites and recent**: favorites live in the sidebar with multi-select batch add; recent keeps both files and folders.
- **Multiple windows**: up to 8 peer windows with independent tabs and state; open in a new window, drag to merge, restore sessions and detect file conflicts.
- **Session restore**: reopens the tabs, folders and reading positions from the last session.

### Search

- **Current document**: `Ctrl+F` / `Ctrl+H` floating search with whole-word, match-case, selection-only and regex modes plus `$1` capture groups.
- **All open files**: a result bar grouped by file with replace-all, and replacements can be undone.
- **Workspace search**: full-text search across all open folders with streamed, cancellable results and jump-to-match.

### Export and Print

- **HTML**: self-contained styles with formulas and diagrams rendered inline; works offline.
- **PDF**: printed in-app without an external browser, with complete per-page headers and footers.
- **PNG**: the whole document as a long image with formulas and diagrams rendered as vectors.
- **Word / ePub / LaTeX**: formulas, diagrams and images exported with layout preserved; ePub splits chapters by heading.
- **Print**: prints the document with its current styling.

### AI

- **Translation**: translate a selection or the whole document, replacing text directly or showing bilingual output; streamed, cancellable and reversible.
- **Assistant**: continue, polish, summarize and chat; floating buttons beside a selection and a multi-turn chat window with quick commands.
- **Connections**: independent connection profiles supporting OpenAI-compatible and Anthropic protocols plus local deployments such as Ollama; live model lists and configurable context / output budgets.
- **Instruction library**: custom instructions with `{{selection}}` and `{{document}}` variables.
- **Key safety**: API keys live in Windows Credential Manager, stored per provider and per profile.

### Appearance and Efficiency

- **Themes**: six themes cycled with `Ctrl+Shift+T`.
- **Focus mode** (`F8`) and **typewriter mode** (`F9`), available in all three surfaces.
- **Immersive full screen** (`F11`): all surrounding panes collapse, leaving only the document.
- **Custom shortcuts**: rebind by category with conflict warnings, per-item reset and restore-all, synced across windows.
- **Update check**: check, download and install new versions from Settings.

### Data Safety

- **Auto save**: compares the file on disk before writing; if another program changed it, saving is skipped with a notice.
- **External changes**: choose notify-only, ask each time, or pick between taking the newest version, keeping local edits or saving as.
- **Independent undo**: undo / redo is scoped strictly per document.
- **Version snapshots**: up to 5 versions per document with diff view and one-click restore.
- **Recycle bin**: deleted files go to the system recycle bin and can be restored.

## Known Limitations

- Paired-input gestures in the source surface (`Tab` jump-out, paired deletion) are not wired up yet; `Tab` indentation, undo and focus mode work normally.
- Typewriter mode does not apply to the source surface; reading and preview are unaffected.
- Multi-cursor editing supports creating cursors and typing, but formatting, replace and AI actions apply only to the primary selection.
- Files larger than 5MB open in edit mode only (source surface).
- Split-view alignment outside the viewport is estimated, so long wrapped paragraphs may show small offsets.
- Workspace search is read-only and does not replace across the workspace; it does not parse wikilinks, tags or frontmatter.
- Not supported: tag system, wikilinks / backlinks, graph view, plugin system, Git integration, folder-wide export.

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Toggle read / edit | Double `Ctrl` |
| Toggle preview | Double `Shift` |
| Save / Save as | `Ctrl+S` / `Ctrl+Shift+S` |
| New / close tab | `Ctrl+N` / `Ctrl+W` |
| Switch tab | `Ctrl+Tab` |
| Quick file switcher | `Ctrl+P` |
| Command palette | `Ctrl+Shift+P` |
| Find / replace | `Ctrl+F` / `Ctrl+H` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Focus / typewriter mode | `F8` / `F9` |
| Immersive full screen | `F11` |
| Settings | `Ctrl+,` |
| New window | `Ctrl+Shift+N` |
| Cycle theme | `Ctrl+Shift+T` |
| Version snapshots | `Ctrl+Alt+V` |

> The complete list lives in the [User Guide](./USER_GUIDE.md) and under **Settings → Editor → Custom shortcuts**, where bindings can be changed.

## Installation

### Windows

Download the latest build from the [Releases](../../releases) page:

- **`LightMD_0.17.1_x64-setup.exe`** — installer, no admin rights required, recommended
- **`LightMD_0.17.1_x64_en-US.msi`** — MSI package, suited to enterprise distribution
- **`lightmd.exe`** — portable single executable, run directly

### System Requirements

- Windows 10 / 11 (64-bit)
- No additional runtime required

## Quick Start

1. Download and install LightMD
2. Create or open a Markdown file
3. Read in read mode, then double `Ctrl` to edit
4. Type `/` at the start of a line for the quick-insert menu (headings, lists, code blocks, tables, diagrams, formulas)
5. `F8` for focus, `F9` for typewriter mode, `F11` for full screen
6. See the [User Guide](./USER_GUIDE.md) for details

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri v2 |
| Backend | Rust |
| Frontend | React 18 + TypeScript |
| Build tool | Vite 5 |
| Reading editor | ProseMirror |
| Source editor | CodeMirror 6 |
| Markdown parsing | markdown-it |
| Diagrams | Mermaid 11 |
| Math | KaTeX |
| Code highlighting | PrismJS / CodeMirror Language |
| State management | Zustand |

## Build from Source

```bash
git clone https://github.com/badwoo/LightMD.git
cd LightMD
npm install
npm run tauri dev      # development
npm run tauri build    # release build
```

Build artifacts are located in `src-tauri/target/release/bundle/`.

## Contributing

Issues and pull requests are welcome. See the [changelog](./CHANGELOG_EN.md) for release contents.

## License

Released under the [MIT License](./LICENSE).
