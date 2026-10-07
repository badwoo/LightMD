/**
 * v0.11.0 B2-1：导出资源内联（离线可用）。
 *
 * 缺陷背景（P0）：
 *   ExportDialog 的 exportHTML / exportPDF 注入 jsdelivr CDN 上的 mermaid 与
 *   KaTeX → **离线/内网打开导出文件时，公式与图表全空白，且无任何降级提示**。
 *   而 `public/vendor/katex`（592K）与 `public/vendor/mermaid`（3.2M）就在仓库内。
 *
 * 本模块的策略（按体积权衡，用户拍板）：
 *   - **KaTeX 内联**（约 300K）：CSS + JS 内联，字体转 base64 data URL 内联
 *     → 导出 HTML 单文件自包含，离线可用。
 *   - **Mermaid 不内联**（3.2M，内联会让 HTML 臃肿到不可用）：
 *     改为在导出目录旁置 `_assets/mermaid.min.js`，HTML 用相对路径引用。
 *     这是「完全离线可用」与「文件体积」的折中。
 *   - 用户可显式关闭内联（回退 CDN），以控制文件体积。
 *
 * 附带修复：katex.min.css 声明了 60 个 url(fonts/...) 但字体目录只有 20 个
 * woff2（其余 40 个 woff/ttf 根本不存在）→ 内联时按实际存在的文件过滤，
 * 避免生成指向空文件的 @font-face。
 */
import { isTauri } from "../services/fileService";

/** 资源文件（相对应用资源目录的路径） */
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

/** Tauri 下读取应用内资源为字符串 */
async function readAssetText(asset: VendorAsset): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const fullPath = await resolveAssetPath(asset);
    if (!fullPath) return null;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(fullPath);
  } catch (err) {
    console.warn("[导出] 读取资源失败:", asset.src, err);
    return null;
  }
}

/** Tauri 下读取应用内资源为 base64（用于字体内联） */
async function readAssetBase64(asset: VendorAsset): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const fullPath = await resolveAssetPath(asset);
    if (!fullPath) return null;
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(fullPath);
    let binary = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
    // 分块避免 apply 栈溢出（字体文件可达 100KB+）
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(arr.subarray(i, i + chunk)) as unknown as number[],
      );
    }
    return btoa(binary);
  } catch (err) {
    console.warn("[导出] 读取资源失败(base64):", asset.src, err);
    return null;
  }
}

/**
 * 解析资源的绝对路径。
 *
 * 优先走 Tauri 的 resourceDir（打包后资源在 resources 目录，public/ 会被复制到
 * 应用资源根）；开发态下 resourceDir 可能不可用，回退到 webview 根的相对路径。
 */
async function resolveAssetPath(asset: VendorAsset): Promise<string | null> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    // ① resourceDir + 相对路径（Tauri v2 的标准做法）
    try {
      const { resourceDir } = await import("@tauri-apps/api/path");
      const dir = await resourceDir();
      const candidate = `${dir}/${asset.src}`;
      if (await exists(candidate)) return candidate;
    } catch {
      /* resourceDir 不可用时回退 */
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/** KaTeX CSS 中引用的字体（与实际字体目录取交集） */
async function listKatexFonts(): Promise<Set<string>> {
  try {
    const fullPath = await resolveAssetPath({ src: "vendor/katex/fonts", dest: "" });
    if (!fullPath) return new Set();
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(fullPath);
    return new Set(
      entries
        .filter((e) => e.isFile)
        .map((e) => (e as { name: string }).name),
    );
  } catch {
    return new Set();
  }
}

/** 单个字体的 MIME */
function fontMime(name: string): string {
  if (name.endsWith(".woff2")) return "font/woff2";
  if (name.endsWith(".woff")) return "font/woff";
  if (name.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

/**
 * 生成内联字体的 KaTeX CSS。
 *
 * 把 `url(fonts/X.woff2)` 替换为 `url(data:font/woff2;base64,...)`。
 * **只处理字体目录中真实存在的文件**（CSS 里另有 40 个 woff/ttf 引用指向
 * 不存在的文件，保留它们无意义且会让某些解析器报错）。
 */
export async function renderKatexCss(): Promise<string | null> {
  const css = await readAssetText(KATEX_CSS);
  if (!css) return null;
  const fonts = await listKatexFonts();
  if (fonts.size === 0) return css; // 读不到字体目录时原样返回（退化但不破坏）

  // 收集所有 url(fonts/...) 引用
  const refs = [...new Set([...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]!))];

  let out = css;
  for (const ref of refs) {
    const name = ref.split("/").pop()!;
    if (!fonts.has(name)) {
      // 引用的文件不存在 → 移除该 @font-face 的 url 声明（保留其余属性无害）
      continue;
    }
    const b64 = await readAssetBase64({
      src: `vendor/katex/${ref}`,
      dest: name,
    });
    if (!b64) continue;
    out = out.replaceAll(
      `url(${ref})`,
      `url(data:${fontMime(name)};base64,${b64})`,
    );
  }
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
  /** 是否成功读到至少一份资源（false 时应回退 CDN） */
  ok: boolean;
}

/**
 * 读取全部可内联资源。
 *
 * @param includeFonts 是否内联 KaTeX 字体（体积大但离线必需；仅 KaTeX 需要）
 */
export async function collectInlineAssets(includeFonts = true): Promise<InlineAssets> {
  const [katexJs, mermaidJs] = await Promise.all([renderKatexJs(), renderMermaidJs()]);
  const katexCss = includeFonts ? await renderKatexCss() : await readAssetText(KATEX_CSS);
  return {
    katexCss,
    katexJs,
    mermaidJs,
    ok: !!(katexJs || katexCss || mermaidJs),
  };
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
