// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { DecorationSet } from "prosemirror-view";
// mermaid 必须在导入被测模块前 mock,避免拉起真实渲染管线
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg>ok</svg>" })),
  },
}));
import { lightMDSchema } from "../core/schema";
import { focusModePlugin, focusModeKey } from "../core/plugins/focus-mode";

/** 创建 state 并启用专注模式 */
function createState(docContent: ReturnType<typeof lightMDSchema.nodes.paragraph.create>[]) {
  let state = EditorState.create({
    doc: lightMDSchema.nodes.doc.create(null, docContent),
    plugins: [focusModePlugin],
  });
  state = state.apply(state.tr.setMeta(focusModeKey, "enable"));
  return state;
}

function para(text: string) {
  return lightMDSchema.nodes.paragraph.create(null, lightMDSchema.text(text));
}

/** 收集 DecorationSet 中全部 focus-mode node 装饰的 [from, to] */
function decoRanges(set: DecorationSet): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  set.find().forEach((d) => {
    if ((d.spec as any)?.focusMark) out.push([d.from, d.to]);
  });
  return out;
}

describe("v0.9.5 E16-1 focus-mode 插件态缓存", () => {
  it("启用后为活跃块以外的块添加 focus-dimmed 装饰(行为不回归)", () => {
    const state = createState([para("first"), para("second"), para("third")]);
    const ps = focusModeKey.getState(state) as any;
    expect(ps.enabled).toBe(true);
    const ranges = decoRanges(ps.decos);
    // 光标默认在首段:3 个块中活跃块不装饰,祖先/兄弟关系下应有 2 个装饰
    expect(ranges.length).toBe(2);
  });

  it("doc 未变且活跃块未变时,纯 selection 移动复用同一 DecorationSet(零重算)", () => {
    let state = createState([para("abcdef"), para("second"), para("third")]);
    const before = focusModeKey.getState(state) as any;
    // 同块内光标从 pos 4 移到 pos 2(doc 未变)
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    const after = focusModeKey.getState(state) as any;
    expect(after).toBe(before);
  });

  it("跨块移动选区时重算:新活跃块不装饰,原活跃块被装饰", () => {
    let state = createState([para("first"), para("second"), para("third")]);
    const first = focusModeKey.getState(state) as any;
    // 移动到第三段(位置:3 + 5 +1 ... 直接选第三段内安全位置)
    const thirdStart = state.doc.content.size - "third".length - 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, thirdStart)));
    const moved = focusModeKey.getState(state) as any;
    expect(moved).not.toBe(first);
    const ranges = decoRanges(moved.decos);
    expect(ranges.length).toBe(2);
    // 第三段(活跃块)不应在装饰列表中
    const thirdFrom = thirdStart - 1;
    expect(ranges.some(([from]) => from === thirdFrom)).toBe(false);
  });

  it("大文档(content.size > 50000)只装饰活跃块附近,不做全文档装饰", () => {
    // 构造 2200 个约 25 字符的段落,content.size 远超 50000
    const blocks: ReturnType<typeof para>[] = [];
    for (let i = 0; i < 2200; i++) blocks.push(para(`段落${i}some filler text bytes`));
    const state = createState(blocks);
    expect(state.doc.content.size).toBeGreaterThan(50000);
    // 光标放到文档中部
    const mid = Math.floor(state.doc.content.size / 2);
    const midState = state.apply(state.tr.setSelection(TextSelection.create(state.doc, mid)));
    const ps = focusModeKey.getState(midState) as any;
    const ranges = decoRanges(ps.decos);
    // NEARBY_THRESHOLD = 30,装饰数应有上限(留少量余量给层级差异)
    expect(ranges.length).toBeLessThanOrEqual(40);
    expect(ranges.length).toBeGreaterThan(0);
    // 所有装饰距活跃块不超过 10000 + 余量
    for (const [from] of ranges) {
      expect(Math.abs(from - mid)).toBeLessThan(10100);
    }
  });

  it("禁用专注模式后装饰清空", () => {
    let state = createState([para("first"), para("second")]);
    state = state.apply(state.tr.setMeta(focusModeKey, "disable"));
    const ps = focusModeKey.getState(state) as any;
    expect(ps.enabled).toBe(false);
    expect(ps.decos).toBe(DecorationSet.empty);
  });
});

describe("v0.9.5 E16-2 mermaid 渲染缓存", () => {
  let MermaidBlockView: typeof import("../core/plugins/mermaid-block").MermaidBlockView;
  let renderMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("../core/plugins/mermaid-block");
    MermaidBlockView = mod.MermaidBlockView;
    const mermaid = (await import("mermaid")).default;
    renderMock = mermaid.render as unknown as ReturnType<typeof vi.fn>;
    renderMock.mockClear();
  });

  function mkView(code: string) {
    const node = lightMDSchema.nodes.mermaid_block.create(null, code ? [lightMDSchema.text(code)] : []);
    return new MermaidBlockView(
      node,
      { state: {} } as any,
      () => 0
    );
  }

  async function flush(times = 3) {
    for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it("内容未变的 update 不触发重新渲染", async () => {
    const v = mkView("graph TD; A-->B;");
    await flush();
    expect(renderMock).toHaveBeenCalledTimes(1);
    // 模拟一次无关事务触碰节点(node 内容未变)
    const sameNode = lightMDSchema.nodes.mermaid_block.create(null, [
      lightMDSchema.text("graph TD; A-->B;"),
    ]);
    (v as any).update(sameNode);
    await flush();
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("内容变化后 update 仍会重新渲染", async () => {
    const v = mkView("graph TD; A-->B;");
    await flush();
    const changed = lightMDSchema.nodes.mermaid_block.create(null, [
      lightMDSchema.text("graph LR; A-->B;"),
    ]);
    (v as any).update(changed);
    await flush();
    expect(renderMock).toHaveBeenCalledTimes(2);
  });
});
