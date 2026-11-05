/**
 * sourceIndent —— v0.16.0 需求（Tab 与缩进体系）：源码（编辑）模式缩进/反缩进**规划器**
 *
 * 与 `utils/sourceAutoPair.ts` 同一套模式：「纯函数规划 → DOM 落地分离」。
 * 本模块只把 textarea 的文本坐标翻译成「一次文本替换计划」，**不做任何 DOM 操作**；
 * 落地（execCommand + 光标）由 EditorContainer 的 `applySourcePairPlan` 统一完成，
 * 因此一次缩进 = 一次 `document.execCommand("insertText")` = 一个 input 事件
 * = 撤销栈里的**一条**记录（多行整体缩进也是一次撤销）。
 *
 * 为什么要「单次 replace」而不是「每行一次编辑」：
 * `applySourcePairPlan` 只支持「一次替换 + 一次光标设置」，多行缩进若拆成 N 次编辑，
 * 撤销栈会记 N 条，用户 Ctrl+Z 要按 N 次才能撤掉一次 Tab——与 PM 侧行为不一致。
 *
 * 光标单位：全部为 JS 字符串下标（value 坐标），与 textarea.selectionStart 一致。
 */
import type { SourcePairPlan } from "./sourceAutoPair";

/**
 * 缩进规划入参。
 *
 * - `start === end` → 折叠光标（插入 `unit` / 删除光标前一个缩进单位）；
 * - `start < end`   → 选区（逐行处理行首）。
 */
export interface SourceIndentInput {
  value: string;
  start: number;
  end: number;
  /** 缩进单位实际字符串：`"  "` / `"    "` / `"\t"`（来自 indentUnitString） */
  unit: string;
}

const NONE: SourcePairPlan = { kind: "none" };

/**
 * 求 `[fromOff, toOff]` 覆盖到的**行首**下标列表（升序）。
 *
 * 行首 = `\n` 之后的位置（文件第 0 行 = 0）。取舍规则：
 * - 选区终点落在某行行首时，该行**不算**进选区（用户选中的是上一行末尾的换行符）；
 * - 选区起点在行中时，仍把该行行首算进来（整行受缩进影响，光标需随行首插入量右移）。
 */
function lineStartsInRange(text: string, fromOff: number, toOff: number): number[] {
  const starts: number[] = [text.lastIndexOf("\n", Math.max(0, fromOff - 1)) + 1];
  let i = text.indexOf("\n", starts[0]);
  while (i !== -1 && i < toOff) {
    starts.push(i + 1);
    i = text.indexOf("\n", i + 1);
  }
  if (starts.length > 1 && starts[starts.length - 1] >= toOff) starts.pop();
  return starts;
}

/**
 * 计算「从行首缩进里删多少个字符」。
 *
 * 口径：
 * - 行首是 `\t` → 删 1 个字符（制表符整体算一个缩进单位，即使当前设置是空格）；
 * - 行首是空格 → 优先删 `unit.length` 个；不足一个单位的空格就全删；
 * - 空白与 unit 不匹配（如 unit=`"  "` 而实际是 `" \t"`）→ 退化为删 1 个，
 *   保证 Shift+Tab 一定「有变化」，不会出现"按了没反应"的死键。
 */
function outdentLen(indentText: string, unit: string): number {
  if (indentText.startsWith("\t")) return 1;
  const n = Math.min(unit.length, indentText.length);
  return indentText.slice(0, n) === " ".repeat(n) ? n : 1;
}

/** 某行行首的连续空白长度（空格/制表符；换行符天然终止）。无缩进 → 0。 */
function leadingIndentLength(value: string, lineStart: number): number {
  let i = lineStart;
  while (i < value.length && (value[i] === " " || value[i] === "\t")) i++;
  return i - lineStart;
}

/** 某行行首实际应删除的字符数（无缩进 → 0 = 该行不需要处理）。 */
function outdentAt(value: string, lineStart: number, unit: string): number {
  const len = leadingIndentLength(value, lineStart);
  if (len === 0) return 0;
  const ws = value.slice(lineStart, lineStart + len);
  return Math.min(outdentLen(ws, unit), len);
}

/**
 * 缩进计划。
 *
 * - 折叠光标：在光标处插入一个 `unit`（不移动到行首，见需求口径）；
 * - 选区：对 `lineStartsInRange` 覆盖的每行行首插一个 `unit`，合并为**一次** replace；
 *   光标/选区按「该位置之前插入的 unit 数 × unit.length」右移，
 *   保证原来选中的文本仍然被选中（多行缩进后选区不塌缩、不偏移）。
 *
 * 替换区间取 `[第一个行首, 最后一个行首)` + 末尾追加一个 unit：
 * 最后一个行首的插入正好落在区间右边界上，等价于「区间文本 + unit」，
 * 这样一次 replace 就能覆盖全部行的行首插入。
 */
export function planSourceIndent(input: SourceIndentInput): SourcePairPlan {
  const { value, start, end, unit } = input;
  if (unit.length === 0) return NONE;

  // 折叠光标：直接插在光标处（textarea 坐标，不是行首）
  if (start === end) {
    return {
      kind: "edit",
      edit: { from: start, to: start, text: unit, caret: start + unit.length },
    };
  }

  const starts = lineStartsInRange(value, start, end);
  if (starts.length === 0) return NONE;

  const from = starts[0];
  const to = starts[starts.length - 1];

  // 把 [from, to) 里每个行首前插 unit，最后一个行首的插入以「追加」形式覆盖到
  let text = "";
  let cursor = from;
  for (const s of starts) {
    text += value.slice(cursor, s) + unit;
    cursor = s;
  }
  text += value.slice(cursor, to);

  // 插入点全在 starts 上。位移只算「严格在该位置之前」的插入：若无选区起点正好落在
  // 行首（插入点 == 起点），新插入的缩进进入选区（与 VS Code 整行选中一致），
  // 重复 Tab 时选区保持稳定、不会把缩进挤到选区外。
  const shiftFor = (pos: number): number => {
    let n = 0;
    for (const s of starts) if (s < pos) n++;
    return n * unit.length;
  };

  return {
    kind: "edit",
    edit: {
      from,
      to,
      text,
      caret: start + shiftFor(start),
      caretEnd: end + shiftFor(end),
    },
  };
}

/**
 * 反缩进（Shift+Tab）计划。
 *
 * - 折叠光标：仅当「光标到行首之间**全是空白**」且存在缩进时删一个单位；
 *   否则返回 `{kind:"none"}`——**由上层无条件吞键**（吞键的责任在 EditorContainer，
 *   本文件返回 none 即"不产生编辑"）。这是 D2 的一部分：v0.15.6 的 Shift+Tab
 *   因未 preventDefault 而把焦点从 textarea 移到分隔条。
 * - 选区：逐行删一个单位，同样合并为一次 replace。
 *
 * 相对缩进计划多出的边界处理：
 * 最后一行的删除可能落在区间右边界之外（行首缩进在 `starts[last]` 之后），
 * 故替换区间右端要延伸到「最后一行行首 + 该行删除长度」；
 * 而左端取**第一个真正有变化**的行首（无缩进的行不参与，避免无意义的替换区间）。
 */
export function planSourceOutdent(input: SourceIndentInput): SourcePairPlan {
  const { value, start, end, unit } = input;
  if (unit.length === 0) return NONE;

  if (start === end) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const beforeCaret = value.slice(lineStart, start);
    // 光标前必须是"纯空白"（无字符、也无换行）才反缩进，否则视为普通退格语义 → 不处理
    if (!/^[ \t]+$/.test(beforeCaret)) return NONE;
    const del = outdentLen(beforeCaret, unit);
    if (del <= 0) return NONE;
    return {
      kind: "edit",
      edit: { from: lineStart, to: lineStart + del, text: "", caret: start - del },
    };
  }

  const starts = lineStartsInRange(value, start, end);
  if (starts.length === 0) return NONE;

  const dels = starts.map((s) => outdentAt(value, s, unit));
  const changed = dels.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return NONE;

  const first = changed[0];
  const last = changed[changed.length - 1];
  const from = starts[first];
  const to = starts[last] + dels[last];

  let text = "";
  let cursor = from;
  for (const i of changed) {
    text += value.slice(cursor, starts[i]);
    cursor = starts[i] + dels[i];
  }
  text += value.slice(cursor, to);

  // 光标位移 = 该位置之前（严格不跨越光标）被删掉的字符数
  const removedBefore = (pos: number): number => {
    let n = 0;
    for (let i = 0; i < starts.length; i++) {
      if (dels[i] <= 0) continue;
      const a = starts[i];
      const b = a + dels[i];
      n += Math.max(0, Math.min(b, pos) - a);
    }
    return n;
  };

  return {
    kind: "edit",
    edit: {
      from,
      to,
      text,
      caret: start - removedBefore(start),
      caretEnd: end - removedBefore(end),
    },
  };
}
