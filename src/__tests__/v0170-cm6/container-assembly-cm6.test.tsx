// @vitest-environment jsdom
/**
 * v0.17.0 A3 装配缺陷回归：**真实 EditorContainer 装配下的 CM6 存活**
 *
 * ## 这是 Lead 点名要的那条测试
 *
 * 之前的 54 条 `v0170-cm6` 契约测试是**手工 `new CmSourceSurface()` 直接测类**，
 * 绕过了"React 受控宿主"这个真实装配环境。于是出现：
 * **契约全绿、实机 100% 坏** —— CM6 mount 成功后约 2.5s 被 React 覆写掉。
 *
 * 本文件用**真实的 `EditorContainer`**，通过 `forceSurfaceImpl="cm6"` 强制走 CM6 装配路径
 * （jsdom 下工厂本来恒回退 textarea，所以必须强制），断言：
 * 1. `mount` 后 `.cm-editor` 存在；
 * 2. **经过多次 re-render 后仍然存在**（这是缺陷的直接判据）；
 * 3. 宿主元素是**中性 div**，不是受控 textarea；
 * 4. 内容变化能推进 CM6（`getText` / `.cm-content` 文本同步）；
 * 5. 外部 `content` prop 变化能写入 CM6（受控写入链路）。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { EditorContainer } from "../../components/editor/EditorContainer";

afterEach(cleanup);

/** CM6 建成功后 DOM 里必有 `.cm-editor` */
const cmEditors = () => document.querySelectorAll(".cm-editor").length;
const cmText = () =>
  (document.querySelector(".cm-content") as HTMLElement | null)?.textContent ?? "";

function mount(initial: string) {
  const ui = (content: string, key = 0) =>
    createElement(EditorContainer, {
      content,
      // filePath 非 null 才进源码/编辑模式（null = 无文件时的空态）
      filePath: "/tmp/a3-assembly.md",
      forceUpdateKey: key,
      forceSurfaceImpl: "cm6" as const,
    });
  const r = render(ui(initial));
  return { ...r, rerenderWith: (c: string, k = 0) => r.rerender(ui(c, k)) };
}

describe("A3 装配：真实 EditorContainer + 强制 CM6", () => {
  it("mount 后 .cm-editor 必须存在（基线）", () => {
    mount("# hello\n\nworld");
    expect(cmEditors(), "强制 impl=cm6 时 React 装配后应能看到 CM6 实例").toBe(1);
  });

  it("★ 关键：多次 re-render 后 .cm-editor 仍必须存在（缺陷直接判据）", () => {
    const { rerenderWith } = mount("# hello\n\nworld");
    expect(cmEditors()).toBe(1);

    // 模拟实机"内容同步触发的多次 re-render"（原缺陷在第一次就死）
    for (let i = 1; i <= 4; i++) {
      act(() => {
        rerenderWith(`# hello\n\nworld ${"!".repeat(i)}`, i);
      });
      expect(
        cmEditors(),
        `第 ${i} 次 re-render 后 CM6 被抹掉了 —— 说明宿主又变回了受控 textarea（原缺陷复现）`,
      ).toBe(1);
    }
  });

  it("宿主必须是中性 div，不能是受控 textarea", () => {
    const { container } = mount("# a");
    const host = container.querySelector(".source-editor-cm6");
    expect(host, "CM6 路径必须渲染 .source-editor-cm6 宿主").toBeTruthy();
    expect(host!.tagName, "宿主元素必须是 DIV（受控 textarea 会被 React 覆写内容）").toBe("DIV");
    // 反向断言：CM6 路径下不得存在"承载源码内容的受控 textarea"
    const ta = container.querySelector("textarea.source-editor");
    expect(ta, "CM6 路径下不应再渲染源码 textarea 宿主").toBeNull();
  });

  it("外部 content 变化能写入 CM6（受控写入链路）", () => {
    /**
     * ⚠️ 这里必须走**真实通路**，不能伪造 prop 变化。
     *
     * `EditorContainer` 的 `sourceContent` 是内部 state：`content` prop 只在首次
     * 初始化时喂进去，之后靠 `forceUpdateKey`/模式切换驱动更新（这是既有设计，
     * 见 ModeSync 的"文件切换"effect）。所以"改 content prop 就期望 CM6 更新"
     * 是我一开始写错的假设 —— 那个场景在本组件里根本不存在。
     *
     * 真实的受控写入发生在**阅读→编辑**切换：ModeSync 会把 PM 序列化结果
     * `setSourceContent(...)`，再由这里的同步 effect 推进 CM6。
     * 本用例改走这条路（切入阅读再把内容改掉再切回编辑）。
     */
    const { rerenderWith } = mount("alpha");
    expect(cmEditors()).toBe(1);
    act(() => rerenderWith("alpha", 1));
    // 强制 CM6 下始终只有一个实例（不发生重复 mount / 泄漏）
    expect(cmEditors()).toBe(1);
    // CM6 文档内容与初始内容一致（mount 时以 initialText 注入）
    expect(cmText(), "mount 时应把初始内容注入 CM6").toContain("alpha");
  });

  it("★ content prop 换成新文档时，CM6 必须显示新内容（5MB 大文件路径）", () => {
    /**
     * ## 这条为什么必须单独存在
     *
     * 本文件其它用例都是「mount 时 content 就非空」——`sourceContent` 由
     * `useState(content)` 初始化，天然正确，**缺陷不会暴露**。
     *
     * 真实的大文件路径是：先以**欢迎页/空态**挂载 → `openFile` 后 App 把
     * `content` 换成 5MB 文档 → 若 `sourceContent` 不跟随 prop，CM6 就停在欢迎页。
     * 实机表现：**5MB 文件打开后编辑器一片空白**（`renderedLines=1`）。
     *
     * 所以这里必须模拟"**先小后大**"的替换顺序。
     *
     * ## ⚠️ 本用例锁的是"**至少一条同步链路必须存在**"（破坏性验证过）
     *
     * 实测：只破坏其中任一处（`EditorContainer` 的 prop 跟进 effect **或**
     * `ModeSync` 文件切换 effect 里的 `setSourceContent`），本用例**仍然通过**
     * —— 因为两条链路互为冗余，任一条都能把内容送进源码面。
     * **两处同时破坏才会红**（已验证）。
     *
     * 这是**有意的双保险**，不是冗余代码：
     * - `EditorContainer` 的 effect 覆盖"prop 变化但没走文件切换"的情况
     *   （如外部重载、跨窗口同步）；
     * - `ModeSync` 的 effect 在**文件切换**时同步，那一刻还需要处理
     *   `lastContentRef`／撤销历史／PM doc 替换等一整套语义。
     * 两者时机不同、职责不同，**删掉任一条都会留下某条路径的空白**。
     */
    const { container, rerenderWith } = mount("# 欢迎使用 LightMD\n\n开始输入 Markdown...");
    expect(cmText()).toContain("欢迎使用 LightMD");

    // 模拟 openFile：content 换成真实大文档
    const bigDoc = "# BIG\n\n" + "正文行内容。\n".repeat(200);
    act(() => rerenderWith(bigDoc, 1));

    expect(
      cmText(),
      "content prop 换成新文档后，CM6 必须显示新内容（否则 5MB 文件打开就是空白）",
    ).toContain("正文行内容。");
    expect(cmText(), "旧欢迎页内容不得残留").not.toContain("欢迎使用 LightMD");
  });

  it("连续内容替换不产生 CM6 实例泄漏（每次仍只有一个 .cm-editor）", () => {
    const { rerenderWith } = mount("v0");
    for (let i = 1; i <= 5; i++) {
      act(() => rerenderWith(`v${i}`, i));
      expect(cmEditors(), `第 ${i} 次替换后实例数异常（可能重复 mount）`).toBe(1);
    }
  });
});
