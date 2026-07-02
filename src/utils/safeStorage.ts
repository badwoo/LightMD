/**
 * 安全的 localStorage 存储工具
 *
 * 核心功能：写入前检查内容大小，超过阈值时跳过写入，避免 QuotaExceededError
 * localStorage 通常限制 5-10MB，这里设置 2MB 阈值留出余量
 */

/** localStorage 内容大小阈值（2MB，UTF-16 编码下约 100 万字符） */
const MAX_CONTENT_SIZE = 2 * 1024 * 1024;

/**
 * 安全写入 localStorage，超限时静默跳过
 * @param key 存储键
 * @param value 字符串值
 * @returns 是否成功写入
 */
export function safeSetItem(key: string, value: string): boolean {
  // 空内容直接写入（清除缓存）
  if (!value) {
    try {
      localStorage.setItem(key, "");
      return true;
    } catch {
      return false;
    }
  }

  // 检查内容大小（UTF-16 编码，每个字符约 2 字节）
  const sizeBytes = value.length * 2;
  if (sizeBytes > MAX_CONTENT_SIZE) {
    // 超限跳过，不写入缓存（文件仍可通过 Ctrl+S 保存到磁盘）
    return false;
  }

  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // 可能触发 QuotaExceededError，静默处理
    return false;
  }
}
