/**
 * v0.15.0 F1 / v0.15.1 需求7：图片灯箱的**事件采集层**（双击采集 + 打开请求）。
 *
 * ## 相对 v0.11.0 B4-9 的变化（本次「收敛」的由来）
 *
 * 旧实现把「灯箱 DOM 创建 / 渲染 / 键盘 / 滚动锁」全部塞在这个插件里，且用
 * **模块级单例**（`currentImages` / `currentIndex` / `document.getElementById`）
 * 维护状态。后果：
 * - 缩放/平移/切图/无障碍没法用 React 组件表达，交互能力停在「能看大图」；
 * - 单例状态与「哪个 document」无关，右侧预览 iframe 里的图片完全无法接入；
 * - 遮罩关闭时无条件 `body.style.overflow = ""`，把用户原本的内联样式抹掉。
 *
 * 现在本文件只做三件事（设计 §2.2）：
 * 1. **双击采集**：在编辑器 / 预览 iframe 的 DOM 上监听 `dblclick`，命中可查看图片；
 * 2. **打开请求**：把「图片分组 + 索引 + 目标 document」以事件形式发出去；
 * 3. **状态查询**：导出 `closeLightbox` / `isLightboxOpen`，供容器在切文档 /
 *    切模式 / 卸载时**强制关闭**（契约不变，外部调用方无感）。
 *
 * ## v0.15.1 需求7 的两处语义变更
 *
 * | | v0.15.0 | v0.15.1 |
 * |---|---|---|
 * | 入口事件 | `click`（单击即开） | `dblclick`（双击才开，单击仍选中） |
 * | 生效闸门 | `editable === false`（只读标签） | `viewMode === "preview"`（阅读模式） |
 *
 * 闸门改动的原因见 `imageLightboxPlugin` 的表格：`editable` 只反映「只读标签」，
 * 与 viewMode 无关，导致普通文档在阅读模式下**根本打不开灯箱**。
 *
 * 渲染改由 `src/components/image/ImageLightbox.tsx`（React portal）负责，
 * 它订阅本模块的 `LIGHTBOX_OPEN_EVENT`。二者之间**只靠事件通信**，
 * 因此：
 * - 不产生模块级共享渲染状态（同窗口内多 document 各自独立，多窗口天然隔离）；
 * - 灯箱不进 PM 文档 → 不参与序列化、不影响撤销栈、不会被保存进文件。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useEditorStore } from "../../stores/useEditorStore";
import { buildImageGroup, toLightboxImage, type LightboxImage } from "../../utils/imageLightbox";

export const lightboxKey = new PluginKey("lightbox");

/** 请求打开灯箱（detail 见 `LightboxOpenDetail`），由 ImageLightbox 组件订阅 */
export const LIGHTBOX_OPEN_EVENT = "lightmd:lightbox-open";
/** 请求关闭灯箱（切文档 / 切模式 / 插件销毁 / 外部命令） */
export const LIGHTBOX_CLOSE_EVENT = "lightmd:lightbox-close";

/** 阅读模式里「可查看」的图片标记（schema.toDOM 与 ImageView 都写这一属性） */
export const LIGHTBOX_IMAGE_SELECTOR = "img[data-editable]";

/**
 * v0.15.1 需求7：灯箱入口事件 = **双击**（用户原话「灯箱这个功能入口请改为双击图片」）。
 *
 * 单击语义保持不变：阅读模式单击仍是「选中图片节点」（不打开灯箱），编辑模式单击
 * 仍是选中 + 四边拖拽缩放。因此采集层监听的事件类型从 v0.15.0 的 `click` 换成
 * `dblclick`；本常量是**唯一**的事件类型来源（采集层与测试都引用它，防止两处漂移）。
 */
export const LIGHTBOX_TRIGGER_EVENT = "dblclick";

/**
 * 灯箱自身的根选择器 —— 采集层必须**排除**它内部的任何事件。
 *
 * ## 为什么需要这层排除（v0.15.1 需求7 实测发现）
 *
 * 灯箱 portal 的目标文档可能是**预览 iframe 的 document.body**（`detail.doc`）。
 * 而 `bindPreviewLightbox` 恰好把监听绑在同一个 `iframe.contentDocument.body` 上，
 * 且是 **capture** 阶段 —— capture 沿「文档 → body → … → 目标」下行，
 * 灯箱作为 body 的后代，其内部双击**必然**被这个监听收到。
 *
 * 后果（若不排除）：在灯箱里双击图片做「fit ⇄ 100%」时，采集层会拿灯箱内的
 * `<img class="lightmd-lightbox-image">` 去 `collectLightboxGroup` 重新采集分组、
 * 重发打开请求 → 灯箱被重开一次：分组重算、缩放/平移复位、`onload` 重跑。
 * 用户看到的是「双击放大时画面闪一下并弹回适应窗口」。
 *
 * 排除判据用灯箱根节点 class（`ImageLightbox.css` 的 `.lightmd-lightbox`）：
 * 采集范围永远是**编辑器内容**，灯箱是浮层，两者在 DOM 上父子相邻但语义无关。
 */
export const LIGHTBOX_ROOT_SELECTOR = ".lightmd-lightbox";

/** 打开请求的载荷 */
export interface LightboxOpenDetail {
  /** 图片分组（当前 document / 文档 DOM 顺序） */
  images: LightboxImage[];
  /** 点中的图片在分组内索引 */
  index: number;
  /** 灯箱要挂到哪个 document 的 body（主文档 / 预览 iframe 的 ownerDocument） */
  doc: Document;
}

/**
 * 当前打开的灯箱所属 document（null = 未打开）。
 *
 * 只用于「是否已打开」的同步查询（插件销毁 / 容器切文档时强制关闭）；
 * 真正的渲染状态在 React 组件里。两个窗口各有自己的 JS 上下文 → 天然隔离。
 */
let activeDoc: Document | null = null;

/** 取节点所属 document（兼容主文档与 iframe 文档：跨 realm 不能用 instanceof Document） */
export function ownerDocumentOf(node: ParentNode): Document {
  const n = node as Node;
  if (n.nodeType === 9) return n as Document;
  return (n.ownerDocument ?? document) as Document;
}

/**
 * 从 DOM 采集切图分组（设计 §2.3「分组 = 当前文档 DOM 顺序」）。
 *
 * @param root 采集范围（编辑器 DOM / iframe document / 预览 body）
 * @param clicked 被点击的图片元素
 * @param selector 可查看图片的匹配式（PM 用 `img[data-editable]`，预览 HTML 用 `img`）
 * @returns 采集结果（纯数据，不含 DOM 引用；点中的元素不在集合内时 index=0）
 */
export function collectLightboxGroup(
  root: ParentNode,
  clicked: Element,
  selector: string = LIGHTBOX_IMAGE_SELECTOR,
): { images: LightboxImage[]; index: number } {
  let nodes: HTMLImageElement[];
  try {
    nodes = Array.from(root.querySelectorAll<HTMLImageElement>(selector));
  } catch {
    // 选择器非法 / root 已卸载：返回空分组（上层直接放弃打开）
    return { images: [], index: 0 };
  }
  const images = nodes.map((img) =>
    toLightboxImage({
      src: img.getAttribute("src"),
      currentSrc: img.currentSrc,
      alt: img.getAttribute("alt"),
      title: img.getAttribute("title"),
    }),
  );
  const hit = nodes.indexOf(clicked as HTMLImageElement);
  return buildImageGroup(images, hit >= 0 ? hit : 0);
}

/** 发出打开请求；返回是否成功（分组为空 → 不打开，返回 false） */
export function requestLightboxOpen(detail: LightboxOpenDetail): boolean {
  if (!detail || detail.images.length === 0) return false;
  const doc = detail.doc ?? document;
  activeDoc = doc;
  // 统一在**主窗口**广播：本模块的调用方（PM 插件、iframe 点击处理）都跑在主文档
  // realm；组件只订阅主窗口。目标 document 由 detail.doc 携带，组件据此 portal。
  window.dispatchEvent(
    new window.CustomEvent(LIGHTBOX_OPEN_EVENT, { detail: { ...detail, doc } }),
  );
  return true;
}

/** 强制关闭（切文档 / 切模式 / 组件卸载 / 插件销毁时调用；幂等） */
export function closeLightbox(): void {
  const doc = activeDoc;
  if (!doc) return;
  activeDoc = null;
  window.dispatchEvent(new window.CustomEvent(LIGHTBOX_CLOSE_EVENT));
}

/** 灯箱是否处于打开状态 */
export function isLightboxOpen(): boolean {
  return activeDoc !== null;
}

/**
 * 组件侧回写打开状态（由 ImageLightbox 在挂载/关闭时调用）。
 * 使 `isLightboxOpen()` 与真实渲染状态保持一致。
 */
export function markLightboxOpen(doc: Document | null): void {
  activeDoc = doc;
}

/** 双击绑定选项 */
export interface BindImageLightboxOptions {
  /** 可查看图片的匹配式（默认阅读模式标记 `img[data-editable]`） */
  selector?: string;
  /** 是否允许打开（默认允许；PM 侧传 `isReadOnlyViewMode` 实现「仅阅读模式」） */
  isEnabled?: () => boolean;
}

/** 已绑定清理函数（按 root 幂等重绑：先解旧再绑新，避免 previewHtml 重建时重复监听） */
const bindings = new WeakMap<object, () => void>();

/**
 * v0.15.1 需求7：**是否处于阅读模式**（灯箱唯一入口闸门）。
 *
 * 语义与 `useEditorStore.viewMode` 一致：`"preview"` = 阅读模式，`"edit"` = 编辑模式
 * （含右侧预览分屏）。为什么不用 `editable` 见 `imageLightboxPlugin` 的表格。
 *
 * 兜底：store 尚未初始化 / 取不到（单测直接 new EditorView、或 store 被重置）时
 * 返回 `false`，即「不打开灯箱」——宁可不开，也不要在编辑态误弹浮层挡住拖拽缩放。
 */
export function isReadOnlyViewMode(): boolean {
  try {
    return useEditorStore.getState().viewMode === "preview";
  } catch {
    return false;
  }
}

/**
 * 在 DOM 容器 / document 上绑定「**双击**图片 → 请求打开灯箱」。
 *
 * **幂等重绑**：同一个 root 反复调用只会保留最新一次绑定（预览 iframe 每次
 * 重写 `previewHtml` 后都会调用，监听器不会叠加）。返回解绑函数。
 *
 * 注意：`document.open()/write()/close()` 会清空该 document 上的监听器，
 * 因此**完整重写 iframe 后必须再调一次**（解旧 + 绑新正好覆盖这个场景）。
 *
 * ## 为什么仍用 capture 阶段
 *
 * capture 阶段在目标元素之前拿到事件，PM 的 `handleDOMEvents` / NodeView 的
 * `stopPropagation` 都拦不住它 —— 阅读模式下 PM 对图片节点有自己的选择逻辑，
 * 冒泡阶段监听可能被吃掉。capture + `closest("img")` 的组合让「点中图片内部
 * 任何位置（含 img 的伪元素区域）」都能命中。
 *
 * ## 为什么不再 `preventDefault()`
 *
 * v0.15.0 的 click 版本会 preventDefault（阻止默认的图片拖拽/选中）。改成 dblclick
 * 后**不能**再阻止默认行为：双击的第一下已经完成了「单击选中」，第二下的
 * preventDefault 也拦不回第一下的效果，反而会干扰 PM 的选区更新。
 */
export function bindImageLightbox(
  root: ParentNode,
  options: BindImageLightboxOptions = {},
): () => void {
  const selector = options.selector ?? LIGHTBOX_IMAGE_SELECTOR;
  const isEnabled = options.isEnabled ?? (() => true);
  // 先解掉同一 root 的旧绑定（幂等重绑）
  bindings.get(root as object)?.();

  const target = root as unknown as EventTarget;
  const handler = (e: Event) => {
    if (!isEnabled()) return;
    const node = e.target as Element | null;
    if (!node || typeof node.closest !== "function") return;
    // 灯箱浮层内部的双击一律忽略：它属于灯箱自己的「fit ⇄ 100%」手势，
    // 不是「打开灯箱」的入口（portal 可能就挂在本 root 的 document.body 上，
    // capture 监听会收到它 —— 详见 LIGHTBOX_ROOT_SELECTOR 注释）。
    if (node.closest(LIGHTBOX_ROOT_SELECTOR)) return;
    const img = node.closest("img") as HTMLImageElement | null;
    if (!img || !img.matches(selector)) return;
    const group = collectLightboxGroup(root, img, selector);
    if (group.images.length === 0) return;
    requestLightboxOpen({ ...group, doc: ownerDocumentOf(root) });
  };

  target.addEventListener(LIGHTBOX_TRIGGER_EVENT, handler, true);
  const cleanup = () => {
    target.removeEventListener(LIGHTBOX_TRIGGER_EVENT, handler, true);
    bindings.delete(root as object);
  };
  bindings.set(root as object, cleanup);
  return cleanup;
}

/**
 * 为**分屏预览 iframe** 绑定灯箱双击（设计 §2.3「事件绑在 iframe ownerDocument」）。
 *
 * v0.15.1 需求7：编辑模式的可见图片面就是这里（左侧源码 textarea 里图片只是
 * `![alt](src)` 文本，没有 `<img>` 元素；PM 面在编辑模式下 `display:none`）。
 * 因此编辑模式的灯箱入口 = 本函数 + 右侧 iframe 的 `dblclick`。
 *
 * 为什么必须每次 `previewHtml` 重建后重新调用：
 * - 预览 HTML 用 `document.open()/write()/close()` 整篇重写时，**该 document 上的
 *   所有监听器都会被清除**（HTML 规范的 open() 语义），不重绑就永远点不开；
 * - 增量更新（只换 `body.innerHTML`）会让旧 body 连同监听器一起丢弃，新 body 需要新绑定。
 *
 * 幂等性由 `bindImageLightbox` 的 WeakMap + 每次先解旧再绑保证：重复调用不会叠加监听。
 *
 * @returns 解绑函数（iframe 卸载 / 关闭预览时调用；绑定失败返回空函数）
 */
export function bindPreviewLightbox(iframe: HTMLIFrameElement | null): () => void {
  const doc = iframe?.contentDocument;
  const body = doc?.body;
  if (!doc || !body) return () => {};
  // 预览是 HTML 渲染结果，图片没有 data-editable 标记 → 用 img 选择器
  return bindImageLightbox(body, { selector: "img" });
}

/**
 * 图片灯箱插件。
 *
 * ## v0.15.1 需求7 修正：闸门从「只读」改为「阅读模式」
 *
 * 旧实现用 `editorView.props.editable?.(state) === false` 判定，但 `editable` 的
 * 唯一来源是 `EditorContainer` 的 `editableGetter` =
 * `() => !openTabs[activeTabIdx]?.isReadonly` —— **它只看「只读标签」标志，
 * 与 viewMode 无关**。而 PM 阅读面恰恰是 `viewMode === "preview"` 时才可见：
 *
 * | viewMode | PM 阅读面 | 源码 textarea | iframe 预览 | `editable` |
 * |---|---|---|---|---|
 * | `"preview"` | **可见** | 隐藏 | 隐藏 | `true`（普通文档） |
 * | `"edit"` | 隐藏 | 可见 | 取决于 `splitPreviewOpen` | `true` |
 *
 * 于是旧判据在普通文档上恒为 `false` → **阅读模式点击/双击图片根本不弹灯箱**。
 * 现在改为按 viewMode 判定：`viewMode === "preview"` 才允许。
 *
 * 为什么可以在插件里直接读 store：本插件跑在主文档 realm（与 React 同一 JS
 * 上下文），zustand 的 `getState()` 同步读快照，成本可忽略；插件无法订阅
 * React 状态，故每次事件时读取最新值（与 `auto-pair.ts` / `code-block.ts` 同法）。
 *
 * 编辑模式（`viewMode !== "preview"`）PM 面**不**弹灯箱：那时 PM 隐藏，
 * 可见的图片面只有右侧 iframe 预览（`bindPreviewLightbox` 负责），编辑态
 * PM 的图片交互是「单击选中 + 四边拖拽缩放」。
 *
 * 只读标签（`isReadonly`）在阅读模式下同样允许灯箱（只读时 PM 仍是
 * `editable === false`，双击更应只做查看）。
 */
export function imageLightboxPlugin(): Plugin {
  return new Plugin({
    key: lightboxKey,
    view(editorView: EditorView) {
      const unbind = bindImageLightbox(editorView.dom as HTMLElement, {
        isEnabled: isReadOnlyViewMode,
      });

      return {
        destroy() {
          unbind();
          if (isLightboxOpen()) closeLightbox();
        },
      };
    },
  });
}
