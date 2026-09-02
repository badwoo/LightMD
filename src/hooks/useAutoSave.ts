/**
 * useAutoSave —— 自动保存 hook
 *
 * 注意：Ctrl+S 手动保存在 App.tsx 中处理，此处只处理定时自动保存
 *
 * 核心修复：根据当前 viewMode 选择正确的数据源
 * - 阅读模式：从 ProseMirror doc 序列化（doc 是最新的）
 * - 编辑/分屏模式：从 sourceContent 读取（textarea 是最新的，ProseMirror doc 可能未同步）
 *
 * 性能优化：优先使用 docToMarkdown 缓存，避免重复序列化
 */
import { useEffect, useRef, useCallback } from "react";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService, isTauri } from "../services/fileService";
import { versionSnapshotService } from "../services/versionSnapshotService";
import { safeSetItem } from "../utils/safeStorage";
import { getMarkdownFromDoc } from "../core/editor";
import { isMarkdownFile } from "../utils/constants";
import type { EditorView } from "prosemirror-view";

export function useAutoSave(
  viewRef: React.MutableRefObject<EditorView | null>,
  // 源码模式下的最新内容（编辑/分屏模式使用），通过 ref 传入避免闭包陈旧
  sourceContentRef?: React.MutableRefObject<string>
) {
  const filePath = useEditorStore((s) => s.filePath);
  const isDirty = useEditorStore((s) => s.isDirty);
  // v0.6.1 问题3：翻译回写（直接替换/双语对照）的修改不自动保存，等待用户手动保存或继续编辑
  const suppressAutoSave = useEditorStore((s) => s.suppressAutoSave);
  const setDirty = useEditorStore((s) => s.setDirty);
  const updateTabDirty = useEditorStore((s) => s.updateTabDirty);
  const viewMode = useEditorStore((s) => s.viewMode);
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveIntervalMs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 追踪 viewMode，避免 save 函数频繁重建
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    // 根据当前模式选择数据源：
    // - 编辑/分屏模式：textarea 内容是最新的（ProseMirror doc 尚未同步）
    // - 阅读模式：ProseMirror doc 是最新的
    // Issue 7 隐藏 bug 修复：非 md 文件 ProseMirror 始终为空，
    // 无论什么模式都必须从 sourceContentRef 读取，否则会保存空内容
    let markdown: string;
    const isSourceMode = viewModeRef.current === "edit" || viewModeRef.current === "split";
    const isMdFile = isMarkdownFile(filePath || "");
    if ((isSourceMode || !isMdFile) && sourceContentRef?.current !== undefined) {
      markdown = sourceContentRef.current;
    } else {
      // 优先使用缓存的序列化结果，避免重复计算
      markdown = getMarkdownFromDoc(view.state.doc);
    }

    try {
      if (isTauri()) {
        await fileService.writeFile(filePath, markdown);
        // v0.4.0 功能4：自动保存成功后记录版本快照（内容去重由服务内部处理）
        versionSnapshotService.recordSnapshot(filePath, markdown).catch(() => {});
      } else {
        safeSetItem("lightmd-content", markdown);
      }
      setDirty(false);
      // 清除当前标签页的脏标记（修复：自动保存后小蓝点未消失）
      const { activeTabIdx } = useEditorStore.getState();
      updateTabDirty(activeTabIdx, false);
    } catch (err) {
      console.error("[AutoSave] 保存失败:", err);
    }
  }, [filePath, setDirty, updateTabDirty, sourceContentRef]);

  // 定时自动保存（仅在 isDirty 且有 filePath 时触发；
  // v0.6.1 问题3：翻译回写后的 suppressAutoSave 期间不启动定时器）
  useEffect(() => {
    if (!isDirty || !filePath || autoSaveInterval <= 0 || suppressAutoSave) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(save, autoSaveInterval);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isDirty, autoSaveInterval, save, filePath, suppressAutoSave]);

  return { save };
}
