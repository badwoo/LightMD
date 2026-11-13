/**
 * sourceFormat —— 源码模式格式化纯函数
 *
 * 设计目标：
 * - 所有函数无副作用、无 DOM 依赖，便于单元测试
 * - EditorContainer.tsx 的快捷键与按钮回调复用同一套逻辑
 * - 通过 buildFormatReplacement 统一构造「替换文本 + 光标偏移」结果
 *
 * 涉及场景：
 * - 行内格式包裹：粗体 / 斜体 / 粗斜体 / 删除线 / 行内代码
 * - 行首前缀：标题 H1~H6（已有标题则替换）/ 移除标题（转为段落）
 * - 块级插入：代码块 / 引用 / 列表 / 分割线 / 数学公式 / Mermaid 模板
 */
// v0.9.0 自定义快捷键：源码模式键位解析读生效键位表（默认 + 用户覆盖）
import { matchShortcut, getShortcutLabel } from "../../core/shortcuts";

/** 格式化操作结果：替换文本 + 光标相对选区起点的偏移 */
export interface FormatResult {
  /** 替换选区的文本 */
  replacement: string;
  /** 替换后光标相对原选区起点的偏移量 */
  cursorOffset: number;
  /**
   * v0.12.0 需求1：无选区时的占位提示文本（不写入文档！）。
   * 由 source ghost overlay 以灰色幽灵文本渲染：用户直接键入即替换之，
   * 不键入则永不落盘（修复"粗体文本/标题一 残留进文件"）。
   * 仅行内格式与标题使用；块级模板（代码块/表格/引用等）仍预填真文本
   * ——新建块需要可见模板指引，属既有语义保留。
   */
  ghostText?: string;
}

/**
 * 包裹选中文本：在前后插入成对的标记符号
 * - 有选中文本时：完整包裹，光标移到包裹后末尾
 * - 无选中文本时：仅插入语法符号（如 `**`），占位文字改走 ghostText
 *   （v0.12.0 需求1：不再把占位文字写进文档，光标居中便于直接键入）
 */
export function wrapSelection(
  selected: string,
  before: string,
  after: string,
  placeholder: string,
): FormatResult {
  if (selected) {
    const replacement = `${before}${selected}${after}`;
    return { replacement, cursorOffset: replacement.length };
  }
  // v0.12.0 需求1：replacement 只含语法符号；placeholder 作为 ghostText 渲染
  const replacement = `${before}${after}`;
  return { replacement, cursorOffset: before.length, ghostText: placeholder };
}

/**
 * v0.13.0 需求6：源码模式的多行注释包裹。
 *
 * 与阅读模式的 `comment` mark 序列化结果保持一致（`<!--text-->`）；
 * **逐行**包裹（每行各自 `<!-- ` … ` -->`），这样任一行单独取消时不影响
 * 其它行，也与「选中多行 → 行行都被注释」的直觉一致。
 *
 * toggle 语义：选中内容**每一行都已被注释**时 → 全部取消（去掉包裹符）；
 * 否则 → 全部加上。
 *
 * @param selected 选中的文本（可能含换行）
 */
export function wrapSourceComment(selected: string): FormatResult {
  const COMMENT_OPEN = "<!-- ";
  const COMMENT_CLOSE = " -->";
  if (!selected) {
    // 无选区：只插入成对符号，光标居中，占位走 ghost（不落盘）
    const replacement = `${COMMENT_OPEN}${COMMENT_CLOSE}`;
    return { replacement, cursorOffset: COMMENT_OPEN.length, ghostText: "注释内容" };
  }
  const lines = selected.split("\n");
  // v0.13.0 返修：注释判定与剥离必须按**标记的真实下标**切分。
  //
  // 缺陷背景：旧实现先用 `trim()` 得到 `t`，却按**定长**切分
  // （`COMMENT_OPEN.length` = "<!-- " 5 字符、`COMMENT_CLOSE.length` = " -->" 4 字符）。
  // 可注释的实际写法并不总带这两个空格，于是短注释被吃掉字符甚至清空：
  //   `<!--ab-->`   → ""    （内容销毁）
  //   `<!--abc-->`  → "b"
  //   `<!--TODO-->` → "OD"
  //   `<!--a-->`    → `<!-- <!--a--> -->`（长度守卫把它判成"未注释"，反复包裹）
  // 现改为定位 `<!--` / `-->` 的真实下标，并只剥掉包裹时额外补的那一个空格。
  const isCommented = (l: string): boolean => {
    const t = l.trim();
    if (!t.startsWith("<!--") || !t.endsWith("-->")) return false;
    if (t.length < 7) return false; // 最短 "<!---->"
    // 结尾的 "-->" 之前不得再出现 "-->"，否则是两段拼接、不能整体取消
    return t.indexOf("-->") === t.length - 3;
  };
  const allCommented = lines.every(isCommented);
  let replacement: string;
  if (allCommented) {
    // 取消：按真实下标剥离包裹符，保留原有缩进
    replacement = lines
      .map((l) => {
        const indent = l.slice(0, l.length - l.trimStart().length);
        const t = l.trim();
        let inner = t.slice(4, t.length - 3); // 去掉 "<!--" 与 "-->"
        if (inner.startsWith(" ")) inner = inner.slice(1);
        if (inner.endsWith(" ")) inner = inner.slice(0, -1);
        return indent + inner;
      })
      .join("\n");
  } else {
    replacement = lines.map((l) => `${COMMENT_OPEN}${l}${COMMENT_CLOSE}`).join("\n");
  }
  return { replacement, cursorOffset: replacement.length };
}

/**
 * v0.12.0 需求1 返修：前缀/包裹类格式的 ghost 占位文案。
 * 用户反馈"还有好多格式符中间的文本没有设置为 ghost 文本"——
 * 列表/任务/有序列表/引用/链接/图片全部改为「只插语法符号 + ghost 提示」，
 * 占位文字（列表项/链接文本等）不再落盘。块级多行模板
 * （代码块/表格/Mermaid/公式/分割线）仍预填真文本（新建块需要模板指引）。
 */
export const PREFIX_GHOST_TEXTS = {
  list: "列表项",
  task: "任务项",
  quote: "引用文本",
  link: "链接文本",
  image: "图片描述",
} as const;

/** v0.12.0 需求1 返修：代码块占位提示（无选区时块内容为空，提示走 ghost 不落盘） */
export const CODEBLOCK_GHOST_TEXT = "代码内容";

/**
 * v0.12.0 需求1 返修：计算"格式 ghost 落在格式符中间"所需的尾部符号与遮罩开关。
 *
 * 背景：粗体等行内格式在光标处插入成对符号（`**` + `**`），光标停在两对符号
 * 中间。占位文字由 overlay 渲染，若不处理会**压住右侧符号**（用户反馈"重叠"）。
 * 处理方式：把光标之后的尾部符号取出，由 overlay 渲染为可见普通色跟在占位文字后，
 * 并用不透明底色遮住 textarea 里被压住的那些符号 → 视觉上即为 `**粗体文本**`。
 *
 * @param content 插入后的全文
 * @param tailStart 尾部符号在全文中的起始偏移（= 光标位置）
 * @param insertedTail 本次插入内容中位于光标之后的原始片段（可为多行模板）
 * @returns tail 为需要可见渲染的尾符号（跨行模板为空）；maskTail 为是否启用底色遮罩
 *   （仅当该行尾部再无其它内容时启用，否则底色会连带遮住用户已有文字）
 */
export function computeGhostTail(
  content: string,
  tailStart: number,
  insertedTail: string,
): { tail: string; maskTail: boolean } {
  if (!insertedTail) return { tail: "", maskTail: false };
  // 跨行模板（尾部以换行开头）：尾部符号不在同一行，无需可见尾符号/遮罩
  const nl = insertedTail.indexOf("\n");
  const tail = nl === -1 ? insertedTail : insertedTail.slice(0, nl);
  if (!tail) return { tail: "", maskTail: false };
  const lineEnd = tailStart + tail.length;
  const maskTail = lineEnd >= content.length || content[lineEnd] === "\n";
  return { tail, maskTail };
}

/**
 * 获取指定级别的标题前缀（如 level=3 返回 "### "）
 * level 自动 clamp 到 [1, 6]
 */
export function getHeadingPrefix(level: number): string {
  const n = Math.max(1, Math.min(6, Math.floor(level)));
  return "#".repeat(n) + " ";
}

/**
 * 找到光标所在行的 [lineStart, lineEnd) 字符区间
 * - lineStart：当前行第一个字符的位置（紧邻上一个 \n 之后）
 * - lineEnd：当前行最后一个字符的下一个位置（指向 \n 或字符串末尾）
 */
export function getLineRange(text: string, cursorPos: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", cursorPos - 1) + 1;
  const nl = text.indexOf("\n", cursorPos);
  const end = nl === -1 ? text.length : nl;
  return { start, end };
}

/**
 * 在光标所在行行首插入/替换标题前缀
 * - 已有标题前缀（# ~ ######）先移除，再插入新前缀
 * - 已有同级别前缀时，相当于去标题（保持幂等：再按一次移除）
 * - 返回新文本和光标位置（光标停在新行末尾）
 */
export function setLinePrefix(text: string, cursorPos: number, prefix: string): FormatResult {
  const { start, end } = getLineRange(text, cursorPos);
  const line = text.substring(start, end);
  // 移除已有的标题前缀（含 1~6 个 # + 一个空格）
  const stripped = line.replace(/^#{1,6}\s*/, "");
  const newLine = prefix + stripped;
  const newText = text.substring(0, start) + newLine + text.substring(end);
  // 光标停在新行末尾
  return { replacement: newText, cursorOffset: start + newLine.length - cursorPos };
}

/**
 * 移除光标所在行的标题前缀（Ctrl+0 转为普通段落）
 * - 已有标题前缀（# ~ ######）则移除
 * - 非标题行原样返回（cursorOffset = 0 表示无变化）
 */
export function removeLinePrefix(text: string, cursorPos: number): FormatResult {
  const { start, end } = getLineRange(text, cursorPos);
  const line = text.substring(start, end);
  const stripped = line.replace(/^#{1,6}\s*/, "");
  if (stripped === line) {
    // 非标题行，无变化
    return { replacement: text, cursorOffset: 0 };
  }
  const newText = text.substring(0, start) + stripped + text.substring(end);
  // 光标位置 clamp 到新行内
  const newCursor = Math.min(start + stripped.length, cursorPos);
  return { replacement: newText, cursorOffset: newCursor - cursorPos };
}

/**
 * v0.12.0 需求1：标题占位 Ghost 文案（H1~H6，索引 0 = 一级标题）。
 * buildFormatReplacement 与 EditorContainer 的 heading 行首路径共用，保证文案一致。
 */
export const HEADING_GHOST_TEXTS = ["标题一", "标题二", "标题三", "标题四", "标题五", "标题六"] as const;

/**
 * 源码模式「把当前行**原地**转换为任务项」（**v0.17.0 第四轮用户裁决口径 R4**）。
 *
 * ─── 历史（四层口径，别再走回头路）───
 * **① v0.13.2 之前**：`COMMAND_SYNTAX["insert.taskList"]` 只是 `"\n- [ ] "`，
 * 在光标处插一行 → 列表项被劈成两半、任务项落在列表内部（视觉=回车换行）。
 *
 * **② v0.13.2 需求2**：「提升为任务项」——从列表摘出来、任务列表插在原列表**之前**，
 * 原序号作为**字面文本**写进任务项（`- [ ] 2. two`）。
 * 缺陷：3 项列表转第 2 项后阅读顺序成了 `2. / 1. / 2.`。
 *
 * **③ v0.17.0 R3（C2）**：任务项**不带**序号、列表断两段、后段续号为 `ownOrder`。
 * → `1. one` / `☐ two` / `2. three`。
 * 缺陷（用户 R4）：「会**把有序列表弄没**」。
 *
 * **④ v0.17.0 R4（现行，取代 C2）**：用户原话「正确例子如**在 2. 上加任务，
 * 那么结果应该是 `- [ ] 2.`**」。任务项**带字面序号**，其余行序号**保持原值**。
 *
 * ### R4 在源码模式的两个硬点（与阅读模式同源，但源码是逐行文本、规则不同）
 *
 * 1. **任务行保留原序号**：`- [ ] 2. two`（C2 是刻意去掉的，R4 又恢复了）。
 * 2. **后段列表起始号 = `ownOrder + 1`**（C2 是 `ownOrder`）。
 *    R4 下待办项自己占了那个序号，后续项必须**接着它后面**数 ——
 *    源码模式必须**显式写出**后段首行的序号（markdown 没有 `order` attr）。
 *    写 `ownOrder`（C2 写法）→ `2. three` 里 2 重复；这才是"跳号"。
 *
 * ### 行分隔策略：段与段之间插入空行
 *
 * `ordered_list` → `task_list` → `ordered_list` 是**三个独立的块**。源码里不空行的话
 * markdown-it 同样会切成三段（实测 `start` 编号也正确），但**空行更明确**：
 * 不空行时"任务项是否被吸进相邻有序列表"依赖 parser 的具体实现细节；
 * 空行则与「三种不同类型列表必须分开」的语义一一对应，且有单测锁死往返保真。
 *
 * 仅在「光标所在行是一个列表项行」时生效；其余返回 null，调用方仍走原有语法插入。
 *
 * @param text      整篇源码
 * @param cursorPos 光标偏移
 * @returns 替换整篇文本的结果；不适用时 null
 */
export function liftListLineToTask(text: string, cursorPos: number): FormatResult | null {
  const lines = text.split("\n");
  // 定位光标所在行（光标恰在行尾时仍算这一行）
  let idx = 0;
  let lineStart = 0;
  while (idx < lines.length - 1 && lineStart + lines[idx].length < cursorPos) {
    lineStart += lines[idx].length + 1;
    idx++;
  }
  const line = lines[idx];
  // 有序/无序列表项：`1. ` / `1) ` / `- ` / `* ` / `+ `，允许 0~3 空格缩进。
  const m = /^(\s{0,3})(\d{1,9}[.)]|[-*+])(\s+)(.*)$/.exec(line);
  if (!m) return null;
  // 已经是任务项 → 不接管（避免把 `- [ ]` 又转换一层）
  if (/^\[[ xX]\](\s|$)/.test(m[4])) return null;
  const indent = m[1];
  const marker = m[2];
  const body = m[4];

  const isOrderedMarker = /^\d/.test(marker);
  // 本项的字面序号 + 分隔符（`2.` / `2)`）
  const ownOrder = isOrderedMarker ? parseInt(marker, 10) : 0;
  const ownDelim = marker.slice(-1);

  // 向上/向下找到该列表块的边界（连续的列表项行）；
  // v0.17.0 R3：C2 需要知道**前后两段各有哪些行**，所以要双向都扫。
  const isListLine = (s: string) => /^\s{0,3}(?:\d{1,9}[.)]|[-*+])\s+\S/.test(s);
  let blockStart = idx;
  while (blockStart > 0 && isListLine(lines[blockStart - 1])) blockStart--;
  let blockEnd = idx;
  while (blockEnd < lines.length - 1 && isListLine(lines[blockEnd + 1])) blockEnd++;

  // ── 任务行：**带原序号**（R4 口径，取代 C2 的"不带序号"）──
  //
  // 用户 R4 原话：「正确例子如**在 2. 上加任务，那么结果应该是 `- [ ] 2.`**」
  // 无序列表没有序号，`keepMarker` 为空串 → `- [ ] bb`（与历史一致）。
  // 有序列表 → `- [ ] 2. bb`；分隔符 `1.` / `1)` 原样保留。
  const keepMarker = isOrderedMarker ? `${ownOrder}${ownDelim} ` : "";
  const taskLine = `${indent}- [ ] ${keepMarker}${body}`;

  const beforeLines = lines.slice(blockStart, idx);
  const afterLines = lines.slice(idx + 1, blockEnd + 1);

  /**
   * 后段列表的序号处理 —— **R4 与 C2 的关键差异**。
   *
   * R4 下**待办项自己保留了字面序号**（`- [ ] 2. bb` 里的 `2.` 是文本），
   * 所以后段不能"顶替"待办的位置，必须**接着它后面**继续数：
   * 后段首行的字面序号 = `ownOrder + 1`。
   *
   * 示例（`1. one / 2. two / 3. three` 转第 2 项，`ownOrder=2`）：
   * - ✅ R4（`ownOrder + 1` = 3）→ 后段 `3. three` —— **与原列表逐字节一致**
   * - ❌ C2（`ownOrder` = 2）→ 后段 `2. three`（序号 2 出现两次，跳号）
   *
   * 后续行按"首行 + 逐行递推"改写，而不是整段重排：原列表中间可能被用户写了
   * **非连续序号**（`1. a / 5. b / 9. c`，markdown 允许）。R4 的语义是
   * "原地变一行 + 其余保持"，不是"重新编号整段"；按首行递推能保住用户原有的相对步长。
   *
   * 无序列表没有序号 → 原样返回（`- aa / - cc` 逐字节不变）。
   */
  const renumberAfter = (arr: string[]): string[] => {
    if (!isOrderedMarker || arr.length === 0) return arr;
    /**
     * v0.17.0 R5（真机验证发现，V3 上报）：**重编号只作用于「与当前项同缩进」的行**。
     *
     * ## 缺陷（R4 引入，R4 的 8 种边界表没抓到）
     *
     * 输入（3 空格缩进的嵌套子列表）：
     * ```
     * 1. 外层
     *    1. 内一
     *    2. 内二
     * ```
     * 光标在外层项 → Ctrl+T，实测输出内层变成 `2. 内一 / 3. 内二`（**被 +1**）。
     *
     * ## 根因
     *
     * 上面的 `isListLine` 用 `/^\s{0,3}/` 允许 **0~3 空格**缩进 ——
     * 于是 3 空格缩进的**嵌套子列表行也满足匹配** → 被 `blockEnd` 扫进 `afterLines`
     * → 又被本函数当成"后段列表"一起重编号。
     *
     * ⚠️ 真机对照给出了铁证：**同一份代码、同一个操作，只因缩进差 1 个空格结果就不同**：
     * | 嵌套缩进 | 输出 | 判定 |
     * |---|---|---|
     * | **3 空格** | 内层 `2./3.` | ❌ 被 +1 |
     * | **4 空格** | 内层 `1./2.` | ✅ 保持原样（因为 `\s{0,3}` 不匹配 4 空格，没被扫进来）|
     * 两种缩进行为不一致 → 只可能是这个正则边界造成的。
     *
     * ## 修法
     *
     * 嵌套子列表是**另一个层级的列表**，源码里明明写着 `1.` `2.`，用户期望保持原样；
     * R4 的语义也是「原地变一行 + 其余保持」，不是"重新编号整段"。
     * 所以这里用**当前行的缩进量**做同一性判定：不同缩进的行**原样返回**。
     *
     * `blockEnd` 的宽扫描**保留不动** —— 它只用于确定块范围（供 slice 拼装），
     * 不决定"改哪几行序号"。两者职责分离后，缩进深的行仍会被原样放回输出。
     */
    const sameIndentOf = (raw: string): RegExpExecArray | null => {
      // 这里改用 `\s*`（而不是 `\s{0,3}`）：必须能**识别出**任意深度的缩进量，
      // 才能判定"是否同级"。若沿用 `{0,3}`，4 空格嵌套行会因不匹配而被当成
      // "不是列表行"—— 虽然结果碰巧正确，但判据是靠"看不见"而非"比得出来"，
      // 属于本项目反复出错的模式（看不见 ≠ 不存在）。
      const mm = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/.exec(raw);
      if (!mm) return null;
      return mm[1].length === indent.length ? mm : null;
    };
    // 后段起始号 = 被转换项的字面序号 **+ 1**（待办项自己占了那个序号）
    let nextNum = ownOrder;
    return arr.map((raw) => {
      const mm = sameIndentOf(raw);
      if (!mm) return raw; // 嵌套子列表 / 非列表行 → 原样保留
      nextNum += 1;
      return `${mm[1]}${nextNum}${mm[3]}${mm[4]}${mm[5]}`;
    });
  };
  const afterRenumbered = renumberAfter(afterLines);

  // ── 组装：前段列表 + 空行 + 任务行 + 空行 + 后段列表 ──
  // 空行是必需的：`ordered_list` / `task_list` / `ordered_list` 是三种块类型，
  // 不空行时"任务项是否被吸进相邻有序列表"依赖 parser 细节，空行则语义明确。
  const out: string[] = [];
  out.push(...lines.slice(0, blockStart));
  if (beforeLines.length > 0) {
    out.push(...beforeLines);
    out.push("");
  }
  out.push(taskLine);
  if (afterRenumbered.length > 0) {
    out.push("");
    out.push(...afterRenumbered);
  }
  out.push(...lines.slice(blockEnd + 1));

  const newText = out.join("\n");

  // 光标落到任务行**末尾**（与阅读模式的"任务项首段文本末尾"对齐：
  // 单段单行时两者是同一个位置）→ 用户可以直接接着打字。
  const taskLineIdx = (beforeLines.length > 0 ? blockStart + beforeLines.length + 1 : blockStart);
  let caret = 0;
  for (let i = 0; i < taskLineIdx; i++) caret += out[i].length + 1;
  caret += taskLine.length;
  return { replacement: newText, cursorOffset: caret - cursorPos };
}

/**
 * 构造指定 action 的格式化结果（按钮点击路径）
 *
 * 统一入口：handleFormatAction 与右键菜单都通过此函数生成 replacement + cursorOffset。
 * - 行内格式：调用 wrapSelection
 * - 标题 H1~H6：使用前缀包裹（与原按钮行为一致，选中文本作为标题内容）
 * - 块级语法：返回固定模板字符串
 * - 未知 action 返回 null，调用方应判空
 */
export function buildFormatReplacement(action: string, selected: string): FormatResult | null {
  switch (action) {
    case "bold":
      return wrapSelection(selected, "**", "**", "粗体文本");
    case "italic":
      return wrapSelection(selected, "*", "*", "斜体文本");
    case "bolditalic":
      return wrapSelection(selected, "***", "***", "粗斜体");
    case "strikethrough":
      return wrapSelection(selected, "~~", "~~", "删除线");
    case "underline":
      // E8(v0.9.3):下划线无 Markdown 原生语法,源码模式以 HTML <u> 表达
      return wrapSelection(selected, "<u>", "</u>", "下划线文本");
    case "code":
      return wrapSelection(selected, "`", "`", "代码");
    case "comment":
      // v0.13.0 需求6：源码模式注释 —— 选中多行时**逐行**包 `<!-- ` / ` -->`，
      // 与阅读模式的 comment mark 序列化结果一致（<!--text-->）。
      // 已注释的选中内容再次触发 → 取消（幂等 toggle）。
      return wrapSourceComment(selected);
    case "codeblock":
      // v0.12.0 需求1 返修：块内容留空，占位提示走 ghost（不再把"代码内容"写进文档）
      return {
        replacement: `\n\`\`\`\n${selected}\n\`\`\`\n`,
        cursorOffset: selected ? 4 + selected.length + 5 : 5,
        ghostText: selected ? undefined : CODEBLOCK_GHOST_TEXT,
      };
    case "h1":
      return selected
        ? { replacement: `# ${selected}`, cursorOffset: 2 + selected.length }
        // v0.12.0 需求1：无选区仅插入前缀，标题占位走 ghostText（不落盘）
        : { replacement: "# ", cursorOffset: 2, ghostText: HEADING_GHOST_TEXTS[0] };
    case "h2":
      return selected
        ? { replacement: `## ${selected}`, cursorOffset: 3 + selected.length }
        : { replacement: "## ", cursorOffset: 3, ghostText: HEADING_GHOST_TEXTS[1] };
    case "h3":
      return selected
        ? { replacement: `### ${selected}`, cursorOffset: 4 + selected.length }
        : { replacement: "### ", cursorOffset: 4, ghostText: HEADING_GHOST_TEXTS[2] };
    case "h4":
      return selected
        ? { replacement: `#### ${selected}`, cursorOffset: 5 + selected.length }
        : { replacement: "#### ", cursorOffset: 5, ghostText: HEADING_GHOST_TEXTS[3] };
    case "h5":
      return selected
        ? { replacement: `##### ${selected}`, cursorOffset: 6 + selected.length }
        : { replacement: "##### ", cursorOffset: 6, ghostText: HEADING_GHOST_TEXTS[4] };
    case "h6":
      return selected
        ? { replacement: `###### ${selected}`, cursorOffset: 7 + selected.length }
        : { replacement: "###### ", cursorOffset: 7, ghostText: HEADING_GHOST_TEXTS[5] };
    // v0.12.0 需求1 返修：无选区时前缀/包裹类格式只插语法符号，占位提示走 ghostText；
    // 有选区时保持完整包裹（前缀 + 选中文字，既有行为不变）
    case "ul":
      return selected
        ? { replacement: `- ${selected}`, cursorOffset: 2 + selected.length }
        : { replacement: "- ", cursorOffset: 2, ghostText: PREFIX_GHOST_TEXTS.list };
    case "task":
      return selected
        ? { replacement: `- [ ] ${selected}`, cursorOffset: 6 + selected.length }
        : { replacement: "- [ ] ", cursorOffset: 6, ghostText: PREFIX_GHOST_TEXTS.task };
    // v0.12.1 需求5：圆形图标的任务项（源码 `* [ ] `，见 core/markdown/task-style.ts）
    case "task-circle":
      return selected
        ? { replacement: `* [ ] ${selected}`, cursorOffset: 6 + selected.length }
        : { replacement: "* [ ] ", cursorOffset: 6, ghostText: PREFIX_GHOST_TEXTS.task };
    case "ol":
      return selected
        ? { replacement: `1. ${selected}`, cursorOffset: 3 + selected.length }
        : { replacement: "1. ", cursorOffset: 3, ghostText: PREFIX_GHOST_TEXTS.list };
    case "quote":
      return selected
        ? { replacement: `> ${selected}`, cursorOffset: 2 + selected.length }
        : { replacement: "> ", cursorOffset: 2, ghostText: PREFIX_GHOST_TEXTS.quote };
    case "link":
      return selected
        ? { replacement: `[${selected}](url)`, cursorOffset: selected.length + 3 }
        : { replacement: "[](url)", cursorOffset: 1, ghostText: PREFIX_GHOST_TEXTS.link };
    case "image":
      return selected
        ? { replacement: `![${selected}](url)`, cursorOffset: selected.length + 4 }
        : { replacement: "![](url)", cursorOffset: 2, ghostText: PREFIX_GHOST_TEXTS.image };
    case "table":
      return {
        replacement: `\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n`,
        cursorOffset: 2,
      };
    case "math":
      return { replacement: `\n$$\n\\sum_{i=1}^{n} x_i\n$$\n`, cursorOffset: 5 };
    case "hr":
      return { replacement: `\n---\n`, cursorOffset: 5 };
    default:
      return null;
  }
}

/**
 * v0.12.0 需求1：格式 ghost（占位提示）的清除时机判定（纯函数，便于单测）。
 *
 * 清除（返回 true）：
 * - "input"：任何真实输入（用户开始键入，占位提示完成使命）；
 * - "escape"：用户按 Esc 放弃提示（不回滚已插入的语法符号，用户可 Ctrl+Z 撤销）；
 * - "undo"：v0.12.0 返修——撤销/恢复后文档内容已与 ghost 快照不符，必须清除
 *   （修复"点击格式符后 Ctrl+Z 撤销了但 ghost 文本还在"）；
 * - "file-switch" / "mode-switch"：切文件/切模式（防跨文档残留）。
 * 保留（返回 false）：
 * - 方向键移动光标 / 点击移动光标 —— 用户可能想移到别处继续，提示继续有效。
 */
export function shouldClearFormatGhost(kind: string): boolean {
  return (
    kind === "input" ||
    kind === "escape" ||
    kind === "undo" ||
    kind === "file-switch" ||
    kind === "mode-switch"
  );
}

/**
 * 判断键盘事件是否为修饰键组合（Ctrl 或 Cmd）
 */
export function hasModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * 源码模式快捷键 action 名映射（id 对齐 core/shortcuts.ts SHORTCUT_DEFS）
 */
const SOURCE_ACTION_BY_ID: Record<string, string> = {
  "format.bold": "bold",
  "format.italic": "italic",
  "format.strikethrough": "strikethrough",
  "format.inlineCode": "code",
  // E8(v0.9.3):下划线源码模式以 <u> 包裹(Markdown 无原生语法)
  "format.underline": "underline",
  // v0.13.0 需求6：源码模式批量注释（Ctrl+/，行首/行尾插 <!-- -->）
  "format.comment": "comment",
  "format.math": "math",
  // v0.11.0 返修（B3-2）：这三条此前只有 shortcuts.ts 的 scope 改成了
  // `rich-source`，本表却缺映射 → parseShortcut 返回 null → 源码 textarea 里
  // Ctrl+Shift+8/9/. 仍然完全无反应（验收①未达成）。buildFormatReplacement
  // 早已支持 ul/ol/quote，只差这三行。
  "format.bulletList": "ul",
  "format.orderedList": "ol",
  "format.blockquote": "quote",
  "format.heading1": "heading1",
  "format.heading2": "heading2",
  "format.heading3": "heading3",
  "format.heading4": "heading4",
  "format.heading5": "heading5",
  "format.heading6": "heading6",
  "format.paragraph": "paragraph",
};

/**
 * 解析源码模式 textarea 的快捷键事件，返回对应的 action 名（无匹配返回 null）
 *
 * v0.9.0 自定义快捷键：改为读 core/shortcuts.ts 生效键位表（默认 + 用户覆盖），
 * 默认键位与历史行为一致：
 * - Ctrl/Cmd + B → bold；Ctrl/Cmd + I → italic；
 * - Ctrl/Cmd + Alt + S → strikethrough（D1：与富文本统一，避开 Ctrl+Shift+S 另存为）
 * - Ctrl/Cmd + ` → code；Ctrl/Cmd + Shift + M → math（块级公式）
 * - Ctrl/Cmd + 1~6 → heading1~heading6；Ctrl/Cmd + 0 → paragraph
 *
 * 全局键（Ctrl+S/O/N/F/H 等）属 global 作用域，结构上不会在本函数命中；
 * 插入类（Ctrl+T 任务列表 / Ctrl+Alt+T 表格）由 App.tsx 全局匹配派发，也不在此处理。
 */
export function parseShortcut(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
  code?: string;
}): string | null {
  const def = matchShortcut(e, ["source"]);
  return def ? SOURCE_ACTION_BY_ID[def.id] ?? null : null;
}

/**
 * Mermaid 模板（按钮下拉菜单项）。
 *
 * ## 字段职责（v0.17.0 R3 #10 起）
 * - `id`：**稳定 ASCII 标识**，既做 React key 也做单测锚点。绝不随界面语言变化。
 * - `labelKey`：**展示文案的 i18n key**，下拉菜单必须渲染 `t(labelKey)`。
 *   —— 用户反馈「mermaid 图标文字又变成英文了」的根因就是这里此前是硬编码
 *   `label: "Flowchart"` 之类的英文字符串，中文界面下直接穿帮。
 * - `label`：**遗留字段，仅供单元测试做语义锚点**（`format-bar-completion.test.ts`
 *   用 `find(t => t.label === "Flowchart")` 定位模板再断言其语法形态）。
 *   ⚠️ **界面渲染严禁再用 `label`** —— 那会立刻退回"中文界面显示英文"的旧缺陷。
 *   保留它而不是把 10 处测试改成按 syntax 找，是因为按 label 找的语义最直白、
 *   误伤风险最低；改测试换来的只是"少一个字段"，不值得。
 * - `syntax`：插入文档的完整围栏文本（含首尾换行）。
 *
 * ## 为什么模板是 20 种而不是"全加"
 * 每个新增类型都在**本仓真实管线**上逐个实测过（mermaid 11.15.0 +
 * `securityLevel:"strict"` + 预览 iframe 同一份 `public/vendor/mermaid/mermaid.min.js`），
 * 渲染失败的**没有加**，理由逐条记在 `_plan/v0170-r3-t4-formatbar.md`：
 * - `requirementDiagram` / `architecture-beta`：**中文内容会解析失败**
 *   （中文用户一改文本就坏图，加了等于埋坑；ASCII 才能渲染）
 * - `zenuml`：本仓 mermaid 包不含该图类型（`No diagram type detected`）
 * - `C4Deployment`：模板必须带 `{}` 块，属 C4 家族变体；C4 家族只保留 `C4Context` 代表
 * - `sankey-beta` / `xychart-beta`：**中文列名/坐标轴标签**会解析失败，模板内用 ASCII，
 *   并保留 `title` 中文（实测 title 支持中文）
 */
export interface MermaidTemplate {
  /** 稳定 ASCII 标识（React key / 单测锚点），不随语言变化 */
  id: string;
  /** 展示文案的 i18n key；渲染必须走 `t(labelKey)` */
  labelKey: string;
  /** @deprecated 仅供单测做语义锚点；界面渲染请用 `labelKey` */
  label: string;
  syntax: string;
}

export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    id: "flowchart",
    labelKey: "mermaid.type.flowchart",
    label: "Flowchart",
    syntax: "\n```mermaid\ngraph TD\n    A[开始] --> B[结束]\n```\n",
  },
  {
    id: "sequence",
    labelKey: "mermaid.type.sequence",
    label: "Sequence",
    syntax: "\n```mermaid\nsequenceDiagram\n    participant A\n    participant B\n    A->>B: 请求\n    B-->>A: 响应\n```\n",
  },
  {
    id: "class",
    labelKey: "mermaid.type.class",
    label: "ClassDiagram",
    syntax: "\n```mermaid\nclassDiagram\n    class 用户 {\n        +String 名字\n        +login()\n    }\n    用户 <|-- 管理员\n```\n",
  },
  {
    id: "state",
    labelKey: "mermaid.type.state",
    label: "State",
    syntax: "\n```mermaid\nstateDiagram-v2\n    [*] --> 待机\n    待机 --> 运行: 启动\n    运行 --> [*]: 停止\n```\n",
  },
  {
    id: "er",
    labelKey: "mermaid.type.er",
    label: "ER图",
    syntax: "\n```mermaid\nerDiagram\n    CUSTOMER ||--o{ ORDER : places\n```\n",
  },
  {
    id: "journey",
    labelKey: "mermaid.type.journey",
    label: "Journey",
    syntax: "\n```mermaid\njourney\n    title 用户旅程\n    section 开始\n      打开应用: 5: 用户\n      浏览内容: 3: 用户\n```\n",
  },
  {
    id: "gantt",
    labelKey: "mermaid.type.gantt",
    label: "Gantt",
    syntax: "\n```mermaid\ngantt\n    title 项目计划\n    dateFormat YYYY-MM-DD\n    section 阶段一\n    任务一 :a1, 2024-01-01, 30d\n```\n",
  },
  {
    id: "pie",
    labelKey: "mermaid.type.pie",
    label: "Pie",
    syntax: "\n```mermaid\npie title 销售占比\n    \"产品A\" : 40\n    \"产品B\" : 60\n```\n",
  },
  {
    id: "quadrant",
    labelKey: "mermaid.type.quadrant",
    label: "QuadrantChart",
    syntax: "\n```mermaid\nquadrantChart\n    title 象限图\n    x-axis 低 --> 高\n    y-axis 低 --> 高\n    quadrant-1 优先做\n    quadrant-2 计划做\n    quadrant-3 暂时不做\n    quadrant-4 以后再说\n    项目A: [0.3, 0.6]\n    项目B: [0.7, 0.8]\n```\n",
  },
  {
    id: "timeline",
    labelKey: "mermaid.type.timeline",
    label: "Timeline",
    syntax: "\n```mermaid\ntimeline\n    title 发展时间线\n    section 早期\n        2020 : 立项\n        2021 : 首发\n```\n",
  },
  {
    id: "mindmap",
    labelKey: "mermaid.type.mindmap",
    label: "Mindmap",
    syntax: "\n```mermaid\nmindmap\n  root((中心))\n    分支一\n      叶子1\n    分支二\n```\n",
  },
  {
    id: "gitgraph",
    labelKey: "mermaid.type.gitgraph",
    label: "Gitgraph",
    syntax: "\n```mermaid\ngitGraph\n    commit id: \"初始\"\n    branch develop\n    checkout develop\n    commit id: \"开发\"\n    checkout main\n    merge develop\n```\n",
  },
  {
    id: "c4",
    labelKey: "mermaid.type.c4",
    label: "C4Context",
    syntax: "\n```mermaid\nC4Context\n    title 系统上下文\n    Person(user, \"用户\")\n    System(sys, \"LightMD\")\n    Rel(user, sys, \"使用\")\n```\n",
  },
  {
    id: "block",
    labelKey: "mermaid.type.block",
    label: "BlockBeta",
    syntax: "\n```mermaid\nblock-beta\n  columns 3\n  a b c\n  d e f\n```\n",
  },
  {
    id: "packet",
    labelKey: "mermaid.type.packet",
    label: "PacketBeta",
    syntax: "\n```mermaid\npacket-beta\n0-15: \"源端口\"\n16-31: \"目的端口\"\n```\n",
  },
  {
    id: "kanban",
    labelKey: "mermaid.type.kanban",
    label: "Kanban",
    syntax: "\n```mermaid\nkanban\n  todo[待办]\n    t1[任务一]\n  done[完成]\n    t2[任务二]\n```\n",
  },
  {
    id: "xychart",
    labelKey: "mermaid.type.xychart",
    label: "XYChartBeta",
    syntax: "\n```mermaid\nxychart-beta\n    title \"月度销售\"\n    x-axis [\"一月\", \"二月\", \"三月\"]\n    y-axis \"金额\" 0 --> 100\n    bar [30, 60, 90]\n    line [30, 60, 90]\n```\n",
  },
  {
    id: "sankey",
    labelKey: "mermaid.type.sankey",
    label: "SankeyBeta",
    syntax: "\n```mermaid\nsankey-beta\n\nSource,Target,10\nSource,Other,5\n```\n",
  },
  {
    id: "radar",
    labelKey: "mermaid.type.radar",
    label: "RadarBeta",
    syntax: "\n```mermaid\nradar-beta\n  axis A, B, C\n  curve c1{1,2,3}\n```\n",
  },
  {
    id: "treemap",
    labelKey: "mermaid.type.treemap",
    label: "TreemapBeta",
    syntax: "\n```mermaid\ntreemap-beta\n\"Root\"\n    \"A\"\n    \"B\"\n```\n",
  },
];

/** 格式工具栏按钮配置 */
export interface FormatButton {
  action: string;
  label: string;
  title: string;
  isUndoRedo?: boolean;
  isSeparator?: boolean;
  hasDropdown?: boolean;
  /** v0.12.0 需求2 返修：刷子形状 SVG 图标（格式刷按钮） */
  isBrushIcon?: boolean;
}

/**
 * 格式工具栏按钮配置（静态常量，避免每次渲染重建）
 * 顺序：撤销/恢复/格式刷(刷子图标) | 分隔 | H1-H6 | 粗体/斜体/粗斜体/删除线/行内代码 | 代码块 | 列表/任务 | 引用/链接/图片/表格 | Mermaid/数学公式/分割线
 *
 * v0.9.0 自定义快捷键：title 不再硬编码键位，展示时经 formatButtonTitle 动态拼接生效键位
 */
export const FORMAT_BUTTONS: FormatButton[] = [
  { action: "undo", label: "↩", title: "撤销", isUndoRedo: true },
  { action: "redo", label: "↪", title: "恢复", isUndoRedo: true },
  // v0.12.0 需求2 返修：格式刷改为刷子形状图标（isBrushIcon），并移到「恢复」按钮右边
  { action: "formatPainter", label: "", title: "格式刷（单击应用一次，双击持续应用）", isBrushIcon: true },
  { action: "sep1", label: "|", title: "", isSeparator: true },
  { action: "h1", label: "H1", title: "标题一" },
  { action: "h2", label: "H2", title: "标题二" },
  { action: "h3", label: "H3", title: "标题三" },
  { action: "h4", label: "H4", title: "标题四" },
  { action: "h5", label: "H5", title: "标题五" },
  { action: "h6", label: "H6", title: "标题六" },
  { action: "bold", label: "B", title: "粗体" },
  { action: "italic", label: "I", title: "斜体" },
  { action: "bolditalic", label: "BI", title: "粗斜体" },
  { action: "strikethrough", label: "S", title: "删除线" },
  { action: "code", label: "<>", title: "行内代码" },
  { action: "codeblock", label: "```", title: "代码块" },
  { action: "ul", label: "•", title: "无序列表" },
  // v0.12.1 需求5：任务列表按钮改为下拉（可选方形 / 圆形图标样式），点击行为由此下拉接管
  { action: "task", label: "☑", title: "任务列表（点击选择方形 / 圆形图标）" },
  { action: "ol", label: "1.", title: "有序列表" },
  { action: "quote", label: "❝", title: "引用" },
  { action: "link", label: "🔗", title: "链接" },
  { action: "image", label: "🖼", title: "图片" },
  { action: "table", label: "⊞", title: "表格" },
  { action: "mermaid", label: "◈", title: "Mermaid 图表", hasDropdown: true },
  { action: "math", label: "∑", title: "数学公式" },
  { action: "hr", label: "—", title: "分割线" },
];

/** 工具栏 action → 快捷键条目 id（有键位的才在 tooltip 中拼接） */
const TOOLBAR_ACTION_DEF: Record<string, string> = {
  undo: "edit.undo",
  redo: "edit.redo",
  h1: "format.heading1",
  h2: "format.heading2",
  h3: "format.heading3",
  h4: "format.heading4",
  h5: "format.heading5",
  h6: "format.heading6",
  bold: "format.bold",
  italic: "format.italic",
  strikethrough: "format.strikethrough",
  code: "format.inlineCode",
  ul: "format.bulletList",
  ol: "format.orderedList",
  quote: "format.blockquote",
  table: "insert.table",
  task: "insert.taskList",
  math: "format.math",
};

/** 工具栏按钮 tooltip：基础文案 + 生效键位（改键后跟随变化） */
export function formatButtonTitle(btn: FormatButton): string {
  const defId = TOOLBAR_ACTION_DEF[btn.action];
  const combo = defId ? getShortcutLabel(defId) : undefined;
  return combo ? `${btn.title} (${combo})` : btn.title;
}
