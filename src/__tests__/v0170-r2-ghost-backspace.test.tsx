// @vitest-environment jsdom
/**
 * v0.17.0 R2 第 7 项用户缺陷回归：**ghost 状态下退格整段删除格式符（CM6 路径）**
 *
 * ## 缺陷（用户原话）
 * > 「格式栏或语法栏的 ghost 文本功能，如果插入某个格式符在没有任何输入情况下
 * >   再按退格键是可以把整个格式符删掉的，但现在这个功能失效了。」
 *
 * 修复前实测（`scripts/v0170-r2-ghost-backspace.mjs`，浏览器内仪器）：
 * 点「粗体」→ 文档 `****`、ghost 存活、坐标一致 → 按 Backspace → `****` 变 `***`
 * （逐字符删除），`formatGhostHandlersRef.remove()` **零次调用**。
 *
 * ## 根因（一层，不是三条）
 *
 * CM6 把 keymap 实现在 **`keymap` facet 的 `enables`** 上：
 * `Prec.default(EditorView.domEventHandlers({ keydown: runHandlers }))`。
 * 而 `@codemirror/commands` 的 `defaultKeymap` **显式绑定了 `Backspace`**
 * （`deleteCharBackward`, `preventDefault: true`）。`CmSourceSurface.buildExtensions()`
 * 里 `keymap.of([...defaultKeymap])` 排在宿主的 `domEventHandlers` **之前**，
 * 两者同为 `Prec.default` → `runHandlers` 按注册顺序跑，CM6 的 keymap 先消费并
 * `preventDefault` + `break` → **宿主的 `handleSourceKeyDown` 一次都不会被调用**。
 * 于是"退格整段删除"那段代码在 CM6 下是**死代码**。
 *
 * 修法：在**捕获阶段**（`document` + `capture: true`）接住无修饰 Backspace，
 * 与同文件 Tab 的既有做法同模式（见 `CmSourceSurface` 的 `onTabKeydown` 注释）。
 *
 * ## 本文件的防恒真设计（关键）
 *
 * 只有"修好后成立"的断言会变成恒真。因此每条正向断言都配了**破坏性对照**：
 *
 * | 用例 | 若把修复/判据改坏，是否会红 |
 * |---|---|
 * | T1 Backspace 必须被捕获阶段 `preventDefault` + 整段删净 | **会** —— 修复前 `defaultPrevented=false`，文本只少 1 字符（已用探针实测修复前红） |
 * | T2 直接调 `remove()`：坐标一致 → 返回 true | 会（若判据被删掉/放宽） |
 * | T3 ★ 坐标判据失效（ghost.pos 与真实选区不符）→ `remove()` 必须返回 false | **会** —— 若有人"简化"掉 `ghostSel.start !== ghost.pos` 这道判据，T3 立刻红 |
 * | T4 ★ ghost 被提前清掉 → 按 Backspace **不得**整段删除 | **会** —— 若有人改成"有字符就整段删"，T4 立刻红 |
 * | T5 Ctrl+Backspace 不得被接管（按词删除语义） | 会（若把修饰键守卫删掉） |
 * | T6 光标已离开插入点 → 走默认逐字符删除 | 会 |
 *
 * T3/T4 正是任务卡要求的"证明如果坐标判据失效 / ghost 被提前清掉，测试会红"。
 *
 * ## 为什么必须走**真实 EditorContainer + forceSurfaceImpl="cm6"**
 *
 * jsdom 下 `createSourceSurface()` 恒回退 textarea（`canUseCm6()` 的 UA 判定），
 * 手工 `new CmSourceSurface()` 又绕过了 React 装配 —— 本缺陷恰恰藏在
 * "CM6 的 keymap 与宿主的 domEventHandlers 谁先跑"这个**装配+库内部**的交界处。
 * 只有真实装配才能复现。
 */
import { describe, it, expect, afterEach, beforeEach, beforeAll } from "vitest";
import { createElement } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { EditorContainer } from "../components/editor/EditorContainer";
import { useEditorStore } from "../stores/useEditorStore";
import type { SourceSurface } from "../editor/types";

afterEach(cleanup);

/**
 * ⚠️ 必须把 store 切到**编辑模式**。
 *
 * `useEditorStore` 的 `viewMode` 默认是 `"preview"`，而 `EditorContainer` 里
 * `isSourceMode = viewMode !== "preview"`。修复的 effect 首行有
 * `if (!isSourceMode || !isMdFile) return;`（与产品语义一致：只有源码面才需要
 * 这个键位）。不切模式 → 监听不挂 → 测试测的是"没装监听"的情形。
 *
 * 实测这**正是**第一版测试红的原因（`text` 从 `****` 变 `***`，
 * 而 `defaultPrevented` 又是 true —— 那是 CM6 contenteditable 自己 preventDefault 的，
 * 极具误导性：看起来"拦了但没删干净"，实际是"根本没装监听"）。
 */
function setEditMode() {
  useEditorStore.setState({ viewMode: "edit" });
}
beforeEach(setEditMode);

/**
 * ## jsdom 布局 API 补丁（**只补到"不抛"**，不伪造真实几何）
 *
 * jsdom 没有 `Range.prototype.getClientRects`。CM6 的 `TextTile.coordsIn`
 * 直接调它 → 抛 `TypeError: textRange(...).getClientRects is not a function`。
 * 该异常发生在 CM6 自己的 rAF measure 循环里（异步），**不是**测试代码抛的，
 * 会被 vitest 记为 "Uncaught Exception"，让整个文件的成败信号变脏。
 *
 * 本文件被测的是**事件路由与 ghost 判据**，与几何无关，所以把这两个 API
 * 补成"返回空/零矩形"即可。真实几何由实机探针
 * （`scripts/v0170-r2-ghost-backspace.mjs`）在浏览器里验 —— 这里不冒充。
 *
 * ⚠️ 这条补丁**必须在 import React/CM6 之后、render 之前**装好；
 * 用 `beforeAll` 放在文件作用域即可（vitest 的 jsdom 环境每个文件独立）。
 */
beforeAll(() => {
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof proto.getClientRects !== "function") {
    proto.getClientRects = () => ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () { /* 空 */ },
    }) as unknown as DOMRectList;
  }
  if (typeof proto.getBoundingClientRect !== "function") {
    proto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
});

const DOC = ["# Ghost 退格", "", "第二段落文字", "", "第三段落", ""].join("\n");
/** DOC 中第 2 行（0-based index 1 是第 2 行；空行）的行首偏移 */
const EMPTY_LINE_START = "# Ghost 退格\n".length;

/* ────────────── 从 React fiber 里取 hook 的 ref（与探针同构） ────────────── */

interface RefLike<T> { current: T }

/**
 * 收集所有 hook 的 ref，**保留 hook 链表顺序**。
 *
 * ⚠️ 为什么必须保留顺序：`formatGhostRef` 初始值是 `useRef(null)`，
 * 它的 `current` 在"还没点格式按钮"时就是 `null` —— 按"形状像 ghost"去找
 * **找不到**。而 `formatGhostHandlersRef`（`{render,clear,remove}` 三个函数）
 * 从首帧起就非 null，形状唯一 → 用它定位，再取**紧邻的前一个** ref
 * 即 `formatGhostRef`（`EditorContainer` 里两者是相邻的 useRef 声明）。
 */
function collectHooks(): Array<{ ref: RefLike<unknown>; order: number }> {
  const el = document.querySelector(".source-format-toolbar")
    ?? document.querySelector(".editor-container")
    ?? document.body;
  const key = Object.keys(el as unknown as Record<string, unknown>)
    .find((n) => n.startsWith("__reactFiber$"));
  if (!key) return [];
  let f = (el as unknown as Record<string, unknown>)[key] as {
    return?: unknown; memoizedState?: unknown; child?: unknown; sibling?: unknown;
  };
  let guard = 0;
  while (f.return && guard++ < 5000) f = f.return as typeof f;

  const out: Array<{ ref: RefLike<unknown>; order: number }> = [];
  const seen = new Set<unknown>();
  let order = 0;
  const walk = (node: typeof f): void => {
    let hook = node.memoizedState as { next?: unknown } | null;
    let g = 0;
    while (hook && typeof hook === "object" && "next" in hook && g++ < 800) {
      const s = (hook as { memoizedState?: unknown }).memoizedState;
      if (s && typeof s === "object" && "current" in (s as object) && !seen.has(s)) {
        seen.add(s);
        // order 单调递增 → "前一个 ref" 即 order 最小者中最大的那个
        out.push({ ref: s as RefLike<unknown>, order: order++ });
      }
      hook = (hook as { next?: unknown }).next as typeof hook;
    }
    if (node.child) walk(node.child as typeof node);
    if (node.sibling) walk(node.sibling as typeof node);
  };
  walk(f);
  return out;
}

const collectFiberRefs = (): Array<RefLike<unknown>> => collectHooks().map((h) => h.ref);

interface GhostSpec {
  text: string; pos: number; start: number; end: number; content: string;
  tail?: string; maskTail?: boolean;
}
interface Handlers {
  render: () => void; clear: (kind: string) => void; remove: () => boolean;
}

function findHandlersEntry(): { ref: RefLike<Handlers>; order: number } | null {
  const hit = collectHooks().find((h) => {
    const c = h.ref.current as Partial<Handlers> | null;
    return !!c && typeof c === "object"
      && typeof c.render === "function" && typeof c.clear === "function"
      && typeof c.remove === "function";
  });
  return (hit as { ref: RefLike<Handlers>; order: number } | undefined) ?? null;
}

/**
 * 取 `formatGhostRef`：`formatGhostHandlersRef` **前一个** ref。
 *
 * 形状判定只做"兜底校验"（`current` 为 null，或已是 ghost 形状），
 * 因为未点按钮时它必然是 `null`。
 */
function findGhostRef(): RefLike<GhostSpec | null> | null {
  const hooks = collectHooks();
  const hIdx = hooks.findIndex((h) => {
    const c = h.ref.current as Partial<Handlers> | null;
    return !!c && typeof c === "object"
      && typeof c.render === "function" && typeof c.clear === "function"
      && typeof c.remove === "function";
  });
  if (hIdx <= 0) return null;
  const cand = hooks[hIdx - 1].ref as RefLike<GhostSpec | null>;
  const c = cand.current as Partial<GhostSpec> | null;
  const shapeOk = c === null || (typeof c === "object"
    && typeof c.pos === "number" && typeof c.start === "number"
    && typeof c.end === "number" && typeof c.content === "string");
  expect(shapeOk, "formatGhostHandlersRef 的前一个 ref 必须是 formatGhostRef（形状校验）").toBe(true);
  return cand;
}

function findSurface(): SourceSurface | null {
  const hit = collectFiberRefs().find((r) => {
    const c = r.current as Partial<SourceSurface> | null;
    return !!c && typeof c === "object" && c.impl === "cm6"
      && typeof c.getSelection === "function" && typeof c.applyEdit === "function";
  });
  return (hit?.current ?? null) as SourceSurface | null;
}

/* ────────────── 装配 ────────────── */

interface Harness {
  surface: SourceSurface;
  ghostRef: RefLike<GhostSpec | null>;
  handlers: RefLike<Handlers>;
}

function mount(): Harness {
  render(createElement(EditorContainer, {
    content: DOC,
    filePath: "/tmp/r2-ghost-backspace.md",
    // jsdom 下工厂恒回退 textarea，必须强制才走 CM6 装配路径
    forceSurfaceImpl: "cm6" as const,
  }));
  const surface = findSurface();
  const handlers = findHandlersEntry();
  const ghostRef = findGhostRef();
  expect(surface, "必须能取到 CM6 的 SourceSurface（否则本文件测的是别的路径）").toBeTruthy();
  expect(handlers, "必须能取到 formatGhostHandlersRef").toBeTruthy();
  expect(ghostRef, "必须能定位到 formatGhostRef（handlers 的前一个 ref）").toBeTruthy();
  return { surface: surface!, ghostRef: ghostRef!, handlers: handlers!.ref };
}

/**
 * 把文档做成"刚点完格式按钮"的状态：插入 `****`、光标落在中间、ghost 指向它。
 *
 * ⚠️ 顺序**必须**是先 `applyEdit` 再设 ghost —— 与产品代码一致
 * （`SourcePane.handleFormatAction` 也是先改文档、后设 ghost）。
 * 反过来会被 `applySourceInput` 的 `clear("input")` 立刻清掉。
 *
 * ⚠️ **必须等快照传播完成再设 ghost**（否则 `remove()` 会因 `sourceContentRef`
 * 落后于 `surface.getText()` 而返回 false —— 这是**测试的时序缺陷**，不是产品缺陷）。
 *
 * 实测（本文件第一版）：单独跑本文件 7/7 绿，跑全量套件时 T2 变红
 * （`remove()` 返回 false）。原因是 `applyEdit` → CM6 `onDidChange` →
 * `applySourceInput` → `setSourceContent` 是一条 **React 提交异步链**，
 * 负载高时这一链可能还没跑完；而 `ghost.content` 是我同步写进去的，
 * 于是 `remove()` 内部 `current.slice(...) !== ghost.content.slice(...)` 判失败。
 *
 * 教训与本轮 P0-1 报告 §3 同类：**测量装置的时序缺陷会伪装成被测对象的缺陷**。
 */
async function armGhost(h: Harness, syntax = "****", ghostText = "粗体文本") {
  await act(async () => {
    h.surface.applyEdit({
      kind: "edit",
      edit: { from: EMPTY_LINE_START, to: EMPTY_LINE_START, text: syntax, caret: EMPTY_LINE_START + 2 },
    });
  });
  // 等宿主把内容同步到 sourceContentRef（`remove()` 的判据读的就是它）
  const content = await waitForSurfaceSync(h.surface, syntax);
  await act(async () => {
    h.ghostRef.current = {
      text: ghostText,
      pos: EMPTY_LINE_START + 2,
      start: EMPTY_LINE_START,
      end: EMPTY_LINE_START + syntax.length,
      content,
      tail: "**",
      maskTail: true,
    };
  });
  /**
   * 再等一次"三条判据同时成立"（而不是只等文本同步）。
   *
   * `remove()` 内部有三道守卫：ghost 非空 / 光标在 ghost.pos 且无选区 /
   * `sourceContentRef` 的对应片段等于 ghost 快照。三者任一条不满足就返回 false。
   * 在**全量套件并发**下这些条件要靠 React 提交与 rAF 才稳定，所以这里显式等齐，
   * 把"等待"与"断言"分开 —— 否则测出来的红是**测试时序**缺陷，不是产品缺陷。
   */
  await waitForGhostReady(h);
  return { content, start: EMPTY_LINE_START, end: EMPTY_LINE_START + syntax.length, pos: EMPTY_LINE_START + 2 };
}

/** 读出 `remove()` 三道守卫的当前实况（诊断用；失败时打印它就知道断在哪条） */
function readGhostGuards(h: Harness) {
  const g = h.ghostRef.current;
  const sel = h.surface.getSelection();
  const candidates = collectFiberRefs()
    .map((r) => r.current)
    .filter((c): c is string => typeof c === "string");
  const expected = g ? g.content.slice(g.start, g.end) : null;
  const sliceOk = !!g && candidates.some((c) => c.slice(g.start, g.end) === expected);
  return {
    hasGhost: !!g,
    pos: g?.pos ?? null,
    start: g?.start ?? null,
    end: g?.end ?? null,
    sel,
    selOk: !!g && sel.start === sel.end && sel.start === g.pos,
    sliceOk,
    strRefs: candidates.map((c) => c.length),
  };
}

/** 等到三道守卫全部成立（最多 1.2s）；超时则原样返回，让断言给出真实差异 */
async function waitForGhostReady(h: Harness) {
  for (let i = 0; i < 24; i++) {
    const g = readGhostGuards(h);
    if (g.hasGhost && g.selOk && g.sliceOk) return g;
    // 光标不在插入点时主动放回去（真实用户点完按钮后光标就在插入点）
    if (g.hasGhost && !g.selOk) {
      await act(async () => { h.surface.setSelection(g.pos as number, g.pos as number); });
    }
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 50)); });
  }
  return readGhostGuards(h);
}

/**
 * 轮询等待宿主的内容快照追上 `surface.getText()`。
 *
 * 判据是"存在一个字符串 ref，其值等于当前文档 **且包含刚插入的语法符号**"。
 * 之所以加 `includes(syntax)`：下拉/编辑器里可能还有别的字符串 ref（如
 * `lastContentRef`），只比长度相同会误判成"已同步"。
 */
async function waitForSurfaceSync(surface: SourceSurface, syntax: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const text = surface.getText();
    const synced = collectFiberRefs().some((r) => {
      const c = r.current;
      return typeof c === "string" && c === text && c.includes(syntax);
    });
    if (synced) return text;
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 25)); });
  }
  return surface.getText();
}

/** 往 CM6 的 `.cm-content` 派发一个可取消的 keydown（真实用户按键路径） */
function pressOnContent(init: KeyboardEventInit): KeyboardEvent {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  expect(content, "CM6 的 .cm-content 必须在（否则事件根本接不到）").toBeTruthy();
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  content!.dispatchEvent(e);
  return e;
}

/**
 * 派发一次 keydown，并报告**事件是否继续冒泡到 window**。
 *
 * ## 为什么不能用 `defaultPrevented` 判断"我们的监听有没有接管"
 *
 * 实测（本项目 `dom-event-handlers-contract.test.ts` 已记录同一坑）：
 * **CM6 对编辑区内未消费的键会自行 `preventDefault()`**（contenteditable 的正常行为）。
 * 所以"没被我们接管"时 `defaultPrevented` 也可能是 `true`，这个判据**不可用**。
 *
 * 可靠判据是 `stopPropagation`：我们的捕获监听在接管后会调 `stopPropagation()`，
 * 事件因此**不会到达 window**；没接管时 CM6 的 `defaultKeymap` 绑定
 * （`Backspace` 未设 `stopPropagation`）会让事件正常冒泡到 window。
 */
function pressAndReportBubble(init: KeyboardEventInit): { e: KeyboardEvent; reachedWindow: boolean } {
  const content = document.querySelector(".cm-content") as HTMLElement | null;
  expect(content, "CM6 的 .cm-content 必须在").toBeTruthy();
  let reachedWindow = false;
  const onWin = () => { reachedWindow = true; };
  window.addEventListener("keydown", onWin);
  try {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    content!.dispatchEvent(e);
    return { e, reachedWindow };
  } finally {
    window.removeEventListener("keydown", onWin);
  }
}

/** 等产品代码里 `requestAnimationFrame(restore)` 把光标放回去 */
const settle = () => new Promise<void>((r) => setTimeout(r, 60));

/* ══════════════════════════════════════════════════════════════════════════ */

describe("v0.17.0 R2-⑦：ghost + Backspace 整段删除格式符（CM6）", () => {
  it("T1 ★ 无修饰 Backspace 被捕获阶段接管：preventDefault + 文本整段退回 + 光标回插入点", async () => {
    const h = mount();
    const armed = await armGhost(h);
    expect(h.surface.getText(), "前置：`****` 必须已插入").toContain("****");

    const e = pressOnContent({ key: "Backspace", code: "Backspace", keyCode: 8 });
    /**
     * ⚠️ 这条断言就是**修复前会红**的那条（探针实测：修复前 `defaultPrevented=false`）。
     * CM6 的 keymap 会先消费 Backspace，宿主的 React 风格 handler 根本轮不到 ——
     * 修复后由 document 捕获阶段的监听拦下并 preventDefault。
     */
    expect(e.defaultPrevented, "Backspace 必须被捕获阶段拦下（修复前为 false → CM6 逐字符删除）").toBe(true);

    await act(async () => { await settle(); });
    expect(h.surface.getText(), "文档必须完全退回点击格式按钮之前").toBe(DOC);
    expect(h.surface.getSelection(), "光标必须回到插入点之前的位置（= ghost.start）")
      .toEqual({ start: armed.start, end: armed.start });
    expect(h.ghostRef.current, "删除后 ghost 必须消失").toBeNull();
  });

  it("T2 直接调用 remove()：坐标一致 → 返回 true 并整段删净（锁判据本身是好的）", async () => {
    const h = mount();
    const armed = await armGhost(h);

    let ret = false;
    await act(async () => { ret = h.handlers.current.remove(); });
    /**
     * 失败时把三道守卫的实况打出来 —— 否则只看到 "expected false to be true"
     * 无法区分"产品判据坏了"和"测试没等到位"。
     */
    expect(ret, `坐标/快照全部一致时 remove() 必须成功；守卫实况=${JSON.stringify(readGhostGuards(h))}`).toBe(true);

    await act(async () => { await settle(); });
    expect(h.surface.getText()).toBe(DOC);
    expect(h.surface.getSelection()).toEqual({ start: armed.start, end: armed.start });
  });

  it("T3 ★ 破坏性对照：坐标判据失效（ghost.pos 与真实选区不符）→ remove() 必须返回 false", async () => {
    const h = mount();
    const armed = await armGhost(h);
    // 只把 ghost.pos 挪开 1 —— 模拟"迁移后坐标系语义不一致"
    await act(async () => {
      h.ghostRef.current = { ...(h.ghostRef.current as GhostSpec), pos: armed.pos + 1 };
    });

    let ret = true;
    await act(async () => { ret = h.handlers.current.remove(); });
    expect(ret, "★ 光标不在 ghost.pos 时必须拒绝整段删除（否则会误删用户已移开的内容）").toBe(false);
    await act(async () => { await settle(); });
    expect(h.surface.getText(), "拒绝后文档不得被改动").toContain("****");
  });

  it("T4 ★ 破坏性对照：ghost 被提前清掉 → 按 Backspace 不得整段删除（回落默认逐字符）", async () => {
    const h = mount();
    await armGhost(h);
    await act(async () => { h.handlers.current.clear("escape"); });
    expect(h.ghostRef.current, "前置：ghost 已被清").toBeNull();

    const before = h.surface.getText();
    // CM6 的默认删除命令在 jsdom 里可能因缺布局 API 抛（那是 jsdom 限制，不是缺陷）
    let reachedWindow = false;
    await act(async () => {
      try { reachedWindow = pressAndReportBubble({ key: "Backspace", code: "Backspace", keyCode: 8 }).reachedWindow; }
      catch { /* jsdom 布局限制 */ }
    });
    await act(async () => { await settle(); });

    const after = h.surface.getText();
    expect(after, "★ ghost 不在了就不能整段删（否则是误删）").not.toBe(DOC);
    expect(after === before.replace("****", ""), "★ 不得整段删除").toBe(false);
    /**
     * 未接管的可观测表现：事件**继续冒泡到 window**（我们的监听一旦接管会
     * `stopPropagation()`）。⚠️ 不能用 `defaultPrevented` —— CM6 对编辑区内
     * 未消费的键会自行 preventDefault（contenteditable 正常行为）。
     */
    expect(reachedWindow, "ghost 已被清时不得接管（事件必须继续冒泡）").toBe(true);
  });

  it("T5 Ctrl+Backspace 不被接管（按词删除语义必须留给 CM6）", async () => {
    const h = mount();
    await armGhost(h);
    const before = h.surface.getText();
    let reachedWindow = false;
    await act(async () => {
      try {
        reachedWindow = pressAndReportBubble({
          key: "Backspace", code: "Backspace", keyCode: 8, ctrlKey: true,
        }).reachedWindow;
      } catch { /* jsdom 布局限制 */ }
    });
    await act(async () => { await settle(); });

    expect(reachedWindow, "带修饰键的 Backspace 不得被 ghost 逻辑接管（事件必须继续冒泡）").toBe(true);
    expect(h.surface.getText(), "Ctrl+Backspace 不得整段删掉格式符").not.toBe(DOC);
    expect(h.surface.getText(), "不得变成整段删净").not.toBe(before.replace("****", ""));
  });

  it("T6 光标已离开插入点 → 走默认行为（不得整段删）", async () => {
    const h = mount();
    await armGhost(h);
    await act(async () => { h.surface.setSelection(0, 0); });
    const before = h.surface.getText();
    let reachedWindow = false;
    await act(async () => {
      try { reachedWindow = pressAndReportBubble({ key: "Backspace", code: "Backspace", keyCode: 8 }).reachedWindow; }
      catch { /* jsdom 限制 */ }
    });
    await act(async () => { await settle(); });

    expect(reachedWindow, "光标已移开时不得接管（事件必须继续冒泡）").toBe(true);
    expect(h.surface.getText(), "不得整段删掉格式符").not.toBe(before.replace("****", ""));
  });

  it("T7 textarea 路径不受影响（impl !== cm6 时不重复绑定，避免双删）", async () => {
    render(createElement(EditorContainer, {
      content: DOC,
      filePath: "/tmp/r2-ghost-backspace-ta.md",
      forceSurfaceImpl: "textarea" as const,
    }));
    const ta = document.querySelector("textarea.source-editor") as HTMLTextAreaElement | null;
    expect(ta, "textarea 路径必须渲染真实 textarea").toBeTruthy();
    /**
     * 修复的 effect 首行是 `if (sourceSurface.impl !== "cm6") return;`，
     * 所以捕获监听不该存在。判据：事件必须**继续冒泡到 window**
     *（我们的监听一旦接管就会 `stopPropagation()`）。
     */
    let bubbled = false;
    const onWin = () => { bubbled = true; };
    window.addEventListener("keydown", onWin);
    try {
      const e = new KeyboardEvent("keydown", {
        key: "Backspace", code: "Backspace", keyCode: 8, bubbles: true, cancelable: true,
      });
      ta!.dispatchEvent(e);
      expect(bubbled, "textarea 路径事件必须能继续冒泡（证明没有捕获阶段的 stopPropagation）").toBe(true);
    } finally {
      window.removeEventListener("keydown", onWin);
    }
  });
});
