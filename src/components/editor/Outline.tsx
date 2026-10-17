/**
 * Outline —— 文档大纲视图（含滚动同步 + 拖拽排序 G13）
 *
 * 性能优化：
 * - 使用 ProseMirror 事务监听替代 MutationObserver，避免 DOM 修改触发无限循环
 * - 限制 IntersectionObserver 只监听可视区域附近的标题
 * - 大纲列表限制最大渲染数量，避免大量 DOM 节点
 * - 防抖提取标题，减少频繁更新
 * - 拖拽过程中不修改文档，仅 onDragEnd 时执行一次 transaction
 *
 * 拖拽（G13）：
 * - 所有模式（编辑/分屏/阅读）均启用拖拽
 * - 阅读模式下拖拽排序通过 editorView.dispatch 直接修改文档 state，
 *   ProseMirror 会自动更新 DOM（阅读模式下 editorView 仍可见）
 * - 拖拽手柄仅 hover 时显示，不干扰点击跳转
 * - 限制垂直方向拖拽
 * - 跨层级拖拽时智能调整标题级别（保持相对层级）
 *
 * 搜索（v0.8.4 需求11，反馈3/4 已改造）：
 * - 搜索框内联在标题栏（outline-header）内，位于"大纲"标题右侧、计数左侧，保持单行布局
 * - 容器 hover / 搜索框聚焦 / 有关键字 任一成立 → 展开搜索框，否则收起；显隐用宽度/透明度过渡
 * - 防误关：输入中鼠标移出但焦点仍在 → 不收起；blur 且鼠标不在 → 收起
 * - 过滤为大小写不敏感的包含匹配，先过滤再做 MAX_OUTLINE_ITEMS 截断
 * - 过滤态下禁用拖拽（dnd-kit items 索引随过滤变化，禁用最稳）
 * - 有关键字时输入框右侧显示清空按钮（×），点击清空并保持焦点（反馈4）
 */
import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties } from "react";
import type { EditorView } from "prosemirror-view";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useT } from "../../i18n";
import { calculateDragTransaction } from "../../utils/outlineDrag";
// v0.13.2 需求7b：大纲滚动位置按文档记忆
import {
  getOutlineScroll,
  setOutlineScroll,
  loadOutlineScrollSnapshot,
} from "../../services/outlineScrollMemory";
import { UNTITLED_PROGRESS_PREFIX } from "../../utils/tabKey";
import { useEditorStore } from "../../stores/useEditorStore";
// v0.13.0 需求9：大纲面板标题折叠（纯逻辑层）
import {
  computeOutlineVisibility,
  toggleCollapsed,
  canCollapse,
  shouldApplyCollapse,
} from "../../utils/outlineCollapse";
import "./Outline.css";

interface HeadingItem {
  level: number;
  text: string;
  pos: number;
  id: string;
}

interface OutlineProps {
  editorView: EditorView | null;
}

/**
 * 大纲最大渲染数量，超出时只显示前 MAX_OUTLINE_ITEMS 项
 * R5（v0.10.0）：100 → 1000——长文档（技术书籍/会议纪要汇编）标题数常超百，
 * 旧上限静默截断可用性差；1000 项 DOM 按钮的渲染开销可接受
 */
const MAX_OUTLINE_ITEMS = 1000;

/**
 * 限制拖拽只能沿垂直方向移动的自定义 modifier
 *
 * 实现：将 transform.x 强制为 0，保留 y 位移。
 * 自定义实现以避免引入额外的 @dnd-kit/modifiers 依赖。
 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

/**
 * v0.13.1 需求11：列表**末尾**落点的哨兵 id。
 *
 * `calculateDragTransaction(state, sourcePos, doc.content.size)` 已经实现了
 * 「拖到文档末尾」的分支（取最后一个标题的层级），但旧实现**没有任何东西能产生
 * 这个目标** —— 列表末尾既不是落点，也没有可命中的目标，于是「把标题拖到最后」
 * 在 UI 上根本不可达。
 *
 * ## 为什么不新增一个 `useDroppable` 末尾落点
 *
 * 试过：给末尾加一个 `useDroppable` 哨兵是 dnd-kit 的教科书做法，但它会**越界**——
 * `@dnd-kit/core` 的替身（`vi.mock`）在 4 个本轮**不在改动范围**的既有测试文件里
 * 是显式枚举导出对象的（`v0.9.0-app-smoke` / `v0.9.0-fixes-round5` / `v0.9.1-fixes` /
 * `v0130-external-refresh`，它们都会 `render(<App />)`）。这些替身一旦缺少
 * `useDroppable`，vitest 会在渲染时抛
 * `No "useDroppable" export is defined on the "@dnd-kit/core" mock` ——
 * 也就是说，为了一个末尾落点要连带改 4 个不属于本轮的测试文件，违反文件范围约束。
 *
 * ## 采用的方案：几何判定 + 末尾占位条
 *
 * 拖拽经过时用指针位置判断是否越过最后一个**可见**行：
 * 越过了 → 落点记为文档末尾（`doc.content.size`），并在末尾渲染高亮的落点条
 * （文案用本轮新增、此前无人使用的 i18n key `outline.dropHere`）。
 * 这样"拖到末尾"全程可达，且**完全不需要新增 dnd-kit 导出**，
 * 现有 4 个 App 级测试的替身无需任何改动。
 */

/** 可排序标题项（包装 useSortable） */
function SortableHeadingItem({
  heading,
  activeId,
  draggable,
  /** v0.13.0 需求9：是否可折叠（有子级） */
  collapsible,
  /** v0.13.0 需求9：当前是否折叠 */
  collapsed,
  /**
   * v0.13.0 返修（问题7）：该行是否处于"折叠隐藏"态。
   *
   * 隐藏行**保留在 DOM 中**（只加 class 收缩高度），这样才能做平滑动画——
   * 直接从 DOM 摘掉节点是瞬时消失，无法过渡。
   */
  hidden,
  /**
   * v0.13.1 需求11：当前拖拽悬停在这一行上（用于 `.outline-row--over` 高亮）。
   * 旧实现里 `overPos` 被算出却从未接到任何元素的 class 上，
   * `.outline-row--over` 是**死样式**，用户看不出"要落到哪一行"。
   */
  isOverTarget,
  /** v0.13.0 需求9：折叠/展开按钮的 aria/title 文案（i18n，由父层注入） */
  collapseLabel,
  expandLabel,
  /** v0.13.0 需求9：切换折叠 */
  onToggleCollapse,
  onClick,
}: {
  heading: HeadingItem;
  activeId: string | null;
  draggable: boolean;
  collapsible: boolean;
  collapsed: boolean;
  hidden: boolean;
  isOverTarget: boolean;
  collapseLabel: string;
  expandLabel: string;
  onToggleCollapse: (pos: number) => void;
  onClick: (pos: number) => void;
}) {
  // v0.13.1 需求11：不再需要 `transform`（DragOverlay 接管位移），也不再需要
  // `CSS.Transform.toString(...)`（见下方 style 的说明）。
  const { attributes, listeners, setNodeRef, transition, isDragging } =
    useSortable({ id: heading.pos, disabled: !draggable });

  // v0.13.1 需求11：**不再对源项做半透明处理**。
  //
  // 缺陷背景（用户报告「大纲拖拽移动过程中路径会变成灰色，我需要拖动过程中能看到我
  // 拖动的标题，也能看到背景目录」）：旧实现这里写 `opacity: isDragging ? 0.5 : 1`，
  // 而 Outline.css 的 `.outline-item.dragging` 又叠了一层 0.5 —— 源项被淡化两次，
  // 整个列表在拖拽期间"发灰"；同时因为既没有 DragOverlay，跟随光标的就是这个被淡化
  // 的真实行。现在改为：
  //   · 跟随光标的是 `<DragOverlay>` 里的**实心幽灵**（portal 到 body，
  //     绕开 .outline-row 的 max-height/overflow:hidden 裁剪 —— 那正是旧实现
  //     "拖出约 ±30px 就看不见了"的根因）；
  //   · 源项保持完全可读，只用虚线描边标记（样式见 .outline-item.dragging）。
  // dnd-kit 在启用 DragOverlay 时**不再 transform 源项**，故这里也不再需要位移动画。
  const style: CSSProperties = {
    transition,
    paddingLeft: `${(heading.level - 1) * 14 + 12}px`,
  };

  return (
    <div
      className={`outline-row outline-level-${heading.level} ${activeId === heading.id ? "active" : ""} ${isDragging ? "dragging" : ""} ${isOverTarget ? "outline-row--over" : ""} ${hidden ? "outline-hidden" : ""}`}
      aria-hidden={hidden || undefined}
      data-collapsed-hidden={hidden ? "true" : undefined}
      // v0.13.1 需求12：供"跟随滚动"精确定位当前活动行（不依赖类名选择器）
      data-outline-pos={heading.pos}
    >
      {/* v0.13.0 需求9：折叠箭头。不可折叠的标题也渲染占位，保持文本左对齐一致 */}
      {collapsible ? (
        <button
          type="button"
          className={`outline-collapse-toggle ${collapsed ? "collapsed" : ""}`}
          aria-label={collapsed ? expandLabel : collapseLabel}
          title={collapsed ? expandLabel : collapseLabel}
          data-testid="outline-collapse-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(heading.pos);
          }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      ) : (
        <span className="outline-collapse-spacer" aria-hidden="true" />
      )}
      <button
        ref={setNodeRef}
        style={style}
        className={`outline-item outline-level-${heading.level} ${activeId === heading.id ? "active" : ""} ${isDragging ? "dragging" : ""}`}
        onClick={() => onClick(heading.pos)}
        title={heading.text}
      >
        {draggable && (
          <span
            className="outline-drag-handle"
            aria-label="drag handle"
            title="⋮⋮"
            {...attributes}
            {...listeners}
          >
            ⋮⋮
          </span>
        )}
        <span className="outline-item-text">{heading.text}</span>
      </button>
    </div>
  );
}

export function Outline({ editorView }: OutlineProps) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // v0.8.4 需求11：搜索条三状态——容器悬停 / 关键字 / 搜索框聚焦
  const [hovered, setHovered] = useState(false);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  // v0.13.0 需求9：大纲折叠态（被折叠标题的 pos 集合）。
  // **不持久化**——重开文档/切换标签后自然重置，不新增存储 key。
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  // 缓存上一次的标题列表，避免内容未变时重复更新
  const lastHeadingsRef = useRef<string>("");
  // v0.8.4 需求11 反馈4：搜索输入框引用，供清空按钮把焦点交还输入框
  const inputRef = useRef<HTMLInputElement | null>(null);
  // v0.13.1 需求11：拖拽中的标题（DragOverlay 幽灵的内容）
  const [activeDrag, setActiveDrag] = useState<{ text: string; level: number } | null>(null);
  // v0.13.1 需求11：落点插入线的位置（相对 .outline-list 的 y 偏移）
  const [dropLineY, setDropLineY] = useState<number | null>(null);
  // v0.13.1 需求11：当前悬停的目标行 pos（用于行高亮）
  const [overPos, setOverPos] = useState<number | null>(null);
  // v0.13.1 需求11：指针是否已越过最后一个可见行（落点 = 文档末尾）
  const [overEnd, setOverEnd] = useState(false);
  // 同上，供 handleDragEnd 读取（事件回调里读 state 会拿到闭包旧值）
  const overEndRef = useRef(false);
  // v0.13.1 需求11：最后一个**可见**行的 pos（末尾落点判定的锚点）
  const lastVisiblePosRef = useRef<number | null>(null);
  // v0.13.1 需求12：大纲列表容器引用（跟随滚动 + 落点线定位）
  const listRef = useRef<HTMLElement | null>(null);
  // v0.13.1 需求12：用户最近一次主动操作大纲列表的时刻（抑制自动跟随，避免抢滚动）
  const userTouchedListAtRef = useRef(0);
  /**
   * v0.13.2 需求7b：当前文档键（与 fileScrollProgress 同源）。
   * 真实文件 = 路径，临时标签 = `untitled:<id>`。
   */
  const docKey = useEditorStore((s) => {
    const tab = s.openTabs[s.activeTabIdx];
    if (!tab) return null;
    return tab.isUntitled
      ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? s.activeTabIdx}`
      : tab.path || null;
  });
  /**
   * v0.13.2 需求7b：恢复记忆位置的窗口期。
   *
   * 切回一个"读到末尾"的文档时，如果立刻让跟随逻辑生效，它会马上把大纲滚到
   * 活动标题处 —— 用户看到的就是"每次切回来大纲都要自己滚一下"。
   * 因此恢复后 `OUTLINE_RESTORE_GRACE_MS` 内抑制跟随，让记忆位置先稳定下来。
   */
  const restoreGraceUntilRef = useRef(0);
  const t = useT();

  // 所有模式启用拖拽（v0.3.0 修复：阅读模式下也支持大纲拖拽排序）
  // editorView.dispatch 不依赖于 contenteditable，可直接修改文档 state
  const dragEnabled = true;

  // v0.8.4 需求11 显隐规则：hover / 聚焦 / 有关键字 任一成立即展开；
  // 防误关由派生逻辑天然保证——输入中鼠标移出但焦点仍在（searchFocused 兜底）不收起；
  // blur 且鼠标不在容器内（三者皆否）自动收起
  const hasQuery = query.trim() !== "";
  const searchVisible = hovered || searchFocused || hasQuery;

  // v0.8.4 需求11：过滤态下禁用拖拽——dnd-kit 的 items 索引随过滤结果变化，
  // 拖拽语义错乱，直接禁用最稳（恢复无关键字后拖拽自动可用）
  const dragActive = dragEnabled && !hasQuery;

  // PointerSensor 要求移动超过 5px 才触发拖拽，避免误触点击跳转
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // 提取标题（遍历 ProseMirror 文档，不依赖 DOM）
  const extractHeadings = useCallback(() => {
    if (!editorView) return [];
    const { doc } = editorView.state;
    const items: HeadingItem[] = [];

    doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        const text = node.textContent || t("outline.emptyHeading");
        const id = `outline-h-${pos}`;
        items.push({ level: node.attrs.level, text, pos, id });
      }
    });

    // 通过序列化比较避免无变化时触发 setState
    // v0.12.1 需求2：比较键**必须含 level**——旧键只有 `pos:text`，而通过标题徽标
    // 下拉改级别时 pos 与 text 都不变（setNodeMarkup 只改 attrs.level），键相同 →
    // setHeadings 被跳过 → 大纲条目的 outline-level-N 类名与 paddingLeft 不刷新，
    // 用户看到"改了级别但大纲没有层级缩进"。level 必须参与比较。
    const key = items.map((h) => `${h.pos}:${h.level}:${h.text}`).join("|");
    if (key === lastHeadingsRef.current) return items;
    lastHeadingsRef.current = key;
    setHeadings(items);
    return items;
  }, [editorView, t]);

  // 设置 IntersectionObserver 追踪标题元素
  //
  // 关键设计：不修改 ProseMirror 管理的 DOM（如设置 id 属性），
  // 否则 ProseMirror 内部的 MutationObserver 会捕获属性变化，
  // 触发 markDirty → view.updateState → 完全重建 DOM 节点，
  // 导致阅读模式编辑时每次按键屏幕闪烁抖动。
  //
  // 改用 WeakMap 建立 DOM 元素 → pos 的映射，在 IntersectionObserver
  // 回调中通过 DOM 元素查找对应的 pos，无需在 DOM 上设置任何标识。
  const domToPosRef = useRef<WeakMap<HTMLElement, number> | null>(null);

  const setupObserver = useCallback((items: HeadingItem[]) => {
    if (!editorView) return;

    // 清理旧 observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    // 使用 requestAnimationFrame 确保 DOM 已渲染
    const rafId = requestAnimationFrame(() => {
      // 建立 DOM → pos 映射，避免修改 ProseMirror DOM
      const domToPos = new WeakMap<HTMLElement, number>();
      domToPosRef.current = domToPos;

      const newObserver = new IntersectionObserver(
        (entries) => {
          // 找出所有当前可见的标题
          const visible = entries
            .filter((e) => e.isIntersecting)
            .map((e) => domToPos.get(e.target as HTMLElement))
            .filter((pos): pos is number => pos !== undefined)
            .sort((a, b) => a - b);
          if (visible.length > 0) {
            // 取最靠前的可见标题的 pos，生成对应的 id 用于 active 高亮
            const firstPos = visible[0];
            const item = items.find((h) => h.pos === firstPos);
            if (item) {
              setActiveId(item.id);
            }
          }
        },
        /**
         * v0.13.2 需求7a：**标题进入屏幕下半部分就要跟上**。
         *
         * 用户报告：「当前滚动屏幕，文档中的标题要滚动到屏幕上半部分，右侧大纲栏
         * 才能跟随滚动看到；我需要只要标题在屏幕下半部分能看到，那么右侧大纲栏
         * 也能跟随滚动看到。」
         *
         * 旧 rootMargin `-10% 0px -70% 0px` 把视口裁成「上 10% ~ 下 30%」的窄带
         * （即 y ∈ [10%, 30%] 才算"可见"）—— 标题必须爬到屏幕上方 1/3 才被认领。
         * 现在改为「上 10% ~ 下 0%」：标题只要出现在视口里（含最底部）就认领。
         * 上边仍留 10%，避免顶部被标题栏/工具栏遮住的那一小条被误判成"已进入"。
         */
        { rootMargin: "-10% 0px 0px 0px", threshold: 0 }
      );

      // 为每个标题元素设置 observer（不修改 DOM 属性）
      items.forEach((h) => {
        try {
          const dom = editorView.nodeDOM(h.pos);
          if (dom instanceof HTMLElement) {
            domToPos.set(dom, h.pos);
            newObserver.observe(dom);
          }
        } catch {
          // DOM 未就绪，跳过此节点
        }
      });

      observerRef.current = newObserver;
    });

    return () => cancelAnimationFrame(rafId);
  }, [editorView]);

  // 通过 ProseMirror dispatchTransaction 钩子监听文档变化
  // 替代 MutationObserver，避免 DOM 修改触发无限循环
  useEffect(() => {
    if (!editorView) return;

    const items = extractHeadings();
    const cleanupRaf = setupObserver(items);

    // 保存原始 dispatchTransaction
    const originalDispatch = editorView.dispatch.bind(editorView);

    // 防抖定时器
    let updateTimer: ReturnType<typeof setTimeout> | null = null;

    // 覆盖 dispatch，在每次事务后检查标题变化
    const patchedDispatch = (tr: any) => {
      originalDispatch(tr);
      // 仅文档变化时才重新提取标题
      if (tr.docChanged) {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = setTimeout(() => {
          const newItems = extractHeadings();
          setupObserver(newItems);
        }, 200);
      }
    };

    // 替换 dispatch
    editorView.dispatch = patchedDispatch;

    return () => {
      // 恢复原始 dispatch
      editorView.dispatch = originalDispatch;
      cleanupRaf?.();
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (updateTimer) clearTimeout(updateTimer);
    };
  }, [editorView, extractHeadings, setupObserver]);

  // 点击跳转到对应标题
  const handleClick = useCallback(
    (pos: number) => {
      if (!editorView) return;
      try {
        const dom = editorView.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
          dom.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } catch {
        // DOM 未就绪，忽略
      }
    },
    [editorView]
  );

  // 拖拽完成处理：通过 calculateDragTransaction 计算 transaction 并 dispatch
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      // v0.13.1 需求11：拖拽结束一律清掉幽灵与落点线（含 over 为空的中止情形）
      const endedAtListEnd = overEndRef.current;
      setActiveDrag(null);
      setDropLineY(null);
      setOverPos(null);
      setOverEnd(false);
      if (!editorView) return;

      const sourcePos = active.id as number;

      // v0.13.1 需求11：落点在列表末尾 → 目标取文档末尾（doc.content.size），
      // 这正是 calculateDragTransaction「拖到末尾」分支期待的入参。
      // 走这条几何分支时 dnd-kit 的 over 通常仍是最后一个可见行
      // （末尾占位条不是 droppable），因此不能直接用 over.id。
      let targetPos: number;
      if (endedAtListEnd) {
        targetPos = editorView.state.doc.content.size;
      } else if (over) {
        if (active.id === over.id) return;
        targetPos = over.id as number;
      } else {
        return;
      }

      if (targetPos === sourcePos) return;

      // 计算并 dispatch 拖拽产生的 transaction
      const tr = calculateDragTransaction(editorView.state, sourcePos, targetPos);
      if (tr) {
        editorView.dispatch(tr);
      }
    },
    [editorView]
  );

  /**
   * v0.13.1 需求11：拖拽开始 → 记录幽灵内容。
   * 用**标题文本**而不是复制整个行 DOM，幽灵才能干净地 portal 到 body
   * （绕开 `.outline-row` 的 `overflow:hidden` 裁剪）。
   */
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const pos = event.active.id as number;
      const h = headings.find((x) => x.pos === pos);
      setActiveDrag({ text: h?.text ?? "", level: h?.level ?? 1 });
    },
    [headings]
  );

  /**
   * v0.13.1 需求11：拖拽经过 → 计算落点插入线位置。
   *
   * 判据：指针在被悬停行的**上半部** → 插到它之前；下半部 → 插到它之后。
   * 用 `over.rect`（dnd-kit 提供的目标矩形）与指针位置比较，不依赖 DOM 测量，
   * 因此在 jsdom 下也能通过注入 rect 得到确定结果。
   */
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over, active } = event;
    const list = listRef.current;
    if (!over || !list || over.id === active.id) {
      setDropLineY(null);
      setOverPos(null);
      setOverEnd(false);
      overEndRef.current = false;
      return;
    }
    const rect = over.rect as { top: number; height: number; bottom?: number } | undefined;
    // over.rect 是视口坐标；换算到 .outline-list 内容坐标（加回 scrollTop）
    const listRect = list.getBoundingClientRect();
    const pointerY = (event.activatorEvent as MouseEvent | undefined)?.clientY;

    // v0.13.1 需求11：末尾判定。
    //
    // 判据用 `over.rect`（dnd-kit 量出的目标矩形）而**不是** DOM 测量：
    // 只有当「被悬停的行就是最后一个可见行」且「指针已越过它的下缘」时，
    // 才把落点记为文档末尾。这样既覆盖"拖到列表最下方"的真实场景，
    // 又不会在 jsdom（rect 全为 0）下把中间行的普通悬停误判成末尾。
    const isLastVisible = lastVisiblePosRef.current !== null && over.id === lastVisiblePosRef.current;
    if (isLastVisible && rect && typeof pointerY === "number" && pointerY > rect.top + rect.height) {
      setOverEnd(true);
      overEndRef.current = true;
      setOverPos(null);
      setDropLineY(rect.top + rect.height - listRect.top + list.scrollTop);
      return;
    }
    setOverEnd(false);
    overEndRef.current = false;

    const pos = over.id as number;
    setOverPos(pos);
    if (!rect) {
      setDropLineY(null);
      return;
    }
    const mid = rect.top + rect.height / 2;
    const after = typeof pointerY === "number" ? pointerY > mid : false;
    const edgeY = after ? rect.top + rect.height : rect.top;
    setDropLineY(edgeY - listRect.top + list.scrollTop);
  }, []);

  // v0.8.4 需求11 反馈4：清空按钮点击处理——清空关键字并把焦点交还输入框。
  // 保持焦点可避免清空后因失焦导致搜索框随即收起；与 ESC 的"清空 + 失焦"语义区分开。
  const handleClear = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, []);

  // v0.8.4 需求11：先按关键字过滤（大小写不敏感、包含匹配），再做 MAX_OUTLINE_ITEMS 截断
  // 顺序很重要——若先截断后过滤，位于前 100 条之外但命中的标题会丢失
  const normalizedQuery = query.trim().toLowerCase();
  const filteredHeadings = normalizedQuery
    ? headings.filter((h) => h.text.toLowerCase().includes(normalizedQuery))
    : headings;

  // v0.13.0 需求9：折叠可见性计算。
  // 关键顺序：**先过滤、再应用折叠、最后截断**——这样「搜到的标题一定显示」
  // （过滤优先于折叠，否则搜索不到内容比不折叠更难理解），且 MAX_OUTLINE_ITEMS
  // 的「还有 N 项」提示仍然基于过滤后的真实条数。
  const applyCollapse = shouldApplyCollapse(query);
  const visibleByPos = useMemo(
    () =>
      applyCollapse
        ? computeOutlineVisibility(
            filteredHeadings.map((h) => ({ pos: h.pos, level: h.level })),
            collapsed,
          )
        : null,
    [applyCollapse, filteredHeadings, collapsed],
  );
  const visibleHeadings = visibleByPos
    ? filteredHeadings.filter((h) => visibleByPos.get(h.pos) !== false)
    : filteredHeadings;

  // v0.13.0 返修（问题7）：**折叠的行保留在 DOM 中**（只加 .outline-hidden 收缩高度），
  // 这样才能做平滑的展开/收缩动画——直接从 DOM 摘掉节点是瞬时消失，无法过渡。
  // 渲染条数仍以 MAX_OUTLINE_ITEMS 为上限（正常情况与"可见条数"一致；
  // 仅当被折叠的子树占满前 1000 项时，才会把更靠后的可见项挤出，属可接受的极端边界）。
  const displayHeadings = filteredHeadings.length > MAX_OUTLINE_ITEMS
    ? filteredHeadings.slice(0, MAX_OUTLINE_ITEMS)
    : filteredHeadings;
  const hasMore = visibleHeadings.length > MAX_OUTLINE_ITEMS;

  // v0.13.0 需求9：可折叠判定基于**全部标题**（不是过滤后的）——
  // 否则搜索态下「有子级但子级被过滤掉」的标题会错误地失去箭头
  const allNodes = useMemo(
    () => headings.map((h) => ({ pos: h.pos, level: h.level })),
    [headings],
  );
  const collapsibleByPos = useMemo(() => {
    const map = new Map<number, boolean>();
    allNodes.forEach((n, i) => map.set(n.pos, canCollapse(allNodes, i)));
    return map;
  }, [allNodes]);

  // 折叠切换（纯函数产出新集合）
  const handleToggleCollapse = useCallback((pos: number) => {
    setCollapsed((prev) => toggleCollapsed(prev, pos));
  }, []);

  /**
   * v0.13.1 需求12：**大纲跟随文档滚动**——把当前活动标题滚进大纲列表的可视区。
   *
   * 缺陷背景（用户报告「阅读文档，右侧大纲也要跟随滚动到对应的标题位置下，
   * 当前问题是大纲没有跟随滚动」）：活动标题由 IntersectionObserver 算出来并
   * 高亮（`setActiveId`），但**从来没有人把大纲自己滚过去** —— 全文唯一的
   * `scrollIntoView` 用在"点击大纲跳正文"上，文档滚动时根本不调用。
   *
   * 守卫（必须，否则会与用户抢滚动或产生抖动）：
   * 1. 用户刚在大纲列表上滚动/按压过（~1200ms 内）→ 不打扰；
   * 2. 目标行已被折叠隐藏（`aria-hidden`）或被搜索过滤掉 → 不滚；
   * 3. 目标行**已经在大纲可视带内** → 不滚（避免每次微小变化都动）；
   * 4. 尊重 `prefers-reduced-motion`（改用 `behavior:"auto"`，大纲折叠动画已有同款先例）；
   * 5. jsdom 没有实现 `scrollIntoView` → 先探测函数存在，避免测试环境抛错；
   * 6. v0.13.2 需求7b：**刚恢复记忆位置后的宽限期内不跟随**（否则切回文档时
   *    大纲会自己滚一下，正是用户抱怨的现象）。
   */
  useEffect(() => {
    if (!activeId) return;
    const list = listRef.current;
    if (!list) return;
    if (Date.now() < restoreGraceUntilRef.current) return;
    if (Date.now() - userTouchedListAtRef.current < 1200) return;
    const row = list.querySelector<HTMLElement>(".outline-row.active");
    if (!row) return;
    if (row.getAttribute("aria-hidden") === "true") return;
    if (typeof row.scrollIntoView !== "function") return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const margin = 4;
    const fullyVisible =
      rowRect.top >= listRect.top + margin && rowRect.bottom <= listRect.bottom - margin;
    if (fullyVisible) return;
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      // 平滑滚动：用户明确要求"这个滚动动画实现要平滑"
      row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    } catch {
      /* 极端环境（无布局）下忽略 */
    }
  }, [activeId, headings]);

  /** v0.13.1 需求12：记录用户在大纲列表上的主动交互，短时间内不自动跟随。
   *
   * 用 **callback ref** 而不是 `useEffect([])`：`headings` 初始为空时组件会提前 return
   * （那时候根本还没有 `<nav className="outline-list">`），所以 `useEffect([])` 首次
   * 拿到的 `listRef.current` 是 null；等标题解析完、nav 真正挂载时该 effect 不会重跑
   * → 监听永远绑不上，"用户操作时不抢滚动"形同虚设（这是实测发现的问题）。
   * callback ref 在节点挂载/卸载时都会被调用，天然与"nav 何时出现"对齐。
   *
   * v0.13.2 需求7b：同一处再挂**滚动位置记忆**（写入 + 切文档时恢复）。
   * 记忆键用 ref 保存，避免 callback ref 因 docKey 变化而重新挂载节点。
   */
  const listCleanupRef = useRef<(() => void) | null>(null);
  const docKeyRef = useRef<string | null>(null);
  docKeyRef.current = docKey;
  const setListRef = useCallback((el: HTMLElement | null) => {
    listRef.current = el;
    listCleanupRef.current?.();
    listCleanupRef.current = null;
    if (!el) return;
    const mark = () => {
      userTouchedListAtRef.current = Date.now();
    };
    const onScroll = () => {
      // 用户主动滚动：记时间（抑制跟随）+ 记位置（下次切回来恢复）
      mark();
      setOutlineScroll(docKeyRef.current, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("pointerdown", mark);
    listCleanupRef.current = () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", mark);
      el.removeEventListener("pointerdown", mark);
    };
  }, []);
  useEffect(() => () => listCleanupRef.current?.(), []);

  /**
   * v0.13.2 需求7b：**文档切换后恢复大纲滚动位置**。
   *
   * 时机：`docKey` 变化 + 标题列表就绪后，双 rAF 等列表高度稳定再写 scrollTop
   * （标题渲染前 scrollHeight 不足，直接写会被浏览器钳到 0）。
   * 同时把 `restoreGraceUntilRef` 推到未来 —— 见该字段的注释。
   */
  const OUTLINE_RESTORE_GRACE_MS = 600;
  useEffect(() => {
    const list = listRef.current;
    if (!list || !docKey) return;
    const saved = getOutlineScroll(docKey);
    if (saved === null) return;
    restoreGraceUntilRef.current = Date.now() + OUTLINE_RESTORE_GRACE_MS;
    // 标记"恢复中"，避免跟随逻辑在恢复的同一帧里又把它滚走
    userTouchedListAtRef.current = Date.now();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = listRef.current;
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(saved, max);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // headings.length 参与依赖：标题解析完成（列表高度稳定）后才恢复
  }, [docKey, headings.length]);

  // sortable items id 数组（用 pos 作为 id）
  //
  // v0.13.1 需求11：**排除被折叠隐藏的行**。
  // 旧实现取的是 `displayHeadings`（含折叠隐藏行，它们 max-height:0 + visibility:hidden
  // 但仍留在 DOM 里），于是拖拽可能落到一个**看不见**的目标上，用户完全无法预期。
  const sortableItems = useMemo(
    () => visibleHeadings.map((h) => h.pos),
    [visibleHeadings],
  );

  // v0.13.1 需求11：末尾落点的判定锚点——最后一个**可见**行的 pos。
  // 悬停到它且指针越过其下缘时，落点才算文档末尾。
  lastVisiblePosRef.current =
    visibleHeadings.length > 0 ? visibleHeadings[visibleHeadings.length - 1].pos : null;

  if (headings.length === 0) {
    return (
      <div className="outline">
        <div className="outline-header">
          <span className="outline-title">{t("outline.title")}</span>
        </div>
        <div className="outline-empty">{t("outline.empty")}</div>
      </div>
    );
  }

  // 所有模式均用 DndContext + SortableContext 包装（支持拖拽排序）
  // v0.8.4：过滤态（dragActive=false）不渲染 DndContext，手柄不渲染，仅保留点击跳转
  const listContent = (
    <>
      {displayHeadings.map((h) => (
        <SortableHeadingItem
          key={h.id}
          heading={h}
          activeId={activeId}
          draggable={dragActive}
          collapsible={collapsibleByPos.get(h.pos) === true}
          collapsed={collapsed.has(h.pos)}
          hidden={visibleByPos ? visibleByPos.get(h.pos) === false : false}
          isOverTarget={overPos === h.pos}
          collapseLabel={t("outline.collapse")}
          expandLabel={t("outline.expand")}
          onToggleCollapse={handleToggleCollapse}
          onClick={handleClick}
        />
      ))}
      {hasMore && (
        <div className="outline-more">{t("outline.more", { count: visibleHeadings.length - MAX_OUTLINE_ITEMS })}</div>
      )}
      {/* v0.13.1 需求11：列表末尾落点。旧实现没有任何东西能让"拖到最末"可达，
          `calculateDragTransaction` 的末尾分支（targetPos = doc.content.size）因此
          永远走不到。这里给出可见的末尾落点条；判定与提交见 handleDragOver /
          handleDragEnd。仅在可拖拽时渲染，避免过滤态留下无意义的提示。 */}
      {dragActive && (
        <div
          className={`outline-end-drop ${overEnd ? "over" : ""}`}
          data-testid="outline-end-drop"
        >
          <span className="outline-end-drop-label">{t("outline.dropHere")}</span>
        </div>
      )}
      {/* v0.8.4 需求11：过滤后无匹配标题的空态提示 */}
      {hasQuery && filteredHeadings.length === 0 && (
        <div className="outline-search-empty">{t("outline.searchEmpty")}</div>
      )}
    </>
  );

  return (
    <div
      className="outline"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="outline-header">
        <span className="outline-title">{t("outline.title")}</span>
        {/* v0.8.4 需求11 反馈3：搜索框内联到标题栏——位于标题右侧、计数左侧，单行布局。
            显隐由 CSS 宽度/透明度过渡控制（见 Outline.css），收起时不占布局，避免挤压标题与计数。 */}
        <div className={`outline-search${searchVisible ? " visible" : ""}`}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={t("outline.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(e) => {
              // ESC：清空关键字并失焦（失焦后若无 hover 随之收起）
              if (e.key === "Escape") {
                setQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {/* v0.8.4 需求11 反馈4：仅当有关键字时渲染的清空按钮，点击清空并保持焦点 */}
          {hasQuery && (
            <button
              type="button"
              className="outline-search-clear"
              aria-label={t("outline.searchClear")}
              title={t("outline.searchClear")}
              onClick={handleClear}
            >
              ×
            </button>
          )}
        </div>
        {/* v0.8.4 需求11：计数保持文档标题总数，不随过滤变化（总数反映文档结构） */}
        <span className="outline-count">{headings.length}</span>
      </div>
      <nav className="outline-list" ref={setListRef}>
        {/* v0.13.1 需求11：落点插入线。绝对定位于 .outline-list（已 position:relative），
            因此不受 .outline-row 的 max-height/overflow:hidden 裁剪 —— 那正是旧实现
            "拖出约 ±30px 就看不见落点"的根因。 */}
        {dropLineY !== null && (
          <div
            className="outline-drop-indicator"
            style={{ top: `${dropLineY}px` }}
            data-testid="outline-drop-indicator"
          />
        )}
        {dragActive ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragEnd}
          >
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {listContent}
            </SortableContext>
            {/* v0.13.1 需求11：跟随光标的**实心幽灵**。DragOverlay 由 dnd-kit portal 到
                body，绕开两处 overflow 裁剪；启用后 dnd-kit 也不再 transform 源项，
                因此"拖动的标题"全程可见，背景目录也不发灰。 */}
            <DragOverlay dropAnimation={null}>
              {activeDrag ? (
                <div
                  className="outline-drag-ghost"
                  data-testid="outline-drag-ghost"
                  style={{ paddingLeft: `${(activeDrag.level - 1) * 14 + 10}px` }}
                >
                  {activeDrag.text}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          listContent
        )}
      </nav>
      {dragActive && (
        <div className="outline-drag-hint">{t("outline.dragHint")}</div>
      )}
    </div>
  );
}
