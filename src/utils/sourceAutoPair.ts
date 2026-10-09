/**
 * sourceAutoPair —— v0.12.1 需求4：textarea（编辑模式 / 分屏模式）侧的自动配对**规划器**
 *
 * 与 PM 侧（core/plugins/auto-pair.ts）共用 core/autoPairRules 的规则，
 * 本模块只做「textarea 文本坐标 → 规则上下文 → 文本编辑计划」的翻译，**不做 DOM 操作**：
 * 落地（execCommand + 光标）由 EditorContainer 统一完成，便于纯函数单测。
 *
 * 为什么用计划（plan）而不是直接改 textarea：
 * - jsdom 无 execCommand 实现，纯函数计划可以完整单测；
 * - 落地方式集中一处（一次 execCommand = 一个 input 事件 = 一条撤销记录）。
 *
 * 光标单位：全部为 JS 字符串下标（value 坐标），与 textarea.selectionStart 一致。
 */
import {
  decideAutoPair,
  decideCompositionCommit,
  decidePairBackspace,
  decidePairTabOut,
  type AutoPairContext,
  type PairKind,
} from "../core/autoPairRules";

/** 自动配对运行时配置（与 PM 侧 readAutoPairConfig 同构） */
export interface SourcePairConfig {
  enabled: boolean;
  kinds: Record<PairKind, boolean>;
}

/** 一次文本编辑：把 [from,to) 替换为 text，并把光标（/选区）落到新坐标 */
export interface SourceEdit {
  from: number;
  to: number;
  text: string;
  /** 落地后的光标起点（新文本坐标） */
  caret: number;
  /** 落地后的选区终点；缺省 = caret（折叠光标） */
  caretEnd?: number;
}

export type SourcePairPlan = { kind: "none" } | { kind: "edit"; edit: SourceEdit };

const NONE: SourcePairPlan = { kind: "none" };

/** 基础入参：textarea 文本 + 选区 */
export interface SourcePairInput {
  value: string;
  start: number;
  end: number;
  cfg: SourcePairConfig;
  /** 代码块 / 行内代码 / 公式上下文（由调用方用 isInCodeBlock + isInInlineCodeOrMath 计算） */
  inDisabledContext: boolean;
}

/** 取光标所在**行**内、光标两侧的文本（textarea 的"块"= 行） */
export function lineAround(value: string, pos: number): { before: string; after: string } {
  const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = value.indexOf("\n", pos);
  const lineEnd = nl === -1 ? value.length : nl;
  return { before: value.slice(lineStart, pos), after: value.slice(pos, lineEnd) };
}

/** 组装规则上下文（textarea 侧口径） */
function buildCtx(
  input: SourcePairInput,
  char: string,
  opts: { selectionEmpty: boolean; isComposing: boolean },
): AutoPairContext {
  const { before, after } = lineAround(input.value, input.start);
  return {
    char,
    before,
    after,
    selectionEmpty: opts.selectionEmpty,
    inDisabledContext: input.inDisabledContext,
    isComposing: opts.isComposing,
    enabled: input.cfg.enabled,
    kinds: input.cfg.kinds,
  };
}

/** 输入一个字符时的编辑计划（对应 beforeinput 的 insertText） */
export function planSourceChar(input: SourcePairInput, char: string): SourcePairPlan {
  const { start, end } = input;
  const action = decideAutoPair(buildCtx(input, char, { selectionEmpty: start === end, isComposing: false }));
  switch (action.type) {
    case "pair":
      // 插入 open+close，光标居中（一次 execCommand → 一次撤销）
      return {
        kind: "edit",
        edit: { from: start, to: end, text: action.open + action.close, caret: start + action.open.length },
      };
    case "surround":
      // 用配对符号包围选中文本，选中内容保持选中
      return {
        kind: "edit",
        edit: {
          from: start,
          to: end,
          text: action.open + input.value.slice(start, end) + action.close,
          caret: start + action.open.length,
          caretEnd: end + action.open.length,
        },
      };
    case "typeOver":
      // 不插入字符，仅把光标右移一位（replace 空区间等价于移动光标）
      return { kind: "edit", edit: { from: start, to: start, text: "", caret: start + 1 } };
    default:
      return NONE;
  }
}

/** 退格：空配对成对删除的计划 */
export function planSourceBackspace(input: SourcePairInput): SourcePairPlan {
  const { start, end, value } = input;
  const { before, after } = lineAround(value, start);
  const hit = decidePairBackspace({
    before,
    after,
    selectionEmpty: start === end,
    inDisabledContext: input.inDisabledContext,
    isComposing: false,
    enabled: input.cfg.enabled,
    kinds: input.cfg.kinds,
  });
  if (!hit) return NONE;
  return { kind: "edit", edit: { from: start - 1, to: end + 1, text: "", caret: start - 1 } };
}

/** Tab：跳出配对的计划（移动到闭符号右侧） */
export function planSourceTab(input: SourcePairInput): SourcePairPlan {
  const { start, end, value } = input;
  const { before, after } = lineAround(value, start);
  const hit = decidePairTabOut({
    before,
    after,
    selectionEmpty: start === end,
    inDisabledContext: input.inDisabledContext,
    isComposing: false,
    enabled: input.cfg.enabled,
    kinds: input.cfg.kinds,
  });
  if (!hit) return NONE;
  return { kind: "edit", edit: { from: start, to: start, text: "", caret: start + 1 } };
}

/**
 * IME 组合提交后的补救计划。
 *
 * 入参 `commitEnd` 为提交后光标位置（闭符号要插在它右侧），`char` 为提交的字符。
 * 规则上下文里的 before 需**去掉刚提交的字符**（还原成"尚未输入"的语义），
 * 因此 after 直接用 commitEnd 之后的行内文本。
 */
export function planSourceCompositionCommit(
  input: SourcePairInput & { char: string; commitEnd: number },
): SourcePairPlan {
  const { value, char, commitEnd } = input;
  const lineStart = value.lastIndexOf("\n", Math.max(0, commitEnd - 1)) + 1;
  const nl = value.indexOf("\n", commitEnd);
  const lineEnd = nl === -1 ? value.length : nl;
  const before = value.slice(lineStart, commitEnd - char.length);
  const after = value.slice(commitEnd, lineEnd);
  const action = decideCompositionCommit({
    char,
    before,
    after,
    selectionEmpty: true,
    inDisabledContext: input.inDisabledContext,
    isComposing: false,
    enabled: input.cfg.enabled,
    kinds: input.cfg.kinds,
  });
  if (action.type !== "pair") return NONE;
  // 只补闭符号，光标留在原处（开符号右侧）
  return { kind: "edit", edit: { from: commitEnd, to: commitEnd, text: action.close, caret: commitEnd } };
}
