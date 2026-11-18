# LightMD Changelog

> Newest first. Each version lists new features and bug fixes only.

## v0.17.1 · 2026-11-18 (includes v0.17.0)

| Type | Content |
|---|---|
| Added | Source editor upgraded to CodeMirror 6: syntax highlighting, line numbers, code folding, bracket matching, active line, rectangular selection, multi-cursor, search highlight, soft wrap |
| Added | Large-document performance: 5MB load 19.3s → 3.3s, input latency 274.1ms → 16.4ms |
| Added | Smart Enter: lists / tasks / quotes continue markup, ordered list numbers increment, empty item exits the list, Backspace at line start removes the marker |
| Added | Fenced code blocks colored per language, languages lazy-loaded |
| Added | Word under cursor highlights all occurrences; `Ctrl+D` adds cursors to edit all matches at once |
| Added | Empty-document placeholder, drop cursor, scroll past end (typewriter mode can center the last line) |
| Added | Word / LaTeX / ePub export moved to the unified document model |
| Fixed | Crash when opening documents with mermaid / math in edit mode |
| Fixed | Reading position lost after repeated read/edit toggles |
| Fixed | Format Painter could not strip formatting, and could only apply to whole blocks |
| Fixed | Left and right panes misaligned after toggling preview with double Shift |
| Fixed | Mode switching rewrote formulas, Setext headings, code blocks inside definition lists |
| Fixed | Reading position reset after restarting the app |
| Fixed | Early source-editor issues: search crash, broken undo, per-keystroke editor rebuild, Tab focus escape, invisible placeholder |

## v0.16.0 · 2026-11-05 ~ 11-08

| Type | Content |
|---|---|
| Added | Indentation system: Tab / Shift+Tab in every block type, indentation unit (Tab / 2 / 4 spaces), unified tab width across code blocks and source pane |
| Added | Source pane supports indentation with focus kept in the editor |
| Added | Sidebar reworked into three mutually exclusive full-height views: Files / Favorites / Recent |
| Added | Favorites support multi-select batch add, including files from the whole workspace |
| Fixed | 16 indentation defects: multi-line indent corrupting code, Shift+Tab eating spaces, Tab focus escape |
| Fixed | Sidebar search and favorites-picker animation stutter |

## v0.15.6 · 2026-11-03

| Type | Content |
|---|---|
| Added | Cross-mode unified undo: read / edit / preview share one timeline |
| Added | Heading folding in read mode and preview |
| Added | Read ↔ edit alignment by content anchors |
| Added | Workspace-wide full-text search with jump-to-match |
| Added | Image lightbox |
| Added | PDF export moved to in-app WebView2, no external browser required |
| Fixed | AI configuration and provider switching interaction issues |

## v0.15.5 · 2026-11-01

| Type | Content |
|---|---|
| Fixed | Custom model profiles invisible in both entry points after saving |
| Fixed | Quick text selection lost after clicking the chat input |
| Improved | Active-model summary moved below the global AI switch, always visible |

## v0.15.4 · 2026-11-01

| Type | Content |
|---|---|
| Added | Custom profiles support Ollama, LM Studio, vLLM, llama.cpp, LocalAI |
| Added | Custom model capabilities: model list, connection test, context slider, model picker |
| Added | AI instruction library entry: quick-command chips and `/` command list |
| Added | Built-in providers expanded to 54, grouped by local / China / international |
| Fixed | Custom models leaking into the provider dropdown |
| Fixed | Chat context not following the selection |
| Fixed | Document jitter on every keystroke and undo |
| Fixed | Missing local models in Ollama model list |

## v0.15.3 · 2026-10-30

| Type | Content |
|---|---|
| Added | Settings window widened to 780px |
| Added | AI settings arranged as a tree: master switch → model → translation → instructions |
| Added | Model settings with two tabs: providers / custom model API |
| Added | Context-window slider based on model metadata |
| Added | Three protocols: OpenAI Chat, OpenAI Responses, Anthropic Messages |
| Added | Vendor coding-plan presets |
| Fixed | AI requests were always sent over a single protocol; now unified across all three |

## v0.15.2 · 2026-10-28

| Type | Content |
|---|---|
| Added | Slide animation when switching read ↔ edit modes |
| Fixed | Heading collapse folded much faster than it expanded |
| Fixed | Preview pane misaligned after double-Ctrl mode switching |
| Fixed | Scroll jitter during cross-mode undo / redo |

## v0.15.1 · 2026-10-28

| Type | Content |
|---|---|
| Fixed | Edits made in read mode never entered the undo timeline |
| Fixed | Viewport drifting after repeated double-Ctrl toggles |
| Improved | Search box redesign, all-match highlight and active-match color |
| Fixed | Workspace search: no response, always jumping to the first match, wrong line numbers |
| Fixed | Collapse animation timing |

## v0.15.0 · 2026-10-26 ~ 10-27

| Type | Content |
|---|---|
| Added | Cross-mode unified undo timeline |
| Added | Deep AI configuration: dual protocols, Ollama, instruction library, token usage |
| Added | Workspace-wide full-text search |
| Added | Read ↔ edit content alignment |
| Added | Heading folding in read mode |
| Added | Image lightbox |
| Added | PDF export through in-app WebView2 |
| Fixed | Interaction and rendering issues found in real-machine testing |

## v0.14.0 · 2026-10-23 ~ 10-26

| Type | Content |
|---|---|
| Added | Edit mode merges split view: source on the left, live preview on the right, preview can be slid in and out |
| Added | Search options: whole word, match case, selection only, regex |
| Added | "Find in all open files" result bar with replace-all |
| Added | Replacements enter the undo stack, including cross-file replacements |
| Added | Search re-evaluates automatically when switching documents |
| Added | Software update section in Settings |
| Added | Table column widths and row heights persisted with the document |
| Fixed | Split divider could only be dragged one way |
| Fixed | Vertical close/open preview buttons unresponsive |
| Fixed | Reading position lost when switching or closing documents |
| Fixed | Reading focus shifted after closing preview; document drifted upward after repeated toggles |
| Fixed | Update check falsely reported GitHub connection failure |
| Fixed | Search box broke after undoing a replacement; keyboard undo failed after cross-file replace |
| Fixed | Replacements in read mode did not apply immediately |
| Fixed | Recent panel not opening, folder section too short, sidebar stutter |
| Fixed | Title-bar dropdown hidden behind the editor |
| Fixed | Preview toggle animation felt abrupt |
| Fixed | Panes could not scroll in sync due to differing lengths |
| Fixed | Table sizes not restored after reopening the document |

## v0.13.2 · 2026-10-17

| Type | Content |
|---|---|
| Added | Single click enters edit mode for code blocks, formulas, mermaid and table cells |
| Added | Persistent drag handle and block menu: cut / copy / paste / delete / format painter / select block / move up / move down |
| Added | Block-level copy/cut as Markdown, HTML or native block data |
| Added | Auto save compares disk content before writing |
| Added | Three external-change policies: auto reload / ask / always prompt |
| Added | Standalone files (not in an opened folder) also react to external changes |
| Fixed | Code-block copy button, `Ctrl+T` task item, mermaid upper-half editing |
| Fixed | Image handle, click-to-select and edge resize |
| Fixed | Image manager and search popup animations |
| Fixed | Outline scroll-follow and position memory |
| Fixed | Split-view sync reworked as bidirectional mapping |
| Fixed | Undo / redo kept strictly per document |
| Fixed | Merged table cells corrupted after saving |
| Fixed | Continue writing after tables/code blocks, Enter moves down a column, Backspace no longer swallows across cells |

## v0.13.1 · 2026-10-16

| Type | Content |
|---|---|
| Fixed | Dragging table borders resizes instead of selecting text |
| Fixed | Backspace no longer swallows content across cells |
| Fixed | Switching tabs no longer falsely reports "saved in another window" |
| Fixed | 16 other interaction and rendering issues |

## v0.13.0 · 2026-10-14 ~ 10-15

| Type | Content |
|---|---|
| Added | Read-mode block interaction: click to edit, drag handle, block menu |
| Added | External changes refresh immediately and auto save never overwrites |
| Added | Image left / center / right alignment, applied to preview and exports |
| Added | Code-block copy button |
| Added | `Ctrl+P` quick file switcher (open tabs / recent / workspace, fuzzy match) |
| Added | Heading folding in the outline panel |
| Added | `Ctrl+/` batch comment |
| Added | Block-level source markers (list / task / horizontal rule / math / toc / mermaid) |
| Added | Emoji shortcode completion |
| Added | Image manager: list document images and unreferenced files, convert, rename, clean up |
| Added | Table cell merge and split |
| Fixed | 14 issues from real-machine testing: table edge selection, toolbar occlusion, emoji false triggers, alignment lost on export |

## v0.12.3 · 2026-10-12

| Type | Content |
|---|---|
| Fixed | Extra blank lines when pressing Enter in read mode: Enter now inserts an in-paragraph line break |
| Fixed | Line spacing in read mode; line-height setting applies in all three surfaces |
| Fixed | Line-leading syntax in continuation lines swallowed into headings / lists |

## v0.12.2 · 2026-10-12

| Type | Content |
|---|---|
| Fixed | White-screen crash opening documents with emoji shortcodes |
| Fixed | Image width suffix silently removed |
| Fixed | Enter with a cross-block selection merged paragraphs and lost content |
| Fixed | `$` and `==` escaped incorrectly |
| Fixed | Anchor `id` invalid after editing headings |
| Fixed | Double zoom and non-full-width content in the split preview |
| Fixed | Focus lost when dragging typography settings; wrong reading progress |
| Fixed | Export styles not following application settings |

## v0.12.1 · 2026-10-09 ~ 10-10

| Type | Content |
|---|---|
| Added | Heading level badges: click `H1`–`H6` to change the level |
| Added | Auto-pairing reworked, shared by read / edit / split modes |
| Added | Pairing scope settings: brackets / quotes / Chinese punctuation |
| Added | Task items support square and round checkboxes |
| Added | Live preview while adjusting typography settings |
| Fixed | Pairing false triggers, duplicate quotes, unreliable Chinese punctuation completion |
| Fixed | Heading badge alignment and wrapping; outline levels not updating |
| Fixed | Images disappearing after switching documents; task checkbox alignment |
| Fixed | Code blocks could not be exited with `→`; settings dialog animation |
| Fixed | Editor scrollbar position |

## v0.12.0 · 2026-10-08

| Type | Content |
|---|---|
| Added | Document zoom: `Ctrl+wheel` or the zoom ruler, 50%–200% |
| Added | Format Painter: works in all modes, click once or double-click to stay armed |
| Added | Block selection and delete; drag blocks by the handle |
| Added | Format placeholder ghosts: syntax only until you type |
| Added | Viewport focus preserved after collapsing panes, resizing or dragging the divider |
| Added | About section in Settings with version and project link |
| Fixed | Heading source symbols jittering in read mode |
| Fixed | Focus mode bright area extended to three lines |
| Fixed | Folder expand / collapse animation timing |

## v0.11.0 · 2026-10-07

| Type | Content |
|---|---|
| Fixed | `Shift+Enter` inside code/math blocks broke block structure |
| Fixed | Deleting a row on table headers lost the header |
| Fixed | Image size syntax lost in split preview and exports |
| Improved | Self-contained HTML export works offline with formulas and charts |
| Improved | PDF headers/footers complete on every page without leaking internal paths |
| Improved | DOCX / EPUB / LaTeX export covers task lists, definition lists, images, nested TOC |
| Fixed | Command palette gaps, source-mode format shortcuts, footnote numbering |
| Fixed | `~` / `^` false escaping, ordered list `1)` asymmetry |
| Improved | Font size / family / typography settings take effect and persist |
| Improved | In-document anchor jumps, live `[toc]`, emoji rendering, image lightbox, reading progress |
| Fixed | `Alt+↑/↓` changed to real block movement |

## v0.10.0 · 2026-10-07

| Type | Content |
|---|---|
| Added | Unified render pipeline shared by preview and every export path |
| Added | Formula and chart fidelity in exports: KaTeX, mermaid SVG, native MathML in ePub |
| Added | Regex search and replace with `$1` / `$&` capture groups |
| Added | Outline limit raised to 1000 items |
| Fixed | Dangerous links blocked on export paths as well |
| Improved | PDF export timing and browser path detection |

## v0.9.5 · 2026-10-02

| Type | Content |
|---|---|
| Added | In-document links open target files and scroll to anchors |
| Added | Favorites / Recent sidebar layout reworked |
| Improved | Mermaid render cache, focus mode performance |
| Fixed | Task items and footnotes keep their block structure |
| Fixed | Save-as did not refresh the file tree or syntax highlighting |
| Fixed | Images pasted into temporary files missing after restart |
| Fixed | Split preview briefly showing the previous document |
| Fixed | Session restore reviving manually closed tabs |

## v0.9.4 · 2026-10-01

| Type | Content |
|---|---|
| Added | Inline syntax markers shown when the cursor enters inline formatting |
| Added | Markdown-aware paste converts rich text and Markdown-looking plain text |
| Added | Code-block language dropdown and soft-wrap toggle; highlighted languages 27 → 34 |
| Fixed | Undo history across modes: no empty steps, no accidental clears |

## v0.9.3 · 2026-10-01

| Type | Content |
|---|---|
| Added | Underline: `Ctrl+U` in read mode, `<u></u>` in source mode |
| Added | Type-as-you-get rules for formulas, links, images, footnotes |
| Added | Minimal HTML whitelist: `u`, `br`, `sub`, `sup`, `mark` |
| Added | Image size syntax and image dialog (alt text, width) |
| Added | Default insert-link shortcut `Ctrl+Shift+K` |

## v0.9.2 · 2026-10-01

| Type | Content |
|---|---|
| Added | In-paragraph line-break semantics setting (GFM / CommonMark) |
| Added | "Recent" collapsed by default |
| Fixed | Format commands in read mode inserted literal text |
| Fixed | Tab did nothing inside code blocks, task lists and tables |
| Fixed | `---` and fenced code in lists / quotes converted incorrectly |
| Fixed | English text leaking into the table context menu; header row offering "delete row" |
| Fixed | Backspace during IME composition deleting paired characters |

## v0.9.1 · 2026-09-30

| Type | Content |
|---|---|
| Added | Shortcut editor reworked into a 3×3 grid showing all bindings at once |
| Added | Open / close animation for dialogs |
| Added | `F11` immersive fullscreen hides all four panes |
| Fixed | `Ctrl+,` captured by the IME so Settings would not open |
| Fixed | `F11` and other keys never reaching the page |
| Fixed | Settings dialog background clutter; shortcut dialog squeezed narrow |

## v0.9.0 · 2026-09-30

| Type | Content |
|---|---|
| Added | Multiple windows (up to 8), each with independent tabs and editor state |
| Added | Open in new window; title-bar Window menu |
| Added | File conflict detection when the same file is open in several windows |
| Added | External change and deletion handling |
| Added | Multi-window session restore |
| Added | Per-window and global state separation; directory watcher reference counting |

## v0.8.5 · 2026-09-26

| Type | Content |
|---|---|
| Added | Deleting files / folders moves them to the system recycle bin |
| Added | "Recent" includes folders |
| Added | File entry icons distinguish real files from temporary ones |
| Added | Open / close animations for file-tree search, sort menu, new-file dialog and search panel |
| Fixed | Background flashing during the new-file dialog animation |

## v0.8.4 · 2026-09-24

| Type | Content |
|---|---|
| Added | Drag files / folders to copy, `Shift` to move |
| Added | Drag to reorder within a folder, persisted across restarts |
| Added | Right-click copy / cut / paste in the file tree; blank-area context menu |
| Added | Centered new-file dialog |
| Added | Six sort modes in folder headers |
| Added | File tree refreshes live on external changes |
| Added | Outline hover search |
| Fixed | Stale-path indicator in "Recent" |

## v0.8.3 · 2026-09-22

| Type | Content |
|---|---|
| Added | Status bar shows cursor line/column and selected character count |
| Added | Window size and position remembered |
| Added | Reading position remembered across sessions |
| Added | "Recent" shows up to 66 entries with dates |
| Added | Startup restore focuses the last active tab |
| Added | Image lazy loading and passive scroll listeners |
| Fixed | Status bar line number always 1 |
| Fixed | Full document serialization on every selection change |
| Fixed | Double highlight in the "Open files" panel |

## v0.8.2 · 2026-09-21

| Type | Content |
|---|---|
| Added | File pane open / close animations with slide and height expansion |
| Added | Folder tree expand / collapse animation |
| Added | Newest folder and file entries pinned to the top |
| Fixed | Clicking a subfolder could freeze the app |
| Fixed | Title-bar "New folder" did nothing |
| Fixed | Sidebar occasionally not draggable |

## v0.8.1 · 2026-09-19

| Type | Content |
|---|---|
| Added | Frameless unified window with minimize / maximize / close at top right |
| Added | Maximized on first launch |
| Added | Thinner sidebar scrollbars; wider default panes |
| Added | File properties in an in-app dialog with copyable path |

## v0.8.0 · 2026-09-18

| Type | Content |
|---|---|
| Added | Temporary untitled tabs, saved to a chosen location on first save |
| Added | Tab bar improvements: overflow scrolling, pinned tabs, 9-item context menu |
| Added | File tree copy / cut / paste / drag |
| Added | New-folder dialog; open containing folder |
| Added | Sidebar layout rework: draggable section heights, floating scroll arrows |
| Added | ePub and LaTeX export |
| Added | Chinese punctuation completion and paired deletion |
| Added | Typewriter mode centers immediately; mode switching anchored by content |
| Fixed | Line breaks lost inside list items with multiple paragraphs and nesting |

## v0.7.5 · 2026-09-13

| Type | Content |
|---|---|
| Added | AI chat window shared by three entry points, multi-turn conversations |
| Added | Three context levels and 6 quick command templates |
| Added | Result action bar and insert-as-you-see |
| Added | Chat window position and size remembered |

## v0.7.4 · 2026-09-13

| Type | Content |
|---|---|
| Added | AI bubble buttons beside the selection: translate / continue / polish / summarize |
| Added | AI summary as a Word-comment style popup |
| Added | Status bar AI panel and "pin AI entry" |
| Fixed | AI bubbles writing into the wrong document |

## v0.7.3 · 2026-09-12

| Type | Content |
|---|---|
| Added | Temperature setting; faster full-document translation with progress |
| Fixed | Silent failures now surface as notifications |
| Fixed | Providers rejecting non-1 temperature values |
| Fixed | Translated text written at the wrong offset |
| Fixed | No ghost preview for continuation in source mode |

## v0.7.2 · 2026-09-10

| Type | Content |
|---|---|
| Added | Built-in providers expanded to 22 |
| Added | API keys stored per provider |
| Added | Fetch live model lists from providers |
| Fixed | Model suggestion popup filtering |

## v0.7.1 · 2026-09-08

| Type | Content |
|---|---|
| Added | Selection action buttons extended to translate / continue / polish / summarize |
| Added | AI bubble delay configurable |
| Added | Token usage shown as input / output |
| Fixed | Duplicate leading text in streamed continuation |

## v0.7.0 · 2026-09-07

| Type | Content |
|---|---|
| Added | AI continue / polish / summarize assistant tasks |
| Added | Floating translate button beside the selection and AI bubbles with delay |
| Added | Status bar AI drawer and global AI master switch |

## v0.6.6 · 2026-09-01

| Type | Content |
|---|---|
| Added | Slash commands available in read mode |
| Added | Inline base64 images shown as compact markers |
| Fixed | Blank lines lost after consecutive Enter on a new document |
| Fixed | `Delete` closing temporary files while editing |

## v0.6.5 · 2026-08-29

| Type | Content |
|---|---|
| Fixed | Paragraphs containing links / inline code / images failed translation; placeholders now preserved |

## v0.6.4 · 2026-08-29

| Type | Content |
|---|---|
| Fixed | Translation failure notice placement and auto-dismiss |
| Fixed | Image-only blocks and image alt text mistranslated |

## v0.6.3 · 2026-08-29

| Type | Content |
|---|---|
| Fixed | Translation pipeline stability and security hardening |

## v0.6.2 · 2026-08-27

| Type | Content |
|---|---|
| Improved | Translation speed |
| Improved | Uninstall clears translation API keys |
| Improved | Translation off by default for new users |

## v0.6.1 · 2026-08-26

| Type | Content |
|---|---|
| Added | Full-document translation, cancel translation, read / edit toggle button |
| Fixed | Long-press Ctrl falsely triggering mode switch |

## v0.6.0 · 2026-08-23

| Type | Content |
|---|---|
| Added | Selection and full-document translation from multiple entry points |
| Added | Two result modes: replace directly or bilingual |
| Added | Streaming translation bubble with localized error codes |
| Added | AI translation settings section |
| Added | API keys stored in Windows Credential Manager |

## v0.5.0 · 2026-08-23

| Type | Content |
|---|---|
| Added | Auto-pairing completion, can be disabled |
| Added | Smart link paste |
| Added | Live preview for block formulas while editing |
| Added | Language auto-detection for unlabeled code blocks |
| Added | Open containing folder |
| Fixed | Table column border dragging unresponsive in read mode |
| Improved | Removed file associations for script files |

## v0.4.5 · 2026-07-16

| Type | Content |
|---|---|
| Added | Drag column borders in read mode while keeping the total table width |
| Fixed | Unresponsive dragging and table collapse |
| Fixed | Search highlight mismatch in non-markdown files |

## v0.4.4 · 2026-07-15

| Type | Content |
|---|---|
| Fixed | Table column resize collapsing the table |
| Fixed | Search highlight offset in non-markdown files |

## v0.4.3 · 2026-07-15

| Type | Content |
|---|---|
| Added | Global file search in the sidebar |
| Added | Multiple folder panes with minimize / maximize / close and height dragging |
| Fixed | Sidebar header height dragging inverted |

## v0.4.2 · 2026-07-14

| Type | Content |
|---|---|
| Added | Search and replace in non-markdown files |
| Added | Table column resize adjusts only adjacent columns |
| Added | "Open files" as a separate pane with draggable height |
| Fixed | "Open last folders" switch bypassed on startup |

## v0.4.1 · 2026-07-13

| Type | Content |
|---|---|
| Added | Collapse / expand / close buttons and height dragging for favorites and recent sections |
| Added | Snapshot window maximize and synchronized scrolling |

## v0.4.0 · 2026-07-12

| Type | Content |
|---|---|
| Added | Multiple folders with independent trees in the sidebar |
| Added | Syntax highlighting for code files |
| Added | Draggable sidebar width and split ratio |
| Added | Version snapshots: up to 5 versions, diff view and one-click restore |

## v0.3.5 · 2026-07-11

| Type | Content |
|---|---|
| Added | Search highlighting always visible in read mode |
| Added | Search box as a draggable floating window |
| Fixed | Typewriter mode stopped working |
| Fixed | Column resize adjusted all columns instead of one |

## v0.3.4 · 2026-07-09

| Type | Content |
|---|---|
| Added | Search entry in the status bar, auto-save interval setting, open recent files on startup |
| Fixed | Images missing when exporting documents with images |
| Fixed | Tab highlight and search positioning in read mode |

## v0.3.3 · 2026-07-08

| Type | Content |
|---|---|
| Fixed | File list showing full paths instead of names |
| Fixed | Exported documents with images came out blank |
| Fixed | Table width and height could not be dragged |

## v0.3.2 · 2026-07-07

| Type | Content |
|---|---|
| Added | Tabs show document name and path |
| Fixed | Table column resizing; outline drag insertion position |
| Fixed | Image insert dialog; word count display |
| Fixed | Spell-check toggle not taking effect |

## v0.3.1 · 2026-07-05

| Type | Content |
|---|---|
| Added | Export path selection, image cropping, table column resizing, outline drag sorting |
| Fixed | Dropping a markdown file reported "not a directory"; startup folder loading |
| Fixed | Opening a folder by drag lost favorites |

## v0.3.0 · 2026-07-04

| Type | Content |
|---|---|
| Added | File favorites and recent files |
| Added | Configurable auto-save interval |
| Added | Visual table editing: add/remove rows and columns, column alignment, floating toolbar |
| Added | Image editing dialog: crop and rotate |
| Added | PNG, Word and PDF export |
| Added | Spell-check toggle, mermaid template dropdown, outline drag sorting |
