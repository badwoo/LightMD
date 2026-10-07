/**
 * v0.11.0 B4-9 返修回归测试：阅读模式图片点击的接管判定。
 *
 * 缺陷背景：`core/plugins/image-lightbox.ts` 把灯箱监听挂在 `.ProseMirror` 的
 * **冒泡**阶段，而 `EditorContainer` 的图片监听注册在容器的**捕获**阶段并会
 * `preventDefault` + `stopPropagation`。捕获先于冒泡执行，一旦只读标签仍然接管，
 * 事件会被截断 → 挂在 .ProseMirror 上的灯箱监听永远收不到 → **灯箱打不开**
 * （表现为只读标签点图片仍弹「编辑图片」对话框，B4-9 形同虚设）。
 *
 * 判定本身抽成了纯函数 `shouldOpenImageEditor`，本文件锁定它的真值表；
 * 事件阶段（捕获/冒泡）的先后关系由浏览器规范保证，无需也无法在单测里复现。
 */
import { describe, it, expect } from "vitest";
import { shouldOpenImageEditor } from "../components/editor/EditorContainer";

function fakeImg(dataEditable: string | null) {
  return {
    getAttribute(name: string) {
      return name === "data-editable" ? dataEditable : null;
    },
  };
}

describe("v0.11.0 B4-9 返修：shouldOpenImageEditor", () => {
  it("可编辑标签 + 可编辑图片 → 由编辑对话框接管（行为不变）", () => {
    expect(shouldOpenImageEditor(fakeImg("true"), false)).toBe(true);
  });

  it("【核心】只读标签 + 可编辑图片 → **不**接管，放行给图片灯箱", () => {
    expect(shouldOpenImageEditor(fakeImg("true"), true)).toBe(false);
  });

  it("非可编辑图片（无 data-editable 标记）→ 两种标签都不接管", () => {
    expect(shouldOpenImageEditor(fakeImg(null), false)).toBe(false);
    expect(shouldOpenImageEditor(fakeImg(null), true)).toBe(false);
    expect(shouldOpenImageEditor(fakeImg("false"), false)).toBe(false);
    expect(shouldOpenImageEditor(fakeImg("false"), true)).toBe(false);
  });
});
