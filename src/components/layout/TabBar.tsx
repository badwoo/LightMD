/**
 * TabBar —— 多标签页栏组件
 *
 * 设计：
 * - 水平排列的标签栏，位于编辑区上方
 * - 每个标签显示文件名、脏标记（●）、关闭按钮（×）
 * - 激活标签高亮，非激活标签可点击切换
 * - 标签过多时支持横向滚动
 */
import { useCallback } from "react";
import { useEditorStore, type TabInfo } from "../../stores/useEditorStore";
import "./TabBar.css";

interface TabBarProps {
  onTabSwitch?: (tab: TabInfo) => void;
  onTabClose?: (tab: TabInfo, idx: number) => void;
}

export function TabBar({ onTabSwitch, onTabClose }: TabBarProps) {
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeTabIdx = useEditorStore((s) => s.activeTabIdx);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);

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

  if (openTabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {openTabs.map((tab, idx) => (
        <div
          key={`${tab.path}-${idx}`}
          className={`tab-item ${idx === activeTabIdx ? "tab-active" : ""}`}
          onClick={() => handleTabClick(idx)}
          title={tab.path}
        >
          <span className="tab-name">{tab.name}</span>
          {tab.isDirty && <span className="tab-dirty">●</span>}
          <button
            className="tab-close"
            onClick={(e) => handleClose(e, idx)}
            title="关闭"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
