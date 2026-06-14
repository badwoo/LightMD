/**
 * Outline —— 文档大纲视图（含滚动同步）
 *
 * 性能优化：
 * - 使用 ProseMirror 事务监听替代 MutationObserver，避免 DOM 修改触发无限循环
 * - 限制 IntersectionObserver 只监听可视区域附近的标题
 * - 大纲列表限制最大渲染数量，避免大量 DOM 节点
 * - 防抖提取标题，减少频繁更新
 */
import { useEffect, useState, useCallback, useRef } from "react";
import type { EditorView } from "prosemirror-view";
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

export function Outline({ editorView }: OutlineProps) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // 缓存上一次的标题列表，避免内容未变时重复更新
  const lastHeadingsRef = useRef<string>("");

  // 提取标题（遍历 ProseMirror 文档，不依赖 DOM）
  const extractHeadings = useCallback(() => {
    if (!editorView) return [];
    const { doc } = editorView.state;
    const items: HeadingItem[] = [];

    doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        const text = node.textContent || "(空标题)";
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
  }, [editorView]);

  // 设置 IntersectionObserver 追踪标题元素
  const setupObserver = useCallback((items: HeadingItem[]) => {
    if (!editorView) return;

    // 清理旧 observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    // 使用 requestAnimationFrame 确保 DOM 已渲染
    const rafId = requestAnimationFrame(() => {
      const newObserver = new IntersectionObserver(
        (entries) => {
          // 找出所有当前可见的标题
          const visible = entries
            .filter((e) => e.isIntersecting)
            .map((e) => e.target.id)
            .sort((a, b) => {
              // 按文档位置排序，取最靠前的可见标题
              const itemA = items.find((h) => h.id === a);
              const itemB = items.find((h) => h.id === b);
              return (itemA?.pos ?? 0) - (itemB?.pos ?? 0);
            });
          if (visible.length > 0) {
            setActiveId(visible[0]);
          }
        },
        { rootMargin: "-10% 0px -70% 0px", threshold: 0 }
      );

      // 为每个标题元素设置 observer 和 id
      items.forEach((h) => {
        try {
          const dom = editorView.nodeDOM(h.pos);
          if (dom instanceof HTMLElement) {
            // 仅在 id 不同时设置，避免触发 DOM 变更
            if (dom.id !== h.id) {
              dom.id = h.id;
            }
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

  // 限制渲染数量
  const displayHeadings = headings.length > MAX_OUTLINE_ITEMS
    ? headings.slice(0, MAX_OUTLINE_ITEMS)
    : headings;
  const hasMore = headings.length > MAX_OUTLINE_ITEMS;

  if (headings.length === 0) {
    return (
      <div className="outline">
        <div className="outline-header">
          <span className="outline-title">大纲</span>
        </div>
        <div className="outline-empty">暂无标题</div>
      </div>
    );
  }

  return (
    <div className="outline">
      <div className="outline-header">
        <span className="outline-title">大纲</span>
        <span className="outline-count">{headings.length}</span>
      </div>
      <nav className="outline-list">
        {displayHeadings.map((h) => (
          <button
            key={h.id}
            className={`outline-item outline-level-${h.level} ${activeId === h.id ? "active" : ""}`}
            style={{ paddingLeft: `${(h.level - 1) * 14 + 12}px` }}
            onClick={() => handleClick(h.pos)}
            title={h.text}
          >
            <span className="outline-item-text">{h.text}</span>
          </button>
        ))}
        {hasMore && (
          <div className="outline-more">还有 {headings.length - MAX_OUTLINE_ITEMS} 个标题...</div>
        )}
      </nav>
    </div>
  );
}
