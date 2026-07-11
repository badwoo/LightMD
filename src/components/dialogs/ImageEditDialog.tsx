/**
 * ImageEditDialog —— 图片编辑对话框（G3）
 *
 * 功能：
 * - 显示原始图片，支持裁剪/旋转/翻转操作
 * - 裁剪：三态状态机交互（idle → selecting → confirmed → 应用）
 * - 旋转：90°/270° 旋转（直接应用，立即显示）
 * - 翻转：水平/垂直翻转（直接应用，立即显示）
 * - 重置：恢复到原始图片
 * - 确认：将编辑后的图片（Base64 dataUrl）保存回文档
 * - 取消：放弃编辑
 *
 * 裁剪交互三态状态机（v0.3.0 修复）：
 * - idle：未开始裁剪，提示"点击图片开始选择裁剪区域"
 *   - mousedown（在图片上）→ selecting，记录起点
 * - selecting：正在拖拽选择范围
 *   - mousemove → 实时更新选区
 *   - mouseup → confirmed（选区固定）
 *     - 若选区过小（<5px）→ 回到 idle
 * - confirmed：选区已确定，等待应用
 *   - mousedown → 清除旧选区，进入 selecting 重新选择
 *   - 点击"应用裁剪"按钮 → 执行裁剪
 *
 * 设计要点：
 * - 复用 ImageInsertDialog 的 overlay 样式（image-insert-overlay）
 * - 编辑后输出统一为 PNG Base64 dataUrl（Canvas 输出）
 * - 裁剪坐标基于原图，通过显示比例 scale 进行转换
 * - 旋转/翻转操作链式应用，每次基于上一次结果
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { cropImage, rotateImage, flipImage, type CropRect } from "../../utils/imageEdit";
import { useT } from "../../i18n";
import "./ImageEditDialog.css";

export interface ImageEditDialogProps {
  /** 是否显示对话框 */
  open: boolean;
  /** 原始图片 src（dataUrl 或 URL） */
  imageSrc: string;
  /** 确认回调，参数为编辑后的 Base64 dataUrl */
  onConfirm: (newSrc: string) => void;
  /** 关闭回调 */
  onClose: () => void;
}

/** 裁剪选区（基于显示坐标，单位 px） */
interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 裁剪三态状态机：idle → selecting → confirmed → 应用 */
type CropMode = "idle" | "selecting" | "confirmed";

export function ImageEditDialog({ open, imageSrc, onConfirm, onClose }: ImageEditDialogProps) {
  const t = useT();
  /** 当前编辑中的图片 src（应用变换后的） */
  const [currentSrc, setCurrentSrc] = useState("");
  /** 原始图片 src（用于重置） */
  const [originalSrc, setOriginalSrc] = useState("");
  /** 是否正在处理变换 */
  const [processing, setProcessing] = useState(false);
  /** 错误信息 */
  const [error, setError] = useState("");
  /** 裁剪选区（显示坐标） */
  const [cropRect, setCropRect] = useState<DisplayRect | null>(null);
  /** 裁剪模式状态机 */
  const [cropMode, setCropMode] = useState<CropMode>("idle");
  /** 拖拽起点 */
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  /** 图片元素 ref（用于计算显示尺寸和位置） */
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** 编辑器容器 ref（用于绑定鼠标事件） */
  const editorRef = useRef<HTMLDivElement | null>(null);

  // open 变化时重置状态
  useEffect(() => {
    if (open) {
      setCurrentSrc(imageSrc);
      setOriginalSrc(imageSrc);
      setProcessing(false);
      setError("");
      setCropRect(null);
      setCropMode("idle");
      dragStartRef.current = null;
    }
  }, [open, imageSrc]);

  /** 计算图片显示坐标到原图坐标的缩放比例 */
  const getScale = useCallback((): { scaleX: number; scaleY: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    if (naturalW <= 0 || naturalH <= 0) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      scaleX: naturalW / rect.width,
      scaleY: naturalH / rect.height,
    };
  }, []);

  /**
   * 处理裁剪选区鼠标按下事件（三态状态机入口）
   * - idle: 开始拖拽，进入 selecting
   * - selecting: 不应触发（mousedown 时已切换）
   * - confirmed: 清除旧选区，开始新拖拽
   */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (processing) return;
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 仅在图片范围内开始拖拽
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    // 三态状态机：无论当前是 idle 还是 confirmed，mousedown 都进入 selecting 开始新选区
    dragStartRef.current = { x, y };
    setCropMode("selecting");
    setCropRect({ x, y, width: 0, height: 0 });
    e.preventDefault();
  }, [processing]);

  /** 处理鼠标移动（仅在 selecting 状态更新选区尺寸） */
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (cropMode !== "selecting" || !dragStartRef.current) return;
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 钳制到图片范围内
    const clampedX = Math.max(0, Math.min(x, rect.width));
    const clampedY = Math.max(0, Math.min(y, rect.height));
    const start = dragStartRef.current;
    setCropRect({
      x: Math.min(start.x, clampedX),
      y: Math.min(start.y, clampedY),
      width: Math.abs(clampedX - start.x),
      height: Math.abs(clampedY - start.y),
    });
  }, [cropMode]);

  /**
   * 处理鼠标松开（结束拖拽，进入 confirmed 状态）
   * - 选区过小（<5px）视为无效点击，回到 idle
   * - 选区有效 → confirmed，等待用户确认或重新选择
   */
  const handleMouseUp = useCallback(() => {
    if (cropMode !== "selecting") return;
    dragStartRef.current = null;
    // 检查选区是否有效
    setCropRect((prev) => {
      if (!prev || prev.width < 5 || prev.height < 5) {
        // 选区过小，视为无效点击，回到 idle
        setCropMode("idle");
        return null;
      }
      // 选区有效，进入 confirmed 状态
      setCropMode("confirmed");
      return prev;
    });
  }, [cropMode]);

  /** 应用裁剪：仅在 confirmed 状态可执行 */
  const handleApplyCrop = useCallback(async () => {
    if (cropMode !== "confirmed" || !cropRect || cropRect.width < 5 || cropRect.height < 5) {
      setError(t("image.crop"));
      return;
    }
    const scale = getScale();
    if (!scale) {
      setError(t("image.edit"));
      return;
    }
    setProcessing(true);
    setError("");
    try {
      // 转换为原图坐标
      const originalCrop: CropRect = {
        x: Math.round(cropRect.x * scale.scaleX),
        y: Math.round(cropRect.y * scale.scaleY),
        width: Math.round(cropRect.width * scale.scaleX),
        height: Math.round(cropRect.height * scale.scaleY),
      };
      const result = await cropImage(currentSrc, originalCrop);
      setCurrentSrc(result);
      setCropRect(null);
      setCropMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  }, [cropMode, cropRect, currentSrc, getScale, t]);

  /** 旋转 90° */
  const handleRotate90 = useCallback(async () => {
    setProcessing(true);
    setError("");
    try {
      const result = await rotateImage(currentSrc, 90);
      setCurrentSrc(result);
      setCropRect(null);
      setCropMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  }, [currentSrc]);

  /** 旋转 270° */
  const handleRotate270 = useCallback(async () => {
    setProcessing(true);
    setError("");
    try {
      const result = await rotateImage(currentSrc, 270);
      setCurrentSrc(result);
      setCropRect(null);
      setCropMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  }, [currentSrc]);

  /** 水平翻转 */
  const handleFlipHorizontal = useCallback(async () => {
    setProcessing(true);
    setError("");
    try {
      const result = await flipImage(currentSrc, true);
      setCurrentSrc(result);
      setCropRect(null);
      setCropMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  }, [currentSrc]);

  /** 垂直翻转 */
  const handleFlipVertical = useCallback(async () => {
    setProcessing(true);
    setError("");
    try {
      const result = await flipImage(currentSrc, false);
      setCurrentSrc(result);
      setCropRect(null);
      setCropMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  }, [currentSrc]);

  /** 重置到原始图片 */
  const handleReset = useCallback(() => {
    setCurrentSrc(originalSrc);
    setCropRect(null);
    setCropMode("idle");
    setError("");
  }, [originalSrc]);

  /** 确认：保存编辑后的图片到文档 */
  const handleConfirm = useCallback(() => {
    if (processing || !currentSrc) return;
    onConfirm(currentSrc);
  }, [processing, currentSrc, onConfirm]);

  // Esc 取消
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

  /** 选区样式（用于渲染选区遮罩） */
  const cropOverlayStyle = useMemo<React.CSSProperties>(() => {
    if (!cropRect) return { display: "none" };
    return {
      left: cropRect.x,
      top: cropRect.y,
      width: cropRect.width,
      height: cropRect.height,
    };
  }, [cropRect]);

  if (!open) return null;

  return (
    <div className="image-edit-overlay" onClick={onClose}>
      <div className="image-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="image-edit-header">
          <h3>{t("image.edit")}</h3>
        </div>

        <div className="image-edit-body">
          {error && <div className="image-edit-error">{error}</div>}

          <div
            ref={editorRef}
            className="image-edit-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {currentSrc && (
              <img
                ref={imgRef}
                src={currentSrc}
                alt="editing"
                draggable={false}
                className="image-edit-img"
              />
            )}
            {cropRect && (
              <div className="image-edit-crop-overlay" style={cropOverlayStyle}>
                <div className="image-edit-crop-border" />
              </div>
            )}
            {cropRect && (
              <div className="image-edit-crop-mask" style={cropOverlayStyle} />
            )}
          </div>

          <div className="image-edit-tip">
            {cropMode === "idle" && t("image.cropTipIdle")}
            {cropMode === "selecting" && t("image.cropTipSelecting")}
            {cropMode === "confirmed" && t("image.cropTipConfirmed")}
          </div>

          <div className="image-edit-toolbar">
            <button
              type="button"
              className="image-edit-tool-btn"
              onClick={handleApplyCrop}
              disabled={processing || cropMode !== "confirmed"}
              title={t("image.apply")}
            >
              {t("image.apply")}
            </button>
            <button
              type="button"
              className="image-edit-tool-btn"
              onClick={handleRotate90}
              disabled={processing}
              title="90°"
            >
              {t("image.rotate")} 90°
            </button>
            <button
              type="button"
              className="image-edit-tool-btn"
              onClick={handleRotate270}
              disabled={processing}
              title="270°"
            >
              {t("image.rotate")} 270°
            </button>
            <button
              type="button"
              className="image-edit-tool-btn"
              onClick={handleFlipHorizontal}
              disabled={processing}
              title={t("image.flipHorizontal")}
            >
              {t("image.flipHorizontal")}
            </button>
            <button
              type="button"
              className="image-edit-tool-btn"
              onClick={handleFlipVertical}
              disabled={processing}
              title={t("image.flipVertical")}
            >
              {t("image.flipVertical")}
            </button>
            <button
              type="button"
              className="image-edit-tool-btn"
              onClick={handleReset}
              disabled={processing || currentSrc === originalSrc}
              title={t("image.reset")}
            >
              {t("image.reset")}
            </button>
          </div>
        </div>

        <div className="image-edit-footer">
          <button className="image-edit-btn secondary" onClick={onClose} type="button">
            {t("image.cancel")}
            <span className="image-edit-kbd">Esc</span>
          </button>
          <button
            className="image-edit-btn primary"
            onClick={handleConfirm}
            disabled={processing || !currentSrc}
            type="button"
          >
            {processing ? "..." : t("image.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
