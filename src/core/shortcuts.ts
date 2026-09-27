/**
 * v0.9.0 WP2：**应用级快捷键绑定表**（回归断言数据源）。
 *
 * 背景：v0.9.0 新增「新建窗口 / 关闭窗口 / 打开到新窗口」三条快捷键。历史上
 * 该项目已发生过一次快捷键冲突（PRD 以为 `Ctrl+Shift+O` 空闲，实际已被「切换
 * 大纲栏」占用，见实施计划 F9），故把应用级绑定收敛成一张可断言的表：
 * `src/__tests__/v0.9.0-shortcuts.test.ts` 用它检测重复绑定。
 *
 * 维护约定：
 * - 只登记 **App.tsx `keydown` 监听里处理**的全局/窗口级快捷键；
 * - ProseMirror 内部的编辑快捷键（Ctrl+B/I、Ctrl+Alt+S 等）不在此表——
 *   它们由 `core/editor.ts` 的 keymap 在编辑器获得焦点时处理，作用域不同；
 * - 新增绑定必须同时更新本表与 App.tsx 的 handler，否则回归测试失去意义。
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

export interface ShortcutBinding {
  /** 可读写法（UI 展示用），如 "Ctrl+Shift+N" */
  combo: string;
  /** 行为简述（中文，与 App.tsx 注释一致） */
  action: string;
  /** v0.9.0 新增标记 */
  since090?: boolean;
}

/** 应用级快捷键绑定表（与 App.tsx `keydown` handler 一一对应） */
export const APP_SHORTCUTS: readonly ShortcutBinding[] = Object.freeze([
  // ─── 文件 ───
  { combo: "Ctrl+N", action: "新建临时标签" },
  { combo: "Ctrl+O", action: "打开文件到当前窗口" },
  { combo: "Ctrl+S", action: "保存" },
  { combo: "Ctrl+Shift+S", action: "另存为" },
  { combo: "Ctrl+Shift+E", action: "导出" },
  { combo: "Ctrl+,", action: "设置" },
  // ─── 编辑 ───
  { combo: "Ctrl+Z", action: "撤销" },
  { combo: "Ctrl+Y", action: "恢复" },
  { combo: "Ctrl+Shift+Z", action: "恢复（同 Ctrl+Y）" },
  { combo: "Ctrl+F", action: "查找" },
  { combo: "Ctrl+H", action: "查找替换" },
  { combo: "F6", action: "AI 翻译选中内容" },
  { combo: "Shift+F6", action: "AI 全文翻译" },
  { combo: "Ctrl+K", action: "AI 对话窗" },
  // ─── 视图 ───
  { combo: "Ctrl+Shift+T", action: "循环切换主题" },
  { combo: "F8", action: "专注模式" },
  { combo: "F9", action: "打字机模式" },
  { combo: "Ctrl+Shift+O", action: "切换大纲栏" },
  { combo: "Ctrl+Shift+P", action: "命令面板" },
  { combo: "Ctrl+Alt+V", action: "版本快照" },
  // ─── 标签 ───
  { combo: "Ctrl+Tab", action: "下一个标签" },
  { combo: "Ctrl+Shift+Tab", action: "上一个标签" },
  { combo: "Ctrl+W", action: "关闭当前标签" },
  // ─── v0.9.0 窗口 ───
  { combo: "Ctrl+Shift+N", action: "新建窗口", since090: true },
  { combo: "Ctrl+Shift+W", action: "关闭当前窗口", since090: true },
  { combo: "Ctrl+Alt+O", action: "打开文件到新窗口", since090: true },
  { combo: "Ctrl+Q", action: "退出应用（记录完整窗口集合）", since090: true },
]);

/** 归一化后的全部组合键（用于重复检测） */
export function normalizedCombos(): string[] {
  return APP_SHORTCUTS.map((s) => normalizeCombo(s.combo));
}

/** 找出重复绑定（返回重复的归一化组合键） */
export function findDuplicateCombos(): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const c of normalizedCombos()) {
    if (seen.has(c)) dup.add(c);
    seen.add(c);
  }
  return [...dup];
}
