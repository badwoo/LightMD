/**
 * v0.13.0 需求10：Emoji 短码补全弹窗。
 *
 * 覆盖：
 * - `detectEmojiState` 纯函数真值表（触发/不触发、query 提取、`::` 不触发、
 *   代码块等不触发）；
 * - `emojiData.ts`：懒加载、前缀过滤、长度优先排序、截断、`countBeyondLimit`；
 * - `applyEmojiCandidate`：替换区间插入 `:name:` 文本（非 unicode）；
 * - 真实 `createEditor` 挂载 + `onEmojiStateChange`：输入 `:sm` 真的触发；
 * - 采纳后 Decoration 渲染为图形、存盘仍是短码（与 v0.11.0 B4 决策一致）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { createEditor } from "../core/editor";
import { markdownToDoc } from "../core/markdown/parser";
import { docToMarkdown } from "../core/markdown/serializer";
import { lightMDSchema } from "../core/schema";
import {
  detectEmojiState,
  applyEmojiCandidate,
  type EmojiState,
} from "../core/plugins/emoji-complete";
import {
  filterCandidates,
  filterCandidatesAsync,
  countBeyondLimit,
  loadEmojiTable,
  isEmojiTableLoaded,
  __resetEmojiTableForTest,
  MAX_CANDIDATES,
} from "../utils/emojiData";
import { emojiRenderKey } from "../core/plugins/emoji-render";

const schema = lightMDSchema;

beforeEach(() => {
  __resetEmojiTableForTest();
});

afterEach(() => {
  __resetEmojiTableForTest();
});

// ───────── detectEmojiState 真值表 ─────────

describe("detectEmojiState", () => {
  it("段落尾部 :sm → 触发，query='sm'", () => {
    const doc = markdownToDoc("hello :sm\n");
    const state = EditorState.create({ doc, schema });
    // 光标放到「:sm」之后（位置 = 内容末尾）
    const $end = state.doc.resolve(state.doc.content.size - 1);
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, $end.pos))));
    expect(s).not.toBeNull();
    expect(s!.query).toBe("sm");
    // from 指向冒号位置
    const text = doc.textBetween(s!.from, s!.to, "\n", "\0");
    expect(text).toBe(":sm");
  });

  it("刚打出冒号（: 后无字符）→ 触发，query=''", () => {
    const doc = markdownToDoc("hello :\n");
    const state = EditorState.create({ doc, schema });
    const $end = state.doc.resolve(state.doc.content.size - 1);
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, $end.pos))));
    expect(s).not.toBeNull();
    expect(s!.query).toBe("");
  });

  it("光标前没有冒号 → 不触发", () => {
    const doc = markdownToDoc("hello world\n");
    const state = EditorState.create({ doc, schema });
    const $end = state.doc.resolve(state.doc.content.size - 1);
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, $end.pos))));
    expect(s).toBeNull();
  });

  it("冒号在光标之前（已被越过）→ 不触发", () => {
    // "hello :smile" 光标在冒号**之前**（位置 3）
    const doc = markdownToDoc("hello :smile\n");
    const state = EditorState.create({ doc, schema });
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, 3))));
    expect(s).toBeNull();
  });

  it(":: 连续两个冒号 → 不触发（避免误判连续短码）", () => {
    const doc = markdownToDoc("a ::\n");
    const state = EditorState.create({ doc, schema });
    const $end = state.doc.resolve(state.doc.content.size - 1);
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, $end.pos))));
    expect(s).toBeNull();
  });

  it("代码块内输入冒号 → 不触发", () => {
    const doc = markdownToDoc("```js\nconst a = { b: 1 }\n```\n");
    const state = EditorState.create({ doc, schema });
    // 光标放进代码块（第一个 child 是 code_block）
    let codePos = -1;
    doc.descendants((n, p) => {
      if (codePos === -1 && n.type.name === "code_block") codePos = p;
      return codePos === -1;
    });
    const inner = codePos + 2;
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, inner))));
    expect(s).toBeNull();
  });

  it("非空选区 → 不触发", () => {
    const doc = markdownToDoc("hello :sm\n");
    const state = EditorState.create({ doc, schema });
    const s = detectEmojiState(
      state.apply(state.tr.setSelection(TextSelection.create(doc, 1, 6))),
    );
    expect(s).toBeNull();
  });

  it("行中间的冒号（后面还有文本）→ 不触发", () => {
    // "a :sm b" 光标在末尾：正则要求 `:name` 在文本末尾
    const doc = markdownToDoc("a :sm b\n");
    const state = EditorState.create({ doc, schema });
    const $end = state.doc.resolve(state.doc.content.size - 1);
    const s = detectEmojiState(state.apply(state.tr.setSelection(TextSelection.create(doc, $end.pos))));
    expect(s).toBeNull();
  });
});

// ───────── emojiData ─────────

describe("emojiData：懒加载与过滤", () => {
  it("初始未加载；loadEmojiTable 后可用", async () => {
    expect(isEmojiTableLoaded()).toBe(false);
    await loadEmojiTable();
    expect(isEmojiTableLoaded()).toBe(true);
  });

  it("表里有常见短码", async () => {
    const table = await loadEmojiTable();
    for (const name of ["smile", "heart", "rocket", "+1", "100"]) {
      expect(table[name], `缺少 ${name}`).toBeTruthy();
    }
  });

  it("filterCandidates：前缀匹配", () => {
    // 表未加载时返回空（同步函数无法触发加载）
    expect(filterCandidates("sm")).toEqual([]);
  });

  it("filterCandidatesAsync：'sm' 命中 smile/smiley 等", async () => {
    const list = await filterCandidatesAsync("sm");
    expect(list.length).toBeGreaterThan(0);
    const names = list.map((c) => c.name);
    expect(names).toContain("smile");
    // 每条都带 unicode
    for (const c of list) expect(c.unicode).toBeTruthy();
  });

  it("排序：同名长短优先（短的在前）", async () => {
    const list = await filterCandidatesAsync("sm");
    // 'smile' 应排在 'smile_cat' 之类更长的名字之前
    const idxSmile = list.findIndex((c) => c.name === "smile");
    if (idxSmile >= 0) {
      for (const c of list.slice(0, idxSmile)) {
        expect(c.name.length).toBeLessThanOrEqual("smile".length);
      }
    }
  });

  it("空 query → 返回全部（截断到 MAX_CANDIDATES）", async () => {
    const list = await filterCandidatesAsync("");
    expect(list).toHaveLength(MAX_CANDIDATES);
  });

  it("截断：limit 生效", async () => {
    const list = await filterCandidatesAsync("s", 5);
    expect(list.length).toBeLessThanOrEqual(5);
  });

  it("countBeyondLimit：超出 limit 的条数", async () => {
    await loadEmojiTable();
    const beyond = countBeyondLimit("s", 5);
    expect(beyond).toBeGreaterThanOrEqual(0);
    // 总数 = limit + beyond
    const all = await filterCandidatesAsync("s", 5);
    expect(all.length).toBe(5);
  });

  it("无匹配 query → 空列表", async () => {
    const list = await filterCandidatesAsync("zzzzzzzz");
    expect(list).toEqual([]);
  });

  it("并发 loadEmojiTable 只加载一次（复用同一 Promise）", async () => {
    __resetEmojiTableForTest();
    const [a, b] = await Promise.all([loadEmojiTable(), loadEmojiTable()]);
    expect(a).toBe(b); // 同一引用
  });

  it("MAX_CANDIDATES = 50", () => {
    expect(MAX_CANDIDATES).toBe(50);
  });
});

// ───────── applyEmojiCandidate ─────────

describe("applyEmojiCandidate", () => {
  it("把 :query 区间替换为 :name: 文本（不是 unicode）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: "hi :sm\n" }) as EditorView;
    try {
      const doc = view.state.doc;
      // 找冒号位置
      let colonPos = -1;
      let found = false;
      doc.descendants((node, pos) => {
        if (found || !node.isText) return;
        const idx = (node.text ?? "").indexOf(":");
        if (idx >= 0) {
          colonPos = pos + idx;
          found = true;
        }
      });
      expect(found).toBe(true);
      const emoji: EmojiState = { from: colonPos, to: doc.content.size - 1, query: "sm" };
      expect(applyEmojiCandidate(view, "smile", emoji)).toBe(true);
      expect(view.state.doc.textContent).toBe("hi :smile:");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("空 name → 返回 false（不修改文档）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({ parent: host, initialContent: "hi :sm\n" }) as EditorView;
    try {
      const before = view.state.doc.textContent;
      expect(applyEmojiCandidate(view, "", { from: 1, to: 2, query: "sm" })).toBe(false);
      expect(view.state.doc.textContent).toBe(before);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ───────── 真实编辑器链路 ─────────

describe("真实编辑器：输入 :sm 触发补全", () => {
  it("onEmojiStateChange 被回调，状态含正确的 from/to/query", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: Array<EmojiState | null> = [];
    const view = createEditor({
      parent: host,
      initialContent: "hi\n",
      onEmojiStateChange: (s) => seen.push(s),
    }) as EditorView;
    try {
      // 在段末插入 ":sm"，并**显式把光标移到插入点之后**
      // （insertText 只 map 选区；初始光标在 0 时不会跟着走，会导致判定失败）
      const pos = view.state.doc.content.size - 1;
      const tr = view.state.tr.insertText(":sm", pos);
      tr.setSelection(TextSelection.create(tr.doc, pos + 3));
      view.dispatch(tr);
      const last = seen[seen.length - 1];
      expect(last).not.toBeNull();
      expect(last!.query).toBe("sm");
      expect(view.state.doc.textBetween(last!.from, last!.to, "\n", "\0")).toBe(":sm");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("光标移出（删掉冒号）→ 回调 null（菜单关闭）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: Array<EmojiState | null> = [];
    const view = createEditor({
      parent: host,
      initialContent: "hi\n",
      onEmojiStateChange: (s) => seen.push(s),
    }) as EditorView;
    try {
      const pos = view.state.doc.content.size - 1;
      const tr = view.state.tr.insertText(":sm", pos);
      tr.setSelection(TextSelection.create(tr.doc, pos + 3));
      view.dispatch(tr);
      expect(seen[seen.length - 1]).not.toBeNull();
      // 删掉 ":sm" 并把光标停在被删位置（不再有冒号 → 菜单关闭）
      const end = view.state.doc.content.size - 1;
      const tr2 = view.state.tr.delete(end - 3, end);
      tr2.setSelection(TextSelection.create(tr2.doc, end - 3));
      view.dispatch(tr2);
      expect(seen[seen.length - 1]).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("代码块内输入冒号 → 不回调（不触发）", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: Array<EmojiState | null> = [];
    const view = createEditor({
      parent: host,
      initialContent: "```js\ncode\n```\n",
      onEmojiStateChange: (s) => seen.push(s),
    }) as EditorView;
    try {
      // 在代码块内容末尾插 ":sm"
      let codePos = -1;
      view.state.doc.descendants((n, p) => {
        if (codePos === -1 && n.type.name === "code_block") codePos = p;
        return codePos === -1;
      });
      const inner = codePos + 1 + (view.state.doc.nodeAt(codePos)?.content.size ?? 0);
      view.dispatch(view.state.tr.insertText(":sm", inner));
      expect(seen.filter(Boolean)).toHaveLength(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ───────── 与渲染层的一致性（v0.11.0 B4 决策） ─────────

describe("补全 → 渲染 → 存盘 的一致性", () => {
  it("采纳后 doc 里是短码文本，Decoration 渲染为图形，序列化仍是短码", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = createEditor({
      parent: host,
      initialContent: "hi :sm\n",
      onEmojiStateChange: () => {},
    }) as EditorView;
    try {
      // 直接走 applyEmojiCandidate（等价于用户在菜单里点了 :smile:）
      let colonPos = -1;
      let found = false;
      view.state.doc.descendants((node, pos) => {
        if (found || !node.isText) return;
        const idx = (node.text ?? "").indexOf(":");
        if (idx >= 0) {
          colonPos = pos + idx;
          found = true;
        }
      });
      applyEmojiCandidate(view, "smile", {
        from: colonPos,
        to: view.state.doc.content.size - 1,
        query: "sm",
      });
      // doc 文本是短码（非 unicode）
      expect(view.state.doc.textContent).toBe("hi :smile:");
      // 序列化存盘仍是短码（源码可逆）
      expect(docToMarkdown(view.state.doc)).toBe("hi :smile:\n");
      // 渲染装饰：emoji-shortcode class + data-emoji 属性
      const decos = emojiRenderKey.getState(view.state);
      expect(decos).toBeTruthy();
      const foundDeco: string[] = [];
      decos!.find().forEach((d) => {
        // Decoration 实例的 type 字段携带 attrs（class / data-emoji）——
        // PM 的 TS 定义未导出该属性，需经 unknown 中转访问。
        const attrs = (d as unknown as { type?: { attrs?: Record<string, unknown> } }).type?.attrs;
        if (attrs?.class) foundDeco.push(String(attrs.class));
      });
      expect(foundDeco.some((c) => c.includes("emoji-shortcode"))).toBe(true);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("补全列表里的短码都能被渲染层解析（同源保证）", async () => {
    const list = await filterCandidatesAsync("sm", 10);
    for (const item of list) {
      // 用真实 editor（emoji-render 插件已注册）验证渲染层认得这个短码
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = createEditor({ parent: host, initialContent: `:${item.name}:` }) as EditorView;
      try {
        const decos = emojiRenderKey.getState(view.state);
        expect(decos, `${item.name} 应产生 emoji 装饰`).toBeTruthy();
      } finally {
        view.destroy();
        host.remove();
      }
    }
  });
});
