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
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { searchHighlightKey } from "../../core/editor";
import { useEditorStore } from "../../stores/useEditorStore";
import { useT } from "../../i18n";
import "./SearchReplace.css";

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
}

// ─── 块级偏移映射（替代逐字符 Map，大幅减少内存）──────────

/** 偏移映射块：记录每个文本节点在 textContent 中的偏移范围和对应的 PM 起始位置 */
interface OffsetBlock {
  /** 该文本节点在 textContent 中的起始偏移 */
  textStart: number;
  /** 该文本节点在 textContent 中的结束偏移（不含） */
  textEnd: number;
  /** 该文本节点在 PM 文档中的起始位置 */
  pmStart: number;
}

/** 偏移映射结果：同时返回 text 和 blocks，保证搜索文本与位置映射完全一致 */
interface OffsetMap {
  text: string;
  blocks: OffsetBlock[];
}

/**
 * 构建块级偏移映射数组，同时构建 textContent
 * 问题2修复：text 和 blocks 在同一次遍历中构建，保证偏移量完全一致
 * （原实现使用 textBetween 获取 text，与 buildOffsetBlocks 的换行符插入逻辑不一致）
 */
function buildOffsetMap(doc: import("prosemirror-model").Node): OffsetMap {
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

/** 从 textContent 偏移量查找 PM 位置（二分查找，O(log n)） */
function lookupPmPos(blocks: OffsetBlock[], textOffset: number): number | undefined {
  let lo = 0, hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const block = blocks[mid];
    if (textOffset < block.textStart) {
      hi = mid - 1;
    } else if (textOffset >= block.textEnd) {
      lo = mid + 1;
    } else {
      // textOffset 落在此块内，计算 PM 位置
      return block.pmStart + (textOffset - block.textStart);
    }
  }
  return undefined;
}

/**
 * Issue 6：在文本中搜索匹配项，返回匹配起始位置数组（纯函数，便于单元测试）
 *
 * 用于 md 文件的 ProseMirror 内容搜索和非 md 文件的 textarea 源码搜索。
 * 特殊字符会被正则转义，避免搜索文本中含 . * + 等时误匹配。
 *
 * @param text 待搜索的文本（sourceContent 或 PM textContent）
 * @param searchText 搜索关键词
 * @param caseSensitive 是否区分大小写
 * @returns 匹配起始位置数组（0-indexed），最多返回 10000 个以防无限循环
 */
export function findMatches(text: string, searchText: string, caseSensitive = false): number[] {
  if (!searchText) return [];
  const flags = caseSensitive ? "g" : "gi";
  const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  const matches: number[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match.index);
    if (matches.length > 10000) break; // 防止无限循环
  }
  return matches;
}

export function SearchReplaceDialog({
  onClose,
  editorView,
  sourceTextareaRef,
  sourceContent,
  onSourceContentChange,
  initialShowReplace = false,
  isMdFile = true,
}: SearchReplaceProps) {
  const t = useT();
  const viewMode = useEditorStore((s) => s.viewMode);
  // Issue 6：非 md 文件 ProseMirror 为空，无论 viewMode 如何都走 sourceContent 搜索分支
  const isSourceMode = viewMode === "edit" || viewMode === "split" || !isMdFile;
  // 问题3：监听 searchFocusKey 变化，重复按 Ctrl+F 时重新聚焦
  const searchFocusKey = useEditorStore((s) => s.searchFocusKey);
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [showReplace, setShowReplace] = useState(initialShowReplace);

  // 当 initialShowReplace 变化时同步 showReplace（Ctrl+H 在已打开搜索框时切换到替换模式）
  useEffect(() => {
    if (initialShowReplace) setShowReplace(true);
  }, [initialShowReplace]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<number[]>([]);
  // 缓存偏移映射，performSearch 构建后 highlightMatch 复用
  const offsetMapRef = useRef<OffsetMap | null>(null);

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

    // Issue 6：使用提取的 findMatches 纯函数搜索匹配项
    const matches = findMatches(text, searchText, caseSensitive);

    matchesRef.current = matches;
    setMatchCount(matches.length);
    setCurrentMatch(matches.length > 0 ? 1 : 0);

    // 高亮第一个匹配
    if (matches.length > 0) {
      highlightMatch(0);
    }
  }, [searchText, caseSensitive, isSourceMode, sourceContent, editorView, isMdFile, viewMode]);

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
      const pos = matchesRef.current[index];
      const endPos = pos + searchText.length;
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
      const pos = matchesRef.current[index];
      // Issue 6：非 md 文件在 preview 模式下 textarea 隐藏（display:none），
      // offsetParent === null 表示不可见，此时跳过视觉高亮（仅显示匹配计数）
      if (textarea.offsetParent === null) return;
      textarea.focus();
      textarea.setSelectionRange(pos, pos + searchText.length);
      // 滚动到匹配位置
      const lines = textarea.value.substring(0, pos).split("\n");
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTop = (lines.length - 1) * lineHeight;
    } else if (editorView) {
      // ProseMirror 模式下，使用 offsetMapRef 中的 blocks 映射位置
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;
        const targetOffset = matchesRef.current[index];

        // 查找匹配起始位置对应的 PM 位置
        const pmStart = lookupPmPos(offsetMap.blocks, targetOffset);
        if (pmStart !== undefined) {
          // 查找匹配结束位置对应的 PM 位置
          const pmEnd = lookupPmPos(offsetMap.blocks, targetOffset + searchText.length - 1);
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
  }, [isSourceMode, sourceTextareaRef, editorView, searchText, isMdFile, viewMode]);

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

    if (isSourceMode && sourceTextareaRef?.current && sourceContent !== undefined && onSourceContentChange) {
      const pos = matchesRef.current[currentMatch - 1];
      const newContent = sourceContent.substring(0, pos) + replaceText + sourceContent.substring(pos + searchText.length);
      onSourceContentChange(newContent);
    } else if (editorView) {
      // 阅读模式：通过 ProseMirror transaction 替换文本
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;
        const targetOffset = matchesRef.current[currentMatch - 1];

        const pmStart = lookupPmPos(offsetMap.blocks, targetOffset);
        const pmEnd = lookupPmPos(offsetMap.blocks, targetOffset + searchText.length - 1);
        if (pmStart !== undefined && pmEnd !== undefined) {
          const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
          const tr = editorView.state.tr.insertText(replaceText, pmStart, endPos);
          tr.setMeta("addToHistory", true);
          editorView.dispatch(tr);
        }
      } catch {
        // 忽略替换错误
      }
    }

    // 替换后重新搜索
    setTimeout(() => performSearch(), 50);
  }, [isSourceMode, sourceTextareaRef, sourceContent, onSourceContentChange, currentMatch, searchText, replaceText, performSearch, editorView]);

  // 全部替换
  const replaceAll = useCallback(() => {
    if (!searchText || matchesRef.current.length === 0) return;

    if (isSourceMode && sourceContent !== undefined && onSourceContentChange) {
      const flags = caseSensitive ? "g" : "gi";
      const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      const newContent = sourceContent.replace(regex, replaceText);
      onSourceContentChange(newContent);
    } else if (editorView) {
      // 阅读模式：从后往前替换，避免位置偏移
      try {
        const offsetMap = offsetMapRef.current;
        if (!offsetMap) return;
        const matches = matchesRef.current;

        let tr = editorView.state.tr;
        // 从后往前替换，这样前面的偏移量不会受影响
        for (let i = matches.length - 1; i >= 0; i--) {
          const targetOffset = matches[i];
          const pmStart = lookupPmPos(offsetMap.blocks, targetOffset);
          const pmEnd = lookupPmPos(offsetMap.blocks, targetOffset + searchText.length - 1);
          if (pmStart !== undefined && pmEnd !== undefined) {
            const endPos = Math.min(pmEnd + 1, editorView.state.doc.content.size);
            tr = tr.insertText(replaceText, pmStart, endPos);
          }
        }
        tr.setMeta("addToHistory", true);
        editorView.dispatch(tr);
      } catch {
        // 忽略替换错误
      }
    }

    setTimeout(() => performSearch(), 50);
  }, [isSourceMode, sourceContent, onSourceContentChange, searchText, replaceText, caseSensitive, performSearch, editorView]);

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
      className="search-replace search-replace-floating"
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
          className="search-input"
          type="text"
          placeholder={t("search.placeholder")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button
          className={`search-option-btn ${caseSensitive ? "active" : ""}`}
          title={t("search.caseSensitive")}
          onClick={() => setCaseSensitive(!caseSensitive)}
        >
          Aa
        </button>
        <button className="search-nav-btn" title={t("search.previous")} onClick={() => goToMatch(-1)} disabled={matchCount === 0}>
          ↑
        </button>
        <button className="search-nav-btn" title={t("search.next")} onClick={() => goToMatch(1)} disabled={matchCount === 0}>
          ↓
        </button>
        <span className="search-count">
          {matchCount > 0 ? `${currentMatch}/${matchCount}` : t("search.noResult")}
        </span>
        <button className="search-toggle-btn" title={t("search.toggleReplace")} onClick={() => setShowReplace(!showReplace)}>
          ⟳
        </button>
      </div>
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
    </div>
  );
}
