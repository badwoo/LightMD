# LightMD

> A **lightweight**, **high-performance**, **WYSIWYG** Markdown editor for Windows, built with Tauri v2 + React + ProseMirror.

**Current Version: v0.7.5**

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

### ✨ AI Translation

- **Selection & Full-Document Translation** — select text and translate it from the context menu or the "Translate" button; with no selection the whole document is translated (`Shift+F6`, the floating button, or the command palette)
- **Result Modes** — "Replace in place" or "Bilingual comparison"
- **Translation Bubble** — streaming results with cancel (`Esc`) and one-click restore of the original (0.6.1)
- **Efficiency** — symbol-only / URL / email / image-only paragraphs are skipped; links, inline code, and images are protected as placeholders so they are never mistranslated (0.6.2/0.6.4/0.6.5); full-document translation runs 3-way concurrent (0.7.3)
- **API Key Security** — stored in Windows Credential Manager and removed on uninstall (0.6.1); warnings for non-local URL endpoints (0.6.3); stored per provider (0.7.2)

### 🤖 AI Assistant & AI Chat

- **Selection AI Bubbles** — selecting text shows one floating row of [译][续][润][摘][问] bubbles (added in 0.7.4, extended in 0.7.5): continue writing (ghost preview at the caret, `Tab` to accept / `Esc` to discard), polish (replaces the selection), summarize (draggable floating window), and chat
- **AI Chat Floating Window** (0.7.5, `Ctrl+K`) — free-form multi-turn chat with a one-click `Selection / Document / No context` scope chip, six quick templates (Diagram / Formula / Summary / Title & tags / Rewrite all / Analyze), and a draggable, resizable window that remembers its position
- **Result Action Bar** — each answer can be inserted at the cursor, replace the selection, replace the whole document, copied, or regenerated; replacing the whole document first verifies the document was not edited, so your changes are never overwritten
- **What You Insert Is What You See** — ```mermaid fences and `$$` formulas produced by the model render immediately as diagrams and formulas once inserted
- **Per-Bubble Visibility & Colors** — the four AI bubbles can be hidden and restored individually and colored individually; the "译" bubble color is configurable too (0.7.5)

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
| | `Ctrl+K` | Open the AI chat window (0.7.5) |
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

Visit the [Releases](../../releases) page to download the 0.7.5 installers:

- **`LightMD_0.7.5_x64_en-US.msi`** — MSI installer, for regular users, supports uninstall
- **`LightMD_0.7.5_x64-setup.exe`** — Self-extracting installer, single file, no admin required

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
