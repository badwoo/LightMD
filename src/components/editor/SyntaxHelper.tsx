/**
 * SyntaxHelper —— 编辑模式下的语法辅助和格式辅助面板
 *
 * 在源码编辑模式下替代大纲面板，显示在右侧。
 * 提供常用 Markdown 语法参考和快捷插入功能。
 */
import { useCallback } from "react";
import "../../styles/editor.css";

interface SyntaxHelperProps {
  onInsert?: (syntax: string, cursorOffset: number) => void;
}

// 语法辅助数据
// cursorOffset: 插入后光标应放在第几个字符位置（从插入文本起始计算）
const SYNTAX_SECTIONS = [
  {
    title: "标题",
    items: [
      { name: "一级标题", code: "# ", insert: "# ", cursorOffset: 2 },
      { name: "二级标题", code: "## ", insert: "## ", cursorOffset: 3 },
      { name: "三级标题", code: "### ", insert: "### ", cursorOffset: 4 },
    ],
  },
  {
    title: "文本格式",
    items: [
      { name: "粗体", code: "**...**", insert: "****", cursorOffset: 2 },
      { name: "斜体", code: "*...*", insert: "**", cursorOffset: 1 },
      { name: "粗斜体", code: "***...***", insert: "******", cursorOffset: 3 },
      { name: "删除线", code: "~~...~~", insert: "~~~~", cursorOffset: 2 },
      { name: "行内代码", code: "`...`", insert: "``", cursorOffset: 1 },
    ],
  },
  {
    title: "代码块",
    items: [
      { name: "代码块", code: "```...```", insert: "\n```\n\n```\n", cursorOffset: 5 },
      { name: "JS 代码块", code: "```js", insert: "\n```javascript\n\n```\n", cursorOffset: 15 },
      { name: "Python 代码块", code: "```python", insert: "\n```python\n\n```\n", cursorOffset: 12 },
      { name: "HTML 代码块", code: "```html", insert: "\n```html\n\n```\n", cursorOffset: 9 },
    ],
  },
  {
    title: "列表",
    items: [
      { name: "无序列表", code: "- ", insert: "- ", cursorOffset: 2 },
      { name: "有序列表", code: "1. ", insert: "1. ", cursorOffset: 3 },
      { name: "任务列表", code: "- [ ] ", insert: "- [ ] ", cursorOffset: 6 },
      { name: "已完成任务", code: "- [x] ", insert: "- [x] ", cursorOffset: 6 },
    ],
  },
  {
    title: "其他",
    items: [
      { name: "引用", code: "> ", insert: "> ", cursorOffset: 2 },
      { name: "链接", code: "[文本](url)", insert: "[](url)", cursorOffset: 1 },
      { name: "图片", code: "![描述](url)", insert: "![](url)", cursorOffset: 2 },
      { name: "分割线", code: "---", insert: "\n---\n", cursorOffset: 5 },
      { name: "表格", code: "|...|", insert: "\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |\n", cursorOffset: 3 },
    ],
  },
];

export function SyntaxHelper({ onInsert }: SyntaxHelperProps) {
  const handleClick = useCallback(
    (insert: string, cursorOffset: number) => {
      onInsert?.(insert, cursorOffset);
    },
    [onInsert]
  );

  return (
    <div className="syntax-helper">
      <div className="syntax-helper-header">
        <span className="syntax-helper-title">语法辅助</span>
      </div>
      <div className="syntax-helper-scroll">
        {SYNTAX_SECTIONS.map((section, idx) => (
          <div key={section.title}>
            {idx > 0 && <div className="syntax-helper-divider" />}
            <div className="syntax-helper-section">
              <div className="syntax-helper-section-title">{section.title}</div>
              <ul className="syntax-helper-list">
                {section.items.map((item) => (
                  <li
                    key={item.name}
                    className="syntax-helper-item"
                    title={`点击插入: ${item.insert}`}
                    onClick={() => handleClick(item.insert, item.cursorOffset)}
                  >
                    <span className="syntax-helper-item-name">{item.name}</span>
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
