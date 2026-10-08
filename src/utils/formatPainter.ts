/**
 * v0.12.0 需求2：格式刷（三模式通用 + 双击持续应用）
 *
 * 核心抽象「格式快照 FormatSnapshot」——与模式无关的中间表示：
 * - 阅读模式（PM）：collectPmSnapshot 取区间内 mark 的**交集**（Word 语义：
 *   整段都加粗才算加粗）+ 光标所在块的类型；
 * - 源码模式（textarea）：collectSourceSnapshot 轻量正则扫描（整段是否被
 *   `**`/`*`/`~~`/`` ` ``/`<u>`/`==` 包裹；首行行首前缀）。
 *
 * 应用（覆盖式）：先清除目标已有的 6 类 mark（PM）或剥离已有同类符号（源码），
 * 再套用快照——**必须先清后套**，否则出现 `***斜体***` 叠加。
 *
 * 本文件为纯函数/事务构造（无 React 依赖），便于单测；store 与 UI 在
 * stores/useFormatPainterStore.ts 与 components/editor/PmContextMenu.tsx。
 */
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { t } from "../i18n/state";

/** 格式快照（模式无关中间表示） */
export interface FormatSnapshot {
  /** 行内 mark 名（strong/em/strike/code/mark/underline 的交集） */
  marks: string[];
  /** 块类型：paragraph / heading1..6 / blockquote / bullet_list / ordered_list / null */
  blockType: string | null;
  /** 源码模式原始语法串（兜底精确复用；本期未使用，保留字段避免后续破坏性变更） */
  rawSyntax?: string;
}

/** 格式刷采集/应用的 mark 白名单；数组顺序 = 包裹嵌套顺序（首个为最外层） */
export const PAINTER_MARKS = ["underline", "mark", "strike", "strong", "em", "code"] as const;

/** 源码模式 mark ↔ 包裹符号（开/闭） */
export const SOURCE_MARK_WRAPPERS: Record<string, [string, string]> = {
  strong: ["**", "**"],
  em: ["*", "*"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
  underline: ["<u>", "</u>"],
  mark: ["==", "=="],
};

/** 持久模式最大应用次数（归零自动退出，防无限模式误用） */
export const FORMAT_PAINTER_MAX_USES = 5;

// ─── 采集（源侧） ────────────────────────────────────────

/**
 * 源码侧采集：选中文本的整段包裹符号 + 首行行首前缀。
 * （选中范围含符号形态："**abc**" → strong；"*abc*" → em；"***abc***" → strong+em）
 */
export function collectSourceSnapshot(text: string, start: number, end: number): FormatSnapshot {
  const selected = text.slice(start, end);
  let body = selected;
  const marks: string[] = [];
  // 循环剥离外层符号（支持叠加：***abc*** → strong → em）
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const [name, [open, close]] of Object.entries(SOURCE_MARK_WRAPPERS)) {
      if (
        body.length >= open.length + close.length &&
        body.startsWith(open) &&
        body.endsWith(close)
      ) {
        marks.push(name);
        body = body.slice(open.length, body.length - close.length);
        stripped = true;
        break;
      }
    }
  }

  // 块类型：选中文本的首行行首前缀
  const firstLine = selected.split("\n")[0] ?? "";
  let blockType: string | null = "paragraph";
  const headingMatch = /^(#{1,6})\s/.exec(firstLine);
  if (headingMatch) {
    blockType = `heading${headingMatch[1].length}`;
  } else if (/^>\s?/.test(firstLine)) {
    blockType = "blockquote";
  } else if (/^[-*+]\s/.test(firstLine)) {
    blockType = "bullet_list";
  } else if (/^\d+\.\s/.test(firstLine)) {
    blockType = "ordered_list";
  }
  return { marks, blockType, rawSyntax: selected };
}

/**
 * PM 侧采集：区间内所有文本节点 mark 的**交集**（整段都有的 mark 才算）
 * + 起点所在块的类型（heading 附级别）。
 */
export function collectPmSnapshot(state: EditorState, from: number, to: number): FormatSnapshot {
  const sets: Set<string>[] = [];
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) sets.push(new Set(node.marks.map((m) => m.type.name)));
  });
  const marks: string[] = [];
  if (sets.length > 0) {
    for (const name of PAINTER_MARKS) {
      if (sets.every((s) => s.has(name))) marks.push(name);
    }
  }
  // 块类型
  let blockType: string | null = null;
  try {
    const parent = state.doc.resolve(from).parent;
    blockType =
      parent.type.name === "heading"
        ? `heading${parent.attrs.level || 1}`
        : parent.type.name;
  } catch {
    blockType = null;
  }
  return { marks, blockType };
}

// ─── 应用（目标侧） ──────────────────────────────────────

/**
 * PM 侧应用（事务构造）：清空目标区间的 6 类 mark → 套用快照 marks；
 * 块级：目标为 paragraph/heading 且快照块级为 heading/paragraph 时 setBlockType。
 *
 * 覆盖式（先清后套），不叠加；不改变目标段落之外的文档结构。
 * 列表/引用（bullet_list/ordered_list/blockquote）的 PM 侧块级暂不套用
 * （wrap 命令作用于 selection，风险较高；源码侧已支持前缀替换）。
 */
export function buildPmSnapshotTr(
  state: EditorState,
  from: number,
  to: number,
  snapshot: FormatSnapshot,
): Transaction | null {
  const schema = state.schema;
  const tr = state.tr;

  // 1) 行内 marks：差异式覆盖（结果等价"先清后套"，但对已同格式目标零操作，
  //    不产生无意义的 undo 步骤）：
  //    - 快照含但区间未全有该 mark → addMark（统一添加）
  //    - 快照不含但区间任一处有 → removeMark（清除）
  const doc = state.doc;
  for (const name of PAINTER_MARKS) {
    const mtype = schema.marks[name];
    if (!mtype) continue;
    let textCount = 0;
    let markCount = 0;
    doc.nodesBetween(from, to, (node) => {
      if (node.isText) {
        textCount++;
        if (mtype.isInSet(node.marks)) markCount++;
      }
    });
    const any = markCount > 0;
    const all = textCount > 0 && markCount === textCount;
    const want = snapshot.marks.includes(name);
    if (want && !all) tr.addMark(from, to, mtype.create());
    else if (!want && any) tr.removeMark(from, to, mtype);
  }

  // 2) 块级：目标块（段落/标题）设为快照块型
  try {
    const $from = state.doc.resolve(from);
    const parent = $from.parent;
    const targetIsSimpleBlock =
      parent.type.name === "paragraph" || parent.type.name === "heading";
    if (targetIsSimpleBlock) {
      // null（异常回退）→ 不改块级；paragraph → 标题降级为段落
      if (snapshot.blockType === "paragraph") {
        if (parent.type.name === "heading") {
          tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph);
        }
      } else if (snapshot.blockType && snapshot.blockType.startsWith("heading")) {
        const level = Math.max(1, Math.min(6, parseInt(snapshot.blockType.slice(7), 10) || 1));
        if (parent.type.name !== "heading" || parent.attrs.level !== level) {
          tr.setBlockType($from.before(), $from.after(), schema.nodes.heading, { level });
        }
      }
    }
  } catch {
    // 位置非法时跳过块级（行内已套用）——不整体失败
  }

  return tr.docChanged ? tr : null;
}

/** PM 侧应用的便捷入口（dispatch 一次事务） */
export function applyPmSnapshotToPm(
  view: EditorView,
  from: number,
  to: number,
  snapshot: FormatSnapshot,
): boolean {
  const tr = buildPmSnapshotTr(view.state, from, to, snapshot);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

/**
 * 源码侧行内应用：先剥离目标已有符号（任何同类），再按快照 marks 逆序包裹
 * （数组首个为最外层）。覆盖式，不叠加。无变化时返回 null。
 */
export function wrapRangeWithMarks(
  text: string,
  start: number,
  end: number,
  marks: string[],
): { text: string; start: number; end: number } | null {
  if (end <= start) return null;
  let body = text.slice(start, end);

  // 1) 剥离已有外层符号（循环直到稳定，支持叠加形态）
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const [, [open, close]] of Object.entries(SOURCE_MARK_WRAPPERS)) {
      if (
        body.length >= open.length + close.length &&
        body.startsWith(open) &&
        body.endsWith(close)
      ) {
        body = body.slice(open.length, body.length - close.length);
        stripped = true;
        break;
      }
    }
  }

  // 2) 按数组逆序包裹（首个为最外层，末个最内层贴近文本）
  for (let i = marks.length - 1; i >= 0; i--) {
    const w = SOURCE_MARK_WRAPPERS[marks[i]];
    if (w) body = w[0] + body + w[1];
  }

  const newText = text.slice(0, start) + body + text.slice(end);
  if (newText === text) return null;
  return { text: newText, start, end: start + body.length };
}

/**
 * 源码侧块级应用：替换指定行的行首前缀。
 * headingN → `#`×N + 空格；blockquote → `> `；bullet_list → `- `；
 * ordered_list → `1. `；paragraph/null → 清除前缀。
 */
export function applyBlockTypeToLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  blockType: string | null,
): { text: string; start: number; end: number } | null {
  const line = text.slice(lineStart, lineEnd);
  const stripped = line.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, "");
  let prefix = "";
  if (blockType === "blockquote") prefix = "> ";
  else if (blockType === "bullet_list") prefix = "- ";
  else if (blockType === "ordered_list") prefix = "1. ";
  else if (blockType && blockType.startsWith("heading")) {
    const level = Math.max(1, Math.min(6, parseInt(blockType.slice(7), 10) || 1));
    prefix = "#".repeat(level) + " ";
  }
  const newLine = prefix + stripped;
  if (newLine === line) return null;
  return {
    text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + newLine.length,
  };
}

// ─── 状态机与状态栏文案 ─────────────────────────────────

/** 格式刷模式：idle 未激活 / once 单击应用后失效 / persistent 持续应用 */
export type FormatPainterMode = "idle" | "once" | "persistent";

/**
 * 模式转换（纯函数，覆盖全部路径）：
 * - arm-once（单击入口）：idle/once/persistent → once
 * - arm-persistent（双击入口）：→ persistent
 * - apply（应用一次）：once → idle（Word 默认语义）；persistent → persistent（次数由 store 递减）
 * - exit（Esc / 再次双击 / 切文件切模式）：→ idle
 */
export function nextFormatPainterMode(
  action: "arm-once" | "arm-persistent" | "apply" | "exit",
  current: FormatPainterMode,
): FormatPainterMode {
  switch (action) {
    case "arm-once":
      return "once";
    case "arm-persistent":
      return "persistent";
    case "apply":
      return current === "once" ? "idle" : current;
    case "exit":
      return "idle";
  }
}

/**
 * 状态栏提示文案（null = 不显示，不占位）。
 * - once：「格式刷：单击目标应用」
 * - persistent：「格式刷：持续应用中（剩余 N 次），按 Esc 退出」
 */
export function formatPainterHintText(
  mode: FormatPainterMode,
  remaining: number,
): string | null {
  if (mode === "idle") return null;
  if (mode === "once") return t("formatPainter.hintOnce");
  return t("formatPainter.hintPersistent", { count: remaining });
}