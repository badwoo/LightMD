/**
 * v0.8.0 修复 P3：内部文件拖拽（自制鼠标拖拽，不依赖 HTML5 拖放 API）
 *
 * 背景：Tauri 窗口配置 dragDropEnabled: true 时，Windows 上的 WebView2 会接管
 * 拖放事件，前端 HTML5 dragstart/dragover/drop 完全不触发（Tauri 官方文档明确
 * 要求"禁用 dragDropEnabled 才能使用 HTML5 拖放"）。为保留"从系统拖入文件到
 * 窗口打开"这一原生能力，这里改用 mousedown/mousemove/mouseup 自制拖拽。
 *
 * 设计要点：
 * - 纯 DOM 实现：拖动过程只移动一个跟随浮层 + 给落点元素加 class，
 *   不经过 React 状态，无额外重渲染，开销可忽略；
 * - 拖拽阈值 4px：小于阈值视为普通点击，不影响选择/切换标签；
 * - 语义：默认复制，按住 Shift 移动（需求1）；
 * - 落点识别：命中元素或祖先带 data-drop-dir 属性即为可投放文件夹；
 * - 落点准入（v0.8.4 S3）：可选 canDrop 谓词在高亮与松手两阶段前置判定，
 *   拖文件夹悬停到自身后代时不高亮、不触发投放（体验闭环）；
 * - 落点三分流（v0.8.4 D5）：命中 drop-dir 后——canDrop 拒绝 → 取消；
 *   落点为源所在目录 → onReorder（同目录重排）；其他目录 → onDrop（复制/移动）；
 *   未命中 drop-dir → 取消（现状不变）；
 * - Esc 取消；拖拽结束后抑制一次 click，避免误触发源元素的点击行为。
 */
import { getParentDir } from "./path";

export interface FileDragPayload {
  path: string;
  name: string;
}

export interface FileDragHandlers {
  /** 松开鼠标且落在有效文件夹上时回调（mode: 默认 copy，按 Shift 为 move） */
  onDrop: (payload: FileDragPayload, targetDir: string, mode: "copy" | "move") => void;
  /**
   * v0.8.4 需求1（S3）：可选落点准入谓词——返回 false 的目录不高亮、不触发投放。
   * 高亮与松手两阶段都会判定。拖文件夹时注入 `!isDescendantDir(src, target)`。
   */
  canDrop?: (targetDir: string) => boolean;
  /**
   * v0.8.4 需求3（D5 分支③）：落点为源所在目录时的同目录重排回调。
   * ev 为松手的 mouseup 事件（供调用方做 elementFromPoint 计算插入位置）。
   */
  onReorder?: (payload: FileDragPayload, ev: MouseEvent) => void;
}

/** 可投放文件夹的标记属性 */
export const DROP_DIR_ATTR = "data-drop-dir";
/** 落点高亮 class（拖动经过时临时加上） */
export const DRAG_ACTIVE_CLASS = "filetree-drop-active";
/** 拖拽启动阈值（px） */
export const DRAG_THRESHOLD_PX = 4;

/** 语义：按住 Shift 为移动，否则复制（需求1） */
export function resolveDragMode(shiftKey: boolean): "copy" | "move" {
  return shiftKey ? "move" : "copy";
}

/** 落点三分流动作（v0.8.4 D5） */
export type DropAction = "reject" | "reorder" | "transfer";

/** 分隔符与尾斜杠归一（同目录比较用） */
function normDirPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 落点三分流决策（v0.8.4 D5，纯函数便于单测）：
 * - "reject"  ：canDrop 准入拒绝（如拖文件夹悬停自身后代）→ onUp 静默取消，
 *               用户在拖动过程中已得到"不高亮 = 不可投放"的视觉反馈（S3 闭环）；
 * - "reorder" ：落点即源所在目录 → 同目录重排（需求 3，与需求 1 无缝衔接）；
 * - "transfer"：其他目录 → 交由调用方传输。注意"落点为源自身后代"的自嵌套
 *               场景：canDrop 已注入时在高亮阶段即被拒绝、到不了这里；未注入
 *               时走 transfer 由调用方（transferTo 的 isDescendantDir 守卫）
 *               拒绝并 toast——本模块不耦合 i18n，反馈统一收敛在调用方。
 */
export function resolveDropAction(
  payload: FileDragPayload,
  targetDir: string,
  canDrop?: (targetDir: string) => boolean,
): DropAction {
  if (canDrop && !canDrop(targetDir)) return "reject";
  if (normDirPath(getParentDir(payload.path)) === normDirPath(targetDir)) return "reorder";
  return "transfer";
}

/** 位移是否已达到拖拽启动阈值（纯函数，便于单测） */
export function isDragStarted(
  dx: number,
  dy: number,
  threshold: number = DRAG_THRESHOLD_PX,
): boolean {
  return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
}

/**
 * 从元素自身向上查找最近的投放目录。
 * 抽成纯函数（不依赖坐标），便于单测覆盖嵌套文件夹的"取最近者"语义。
 */
export function resolveDropDirFromElement(el: Element | null | undefined): string | null {
  if (!el || typeof (el as Element).closest !== "function") return null;
  const holder = el.closest(`[${DROP_DIR_ATTR}]`) as HTMLElement | null;
  const dir = holder?.getAttribute(DROP_DIR_ATTR);
  return dir || null;
}

/**
 * 查询坐标下的投放目录。
 * hitTest 可注入（jsdom 未实现 elementFromPoint），默认走浏览器原生命中测试。
 */
export function findDropDirAt(
  x: number,
  y: number,
  hitTest: (x: number, y: number) => Element | null = defaultHitTest,
): string | null {
  return resolveDropDirFromElement(hitTest(x, y));
}

function defaultHitTest(x: number, y: number): Element | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
  return document.elementFromPoint(x, y) as Element | null;
}

/** 拖拽结束后拦截一次 click，避免"拖动"被源元素当成"点击"处理 */
function suppressNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, true);
  window.setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

let sessionActive = false;

/**
 * 启动一次鼠标拖拽会话（在源元素的 onMouseDown 中调用）。
 *
 * @param payload    拖拽源（文件路径 + 显示名）
 * @param startEvent mousedown 事件（仅用其坐标与按键）
 * @param handlers   落点回调
 */
export function beginFileDrag(
  payload: FileDragPayload,
  startEvent: { clientX: number; clientY: number; button?: number },
  handlers: FileDragHandlers,
  hitTest: (x: number, y: number) => Element | null = defaultHitTest,
): void {
  if (startEvent.button !== undefined && startEvent.button !== 0) return;
  if (sessionActive) return;
  sessionActive = true;

  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  let ghost: HTMLDivElement | null = null;
  let activeDropEl: HTMLElement | null = null;
  let dragging = false;

  const clearDropHighlight = () => {
    if (activeDropEl) {
      activeDropEl.classList.remove(DRAG_ACTIVE_CLASS);
      activeDropEl = null;
    }
  };

  const cleanup = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    clearDropHighlight();
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    document.body.classList.remove("file-dragging");
    sessionActive = false;
  };

  const onMove = (ev: MouseEvent) => {
    if (!dragging) {
      if (!isDragStarted(ev.clientX - startX, ev.clientY - startY)) return;
      dragging = true;
      ghost = document.createElement("div");
      ghost.className = "file-drag-ghost";
      ghost.textContent = payload.name;
      document.body.appendChild(ghost);
      document.body.classList.add("file-dragging");
    }
    ev.preventDefault();
    if (ghost) {
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
    }
    // 命中测试直接取元素（比字符串属性选择器更稳，路径含反斜杠/引号也能匹配）
    const hit = hitTest(ev.clientX, ev.clientY);
    const holder = (hit?.closest?.(`[${DROP_DIR_ATTR}]`) as HTMLElement | null) ?? null;
    // v0.8.4 S3：canDrop 拒绝的落点不高亮（如拖文件夹悬停到自身后代），
    // 高亮阶段即给出"不可投放"的视觉反馈，松手也不会触发投放
    const allowed =
      holder !== null &&
      (!handlers.canDrop || handlers.canDrop(holder.getAttribute(DROP_DIR_ATTR) || ""));
    const nextHolder = allowed ? holder : null;
    if (nextHolder !== activeDropEl) {
      clearDropHighlight();
      if (nextHolder) {
        nextHolder.classList.add(DRAG_ACTIVE_CLASS);
        activeDropEl = nextHolder;
      }
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      // 拖拽中按 Esc：取消本次拖拽，且不把 Esc 传给编辑器（避免误触发其它 Esc 行为）
      ev.stopPropagation();
      dragging = false;
      cleanup();
    }
  };

  // 窗口失焦（如 Alt+Tab 切走、在窗口外松手）时取消拖拽，避免会话卡死导致后续无法再拖
  const onBlur = () => {
    dragging = false;
    cleanup();
  };

  const onUp = (ev: MouseEvent) => {
    const wasDragging = dragging;
    const targetDir = activeDropEl?.getAttribute(DROP_DIR_ATTR) || null;
    const mode = resolveDragMode(ev.shiftKey);
    cleanup();
    if (!wasDragging) return;
    suppressNextClick();
    if (!targetDir) return; // 未命中 drop-dir → 取消（现状不变）
    // v0.8.4 D5 落点三分流：
    // ① canDrop 准入拒绝 → 静默取消（高亮阶段已给"不可投放"反馈）；
    // ③ 落点即源所在目录 → 同目录重排（需求 3；复制/移动语义均不适用，
    //    也因此根目录内拖到空白不再误触发"复制到根目录生成副本"）；
    // ②④ 其他目录 → onDrop 传输。自嵌套（落点为源自身后代）在 canDrop 注入时
    //    已被高亮阶段拦截，未注入时由 transferTo 的 isDescendantDir 守卫
    //    拒绝并 toast「不能移动/复制到自身内部」（反馈统一收敛在调用方）。
    const action = resolveDropAction(payload, targetDir, handlers.canDrop);
    if (action === "reject") return;
    if (action === "reorder") {
      handlers.onReorder?.(payload, ev);
      return;
    }
    handlers.onDrop(payload, targetDir, mode);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
}