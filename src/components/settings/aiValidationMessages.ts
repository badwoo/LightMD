/**
 * v0.15.0 R3c：校验机器码 → i18n key 的映射（纯函数）。
 *
 * `validateAiConnectionProfile` 返回的是**机器可读错误码**（`profile.model.required`
 * 这类），设计上不夹带任何文案。本模块负责把它翻译成 UI 需要的 key，
 * 组件再用 `t(key)` 渲染 —— 这样新增错误码时只改这一处映射，文案仍归 i18n。
 */
import type { AiProfileValidationError } from "../../services/aiProfiles";

/** 错误码 → 文案 key。未知码兜底到通用错误，绝不显示裸机器码给用户。 */
export function validationErrorKey(code: AiProfileValidationError | string): string {
  switch (code) {
    case "profile.id.required":
      return "settings.ai.error.idRequired";
    case "profile.name.required":
      return "settings.ai.error.nameRequired";
    case "profile.protocol.invalid":
      return "settings.ai.error.protocolInvalid";
    case "profile.baseUrl.required":
      return "settings.ai.error.baseUrlRequired";
    case "profile.model.required":
      return "settings.ai.error.modelRequired";
    case "profile.credentialId.mismatch":
      // 内部一致性错误：正常 UI 路径不会产生（复制/新建都同步换 id）。
      // 若出现说明数据被外部改坏，要让用户看到而不是静默吞掉。
      return "settings.ai.error.credentialIdMismatch";
    case "profile.authMode.invalid":
      return "settings.ai.error.authModeInvalid";
    case "profile.contextWindowTokens.invalid":
      return "settings.ai.error.contextWindowInvalid";
    case "profile.maxOutputTokens.invalid":
      return "settings.ai.error.maxOutputInvalid";
    case "profile.requestPolicy.invalid":
      return "settings.ai.error.requestPolicyInvalid";
    case "profile.temperature.invalid":
      return "settings.ai.error.temperatureInvalid";
    default:
      return "settings.ai.error.generic";
  }
}

/** 指令校验错误码 → 文案 key */
export function instructionIssueKey(code: string): string {
  switch (code) {
    case "name.required":
      return "settings.ai.instruction.error.nameRequired";
    case "template.required":
      return "settings.ai.instruction.error.templateRequired";
    case "variable.unknown":
      return "settings.ai.instruction.warn.unknownVariable";
    default:
      return "settings.ai.error.generic";
  }
}
