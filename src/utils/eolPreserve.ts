/**
 * v0.9.0 D7：保存链路行尾保真。
 *
 * 背景：序列化器输出统一为 LF，而 Windows 下 CRLF 文档经阅读/分屏模式保存时
 * 会被整体改写为 LF，产生全文件 git diff。B6 快路径（未编辑块原文逐字节返回）
 * 天然保留 CRLF；本工具只兜底「重新序列化」的 fallback 路径：
 * 磁盘原文含 CRLF 时，把序列化输出统一转换为 CRLF 再写盘。
 */
export function preserveEol(serialized: string, original: string): string {
  if (!original.includes("\r\n")) return serialized;
  if (serialized.includes("\r\n")) {
    // 混合行尾（B6 命中切片已是 CRLF + miss 块为 LF）：只补缺失的 \r
    return serialized.replace(/(?<!\r)\n/g, "\r\n");
  }
  return serialized.replace(/\n/g, "\r\n");
}
