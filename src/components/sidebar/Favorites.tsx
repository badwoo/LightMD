import { useCallback, useEffect, useMemo, useState } from "react";
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import { useEditorStore } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
import { pathCompareKey } from "../../utils/path";
import "./FileTree.css";

interface FavoriteCandidate {
  path: string;
  key: string;
  name: string;
}

interface FavoritesProps {
  onOpen: (node: FileNode) => void;
  /** @deprecated v0.16.0 起特殊面板不再使用内嵌分区属性。 */
  onClose?: () => void;
  height?: number;
  sectionKey?: string;
  prevSectionKey?: string;
  nextSectionKey?: string;
  maxHeight?: number;
  compact?: boolean;
}

/** 当前窗口已打开且已落盘的标签；未命名标签没有可持久化的路径。 */
export function collectFavoriteCandidates(
  tabs: ReadonlyArray<{ path?: string | null; name: string; isUntitled?: boolean }>,
): FavoriteCandidate[] {
  const byPath = new Map<string, FavoriteCandidate>();
  for (const tab of tabs) {
    if (!tab.path || tab.isUntitled) continue;
    const key = pathCompareKey(tab.path);
    if (!byPath.has(key)) byPath.set(key, { path: tab.path, key, name: tab.name });
  }
  return [...byPath.values()];
}

export function Favorites({ onOpen }: FavoritesProps) {
  const favorites = useFileStore((s) => s.favorites);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const addFavorites = useFileStore((s) => s.addFavorites);
  const openTabs = useEditorStore((s) => s.openTabs);
  const t = useT();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState("");

  const candidates = useMemo(() => collectFavoriteCandidates(openTabs), [openTabs]);
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((file) => pathCompareKey(file.path))),
    [favorites],
  );

  const cancelPicker = useCallback(() => {
    setShowPicker(false);
    setSelectedPaths(new Set());
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // 选择期间关闭标签时，候选和未提交选择同步失效。
  useEffect(() => {
    if (!showPicker) return;
    const available = new Set(candidates.map((file) => file.key));
    setSelectedPaths((previous) => {
      const next = new Set([...previous].filter((key) => available.has(key) && !favoriteKeys.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [candidates, favoriteKeys, showPicker]);

  useEffect(() => {
    if (!showPicker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelPicker();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelPicker, showPicker]);

  const toggleCandidate = (key: string) => {
    if (favoriteKeys.has(key)) return;
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const confirmPicker = () => {
    const selected = candidates.filter((file) => selectedPaths.has(file.key) && !favoriteKeys.has(file.key));
    const result = addFavorites(selected.map((file) => ({ path: file.path, name: file.name })));
    cancelPicker();
    if (result.skipped > 0) {
      setFeedback(t("favorites.addedWithSkipped", { added: result.added, skipped: result.skipped, limit: 50 }));
    } else if (result.added > 0) {
      setFeedback(t("favorites.addedCount", { count: result.added }));
    }
  };

  return (
    <section className="favorites-panel" aria-label={t("sidebar.favorites")}>
      <header className="favorites-panel-header">
        <span className="filetree-title">
          {favorites.length > 0 ? t("sidebar.favoritesCount", { count: favorites.length }) : t("sidebar.favorites")}
        </span>
        <button
          type="button"
          className="section-btn favorites-add-btn"
          title={t("favorites.add")}
          aria-label={t("favorites.add")}
          aria-expanded={showPicker}
          onClick={() => { setFeedback(""); setShowPicker(true); }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {feedback && <div className="favorites-feedback" role="status">{feedback}</div>}

      {showPicker && (
        <div className="favorites-add-picker">
          <div className="favorites-picker-header">{t("favorites.selectOpened")}</div>
          <div className="favorites-picker-list">
            {candidates.length === 0 ? (
              <div className="favorites-picker-empty">{t("favorites.noOpenedFiles")}</div>
            ) : candidates.map((file) => {
              const isFavorite = favoriteKeys.has(file.key);
              const isSelected = selectedPaths.has(file.key);
              return (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isFavorite ? true : isSelected}
                  aria-label={`${file.name} — ${file.path}`}
                  disabled={isFavorite}
                  key={file.key}
                  className={`favorite-picker-item ${isFavorite ? "disabled" : ""} ${isSelected ? "selected" : ""}`}
                  onClick={() => toggleCandidate(file.key)}
                >
                  <span className="favorite-picker-info">
                    <span className="filetree-name">{file.name}</span>
                    <span className="favorite-path">{file.path}</span>
                  </span>
                  {isFavorite && <span className="favorite-picker-already">{t("favorites.alreadyAdded")}</span>}
                  <span className={`favorite-picker-check ${isSelected || isFavorite ? "checked" : ""}`} aria-hidden="true">
                    {(isSelected || isFavorite) && "✓"}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="favorites-picker-footer">
            <span className="favorites-selected-count">{t("favorites.selectedCount", { count: selectedPaths.size })}</span>
            <div className="favorites-picker-actions">
              <button type="button" className="favorites-picker-cancel" onClick={cancelPicker}>{t("common.cancel")}</button>
              <button type="button" className="favorites-picker-confirm" disabled={selectedPaths.size === 0} onClick={confirmPicker}>
                {t("favorites.addSelected")}
              </button>
            </div>
          </div>
        </div>
      )}

      {!showPicker && favorites.length === 0 && <div className="favorites-empty">{t("sidebar.noFavorites")}</div>}
      {!showPicker && favorites.length > 0 && (
        <div className="favorites-list">
          {favorites.map((file) => (
            <div
              key={file.path}
              className="filetree-node favorite-item"
              onClick={() => onOpen({ name: file.name, path: file.path, isDir: false, size: 0 })}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ x: event.clientX, y: event.clientY, path: file.path });
              }}
              title={`${file.path}${file.stale ? `\n${t("recent.staleHint")}` : ""}`}
            >
              <span className="filetree-icon favorite-star">★</span>
              <div className="favorite-info">
                <span className="filetree-name">{file.name}</span>
                <span className="favorite-path">{file.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "")}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {contextMenu && (
        <div className="filetree-context-menu" style={{ left: contextMenu.x, top: contextMenu.y, position: "fixed" }} onClick={(event) => event.stopPropagation()}>
          <button className="context-menu-item danger" onClick={() => { removeFavorite(contextMenu.path); setContextMenu(null); }}>
            {t("sidebar.removeFromFavorites")}
          </button>
        </div>
      )}
    </section>
  );
}
