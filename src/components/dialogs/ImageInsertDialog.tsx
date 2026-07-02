/**
 * ImageInsertDialog —— 图片从文件选择插入对话框
 *
 * 功能：
 * - 调用 Tauri dialog.open 选择图片文件（浏览器模式回退到原生 <input type=file>）
 * - 图片预览（Tauri 模式用 data URL；浏览器模式用 Blob URL）
 * - 输入 alt、title
 * - 插入方式：Base64 内联 / 复制到 assets 目录
 * - 大图（>2MB）警告提示
 * - 支持格式：png/jpg/jpeg/gif/svg/webp
 *
 * 资源管理：
 * - Blob URL 在卸载/重新选择/关闭时及时 revokeObjectURL，避免内存泄漏
 * - 大图优先建议「复制到 assets」方式，避免文档体积膨胀
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile as tauriReadFile, copyFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { isTauri } from "../../services/fileService";
import { useEditorStore } from "../../stores/useEditorStore";
import "./ImageInsertDialog.css";

/** 支持的图片扩展名 */
const SUPPORTED_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
/** Base64 内联大小警告阈值 */
const BASE64_SIZE_WARN = 2 * 1024 * 1024; // 2MB

/** 扩展名 -> MIME 映射 */
const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** 从路径中提取扩展名（小写，不含点） */
function getExt(path: string): string {
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

/** 从路径中提取文件名（兼容 / 与 \） */
function getFileName(path: string): string {
  const m = path.match(/[/\\]([^/\\]+)$/);
  return m ? m[1] : path;
}

/** 从路径中提取所在目录（兼容 / 与 \） */
function getDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.substring(0, idx) : "";
}

/** 根据父目录推断路径分隔符 */
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  return dir + sep + name;
}

/** 根据 MIME 返回 */
function getMime(ext: string): string {
  return MIME_MAP[ext] || "application/octet-stream";
}

/** Uint8Array -> base64 字符串 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** 浏览器 File 转 data URL */
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 截断字符串，避免预览过长 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * 生成图片 Markdown
 * - 有 title：`![alt](src "title")`
 * - 无 title：`![alt](src)`
 * - src 为空时返回空串
 */
export function buildImageMarkdown(alt: string, src: string, title: string): string {
  if (!src) return "";
  const a = alt.trim();
  const t = title.trim();
  return t ? `![${a}](${src} "${t}")` : `![${a}](${src})`;
}

/**
 * 复制源文件到文档同级的 assets/ 目录，返回相对引用路径
 * 若 assets 目录不存在则创建。
 */
async function copyToAssets(srcPath: string, fileName: string, docPath: string): Promise<string> {
  const docDir = getDir(docPath);
  const assetsDir = joinPath(docDir, "assets");
  if (!(await exists(assetsDir))) {
    await mkdir(assetsDir, { recursive: true });
  }
  const destPath = joinPath(assetsDir, fileName);
  await copyFile(srcPath, destPath);
  // Markdown 中统一使用正斜杠作为引用路径分隔符
  return `assets/${fileName}`;
}

export interface ImageInsertDialogProps {
  /** 是否显示对话框 */
  open: boolean;
  /** 插入回调，返回生成的 Markdown */
  onInsert: (markdown: string) => void;
  /** 关闭回调 */
  onClose: () => void;
}

export function ImageInsertDialog({ open, onInsert, onClose }: ImageInsertDialogProps) {
  const filePath = useEditorStore((s) => s.filePath);
  const [mode, setMode] = useState<"base64" | "assets">("base64");
  /** Tauri 模式下选中文件的本地路径 */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  /** 浏览器模式下选中的 File 对象 */
  const [fileObj, setFileObj] = useState<File | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [fileName, setFileName] = useState<string>("");
  const [fileExt, setFileExt] = useState<string>("");
  /** 预览图地址（data URL 或 Blob URL） */
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [alt, setAlt] = useState("");
  const [title, setTitle] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>("");

  const blobUrlRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** 清理预览资源（revoke Blob URL 并重置状态） */
  const clearPreview = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPreviewSrc("");
    setSelectedPath(null);
    setFileObj(null);
    setFileSize(0);
    setFileName("");
    setFileExt("");
  }, []);

  // 对话框打开/关闭时重置状态
  useEffect(() => {
    if (open) {
      setMode("base64");
      setAlt("");
      setTitle("");
      setProcessing(false);
      setError("");
      clearPreview();
    } else {
      clearPreview();
    }
  }, [open, clearPreview]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const isLarge = fileSize > BASE64_SIZE_WARN;
  const isSupportedExt = SUPPORTED_EXTS.includes(fileExt);

  /** 选择图片文件（Tauri 优先，浏览器回退到 input） */
  const handleSelectFile = useCallback(async () => {
    setError("");
    if (isTauri()) {
      try {
        const selected = await openDialog({
          multiple: false,
          filters: [{ name: "图片", extensions: SUPPORTED_EXTS }],
        });
        const path = typeof selected === "string" ? selected : Array.isArray(selected) ? selected[0] : null;
        if (!path) return;
        const name = getFileName(path);
        const ext = getExt(path);
        if (!SUPPORTED_EXTS.includes(ext)) {
          setError(`不支持的图片格式：.${ext || "?"}（支持 ${SUPPORTED_EXTS.join("/")}）`);
          return;
        }
        // 读取文件生成预览 data URL
        const bytes = await tauriReadFile(path);
        const base64 = bytesToBase64(bytes);
        const dataUrl = `data:${getMime(ext)};base64,${base64}`;
        clearPreview();
        setSelectedPath(path);
        setFileName(name);
        setFileExt(ext);
        setFileSize(bytes.byteLength);
        setPreviewSrc(dataUrl);
      } catch (err) {
        setError(`选择文件失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      inputRef.current?.click();
    }
  }, [clearPreview]);

  /** 浏览器 input[type=file] 选择回调 */
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name;
    const ext = getExt(name);
    if (!SUPPORTED_EXTS.includes(ext)) {
      setError(`不支持的图片格式：.${ext || "?"}（支持 ${SUPPORTED_EXTS.join("/")}）`);
      e.target.value = "";
      return;
    }
    clearPreview();
    const url = URL.createObjectURL(file);
    blobUrlRef.current = url;
    setFileObj(file);
    setFileName(name);
    setFileExt(ext);
    setFileSize(file.size);
    setPreviewSrc(url);
    e.target.value = "";
  }, [clearPreview]);

  // 预览生成的 Markdown（assets 模式下显示相对路径而非 data URL，避免预览过长）
  const preview = useMemo(() => {
    if (!previewSrc) return "";
    const src =
      mode === "assets" && (selectedPath || fileObj)
        ? `assets/${fileName}`
        : previewSrc;
    return buildImageMarkdown(alt, src, title);
  }, [previewSrc, mode, selectedPath, fileObj, fileName, alt, title]);

  const canInsert = !!previewSrc && isSupportedExt;

  /** 插入：根据模式生成最终 src 后调用 onInsert */
  const handleInsert = useCallback(async () => {
    if (!canInsert) return;
    setProcessing(true);
    setError("");
    try {
      let src = "";
      if (mode === "base64") {
        if (isTauri() && selectedPath) {
          // Tauri 模式下 previewSrc 已是 data URL
          src = previewSrc;
        } else if (fileObj) {
          // 浏览器模式下需将 Blob URL 转 data URL
          src = await readFileAsDataURL(fileObj);
        } else {
          src = previewSrc;
        }
      } else {
        // assets 模式
        if (isTauri() && selectedPath) {
          if (!filePath) {
            setError("请先保存文档后再使用「复制到 assets」方式");
            setProcessing(false);
            return;
          }
          src = await copyToAssets(selectedPath, fileName, filePath);
        } else if (fileObj) {
          setError("浏览器模式下不支持「复制到 assets」，请使用 Base64 内联");
          setProcessing(false);
          return;
        }
      }
      const md = buildImageMarkdown(alt, src, title);
      if (md) onInsert(md);
    } catch (err) {
      setError(`插入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProcessing(false);
    }
  }, [canInsert, mode, selectedPath, fileObj, previewSrc, fileName, filePath, alt, title, onInsert]);

  // Esc 取消（不监听 Enter，避免与多行输入冲突；插入由按钮触发）
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

  return (
    <div className="image-insert-overlay" onClick={onClose}>
      <div className="image-insert-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="image-insert-header">
          <h3>插入图片</h3>
        </div>

        <div className="image-insert-body">
          <div className="image-insert-field">
            <button
              className="image-insert-select-btn"
              onClick={handleSelectFile}
              type="button"
            >
              📁 选择图片文件
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={SUPPORTED_EXTS.map((e) => `.${e}`).join(",")}
              onChange={handleInputChange}
              style={{ display: "none" }}
            />
            {fileName && (
              <span className="image-insert-file-info">
                {fileName}（{formatSize(fileSize)}）
              </span>
            )}
          </div>

          {isLarge && mode === "base64" && (
            <div className="image-insert-warn">
              ⚠️ 图片大于 2MB，Base64 编码会显著增大文档体积，建议使用「复制到 assets」。
            </div>
          )}

          {error && <div className="image-insert-error">{error}</div>}

          {previewSrc && (
            <div className="image-insert-preview-img">
              <img src={previewSrc} alt={alt} />
            </div>
          )}

          <div className="image-insert-field">
            <label>图片描述（alt）</label>
            <input
              type="text"
              className="image-insert-input"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="图片的替代文字"
            />
          </div>

          <div className="image-insert-field">
            <label>标题（可选）</label>
            <input
              type="text"
              className="image-insert-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="鼠标悬停提示"
            />
          </div>

          <div className="image-insert-field">
            <label>插入方式</label>
            <div className="image-insert-mode-group">
              <button
                type="button"
                className={`image-insert-mode-btn ${mode === "base64" ? "active" : ""}`}
                onClick={() => setMode("base64")}
              >
                🔗 Base64 内联
              </button>
              <button
                type="button"
                className={`image-insert-mode-btn ${mode === "assets" ? "active" : ""}`}
                onClick={() => setMode("assets")}
                disabled={!isTauri()}
                title={!isTauri() ? "浏览器模式不支持" : ""}
              >
                📁 复制到 assets/
              </button>
            </div>
            {mode === "assets" && !filePath && (
              <div className="image-insert-hint">
                ⚠️ 需要先保存文档，图片将复制到文档同级的 assets/ 目录
              </div>
            )}
          </div>

          {preview && (
            <div className="image-insert-preview">
              <div className="image-insert-preview-label">Markdown 预览</div>
              <code className="image-insert-preview-code">{truncate(preview, 200)}</code>
            </div>
          )}
        </div>

        <div className="image-insert-footer">
          <button className="image-insert-btn secondary" onClick={onClose} type="button">
            取消
            <span className="image-insert-kbd">Esc</span>
          </button>
          <button
            className="image-insert-btn primary"
            onClick={handleInsert}
            disabled={!canInsert || processing}
            type="button"
          >
            {processing ? "处理中..." : "插入"}
          </button>
        </div>
      </div>
    </div>
  );
}
