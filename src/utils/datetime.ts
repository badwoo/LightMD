/**
 * v0.12.0 需求7：时间格式化工具（侧栏文件条目日期显示）
 *
 * 抽成纯函数便于单测边界：0 / undefined / NaN / 负数均返回空串（渲染层据此隐藏），
 * 有效时间戳输出 `YYYY-MM-DD HH:mm`（本地时区，补零对齐）。
 */

/** 将毫秒时间戳格式化为 `YYYY-MM-DD HH:mm`；无效值返回空串 */
export function formatFileTime(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${mi}`;
}