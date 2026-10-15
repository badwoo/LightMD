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
import { getKnownDiskContent } from "../services/selfWriteGuard";
import {
  judgeAutoSaveWrite,
  getCachedDiskRead,
  putCachedDiskRead,
} from "../utils/autoSaveGuard";
import { safeSetItem } from "../utils/safeStorage";
import { getMarkdownFromDoc } from "../core/editor";
import { isMarkdownFile } from "../utils/constants";
import { preserveEol } from "../utils/eolPreserve";
import { useT } from "../i18n";
import type { EditorView } from "prosemirror-view";

/** 从路径取文件名（用于提示文案；与 App.tsx 的同名工具保持一致行为） */
function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

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
  const t = useT();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * v0.9.0 第五轮（问题1）：当前标签是否「已被**其他**窗口保存过而未处理」。
   *
   * 多窗口同文件同时编辑时，后台定时自动保存**静默覆盖**另一个窗口刚保存的内容
   * 是最真实的数据丢失点（用户完全不知情）。因此此处暂停自动保存，并要求用户
   * 手动 `Ctrl+S`——手动保存会走「覆盖 / 另存为 / 取消」确认，知情后才会覆盖。
   *
   * 磁盘内容始终以「最后一次成功保存」为准；暂停只保证**没有哪一次覆盖是静默的**。
   */
  const externallyChanged = useEditorStore(
    (s) => s.openTabs[s.activeTabIdx]?.isExternallyChanged === true,
  );
  /** 暂停提示只弹一次（同一轮外部变更内），用户手动保存清除标记后重新武装 */
  const pausedNotifiedRef = useRef(false);
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
      // v0.9.0 D7：CRLF 文档的序列化输出统一转回 CRLF（B6 快路径已逐字节
      // 返回原文不受影响，此处兜底重新序列化的块）
      if (sourceContentRef?.current) {
        markdown = preserveEol(markdown, sourceContentRef.current);
      }
    }

    try {
      if (isTauri()) {
        // v0.13.0 需求3：写盘前先读一次磁盘做三路判定。
        //
        // 背景：外部软件改文件、而 LightMD 正开着它时，若直接写盘会把内存里的
        // 旧内容盖回去，外部编辑被静默覆盖回退（用户完全不知情）。
        // 此前的 `externallyChanged` 标记不够——它依赖 watcher 事件先到达，
        // 而事件可能因「目录未挂载 / mtime 去重命中 / Rust 回调调度晚于定时器」
        // 迟到或缺失。所以这里不依赖事件，直接自己读盘判断。
        const now = Date.now();
        let disk = getCachedDiskRead(filePath, now);
        if (disk === undefined) {
          disk = await fileService.readFile(filePath, { silent: true });
          putCachedDiskRead(filePath, disk, now);
        }
        const decision = judgeAutoSaveWrite({
          diskContent: disk,
          targetContent: markdown,
          // v0.13.0 返修（问题8）：这里必须用「本应用所知的磁盘内容」——
          // 优先自身写盘记录（短 TTL），否则回退打开文件时登记的磁盘基线（长 TTL）。
          //
          // 缺陷背景：此前用 `getLastSelfWritten`（TTL 仅 10s），而自动保存默认间隔
          // 是 **60s**。于是「打开文件 → 编辑 → 从未手动保存」或「上次保存已过 10s」
          // 时，该函数返回 null → 三路判定无法证明磁盘未被第三方改过 → 判为 conflict
          // → 放弃自动保存并弹「已在其他窗口保存，自动保存已暂停」。
          // 实际**没有任何外部程序改过文档**，这就是用户报告的误报。
          lastSelfWritten: getKnownDiskContent(filePath),
        });
        if (decision === "conflict") {
          // 第三方已改过磁盘 → 放弃本次自动保存，绝不写盘。
          // 标记「外部变更未处理」并提示：用户手动 Ctrl+S 时会走
          // 「覆盖 / 另存为 / 取消」确认（知情后才会覆盖）。
          const { activeTabIdx } = useEditorStore.getState();
          useEditorStore.getState().setTabExternallyChanged(activeTabIdx, true);
          void import("../services/notificationService").then(({ notify }) =>
            notify(t("multiwindow.autoSaveSkipped", { name: fileNameOf(filePath) }), "warning"),
          );
          return;
        }
        if (decision === "skip") {
          // 磁盘已是目标内容：无需写盘，直接清脏标记（省一次 IO + 一次快照）
          setDirty(false);
          updateTabDirty(useEditorStore.getState().activeTabIdx, false);
          return;
        }
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
  // v0.6.1 问题3：翻译回写后的 suppressAutoSave 期间不启动定时器；
  // v0.9.0 第五轮：外部变更未处理（externallyChanged）时同样不启动——不静默覆盖）
  useEffect(() => {
    if (!isDirty || !filePath || autoSaveInterval <= 0 || suppressAutoSave) return;
    if (externallyChanged) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(save, autoSaveInterval);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isDirty, autoSaveInterval, save, filePath, suppressAutoSave, externallyChanged]);

  /**
   * v0.9.0 第五轮：自动保存暂停的一次性提示。
   *
   * 只在「确实开着自动保存 + 本窗口有未保存修改」时提示——否则用户本就该收到
   * App 侧那条 `fileChanged.dirtyHint`，不必重复打扰。
   */
  useEffect(() => {
    if (!externallyChanged) {
      pausedNotifiedRef.current = false;
      return;
    }
    if (autoSaveInterval <= 0 || !isDirty || pausedNotifiedRef.current) return;
    pausedNotifiedRef.current = true;
    void import("../services/notificationService").then(({ notify }) =>
      notify(t("multiwindow.autoSavePaused", { name: fileNameOf(filePath ?? "") }), "warning"),
    );
  }, [externallyChanged, autoSaveInterval, isDirty, filePath, t]);

  return { save };
}
