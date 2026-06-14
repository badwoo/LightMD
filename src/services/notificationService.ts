/**
 * 全局通知服务 —— 统一的用户反馈机制
 *
 * 通过 React 组件注册处理器，将 invoke 错误、操作结果
 * 通过 UI toast 通知用户，而非静默失败。
 */

export type NotificationType = "error" | "info" | "success" | "warning";

export interface Notification {
  id: number;
  message: string;
  type: NotificationType;
  timestamp: number;
}

type NotificationHandler = (notification: Notification) => void;

let handler: NotificationHandler | null = null;
let nextId = 1;

/** 注册通知处理器（由 React 组件调用） */
export function setNotificationHandler(h: NotificationHandler | null) {
  handler = h;
}

/** 发送通知 */
export function notify(message: string, type: NotificationType = "info") {
  console.log(`[LightMD][${type}] ${message}`);
  if (handler) {
    handler({ id: nextId++, message, type, timestamp: Date.now() });
  }
}

/** 发送成功通知 */
export function notifySuccess(message: string) {
  notify(message, "success");
}

/** 发送错误通知 */
export function notifyError(message: string) {
  notify(message, "error");
}

/** 发送警告通知 */
export function notifyWarning(message: string) {
  notify(message, "warning");
}
