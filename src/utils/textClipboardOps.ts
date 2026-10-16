/**
 * v0.13.1 需求16：选区级文本剪贴板操作（阅读模式右键菜单的剪切 / 复制 / 粘贴 / 粘贴为纯文本）。
 *
 * ─── 为什么单独一个文件 ───
 * `utils/blockClipboardOps.ts` 是**块级**（NodeSelection）剪贴板，走 LightMD 专用的
 * `application/x-lightmd-block` 载荷；这里处理的是**文本选区**，语义完全不同：
 * 复制出去的内容要能被别的应用（Word / 浏览器 / 纯文本编辑器）正常消费，
 * 所以写的是浏览器标准的两份格式：`text/html`（保留行内格式）+ `text/plain`。
 *
 * ─── 为什么复制/剪切不依赖事件对象 ───
 * ProseMirror 自带的 `copy`/`cut` 处理器需要**真实事件**上的 `clipboardData`
 * （`prosemirror-view` dist 3619-3635：`data.setData("text/html"…)/("text/plain"…)`，
 * 没有 `data` 时退化到 `captureCopy` 的 DOM Range + `execCommand` 老路）。
 * 从菜单点击进入时并没有原生的复制事件，硬造事件又依赖 `DataTransfer` 的可用性
 * （WebView2/jsdom 上都不可靠）。因此这里走**显式的剪贴板写入**：
 * 用 ProseMirror 公开的 `view.serializeForClipboard(slice)` 拿到标准的 { dom, text }，
 * 再用 `navigator.clipboard.write([ClipboardItem])` 一次写入两份格式；
 * `ClipboardItem` 不可用时退回 `writeText`（至少保证纯文本可用）。
 *
 * ─── 为什么"粘贴为纯文本"不调用 view.pasteText ───
 * `view.pasteText` 会再次经过项目的 `handlePaste` 插件链，其中
 * `clipboard-paste` 的 Markdown 启发式会把 `# 标题` 这类文本**重新渲染成结构**——
 * 那正是"粘贴为纯文本"要避免的行为。因此纯文本粘贴在这里**直接构造 Slice**：
 * 按行拆成若干段落，行内不再做任何 Markdown 解析，落进文档的字面就是剪贴板原文。
 */
import { Fragment, Slice, type Schema } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/** 复制出去的载荷（标准两份格式） */
export interface SelectionClipboardPayload {
  /** 渲染后的 HTML（跨应用保格式） */
  html: string;
  /** 纯文本（Markdown 源码 / 字面文本） */
  text: string;
}

/** 平台是否具备异步剪贴板写入能力 */
function hasAsyncClipboardWrite(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

/** 平台是否具备异步剪贴板读取能力 */
function hasAsyncClipboardRead(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.readText === "function"
  );
}

/**
 * 取当前选区的剪贴板载荷（不写盘、不碰系统剪贴板，纯读）。
 *
 * 用 ProseMirror 公开 API `serializeForClipboard`，保证与 `Ctrl+C` 的原生行为
 * **逐字节一致**（同一套 schema 序列化规则），不会出现"菜单复制的格式和快捷键不一样"。
 *
 * @returns 载荷；选区为空时 null
 */
export function serializeSelection(view: EditorView): SelectionClipboardPayload | null {
  const { selection, doc } = view.state;
  if (selection.empty) return null;
  // 把选区变成"整块"的 Slice：闭合两端的 openStart/openEnd，让输出的 HTML 自成一段
  const slice = selection.content();
  try {
    const { dom, text } = view.serializeForClipboard(slice);
    return { html: dom.innerHTML, text };
  } catch {
    // 极少数 schema 边界（选区跨不兼容节点）下序列化会抛错 → 退回纯 doc 文本
    try {
      return { html: "", text: doc.textBetween(selection.from, selection.to, "\n") };
    } catch {
      return null;
    }
  }
}

/**
 * 把载荷写入系统剪贴板。
 *
 * 优先一次写入两份格式；`ClipboardItem` 不可用时退回纯文本
 * （WebView2 对自定义/多格式写入支持有限，退路必须存在，否则"复制"会完全失效）。
 */
export async function writeSelectionClipboard(
  payload: SelectionClipboardPayload,
): Promise<boolean> {
  if (hasAsyncClipboardWrite()) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      // 落到 writeText 保底
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload.text);
      return true;
    }
  } catch {
    // 完全不可用（权限被拒）
  }
  return false;
}

/**
 * 复制当前选区（不改变文档）。
 *
 * @returns 是否写入成功（失败时调用方 toast 提示，不静默）
 */
export async function copySelection(view: EditorView): Promise<boolean> {
  const payload = serializeSelection(view);
  if (!payload) return false;
  return writeSelectionClipboard(payload);
}

/**
 * 剪切当前选区：先写入剪贴板，**成功后才删除**。
 *
 * 顺序很重要：先删后写的话，写盘失败就会**净丢内容**（用户既没复制成、原文也没了）。
 * 删除走一次事务（= 一次撤销），与 PM 原生 `cut` 的 `deleteSelection` 同源。
 */
export async function cutSelection(view: EditorView): Promise<boolean> {
  const ok = await copySelection(view);
  if (!ok) return false;
  const { state } = view;
  if (state.selection.empty) return false;
  view.dispatch(state.tr.deleteSelection().scrollIntoView());
  return true;
}

/** 读系统剪贴板纯文本；不可用 / 权限被拒时返回 null */
export async function readClipboardText(): Promise<string | null> {
  if (!hasAsyncClipboardRead()) return null;
  try {
    const text = await navigator.clipboard.readText();
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/**
 * 常规粘贴：读剪贴板 → 交给 `view.pasteText`。
 *
 * 走 `pasteText` 而不是自己解析，是为了让粘贴**经过项目既有的 `handlePaste` 插件链**
 * （Markdown 感知 / URL 智能链接 / 图片粘贴），保证"右键菜单粘贴"与 `Ctrl+V` 行为一致。
 */
export async function pasteIntoView(view: EditorView): Promise<boolean> {
  const text = await readClipboardText();
  if (text === null || text === "") return false;
  try {
    return view.pasteText(text);
  } catch {
    return false;
  }
}

/**
 * 由纯文本构造 Slice（**不做任何 Markdown 解析**）。
 *
 * 语义与 `clipboard-paste.buildPasteSlice` 对齐：
 * - 单行 → openStart/openEnd = 1，与光标所在段落行内合并；
 * - 多行 → 每行一个段落，open = 0，按块插入并拆分当前段落。
 *
 * 之所以不用 `markdownToDoc`：那正是"粘贴为纯文本"要**避免**的（`# 标题` 会被
 * 渲染成标题结构）。这里只按行切段，字面内容一字不改。
 *
 * @returns Slice；空文本时 null
 */
export function buildPlainTextSlice(schema: Schema, text: string): Slice | null {
  if (!text) return null;
  const lines = text.split(/\r\n|\r|\n/);
  const para = schema.nodes.paragraph;
  if (!para) return null;
  const nodes = lines.map((line) =>
    para.create(null, line.length > 0 ? schema.text(line) : undefined),
  );
  if (nodes.length === 0) return null;
  const open = nodes.length === 1 ? 1 : 0;
  return new Slice(Fragment.fromArray(nodes), open, open);
}

/**
 * 粘贴为纯文本：读剪贴板 → 按纯文本插入，**不经过 Markdown 解析**。
 *
 * @returns 是否插入成功
 */
export async function pastePlainIntoView(view: EditorView): Promise<boolean> {
  const text = await readClipboardText();
  if (text === null || text === "") return false;
  const slice = buildPlainTextSlice(view.state.schema, text);
  if (!slice) return false;
  try {
    const tr = view.state.tr.replaceSelection(slice);
    if (!tr.docChanged) return false;
    view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "paste"));
    return true;
  } catch {
    return false;
  }
}

/**
 * 选区是否可剪切/复制（菜单禁用态用，**不读系统剪贴板**）。
 *
 * v0.13.0 第三轮的教训：为了算禁用态去 `navigator.clipboard.read()` 会让 WebView2
 * 弹出系统授权气泡。这里只读编辑器自身选区，零 IO。
 */
export function hasCopyableSelection(view: EditorView | null): boolean {
  if (!view) return false;
  return !view.state.selection.empty;
}
