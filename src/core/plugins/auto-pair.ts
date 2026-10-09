/**
 * AutoPair —— 自动配对补全（v0.5.0 引入，v0.12.1 需求4 重写）
 *
 * 本文件是**适配层**：把 ProseMirror 的输入/按键事件翻译成
 * `core/autoPairRules` 的纯函数上下文，再落地编辑。规则本身（哪些情形补全、
 * 哪些跳过、哪些不补全）全部在 autoPairRules 中，textarea（编辑/分屏模式）
 * 适配层共用同一套规则 → 三个模式行为一致。
 *
 * 覆盖的四个面（缺一不可）：
 *  1. 输入开符号 → 补全配对 / 包围选区；
 *  2. 输入闭符号且右侧已是同一闭符号 → 跳过（typeover），光标右移；
 *  3. 空配对内按退格 → 成对删除；
 *  4. 配对内按 Tab → 跳到闭符号右侧（`pairTabOut`，由 keymap 的 Tab 链调用）。
 *  另：IME 组合输入期间不配对（PM 的 handleTextInput 在组合期不会被调用），
 *  组合提交后由 handleDOMEvents.compositionend 补一次闭符号。
 *
 * 与旧实现的差异（修复的缺陷）：
 *  - 补 `math_inline`（旧 inDisabledNode 只认 code_block/math_block/code_inline）；
 *  - 词中间（`abc|def`）输入开符号不再插配对，只插单字符；
 *  - 右侧紧邻闭符号时不插配对；
 *  - 英文撇号（don't）不配对；转义态（`\(`）不配对；
 *  - 孤儿闭符号（左侧无未闭合开符号）不跳过、只插单字符；
 *  - 分组开关（括号 / 引号 / 中文标点）。
 */
import { Plugin, TextSelection } from "prosemirror-state";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useSettingsStore } from "../../stores/useSettingsStore";
import {
  AUTO_PAIRS,
  DEFAULT_PAIR_KINDS,
  decideAutoPair,
  decideCompositionCommit,
  decidePairBackspace,
  decidePairTabOut,
  type AutoPairContext,
  type PairKind,
} from "../autoPairRules";

/**
 * 开符号 → 闭符号映射（v0.5.0 起的对外契约，保留给外部使用；
 * 权威数据在 autoPairRules.AUTO_PAIRS，此处由其派生，勿手工维护）。
 */
export const PAIR_MAP: Record<string, string> = AUTO_PAIRS.reduce<Record<string, string>>(
  (acc, p) => {
    acc[p.open] = p.close;
    return acc;
  },
  {},
);

/** 闭符号集合（保留旧导出；权威数据见 autoPairRules.PAIR_CLOSERS） */
export const PAIR_CLOSERS: Set<string> = new Set(AUTO_PAIRS.map((p) => p.close));

/** 自动配对运行时配置（总开关 + 分组开关） */
export interface AutoPairConfig {
  enabled: boolean;
  kinds: Record<PairKind, boolean>;
}

/**
 * 读取当前设置。
 * plugin 无法订阅 React 状态，故每次输入时通过 getState() 读最新值（成本可忽略）。
 */
export function readAutoPairConfig(): AutoPairConfig {
  const s = useSettingsStore.getState();
  return {
    enabled: s.autoPairEnabled,
    kinds: {
      bracket: s.autoPairBrackets ?? DEFAULT_PAIR_KINDS.bracket,
      quote: s.autoPairQuotes ?? DEFAULT_PAIR_KINDS.quote,
      cjk: s.autoPairCjk ?? DEFAULT_PAIR_KINDS.cjk,
    },
  };
}

/** 代码块 / 行内代码 / 块级公式 / 行内公式内不做配对（"字符串与注释内不配对"的 Markdown 等价物） */
const DISABLED_NODES = new Set(["code_block", "math_block", "code_inline", "math_inline"]);

/** 判断选区是否位于禁用自动配对的节点内（smart-paste 插件复用） */
export function inDisabledNode(view: EditorView): boolean {
  return inDisabledNodeState(view.state);
}

/** 同上，但以 EditorState 为入口（Tab 命令没有 view） */
export function inDisabledNodeState(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if (DISABLED_NODES.has($from.node(d).type.name)) return true;
  }
  return false;
}

/**
 * 取光标所在文本块内、光标两侧的文本（O(块内)）。
 *
 * 用 textBetween + leafText：非文本行内节点（图片等）被替换为一个占位字符，
 * 与文档位置保持 1:1，避免 `parent.textContent` 在含图片段落里坐标错位。
 */
export function blockTextAround(state: EditorState, pos: number): { before: string; after: string } {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent) return { before: "", after: "" };
  const start = $pos.start();
  const end = $pos.end();
  return {
    before: state.doc.textBetween(start, pos, undefined, "\ufffc"),
    after: state.doc.textBetween(pos, end, undefined, "\ufffc"),
  };
}

/** 组装规则上下文（两个适配层共用同一装配口径） */
export function buildContext(
  state: EditorState,
  pos: number,
  char: string,
  opts: { selectionEmpty: boolean; isComposing: boolean; cfg: AutoPairConfig },
): AutoPairContext {
  const { before, after } = blockTextAround(state, pos);
  return {
    char,
    before,
    after,
    selectionEmpty: opts.selectionEmpty,
    inDisabledContext: inDisabledNodeState(state),
    isComposing: opts.isComposing,
    enabled: opts.cfg.enabled,
    kinds: opts.cfg.kinds,
  };
}

/** 落地「包围选区」：open 插在选区左、close 插在选区右，原有选中文本保持选中 */
function applySurround(view: EditorView, from: number, to: number, open: string, close: string): void {
  const tr = view.state.tr;
  tr.insertText(open, from);
  tr.insertText(close, to + open.length);
  tr.setSelection(TextSelection.create(tr.doc, from + open.length, to + open.length));
  view.dispatch(tr);
}

/** 落地「补全配对」：插入 open+close，光标居中（单事务 = 单次撤销） */
function applyPair(view: EditorView, from: number, to: number, open: string, close: string): void {
  const tr = view.state.tr;
  tr.insertText(open + close, from, to);
  tr.setSelection(TextSelection.create(tr.doc, from + open.length));
  view.dispatch(tr);
}

/** 落地「跳过输入」：不插入字符，光标右移一位 */
function applyTypeOver(view: EditorView, to: number, by = 1): void {
  const tr = view.state.tr;
  tr.setSelection(TextSelection.create(tr.doc, to + by));
  view.dispatch(tr);
}

/** N1：自动配对补全插件 */
export function autoPairPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        // 仅处理单字符输入：多字符（粘贴/输入法整体上屏）不介入
        if (text.length !== 1) return false;
        const cfg = readAutoPairConfig();
        if (!cfg.enabled) return false;

        const ctx = buildContext(view.state, from, text, {
          selectionEmpty: from === to,
          isComposing: false,
          cfg,
        });
        const action = decideAutoPair(ctx);

        switch (action.type) {
          case "typeOver":
            applyTypeOver(view, to);
            return true;
          case "surround":
            applySurround(view, from, to, action.open, action.close);
            return true;
          case "pair":
            applyPair(view, from, to, action.open, action.close);
            return true;
          default:
            return false;
        }
      },

      // 空配对成对删除。
      // 有内容时（"（x）"）不拦截：默认 Backspace 仅删光标前单字符，不吞闭符号。
      // Delete 键删右侧单字符、之后 Backspace 删左侧单字符均为默认行为，无需实现。
      handleKeyDown(view, event) {
        if (event.key !== "Backspace") return false;
        // IME 组合态守卫：部分输入法组合期 isComposing=false 但 keyCode=229，
        // 拼音未上屏按 Backspace 不应误触成对删除
        if (event.isComposing || event.keyCode === 229 || view.composing) return false;

        const cfg = readAutoPairConfig();
        const { from, to } = view.state.selection;
        const { before, after } = blockTextAround(view.state, from);
        if (
          !decidePairBackspace({
            before,
            after,
            selectionEmpty: from === to,
            inDisabledContext: inDisabledNodeState(view.state),
            isComposing: false,
            enabled: cfg.enabled,
            kinds: cfg.kinds,
          })
        ) {
          return false;
        }

        const tr = view.state.tr.delete(from - 1, to + 1);
        view.dispatch(tr);
        return true;
      },

      /**
       * IME 组合提交后补闭符号。
       *
       * 为什么必须单独处理：组合期 PM 不调用 handleTextInput，而 Chromium 的提交路径
       * （实测 Edge/WebView2 同内核）是 beforeinput/input(inputType=insertCompositionText,
       * isComposing=true) → **最后** compositionend，因此无法在 beforeinput 阶段拦截。
       * 这里在 compositionend 后用 rAF 让 PM 先把组合文本并入文档，再按提交后相位判定。
       */
      handleDOMEvents: {
        compositionend(view, event) {
          const data = (event as CompositionEvent).data;
          const cfg = readAutoPairConfig();
          if (!cfg.enabled || typeof data !== "string" || data.length !== 1) return false;
          if (inDisabledNode(view)) return false;
          requestAnimationFrame(() => {
            if (view.isDestroyed) return;
            const sel = view.state.selection;
            if (!sel.empty) return;
            const pos = sel.from;
            const { before, after } = blockTextAround(view.state, pos);
            // 必须确实是刚提交的那个字符（组合被取消 / 文本被替换时不误判）
            if (before[before.length - 1] !== data) return;
            const ctx: AutoPairContext = {
              char: data,
              before: before.slice(0, -1),
              after,
              selectionEmpty: true,
              inDisabledContext: false,
              isComposing: false,
              enabled: cfg.enabled,
              kinds: cfg.kinds,
            };
            const action = decideCompositionCommit(ctx);
            if (action.type !== "pair") return;
            // 只补闭符号，光标留在开符号右侧
            const tr = view.state.tr.insertText(action.close, pos);
            tr.setSelection(TextSelection.create(tr.doc, pos));
            view.dispatch(tr);
          });
          return false; // 不拦截 PM 自身的组合收尾处理
        },
      },
    },
  });
}

/**
 * Tab：光标在两个配对符号之间 → 跳到闭符号右侧。
 * 由 keymap 的 Tab 链**最先**调用，未命中则回落表格导航 / 代码块缩进 / 列表嵌套。
 */
export const pairTabOut: Command = (state, dispatch) => {
  const cfg = readAutoPairConfig();
  const { from, to, empty } = state.selection;
  if (!empty) return false;
  const { before, after } = blockTextAround(state, from);
  const hit = decidePairTabOut({
    before,
    after,
    selectionEmpty: true,
    inDisabledContext: inDisabledNodeState(state),
    isComposing: false,
    enabled: cfg.enabled,
    kinds: cfg.kinds,
  });
  if (!hit) return false;
  if (dispatch) {
    const tr = state.tr.setSelection(TextSelection.create(state.tr.doc, to + 1));
    dispatch(tr);
  }
  return true;
};
