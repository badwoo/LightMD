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
import { TextSelection } from "prosemirror-state";
import { lift as liftCmd, setBlockType, wrapIn } from "prosemirror-commands";
import { wrapInList, liftListItem } from "prosemirror-schema-list";
import { t } from "../i18n/state";
// v0.12.1 需求5：任务列表方形/圆形样式的单一事实源
import { normalizeTaskStyle, taskStyleFromBullet, TASK_STYLE_BULLET, type TaskStyle } from "../core/markdown/task-style";

/** 格式快照（模式无关中间表示） */
export interface FormatSnapshot {
  /** 行内 mark 名（strong/em/strike/code/mark/underline 的交集） */
  marks: string[];
  /** 块类型：paragraph / heading1..6 / blockquote / bullet_list / ordered_list / null */
  blockType: string | null;
  /**
   * v0.12.1 需求5：任务列表图标样式（square/circle）。
   * 非 null 表示"源格式是任务项"——源码侧据此写 `- [ ] ` / `* [ ] `，
   * PM 侧据此改目标任务项的 style 属性（列表符号随之变化）。
   */
  taskStyle?: TaskStyle | null;
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

/** 持久模式最大应用次数（归零自动退出，防无限模式误用）
 *  v0.12.0 返修（问题5）：5 → 10（用户要求双击格式刷可连续应用 10 次） */
export const FORMAT_PAINTER_MAX_USES = 10;

/**
 * 判断快照是否**采集失败**（空快照）—— v0.17.0 第四轮 · 用户第 7 项（D1 修复）
 *
 * ## 缺陷（端到端实测，`scripts/v0170-r4-painter-matrix.mjs`）
 * 用户在源码面选中一段**普通文字**（无语法符号）后点格式刷：
 * ```
 * collectSourceSnapshot("普通文字", ...) → { marks: [], blockType: "paragraph", taskStyle: null }
 * ```
 * 这个快照**看起来非空**（`blockType` 是 "paragraph"），但**没有任何可复制的格式**。
 * 而 `armFormatPainter` 只检查了「选区非空」（`start === end`），不检查快照是否为空 →
 * 于是**仍然 arm 成功**（bodyClass=true、状态栏显示"单击目标应用"）→
 * 点目标时 `applyFormatPainterToSource` 算出 `next === text` → 返回 false →
 * **不 consume、不退出待刷态**。
 *
 * 用户视角：**"点了没反应，而且退不出去"**。
 * 这正是用户说"格式刷功能不正常"最可能的机制 —— 用户不可能知道
 * "要先选中**含格式符**的文字"（`**粗体**` 而不是"粗体"）。
 *
 * ## 判定口径（三处都要判，缺一不可）
 * 1. `marks` 非空 → 有行内格式可刷
 * 2. `blockType` 是**非 paragraph** 的块型（heading/list/quote）→ 有块级格式可刷
 * 3. `taskStyle` 非空 → 有任务列表图标样式可刷（虽然它通常伴随 bullet_list）
 *
 * ⚠️ **`blockType === "paragraph"` 不算"有格式"**：段落是**默认态**，
 * 把"段落"刷到标题上虽然是合法操作（降级为段落），但用户选普通文字时
 * 脑子里想的是"复制这段的格式"，而普通文字**没有任何格式**。
 * 若把 paragraph 也算作有效，D1 就修不掉（用户仍会 arm 成功然后点了没反应）。
 *
 * 阅读面同理：`collectPmSnapshot` 对无 mark 的普通段落也返回
 * `{ marks: [], blockType: "paragraph" }`。
 *
 * @returns true = 该快照没有可施加的格式，调用方应**拒绝 arm** 并提示用户
 */
export function isSnapshotEmpty(snapshot: FormatSnapshot | null | undefined): boolean {
  if (!snapshot) return true;
  // 有行内 mark → 非空
  if (snapshot.marks.length > 0) return false;
  // 有任务列表样式 → 非空（图标样式也是"格式"）
  if (snapshot.taskStyle) return false;
  // 块级：只有**非 paragraph** 才算"有块格式"
  if (snapshot.blockType && snapshot.blockType !== "paragraph") return false;
  return true;
}

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
  // v0.12.1 需求5：任务项（`- [ ] ` / `* [ ] `）额外采集图标样式
  let taskStyle: TaskStyle | null = null;
  const taskMatch = /^\s*([-*+])\s+\[[ xX]\]/.exec(firstLine);
  const headingMatch = /^(#{1,6})\s/.exec(firstLine);
  if (taskMatch) {
    blockType = "bullet_list";
    taskStyle = taskStyleFromBullet(taskMatch[1]);
  } else if (headingMatch) {
    blockType = `heading${headingMatch[1].length}`;
  } else if (/^>\s?/.test(firstLine)) {
    blockType = "blockquote";
  } else if (/^[-*+]\s/.test(firstLine)) {
    blockType = "bullet_list";
  } else if (/^\d+\.\s/.test(firstLine)) {
    blockType = "ordered_list";
  }
  return { marks, blockType, taskStyle, rawSyntax: selected };
}

/**
 * PM 侧采集：区间内所有文本节点 mark 的**交集**（整段都有的 mark 才算）
 * + 起点所在块的类型（heading 附级别）。
 *
 * v0.12.0 需求2 返修：块类型检测补齐列表/序号/引用——点击列表项/引用内段落时，
 * 向外找最近的容器祖先（与源码行首前缀语义对齐：heading > blockquote > list），
 * task_list 归并为 bullet_list（源码侧 `- [ ] ` 同样按 bullet 采集）。
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
  // v0.12.1 需求5：任务项样式（square/circle）
  let taskStyle: TaskStyle | null = null;
  try {
    const $from = state.doc.resolve(from);
    const parent = $from.parent;
    if (parent.type.name === "heading") {
      blockType = `heading${parent.attrs.level || 1}`;
    } else {
      // 从内向外找最近的列表/引用容器
      for (let d = $from.depth - 1; d >= 1; d--) {
        const name = $from.node(d).type.name;
        // v0.12.1 需求5：任务项本身携带样式，必须在内层先采集
        // （外层是 task_list，循环在它那里 break）
        if (name === "task_item") taskStyle = normalizeTaskStyle($from.node(d).attrs.style);
        if (name === "blockquote") { blockType = "blockquote"; break; }
        if (name === "bullet_list" || name === "task_list") { blockType = "bullet_list"; break; }
        if (name === "ordered_list") { blockType = "ordered_list"; break; }
      }
      if (!blockType) {
        blockType = parent.type.name === "paragraph" ? "paragraph" : parent.type.name;
      }
    }
  } catch {
    blockType = null;
  }
  return { marks, blockType, taskStyle };
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
 * v0.12.0 需求2 返修：PM 侧块级全格式应用（无序列表/有序列表/引用 ⇄ 段落/标题）。
 *
 * buildPmSnapshotTr 只覆盖 paragraph/heading 的 setBlockType；列表与引用的转换
 * 涉及文档结构调整（包 list_item、脱离引用/列表），需要命令管线按序执行：
 *   ① 脱离引用（目标非 blockquote 时）→ prosemirror-commands `lift`；
 *   ② 脱离列表（目标非同类型列表时）→ `liftListItem`（task_item 用对应类型）；
 *   ③ 应用目标：标题/段落 setBlockType；bullet/ordered wrapInList（标题先转段落，
 *      因 list_item 首子必须是 paragraph）；blockquote wrapIn。
 * 每步都是 prosemirror 标准命令（自动保证 schema 合法性），无效果的步骤跳过。
 * 各步依次 view.dispatch（均入撤销历史），全部基于命令后的最新 state 计算位置。
 *
 * @returns 是否发生过任何变更
 */
export function applyPmBlockSnapshot(
  view: EditorView,
  from: number,
  to: number,
  snapshot: FormatSnapshot,
): boolean {
  const schema = view.state.schema;
  const target = snapshot.blockType;
  // 目标为空（采集异常）→ 不动块级
  if (target === null) return false;

  let cur = view.state;
  let changed = false;
  const txs: Transaction[] = [];
  const step = (cmd: (s: EditorState, d: (t?: Transaction) => void) => boolean): boolean => {
    let stepped: Transaction | undefined;
    cmd(cur, (t) => { if (t) stepped = t; });
    if (stepped) {
      txs.push(stepped);
      cur = cur.apply(stepped);
      changed = true;
      return true;
    }
    return false;
  };

  // 0) 建立覆盖目标块的文本选区（供命令定位；不入撤销历史）
  const maxPos = cur.doc.content.size - 1;
  const selFrom = Math.max(1, Math.min(from, maxPos));
  const selTo = Math.max(selFrom, Math.min(to, maxPos));
  try {
    cur = cur.apply(cur.tr.setSelection(TextSelection.create(cur.doc, selFrom, selTo)).setMeta("addToHistory", false));
  } catch {
    return false;
  }

  /** 当前选区所在上下文：最近的列表容器类型 / 是否在引用内 / 父块类型 */
  const ctx = (st: EditorState) => {
    const $p = st.doc.resolve(st.selection.from);
    let listType: string | null = null;
    let inQuote = false;
    for (let d = $p.depth; d >= 1; d--) {
      const name = $p.node(d).type.name;
      if (!listType && (name === "bullet_list" || name === "ordered_list" || name === "task_list")) {
        listType = name;
      }
      if (name === "blockquote") inQuote = true;
    }
    const parent = $p.parent;
    return {
      listType,
      inQuote,
      isHeading: parent.type.name === "heading",
      isParagraph: parent.type.name === "paragraph",
      headingLevel: parent.type.name === "heading" ? Number(parent.attrs.level) || 1 : 0,
    };
  };

  // ① 脱离引用（目标非引用时）
  if (ctx(cur).inQuote && target !== "blockquote") {
    step(liftCmd);
  }

  // ② 脱离列表：当前列表容器与目标不同（目标非列表，或为另一类型列表）时，
  //    先 liftListItem 脱离；目标为同类型列表时保持不动（幂等）
  const c1 = ctx(cur);
  if (c1.listType && c1.listType !== target) {
    const itemType =
      c1.listType === "task_list" && schema.nodes.task_item
        ? schema.nodes.task_item
        : schema.nodes.list_item;
    step(liftListItem(itemType));
  }

  // ③ 应用目标块型
  if (target === "paragraph" || target.startsWith("heading")) {
    const c2 = ctx(cur);
    if (target === "paragraph") {
      if (c2.isHeading) step(setBlockType(schema.nodes.paragraph));
    } else {
      const level = Math.max(1, Math.min(6, parseInt(target.slice(7), 10) || 1));
      if (!c2.isHeading || c2.headingLevel !== level) {
        step(setBlockType(schema.nodes.heading, { level }));
      }
    }
  } else if (target === "bullet_list" || target === "ordered_list") {
    const c2 = ctx(cur);
    if (c2.listType !== target) {
      const listNode = target === "bullet_list" ? schema.nodes.bullet_list : schema.nodes.ordered_list;
      if (!listNode) return false;
      // 标题先转段落（list_item 内容首子必须是 paragraph）
      if (c2.isHeading) step(setBlockType(schema.nodes.paragraph));
      step(wrapInList(listNode));
    }
  } else if (target === "blockquote") {
    const c2 = ctx(cur);
    if (!c2.inQuote) {
      step(wrapIn(schema.nodes.blockquote));
    }
  }

  // ④ v0.12.1 需求5：任务列表图标样式（方形/圆形）必须跟随格式刷。
  //    目标已是任务项 → setNodeMarkup 改 style 属性（序列化端据此写 `-` / `*`）。
  //    目标不是任务项时不做列表包装（把普通段落变成任务项需要重建块结构，
  //    超出格式刷"套用格式"的语义；源码模式侧已按 `- [ ] ` / `* [ ] ` 前缀实现）。
  if (snapshot.taskStyle) {
    const $p = cur.doc.resolve(cur.selection.from);
    for (let d = $p.depth; d >= 1; d--) {
      const n = $p.node(d);
      if (n.type.name !== "task_item") continue;
      if (normalizeTaskStyle(n.attrs.style) !== snapshot.taskStyle) {
        const pos = $p.before(d);
        const tr = cur.tr.setNodeMarkup(pos, undefined, { ...n.attrs, style: snapshot.taskStyle });
        txs.push(tr);
        cur = cur.apply(tr);
        changed = true;
      }
      break;
    }
  }

  if (!changed) return false;
  for (const tx of txs) view.dispatch(tx);
  return true;
}

/**
 * 源码侧行内应用：先剥离目标已有符号（任何同类），再按快照 marks 逆序包裹
 * （数组首个为最外层）。覆盖式，不叠加。无变化时返回 null。
 */
/**
 * 从行内文本中**全量剥离**已知 mark 符号对（v0.17.0 R4 · D2 修复）。
 *
 * ## 为什么不能再用「首尾夹逼」剥离（原实现的缺陷）
 * 原实现（以及下面 `wrapRangeWithMarks` 的旧逻辑）是：
 * ```ts
 * while (body.startsWith(open) && body.endsWith(close)) body = body.slice(...)
 * ```
 * 它只认「**整段首尾**被同一对符号包裹」。
 *
 * 实测（`scripts/v0170-r4-painter-d2.mjs`）：
 * | 目标行 | 实际结果 | 期望（覆盖式） |
 * |---|---|---|
 * | `*已斜体目标*。` | `***已斜体目标*。**` ← **畸形** | `**已斜体目标。**` |
 * | `**已加粗目标**，` | `***已加粗目标**，*` ← **畸形** | `*已加粗目标，*` |
 * | `~~已有删除线~~。` | `**~~已有删除线~~。**` ← **删除线没清** | `**已有删除线。**` |
 *
 * 根因：目标行尾是"。"不是符号 → `endsWith(close)` 为假 → 剥离失败 →
 * 外层再包一层 → 产生 `***X*。**` 这种畸形 markdown。
 *
 * **而函数头注释明确承诺"覆盖式，先清后套，不叠加"** —— 实现没兑现自己的契约。
 *
 * ## 保守策略（5 条边界，全部有单测）
 * 直接正则扫掉所有 `*`/`**`/`~~`/`==` 会**破坏字面内容**。所以：
 *
 * 1. **只剥离成对且内容非空**：`*x*` 剥，`*`（落单）不剥
 * 2. **字面星号必须保留**：`2*3=6`、`a * b`、`C*` 里的 `*` 不是格式符号
 * 3. **不跨行**：本函数是**行内**工具，绝不碰 `\n`
 * 4. **不碰行内代码**：`` `*code*` `` 里的星号是字面内容 —— 先把 code span 挖出来保护
 * 5. **不碰转义**：`\*` 是字面星号
 *
 * ## 实现思路
 * ① 先把行内代码（`` `...` ``）**整体占位**保护起来（它们的内容不可改）；
 * ② 剩下部分用**配对扫描**：从左找开符号、从右找配对的闭符号，
 *    且**中间内容非空、不含换行**才算一对；
 * ③ 反复剥离直到稳定（支持嵌套 `***X***`）；
 * ④ 还原占位。
 *
 * @param body 单行文本（不含换行）
 * @returns 剥离掉所有已知 mark 符号后的纯正文
 */
export function stripInlineMarkSymbols(body: string): string {
  if (!body) return body;
  /**
   * ① 保护行内代码：把 `` `...` `` 换成一个不含任何符号的占位 token，
   *    最后再换回来。这样 code 里的 `*` 绝不会被当成格式符号。
   */
  const codeSpans: string[] = [];
  const CODE_TOKEN = "\u0000CODE\u0000"; // 用控制字符做占位，正常文本不会出现
  let work = body.replace(/`[^`\n]*`/g, (m) => {
    codeSpans.push(m);
    return CODE_TOKEN + (codeSpans.length - 1) + "\u0000";
  });

  /** 符号对按**开符号长度降序**尝试（`**` 必须先于 `*`，否则 `**x**` 会被拆成 `*`+`*x*`+`*`） */
  const pairs: Array<[string, string]> = [
    ["<u>", "</u>"],
    ["~~", "~~"],
    ["==", "=="],
    ["**", "**"],
    ["*", "*"],
  ];

  /**
   * 反复剥离直到稳定（每轮至少剥掉一对）。
   * 一轮只剥**一对**（最外层那对），然后重新扫描 —— 这样嵌套形态
   * `***X***`（= `*` + `**X**` + `*`）会逐层剥开。
   */
  let guard = 0;
  while (guard++ < 200) {
    let changed = false;
    for (const [open, close] of pairs) {
      // 必须从两端都是该符号才开始（但要允许后面还有其它符号，形成嵌套）
      if (!work.startsWith(open)) continue;
      if (!work.endsWith(close)) continue;
      const inner = work.slice(open.length, work.length - close.length);
      // 边界 1：内容必须非空（`**` 单独出现不是格式）
      if (inner.length === 0) continue;
      // 边界 3：不跨行（本函数是行内工具；防御性检查）
      if (inner.includes("\n")) continue;
      work = inner;
      changed = true;
      break;
    }
    if (!changed) break;
  }

  /**
   * ② 处理**句中**符号对：形如 `*甲* 和 **乙** 混排。`
   *    上面的首尾剥离处理不了（整段首尾不是符号），需要按"配对"逐个移除。
   *
   * ⚠️ 保守：只移除**成对且中间非空、不含空白边界歧义**的符号。
   *    具体规则 —— 找到 `open` 后，必须在**同一行内**找到其后的 `close`，
   *    且中间内容非空。找不到配对就**保留**（落单符号是字面内容）。
   */
  for (const [open, close] of pairs) {
    let guard2 = 0;
    while (guard2++ < 100) {
      const i = work.indexOf(open);
      if (i < 0) break;
      const j = work.indexOf(close, i + open.length);
      if (j < 0) break;
      const inner = work.slice(i + open.length, j);
      // 边界 1 + 3：内容非空、不跨行
      if (inner.length === 0 || inner.includes("\n")) break;
      /**
       * 边界 2：**字面星号保护** —— `2*3=6` / `a * b`。
       * 判据：单 `*` 的配对，若开符号**紧邻字母/数字**（前面是字母数字）或
       * 闭符号**紧邻字母/数字**（后面是字母数字），说明它是乘号/字面符号，不剥。
       * 真正的强调符号 `*x*` 通常两侧是中文/标点/空白边界。
       *
       * 说明：这是**启发式**，不追求 100% 正确（markdown 本身也有歧义），
       * 但能挡住最常见误伤。宁可漏剥（用户能看到残留符号）也不能误删用户文字。
       */
      if (open === "*") {
        const prevCh = i > 0 ? work[i - 1] : "";
        const nextCh = j + close.length < work.length ? work[j + close.length] : "";
        const isAlnum = (c: string) => !!c && /[A-Za-z0-9]/.test(c);
        // 前面紧邻字母数字 且 后面紧邻字母数字 → 疑似算式（如 2*3=6）
        if (isAlnum(prevCh) && /[0-9]/.test(prevCh) && isAlnum(nextCh)) break;
        // 开/闭符号内侧紧邻空格 → 疑似字面（`a * b`）
        if (/^\s/.test(inner) || /\s$/.test(inner)) break;
      }
      work = work.slice(0, i) + inner + work.slice(j + close.length);
    }
  }

  // ③ 还原行内代码占位
  work = work.replace(new RegExp(CODE_TOKEN + "(\\d+)\\u0000", "g"), (_m, idx) => codeSpans[Number(idx)] ?? "");
  return work;
}

/**
 * 源码侧行内应用：**先全量剥离**目标已有符号（任何同类、含句中），
 * 再按快照 marks 逆序包裹（数组首个为最外层）。覆盖式，不叠加。
 * 无变化时返回 null。
 *
 * ## v0.17.0 R4 · D2 修复：剥离从「首尾夹逼」改为「全量扫描」
 * 旧实现见 `stripInlineMarkSymbols` 的注释（带标点的目标会剥离失败 → 畸形嵌套）。
 * 现在剥离交给 `stripInlineMarkSymbols`，它守住了 5 条保守边界
 * （落单符号/字面星号/不跨行/行内代码/嵌套）。
 */
export function wrapRangeWithMarks(
  text: string,
  start: number,
  end: number,
  marks: string[],
): { text: string; start: number; end: number } | null {
  if (end <= start) return null;
  const rawBody = text.slice(start, end);

  // 1) 全量剥离已有符号（含句中/带标点，见 stripInlineMarkSymbols）
  let body = stripInlineMarkSymbols(rawBody);

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
 *
 * v0.12.1 需求5：源格式是任务项时（taskStyle 非 null）前缀为任务项语法
 * `- [ ] ` / `* [ ] `（圆形用 `*`），这样"从任务项采集 → 刷到普通行"也能得到
 * 同款图标的任务项；已有前缀（含旧的任务项语法）先剥离再替换。
 */
export function applyBlockTypeToLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  blockType: string | null,
  taskStyle?: TaskStyle | null,
): { text: string; start: number; end: number } | null {
  const line = text.slice(lineStart, lineEnd);
  const stripped = line.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, "");
  let prefix = "";
  if (blockType === "blockquote") prefix = "> ";
  else if (blockType === "bullet_list") {
    prefix = taskStyle ? `${TASK_STYLE_BULLET[taskStyle]} [ ] ` : "- ";
  } else if (blockType === "ordered_list") prefix = "1. ";
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