/**
 * SyntaxHelper —— 编辑模式下的语法辅助和格式辅助面板
 *
 * 在源码编辑模式下替代大纲面板，显示在右侧。
 * 提供常用 Markdown 语法参考和快捷插入功能。
 */
import { useCallback } from "react";
import { useT } from "../../i18n";
import { CODEBLOCK_GHOST_TEXT, HEADING_GHOST_TEXTS, PREFIX_GHOST_TEXTS } from "./sourceFormat";
import "../../styles/editor.css";

interface SyntaxHelperProps {
  onInsert?: (syntax: string, cursorOffset: number, opts?: { ghost?: string }) => void;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * v0.17.0 R3 #3：ghost（灰色占位提示）覆盖判定规则
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话：「语法辅助栏的 ghost 文本功能还缺失，例如代码块，请全面检查下格式栏和
 * 语法辅助栏，发现有漏的就补上。」
 *
 * ### 判定规则（唯一一条，正反两向都可判）
 *
 * **插入后文档里只留下「语法骨架」、且骨架中存在「本应由用户填写内容」的空位
 * → 必须有 ghost 提示该空位该填什么。**
 *
 * 反过来，以下两类**不该**有 ghost：
 * 1. **插入即预填了可见内容** —— 空位已经被真实文本填满，再叠 ghost 就是双重文字
 *    （表格 `列1/列2/内容`、块级公式 `\sum…`）。
 * 2. **结构里根本没有内容位** —— 没有任何"该填什么"的位置（分割线 `---`）。
 *
 * ### 为什么规则要这么写（而不是"格式栏有就跟着有"）
 *
 * 只看"格式栏有没有"会把表格/公式/分割线也误补上 ghost，而且无法解释为什么
 * 代码块该补、表格不该补 —— 两者都是"块级模板"，区别只在**空位的存在性**。
 * 规则必须能判"表格为什么不该有 ghost"，否则补漏就成了抄表。
 *
 * ### 逐项结论
 *
 * | 分组 | 项 | ghost | 理由 |
 * |---|---|---|---|
 * | 标题 | h1/h2/h3 | ✅ 有 | `# ` 后是空内容位 |
 * | 标题 | **h4/h5/h6** | ✅ **本次补** | 格式栏早有 H4-H6，语法栏漏了同三级；补的是**缺失的项本身** + 其 ghost |
 * | 文本格式 | 粗体/斜体/粗斜体/删除线/行内代码 | ✅ 有 | 成对符号中间是空内容位（既有） |
 * | 代码块 | 裸围栏 + js/python/html | ✅ **本次补** | ```` ``` ```` 与闭合围栏之间是空行 = 内容位；此前无 ghost，与格式栏 `codeblock` 的"代码内容"提示不一致 |
 * | 代码块·更多 | TS/Go/Rust/Java/C++/SQL/JSON/YAML/Bash/Markdown/PHP | ✅ **本次补** | 同上（11 项）。文案统一用 `CODEBLOCK_GHOST_TEXT`，**不按语言分化**：围栏内的空位性质完全相同，且语言名（TypeScript/Go…）本身不 i18n |
 * | 列表 | 无序/有序/任务/已完成任务 | ✅ 有 | 标记后是空内容位（既有） |
 * | 其它 | 引用 | ✅ 有 | `> ` 后是空内容位（既有） |
 * | 其它 | 链接/图片 | ✅ 有 | `[]` / `![]` 中间是空的内容位（既有） |
 * | 其它 | **分割线 `---`** | ❌ **不该有** | 规则②：`---` 是自足的叶级结构，没有任何内容位 |
 * | 其它 | **表格** | ❌ **不该有** | 规则①：模板已预填 `列1/列2/列3` 与 `内容`，空位已被真实文本占满 |
 *
 * ### 复用常量而不是就地写字符串
 *
 * ghost 文案全部引自 `sourceFormat.ts` 的 `HEADING_GHOST_TEXTS` /
 * `PREFIX_GHOST_TEXTS` / `CODEBLOCK_GHOST_TEXT` —— 语法栏与格式栏对**同一个操作**
 * 必须给出**同一句话**（否则用户点按钮和点语法栏得到两种提示文案，是另一种不一致）。
 * 这条也顺带把"格式栏改了文案、语法栏忘了改"这类漂移在编译期就挡住。
 */
// 语法辅助数据
// cursorOffset: 插入后光标应放在第几个字符位置（从插入文本起始计算）
// title/name 字段存储 i18n key，渲染时通过 t() 翻译
// code/insert 字段是 Markdown 语法示例，不 i18n
// v0.12.0 需求1 返修：ghost 为占位提示文案——插入后由格式 ghost overlay
// 以灰色幽灵文本显示（不落盘），未编辑时退格可整段删除刚插入的语法符号
/**
 * 语法辅助栏的数据表。
 *
 * 为什么**导出**（原本是模块私有）：v0.17.0 R3 #3 的验收需要一份
 * 「哪些项有 ghost / 哪些没有」的**机器可验矩阵**。用正则去读源码文本做断言
 * 会在条目结构变化时悄悄抓不全（实测第一版正则只抓到 22/35 项 → 断言空跑，
 * 少了 13 项漏检）。导出后测试直接遍历真实数据，漏项会立刻变成数量断言失败。
 *
 * 生产代码只有本文件自己的 `<SyntaxHelper>` 使用它，导出不扩大任何对外 API 面。
 */
export const SYNTAX_SECTIONS = [
  {
    title: "syntax.section.heading",
    items: [
      { name: "syntax.h1", code: "# ", insert: "# ", cursorOffset: 2, ghost: HEADING_GHOST_TEXTS[0] },
      { name: "syntax.h2", code: "## ", insert: "## ", cursorOffset: 3, ghost: HEADING_GHOST_TEXTS[1] },
      { name: "syntax.h3", code: "### ", insert: "### ", cursorOffset: 4, ghost: HEADING_GHOST_TEXTS[2] },
      // v0.17.0 R3 #3：格式栏 H1~H6 齐全，语法栏只有 H1~H3 —— 补齐 H4~H6。
      { name: "syntax.h4", code: "#### ", insert: "#### ", cursorOffset: 5, ghost: HEADING_GHOST_TEXTS[3] },
      { name: "syntax.h5", code: "##### ", insert: "##### ", cursorOffset: 6, ghost: HEADING_GHOST_TEXTS[4] },
      { name: "syntax.h6", code: "###### ", insert: "###### ", cursorOffset: 7, ghost: HEADING_GHOST_TEXTS[5] },
    ],
  },
  {
    title: "syntax.section.textFormat",
    items: [
      { name: "syntax.bold", code: "**...**", insert: "****", cursorOffset: 2, ghost: "粗体文本" },
      { name: "syntax.italic", code: "*...*", insert: "**", cursorOffset: 1, ghost: "斜体文本" },
      { name: "syntax.boldItalic", code: "***...***", insert: "******", cursorOffset: 3, ghost: "粗斜体" },
      { name: "syntax.strikethrough", code: "~~...~~", insert: "~~~~", cursorOffset: 2, ghost: "删除线" },
      { name: "syntax.inlineCode", code: "`...`", insert: "``", cursorOffset: 1, ghost: "代码" },
    ],
  },
  {
    title: "syntax.section.codeblock",
    items: [
      // v0.17.0 R3 #3：这 4 项此前**无 ghost** —— 用户点名"例如代码块"。
      // 插入后的形态是「开围栏 / 空行 / 闭围栏」，空行就是内容位 → 按判定规则①必须有 ghost。
      // 文案复用 CODEBLOCK_GHOST_TEXT，与格式栏的 codeblock 按钮同句。
      { name: "syntax.codeblock", code: "```...```", insert: "\n```\n\n```\n", cursorOffset: 5, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "syntax.jsCodeblock", code: "```js", insert: "\n```javascript\n\n```\n", cursorOffset: 15, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "syntax.pythonCodeblock", code: "```python", insert: "\n```python\n\n```\n", cursorOffset: 12, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "syntax.htmlCodeblock", code: "```html", insert: "\n```html\n\n```\n", cursorOffset: 9, ghost: CODEBLOCK_GHOST_TEXT },
    ],
  },
  {
    title: "syntax.section.codeblockMore",
    items: [
      // v0.17.0 R3 #3：11 个语言围栏同样补 ghost（理由同上；语言名不 i18n，文案统一）
      { name: "TypeScript", code: "```typescript", insert: "\n```typescript\n\n```\n", cursorOffset: 15, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "Go", code: "```go", insert: "\n```go\n\n```\n", cursorOffset: 7, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "Rust", code: "```rust", insert: "\n```rust\n\n```\n", cursorOffset: 9, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "Java", code: "```java", insert: "\n```java\n\n```\n", cursorOffset: 9, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "C++", code: "```cpp", insert: "\n```cpp\n\n```\n", cursorOffset: 8, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "SQL", code: "```sql", insert: "\n```sql\n\n```\n", cursorOffset: 8, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "JSON", code: "```json", insert: "\n```json\n\n```\n", cursorOffset: 9, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "YAML", code: "```yaml", insert: "\n```yaml\n\n```\n", cursorOffset: 9, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "Bash", code: "```bash", insert: "\n```bash\n\n```\n", cursorOffset: 9, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "Markdown", code: "```markdown", insert: "\n```markdown\n\n```\n", cursorOffset: 13, ghost: CODEBLOCK_GHOST_TEXT },
      { name: "PHP", code: "```php", insert: "\n```php\n\n```\n", cursorOffset: 8, ghost: CODEBLOCK_GHOST_TEXT },
    ],
  },
  {
    title: "syntax.section.list",
    items: [
      { name: "syntax.unorderedList", code: "- ", insert: "- ", cursorOffset: 2, ghost: PREFIX_GHOST_TEXTS.list },
      { name: "syntax.orderedList", code: "1. ", insert: "1. ", cursorOffset: 3, ghost: PREFIX_GHOST_TEXTS.list },
      { name: "syntax.taskList", code: "- [ ] ", insert: "- [ ] ", cursorOffset: 6, ghost: PREFIX_GHOST_TEXTS.task },
      { name: "syntax.taskDone", code: "- [x] ", insert: "- [x] ", cursorOffset: 6, ghost: PREFIX_GHOST_TEXTS.task },
    ],
  },
  {
    title: "syntax.section.other",
    items: [
      { name: "syntax.quote", code: "> ", insert: "> ", cursorOffset: 2, ghost: PREFIX_GHOST_TEXTS.quote },
      { name: "syntax.link", code: "[文本](url)", insert: "[](url)", cursorOffset: 1, ghost: PREFIX_GHOST_TEXTS.link },
      { name: "syntax.image", code: "![描述](url)", insert: "![](url)", cursorOffset: 2, ghost: PREFIX_GHOST_TEXTS.image },
      // ─── 以下两项**明确不补 ghost**（判定规则的反例，别"顺手补上"）───
      // 分割线：`---` 是自足的叶级结构，没有内容位（规则②）。
      { name: "syntax.hr", code: "---", insert: "\n---\n", cursorOffset: 5 },
      // 表格：模板已预填 `列1/列2/列3` 与 `内容`，空位被真实文本占满；
      // 再叠一层 ghost 会与预填文字重叠（规则①）。
      { name: "syntax.table", code: "|...|", insert: "\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n", cursorOffset: 3 },
    ],
  },
];

export function SyntaxHelper({ onInsert }: SyntaxHelperProps) {
  const t = useT();
  const handleClick = useCallback(
    (insert: string, cursorOffset: number, ghost?: string) => {
      onInsert?.(insert, cursorOffset, ghost ? { ghost } : undefined);
    },
    [onInsert]
  );

  return (
    <div className="syntax-helper">
      <div className="syntax-helper-header">
        <span className="syntax-helper-title">{t("syntax.title")}</span>
      </div>
      <div className="syntax-helper-scroll">
        {SYNTAX_SECTIONS.map((section, idx) => (
          <div key={section.title}>
            {idx > 0 && <div className="syntax-helper-divider" />}
            <div className="syntax-helper-section">
              <div className="syntax-helper-section-title">{t(section.title)}</div>
              <ul className="syntax-helper-list">
                {section.items.map((item) => (
                  <li
                    key={item.name}
                    className="syntax-helper-item"
                    title={t("syntax.clickToInsert", { code: item.insert })}
                    onClick={() => handleClick(item.insert, item.cursorOffset, item.ghost)}
                  >
                    <span className="syntax-helper-item-name">
                      {/* 代码块·更多 分组的 name 是语言名（TypeScript/Go 等），不 i18n；其余通过 t() 翻译 */}
                      {section.title === "syntax.section.codeblockMore" ? item.name : t(item.name)}
                    </span>
                    <span className="syntax-helper-item-code">{item.code}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
