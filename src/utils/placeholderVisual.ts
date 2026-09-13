/**
 * v0.7.3 改进8(D4)：占位符可视化。
 *
 * AI 流式输出（翻译/润色/续写/摘要）在 Rust 侧做占位符 mask（{{N}} 保护
 * 链接/行内代码/图片），流式 chunk 透传的是未回填的 {{N}}。气泡流式显示时
 * 用户会看到原始占位符，完成瞬间才被 unmask 文本替换（"乱码→正常"跳变）。
 *
 * 此函数把 {{N}} 统一替换为可见的可视化符号 ⟦N⟧，弱化流式跳变，且不影响
 * 复制/回写时使用的原始 unmask 文本。
 */
export function visualizePlaceholders(text: string): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => `⟦${n}⟧`);
}