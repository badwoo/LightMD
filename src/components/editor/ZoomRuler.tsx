/**
 * v0.12.0 需求5：文档缩放尺（右下角 hover 显现）
 *
 * 交互（用户确认）：
 * - 默认透明（opacity 0），鼠标移入右下角尺子区域即显现（150ms 过渡）；
 * - 向上推 = 放大、向下推 = 缩小；
 * - 刻度可点击跳转（原生 range 行为）+ 拖动连续调整；
 * - 旁边百分比数字实时更新。
 *
 * 实现用竖向 `input[type=range]`（writing-mode: vertical-lr + direction: rtl 实现
 * "向上增大"），比自绘 canvas 简单且原生支持键盘/无障碍；
 * 刻度齿用 repeating-linear-gradient 画在轨道上。
 */
import { useCallback } from "react";
import { useT } from "../../i18n";
import { DOC_ZOOM_MIN, DOC_ZOOM_MAX, DOC_ZOOM_STEP } from "../../stores/useSettingsStore";
import "./ZoomRuler.css";

interface ZoomRulerProps {
  /** 当前缩放（百分比，50~200） */
  value: number;
  /** 变更回调（钳制由 store 负责） */
  onChange: (value: number) => void;
}

export function ZoomRuler({ value, onChange }: ZoomRulerProps) {
  const t = useT();

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(Number(e.target.value));
    },
    [onChange],
  );

  return (
    <div className="zoom-ruler" title={t("zoomRuler.label")} data-testid="zoom-ruler">
      <span className="zoom-ruler-value">{value}%</span>
      <input
        type="range"
        className="zoom-ruler-range"
        min={DOC_ZOOM_MIN}
        max={DOC_ZOOM_MAX}
        step={DOC_ZOOM_STEP}
        value={value}
        onChange={handleChange}
        aria-label={t("zoomRuler.label")}
      />
    </div>
  );
}