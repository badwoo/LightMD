/**
 * TabBar —— 多标签页栏组件
 *
 * 设计：
 * - 水平排列的标签栏，位于编辑区上方
 * - 每个标签显示文件名、脏标记（●）、关闭按钮（×）
 * - 激活标签高亮，非激活标签可点击切换
 * - v0.8.0 WP3：
 *   - 需求5：标签溢出时左右滚动按钮 + 滚轮滚动（.tab-bar-scroll 持有标签）
 *   - 需求2：标签栏空白区双击新建临时文件（守卫 target === currentTarget）
 *   - 需求8：右键菜单扩展（重命名/固定/打印/另存为/批量关闭）
 */
import { useCallback, useState, useEffect, useRef } from "react";
import { useEditorStore, type TabInfo } from "../../stores/useEditorStore";
// v0.8.0 WP2 需求1：标签右键"复制"（配合左侧文件夹的 Ctrl+V）
import { setClipboard } from "../../utils/fileClipboard";
// v0.8.0 修复 P3：标签拖拽到左侧文件夹改用自制鼠标拖拽（HTML5 DnD 被 Tauri 拦截）
import { beginFileDrag } from "../../utils/fileDragMouse";
import { useT } from "../../i18n";
import { fileService } from "../../services/fileService";
import {
  hasOverflow,
  isAtStart,
  isAtEnd,
  normalizeWheelDelta,
  clampScrollLeft,
  computeSmoothedScroll,
  computeScrollToReveal,
} from "../../services/tabScroll";
import {
  computeCloseIndices,
  countDirtyTabs,
  type BatchCloseAction,
} from "../../services/tabClose";
import { renameFile as renameFileOnDisk } from "../../services/renameService";
import "./TabBar.css";

interface TabBarProps {
  onTabSwitch?: (tab: TabInfo) => void;
  onTabClose?: (tab: TabInfo, idx: number) => void;
  onSaveAs?: (tab: TabInfo) => void;
  onCloseMany?: (indices: number[]) => void;
  /**
   * v0.8.0 修复 P2：标签栏空白处双击新建临时文件。
   * 由 App 提供（创建标签的同时同步 content/filePath/forceUpdateKey），
   * 否则新标签既不会跳转也无法编辑。
   */
  onNewUntitled?: () => void;
  /**
   * v0.9.0 WP2：把该标签移动到新窗口（真实文件带 dirty 时由 App 负责先提示保存）。
   */
  onMoveToNewWindow?: (tab: TabInfo, idx: number) => void;
  /**
   * v0.9.0 第四轮（问题2）：标签被拖出标签栏松手时的入口（优先于
   * `onMoveToNewWindow`）。App 据此判断落点是否在**另一个窗口的标签栏**上：
   * 是主窗口 → 询问「是否合并回主窗口」；否则回退到「移动到新窗口」。
   */
  onTabDropOutside?: (tab: TabInfo, idx: number) => void;
}

export function TabBar({
  onTabSwitch,
  onTabClose,
  onSaveAs,
  onCloseMany,
  onNewUntitled,
  onMoveToNewWindow,
  onTabDropOutside,
}: TabBarProps) {
  const t = useT();
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeTabIdx = useEditorStore((s) => s.activeTabIdx);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const togglePin = useEditorStore((s) => s.togglePin);
  const renameUntitledTab = useEditorStore((s) => s.renameUntitledTab);
  const createUntitledTab = useEditorStore((s) => s.createUntitledTab);
  const getTabById = useEditorStore((s) => s.getTabById);
  const getTabByPath = useEditorStore((s) => s.getTabByPath);

  // 右键菜单位置与目标 tab
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null);
  // 滚动容器引用
  const scrollRef = useRef<HTMLDivElement>(null);
  // v0.8.0 修复 P5-1：溢出即同时显示 < > 两个按钮，到边界改为禁用态
  const [scrollState, setScrollState] = useState({ overflow: false, atStart: true, atEnd: true });

  // 根据滚动状态更新按钮显隐（值未变化时返回原对象，避免滚动过程中频繁重渲染）
  const updateScrollButtons = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = {
      overflow: hasOverflow(el.clientWidth, el.scrollWidth),
      atStart: isAtStart(el.scrollLeft),
      atEnd: isAtEnd(el.scrollLeft, el.clientWidth, el.scrollWidth),
    };
    setScrollState((prev) =>
      prev.overflow === next.overflow && prev.atStart === next.atStart && prev.atEnd === next.atEnd
        ? prev
        : next,
    );
  }, []);

  // 标签数量变化 / 初次渲染时重新计算按钮显隐
  useEffect(() => {
    updateScrollButtons();
  }, [openTabs, updateScrollButtons]);

  // v0.8.0 修复 P5-2：本组件在 openTabs.length === 0 时 return null（不渲染滚动容器），
  // 若挂载依赖为 []，首次挂载时 scrollRef.current 为 null → 监听永远不会被绑上，
  // 之后打开标签滚轮/ResizeObserver 全部失效。改为依赖"是否有标签"。
  const hasTabs = openTabs.length > 0;

  // 滚动事件 + ResizeObserver 驱动按钮显隐
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollButtons);
    const ro = new ResizeObserver(updateScrollButtons);
    ro.observe(el);
    updateScrollButtons();
    return () => {
      el.removeEventListener("scroll", updateScrollButtons);
      ro.disconnect();
    };
  }, [hasTabs, updateScrollButtons]);

  // ── v0.8.0 修复 P12-2：滚轮平滑滚动 ──
  // 旧实现每个 wheel 事件直接 el.scrollLeft += deltaY：① 增量未归一化，
  // deltaMode=行 的设备每格只滚 3px，手感很涩；② 瞬时赋值叠加后视觉生硬。
  // 现改为"累计目标位置 + 单个 rAF 循环指数逼近"：
  // - 只在动画期间有一个 rAF 循环，到达目标立即停止（无定时器、无 React 重渲染）；
  // - 滚轮连续触发时只更新目标值，不新建循环，开销与事件频率无关。
  const wheelTargetRef = useRef(0);
  const wheelRafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const step = () => {
      const next = computeSmoothedScroll(el.scrollLeft, wheelTargetRef.current);
      el.scrollLeft = next;
      if (next === wheelTargetRef.current) {
        wheelRafRef.current = null; // 已到目标，结束动画
        return;
      }
      wheelRafRef.current = requestAnimationFrame(step);
    };

    const onWheel = (e: WheelEvent) => {
      // 无溢出时不接管滚轮，避免影响其它滚动容器
      if (e.deltaY === 0 || !hasOverflow(el.clientWidth, el.scrollWidth)) return;
      e.preventDefault();
      const delta = normalizeWheelDelta(e.deltaY, e.deltaMode, 16, el.clientHeight);
      // 动画未进行时以当前位置为基准，避免继承上一次动画的陈旧目标
      if (wheelRafRef.current === null) wheelTargetRef.current = el.scrollLeft;
      wheelTargetRef.current = clampScrollLeft(
        wheelTargetRef.current + delta,
        el.clientWidth,
        el.scrollWidth,
      );
      if (wheelRafRef.current === null) wheelRafRef.current = requestAnimationFrame(step);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelRafRef.current !== null) {
        cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
    };
  }, [hasTabs]);

  // ── v0.8.0 修复 P12-3：活跃标签自动滚入可视区 ──
  // 覆盖"打开新文档 / 切换标签 / 新建临时文件"（都会改变 activeTabIdx）。
  // 已完全可见时不滚动，避免无意义的视口抖动。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || openTabs.length === 0) return;
    const item = el.querySelectorAll<HTMLElement>(".tab-item")[activeTabIdx];
    if (!item) return;
    const target = computeScrollToReveal(
      item.offsetLeft,
      item.offsetWidth,
      el.scrollLeft,
      el.clientWidth,
      el.scrollWidth,
    );
    if (target === null) return;
    // 与滚轮动画共用目标：先停掉在途动画，避免两套滚动互相打架
    if (wheelRafRef.current !== null) {
      cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
    }
    wheelTargetRef.current = target;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ left: target, behavior: "smooth" });
    } else {
      el.scrollLeft = target;
    }
  }, [activeTabIdx, openTabs.length]);

  const handleTabClick = useCallback((idx: number) => {
    if (idx === activeTabIdx) return;
    // 不在此处调用 setActiveTab，由 handleTabSwitch 统一处理
    const tab = openTabs[idx];
    if (tab) onTabSwitch?.(tab);
  }, [activeTabIdx, openTabs, onTabSwitch]);

  const handleClose = useCallback((e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const tab = openTabs[idx];
    if (tab) onTabClose?.(tab, idx);
  }, [openTabs, onTabClose]);

  // tab-item 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, tab: TabInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, tab });
  }, []);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  // 需求2：标签栏空白区双击新建临时文件。
  // 守卫 e.target === e.currentTarget：只有点在滚动容器自身（空白）才触发，
  // 点在实际标签（子元素）上不会误触发新建。
  const handleBarDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    // v0.8.0 修复 P2：优先走 App 回调（同步编辑器上下文，新建后立即跳转且可编辑）；
    // 无回调时退化为仅更新 store（浏览器/单测场景）
    if (onNewUntitled) {
      onNewUntitled();
      return;
    }
    createUntitledTab();
  }, [createUntitledTab, onNewUntitled]);

  // 左右滚动按钮（v0.8.0 修复 P11-3）：
  // - 普通点击：按"一个标签"为单位滚动（滚到相邻标签的左边缘），不再翻整页；
  // - Shift+点击：直达第一个 / 最后一个标签位置（仅滚动定位，不切换活跃标签）。
  const scrollByOneTab = useCallback((dir: -1 | 1, shift: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (shift) {
      el.scrollTo({ left: dir < 0 ? 0 : el.scrollWidth, behavior: "smooth" });
      return;
    }
    const items = Array.from(el.querySelectorAll<HTMLElement>(".tab-item"));
    if (items.length === 0) return;
    const current = el.scrollLeft;
    if (dir > 0) {
      // 向右：视口左边界右侧的第一个标签 → 滚到它的左边缘
      const next = items.find((it) => it.offsetLeft > current + 1);
      el.scrollTo({ left: next ? next.offsetLeft : el.scrollWidth, behavior: "smooth" });
    } else {
      // 向左：视口左边界左侧的最近一个标签 → 滚到它的左边缘
      const prevItems = items.filter((it) => it.offsetLeft < current - 1);
      const prev = prevItems.length > 0 ? prevItems[prevItems.length - 1] : undefined;
      el.scrollTo({ left: prev ? prev.offsetLeft : 0, behavior: "smooth" });
    }
  }, []);

  // ─── 菜单动作 ────────────────────────────────────────
  const resolveIdx = useCallback((tab: TabInfo): number =>
    tab.isUntitled && tab.id ? getTabById(tab.id) : getTabByPath(tab.path),
    [getTabById, getTabByPath]
  );

  // 切换到目标标签（先 setActiveTab 再走 onTabSwitch 同步内容与 filePath，保证上下文一致）
  const switchTo = useCallback((tab: TabInfo) => {
    const idx = resolveIdx(tab);
    if (idx !== -1) setActiveTab(idx);
    onTabSwitch?.(tab);
  }, [resolveIdx, setActiveTab, onTabSwitch]);

  const onRename = useCallback((tab: TabInfo) => {
    const name = window.prompt(t("tabbar.rename") + ":", tab.name);
    if (!name || !name.trim()) { setCtxMenu(null); return; }
    const newName = name.trim();
    switchTo(tab);
    const idx = resolveIdx(tab);
    if (tab.isUntitled) {
      if (idx !== -1) renameUntitledTab(idx, newName);
    } else {
      // 磁盘文件：走 renameService（重命名 + 同步收藏/最近/标签页）
      renameFileOnDisk(tab.path, newName);
    }
    setCtxMenu(null);
  }, [t, switchTo, resolveIdx, renameUntitledTab]);

  const onTogglePin = useCallback((tab: TabInfo) => {
    const idx = resolveIdx(tab);
    if (idx !== -1) togglePin(idx);
    setCtxMenu(null);
  }, [resolveIdx, togglePin]);

  const onPrint = useCallback((tab: TabInfo) => {
    // v0.8.0 修复 P1-8：旧实现 switchTo(tab) 后**同步** window.print()——
    // React 尚未重渲染，打印的是上一个标签的内容；且编辑/分屏模式下只会
    // 打印被截断的 textarea。现改为：切标签 + 强制阅读模式 + 等渲染完成
    // （双重 rAF）后再调用 print()。@media print 样式只输出正文。
    switchTo(tab);
    setCtxMenu(null);
    useEditorStore.getState().setViewMode("preview");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print());
    });
  }, [switchTo]);

  const onSaveAsClick = useCallback((tab: TabInfo) => {
    switchTo(tab);
    setCtxMenu(null);
    onSaveAs?.(tab);
  }, [switchTo, onSaveAs]);

  const onBatchClose = useCallback((tab: TabInfo, action: BatchCloseAction) => {
    const idx = resolveIdx(tab);
    if (idx === -1) { setCtxMenu(null); return; }
    const indices = computeCloseIndices(openTabs, idx, action);
    if (indices.length === 0) { setCtxMenu(null); return; }
    // 未保存标签汇总确认一次（避免连环弹窗）
    const dirty = countDirtyTabs(openTabs, indices);
    if (dirty > 0) {
      const ok = window.confirm(t("tabbar.confirmCloseMany", { count: dirty }));
      if (!ok) { setCtxMenu(null); return; }
    }
    onCloseMany?.(indices);
    setCtxMenu(null);
  }, [openTabs, resolveIdx, onCloseMany, t]);

  // 标题栏快照入口：用当前活跃标签的 filePath
  const handleSnapshotBtnClick = useCallback(() => {
    const activeTab = openTabs[activeTabIdx];
    if (activeTab) {
      window.dispatchEvent(
        new CustomEvent("lightmd:showSnapshotDialog", {
          detail: { filePath: activeTab.path },
        })
      );
    }
  }, [openTabs, activeTabIdx]);

  /**
   * v0.9.0 第三轮（需求2）：拖拽指针是否已离开「标签栏 + 侧栏」区域。
   * 在标签栏内松手 = 取消（避免与"拖到文件夹"手势歧义）；在侧栏内松手保持
   * 原语义（命中文件夹 = 复制/移动文件，落不到文件夹 = 取消）；只有拖到
   * 标签栏与侧栏之外（编辑区/大纲/窗口外）松手才构成「撕下标签 → 新窗口」。
   */
  const isOutsideTabArea = useCallback((x: number, y: number) => {
    const bar = scrollRef.current?.getBoundingClientRect();
    if (!bar) return false;
    if (x >= bar.left && x <= bar.right && y >= bar.top && y <= bar.bottom) return false;
    const hit =
      typeof document !== "undefined" && typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(x, y)
        : null;
    return !(hit && typeof hit.closest === "function" && hit.closest(".app-sidebar"));
  }, []);

  if (openTabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {/* 需求5：滚动容器持有标签，overflow 在此层；dblclick 守卫空白区新建 */}
      <div
        className="tab-bar-scroll"
        ref={scrollRef}
        onDoubleClick={handleBarDoubleClick}
      >
        {openTabs.map((tab, idx) => (
          <div
            key={`${tab.path}-${tab.id ?? ""}-${idx}`}
            className={`tab-item ${idx === activeTabIdx ? "tab-active" : ""} ${tab.pinned ? "tab-pinned" : ""}`}
            onClick={() => handleTabClick(idx)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
            // v0.8.0 修复 P3：按下标签即启动自制拖拽（拖到左侧已打开文件夹；默认复制 / Shift 移动）
            // v0.9.0 第三轮（需求2）：所有标签（含未落盘临时标签）都支持「拖出标签栏 →
            // 移动到新窗口」（浏览器式"撕下标签"手势）；临时标签无磁盘路径，
            // 不能投放文件夹（canDrop 恒拒），只走拖出分支。
            onMouseDown={(e) => {
              const isUntitled = !tab.path;
              beginFileDrag({ path: tab.path ?? "", name: tab.name }, e, {
                canDrop: isUntitled ? () => false : undefined,
                isOutsideSourceArea: isOutsideTabArea,
                outsideHint: t("multiwindow.dragOutsideHint"),
                onDrop: (payload, targetDir, mode) => {
                  // 跨组件解耦：由 FileTree 监听并执行真实文件传输
                  window.dispatchEvent(
                    new CustomEvent("lightmd:fileDrop", {
                      detail: { srcPath: payload.path, targetDir, mode },
                    }),
                  );
                },
                // 拖出标签栏松手 → 把该标签移动到新窗口（落点时重新定位下标）
                onDropOutsideSource: () => {
                  if (!onTabDropOutside && !onMoveToNewWindow) return;
                  const st = useEditorStore.getState();
                  const i = st.openTabs.findIndex((x) =>
                    tab.isUntitled && tab.id ? x.id === tab.id : x.path === tab.path,
                  );
                  const targetIdx = i === -1 ? st.activeTabIdx : i;
                  // v0.9.0 第四轮（问题2）：交由 App 判定落点——若松手时标签压在
                  // 另一个窗口（尤其是主窗口）的标签栏上 → 询问「合并回主窗口」；
                  // 否则维持「移动到新窗口」。
                  if (onTabDropOutside) onTabDropOutside(tab, targetIdx);
                  else onMoveToNewWindow?.(tab, targetIdx);
                },
              });
            }}
            title={tab.path}
          >
            {/* v0.8.0 修复 P8-1：固定标签在右上角显示小图钉（固定时不渲染关闭按钮，此处不遮挡）。
                v0.8.0 修复 P11-9：图钉本身可点击 → 取消固定；阻挡冒泡避免触发标签切换/拖拽 */}
            {tab.pinned && (
              <button
                className="tab-pin"
                title={t("tabbar.unpin")}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(idx);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.2 1.4l5.4 5.4-.9.9-1.6-.2-2.6 2.6.2 1.9-1 1-3-3-3.3 3.3-.9-.9L4.8 9.1l-3-3 1-1 1.9.2 2.6-2.6-.2-1.6z" />
                </svg>
              </button>
            )}
            <span className="tab-name" title={tab.path}>
              {tab.name}
            </span>
            {tab.isDirty && <span className="tab-dirty">●</span>}
            {/* 固定标签不显示关闭按钮（防误关，需先取消固定或用菜单） */}
            {!tab.pinned && (
              <button
                className="tab-close"
                onClick={(e) => handleClose(e, idx)}
                title={t("tabbar.close")}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {/* 需求5 问题1：标签铺满（溢出）后，在标签区最右侧成对显示 < > 两个滚动按钮；
          Shift+点击左按钮跳首个标签、Shift+点击右按钮跳最后一个（仅滚动定位） */}
      {scrollState.overflow && (
        <div className="tab-scroll-btns">
          <button
            className="tab-scroll-btn left"
            disabled={scrollState.atStart}
            title={t("tabbar.scrollLeft")}
            onClick={(e) => scrollByOneTab(-1, e.shiftKey)}
          >
            ‹
          </button>
          <button
            className="tab-scroll-btn right"
            disabled={scrollState.atEnd}
            title={t("tabbar.scrollRight")}
            onClick={(e) => scrollByOneTab(1, e.shiftKey)}
          >
            ›
          </button>
        </div>
      )}
      {/* 标题栏快照入口图标 */}
      <button
        className="tab-bar-snapshot-btn"
        onClick={handleSnapshotBtnClick}
        title={t("snapshot.viewSnapshots")}
      >
        🕐
      </button>
      {/* 右键菜单 */}
      {ctxMenu && (
        <div
          className="tabbar-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => onRename(ctxMenu.tab)}>
            {t("tabbar.rename")}
          </button>
          <button className="context-menu-item" onClick={() => onTogglePin(ctxMenu.tab)}>
            {ctxMenu.tab.pinned ? t("tabbar.unpin") : t("tabbar.pin")}
          </button>
          <button className="context-menu-item" onClick={() => onPrint(ctxMenu.tab)}>
            {t("tabbar.print")}
          </button>
          <button className="context-menu-item" onClick={() => onSaveAsClick(ctxMenu.tab)}>
            {t("tabbar.saveAs")}
          </button>
          {/* v0.9.0 WP2：移动到新窗口 */}
          {onMoveToNewWindow && (
            <>
              <div className="context-menu-sep" />
              <button
                className="context-menu-item"
                data-testid="tab-context-move-to-new-window"
                onClick={() => {
                  const tab = ctxMenu.tab;
                  const idx = useEditorStore.getState().openTabs.findIndex((x) =>
                    tab.isUntitled && tab.id ? x.id === tab.id : x.path === tab.path,
                  );
                  setCtxMenu(null);
                  onMoveToNewWindow(tab, idx === -1 ? useEditorStore.getState().activeTabIdx : idx);
                }}
              >
                {t("multiwindow.moveToNewWindow")}
              </button>
            </>
          )}
          <div className="context-menu-sep" />
          <button
            className="context-menu-item"
            onClick={() => onBatchClose(ctxMenu.tab, "others")}
          >
            {t("tabbar.closeOthers")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => onBatchClose(ctxMenu.tab, "othersKeepPinned")}
          >
            {t("tabbar.closeOthersKeepPinned")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => onBatchClose(ctxMenu.tab, "left")}
          >
            {t("tabbar.closeLeft")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => onBatchClose(ctxMenu.tab, "right")}
          >
            {t("tabbar.closeRight")}
          </button>
          <button
            className="context-menu-item"
            onClick={() => onBatchClose(ctxMenu.tab, "unmodified")}
          >
            {t("tabbar.closeUnmodified")}
          </button>
          <div className="context-menu-sep" />
          <button
            className="context-menu-item"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("lightmd:showSnapshotDialog", {
                  detail: { filePath: ctxMenu.tab.path },
                })
              );
              setCtxMenu(null);
            }}
          >
            {t("snapshot.viewSnapshots")}
          </button>
          {/* v0.8.0 WP2 需求1：复制（配合左侧文件夹里的 Ctrl+V 粘贴） */}
          {ctxMenu.tab.path ? (
            <button
              className="context-menu-item"
              onClick={() => {
                setClipboard({ path: ctxMenu.tab.path, name: ctxMenu.tab.name });
                setCtxMenu(null);
              }}
            >
              {t("filetree.copy")}
            </button>
          ) : null}
          {/* v0.8.0 WP2 需求6：在左侧栏打开该文件所在文件夹工作区（临时标签无路径，不显示） */}
          {ctxMenu.tab.path ? (
            <button
              className="context-menu-item"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("lightmd:command", {
                    detail: { id: "workspace.open", path: ctxMenu.tab.path },
                  })
                );
                setCtxMenu(null);
              }}
            >
              {t("filetree.openWorkspace")}
            </button>
          ) : null}
          <button
            className="context-menu-item"
            onClick={() => {
              fileService.revealInFolder(ctxMenu.tab.path).catch(() => {});
              setCtxMenu(null);
            }}
          >
            {t("common.revealInFolder")}
          </button>
        </div>
      )}
    </div>
  );
}
