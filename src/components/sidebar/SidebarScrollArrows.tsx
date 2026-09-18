/**
 * SidebarScrollArrows —— WP4 需求9：侧栏溢出时的浮动上下滚动箭头
 *
 * 渲染于 .filetree（position:relative）内、统一滚动容器 .filetree-scroll 之上：
 * - 仅当侧栏 hover（.filetree:hover）且内容可滚动时，上下箭头隐约呼吸闪动；
 * - 点击箭头平滑滚动 ±200px；在箭头处滚轮则转发到底层滚动容器；
 * - 使用已备好的 i18n 键 sidebar.scrollUp / sidebar.scrollDown（useT 同组件树）。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";

/** 纯函数：是否显示"向上"箭头（未到顶） */
export function canShowUp(scrollTop: number): boolean {
  return scrollTop > 0;
}

/** 纯函数：是否显示"向下"箭头（未到底） */
export function canShowDown(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollTop + clientHeight < scrollHeight - 1;
}

interface SidebarScrollArrowsProps {
  /** 统一滚动容器的 ref（箭头以该层为滚动目标） */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** 单次滚动距离（px） */
  step?: number;
}

export function SidebarScrollArrows({ scrollRef, step = 200 }: SidebarScrollArrowsProps) {
  const t = useT();
  const [showUp, setShowUp] = useState(false);
  const [showDown, setShowDown] = useState(false);
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);

  // 监听滚动容器，更新箭头显隐
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setShowUp(canShowUp(el.scrollTop));
      setShowDown(canShowDown(el.scrollTop, el.clientHeight, el.scrollHeight));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef]);

  // 箭头处滚轮转发（非被动监听，确保 preventDefault 生效）
  useEffect(() => {
    const attach = (el: HTMLButtonElement | null, dir: number) => {
      if (!el) return () => {};
      const handler = (e: WheelEvent) => {
        e.preventDefault();
        const d = Math.sign(e.deltaY || dir) * step;
        scrollRef.current?.scrollBy({ top: d, behavior: "auto" });
      };
      el.addEventListener("wheel", handler, { passive: false });
      return () => el.removeEventListener("wheel", handler);
    };
    const c1 = attach(upRef.current, -1);
    const c2 = attach(downRef.current, 1);
    return () => {
      c1();
      c2();
    };
  }, [showUp, showDown, scrollRef, step]);

  const scrollByStep = (dir: number) => {
    scrollRef.current?.scrollBy({ top: dir * step, behavior: "smooth" });
  };

  return (
    <>
      {showUp && (
        <button
          ref={upRef}
          type="button"
          className="sidebar-scroll-arrow sidebar-scroll-arrow-up"
          title={t("sidebar.scrollUp")}
          aria-label={t("sidebar.scrollUp")}
          onClick={() => scrollByStep(-1)}
        >
          ▲
        </button>
      )}
      {showDown && (
        <button
          ref={downRef}
          type="button"
          className="sidebar-scroll-arrow sidebar-scroll-arrow-down"
          title={t("sidebar.scrollDown")}
          aria-label={t("sidebar.scrollDown")}
          onClick={() => scrollByStep(1)}
        >
          ▼
        </button>
      )}
    </>
  );
}
