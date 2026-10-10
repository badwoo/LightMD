/**
 * v0.12.1 需求5：任务列表的两种图标样式（方形 / 圆形）——**单一事实源**。
 *
 * 背景：Markdown 没有"圆形复选框"语法，样式必须落进 .md 才能保存后不丢。
 * 与用户确认的口径：**用无序列表符号区分**
 *   · 方形（默认）：`- [ ] 内容` / `- [x] 内容`
 *   · 圆形：        `* [ ] 内容` / `* [x] 内容`
 * 两者都是标准任务列表语法（CommonMark 的 bullet 可以是 - * +），别的编辑器打开只是
 * 列表符号不同，不会多出奇怪文字；LightMD 内按符号渲染成方框/圆框。
 *
 * 解析（task-list-plugin）、文档模型（schema.task_item.attrs.style）、序列化（serializer）、
 * 分屏预览（markdown-it renderer）与格式刷都从这里取口径，避免各处硬编码字符串漂移。
 */

export type TaskStyle = "square" | "circle";

export const DEFAULT_TASK_STYLE: TaskStyle = "square";

/** 容错归一：未知值一律回落到方形（默认样式） */
export function normalizeTaskStyle(value: unknown): TaskStyle {
  return value === "circle" ? "circle" : "square";
}

/** 样式 → 无序列表符号 */
export const TASK_STYLE_BULLET: Record<TaskStyle, string> = {
  square: "-",
  circle: "*",
};

/** 无序列表符号 → 样式（`*` 为圆形，`-`/`+` 与其它一律方形） */
export function taskStyleFromBullet(bullet: string): TaskStyle {
  return bullet === "*" ? "circle" : "square";
}

/** 样式 → li 的 class（NodeView 与 markdown-it 渲染规则共用，保证两处 DOM 同构） */
export function taskItemClassName(style: TaskStyle): string {
  return style === "circle" ? "task-item task-item-circle" : "task-item";
}
