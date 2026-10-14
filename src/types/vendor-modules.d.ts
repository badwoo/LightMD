/**
 * 第三方模块类型补充声明。
 *
 * `markdown-it-emoji/lib/data/full.mjs` 是包的数据出口（约 1900 条
 * shortcode → unicode 映射），包本身不带 .d.ts。v0.13.0 需求10 的 Emoji
 * 短码补全需要动态 import 它，故在此声明其形态。
 */
declare module "markdown-it-emoji/lib/data/full.mjs" {
  const data: Record<string, string>;
  export default data;
}
