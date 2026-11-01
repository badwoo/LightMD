// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), isTauriMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../services/fileService", () => ({ isTauri: isTauriMock }));

import { aiConnectionService } from "../services/aiConnectionService";
import { createDefaultAiSettings } from "../services/aiProfiles";

describe("v0.15.3 aiConnectionService", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  it("Ollama 模型探测传 authMode=none，并保留真实上下文元数据", async () => {
    invokeMock.mockResolvedValue([
      { id: "qwen3-vl:8b", name: "qwen3-vl:8b", contextWindowTokens: 262144 },
      { id: "broken", name: "" },
    ]);
    const profile = createDefaultAiSettings().profiles[0]!;
    await expect(aiConnectionService.listModels(profile)).resolves.toEqual([
      { id: "qwen3-vl:8b", name: "qwen3-vl:8b", contextWindowTokens: 262144 },
      { id: "broken", name: "broken" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("list_ai_models", expect.objectContaining({
      credentialId: "ollama",
      provider: "ollama",
      protocol: "openai-chat",
      authMode: "none",
      baseUrl: "http://127.0.0.1:11434/v1",
    }));
  });

  it("测试自定义 Responses 连接时透传 Provider 与协议", async () => {
    invokeMock.mockResolvedValue(undefined);
    const profile = {
      ...createDefaultAiSettings().profiles[0]!,
      providerId: "acme-api",
      credentialId: "acme-api",
      protocol: "openai-responses" as const,
      baseUrl: "https://acme.example/v1",
      model: "model-a",
      authMode: "required" as const,
    };
    await aiConnectionService.testConnection(profile);
    expect(invokeMock).toHaveBeenCalledWith("test_ai_connection", expect.objectContaining({
      provider: "acme-api",
      credentialId: "acme-api",
      protocol: "openai-responses",
      model: "model-a",
      authMode: "required",
    }));
  });

  it("非 Tauri 环境不发 IPC", async () => {
    isTauriMock.mockReturnValue(false);
    const profile = createDefaultAiSettings().profiles[0]!;
    await expect(aiConnectionService.listModels(profile)).rejects.toMatchObject({ info: { code: "NETWORK" } });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
