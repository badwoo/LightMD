/**
 * src/components/editor/panes/SearchHost/SearchHost.tsx —— SearchHost pane
 *
 * ## 职责边界
 *
 * 搜索/替换接线（跨文件搜索文件清单与替换文本回写）
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 4170-4241 行。
 * **hook 体逐字节原样**（连缩进、注释、空行都没动）——这是本轮拆分的硬约束：
 * 判定"无逻辑改写"靠的是文本不变，不是靠肉眼审。
 *
 * 参数经 `Params` 解构到本地同名绑定 → 函数体内引用与拆分前完全一致；
 * 产物以 `Result` 对象返回给容器。两边字段都由 TypeChecker 生成真类型。
 *
 * ⚠️ 本文件**不得**直接 import textarea 具体实现：源码面一律经 `SourceSurface`
 * 接口访问（见 src/editor/types.ts）。
 */
import {
  useCallback,
} from "react";
import { SearchableFile } from "../.././SearchReplace";
import { useEditorStore } from "../../../../stores/useEditorStore";
import { UNTITLED_PROGRESS_PREFIX } from "../../../../utils/tabKey";
import { commitWholeText } from "../../../../editorHistory/coordinator";
import { documentHistory } from "../../../../services/documentHistory";
import type { SearchHostParams, SearchHostResult } from "./types";

export function useSearchHost(p: SearchHostParams): SearchHostResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    currentDocKey,
    isSourceMode,
    sourceContentRef,
    writeBackCurrentDoc,
  } = p;

  const collectSearchFiles = useCallback((): SearchableFile[] => {
    const st = useEditorStore.getState();
    const curKey = currentDocKey();
    const out: SearchableFile[] = [];
    for (let i = 0; i < st.openTabs.length; i++) {
      const tab = st.openTabs[i];
      const key = tab.isUntitled
        ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? i}`
        : tab.path || "";
      if (!key) continue;
      const isCurrent = curKey !== null && key === curKey;
      out.push({
        fileKey: key,
        filePath: tab.path || "",
        fileName: tab.name,
        getText: () => {
          // 当前文档在编辑模式下以 textarea 的实时内容为准（PM 编辑模式下
          // 若读标签内容会漏掉最近一次 onContentChange 之后的字符）
          if (isCurrent && isSourceMode) return sourceContentRef.current;
          return useEditorStore.getState().openTabs[i]?.content ?? "";
        },
      });
    }
    return out;
  }, [currentDocKey, isSourceMode]);

  const applyFileText = useCallback((fileKey: string, newText: string) => {
    const curKey = currentDocKey();
    if (curKey && fileKey === curKey) {
      // v0.14.0 需求1+2：当前文档必须走**统一写回入口**——它会按当前视图模式分别
      // dispatch 到 ProseMirror（阅读模式立即生效 + 进 PM 撤销栈）或写 textarea 状态
      // （源码模式 + 记 diff 撤销记录）。旧实现只改 state，阅读模式下用户看不到任何变化。
      writeBackCurrentDoc(newText);
      return;
    }
    const st = useEditorStore.getState();
    const idx = st.openTabs.findIndex((tab, i) =>
      tab.isUntitled
        ? `${UNTITLED_PROGRESS_PREFIX}${tab.id ?? i}` === fileKey
        : (tab.path || "") === fileKey,
    );
    if (idx < 0) return;
    // v0.14.0 需求2：「跨文件替换后切到对应文件也能撤销/恢复」。
    //
    // v0.15.0 需求（跨模式撤销统一）：记录方式从「docHistoryStore 的 crossFileEdit」
    // **改为统一时间线上的 `origin:"cross-file"` 条目**。
    // 为什么必须改：撤销入口已不再内联消费 `peekCrossFileUndo`，而是统一委托
    // coordinator；若这里仍写旧记录，切过去按 Ctrl+Z 时**没有任何人消费它**
    // （实机探针实测：跨文件替换后 A/B 都撤不动，8 项 FAIL）。
    //
    // `commitWholeText` 会先按该标签的真实内容对齐时间线基线（knownText 不一致时
    // rebase），因此未激活文档也能正确入账；切过去后 coordinator 的方向敏感护栏
    // 会校验 after/before 是否仍匹配，不匹配就丢弃而不覆盖用户编辑。
    commitWholeText(documentHistory, fileKey, st.openTabs[idx].content ?? "", newText, "cross-file");
    st.updateTabContent(idx, newText);
    st.updateTabDirty(idx, true);
  }, [currentDocKey, writeBackCurrentDoc]);

  return {
    collectSearchFiles,
    applyFileText
  };
}
