/**
 * v0.14.0 需求1：更新服务纯函数测试（node 环境，无 DOM）
 *
 * 覆盖：
 * 1. compareVersions 与 Rust 侧 is_newer_version 同一套语义
 *    - 0.9.0 vs 0.14.0（字典序会误判的经典用例）
 *    - 相等 / patch 递增 / `v` 前缀 / 预发布后缀 / 段数不同
 * 2. pickInstallerAsset 优先级：x64-setup.exe > setup.exe > .msi > 无
 * 3. v0.14.0 修复：parseUpdateFailure —— 网络层失败 vs 业务失败的分层解析
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// updateService 顶层 import 了 @tauri-apps/api/core 与 fileService（后者会拉进
// zustand store / localStorage 等浏览器侧依赖），纯函数测试里全部替换为轻量桩。
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  /** 是否把当前环境伪装成 Tauri（checkForUpdate 的前置判定） */
  tauri: { value: false },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("../services/fileService", () => ({ isTauri: () => mocks.tauri.value }));

import {
  compareVersions,
  pickInstallerAsset,
  parseUpdateFailure,
  checkForUpdate,
  UpdateNetworkError,
  UPDATE_NETWORK_ERROR_CODE,
} from "../services/updateService";

describe("v0.14.0 compareVersions：版本比较（与 Rust 侧同语义）", () => {
  it("0.9.0 vs 0.14.0：按数字段比较，不是字符串字典序", () => {
    // 字符串比较下 "0.9.0" > "0.14.0"，但版本语义相反
    expect(compareVersions("0.9.0", "0.14.0")).toBe(-1);
    expect(compareVersions("0.14.0", "0.9.0")).toBe(1);
  });

  it("0.14.0 vs 0.14.0：相等返回 0", () => {
    expect(compareVersions("0.14.0", "0.14.0")).toBe(0);
  });

  it("0.14.0 vs 0.14.1：patch 递增 → -1", () => {
    expect(compareVersions("0.14.0", "0.14.1")).toBe(-1);
    expect(compareVersions("0.14.1", "0.14.0")).toBe(1);
  });

  it("v 前缀不影响比较", () => {
    expect(compareVersions("v0.14.0", "0.14.0")).toBe(0);
    expect(compareVersions("0.14.0", "v0.15.0")).toBe(-1);
    expect(compareVersions("V1.0.0", "v0.9.9")).toBe(1);
  });

  it("0.14.0-beta：数字段仍是 0.14.0，与 0.14.0 相等", () => {
    expect(compareVersions("0.14.0", "0.14.0-beta")).toBe(0);
    expect(compareVersions("0.14.0-beta", "0.14.0")).toBe(0);
    // 0.14.1-beta 的数字段 0.14.1 > 0.14.0
    expect(compareVersions("0.14.0", "0.14.1-beta")).toBe(-1);
  });

  it("段数不同：缺的段按 0 补齐", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0", "1.1")).toBe(-1);
    expect(compareVersions("2", "1.9.9")).toBe(1);
  });

  it("major 升级", () => {
    expect(compareVersions("0.99.99", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });

  it("异常输入不抛错（空串 / 非数字段按 0 处理）", () => {
    expect(compareVersions("", "")).toBe(0);
    expect(compareVersions("", "0.0.1")).toBe(-1);
    expect(compareVersions("abc", "0.0.0")).toBe(0);
    expect(compareVersions("abc", "0.0.1")).toBe(-1);
  });
});

describe("v0.14.0 pickInstallerAsset：安装包优先级", () => {
  const asset = (name: string, url = `https://example.com/${name}`, size = 100) => ({
    name,
    url,
    size,
  });

  it("优先 x64-setup.exe（NSIS）", () => {
    const picked = pickInstallerAsset([
      asset("LightMD_0.15.0_x64_en-US.msi"),
      asset("LightMD_0.15.0_x64-setup.exe"),
    ]);
    expect(picked?.name).toBe("LightMD_0.15.0_x64-setup.exe");
  });

  it("没有 x64-setup 时退到通用 setup.exe，再退到 .msi", () => {
    expect(
      pickInstallerAsset([asset("LightMD_0.15.0_setup.exe"), asset("LightMD_0.15.0_x64_en-US.msi")])
        ?.name,
    ).toBe("LightMD_0.15.0_setup.exe");

    expect(
      pickInstallerAsset([asset("LightMD_0.15.0_x64_en-US.msi"), asset("SHA256SUMS.txt")])?.name,
    ).toBe("LightMD_0.15.0_x64_en-US.msi");
  });

  it("都没有可用安装包 → null", () => {
    expect(pickInstallerAsset([asset("SHA256SUMS.txt"), asset("source.zip")])).toBeNull();
    expect(pickInstallerAsset([])).toBeNull();
  });

  it("忽略缺 url 的 asset", () => {
    expect(pickInstallerAsset([{ name: "LightMD_x64-setup.exe", url: "", size: 0 }])).toBeNull();
  });

  it("排除签名/校验文件（xxx-setup.exe.sig 名里也含 setup.exe）", () => {
    const picked = pickInstallerAsset([
      asset("LightMD_0.15.0_x64-setup.exe.sig"),
      asset("SHA256SUMS.txt"),
      asset("LightMD_0.15.0_x64-setup.exe"),
    ]);
    expect(picked?.name).toBe("LightMD_0.15.0_x64-setup.exe");
    // 只有签名/校验文件时不应选中任何东西
    expect(
      pickInstallerAsset([asset("LightMD_0.15.0_x64-setup.exe.sig"), asset("SHA256SUMS.txt")]),
    ).toBeNull();
  });
});

// ─── v0.14.0 需求1 修复：网络层失败 vs 业务失败 ────────────────────────

/** 与 Rust update.rs 的 network_failure_message 同形的错误串 */
const netMsg = (scope: "check" | "download", detail: string) =>
  `${UPDATE_NETWORK_ERROR_CODE}|${scope}|${detail}`;

describe("v0.14.0 修复：parseUpdateFailure 错误分层", () => {
  it("错误码常量与 Rust 侧逐字一致（跨语言契约）", () => {
    // 改动任何一侧都会让这里或 Rust 的 network_code_constant_matches_frontend_contract 失败
    expect(UPDATE_NETWORK_ERROR_CODE).toBe("LIGHTMD_UPDATE_NETWORK");
  });

  it("网络码 + check → kind=network, scope=check", () => {
    const f = parseUpdateFailure(netMsg("check", "error sending request for url (x)"));
    expect(f.kind).toBe("network");
    expect(f.scope).toBe("check");
    expect(f.detail).toBe("error sending request for url (x)");
  });

  it("网络码 + download → kind=network, scope=download", () => {
    const f = parseUpdateFailure(netMsg("download", "connection reset by peer"));
    expect(f.kind).toBe("network");
    expect(f.scope).toBe("download");
    expect(f.detail).toBe("connection reset by peer");
  });

  it("Error 实例包装的网络码同样能识别（Tauri 有时以 Error 抛出）", () => {
    const f = parseUpdateFailure(new Error(netMsg("check", "dns error")));
    expect(f.kind).toBe("network");
    expect(f.detail).toBe("dns error");
  });

  it("业务错误（HTTP 403/404、解析失败、缺 tag_name、非 Tauri 提示）→ kind=server", () => {
    const cases = [
      "GitHub 返回 HTTP 403（GitHub API 访问受限，可能触发了速率限制，请稍后再试）",
      "GitHub 返回 HTTP 404（未找到发布版本，仓库可能尚未发布 release）",
      "解析 GitHub 发布信息失败：expected value at line 1 column 1",
      "未找到有效的版本号（release 缺少 tag_name）",
      "当前环境不支持检查更新（请使用 LightMD 桌面客户端）",
      "下载安装包失败：下载服务器返回 HTTP 500",
    ];
    for (const msg of cases) {
      const f = parseUpdateFailure(msg);
      expect(f.kind, `应判为业务失败: ${msg}`).toBe("server");
      expect(f.detail).toBe(msg);
    }
  });

  it("形似但不符合契约的串不会被误判为网络层", () => {
    const notNetwork = [
      // 只有码没有分隔符
      UPDATE_NETWORK_ERROR_CODE,
      // 前缀不匹配（前面多了字符）
      `X${UPDATE_NETWORK_ERROR_CODE}|check|x`,
      // 小写变体
      "lightmd_update_network|check|x",
      // 空串 / 非字符串
      "",
    ];
    for (const msg of notNetwork) {
      expect(parseUpdateFailure(msg).kind, `不应判为网络层: ${msg}`).toBe("server");
    }
    expect(parseUpdateFailure(null).kind).toBe("server");
    expect(parseUpdateFailure(undefined).kind).toBe("server");
    expect(parseUpdateFailure({ foo: 1 }).kind).toBe("server");
  });

  it("作用域缺失/非法 → 回落 check（保守：重试=重新检查）", () => {
    expect(parseUpdateFailure(`${UPDATE_NETWORK_ERROR_CODE}|check`).scope).toBe("check");
    expect(parseUpdateFailure(`${UPDATE_NETWORK_ERROR_CODE}|weird|x`).scope).toBe("check");
    expect(parseUpdateFailure(`${UPDATE_NETWORK_ERROR_CODE}|`).scope).toBe("check");
  });
});

describe("v0.14.0 修复：checkForUpdate 抛出 UpdateNetworkError", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.tauri.value = true;
  });

  it("网络码 → 抛 UpdateNetworkError（带 scope），不是普通 Error", async () => {
    mocks.invoke.mockRejectedValue(netMsg("check", "error sending request for url (x)"));
    await expect(checkForUpdate("0.14.0")).rejects.toBeInstanceOf(UpdateNetworkError);
    try {
      await checkForUpdate("0.14.0");
    } catch (e) {
      const err = e as UpdateNetworkError;
      expect(err.scope).toBe("check");
      expect(err.detail).toContain("error sending request");
    }
  });

  it("业务错误 → 抛普通 Error（保留可读文案，便于 UI 套 failed 模板）", async () => {
    mocks.invoke.mockRejectedValue("GitHub 返回 HTTP 404（未找到发布版本，仓库可能尚未发布 release）");
    let caught: unknown = null;
    try {
      await checkForUpdate("0.14.0");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpdateNetworkError);
    expect((caught as Error).message).toContain("HTTP 404");
  });

  it("成功路径不受影响：返回后端结果", async () => {
    const info = { version: "0.14.0", current: "0.14.0", isNewer: false };
    mocks.invoke.mockResolvedValue(info);
    await expect(checkForUpdate("0.14.0")).resolves.toEqual(info);
  });
});
