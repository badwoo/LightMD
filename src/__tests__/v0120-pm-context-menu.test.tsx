/**
 * v0.12.0 需求2：PM 右键菜单测试
 *
 * 覆盖：
 * 1. buildPmMenuItems 三态（有选区 / NodeSelection 块选中 / 无选区）
 * 2. 渲染交互：菜单项点击 → onAction + onClose；Esc 关闭
 * 3. 块删除文案按类型映射（table/code_block/mermaid_block/math_block + 回退）
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  buildPmMenuItems,
  PmContextMenu,
  NODE_DELETE_LABEL_KEYS,
} from "../components/editor/PmContextMenu";

const containerSrc = readFileSync("src/components/editor/EditorContainer.tsx", "utf-8");

afterEach(cleanup);

const baseCtx = { hasSelection: false, nodeKind: null, isMdFile: true, translateEnabled: true };

describe("v0.12.0 需求2：buildPmMenuItems 三态", () => {
  it("有文本选区：行内格式 + 格式刷 + AI 翻译", () => {
    const items = buildPmMenuItems({ ...baseCtx, hasSelection: true });
    const actions = items.filter((i) => i.type === "item").map((i) => i.action);
    expect(actions).toEqual([
      "bold", "italic", "strikethrough", "code", "highlight", "underline",
      "formatPainter", "translate",
    ]);
  });

  it("NodeSelection（块选中）：格式刷 + 删除 XX（按类型映射）", () => {
    const table = buildPmMenuItems({ ...baseCtx, nodeKind: "table" });
    expect(table.find((i) => i.action === "deleteNode")?.label).toBe("删除表格");
    expect(table.find((i) => i.action === "formatPainter")).toBeTruthy();
    // 各类型映射
    expect(NODE_DELETE_LABEL_KEYS.code_block).toBe("menu.deleteCodeBlock");
    expect(NODE_DELETE_LABEL_KEYS.mermaid_block).toBe("menu.deleteMermaid");
    expect(NODE_DELETE_LABEL_KEYS.math_block).toBe("menu.deleteMathBlock");
    // 未知类型回退通用文案
    const unknown = buildPmMenuItems({ ...baseCtx, nodeKind: "weird_block" });
    expect(unknown.find((i) => i.action === "deleteNode")?.label).toBe("删除块");
  });

  it("无选区：插入类 + AI 续写/摘要；无行内格式项", () => {
    const items = buildPmMenuItems(baseCtx);
    const actions = items.filter((i) => i.type === "item").map((i) => i.action);
    expect(actions).toEqual([
      "link", "image", "table", "codeblock", "mermaid", "aiContinue", "aiSummary",
    ]);
    expect(actions).not.toContain("bold");
    expect(actions).not.toContain("formatPainter");
  });

  it("AI 关闭（translateEnabled=false）→ 隐藏 AI 项", () => {
    const selItems = buildPmMenuItems({ ...baseCtx, hasSelection: true, translateEnabled: false });
    expect(selItems.some((i) => i.action === "translate")).toBe(false);
    const noneItems = buildPmMenuItems({ ...baseCtx, translateEnabled: false });
    expect(noneItems.some((i) => i.action === "aiContinue")).toBe(false);
  });
});

describe("v0.12.0 需求2：PmContextMenu 渲染交互", () => {
  it("open=true 渲染菜单；点击项 → onAction + onClose", () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <PmContextMenu
        open
        x={100}
        y={100}
        hasSelection
        nodeKind={null}
        isMdFile
        translateEnabled={false}
        onAction={onAction}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("pm-context-menu")).toBeTruthy();
    fireEvent.click(screen.getByText("格式刷"));
    expect(onAction).toHaveBeenCalledWith("formatPainter");
    expect(onClose).toHaveBeenCalled();
  });

  it("open=false 不渲染", () => {
    render(
      <PmContextMenu
        open={false}
        x={0}
        y={0}
        hasSelection={false}
        nodeKind={null}
        isMdFile
        translateEnabled={false}
        onAction={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("pm-context-menu")).toBeNull();
  });

  it("Esc 关闭菜单", () => {
    const onClose = vi.fn();
    render(
      <PmContextMenu
        open
        x={0}
        y={0}
        hasSelection
        nodeKind={null}
        isMdFile
        translateEnabled={false}
        onAction={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * v0.12.0 返修（问题1）：阅读模式右键按需接管，恢复 v0.11.0 的 WebView2 原生菜单。
 *
 * 缺陷背景：v0.12.0 首次为阅读模式（PM）接管右键，**无差别** preventDefault，
 * 把原生菜单（表情符号 / 书写方向 / 更多工具）挤掉，用户反馈"右键菜单变成了
 * 插入链接、插入图片这些"。
 * 修复：仅「有文本选区 / 已选中块（NodeSelection）」时接管并渲染本菜单；
 * 其余情况不拦截，交回原生菜单。
 */
describe("v0.12.0 返修（问题1）：阅读模式右键接管策略（源码断言）", () => {
  it("无选区时不拦截（早退 → 交回原生菜单）", () => {
    expect(containerSrc).toContain("if (!isNode && !hasTextSelection) return;");
  });

  it("判定**同步**读取选区后才 preventDefault（rAF 内读取已无法阻止原生菜单）", () => {
    const selIdx = containerSrc.indexOf("const sel = view?.state.selection;");
    const preventIdx = containerSrc.indexOf("e.preventDefault();", selIdx);
    expect(selIdx).toBeGreaterThan(-1);
    expect(preventIdx).toBeGreaterThan(selIdx);
  });

  it("仅阅读模式 + md 文件生效（编辑/分屏走各自既有右键逻辑）", () => {
    expect(containerSrc).toContain('if (viewMode !== "preview" || !isMdFile) return;');
  });

  it("有选区/选中块的判定：NodeSelection 或非空 TextSelection", () => {
    expect(containerSrc).toContain("const isNode = sel instanceof NodeSelection;");
    expect(containerSrc).toContain("const hasTextSelection = !!sel && !isNode && sel.from !== sel.to;");
  });
});