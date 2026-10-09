/**
 * v0.12.0 需求5：文档缩放尺（右下角）
 *
 * 交互（用户确认）：
 * - 默认透明（opacity 0），鼠标移入右下角区域即显现（150ms 过渡）；
 * - 向上推 = 放大、向下推 = 缩小；刻度可点击跳转 + 拖动连续调整。
 *
 * v0.12.0 返修（问题3）：
 * - 结构改为 wrap（热区，含百分比气泡）+ ruler（尺身），使「悬停气泡即显现尺子」；
 * - **调整中（拖动 / Ctrl+滚轮，value 变化）尺子强制显现**——此前鼠标不在尺子上，
 *   容器 opacity:0 导致调整时完全看不到尺子，也看不到百分比；
 * - 圆形透明百分比气泡：调整中按比例放大显示；**停止调整后只要不是 100% 就继续
 *   驻留在右下角**（此前它被 opacity:0 的父容器一并隐藏，等于没显示）；仅为 100% 时不显示。
 * - 100% 刻度位于尺子正中间（分段线性映射：50~100 占下半、100~200 占上半），
 *   100% 刻度线颜色加深。内部滑条用线性"位置值" 0~1000，经换算与真实缩放互转，
 *   原生 range 的拖动/点击/键盘行为全部保留。
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

/** 调整中状态的保持时长（ms）：最后一次取值变化后多久算"停止调整" */
const ADJUST_HOLD_MS = 600;

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
  /** 首次挂载不算"调整过"（避免重启后无谓地驻留气泡） */
  const mountedRef = useRef(false);

  /** 值变化（拖动 / Ctrl+滚轮）→ 进入"调整中"态；停顿 ADJUST_HOLD_MS 后退出 */
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setAdjusting(true);
    if (adjustTimerRef.current) clearTimeout(adjustTimerRef.current);
    adjustTimerRef.current = setTimeout(() => setAdjusting(false), ADJUST_HOLD_MS);
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
  const size = Math.round(36 + bubbleScale * 22);
  const font = Math.round(12 + bubbleScale * 5);

  // 非 100% 时时驻留显示（调整中放大；停止调整后缩小变淡，仍可点/悬停唤起尺子）
  const showBadge = adjusting || value !== 100;

  return (
    <div
      className={`zoom-ruler-wrap${adjusting ? " adjusting" : ""}`}
      data-testid="zoom-ruler"
      title={t("zoomRuler.label")}
    >
      {showBadge && (
        <div
          className={`zoom-ruler-badge${adjusting ? " adjusting" : ""}`}
          data-testid="zoom-ruler-badge"
          style={adjusting ? { width: size, height: size, fontSize: font } : undefined}
        >
          {value}%
        </div>
      )}
      <div className="zoom-ruler">
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
    </div>
  );
}