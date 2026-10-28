/**
 * v0.15.0 R3c：AI 连接档案的**凭据存取边界**。
 *
 * ## 为什么单独抽一层接口，而不是直接在组件里调 translateService
 *
 * 1. **槽位不匹配是真实风险**：`translateService.setKey(provider, key)` 写入的是
 *    `translate_api_key::{provider}` 槽位，而 Rust 侧为 AI profile 预留的是
 *    `ai_credential::{credentialId}` 槽位（见 `commands/translate.rs` 的
 *    `profile_keyring_entry`）。在该命令接线完成前，直接把 credentialId 当 provider
 *    传进去会写错槽位。因此这里把「存取」抽成接口，由宿主（Lead）注入正确实现；
 * 2. **删除是缺失能力**：Rust 目前没有任何删除 keyring 条目的命令
 *    （`set_translate_key` 拒绝空 Key），所以「清除 Key」在接口里是**可选方法**，
 *    未提供时 UI 必须禁用按钮并给出说明，而不是静默失败或假装已清除；
 * 3. **可测性**：组件测试注入内存实现即可，不需要 mock Tauri IPC。
 *
 * ## 硬约束（贯穿本模块与组件）
 * - API Key **绝不**进入 `AiSettings`/persist，绝不回显明文；
 * - `has()` 只返回布尔（与 `has_translate_key` 同语义，读不到明文）；
 * - `authMode: "none"` 的档案（Ollama）不调用任何 Key 能力。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../services/fileService";

/** 凭据存取接口。credentialId = profile.credentialId（= profile.id）。 */
export interface AiCredentialStore {
  /** 该 credentialId 是否已配置 Key（只回布尔，无明文） */
  has(credentialId: string): Promise<boolean>;
  /** 保存 Key。实现方负责写入系统凭据库，不得回传/记录明文 */
  save(credentialId: string, key: string): Promise<void>;
  /**
   * 清除 Key。**可选**：后端尚未提供删除命令时不要实现它，
   * 组件会据 `clear` 是否存在来决定按钮可用性。
   */
  clear?(credentialId: string): Promise<void>;
}

/**
 * 默认实现：走 **AI 专用凭据命令**，槽位 `ai_credential::{credentialId}`。
 *
 * 为什么不能用 translateService 的 `setKey/hasKey`：那写的是
 * `translate_api_key::{provider}` 槽位，与 AI profile 槽位不同 → AI 请求读不到 Key
 * （报 NO_KEY）；且同一 provider 配两个端点会串用同一个 Key。
 *
 * 三个命令已由 Rust 实现并注册（`commands/translate.rs` + `lib.rs`）。
 * 非 Tauri 环境明确抛错，不静默降级（让调用方知道凭据不可用）。
 */
export function createDefaultCredentialStore(): AiCredentialStore {
  return {
    async has(credentialId: string): Promise<boolean> {
      if (!isTauri()) return false;
      try {
        return await invoke<boolean>("has_ai_credential_key", { credentialId });
      } catch {
        // 凭据管理器不可用 → 视为未配置（UI 显示"未配置"，不阻断其它功能）
        return false;
      }
    },
    async save(credentialId: string, key: string): Promise<void> {
      if (!isTauri()) throw new Error("AUTH|non-tauri");
      await invoke("set_ai_credential_key", { credentialId, key });
    },
    async clear(credentialId: string): Promise<void> {
      if (!isTauri()) throw new Error("AUTH|non-tauri");
      await invoke("clear_ai_credential_key", { credentialId });
    },
  };
}

/** 测试/预览用内存实现（不接触系统凭据库，也不写入任何持久化存储） */
export function createMemoryCredentialStore(initial: Record<string, string> = {}): AiCredentialStore & {
  /** 测试断言用：已保存的凭据（仅存在于内存，测试结束即丢弃） */
  readonly stored: Map<string, string>;
} {
  const stored = new Map(Object.entries(initial));
  return {
    stored,
    async has(credentialId: string): Promise<boolean> {
      return stored.has(credentialId);
    },
    async save(credentialId: string, key: string): Promise<void> {
      if (!key.trim()) throw new Error("AUTH|Key 不能为空");
      stored.set(credentialId, key.trim());
    },
    async clear(credentialId: string): Promise<void> {
      stored.delete(credentialId);
    },
  };
}

/** 凭据错误码 → i18n key（与翻译错误分类同口径：`CODE|detail`） */
export function credentialErrorKey(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (raw.includes("NO_KEY")) return "settings.ai.apiKey.error.noKey";
  if (raw.includes("AUTH")) return "settings.ai.apiKey.error.auth";
  if (raw.includes("NETWORK")) return "settings.ai.apiKey.error.network";
  return "settings.ai.apiKey.error.generic";
}
