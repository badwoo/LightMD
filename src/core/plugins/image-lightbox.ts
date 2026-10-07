/**
 * v0.11.0 B4-9：阅读模式图片灯箱（点击放大 / 遮罩关闭 / 键盘导航）。
 *
 * 缺陷背景（P2 · 体验缺失）：
 *   schema 的 image.toDOM 已输出 `data-editable="true"` 标记，注释写明
 *   「供阅读模式注入点击监听（G3）」，但**全仓无任何点击监听实现**
 *   → 阅读模式点小图无反应，用户只能拖窗口边缘或靠浏览器缩放看图细节。
 *   这是纯图像文档（截图、扫描件）的高频痛点。
 *
 * 实现要点（全部为**渲染层**行为，不改 doc、不改序列化）：
 * - 监听编辑器 DOM 的 click，命中 `img[data-editable]` 时打开灯箱；
 * - 灯箱是**插件自建的独立 DOM**（挂 body），不进 PM 文档 → 不参与序列化、
 *   不影响撤销栈、不会被保存进文件；
 * - 关闭：点遮罩 / 点关闭按钮 / `Esc` / 方向键切换前后图（同类分组）。
 *
 * 为什么不用 NodeView：灯箱是覆盖整个视口的浮层，与文档内容无关，
 * 挂 body 更简单可靠（不受 PM 选区/滚动容器影响）。
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export const lightboxKey = new PluginKey("lightbox");

/** 灯箱的 DOM 容器 id（幂等锚点） */
const BOX_ID = "lightmd-lightbox";
/** 打开时记录原滚动位置，关闭后还原 */
let savedScrollY = 0;
/** 当前灯箱内的图片列表与索引（支持前后切换） */
let currentImages: HTMLImageElement[] = [];
let currentIndex = 0;

/** 灯箱样式（inline 注入，避免新增 CSS 文件引入顺序问题） */
const STYLE_TEXT = `
#${BOX_ID} {
  position: fixed; inset: 0; z-index: 99999;
  background: rgba(0, 0, 0, 0.88);
  display: none; align-items: center; justify-content: center;
  flex-direction: column;
}
#${BOX_ID}.lightbox-open { display: flex; }
#${BOX_ID} .lightbox-img {
  max-width: 92vw; max-height: 84vh;
  object-fit: contain; cursor: zoom-out;
  user-select: none; -webkit-user-drag: none;
}
#${BOX_ID} .lightbox-close {
  position: absolute; top: 16px; right: 20px;
  font-size: 32px; line-height: 1; color: #fff;
  background: transparent; border: none; cursor: pointer;
  padding: 8px 12px; border-radius: 4px; opacity: 0.75;
}
#${BOX_ID} .lightbox-close:hover { opacity: 1; background: rgba(255,255,255,0.12); }
#${BOX_ID} .lightbox-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  font-size: 40px; color: #fff; background: rgba(255,255,255,0.1);
  border: none; cursor: pointer; padding: 16px 20px; border-radius: 6px;
}
#${BOX_ID} .lightbox-nav:hover { background: rgba(255,255,255,0.2); }
#${BOX_ID} .lightbox-prev { left: 18px; }
#${BOX_ID} .lightbox-next { right: 18px; }
#${BOX_ID} .lightbox-caption {
  margin-top: 12px; color: #ddd; font-size: 13px; text-align: center;
  max-width: 80vw; word-break: break-all;
}
#${BOX_ID} .lightbox-counter { color: #999; font-size: 12px; margin-top: 4px; }
`;

/** 注入样式（幂等） */
function ensureStyle(): void {
  if (document.getElementById(`${BOX_ID}-style`)) return;
  const style = document.createElement("style");
  style.id = `${BOX_ID}-style`;
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
}

/** 创建（或复用）灯箱 DOM */
function ensureBox(): HTMLElement | null {
  ensureStyle();
  let box = document.getElementById(BOX_ID) as HTMLElement | null;
  if (box) return box;
  box = document.createElement("div");
  box.id = BOX_ID;
  box.innerHTML = `
    <button class="lightbox-close" aria-label="关闭">&times;</button>
    <button class="lightbox-nav lightbox-prev" aria-label="上一张">&#8249;</button>
    <img class="lightbox-img" alt="" />
    <button class="lightbox-nav lightbox-next" aria-label="下一张">&#8250;</button>
    <div class="lightbox-caption"></div>
    <div class="lightbox-counter"></div>
  `;
  document.body.appendChild(box);

  // 事件绑定（只绑一次，元素复用）
  box.querySelector(".lightbox-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  box.querySelector(".lightbox-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showImage(currentIndex - 1);
  });
  box.querySelector(".lightbox-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showImage(currentIndex + 1);
  });
  // 点遮罩（空白处）关闭
  box.addEventListener("click", (e) => {
    if (e.target === box) closeLightbox();
  });
  // 图片本身点击关闭
  box.querySelector(".lightbox-img")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  return box;
}

/** 渲染指定索引的图片 */
function showImage(index: number): void {
  const box = ensureBox();
  if (!box) return;
  if (currentImages.length === 0) return closeLightbox();
  // 循环切换
  currentIndex = ((index % currentImages.length) + currentImages.length) % currentImages.length;
  const srcImg = currentImages[currentIndex]!;
  const img = box.querySelector(".lightbox-img") as HTMLImageElement;
  img.src = srcImg.currentSrc || srcImg.src;
  img.alt = srcImg.alt || "";
  const caption = box.querySelector(".lightbox-caption") as HTMLElement;
  caption.textContent = srcImg.alt || srcImg.title || "";
  const counter = box.querySelector(".lightbox-counter") as HTMLElement;
  counter.textContent =
    currentImages.length > 1 ? `${currentIndex + 1} / ${currentImages.length}` : "";
  // 多图时显示前后导航
  const navVisible = currentImages.length > 1;
  box.querySelectorAll<HTMLElement>(".lightbox-nav").forEach((el) => {
    el.style.display = navVisible ? "block" : "none";
  });
}

/** 打开灯箱到指定图片 */
function openLightbox(img: HTMLImageElement, group: HTMLImageElement[]): void {
  const box = ensureBox();
  if (!box) return;
  currentImages = group.length > 0 ? group : [img];
  savedScrollY = window.scrollY;
  // 锁滚动（灯箱期间背景不滚）
  document.body.style.overflow = "hidden";
  box.classList.add("lightbox-open");
  const idx = currentImages.indexOf(img);
  showImage(idx >= 0 ? idx : 0);
}

/** 关闭灯箱并还原滚动 */
export function closeLightbox(): void {
  const box = document.getElementById(BOX_ID);
  if (!box) return;
  box.classList.remove("lightbox-open");
  document.body.style.overflow = "";
  currentImages = [];
  currentIndex = 0;
  if (savedScrollY) window.scrollTo(0, savedScrollY);
}

/** 灯箱是否处于打开状态 */
export function isLightboxOpen(): boolean {
  return document.getElementById(BOX_ID)?.classList.contains("lightbox-open") ?? false;
}

/** 从编辑器 DOM 收集所有可点击图片（作为切换分组） */
function collectImages(root: HTMLElement): HTMLImageElement[] {
  return Array.from(
    root.querySelectorAll<HTMLImageElement>("img[data-editable]"),
  );
}

/** 键盘处理：Esc 关闭、方向键切换 */
function onKeydown(e: KeyboardEvent): void {
  if (!isLightboxOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeLightbox();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    showImage(currentIndex - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    showImage(currentIndex + 1);
  }
}

/**
 * 图片灯箱插件。
 *
 * 只在**阅读模式**生效（`editable === false`）：编辑模式下点击图片是选中/拖拽
 * 图片节点的行为，不应弹灯箱。
 */
export function imageLightboxPlugin(): Plugin {
  return new Plugin({
    key: lightboxKey,
    view(editorView: EditorView) {
      // 键盘监听挂在 document 上（灯箱是 body 级浮层）
      document.addEventListener("keydown", onKeydown);

      const onClick = (e: MouseEvent) => {
        // 编辑模式不弹灯箱（点击图片是选中节点）
        if (editorView.props.editable?.(editorView.state) !== false) return;
        const target = e.target as HTMLElement | null;
        if (!target || target.tagName !== "IMG") return;
        if (!target.matches("img[data-editable]")) return;
        e.preventDefault();
        const group = collectImages(editorView.dom as HTMLElement);
        openLightbox(target as HTMLImageElement, group);
      };

      editorView.dom.addEventListener("click", onClick);

      return {
        destroy() {
          editorView.dom.removeEventListener("click", onClick);
          document.removeEventListener("keydown", onKeydown);
          // 插件销毁时若灯箱仍开着，务必清理（否则浮层残留遮住界面）
          if (isLightboxOpen()) closeLightbox();
        },
      };
    },
  });
}
