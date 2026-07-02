/**
 * ImagePasteDialog —— 图片粘贴处理询问
 *
 * 浏览器模式：直接转为 Base64 插入
 * Tauri 模式：可选择保存到 assets/ 目录
 *
 * 性能优化：
 * - Blob URL 在组件卸载时及时 revokeObjectURL，避免内存泄漏
 * - Base64 内联大图（>2MB）时显示警告提示
 */
import { useState, useEffect, useMemo } from "react";
import { isTauri } from "../../services/fileService";
import { writeFile, mkdir, exists, readDir } from "@tauri-apps/plugin-fs";
import { dirname, join } from "@tauri-apps/api/path";
import { notifyWarning } from "../../services/notificationService";
import "./ImagePasteDialog.css";

/** Base64 内联大小警告阈值 */
const BASE64_SIZE_WARN = 2 * 1024 * 1024; // 2MB

// ─── 纯函数（便于单元测试）──────────────────────────────

/** MIME 类型到扩展名映射表 */
const MIME_EXT_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/tiff": "tiff",
};

/** 从 MIME 类型获取扩展名（无匹配时默认 png） */
export function getExtFromMime(mime: string): string {
  return MIME_EXT_MAP[mime] || "png";
}

/** 从文件名提取扩展名（不含点，小写；无扩展名返回空串） */
export function getExtFromName(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.substring(idx + 1).toLowerCase();
}

/**
 * 生成唯一文件名（纯函数，基于已存在的文件名集合）
 *
 * 规则：
 * - 若文件名不存在冲突，直接使用
 * - 若存在冲突，在主名后追加 -1, -2, ... 序号
 *   例：image.png → image-1.png → image-2.png
 */
export function generateUniqueFileName(
  existingFiles: Set<string>,
  fileName: string,
): string {
  if (!existingFiles.has(fileName)) return fileName;
  const dotIdx = fileName.lastIndexOf(".");
  const base = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
  const ext = dotIdx > 0 ? fileName.substring(dotIdx) : "";
  let idx = 1;
  let candidate = `${base}-${idx}${ext}`;
  while (existingFiles.has(candidate)) {
    idx++;
    candidate = `${base}-${idx}${ext}`;
  }
  return candidate;
}

/** 生成 assets 相对路径引用（./assets/xxx.png） */
export function getRelativeAssetsPath(fileName: string): string {
  return `./assets/${fileName}`;
}

/**
 * 将图片文件保存到文档同目录的 assets/ 文件夹
 *
 * @param file 图片文件
 * @param docPath 当前文档的绝对路径
 * @param existingNames assets 目录中已存在的文件名集合（用于冲突检测，避免重复 exists 调用）
 * @returns Markdown 相对路径引用（如 ./assets/image.png）
 */
export async function saveImageToAssets(
  file: File,
  docPath: string,
  existingNames: Set<string>,
): Promise<string> {
  // 获取文档所在目录和 assets 目录路径
  const docDir = await dirname(docPath);
  const assetsDir = await join(docDir, "assets");

  // 创建 assets 目录（recursive 模式，已存在时不报错）
  await mkdir(assetsDir, { recursive: true });

  // 生成目标文件名：优先保留原文件名，无扩展名时用 MIME 推断
  const originalName = file.name || `image-${Date.now()}`;
  const ext = getExtFromName(originalName) || getExtFromMime(file.type);
  const hasExt = getExtFromName(originalName).length > 0;
  const baseFileName = hasExt ? originalName : `${originalName}.${ext}`;

  // 冲突检测并生成唯一文件名
  const finalName = generateUniqueFileName(existingNames, baseFileName);
  // 将最终文件名加入集合，防止同批次多文件重复
  existingNames.add(finalName);

  // 读取文件二进制数据并写入（避免 Base64 编码的内存开销）
  const buffer = await file.arrayBuffer();
  const targetPath = await join(assetsDir, finalName);
  await writeFile(targetPath, new Uint8Array(buffer));

  return getRelativeAssetsPath(finalName);
}

interface ImagePasteDialogProps {
  files: File[];
  filePath?: string | null;
  onInsert: (images: Array<{ src: string; alt: string }>) => void;
  onCancel: () => void;
}

export function ImagePasteDialog({ files, filePath, onInsert, onCancel }: ImagePasteDialogProps) {
  const [mode, setMode] = useState<"base64" | "assets">("base64");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 标记 assets 模式因文档未保存而回退到 base64
  const [fallbackToBase64, setFallbackToBase64] = useState(false);

  // 预创建 Blob URL 并在组件卸载时清理，避免内存泄漏
  const blobUrls = useMemo(() => files.map(f => URL.createObjectURL(f)), [files]);
  useEffect(() => {
    return () => blobUrls.forEach(url => URL.revokeObjectURL(url));
  }, [blobUrls]);

  // 检测是否有大图（Base64 模式下）
  const hasLargeFiles = mode === "base64" && files.some(f => f.size > BASE64_SIZE_WARN);

  // assets 模式下检查文档是否已保存
  const assetsUnavailable = mode === "assets" && !filePath;

  const handleInsert = async () => {
    setProcessing(true);
    setError(null);
    try {
      const images: Array<{ src: string; alt: string }> = [];

      // 判断是否需要回退到 base64（assets 模式但文档未保存）
      const useAssetsMode = mode === "assets" && !!filePath && isTauri();
      if (mode === "assets" && !filePath) {
        // 文档未保存：提示用户并回退到 base64
        setFallbackToBase64(true);
        notifyWarning("文档尚未保存，无法使用 assets 模式，已自动回退到 Base64");
      }

      // assets 模式下收集已存在的文件名，避免同批次多文件重复
      const existingNames = new Set<string>();
      if (useAssetsMode && filePath) {
        try {
          const docDir = await dirname(filePath);
          const assetsDir = await join(docDir, "assets");
          // 列出 assets 目录中已有的文件（若目录不存在则跳过，saveImageToAssets 会自动创建）
          if (await exists(assetsDir)) {
            const entries = await readDir(assetsDir);
            for (const entry of entries) {
              if (!entry.isDirectory) {
                existingNames.add(entry.name);
              }
            }
          }
        } catch {
          // 列举失败时忽略，saveImageToAssets 与 generateUniqueFileName 仍会基于当前批次去重
        }
      }

      for (const file of files) {
        if (useAssetsMode && filePath) {
          const relativePath = await saveImageToAssets(file, filePath, existingNames);
          images.push({ src: relativePath, alt: file.name });
        } else {
          // Base64 模式（或回退场景）
          const dataUrl = await readFileAsDataURL(file);
          images.push({ src: dataUrl, alt: file.name });
        }
      }

      onInsert(images);
    } catch (err) {
      console.error("图片处理失败:", err);
      setError(err instanceof Error ? err.message : "图片处理失败");
    } finally {
      setProcessing(false);
    }
  };

  // 键盘快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") handleInsert();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, handleInsert]);

  if (files.length === 0) return null;

  return (
    <div className="image-dialog-overlay" onClick={onCancel}>
      <div className="image-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="image-dialog-header">
          <h3>插入图片</h3>
          <span className="image-dialog-count">
            {files.length} 个文件
          </span>
        </div>

        <div className="image-dialog-body">
          <div className="image-preview-list">
            {Array.from(files).slice(0, 5).map((file, i) => (
              <div key={i} className="image-preview-item">
                <img
                  src={blobUrls[i]}
                  alt={file.name}
                  className="image-preview-thumb"
                />
                <span className="image-preview-name">{file.name}</span>
                <span className="image-preview-size">{formatSize(file.size)}</span>
              </div>
            ))}
            {files.length > 5 && (
              <div className="image-preview-more">
                ...共 {files.length} 个文件
              </div>
            )}
          </div>

          {isTauri() && (
            <div className="image-mode-select">
              <label>保存方式</label>
              <div className="image-mode-group">
                <button
                  className={`image-mode-btn ${mode === "base64" ? "active" : ""}`}
                  onClick={() => { setMode("base64"); setFallbackToBase64(false); setError(null); }}
                >
                  🔗 Base64 内联
                </button>
                <button
                  className={`image-mode-btn ${mode === "assets" ? "active" : ""}`}
                  onClick={() => { setMode("assets"); setFallbackToBase64(false); setError(null); }}
                >
                  📁 保存到 assets/
                </button>
              </div>
            </div>
          )}
          <div className="image-dialog-info">
            {error
              ? `❌ ${error}`
              : fallbackToBase64
                ? "⚠️ 文档尚未保存，无法使用 assets 模式，将自动回退到 Base64。建议先保存文档（Ctrl+S）再粘贴图片。"
                : hasLargeFiles
                  ? "⚠️ 存在大于 2MB 的图片，Base64 编码后文档体积会显著增大，建议使用「保存到 assets/」方式。"
                  : assetsUnavailable
                    ? "⚠️ 文档尚未保存，无法使用 assets 模式。请先保存文档（Ctrl+S）。"
                    : mode === "base64"
                      ? "💡 图片将以 Base64 编码嵌入到 Markdown 中，适合小图片和单文件分享。"
                      : "💡 图片将复制到文档目录的 assets/ 文件夹中，生成相对路径引用，适合大图片和本地管理。"}
          </div>
        </div>

        <div className="image-dialog-footer">
          <button className="image-dialog-btn secondary" onClick={onCancel}>
            取消
          </button>
          <button
            className="image-dialog-btn primary"
            onClick={handleInsert}
            disabled={processing}
          >
            {processing ? "处理中..." : `插入 ${files.length} 张图片`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 工具 ──────────────────────────────────────────────

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
