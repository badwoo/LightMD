/**
 * EmojiCompletePm ── 阅读模式（ProseMirror）的 Emoji 短码补全菜单（v0.13.0 需求10）
 *
 * 复用 slash-command 的插件形态与交互（portal + 键盘上下 + Enter + Esc）：
 * - 触发状态由 `emoji-complete.ts` 检测，经 props 传入；
 * - 定位用 `view.coordsAtPos`（同 SlashCommandPm）；
 * - 采纳插入 `:name:` **文本**（非 unicode）——Decoration 渲染图形，存盘仍是短码。
 *
 * 数据懒加载：`utils/emojiData.ts` 动态 import markdown-it-emoji 的 full 表，
 * 首次触发时才拉取（不进主包）。
 */
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import { applyEmojiCandidate, type EmojiState } from "../../core/plugins/emoji-complete";
import {
  filterCandidatesAsync,
  countBeyondLimit,
  MAX_CANDIDATES,
  type EmojiCandidate,
} from "../../utils/emojiData";
import { useT } from "../../i18n";

const MENU_WIDTH = 260;
const MENU_MAX_HEIGHT = 240;

export interface EmojiCompletePmProps {
  view: EditorView | null;
  /** 插件检测到的触发状态 */
  emoji: EmojiState;
  onClose: () => void;
}

export function EmojiCompletePm({ view, emoji, onClose }: EmojiCompletePmProps) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [candidates, setCandidates] = useState<EmojiCandidate[]>([]);
  const [beyond, setBeyond] = useState(0);
  const [loading, setLoading] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  // 过滤词变化 → 重新取候选（异步，表首次加载时有 loading 态）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void filterCandidatesAsync(emoji.query).then((list) => {
      if (!alive) return;
      setCandidates(list);
      setBeyond(countBeyondLimit(emoji.query));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [emoji.query]);

  // 候选变化时重置选中项
  useEffect(() => {
    setSelectedIndex(0);
  }, [candidates]);

  // 位置：依赖 emoji.from（同一触发会话内固定，query 变化不抖动）
  const position = useMemo(() => {
    if (!view) return { left: 0, top: 0 };
    try {
      const coords = view.coordsAtPos(emoji.from);
      const left =
        coords.left + MENU_WIDTH > window.innerWidth
          ? Math.max(8, coords.left - MENU_WIDTH + 20)
          : coords.left;
      const top =
        coords.top + 24 + MENU_MAX_HEIGHT > window.innerHeight
          ? Math.max(8, coords.top - MENU_MAX_HEIGHT - 4)
          : coords.top + 24;
      return { left, top };
    } catch {
      return { left: 0, top: 0 };
    }
  }, [view, emoji.from]);

  const handleSelect = useCallback(
    (item: EmojiCandidate) => {
      if (!view) return;
      if (applyEmojiCandidate(view, item.name, emoji)) onClose();
    },
    [view, emoji, onClose],
  );

  // 键盘：↑↓ 选择、Enter 采纳、Esc 关闭（捕获阶段，先于 PM keymap）
  useEffect(() => {
    if (!view) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => (candidates.length > 0 ? (i + 1) % candidates.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) =>
          candidates.length > 0 ? (i - 1 + candidates.length) % candidates.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const item = candidates[selectedIndex];
        if (item) handleSelect(item);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    view.dom.addEventListener("keydown", onKeyDown, { capture: true });
    return () => view.dom.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [view, candidates, selectedIndex, handleSelect, onClose]);

  // 点击菜单外部关闭
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".emoji-complete-menu")) onClose();
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true });
    return () => document.removeEventListener("mousedown", onMouseDown, { capture: true });
  }, [onClose]);

  // 选中项滚入可见区
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const el = menu.querySelector(".emoji-complete-item.selected") as HTMLElement | null;
    if (!el) return;
    const m = menu.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < m.top || r.bottom > m.bottom) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!view) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="emoji-complete-menu"
      role="listbox"
      aria-label={t("emoji.complete.ariaLabel")}
      data-testid="emoji-complete-menu"
      style={{
        position: "fixed",
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${MENU_WIDTH}px`,
        maxHeight: `${MENU_MAX_HEIGHT}px`,
        overflowY: "auto",
        zIndex: 10000,
        background: "var(--bg-primary, #fff)",
        border: "1px solid var(--border-color, #e0e0e0)",
        borderRadius: "8px",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.1)",
        padding: "4px 0",
        margin: 0,
      }}
    >
      {loading && <div className="emoji-complete-empty">{t("emoji.complete.loading")}</div>}
      {!loading && candidates.length === 0 && (
        <div className="emoji-complete-empty">{t("emoji.complete.empty")}</div>
      )}
      {!loading &&
        candidates.map((item, idx) => (
          <div
            key={item.name}
            role="option"
            aria-selected={idx === selectedIndex}
            data-testid="emoji-complete-item"
            className={`emoji-complete-item${idx === selectedIndex ? " selected" : ""}`}
            onMouseDown={(e) => {
              // mousedown 阻止默认：不让编辑器丢掉焦点/移动光标
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => handleSelect(item)}
            onMouseEnter={() => setSelectedIndex(idx)}
          >
            <span className="emoji-complete-glyph">{item.unicode}</span>
            <span className="emoji-complete-name">:{item.name}:</span>
          </div>
        ))}
      {beyond > 0 && (
        <div className="emoji-complete-more">
          {t("emoji.complete.more", { count: beyond, max: MAX_CANDIDATES })}
        </div>
      )}
    </div>,
    document.body,
  );
}
