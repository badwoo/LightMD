/**
 * @vitest-environment jsdom
 *
 * v0.15.0 F1：图片灯箱**事件采集层**测试（core/plugins/image-lightbox）。
 *
 * 覆盖设计 §2.3 的三条硬约束：
 * 1. 双击采集：命中可查看图片才发请求；分组按 DOM 顺序；点中项索引正确；
 *    （v0.15.1 需求7：入口由单击改为双击，单击不再打开灯箱 —— 见文件末尾新增用例）
 * 2. 幂等重绑：预览 iframe 每次重写 `previewHtml` 后必须重绑，监听**不得叠加**；
 * 3. 跨 document：iframe 内双击时 `detail.doc` 必须是 iframe 的 ownerDocument
 *    （组件据此 portal），且灯箱打开状态按文档记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LIGHTBOX_CLOSE_EVENT,
  LIGHTBOX_IMAGE_SELECTOR,
  LIGHTBOX_OPEN_EVENT,
  bindImageLightbox,
  closeLightbox,
  collectLightboxGroup,
  isLightboxOpen,
  markLightboxOpen,
  ownerDocumentOf,
  type LightboxOpenDetail,
} from "../core/plugins/image-lightbox";

/** 构造一张可查看图片（带 data-editable，模拟 PM/schema 输出） */
function makeImg(src: string, alt = "", editable = true): HTMLImageElement {
  const img = document.createElement("img");
  img.setAttribute("src", src);
  img.setAttribute("alt", alt);
  if (editable) img.setAttribute("data-editable", "true");
  return img;
}

/** 收集一次打开请求（返回撤销函数） */
function captureOpen(): { events: LightboxOpenDetail[]; stop: () => void } {
  const events: LightboxOpenDetail[] = [];
  const handler = (e: Event) => events.push((e as CustomEvent<LightboxOpenDetail>).detail);
  window.addEventListener(LIGHTBOX_OPEN_EVENT, handler);
  return { events, stop: () => window.removeEventListener(LIGHTBOX_OPEN_EVENT, handler) };
}

let cleanups: Array<() => void> = [];

beforeEach(() => {
  document.body.innerHTML = "";
  markLightboxOpen(null);
  cleanups = [];
});

afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  markLightboxOpen(null);
});

describe("F1 采集层：collectLightboxGroup", () => {
  it("按 DOM 顺序采集分组，并把点中项换算成索引", () => {
    const root = document.createElement("div");
    const a = makeImg("a.png", "甲");
    const b = makeImg("b.png", "乙");
    const c = makeImg("c.png", "丙");
    root.append(a, b, c);

    const group = collectLightboxGroup(root, b);
    expect(group.images.map((i) => i.src)).toEqual(["a.png", "b.png", "c.png"]);
    expect(group.images.map((i) => i.alt)).toEqual(["甲", "乙", "丙"]);
    expect(group.index).toBe(1);
  });

  it("只采集 selector 命中的图片（未标记 data-editable 的不参与）", () => {
    const root = document.createElement("div");
    root.append(makeImg("plain.png", "", false), makeImg("ok.png"));
    const group = collectLightboxGroup(root, root.querySelector("img[data-editable]")!);
    expect(group.images.map((i) => i.src)).toEqual(["ok.png"]);
    expect(group.index).toBe(0);
  });

  it("点中的图片不在范围内 → index 归 0（不产生越界）", () => {
    const root = document.createElement("div");
    root.append(makeImg("a.png"));
    const stranger = makeImg("x.png");
    expect(collectLightboxGroup(root, stranger).index).toBe(0);
  });

  it("非法的自定义 selector → 返回空分组（调用方据此放弃打开）", () => {
    const root = document.createElement("div");
    root.append(makeImg("a.png"));
    expect(collectLightboxGroup(root, makeImg("a.png"), "img[[").images).toEqual([]);
  });

  it("默认 selector 与 schema 的 data-editable 标记一致", () => {
    expect(LIGHTBOX_IMAGE_SELECTOR).toBe("img[data-editable]");
  });
});

describe("F1 采集层：bindImageLightbox 双击采集", () => {
  it("双击可查看图片 → 发出打开请求（含分组与索引）", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const imgs = [makeImg("a.png"), makeImg("b.png")];
    root.append(...imgs);
    cleanups.push(bindImageLightbox(root));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    imgs[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.images.map((i) => i.src)).toEqual(["a.png", "b.png"]);
    expect(cap.events[0]!.index).toBe(1);
    // 主文档内的双击 → doc 就是当前 document
    expect(cap.events[0]!.doc).toBe(document);
    expect(isLightboxOpen()).toBe(true);
  });

  it("双击非图片 / 未标记图片 → 不发请求", () => {
    const root = document.createElement("div");
    const plain = makeImg("plain.png", "", false);
    const p = document.createElement("p");
    p.textContent = "文本";
    root.append(plain, p);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    p.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    plain.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);
    expect(isLightboxOpen()).toBe(false);
  });

  it("被包裹的图片（span.image-node-wrapper）双击仍命中，且分组只算可查看图片", () => {
    const root = document.createElement("div");
    const wrap = document.createElement("span");
    const img = makeImg("a.png");
    wrap.appendChild(img);
    root.appendChild(wrap);
    root.appendChild(makeImg("b.png", "", false));
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));
    const cap = captureOpen();
    cleanups.push(cap.stop);

    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.images.map((i) => i.src)).toEqual(["a.png"]);
  });

  it("isEnabled=false 时不打开（PM 编辑模式的守卫）", () => {
    const root = document.createElement("div");
    const img = makeImg("a.png");
    root.appendChild(img);
    document.body.appendChild(root);
    let enabled = false;
    cleanups.push(bindImageLightbox(root, { isEnabled: () => enabled }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    enabled = true;
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
  });

  it("同一 root 重复绑定是幂等的（监听不叠加，只发一次请求）", () => {
    const root = document.createElement("div");
    const img = makeImg("a.png");
    root.appendChild(img);
    document.body.appendChild(root);

    // 模拟预览 iframe 每次重写 previewHtml 后都重绑（三次）
    cleanups.push(bindImageLightbox(root, { selector: "img" }));
    cleanups.push(bindImageLightbox(root, { selector: "img" }));
    cleanups.push(bindImageLightbox(root, { selector: "img" }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
  });

  it("解绑后不再触发；重复解绑不抛错", () => {
    const root = document.createElement("div");
    const img = makeImg("a.png");
    root.appendChild(img);
    document.body.appendChild(root);
    const unbind = bindImageLightbox(root);
    unbind();
    expect(() => unbind()).not.toThrow();

    const cap = captureOpen();
    cleanups.push(cap.stop);
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);
  });

  it("预览 HTML 场景：用 selector=\"img\" 采集全部图片（无 data-editable 标记）", () => {
    const root = document.createElement("div");
    const i1 = makeImg("a.png", "甲", false);
    const i2 = makeImg("b.png", "乙", false);
    root.append(i1, i2);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root, { selector: "img" }));

    const cap = captureOpen();
    cleanups.push(cap.stop);
    i2.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.images.map((i) => i.src)).toEqual(["a.png", "b.png"]);
    expect(cap.events[0]!.index).toBe(1);
  });
  it("预览 iframe：bindPreviewLightbox 绑定 iframe body，重绑幂等（预览重写后必调）", async () => {
    const { bindPreviewLightbox } = await import("../core/plugins/image-lightbox");
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    iframeDoc.body.innerHTML = '<img src="a.png"><img src="b.png">';

    const unbind1 = bindPreviewLightbox(iframe);
    // 模拟"预览重写后重绑"（完整重写会清掉 document 上所有监听，必须重绑）
    const unbind2 = bindPreviewLightbox(iframe);
    cleanups.push(unbind1, unbind2);

    const cap = captureOpen();
    cleanups.push(cap.stop);
    iframeDoc.querySelectorAll("img")[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    // 幂等：重绑不叠加，只发一次
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.images.map((i) => i.src)).toEqual(["a.png", "b.png"]);
    expect(cap.events[0]!.doc).toBe(iframeDoc);
  });

  it("bindPreviewLightbox：iframe 未就绪 / null 时返回空函数（不抛错）", async () => {
    const { bindPreviewLightbox } = await import("../core/plugins/image-lightbox");
    expect(() => bindPreviewLightbox(null)()).not.toThrow();
    const iframe = document.createElement("iframe");
    // 未挂载 → contentDocument 可能为 null
    expect(() => bindPreviewLightbox(iframe)()).not.toThrow();
  });
});

describe("F1 采集层：跨 document 与打开状态", () => {
  it("iframe 内双击 → detail.doc 是 iframe 的 ownerDocument", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    iframeDoc.body.innerHTML = '<img src="a.png" alt="甲"><img src="b.png" alt="乙">';
    const imgs = Array.from(iframeDoc.querySelectorAll("img"));
    cleanups.push(bindImageLightbox(iframeDoc.body, { selector: "img" }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    imgs[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.doc).toBe(iframeDoc);
    expect(cap.events[0]!.images).toHaveLength(2);
    // 打开状态按 document 记录（宿主切文档时据此强制关闭）
    expect(isLightboxOpen()).toBe(true);
  });

  it("ownerDocumentOf：document 与 iframe 文档都能正确识别（跨 realm 不用 instanceof）", () => {
    const div = document.createElement("div");
    expect(ownerDocumentOf(div)).toBe(document);
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    expect(ownerDocumentOf(iframe.contentDocument!).defaultView).toBe(iframe.contentWindow);
  });

  it("closeLightbox：未打开时幂等；打开后广播关闭事件并清标记", () => {
    expect(() => closeLightbox()).not.toThrow();

    const root = document.createElement("div");
    root.appendChild(makeImg("a.png"));
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));
    root.querySelector("img")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(isLightboxOpen()).toBe(true);

    const onClose = vi.fn();
    window.addEventListener(LIGHTBOX_CLOSE_EVENT, onClose);
    cleanups.push(() => window.removeEventListener(LIGHTBOX_CLOSE_EVENT, onClose));

    closeLightbox();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isLightboxOpen()).toBe(false);

    // 再次调用不再广播（幂等）
    closeLightbox();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// v0.15.1 需求7：入口改双击 + 闸门改 viewMode
// ═══════════════════════════════════════════════════════════════════
describe("v0.15.1 需求7：单击不打开、双击才打开", () => {
  it("单击图片**不**打开灯箱（单击语义保持为选中）", () => {
    const root = document.createElement("div");
    const img = makeImg("a.png");
    root.appendChild(img);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cap.events).toHaveLength(0);
    expect(isLightboxOpen()).toBe(false);

    // 连续单击多次（含 detail=2 这种"连击"click）仍不打开：
    // 只有真正的 dblclick 事件才算入口，click 序列一律不触发
    img.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    img.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 3 }));
    expect(cap.events).toHaveLength(0);
    expect(isLightboxOpen()).toBe(false);
  });

  it("双击图片 → 打开灯箱（且只发一次请求）", () => {
    const root = document.createElement("div");
    const imgs = [makeImg("a.png"), makeImg("b.png")];
    root.append(...imgs);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    imgs[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.index).toBe(1);
    expect(isLightboxOpen()).toBe(true);
  });

  it("双击分组索引正确：点第 N 张 → index = N-1，分组为全文 DOM 顺序", () => {
    const root = document.createElement("div");
    const imgs = [makeImg("a.png", "甲"), makeImg("b.png", "乙"), makeImg("c.png", "丙")];
    root.append(...imgs);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    imgs[2]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events[0]!.images.map((i) => i.src)).toEqual(["a.png", "b.png", "c.png"]);
    expect(cap.events[0]!.index).toBe(2);
  });

  it("预览面（selector=img）双击同样打开，单击不打开", () => {
    const root = document.createElement("div");
    const i1 = makeImg("a.png", "甲", false);
    const i2 = makeImg("b.png", "乙", false);
    root.append(i1, i2);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root, { selector: "img" }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    i1.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    i1.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.index).toBe(0);
  });

  it("LIGHTBOX_TRIGGER_EVENT 是唯一事件来源，且值为 dblclick", async () => {
    const mod = await import("../core/plugins/image-lightbox");
    expect(mod.LIGHTBOX_TRIGGER_EVENT).toBe("dblclick");
    // 采集层监听的事件类型必须来自该常量（改一处不漏另一处）
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    expect(src).toContain("addEventListener(LIGHTBOX_TRIGGER_EVENT");
    expect(src).toContain('export const LIGHTBOX_TRIGGER_EVENT = "dblclick"');
    // 旧 click 入口必须彻底消失（否则单击仍会打开）
    expect(src).not.toContain('addEventListener("click"');
  });
});

describe("v0.15.1 需求7：闸门按 viewMode（而非 editable）判定", () => {
  it("isReadOnlyViewMode：viewMode === 'preview' 才为 true", async () => {
    const { isReadOnlyViewMode } = await import("../core/plugins/image-lightbox");
    const { useEditorStore } = await import("../stores/useEditorStore");
    const prev = useEditorStore.getState().viewMode;

    useEditorStore.setState({ viewMode: "preview" });
    expect(isReadOnlyViewMode()).toBe(true);

    useEditorStore.setState({ viewMode: "edit" });
    expect(isReadOnlyViewMode()).toBe(false);

    useEditorStore.setState({ viewMode: prev });
  });

  it("阅读模式（viewMode=preview）双击 → 打开；编辑模式（viewMode=edit）双击 → 不打开", async () => {
    const { isReadOnlyViewMode } = await import("../core/plugins/image-lightbox");
    const { useEditorStore } = await import("../stores/useEditorStore");
    const prev = useEditorStore.getState().viewMode;

    const root = document.createElement("div");
    const img = makeImg("a.png");
    root.appendChild(img);
    document.body.appendChild(root);
    // 模拟 imageLightboxPlugin 的接线方式
    cleanups.push(bindImageLightbox(root, { isEnabled: isReadOnlyViewMode }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    useEditorStore.setState({ viewMode: "edit" });
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    useEditorStore.setState({ viewMode: "preview" });
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);

    useEditorStore.setState({ viewMode: prev });
  });

  it("源码里不再以 editable 作为灯箱闸门（旧判据必然打不开阅读模式）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/plugins/image-lightbox.ts", "utf-8");
    // 闸门必须是 viewMode 口径
    expect(src).toContain("isEnabled: isReadOnlyViewMode");
    expect(src).toContain('viewMode === "preview"');
    // 不得再用 editable 做闸门。注释里会引用旧判据作说明，故只查「代码形态」：
    // 旧实现的关键形态是 `const isReadonly = () => editorView.props.editable?.(
    expect(src).not.toMatch(/const\s+isReadonly\s*=/);
    expect(src).not.toMatch(/props\.editable\?\.\(\s*editorView\.state\s*\)\s*===/);
  });

  it("只读标签 × 模式矩阵：阅读模式弹、编辑模式不弹（闸门只看 viewMode）", async () => {
    const { isReadOnlyViewMode } = await import("../core/plugins/image-lightbox");
    const { useEditorStore } = await import("../stores/useEditorStore");
    const st = useEditorStore.getState();
    const prevMode = st.viewMode;
    const prevTabs = st.openTabs;
    const prevIdx = st.activeTabIdx;

    // 造一个「只读标签」（isReadonly = true）→ 旧 editable 判据此时为 false
    useEditorStore.setState({
      openTabs: [{ path: "/tmp/ro.md", name: "ro.md", isReadonly: true }],
      activeTabIdx: 0,
    });

    const root = document.createElement("div");
    const img = makeImg("a.png");
    root.appendChild(img);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root, { isEnabled: isReadOnlyViewMode }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    // 只读 + 编辑模式：不弹（PM 面此时不可见，编辑态不该有灯箱）
    useEditorStore.setState({ viewMode: "edit" });
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    // 只读 + 阅读模式：仍要能看大图（只读标签不该失去灯箱能力）
    useEditorStore.setState({ viewMode: "preview" });
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);

    useEditorStore.setState({ viewMode: prevMode, openTabs: prevTabs, activeTabIdx: prevIdx });
  });
});

describe("v0.15.1 需求7：灯箱浮层内部双击不重开灯箱", () => {
  it("LIGHTBOX_ROOT_SELECTOR 覆盖灯箱根 class", async () => {
    const mod = await import("../core/plugins/image-lightbox");
    expect(mod.LIGHTBOX_ROOT_SELECTOR).toBe(".lightmd-lightbox");
    // 与组件实际使用的 class 必须一致（改一处不漏另一处）
    const { readFileSync } = await import("node:fs");
    const tsx = readFileSync("src/components/image/ImageLightbox.tsx", "utf-8");
    expect(tsx).toContain('className="lightmd-lightbox"');
  });

  it("灯箱 portal 挂在 iframe body 上时，灯箱内双击**不**触发重开（capture 会收到）", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    iframeDoc.body.innerHTML = '<img src="a.png"><img src="b.png">';
    // 模拟 bindPreviewLightbox 的绑定方式：capture 在 iframe body 上
    cleanups.push(bindImageLightbox(iframeDoc.body, { selector: "img" }));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    // 模拟灯箱 portal 到 iframe body（组件 createPortal(overlay, doc.body)）
    const lightboxRoot = iframeDoc.createElement("div");
    lightboxRoot.className = "lightmd-lightbox";
    lightboxRoot.setAttribute("data-testid", "image-lightbox");
    const stage = iframeDoc.createElement("div");
    stage.className = "lightmd-lightbox-stage";
    const innerImg = iframeDoc.createElement("img");
    innerImg.className = "lightmd-lightbox-image";
    innerImg.setAttribute("src", "a.png");
    stage.appendChild(innerImg);
    lightboxRoot.appendChild(stage);
    iframeDoc.body.appendChild(lightboxRoot);

    // 灯箱内图片双击（= fit ⇄ 100% 手势）
    innerImg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    // 灯箱容器任意位置双击也不重开
    stage.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    lightboxRoot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    // 但灯箱**外部**（编辑器内容）的双击仍正常打开
    iframeDoc.querySelectorAll("img")[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.index).toBe(1);
  });

  it("主文档：灯箱内双击不重开，灯箱外双击正常打开", () => {
    const root = document.createElement("div");
    const imgs = [makeImg("a.png"), makeImg("b.png")];
    root.append(...imgs);
    document.body.appendChild(root);
    cleanups.push(bindImageLightbox(root));

    const cap = captureOpen();
    cleanups.push(cap.stop);

    // 灯箱作为 root 的后代（真实场景 portal 挂 body，而 root 可能是编辑器容器；
    // 这里刻意挂到 root 内部以证明"排除靠 class 而非层级"）
    const box = document.createElement("div");
    box.className = "lightmd-lightbox";
    const inner = document.createElement("img");
    inner.setAttribute("src", "a.png");
    box.appendChild(inner);
    root.appendChild(box);

    inner.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(0);

    imgs[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(cap.events).toHaveLength(1);
  });
});


