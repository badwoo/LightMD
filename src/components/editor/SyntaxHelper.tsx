/**
 * SyntaxHelper —— 编辑模式下的语法辅助和格式辅助面板
 *
 * 在源码编辑模式下替代大纲面板，显示在右侧。
 * 提供常用 Markdown 语法参考和快捷插入功能。
 */
import { useCallback } from "react";
import { useT } from "../../i18n";
import "../../styles/editor.css";

interface SyntaxHelperProps {
  onInsert?: (syntax: string, cursorOffset: number) => void;
}

// 语法辅助数据
// cursorOffset: 插入后光标应放在第几个字符位置（从插入文本起始计算）
// title/name 字段存储 i18n key，渲染时通过 t() 翻译
// code/insert 字段是 Markdown 语法示例，不 i18n
const SYNTAX_SECTIONS = [
  {
    title: "syntax.section.heading",
    items: [
      { name: "syntax.h1", code: "# ", insert: "# ", cursorOffset: 2 },
      { name: "syntax.h2", code: "## ", insert: "## ", cursorOffset: 3 },
      { name: "syntax.h3", code: "### ", insert: "### ", cursorOffset: 4 },
    ],
  },
  {
    title: "syntax.section.textFormat",
    items: [
      { name: "syntax.bold", code: "**...**", insert: "****", cursorOffset: 2 },
      { name: "syntax.italic", code: "*...*", insert: "**", cursorOffset: 1 },
      { name: "syntax.boldItalic", code: "***...***", insert: "******", cursorOffset: 3 },
      { name: "syntax.strikethrough", code: "~~...~~", insert: "~~~~", cursorOffset: 2 },
      { name: "syntax.inlineCode", code: "`...`", insert: "``", cursorOffset: 1 },
    ],
  },
  {
    title: "syntax.section.codeblock",
    items: [
      { name: "syntax.codeblock", code: "```...```", insert: "\n```\n\n```\n", cursorOffset: 5 },
      { name: "syntax.jsCodeblock", code: "```js", insert: "\n```javascript\n\n```\n", cursorOffset: 15 },
      { name: "syntax.pythonCodeblock", code: "```python", insert: "\n```python\n\n```\n", cursorOffset: 12 },
      { name: "syntax.htmlCodeblock", code: "```html", insert: "\n```html\n\n```\n", cursorOffset: 9 },
    ],
  },
  {
    title: "syntax.section.codeblockMore",
    items: [
      { name: "TypeScript", code: "```typescript", insert: "\n```typescript\n\n```\n", cursorOffset: 15 },
      { name: "Go", code: "```go", insert: "\n```go\n\n```\n", cursorOffset: 7 },
      { name: "Rust", code: "```rust", insert: "\n```rust\n\n```\n", cursorOffset: 9 },
      { name: "Java", code: "```java", insert: "\n```java\n\n```\n", cursorOffset: 9 },
      { name: "C++", code: "```cpp", insert: "\n```cpp\n\n```\n", cursorOffset: 8 },
      { name: "SQL", code: "```sql", insert: "\n```sql\n\n```\n", cursorOffset: 8 },
      { name: "JSON", code: "```json", insert: "\n```json\n\n```\n", cursorOffset: 9 },
      { name: "YAML", code: "```yaml", insert: "\n```yaml\n\n```\n", cursorOffset: 9 },
      { name: "Bash", code: "```bash", insert: "\n```bash\n\n```\n", cursorOffset: 9 },
      { name: "Markdown", code: "```markdown", insert: "\n```markdown\n\n```\n", cursorOffset: 13 },
      { name: "PHP", code: "```php", insert: "\n```php\n\n```\n", cursorOffset: 8 },
    ],
  },
  {
    title: "syntax.section.list",
    items: [
      { name: "syntax.unorderedList", code: "- ", insert: "- ", cursorOffset: 2 },
      { name: "syntax.orderedList", code: "1. ", insert: "1. ", cursorOffset: 3 },
      { name: "syntax.taskList", code: "- [ ] ", insert: "- [ ] ", cursorOffset: 6 },
      { name: "syntax.taskDone", code: "- [x] ", insert: "- [x] ", cursorOffset: 6 },
    ],
  },
  {
    title: "syntax.section.other",
    items: [
      { name: "syntax.quote", code: "> ", insert: "> ", cursorOffset: 2 },
      { name: "syntax.link", code: "[文本](url)", insert: "[](url)", cursorOffset: 1 },
      { name: "syntax.image", code: "![描述](url)", insert: "![](url)", cursorOffset: 2 },
      { name: "syntax.hr", code: "---", insert: "\n---\n", cursorOffset: 5 },
      { name: "syntax.table", code: "|...|", insert: "\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n", cursorOffset: 3 },
    ],
  },
];

export function SyntaxHelper({ onInsert }: SyntaxHelperProps) {
  const t = useT();
  const handleClick = useCallback(
    (insert: string, cursorOffset: number) => {
      onInsert?.(insert, cursorOffset);
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
                    onClick={() => handleClick(item.insert, item.cursorOffset)}
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
