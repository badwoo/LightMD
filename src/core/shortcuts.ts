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
  // 单字符键（字母/符号）大写归一：Ctrl+n 与 Ctrl+N 视为同一绑定；
  // 功能键同样大小写归一（"f4"/"alt+f4" 与 "F4"/"Alt+F4" 是同一条，否则
  // 保留清单和冲突检测会被手写/外部来源的小写写法绕过）
  const key = keys
    .map((k) => (k.length === 1 || /^f([1-9]|1[0-2])$/i.test(k) ? k.toUpperCase() : k))
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
  // 说明：基线表把这两条标为「富文本+源码」作用域。实现上它们是**命令面板既有命令**，
  // 唯一派发路径是 App.tsx 的 lightmd:command 路由器（INSERT 类命令由 COMMAND_SYNTAX
  // 处理），因此这里只能登记为 global 才能同时覆盖源码/富文本两种编辑面；
  // 为消除副作用，App.tsx 侧已加「仅可编辑面才派发」守卫（只读标签不再被写入）。
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
  "Esc", "Escape", // 各对话框取消/关闭（e.key 实际值为 "Escape"，两种写法都登记）
  "Enter", "Shift+Enter",
  "Tab", "Shift+Tab",
  "Alt+ArrowUp", "Alt+ArrowDown", // PM 移动块
  // ── 编辑器/浏览器原生行为键（不在静态 keymap，而在 PM baseKeymap 与原生编辑上）──
  // 用户若把这些绑成自定义键，会「抢掉」选区/词跳转/删词等原生行为（v0.9.0 review 补充）
  "Ctrl+A", // PM baseKeymap: selectAll
  "Ctrl+Enter", // PM baseKeymap: exitCode
  "Ctrl+Backspace", "Ctrl+Delete", // PM baseKeymap / 原生删词
  "Ctrl+ArrowLeft", "Ctrl+ArrowRight", // 原生按词跳转（P7 关注的正是这类键）
  "Ctrl+Home", "Ctrl+End",
]);

/** 浏览器/系统级组合键：**允许绑定但提示可能被系统拦截**（计划 §2.3 冲突策略第 3 行）。
 * 这些键在 WebView 里未必到得了页面，故不做硬拒绝，只在录入成功后给出黄色提示。 */
export const SYSTEM_COMBOS: readonly string[] = Object.freeze([
  "Alt+F4", "Alt+Tab", "Ctrl+Alt+Delete", "Ctrl+Shift+Esc",
  "Meta+Tab", "Meta+Space", "Meta+D", "Meta+L",
]);

/** 是否为系统级组合键（单纯提示，不阻止写入） */
export function isSystemCombo(combo: string): boolean {
  const norm = normalizeCombo(combo);
  return SYSTEM_COMBOS.some((c) => normalizeCombo(c) === norm);
}

// ─── 运行时（用户自定义覆盖） ─────────────────────────

/** 用户自定义覆盖表：id → 归一化键位。由 useSettingsStore 订阅注入。 */
let overrides: Record<string, string> = {};
/** 上一次注入的引用，避免 store 任意字段变化都重建索引 */
let lastOverrides: Record<string, string> | undefined;

/** id → def 索引（避免展示点每次渲染线性查找） */
const DEF_BY_ID: Map<string, ShortcutDef> = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));

/** 归一化生效键位 → defs（同键位多 def 时保持 SHORTCUT_DEFS 顺序）。
 * 注意：这是 keydown 热路径（每键一次），必须 O(1)；故用索引而非线性归一化比较。 */
let comboIndex: Map<string, ShortcutDef[]> | null = null;

function rebuildComboIndex(): void {
  const idx = new Map<string, ShortcutDef[]>();
  for (const def of SHORTCUT_DEFS) {
    const combo = normalizeCombo(effectiveCombo(def));
    const list = idx.get(combo);
    if (list) list.push(def);
    else idx.set(combo, [def]);
  }
  comboIndex = idx;
}

function getComboIndex(): Map<string, ShortcutDef[]> {
  if (!comboIndex) rebuildComboIndex();
  return comboIndex as Map<string, ShortcutDef[]>;
}

export function setShortcutOverrides(o: Record<string, string> | undefined): void {
  const next = o && typeof o === "object" ? o : {};
  if (next === lastOverrides) return; // 引用未变：索引无需重建
  lastOverrides = next;
  overrides = next;
  rebuildComboIndex();
}

/** 生效键位 = 用户覆盖 ?? 默认值 */
export function effectiveCombo(def: ShortcutDef): string {
  return overrides[def.id] ?? def.defaultCombo;
}

/** 按 id 取条目（未登记返回 undefined） */
export function getShortcutDef(id: string): ShortcutDef | undefined {
  return DEF_BY_ID.get(id);
}

/** 键名展示美化：方向键用箭头符号（与基线表「Ctrl+Alt+←」写法一致）。 */
const DISPLAY_KEY: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Escape: "Esc", Space: "Space", Backquote: "`", Plus: "+",
};

export function formatComboForDisplay(combo: string): string {
  if (!combo) return combo;
  return combo
    .split("+")
    .map((part) => DISPLAY_KEY[part] ?? part)
    .join("+");
}

/** 展示用生效键位（未登记 id 回退到覆盖表；供命令面板/菜单/工具栏 tooltip 动态读取） */
export function getShortcutLabel(id: string): string | undefined {
  const def = DEF_BY_ID.get(id);
  if (def) return formatComboForDisplay(effectiveCombo(def));
  const override = overrides[id];
  return override ? formatComboForDisplay(override) : undefined;
}

/** 该条目是否被用户改绑过。
 *
 * 用于 editableGate 的**条件门控**：计划 P7 的原意是「用户把折叠键改回 Ctrl+← 类
 * 编辑器原生键后，不要吞掉词跳转」。默认键位（Ctrl+Alt+←/→、Ctrl+Shift+B）本身
 * 与编辑器原生行为无冲突，若无条件门控，编辑器一有焦点这三个功能就整体失效。 */
export function isShortcutOverridden(id: string): boolean {
  return overrides[id] !== undefined;
}

/** 恢复单项默认键位是否会与别的条目撞车。
 *
 * `setShortcut` 会拦住冲突写入，但 `resetShortcut` 是「删掉覆盖项、回落到默认值」——
 * 若那个默认键位已被别的条目改绑占用（先 A→Ctrl+I，再 B→Ctrl+Shift+I，再恢复 A），
 * 就会产生两条同键位绑定：表内靠前的条目独占该键，另一条永远按不出来。
 * 返回占用者；null 表示可以安全恢复。
 */
export function findResetCollision(id: string): { id: string; combo: string } | null {
  const def = DEF_BY_ID.get(id);
  if (!def) return null;
  const target = normalizeCombo(def.defaultCombo);
  for (const other of SHORTCUT_DEFS) {
    if (other.id === id) continue;
    if (normalizeCombo(effectiveCombo(other)) === target) {
      return { id: other.id, combo: effectiveCombo(other) };
    }
  }
  return null;
}

// ─── 事件组合键解析 ───────────────────────────────────

/** Ctrl/Alt/Meta 按下时浏览器不产出移位字符，按 e.code 还原主键名（Digit8 → "8" 等） */
const CODE_KEY_FALLBACK: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** 规范修饰键名集合（用于识别「只剩修饰键」的非法绑定） */
const MODIFIER_SET: ReadonlySet<string> = new Set<string>(MODIFIER_ORDER);

/** 单字符 ASCII 字母/数字（这类 e.key 可信；其余一律以 e.code 还原物理键） */
const ASCII_ALNUM = /^[A-Za-z0-9]$/;

/** e.code → 键名（KeyA→A / Digit8→8 / 标点表） */
function codeKeyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_KEY_FALLBACK[code] ?? null;
}

/** 从键盘事件取主键名；修饰键自身按下返回 null（不构成组合）。
 *
 * 带修饰键时 `e.key` 不总是可信：Shift+8 产出 "*"、AltGr（右 Alt = Ctrl+Alt）
 * 在德语/波兰语等布局产出第三层字符（ß / ś），俄语等非拉丁布局产出西里尔字母。
 * 这些情况下以 `e.code` 还原物理键，保证 Ctrl+Alt+S(T/O/V/←/→) 等默认键位
 * 在非美式布局下同样可用；`e.key` 是 ASCII 字母/数字时仍沿用（尊重 AZERTY 等
 * 字母重排布局，不把用户按的 A 记成 Q）。
 */
function eventKeyName(e: {
  key: string; code?: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
  getModifierState?: (k: string) => boolean;
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  // AltGr（右 Alt / 布局第三层）：**绝不参与快捷键匹配**。
  // Windows 把 AltGr 报成 ctrlKey+altKey，若继续匹配，德语 AltGr+S("ß")、
  // 波兰语 AltGr+O("ó") 会被当成 Ctrl+Alt+S/O——既吞掉用户正在输入的字符，
  // 又误触「删除线」「打开到新窗口」。AltGr 布局下 Ctrl+Alt+X 类键位需用户改绑。
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) {
    const byCode = codeKeyName(e.code || "");
    if (byCode && !ASCII_ALNUM.test(e.key)) return byCode;
  }
  return e.key === " " ? "Space" : e.key;
}

/** 键盘事件 → 可读组合键（如 "Ctrl+Shift+P"）；仅按修饰键返回 null。
 * Ctrl 与 Meta 等价（Windows Ctrl / macOS Cmd，与 PM "Mod-" 语义一致）。 */
export function comboFromEvent(e: {
  key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
  getModifierState?: (k: string) => boolean;
}): string | null {
  const name = eventKeyName(e);
  if (!name) return null;
  // "+" 键不能用字面量：normalizeCombo 以 "+" 分隔，(NumpadAdd / Shift+=) 会产出
  // "Ctrl+Shift++"，归一化后变成修饰键组合 "Ctrl+Shift"，成为永远触发不了的空绑定。
  const key = name === "+" ? "Plus" : name;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
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

/** 按生效表匹配键盘事件（完全相等匹配，非「至少包含」——Ctrl+S 与 Ctrl+Alt+S 互不误触）。
 *
 * 走归一化键位索引（O(1)）：keydown 是热路径，每键都要查一次，
 * 不能在 48 条默认表上做线性 normalizeCombo 比较。 */
export function matchShortcut(
  e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
  kinds: ScopeKind[],
): ShortcutDef | undefined {
  const combo = comboFromEvent(e);
  if (!combo) return undefined;
  const candidates = getComboIndex().get(normalizeCombo(combo));
  if (!candidates) return undefined;
  for (const def of candidates) {
    if (kinds.some((k) => scopeMatches(def.scope, k))) return def;
  }
  return undefined;
}

/**
 * D5 录入校验：仅 F1~F12 可裸绑；字母/数字/符号必须带 Ctrl 或 Alt（Meta 亦计入）。
 * Shift 单独不构成有效修饰——Shift+t ≡ 输入大写 T，会吞正常输入。
 * 同时拒绝「只剩修饰键」的空绑定（如 "Ctrl+Shift"——键名被 "+" 分隔吃掉的产物），
 * 这类绑定能存进表但永远触发不了。
 */
export function isLegalCombo(combo: string): boolean {
  const norm = normalizeCombo(combo);
  if (!norm) return false;
  const parts = norm.split("+");
  const key = parts[parts.length - 1];
  if (!key || MODIFIER_SET.has(key)) return false;
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

/**
 * 清洗**持久化**的覆盖表（migrateSettings / 手改 localStorage 的防线）。
 *
 * `setShortcut` 只在写入时查重，无法约束已经落盘的脏数据（旧版本写坏、
 * 用户手改 localStorage、两个窗口并发写同一 key）。这里按 SHORTCUT_DEFS
 * 顺序逐条重放「落盘前本该通过的校验」：
 * 未登记 id / 非字符串 / 非法键位（D5）/ 保留占用 / 与他人冲突 → 丢弃；
 * 与自身默认值相同 → 视为未自定义（不写入覆盖表）。
 * 结果与「按顺序调用 setShortcut」等价，保证生效表不会出现两个条目同键位。
 */
export function sanitizeShortcutOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const result: Record<string, string> = {};
  /** 归一化键位 → 当前占用者 id（初始为各条默认键位） */
  const taken = new Map<string, string>();
  for (const def of SHORTCUT_DEFS) taken.set(normalizeCombo(def.defaultCombo), def.id);

  for (const def of SHORTCUT_DEFS) {
    const combo = input[def.id];
    if (typeof combo !== "string" || !combo) continue;
    const norm = normalizeCombo(combo);
    if (!norm || !isLegalCombo(norm)) continue;
    if (RESERVED_COMBOS.some((c) => normalizeCombo(c) === norm)) continue;
    if (norm === normalizeCombo(def.defaultCombo)) continue; // 与默认值相同：无需覆盖
    const owner = taken.get(norm);
    if (owner && owner !== def.id) continue; // 已被默认值或先应用的覆盖占用
    taken.delete(normalizeCombo(def.defaultCombo)); // 让出自身默认键位
    taken.set(norm, def.id);
    result[def.id] = norm;
  }
  return result;
}
