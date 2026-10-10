/**
 * v0.12.1 需求9：排版设置的**临时预览**（不落盘、不进持久化设置）。
 *
 * 背景：字号 / 字体 / 行高 / 段间距 / 内容区宽度这五项此前是"保存后生效"——
 * 设置弹窗里拖滑条看不到文档变化，用户要求"实时能看到调整效果"。
 *
 * 为什么单独开一个 store 而不是直接写 useSettingsStore：
 *  · useSettingsStore 走 zustand persist，每次 set 都会同步写 localStorage，
 *    并把变更广播给其它窗口（utils/broadcast.ts 订阅了它）——拖滑条会在拖动过程中
 *    每帧写一次磁盘 + 发一次 IPC；
 *  · 直接写持久化设置还会让"取消"变得不可逆（旧值已被覆盖）。
 *
 * 因此：拖动期间只写这个**非持久化**的预览 store（EditorContainer 用它覆盖 CSS 变量），
 * 点「保存设置」才真正写进 useSettingsStore；点取消 / ✕ / 遮罩 / Esc 只需 clear()，
 * 文档立刻回到原样。
 */
import { create } from "zustand";

export interface TypographyPreview {
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  paragraphSpacing?: number;
  contentMaxWidth?: number;
}

interface TypographyPreviewState {
  preview: TypographyPreview | null;
  setPreview: (preview: TypographyPreview) => void;
  clear: () => void;
}

export const useTypographyPreviewStore = create<TypographyPreviewState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
  clear: () => set({ preview: null }),
}));

/** 预览值优先于已保存值（拖滑条时立即生效；保存后两者一致） */
export function withPreview<T>(saved: T, previewed: T | undefined): T {
  return previewed === undefined ? saved : previewed;
}
