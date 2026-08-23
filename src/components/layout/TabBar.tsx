/**
 * TabBar —— 多标签页栏组件
 *
 * 设计：
 * - 水平排列的标签栏，位于编辑区上方
 * - 每个标签显示文件名、脏标记（●）、关闭按钮（×）
 * - 激活标签高亮，非激活标签可点击切换
 * - 标签过多时支持横向滚动
 * - v0.4.0 功能4：tab-item 右键菜单 + 标题栏快照入口图标
 */
import { useCallback, useState, useEffect } from "react";
import { useEditorStore, type TabInfo } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
import { fileService } from "../../services/fileService";
import "./TabBar.css";

interface TabBarProps {
  onTabSwitch?: (tab: TabInfo) => void;
  onTabClose?: (tab: TabInfo, idx: number) => void;
}

export function TabBar({ onTabSwitch, onTabClose }: TabBarProps) {
  const t = useT();
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeTabIdx = useEditorStore((s) => s.activeTabIdx);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  // 右键菜单位置与目标 tab
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: TabInfo } | null>(null);

  const handleTabClick = useCallback((idx: number) => {
    if (idx === activeTabIdx) return;
    // 不在此处调用 setActiveTab，由 handleTabSwitch 统一处理
    // 避免 activeTabIdx 提前更新导致 handleTabSwitch 保存内容到错误的标签页
    const tab = openTabs[idx];
    if (tab) onTabSwitch?.(tab);
  }, [activeTabIdx, openTabs, onTabSwitch]);

  const handleClose = useCallback((e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const tab = openTabs[idx];
    if (tab) onTabClose?.(tab, idx);
  }, [openTabs, onTabClose]);

  // tab-item 右键菜单：弹出含"查看版本快照"项
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
    return () => window.removeEventListener("click", close);
  }, [ctxMenu]);

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

  if (openTabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {openTabs.map((tab, idx) => (
        <div
          key={`${tab.path}-${idx}`}
          className={`tab-item ${idx === activeTabIdx ? "tab-active" : ""}`}
          onClick={() => handleTabClick(idx)}
          onContextMenu={(e) => handleContextMenu(e, tab)}
          title={tab.path}
        >
          <span className="tab-name" title={tab.path}>
            {tab.name}
          </span>
          {tab.isDirty && <span className="tab-dirty">●</span>}
          <button
            className="tab-close"
            onClick={(e) => handleClose(e, idx)}
            title={t("tabbar.close")}
          >
            ×
          </button>
        </div>
      ))}
      {/* v0.4.0 功能4：标题栏快照入口图标 */}
      <button
        className="tab-bar-snapshot-btn"
        onClick={handleSnapshotBtnClick}
        title={t("snapshot.viewSnapshots")}
      >
        🕐
      </button>
      {/* tab-item 右键菜单 */}
      {ctxMenu && (
        <div
          className="tabbar-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
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
          {/* N5：在资源管理器中显示并选中该文件 */}
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
