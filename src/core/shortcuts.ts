/**
 * v0.9.0 自定义快捷键：**快捷键默认表 + 生效解析 + 冲突检测**（单源）。
 *
 * 数据源：`.trae/documents/lightmd-v0.9.0-default-shortcuts-baseline.md`（已定稿）。
 *
 * 三条处理链路都从本模块读生效键位：
 * - App.tsx window keydown（scope 含 global）；
 * - ProseMirror 动态 keymap（core/keymap.ts，scope 含 editor/rich）；
 * - 源码模式 parseShortcut（sourceFormat.ts，scope 含 source）。
 *
 * 用户自定义存储在 useSettingsStore.shortcuts（persist v4），
 * 经 setShortcutOverrides 注入本模块运行时——keydown 是事件驱动，
 * 运行时读取避免 React 闭包过期，也免去重建 PM EditorView。
 *
 * 维护约定：
 * - 改默认键位必须同步基线表与 SHORTCUT_DEFS；
 * - 新增绑定必须确认与 RESERVED_COMBOS 及既有 defs 无冲突（回归测试把关）；
 * - 双击 Ctrl/双击 Shift（切阅读/分屏）是双击手势非组合键，不在本表（阈值 220ms）。
 */

/** 修饰键规范顺序（用于组合键归一化，避免 "Shift+Ctrl+X" 与 "Ctrl+Shift+X" 判为不同键） */
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

/** 小写修饰键名 → 规范写法（容忍 "ctrl"/"CTRL"/"Control" 等写法） */
const MODIFIER_CANON: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
};

/** 归一化组合键：修饰键按固定顺序排列、单字符键统一大写。
 * 仅用于**比较/去重**，不改变展示用的可读写法。
 *
 * 例：`Shift+Ctrl+N` → `Ctrl+Shift+N`；`ctrl+shift+n` → `Ctrl+Shift+N`。
 */
export function normalizeCombo(combo: string): string {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const canon = MODIFIER_CANON[p.toLowerCase()];
    if (canon) mods.push(canon);
    else keys.push(p);
  }
  mods.sort(
    (a, b) =>
      MODIFIER_ORDER.indexOf(a as (typeof MODIFIER_ORDER)[number]) -
      MODIFIER_ORDER.indexOf(b as (typeof MODIFIER_ORDER)[number]),
  );
  // 单字符键（字母/符号）大写归一：Ctrl+n 与 Ctrl+N 视为同一绑定
  const key = keys
    .map((k) => (k.length === 1 ? k.toUpperCase() : k))
    .sort()
    .join("+");
  return [...mods, key].filter(Boolean).join("+");
}

// ─── 默认表（v0.9.0 基线，已确认） ─────────────────────

export type ShortcutCategory =
  | "file"
  | "edit"
  | "format"
  | "view"
  | "tab"
  | "window"
  | "insert";

/**
 * 生效作用域：
 * - global：App.tsx window keydown（任何焦点）；
 * - global-editor：全局 + 编辑器（undo/redo——textarea 走自定义栈，PM 走 keymap）；
 * - rich：仅 ProseMirror；source：仅源码 textarea；rich-source：两编辑模式。
 */
export type ShortcutScope = "global" | "global-editor" | "rich" | "rich-source" | "source";

export interface ShortcutDef {
  /** 全局唯一 id，尽量对齐 commands.ts 命令 id */
  id: string;
  category: ShortcutCategory;
  /** i18n key（zh-CN/en-US） */
  labelKey: string;
  /** 默认键位（= 基线表「默认键位」列） */
  defaultCombo: string;
  scope: ShortcutScope;
  /** 派发目标 lightmd:command id（由命令路由/EditorContainer 处理）；缺省 = App 直接执行 */
  command?: string;
  /** 焦点在可编辑元素内不拦截（防改绑后吞词跳转等原生行为） */
  editableGate?: boolean;
}

/** 快捷键默认表（48 条可自定义；🔒 保留项见 RESERVED_COMBOS） */
export const SHORTCUT_DEFS: readonly ShortcutDef[] = Object.freeze([
  // ─── 文件 ───
  { id: "file.new", category: "file", labelKey: "command.file.new", defaultCombo: "Ctrl+N", scope: "global", command: "file.new" },
  { id: "file.open", category: "file", labelKey: "command.file.open", defaultCombo: "Ctrl+O", scope: "global", command: "file.open" },
  { id: "file.save", category: "file", labelKey: "command.file.save", defaultCombo: "Ctrl+S", scope: "global", command: "file.save" },
  { id: "file.saveAs", category: "file", labelKey: "command.file.saveAs", defaultCombo: "Ctrl+Shift+S", scope: "global", command: "file.saveAs" },
  { id: "export.html", category: "file", labelKey: "command.export.html", defaultCombo: "Ctrl+Shift+E", scope: "global", command: "export.html" },
  // ─── 编辑 ───
  { id: "edit.undo", category: "edit", labelKey: "command.edit.undo", defaultCombo: "Ctrl+Z", scope: "global-editor" },
  { id: "edit.redo", category: "edit", labelKey: "command.edit.redo", defaultCombo: "Ctrl+Y", scope: "global-editor" },
  { id: "edit.redo2", category: "edit", labelKey: "shortcut.edit.redo2", defaultCombo: "Ctrl+Shift+Z", scope: "global-editor" },
  { id: "edit.find", category: "edit", labelKey: "command.edit.find", defaultCombo: "Ctrl+F", scope: "global", command: "edit.find" },
  { id: "edit.replace", category: "edit", labelKey: "command.edit.replace", defaultCombo: "Ctrl+H", scope: "global", command: "edit.replace" },
  { id: "edit.translate", category: "edit", labelKey: "command.edit.translate", defaultCombo: "F6", scope: "global", command: "edit.translate" },
  { id: "edit.translateDocument", category: "edit", labelKey: "command.edit.translateDocument", defaultCombo: "Shift+F6", scope: "global", command: "edit.translateDocument" },
  { id: "ai.chat", category: "edit", labelKey: "command.ai.chat", defaultCombo: "Ctrl+K", scope: "global", command: "ai.chat" },
  // ─── 格式 ───
  { id: "format.bold", category: "format", labelKey: "command.format.bold", defaultCombo: "Ctrl+B", scope: "rich-source" },
  { id: "format.italic", category: "format", labelKey: "command.format.italic", defaultCombo: "Ctrl+I", scope: "rich-source" },
  // D1 已拍板：删除线两编辑模式统一 Ctrl+Alt+S（原富文本 Ctrl+Shift+S 废弃）
  { id: "format.strikethrough", category: "format", labelKey: "command.format.strikethrough", defaultCombo: "Ctrl+Alt+S", scope: "rich-source" },
  { id: "format.inlineCode", category: "format", labelKey: "command.format.inlineCode", defaultCombo: "Ctrl+`", scope: "rich-source" },
  { id: "format.math", category: "format", labelKey: "shortcut.format.math", defaultCombo: "Ctrl+Shift+M", scope: "source" },
  { id: "format.heading1", category: "format", labelKey: "command.format.heading1", defaultCombo: "Ctrl+1", scope: "rich-source" },
  { id: "format.heading2", category: "format", labelKey: "command.format.heading2", defaultCombo: "Ctrl+2", scope: "rich-source" },
  { id: "format.heading3", category: "format", labelKey: "command.format.heading3", defaultCombo: "Ctrl+3", scope: "rich-source" },
  { id: "format.heading4", category: "format", labelKey: "shortcut.format.heading4", defaultCombo: "Ctrl+4", scope: "rich-source" },
  { id: "format.heading5", category: "format", labelKey: "shortcut.format.heading5", defaultCombo: "Ctrl+5", scope: "rich-source" },
  { id: "format.heading6", category: "format", labelKey: "shortcut.format.heading6", defaultCombo: "Ctrl+6", scope: "rich-source" },
  { id: "format.paragraph", category: "format", labelKey: "shortcut.format.paragraph", defaultCombo: "Ctrl+0", scope: "rich-source" },
  { id: "format.bulletList", category: "format", labelKey: "shortcut.format.bulletList", defaultCombo: "Ctrl+Shift+8", scope: "rich" },
  { id: "format.orderedList", category: "format", labelKey: "shortcut.format.orderedList", defaultCombo: "Ctrl+Shift+9", scope: "rich" },
  { id: "format.blockquote", category: "format", labelKey: "shortcut.format.blockquote", defaultCombo: "Ctrl+Shift+.", scope: "rich" },
  // ─── 视图 ───
  { id: "view.toggleTheme", category: "view", labelKey: "command.view.toggleTheme", defaultCombo: "Ctrl+Shift+T", scope: "global", command: "view.toggleTheme" },
  { id: "view.toggleFocusMode", category: "view", labelKey: "command.view.toggleFocusMode", defaultCombo: "F8", scope: "global", command: "view.toggleFocusMode" },
  { id: "view.toggleTypewriter", category: "view", labelKey: "command.view.toggleTypewriter", defaultCombo: "F9", scope: "global", command: "view.toggleTypewriter" },
  { id: "view.toggleOutline", category: "view", labelKey: "command.view.toggleOutline", defaultCombo: "Ctrl+Shift+O", scope: "global", command: "view.toggleOutline" },
  { id: "view.commandPalette", category: "view", labelKey: "shortcut.view.commandPalette", defaultCombo: "Ctrl+Shift+P", scope: "global" },
  { id: "view.snapshot", category: "view", labelKey: "shortcut.view.snapshot", defaultCombo: "Ctrl+Alt+V", scope: "global" },
  { id: "view.settings", category: "view", labelKey: "command.view.settings", defaultCombo: "Ctrl+,", scope: "global", command: "view.settings" },
  // 🆕 v0.9.0：侧栏/大纲栏折叠（AppShell 折叠功能已存在，经命令总线打通）
  // 默认键位无原生冲突；editableGate 防用户改绑回 Ctrl+←/→ 类词跳转键后吞原生行为
  { id: "view.toggleLeft", category: "view", labelKey: "command.view.toggleLeft", defaultCombo: "Ctrl+Alt+ArrowLeft", scope: "global", command: "view.toggleLeft", editableGate: true },
  { id: "view.toggleRight", category: "view", labelKey: "command.view.toggleRight", defaultCombo: "Ctrl+Alt+ArrowRight", scope: "global", command: "view.toggleRight", editableGate: true },
  // 🆕 v0.9.0：标签栏折叠（全新功能）
  { id: "view.toggleTag", category: "view", labelKey: "command.view.toggleTag", defaultCombo: "Ctrl+Shift+B", scope: "global", command: "view.toggleTag", editableGate: true },
  // ─── 标签 ───
  { id: "tab.next", category: "tab", labelKey: "shortcut.tab.next", defaultCombo: "Ctrl+Tab", scope: "global" },
  { id: "tab.prev", category: "tab", labelKey: "shortcut.tab.prev", defaultCombo: "Ctrl+Shift+Tab", scope: "global" },
  { id: "tab.close", category: "tab", labelKey: "shortcut.tab.close", defaultCombo: "Ctrl+W", scope: "global" },
  // ─── 窗口（v0.9.0 多窗口） ───
  { id: "window.new", category: "window", labelKey: "command.window.new", defaultCombo: "Ctrl+Shift+N", scope: "global", command: "window.new" },
  { id: "window.close", category: "window", labelKey: "command.window.close", defaultCombo: "Ctrl+Shift+W", scope: "global", command: "window.close" },
  { id: "window.openInNew", category: "window", labelKey: "command.window.openInNew", defaultCombo: "Ctrl+Alt+O", scope: "global", command: "window.openInNew" },
  { id: "window.quit", category: "window", labelKey: "command.window.quit", defaultCombo: "Ctrl+Q", scope: "global", command: "window.quit" },
  { id: "window.mergeToPrimary", category: "window", labelKey: "command.window.mergeToPrimary", defaultCombo: "Ctrl+Shift+C", scope: "global", command: "window.mergeToPrimary" },
  // ─── 插入（v0.9.0 转正，命令面板既有命令补默认键位） ───
  { id: "insert.table", category: "insert", labelKey: "command.insert.table", defaultCombo: "Ctrl+Alt+T", scope: "global", command: "insert.table" },
  { id: "insert.taskList", category: "insert", labelKey: "command.insert.taskList", defaultCombo: "Ctrl+T", scope: "global", command: "insert.taskList" },
]);

/** 🔒 保留占用清单（不纳入自定义；新增默认键位/用户绑定均不得落入）。
 * 编辑器行为键（Enter/Tab/Alt+↑↓ 等）与双击手势见基线表第九节，此处登记组合键部分。 */
export const RESERVED_COMBOS: readonly string[] = Object.freeze([
  "F11", // 窗口全屏（🔒 新功能）
  "Delete", // 文件树关闭临时文件
  "Backspace", // 文件树关闭临时文件（v0.9.0 由 Ctrl+2 改来）
  "Ctrl+R", // 文件树刷新
  "Ctrl+C", "Ctrl+X", "Ctrl+V", // 文本剪贴板 + 侧栏文件复制/粘贴
  "Esc",
  "Enter", "Shift+Enter",
  "Tab", "Shift+Tab",
  "Alt+ArrowUp", "Alt+ArrowDown", // PM 移动块
]);

// ─── 运行时（用户自定义覆盖） ─────────────────────────

/** 用户自定义覆盖表：id → 归一化键位。由 useSettingsStore 订阅注入。 */
let overrides: Record<string, string> = {};

export function setShortcutOverrides(o: Record<string, string> | undefined): void {
  overrides = o && typeof o === "object" ? o : {};
}

/** 生效键位 = 用户覆盖 ?? 默认值 */
export function effectiveCombo(def: ShortcutDef): string {
  return overrides[def.id] ?? def.defaultCombo;
}

/** 展示用生效键位（未登记 id 返回 undefined；供命令面板/菜单等展示点动态读取） */
export function getShortcutLabel(id: string): string | undefined {
  const def = SHORTCUT_DEFS.find((d) => d.id === id);
  return def ? effectiveCombo(def) : overrides[id];
}

// ─── 事件组合键解析 ───────────────────────────────────

/** Ctrl/Alt/Meta 按下时浏览器不产出移位字符，按 e.code 还原主键名（Digit8 → "8" 等） */
const CODE_KEY_FALLBACK: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** 从键盘事件取主键名；修饰键自身按下返回 null（不构成组合） */
function eventKeyName(e: {
  key: string; code?: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) {
    const digit = /^Digit([0-9])$/.exec(e.code || "");
    if (digit) return digit[1];
    const fallback = CODE_KEY_FALLBACK[e.code || ""];
    if (fallback) return fallback;
  }
  return e.key === " " ? "Space" : e.key;
}

/** 键盘事件 → 可读组合键（如 "Ctrl+Shift+P"）；仅按修饰键返回 null。
 * Ctrl 与 Meta 等价（Windows Ctrl / macOS Cmd，与 PM "Mod-" 语义一致）。 */
export function comboFromEvent(e: {
  key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
}): string | null {
  const name = eventKeyName(e);
  if (!name) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, name.length === 1 ? name.toUpperCase() : name].join("+");
}

// ─── 匹配与冲突检测 ───────────────────────────────────

/** 匹配维度：global=window 全局；editor=PM/textarea 编辑器；rich=富文本；source=源码 */
export type ScopeKind = "global" | "editor" | "rich" | "source";

function scopeMatches(defScope: ShortcutScope, kind: ScopeKind): boolean {
  switch (kind) {
    case "global":
      return defScope === "global";
    case "editor":
      return defScope === "global-editor";
    case "rich":
      return defScope === "rich" || defScope === "rich-source";
    case "source":
      return defScope === "source" || defScope === "rich-source";
  }
}

/** 按生效表匹配键盘事件（完全相等匹配，非「至少包含」——Ctrl+S 与 Ctrl+Alt+S 互不误触） */
export function matchShortcut(
  e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
  kinds: ScopeKind[],
): ShortcutDef | undefined {
  const combo = comboFromEvent(e);
  if (!combo) return undefined;
  const norm = normalizeCombo(combo);
  for (const def of SHORTCUT_DEFS) {
    if (!kinds.some((k) => scopeMatches(def.scope, k))) continue;
    if (normalizeCombo(effectiveCombo(def)) === norm) return def;
  }
  return undefined;
}

/**
 * D5 录入校验：仅 F1~F12 可裸绑；字母/数字/符号必须带 Ctrl 或 Alt（Meta 亦计入）。
 * Shift 单独不构成有效修饰——Shift+t ≡ 输入大写 T，会吞正常输入。
 */
export function isLegalCombo(combo: string): boolean {
  const norm = normalizeCombo(combo);
  if (!norm) return false;
  const parts = norm.split("+");
  const key = parts[parts.length - 1];
  const hasQualifier = parts.slice(0, -1).some((m) => m === "Ctrl" || m === "Alt" || m === "Meta");
  if (hasQualifier) return true;
  return /^F([1-9]|1[0-2])$/.test(key);
}

/** 冲突结果：null=可用 */
export type ShortcutConflict =
  | { type: "illegal" }
  | { type: "def"; id: string }
  | { type: "reserved"; combo: string }
  | null;

/** 新绑定查重：保留占用 → 其他条目占用 → D5 校验（保留键如 Backspace 先于 D5 判定） */
export function findShortcutConflict(id: string, combo: string): ShortcutConflict {
  const norm = normalizeCombo(combo);
  if (!norm) return { type: "illegal" };
  const reserved = RESERVED_COMBOS.find((c) => normalizeCombo(c) === norm);
  if (reserved) return { type: "reserved", combo: reserved };
  if (!isLegalCombo(norm)) return { type: "illegal" };
  for (const def of SHORTCUT_DEFS) {
    if (def.id === id) continue;
    if (normalizeCombo(effectiveCombo(def)) === norm) return { type: "def", id: def.id };
  }
  return null;
}

/** 找出默认表中的重复绑定（应恒为空，回归测试把关） */
export function findDuplicateCombos(): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const def of SHORTCUT_DEFS) {
    const c = normalizeCombo(def.defaultCombo);
    if (seen.has(c)) dup.add(c);
    seen.add(c);
  }
  return [...dup];
}
