/**
 * useResizable —— 可复用的鼠标拖拽调整宽度/高度/比例 hook
 *
 * 支持四种方向：
 * - "left"：左侧栏（拖右移→宽度增加）
 * - "right"：右侧栏（拖左移→宽度增加）
 * - "split"：分屏模式（按容器总宽计算 ratio，钳制 0.3~0.7）
 * - "vertical"：垂直方向（拖下移→高度增加，钳制 minHeight~maxHeight）
 *
 * 设计要点：
 * - 用 useRef 追踪拖拽中间状态，避免重渲染
 * - 用 useState 触发宽度/高度/比例更新，驱动 UI
 * - 拖拽中锁定 body 光标和用户选择，结束时恢复
 * - 向后兼容：left/right/split 逻辑不变，vertical 为新增能力
 *
 * ─── v0.14.0 需求3：分屏分割线「往左拖能改、往右拖拖不回来」修复 ───
 *
 * 根因（实机 CDP 探针 scripts/v0140-probe-split-divider.mjs 取证）：
 *   分割条右侧紧挨着 `iframe.split-preview`（左侧 3px 误差内）。往右拖时指针一越过分割条
 *   就落进 iframe，**鼠标事件从此派发给 iframe 内部文档**，父文档的 `mousemove`/`mouseup`
 *   一次都收不到（实测：往左拖 6 次移动收到 6 次事件；往右拖 6 次移动收到 0 次，
 *   `elementFromPoint` 每一步都返回 `IFRAME.split-preview`）→ 拖拽链路中断、ratio 冻结，
 *   且 `mouseup` 丢失导致 body 一直停在 col-resize/user-select:none。
 *   往左拖不会经过 iframe，所以方向上是「单向右」失效。
 *
 * 三重修复（彼此互为兜底，`direction` 的拖拽数学**一行未改**）：
 *   1. `setPointerCapture`：按下时把指针捕获到分割条元素上。Chromium/WebView2 支持后，
 *      后续 `pointermove`/`pointerup` 会被重定向回分割条并继续冒泡到 document
 *      （实测 stage 5：捕获后指针进入 iframe，分割条仍收到 4/4 pointermove）。
 *   2. 拖拽期间临时把所有 `iframe/embed/object` 的 `style.pointerEvents` 设为 `none`
 *      （结束恢复原值）。这是不依赖 pointer capture 的兜底，实测单独生效即可修复
 *      （stage 4：打上该内联样式后同一「左拖→松手→右拖」手势立刻恢复双向可拖）。
 *   3. 同时监听 `pointermove`/`pointerup`/`pointercancel` 与旧的 `mousemove`/`mouseup`
 *      （jsdom 与老引擎没有可靠的 pointer capture，保留鼠标事件兼容路径）。
 *      同一次物理移动会先后派发 pointermove + 兼容 mousemove，用 `pointerSeenRef`
 *      去重，避免一次移动回调两次（拖拽公式是绝对量，重复调用不会错，但会多渲染一次）。
 *
 * 另外修复一个**潜在**缺陷：`initialRatio` 原来只在挂载时读一次，hook 内部 `ratio`
 * 之后不再跟随外部 store（若 store 被别的入口改动，第二次拖拽会从**旧起点**开始，
 * 表现为「要拖过一段才动」）。现在用 effect 同步，且**拖拽进行中不覆盖**内部实时值
 * （否则会跟手抖动）；拖拽结束后以外部值（store）为准。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseResizableOptions {
  /** 初始宽度(px) - left/right 方向用 */
  initialWidth?: number;
  /** 最小宽度(px) - left/right 方向用 */
  minWidth?: number;
  /** 最大宽度(px) - left/right 方向用 */
  maxWidth?: number;
  /** 初始高度(px) - vertical 方向用 */
  initialHeight?: number;
  /** 最小高度(px) - vertical 方向用 */
  minHeight?: number;
  /** 最大高度(px) - vertical 方向用 */
  maxHeight?: number;
  /** 拖拽方向 */
  direction: "left" | "right" | "split" | "vertical";
  /** 初始分屏比例（direction === "split" 时使用，默认 0.5） */
  initialRatio?: number;
  /** 尺寸变化回调（left/right 传 width，vertical 传 height） */
  onChange?: (size: number) => void;
  /** 分屏比例回调（direction === "split" 时触发） */
  onSplitChange?: (ratio: number) => void;
}

export interface UseResizableResult {
  /** 当前宽度(px) - left/right 方向 */
  width: number;
  /** 当前高度(px) - vertical 方向 */
  height: number;
  /** 当前分屏比例（0.3~0.7） */
  ratio: number;
  /** 是否正在拖拽 */
  isDragging: boolean;
  /** 绑定到分割条 mousedown 的事件处理器 */
  onMouseDown: (e: React.MouseEvent) => void;
}

/** split 方向比例的钳制区间（与 useSettingsStore.setSplitRatio 的 clamp 保持一致） */
const SPLIT_MIN_RATIO = 0.3;
const SPLIT_MAX_RATIO = 0.7;

/**
 * v0.14.0：拖拽期间需要临时屏蔽指针事件的嵌入内容。
 * iframe/embed/object 是独立的浏览上下文，指针进入后父文档收不到鼠标事件。
 */
const EMBED_SELECTOR = "iframe, embed, object";

/** 被临时屏蔽的嵌入元素及其原始内联 pointer-events 值 */
interface SuppressedEmbed {
  el: HTMLElement;
  prevPointerEvents: string;
}

/** 钳制到 [min, max] */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** 兜底用的 body 类名：拖拽期间挂上（CSS 侧可选配合，见 v0.14.0 报告） */
const SPLIT_RESIZING_CLASS = "split-resizing";

/**
 * 临时屏蔽页面内所有嵌入元素的指针事件，返回可用于恢复的快照。
 * 任何一步失败都不影响拖拽主流程（尽力而为）。
 */
function suppressEmbeddedPointerEvents(): SuppressedEmbed[] {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return [];
  const saved: SuppressedEmbed[] = [];
  try {
    document.querySelectorAll<HTMLElement>(EMBED_SELECTOR).forEach((el) => {
      if (!el || !el.style) return;
      saved.push({ el, prevPointerEvents: el.style.pointerEvents });
      el.style.pointerEvents = "none";
    });
  } catch {
    /* 忽略：屏蔽失败只是少了一层兜底 */
  }
  return saved;
}

/** 恢复被屏蔽嵌入元素的内联 pointer-events 原值 */
function restoreEmbeddedPointerEvents(saved: SuppressedEmbed[]): void {
  for (const item of saved) {
    try {
      item.el.style.pointerEvents = item.prevPointerEvents;
    } catch {
      /* 元素可能已随重渲染被移除，忽略 */
    }
  }
  saved.length = 0;
}

/**
 * v0.14.0：注入一条运行期样式表，让「拖拽期间新挂载的嵌入元素」也被屏蔽。
 *
 * 为什么需要：拖拽中 React 重渲染可能重建 iframe（例如分屏预览的 srcDoc 更新），
 * 新节点不在 `suppressEmbeddedPointerEvents` 的快照里，内联样式覆盖不到它。
 * 规则挂在 `<html data-split-resizing="1">` 上，只在拖拽期间生效，拖完即失效，
 * 不改变任何常态样式（因此不会影响侧栏/大纲/别的页面的 iframe 行为）。
 */
const RESIZING_STYLE_ID = "lightmd-split-resizing-style";
const RESIZING_ATTR = "data-split-resizing";

function ensureResizingStyleSheet(): void {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  try {
    if (!document.getElementById(RESIZING_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = RESIZING_STYLE_ID;
      // 三种嵌入元素各一条规则，均在 <html data-split-resizing="1"> 生效期间才命中
      style.textContent = [
        `html[${RESIZING_ATTR}="1"] iframe,`,
        `html[${RESIZING_ATTR}="1"] embed,`,
        `html[${RESIZING_ATTR}="1"] object { pointer-events: none !important; }`,
      ].join("\n");
      document.head.appendChild(style);
    }
    document.documentElement.setAttribute(RESIZING_ATTR, "1");
  } catch {
    /* 忽略：内联样式那一层仍然有效 */
  }
}

function teardownResizingStyleSheet(): void {
  if (typeof document === "undefined") return;
  try {
    document.documentElement.removeAttribute(RESIZING_ATTR);
  } catch {
    /* 忽略 */
  }
}

export function useResizable(options: UseResizableOptions): UseResizableResult {
  const {
    initialWidth,
    minWidth,
    maxWidth,
    initialHeight,
    minHeight,
    maxHeight,
    direction,
    initialRatio = 0.5,
    onChange,
    onSplitChange,
  } = options;
  const [width, setWidth] = useState(initialWidth ?? 0);
  const [height, setHeight] = useState(initialHeight ?? 0);
  const [ratio, setRatio] = useState(initialRatio);
  const [isDragging, setIsDragging] = useState(false);

  // 拖拽中间状态（不触发重渲染）
  const dragStateRef = useRef({
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0,
    startRatio: 0.5,
    containerWidth: 0,
  });

  // 最新回调引用，避免闭包陈旧
  const onChangeRef = useRef(onChange);
  const onSplitChangeRef = useRef(onSplitChange);
  onChangeRef.current = onChange;
  onSplitChangeRef.current = onSplitChange;

  // v0.14.0：拖拽中标记（ref，供事件处理器同步读取，不必等重渲染）
  const isDraggingRef = useRef(false);
  // v0.14.0：本次拖拽是否已经由 pointer 事件通道接管（用于 mousemove 去重）
  const pointerSeenRef = useRef(false);
  // v0.14.0：被临时屏蔽指针事件的嵌入元素快照
  const suppressedEmbedsRef = useRef<SuppressedEmbed[]>([]);
  // v0.14.0：当前持有指针捕获的元素与 pointerId
  const capturedElRef = useRef<HTMLElement | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);
  // v0.14.0：最近一次 pointerdown 的 pointerId
  // （mouse 事件的 MouseEvent 上没有 pointerId，而 setPointerCapture 需要它；
  //  pointerdown 在同一手势内**先于** mousedown 同步触发，所以这里记录的必是当前手势的 id）
  const lastPointerIdRef = useRef<number | null>(null);
  // v0.14.0：外部最新 initialRatio（onMouseDown 里读取，避免 useCallback 闭包拿到旧值）
  const initialRatioRef = useRef(initialRatio);
  initialRatioRef.current = initialRatio;

  // v0.14.0：两个移动处理器的引用容器
  // （handleMouseUp 需要解绑它们，它们又要调用 applyMove —— 用 ref 打破 useCallback 依赖环）
  const moveHandlersRef = useRef<{
    mouse: (e: MouseEvent) => void;
    pointer: (e: PointerEvent) => void;
  }>({ mouse: () => {}, pointer: () => {} });

  // v0.14.0：记录 pointerdown 的 pointerId —— 供 onMouseDown 里调用 setPointerCapture
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onPointerDown = (e: PointerEvent) => {
      lastPointerIdRef.current = typeof e.pointerId === "number" ? e.pointerId : null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  /**
   * v0.14.0：外部（store）值变化时同步内部 ratio。
   *
   * 策略：
   * - **拖拽进行中不覆盖**——内部 ratio 是正在跟手的实时值，一覆盖就会抖；
   *   所以拖拽期间本 effect 只会在 `isDraggingRef` 为 true 时直接返回；
   * - 拖拽结束（isDragging 转 false）时本 effect 会因依赖变化**再跑一次**，
   *   此时把内部值对齐到外部值。正常路径下两者本来就相等（最后一次 move 已经
   *   通过 onSplitChange 写进 store），所以这次 setRatio 是 no-op、不会出现
   *   "松手瞬间弹一下"；只有在拖拽中外部被第三方改动时它才真正起作用。
   */
  useEffect(() => {
    if (direction !== "split") return;
    if (isDraggingRef.current) return;
    setRatio(initialRatio);
  }, [initialRatio, direction, isDragging]);

  /** 按方向计算并提交新的尺寸/比例（pointer 与 mouse 两条通道共用） */
  const applyMove = useCallback(
    (clientX: number, clientY: number) => {
      const ds = dragStateRef.current;

      if (direction === "vertical") {
        // Issue 3 修复：resizer 在区域上方，往下拖应减小区域高度（上方空间增大），
        // 往上拖应增大区域高度（上方空间减小）。因此 delta 取反。
        const delta = clientY - ds.startY;
        const newHeight = clamp(ds.startHeight - delta, minHeight ?? 0, maxHeight ?? Infinity);
        setHeight(newHeight);
        onChangeRef.current?.(newHeight);
      } else if (direction === "split") {
        // split 模式：按容器总宽计算 ratio
        const cw = ds.containerWidth || 1;
        const delta = clientX - ds.startX;
        // delta 正→左侧变宽→ratio 增加
        const newRatio = clamp(ds.startRatio + delta / cw, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO);
        setRatio(newRatio);
        onSplitChangeRef.current?.(newRatio);
      } else if (direction === "left") {
        // 左侧栏：拖右移(delta 正)→宽度增加
        const delta = clientX - ds.startX;
        const newWidth = clamp(ds.startWidth + delta, minWidth ?? 0, maxWidth ?? Infinity);
        setWidth(newWidth);
        onChangeRef.current?.(newWidth);
      } else {
        // right 方向：拖左移(delta 正)→宽度增加
        const delta = clientX - ds.startX;
        const newWidth = clamp(ds.startWidth - delta, minWidth ?? 0, maxWidth ?? Infinity);
        setWidth(newWidth);
        onChangeRef.current?.(newWidth);
      }
    },
    [direction, minWidth, maxWidth, minHeight, maxHeight],
  );

  // v0.8.2 / v0.14.0：结束拖拽的引用（供事件处理器与兜底逻辑互相调用，打破依赖环）
  const endDragRef = useRef<() => void>(() => {});

  /**
   * 结束拖拽：解绑所有监听、释放指针捕获、恢复 body 样式与被屏蔽的嵌入元素。
   * v0.14.0：做成幂等——pointerup 与兼容的 mouseup 会先后到达，重复调用必须安全。
   */
  const handleMouseUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    pointerSeenRef.current = false;

    document.removeEventListener("mousemove", moveHandlersRef.current.mouse);
    document.removeEventListener("mouseup", handleMouseUp);
    document.removeEventListener("pointermove", moveHandlersRef.current.pointer);
    document.removeEventListener("pointerup", handleMouseUp);
    document.removeEventListener("pointercancel", handleMouseUp);
    window.removeEventListener("blur", handleMouseUp);

    // 释放指针捕获（浏览器在 pointerup 后会自动释放，这里显式释放以防异常路径）
    const capturedEl = capturedElRef.current;
    const capturedId = capturedPointerIdRef.current;
    if (capturedEl && capturedId !== null) {
      try {
        capturedEl.releasePointerCapture?.(capturedId);
      } catch {
        /* 忽略：可能已自动释放 */
      }
    }
    capturedElRef.current = null;
    capturedPointerIdRef.current = null;

    // 恢复 body 样式与拖拽类名
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.classList.remove(SPLIT_RESIZING_CLASS);

    // 恢复被临时屏蔽指针事件的 iframe/embed/object
    restoreEmbeddedPointerEvents(suppressedEmbedsRef.current);
    suppressedEmbedsRef.current = [];
    teardownResizingStyleSheet();

    // 注意：这里**不**用 initialRatio 覆盖内部 ratio。
    // 拖拽结束时的外部值与最后一次 mousemove 写出去的值可能还差一帧（zustand 同步写、
    // React 下一帧才把新 prop 传回来），强行覆盖会让分割条在松手瞬间弹一下。
    // 真实值由下面的 useEffect 在 initialRatio 变化时统一同步。

    setIsDragging(false);
  }, [direction]);
  endDragRef.current = handleMouseUp;

  /** mousemove 通道（jsdom 与老引擎的兼容路径；真实 WebView2 由 pointer 通道接管） */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      // v0.8.2 修复：拖拽中窗口失焦（Alt+Tab/系统通知/Win 键）时 mouseup 丢失，
      // mousemove 监听器永久残留 → 残留监听器用旧起点持续改写宽度 → "分割条拖不动"。
      // 检测到按键已全部松开（buttons === 0）立即结束拖拽。
      if (e.buttons === 0) {
        endDragRef.current();
        return;
      }
      // v0.14.0：pointer 通道已接管本次拖拽 → 忽略兼容 mousemove，避免一次移动回调两次
      if (pointerSeenRef.current) return;
      applyMove(e.clientX, e.clientY);
    },
    [applyMove],
  );

  /** v0.14.0：pointermove 通道（指针捕获重定向到这里，进入 iframe 也不会丢） */
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      pointerSeenRef.current = true;
      if (e.buttons === 0) {
        endDragRef.current();
        return;
      }
      applyMove(e.clientX, e.clientY);
    },
    [applyMove],
  );

  // 两个处理器经 ref 互相引用（handleMouseUp 需要解绑它们，它们需要调用 applyMove）
  moveHandlersRef.current = { mouse: handleMouseMove, pointer: handlePointerMove };

  // 卸载时结束拖拽（避免监听器与 body 样式泄漏）
  useEffect(
    () => () => {
      if (isDraggingRef.current) endDragRef.current();
    },
    [],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 仅响应左键，阻止默认选区行为
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      // 上一轮若因异常没走完，先确保清干净（幂等）
      if (isDraggingRef.current) endDragRef.current();

      const target = e.currentTarget as HTMLElement | null;
      const ds = dragStateRef.current;
      ds.startX = e.clientX;
      ds.startY = e.clientY;
      ds.startWidth = width;
      ds.startHeight = height;
      // v0.14.0：split 的起点以**外部最新值**为准（它就是当前渲染出来的比例），
      // 不再用可能滞后的内部 state —— 避免第二次拖拽从旧起点开始（"要拖一段才动"）。
      ds.startRatio =
        direction === "split" ? clamp(initialRatioRef.current, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO) : ratio;
      // split 模式需要容器总宽：取分割条父元素宽度
      if (direction === "split") {
        const parent = target?.parentElement;
        ds.containerWidth = parent ? parent.getBoundingClientRect().width : 0;
      }

      isDraggingRef.current = true;
      pointerSeenRef.current = false;

      // 锁定 body 光标和选择（vertical 用 row-resize，其余用 col-resize）
      document.body.style.cursor = direction === "vertical" ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
      // v0.14.0：拖拽期间挂类名（供 CSS 可选配合，如屏蔽 iframe 指针事件 / 禁用过渡）
      document.body.classList.add(SPLIT_RESIZING_CLASS);
      // v0.14.0：兜底屏蔽 iframe/embed/object 的指针事件（不依赖 pointer capture）
      ensureResizingStyleSheet(); // 覆盖"拖拽中新挂载"的嵌入元素
      suppressedEmbedsRef.current = suppressEmbeddedPointerEvents(); // 覆盖"拖拽前已存在"的嵌入元素
      setIsDragging(true);

      // v0.14.0：把指针捕获到分割条上 —— 指针进入 iframe 后事件仍会回到这里
      if (target && typeof target.setPointerCapture === "function") {
        const pointerId = lastPointerIdRef.current;
        if (pointerId !== null) {
          try {
            target.setPointerCapture(pointerId);
            capturedElRef.current = target;
            capturedPointerIdRef.current = pointerId;
          } catch {
            /* 环境不支持（jsdom / 老引擎）→ 走 mousemove 兼容路径 */
          }
        }
      }

      // pointer 通道（优先）+ mouse 通道（兼容）
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handleMouseUp);
      document.addEventListener("pointercancel", handleMouseUp);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      // v0.8.2：窗口失焦兜底——失焦瞬间结束拖拽（mouseup 可能丢失）
      window.addEventListener("blur", handleMouseUp);
    },
    [direction, width, height, ratio, handleMouseMove, handlePointerMove, handleMouseUp],
  );

  return { width, height, ratio, isDragging, onMouseDown };
}
