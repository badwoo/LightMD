/**
 * @vitest-environment jsdom
 *
 * v0.15.0 R3c：AI 连接档案纯操作函数单测（aiProfileOps）。
 *
 * 重点锁定那些"在 JSX 里极容易写错"的不变量：
 * 1. 复制档案必须换新 credentialId（否则两个档案共用同一 keyring 槽位）；
 * 2. 删除默认档案要选出新的默认；列表空时 activeProfileId 必须清空（不留悬空 id）；
 * 3. 预设只填端点/协议，**模型 ID 一律留空**；Ollama 的 authMode 必须是 none；
 * 4. 温度/推理档位可空 = undefined（请求里不发送），空输入是合法状态。
 */
import { describe, it, expect } from "vitest";
import {
  AI_PROFILE_PRESETS,
  appendProfile,
  createBlankProfile,
  createProfileFromPreset,
  duplicateProfile,
  findPreset,
  hasProfiles,
  moveProfile,
  newProfileId,
  parsePositiveIntInput,
  parseTemperatureInput,
  removeProfile,
  replaceInstructions,
  setActiveProfile,
  updateProfile,
} from "../components/settings/aiProfileOps";
import type { AiConnectionProfile, AiSettings } from "../services/aiProfiles";
import { validateAiConnectionProfile } from "../services/aiProfiles";

function makeProfile(name: string, id: string): AiConnectionProfile {
  return createBlankProfile(name, id);
}

function makeSettings(profiles: AiConnectionProfile[], activeProfileId?: string): AiSettings {
  return {
    profiles,
    activeProfileId: activeProfileId ?? profiles[0]?.id ?? "",
    instructions: [],
  };
}

describe("newProfileId：稳定随机 ID", () => {
  it("生成非空且互不相同的 id", () => {
    const a = newProfileId();
    const b = newProfileId();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("AI_PROFILE_PRESETS：预设只填端点，模型留空", () => {
  it("四个预设齐全，且 id 唯一", () => {
    expect(AI_PROFILE_PRESETS.map((p) => p.id)).toEqual(["blank", "ollama", "volc-anthropic", "volc-openai"]);
    const ids = new Set(AI_PROFILE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(AI_PROFILE_PRESETS.length);
  });

  it("Ollama 预设：本地端点 + openai-chat + authMode none", () => {
    const preset = findPreset("ollama")!;
    expect(preset.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(preset.protocol).toBe("openai-chat");
    expect(preset.authMode).toBe("none");
  });

  it("火山 Anthropic：/api/plan + anthropic-messages（不需要 /v1 后缀）", () => {
    const preset = findPreset("volc-anthropic")!;
    expect(preset.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan");
    expect(preset.protocol).toBe("anthropic-messages");
    expect(preset.authMode).toBe("required");
  });

  it("火山 OpenAI 兼容：/api/plan/v3 + openai-chat", () => {
    const preset = findPreset("volc-openai")!;
    expect(preset.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
    expect(preset.protocol).toBe("openai-chat");
  });

  it("【核心】所有预设创建出的档案 model 必须是空串（不硬编码未核实模型名）", () => {
    for (const preset of AI_PROFILE_PRESETS) {
      const profile = createProfileFromPreset(preset.id, "x", `id-${preset.id}`);
      expect(profile.model, preset.id).toBe("");
    }
  });

  it("findPreset：未知 id 返回 null，不静默回落到别的端点", () => {
    expect(findPreset("openai")).toBeNull();
    expect(findPreset("")).toBeNull();
  });
});

describe("createBlankProfile：默认值", () => {
  it("保守 token 预算 + credentialId 等于 id（凭据分槽前提）", () => {
    const profile = createBlankProfile("测试", "p-1");
    expect(profile).toMatchObject({
      id: "p-1",
      credentialId: "p-1",
      protocol: "openai-chat",
      authMode: "required",
      contextWindowTokens: 32768,
      maxOutputTokens: 4096,
    });
    // 空 URL/model 会报校验错误（这是预期：用户必须自己填）
    expect(validateAiConnectionProfile(profile)).toContain("profile.baseUrl.required");
    expect(validateAiConnectionProfile(profile)).toContain("profile.model.required");
  });

  it("【核心】temperature 与 reasoningEffort 默认 undefined（请求里不发送）", () => {
    const profile = createBlankProfile("x", "p-2");
    expect(profile.requestPolicy.temperature).toBeUndefined();
    expect(profile.requestPolicy.reasoningEffort).toBeUndefined();
    expect(profile.requestPolicy.tokenField).toBe("max_tokens");
    expect(profile.requestPolicy.includeStreamUsage).toBe(true);
  });

  it("systemPrompt 默认 undefined（不是空串）", () => {
    expect(createBlankProfile("x", "p-3").systemPrompt).toBeUndefined();
  });
});

describe("createProfileFromPreset", () => {
  it("Ollama：预填端点与 authMode none，模型留空", () => {
    const profile = createProfileFromPreset("ollama", "本地 Ollama", "p-ollama");
    expect(profile.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(profile.authMode).toBe("none");
    expect(profile.model).toBe("");
    expect(profile.name).toBe("本地 Ollama");
  });

  it("未知预设 id → 回落成空白档案（不抛错）", () => {
    const profile = createProfileFromPreset("nope", "自定义", "p-x");
    expect(profile.baseUrl).toBe("");
    expect(profile.model).toBe("");
  });
});

describe("duplicateProfile：复制必须换新 credentialId", () => {
  it("【核心】id 与 credentialId 同时换成新值（否则共用同一 keyring 槽位）", () => {
    const source = makeProfile("原档案", "orig");
    const copied = duplicateProfile(source, "原档案（副本）", "copy");
    expect(copied.id).toBe("copy");
    expect(copied.credentialId).toBe("copy");
    expect(copied.name).toBe("原档案（副本）");
    // 其余字段原样继承
    expect(copied.protocol).toBe(source.protocol);
    expect(copied.contextWindowTokens).toBe(source.contextWindowTokens);
  });

  it("requestPolicy 是浅拷贝（改副本不影响原档案）", () => {
    const source = makeProfile("a", "id-a");
    const copied = duplicateProfile(source, "b", "id-b");
    copied.requestPolicy.tokenField = "max_completion_tokens";
    expect(source.requestPolicy.tokenField).toBe("max_tokens");
  });

  it("复制后的档案 credentialId 校验通过（不吃 mismatch 错误）", () => {
    const copied = duplicateProfile(makeProfile("a", "id-a"), "b", "id-b");
    expect(validateAiConnectionProfile(copied)).not.toContain("profile.credentialId.mismatch");
  });
});

describe("appendProfile / updateProfile", () => {
  it("空配置首次新增时自动设为默认", () => {
    const next = appendProfile(makeSettings([]), makeProfile("a", "id-a"));
    expect(next.profiles).toHaveLength(1);
    expect(next.activeProfileId).toBe("id-a");
  });

  it("已有默认时追加不改变 activeProfileId", () => {
    const next = appendProfile(makeSettings([makeProfile("a", "id-a")]), makeProfile("b", "id-b"));
    expect(next.activeProfileId).toBe("id-a");
    expect(next.profiles).toHaveLength(2);
  });

  it("updateProfile 不允许改 id/credentialId（防止凭据槽位漂移）", () => {
    const settings = makeSettings([makeProfile("a", "id-a")]);
    const next = updateProfile(settings, "id-a", {
      name: "改名后",
      id: "hacked",
      credentialId: "hacked",
    });
    expect(next.profiles[0]!.name).toBe("改名后");
    expect(next.profiles[0]!.id).toBe("id-a");
    expect(next.profiles[0]!.credentialId).toBe("id-a");
  });

  it("updateProfile 对不存在的 id 不改动任何档案", () => {
    const settings = makeSettings([makeProfile("a", "id-a")]);
    const next = updateProfile(settings, "nope", { name: "x" });
    expect(next.profiles[0]!.name).toBe("a");
  });
});

describe("removeProfile：删除后修正默认档案", () => {
  it("删除非默认档案时 default 不变", () => {
    const settings = makeSettings([makeProfile("a", "id-a"), makeProfile("b", "id-b")], "id-a");
    const next = removeProfile(settings, "id-b");
    expect(next.profiles.map((p) => p.id)).toEqual(["id-a"]);
    expect(next.activeProfileId).toBe("id-a");
  });

  it("【核心】删除默认档案时选中原位置的下一项", () => {
    const settings = makeSettings(
      [makeProfile("a", "id-a"), makeProfile("b", "id-b"), makeProfile("c", "id-c")],
      "id-b",
    );
    const next = removeProfile(settings, "id-b");
    expect(next.profiles.map((p) => p.id)).toEqual(["id-a", "id-c"]);
    expect(next.activeProfileId).toBe("id-c");
  });

  it("删除末尾默认档案时回退到上一项", () => {
    const settings = makeSettings([makeProfile("a", "id-a"), makeProfile("b", "id-b")], "id-b");
    const next = removeProfile(settings, "id-b");
    expect(next.activeProfileId).toBe("id-a");
  });

  it("【核心】删到空列表时 activeProfileId 清空，不留悬空 id", () => {
    const settings = makeSettings([makeProfile("only", "id-only")], "id-only");
    const next = removeProfile(settings, "id-only");
    expect(next.profiles).toEqual([]);
    expect(next.activeProfileId).toBe("");
  });

  it("删除不存在的 id 原样返回（同一引用）", () => {
    const settings = makeSettings([makeProfile("a", "id-a")]);
    expect(removeProfile(settings, "nope")).toBe(settings);
  });
});

describe("setActiveProfile / moveProfile", () => {
  it("设为默认：id 存在才生效", () => {
    const settings = makeSettings([makeProfile("a", "id-a"), makeProfile("b", "id-b")], "id-a");
    expect(setActiveProfile(settings, "id-b").activeProfileId).toBe("id-b");
    // 不存在的 id 不产生悬空 activeProfileId
    expect(setActiveProfile(settings, "nope")).toBe(settings);
  });

  it("上移/下移：边界处原样返回", () => {
    const settings = makeSettings([makeProfile("a", "id-a"), makeProfile("b", "id-b")]);
    expect(moveProfile(settings, "id-a", -1)).toBe(settings);
    expect(moveProfile(settings, "id-b", 1)).toBe(settings);
  });

  it("上移/下移改变列表顺序但不改 activeProfileId", () => {
    const settings = makeSettings([makeProfile("a", "id-a"), makeProfile("b", "id-b")], "id-a");
    const moved = moveProfile(settings, "id-b", -1);
    expect(moved.profiles.map((p) => p.id)).toEqual(["id-b", "id-a"]);
    expect(moved.activeProfileId).toBe("id-a");
  });
});

describe("replaceInstructions / hasProfiles", () => {
  it("整表替换指令", () => {
    const settings = makeSettings([makeProfile("a", "id-a")]);
    const next = replaceInstructions(settings, [
      { id: "i1", name: "n", scope: "none", userTemplate: "t" },
    ]);
    expect(next.instructions).toHaveLength(1);
  });

  it("hasProfiles：null/空/有档案", () => {
    expect(hasProfiles(null)).toBe(false);
    expect(hasProfiles(undefined)).toBe(false);
    expect(hasProfiles(makeSettings([]))).toBe(false);
    expect(hasProfiles(makeSettings([makeProfile("a", "id-a")]))).toBe(true);
  });
});

describe("parseTemperatureInput：空 = 不发送", () => {
  it("【核心】空串是合法输入 → undefined（不是 0）", () => {
    expect(parseTemperatureInput("")).toEqual({ ok: true, value: undefined });
    expect(parseTemperatureInput("   ")).toEqual({ ok: true, value: undefined });
  });

  it("0 ~ 2 之间的数字接受", () => {
    expect(parseTemperatureInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseTemperatureInput("0.7")).toEqual({ ok: true, value: 0.7 });
    expect(parseTemperatureInput("2")).toEqual({ ok: true, value: 2 });
  });

  it("越界/非数字返回 ok:false（调用方不落库）", () => {
    expect(parseTemperatureInput("-0.1").ok).toBe(false);
    expect(parseTemperatureInput("2.1").ok).toBe(false);
    expect(parseTemperatureInput("abc").ok).toBe(false);
    expect(parseTemperatureInput("NaN").ok).toBe(false);
  });
});

describe("parsePositiveIntInput：中间态不落库", () => {
  it("正整数字符串接受", () => {
    expect(parsePositiveIntInput("32768")).toBe(32768);
    expect(parsePositiveIntInput("1")).toBe(1);
  });

  it("空串/小数/负数/前导非数字返回 null", () => {
    expect(parsePositiveIntInput("")).toBeNull();
    expect(parsePositiveIntInput("0")).toBeNull();
    expect(parsePositiveIntInput("-5")).toBeNull();
    expect(parsePositiveIntInput("3.5")).toBeNull();
    expect(parsePositiveIntInput("abc")).toBeNull();
    expect(parsePositiveIntInput("1e5")).toBeNull();
  });
});
