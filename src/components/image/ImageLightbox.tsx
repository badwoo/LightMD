/**
 * v0.15.0 F1：图片灯箱（覆盖应用视口的缩放 / 平移 / 切换查看）。
 *
 * ## 与旧实现（v0.11.0 B4-9 插件内单例 DOM）的差别
 *
 * | | 旧 | 新 |
 * |---|---|---|
 * | 渲染 | 插件里手搓 DOM + 模块级单例 | React 组件 + portal，状态即组件状态 |
 * | 缩放/平移 | 无 | 滚轮/按钮/双击缩放、拖拽平移、边界钳制 |
 * | 挂载目标 | 恒为 `document.body` | **所属 document**：主文档 / 预览 iframe 的 ownerDocument |
 * | 滚动锁 | 关闭时无条件清空 overflow | 保存原值、关闭时按原值还原（含滚动位置） |
 * | 无障碍 | 仅按钮标题 | portal 级 focus trap + `aria-modal` + 键盘全覆盖 |
 *
 * ## 为什么 portal 到「所属 document」
 *
 * 右侧分屏预览是 iframe：它的图片属于 iframe 文档，若灯箱挂到主文档 body，
 * 覆盖区只盖住主窗口的坐标体系、且无法与 iframe 的图片共用层叠上下文。
 * 设计 §2.2 因此要求「按 window 隔离（React state + portal）」。组件接收打开
 * 事件，载荷里带 `doc`，`createPortal(children, doc.body)` 即完成隔离：
 * 多窗口各自有独立 JS 上下文，天然互不干扰。
 *
 * ## 事件契约（与 core/plugins/image-lightbox 解耦，仅事件通信）
 *
 * - 打开：`lightmd:lightbox-open`，detail = `LightboxOpenDetail`
 * - 关闭请求：`lightmd:lightbox-close`
 * - 状态回写：`markLightboxOpen(doc | null)`，供容器判断「是否需要强制关闭」
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import {
  LIGHTBOX_CLOSE_EVENT,
  LIGHTBOX_OPEN_EVENT,
  markLightboxOpen,
  type LightboxOpenDetail,
} from "../../core/plugins/image-lightbox";
import {
  DOUBLE_CLICK_MS,
  DOUBLE_CLICK_PX,
  MAX_SCALE,
  MIN_SCALE,
  WHEEL_ZOOM_FACTOR,
  ZOOM_STEP,
  canPan,
  clampViewOffsets,
  createLightboxState,
  fitView,
  goToImage,
  isDoubleClick,
  nextImage,
  panBy,
  prevImage,
  resetView,
  scalePercent,
  toggleActualSize,
  zoomAt,
  type LightboxMetrics,
  type LightboxState,
  type Size,
} from "../../utils/imageLightbox";
import "./ImageLightbox.css";
// 灯箱可能 portal 到**预览 iframe 的 document**，而 Vite 的样式表只注入主文档 head。
// 因此这里拿一份 CSS 文本，打开时幂等注入目标文档（主文档已有样式表 → 跳过）。
import lightboxCssText from "./ImageLightbox.css?inline";

/** 注入样式用的 <style> id（按文档幂等） */
const STYLE_ID = "lightmd-lightbox-style";

/** 拖拽判定的最小位移（px）：小于此值视为点击，避免误拖 */
const DRAG_THRESHOLD_PX = 3;
// 双击判定的时间窗 / 位移窗：**与灯箱入口（采集层 / NodeView）共用同一口径**，
// 常量定义在 utils/imageLightbox（纯函数模块），此处只做别名，避免两处数值漂移。
const DOUBLE_CLICK_WINDOW_MS = DOUBLE_CLICK_MS;
const DOUBLE_CLICK_WINDOW_PX = DOUBLE_CLICK_PX;
/** 可聚焦控件选择器（focus trap 用） */
const FOCUSABLE_SELECTOR = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** 显示区留白（与 ImageLightbox.css 的 padding 一致，避免 fit 后仍被裁边） */
const STAGE_PAD_X = 80;
const STAGE_PAD_Y = 128;

/** 保存的滚动容器原状态（关闭时按**原值**还原，不能无条件清空） */
interface ScrollLockSnapshot {
  /** 被锁的滚动容器（主文档 body / iframe 滚动元素） */
  el: HTMLElement;
  /** 原 overflow 内联值（"" 需配合优先级判断「原本到底有没有」） */
  overflow: string;
  overflowPriority: string;
  /** 原来的滚动位置（锁 overflow 会连带清零滚动，关闭后要放回去） */
  scrollTop: number;
  scrollLeft: number;
}

/** 取文档的滚动容器（主文档锁 body=既有行为；iframe 锁 scrollingElement） */
function scrollerOf(doc: Document): HTMLElement | null {
  const win = doc.defaultView;
  if (win === window && doc.body) return doc.body as HTMLElement;
  return ((doc.scrollingElement as HTMLElement | null) ?? doc.documentElement) as HTMLElement | null;
}

/**
 * 往目标 document 幂等注入灯箱样式。
 *
 * 只对**非主文档**（预览 iframe）需要：Vite 把 `.css` 注入主文档 head，
 * iframe 是独立文档、不继承父文档样式表。`?inline` 拿到的文本在测试环境为空，
 * 此时跳过注入即可（测试只断言 DOM 结构与行为，不断言样式）。
 */
function ensureLightboxStyle(doc: Document): void {
  if (!doc || doc === document) return;
  if (!lightboxCssText) return;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = lightboxCssText;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

/** 可用显示区尺寸（视口减去 CSS 留白） */
function viewportSizeOf(doc: Document): Size {
  const win = doc.defaultView;
  const w = win?.innerWidth ?? doc.documentElement?.clientWidth ?? 0;
  const h = win?.innerHeight ?? doc.documentElement?.clientHeight ?? 0;
  return {
    w: Math.max(0, w - STAGE_PAD_X),
    h: Math.max(0, h - STAGE_PAD_Y),
  };
}

export interface ImageLightboxProps {
  /** 可选：受控打开（不传则只订阅全局事件，宿主挂一次 `<ImageLightbox />` 即可） */
  open?: boolean;
  /** 可选：受控打开时的图片分组 */
  images?: LightboxState["images"];
  /** 可选：受控打开时的初始索引 */
  index?: number;
  /** 可选：覆盖 portal 目标文档（默认取打开事件里的 doc） */
  targetDocument?: Document;
  /** 关闭回调（组件内部关闭时也会调用） */
  onClose?: () => void;
}

/**
 * 图片灯箱。
 *
 * 宿主接线（由 Lead 在 EditorContainer 里挂**一次**）：
 * ```tsx
 * <ImageLightbox />
 * ```
 * 组件常驻挂载、未打开时返回 `null`（不产生任何 DOM 与监听）。
 */
export function ImageLightbox(props: ImageLightboxProps = {}) {
  const { open: controlledOpen, images: controlledImages, index: controlledIndex, onClose } = props;
  const t = useT();

  /** 当前视图状态（null = 未打开）。`fit` 字段在图片 onload 后按自然尺寸回填 */
  const [state, setState] = useState<LightboxState | null>(null);
  /** 自然尺寸（onload 量得；未量得前按 0 处理） */
  const [natural, setNatural] = useState<Size>({ w: 0, h: 0 });
  /** portal 目标文档（事件载荷决定：主文档 / 预览 iframe） */
  const [targetDoc, setTargetDoc] = useState<Document | null>(null);
  /** 坏图占位（onerror 后置 true，灯箱保留，仍可切图 / 关闭） */
  const [broken, setBroken] = useState(false);

  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrollLockRef = useRef<ScrollLockSnapshot | null>(null);
  /** 拖拽会话（指针按下 → 抬起） */
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  /** 上次按下的时间 / 坐标（双击判定） */
  const lastDownRef = useRef<{ at: number; x: number; y: number } | null>(null);
  /**
   * 抑制紧随其后的 click（= 本次手势不是"点空白关闭"）。
   *
   * 两种场景必须抑制：
   * 1. 拖拽平移结束——浏览器在 pointerup 之后仍会派发 click，若当成遮罩点击会
   *    一拖就关灯箱（实机必然踩到）；
   * 2. 双击切换 fit↔100%——两次 pointerdown 之间会派发两次 click，第二次若当成
   *    遮罩点击，双击行为就变成"切完立刻关闭"。
   */
  const suppressClickRef = useRef(false);
  /** 打开前的焦点元素（关闭后归还焦点） */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const isOpen = controlledOpen === true || state !== null;
  const doc = targetDoc ?? document;

  const metrics: LightboxMetrics = useMemo(
    () => ({ natural, viewport: targetDoc ? viewportSizeOf(targetDoc) : { w: 0, h: 0 } }),
    [natural, targetDoc],
  );

  /** 按当前文档/自然尺寸取度量上下文（事件回调里用，避免闭包过期） */
  const currentMetrics = useCallback(
    (): LightboxMetrics => ({ natural, viewport: viewportSizeOf(targetDoc ?? document) }),
    [natural, targetDoc],
  );

  // ─── 滚动锁 / 还原 ────────────────────────────────────────
  const lockScroll = useCallback((targetDoc: Document) => {
    if (scrollLockRef.current) return;
    const el = scrollerOf(targetDoc);
    if (!el) return;
    scrollLockRef.current = {
      el,
      overflow: el.style.overflow,
      overflowPriority: el.style.getPropertyPriority("overflow"),
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
    };
    el.style.setProperty("overflow", "hidden", "important");
  }, []);

  const restoreScroll = useCallback(() => {
    const snap = scrollLockRef.current;
    if (!snap) return;
    scrollLockRef.current = null;
    // 按**原值**还原：原本有内联 overflow 就写回原值，原本没有则移除属性。
    // （旧实现无条件 `body.style.overflow = ""`，会把用户/其它模块写的样式抹掉。）
    if (snap.overflow === "") snap.el.style.removeProperty("overflow");
    else snap.el.style.setProperty("overflow", snap.overflow, snap.overflowPriority || "");
    // 锁 overflow 后部分浏览器会把 scrollTop 归零 → 关闭后放回原位置
    if (snap.el.scrollTop !== snap.scrollTop) snap.el.scrollTop = snap.scrollTop;
    if (snap.el.scrollLeft !== snap.scrollLeft) snap.el.scrollLeft = snap.scrollLeft;
  }, []);

  // ─── 关闭（唯一出口：状态、滚动锁、焦点、状态回写都收口于此） ──
  const close = useCallback(() => {
    setState(null);
    setBroken(false);
    setNatural({ w: 0, h: 0 });
    restoreScroll();
    const prev = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (prev && typeof prev.focus === "function") {
      try {
        prev.focus({ preventScroll: true });
      } catch {
        /* 元素已卸载：忽略 */
      }
    }
    markLightboxOpen(null);
    onClose?.();
  }, [onClose, restoreScroll]);

  // ─── 打开 / 关闭事件订阅 ──────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<LightboxOpenDetail>).detail;
      if (!detail || !detail.images || detail.images.length === 0) return;
      const nextDoc = detail.doc ?? document;
      // 切换 document（主文档 ↔ iframe）时先还原上一份滚动锁，避免脏状态叠加
      restoreScroll();
      // 记录打开前的焦点元素（关闭后归还，键盘用户不会掉到 body 上）
      restoreFocusRef.current = (nextDoc.activeElement as HTMLElement | null) ?? null;
      setTargetDoc(nextDoc);
      setBroken(false);
      setNatural({ w: 0, h: 0 });
      setState(createLightboxState(detail.images, detail.index, { w: 0, h: 0 }, viewportSizeOf(nextDoc)));
      markLightboxOpen(nextDoc);
      lockScroll(nextDoc);
      ensureLightboxStyle(nextDoc);
    };
    const onCloseRequest = () => close();

    window.addEventListener(LIGHTBOX_OPEN_EVENT, onOpen);
    window.addEventListener(LIGHTBOX_CLOSE_EVENT, onCloseRequest);
    return () => {
      window.removeEventListener(LIGHTBOX_OPEN_EVENT, onOpen);
      window.removeEventListener(LIGHTBOX_CLOSE_EVENT, onCloseRequest);
    };
  }, [close, lockScroll, restoreScroll]);

  // 卸载兜底：组件卸载时必须还原滚动锁并清掉「已打开」标记（防浮层残留）
  useLayoutEffect(() => {
    return () => {
      restoreScroll();
      markLightboxOpen(null);
    };
  }, [restoreScroll]);

  // ─── 受控模式：把 props 合成为内部状态 ──────────────────────
  useEffect(() => {
    if (controlledOpen !== true) return;
    if (!controlledImages || controlledImages.length === 0) return;
    const nextDoc = props.targetDocument ?? document;
    restoreScroll();
    setTargetDoc(nextDoc);
    setBroken(false);
    setNatural({ w: 0, h: 0 });
    setState(createLightboxState(controlledImages, controlledIndex ?? 0, { w: 0, h: 0 }, viewportSizeOf(nextDoc)));
    markLightboxOpen(nextDoc);
    lockScroll(nextDoc);
    ensureLightboxStyle(nextDoc);
  }, [controlledOpen, controlledImages, controlledIndex, props.targetDocument, lockScroll, restoreScroll]);

  // ─── 图片 onload → 按自然尺寸计算 fit ─────────────────────
  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const size: Size = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
    setBroken(false);
    setNatural(size);
    setState((prev) => (prev ? fitView(prev, size, viewportSizeOf(targetDoc ?? document)) : prev));
  }, [targetDoc]);

  const handleImageError = useCallback(() => {
    setBroken(true);
  }, []);

  // ─── 缩放 / 平移 / 切图 ───────────────────────────────────
  /** 以视口中心为锚点缩放（工具栏按钮 / 键盘 +/-） */
  const zoomBy = useCallback(
    (factor: number) => {
      setState((prev) => (prev ? zoomAt(prev, factor, 0, 0, currentMetrics()) : prev));
    },
    [currentMetrics],
  );

  /** 滚轮缩放：锚点 = 指针相对显示区中心的坐标 */
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) {
        // 无布局信息（jsdom 等）时退化为中心缩放
        zoomBy(e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR);
        return;
      }
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setState((prev) => (prev ? zoomAt(prev, factor, cx, cy, currentMetrics()) : prev));
    },
    [currentMetrics, zoomBy],
  );

  // 原生 wheel 监听：必须是**非 passive** 才能 preventDefault（React 的 onWheel 走
  // root 委托，Chromium 里被当作 passive，preventDefault 无效且会告警）——
  // 而灯箱打开期间绝不能连带滚动背景文档，故这里显式绑 non-passive。
  useEffect(() => {
    if (!isOpen) return;
    const el = overlayRef.current;
    if (!el) return;
    const onWheelNative = (e: Event) => {
      const we = e as WheelEvent;
      we.preventDefault();
      handleWheel(we);
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [isOpen, handleWheel]);

  /** 切图：索引回环 + 视图复位（等新图 onload 再按新图算 fit） */
  const goTo = useCallback((index: number) => {
    setBroken(false);
    setNatural({ w: 0, h: 0 });
    setState((prev) => (prev ? goToImage(prev, index) : prev));
  }, []);

  /** 指针按下：可能是拖拽、可能是双击。仅「可平移」时进入拖拽 */
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const point = { at: Date.now(), x: e.clientX, y: e.clientY };
      const last = lastDownRef.current;
      lastDownRef.current = point;
      // 双击 fit ⇄ 100%（设计 §2.3）；判定口径与灯箱入口共用（isDoubleClick）
      if (isDoubleClick(last, point, DOUBLE_CLICK_WINDOW_MS, DOUBLE_CLICK_WINDOW_PX)) {
        lastDownRef.current = null;
        // 双击派生出的 click 不能当成遮罩点击（否则切完视图立刻关闭）
        suppressClickRef.current = true;
        e.preventDefault();
        setState((prev) => (prev ? toggleActualSize(prev, currentMetrics()) : prev));
        return;
      }
      if (!state || !canPan(state, currentMetrics())) return;
      e.preventDefault();
      const stage = e.currentTarget as HTMLElement;
      try {
        stage.setPointerCapture?.(e.pointerId);
      } catch {
        /* jsdom / 已释放：忽略 */
      }
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: state.offsetX,
        originY: state.offsetY,
      };
    },
    [state, currentMetrics],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      // 真的拖动了 → 随后的 click 是拖拽尾巴，不能当成遮罩点击关闭灯箱
      suppressClickRef.current = true;
      setState((prev) => {
        if (!prev) return prev;
        // 以按下时的 offset 为基线，避免逐帧累积误差
        const base: LightboxState = { ...prev, offsetX: drag.originX, offsetY: drag.originY };
        return panBy(base, dx, dy, currentMetrics());
      });
    },
    [currentMetrics],
  );

  const handlePointerUp = useCallback((e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* 已释放：忽略 */
    }
  }, []);

  // ─── 键盘：Esc / ←→ / Home / 0 / +/- / Tab ──────────────────
  useEffect(() => {
    if (!isOpen) return;
    const keyDoc = targetDoc ?? document;
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          close();
          break;
        case "ArrowLeft":
          e.preventDefault();
          setState((prev) => (prev ? prevImage(prev) : prev));
          setNatural({ w: 0, h: 0 });
          setBroken(false);
          break;
        case "ArrowRight":
          e.preventDefault();
          setState((prev) => (prev ? nextImage(prev) : prev));
          setNatural({ w: 0, h: 0 });
          setBroken(false);
          break;
        case "Home":
        case "0":
          e.preventDefault();
          setState((prev) => (prev ? resetView(prev) : prev));
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomBy(ZOOM_STEP);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomBy(1 / ZOOM_STEP);
          break;
        case "Tab": {
          // focus trap：Tab 在灯箱内循环，不逃到背景内容
          const root = overlayRef.current;
          if (!root) break;
          const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
          if (nodes.length === 0) break;
          const first = nodes[0]!;
          const last = nodes[nodes.length - 1]!;
          const active = keyDoc.activeElement as HTMLElement | null;
          const inside = active != null && root.contains(active);
          if (e.shiftKey && (!inside || active === first)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (!inside || active === last)) {
            e.preventDefault();
            first.focus();
          }
          break;
        }
        default:
          break;
      }
    };
    keyDoc.addEventListener("keydown", onKeyDown, true);
    return () => keyDoc.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, targetDoc, close, zoomBy]);

  // 打开时把焦点移进灯箱（关闭按钮），让键盘用户能 Tab / Esc
  useEffect(() => {
    if (!isOpen) return;
    const root = overlayRef.current;
    if (!root) return;
    root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
  }, [isOpen]);

  // ─── 窗口尺寸变化：fit 态重算 fit；custom 态只钳制平移 ─────
  useEffect(() => {
    if (!isOpen) return;
    const win = (targetDoc ?? document).defaultView;
    if (!win) return;
    const onResize = () => {
      setState((prev) => {
        if (!prev) return prev;
        const vp = viewportSizeOf(targetDoc ?? document);
        if (prev.mode === "fit") return fitView(prev, natural, vp);
        return clampViewOffsets(prev, { natural, viewport: vp });
      });
    };
    win.addEventListener("resize", onResize);
    return () => win.removeEventListener("resize", onResize);
  }, [isOpen, targetDoc, natural]);

  // ─── 渲染 ────────────────────────────────────────────────
  if (!isOpen || !state) return null;
  const body = doc.body;
  // 文档已卸载（iframe 被整体替换 / 主文档未就绪）→ 不渲染，等宿主重新打开
  if (!body) return null;

  const current = state.images[state.index];
  const multi = state.images.length > 1;
  const percent = scalePercent(state.scale);
  const pannable = canPan(state, metrics);
  // 自然尺寸已知时才写显式宽高；未知时交给 CSS（max-width/max-height + object-fit）
  const imgWidth = natural.w > 0 ? `${natural.w * state.scale}px` : undefined;
  const imgHeight = natural.h > 0 ? `${natural.h * state.scale}px` : undefined;

  const overlay = (
    <div
      ref={overlayRef}
      className="lightmd-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("imageLightbox.title")}
      data-testid="image-lightbox"
      // 点遮罩空白处关闭；点图片本身不关闭（设计 §2.3）
      onClick={(e) => {
        if (suppressClickRef.current) {
          // 拖拽尾巴 / 双击派生出的 click：吞掉，不触发关闭
          suppressClickRef.current = false;
          return;
        }
        // detail > 1 = 多击序列的后续 click（双击缩放的第二下），不当作关闭
        if (e.detail > 1) return;
        if (e.target === e.currentTarget) close();
      }}
      data-target-doc={doc === document ? "main" : "iframe"}
    >
      <div className="lightmd-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="lightmd-lightbox-btn"
          aria-label={t("imageLightbox.zoomOut")}
          title={t("imageLightbox.zoomOut")}
          data-testid="lightbox-zoom-out"
          disabled={state.scale <= MIN_SCALE + 1e-6}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          &minus;
        </button>
        <span className="lightmd-lightbox-percent" data-testid="lightbox-percent" aria-live="polite">
          {percent}%
        </span>
        <button
          type="button"
          className="lightmd-lightbox-btn"
          aria-label={t("imageLightbox.zoomIn")}
          title={t("imageLightbox.zoomIn")}
          data-testid="lightbox-zoom-in"
          disabled={state.scale >= MAX_SCALE - 1e-6}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="lightmd-lightbox-btn"
          aria-label={t("imageLightbox.reset")}
          title={t("imageLightbox.reset")}
          data-testid="lightbox-reset"
          onClick={() => setState((prev) => (prev ? resetView(prev) : prev))}
        >
          <span aria-hidden="true">&#8634;</span>
        </button>
        {multi && (
          <span className="lightmd-lightbox-counter" data-testid="lightbox-counter">
            {state.index + 1} / {state.images.length}
          </span>
        )}
        <button
          type="button"
          className="lightmd-lightbox-btn lightmd-lightbox-close"
          aria-label={t("imageLightbox.close")}
          title={t("imageLightbox.close")}
          data-testid="lightbox-close"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          &times;
        </button>
      </div>

      {/* 图片舞台：拖拽平移 / 双击切换 fit↔100% */}
      <div
        className={`lightmd-lightbox-stage${pannable ? " is-pannable" : ""}`}
        data-testid="lightbox-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {broken ? (
          <div className="lightmd-lightbox-broken" data-testid="lightbox-broken">
            {t("imageLightbox.broken")}
          </div>
        ) : (
          <img
            ref={imgRef}
            className="lightmd-lightbox-image"
            src={current?.src}
            alt={current?.alt ?? ""}
            draggable={false}
            data-testid="lightbox-image"
            style={{
              width: imgWidth,
              height: imgHeight,
              transform: `translate(${state.offsetX}px, ${state.offsetY}px)`,
            }}
            onLoad={handleImageLoad}
            onError={handleImageError}
            // 图片本身点击不关闭（设计明确要求），也不冒泡到遮罩
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>

      {multi && (
        <>
          <button
            type="button"
            className="lightmd-lightbox-nav lightmd-lightbox-prev"
            aria-label={t("imageLightbox.prev")}
            title={t("imageLightbox.prev")}
            data-testid="lightbox-prev"
            onClick={(e) => {
              e.stopPropagation();
              goTo(state.index - 1);
            }}
          >
            &#8249;
          </button>
          <button
            type="button"
            className="lightmd-lightbox-nav lightmd-lightbox-next"
            aria-label={t("imageLightbox.next")}
            title={t("imageLightbox.next")}
            data-testid="lightbox-next"
            onClick={(e) => {
              e.stopPropagation();
              goTo(state.index + 1);
            }}
          >
            &#8250;
          </button>
        </>
      )}

      {(current?.alt || current?.title) && (
        <div className="lightmd-lightbox-caption" data-testid="lightbox-caption">
          {current?.alt || current?.title}
        </div>
      )}
    </div>
  );

  return createPortal(overlay, body);
}

export default ImageLightbox;
