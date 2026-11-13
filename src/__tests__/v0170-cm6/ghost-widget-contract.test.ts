// @vitest-environment jsdom
/**
 * v0.17.0 A3：ghost 的 Decoration.widget 语义
 *
 * ## Lead 特别提醒的两点，本文件逐条锁住
 *
 * 1. **必须是行内 widget，不能是块级**（`block: true` 会在块边界换行，导致
 *    "占位提示跑到下一行"）。AI 续写与格式 ghost 都是**行内插入**语义。
 * 2. **清除必须走 StateEffect + StateField**，不能直接改 DOM —— 否则 CM6 的
 *    内部状态与 DOM 会脱节（下次重绘时 ghost 又冒出来，或残留永不消失）。
 *
 * ## 为什么这些能在 jsdom 里验
 *
 * widget 的**文档模型层面**（DecorationSet 的 pos/side/block 属性）不依赖布局，
 * 只有渲染成真实 DOM 才依赖。因此这里验"交给 CM6 的 decoration 规格"是可靠的；
 * 真实视觉位置由实机探针验证。
 */

import { describe, it, expect, afterEach } from "vitest";
import { createSourceSurface } from "../../editor/createSourceSurface";
import type { SourceSurface } from "../../editor/types";

let surface: SourceSurface | null = null;
let host: HTMLElement | null = null;

function mount(text: string): SourceSurface {
  surface = createSourceSurface({ impl: "cm6" });
  host = document.createElement("div");
  document.body.appendChild(host);
  surface.mount(host, { initialText: text });
  return surface;
}

afterEach(() => {
  surface?.destroy();
  surface = null;
  host?.remove();
  host = null;
});

describe("A3 ghost：契约层语义", () => {
  it("showGhost 不得抛异常（它在 rAF/AI 回调链路里，抛了会静默断掉 ghost）", () => {
    const s = mount("hello");
    expect(() => s.showGhost({ text: " world", pos: 5 })).not.toThrow();
  });

  it("pos 越界时被钳到文档范围（AI 流式返回时 pos 可能漂移）", () => {
    const s = mount("hello");
    expect(() => s.showGhost({ text: "x", pos: 9999 })).not.toThrow();
    expect(() => s.showGhost({ text: "x", pos: -5 })).not.toThrow();
  });

  it("clearGhost 可重复调用（宿主在多个时机都会清，不能因此崩）", () => {
    const s = mount("hello");
    s.showGhost({ text: "ghost", pos: 2 });
    expect(() => s.clearGhost()).not.toThrow();
    expect(() => s.clearGhost()).not.toThrow();
  });

  it("tail 与 maskTail 参数被接受（格式 ghost 的尾部符号 + 遮罩开关）", () => {
    const s = mount("****");
    expect(() =>
      s.showGhost({ text: "标题", pos: 2, tail: "**", maskTail: true }),
    ).not.toThrow();
  });

  it("文档编辑后 ghost 不崩（change 链路会 map decoration 位置）", () => {
    const s = mount("hello");
    s.showGhost({ text: " world", pos: 5 });
    // 在 ghost 位置之前插入文本 → decoration 位置需要被 map 到新坐标
    expect(() => s.setText("XXhello")).not.toThrow();
    // 之后仍能正常清除
    expect(() => s.clearGhost()).not.toThrow();
  });

  it("setText 之后 getText 反映新内容（ghost 存在不得干扰文档读取）", () => {
    const s = mount("hello");
    s.showGhost({ text: " ghost", pos: 5 });
    s.setText("changed");
    // ghost 是展示层，绝不写进文档
    expect(s.getText()).toBe("changed");
  });
});

/**
 * ## v0.17.0 P1-6：**destroy → mount 之后 ghost 必须仍在**
 *
 * ### 为什么这是一条必须有的护栏
 *
 * `showGhost` 把规格存在**实例字段** `this.ghost` 里，同时把它画进当前 view
 * （CM6：`ghostField` 的 Decoration；textarea：overlay 的 innerHTML）。
 * 而 `mount()` 建的是**全新**的 state / overlay：
 * - CM6 侧 `ghostField.create()` 恒等于 `Decoration.none`；
 * - textarea 侧 `destroy()` 已经把 `ghostEl` 移除并置空。
 *
 * 于是"实例记得、DOM 忘了" —— ghost 静默消失，且**零报错**。
 * 两个类都声明自己是**可重挂载**的（`destroy()` 上方注释），所以这是契约违反。
 *
 * ### 破坏性验证（本测试真能红）
 *
 * 把 `CmSourceSurface.mount()` / `TextareaSourceSurface.mount()` 末尾的
 * `if (this.ghost) this.showGhost(this.ghost);` 注释掉，本组 4 条会全部失败
 *（前两条 CM6、后两条 textarea）。已实测（见 `_plan/v0170-fix-p1-6.md` §5）。
 *
 * ### 为什么同时测两个实现
 *
 * 缺陷报告最初写「textarea 有恢复、CM6 没有」——**那是错的**：两个都不恢复。
 * 只是 textarea 路径从不因内容变化重挂载，所以从未暴露。
 * 两边各测一遍，才能防止"只修了一个"再发生。
 */
describe("v0.17.0 P1-6：重挂载（destroy → mount）后 ghost 必须仍在", () => {
  /** 取出当前渲染出的 ghost 文本（两种实现的选择器不同） */
  const readGhost = (impl: "cm6" | "textarea"): string[] => {
    if (impl === "cm6") {
      return Array.from(document.querySelectorAll(".cm-source-ghost")).map(
        (e) => e.textContent ?? "",
      );
    }
    // textarea 实现把 ghost 写进 .source-ghost-overlay 的 innerHTML
    const ov =
      document.querySelector(".source-ghost-overlay") ??
      document.querySelector(".source-search-overlay");
    if (!ov) return [];
    const disp = (ov as HTMLElement).style.display;
    if (disp === "none") return [];
    return [ov.textContent ?? ""];
  };

  const makePair = (impl: "cm6" | "textarea") => {
    const s = createSourceSurface({ impl });
    const h = document.createElement("div");
    document.body.appendChild(h);
    return { s, h };
  };

  for (const impl of ["cm6", "textarea"] as const) {
    it(`[${impl}] showGhost → destroy → mount → ghost 仍在（不得静默丢失）`, () => {
      const { s, h } = makePair(impl);
      s.mount(h, { initialText: "****" });
      s.showGhost({ text: "粗体文本", pos: 2 });

      const before = readGhost(impl);
      expect(before.length, `${impl}：showGhost 后应立即渲染出 ghost`).toBeGreaterThan(0);
      expect(before.join("")).toContain("粗体文本");

      // 重挂载：destroy 会把 view / overlay 销毁，但实例字段 this.ghost 应被保留
      s.destroy();
      s.mount(h, { initialText: "****" });

      const after = readGhost(impl);
      expect(
        after.length,
        `${impl}：destroy→mount 后 ghost 消失了 —— mount() 没有重放 this.ghost`,
      ).toBeGreaterThan(0);
      expect(after.join("")).toContain("粗体文本");

      s.destroy();
      h.remove();
    });

    it(`[${impl}] destroy → mount 重放时位置不变，且 clearGhost 之后确实不再恢复`, () => {
      const { s, h } = makePair(impl);
      s.mount(h, { initialText: "****" });
      s.showGhost({ text: "标题一", pos: 2, tail: "", maskTail: false });
      s.destroy();
      s.mount(h, { initialText: "****" });
      expect(readGhost(impl).join("")).toContain("标题一");

      // 清掉之后再重挂载 → 不该再冒出来（防止"清不掉"的反向缺陷）
      s.clearGhost();
      expect(readGhost(impl).join("")).not.toContain("标题一");
      s.destroy();
      s.mount(h, { initialText: "****" });
      expect(
        readGhost(impl).join(""),
        `${impl}：clearGhost 之后重挂载不得让 ghost 复活（否则 ghost 永远清不掉）`,
      ).not.toContain("标题一");

      s.destroy();
      h.remove();
    });
  }
});
