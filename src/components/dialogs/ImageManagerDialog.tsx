/**
 * ImageManagerDialog —— 图片管理面板（v0.13.0 需求11）
 *
 * 作用域：**只管当前文档**（v1 用户确认）。
 *
 * 功能：
 * - 列出当前文档引用的全部图片（**一次出现一行**，严格按文档顺序）
 * - 逐图自动判定引用形态，并给出**相反方向**的转换按钮：
 *   · 内联 base64 / 远程 → 「转 assets」（复制到文档同级 assets/，改写为相对路径）
 *   · 本地文件（相对 / 绝对路径 / 解码后的 asset.localhost）→ 「转 base64」
 *     （读盘后内联为 data: URL）
 *   「转 assets」**不删源文件**（v1 决策）
 * - 「重命名」：只编辑**主名**，扩展名保持原样；rename_file + 文档内所有引用同步更新
 * - 「清理未引用」：列出 assets/ 中未被**本文档**引用的文件，多选后
 *   走回收站删除（file_ops::delete_file → trash），删除前二次确认
 *
 * ─── v0.13.0 第三轮返修（⑩⑪⑫⑬）───────────────────────────────
 * ⑩ 旧面板对所有图片只给一个「转 assets」：已经在 assets/ 里的图片点它只是
 *    自我复制，而用户真正想要的是"把磁盘文件内联回 base64"；同时 Tauri 的
 *    `asset.localhost` URL（百分号编码的本地绝对路径）被 `http:` 前缀误判为
 *    远程图，重命名/转存/转 base64 全部拿不到磁盘路径而失败。
 * ⑪⑫ 旧面板用按 src 合并的列表：同一文件引用两次就少一行，用户数不出
 *    文档里的图片（实机：5 处引用只显示 3 行）。现在一次出现一行。
 * ⑬ 旧面板把「a.png」整个塞进输入框，用户改个名字要重打 `.png`；
 *    漏打就变成无扩展名文件（Markdown 直接裂图）。现在只编辑主名。
 *
 * 设计要点：
 * - 计算部分全部走 `utils/imageManager.ts` 纯函数（单测覆盖）；
 * - IO 部分（复制/重命名/删除/列目录）由本组件直接调用 Tauri，
 *   与 ImageInsertDialog / ImagePasteDialog 的既有形态一致；
 * - **所有写盘后调用方登记 noteSelfWrittenFile**：由 App 的
 *   `onRewriteRefs` → fileService.writeFile 自动完成（v0.9.0 问题3 教训），
 *   本组件不做写盘，因此不存在未登记的写入路径。
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Node } from "prosemirror-model";
import { useT } from "../../i18n";
import { notifyError } from "../../services/notificationService";
import { fileService, isTauri } from "../../services/fileService";
import { exists as fsExists, readFile as fsReadFile, writeFile as fsWriteFile } from "@tauri-apps/plugin-fs";
import { join as fsJoin, dirname as fsDirname } from "@tauri-apps/api/path";
import {
  collectDocImageOccurrences,
  findUnreferenced,
  imageBaseNameOf,
  imageExtNameOf,
  imageFileNameOf,
  imageSourceKind,
  isExternalImageSrc,
  livesInAssetsDir,
  oppositeConversionOf,
  parseDataUrl,
  planConvertToAssets,
  planConvertToBase64,
  planRenameBaseName,
  resolveImageAbsPath,
  revealTargetOf,
  countRefsOf,
  base64ToBytes,
  type DocImage,
  type ImageSourceKind,
} from "../../utils/imageManager";
import "./ImageManagerDialog.css";

export interface ImageManagerDialogProps {
  open: boolean;
  /** 当前文档的 PM doc（面板数据源） */
  doc: Node | null;
  /** 当前文档路径（未保存文档为 null，此时禁用需要 IO 的操作） */
  docPath: string | null;
  /** 应用引用改写：App 侧走一次 tr 事务（一次撤销） */
  onRewriteRefs: (ops: Array<{ oldSrc: string; newSrc: string }>) => void;
  /** 关闭 */
  onClose: () => void;
  /**
   * ─── v0.13.1 需求9（可选）────────────────────────────────
   * 点「本地文件」徽标 → 在系统资源管理器中打开该图片所在目录并选中它。
   *
   * 可选而非必填：面板的其它能力（转 assets / 转 base64 / 重命名 / 清理未引用）
   * 都与它无关，缺失时只是**没有定位入口**，不必让所有调用点都被迫传参。
   * 失败提示由 App 侧负责（fileService.revealInFolder 内部已 notifyError），
   * 本组件只在没有本地路径时给出 revealNoPath 文案。
   */
  onRevealInFolder?: (absPath: string) => void;
}

/** assets 目录名（与 ImageInsertDialog/ImagePasteDialog 一致） */
const ASSETS_DIR_NAME = "assets";

/**
 * v0.13.2 返修（用户复测）：拖拽窗口时保留的最小视口边距（px）。
 * 避免把标题栏拖出屏幕后无法再拖动/关闭。
 */
const DRAG_VIEWPORT_MARGIN = 8;

/** 面板两个页签：文档图片 / 未引用清理 */
type PanelTab = "doc" | "unref";

/** ⑩ 形态徽标的 i18n key */
const KIND_LABEL_KEY: Record<ImageSourceKind, string> = {
  base64: "imageManager.kindBase64",
  file: "imageManager.kindFile",
  remote: "imageManager.kindRemote",
};

export function ImageManagerDialog({
  open,
  doc,
  docPath,
  onRewriteRefs,
  onClose,
  onRevealInFolder,
}: ImageManagerDialogProps) {
  const t = useT();
  const [tab, setTab] = useState<PanelTab>("doc");
  /** 正在处理的 src（按钮 loading 态） */
  const [busy, setBusy] = useState<string | null>(null);
  /** 面板内的错误/提示信息 */
  const [message, setMessage] = useState("");
  /**
   * 重命名输入：src → 新**主名**（⑬ 不含扩展名）。
   *
   * 按 src 而非行号索引：同一 src 的多次出现是**同一个文件**，
   * 重命名必然作用于全部出现，草稿也应当共享（避免两行给出互相冲突的新名）。
   */
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  /** assets 目录中的文件（未引用页签数据源） */
  const [assetsFiles, setAssetsFiles] = useState<string[]>([]);
  /** 未引用清理：勾选集合 */
  const [checkedUnref, setCheckedUnref] = useState<Set<string>>(new Set());

  // ─── v0.13.2 返修：窗口拖拽 + 关闭交给动画壳 ─────────────────────
  /**
   * 拖拽产生的位移（px）。通过 dialog 的 `left/top` 应用（**不用 transform**：
   * transform 已被 genie 入场/退场动画占用，`animation-fill-mode: both` 会在动画
   * 结束后覆盖普通 transform，拖拽就会失效）。
   */
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 关闭请求去重（连点 ✕ / 遮罩+Esc 同时到达时只回调一次） */
  const closeRequestedRef = useRef(false);

  /**
   * v0.13.2 返修（用户复测）：「关闭窗口要顺滑回到图标位置」。
   *
   * 旧实现让本组件自己等 260ms 再调 `onClose`，同时又保留 `if (!open) return null;`
   * ——父组件把 open 置 false 后，`GenieDialogShell` 虽然还挂 300ms 播退场，
   * 但**子组件已经返回 null**，画面上没有任何东西可动画，看起来就是"瞬间消失"。
   *
   * 现在：关闭立即回调父组件；面板在 `open=false` 时仍渲染（壳负责在 300ms 退场
   * 动画结束后连同子组件一起卸载），`image-mgr-genie-out` 才有真实的 DOM 可缩回按钮。
   */
  const requestClose = useCallback(() => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    onClose();
  }, [onClose]);

  /**
   * 从标题栏拖动窗口。
   *
   * 边界：以**未拖拽时**的面板矩形为基准，把允许的位移限制在视口内
   * （四周留 `DRAG_VIEWPORT_MARGIN`），避免标题栏被拖出屏幕后再也抓不到。
   */
  const handleHeaderMouseDown = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    // 标题栏里的关闭按钮等交互控件不触发拖拽
    if (target?.closest("button, input, a, select, textarea")) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    e.preventDefault();
    const rect = dialog.getBoundingClientRect();
    // 基准矩形 = 当前矩形减去已有位移
    const baseLeft = rect.left - dragOffset.x;
    const baseTop = rect.top - dragOffset.y;
    const minX = DRAG_VIEWPORT_MARGIN - baseLeft;
    const maxX = window.innerWidth - DRAG_VIEWPORT_MARGIN - (baseLeft + rect.width);
    const minY = DRAG_VIEWPORT_MARGIN - baseTop;
    const maxY = window.innerHeight - DRAG_VIEWPORT_MARGIN - (baseTop + rect.height);
    const startX = e.clientX;
    const startY = e.clientY;
    const startOffset = { ...dragOffset };
    const clamp = (v: number, min: number, max: number) =>
      Math.min(Math.max(v, min), Math.max(min, max));

    const onMove = (ev: MouseEvent) => {
      setDragOffset({
        x: clamp(startOffset.x + (ev.clientX - startX), minX, maxX),
        y: clamp(startOffset.y + (ev.clientY - startY), minY, maxY),
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [dragOffset]);

  // ⑪⑫：一次出现一行，按文档顺序（不再是按 src 合并的列表）
  const docImages = useMemo<DocImage[]>(
    () => (doc ? collectDocImageOccurrences(doc) : []),
    [doc],
  );

  const docDir = docPath ? docPath.replace(/[\\/][^\\/]*$/, "").replace(/\\/g, "/") : null;

  /** 加载 assets 目录内容（未引用页签） */
  const loadAssetsFiles = useCallback(async () => {
    if (!docDir || !isTauri()) {
      setAssetsFiles([]);
      return;
    }
    try {
      const assetsDir = await fsJoin(docDir, ASSETS_DIR_NAME);
      if (!(await fsExists(assetsDir))) {
        setAssetsFiles([]);
        return;
      }
      const entries = await fileService.listDir(assetsDir);
      setAssetsFiles(entries.filter((e) => !e.is_dir).map((e) => e.name));
    } catch {
      setAssetsFiles([]);
    }
  }, [docDir]);

  // 打开时重置状态；切到未引用页签时按需加载目录
  useEffect(() => {
    if (!open) return;
    setTab("doc");
    setBusy(null);
    setMessage("");
    setRenameDraft({});
    setCheckedUnref(new Set());
    // 每次打开回到居中位置（不带上次拖拽的偏移），并重置关闭去重标记
    setDragOffset({ x: 0, y: 0 });
    closeRequestedRef.current = false;
  }, [open]);

  useEffect(() => {
    if (open && tab === "unref") void loadAssetsFiles();
  }, [open, tab, loadAssetsFiles]);

  // Esc 关闭（v0.13.1 需求10：走统一入口，保留退场动画）
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, requestClose]);

  /**
   * v0.13.2 返修：**本组件不再用 `if (!open) return null;` 自行卸载**。
   *
   * 历史缺陷一：早退放在一个 `useMemo` 之前 → 关闭时 Hook 数量变化，React #300。
   * 历史缺陷二（用户复测）：即便 Hook 顺序修好，早退也让关闭瞬间**整棵面板消失**；
   * `GenieDialogShell` 虽然还挂 300ms 播 `image-mgr-genie-out`，但没有 DOM 可动画
   * → 看起来"没有关闭动效、窗口瞬间没了"。
   *
   * 现在的挂载由壳统一管理：`active=false` 时壳仍渲染 children 300ms 播放退场，
   * 结束后才卸载；因此本组件在 `open=false` 期间**继续渲染**（内部副作用由 `open` 控制）。
   * `open` 只负责"重置状态 / 注册 Esc / 加载页签数据"，不决定是否渲染。
   */
  const unreferenced = useMemo(
    () => findUnreferenced(assetsFiles, docImages),
    [assetsFiles, docImages],
  );

  /** 当前 assets 目录中的文件名（迁移/重命名冲突消解用） */
  const listAssetsNames = async (assetsDir: string): Promise<string[]> =>
    (await fsExists(assetsDir))
      ? (await fileService.listDir(assetsDir)).filter((e) => !e.is_dir).map((e) => e.name)
      : [];

  /**
   * ⑩ 转 assets：内联 base64 / 远程 → 复制进 assets/ 并改写为相对引用。
   *
   * 与旧实现的差别：base64 不再"取不到文件名而失败"，而是按 mime 合成
   * `image.png` 落盘；`asset.localhost` 解码成本地绝对路径后走复制分支。
   */
  const handleConvertToAssets = async (img: DocImage) => {
    if (!docDir || !isTauri()) return;
    const kind = imageSourceKind(img.src);
    setBusy(img.src);
    setMessage("");
    try {
      const assetsDir = await fsJoin(docDir, ASSETS_DIR_NAME);
      const existing = await listAssetsNames(assetsDir);
      const plan = planConvertToAssets(img.src, existing);
      if (!plan) {
        setMessage(t("imageManager.migrateFailed"));
        return;
      }
      const dstAbs = await fsJoin(assetsDir, plan.fileName);
      if (kind === "base64") {
        // 内联图：解码 data URL 载荷 → 写 assets
        const parsed = parseDataUrl(img.src);
        if (!parsed) {
          setMessage(t("imageManager.migrateFailed"));
          return;
        }
        await fsWriteFile(dstAbs, base64ToBytes(parsed.payload));
      } else if (kind === "file") {
        const srcAbs = resolveImageAbsPath(img.src, docDir);
        if (!srcAbs) {
          setMessage(t("imageManager.migrateFailed"));
          return;
        }
        if (isExternalImageSrc(img.src)) {
          // 文档目录之外的本地文件（绝对路径）：读源 → 写 assets
          await fsWriteFile(dstAbs, await fsReadFile(srcAbs));
        } else {
          // 文档目录内的图：直接复制（保持源文件不动，v1 决策）
          await fileService.copyFile(srcAbs, dstAbs);
        }
      } else {
        // 真远程：面板不联网抓图（v1 决策：只管当前文档的本地资源）
        setMessage(t("imageManager.remoteUnsupported"));
        return;
      }
      onRewriteRefs([{ oldSrc: img.src, newSrc: plan.newSrc }]);
      setMessage(t("imageManager.migrated", { name: plan.fileName }));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err));
      setMessage(t("imageManager.migrateFailed"));
    } finally {
      setBusy(null);
    }
  };

  /** ⑩ 转 base64：读盘 → 内联为 data: URL，替换该引用 */
  const handleConvertToBase64 = async (img: DocImage) => {
    if (!docDir || !isTauri()) return;
    setBusy(img.src);
    setMessage("");
    try {
      const srcAbs = resolveImageAbsPath(img.src, docDir);
      if (!srcAbs) {
        setMessage(t("imageManager.inlineFailed"));
        return;
      }
      const bytes = await fsReadFile(srcAbs);
      const plan = planConvertToBase64(img.src, bytes);
      if (!plan) {
        setMessage(t("imageManager.inlineFailed"));
        return;
      }
      onRewriteRefs([{ oldSrc: img.src, newSrc: plan.newSrc }]);
      setMessage(t("imageManager.inlined", { name: plan.fileName }));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err));
      setMessage(t("imageManager.inlineFailed"));
    } finally {
      setBusy(null);
    }
  };

  /**
   * ⑬ 重命名 + 同步引用（输入框里只有主名，后缀自动沿用）。
   */
  const handleRename = async (img: DocImage) => {
    if (!docDir || !isTauri()) return;
    const nextBase = (renameDraft[img.src] ?? "").trim();
    // v0.13.0 返修：传入文档内已有的图片名，避免「批量改成同一个名字」时
    // 第二张开始 rename_file 报错、批量操作中途失败留下部分完成状态。
    const plan = planRenameBaseName(
      img.src,
      nextBase,
      docImages.map((i) => imageFileNameOf(i.src)),
    );
    if (!plan) {
      setMessage(t("imageManager.renameInvalid"));
      return;
    }
    setBusy(img.src);
    setMessage("");
    try {
      const oldAbs = resolveImageAbsPath(img.src, docDir);
      if (!oldAbs) {
        setMessage(t("imageManager.renameFailed"));
        return;
      }
      // 目标与源同目录，只换文件名（后缀已由 planRenameBaseName 保留）
      const newAbs = await fsJoin(await fsDirname(oldAbs), plan.fileName);
      await fileService.renameFile(oldAbs, newAbs);
      onRewriteRefs([{ oldSrc: plan.oldSrc, newSrc: plan.newSrc }]);
      setMessage(t("imageManager.renamed", { name: plan.fileName }));
      setRenameDraft((d) => ({ ...d, [img.src]: "" }));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err));
      setMessage(t("imageManager.renameFailed"));
    } finally {
      setBusy(null);
    }
  };

  /**
   * ─── v0.13.1 需求9：点「本地文件」徽标 → 资源管理器定位并选中该图 ───────
   *
   * 只做一次「解析绝对路径 → 交给上层」的转发：真正的 `explorer /select,<path>`
   * 由 App 侧走既有 fileService.revealInFolder（Rust reveal_in_folder），
   * 本组件不新增任何 Rust 命令，也不做应用内文件树展开。
   *
   * 没有本地落点（远程图 / data URL）或文档未保存 → 只提示，不调用回调。
   */
  const handleReveal = (img: DocImage) => {
    const abs = revealTargetOf(img.src, docDir);
    if (!abs || !onRevealInFolder) {
      setMessage(t("imageManager.revealNoPath"));
      return;
    }
    onRevealInFolder(abs);
  };

  /** 清理未引用：多选 → 二次确认 → 回收站 */
  const handleClean = async () => {
    if (!docDir || !isTauri() || checkedUnref.size === 0) return;
    const names = [...checkedUnref];
    const ok = window.confirm(t("imageManager.cleanConfirm", { count: String(names.length) }));
    if (!ok) return;
    setBusy("__clean__");
    setMessage("");
    let failed = 0;
    for (const name of names) {
      try {
        const abs = await fsJoin(docDir, ASSETS_DIR_NAME, name);
        await fileService.deleteFile(abs);
      } catch {
        failed += 1;
      }
    }
    setBusy(null);
    setCheckedUnref(new Set());
    if (failed > 0) {
      setMessage(t("imageManager.cleanPartial", { count: String(failed) }));
    } else {
      setMessage(t("imageManager.cleaned", { count: String(names.length) }));
    }
    await loadAssetsFiles();
  };

  return (
    // 退场动画由 GenieDialogShell 的 image-mgr-genie-out 驱动（本组件保持渲染）
    <div className="image-mgr-overlay" onClick={requestClose}>
      <div
        ref={dialogRef}
        className="image-mgr-dialog"
        // 拖拽位移用 left/top（transform 留给 genie 动画，避免被 fill-mode 覆盖）
        style={{ left: `${dragOffset.x}px`, top: `${dragOffset.y}px` }}
        onClick={(e) => e.stopPropagation()}
        data-testid="image-manager"
      >
        <div
          className="image-mgr-header"
          title={t("imageManager.dragTip")}
          onMouseDown={handleHeaderMouseDown}
          data-testid="image-manager-drag-handle"
        >
          <h3>{t("imageManager.title")}</h3>
          <button
            type="button"
            className="image-mgr-close"
            onClick={requestClose}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </div>

        <div className="image-mgr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "doc"}
            className={`image-mgr-tab ${tab === "doc" ? "active" : ""}`}
            onClick={() => setTab("doc")}
          >
            {t("imageManager.tabDoc", { count: String(docImages.length) })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "unref"}
            className={`image-mgr-tab ${tab === "unref" ? "active" : ""}`}
            onClick={() => setTab("unref")}
          >
            {t("imageManager.tabUnref")}
          </button>
        </div>

        {message && <div className="image-mgr-message">{message}</div>}

        {tab === "doc" && (
          <div className="image-mgr-body">
            {docImages.length === 0 ? (
              <div className="image-mgr-empty">{t("imageManager.emptyDoc")}</div>
            ) : (
              <table className="image-mgr-table">
                <thead>
                  <tr>
                    <th>{t("imageManager.colName")}</th>
                    <th>{t("imageManager.colKind")}</th>
                    <th>{t("imageManager.colRefs")}</th>
                    <th>{t("imageManager.colOps")}</th>
                  </tr>
                </thead>
                <tbody>
                  {docImages.map((img) => {
                    const refCount = countRefsOf(docImages, img.src);
                    const kind = imageSourceKind(img.src);
                    const conversion = oppositeConversionOf(img.src);
                    const baseName = imageBaseNameOf(img.src);
                    const ext = imageExtNameOf(img.src);
                    const draft = renameDraft[img.src] ?? "";
                    const ioDisabled = busy !== null || !docDir;
                    // ⑩ 已经在 assets/ 里的图片再"转 assets"只是自我复制（无意义）；
                    // 真远程图不联网抓取。其余本地文件（相对 / 绝对 / asset.localhost）
                    // 的「转 assets」是既有能力，必须保留可用。
                    const migrateApplicable =
                      kind !== "remote" && !livesInAssetsDir(img.src);
                    // ⑩ 只有**磁盘上的本地文件**能内联成 base64（内联图已是 base64、
                    // 远程图没有本地路径）。这一条与 oppositeConversionOf 同源。
                    const inlineApplicable = conversion === "toBase64";
                    return (
                      // ⑫ 同一 src 会出现多行：key 必须带文档序号，
                      // 否则 React 会因重复 key 丢行/串行
                      <tr key={`${img.docIndex}-${img.src}`}>
                        <td className="image-mgr-name" title={img.src}>
                          {img.alt || imageFileNameOf(img.src) || img.src}
                          <span className="image-mgr-src">{img.src}</span>
                        </td>
                        <td className="image-mgr-kind">
                          {/* ─── v0.13.1 需求9：本地文件徽标可点 ───────────────
                              只有 kind === "file"（磁盘上真有这个文件）才做成按钮：
                              点了在资源管理器里定位并选中它。
                              base64 / remote **保持 <span>**——它们没有本地落点，
                              做成按钮只会是"看起来能点、点了没用"的死控件；
                              两者共用 .image-mgr-badge 与 .image-mgr-kind 的
                              固定宽度/同款内边距，故行布局不因形态变化而抖动。
                              未保存文档（docDir === null）时按钮禁用，
                              与其它 IO 按钮（转 assets / 重命名…）的禁用口径一致。 */}
                          {kind === "file" ? (
                            <button
                              type="button"
                              className={`image-mgr-badge ${kind}`}
                              onClick={() => handleReveal(img)}
                              disabled={!docDir}
                              title={
                                docDir
                                  ? t("imageManager.revealTip")
                                  : t("imageManager.needSave")
                              }
                            >
                              {t(KIND_LABEL_KEY[kind])}
                            </button>
                          ) : (
                            <span className={`image-mgr-badge ${kind}`}>
                              {t(KIND_LABEL_KEY[kind])}
                            </span>
                          )}
                        </td>
                        <td className="image-mgr-count">{refCount}</td>
                        <td className="image-mgr-ops">
                          {/* ⑩ 两个方向都列出，但**只有一个可用**：可用的是该图
                              当前形态的相反操作（磁盘文件 → 转 base64；
                              内联 base64 → 转 assets）。另一个保持可见但禁用，
                              并用 title 说明为什么不可用，避免用户以为功能缺失。 */}
                          <button
                            type="button"
                            className="image-mgr-btn"
                            disabled={ioDisabled || !migrateApplicable}
                            onClick={() => void handleConvertToAssets(img)}
                            title={t("imageManager.migrateTip")}
                          >
                            {busy === img.src && migrateApplicable
                              ? "..."
                              : t("imageManager.migrate")}
                          </button>
                          <button
                            type="button"
                            className="image-mgr-btn"
                            disabled={ioDisabled || !inlineApplicable}
                            onClick={() => void handleConvertToBase64(img)}
                            title={t("imageManager.inlineTip")}
                          >
                            {busy === img.src && inlineApplicable
                              ? "..."
                              : t("imageManager.inline")}
                          </button>
                          {/* ⑬ 输入框只编辑主名，后缀作为固定文本显示 */}
                          <span className="image-mgr-rename-wrap">
                            <input
                              className="image-mgr-rename-input"
                              value={draft}
                              placeholder={baseName}
                              aria-label={t("imageManager.renameBaseTip", { ext: ext || "—" })}
                              onChange={(e) =>
                                setRenameDraft((d) => ({ ...d, [img.src]: e.target.value }))
                              }
                            />
                            {ext && <span className="image-mgr-rename-ext">{ext}</span>}
                          </span>
                          <button
                            type="button"
                            className="image-mgr-btn"
                            disabled={ioDisabled || kind === "remote" || !draft.trim()}
                            onClick={() => void handleRename(img)}
                            title={
                              kind === "remote"
                                ? t("imageManager.renameUnavailable")
                                : t("imageManager.renameTip")
                            }
                          >
                            {t("imageManager.rename")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === "unref" && (
          <div className="image-mgr-body">
            <div className="image-mgr-unref-tip">{t("imageManager.unrefTip")}</div>
            {unreferenced.length === 0 ? (
              <div className="image-mgr-empty">{t("imageManager.emptyUnref")}</div>
            ) : (
              <>
                <ul className="image-mgr-unref-list">
                  {unreferenced.map((name) => (
                    <li key={name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checkedUnref.has(name)}
                          onChange={(e) => {
                            setCheckedUnref((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(name);
                              else next.delete(name);
                              return next;
                            });
                          }}
                        />
                        <span>{name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="image-mgr-footer">
                  <button
                    type="button"
                    className="image-mgr-btn danger"
                    disabled={busy !== null || checkedUnref.size === 0}
                    onClick={() => void handleClean()}
                  >
                    {busy === "__clean__"
                      ? "..."
                      : t("imageManager.clean", { count: String(checkedUnref.size) })}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {!docPath && (
          <div className="image-mgr-warn">{t("imageManager.needSave")}</div>
        )}
      </div>
    </div>
  );
}
