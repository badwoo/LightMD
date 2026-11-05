/**
 * code-indent —— 代码类文本块的 Tab 缩进 / 反缩进（v0.16.0 重写）
 *
 * ─── 历史（E2 / v0.9.2）───
 * 此前 code_block 内按 Tab 落到浏览器默认行为，焦点直接移出编辑器，是代码编辑的
 * 第一体验断点。mermaid_block 与 code_block 同为 `code:true`、`content:"text*"`
 * 的文本块，一并纳入（否则图表源码编辑时 Tab 仍会跳走，行为不一致）。
 *
 * ─── v0.16.0 重写修掉的 4 个缺陷 ───
 *
 * ① **D1（P0）有选区时写坏代码**
 *    旧实现 `tr.insertText(unit, selection.$from.pos)` 用 `$from` 单点插入，
 *    既不看 `$to`、也不按行拆分。实测：
 *      · `"line1\nline2\nline3"` 选 `line2..line3` → `"line1\nl  ine2\nline3"`
 *        （空格被缝进选区起点，其余行没动）
 *      · `"const a = 1;"` 选 `a` → `"const   a = 1;"`
 *    正确性完全取决于 `from` 是否恰在行首 —— 非确定行为，最危险的一类。
 *
 * ② **D10（P2）Shift+Tab 有选区时不按行处理**
 *    旧实现只做单点 `delete($from.pos-2, $from.pos)`，只删起点那行的缩进，
 *    选区覆盖的其余行纹丝不动。
 *
 * ③ **D8（P1）Shift+Tab 吃掉行中空格**
 *    旧实现的两个分支（`/ {2}$/` 与 `text[off-1] === " "`）都只看「光标前的
 *    文本末尾」，**完全不看是否处于行首缩进区**。实测：
 *      · `"a b"` 光标在 `a ` 之后 → `"ab"`
 *      · `"a  b"` 光标在 `a  ` 之后 → `"ab"`（一次吃 2 个）
 *      · `"a 中"` 光标在 `a ` 之后 → `"a中"`
 *
 * ④ **D9（P2）不识别真实 `\t` 缩进**
 *    旧实现只认空格。用户粘贴来的 `\t` 缩进代码「能缩进却不能反缩进」，
 *    而且 `Shift+Tab` 返回 false → 焦点逃出编辑器。
 *
 * ─── 口径（本文件是唯一实现处，keymap 的 indent/outdent 只做分派）───
 *
 * · **空选区**：Tab 在光标处插一个缩进单位；Shift+Tab 只在「行首缩进区」内删一个
 *   缩进单位，**行中一律吞键、一个字都不删**。
 * · **有选区**：按选区**覆盖的每一行**分别加/减一个缩进单位，**一个事务内完成**
 *   ⇒ N 行缩进 = 一次撤销。
 * · **缩进单位可配**（用户已拍板默认 "2"）：读 `useSettingsStore.indentUnit`，
 *   与 `--lm-tab-size` CSS 变量同源，保证「实际插入的字符数」与「视觉宽度」自洽。
 * · **每次缩进独立成一步撤销**（Q4）：所有派发统一过 `closeHistory`。
 *
 * ─── 关键实现细节 ───
 *
 * · **从后往前改**：同一事务里按行倒序插入/删除，前面的位置不受影响，
 *   不需要 `tr.mapping.map` 累积偏移（比逐行映射更不易错）。
 * · **`\t` 恒等于一个缩进单位**：即使设置是 "2"，反缩进也认 `\t`
 *   （粘贴来的代码必须能反缩进）。`outdentLen` 里以 `\t` 开头直接返回 1。
 * · **「行首缩进区」判定是 `^[ \t]+$`**：从光标回看到行首必须全是空白。
 *   这是区分「行首缩进」与「行中」的唯一可靠判据 ——
 *   `text[off-1] === " "` 对 `"a b"` 与 `"  a"` 都为 true，区分不了。
 */
import { Command, EditorState } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { indentUnitString, useSettingsStore } from "../../stores/useSettingsStore";

/**
 * 当前缩进单位字符串。
 *
 * 与 `useSettingsStore.indentUnit` 同源（默认 "2" → `"  "`）。
 * 沿用 `readAutoPairConfig()` 的既有先例：core 只**读** store，不 import 组件。
 */
function readIndentUnit(): string {
  return indentUnitString(useSettingsStore.getState().indentUnit);
}

/** 光标是否直接位于代码类文本块内(块内容为纯文本,无中间节点层) */
export function inCodeLikeBlock(state: EditorState): boolean {
  const parent = state.selection.$from.parent;
  return (
    parent.type.name === "code_block" ||
    parent.type.name === "mermaid_block" ||
    // v0.16.0 D4：math_block 的 content 同为 `text*`（schema.ts），与 code_block
    // 完全同构，属历史漏配（旧实现只认两个，公式块内 Tab 焦点会逃到 ⋮ 菜单按钮）。
    parent.type.name === "math_block"
  );
}

/**
 * 选区覆盖的**每一行的行首位置**（相对块内容的偏移）。
 *
 * code_block 内的换行就是 `"\n"` 文本，所以行 = `\n` 分隔的片段。
 *
 * 边界口径（与 VS Code / 主流编辑器一致）：
 * 选区终点**恰在行首**时，该行不算「被选中」——否则「选到某行行首」会把下一行
 * 也一起缩进，用户感知是"多缩进了一行"。
 *
 * @example
 * text="line1\nline2\nline3", from=6(行2首), to=17(末尾) → [6, 12]
 * text="aaa\nbbb\nccc",       from=4(行2首), to=7(行3首) → [4]  ← 不含 bbb 之后那行
 */
export function lineStartsInRange(text: string, fromOff: number, toOff: number): number[] {
  const starts: number[] = [text.lastIndexOf("\n", Math.max(0, fromOff - 1)) + 1];
  let i = text.indexOf("\n", starts[0]);
  while (i !== -1 && i < toOff) {
    starts.push(i + 1);
    i = text.indexOf("\n", i + 1);
  }
  // 选区终点恰在行首 ⇒ 该行未被选中，剔除
  if (starts.length > 1 && starts[starts.length - 1] >= toOff) starts.pop();
  return starts;
}

/**
 * 从行首空白里「删一个缩进单位」的长度。
 *
 * · 以 `\t` 开头 → 删 1 个字符（1 个 `\t` **恒等于** 1 个缩进单位，与设置无关）
 * · 否则删 `min(unit.length, 已有空白数)` 个空格 → 奇数/不足一单位时自然收敛
 *
 * 实测收敛链（unit = "  "）：`4→2`、`6→4`、`3→1`、`1→0`、`\t\t→\t`、`\t→0`。
 *
 * ⚠️ 注意**不能**实现成「删到行首全部空白」：那会把 `"    a"` 从 4 空格直接清零，
 * 既违背「一次只减一层」的直觉，也与 v0.9.2 既有测试
 * 「4 空格缩进 Shift+Tab 只删一个缩进单位」直接冲突。
 */
export function outdentLen(indentText: string, unit: string): number {
  if (indentText.startsWith("\t")) return 1;
  const n = Math.min(unit.length, indentText.length);
  return indentText.slice(0, n) === " ".repeat(n) ? n : 1;
}

/**
 * Tab：插缩进。
 * - 空选区：光标处插一个缩进单位；
 * - 有选区：选区覆盖的每一行行首各插一个缩进单位（一个事务）。
 */
export const codeBlockIndent: Command = (state, dispatch) => {
  if (!inCodeLikeBlock(state)) return false;
  const { from, to, empty, $from } = state.selection;
  const unit = readIndentUnit();

  if (empty) {
    if (dispatch) dispatch(closeHistory(state.tr.insertText(unit, from)));
    return true;
  }

  const text = $from.parent.textContent;
  const base = $from.start(); // 块内容起点（文档坐标）
  const starts = lineStartsInRange(text, from - base, to - base);
  const tr = state.tr;
  // 从后往前插：前面的位置不受影响，无需 mapping.map 累积偏移
  for (const off of starts.slice().reverse()) tr.insertText(unit, base + off);
  if (dispatch) dispatch(closeHistory(tr));
  return true;
};

/**
 * Shift+Tab：反缩进。
 * - 空选区：只在「行首缩进区」内删一个缩进单位；行中/行首无缩进 → **吞键不删**；
 * - 有选区：选区覆盖的每一行行首各删一个单位；**即使无可删也吞键**（防焦点逃逸）。
 */
export const codeBlockOutdent: Command = (state, dispatch) => {
  if (!inCodeLikeBlock(state)) return false;
  const { from, to, empty, $from } = state.selection;
  const text = $from.parent.textContent;
  const base = $from.start();
  const unit = readIndentUnit();

  if (empty) {
    const off = from - base;
    const lineStart = text.lastIndexOf("\n", Math.max(0, off - 1)) + 1;
    const lineIndent = text.slice(lineStart, off);
    // ★ 行首缩进区判定：光标到行首之间必须**全是空白**。
    //   行中（沿途有非空白字符）一律吞键、一个字都不删 —— 修 D8。
    if (lineIndent.length === 0 || !/^[ \t]+$/.test(lineIndent)) return true;
    const len = outdentLen(lineIndent, unit);
    if (dispatch) dispatch(closeHistory(state.tr.delete(from - len, from)));
    return true;
  }

  const starts = lineStartsInRange(text, from - base, to - base);
  const tr = state.tr;
  for (const off of starts.slice().reverse()) {
    const lead = text.slice(off).match(/^\t|^ +/);
    if (!lead) continue; // 该行无缩进：跳过
    const len = lead[0].startsWith("\t") ? 1 : outdentLen(lead[0], unit);
    tr.delete(base + off, base + off + len);
  }
  if (dispatch) dispatch(closeHistory(tr));
  return true;
};
