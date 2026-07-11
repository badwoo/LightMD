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
 * 将 DOM 元素导出为 PNG 图片
 *
 * @param element 要截图的 DOM 元素（通常是预览容器）
 * @param filename 下载文件名（不含扩展名）
 * @param opts.filePath 当前编辑文件路径，用于推导默认保存目录
 * @returns 成功返回 true，失败返回 false
 */
export async function exportElementAsPng(
  element: HTMLElement,
  filename: string,
  opts?: ExportImageOptions,
): Promise<boolean> {
  try {
    // 动态加载库，避免首屏体积
    const { toPng } = await import("html-to-image");

    // 长文档截图：html-to-image 内部会处理元素高度
    // pixelRatio=2 提高清晰度，但内存占用较高，对超长文档（>10000px）需注意
    // skipFonts=true 跳过字体嵌入：字体嵌入需要 fetch @font-face 文件，
    // 跨域或系统字体加载失败会导致 SVG foreignObject 无法渲染，输出空白
    const dataUrl = await toPng(element, {
      pixelRatio: 2,
      backgroundColor: "#fff",
      cacheBust: true,
      skipFonts: true,
    });

    const finalName = filename.endsWith(".png") ? filename : `${filename}.png`;

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
