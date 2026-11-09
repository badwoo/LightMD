/**
 * v0.17.0 B1 —— DocStore 测试（懒构建 / revision 推进 / LRU / paragraphBreaks 失效）。
 *
 * 这个文件的三个关键断言，任何一个错了都会造成**性能或语义**事故：
 * 1. 编辑期**零解析**（`touchSource` 不构建 tree）—— 否则大文档输入延迟直接崩
 * 2. 同文本重复 set **不推进 revision** —— 否则下游缓存每次都全失效
 * 3. paragraphBreaks 切换**必须失效旧树** —— 否则"所见非所得"（设计稿复检第 7 条）
 */
import { describe, it, expect } from "vitest";
import { createDocStore, MAX_DOCS } from "../../core/unified/store";

describe("懒构建：编辑期零解析成本", () => {
  it("touchSource 只推 revision，不构建 tree（hasBuilt=false）", () => {
    const store = createDocStore();
    const rev = store.touchSource("doc1", "# h\n");
    expect(rev).toBe(0);
    expect(store.hasBuilt("doc1")).toBe(false); // 关键：没有解析
    // get 之后才构建
    const snap = store.get("doc1")!;
    expect(snap.tree).toHaveLength(1);
    expect(store.hasBuilt("doc1")).toBe(true);
  });

  it("连续 100 次 touchSource（模拟打字）不触发任何解析", () => {
    const store = createDocStore();
    let src = "# h\n";
    for (let i = 0; i < 100; i++) {
      src += `line ${i}\n`;
      store.touchSource("doc1", src);
    }
    expect(store.hasBuilt("doc1")).toBe(false);
    expect(store.revisionOf("doc1")).toBe(99); // 每次内容都变 → revision 递增
  });

  it("update（立即取值）会构建，但同一 revision 内重复 get 复用同一快照", () => {
    const store = createDocStore();
    const a = store.update("doc1", "# h\n");
    const b = store.get("doc1")!;
    expect(a.revision).toBe(b.revision);
    // tree 引用复用（出口适配层可安全持有引用做缓存）
    expect(a.tree).toBe(b.tree);
  });
});

describe("revision 推进规则", () => {
  it("同文本重复 set 不推进 revision（幂等）", () => {
    const store = createDocStore();
    store.update("doc1", "# h\n");
    const r1 = store.update("doc1", "# h\n").revision;
    const r2 = store.update("doc1", "# h\n").revision;
    expect(r1).toBe(0);
    expect(r2).toBe(0); // 关键：没变就不涨
  });

  it("内容变化 → revision++", () => {
    const store = createDocStore();
    store.update("doc1", "# a\n");
    expect(store.update("doc1", "# b\n").revision).toBe(1);
    expect(store.update("doc1", "# c\n").revision).toBe(2);
  });

  it("切换 paragraphBreaks → revision++（语义变了，下游缓存必须失效）", () => {
    const store = createDocStore();
    store.update("doc1", "a\nb\n", { paragraphBreaks: "gfm" });
    const after = store.update("doc1", "a\nb\n", { paragraphBreaks: "commonmark" });
    expect(after.revision).toBe(1); // 内容没变但语义变了 → 仍要推进
  });
});

describe("paragraphBreaks 必须改变解析结果（设计稿复检第 7 条）", () => {
  const src = "line1\nline2\n";

  it("gfm：裸换行 = softbreak 节点；commonmark：裸换行被解析成空格文本（无 break 节点）", () => {
    // ⚠️ 实测校准（第一版我以为两种模式下 token 流相同、只有渲染才分派 —— 错的）：
    // `getMarkdownIt(breaks=false)` 是**独立实例**（breaks:false），
    // markdown-it 的 breaks 选项在**解析期**就把 softbreak 处理成空格 token，
    // 故两种模式下 inline 里是否出现 softbreak 节点本身就是可观测差异。
    const store = createDocStore();
    const gfm = store.update("doc1", src, { paragraphBreaks: "gfm" });
    const kindsGfm = (gfm.tree[0]!.inline || []).map((n) => n.kind);

    const cm = store.update("doc1", src, { paragraphBreaks: "commonmark" });
    const kindsCm = (cm.tree[0]!.inline || []).map((n) => n.kind);

    expect(kindsGfm).toContain("softbreak");
    expect(kindsCm).not.toContain("softbreak");
    expect(kindsCm.join(",")).not.toBe(kindsGfm.join(","));
  });

  it("切换后拿到的是**新语义**的树（不是缓存里的旧树）", () => {
    const store = createDocStore();
    const first = store.update("doc1", src, { paragraphBreaks: "gfm" });
    const second = store.update("doc1", src, { paragraphBreaks: "commonmark" });
    // 两个快照必须是不同对象、不同 tree
    expect(second.revision).not.toBe(first.revision);
    expect(second.tree).not.toBe(first.tree);
  });
});

describe("LRU：上限 40，最久未用先淘汰", () => {
  it("MAX_DOCS 与 docHistoryStore 口径一致（都是 40）", () => {
    expect(MAX_DOCS).toBe(40);
  });

  it("超过上限时淘汰最久未访问的条目", () => {
    const store = createDocStore(3);
    store.touchSource("a", "# a\n");
    store.touchSource("b", "# b\n");
    store.touchSource("c", "# c\n");
    expect(store.size()).toBe(3);
    // 访问 a（a 变成最近使用）
    store.get("a");
    // 再插 d → 应淘汰最久未用的 b
    store.touchSource("d", "# d\n");
    expect(store.size()).toBe(3);
    expect(store.keys().sort()).toEqual(["a", "c", "d"]);
  });

  it("命中即新（get 会刷新 LRU 顺序）", () => {
    const store = createDocStore(2);
    store.touchSource("a", "# a\n");
    store.touchSource("b", "# b\n");
    store.get("a");
    store.touchSource("c", "# c\n");
    // a 刚被访问 → 淘汰 b
    expect(store.keys().sort()).toEqual(["a", "c"]);
  });

  it("delete / clear 正常", () => {
    const store = createDocStore();
    store.touchSource("a", "# a\n");
    expect(store.delete("a")).toBe(true);
    expect(store.get("a")).toBeNull();
    store.touchSource("b", "# b\n");
    store.clear();
    expect(store.size()).toBe(0);
  });
});

describe("快照形态：出口需要的派生数据一次给全", () => {
  it("快照带 unknownTokens / headings / raw（出口不必再 parse）", () => {
    const store = createDocStore();
    const snap = store.update("doc1", "# one\n\n[toc]\n");
    expect(snap.headings.length).toBeGreaterThanOrEqual(1);
    expect(snap.unknownTokens).toEqual([]);
    expect(snap.raw.trailingBlankLines).toBe(0);
    // [toc] 节点能拿到 headings
    const toc = snap.tree.find((n) => n.kind === "toc");
    expect(toc).toBeDefined();
    expect((toc!.attrs.headings as unknown[]).length).toBe(snap.headings.length);
  });

  it("尾部空行数正确（保真用：末尾 N 个空行要写回 N 个）", () => {
    const store = createDocStore();
    expect(store.update("d1", "a\n").raw.trailingBlankLines).toBe(0);
    expect(store.update("d2", "a\n\n").raw.trailingBlankLines).toBe(1);
    expect(store.update("d3", "a\n\n\n").raw.trailingBlankLines).toBe(2);
  });
});

describe("多文档隔离：不同 docKey 互不影响", () => {
  it("各自独立的 revision 与 tree", () => {
    const store = createDocStore();
    store.update("a", "# A\n");
    store.update("b", "# B\n");
    expect(store.revisionOf("a")).toBe(0);
    expect(store.revisionOf("b")).toBe(0);
    expect(store.get("a")!.tree[0]!.inline![0]!.text).toBe("A");
    expect(store.get("b")!.tree[0]!.inline![0]!.text).toBe("B");
    store.update("a", "# A2\n");
    expect(store.revisionOf("a")).toBe(1);
    expect(store.revisionOf("b")).toBe(0); // b 不受影响
  });
});
