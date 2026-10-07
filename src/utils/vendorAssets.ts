/**
 * v0.11.0 B2-1：导出资源内联（离线可用）。
 *
 * 缺陷背景（P0）：
 *   ExportDialog 的 exportHTML / exportPDF 注入 jsdelivr CDN 上的 mermaid 与
 *   KaTeX → **离线/内网打开导出文件时，公式与图表全空白，且无任何降级提示**。
 *   而 `public/vendor/katex`（592K）与 `public/vendor/mermaid`（3.2M）就在仓库内。
 *
 * ⚠️ v0.11.0 返修（本次）：首版实现从 Tauri 的 `resourceDir()` 用 plugin-fs 读
 *   `vendor/...`，但 `public/vendor` 经 Vite 打进 **dist 并由 webview 源提供**，
 *   `tauri.conf.json` 也没有 `bundle.resources` 映射 ⇒ resourceDir 下根本没有
 *   `vendor/`，`resolveAssetPath` 恒返回 null ⇒ 内联恒失败、恒回退 CDN
 *   （实测：导出 HTML 仅 4.7KB、3 条 jsdelivr、0 个 data:font、无 `_assets/`）。
 *
 *   现改为**从应用自身的 webview 源 fetch**（开发态由 Vite 提供 public/，
 *   打包后由内嵌的 dist 提供）——与 `index.html` 引 `/vendor/katex` 是同一条
 *   真实可用路径；fs 读取保留为兜底（若将来补上 bundle.resources 仍可工作）。
 *   同时去掉 `isTauri()` 前置短路，使本模块可在单测中直接验证
 *   （首版把 collectInlineAssets 排除在测试外，正是这个 P0 漏网的原因）。
 *
 * 本模块的策略（按体积权衡，用户拍板）：
 *   - **KaTeX 内联**（约 300K）：CSS + JS 内联，字体转 base64 data URL 内联
 *     → 导出 HTML 单文件自包含，离线可用。
 *   - **Mermaid 不内联**（3.2M，内联会让 HTML 臃肿到不可用）：
 *     改为在导出目录旁置 `_assets/mermaid.min.js`，HTML 用相对路径引用。
 *     这是「完全离线可用」与「文件体积」的折中。
 *
 * 附带修复：katex.min.css 声明了 60 个 url(fonts/...) 但字体目录只有 20 个
 * woff2（其余 40 个 woff/ttf 根本不存在）→ 内联时按**实际能否取到**过滤，
 * 取不到的连同其 `format(...)` 一起移除，不再留死引用。
 */
/** fs 兜底需要 Tauri 运行时；fetch 路径在浏览器/打包产物下都可用 */
async function fsFallbackAvailable(): Promise<boolean> {
  try {
    const { isTauri } = await import("../services/fileService");
    return isTauri();
  } catch {
    return false;
  }
}

/** 资源文件（相对应用资源根 / webview 根的路径） */
export interface VendorAsset {
  /** 源路径（相对 public/） */
  src: string;
  /** 导出目录中的相对路径 */
  dest: string;
}

/** KaTeX 需要内联的文件（字体在 renderKatexCss 中按需内联） */
const KATEX_JS: VendorAsset = { src: "vendor/katex/katex.min.js", dest: "katex.min.js" };
const KATEX_CSS: VendorAsset = { src: "vendor/katex/katex.min.css", dest: "katex.min.css" };
/** Mermaid 体积过大，改为旁置目录 */
const MERMAID_JS: VendorAsset = {
  src: "vendor/mermaid/mermaid.min.js",
  dest: "mermaid.min.js",
};

/** 资源子目录名（导出目录下） */
export const EXPORT_ASSETS_DIR = "_assets";

/**
 * 资源在应用内的 URL。
 *
 * 相对 `document.baseURI` 解析：开发态是 Vite 的根（public/ 由此提供），
 * 打包后是 `http://tauri.localhost/`（内嵌 dist 由此提供）。
 * 抽成纯函数以便单测直接断言解析结果。
 */
export function assetUrl(asset: VendorAsset, base?: string): string {
  const b = base ?? (typeof document !== "undefined" ? document.baseURI : undefined);
  return b ? new URL(asset.src, b).href : asset.src;
}

/** Uint8Array → base64（分块避免 apply 参数栈溢出，字体可达 100KB+） */
function bytesToBase64(arr: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(arr.subarray(i, i + chunk)) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** ① 经 webview 源取字节（打包产物真实可用路径） */
async function fetchAssetBytes(asset: VendorAsset): Promise<Uint8Array | null> {
  try {
    const res = await fetch(assetUrl(asset));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** ② fs 兜底：resourceDir + 相对路径（仅在配置了 bundle.resources 时才有文件） */
async function resolveAssetPathViaFs(asset: VendorAsset): Promise<string | null> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    const { resourceDir } = await import("@tauri-apps/api/path");
    const dir = await resourceDir();
    const candidate = `${dir}/${asset.src}`;
    if (await exists(candidate)) return candidate;
  } catch {
    /* resourceDir 不可用 */
  }
  return null;
}

/** 读取资源为字符串（webview fetch 优先，fs 兜底） */
async function readAssetText(asset: VendorAsset): Promise<string | null> {
  try {
    const res = await fetch(assetUrl(asset));
    if (res.ok) return await res.text();
  } catch {
    /* 落到 fs 兜底 */
  }
  if (!(await fsFallbackAvailable())) return null;
  try {
    const fullPath = await resolveAssetPathViaFs(asset);
    if (!fullPath) return null;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(fullPath);
  } catch (err) {
    console.warn("[导出] 读取资源失败:", asset.src, err);
    return null;
  }
}

/** 读取资源为 base64（webview fetch 优先，fs 兜底；用于字体内联） */
async function readAssetBase64(asset: VendorAsset): Promise<string | null> {
  const viaFetch = await fetchAssetBytes(asset);
  if (viaFetch) return bytesToBase64(viaFetch);
  if (!(await fsFallbackAvailable())) return null;
  try {
    const fullPath = await resolveAssetPathViaFs(asset);
    if (!fullPath) return null;
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(fullPath);
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
    return bytesToBase64(arr);
  } catch (err) {
    console.warn("[导出] 读取资源失败(base64):", asset.src, err);
    return null;
  }
}

/** 单个字体的 MIME */
function fontMime(name: string): string {
  if (name.endsWith(".woff2")) return "font/woff2";
  if (name.endsWith(".woff")) return "font/woff";
  if (name.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 生成内联字体的 KaTeX CSS。
 *
 * 把 `url(fonts/X.woff2)` 替换为 `url(data:font/woff2;base64,...)`。
 * **取不到的字体连同其 `format(...)` 一起移除**：CSS 里 60 条引用中有 40 条
 * 指向不存在的 woff/ttf，留着只会产生 404 与死 @font-face。
 */
export async function renderKatexCss(): Promise<string | null> {
  const css = await readAssetText(KATEX_CSS);
  if (!css) return null;

  const refs = [...new Set([...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]!))];

  let out = css;
  for (const ref of refs) {
    const name = ref.split("/").pop()!;
    const b64 = await readAssetBase64({ src: `vendor/katex/${ref}`, dest: name });
    if (b64) {
      out = out.replaceAll(`url(${ref})`, `url(data:${fontMime(name)};base64,${b64})`);
      continue;
    }
    // 取不到 → 连同前导逗号与 format() 一起删掉，避免留死引用
    const entry = new RegExp(
      `(,\\s*)?url\\(${escapeRegExp(ref)}\\)(\\s*format\\([^)]*\\))?`,
      "g",
    );
    out = out.replace(entry, "");
  }
  // 清理删除后残留的标点（`url(a) format(...),` → `,;` / `,:` 等）
  out = out
    .replace(/,\s*;/g, ";")
    .replace(/:\s*,/g, ":")
    .replace(/,\s*,/g, ",")
    .replace(/\bsrc\s*:\s*;/g, "")
    .replace(/;\s*}/g, "}");
  return out;
}

/** 内联的 KaTeX JS（读不到时返回 null） */
export async function renderKatexJs(): Promise<string | null> {
  return readAssetText(KATEX_JS);
}

/** 内联的 mermaid JS（读不到时返回 null） */
export async function renderMermaidJs(): Promise<string | null> {
  return readAssetText(MERMAID_JS);
}

/** 导出结果：HTML 片段 + 需要旁置的资源 */
export interface InlineAssets {
  /** 替换原 CDN <script> 的内容；null 表示需回退 CDN */
  katexCss: string | null;
  katexJs: string | null;
  /** mermaid JS 内容；为 null 时应写 `_assets/mermaid.min.js` 并用相对路径引用 */
  mermaidJs: string | null;
  /** 是否成功读到至少一份资源（false 时应回退 CDN 并告知用户） */
  ok: boolean;
  /** 具体哪几类资源没读到（用于给出精确的降级提示） */
  missing: Array<"katexCss" | "katexJs" | "mermaidJs">;
}

/**
 * 读取全部可内联资源。
 *
 * @param includeFonts 是否内联 KaTeX 字体（体积大但离线必需；仅 KaTeX 需要）
 */
export async function collectInlineAssets(includeFonts = true): Promise<InlineAssets> {
  const [katexJs, mermaidJs] = await Promise.all([renderKatexJs(), renderMermaidJs()]);
  const katexCss = includeFonts ? await renderKatexCss() : await readAssetText(KATEX_CSS);
  const missing: InlineAssets["missing"] = [];
  if (!katexCss) missing.push("katexCss");
  if (!katexJs) missing.push("katexJs");
  if (!mermaidJs) missing.push("mermaidJs");
  return { katexCss, katexJs, mermaidJs, ok: missing.length < 3, missing };
}

/** 生成 KaTeX 渲染脚本（内联版，无需外部 JS） */
export function buildKatexRenderScript(): string {
  return `<script>
document.querySelectorAll("[data-math=inline]").forEach(function(e){
  var l=e.getAttribute("data-latex");
  if(l){try{katex.render(l,e,{throwOnError:false,displayMode:false});}catch(err){e.textContent="⚠ "+err.message;}}
});
document.querySelectorAll("[data-math=block]").forEach(function(e){
  var l=e.getAttribute("data-latex");
  if(l){try{katex.render(l,e,{throwOnError:false,displayMode:true});}catch(err){e.textContent="⚠ "+err.message;}}
});
</script>`;
}

/** mermaid 初始化脚本（theme 由调用方传入） */
export function buildMermaidInitScript(theme: string, securityLevel = "strict"): string {
  return `<script>mermaid.initialize({startOnLoad:true,theme:"${theme}",securityLevel:"${securityLevel}"});</script>`;
}
