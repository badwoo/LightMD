/**
 * src/components/editor/panes/SearchHost/types.ts —— SearchHost pane 的入参/出参类型
 *
 * ⚠️ 由 v0.17.0 P0-1 拆分生成：字段类型全部是 TypeChecker 实测（`typeToString`），
 * 没有 any / Record<string,any> 兜底。字段含义见 SearchHost.tsx 文件头与字段名。
 *
 * 这是「纯搬运」的必要成本：hook 体必须逐字节原样，因此它引用的每个外部名字
 * 都要在入参/出参里有显式落点。
 */

import type { MutableRefObject } from "react";
import type { SearchableFile } from "../.././SearchReplace";

/** 容器传给 SearchHost 的全部入参（解构到本地名后 hook 体与拆分前逐字节一致） */
 export interface SearchHostParams {
  currentDocKey: () => string | null;
  isSourceMode: boolean;
  sourceContentRef: MutableRefObject<string>;
  writeBackCurrentDoc: (newText: string) => void;
}

/** SearchHost 交回容器的全部产物（容器与其它 pane 只通过这些名字使用它） */
export interface SearchHostResult {
  collectSearchFiles: () => SearchableFile[];
  applyFileText: (fileKey: string, newText: string) => void;
}
