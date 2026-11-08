import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFileStore, type FileNode } from "../../stores/useFileStore";
import { useEditorStore } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
import { pathCompareKey } from "../../utils/path";
import { isSupportedTextFile } from "../../utils/constants";
import {
  fileService,
  MAX_WORKSPACE_FILES,
  type WorkspaceFileEntry,
} from "../../services/fileService";
import "./FileTree.css";

/* ─── v0.16.0 第三次调整：收藏「+」选择器 ───────────────────────────────
 * 两条用户需求：
 *   ① 候选范围 = 已打开标签 ∪ 所有已打开工作区文件夹（递归子目录）中的可打开文本文件；
 *   ② 「+ 展开文件列表」与「取消添加」两段过程都要顺滑动画过渡。
 *
 * 动画时长导出为常量：实机探针（scripts/v0160-probe-favorites-picker.mjs）与单测
 * 按这些常量断言，CSS keyframes 与之同值（240/180ms）。
 * ───────────────────────────────────────────────────────────────────── */

/** 选择器展开动画时长（`.favorites-picker-open .favorites-picker-inner`） */
export const FAVORITES_PICKER_IN_MS = 240;
/** 选择器取消/关闭动画时长；也是延迟卸载的等待时间（reduced-motion 下取 0） */
export const FAVORITES_PICKER_OUT_MS = 180;
/** 每个分组最多渲染的候选条数（防止 2 万工作区文件一次性挂 2 万个按钮） */
export const MAX_RENDERED_CANDIDATES = 400;

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

/**
 * v0.16.0：把两类候选合并成固定顺序的两个分组。
 *
 * - `openTabs`：已打开且已落盘的标签（顺序 = 标签顺序，去重口径同 collectFavoriteCandidates）
 * - `workspace`：工作区枚举结果，先用 isSupportedTextFile 丢掉图片/二进制/无扩展名怪文件，
 *   再按 pathCompareKey 剔除与已打开标签重复的条目（**已打开标签优先**）
 *
 * 已收藏项**不过滤**：它们仍要展示（置灰 + 「已收藏」），是否已收藏由组件层用
 * favoriteKeys 标记。第三个参数因此只做调用兼容保留，不参与合并结果。
 */
export function mergeFavoriteCandidates(
  openTabs: ReadonlyArray<{ path?: string | null; name: string; isUntitled?: boolean }>,
  workspaceFiles: ReadonlyArray<WorkspaceFileEntry>,
  _favoriteKeys?: ReadonlySet<string>,
): { openTabs: FavoriteCandidate[]; workspace: FavoriteCandidate[] } {
  const open = collectFavoriteCandidates(openTabs);
  const seen = new Set(open.map((file) => file.key));
  const workspace: FavoriteCandidate[] = [];
  for (const file of workspaceFiles) {
    if (!file?.path) continue;
    const name = file.name || file.path.replace(/\\/g, "/").split("/").pop() || file.path;
    if (!isSupportedTextFile(name)) continue;
    const key = pathCompareKey(file.path);
    if (seen.has(key)) continue;
    seen.add(key);
    workspace.push({ path: file.path, key, name });
  }
  return { openTabs: open, workspace };
}

/** 动画开关：reduced-motion 下卸载延迟取 0ms（CSS 侧动画同时被关掉）。 */
function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function Favorites({ onOpen }: FavoritesProps) {
  const favorites = useFileStore((s) => s.favorites);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const addFavorites = useFileStore((s) => s.addFavorites);
  const openFolders = useFileStore((s) => s.openFolders);
  const openTabs = useEditorStore((s) => s.openTabs);
  const t = useT();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerClosing, setPickerClosing] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState("");
  const [filterText, setFilterText] = useState("");
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceTruncated, setWorkspaceTruncated] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(false);

  /** 递增请求号：只有最新一次工作区读取的响应能写状态（picker 关闭/卸载后旧响应作废）。 */
  const requestIdRef = useRef(0);
  /** 延迟卸载计时器：关闭中重复取消/连按 Esc 不叠加，卸载时清理。 */
  const closeTimerRef = useRef<number | null>(null);
  /**
   * 上次成功读到的工作区候选（按 roots 签名缓存）。
   * 二次打开时直接同步铺满两组，避免"先只有已打开标签、一帧后才补上工作区文件"的
   * 两段式重排（视觉上是条目列表跳一下，也让入场错峰从中间重新起算）。
   * roots 变化即作废；关闭时不丢（数据本身没变），只丢弃在途响应。
   */
  const workspaceCacheRef = useRef<{ signature: string; files: WorkspaceFileEntry[]; truncated: boolean } | null>(null);

  const roots = useMemo(
    () => openFolders.map((folder) => folder.path).filter(Boolean),
    [openFolders],
  );

  const candidates = useMemo(
    () => mergeFavoriteCandidates(openTabs, workspaceFiles),
    [openTabs, workspaceFiles],
  );
  const allCandidates = useMemo(
    () => [...candidates.openTabs, ...candidates.workspace],
    [candidates],
  );
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((file) => pathCompareKey(file.path))),
    [favorites],
  );

  /** 真正的卸载：清选择、清过滤词、作废在途响应。 */
  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    requestIdRef.current += 1;
    setShowPicker(false);
    setPickerClosing(false);
    setSelectedPaths(new Set());
    setFilterText("");
    setWorkspaceFiles([]);
    setWorkspaceTruncated(false);
    setWorkspaceLoading(false);
    setWorkspaceError(false);
  }, []);

  /**
   * v0.16.0：取消添加 —— 先播 180ms 反向动画再卸载（reduced-motion 立即卸载）。
   * 幂等：已经在关闭中时直接返回，不叠加计时器。
   */
  const cancelPicker = useCallback(() => {
    if (closeTimerRef.current !== null) return;
    if (prefersReducedMotion()) {
      setPickerClosing(true);
      finishClose();
      return;
    }
    setPickerClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      finishClose();
    }, FAVORITES_PICKER_OUT_MS);
  }, [finishClose]);

  /** 打开选择器：已打开标签立即可见，工作区文件异步补齐（不阻塞首屏）。 */
  const openPicker = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setPickerClosing(false);
    setShowPicker(true);
    setFeedback("");
    setSelectedPaths(new Set());
    setFilterText("");

    const requestId = (requestIdRef.current += 1);
    setWorkspaceError(false);
    // 没有打开任何文件夹：没有工作区候选可读，直接进「仅已打开标签」形态。
    if (roots.length === 0) {
      workspaceCacheRef.current = null;
      setWorkspaceFiles([]);
      setWorkspaceTruncated(false);
      setWorkspaceLoading(false);
      return;
    }

    // 同一批 roots 的上次结果先同步铺上：避免二次打开时"先 2 项、一帧后补 6 项"的重排，
    // 也让入场错峰（animationDelay）从第一帧起就是连续的。后台仍会刷新一次。
    const signature = roots.join("\u0000");
    const cached = workspaceCacheRef.current;
    if (cached && cached.signature === signature) {
      setWorkspaceFiles(cached.files);
      setWorkspaceTruncated(cached.truncated);
      setWorkspaceLoading(false);
    } else {
      setWorkspaceFiles([]);
      setWorkspaceTruncated(false);
      setWorkspaceLoading(true);
    }

    fileService
      .listWorkspaceFiles(roots, { silent: true })
      .then((result) => {
        if (requestIdRef.current !== requestId) return; // 过期响应（已关闭/已重开）
        const files = result.files ?? [];
        workspaceCacheRef.current = { signature, files, truncated: !!result.truncated };
        setWorkspaceFiles(files);
        setWorkspaceTruncated(!!result.truncated);
        setWorkspaceLoading(false);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        // 静默降级：只显示已打开标签，并在选择器内提示读取失败。
        // 选择器内用 favorites-picker-error（探针断言该节点）；同时写一条 feedback，
        // 让用户关掉选择器后仍能看到这次读取失败（不弹 toast、不抛未捕获错误）。
        workspaceCacheRef.current = null;
        setWorkspaceFiles([]);
        setWorkspaceTruncated(false);
        setWorkspaceLoading(false);
        setWorkspaceError(true);
        setFeedback(t("favorites.addFailed"));
      });
  }, [roots]);

  // 组件卸载：作废在途响应 + 清理延迟卸载计时器
  useEffect(() => (
    () => {
      requestIdRef.current += 1;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    }
  ), []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // 选择期间候选失效（关闭标签 / 工作区结果变化）时，未提交选择同步失效。
  useEffect(() => {
    if (!showPicker) return;
    const available = new Set(allCandidates.map((file) => file.key));
    setSelectedPaths((previous) => {
      const next = new Set([...previous].filter((key) => available.has(key) && !favoriteKeys.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [allCandidates, favoriteKeys, showPicker]);

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
    // 提交口径 = selectedPaths ∩ 当前候选（过滤只影响显示，不清空已选）
    const selected = allCandidates.filter((file) => selectedPaths.has(file.key) && !favoriteKeys.has(file.key));
    const result = addFavorites(selected.map((file) => ({ path: file.path, name: file.name })));
    if (result.skipped > 0) {
      setFeedback(t("favorites.addedWithSkipped", { added: result.added, skipped: result.skipped, limit: 50 }));
    } else if (result.added > 0) {
      setFeedback(t("favorites.addedCount", { count: result.added }));
    }
    // 确认同样走延迟卸载，反馈文案已在上方同步显示
    cancelPicker();
  };

  // 过滤（大小写不敏感的子串匹配 name 或 path）只影响显示，不清空已选
  const filterQuery = filterText.trim().toLowerCase();
  const filtered = useMemo(() => {
    const match = (file: FavoriteCandidate) => (
      !filterQuery
      || file.name.toLowerCase().includes(filterQuery)
      || file.path.toLowerCase().includes(filterQuery)
    );
    return {
      openTabs: candidates.openTabs.filter(match),
      workspace: candidates.workspace.filter(match),
    };
  }, [candidates, filterQuery]);

  // 每组最多渲染 MAX_RENDERED_CANDIDATES 项；被裁剪时给提示
  const openVisible = filtered.openTabs.slice(0, MAX_RENDERED_CANDIDATES);
  const workspaceVisible = filtered.workspace.slice(0, MAX_RENDERED_CANDIDATES);
  const openTabsOverflow = filtered.openTabs.length > MAX_RENDERED_CANDIDATES;
  const workspaceOverflow = filtered.workspace.length > MAX_RENDERED_CANDIDATES;
  const nothingVisible = openVisible.length + workspaceVisible.length === 0;

  const renderCandidate = (file: FavoriteCandidate, renderIndex: number) => {
    const isFavorite = favoriteKeys.has(file.key);
    const isSelected = selectedPaths.has(file.key);
    // aria-label 里的路径统一用 "/"（Windows 原生路径是 "\"）：同名不同目录必须可区分，
    // 且实机探针/测试都用正斜杠路径串匹配这个可访问名称。
    const ariaPath = file.path.replace(/\\/g, "/");
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={isFavorite ? true : isSelected}
        aria-label={`${file.name} — ${ariaPath}`}
        disabled={isFavorite}
        key={file.key}
        className={`favorite-picker-item ${isFavorite ? "disabled" : ""} ${isSelected ? "selected" : ""}`}
        style={{ animationDelay: `${Math.min(renderIndex, 8) * 22}ms` }}
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
  };

  return (
    <section className="favorites-panel" aria-label={t("sidebar.favorites")}>
      <header className="favorites-panel-header">
        <span className="filetree-title">
          {favorites.length > 0 ? t("sidebar.favoritesCount", { count: favorites.length }) : t("sidebar.favorites")}
        </span>
        <button
          type="button"
          className={`section-btn favorites-add-btn${showPicker && !pickerClosing ? " expanded" : ""}`}
          title={t("favorites.add")}
          aria-label={t("favorites.add")}
          aria-expanded={showPicker && !pickerClosing}
          onClick={openPicker}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {feedback && <div className="favorites-feedback" role="status">{feedback}</div>}

      {showPicker && (
        <div
          className={`favorites-add-picker ${pickerClosing ? "favorites-picker-closing" : "favorites-picker-open"}`}
          aria-hidden={pickerClosing}
          {...(pickerClosing ? { inert: "" } : {})}
        >
          <div className="favorites-picker-clip">
            <div className="favorites-picker-inner">
              <div className="favorites-picker-header">{t("favorites.selectFiles")}</div>
              <div className="favorites-picker-filter">
                <input
                  type="text"
                  value={filterText}
                  onChange={(event) => setFilterText(event.target.value)}
                  placeholder={t("favorites.filterPlaceholder")}
                  aria-label={t("favorites.filterPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="favorites-picker-list">
                {openVisible.length > 0 && (
                  <>
                    <div className="favorites-picker-group-title">{t("favorites.group.openTabs")}</div>
                    {openVisible.map((file, index) => renderCandidate(file, index))}
                    {openTabsOverflow && (
                      <div className="favorites-picker-hint">
                        {t("favorites.pickerLimitHint", { shown: MAX_RENDERED_CANDIDATES })}
                      </div>
                    )}
                  </>
                )}

                {workspaceLoading && (
                  <div className="favorites-picker-loading">{t("favorites.loadingWorkspace")}</div>
                )}

                {!workspaceLoading && workspaceVisible.length > 0 && (
                  <>
                    <div className="favorites-picker-group-title">{t("favorites.group.workspace")}</div>
                    {workspaceVisible.map((file, index) => renderCandidate(file, openVisible.length + index))}
                    {workspaceOverflow && (
                      <div className="favorites-picker-hint">
                        {t("favorites.pickerLimitHint", { shown: MAX_RENDERED_CANDIDATES })}
                      </div>
                    )}
                  </>
                )}

                {workspaceTruncated && !workspaceLoading && (
                  <div className="favorites-picker-hint">
                    {t("favorites.workspaceTruncated", { limit: MAX_WORKSPACE_FILES })}
                  </div>
                )}

                {workspaceError && (
                  <div className="favorites-picker-error">{t("favorites.addFailed")}</div>
                )}

                {nothingVisible && !workspaceLoading && (
                  <div className="favorites-picker-empty">
                    {filterQuery ? t("favorites.noMatch") : t("favorites.noSelectableFiles")}
                  </div>
                )}
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
