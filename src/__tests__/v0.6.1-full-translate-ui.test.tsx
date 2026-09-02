/**
 * v0.6.1 全文翻译 UI 测试
 *
 * 覆盖：
 * 1. FullTranslateButton：idle 渲染按钮（tooltip 全文翻译）、running 进度显示、点击回调
 * 2. StatusBar：运行中进度 + 取消按钮（mock translateService.cancel）、错误态提示、✕ 关闭
 * 3. commands.ts：edit.translateDocument action 派发 lightmd:command 事件
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FullTranslateButton } from "../components/editor/FullTranslateButton";
import { StatusBar } from "../components/layout/StatusBar";
import { useFullTranslateStore } from "../stores/fullTranslateStore";
import { commands } from "../core/commands";

// mock translateService（cancel 不发 invoke）
vi.mock("../services/translateService", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/translateService")>();
  return {
    ...orig,
    translateService: {
      ...orig.translateService,
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { translateService } from "../services/translateService";

beforeEach(() => {
  useFullTranslateStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── FullTranslateButton ─────────────────────────────────

describe("v0.6.1 FullTranslateButton", () => {
  it("idle：渲染按钮，title 含「全文翻译」", () => {
    const onStart = vi.fn();
    render(<FullTranslateButton onStart={onStart} />);
    const btn = screen.getByRole("button", { name: /全文翻译|Translate Document/ });
    expect(btn).toBeDefined();
    expect(btn.className).not.toContain("running");
  });

  it("点击触发 onStart 回调", () => {
    const onStart = vi.fn();
    render(<FullTranslateButton onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: /全文翻译|Translate Document/ }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("running：显示进度数字 done/total", () => {
    useFullTranslateStore.getState().start(8);
    useFullTranslateStore.getState().tick();
    useFullTranslateStore.getState().tick();
    useFullTranslateStore.getState().tick();
    render(<FullTranslateButton onStart={() => {}} />);
    const btn = screen.getByRole("button", { name: /全文翻译|Translate Document/ });
    expect(btn.className).toContain("running");
    expect(btn.textContent).toContain("3/8");
  });

  it("运行中 title 提示点击取消", () => {
    useFullTranslateStore.getState().start(4);
    render(<FullTranslateButton onStart={() => {}} />);
    const btn = screen.getByRole("button", { name: /全文翻译|Translate Document/ });
    expect(btn.getAttribute("title")).toContain("取消");
  });
});

// ─── StatusBar 进度/错误 ──────────────────────────────────

describe("v0.6.1 StatusBar 全文翻译进度", () => {
  it("running：显示进度与取消按钮，点击取消调用 translateService.cancel", () => {
    useFullTranslateStore.getState().start(10);
    useFullTranslateStore.getState().tick();
    useFullTranslateStore.getState().tick();
    render(<StatusBar />);
    expect(screen.getByText(/2\s*\/\s*10|2\/10/)).toBeDefined();
    const cancelBtn = screen.getByTitle(/取消翻译|Cancel translation/);
    fireEvent.click(cancelBtn);
    expect(translateService.cancel).toHaveBeenCalledTimes(1);
    expect(useFullTranslateStore.getState().cancelRequested).toBe(true);
  });

  it("finish 含段失败：v0.6.4 起 done 态显示「翻译完成」，不再显示段失败计数", () => {
    useFullTranslateStore.getState().start(5);
    useFullTranslateStore.getState().finish(2);
    render(<StatusBar />);
    // v0.6.4 问题1b：底部栏不再显示失败，仅显示完成（失败段由编辑器气泡提示）
    expect(screen.getByTestId("statusbar-ft-done")).toBeDefined();
    expect(screen.queryByText(/2.*段.*失败|failed/i)).toBeNull();
  });

  it("error（AUTH）：显示 Key 错误文案", () => {
    useFullTranslateStore.getState().start(2);
    useFullTranslateStore.getState().fail("AUTH");
    render(<StatusBar />);
    expect(screen.getByText(/API Key/i)).toBeDefined();
  });

  // v0.6.3 P0-3：翻译期间文档被编辑 → DOC_CHANGED 错误码显示专属文案
  it("error（DOC_CHANGED）：显示文档已修改文案", () => {
    useFullTranslateStore.getState().start(2);
    useFullTranslateStore.getState().fail("DOC_CHANGED");
    render(<StatusBar />);
    expect(screen.getByText(/文档在翻译期间已修改|Document changed during translation/)).toBeDefined();
  });

  it("idle：不显示进度区域", () => {
    render(<StatusBar />);
    expect(screen.queryByText(/翻译中|Translating \d/)).toBeNull();
  });
});

// ─── 命令派发 ────────────────────────────────────────────

describe("v0.6.1 edit.translateDocument 命令", () => {
  it("action 派发 lightmd:command 事件（detail.id = edit.translateDocument）", () => {
    const cmd = commands.find((c) => c.id === "edit.translateDocument");
    expect(cmd).toBeDefined();

    let received: string | null = null;
    const handler = (e: Event) => {
      received = (e as CustomEvent).detail?.id;
    };
    window.addEventListener("lightmd:command", handler);
    cmd!.action();
    window.removeEventListener("lightmd:command", handler);
    expect(received).toBe("edit.translateDocument");
  });
});
