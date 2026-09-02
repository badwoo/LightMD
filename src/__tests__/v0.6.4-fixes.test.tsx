/**
 * v0.6.4 问题修复测试
 *
 * 覆盖：
 * 1. hasTranslatableText：图片语法 ![alt](url) 整体剔除——纯图片块不可译（问题1a根因）
 * 2. splitDocumentForTranslation：纯图片块不单独生成翻译单元
 * 3. fullTranslateStore：finish 含段失败 → done 态（不再置 error），failedCount 供气泡
 * 4. StatusBar：done 态显示"翻译完成 ✓"且不显示失败计数；2 秒后自动消失（问题1b）
 * 5. 内联图片混正文：可译但图片部分由 Rust mask 层整体占位符保护（问题2 对齐）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import {
  hasTranslatableText,
  splitDocumentForTranslation,
} from "../services/fullTranslate";
import { useFullTranslateStore } from "../stores/fullTranslateStore";
import { StatusBar } from "../components/layout/StatusBar";

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

beforeEach(() => {
  useFullTranslateStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ─── 问题1a/2：图片语法可译性判断 ────────────────────────

describe("v0.6.4 hasTranslatableText 图片语法剔除", () => {
  it("纯图片块（含中文 alt）不可译——根因场景：纯图片块发请求 LLM 返回空导致段失败", () => {
    expect(hasTranslatableText("![截图](./images/流程图.png)")).toBe(false);
    expect(hasTranslatableText("![image](https://img.example.com/a.png)")).toBe(false);
    expect(hasTranslatableText("![alt text](https://a.com/b.png \"title\")")).toBe(false);
  });

  it("多个图片组合仍不可译", () => {
    expect(
      hasTranslatableText("![a](./1.png)\n\n![b](./2.png)"),
    ).toBe(false);
  });

  it("图片混正文可译（正文参与判断，图片由 Rust mask 层保护）", () => {
    expect(hasTranslatableText("这是说明文字 ![图](./a.png) 结束")).toBe(true);
    expect(hasTranslatableText("Text before ![img](./a.png) and after")).toBe(true);
  });

  it("内联图片嵌在句子中：剔除图片后按剩余文字判断（问题2）", () => {
    // 内联图片 + 纯符号 → 不可译
    expect(hasTranslatableText("![only](./a.png) ---")).toBe(false);
  });
});

// ─── 问题1a：切分跳过纯图片块 ────────────────────────────

describe("v0.6.4 splitDocumentForTranslation 纯图片块跳过", () => {
  it("纯图片块不单独生成单元：作为无文字 gap 并入相邻单元", () => {
    const md = "# 标题\n\n![截图](./images/流程图.png)\n\n正文段落。";
    const units = splitDocumentForTranslation(md);
    // 纯图片 gap 无可译文字 → 标题与正文合并为 1 个单元
    expect(units).toHaveLength(1);
    expect(units[0].text).toContain("# 标题");
    expect(units[0].text).toContain("正文段落。");
  });

  it("图片混正文的段落正常生成单元（图片由 Rust mask 层整体占位符化）", () => {
    const md = "这是说明 ![图](./a.png) 继续。";
    const units = splitDocumentForTranslation(md);
    expect(units).toHaveLength(1);
    expect(units[0].text).toBe(md);
  });
});

// ─── 问题1b：状态机 done 态 ──────────────────────────────

describe("v0.6.4 fullTranslateStore done 状态机", () => {
  it("finish 含段失败 → done 态 + failedCount 记录（不再置 error）", () => {
    useFullTranslateStore.getState().start(5);
    useFullTranslateStore.getState().finish(1);
    const s = useFullTranslateStore.getState();
    expect(s.status).toBe("done");
    expect(s.failedCount).toBe(1);
  });

  it("finish 全部成功 → done 态，failedCount 为 0", () => {
    useFullTranslateStore.getState().start(3);
    useFullTranslateStore.getState().finish(0);
    const s = useFullTranslateStore.getState();
    expect(s.status).toBe("done");
    expect(s.failedCount).toBe(0);
  });

  it("reset → idle 且 failedCount 清零", () => {
    useFullTranslateStore.getState().start(3);
    useFullTranslateStore.getState().finish(2);
    useFullTranslateStore.getState().reset();
    const s = useFullTranslateStore.getState();
    expect(s.status).toBe("idle");
    expect(s.failedCount).toBe(0);
  });

  it("系统性错误仍走 error 态（fail 不受影响）", () => {
    useFullTranslateStore.getState().start(3);
    useFullTranslateStore.getState().fail("AUTH");
    expect(useFullTranslateStore.getState().status).toBe("error");
    expect(useFullTranslateStore.getState().errorCode).toBe("AUTH");
  });
});

// ─── 问题1b：StatusBar done 显示与自动消失 ───────────────

describe("v0.6.4 StatusBar 翻译完成态", () => {
  it("done：显示「翻译完成 ✓」，不显示失败计数", () => {
    useFullTranslateStore.getState().start(5);
    useFullTranslateStore.getState().finish(1); // 含 1 段失败
    render(<StatusBar />);
    expect(screen.getByTestId("statusbar-ft-done")).toBeDefined();
    expect(screen.getByTestId("statusbar-ft-done").textContent).not.toMatch(/失败|failed/i);
  });

  it("done 2 秒后自动 reset 回 idle（提示消失）", () => {
    vi.useFakeTimers();
    useFullTranslateStore.getState().start(5);
    useFullTranslateStore.getState().finish(0);
    render(<StatusBar />);
    expect(screen.getByTestId("statusbar-ft-done")).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(useFullTranslateStore.getState().status).toBe("idle");
    expect(screen.queryByTestId("statusbar-ft-done")).toBeNull();
  });

  it("running：只显示进度，不显示完成态", () => {
    useFullTranslateStore.getState().start(4);
    useFullTranslateStore.getState().tick();
    render(<StatusBar />);
    expect(screen.queryByTestId("statusbar-ft-done")).toBeNull();
    expect(screen.getByText(/1\s*\/\s*4|1\/4/)).toBeDefined();
  });
});
