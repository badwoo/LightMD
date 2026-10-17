/**
 * v0.13.2 需求9：**文档末尾永远有一个可放置光标的段落**。
 *
 * ## 用户报告
 * 「文档阅读模式下编辑有受限情况，例如我从 a 文档复制一个表格到新建文档 b 中，
 *  我想在 b 文档表格后面继续编辑内容，但没法将编辑符移到表格下面再进行编辑。
 *  按理说我点击文档空白处，那么就应该有插入符号，但现在没有。」
 *
 * ## 根因
 * schema 的 `doc.content` 是 `block+`，而 `table` 是 `isolating` 的块级节点。
 * 当文档**以表格（或代码块/公式块/图表块）结尾**时：
 * - 表格内部最后能放光标的只有最后一个单元格 —— 点表格下方的空白，PM 的
 *   `posAtCoords` 把点击解析到「文档末尾 = 表格内部末尾」，于是光标进了**最后一个格子**；
 * - 表格之后没有任何可容纳光标的块，PM 又**没有注册 gap cursor**
 *   （本项目未安装 `prosemirror-gapcursor`），所以"表格后面"这个位置在模型里
 *   根本不存在 → 用户看到的就是"点空白处没有插入符"。
 *
 * ## 修复
 * 用一个 `appendTransaction` 插件在每次文档变化后保证：
 * **若最后一个顶层块是"原子型/隔离型"块（表格、代码块、图表、公式块），
 * 就在其后补一个空段落。**
 *
 * ## 为什么补的段落带 `pad: true` 且序列化时被跳过
 * 它是**结构补位**、不是用户内容：
 * - `schema.paragraph.attrs.pad` 标记它；
 * - `docToMarkdown` 见到该标记直接跳过 → **不会往 Markdown 里写多余空行**；
 * - 用户一旦在里面打字，插件会清掉标记，它就变成普通段落。
 *
 * 为什么不能改 serializer 去"丢弃末尾空段落"：末尾空段落也可能是**用户显式输入**的
 * （`v0.7.0-fix2-trailing-newline.test.ts` 锁定了该往返行为），一刀切会破坏它。
 *
 * 与"点击空白处"的配合：光标落到新段落里之后，点空白就是普通的"文档末尾"点击，
 * 不再被解析进表格内部。
 */
import { Plugin } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { lightMDSchema } from "../schema";

/**
 * 需要"尾部垫段落"的块类型。
 *
 * 判定口径：**内容模型里没有行内文本、也不是普通文本容器**的块。
 * 这些块的内部无法直接承接"块之后"的光标：
 * - `table`：内容只能进单元格；
 * - `code_block` / `mermaid_block` / `math_block`：内容只能是 `text*`，
 *   光标落在里面就是"在块内打字"，而不是"块之后的新块"。
 *
 * 刻意**不含** `horizontal_rule`（原子叶块，PM 的 `posAtCoords` 天然把点击
 * 解析到它之前/之后的位置，加段落反而会凭空多出空行）与列表/引用（它们
 * 内部本身就能回车继续）。
 */
const NEEDS_TRAILING_PARAGRAPH = new Set([
  "table",
  "code_block",
  "mermaid_block",
  "math_block",
]);

/** 纯函数：该文档末尾是否需要补一个空段落 */
export function needsTrailingParagraph(doc: PMNode): boolean {
  if (doc.childCount === 0) return false;
  const last = doc.child(doc.childCount - 1);
  return NEEDS_TRAILING_PARAGRAPH.has(last.type.name);
}

/** 纯函数：该段落是否为自动补位段落（带 pad 标记） */
export function isPadParagraph(node: PMNode): boolean {
  return node.type.name === "paragraph" && node.attrs.pad === true;
}

/** 创建一个带 pad 标记的空段落 */
function createPadParagraph(): PMNode | null {
  const para = lightMDSchema.nodes.paragraph;
  if (!para) return null;
  return para.create({ pad: true });
}

/** v0.13.2 需求9：尾部段落插件（appendTransaction，零 UI） */
export function trailingParagraphPlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _oldState, newState: EditorState) {
      // 只有真正改过文档的事务才检查（选区移动不必补段落）
      if (!trs.some((tr) => tr.docChanged)) return null;

      const tr = newState.tr;
      let changed = false;

      // ① 清掉"已经是普通内容"的旧 pad 标记。
      //    用户一旦在补位段落里打字，它就不再是补位段落；留着标记会让
      //    这段内容在保存时被**静默丢弃**（比不给落点严重得多）。
      newState.doc.descendants((node, pos) => {
        if (!isPadParagraph(node)) return true;
        if (node.content.size === 0) return true; // 仍是空的 → 保留标记
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, pad: false });
        changed = true;
        return true;
      });

      // ② 末尾需要落点但还没有 → 补一个带标记的空段落
      if (needsTrailingParagraph(tr.doc)) {
        const pad = createPadParagraph();
        if (pad) {
          tr.insert(tr.doc.content.size, pad);
          changed = true;
        }
      }

      if (!changed) return null;
      // 补位本身不进撤销历史：它是结构性补位，不是用户的一次编辑。
      // 否则用户按 Ctrl+Z 会先"撤销掉那个空段落"而不是撤销自己刚做的修改。
      tr.setMeta("addToHistory", false);
      tr.setMeta("trailingParagraph", true);
      return tr;
    },
  });
}

/**
 * 纯函数：为"尾部缺落点"的文档补一个空段落（返回新 doc；不需要时原样返回）。
 *
 * 抽成纯函数便于单测，也让调用方能在**不经过插件**的路径上主动补位。
 */
export function withTrailingParagraph(doc: PMNode): PMNode {
  if (!needsTrailingParagraph(doc)) return doc;
  const pad = createPadParagraph();
  if (!pad) return doc;
  try {
    const content = doc.content.addToEnd(pad);
    return doc.type.create(doc.attrs, content, doc.marks);
  } catch {
    return doc;
  }
}
