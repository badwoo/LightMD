// @vitest-environment jsdom
/**
 * v0.13.1 需求16：选中文本右键菜单的剪贴板四件套
 * （剪切 / 复制 / 粘贴 / 粘贴为纯文本），且置于菜单**最上面一栏**。
 *
 * 覆盖两层：
 * ① 纯函数层 `buildPmMenuItems` / `buildMenuItems` 的**顺序与项集合**（两个菜单必须同款）；
 * ② 执行层 `utils/textClipboardOps.ts` 的**行为**：
 *    - 复制把选区的 text/html + text/plain 写进系统剪贴板；
 *    - 剪切**先写成功再删除**（写失败时原文必须原封不动，绝不能净丢内容）；
 *    - "粘贴为纯文本"按行构造段落、**不做任何 Markdown 解析**（`# 标题` 必须保持字面）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { lightMDSchema as schema } from "../core/schema";
import { markdownToDoc } from "../core/markdown/parser";
import {
  buildPlainTextSlice,
  serializeSelection,
  copySelection,
  cutSelection,
  pastePlainIntoView,
  pasteIntoView,
  hasCopyableSelection,
} from "../utils/textClipboardOps";
import { buildPmMenuItems } from "../components/editor/PmContextMenu";
import { buildMenuItems } from "../components/editor/EditorContextMenu";

// ─── 测试替身：可编程的系统剪贴板 ───────────────────────────

interface FakeClipboard {
  writes: Array<Array<{ types: string[]; blobs: Record<string, string> }>>;
  written: string | null;
  readText: string | null;
  failWrite: boolean;
  failWriteText: boolean;
  writeCalls: number;
  writeTextCalls: number;
}

function installFakeClipboard(): FakeClipboard {
  const fake: FakeClipboard = {
    writes: [],
    written: null,
    readText: null,
    failWrite: false,
    failWriteText: false,
    writeCalls: 0,
    writeTextCalls: 0,
  };
  // 用最小可用的 ClipboardItem 替身（jsdom 不实现它）
  class FakeClipboardItem {
    types: string[];
    private map: Record<string, Blob>;
    constructor(map: Record<string, Blob>) {
      this.map = map;
      this.types = Object.keys(map);
    }
    async getType(t: string): Promise<Blob> {
      return this.map[t]!;
    }
  }
  (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = FakeClipboardItem;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: unknown[]) => {
        fake.writeCalls++;
        if (fake.failWrite) throw new Error("denied");
        const recorded: Array<{ types: string[]; blobs: Record<string, string> }> = [];
        for (const it of items) {
          const item = it as FakeClipboardItem;
          const blobs: Record<string, string> = {};
          for (const t of item.types) blobs[t] = await (await item.getType(t)).text();
          recorded.push({ types: item.types, blobs });
        }
        fake.writes.push(recorded);
      },
      writeText: async (text: string) => {
        fake.writeTextCalls++;
        if (fake.failWriteText) throw new Error("denied");
        fake.written = text;
      },
      readText: async () => fake.readText,
    },
  });
  return fake;
}

/** 造一个真实 ProseMirror 视图（stub dispatch 应用事务，等价于真编辑器状态演算） */
function makeView(
  md: string,
  from: number,
  to: number,
): { view: EditorView; get: () => EditorState } {
  const doc = markdownToDoc(md);
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: import("prosemirror-state").Transaction) => {
      state = state.apply(tr);
    },
    focus: () => {},
    // serializeForClipboard 是 PM 的公开 API；这里给出与 PM 一致形态的最小实现
    serializeForClipboard: (slice: {
      content: {
        size: number;
        textBetween: (a: number, b: number, s: string) => string;
      };
    }) => {
      const text = slice.content.textBetween(0, slice.content.size, "\n");
      const dom = document.createElement("div");
      dom.innerHTML = `<p>${text}</p>`;
      return { dom, text };
    },
  } as unknown as EditorView;
  return { view, get: () => state };
}

let clip: FakeClipboard;
beforeEach(() => {
  clip = installFakeClipboard();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════ ① 菜单结构：四件套置顶、两个菜单同款 ═════════

describe("v0.13.1 需求16：剪贴板四件套置于菜单最上面一栏", () => {
  it("阅读模式（PM）菜单：前四项就是 cut/copy/paste/pastePlain", () => {
    const items = buildPmMenuItems({
      hasSelection: true,
      nodeKind: null,
      isMdFile: true,
      translateEnabled: true,
    });
    expect(items.slice(0, 4).map((i) => i.action)).toEqual([
      "cut",
      "copy",
      "paste",
      "pastePlain",
    ]);
    // 第 5 项必须是分隔线，把剪贴板组与行内格式组分开
    expect(items[4]?.type).toBe("separator");
  });

  it("阅读模式菜单：无选区时不出现剪贴板项（四件套依赖文本选区）", () => {
    const items = buildPmMenuItems({
      hasSelection: false,
      nodeKind: null,
      isMdFile: true,
      translateEnabled: true,
    });
    const actions = items.map((i) => i.action);
    expect(actions).not.toContain("pastePlain");
    expect(actions).not.toContain("cut");
  });

  it("阅读模式菜单：剪切/复制随选区可复制性禁用，粘贴恒可用", () => {
    const items = buildPmMenuItems({
      hasSelection: true,
      nodeKind: null,
      isMdFile: true,
      translateEnabled: true,
      hasTextClipboard: false,
    });
    expect(items.find((i) => i.action === "cut")?.disabled).toBe(true);
    expect(items.find((i) => i.action === "copy")?.disabled).toBe(true);
    expect(items.find((i) => i.action === "paste")?.disabled).toBeFalsy();
    expect(items.find((i) => i.action === "pastePlain")?.disabled).toBeFalsy();
  });

  it("源码模式（textarea）菜单：四件套同样置顶，且含 pastePlain", () => {
    const actions = buildMenuItems(true, true, true)
      .filter((i) => i.type === "item")
      .map((i) => i.action);
    expect(actions.slice(0, 4)).toEqual(["cut", "copy", "paste", "pastePlain"]);
    // 撤销/恢复被排到剪贴板组之后
    expect(actions.indexOf("undo")).toBeGreaterThan(actions.indexOf("pastePlain"));
  });

  it("两个菜单的四件套 action 名一致（避免调用方分发分叉）", () => {
    const pm = buildPmMenuItems({
      hasSelection: true,
      nodeKind: null,
      isMdFile: true,
      translateEnabled: true,
    })
      .filter((i) => i.type === "item")
      .map((i) => i.action);
    const plain = buildMenuItems(true, true, true)
      .filter((i) => i.type === "item")
      .map((i) => i.action);
    for (const a of ["cut", "copy", "paste", "pastePlain"]) {
      expect(pm).toContain(a);
      expect(plain).toContain(a);
    }
  });
});

// ═════════ ② 执行层行为 ═════════

describe("v0.13.1 需求16：复制 / 剪切 的剪贴板写入", () => {
  it("serializeSelection 产出 text + html 两份格式；选区为空时返回 null", () => {
    const { view } = makeView("hello world", 1, 6);
    const payload = serializeSelection(view);
    expect(payload).toBeTruthy();
    expect(payload!.text).toContain("hello");
    expect(payload!.html).toContain("hello");

    const empty = makeView("hi", 2, 2);
    expect(serializeSelection(empty.view)).toBeNull();
  });

  it("copySelection 一次写入 text/plain 与 text/html", async () => {
    const { view } = makeView("hello world", 1, 6);
    const ok = await copySelection(view);
    expect(ok).toBe(true);
    expect(clip.writeCalls).toBe(1);
    const [batch] = clip.writes;
    expect(batch).toHaveLength(1);
    expect(batch[0].types.sort()).toEqual(["text/html", "text/plain"]);
    expect(batch[0].blobs["text/plain"]).toContain("hello");
  });

  it("ClipboardItem 不可用时退回 writeText（不能完全失效）", async () => {
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = undefined;
    const { view } = makeView("hello world", 1, 6);
    const ok = await copySelection(view);
    expect(ok).toBe(true);
    expect(clip.writeTextCalls).toBe(1);
    expect(clip.written).toContain("hello");
  });

  it("剪贴板完全不可用 → 返回 false（调用方要 toast，不静默）", async () => {
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = undefined;
    clip.failWriteText = true;
    const { view } = makeView("hello world", 1, 6);
    expect(await copySelection(view)).toBe(false);
  });

  it("cutSelection 写成功后才删除选区（一次事务）", async () => {
    const { view, get } = makeView("hello world", 1, 6);
    const before = get().doc.textContent;
    const ok = await cutSelection(view);
    expect(ok).toBe(true);
    expect(get().doc.textContent).not.toBe(before);
    expect(get().doc.textContent).not.toContain("hello");
    expect(clip.writes.length).toBe(1);
  });

  it("cutSelection 写盘失败时**原文必须原封不动**（先写后删的数据安全红线）", async () => {
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = undefined;
    clip.failWriteText = true;
    const { view, get } = makeView("hello world", 1, 6);
    const before = get().doc.textContent;
    const ok = await cutSelection(view);
    expect(ok).toBe(false);
    expect(get().doc.textContent).toBe(before);
  });

  it("hasCopyableSelection 只读编辑器选区，不碰系统剪贴板", () => {
    const { view } = makeView("hello", 1, 3);
    expect(hasCopyableSelection(view)).toBe(true);
    const empty = makeView("hello", 2, 2);
    expect(hasCopyableSelection(empty.view)).toBe(false);
    expect(hasCopyableSelection(null)).toBe(false);
    // 全程没有发生任何剪贴板读（readText 从未被调用 → readText 是纯函数替身，
    // 这里用写入次数 0 作为"零 IO"的可观测证据）
    expect(clip.writeCalls).toBe(0);
    expect(clip.writeTextCalls).toBe(0);
  });
});

describe("v0.13.1 需求16：粘贴为纯文本不做 Markdown 解析", () => {
  it("buildPlainTextSlice 把多行文本按行拆成段落，open=0", () => {
    const slice = buildPlainTextSlice(schema, "# 标题\n- 列表项");
    expect(slice).toBeTruthy();
    expect(slice!.openStart).toBe(0);
    expect(slice!.content.childCount).toBe(2);
    expect(slice!.content.child(0).type.name).toBe("paragraph");
    expect(slice!.content.child(0).textContent).toBe("# 标题");
  });

  it("单行文本 open=1（与光标段落行内合并）", () => {
    const slice = buildPlainTextSlice(schema, "纯文本");
    expect(slice!.openStart).toBe(1);
    expect(slice!.openEnd).toBe(1);
  });

  it("空文本返回 null（不产生空操作事务）", () => {
    expect(buildPlainTextSlice(schema, "")).toBeNull();
  });

  it("CRLF 与 CR 都按换行处理", () => {
    const slice = buildPlainTextSlice(schema, "a\r\nb\rc");
    expect(slice!.content.childCount).toBe(3);
  });

  it("pastePlainIntoView：`# 标题` 落进文档后仍是**普通段落字面文本**，不是 heading", async () => {
    clip.readText = "# 标题";
    const { view, get } = makeView("原文", 1, 1);
    const ok = await pastePlainIntoView(view);
    expect(ok).toBe(true);
    const doc = get().doc;
    let hasHeading = false;
    let literals = "";
    doc.descendants((n) => {
      if (n.type.name === "heading") hasHeading = true;
      if (n.isText) literals += n.text;
    });
    expect(hasHeading).toBe(false);
    expect(literals).toContain("# 标题");
  });

  it("pasteIntoView 走 view.pasteText（与 Ctrl+V 同一条插件链）", async () => {
    clip.readText = "abc";
    const pasteText = vi.fn(() => true);
    const { view } = makeView("原文", 1, 1);
    (view as unknown as { pasteText: typeof pasteText }).pasteText = pasteText;
    const ok = await pasteIntoView(view);
    expect(ok).toBe(true);
    expect(pasteText).toHaveBeenCalledWith("abc");
  });

  it("剪贴板为空/不可读时两条粘贴都返回 false（不产生空事务）", async () => {
    clip.readText = null;
    const { view } = makeView("原文", 1, 1);
    expect(await pasteIntoView(view)).toBe(false);
    expect(await pastePlainIntoView(view)).toBe(false);
  });
});
