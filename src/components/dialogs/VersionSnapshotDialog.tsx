/**
 * VersionSnapshotDialog —— 版本快照可拖拽浮窗
 *
 * 布局：
 * - 标题栏（可拖拽移动窗口）
 * - 左栏：快照列表（最多 5 条）
 * - 右栏：差异对比（左=选中版本，右=当前版本），行级 diff 着色
 * - "使用该版本"按钮
 *
 * 性能保障：
 * - 切换快照项时才 readSnapshotContent（惰性加载）
 * - diff 结果用 useMemo 缓存
 * - 大量 diff 行限制渲染前 800 行，避免 DOM 卡顿
 */
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { versionSnapshotService } from "../../services/versionSnapshotService";
import { useT } from "../../i18n";
import "./VersionSnapshotDialog.css";

interface VersionSnapshotDialogProps {
  filePath: string;
  currentContent: string;
  onClose: () => void;
  /** 使用某版本后回调，参数为新内容 */
  onApply: (newContent: string) => void;
}

/** 渲染 diff 行数上限，超出截断并提示，避免 DOM 卡顿 */
const MAX_RENDER_LINES = 800;

/** 格式化时间 MM-DD HH:mm */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${MM}-${dd} ${HH}:${mm}`;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** 从路径提取文件名 */
function getFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function VersionSnapshotDialog({
  filePath,
  currentContent,
  onClose,
  onApply,
}: VersionSnapshotDialogProps) {
  const t = useT();
  const snapshots = useMemo(
    () => versionSnapshotService.getSnapshots(filePath),
    [filePath]
  );
  const [selectedIdx, setSelectedIdx] = useState<number>(
    snapshots.length > 0 ? snapshots.length - 1 : -1
  );
  const [selectedContent, setSelectedContent] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // 拖拽位置状态
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    // 初始居中
    const w = Math.min(840, window.innerWidth - 80);
    const h = 540;
    return {
      x: Math.max(20, (window.innerWidth - w) / 2),
      y: Math.max(20, (window.innerHeight - h) / 2),
    };
  });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // 最大化状态（问题6：放大/缩小按钮）
  const [maximized, setMaximized] = useState(false);

  // 左右栏滚动联动 ref（问题7：滚动联动）
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  // 锁标志，防止联动循环触发
  const isSyncingRef = useRef(false);

  // 拖拽事件处理（用 ref 持有最新 pos，避免频繁重建监听器）
  const posRef = useRef(pos);
  posRef.current = pos;

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const newX = dragRef.current.origX + dx;
    const newY = dragRef.current.origY + dy;
    // 限制在视口内
    const maxX = window.innerWidth - 100;
    const maxY = window.innerHeight - 60;
    setPos({
      x: Math.max(0, Math.min(maxX, newX)),
      y: Math.max(0, Math.min(maxY, newY)),
    });
  }, []);

  const onDragUp = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragUp);
  }, [onDragMove]);

  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // 最大化时禁用拖拽
      if (maximizedRef.current) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: posRef.current.x,
        origY: posRef.current.y,
      };
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragUp);
    },
    [onDragMove, onDragUp]
  );

  // 用 ref 持有最新 maximized，避免 onHeaderMouseDown 依赖变化导致监听器重建
  const maximizedRef = useRef(maximized);
  maximizedRef.current = maximized;

  // 双击标题栏切换最大化（问题6）
  const onHeaderDoubleClick = useCallback(() => {
    setMaximized((m) => !m);
  }, []);

  // 左右栏滚动联动（问题7）：滚动任一栏时同步另一栏，用 isSyncingRef 防循环
  const handleScroll = useCallback((source: "left" | "right") => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    const src = source === "left" ? leftScrollRef.current : rightScrollRef.current;
    const dst = source === "left" ? rightScrollRef.current : leftScrollRef.current;
    if (src && dst) {
      // 两栏 diff 行已对齐（行数相同），直接同步 scrollTop 即可
      dst.scrollTop = src.scrollTop;
    }
    // 用 requestAnimationFrame 解锁，确保本帧内对方 onScroll 被拦截
    requestAnimationFrame(() => {
      isSyncingRef.current = false;
    });
  }, []);

  // 组件卸载时清理拖拽监听
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragUp);
    };
  }, [onDragMove, onDragUp]);

  // 惰性加载选中快照内容
  useEffect(() => {
    if (selectedIdx < 0 || !snapshots[selectedIdx]) {
      setSelectedContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    // 切换快照时重置左右栏滚动位置（问题7）
    if (leftScrollRef.current) leftScrollRef.current.scrollTop = 0;
    if (rightScrollRef.current) rightScrollRef.current.scrollTop = 0;
    const meta = snapshots[selectedIdx];
    versionSnapshotService
      .readSnapshotContent(meta)
      .then((content) => {
        if (!cancelled) setSelectedContent(content);
      })
      .catch(() => {
        if (!cancelled) setSelectedContent("");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedIdx, snapshots]);

  // 计算差异（选中版本 → 当前版本），用 useMemo 缓存
  const diffResult = useMemo(() => {
    if (!selectedContent) return null;
    return versionSnapshotService.diffContent(selectedContent, currentContent);
  }, [selectedContent, currentContent]);

  // 生成左右对齐的行数组（保证两栏行数相同，对齐显示）
  const { leftLines, rightLines, truncated } = useMemo(() => {
    if (!diffResult) return { leftLines: [], rightLines: [], truncated: false };
    const left: { type: string; content: string; lineNo?: number }[] = [];
    const right: { type: string; content: string; lineNo?: number }[] = [];
    for (const l of diffResult.lines) {
      if (left.length >= MAX_RENDER_LINES) break;
      if (l.type === "context") {
        left.push({ type: "context", content: l.content, lineNo: l.oldLineNo });
        right.push({ type: "context", content: l.content, lineNo: l.newLineNo });
      } else if (l.type === "remove") {
        left.push({ type: "remove", content: l.content, lineNo: l.oldLineNo });
        right.push({ type: "empty", content: "" });
      } else if (l.type === "add") {
        left.push({ type: "empty", content: "" });
        right.push({ type: "add", content: l.content, lineNo: l.newLineNo });
      }
    }
    return {
      leftLines: left,
      rightLines: right,
      truncated: diffResult.lines.length > MAX_RENDER_LINES,
    };
  }, [diffResult]);

  // 使用该版本
  const handleUseVersion = useCallback(async () => {
    if (selectedIdx < 0 || !snapshots[selectedIdx]) return;
    const meta = snapshots[selectedIdx];
    if (!window.confirm(t("snapshot.confirmUse"))) return;
    try {
      const newContent = await versionSnapshotService.applySnapshot(meta);
      onApply(newContent);
      onClose();
    } catch (err) {
      console.error("使用版本失败:", err);
    }
  }, [selectedIdx, snapshots, t, onApply, onClose]);

  const fileName = getFileName(filePath);

  return (
    <div
      className="snapshot-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`snapshot-dialog${maximized ? " maximized" : ""}`}
        style={{
          left: maximized ? 0 : pos.x,
          top: maximized ? 0 : pos.y,
          width: maximized ? "100vw" : undefined,
          height: maximized ? "100vh" : undefined,
          maxWidth: maximized ? "100vw" : undefined,
          maxHeight: maximized ? "100vh" : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 可拖拽标题栏（最大化时禁用拖拽，双击切换最大化） */}
        <div
          className="snapshot-header"
          onMouseDown={onHeaderMouseDown}
          onDoubleClick={onHeaderDoubleClick}
        >
          <span className="snapshot-title">
            {t("snapshot.title")} - {fileName}
          </span>
          <div className="snapshot-header-btns">
            {/* 放大/缩小按钮（问题6） */}
            <button
              className="snapshot-btn snapshot-maximize"
              onClick={() => setMaximized((m) => !m)}
              onMouseDown={(e) => e.stopPropagation()}
              title={maximized ? t("snapshot.restore") : t("snapshot.maximize")}
            >
              {maximized ? (
                // 还原图标：两个重叠方框
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="5" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  <path d="M5 5V3H13V11H11" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              ) : (
                // 最大化图标：单个方框
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="3" width="10" height="10" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              )}
            </button>
            <button
              className="snapshot-close"
              onClick={onClose}
              onMouseDown={(e) => e.stopPropagation()}
              title={t("common.close")}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="snapshot-body">
          {/* 左栏：快照列表 */}
          <div className="snapshot-list">
            {snapshots.length === 0 ? (
              <div className="snapshot-empty">{t("snapshot.empty")}</div>
            ) : (
              snapshots.map((meta, idx) => (
                <div
                  key={meta.id}
                  className={`snapshot-item ${
                    idx === selectedIdx ? "selected" : ""
                  } ${meta.isInitial ? "initial" : ""}`}
                  onClick={() => setSelectedIdx(idx)}
                >
                  <div className="snapshot-item-header">
                    <span className="snapshot-item-no">#{idx + 1}</span>
                    <span className="snapshot-item-label">
                      {meta.isInitial
                        ? t("snapshot.initial")
                        : t("snapshot.modified")}
                    </span>
                    {idx === snapshots.length - 1 && (
                      <span className="snapshot-item-recent" title={t("snapshot.recent")}>
                        ●
                      </span>
                    )}
                  </div>
                  <div className="snapshot-item-meta">
                    <span className="snapshot-item-time">
                      {formatTime(meta.timestamp)}
                    </span>
                    <span className="snapshot-item-size">
                      {formatSize(meta.size)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 右栏：差异对比 */}
          <div className="snapshot-diff">
            <div className="snapshot-diff-headers">
              <div className="snapshot-diff-col-title">
                {t("snapshot.leftVersion")}
              </div>
              <div className="snapshot-diff-col-title">
                {t("snapshot.rightCurrent")}
              </div>
            </div>
            <div className="snapshot-diff-content">
              {loading ? (
                <div className="snapshot-diff-loading">...</div>
              ) : !diffResult ? (
                <div className="snapshot-diff-empty">{t("snapshot.empty")}</div>
              ) : (
                <>
                  <div
                    className="snapshot-diff-col left"
                    ref={leftScrollRef}
                    onScroll={() => handleScroll("left")}
                  >
                    {leftLines.map((l, i) => (
                      <div
                        key={i}
                        className={`diff-line ${l.type}`}
                      >
                        <span className="diff-line-no">
                          {l.lineNo ?? ""}
                        </span>
                        <span className="diff-line-content">
                          {l.content}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div
                    className="snapshot-diff-col right"
                    ref={rightScrollRef}
                    onScroll={() => handleScroll("right")}
                  >
                    {rightLines.map((l, i) => (
                      <div
                        key={i}
                        className={`diff-line ${l.type}`}
                      >
                        <span className="diff-line-no">
                          {l.lineNo ?? ""}
                        </span>
                        <span className="diff-line-content">
                          {l.content}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {truncated && (
              <div className="snapshot-diff-truncated">
                {t("snapshot.diffTruncated", { count: MAX_RENDER_LINES })}
              </div>
            )}
            {diffResult && (
              <div className="snapshot-diff-footer">
                <span className="snapshot-diff-stat add">
                  +{diffResult.added} {t("snapshot.diffAdded")}
                </span>
                <span className="snapshot-diff-stat remove">
                  -{diffResult.removed} {t("snapshot.diffRemoved")}
                </span>
                {selectedIdx >= 0 && (
                  <button
                    className="snapshot-use-btn"
                    onClick={handleUseVersion}
                  >
                    {t("snapshot.useThisVersion")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
