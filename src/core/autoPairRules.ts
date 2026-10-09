/**
 * autoPairRules —— v0.12.1 需求4：自动配对补全的**唯一规则源**（纯函数，无副作用）
 *
 * 为什么要独立成模块：
 * 三个模式（阅读=ProseMirror / 编辑=textarea / 分屏=textarea）此前各写一套判定，
 * 行为不一致、bug 互相独立（PM 侧 code_inline 之外的 math_inline 漏判、textarea 侧
 * 引号永不跳过、两侧都没有"右侧是单词字符"判定）。现在两侧适配层都只做：
 *   采集上下文 → 调 decideAutoPair / decidePairBackspace / decidePairTabOut → 落地编辑。
 *
 * ─── 规则（对齐 VS Code / CodeMirror closeBrackets 的取舍）───
 *
 * 一、会补全
 *  1. 折叠光标 + 输入开符号，且**光标右侧不是单词字符、不是闭符号、不是转义态** →
 *     插入 open+close，光标居中。
 *  2. 非空选区 + 输入开符号 → 用配对符号包围选区（多行选区同样包围；引号不跨行是
 *     编辑器实现细节，Markdown 里多行引用/强调仍然合法）。
 *
 * 二、跳过输入（typeover）
 *  折叠光标 + 输入的字符是闭符号 + **右侧紧邻同一字符** → 不插入，光标右移一位。
 *  非对称闭符号（) ] } ）】》」）在左上下文里没有未闭合的对应开符号时视为"孤儿闭符号"，
 *  退化为插入单个字符（见 decideAutoPair 注释）。
 *
 * 三、不补全
 *  1. 总开关关闭 / 该符号分组关闭；
 *  2. IME 组合输入期间；
 *  3. 代码块、行内代码、公式（块级/行内）内——即"字符串/注释内不配对"的 Markdown 等价物；
 *  4. 光标右侧是单词字符（`abc|def` 中间输入 `(` 只插单字符）；
 *  5. 光标右侧是闭符号（用户规则：多数实现直接插入单个字符）；
 *  6. 英文撇号：`'` 左侧是单词字符（don't / it's）时不配对；
 *  7. 反斜杠转义态：`\(` 不配对。
 *
 * 四、配套交互
 *  - 退格删除配对（光标在两个配对符号之间按退格 → 一起删）；
 *  - Tab 跳出（光标在两个配对符号之间按 Tab → 跳到闭符号右侧）；
 *  - 组合输入提交后补闭符号（decideCompositionCommit 的语义 = 同一套规则、提交后相位）。
 */

// ─── 配对表 ────────────────────────────────────────────────

/** 符号分组：设置面板按组开关 */
export type PairKind = "bracket" | "quote" | "cjk";

export interface PairDef {
  /** 开符号 */
  open: string;
  /** 闭符号 */
  close: string;
  kind: PairKind;
  /**
   * 同一字符既当开又当闭（" ' `）——是否算"开符号"只能靠上下文（光标前一个字符）判断。
   * 非对称符号（( ）“ 等）永远只有一种解释。
   */
  symmetric: boolean;
  /** 左侧是单词字符时不配对（英文撇号 don't / it's 场景） */
  noPairAfterWord?: boolean;
}

/**
 * 配对表（`$` 有意不在表内：输入价格/公式时误配对，且行内公式由 markdown-it 自身处理）。
 * 顺序即设置面板展示顺序。
 */
export const AUTO_PAIRS: readonly PairDef[] = [
  { open: "(", close: ")", kind: "bracket", symmetric: false },
  { open: "[", close: "]", kind: "bracket", symmetric: false },
  { open: "{", close: "}", kind: "bracket", symmetric: false },
  { open: '"', close: '"', kind: "quote", symmetric: true },
  { open: "'", close: "'", kind: "quote", symmetric: true, noPairAfterWord: true },
  { open: "`", close: "`", kind: "quote", symmetric: true },
  { open: "“", close: "”", kind: "cjk", symmetric: false },
  { open: "‘", close: "’", kind: "cjk", symmetric: false },
  { open: "（", close: "）", kind: "cjk", symmetric: false },
  { open: "【", close: "】", kind: "cjk", symmetric: false },
  { open: "《", close: "》", kind: "cjk", symmetric: false },
  { open: "「", close: "」", kind: "cjk", symmetric: false },
];

/** 开符号 → 配对定义 */
export const OPEN_TO_PAIR: Readonly<Record<string, PairDef>> = Object.freeze(
  AUTO_PAIRS.reduce<Record<string, PairDef>>((acc, p) => {
    acc[p.open] = p;
    return acc;
  }, {}),
);

/** 全部开符号（含自配对字符） */
export const PAIR_OPENERS: ReadonlySet<string> = new Set(AUTO_PAIRS.map((p) => p.open));

/** 全部闭符号（含自配对字符） */
export const PAIR_CLOSERS: ReadonlySet<string> = new Set(AUTO_PAIRS.map((p) => p.close));

/** 非对称闭符号 → 其开符号（用于孤儿闭符号判定） */
export const CLOSER_TO_OPEN: Readonly<Record<string, string>> = Object.freeze(
  AUTO_PAIRS.reduce<Record<string, string>>((acc, p) => {
    if (!p.symmetric) acc[p.close] = p.open;
    return acc;
  }, {}),
);

/** 闭符号 → 配对定义（含自配对字符） */
const CLOSER_TO_PAIR: Readonly<Record<string, PairDef>> = Object.freeze(
  AUTO_PAIRS.reduce<Record<string, PairDef>>((acc, p) => {
    acc[p.close] = p;
    return acc;
  }, {}),
);

export function pairByOpen(ch: string): PairDef | undefined {
  return OPEN_TO_PAIR[ch];
}

export function pairByCloser(ch: string): PairDef | undefined {
  return CLOSER_TO_PAIR[ch];
}

export function isCloser(ch: string | undefined): boolean {
  return !!ch && PAIR_CLOSERS.has(ch);
}

export function isOpener(ch: string | undefined): boolean {
  return !!ch && PAIR_OPENERS.has(ch);
}

/** 所有符号分组的默认开启状态 */
export const DEFAULT_PAIR_KINDS: Record<PairKind, boolean> = {
  bracket: true,
  quote: true,
  cjk: true,
};

// ─── 字符分类 ──────────────────────────────────────────────

/**
 * 单词字符：ASCII 字母数字下划线 + 拉丁扩展 + 中日韩文字 + 假名 + 谚文。
 * 用途：`abc|def` 中间输入开符号不配对（VS Code 同款判定）。
 */
export function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[0-9A-Za-z_\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(
    ch,
  );
}

// ─── 上下文判定辅助 ────────────────────────────────────────

/**
 * 从 pos 向前做轻量栈扫描：判断是否存在**未闭合**的 pair.open。
 *
 * 用于"孤儿闭符号"判定（用户规则：输入 `)` 而左侧没有对应的未闭合 `(` → 只插单字符）。
 * 只为非对称符号设计（对称符号的开关语义模糊，一律走 overtype）。
 * `\\(` 这类转义字符不计入。
 */
export function hasUnclosedOpener(textBefore: string, open: string, close: string): boolean {
  let depth = 0;
  for (let i = textBefore.length - 1; i >= 0; i--) {
    const ch = textBefore[i];
    // 转义：前一个字符是奇数个反斜杠 → 该字符是字面量，跳过
    if (isEscapedAt(textBefore, i)) continue;
    if (ch === close) {
      depth++;
    } else if (ch === open) {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

/** text[i] 是否被反斜杠转义（其前连续反斜杠数量为奇数） */
export function isEscapedAt(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/** 文本末尾是否处于转义态（用于 `\(` 不配对） */
export function endsWithEscape(textBefore: string): boolean {
  let n = 0;
  for (let i = textBefore.length - 1; i >= 0 && textBefore[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/** 采集配对上下文（两个适配层共用；before/after 为**当前块/行**内光标两侧文本） */
export interface AutoPairContext {
  /** 本次输入/提交的单个字符 */
  char: string;
  /** 光标前的当前块文本 */
  before: string;
  /** 光标后的当前块文本 */
  after: string;
  /** 选区是否为空 */
  selectionEmpty: boolean;
  /** 是否处于代码块 / 行内代码 / 公式上下文（不配对） */
  inDisabledContext: boolean;
  /** IME 组合输入中（暂停配对） */
  isComposing: boolean;
  /** 总开关 */
  enabled: boolean;
  /** 各分组开关 */
  kinds: Record<PairKind, boolean>;
}

/** 配对决策结果 */
export type AutoPairAction =
  /** 不接管，走默认输入 */
  | { type: "none" }
  /** 插入 open+close（光标居中）；"提交后相位"只补 close */
  | { type: "pair"; open: string; close: string }
  /** 用配对符号包围选中文本（保持选中） */
  | { type: "surround"; open: string; close: string }
  /** 右侧已有同一闭符号：不插入，光标右移一位 */
  | { type: "typeOver" };

/** 判断某个分组当前是否启用 */
function kindEnabled(pair: PairDef, kinds: Record<PairKind, boolean>): boolean {
  return kinds[pair.kind] !== false;
}

// ─── 主决策 ────────────────────────────────────────────────

/**
 * 输入一个字符时的配对决策（纯函数）。
 *
 * 调用时机：字符**尚未**插入时（PM 的 handleTextInput / textarea 的 beforeinput）。
 * 另有"提交后相位"复用同一函数：IME 组合提交后字符已在文档里，此时 pair 动作
 * 只需补闭符号（适配层按相位落地）。
 */
export function decideAutoPair(ctx: AutoPairContext): AutoPairAction {
  if (!ctx.enabled || ctx.isComposing || ctx.inDisabledContext) return { type: "none" };
  if (ctx.char.length !== 1) return { type: "none" };

  const pair = pairByOpen(ctx.char);

  // ─── 有选区：包围 ───
  if (!ctx.selectionEmpty) {
    if (!pair || !kindEnabled(pair, ctx.kinds)) return { type: "none" };
    return { type: "surround", open: pair.open, close: pair.close };
  }

  // ─── 跳过输入（typeover）：右侧紧邻同一闭符号 ───
  //
  // 必须在开符号分支之前：`"` 在配对表里 key/value 相同（自配对），
  // 若先判开符号会再插一对引号，出现 4 个引号（v0.8.0 已踩过的坑）。
  const right = ctx.after[0];
  if (right !== undefined && right === ctx.char && isCloser(ctx.char)) {
    const closerPair = pairByCloser(ctx.char);
    // 孤儿闭符号：非对称闭符号（) ] } 等）左侧没有未闭合的开符号 → 只插单字符
    if (closerPair && !closerPair.symmetric) {
      const balanced = hasUnclosedOpener(ctx.before, closerPair.open, closerPair.close);
      if (!balanced) return { type: "none" };
    }
    return { type: "typeOver" };
  }

  // ─── 开符号补全 ───
  if (!pair || !kindEnabled(pair, ctx.kinds)) return { type: "none" };

  if (right !== undefined) {
    // 右侧是单词字符：词中间不插配对（abc|def 输入 ( 只插单字符）
    if (isWordChar(right)) return { type: "none" };
    // 右侧是闭符号：用户规则——多数实现直接插入单个字符
    if (isCloser(right)) return { type: "none" };
  }

  // 英文撇号：左侧是单词字符时不配对（don't / it's）
  if (pair.noPairAfterWord && isWordChar(ctx.before[ctx.before.length - 1])) return { type: "none" };

  // 转义态：`\(` 不配对
  if (endsWithEscape(ctx.before)) return { type: "none" };

  return { type: "pair", open: pair.open, close: pair.close };
}

// ─── 退格 / Tab ────────────────────────────────────────────

/** 光标是否**恰好**夹在一对配对符号之间（开符号紧邻左侧、闭符号紧邻右侧） */
export function pairAroundCaret(
  before: string,
  after: string,
  kinds: Record<PairKind, boolean>,
): PairDef | null {
  const open = pairByOpen(before[before.length - 1]);
  if (!open || !kindEnabled(open, kinds)) return null;
  if (!after.startsWith(open.close)) return null;
  return open;
}

export interface PairKeyContext {
  before: string;
  after: string;
  selectionEmpty: boolean;
  inDisabledContext: boolean;
  isComposing: boolean;
  enabled: boolean;
  kinds: Record<PairKind, boolean>;
}

/**
 * 退格：光标在两个配对符号之间（空配对）→ 一次删掉一对。
 * 配对内有内容（`（x）`）不吞闭符号，只走默认单字符删除。
 */
export function decidePairBackspace(ctx: PairKeyContext): boolean {
  if (!ctx.enabled || ctx.isComposing || ctx.inDisabledContext) return false;
  if (!ctx.selectionEmpty) return false;
  return pairAroundCaret(ctx.before, ctx.after, ctx.kinds) !== null;
}

/** Tab：光标在两个配对符号之间 → 跳到闭符号右侧（跳出配对） */
export function decidePairTabOut(ctx: PairKeyContext): boolean {
  if (!ctx.enabled || ctx.inDisabledContext) return false;
  if (!ctx.selectionEmpty) return false;
  return pairAroundCaret(ctx.before, ctx.after, ctx.kinds) !== null;
}

// ─── 组合输入提交后的补救 ──────────────────────────────────

/**
 * IME 组合提交后的决策：字符已经落进文档，只需要判断"是否要补一个闭符号"。
 *
 * 与 decideAutoPair 复用同一套规则，区别只在落地相位：
 * 提交后光标位于刚提交字符的右侧，`after` 为提交后光标右侧文本。
 * 返回 pair 动作时适配层**只补 close**，并把光标保持在原处（开字符左侧已存在）。
 */
export function decideCompositionCommit(ctx: AutoPairContext): AutoPairAction {
  // 组合提交后光标必然紧跟刚提交的字符：未插入完整配对，故按折叠光标处理
  return decideAutoPair({ ...ctx, isComposing: false, selectionEmpty: true });
}
