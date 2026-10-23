/**
 * v0.14.0 需求1：设置面板「软件更新」区 UI 测试（jsdom）
 *
 * 覆盖完整交互链路（IPC 全部打桩，不触网）：
 * 1. 点「检查更新」→ 后端返回无新版 → 显示「已是最新版本 v{version}」
 * 2. 有新版 → 显示版本号 + 下载按钮 + 更新说明
 * 3. 点「下载并安装」→ 模拟 Rust 发进度事件 → 进度条更新 → 完成文案
 * 4. 检查失败 → 错误文案 + 重试按钮；重试成功后恢复正常
 * 5. 「软件更新」section 位于「关于 LightMD」之后（用户要求放在设置里最后）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

// ─── mocks（必须在 import 组件之前注册） ─────────────────────
const mocks = vi.hoisted(() => {
  return {
    invoke: vi.fn(),
    /** 保存 listen 注册的回调，测试里手动模拟 Rust emit 进度事件 */
    listenHandlers: [] as Array<(event: { payload: { downloaded: number; total: number } }) => void>,
    listen: vi.fn(async (_name: string, handler: (e: any) => void) => {
      mocks.listenHandlers.push(handler);
      return () => {};
    }),
    openExternal: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  Channel: class {
    onmessage: ((c: string) => void) | null = null;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mocks.listen(...(args as [string, (e: any) => void])),
  emit: vi.fn(),
  once: vi.fn(),
}));

// 视为 Tauri 环境（updateService 用 isTauri() 做前置判定）
vi.mock("../services/fileService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/fileService")>();
  return { ...orig, isTauri: () => true };
});

vi.mock("../utils/openExternal", () => ({
  openExternalHref: mocks.openExternal,
}));

/**
 * i18n 不设桩：直接用真实字典（Lead 已在 zh-CN / en-US 补齐 13 个
 * settings.update.* 键）。这样本用例同时充当「i18n key 齐全」的回归——
 * 缺键时 t() 会回退成 key 本身，断言立刻失败。
 */
import { SettingsDialog } from "../components/dialogs/SettingsDialog";
import { t } from "../i18n/state";
import { zhCN } from "../i18n/locales/zh-CN";
import { enUS } from "../i18n/locales/en-US";
import pkg from "../../package.json";

/** 文案断言统一走 t()：与组件渲染出的字符串同源 */
const L = {
  update: t("settings.update"),
  check: t("settings.update.check"),
  notes: t("settings.update.notes"),
  downloaded: t("settings.update.downloaded"),
  failed: (msg: string) => t("settings.update.failed", { msg }),
  upToDate: (version: string) => t("settings.update.upToDate", { version }),
  available: (version: string, current: string) =>
    t("settings.update.available", { version, current }),
};

/** 构造一次「有新版本」的 check_update 返回值（字段与 Rust UpdateInfo 一致，camelCase） */
function makeUpdateInfo(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.15.0",
    current: pkg.version,
    isNewer: true,
    notes: "## 更新内容\n- 新增检查更新\n- 修复若干问题",
    htmlUrl: "https://github.com/badwoo/LightMD/releases/tag/v0.15.0",
    assetName: "LightMD_0.15.0_x64-setup.exe",
    assetUrl: "https://github.com/badwoo/LightMD/releases/download/v0.15.0/LightMD_0.15.0_x64-setup.exe",
    assetSize: 12_345_678,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listen.mockClear();
  mocks.listenHandlers.length = 0;
  mocks.openExternal.mockReset();
  // 默认桩：翻译 Key 探测 / 其余未知命令返回 undefined
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "has_translate_key") return false;
    return undefined;
  });
});

afterEach(cleanup);

describe("v0.14.0 需求1：设置里「软件更新」区", () => {
  it("渲染在「关于 LightMD」之后（设置里最后一块）", () => {
    render(<SettingsDialog onClose={() => {}} />);
    const about = screen.getByText("关于 LightMD");
    const update = screen.getByTestId("settings-update-section");
    // compareDocumentPosition: 2 = FOLLOWING（update 在 about 之后）
    expect(about.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 且是弹窗内最后一个 settings-section
    const sections = document.querySelectorAll(".settings-section");
    expect(sections[sections.length - 1]).toBe(update);
  });

  it("点「检查更新」→ 已是最新版本 → 显示版本号文案", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update") return makeUpdateInfo({ isNewer: false, version: pkg.version });
      return undefined;
    });
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));
    const upToDate = await screen.findByTestId("update-uptodate");
    expect(upToDate.textContent).toContain(pkg.version);
    // 调用参数：命令名 + camelCase 的 currentVersion
    expect(mocks.invoke).toHaveBeenCalledWith("check_update", { currentVersion: pkg.version });
    // 没有下载按钮
    expect(screen.queryByTestId("update-download-btn")).toBeNull();
  });

  it("线上最新 tag 比当前版本旧（开发构建/未发布版本）→ 已是最新，且显示**当前**版本", async () => {
    // 实况：GitHub 最新 release 可能落后于本地构建（例如本地 0.14.0、线上 0.13.2）。
    // 此时 Rust 的 is_newer 为 false，UI 不应显示「已是最新版本 v0.13.2」造成困惑。
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update")
        return makeUpdateInfo({ isNewer: false, version: "0.13.2", current: pkg.version });
      return undefined;
    });
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));

    const upToDate = await screen.findByTestId("update-uptodate");
    expect(upToDate.textContent).toContain(pkg.version);
    expect(upToDate.textContent).not.toContain("0.13.2");
  });

  it("i18n：zh-CN / en-US 均有 13 个 settings.update.* 键，且占位符一致", () => {
    const keys = [
      "settings.update",
      "settings.update.check",
      "settings.update.checking",
      "settings.update.upToDate",
      "settings.update.available",
      "settings.update.download",
      "settings.update.downloading",
      "settings.update.downloaded",
      "settings.update.failed",
      "settings.update.noAsset",
      "settings.update.retry",
      "settings.update.notes",
      "settings.update.openRelease",
    ] as const;
    for (const key of keys) {
      expect(zhCN[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}`).toBeTruthy();
      // 占位符必须中英一致，否则某语言会残留 {version}/{msg} 字面量
      const ph = (s: string) => (s.match(/\{[a-zA-Z_]+\}/g) ?? []).sort().join(",");
      expect(ph(zhCN[key]), `占位符不一致: ${key}`).toBe(ph(enUS[key]));
    }
    // 关键占位符存在
    expect(zhCN["settings.update.upToDate"]).toContain("{version}");
    expect(zhCN["settings.update.available"]).toContain("{version}");
    expect(zhCN["settings.update.available"]).toContain("{current}");
    expect(zhCN["settings.update.downloading"]).toContain("{percent}");
    expect(zhCN["settings.update.failed"]).toContain("{msg}");
  });

  it("有新版 → 显示新版本号 + 下载按钮 + 更新说明", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update") return makeUpdateInfo();
      return undefined;
    });
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));

    const result = await screen.findByTestId("update-available");
    expect(result.textContent).toContain("0.15.0");
    expect(result.textContent).toContain(pkg.version);
    expect(screen.getByTestId("update-download-btn")).toBeTruthy();
    // 更新说明折叠区（<details> + pre-wrap 样式在 CSS 里）
    expect(result.textContent).toContain(L.notes);
  });

  it("点下载 → 进度事件更新进度条 → 下载完成文案", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update") return makeUpdateInfo();
      if (cmd === "download_update") {
        // 模拟 Rust 侧边下边发进度事件（与 update.rs 的 lightmd://update-progress 一致）
        for (const [downloaded, total] of [
          [1024, 4096],
          [2048, 4096],
          [4096, 4096],
        ]) {
          act(() => {
            mocks.listenHandlers.forEach((h) => h({ payload: { downloaded, total } }));
          });
        }
        return "C:\\Users\\me\\AppData\\Local\\com.lightmd.app\\cache\\updates\\LightMD_0.15.0_x64-setup.exe";
      }
      if (cmd === "launch_installer") return undefined;
      return undefined;
    });

    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));
    const downloadBtn = await screen.findByTestId("update-download-btn");
    fireEvent.click(downloadBtn);

    const downloaded = await screen.findByTestId("update-downloaded");
    expect(downloaded.textContent).toContain(L.downloaded);
    // download_update 收到 camelCase 参数
    expect(mocks.invoke).toHaveBeenCalledWith("download_update", {
      assetUrl: "https://github.com/badwoo/LightMD/releases/download/v0.15.0/LightMD_0.15.0_x64-setup.exe",
      assetName: "LightMD_0.15.0_x64-setup.exe",
    });
    // 下载完成后自动调用 launch_installer 启动安装向导
    expect(mocks.invoke).toHaveBeenCalledWith("launch_installer", {
      path: "C:\\Users\\me\\AppData\\Local\\com.lightmd.app\\cache\\updates\\LightMD_0.15.0_x64-setup.exe",
    });
  });

  it("下载过程中进度条按事件更新（role=progressbar + aria-valuenow）", async () => {
    // download_update 挂起：让进度事件在「下载中」阶段被断言
    let resolveDownload: ((v: string) => void) | null = null;
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update") return makeUpdateInfo();
      if (cmd === "download_update") {
        return new Promise<string>((resolve) => {
          resolveDownload = resolve;
        });
      }
      return undefined;
    });

    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));
    fireEvent.click(await screen.findByTestId("update-download-btn"));

    const progress = await screen.findByTestId("update-progress");
    expect(progress.getAttribute("role")).toBe("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("0");

    act(() => {
      mocks.listenHandlers.forEach((h) => h({ payload: { downloaded: 50, total: 100 } }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("update-progress").getAttribute("aria-valuenow")).toBe("50");
    });
    expect(screen.getByTestId("update-progress").textContent).toContain("50");

    // 收尾：让下载完成，避免悬挂 Promise 影响 cleanup
    await act(async () => {
      resolveDownload?.("C:\\tmp\\LightMD_0.15.0_x64-setup.exe");
    });
  });

  it("检查失败 → 错误文案 + 重试按钮；重试成功后显示结果", async () => {
    let call = 0;
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update") {
        call += 1;
        if (call === 1) throw "无法连接 GitHub（请检查网络或代理）：连接超时";
        return makeUpdateInfo({ isNewer: false, version: pkg.version });
      }
      return undefined;
    });

    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));

    const error = await screen.findByTestId("update-error");
    expect(error.textContent).toContain(L.failed(""));
    expect(error.textContent).toContain("连接超时");
    const retry = screen.getByTestId("update-retry-btn");
    expect(retry).toBeTruthy();

    // 重试 → 这次成功
    fireEvent.click(retry);
    expect(await screen.findByTestId("update-uptodate")).toBeTruthy();
    expect(screen.queryByTestId("update-error")).toBeNull();
  });

  it("下载失败 → 显示下载错误（不重复套「检查更新失败」前缀）+ 重试可重新下载", async () => {
    let downloadCalls = 0;
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update") return makeUpdateInfo();
      if (cmd === "download_update") {
        downloadCalls += 1;
        if (downloadCalls === 1) throw "下载安装包失败：下载服务器返回 HTTP 404";
        return "C:\\tmp\\LightMD_0.15.0_x64-setup.exe";
      }
      if (cmd === "launch_installer") return undefined;
      return undefined;
    });

    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));
    fireEvent.click(await screen.findByTestId("update-download-btn"));

    const error = await screen.findByTestId("update-error");
    expect(error.textContent).toContain("下载安装包失败");
    expect(error.textContent).not.toContain("检查更新失败");

    // 重试 → 走重新下载（不是重新检查）
    fireEvent.click(screen.getByTestId("update-retry-btn"));
    expect(await screen.findByTestId("update-downloaded")).toBeTruthy();
    expect(downloadCalls).toBe(2);
  });

  it("有新版但没有可用安装包 → 提示 noAsset，仍给发布页入口", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "has_translate_key") return false;
      if (cmd === "check_update")
        return makeUpdateInfo({ assetName: "", assetUrl: "", assetSize: 0 });
      return undefined;
    });
    render(<SettingsDialog onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("update-check-btn"));

    expect(await screen.findByTestId("update-no-asset")).toBeTruthy();
    expect(screen.queryByTestId("update-download-btn")).toBeNull();
    const releaseBtn = screen.getByTestId("update-open-release-btn");
    fireEvent.click(releaseBtn);
    expect(mocks.openExternal).toHaveBeenCalledWith(
      "https://github.com/badwoo/LightMD/releases/tag/v0.15.0",
    );
  });
});
