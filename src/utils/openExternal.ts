/**
 * v0.12.0 需求8：外部链接统一打开工具
 *
 * 从 EditorContainer 的 openExternalHref 抽出（设置弹窗「关于 LightMD」的
 * GitHub 地址需要同一能力）：Tauri 环境走 plugin-shell 的 open（经系统浏览器
 * 打开、不离开应用）；浏览器 dev 环境退化为 window.open。
 */
import { isTauri } from "../services/fileService";

/** 打开外部链接（http(s)/mailto 等交由系统处理） */
export async function openExternalHref(href: string): Promise<void> {
  if (isTauri()) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(href);
    } catch (err) {
      console.error("外部链接打开失败:", err);
    }
  } else {
    window.open(href, "_blank", "noopener");
  }
}