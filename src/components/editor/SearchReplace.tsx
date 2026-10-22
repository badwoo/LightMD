/**
 * SearchReplaceDialog —— 搜索和替换对话框（浮动窗口）
 *
 * 支持 Ctrl+F 搜索和 Ctrl+H 查找替换
 * 在阅读模式下搜索 ProseMirror 内容，在编辑模式下搜索 textarea 内容
 *
 * v0.3.5 改进：
 * - 浮动窗口，支持拖拽移动
 * - Ctrl+F 重复按可重新激活搜索框
 * - 搜索框编辑时保持焦点（不被 ProseMirror focus 抢走）
 * - 修复阅读模式搜索高亮与匹配位置不一致（buildOffsetBlocks 同时构建 text，保证偏移一致）
 *
 * 性能优化：
 * - buildOffsetMap 从每字符 Map 改为块级数组 + 二分查找
 * - 100KB 文档：内存从 4-8MB 降至 20-80KB
 *
 * v0.14.0 需求2（搜索增强）：
 * - 选项区改为 4 个勾选框：全词匹配 / 匹配大小写 / 选取范围内 / 正则（默认全不勾）
 * - 「选取范围内」= **勾选瞬间**捕获一次选区作为范围快照，之后随替换增量平移
 *   （不平移就会在第一次替换后失效，用户会看到「替换越界」）
 * - 「查找所有打开文件」：条幅列出每个文件的命中行，点条目跳到对应文件/位置
 * - 替换（单个/全部）与查找共用同一份 SearchOptions，范围外的文本永不被改写
 * - 纯函数层抽到 utils/searchEngine.ts（本文件只保留组件与兼容包装）
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import type { Node as PMNode } from "prosemirror-model";
import { searchHighlightKey } from "../../core/editor";
import { useEditorStore } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
import {
  lookupPmPos,
  pmPosToTextOffset,
  buildSearchRegexEx,
  findMatchRangesEx,
  buildRawOffsetMap,
  rawOffsetToNormalized,
  applyReplacementToRange,
  collectFileResults,
  resolveJumpOffset,
  resolveJumpByOccurrence,
  MAX_FILES,
  type MatchRange,
  type OffsetBlock,
  type SearchOptions,
  type SearchFileResult,
} from "../../utils/searchEngine";
import { requestSearchJump, peekSearchJump, takeSearchJump, type SearchJumpTarget } from "../../utils/searchJump";
import "./SearchReplace.css";

// R4 起 MatchRange 就由本文件导出（既有测试/调用方按此路径 import），
// v0.14.0 实现搬到 utils/searchEngine.ts 后这里保持同名再导出，避免改调用方。
export type { MatchRange };

/** 「查找所有打开文件」的数据来源：一个可搜索的已打开文件 */
export interface SearchableFile {
  /** 文件稳定标识（当前文件夹用 `tab.id ?? tab.path`） */
  fileKey: string;
  /** 绝对路径（临时文件为空串） */
  filePath: string;
  /** 展示用文件名 */
  fileName: string;
  /**
   * 返回**实时**文本（不能是渲染时的快照）。
   * 为什么是函数而不是字符串：条幅可能要过一会儿才展开/刷新，
   * 期间用户可能已经改了当前文档或切了标签；传字符串会把旧内容搜出来。
   *
   * 注意：这里返回的必须是**未归一化**的原文（可含 CRLF），
   * collectFileResults 内部会自己做换行归一化并算行号。
   */
  getText: () => string;
}

interface SearchReplaceProps {
  onClose: () => void;
  editorView: import("prosemirror-view").EditorView | null;
  sourceTextareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  sourceContent?: string;
  onSourceContentChange?: (content: string) => void;
  /** 初始是否显示替换行（Ctrl+H 时为 true） */
  initialShowReplace?: boolean;
  /** Issue 6：是否为 Markdown 文件。非 md 文件总是走 sourceContent 搜索分支（ProseMirror 为空） */
  isMdFile?: boolean;
  /**
   * v0.14.0：当前文档稳定标识（App 侧传 `activeTab.id ?? activeTab.path`）。
   * 用途：切文件 / 切模式时判定「选取范围内」的旧快照失效。
   * 缺省时退化为只按模式判断（独立测试用）。
   */
  docKey?: string;
  /**
   * v0.14.0：「查找所有打开文件」的数据来源。
   * 缺省时功能退化为「仅搜索当前文档」（保证面板可独立测试、也保证未接线时不崩）。
   */
  collectFiles?: () => SearchableFile[];
  /** v0.14.0：跨文件跳转回调（切标签由 App 负责；缺省只派发 lightmd:search-jump 事件） */
  onJumpToFile?: (t: SearchJumpTarget) => void;
  /**
   * v0.14.0：编辑模式下右侧预览是否打开（两模式合并后由 Lead 接线；缺省按 true）。
   * 用途：右侧没有预览面板时条幅可以给更高（不存在「遮住预览」的顾虑）。
   */
  splitPreviewOpen?: boolean;
}

// ─── 块级偏移映射（v0.14.0：实现已抽到 utils/searchEngine.ts）──────────

/**
 * 偏移映射结果类型（保留在本文件的理由：既有测试按 `interface OffsetMap` 锁定，
 * 且组件内多处按此结构标注；实现见 utils/searchEngine.ts 的 buildOffsetMap）。
 */
interface OffsetMap {
  text: string;
  blocks: OffsetBlock[];
}

/**
 * 构建块级偏移映射数组，同时构建 textContent。
 *
 * 问题2修复（v0.3.5）：text 和 blocks 必须在**同一次遍历**中构建，保证偏移量完全一致。
 * 旧实现用 textBetween 取 text、另一趟构建 blocks，两边的换行插入逻辑不一致 →
 * 阅读模式高亮位置整体偏移。
 *
 * ⚠️ v0.14.0：同一份逻辑在 utils/searchEngine.ts 里也有一份（纯函数层需要它，
 * 而纯函数层不能反向依赖本组件）。两处必须逐字一致，由 v0140-search-engine.test.ts
 * 的「两份 buildOffsetMap 输出一致」用例守护；改这里务必同步改那边。
 * 之所以不在这里只写一行 `return buildOffsetMapCore(doc)`：v0.3.5 的防回退用例
 * 按本文件的函数体锁定「同趟遍历」这一性质，留薄封装会让该用例失去实际保护力。
 */
function buildOffsetMap(doc: PMNode): OffsetMap {
  const blocks: OffsetBlock[] = [];
  let textOffset = 0;
  let lastBlockPos = -1;
  let text = "";

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      // 块边界换行符：textContent 在块边界插入换行符
      if (lastBlockPos >= 0) {
        textOffset += 1;
        text += "\n";
        lastBlockPos = -1;
      }
      blocks.push({
        textStart: textOffset,
        textEnd: textOffset + node.text.length,
        pmStart: pos,
      });
      text += node.text;
      textOffset += node.text.length;
    } else if (node.isBlock && !node.isInline && pos > 0) {
      lastBlockPos = pos;
    }
    return true;
  });

  return { text, blocks };
}

/**
 * R4（v0.10.0）：按模式构造搜索正则（纯函数，便于单元测试）
 *
 * - 关闭正则：全量转义元字符（v0.4.2 字面量语义回归不变）
 * - 开启正则：直接按正则语义构造；非法正则返回 null（组件据此红字提示、禁用查找，
 *   不抛异常不崩溃）
 *
 * v0.14.0：内部委托 buildSearchRegexEx（多出全词断言能力），签名保持向后兼容。
 *
 * @returns 带全局标志的 RegExp；非法正则返回 null
 */
export function buildSearchRegex(searchText: string, caseSensitive: boolean, useRegex: boolean): RegExp | null {
  // 实现细节：全词匹配不在旧签名里，故此处等价于 buildSearchRegexEx 的「无全词」分支；
  // 需要全词时请直接用 buildSearchRegexEx(searchText, { wholeWord: true }).
  return buildSearchRegexEx(searchText, { caseSensitive, useRegex });
}

/**
 * R4：在文本中搜索匹配区间（纯函数，textarea 与 PM 两条路径共用）
 *
 * @returns 匹配区间数组；开启正则且表达式非法时返回 null；空关键词返回 []
 */
export function findMatchRanges(
  text: string,
  searchText: string,
  caseSensitive = false,
  useRegex = false,
): MatchRange[] | null {
  return findMatchRangesEx(text, searchText, { caseSensitive, useRegex });
}

/**
 * R4：展开替换文本中的捕获组引用（$1/$2/$& 等）
 *
 * - 正则模式：用原生 String.replace 语义展开（与 textarea 路径的
 *   String.replace(replacement) 行为一致）
 * - 字面量模式：替换文本原样输出（保持 v0.4.2 行为，"$1" 不展开）
 */
export function expandReplacement(matchedText: string, regex: RegExp, replacement: string, useRegex: boolean): string {
  if (!useRegex) return replacement;
  return matchedText.replace(regex, replacement);
}

/**
 * Issue 6：在文本中搜索匹配项，返回匹配起始位置数组（纯函数，便于单元测试）
 *
 * 用于 md 文件的 ProseMirror 内容搜索和非 md 文件的 textarea 源码搜索。
 * 特殊字符会被正则转义，避免搜索文本中含 . * + 等时误匹配。
 * R4：内部委托 findMatchRanges（区间 → 起点数组兼容层）；开启正则且非法时返回 []。
 *
 * @param text 待搜索的文本（sourceContent 或 PM textContent）
 * @param searchText 搜索关键词
 * @param caseSensitive 是否区分大小写
 * @param useRegex 是否按正则语义匹配（R4）
 * @returns 匹配起始位置数组（0-indexed），最多返回 10000 个以防无限循环
 */
export function findMatches(text: string, searchText: string, caseSensitive = false, useRegex = false): number[] {
  const ranges = findMatchRanges(text, searchText, caseSensitive, useRegex);
  return ranges ? ranges.map((r) => r.start) : [];
}

/** 「选取范围内」快照的空范围哨兵：无选区时用它把匹配数压成 0（见 toggleInSelection） */
const EMPTY_RANGE: MatchRange = { start: 0, end: 0 };
/** collectFiles 缺省（仅当前文档）时使用的 fileKey */
const FALLBACK_FILE_KEY = "__search_current_doc__";

export function SearchReplaceDialog({
  onClose,
  editorView,
  sourceTextareaRef,
  sourceContent,
  onSourceContentChange,
  initialShowReplace = false,
  isMdFile = true,
  docKey,
  collectFiles,
  onJumpToFile,
  splitPreviewOpen,
}: SearchReplaceProps) {
  const t = useT();
  const viewMode = useEditorStore((s) => s.viewMode);
  /**
   * 编辑模式下右侧预览是否打开（v0.14.0 两模式合并后由 store 持有）。
   *
   * 为什么这里既支持 prop 又读 store：
   * - store 里的 `splitPreviewOpen` 是权威值（Lead 已接线），面板独立渲染时也能拿到正确的默认值；
   * - prop 保留作显式覆盖入口（测试/将来把面板复用到其它宿主时用）。
   * 缺省按 `true` 处理（与 store 默认值一致），保证面板不会因未接线而少一块高度。
   */
  const storeSplitPreviewOpen = useEditorStore((s) => s.splitPreviewOpen);
  const previewOpen = splitPreviewOpen ?? storeSplitPreviewOpen ?? true;
  /**
   * 源码模式判定（v0.14.0：两模式合并后**唯一正确**的写法是 `viewMode !== "preview"`）。
   *
   * 为什么不能写 `viewMode === "edit" || viewMode === "split"`：
   * 本版把「编辑/分屏」合并成一个「编辑模式 + 预览开关」，`"split"` 这个值会消失；
   * 任何硬编码 "split" 的判断在合并后都会静默失配（搜索在编辑模式下直接失效）。
   * 非 md 文件永远走源码分支（PM 为空），故仍保留 `|| !isMdFile`。
   */
  const isSourceMode = viewMode !== "preview" || !isMdFile;
  // 问题3：监听 searchFocusKey 变化，重复按 Ctrl+F 时重新聚焦
  const searchFocusKey = useEditorStore((s) => s.searchFocusKey);
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  /**
   * 匹配大小写（沿用的是 R4 以来的同一个 state，v0.14.0 只是把 UI 从按钮换成勾选框）。
   * ⚠️ 不要再新增一份「matchCase」状态：两份状态会让勾选框与搜索行为脱钩。
   */
  const [caseSensitive, setCaseSensitive] = useState(false);
  // R4：正则开关与非法表达式标记（非法时红字提示、禁用查找）
  const [useRegex, setUseRegex] = useState(false);
  // v0.14.0：全词匹配（默认不勾）
  const [wholeWord, setWholeWord] = useState(false);
  // v0.14.0：「选取范围内」勾选状态 + 范围快照（快照 = 勾选瞬间的选区，之后随替换平移）
  const [inSelection, setInSelection] = useState(false);
  const [selectionRange, setSelectionRange] = useState<MatchRange | null>(null);
  // v0.14.0：「查找所有打开文件」条幅
  const [showResults, setShowResults] = useState(false);
  const [fileResults, setFileResults] = useState<SearchFileResult[]>([]);
  const [resultFileCounts, setResultFileCounts] = useState<Record<string, number>>({});
  const [resultMatchTotal, setResultMatchTotal] = useState(0);
  const [resultsTruncated, setResultsTruncated] = useState(false);
  const [regexInvalid, setRegexInvalid] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [showReplace, setShowReplace] = useState(initialShowReplace);

  // 当 initialShowReplace 变化时同步 showReplace（Ctrl+H 在已打开搜索框时切换到替换模式）
  useEffect(() => {
    if (initialShowReplace) setShowReplace(true);
  }, [initialShowReplace]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // R4：匹配数组升级为区间（正则匹配长度可变），高亮/替换均按区间计算
  const matchesRef = useRef<MatchRange[]>([]);
  // 缓存偏移映射，performSearch 构建后 highlightMatch 复用
  const offsetMapRef = useRef<OffsetMap | null>(null);
  // 选区快照所属文档（docKey+m 模式）：与当前文档不一致时快照作废
  const selectionDocKeyRef = useRef<string>("");
  /**
   * collectFiles 走 ref：EditorContainer 很可能用内联箭头函数传（每次渲染新引用），
   * 若进入 useCallback 依赖会导致「重建结果 → 重渲染 → 依赖变化 → 再重建」的死循环。
   */
  const collectFilesRef = useRef(collectFiles);
  collectFilesRef.current = collectFiles;

  // ─── 问题4：浮动窗口拖拽 ──────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [initialized, setInitialized] = useState(false);

  // 初始位置：浮动在文档中间
  useEffect(() => {
    if (!initialized && containerRef.current) {
      const w = containerRef.current.offsetWidth || 460;
      const h = containerRef.current.offsetHeight || 80;
      setPosition({
        x: Math.max(20, (window.innerWidth - w) / 2),
        y: Math.max(20, (window.innerHeight - h) / 2 - 100),
      });
      setInitialized(true);
    }
  }, [initialized]);

  // 问题3修复：拖拽事件改为在 handleDragStart 中注册，避免 useEffect 挂载时 dragging=false 导致不注册
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // 不在 input/button 上触发拖拽
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "BUTTON") return;
    const startX = e.clientX;
    const startY = e.clientY;
    const posX = position.x;
    const posY = position.y;

    const handleMove = (ev: MouseEvent) => {
      const newX = posX + ev.clientX - startX;
      const newY = posY + ev.clientY - startY;
      // 限制在视口范围内
      const maxX = window.innerWidth - 60;
      const maxY = window.innerHeight - 30;
      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    };
    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    e.preventDefault();
  }, [position]);

  // 聚焦搜索框（初始 + searchFocusKey 变化时）
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // 问题3：searchFocusKey 变化时重新聚焦搜索框
  useEffect(() => {
    if (searchFocusKey > 0) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [searchFocusKey]);

  // 问题1修复：组件卸载时清除 ProseMirror 中的搜索高亮 Decoration
  useEffect(() => {
    return () => {
      if (editorView && !isSourceMode) {
        try {
          const tr = editorView.state.tr;
          tr.setMeta(searchHighlightKey, null);
          editorView.dispatch(tr);
        } catch {
          // 忽略清除错误（editorView 可能已销毁）
        }
      }
      // v0.4.3 Issue 3：清除非 md 文件阅读模式的选区高亮
      if (!isMdFile) {
        window.getSelection()?.removeAllRanges();
      }
    };
  }, [editorView, isSourceMode, isMdFile]);

  // ─── v0.14.0：「选取范围内」范围快照 ─────────────────────────

  /** 当前文档标识（docKey 由 App 提供；模式变化也算换文档） */
  const currentDocKey = `${docKey ?? ""}::${isSourceMode ? "source" : "pm"}`;

  /**
   * 读取当前文本（归一化后）与原始串。
   * 源码模式返回原文（可能含 CRLF）+ 归一化文本；阅读模式返回 PM 偏移映射的 text。
   */
  const readCurrentText = useCallback((): { text: string; raw: string | null } => {
    if (isSourceMode) {
      const raw = sourceContent ?? sourceTextareaRef?.current?.value ?? "";
      // v0.4.4 修复：规范化换行符后位置才与 textarea.value 一致
      return { text: raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), raw };
    }
    if (editorView) {
      const map = offsetMapRef.current ?? buildOffsetMap(editorView.state.doc);
      offsetMapRef.current = map;
      return { text: map.text, raw: null };
    }
    return { text: "", raw: null };
  }, [isSourceMode, sourceContent, sourceTextareaRef, editorView]);

  /**
   * 捕获当前选区为文本偏移范围。
   *
   * - 编辑模式：textarea.selectionStart/End 是**原始串**坐标，若含 CRLF 必须先换算成
   *   归一化偏移（否则每个 "\r\n" 都让范围错位一格，替换就会越界到范围外）
   * - 阅读模式：PM 的 from/to 用 buildOffsetMap 的 blocks 反查文本偏移
   *   （pmPosToTextOffset 会把落在块间隙的位置收敛到前一块末尾）
   *
   * @returns 有效选区范围；无选区/无法换算时返回 null
   */
  const captureSelectionRange = useCallback((): MatchRange | null => {
    if (isSourceMode) {
      const ta = sourceTextareaRef?.current;
      if (!ta) return null;
      const raw = sourceContent ?? ta.value;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (end <= start) return null;
      return { start: rawOffsetToNormalized(raw, start), end: rawOffsetToNormalized(raw, end) };
    }
    if (!editorView) return null;
    const sel = editorView.state.selection;
    if (sel.empty || sel.to <= sel.from) return null;
    const map = buildOffsetMap(editorView.state.doc);
    const start = pmPosToTextOffset(map.blocks, sel.from);
    const end = pmPosToTextOffset(map.blocks, sel.to);
    if (start === undefined || end === undefined || end <= start) return null;
    return { start, end };
  }, [isSourceMode, sourceContent, sourceTextareaRef, editorView]);

  /**
   * 勾选/取消「选取范围内」。
   *
   * 关键语义（用户确认过）：**勾选瞬间**捕获一次选区作为范围快照，之后不再跟随光标。
   * 为什么不做成"实时跟随"：替换会把光标/选区打散，一替换范围就丢了；
   * 也没有"实时快照"这种能力（PM 选区与文本偏移不是同一坐标系）。
   *
   * 无选区时：**保持勾选**但范围置空 → 匹配数 0 + 红字提示。
   * 为什么不静默退化成全文：用户勾了这个框就是明确表示"只在选区内操作"，
   * 若悄悄退化成全文，一次"全部替换"就会改掉整篇文档（不可逆的用户事故）。
   */
  const handleToggleInSelection = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.checked) {
      setInSelection(false);
      setSelectionRange(null);
      setSelectionLostByDocChange(false);
      return;
    }
    const captured = captureSelectionRange();
    selectionDocKeyRef.current = currentDocKey;
    setInSelection(true);
    setSelectionLostByDocChange(false);
    setSelectionRange(captured);
  }, [captureSelectionRange, currentDocKey]);

  // 切文件 / 切模式：旧快照必然错位（那时是另一个文档的坐标），立即丢弃并提示重新选取
  const [selectionLostByDocChange, setSelectionLostByDocChange] = useState(false);
  useEffect(() => {
    if (!selectionDocKeyRef.current || selectionDocKeyRef.current === currentDocKey) return;
    selectionDocKeyRef.current = currentDocKey;
    if (inSelection) {
      setSelectionRange(null);
      // 提示文案区别于「从没选过」：用户刚才明明选过，是切文档导致失效，要说清原因
      setSelectionLostByDocChange(true);
    }
  }, [currentDocKey, inSelection]);

  // 就地跳转失败的一次性提示（条幅点击落到无法定位的位置时给出可见反馈，而不是静默无反应）
  const [jumpFailed, setJumpFailed] = useState(false);
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
  }, []);

  /**
   * 本次搜索/替换使用的选项（唯一真源）。
   *
   * 范围规则：勾选「选取范围内」但没取到快照时传 `EMPTY_RANGE`（{0,0}），
   * 而 findMatchRangesEx 要求匹配**完全落在**范围内 → 任何非零长匹配都不会命中 → 匹配数 0。
   */
  const searchOptions = useMemo<SearchOptions>(() => ({
    caseSensitive,
    useRegex,
    wholeWord,
    range: inSelection ? selectionRange ?? EMPTY_RANGE : null,
  }), [caseSensitive, useRegex, wholeWord, inSelection, selectionRange]);

  // 搜索
  const performSearch = useCallback(() => {
    if (!searchText) {
      setMatchCount(0);
      setCurrentMatch(0);
      matchesRef.current = [];
      // 问题1修复：清除 ProseMirror 中的搜索高亮 Decoration
      if (editorView && !isSourceMode) {
        const tr = editorView.state.tr;
        tr.setMeta(searchHighlightKey, null);
        editorView.dispatch(tr);
      }
      // v0.4.3 Issue 3：清除非 md 文件阅读模式的选区高亮
      if (!isMdFile && viewMode === "preview") {
        window.getSelection()?.removeAllRanges();
      }
      return;
    }

    let text: string;
    if (isSourceMode) {
      // v0.4.4 修复：规范化换行符 \r\n → \n。
      // textarea.value 和 DOM 文本都会将 \r\n 规范化为 \n，
      // 如果 sourceContent 含 \r\n，findMatches 返回的位置会偏移，导致高亮选中错误内容。
      text = (sourceContent || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      offsetMapRef.current = null;
    } else if (editorView) {
      // 问题2修复：使用 buildOffsetMap 同时构建 text 和 blocks，保证偏移一致
      const map = buildOffsetMap(editorView.state.doc);
      offsetMapRef.current = map;
      text = map.text;
    } else {
      text = "";
    }

    // v0.14.0：统一走 findMatchRangesEx —— 全词/大小写/正则/范围四个约束一次性生效
    const ranges = findMatchRangesEx(text, searchText, searchOptions);
    setRegexInvalid(ranges === null);
    const matches = ranges || [];

    matchesRef.current = matches;
    setMatchCount(matches.length);
    setCurrentMatch(matches.length > 0 ? 1 : 0);

    // 高亮第一个匹配
    if (matches.length > 0) {
      highlightMatch(0);
    }
  }, [searchText, searchOptions, isSourceMode, sourceContent, editorView, isMdFile, viewMode]);

  // 搜索文本变化时自动搜索
  useEffect(() => {
    performSearch();
  }, [performSearch]);

  // 高亮匹配位置
  const highlightMatch = useCallback((index: number) => {
    if (matchesRef.current.length === 0) return;

    // v0.4.3 Issue 3：非 md 文件阅读模式下 textarea 隐藏（display:none），
    // 需要在 .plaintext-preview 容器中通过 Range 选区高亮匹配文本
    if (!isMdFile && viewMode === "preview") {
      const previewEl = document.querySelector(".plaintext-preview");
      if (!previewEl) return;
      const range = matchesRef.current[index];
      const pos = range.start;
      // R4：正则匹配长度可变，按区间计算终点
      const endPos = range.end;
      // TreeWalker 遍历文本节点，定位匹配的起止位置（PrismJS 高亮后文本被分散在多个 span 中）
      const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
      let charCount = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const nodeLen = node.nodeValue?.length || 0;
        if (!startNode && charCount + nodeLen > pos) {
          startNode = node;
          startOffset = Math.max(0, pos - charCount);
        }
        if (charCount + nodeLen >= endPos) {
          endNode = node;
          endOffset = Math.max(0, endPos - charCount);
          break;
        }
        charCount += nodeLen;
      }
      if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        // 滚动到匹配位置（居中显示）
        const rect = range.getBoundingClientRect();
        const containerRect = previewEl.getBoundingClientRect();
        const targetTop = rect.top - containerRect.top + previewEl.scrollTop - containerRect.height / 2;
        previewEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
      }
      return;
    }

    if (isSourceMode && sourceTextareaRef?.current) {
      const textarea = sourceTextareaRef.current;
      // R4：按区间选区（正则匹配长度可变）
      const range = matchesRef.current[index];
      const pos = range.start;
      // Issue 6：非 md 文件在 preview 模式下 textarea 隐藏（display:none），
      // offsetParent === null 表示不可见，此时跳过视觉高亮（仅显示匹配计数）
      if (textarea.offsetParent === null) return;
      textarea.focus();
      textarea.setSelectionRange(pos, range.end);
      // 滚动到匹配位置
      const lines = textarea.value.substring(0, pos).split("\n");
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTop = (lines.length - 1) * lineHeight;
    } else if (editorView) {
      // ProseMirror 模式下，使用 offsetMapRef 中的 blocks 映射位置
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;
        const range = matchesRef.current[index];
        const targetOffset = range.start;

        // 查找匹配起始位置对应的 PM 位置
        const pmStart = lookupPmPos(offsetMap.blocks, targetOffset);
        if (pmStart !== undefined) {
          // 查找匹配结束位置对应的 PM 位置（R4：区间终点 - 1）
          const pmEnd = lookupPmPos(offsetMap.blocks, range.end - 1);
          if (pmEnd !== undefined) {
            const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
            // 问题1修复：使用 ProseMirror Decoration 高亮匹配内容，不依赖编辑器焦点
            // 通过 searchHighlightKey meta 更新 Plugin state，Decoration 始终可见
            const tr = editorView.state.tr;
            tr.setMeta(searchHighlightKey, { from: pmStart, to: endPos });
            tr.scrollIntoView();
            editorView.dispatch(tr);

            // 阅读模式下 handleScrollToSelection 返回 true 会阻止自动滚动
            // 手动滚动到匹配位置（使用 editor-container 作为滚动容器）
            const view = editorView;
            requestAnimationFrame(() => {
              try {
                const coords = view.coordsAtPos(pmStart);
                const scrollContainer = view.dom.parentElement as HTMLElement | null;
                if (scrollContainer) {
                  const containerRect = scrollContainer.getBoundingClientRect();
                  // 计算目标滚动位置，让匹配位置出现在容器中部
                  const targetTop = coords.top - containerRect.top + scrollContainer.scrollTop - containerRect.height / 2;
                  scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
                }
              } catch {
                // 忽略滚动错误
              }
            });
          }
        }
      } catch {
        // 忽略位置计算错误
      }
    }
  }, [isSourceMode, sourceTextareaRef, editorView, isMdFile, viewMode]);

  // 上一个/下一个
  const goToMatch = useCallback((direction: 1 | -1) => {
    if (matchesRef.current.length === 0) return;
    const newIdx = currentMatch - 1 + direction;
    const wrapped = ((newIdx % matchesRef.current.length) + matchesRef.current.length) % matchesRef.current.length;
    setCurrentMatch(wrapped + 1);
    highlightMatch(wrapped);
  }, [currentMatch, highlightMatch]);

  // 替换当前
  const replaceCurrent = useCallback(() => {
    if (matchesRef.current.length === 0 || currentMatch === 0) return;

    // R4：正则模式下用展开后的替换文本（支持 $1 捕获组）
    // v0.14.0：正则与匹配集合同源（全词/大小写/范围一致），否则会替换到查找结果之外的文本
    const regex = buildSearchRegexEx(searchText, { caseSensitive, useRegex, wholeWord });
    if (!regex) return;
    const range = matchesRef.current[currentMatch - 1];
    // 匹配文本按路径取源：textarea 路径来自 sourceContent，PM 路径来自 offsetMap.text
    // （R4 修复：阅读模式下 sourceContent 为 undefined，不能作为匹配文本来源）
    // v0.14.0：源码模式必须先做换行归一化再切 —— range 是**归一化文本**的坐标，
    // 直接切含 CRLF 的原文会让 $1/$& 匹配到错位的字符。
    const matched = isSourceMode && sourceContent !== undefined
      ? sourceContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").substring(range.start, range.end)
      : offsetMapRef.current?.text.substring(range.start, range.end) ?? searchText;
    const expanded = expandReplacement(matched, regex, replaceText, useRegex);

    if (isSourceMode && sourceTextareaRef?.current && sourceContent !== undefined && onSourceContentChange) {
      // v0.14.0：命中偏移是「归一化文本」坐标，写回时必须换算回原始串坐标，
      // 否则含 CRLF 的文档每替换一次就错位一格（后面越替换越偏）。
      const rawMap = buildRawOffsetMap(sourceContent);
      const rawStart = rawMap ? rawMap[Math.min(range.start, rawMap.length - 1)] : range.start;
      const rawEnd = rawMap ? rawMap[Math.min(range.end, rawMap.length - 1)] : range.end;
      const newContent = sourceContent.substring(0, rawStart) + expanded + sourceContent.substring(rawEnd);
      onSourceContentChange(newContent);
    } else if (editorView) {
      // 阅读模式：通过 ProseMirror transaction 替换文本
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;

        const pmStart = lookupPmPos(offsetMap.blocks, range.start);
        const pmEnd = lookupPmPos(offsetMap.blocks, range.end - 1);
        if (pmStart !== undefined && pmEnd !== undefined) {
          const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
          const tr = editorView.state.tr.insertText(expanded, pmStart, endPos);
          tr.setMeta("addToHistory", true);
          editorView.dispatch(tr);
        }
      } catch {
        // 忽略替换错误
      }
    }

    // v0.14.0：替换后平移范围快照（不平移的话第二次替换就会越出原选区，用户在范围外的文本被改）
    if (inSelection && selectionRange) {
      setSelectionRange(applyReplacementToRange(selectionRange, range.start, range.end - range.start, expanded.length));
    }

    // 替换后重新搜索
    setTimeout(() => performSearch(), 50);
  }, [isSourceMode, sourceTextareaRef, sourceContent, onSourceContentChange, currentMatch, searchText, replaceText, caseSensitive, useRegex, wholeWord, inSelection, selectionRange, performSearch, editorView]);

  // 全部替换
  const replaceAll = useCallback(() => {
    if (!searchText || matchesRef.current.length === 0) return;

    const regex = buildSearchRegexEx(searchText, { caseSensitive, useRegex, wholeWord });
    if (!regex) return;
    const matches = matchesRef.current;
    /** 计算第 i 个命中的替换文本（逐 match 展开捕获组；字面量模式原样替换） */
    const expandedOf = (i: number, sourceText: string): string =>
      expandReplacement(sourceText.substring(matches[i].start, matches[i].end), regex, replaceText, useRegex);

    if (isSourceMode && sourceContent !== undefined && onSourceContentChange) {
      const raw = sourceContent;
      const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const rawMap = buildRawOffsetMap(raw);
      // v0.14.0：只替换 matchesRef 里的命中（已按范围/全词过滤），不再用 String.replace 全文替换。
      // 逆序拼接：从后往前改，前面的偏移量不受影响。
      let next = raw;
      for (let i = matches.length - 1; i >= 0; i--) {
        const expanded = expandedOf(i, normalized);
        const rawStart = rawMap ? rawMap[Math.min(matches[i].start, rawMap.length - 1)] : matches[i].start;
        const rawEnd = rawMap ? rawMap[Math.min(matches[i].end, rawMap.length - 1)] : matches[i].end;
        next = next.substring(0, rawStart) + expanded + next.substring(rawEnd);
      }
      onSourceContentChange(next);
    } else if (editorView) {
      // 阅读模式：从后往前替换，避免位置偏移（v0.14.0：同样只替换过滤后的命中）
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;

        let tr = editorView.state.tr;
        // 从后往前替换，这样前面的偏移量不会受影响
        for (let i = matches.length - 1; i >= 0; i--) {
          const range = matches[i];
          const pmStart = lookupPmPos(offsetMap.blocks, range.start);
          const pmEnd = lookupPmPos(offsetMap.blocks, range.end - 1);
          if (pmStart !== undefined && pmEnd !== undefined) {
            const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
            // R4：逐 match 展开捕获组（字面量模式原样替换）
            tr = tr.insertText(expandedOf(i, offsetMap.text), pmStart, endPos);
          }
        }
        tr.setMeta("addToHistory", true);
        editorView.dispatch(tr);
      } catch {
        // 忽略替换错误
      }
    }

    // v0.14.0：范围快照随「全部替换」平移。
    // 按命中升序逐次套用 applyReplacementToRange（相当于把 N 次替换依次施加到范围上），
    // 因为范围只罩住这些命中，所以起点不动、终点按累计增量伸缩。
    if (inSelection && selectionRange) {
      const normalized = isSourceMode ? (sourceContent ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n") : offsetMapRef.current?.text ?? "";
      let shifted = selectionRange;
      let acc = 0; // 已处理命中造成的累计位移
      for (let i = 0; i < matches.length; i++) {
        const inserted = expandedOf(i, normalized).length;
        const removed = matches[i].end - matches[i].start;
        shifted = applyReplacementToRange(shifted, matches[i].start + acc, removed, inserted);
        acc += inserted - removed;
      }
      setSelectionRange(shifted);
    }

    setTimeout(() => performSearch(), 50);
  }, [isSourceMode, sourceContent, onSourceContentChange, searchText, replaceText, caseSensitive, useRegex, wholeWord, inSelection, selectionRange, performSearch, editorView]);

  // ─── v0.14.0：「查找所有打开文件」结果条幅 ─────────────────────

  /**
   * 取某个文件的「本轮搜索选项」。
   *
   * 范围（range）只属于**当前文档**：选区快照是当前文档的文本坐标，套到别的文件上
   * 会误杀该文件所有结果（而且毫无意义）。所以只有 fileKey === 当前文档 key 时才传范围。
   */
  const optionsForFile = useCallback((fileKey: string): SearchOptions => {
    const currentKey = docKey ?? FALLBACK_FILE_KEY;
    return {
      caseSensitive,
      useRegex,
      wholeWord,
      range: inSelection ? (fileKey === currentKey ? selectionRange ?? EMPTY_RANGE : null) : null,
    };
  }, [caseSensitive, useRegex, wholeWord, inSelection, selectionRange, docKey]);

  /**
   * 重建条幅结果（同步执行，不做任何 IO）。
   *
   * 数据来源：props.collectFiles()（App 侧提供所有已打开文件 + 实时 getText）；
   * 缺省时退化成「仅当前文档」——保证面板可独立测试，也保证未接线时不崩。
   *
   * 文本空间口径（与 Lead 的接线约定一致，改动前请先对齐）：
   * - 当前文档：优先用 readCurrentText()（阅读模式 = PM 文本、编辑模式 = 源码文本）。
   *   为什么必须走它：`selectionRange` 是当前文档文本空间的偏移，替换/上一个下一个
   *   全部依赖同一空间；用 getText()（源码）来搜当前文档，在阅读模式下会和替换坐标系打架。
   * - 其他文件：用 getText()（App 传的是该标签的 markdown 源码）。
   * - 「选取范围内」勾选时**跳过其他文件**：选区只有当前文档有，把当前文档的文本偏移
   *   套到别的文件上毫无意义，只会把所有结果误杀成 0（用户会以为"别的文件里没有"）。
   */
  const rebuildResults = useCallback(() => {
    if (!searchText) {
      setFileResults([]);
      setResultFileCounts({});
      setResultMatchTotal(0);
      setResultsTruncated(false);
      return;
    }
    const currentKey = docKey ?? FALLBACK_FILE_KEY;
    const currentText = readCurrentText().text;
    const provided = collectFilesRef.current ? collectFilesRef.current() : null;
    const files: SearchableFile[] = provided
      ? provided
      : [
          {
            fileKey: currentKey,
            filePath: "",
            fileName: docKey ? docKey.split(/[\\/]/).pop() ?? docKey : "",
            getText: () => currentText,
          },
        ];

    const results: SearchFileResult[] = [];
    const counts: Record<string, number> = {};
    let total = 0;
    let truncated = false;
    // MAX_FILES 上限：打开上百个标签时全量搜索会卡死 UI（文本可能上百 MB），
    // 超出部分直接不搜，并在汇总里标记「结果过多」让用户收窄条件。
    const limit = Math.min(files.length, MAX_FILES);
    if (files.length > MAX_FILES) truncated = true;
    for (let i = 0; i < limit; i++) {
      const f = files[i];
      const isCurrentDoc = f.fileKey === currentKey;
      // 选取范围内只对当前文档成立 → 其他文件整份跳过（见函数头注释）
      if (inSelection && !isCurrentDoc) continue;
      const content = isCurrentDoc ? currentText : f.getText();
      // 当前文档带 range；其他文件 range 恒为 null（optionsForFile 内部已保证）
      const res = collectFileResults(
        content,
        { query: searchText, ...optionsForFile(f.fileKey) },
        { fileKey: f.fileKey, filePath: f.filePath, fileName: f.fileName },
      );
      if (res.truncated) truncated = true;
      if (res.results.length > 0) {
        counts[f.fileKey] = res.matchCount;
        total += res.matchCount;
      }
      for (const r of res.results) results.push(r);
    }
    setFileResults(results);
    setResultFileCounts(counts);
    setResultMatchTotal(total);
    setResultsTruncated(truncated);
  }, [searchText, optionsForFile, docKey, readCurrentText]);

  /** 搜索词/选项/范围变化时，条幅已展开就自动刷新（跟着查找走，不需要再点一次按钮） */
  useEffect(() => {
    if (!showResults) return;
    rebuildResults();
  }, [showResults, rebuildResults]);

  /** 「查找所有打开文件」按钮：展开 ↔ 收起 */
  const toggleResults = useCallback(() => {
    setShowResults((v) => !v);
  }, []);

  /**
   * 点击某条结果 → 跳转。
   *
   * 两种分支：
   * - 目标是当前文档：**就地跳转**，用「行/列 + 关键词」在同文本空间里定位，最精确
   *   （不派发切标签事件，避免 App 多余地重建编辑器导致面板失焦）
   * - 目标是别的文件：把目标（含 `occurrence`）写入跨组件跳转契约并派发事件让 App 切标签。
   *   为什么跨文件不用行号：结果算在源码空间，跳过去可能是阅读模式（PM 文本空间），
   *   行号会错位；用「第 N 次出现」定位见 resolveJumpByOccurrence。
   *   定位闭环由下面的 docKey effect 在本文件内完成 —— 不依赖 EditorContainer 改定位逻辑。
   */
  const handleResultClick = useCallback((r: SearchFileResult) => {
    const length = Math.max(1, (r.ranges[0]?.end ?? 0) - (r.ranges[0]?.start ?? 0));
    const target: SearchJumpTarget = {
      fileKey: r.fileKey,
      filePath: r.filePath,
      line: r.line,
      column: r.column,
      length,
      query: searchText,
      occurrence: r.occurrence,
    };
    const currentKey = docKey ?? FALLBACK_FILE_KEY;
    if (r.fileKey === currentKey) {
      // 就地跳转：用「行/列 + 关键词」在当前文本里定位（三级降级，见 resolveJumpOffset）
      const { text } = readCurrentText();
      const offset = resolveJumpOffset(text, { line: r.line, column: r.column, query: searchText });
      const matches = matchesRef.current;
      let idx = matches.findIndex((m) => offset >= m.start && offset < m.end);
      if (idx < 0) idx = matches.findIndex((m) => m.start >= offset);
      if (idx < 0) idx = matches.length > 0 ? 0 : -1;
      if (idx >= 0) {
        setCurrentMatch(idx + 1);
        highlightMatch(idx);
        setJumpFailed(false);
      } else {
        // 找不到落点（例如文本刚被改过、命中已消失）：给出可见提示，而不是点了没反应
        setJumpFailed(true);
        if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
        jumpTimerRef.current = setTimeout(() => setJumpFailed(false), 2000);
      }
      return;
    }
    onJumpToFile?.(target);
    requestSearchJump(target);
  }, [docKey, readCurrentText, searchText, highlightMatch, onJumpToFile]);

  /**
   * v0.14.0：跨文件跳转的「接收端」——切标签完成后由本面板自己完成定位闭环。
   *
   * 时序：点击结果 → requestSearchJump 写入 pending + 派发 lightmd:search-jump →
   * App 切标签 → `docKey` 变成目标文件的键 → 本 effect 触发。
   *
   * 为什么用 docKey 变化来触发而不是监听事件：
   * 事件派发时目标文档还没加载好（内容/文本空间都还是旧的），此时定位必然算错。
   * docKey 变化才是「目标文档已成为当前文档」的可靠信号。
   *
   * 为什么拿 peekSearchJump 再 take：
   * 别的窗口/别的面板实例也可能有 pending，必须先确认 fileKey 与当前 docKey 一致才消费，
   * 否则会把别人的跳转请求吃掉（表现为"点了结果但没反应"）。
   */
  useEffect(() => {
    const key = docKey;
    if (!key) return;
    const pending = peekSearchJump();
    if (!pending || pending.fileKey !== key) return;
    const taken = takeSearchJump(key);
    if (!taken) return;
    // 用「第 N 次出现」在当前文本空间定位（跨源码/PM 空间靠 occurrence，不靠行号）
    const { text } = readCurrentText();
    const offset = resolveJumpByOccurrence(text, taken.query, taken.occurrence, {
      caseSensitive,
      useRegex,
      wholeWord,
    });
    const matches = matchesRef.current;
    let idx = offset === null ? -1 : matches.findIndex((m) => offset >= m.start && offset < m.end);
    if (idx < 0 && offset !== null) idx = matches.findIndex((m) => m.start >= offset);
    if (idx >= 0) {
      setCurrentMatch(idx + 1);
      highlightMatch(idx);
      setJumpFailed(false);
    } else {
      // 定位不到（文本刚被改过 / 关键词在渲染文本里形态不同）：给可见提示，2 秒后复位
      setJumpFailed(true);
      if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = setTimeout(() => setJumpFailed(false), 2000);
    }
    // 依赖里只放 docKey 与搜索选项：本 effect 的职责就是"文档就绪后消费一次 pending"，
    // 把 matches 等易变引用放进来会重复触发消费（pending 已被 take，第二次为空但语义混淆）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, caseSensitive, useRegex, wholeWord]);

  // 键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") {
      onClose();
    }
  }, [goToMatch, onClose]);

  return (
    <div
      ref={containerRef}
      className={`search-replace search-replace-floating${previewOpen ? "" : " search-replace-solo"}`}
      style={initialized ? { left: position.x, top: position.y } : undefined}
      onKeyDown={handleKeyDown}
    >
      {/* 拖拽条 */}
      <div className="search-drag-handle" onMouseDown={handleDragStart}>
        <span className="search-drag-dots">⋮⋮</span>
        <span className="search-drag-title">{t("search.placeholder")}</span>
        <button className="search-close-btn" title={t("search.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="search-row">
        <input
          ref={searchInputRef}
          className={`search-input${regexInvalid ? " search-input-invalid" : ""}`}
          type="text"
          placeholder={t("search.placeholder")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button className="search-nav-btn" title={t("search.previous")} onClick={() => goToMatch(-1)} disabled={matchCount === 0}>
          ↑
        </button>
        <button className="search-nav-btn" title={t("search.next")} onClick={() => goToMatch(1)} disabled={matchCount === 0}>
          ↓
        </button>
        <span
          className={`search-count${regexInvalid ? " search-count-invalid" : ""}`}
          data-testid="search-count"
        >
          {regexInvalid
            ? t("search.regexInvalid")
            : matchCount > 0
              ? `${currentMatch}/${matchCount}`
              : t("search.noResult")}
        </span>
        <button className="search-toggle-btn" title={t("search.toggleReplace")} onClick={() => setShowReplace(!showReplace)}>
          ⟳
        </button>
      </div>
      {/* v0.14.0：4 个勾选框（默认全不勾）+ 「查找所有打开文件」 */}
      <div className="search-options-row">
        <label className="search-check" title={t("search.wholeWord")}>
          <input
            type="checkbox"
            data-testid="search-whole-word"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          <span className="search-check-label">{t("search.wholeWord")}</span>
        </label>
        <label className="search-check" title={t("search.matchCase")}>
          <input
            type="checkbox"
            data-testid="search-match-case"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          <span className="search-check-label">{t("search.matchCase")}</span>
        </label>
        <label className="search-check" title={t("search.inSelection")}>
          <input
            type="checkbox"
            data-testid="search-in-selection"
            checked={inSelection}
            onChange={handleToggleInSelection}
          />
          <span className="search-check-label">{t("search.inSelection")}</span>
        </label>
        {/* 正则：沿用 R4 行为（可 $1 捕获组），沿用旧 title key */}
        <label className="search-check" title={t("search.useRegex")}>
          <input
            type="checkbox"
            data-testid="search-use-regex"
            checked={useRegex}
            onChange={(e) => setUseRegex(e.target.checked)}
          />
          <span className="search-check-label search-check-mono">.*</span>
        </label>
        <button
          type="button"
          className={`search-find-files-btn${showResults ? " active" : ""}`}
          data-testid="search-find-in-open-files"
          title={t("search.findInOpenFiles")}
          onClick={toggleResults}
        >
          {t("search.findInOpenFiles")}
        </button>
      </div>
      {/* 勾了「选取范围内」却没取到选区：红字提示 + 匹配数 0（绝不静默退化成全文） */}
      {inSelection && !selectionRange && (
        <div className="search-hint" data-testid="search-selection-hint">
          {selectionLostByDocChange ? t("search.selectionLost") : t("search.selectionRequired")}
        </div>
      )}
      {jumpFailed && (
        <div className="search-hint" data-testid="search-jump-hint">
          {t("search.jumpFailed")}
        </div>
      )}
      {showReplace && (
        <div className="replace-row">
          <input
            className="search-input"
            type="text"
            placeholder={t("search.replacePlaceholder")}
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button className="replace-btn" title={t("search.replaceCurrent")} onClick={replaceCurrent} disabled={matchCount === 0}>
            {t("search.replace")}
          </button>
          <button className="replace-btn" title={t("search.replaceAll")} onClick={replaceAll} disabled={matchCount === 0}>
            {t("search.replaceAll")}
          </button>
        </div>
      )}
      {/* 结果条幅：放在替换行**下方**（纵向展开而不是盖住替换行），
          条幅自身可滚动，长结果不影响面板其它控件 */}
      {showResults && (
        <div className="search-results" data-testid="search-results">
          <div className="search-results-summary" data-testid="search-results-summary">
            {fileResults.length === 0
              ? t("search.resultsEmpty")
              : t("search.resultsCount", {
                  count: resultMatchTotal,
                  files: Object.keys(resultFileCounts).length,
                })}
            {resultsTruncated && fileResults.length > 0
              ? ` · ${t("search.tooManyResults", { count: fileResults.length })}`
              : ""}
          </div>
          {fileResults.map((r, i) => (
            <div
              key={`${r.fileKey}:${r.line}:${i}`}
              className="search-result-item"
              data-testid="search-result-item"
              title={`${r.filePath || r.fileName}:${r.line}`}
              onClick={() => handleResultClick(r)}
            >
              <span className="search-result-file" data-testid="search-result-file" title={r.filePath}>
                {r.fileName || r.filePath || "—"}
                <span className="search-result-file-count">
                  ({resultFileCounts[r.fileKey] ?? r.ranges.length})
                </span>
                <span className="search-result-file-line">:{r.line}</span>
              </span>
              <span className="search-result-line" data-testid="search-result-line">
                {r.segments.map((seg, si) =>
                  seg.match ? (
                    <mark key={si} className="search-result-match" data-testid="search-result-match">
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={si}>{seg.text}</span>
                  ),
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 搜索面板「从搜索按钮顺滑出现 / 顺滑收回」动画的延迟卸载壳（v0.8.5 需求7 第三版）。
 *
 * 链路：StatusBar 搜索按钮 → useEditorStore.showSearch → EditorContainer 渲染本组件
 * （替代原先的条件渲染 SearchReplaceDialog）。
 *
 * 为什么需要壳：SearchReplaceDialog 关闭即被卸载，收回动画来不及播放。
 * 本壳采用「延迟卸载」模式（思路同 FileTree 的 SlideWrap）：
 * - 打开（active=true）→ 挂载内部面板，几何测量完成后播放呼出动画；
 * - 关闭（active=false）→ 先播「面板缩回搜索按钮」，动画结束后才真正卸载；
 * - 未打开过 → 不渲染任何 DOM（与原条件渲染行为一致，不引入常驻节点）。
 *
 * 第三版定稿：验收反馈"尾巴特效观感偏怪"，因此**整体去掉尾巴**，
 * 只保留搜索窗口本体从底栏搜索按钮顺滑冒出、再顺滑缩回按钮这一件事：
 * - --genie-from-y   面板下沿落到按钮上沿所需的位移（动画起点面板正好贴在按钮上）；
 * - --genie-origin-x 按钮中心相对面板左沿的横向位置，作为 transform-origin 的横向原点，
 *   面板收放时会朝按钮那一侧收拢 / 展开 —— 于是"从按钮里冒出来"这件事在视觉上成立。
 * 两个量都在开合瞬间各测一次（无监听、无持续开销），面板只做 transform（合成层属性），
 * 不做 opacity 动画（避免淡入期间背景透出的闪动）。具体编排见 SearchReplace.css。
 */
/**
 * 收回动画总时长：面板 0.38s 缩回按钮，定时留 60ms 余量。
 * 常量名与旧版保持一致（测试与调用方按此判断延迟卸载时机）。
 */
const GENIE_OUT_MS = 440;

export function GenieSearchDialog(props: SearchReplaceProps & { active: boolean }) {
  const { active, ...rest } = props;
  // mounted：内部面板是否挂载；closing：收回动画播放中；ready：几何变量是否已注入
  const [mounted, setMounted] = useState(active);
  const [closing, setClosing] = useState(false);
  const [ready, setReady] = useState(false);
  // effect 内判定"关闭前是否打开过"用 ref 兜底（避免 state 滞后一帧）
  const mountedRef = useRef(active);
  const shellRef = useRef<HTMLDivElement>(null);

  /**
   * 一次测量"按钮 ↔ 面板"的关系，注入出现/收回动画所需的两个 CSS 变量
   * （开合各一次，无监听、无持续开销）：
   * - --genie-from-y   面板下沿对齐按钮上沿所需的纵向位移
   *                    —— 起点即"窗口正好贴在搜索按钮上"，配合纵向压扁呈现"从按钮冒出"
   * - --genie-origin-x 按钮中心 x 相对面板左沿的位置
   *                    —— 作为 transform-origin 的横向原点，让面板朝按钮一侧收放
   * 测量失败（锚点或面板缺失）时退化为屏幕底部的常规上升动画。
   */
  const syncGenieVars = useCallback(() => {
    const shell = shellRef.current;
    // ⚠️ 必须指名搜索按钮：图片管理入口也带 `data-genie-anchor="image-manager"`，
    // 且在 DOM 中更靠前。用泛选择器 `[data-genie-anchor]` 会量到图片管理图标，
    // 搜索面板的出现/收回动画就会锚错位置（用户反馈"尾巴动画没了"）。
    const anchor = document.querySelector<HTMLElement>('[data-genie-anchor="search"]');
    const panel = shell?.querySelector<HTMLElement>(".search-replace");
    if (!shell || !anchor || !panel) return;
    const btn = anchor.getBoundingClientRect();
    const pn = panel.getBoundingClientRect();
    // 兜底：底栏锚点不可见（如被打印样式隐藏）时矩形全 0 —— 用常规上升动画，不至于不动
    const anchored = btn.width > 0 && btn.height > 0 && pn.width > 0;
    if (!anchored) {
      shell.style.setProperty("--genie-from-y", "200px");
      shell.style.setProperty("--genie-origin-x", "50%");
      return;
    }
    // 面板下沿对齐按钮上沿：>0 表示面板在按钮上方（常规情形）；
    // 面板被拖到贴着底栏时夹到 0，退化为"原地收放"而不是反向下坠
    const fromY = Math.max(0, Math.round(btn.top - pn.bottom));
    // 按钮中心相对面板左沿（可能落在面板外，此时面板朝按钮方向整体收拢，方向依然正确）
    const originX = Math.round(btn.left + btn.width / 2 - pn.left);
    shell.style.setProperty("--genie-from-y", `${fromY}px`);
    shell.style.setProperty("--genie-origin-x", `${originX}px`);
  }, []);

  useEffect(() => {
    if (active) {
      // 打开：清掉未完成的收回定时器，立即挂载并（测量后）播放呼出动画
      mountedRef.current = true;
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mountedRef.current) return;
    // 关闭：先播收回动画，结束后再真正卸载（此时组件卸载清理逻辑照常触发）
    setClosing(true);
    const timer = setTimeout(() => {
      mountedRef.current = false;
      setMounted(false);
      setClosing(false);
      setReady(false);
    }, GENIE_OUT_MS);
    return () => clearTimeout(timer);
  }, [active]);

  // 打开：等 SearchReplaceDialog 内部初始定位（居中）effect 完成后再测量——双层 rAF
  // 确保面板已落到最终位置（fixed 定位坐标就绪）；测量到位才挂 in 类开始播放动画，
  // 否则动画首帧会读到还没注入的 --genie-from-y 而跳一下。
  // 期间壳带 pending 类把面板藏起来（≈2 帧，用户不可感）。
  useEffect(() => {
    if (!mounted || closing || ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        syncGenieVars();
        // 即使测量失败也放行：面板照常显示（fail-open）
        setReady(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [mounted, closing, ready, syncGenieVars]);

  // 关闭：同步重测（面板可能已被拖拽移动，缩回轨迹须按当前位置连回按钮）。
  // 用 useLayoutEffect：几何变量在浏览器绘制前就位，收回动画的每一帧都按新位置播放
  useLayoutEffect(() => {
    if (closing) syncGenieVars();
  }, [closing, syncGenieVars]);

  if (!mounted) return null;
  const stateClass = closing
    ? "search-genie-out"
    : ready
      ? "search-genie-in"
      : "search-genie-pending";
  return (
    // 壳本身无定位样式（面板自身 fixed 定位），仅承载状态类驱动 CSS 动画
    <div
      ref={shellRef}
      className={`search-genie ${stateClass}`}
      data-testid="search-genie"
    >
      <SearchReplaceDialog {...rest} />
    </div>
  );
}
