/**
 * v0.7.0 修复测试：6 项问题修复的可测逻辑
 *
 * 修复1/2：全局 AI 总开关（aiEnabled）——关闭联动关闭翻译子开关；老数据迁移
 * 修复4：翻译气泡右键菜单定位（computeMenuPosition 视口自适应）
 * 修复5：AI 摘要气泡——全文/选段判定（isFullDocSummary）+ 虚线连接路径（computeSummaryPath）
 */
import { describe, it, expect } from "vitest";
import { useSettingsStore } from "../stores/useSettingsStore";
import { computeMenuPosition } from "../components/editor/MiniContextMenu";
import { isFullDocSummary, computeSummaryPath } from "../components/editor/AiAssistBubble";

describe("v0.7.0 修复1/2：全局 AI 总开关 setAiEnabled 联动", () => {
  it("关闭总开关时联动关闭翻译子开关（翻译入口随之静默）", () => {
    useSettingsStore.setState({ aiEnabled: true, translate: { ...useSettingsStore.getState().translate, translateEnabled: true } });
    useSettingsStore.getState().setAiEnabled(false);
    const s = useSettingsStore.getState();
    expect(s.aiEnabled).toBe(false);
    expect(s.translate.translateEnabled).toBe(false);
  });

  it("开启总开关不强制改变翻译子开关（子开关独立控制）", () => {
    useSettingsStore.setState({ aiEnabled: false, translate: { ...useSettingsStore.getState().translate, translateEnabled: false } });
    useSettingsStore.getState().setAiEnabled(true);
    const s = useSettingsStore.getState();
    expect(s.aiEnabled).toBe(true);
    // 翻译子开关保持关闭（需用户单独开启）
    expect(s.translate.translateEnabled).toBe(false);
  });

  it("总开关开启 + 子开关开启 → 双开关判定为可用（模拟入口 getter 语义）", () => {
    useSettingsStore.setState({ aiEnabled: true, translate: { ...useSettingsStore.getState().translate, translateEnabled: true } });
    const s = useSettingsStore.getState();
    expect(s.aiEnabled && s.translate.translateEnabled).toBe(true);
  });
});

describe("v0.7.0 修复5：AI 摘要全文/选段判定 isFullDocSummary", () => {
  it("null 锚点 → 全文摘要（显示 } 符号）", () => {
    expect(isFullDocSummary(null)).toBe(true);
  });

  it("{0,0} 占位锚点 → 全文摘要（入口未取到选区坐标）", () => {
    expect(isFullDocSummary({ x: 0, y: 0 })).toBe(true);
  });

  it("真实选区锚点 → 选段摘要（画虚线连接）", () => {
    expect(isFullDocSummary({ x: 320, y: 240 })).toBe(false);
  });
});

describe("v0.7.0 修复5：选段摘要虚线路径 computeSummaryPath", () => {
  it("生成二次贝塞尔路径（M 起点 Q 控制点 终点）", () => {
    const { d } = computeSummaryPath({ x: 900, y: 200 }, { x: 400, y: 500 });
    expect(d).toMatch(/^M 900 200 Q [\d.]+ [\d.]+ 400 500$/);
  });

  it("控制点向左回拉（弧线从气泡向选区收拢，Word 批注观感）", () => {
    const from = { x: 900, y: 200 };
    const to = { x: 400, y: 500 };
    const { d } = computeSummaryPath(from, to);
    const m = d.match(/^M [\d.]+ [\d.]+ Q ([\d.]+) ([\d.]+) [\d.]+ [\d.]+$/);
    expect(m).not.toBeNull();
    const cx = Number(m![1]);
    const cy = Number(m![2]);
    // 控制点横坐标在两端点左侧（回拉 ≥ 40px）
    expect(cx).toBeLessThan(Math.min(from.x, to.x));
    expect(Math.min(from.x, to.x) - cx).toBeGreaterThanOrEqual(40);
    // 控制点纵坐标为两端点中点（水平对称弧）
    expect(cy).toBeCloseTo((from.y + to.y) / 2);
  });

  it("垂直大跨度时回拉量按跨度放大（避免弧线过平）", () => {
    const from = { x: 900, y: 100 };
    const to = { x: 400, y: 900 };
    const { d } = computeSummaryPath(from, to);
    const m = d.match(/^M [\d.]+ [\d.]+ Q ([\d.]+) [\d.]+ [\d.]+ [\d.]+$/);
    const cx = Number(m![1]);
    // 跨度 800 * 0.2 = 160 > 40 下限
    expect(Math.min(from.x, to.x) - cx).toBeGreaterThanOrEqual(160 - 1e-9);
  });
});

describe("v0.7.0 修复4：翻译气泡右键菜单定位 computeMenuPosition", () => {
  const viewport = { width: 1280, height: 800 };

  it("菜单在视口内时显示在鼠标点（右下展开）", () => {
    const pos = computeMenuPosition(100, 100, viewport);
    expect(pos).toEqual({ left: 100, top: 100 });
  });

  it("右边界溢出时左移贴边（菜单不超出视口右侧）", () => {
    const pos = computeMenuPosition(1270, 100, viewport);
    expect(pos.left + 180).toBeLessThanOrEqual(viewport.width - 6);
    expect(pos.left).toBeGreaterThanOrEqual(6);
  });

  it("底部溢出时上移贴边（菜单不超出视口底部）", () => {
    const pos = computeMenuPosition(100, 790, viewport);
    expect(pos.top).toBeLessThanOrEqual(viewport.height - 6);
    expect(pos.top).toBeGreaterThanOrEqual(6);
  });

  it("右下角同时溢出时双向钳制在视口内", () => {
    const pos = computeMenuPosition(1275, 795, viewport);
    expect(pos.left).toBeGreaterThanOrEqual(6);
    expect(pos.top).toBeGreaterThanOrEqual(6);
  });
});
