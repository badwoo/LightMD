/**
 * translateService —— AI 翻译前端服务（v0.6.0）
 *
 * 职责：
 * - 封装 translate_text 流式调用（Channel 接收增量）
 * - 大选区前置校验（>4000 字符拒绝，不发 invoke）
 * - 单任务模型：新任务先取消旧任务
 * - Rust 错误码协议解析（NETWORK| / AUTH| / RATE| / TRUNCATED| /
 *   STREAM| / CANCELLED / PLACEHOLDER| / PROVIDER|{status}|{message}）
 * - Key/测试连接命令封装
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./fileService";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { TranslateResultData } from "../stores/translateStore";

/** 大选区防护上限（字符数） */
export const MAX_SELECTION_CHARS = 4000;

/** 前端错误码（含本地前置校验错误） */
export type TranslateErrorCode =
  | "NETWORK" | "AUTH" | "RATE" | "TRUNCATED" | "STREAM"
  | "CANCELLED" | "PROVIDER" | "TOO_LONG" | "EMPTY" | "NO_KEY"
  /** v0.6.3 P0-3：翻译期间文档被编辑，译文未应用（仅全文翻译） */
  | "DOC_CHANGED";

/** 解析后的错误（code 用于 i18n 文案，detail 为补充信息） */
export interface TranslateErrorInfo {
  code: TranslateErrorCode;
  detail: string;
}

/** 服务层统一错误类型 */
export class TranslateServiceError extends Error {
  readonly info: TranslateErrorInfo;
  constructor(info: TranslateErrorInfo) {
    super(`${info.code}: ${info.detail}`);
    this.info = info;
  }
}

/** 解析 Rust 侧错误码协议字符串 */
export function parseTranslateError(raw: unknown): TranslateErrorInfo {
  const msg = typeof raw === "string" ? raw : String(raw ?? "");
  if (msg.startsWith("NETWORK|")) return { code: "NETWORK", detail: msg.slice(8) };
  // v0.6.3 P2-1：NO_KEY = Key 未配置（keyring NoEntry），与 AUTH（Key 无效）区分
  if (msg.startsWith("NO_KEY|")) return { code: "NO_KEY", detail: msg.slice(7) };
  if (msg.startsWith("AUTH|")) return { code: "AUTH", detail: msg.slice(5) };
  if (msg.startsWith("RATE|")) return { code: "RATE", detail: msg.slice(5) };
  if (msg.startsWith("TRUNCATED|")) return { code: "TRUNCATED", detail: msg.slice(10) };
  if (msg.startsWith("STREAM|")) return { code: "STREAM", detail: msg.slice(7) };
  if (msg === "CANCELLED") return { code: "CANCELLED", detail: "" };
  if (msg.startsWith("PLACEHOLDER|")) return { code: "PROVIDER", detail: msg.slice(12) };
  if (msg.startsWith("PROVIDER|")) {
    // PROVIDER|{status}|{message}（三段式）或 PROVIDER|{status}（两段式）
    const rest = msg.slice(9);
    const sep = rest.indexOf("|");
    const status = sep > 0 ? rest.slice(0, sep) : "";
    const detail = sep > 0 ? rest.slice(sep + 1) : rest;
    // 三段式拼接 "status: detail"，两段式直接返回 status
    return { code: "PROVIDER", detail: status && detail ? `${status}: ${detail}` : status || detail };
  }
  // 未识别格式（多为非 Tauri 环境或 IPC 层错误）
  return { code: "NETWORK", detail: msg };
}

/** 单任务互斥在 Rust 侧执行（begin_task/end_task）；v0.6.3 P2-3 删除前端冗余的 taskActive 标志 */

export const translateService = {
  /**
   * 选中翻译（流式）。
   * - 前置校验：空文本/超长直接抛 TranslateServiceError（不发 invoke）
   * - 单任务：发起前取消旧任务
   * @returns 完整翻译结果（已回填占位符，含校验标记）
   */
  async translate(
    text: string,
    onChunk: (chunk: string) => void,
  ): Promise<TranslateResultData> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new TranslateServiceError({ code: "EMPTY", detail: "" });
    }
    if (trimmed.length > MAX_SELECTION_CHARS) {
      throw new TranslateServiceError({ code: "TOO_LONG", detail: "" });
    }
    if (!isTauri()) {
      throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    }

    // 单任务模型：新任务自动取消旧任务（Rust 侧 begin_task 处理互斥）
    await this.cancel().catch(() => undefined);

    const cfg = useSettingsStore.getState().translate;
    const channel = new Channel<string>();
    channel.onmessage = onChunk;

    try {
      const result = await invoke<TranslateResultData>("translate_text", {
        text: trimmed,
        baseUrl: cfg.translateBaseUrl,
        model: cfg.translateModel,
        targetLang: cfg.translateTargetLang,
        tone: cfg.translateTone,
        customPrompt: cfg.translateCustomPrompt || null,
        onChunk: channel,
      });
      return result;
    } catch (e) {
      throw new TranslateServiceError(parseTranslateError(e));
    }
  },

  /** 中断进行中的任务（幂等；静默失败） */
  async cancel(): Promise<void> {
    if (!isTauri()) return;
    try {
      await invoke("cancel_translate");
    } catch {
      // 静默：取消失败不影响主流程
    }
  },

  /** 测试连接：1-token 最小请求验证 Key（设置页用） */
  async testConnection(baseUrl: string, model: string): Promise<void> {
    if (!isTauri()) {
      throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    }
    try {
      await invoke("test_translate_connection", { baseUrl, model });
    } catch (e) {
      throw new TranslateServiceError(parseTranslateError(e));
    }
  },

  /** 保存 API Key 到 keyring */
  async setKey(key: string): Promise<void> {
    if (!isTauri()) {
      throw new TranslateServiceError({ code: "NETWORK", detail: "non-tauri" });
    }
    try {
      await invoke("set_translate_key", { key });
    } catch (e) {
      throw new TranslateServiceError(parseTranslateError(e));
    }
  },

  /** Key 是否已配置（keyring 存在性检查，不回明文） */
  async hasKey(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>("has_translate_key");
    } catch {
      return false;
    }
  },
};
