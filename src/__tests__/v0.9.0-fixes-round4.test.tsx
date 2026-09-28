/**
 * v0.9.0 第四轮用户反馈（多窗口继续优化）的回归用例。
 *
 * 覆盖：
 * 1. **同文件多窗口保存后刷新** —— Rust 侧自身写入抑制从「进程全局」收窄为
 *    「按写入窗口」并在事件里带 `source`；写入窗口据此忽略回声，其他窗口照常
 *    重载（根因单测见 open_files::tests::other_window_is_not_suppressed_after_peer_saves）。
 * 2. **标签拖到主窗口标签栏 → 询问合并** —— `merge_tab_drop_target` 用全局光标
 *    坐标判定落点；TabBar 拖出后交由 App 分流（主窗口 → 合并询问，否则移动到新窗口）。
 * 3. **Ctrl+Q 退出后不恢复其他窗口** —— `quit_app` 写「仅主窗口」快照并置位
 *    `quit_action`，`finalize_session` 不再用存活窗口快照覆盖它；退出前冲刷本窗口状态。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── mocks（必须在 import 业务模块之前）───────────────────────
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  Channel: class {},
}));

import { TabBar } from "../components/layout/TabBar";
import { useEditorStore, type TabInfo } from "../stores/useEditorStore";
import { windowService } from "../services/windowService";
import { __setWindowLabelForTest } from "../utils/windowLabel";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, rel), "utf-8").replace(/\r\n/g, "\n");

const appSrc = read("../App.tsx");
const tabbarSrc = read("../components/layout/TabBar.tsx");
const windowServiceSrc = read("../services/windowService.ts");
const openFilesRs = read("../../src-tauri/src/window/open_files.rs");
const fileOpsRs = read("../../src-tauri/src/commands/file_ops.rs");
const windowCmdsRs = read("../../src-tauri/src/commands/window_cmds.rs");
const libRs = read("../../src-tauri/src/lib.rs");
const modRs = read("../../src-tauri/src/window/mod.rs");

function enterTauri(label = "sec-1") {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label } },
  };
}

function exitTauri() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  invokeMock.mockReset();
  __setWindowLabelForTest(null);
});

afterEach(() => {
  cleanup();
  useEditorStore.setState({ openTabs: [], activeTabIdx: 0 });
  exitTauri();
  vi.restoreAllMocks();
});

const TABS: TabInfo[] = [
  { path: "/a.md", name: "a.md", content: "A" },
  { path: "/b.md", name: "b.md", content: "B" },
];

/** 拖出标签栏（jsdom 矩形全 0 → 落点必然在标签栏外） */
function dragTabOutside(container: HTMLElement, idx = 0) {
  const item = container.querySelectorAll(".tab-item")[idx] as HTMLElement;
  fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 10 });
  fireEvent.mouseMove(document, { clientX: 300, clientY: 300 });
  fireEvent.mouseUp(document, { clientX: 400, clientY: 500 });
}

// ───────────────── 需求1：同文件多窗口，保存后其他窗口立即刷新 ─────────────────

describe("需求1：跨窗口保存后同文件标签立即刷新", () => {
  it("write_file 带上调用者窗口 label（抑制按窗口而非全局）", () => {
    expect(fileOpsRs).toContain("window: tauri::WebviewWindow");
    expect(fileOpsRs).toContain("note_file_written(&path.to_string_lossy(), window.label())");
  });

  it("Rust：事件载荷带 source（写入窗口列表），其他窗口照常收到", () => {
    expect(openFilesRs).toContain('"source": source');
    expect(openFilesRs).toContain("let writers = recent_writers(&path_owned);");
    // 不再有任何「全局吞掉事件」的分支
    expect(openFilesRs).not.toContain("is_recent_self_write");
    expect(openFilesRs).toContain("fn recent_writers_at");
  });

  it("前端：事件 source 含本窗口 → 视为自身回声直接忽略", () => {
    expect(appSrc).toContain("source?: string[]");
    expect(appSrc).toContain(
      "if (!removed && Array.isArray(source) && source.includes(getWindowLabel())) return;",
    );
  });
});

// ───────────────── 需求2：标签拖到主窗口标签栏 → 询问合并 ─────────────────

describe("需求2：标签拖到主窗口标签栏 → 是否合并回主窗口", () => {
  it("TabBar：提供 onTabDropOutside 时拖出交由它处理（不再直接建新窗口）", () => {
    useEditorStore.setState({ openTabs: TABS, activeTabIdx: 0 });
    const onDropOutside = vi.fn();
    const onMove = vi.fn();
    const { container } = render(
      <TabBar onTabDropOutside={onDropOutside} onMoveToNewWindow={onMove} />,
    );
    dragTabOutside(container, 1);
    expect(onDropOutside).toHaveBeenCalledTimes(1);
    const [tab, idx] = onDropOutside.mock.calls[0];
    expect(tab.name).toBe("b.md");
    expect(idx).toBe(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("TabBar：未提供 onTabDropOutside 时维持「移动到新窗口」（第三轮行为不变）", () => {
    useEditorStore.setState({ openTabs: TABS, activeTabIdx: 0 });
    const onMove = vi.fn();
    const { container } = render(<TabBar onMoveToNewWindow={onMove} />);
    dragTabOutside(container, 0);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].name).toBe("a.md");
  });

  it("App：落点为主窗口标签栏 → 询问「合并回主窗口」，确认后走合并流程", () => {
    expect(appSrc).toContain("const target = await windowService.mergeTabDropTarget();");
    expect(appSrc).toContain("if (target?.isPrimary) {");
    // 确认后才合并；否则回退到「移动到新窗口」
    expect(appSrc).toContain("await handleMergeToPrimary();");
    expect(appSrc).toContain("await handleMoveTabToNewWindow(tab, idx);");
    // 对话框类型复用 mergeOffer
    expect(appSrc).toContain('onTabDropOutside={handleTabDropOutsideTabBar}');
  });

  it("windowService：命中检测走 merge_tab_drop_target，非 Tauri 返回 null", async () => {
    expect(windowServiceSrc).toContain('invoke<MergeDropTarget | null>("merge_tab_drop_target")');
    await expect(windowService.mergeTabDropTarget()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    enterTauri("sec-1");
    invokeMock.mockResolvedValue({ label: "main", isPrimary: true });
    await expect(windowService.mergeTabDropTarget()).resolves.toEqual({
      label: "main",
      isPrimary: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("merge_tab_drop_target");
  });

  it("Rust：命令已实现并注册（光标坐标 + 几何命中）", () => {
    expect(windowCmdsRs).toContain("pub fn merge_tab_drop_target(");
    expect(libRs).toContain("window_cmds::merge_tab_drop_target,");
    const mergeRs = read("../../src-tauri/src/window/merge_detect.rs");
    expect(mergeRs).toContain("pub fn tab_strip_target(");
    expect(mergeRs).toContain("caller.cursor_position()");
    expect(mergeRs).toContain("pub fn point_in_tab_strip(");
  });
});

// ───────────────── 需求3：Ctrl+Q 退出后不恢复其他窗口 ─────────────────

describe("需求3：「退出 LightMD」/ Ctrl+Q 后下次不恢复其他窗口", () => {
  it("Rust：quit_app 只写主窗口快照并置位标记", () => {
    expect(windowCmdsRs).toContain("mgr.mark_quit_action();");
    expect(windowCmdsRs).toContain("mgr.snapshot_for_quit(window::now_ms())");
    // 空状态时至少裁掉旧会话中的辅助窗口
    expect(windowCmdsRs).toContain("prune_session_secondaries(app.clone())");
  });

  it("Rust：finalize_session 尊重退出标记，不再覆盖成存活窗口快照", () => {
    expect(libRs).toContain("if mgr.quit_action_requested() {");
    expect(libRs).toContain("mgr.snapshot_for_quit(window::now_ms())");
  });

  it("Rust：snapshot_for_quit 只输出一个主窗口条目（含晋升场景重标为 main）", () => {
    expect(modRs).toContain("pub fn snapshot_for_quit(&self, timestamp: u64) -> SessionSnapshot");
    expect(modRs).toContain("session.label = PRIMARY_LABEL.to_string();");
  });

  it("前端：退出前先冲刷本窗口状态，再调用 quit_app", () => {
    const flush = appSrc.indexOf("await flushWindowState().catch(() => undefined);");
    const quit = appSrc.indexOf("await windowService.quitApp().catch((err) => {");
    expect(flush).toBeGreaterThan(-1);
    expect(quit).toBeGreaterThan(flush);
    // 冲刷是「立即上报」，绕过 300ms 防抖与指纹跳过
    expect(appSrc).toContain("const flushWindowState = useCallback(async () => {");
    expect(appSrc).toContain("await windowService.syncWindowState(report);");
  });

  it("windowService.quitApp 仍走 quit_app 命令（语义在 Rust 侧）", async () => {
    enterTauri("main");
    invokeMock.mockResolvedValue(undefined);
    await windowService.quitApp();
    expect(invokeMock).toHaveBeenCalledWith("quit_app");
  });
});
