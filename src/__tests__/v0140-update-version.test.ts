/**
 * v0.14.0 需求1：更新服务纯函数测试（node 环境，无 DOM）
 *
 * 覆盖：
 * 1. compareVersions 与 Rust 侧 is_newer_version 同一套语义
 *    - 0.9.0 vs 0.14.0（字典序会误判的经典用例）
 *    - 相等 / patch 递增 / `v` 前缀 / 预发布后缀 / 段数不同
 * 2. pickInstallerAsset 优先级：x64-setup.exe > setup.exe > .msi > 无
 */
import { describe, it, expect, vi } from "vitest";

// updateService 顶层 import 了 @tauri-apps/api/core 与 fileService（后者会拉进
// zustand store / localStorage 等浏览器侧依赖），纯函数测试里全部替换为轻量桩。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../services/fileService", () => ({ isTauri: () => false }));

import { compareVersions, pickInstallerAsset } from "../services/updateService";

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
