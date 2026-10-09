/**
 * v0.12.0 需求5：文档缩放尺（右下角 hover 显现）
 *
 * 交互（用户确认）：
 * - 默认透明（opacity 0），鼠标移入右下角尺子区域即显现（150ms 过渡）；
 * - 向上推 = 放大、向下推 = 缩小；刻度可点击跳转 + 拖动连续调整。
 *
 * v0.12.0 返修：
 * - **100% 刻度位于尺子正中间**：缩放范围 50~200 若线性映射，100% 偏在下 1/3 处。
 *   改为分段线性（50~100 占下半、100~200 占上半），内部滑条用线性"位置值"
 *   0~1000，经 valueToPosition/positionToValue 与真实缩放互转——原生 range 的
 *   拖动/点击/键盘行为全部保留，仅值换算非线性；
 * - 100% 刻度线颜色加深（.zoom-ruler-mid）；
 * - 调整过程中显示**圆形透明气泡**实时百分比，百分比越大气泡与数字越大；
 *   （Ctrl+滚轮调整同样生效——value 变化即进入"调整中"态）
 * - 停止调整后在尺子位置显示一个低透明度小百分比数字，保持 100% 时不显示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { DOC_ZOOM_MIN, DOC_ZOOM_MAX, DOC_ZOOM_STEP } from "../../stores/useSettingsStore";
import "./ZoomRuler.css";

interface ZoomRulerProps {
  /** 当前缩放（百分比，50~200） */
  value: number;
  /** 变更回调（钳制由 store 负责） */
  onChange: (value: number) => void;
}

/** 内部滑条位置量程（0~1000 线性；500 = 100% 居中） */
const POS_MAX = 1000;
const POS_MID = POS_MAX / 2;

/** 真实缩放 → 滑条位置：50~100 占下半，100~200 占上半（分段线性） */
function valueToPosition(value: number): number {
  if (value <= 100) {
    return ((value - DOC_ZOOM_MIN) / (100 - DOC_ZOOM_MIN)) * POS_MID;
  }
  return POS_MID + ((value - 100) / (DOC_ZOOM_MAX - 100)) * POS_MID;
}

/** 滑条位置 → 真实缩放（与 valueToPosition 互逆） */
function positionToValue(pos: number): number {
  if (pos <= POS_MID) {
    return DOC_ZOOM_MIN + (pos / POS_MID) * (100 - DOC_ZOOM_MIN);
  }
  return 100 + ((pos - POS_MID) / POS_MID) * (DOC_ZOOM_MAX - 100);
}

export function ZoomRuler({ value, onChange }: ZoomRulerProps) {
  const t = useT();
  const [adjusting, setAdjusting] = useState(false);
  const adjustTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 值变化（拖动/Ctrl+滚轮）→ 进入"调整中"态；停顿 600ms 后退出 */
  useEffect(() => {
    setAdjusting(true);
    if (adjustTimerRef.current) clearTimeout(adjustTimerRef.current);
    adjustTimerRef.current = setTimeout(() => setAdjusting(false), 600);
    return () => {
      if (adjustTimerRef.current) clearTimeout(adjustTimerRef.current);
    };
  }, [value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // 内部位置值 → 真实缩放（取整到步进，避免分段映射产生 5% 以内的碎值）
      const raw = positionToValue(Number(e.target.value));
      onChange(Math.round(raw / DOC_ZOOM_STEP) * DOC_ZOOM_STEP);
    },
    [onChange],
  );

  // 气泡尺寸随百分比增大（50% → 最小，200% → 最大）
  const bubbleScale = (value - DOC_ZOOM_MIN) / (DOC_ZOOM_MAX - DOC_ZOOM_MIN);
  const bubbleSize = Math.round(36 + bubbleScale * 22);
  const bubbleFont = Math.round(12 + bubbleScale * 5);

  return (
    <div className="zoom-ruler" title={t("zoomRuler.label")} data-testid="zoom-ruler">
      {adjusting && (
        <div
          className="zoom-ruler-bubble"
          data-testid="zoom-ruler-bubble"
          style={{ width: bubbleSize, height: bubbleSize, fontSize: bubbleFont }}
        >
          {value}%
        </div>
      )}
      {!adjusting && value !== 100 && (
        <span className="zoom-ruler-idle-value" data-testid="zoom-ruler-idle-value">
          {value}%
        </span>
      )}
      <div className="zoom-ruler-track-wrap">
        <span className="zoom-ruler-mid" aria-hidden="true" />
        <input
          type="range"
          className="zoom-ruler-range"
          min={0}
          max={POS_MAX}
          step={1}
          value={valueToPosition(value)}
          onChange={handleChange}
          aria-label={t("zoomRuler.label")}
        />
      </div>
    </div>
  );
}
