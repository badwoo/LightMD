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
 */
import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties } from "react";
import type { EditorView } from "prosemirror-view";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
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

/** 大纲最大渲染数量，超出时只显示前 MAX_OUTLINE_ITEMS 项 */
const MAX_OUTLINE_ITEMS = 100;

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

/** 可排序标题项（包装 useSortable） */
function SortableHeadingItem({
  heading,
  activeId,
  draggable,
  onClick,
}: {
  heading: HeadingItem;
  activeId: string | null;
  draggable: boolean;
  onClick: (pos: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: heading.pos, disabled: !draggable });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1, // 拖拽时半透明预览
    paddingLeft: `${(heading.level - 1) * 14 + 12}px`,
  };

  return (
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
  );
}

export function Outline({ editorView }: OutlineProps) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // 缓存上一次的标题列表，避免内容未变时重复更新
  const lastHeadingsRef = useRef<string>("");
  const t = useT();

  // 所有模式启用拖拽（v0.3.0 修复：阅读模式下也支持大纲拖拽排序）
  // editorView.dispatch 不依赖于 contenteditable，可直接修改文档 state
  const dragEnabled = true;

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
    const key = items.map((h) => `${h.pos}:${h.text}`).join("|");
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
        { rootMargin: "-10% 0px -70% 0px", threshold: 0 }
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
      if (!over || !editorView) return;
      if (active.id === over.id) return;

      const sourcePos = active.id as number;
      const targetPos = over.id as number;

      // 计算并 dispatch 拖拽产生的 transaction
      const tr = calculateDragTransaction(editorView.state, sourcePos, targetPos);
      if (tr) {
        editorView.dispatch(tr);
      }
    },
    [editorView]
  );

  // 限制渲染数量
  const displayHeadings = headings.length > MAX_OUTLINE_ITEMS
    ? headings.slice(0, MAX_OUTLINE_ITEMS)
    : headings;
  const hasMore = headings.length > MAX_OUTLINE_ITEMS;

  // sortable items id 数组（用 pos 作为 id）
  const sortableItems = useMemo(
    () => displayHeadings.map((h) => h.pos),
    [displayHeadings],
  );

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
  const listContent = (
    <>
      {displayHeadings.map((h) => (
        <SortableHeadingItem
          key={h.id}
          heading={h}
          activeId={activeId}
          draggable={dragEnabled}
          onClick={handleClick}
        />
      ))}
      {hasMore && (
        <div className="outline-more">{t("outline.more", { count: headings.length - MAX_OUTLINE_ITEMS })}</div>
      )}
    </>
  );

  return (
    <div className="outline">
      <div className="outline-header">
        <span className="outline-title">{t("outline.title")}</span>
        <span className="outline-count">{headings.length}</span>
      </div>
      <nav className="outline-list">
        {dragEnabled ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {listContent}
            </SortableContext>
          </DndContext>
        ) : (
          listContent
        )}
      </nav>
      {dragEnabled && (
        <div className="outline-drag-hint">{t("outline.dragHint")}</div>
      )}
    </div>
  );
}
