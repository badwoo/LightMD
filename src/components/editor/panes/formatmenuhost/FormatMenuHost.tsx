/**
 * src/components/editor/panes/FormatMenuHost/FormatMenuHost.tsx —— FormatMenuHost pane
 *
 * ## 职责边界
 *
 * 格式工具栏/右键菜单/块菜单/格式刷/标题菜单接线
 *
 * ## 从哪搬来的（v0.17.0 P0-1）
 *
 * 搬自 `src/components/editor/EditorContainer.tsx` 的 组件体 6283-7037 行。
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
  useRef,
  useEffect,
} from "react";
import { useFormatPainterStore } from "../../../../stores/useFormatPainterStore";
import { collectPmSnapshot, collectSourceSnapshot, buildPmSnapshotTr, applyPmBlockSnapshot, applyBlockTypeToLine, wrapRangeWithMarks } from "../../../../utils/formatPainter";
import { getLineRange, MERMAID_TEMPLATES } from "../.././sourceFormat";
import { unmaskBase64Images } from "../../../../utils/base64ImageMask";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { hasInAppBlockClipboard, selectBlockAt, copySelectedBlock, cutSelectedBlock, pasteBlockAtSelection, deleteSelectedBlock } from "../../../../utils/blockClipboardOps";
import { BlockActionDetail, BLOCK_ACTION_EVENT } from "../../../../core/plugins/blockKebab";
import { notifyWarning } from "../../../../services/notificationService";
import { buildBlockMoveByDir } from "../../../../core/plugins/block-drag";
import { toggleMark } from "prosemirror-commands";
import { cutSelection, copySelection, pasteIntoView, pastePlainIntoView } from "../../../../utils/textClipboardOps";
import { isCursorOutsideViewport, computeViewportCenter } from "../../../../utils/typewriter";
import { focusModeKey } from "../../../../core/plugins/focus-mode";
import { findFocusRowRange, measureTextareaRangeY, resolveLineHeight, destroyMirror } from "../../../../utils/focus-paragraph";
import { isDarkTheme } from "../../../../utils/themeTone";
import type { AiTask as AiTask } from "../../../../services/aiAssistService";
import type { EditorView as EditorView } from "prosemirror-view";
import type { SlashState as SlashState } from "../../../../core/plugins/slash-command";
import type { ViewMode as ViewMode } from "../../../../stores/useEditorStore";
import {
  applyHeadingLevelToView,
  PM_MARK_BY_ACTION,
} from "../../EditorContainer";
import type { FormatMenuHostParams, FormatMenuHostResult } from "./types";

export function useFormatMenuHost(p: FormatMenuHostParams): FormatMenuHostResult {
  // 解构到本地同名绑定：函数体因此可以逐字节原样
  const {
    sourceSurface,
    isSourceMode,
    isMdFile,
    sourceTextareaRef,
    setContextMenu,
    handleUndo,
    handleRedo,
    openLinkDialog,
    insertTextAtCursor,
    startTranslateRef,
    handleFormatAction,
    setImageDialogOpen,
    setTableDialogOpen,
    setMermaidMenuOpen,
    viewMode,
    viewRef,
    sourceContentRef,
    recordDiscreteSourceEdit,
    setSourceContent,
    onContentChangeRef,
    setDirtyRef,
    lastContentRef,
    base64TokensRef,
    editorRef,
    formatPainterMode,
    filePath,
    setPmContextMenu,
    setBlockKebabMenu,
    blockKebabMenu,
    t,
    insertMarkdownIntoPM,
    startAiAssistRef,
    mermaidMenuOpen,
    setTaskStyleMenuOpen,
    taskStyleMenuOpen,
    setSlashCommandOpen,
    setPmSlash,
    focusMode,
    forceUpdateKey,
    theme,
    focusOverlayRef,
    lineHeight,
    sourceContent,
  } = p;


  // ─── textarea 右键菜单 ──────────────────────────
  const handleTextareaContextMenu = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (!isSourceMode || !isMdFile) return;
    e.preventDefault();
    // v0.17.0 A2 收敛：只判断"有无选区"，纯值语义 → 经 surface
    const csel = sourceSurface.getSelection();
    const hasSelection = csel.start !== csel.end;
    setContextMenu({ open: true, x: e.clientX, y: e.clientY, hasSelection });
  }, [isSourceMode, isMdFile]);


  // ─── 右键菜单 action 分发 ─────────────────────────
  // 撤销/恢复走 handleUndo/handleRedo；行内格式走 handleFormatAction；
  // 插入链接/图片/表格打开对应对话框；剪切/复制/粘贴调用原生命令
  const handleContextMenuAction = useCallback((action: string) => {
    switch (action) {
      case "undo": handleUndo(); return;
      case "redo": handleRedo(); return;
      // v0.6.0：AI 翻译当前选区（textarea 通道）
      case "translate": startTranslateRef.current(); return;
      case "bold":
      case "italic":
      case "strikethrough":
      case "code":
        handleFormatAction.current(action);
        return;
      // v0.12.0 需求2：格式刷（单击入口；采集 textarea 选区）
      case "formatPainter":
        armFormatPainterRef.current(false);
        return;
      case "link": openLinkDialog(); return;
      case "image": setImageDialogOpen(true); return;
      case "table": setTableDialogOpen(true); return;
      case "codeblock":
        insertTextAtCursor("\n```\n\n```\n");
        return;
      case "mermaid":
        setMermaidMenuOpen(true);
        return;
      case "cut":
      case "copy":
        // 同步命令：仅对选中文本生效，失败静默
        try { document.execCommand(action); } catch { /* ignore */ }
        return;
      case "paste":
        // 异步读取剪贴板并插入到光标位置
        try {
          navigator.clipboard?.readText().then((text) => {
            if (text) insertTextAtCursor(text);
          }).catch(() => { /* ignore clipboard permission */ });
        } catch { /* ignore */ }
        return;
      // v0.13.1 需求16：粘贴为纯文本。
      // 源码模式的 textarea 本来就是「字面插入」（不做任何 Markdown 解析），
      // 因此与上面的 "paste" 行为一致；这里仍显式保留独立分支，让两条菜单语义对齐，
      // 且将来若给源码粘贴加入转换逻辑时，纯文本分支不会被顺带改变。
      case "pastePlain":
        try {
          navigator.clipboard?.readText().then((text) => {
            if (text) insertTextAtCursor(text);
          }).catch(() => { /* ignore clipboard permission */ });
        } catch { /* ignore */ }
        return;
    }
  }, [handleUndo, handleRedo, openLinkDialog, insertTextAtCursor]);


  // ─── v0.12.0 需求2：格式刷（三模式通用 + 双击持续） ───────────────
  // 采集（源侧）→ armed → 下一次「单击」应用（目标侧，覆盖式）；Esc 退出。
  // 跨模式可用：PM 采集 → 切编辑模式应用（反向亦可），快照为模式无关中间表示。

  /** 采集当前选区格式并 arm（persistent=true 为双击持续模式；持续态下再次双击 = 结束） */
  const armFormatPainter = useCallback((persistent: boolean) => {
    const store = useFormatPainterStore.getState();
    if (persistent && store.mode === "persistent") {
      // 持续模式下再次双击入口 → 立即结束（计划状态机：Persistent --再次双击--> Idle）
      store.exit();
      return;
    }
    // 阅读模式：PM 选区采集（文本选区或 NodeSelection 块范围）
    if (viewMode === "preview" && viewRef.current) {
      const { state } = viewRef.current;
      const { from, to } = state.selection;
      if (from === to) return; // 无可采集内容
      const snapshot = collectPmSnapshot(state, from, to);
      if (persistent) store.armPersistent(snapshot);
      else store.armOnce(snapshot);
      return;
    }
    // 编辑/分屏：选区采集（v0.17.0 A2 收敛：纯值语义 → 经 surface）
    const fsel = sourceSurface.getSelection();
    const start = fsel.start;
    const end = fsel.end;
    if (start === end) return;
    const snapshot = collectSourceSnapshot(sourceContentRef.current, start, end);
    if (persistent) store.armPersistent(snapshot);
    else store.armOnce(snapshot);
  }, [viewMode, sourceSurface]);


  // 经 ref 转发（handleContextMenuAction / 格式栏按钮的闭包可能早于本定义创建，避免闭包过期）
  const armFormatPainterRef = useRef<(persistent: boolean) => void>(() => {});

  armFormatPainterRef.current = armFormatPainter;


  /** 应用格式刷到 PM 点击处所在段落（覆盖式：先清后套；块级 setBlockType 一并处理） */
  const applyFormatPainterToPm = useCallback((clientX: number, clientY: number) => {
    const view = viewRef.current;
    const snapshot = useFormatPainterStore.getState().snapshot;
    if (!view || !snapshot) return false;
    const coords = view.posAtCoords({ left: clientX, top: clientY });
    if (!coords) return false;
    const $pos = view.state.doc.resolve(coords.pos);
    if ($pos.depth < 1) return false;
    const from = $pos.start($pos.depth);
    const to = $pos.end($pos.depth);
    let applied = false;
    // 行内 marks + 段落/标题块级（事务构造）
    const tr = buildPmSnapshotTr(view.state, from, to, snapshot);
    if (tr) {
      view.dispatch(tr);
      applied = true;
    }
    // v0.12.0 需求2 返修：列表/序号/引用块级管线（命令按序执行，目标已一致时为 no-op）
    if (applyPmBlockSnapshot(view, from, to, snapshot)) {
      applied = true;
    }
    if (applied) view.focus();
    return applied;
  }, []);


  /** 应用格式刷到源码点击处所在行（块级前缀替换 + 行内容包裹，覆盖式） */
  const applyFormatPainterToSource = useCallback((cursorPos: number) => {
    const snapshot = useFormatPainterStore.getState().snapshot;
    if (!snapshot) return false;
    const text = sourceContentRef.current;
    // A2 收敛：滚动像素是纯值 → 经 surface
    const scrollTop = sourceSurface.getScrollTop();
    const { start: lineStart, end: lineEnd } = getLineRange(text, cursorPos);

    // 1) 块级：替换行首前缀
    let next = text;
    let nextLineStart = lineStart;
    let nextLineEnd = lineEnd;
    if (snapshot.blockType !== null) {
      // v0.12.1 需求5：任务项样式（方形 `- [ ] ` / 圆形 `* [ ] `）随格式刷一并套用
      const blockRes = applyBlockTypeToLine(text, lineStart, lineEnd, snapshot.blockType, snapshot.taskStyle);
      if (blockRes) {
        next = blockRes.text;
        nextLineStart = blockRes.start;
        nextLineEnd = blockRes.end;
      }
    }
    // 2) 行内：对行内容（掐掉前缀）包裹（先剥后包，不叠加）
    if (snapshot.marks.length > 0) {
      const line = next.slice(nextLineStart, nextLineEnd);
      // 前置前缀（含任务项 `- [ ] ` 形态）都要掐掉，行内符号只包裹正文
      const prefixMatch = /^(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/.exec(line);
      const contentStart = nextLineStart + (prefixMatch ? prefixMatch[0].length : 0);
      if (nextLineEnd > contentStart) {
        const wrapped = wrapRangeWithMarks(next, contentStart, nextLineEnd, snapshot.marks);
        if (wrapped) {
          next = wrapped.text;
          nextLineEnd = wrapped.end;
        }
      }
    }
    if (next === text) return false;

    // v0.15.1 需求1：改写**统一时间线**（旧 `pushUndoEntry` 已退休）
    recordDiscreteSourceEdit(text, next, lineEnd, scrollTop);
    setSourceContent(next);
    sourceContentRef.current = next;
    onContentChangeRef.current?.(next);
    setDirtyRef.current(true);
    // v0.6.6 问题4：lastContentRef 与 content prop 同为真实坐标（unmask 后）
    lastContentRef.current = unmaskBase64Images(next, base64TokensRef.current);
    const caret = nextLineEnd;
    requestAnimationFrame(() => {
      // A2 收敛：纯值语义 → 经 surface（CM6 下同样成立）
      sourceSurface.focus();
      sourceSurface.setSelection(caret, caret);
      sourceSurface.setScrollTop(scrollTop);
    });
    return true;
  }, [recordDiscreteSourceEdit, sourceSurface]);


  // armed 时单击应用：PM（阅读模式；点击处所在段落为应用目标）
  useEffect(() => {
    if (viewMode !== "preview") return;
    const container = editorRef.current;
    if (!container) return;
    const onClick = (e: MouseEvent) => {
      if (useFormatPainterStore.getState().mode === "idle") return;
      if (applyFormatPainterToPm(e.clientX, e.clientY)) {
        useFormatPainterStore.getState().consume();
      }
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [viewMode, applyFormatPainterToPm]);


  // armed 时单击应用：源码（编辑/分屏；点击处所在行为应用目标）
  useEffect(() => {
    if (!isSourceMode) return;
    /**
     * ⚠️ 这里是 Lead 判据 2 的**边界**：本 effect 必须绑 DOM 事件
     * （`click` 要落在 textarea 上），所以 `ta` 仍然要取；
     * 但"点击处光标位置"是纯值，改成经 `surface.getSelection()` 读 ——
     * 这样 CM6 下取值逻辑不用再写一份，事件绑定等 A3 统一换 `domEventHandlers`。
     */
    // TODO(v0.18): CM6 能力缺口 — 格式刷的点击落点绑定（CM6 应用 `domEventHandlers`）。当前 CM6 表现：格式刷仍可从菜单/快捷键进入并使用，仅缺"点击正文直接应用"这一手势 | 用户可感知度：低 | 建议优先级：P2
    const ta = sourceTextareaRef.current;
    const onClick = () => {
      if (useFormatPainterStore.getState().mode === "idle") return;
      const pos = sourceSurface.getSelection().start;
      if (applyFormatPainterToSource(pos)) {
        useFormatPainterStore.getState().consume();
      }
    };
    // v0.17.0 A3 收尾：**不因宿主元素缺失而放弃整个功能**。
    // 取值已全走 surface；这里只缺"点击落点事件"——CM6 下由 domEventHandlers 提供（A3 后能力）。
    // 没有元素时功能不绑点击，但格式刷本身仍可通过其它入口（菜单/快捷键）使用，
    // 不会静默消失。
    if (ta) ta.addEventListener("click", onClick);
    return () => { if (ta) ta.removeEventListener("click", onClick); };
  }, [isSourceMode, viewMode, applyFormatPainterToSource]);


  // Esc 退出格式刷（window 捕获阶段；与 PM 菜单的 Esc 关闭并存互不阻塞）
  useEffect(() => {
    if (formatPainterMode === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      useFormatPainterStore.getState().exit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [formatPainterMode]);


  // armed 全局光标（刷子形状，见 editor.css 的 .format-painter-armed）
  useEffect(() => {
    document.body.classList.toggle("format-painter-armed", formatPainterMode !== "idle");
    return () => document.body.classList.remove("format-painter-armed");
  }, [formatPainterMode]);


  // 切文件 / 切模式 → 自动退出（防快照跨文档误用）
  useEffect(() => {
    useFormatPainterStore.getState().exit();
  }, [filePath, viewMode]);


  // v0.12.0 需求2：阅读模式右键菜单（首次为 PM 模式引入）。
  // v0.12.0 返修（问题1）：**无选区时不再拦截** —— v0.12.0 首次为阅读模式接管了右键，
  // 把 v0.11.0 的原生菜单（表情符号 / 书写方向 / 更多工具等 WebView2 项）挤掉了，
  // 用户反馈"右键菜单变成了插入链接、插入图片这些"。现改为按需接管：
  //   · 有文本选区 / 已选中块（NodeSelection）→ 应用菜单（行内格式 / 格式刷 / 删除块 / AI 翻译）；
  //   · 其余（普通空白处右键）→ 不 preventDefault，交回 WebView2 原生菜单。
  // 判定必须**同步**读取选区：preventDefault 只能在事件分发期生效（放到 rAF 里太晚）；
  // PM 的 mousedown 处理器已先于 contextmenu 执行，此处读到的选区即最新值。
  useEffect(() => {
    if (viewMode !== "preview" || !isMdFile) return;
    const container = editorRef.current;
    if (!container) return;
    const onContextMenu = (e: MouseEvent) => {
      const view = viewRef.current;
      const sel = view?.state.selection;
      const isNode = sel instanceof NodeSelection;
      const hasTextSelection = !!sel && !isNode && sel.from !== sel.to;
      if (!isNode && !hasTextSelection) return; // → 原生菜单
      e.preventDefault();
      const { clientX: x, clientY: y } = e;
      // v0.13.0 返修第三轮（问题2）：**不再为了算禁用态去读系统剪贴板**。
      // 缺陷背景：旧实现在这里 `void readBlockClipboard()`，而它会调
      // `navigator.clipboard.read()` → WebView2 弹出系统授权气泡
      // 「http://tauri.localhost 想要查看复制到剪贴板的文本和图像」。
      // 用户只是右键了一下，就被系统弹窗打断。
      // 应用内兜底（本应用刚复制过的块）是同步可知的，用它给禁用态初值即可。
      setPmContextMenu({
        open: true,
        x,
        y,
        hasSelection: hasTextSelection,
        nodeKind: isNode ? sel!.node.type.name : null,
        hasBlockClipboard: hasInAppBlockClipboard(),
        // v0.13.1 需求16：有非空文本选区即可剪切/复制（零 IO，不碰系统剪贴板）
        hasTextClipboard: hasTextSelection,
      });
    };
    container.addEventListener("contextmenu", onContextMenu);
    return () => container.removeEventListener("contextmenu", onContextMenu);
  }, [viewMode, isMdFile]);


  /**
   * v0.12.1 需求1：把标题级别徽标选中的级别落到文档（一次事务 = 一次撤销）。
   * 判定/落地逻辑抽到模块级 applyHeadingLevelToView（可单测）。
   */
  const applyHeadingLevel = useCallback((pos: number, level: number) => {
    const view = viewRef.current;
    if (!view || view.isDestroyed) return;
    if (!applyHeadingLevelToView(view, pos, level)) return;
    view.focus();
  }, []);


  /**
   * v0.13.0 需求1：监听块右上角三点按钮派发的 `lightmd:blockAction`。
   *
   * NodeView 只负责派发（含块的 pos），这里统一弹菜单——业务层只在一处。
   * 菜单复用 MiniContextMenu（portal + 视口自适应 + 键盘导航，既有实现）。
   */
  useEffect(() => {
    const container = editorRef.current;
    if (!container) return;
    const onBlockAction = (e: Event) => {
      const detail = (e as CustomEvent<BlockActionDetail>).detail;
      if (!detail || typeof detail.pos !== "number") return;
      // v0.13.0 返修（问题4）：菜单必须锚定在三点按钮**下方**。
      //
      // 缺陷背景：旧实现从 `e.target` 反查 `.block-kebab`，但事件是从 NodeView 的
      // 容器 dom 派发的，`e.target` 是容器 → `closest()` 返回 null → 锚点退化为
      // (0, 4) → **菜单弹到窗口左上角**。
      // 现在按钮自身派发事件并直接携带矩形（detail.anchor），不依赖 target 形态；
      // 取按钮**左缘**对齐 + 下缘偏移，使菜单左边界与三点对齐（符合"在三个点下面"）。
      const a = detail.anchor;
      const x = a ? a.left : 0;
      const y = a ? a.bottom + 4 : 0;
      // v0.13.0 返修第三轮（问题2）：剪贴板禁用态**只用应用内兜底**同步判定。
      // 缺陷背景：旧实现紧接着 `void readBlockClipboard()` 去补系统剪贴板结果，
      // 而 `navigator.clipboard.read()` 会让 WebView2 弹出系统授权气泡
      // 「http://tauri.localhost 想要查看复制到剪贴板的文本和图像」——
      // 用户只是点开三点菜单，并不想粘贴。现在完全不碰系统剪贴板：
      // 本应用内复制过块就可用「粘贴」，否则置灰（点粘贴时才会真正去读）。
      setBlockKebabMenu({
        open: true,
        x,
        y,
        pos: detail.pos,
        hasClipboard: hasInAppBlockClipboard(),
      });
    };
    container.addEventListener(BLOCK_ACTION_EVENT, onBlockAction);
    return () => container.removeEventListener(BLOCK_ACTION_EVENT, onBlockAction);
  }, [viewMode]);


  /** v0.13.0 需求1：三点菜单 action 分发（复用块级剪贴板/移动/格式刷既有实现） */
  const handleBlockKebabAction = useCallback(
    (action: string) => {
      const view = viewRef.current;
      if (!view) return;
      const pos = blockKebabMenu.pos;
      switch (action) {
        case "cut":
        case "copy": {
          // 菜单触发时先确保该块处于选中态（NodeSelection），再走既有实现
          selectBlockAt(view, pos);
          if (action === "copy") {
            void copySelectedBlock(view).then((ok) => {
              if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
            });
          } else {
            void cutSelectedBlock(view).then((ok) => {
              if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
            });
          }
          return;
        }
        case "paste":
          void pasteBlockAtSelection(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
          return;
        case "delete":
          selectBlockAt(view, pos);
          deleteSelectedBlock(view);
          return;
        case "formatPainter":
          // v0.13.0 返修（问题5）：`armFormatPainter` 在「无选区」（from === to）时
          // 直接 return —— 点三点菜单时通常只有光标，于是格式刷**毫无反应**。
          // 先建立该块的 NodeSelection 再采集，与复制/剪切同一前置。
          selectBlockAt(view, pos);
          armFormatPainter(false);
          return;
        case "select":
          selectBlockAt(view, pos);
          return;
        case "moveUp":
        case "moveDown": {
          // v0.13.0 返修（问题5）：按**方向**算插入点（旧实现把 -1/1 当位置传入，
          // 结构非法被吞 → 两项完全无反应）
          const dir = action === "moveUp" ? -1 : 1;
          const tr = buildBlockMoveByDir(view.state, pos, dir);
          if (tr) {
            view.dispatch(tr);
            view.focus();
          }
          return;
        }
      }
    },
    [armFormatPainter, blockKebabMenu.pos],
  );


  /** PM 右键菜单 action 分发 */
  const handlePmMenuAction = useCallback((action: string) => {
    const view = viewRef.current;
    switch (action) {
      case "bold":
      case "italic":
      case "strikethrough":
      case "code":
      case "highlight":
      case "underline": {
        const mtype = view?.state.schema.marks[PM_MARK_BY_ACTION[action]];
        if (view && mtype) {
          toggleMark(mtype)(view.state, view.dispatch, view);
          view.focus();
        }
        return;
      }
      case "formatPainter":
        armFormatPainter(false);
        return;
      case "deleteNode":
        if (view) {
          view.dispatch(view.state.tr.deleteSelection());
          view.focus();
        }
        return;
      // ─── v0.13.1 需求16：选区级剪贴板（剪切 / 复制 / 粘贴 / 粘贴为纯文本）───
      // 与上面的块级 `blockCut/blockCopy/blockPaste` 区分开：这四个作用于**文本选区**。
      // 均不依赖原生复制事件（菜单点击没有 clipboardData），走 textClipboardOps 的
      // 显式剪贴板读写；失败一律 toast，不静默。
      case "cut":
        if (view) {
          void cutSelection(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      case "copy":
        if (view) {
          void copySelection(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      case "paste":
        if (view) {
          void pasteIntoView(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      case "pastePlain":
        if (view) {
          void pastePlainIntoView(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      // ─── v0.13.0 需求1：块级复制/剪切/粘贴 ───
      case "blockCopy":
        if (view) {
          void copySelectedBlock(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      case "blockCut":
        if (view) {
          void cutSelectedBlock(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      case "blockPaste":
        if (view) {
          void pasteBlockAtSelection(view).then((ok) => {
            if (!ok) notifyWarning(t("blockMenu.clipboardFailed"));
          });
        }
        return;
      case "translate":
        startTranslateRef.current();
        return;
      case "link":
        openLinkDialog();
        return;
      case "image":
        setImageDialogOpen(true);
        return;
      case "table":
        setTableDialogOpen(true);
        return;
      case "codeblock":
        insertMarkdownIntoPM("\n```\n\n```\n");
        return;
      case "mermaid":
        insertMarkdownIntoPM(MERMAID_TEMPLATES[0].syntax);
        return;
      case "aiContinue":
        startAiAssistRef.current("continue");
        return;
      case "aiSummary":
        startAiAssistRef.current("summary");
        return;
    }
  }, [armFormatPainter, insertMarkdownIntoPM, openLinkDialog]);


  // ─── Mermaid 模板插入 ──────────────────────────────
  const handleMermaidTemplateSelect = useCallback((syntax: string) => {
    setMermaidMenuOpen(false);
    insertTextAtCursor(syntax);
  }, [insertTextAtCursor]);


  // 关闭 Mermaid 下拉：失焦或外部点击时
  useEffect(() => {
    if (!mermaidMenuOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".mermaid-dropdown-wrap")) {
        setMermaidMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [mermaidMenuOpen]);


  // ─── v0.12.1 需求5：任务列表样式下拉（格式栏「任务列表」按钮）──────
  // 点击插入对应符号的任务项：方形 = `- [ ] `、圆形 = `* [ ] `
  // （样式口径见 core/markdown/task-style.ts，阅读模式手柄下拉走同一套符号）
  const handleTaskStyleSelect = useCallback((style: "square" | "circle") => {
    setTaskStyleMenuOpen(false);
    handleFormatAction.current(style === "circle" ? "task-circle" : "task");
  }, []);


  // 关闭任务样式下拉：外部点击时（与 Mermaid 下拉同款处理）
  useEffect(() => {
    if (!taskStyleMenuOpen) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".task-style-dropdown-wrap")) {
        setTaskStyleMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [taskStyleMenuOpen]);


  // ─── SlashCommand 菜单关闭回调 ──────────────────
  // 根因：onClose 调用 setSlashCommandOpen(false) + handleSourceChange 调用 setSourceContent
  // 触发 React 重新渲染，textarea 的 value 被重设，浏览器把 selectionStart 重置到文档末尾。
  // 修复：关闭前保存光标位置和滚动位置，在 rAF（重新渲染后）恢复。
  const handleSlashClose = useCallback(() => {
    // v0.17.0 A2 收敛：保存/恢复光标与滚动都是纯值语义 → 经 surface
    const savedCursor = sourceSurface.getSelection().start;
    const savedScroll = sourceSurface.getScrollTop();
    setSlashCommandOpen(false);
    requestAnimationFrame(() => {
      sourceSurface.focus();
      sourceSurface.setSelection(savedCursor, savedCursor);
      sourceSurface.setScrollTop(savedScroll);
    });
  }, [sourceSurface]);


  // ─── 切换文件/模式时关闭 SlashCommand 菜单（防止残留）─────────
  // 根因：SlashCommand 通过 portal 渲染到 body，模式切换时 textarea 隐藏但菜单可能残留；
  // 文件切换时 textarea 内容变化但不会触发 input 事件，菜单 query 与新内容脱节
  // 注意：依赖 filePath 而非 content，因为用户输入 "/" 时会触发 onContentChange → content 变化，
  // 如果依赖 content 会导致菜单刚打开就被关闭（菜单一闪而过）
  useEffect(() => {
    setSlashCommandOpen(false);
    // v0.6.6 问题2：阅读模式 Slash 菜单同步关闭（防止模式/文件切换后残留）
    setPmSlash(null);
  }, [filePath, viewMode]);


  // ─── 专注模式 ──────────────────────────────────
  // 通过 ProseMirror 插件状态控制 decoration，CSS 类用于样式触发
  useEffect(() => {
    const editorDom = editorRef.current?.querySelector(".ProseMirror") as HTMLElement | null;
    if (editorDom) editorDom.classList.toggle("focus-mode", focusMode);
    // 同步 ProseMirror 插件状态，触发 decoration 重新计算
    const view = viewRef.current;
    if (view) {
      // 修复问题5：进入专注模式时，检查光标是否在可视区域
      // 如果光标不在可视区域（如用户在阅读模式下浏览到中间，但光标在文档开头），
      // focus-mode 插件高亮的活跃块也不在可视区域，用户看不到高亮内容。
      // 此时将 selection 设置到屏幕中央的块，使 focus-mode 插件高亮可见区域。
      if (focusMode && !isSourceMode && editorDom) {
        const selection = view.state.selection;
        const coords = view.coordsAtPos(selection.from);
        // 问题2修复：使用 editor-container（editorRef.current）的 rect，
        // 因为 .ProseMirror 移除 overflow 后不再是滚动容器，rect.height 是内容高度而非视口高度
        const rect = editorRef.current?.getBoundingClientRect() || editorDom.getBoundingClientRect();
        const cursorTop = coords.top - rect.top;
        const cursorBottom = coords.bottom - rect.top;
        if (isCursorOutsideViewport(cursorTop, cursorBottom, rect.height)) {
          // 光标不在可视区域，将 selection 设置到屏幕中央
          const center = computeViewportCenter(rect);
          const posInfo = view.posAtCoords({ left: center.left, top: center.top });
          if (posInfo) {
            try {
              const $pos = view.state.doc.resolve(posInfo.pos);
              const newSelection = TextSelection.near($pos);
              const selTr = view.state.tr.setSelection(newSelection);
              selTr.setMeta("addToHistory", false);
              view.dispatch(selTr);
            } catch {
              // posAtCoords 可能返回无效位置（如文档边界），忽略错误
            }
          }
        }
      }
      const tr = view.state.tr.setMeta(focusModeKey, focusMode ? "enable" : "disable");
      // 不触发历史记录
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
    }
  }, [focusMode, isSourceMode]);


  // ─── 源码模式（edit/split）专注遮罩 ──────────────────
  // textarea 无法像 ProseMirror 那样对部分文本加装饰，因此用 overlay div 实现：
  // 覆盖在 textarea 之上（pointer-events:none 不影响交互），
  // 通过线性渐变 background-image 在活跃段落位置开窗（transparent），
  // 其余位置覆盖半透明遮罩，使非活跃段落视觉变暗，达到与阅读模式专注效果一致的体验。
  // 段落定义：以空行（\n\n）分隔的连续文本块，与 Markdown 段落语义一致。
  //
  // ─── 修复：使用 mirror div 准确测量段落 Y 坐标 ──────────
  // 早期实现基于硬换行（\n）计算行号，再乘以 lineHeight 得到 Y 坐标。
  // 但 textarea 配置 `white-space: pre-wrap; word-break: break-word;` 会导致长行软换行，
  // 实际显示行数多于硬换行行数，导致高亮 Y 坐标偏上（用户报告"高亮在点击位置的上一行"）。
  //
  // 修复方案：使用 mirror div（与 textarea 样式一致的隐藏 div），复制文本内容，
  // 通过 getBoundingClientRect 测量段落起止位置的实际 Y 坐标，准确处理软换行。
  //
  // ─── 修复：移除 rAF 节流，立即重绘 ──────────────────
  // 早期实现使用 rAF 节流，导致回车换行时高亮延迟一帧重绘（用户报告"输入文字后才高亮"）。
  // 现在改为同步立即重绘，确保光标位置变化时高亮即时跟随。
  //
  // 关键设计：事件监听与 sourceContent 解耦
  // useEffect 只依赖 focusMode/isSourceMode/viewMode/forceUpdateKey，
  // updateOverlay 通过 sourceContentRef.current 读取最新内容；
  // 内容变化时通过单独的 useEffect 调用 updateOverlayRef.current() 触发重绘，
  // 不重绑事件、不清空遮罩。
  const updateOverlayRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const overlay = focusOverlayRef.current;
    /**
     * ⚠️ v0.17.0 A3-④：**不能再要求 `sourceTextareaRef.current` 存在**。
     *
     * 旧判据 `if (!focusMode || !isSourceMode || !textarea || !overlay) return;` 在 CM6
     * 路径下会直接短路（`sourceTextareaRef.current` 为 null）→ 专注遮罩**静默完全不工作**。
     * 现在改成"overlay 就绪即可"，数据源全部走 `SourceSurface`。
     *
     * 事件绑定仍绑在源码宿主元素上（判据 2：DOM 事件属 A3 后能力），
     * 但**没有宿主元素时不再放弃整个遮罩**——只是不绑事件，遮罩仍随内容变化重绘。
     */
    if (!focusMode || !isSourceMode || !overlay) {
      updateOverlayRef.current = null;
      return;
    }
    // TODO(v0.18): CM6 能力缺口 — 专注遮罩的事件绑定（`keyup/click/input/scroll/select` 需具体元素）。当前 CM6 表现：**遮罩仍会随内容变化重绘，但光标移动时不一定即时跟随** | 用户可感知度：中 | 建议优先级：P1
    const textarea = sourceTextareaRef.current;

    /** 计算聚焦行区间（v0.12.0：光标行 ±1 行）的 [startY, endY) 视口 Y 坐标，并更新 overlay 遮罩 */
    const updateOverlay = () => {
      const ov = focusOverlayRef.current;
      if (!ov) return;

      /**
       * v0.17.0 A3-④：专注遮罩的数据源改经 `SourceSurface`。
       *
       * 原实现直接用 `sourceTextareaRef.current` + `measureTextareaRangeY`。在 CM6 路径下
       * `sourceTextareaRef.current` 是 **null** → `if (!ta) return` → **专注遮罩静默完全不工作**
       *（无报错、无提示，用户只觉得"专注模式点了没反应"）。这类静默失效是最难发现的缺陷。
       *
       * 现在：
       * - 文本与光标位置走 surface 纯值接口；
       * - 区间起止 Y 走 `measureRangeContentY`（textarea 内部复用原 mirror 函数，CM6 用 coordsAtPos）；
       * - **不可测时显式走既有的"屏幕中央 3 行窗"兜底**，绝不退化成 `[0,0]`。
       */
      const text = sourceSurface.getText();
      const cursorPos = sourceSurface.getSelection().start;

      // 调用纯函数查找聚焦行字符区间（v0.12.0 需求9：光标行 ±1 行 = 3 行全亮窗）
      // 纯函数不动：它只吃 (text, pos)
      const range = findFocusRowRange(text, cursorPos, 1);

      const measuredRange = sourceSurface.measureRangeContentY(range.start, range.end);
      const metrics = sourceSurface.getMetrics();
      const height = metrics.clientHeight;

      /**
       * ⚠️ 测量不可用（CM6 视口外 / 布局未就绪）时**必须走兜底**，
       * 绝不能把它当成 `{ startY: 0, endY: 0 }` —— 那会在顶部画一小条遮罩，
       * 用户会以为"专注模式坏了但还在工作"，比明确不画更糟。
       */
      // 限制到可视区域内，避免遮罩溢出；不可测时用 (0,0) 只是为了让下面的
      // "startY >= height" 兜底判据成立 —— 真正的兜底在下一个分支，不会画空条。
      const rawStartY = measuredRange ? measuredRange.startY : 0;
      const rawEndY = measuredRange ? measuredRange.endY : 0;
      const startY = Math.max(0, rawStartY);
      const endY = measuredRange ? Math.min(height, rawEndY) : 0;

      // 修复：暗色主题下遮罩颜色适配，避免 rgba(0,0,0,0.45) 在深色背景上过暗
      const dimColor = isDarkTheme(theme) ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.45)";

      // 若聚焦行不在可视区域（如光标在文档开头但已滚动到中间），默认高亮屏幕中央的 3 行窗
      // 修复：原代码整个视口遮罩，用户看不到高亮内容；改为高亮屏幕中央
      // v0.12.0 需求9：单行窗 → 3 行窗（中心行 ±1.5 行高）
      if (endY <= 0 || startY >= height) {
        /**
         * 兜底：聚焦行不在可视区（或测量不可用）→ 高亮屏幕中央 3 行窗（既有行为）。
         *
         * 行高来源：优先用 surface 的几何接口**推导**（不依赖 textarea 元素）——
         * 这正是原来 `getComputedStyle(ta)` 在 CM6 下会失效的地方。
         * 取"相邻两个内容 Y 的差"作为行高；不可得时退回 CSS 变量口径的默认行高。
         */
        const lineHeight = (() => {
          const y0 = sourceSurface.offsetToContentY(0);
          // 用第 1 个换行符之后的偏移推一行高
          const text0 = sourceSurface.getText();
          const nl = text0.indexOf("\n");
          const y1 = nl >= 0 ? sourceSurface.offsetToContentY(nl + 1) : null;
          if (y0 !== null && y1 !== null && y1 > y0) return y1 - y0;
          // 退路：读 CSS 变量（CM6 与 textarea 共用同一套排版变量）
          const root = getComputedStyle(document.documentElement);
          const lh = parseFloat(root.getPropertyValue("--editor-line-height"));
          const fs = parseFloat(root.getPropertyValue("--editor-font-size"));
          if (Number.isFinite(lh) && Number.isFinite(fs) && lh > 0 && fs > 0) return lh * fs;
          return 24; // 最后兜底：与既有默认行高一致
        })();
        const centerY = height / 2;
        const centerStartY = Math.max(0, centerY - lineHeight * 1.5);
        const centerEndY = Math.min(height, centerY + lineHeight * 1.5);
        ov.style.backgroundImage = `linear-gradient(to bottom,
          ${dimColor} 0px,
          ${dimColor} ${centerStartY}px,
          transparent ${centerStartY}px,
          transparent ${centerEndY}px,
          ${dimColor} ${centerEndY}px,
          ${dimColor} ${height}px
        )`;
        return;
      }

      // 三段渐变：上方遮罩、中间透明（活跃段落）、下方遮罩
      ov.style.backgroundImage = `linear-gradient(to bottom,
        ${dimColor} 0px,
        ${dimColor} ${startY}px,
        transparent ${startY}px,
        transparent ${endY}px,
        ${dimColor} ${endY}px,
        ${dimColor} ${height}px
      )`;
    };

    // 暴露给外部 useEffect（sourceContent 变化时）调用，避免重绑事件
    updateOverlayRef.current = updateOverlay;

    // 立即重绘（保持既有即时性），再以**双 rAF 跟随重绘**校正最终位置：
    // 首次同步重绘时 textarea.value/scrollTop 可能尚未稳定（React 提交、打字机
    // 滚动、浏览器 scrollIntoView 都在其后发生），双 rAF 在布局稳定后再算一次，
    // 修复"上下移动光标/回车换行时 3 行高亮没有准确跟随"。
    // measureTextareaRangeY 内部使用 getBoundingClientRect，浏览器会强制布局计算，
    // 但仅在 focusMode 开启时执行，性能开销可控
    let followUpRaf = 0;
    const scheduleUpdate = () => {
      updateOverlay();
      if (followUpRaf) cancelAnimationFrame(followUpRaf);
      // 双 rAF：第一帧等滚动/渲染落定，第二帧在布局稳定后重算
      followUpRaf = requestAnimationFrame(() => {
        followUpRaf = requestAnimationFrame(updateOverlay);
      });
    };

    /**
     * 监听光标位置变化和滚动。
     *
     * ⚠️ 宿主元素可能为 null（CM6 路径下 `sourceTextareaRef` 不提供元素）。
     * 这种情况下**不放弃遮罩** —— 下面的 `document.addEventListener("selectionchange")`
     * 仍能覆盖光标移动，`sourceContent` 变化的 effect 也会触发重绘。
     * 这正是"不能因为拿不到 textarea 就让整个功能静默失效"的处置。
     */
    if (textarea) {
      textarea.addEventListener("keyup", scheduleUpdate);
      textarea.addEventListener("click", scheduleUpdate);
      textarea.addEventListener("input", scheduleUpdate);
      textarea.addEventListener("scroll", scheduleUpdate);
      // select 事件覆盖键盘方向键移动选区的情况
      textarea.addEventListener("select", scheduleUpdate);
    }
    // v0.12.0 返修（需求9）：document selectionchange 覆盖所有光标移动路径
    // （方向键/Home/End/PgUp/PgDn 等不触发 select 事件，keyup 也可能被吞），
    // 保证 3 行高亮窗始终跟随光标
    document.addEventListener("selectionchange", scheduleUpdate);

    // 初始绘制
    updateOverlay();

    return () => {
      if (textarea) {
      textarea.removeEventListener("keyup", scheduleUpdate);
      textarea.removeEventListener("click", scheduleUpdate);
      textarea.removeEventListener("input", scheduleUpdate);
      textarea.removeEventListener("scroll", scheduleUpdate);
      textarea.removeEventListener("select", scheduleUpdate);
      }
      document.removeEventListener("selectionchange", scheduleUpdate);
      if (followUpRaf) cancelAnimationFrame(followUpRaf);
      updateOverlayRef.current = null;
      // 清空遮罩，避免残留
      const ov = focusOverlayRef.current;
      if (ov) ov.style.backgroundImage = "";
      // 销毁 mirror div，避免内存泄漏（无宿主元素时无需销毁）
      if (textarea) destroyMirror(textarea);
    };
  }, [focusMode, isSourceMode, viewMode, forceUpdateKey, theme]);


  // ─── sourceContent 变化时重绘专注遮罩（不重绑事件）────────
  // 解耦后：内容变化仅触发 updateOverlay 重绘，避免事件重绑和遮罩清空
  useEffect(() => {
    if (!updateOverlayRef.current) return;
    updateOverlayRef.current();
  }, [sourceContent]);

  return {
    handleTextareaContextMenu,
    handleContextMenuAction,
    armFormatPainterRef,
    applyHeadingLevel,
    handleBlockKebabAction,
    handlePmMenuAction,
    handleMermaidTemplateSelect,
    handleTaskStyleSelect,
    handleSlashClose
  };
}
