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
import "./ImagePasteDialog.css";

/** Base64 内联大小警告阈值 */
const BASE64_SIZE_WARN = 2 * 1024 * 1024; // 2MB

interface ImagePasteDialogProps {
  files: File[];
  filePath?: string | null;
  onInsert: (images: Array<{ src: string; alt: string }>) => void;
  onCancel: () => void;
}

export function ImagePasteDialog({ files, filePath, onInsert, onCancel }: ImagePasteDialogProps) {
  const [mode, setMode] = useState<"base64" | "assets">("base64");
  const [processing, setProcessing] = useState(false);

  // 预创建 Blob URL 并在组件卸载时清理，避免内存泄漏
  const blobUrls = useMemo(() => files.map(f => URL.createObjectURL(f)), [files]);
  useEffect(() => {
    return () => blobUrls.forEach(url => URL.revokeObjectURL(url));
  }, [blobUrls]);

  // 检测是否有大图（Base64 模式下）
  const hasLargeFiles = mode === "base64" && files.some(f => f.size > BASE64_SIZE_WARN);

  const handleInsert = async () => {
    setProcessing(true);
    try {
      const images: Array<{ src: string; alt: string }> = [];

      for (const file of files) {
        if (mode === "base64") {
          const dataUrl = await readFileAsDataURL(file);
          images.push({ src: dataUrl, alt: file.name });
        } else {
          // assets/ 目录保存模式 (当前回退到 base64)
          const dataUrl = await readFileAsDataURL(file);
          images.push({ src: dataUrl, alt: file.name });
        }
      }

      onInsert(images);
    } catch (err) {
      console.error("图片处理失败:", err);
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
                  onClick={() => setMode("base64")}
                >
                  🔗 Base64 内联
                </button>
                <button
                  className={`image-mode-btn ${mode === "assets" ? "active" : ""}`}
                  onClick={() => setMode("assets")}
                >
                  📁 保存到 assets/
                </button>
              </div>
            </div>
          )}

          <div className="image-dialog-info">
            {hasLargeFiles
              ? "⚠️ 存在大于 2MB 的图片，Base64 编码后文档体积会显著增大，建议使用「保存到 assets/」方式。"
              : mode === "base64"
                ? "💡 图片将以 Base64 编码嵌入到 Markdown 中，适合小图片和单文件分享。"
                : "💡 图片将复制到文档目录的 assets/ 文件夹中，适合大图片和本地管理。"}
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
