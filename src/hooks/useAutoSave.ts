/**
 * useAutoSave —— 自动保存 hook
 *
 * 注意：Ctrl+S 手动保存在 App.tsx 中处理，此处只处理定时自动保存
 *
 * 性能优化：优先使用 docToMarkdown 缓存，避免重复序列化
 */
import { useEffect, useRef, useCallback } from "react";
import { useEditorStore } from "../stores/useEditorStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { fileService, isTauri } from "../services/fileService";
import { getMarkdownFromDoc } from "../core/editor";
import type { EditorView } from "prosemirror-view";

export function useAutoSave(viewRef: React.MutableRefObject<EditorView | null>) {
  const filePath = useEditorStore((s) => s.filePath);
  const isDirty = useEditorStore((s) => s.isDirty);
  const setDirty = useEditorStore((s) => s.setDirty);
  const autoSaveInterval = useSettingsStore((s) => s.autoSaveIntervalMs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !filePath) return;

    // 优先使用缓存的序列化结果，避免重复计算
    const markdown = getMarkdownFromDoc(view.state.doc);
    try {
      if (isTauri()) {
        await fileService.writeFile(filePath, markdown);
      } else {
        localStorage.setItem("lightmd-content", markdown);
      }
      setDirty(false);
    } catch (err) {
      console.error("[AutoSave] 保存失败:", err);
    }
  }, [filePath, setDirty]);

  // 定时自动保存（仅在 isDirty 且有 filePath 时触发）
  useEffect(() => {
    if (!isDirty || !filePath || autoSaveInterval <= 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(save, autoSaveInterval);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isDirty, autoSaveInterval, save, filePath]);

  return { save };
}
