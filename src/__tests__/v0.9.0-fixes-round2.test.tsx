/**
 * v0.9.0 第二轮用户反馈修复（问题 1~5）的回归用例。
 *
 * 覆盖：
 * 1. **问题1 阅读位置被重置** —— `shouldEndRestoreWindowOnBoot` 必须让 legacy 模式的
 *    「会话恢复期」延后结束（否则刚注入的跨会话进度会被恢复流程自己清掉）。
 * 2. **问题2/4 主窗口标签/文件夹丢失** —— 前端启动流程改用 `pruneSecondarySessions`
 *    只裁辅助窗口条目、会话残缺时回退 legacy；主窗口状态保留由 Rust 侧单测覆盖
 *    （window::tests::snapshot_keeps_main_state_after_primary_closed）。
 * 3. **问题3 保存后误报「已被外部修改」** —— selfWriteGuard 内容指纹 + fileService
 *    写盘登记 + App 侧 fileChanged 分支接线。
 * 4. **问题5 设置项描述样式** —— 描述改为按钮后的小字号灰色提示（同一行）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── mocks（必须在 import 业务模块之前）───────────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  Channel: class {},
}));

import {
  noteSelfWrittenFile,
  isSelfWrittenContent,
  __resetSelfWriteGuardForTest,
  __selfWriteGuardSize,
  TTL_MS,
  MAX_ENTRIES,
} from "../services/selfWriteGuard";
import { fileService } from "../services/fileService";
import { windowService } from "../services/windowService";
import { decideStartupMode, shouldEndRestoreWindowOnBoot } from "../services/startupMode";
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { useSettingsStore } from "../stores/useSettingsStore";
import { _setCurrentLanguage } from "../i18n/state";
import { __setWindowLabelForTest } from "../utils/windowLabel";

const appSrc = readFileSync(resolve(__dirname, "../App.tsx"), "utf-8");
const settingsSrc = readFileSync(
  resolve(__dirname, "../components/dialogs/SettingsDialog.tsx"),
  "utf-8",
);
const settingsCss = readFileSync(
  resolve(__dirname, "../components/dialogs/SettingsDialog.css"),
  "utf-8",
);

function enterTauri(label = "main") {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
  };
}

function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

beforeEach(() => {
  invokeMock.mockReset();
  __resetSelfWriteGuardForTest();
  __setWindowLabelForTest(null);
});

afterEach(() => {
  cleanup();
  exitTauri();
  __setWindowLabelForTest(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ───────────────────────── 问题3：自身写盘指纹 ─────────────────────────

describe("v0.9.0 修复问题3：自身写盘内容指纹（selfWriteGuard）", () => {
  it("登记后：磁盘内容与写入内容一致 → 判定为自身回声", () => {
    noteSelfWrittenFile("D:/docs/a.md", "# 保存成功");
    expect(isSelfWrittenContent("D:/docs/a.md", "# 保存成功")).toBe(true);
  });

  it("磁盘内容不同（真实外部修改）→ 不判定为自身回声", () => {
    noteSelfWrittenFile("D:/docs/a.md", "# 我写的");
    expect(isSelfWrittenContent("D:/docs/a.md", "# 别人改的")).toBe(false);
  });

  it("路径分隔符 / Windows 大小写不敏感（事件路径 vs 标签路径）", () => {
    noteSelfWrittenFile("D:\\Docs\\A.MD", "x");
    expect(isSelfWrittenContent("d:/docs/a.md", "x")).toBe(true);
  });

  it("未登记过的路径 → false（外部修改必须照常上报）", () => {
    expect(isSelfWrittenContent("D:/never.md", "x")).toBe(false);
  });

  it(`超过 TTL（${TTL_MS}ms）后失效`, () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    noteSelfWrittenFile("D:/docs/a.md", "x");
    expect(isSelfWrittenContent("D:/docs/a.md", "x")).toBe(true);
    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    expect(isSelfWrittenContent("D:/docs/a.md", "x")).toBe(true); // 1s < TTL
    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1));
    expect(isSelfWrittenContent("D:/docs/a.md", "x")).toBe(false);
  });

  it(`条目数被限制在 ${MAX_ENTRIES} 条（LRU 淘汰最旧）`, () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      noteSelfWrittenFile(`D:/docs/f${i}.md`, `c${i}`);
    }
    expect(__selfWriteGuardSize()).toBeLessThanOrEqual(MAX_ENTRIES);
    // 最早写入的已被淘汰，最新的仍在
    expect(isSelfWrittenContent("D:/docs/f0.md", "c0")).toBe(false);
    expect(isSelfWrittenContent(`D:/docs/f${MAX_ENTRIES + 4}.md`, `c${MAX_ENTRIES + 4}`)).toBe(true);
  });

  it("空路径 / 非法内容不登记（防御异常调用）", () => {
    noteSelfWrittenFile("", "x");
    noteSelfWrittenFile("D:/docs/a.md", undefined as unknown as string);
    expect(__selfWriteGuardSize()).toBe(0);
    expect(isSelfWrittenContent("", "x")).toBe(false);
  });
});

describe("v0.9.0 修复问题3：fileService.writeFile 登记指纹", () => {
  it("写盘成功 → 登记指纹（供随后的 watcher 事件比对）", async () => {
    enterTauri("main");
    invokeMock.mockResolvedValue(undefined);
    await fileService.writeFile("D:/docs/a.md", "# hi");
    expect(invokeMock).toHaveBeenCalledWith("write_file", { path: "D:/docs/a.md", content: "# hi" });
    expect(isSelfWrittenContent("D:/docs/a.md", "# hi")).toBe(true);
  });

  it("写盘失败 → 不登记（避免掩盖真实的外部修改）", async () => {
    enterTauri("main");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue("boom");
    await expect(fileService.writeFile("D:/docs/a.md", "# hi")).rejects.toThrow();
    expect(isSelfWrittenContent("D:/docs/a.md", "# hi")).toBe(false);
    errSpy.mockRestore();
  });
});

describe("v0.9.0 修复问题3：App 的 fileChanged 分支接线", () => {
  it("脏标签分支先做自身写盘判定，再标记外部修改", () => {
    expect(appSrc).toContain("isSelfWrittenContent(path, fresh)");
    expect(appSrc).toContain("useEditorStore.getState().setTabExternallyChanged(idx2, true);");
    // 判定必须在 setTabExternallyChanged 之前（同一条分支内）
    const guardAt = appSrc.indexOf("if (isSelfWrittenContent(path, fresh)) return;");
    const markAt = appSrc.indexOf("setTabExternallyChanged(idx2, true)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(guardAt);
  });

  it("干净标签分支：内容一致时不再重载、不再弹「已自动重新载入」", () => {
    expect(appSrc).toContain("if (current && current.content === fresh) return;");
  });
});

// ───────────────────────── 问题1：阅读位置恢复期 ─────────────────────────

describe("v0.9.0 修复问题1：恢复期结束时机", () => {
  it("legacy 模式不在引导流程 finally 提前复位（交给最近文件恢复 effect）", () => {
    expect(shouldEndRestoreWindowOnBoot("legacy")).toBe(false);
  });

  it("session / skip / 未决定（异常路径）都必须复位，避免永久停在恢复期", () => {
    expect(shouldEndRestoreWindowOnBoot("session")).toBe(true);
    expect(shouldEndRestoreWindowOnBoot("skip")).toBe(true);
    expect(shouldEndRestoreWindowOnBoot(null)).toBe(true);
  });

  it("App 接线：用纯函数判定，且 legacy 的复位仍在恢复 effect 的 finally 里", () => {
    expect(appSrc).toContain("if (shouldEndRestoreWindowOnBoot(appliedMode)) {");
    expect(appSrc).toContain("sessionRestoringRef.current = false;");
    // 「最近文件恢复」里原有的一次复位保留（legacy 的收尾）
    expect(appSrc.match(/sessionRestoringRef\.current = false;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────── 问题2/4：会话恢复与裁剪 ─────────────────────────

describe("v0.9.0 修复问题2/4：主窗口会话恢复", () => {
  it("pruneSecondarySessions：Tauri 下调用 prune_session_secondaries", async () => {
    enterTauri("main");
    invokeMock.mockResolvedValue(undefined);
    await windowService.pruneSecondarySessions();
    expect(invokeMock).toHaveBeenCalledWith("prune_session_secondaries");
  });

  it("pruneSecondarySessions：非 Tauri 环境静默 no-op", async () => {
    await expect(windowService.pruneSecondarySessions()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pruneSecondarySessions：IPC 失败不影响启动流程", async () => {
    enterTauri("main");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("ipc down"));
    await expect(windowService.pruneSecondarySessions()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it("App 接线：关闭「恢复其他窗口」时只裁剪辅助窗口，不再整份丢弃会话", () => {
    expect(appSrc).toContain("await windowService.pruneSecondarySessions();");
    expect(appSrc).toContain("await windowService.restoreWindows();");
  });

  it("App 接线：会话快照缺主窗口条目时回退 legacy（不留下空白主窗口）", () => {
    expect(appSrc).toContain('effectiveMode = "legacy";');
    expect(appSrc).toContain("const session = await windowService.getWindowSession(boot.label);");
    // 回退后仍然置位一次启动模式，让 legacy 恢复 effect 真正跑起来
    expect(appSrc).toContain("setStartupMode(effectiveMode);");
  });

  it("启动模式纯函数语义不变（回归保护）", () => {
    expect(
      decideStartupMode({ isMain: true, bootRestore: false, restoreEnabled: true, hasSession: true }),
    ).toBe("session");
    expect(
      decideStartupMode({ isMain: true, bootRestore: false, restoreEnabled: true, hasSession: false }),
    ).toBe("legacy");
    expect(
      decideStartupMode({ isMain: true, bootRestore: false, restoreEnabled: false, hasSession: true }),
    ).toBe("skip");
    expect(
      decideStartupMode({ isMain: false, bootRestore: false, restoreEnabled: true, hasSession: true }),
    ).toBe("skip");
  });
});

// ───────────────────────── 问题5：设置项描述样式 ─────────────────────────

describe("v0.9.0 修复问题5：设置项功能描述样式", () => {
  beforeEach(() => {
    useSettingsStore.setState({ restoreOtherWindows: false, language: "zh-CN" });
    _setCurrentLanguage("zh-CN");
  });

  it("描述与开关按钮处于同一行容器（在按钮后面）", () => {
    render(<SettingsDialog onClose={() => {}} />);
    const hint = screen.getByText("开启后，上次退出时仍打开的辅助窗口会一并恢复；已在退出前手动关闭的窗口不会恢复");
    expect(hint.className).toContain("settings-hint-inline");
    const row = hint.closest(".settings-switch-row");
    expect(row).not.toBeNull();
    // 同一行里同时包含开关按钮
    expect(row?.querySelector(".settings-switch")).not.toBeNull();
    expect(row?.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it("CSS：小字号 + 灰色 + 与按钮同排（flex 行）", () => {
    expect(settingsCss).toContain(".settings-switch-row");
    expect(settingsCss).toContain(".settings-hint-inline");
    const block = settingsCss.slice(settingsCss.indexOf(".settings-hint-inline"));
    expect(block).toContain("font-size: 12px");
    expect(block).toContain("color: var(--text-secondary");
    // 行容器用 flex 把描述排在按钮右边
    const rowBlock = settingsCss.slice(settingsCss.indexOf(".settings-switch-row"));
    expect(rowBlock.slice(0, 200)).toContain("display: flex");
  });

  it("源码接线：描述 span 带两个 class 且位于 switch-row 内", () => {
    expect(settingsSrc).toContain('className="settings-hint settings-hint-inline"');
    expect(settingsSrc).toContain('className="settings-switch-row"');
  });
});
