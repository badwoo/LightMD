/**
 * QuickOpenDialog —— `Ctrl+P` 快速切换器（v0.13.0 需求8）
 *
 * 复用 CommandPalette 的弹层结构（overlay + portal + 键盘导航），只换数据源：
 * - 三类来源：已打开标签 / 最近文件 / 当前工作区文件（`utils/quickOpen.ts` 去重排序）；
 * - ↑↓ 选择、Enter 打开、Esc 关闭；
 * - 匹配字符高亮（`ScoredItem.positions`，与排序依据同一份结果）；
 * - 分组显示，已打开标签置顶。
 *
 * 拼音首字母匹配**本版不做**（需引入拼音库）。
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import {
  buildQuickOpenItems,
  QUICK_OPEN_GROUP_KEYS,
  type QuickOpenItem,
} from "../../utils/quickOpen";
import "./QuickOpenDialog.css";

export interface QuickOpenDialogProps {
  open: boolean;
  /** 已打开标签（置顶） */
  openTabs: QuickOpenItem[];
  /** 最近文件 */
  recent: QuickOpenItem[];
  /** 当前工作区文件 */
  workspace: QuickOpenItem[];
  /** 选中某个条目 */
  onPick: (item: QuickOpenItem) => void;
  onClose: () => void;
}

/** 把匹配到的字符下标集合转成「该字符是否高亮」的布尔数组 */
function highlightMask(length: number, positions: number[]): boolean[] {
  const mask = new Array<boolean>(length).fill(false);
  for (const p of positions) if (p >= 0 && p < length) mask[p] = true;
  return mask;
}

export function QuickOpenDialog({
  open,
  openTabs,
  recent,
  workspace,
  onPick,
  onClose,
}: QuickOpenDialogProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sources = useMemo(
    () => ({ openTabs, recent, workspace }),
    [openTabs, recent, workspace],
  );

  const items = useMemo(() => buildQuickOpenItems(query, sources), [query, sources]);

  // 打开时重置并聚焦
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIdx(0);
    // 下一帧聚焦，避免与关闭动画抢焦点
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 查询变化重置选中
  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // 选中项滚入可视区
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, open]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = items[selectedIdx];
      if (picked) {
        onPick(picked.item);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // 按分组渲染（保持已排序的顺序，分组只作为标题分隔）
  let lastGroup: QuickOpenItem["group"] | null = null;

  return createPortal(
    <div className="quick-open-overlay" onClick={onClose}>
      <div
        className="quick-open"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid="quick-open"
      >
        <div className="quick-open-header">
          <input
            ref={inputRef}
            type="text"
            className="quick-open-input"
            placeholder={t("quickOpen.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="quick-open-body" ref={listRef}>
          {items.length === 0 ? (
            <div className="quick-open-empty">{t("quickOpen.empty")}</div>
          ) : (
            items.map((entry, idx) => {
              const item = entry.item;
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              const mask = highlightMask(item.name.length, entry.positions);
              return (
                <div key={`${item.group}:${item.path}`}>
                  {showGroup && (
                    <div className="quick-open-group-title">
                      {t(QUICK_OPEN_GROUP_KEYS[item.group])}
                    </div>
                  )}
                  <div
                    data-idx={idx}
                    className={`quick-open-item${idx === selectedIdx ? " selected" : ""}${
                      item.isActive ? " active" : ""
                    }`}
                    onClick={() => {
                      onPick(item);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIdx(idx)}
                  >
                    <span className="quick-open-item-name">
                      {item.name.split("").map((ch, i) => (
                        <span key={i} className={mask[i] ? "hl" : undefined}>
                          {ch}
                        </span>
                      ))}
                    </span>
                    {item.dir && <span className="quick-open-item-dir">{item.dir}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="quick-open-footer">
          <span className="quick-open-hints">
            <kbd>↑↓</kbd> {t("quickOpen.navigate")}
            <kbd>Enter</kbd> {t("quickOpen.open")}
            <kbd>Esc</kbd> {t("quickOpen.close")}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
