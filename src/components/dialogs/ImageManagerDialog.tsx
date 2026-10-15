/**
 * ImageManagerDialog —— 图片管理面板（v0.13.0 需求11）
 *
 * 作用域：**只管当前文档**（v1 用户确认）。
 *
 * 功能：
 * - 列出当前文档引用的全部图片（同 src 合并计数）
 * - 「转 assets」：外部图源（http/data/绝对路径）复制到文档同级 assets/，
 *   文档引用改写为 `assets/<name>`；**不删源文件**（v1 决策）
 * - 「重命名」：rename_file + 文档内所有引用同步更新（一次事务）
 * - 「清理未引用」：列出 assets/ 中未被**本文档**引用的文件，多选后
 *   走回收站删除（file_ops::delete_file → trash），删除前二次确认
 *
 * 设计要点：
 * - 计算部分全部走 `utils/imageManager.ts` 纯函数（单测覆盖）；
 * - IO 部分（复制/重命名/删除/列目录）由本组件直接调用 Tauri，
 *   与 ImageInsertDialog / ImagePasteDialog 的既有形态一致；
 * - **所有写盘后调用方登记 noteSelfWrittenFile**：由 App 的
 *   `onRewriteRefs` → fileService.writeFile 自动完成（v0.9.0 问题3 教训），
 *   本组件不做写盘，因此不存在未登记的写入路径。
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import type { Node } from "prosemirror-model";
import { useT } from "../../i18n";
import { notifyError } from "../../services/notificationService";
import { fileService, isTauri } from "../../services/fileService";
import { exists as fsExists, readFile as fsReadFile, writeFile as fsWriteFile } from "@tauri-apps/plugin-fs";
import { join as fsJoin, dirname as fsDirname } from "@tauri-apps/api/path";
import {
  collectDocImages,
  findUnreferenced,
  imageFileNameOf,
  planAssetsMigration,
  planRename,
  countRefsOf,
  type DocImage,
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
}

/** assets 目录名（与 ImageInsertDialog/ImagePasteDialog 一致） */
const ASSETS_DIR_NAME = "assets";

/** 面板两个页签：文档图片 / 未引用清理 */
type PanelTab = "doc" | "unref";

export function ImageManagerDialog({
  open,
  doc,
  docPath,
  onRewriteRefs,
  onClose,
}: ImageManagerDialogProps) {
  const t = useT();
  const [tab, setTab] = useState<PanelTab>("doc");
  /** 正在处理的 src（按钮 loading 态） */
  const [busy, setBusy] = useState<string | null>(null);
  /** 面板内的错误/提示信息 */
  const [message, setMessage] = useState("");
  /** 重命名输入：src → 新文件名 */
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  /** assets 目录中的文件（未引用页签数据源） */
  const [assetsFiles, setAssetsFiles] = useState<string[]>([]);
  /** 未引用清理：勾选集合 */
  const [checkedUnref, setCheckedUnref] = useState<Set<string>>(new Set());

  const docImages = useMemo<DocImage[]>(
    () => (doc ? collectDocImages(doc) : []),
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
  }, [open]);

  useEffect(() => {
    if (open && tab === "unref") void loadAssetsFiles();
  }, [open, tab, loadAssetsFiles]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  /** 把外部/相对图片复制进 assets 并改写引用 */
  const handleMigrate = async (img: DocImage) => {
    if (!docDir || !isTauri()) return;
    setBusy(img.src);
    setMessage("");
    try {
      const assetsDir = await fsJoin(docDir, ASSETS_DIR_NAME);
      const existing = (await fsExists(assetsDir))
        ? (await fileService.listDir(assetsDir)).filter((e) => !e.is_dir).map((e) => e.name)
        : [];
      const plan = planAssetsMigration(img, existing);
      if (!plan) {
        setMessage(t("imageManager.migrateFailed"));
        return;
      }
      // 解析源文件绝对路径（相对引用基于文档目录）
      const srcName = imageFileNameOf(img.src);
      const srcAbs = img.src.startsWith("./") || img.src.startsWith("../") || !/^[A-Za-z]:[\\/]/.test(img.src)
        ? await fsJoin(docDir, img.src.replace(/^\.\//, ""))
        : img.src.replace(/\\/g, "/");
      const dstAbs = await fsJoin(assetsDir, plan.fileName);
      if (plan.needsCopy) {
        // 外部图源：读源 → 写 assets（data URL 走解码分支）
        if (/^data:/i.test(img.src)) {
          const base64 = img.src.slice(img.src.indexOf(",") + 1);
          const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          await fsWriteFile(dstAbs, bin);
        } else {
          const bytes = await fsReadFile(srcAbs);
          await fsWriteFile(dstAbs, bytes);
        }
      } else {
        // 文档目录内的图：直接复制（保持源文件不动，v1 决策）
        await fileService.copyFile(srcAbs, dstAbs);
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

  /** 重命名 + 同步引用 */
  const handleRename = async (img: DocImage) => {
    if (!docDir || !isTauri()) return;
    const nextName = (renameDraft[img.src] ?? "").trim();
    // v0.13.0 返修：传入文档内已有的图片名，避免「批量改成同一个名字」时
    // 第二章开始 rename_file 报错、批量操作中途失败留下部分完成状态。
    const plan = planRename(
      img.src,
      nextName,
      docImages.map((i) => imageFileNameOf(i.src)),
    );
    if (!plan) {
      setMessage(t("imageManager.renameInvalid"));
      return;
    }
    setBusy(img.src);
    setMessage("");
    try {
      const oldAbs = await fsJoin(docDir, img.src.replace(/^\.\//, ""));
      const newAbs = await fsJoin(docDir, plan.newSrc.replace(/^\.\//, ""));
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

  const unreferenced = useMemo(
    () => findUnreferenced(assetsFiles, docImages),
    [assetsFiles, docImages],
  );

  return (
    <div className="image-mgr-overlay" onClick={onClose}>
      <div
        className="image-mgr-dialog"
        onClick={(e) => e.stopPropagation()}
        data-testid="image-manager"
      >
        <div className="image-mgr-header">
          <h3>{t("imageManager.title")}</h3>
          <button
            type="button"
            className="image-mgr-close"
            onClick={onClose}
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
                    <th>{t("imageManager.colRefs")}</th>
                    <th>{t("imageManager.colOps")}</th>
                  </tr>
                </thead>
                <tbody>
                  {docImages.map((img) => {
                    const refCount = countRefsOf(docImages, img.src);
                    return (
                      <tr key={img.src}>
                        <td className="image-mgr-name" title={img.src}>
                          {img.alt || imageFileNameOf(img.src) || img.src}
                          <span className="image-mgr-src">{img.src}</span>
                        </td>
                        <td className="image-mgr-count">{refCount}</td>
                        <td className="image-mgr-ops">
                          <button
                            type="button"
                            className="image-mgr-btn"
                            disabled={busy !== null || !docDir}
                            onClick={() => void handleMigrate(img)}
                            title={t("imageManager.migrateTip")}
                          >
                            {busy === img.src ? "..." : t("imageManager.migrate")}
                          </button>
                          <input
                            className="image-mgr-rename-input"
                            value={renameDraft[img.src] ?? ""}
                            placeholder={imageFileNameOf(img.src)}
                            onChange={(e) =>
                              setRenameDraft((d) => ({ ...d, [img.src]: e.target.value }))
                            }
                          />
                          <button
                            type="button"
                            className="image-mgr-btn"
                            disabled={busy !== null || !docDir || !(renameDraft[img.src] ?? "").trim()}
                            onClick={() => void handleRename(img)}
                            title={t("imageManager.renameTip")}
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
