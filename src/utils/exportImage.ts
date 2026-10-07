/**
 * G12 导出图片（PNG 长图）工具
 *
 * 使用 html-to-image 库将 DOM 元素转为 PNG dataURL。
 * Tauri 环境下使用 save 对话框选择保存路径，浏览器环境下回退到 a.download 下载。
 * 长文档处理：直接对预览容器 toPng，html-to-image 内部处理像素合并。
 *
 * 设计要点：
 * - 动态 import html-to-image，避免在首屏加载该库（约 50KB gzip）
 * - pixelRatio: 2 保证清晰度
 * - backgroundColor: '#fff' 避免透明背景在长图中显示异常
 * - cacheBust: true 避免缓存导致图片缺失
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "../services/fileService";
import { notifyError, notifySuccess } from "../services/notificationService";
import { t } from "../i18n";

export interface ExportImageOptions {
  /** 当前编辑文件路径，用于推导默认保存目录 */
  filePath?: string | null;
}

/** 从文件路径推导默认保存目录 */
function getDefaultDir(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return idx > 0 ? filePath.substring(0, idx) : undefined;
}

/**
 * 把 DOM 元素导出为 PNG 图片
 *
 * v0.11.0 B2-3：字体处理改为「显式内联 KaTeX 字体」而非跳过。
 *
 * 缺陷背景（P0）：原实现 `skipFonts: true`，注释理由是「字体嵌入需 fetch
 * @font-face，失败会导致 SVG foreignObject 渲染空白」。但公式依赖 KaTeX 的
 * Web 字体（index.html 引入 /vendor/katex），跳过字体 → **截图内公式回退/错形**。
 * 同时 DOCX 路径（exportDocx.ts:92）没有设 skipFonts → 两条导出路径字体行为不一致。
 *
 * 修复：skipFonts 保持 true（避免 html-to-image 自动 fetch 跨域字体失败），
 * 改为**显式传入 fontEmbedCSS** —— 复用 B2-1 已实现的 vendorAssets 字体内联能力
 * （含字体 base64），字体因此确定性地嵌入，不依赖 html-to-image 的自动 fetch。
 * 读不到字体时降级为「无 fontEmbedCSS」，并在返回 false 时给出明确提示，
 * 而非静默输出错形图片。
 */
export async function exportElementAsPng(
  element: HTMLElement,
  filename: string,
  opts?: ExportImageOptions,
): Promise<boolean> {
  try {
    // 动态加载库，避免首屏体积
    const { toPng } = await import("html-to-image");

    // v0.11.0 B2-3：预取 KaTeX CSS（字体已内联为 data URL）作为 fontEmbedCSS
    let fontEmbedCSS: string | undefined;
    try {
      const { renderKatexCss } = await import("./vendorAssets");
      const css = await renderKatexCss();
      if (css) fontEmbedCSS = css;
    } catch (err) {
      // 读不到字体不阻断导出，仅公式可能错形（下方会提示）
      console.warn("[导出PNG] 字体 CSS 预取失败，公式可能错形:", err);
    }

    // 长文档截图：html-to-image 内部会处理元素高度
    // pixelRatio=2 提高清晰度，但内存占用较高，对超长文档（>10000px）需注意
    const dataUrl = await toPng(element, {
      pixelRatio: 2,
      backgroundColor: "#fff",
      cacheBust: true,
      // v0.11.0 B2-3：保持跳过自动字体嵌入（避免跨域 fetch 失败导致整图空白），
      // 改由 fontEmbedCSS 显式提供 KaTeX 字体（数据已 base64 内联，无跨域问题）
      skipFonts: true,
      ...(fontEmbedCSS ? { fontEmbedCSS } : {}),
    });

    const finalName = filename.endsWith(".png") ? filename : `${filename}.png`;

    // v0.11.0 B2-3：字体未就绪时给出明确提示，而非静默输出错形图片
    if (!fontEmbedCSS) {
      const { notifyWarning } = await import("../services/notificationService");
      notifyWarning("未能加载公式字体，导出的图片中公式可能显示异常");
    }

    // Tauri 环境：使用 save 对话框选择保存路径，writeFile 写入二进制
    if (isTauri()) {
      try {
        const defaultDir = getDefaultDir(opts?.filePath);
        const selected = await save({
          defaultPath: defaultDir ? `${defaultDir}/${finalName}` : finalName,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (!selected) return false; // 用户取消

        // 将 dataURL 转换为 Uint8Array 写入文件
        const base64 = dataUrl.split(",")[1];
        const bytes = base64ToUint8Array(base64);
        await writeFile(selected, bytes);
        notifySuccess(t("export.image.exported", { name: finalName }));
        return true;
      } catch (err) {
        console.error("Tauri 导出图片失败，回退到浏览器下载:", err);
        // 回退到浏览器下载
      }
    }

    // 浏览器模式：触发下载
    const link = document.createElement("a");
    link.download = finalName;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    notifySuccess(t("export.image.exported", { name: finalName }));
    return true;
  } catch (err) {
    console.error("PNG 导出失败:", err);
    notifyError(
      t("export.image.exportFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

/** Base64 字符串转 Uint8Array */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
