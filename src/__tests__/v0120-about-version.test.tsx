/**
 * v0.12.0 需求8：设置底部「关于 LightMD」测试
 *
 * 覆盖：
 * 1. i18n 中英两语言均含关于 section key
 * 2. 渲染设置弹窗：底部显示「关于 LightMD」+ 版本号 = package.json version
 *    （同时验证 vite define 注入 __APP_VERSION__ 在测试环境可用）
 * 3. 点击 GitHub 链接：preventDefault 并经 openExternalHref 外部打开
 * 4. vite.config.ts 编译期 define 注入存在
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// ─── mocks（必须在 import 组件之前） ───────────────────────
const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));

vi.mock("../utils/openExternal", () => ({
  openExternalHref: mockOpen,
}));

vi.mock("../services/translateService", () => ({
  translateService: {
    setKey: vi.fn(),
    hasKey: vi.fn().mockResolvedValue(false),
    testConnection: vi.fn(),
    listModels: vi.fn(),
  },
}));

import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";
import pkg from "../../package.json";

afterEach(cleanup);

describe("v0.12.0 需求8：关于 LightMD", () => {
  it("i18n 中英两语言均含关于 section 的 key", () => {
    expect(zhCN["settings.about"]).toBe("关于 LightMD");
    expect(zhCN["settings.about.version"]).toContain("{version}");
    expect(enUS["settings.about"]).toBe("About LightMD");
    expect(enUS["settings.about.version"]).toContain("{version}");
  });

  it("渲染设置弹窗：底部显示「关于 LightMD」+ 版本号与 package.json 一致", () => {
    render(<SettingsDialog onClose={() => {}} />);
    expect(screen.getByText("关于 LightMD")).toBeTruthy();
    expect(screen.getByText(`版本 ${pkg.version}`)).toBeTruthy();
  });

  it("点击 GitHub 链接：preventDefault 并经 openExternalHref 打开", () => {
    render(<SettingsDialog onClose={() => {}} />);
    const link = screen.getByRole("link", {
      name: "https://github.com/badwoo/LightMD",
    }) as HTMLAnchorElement;
    fireEvent.click(link);
    expect(mockOpen).toHaveBeenCalledWith("https://github.com/badwoo/LightMD");
  });

  it("vite.config.ts 编译期注入 __APP_VERSION__（define，来源 package.json）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("vite.config.ts", "utf-8");
    expect(src).toContain("__APP_VERSION__");
    expect(src).toContain('JSON.stringify(pkg.version)');
  });
});