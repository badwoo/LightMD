/**
 * v0.6.1 修复项测试
 *
 * 覆盖：
 * 1. 问题6：evalDoublePress 双击判定（长按 repeat 不触发模式切换）
 * 2. 问题2/3：useEditorStore 新增 suppressAutoSave / translateUndoSnapshot 流转
 * 3. 问题5：ModeSwitchButton 羽毛笔/书本切换
 * 4. 问题2：TranslateUndoToast 取消翻译气泡显示/点击恢复
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { evalDoublePress, DOUBLE_PRESS_THRESHOLD } from "../utils/modeSwitch";
import { useEditorStore } from "../stores/useEditorStore";
import { ModeSwitchButton } from "../components/editor/ModeSwitchButton";
import { TranslateUndoToast } from "../components/editor/TranslateUndoToast";

// ─── 问题6：evalDoublePress 双击判定 ─────────────────────

describe("v0.6.1 问题6 evalDoublePress 双击判定", () => {
  it("首次按下（无上次记录）→ record", () => {
    expect(evalDoublePress(1000, 0, DOUBLE_PRESS_THRESHOLD, false)).toBe("record");
  });

  it("阈值内第二次按下 → toggle", () => {
    expect(evalDoublePress(1000, 900, DOUBLE_PRESS_THRESHOLD, false)).toBe("toggle");
  });

  it("超过阈值的第二次按下 → record（不算双击）", () => {
    expect(evalDoublePress(2000, 1000, DOUBLE_PRESS_THRESHOLD, false)).toBe("record");
  });

  it("长按产生的 repeat keydown → skip（无论时间差多近）", () => {
    expect(evalDoublePress(1000, 900, DOUBLE_PRESS_THRESHOLD, true)).toBe("skip");
    expect(evalDoublePress(1000, 999, DOUBLE_PRESS_THRESHOLD, true)).toBe("skip");
  });

  it("完整长按序列：长按 1 秒后快速单击不误判为双击", () => {
    // 1. t0 按下（record，lastTime=t0）
    const t0 = 1_000_000;
    expect(evalDoublePress(t0, 0, DOUBLE_PRESS_THRESHOLD, false)).toBe("record");
    // 2. 长按期间 repeat 事件（skip，不刷新 lastTime —— 调用方忽略）
    expect(evalDoublePress(t0 + 500, t0, DOUBLE_PRESS_THRESHOLD, true)).toBe("skip");
    expect(evalDoublePress(t0 + 900, t0, DOUBLE_PRESS_THRESHOLD, true)).toBe("skip");
    // 3. 松开后 t0+950 再按下一次（真实单击）：lastTime 仍为 t0，950 > 300 → record
    expect(evalDoublePress(t0 + 950, t0, DOUBLE_PRESS_THRESHOLD, false)).toBe("record");
  });

  it("正常双击：快速两次真实按下 → 第二次 toggle", () => {
    const t0 = 1_000_000;
    expect(evalDoublePress(t0, 0, DOUBLE_PRESS_THRESHOLD, false)).toBe("record");
    expect(evalDoublePress(t0 + 200, t0, DOUBLE_PRESS_THRESHOLD, false)).toBe("toggle");
  });
});

// ─── 问题2/3：useEditorStore 翻译回写状态 ─────────────────

describe("v0.6.1 问题2/3 useEditorStore 翻译回写状态", () => {
  beforeEach(() => {
    useEditorStore.getState().setSuppressAutoSave(false);
    useEditorStore.getState().setTranslateUndoSnapshot(null);
    useEditorStore.setState({ isDirty: false });
  });

  it("翻译回写：置抑制自动保存 + 记录原文快照", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "# 原文\n\n第一段。", filePath: "a.md", key: 0 });
    expect(useEditorStore.getState().suppressAutoSave).toBe(true);
    expect(useEditorStore.getState().translateUndoSnapshot?.content).toBe("# 原文\n\n第一段。");
  });

  it("手动保存（markSaved）：重置脏标记 + 解除抑制 + 清除快照", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "原文", filePath: "a.md", key: 0 });
    useEditorStore.setState({ isDirty: true });
    useEditorStore.getState().markSaved();
    const s = useEditorStore.getState();
    expect(s.isDirty).toBe(false);
    expect(s.suppressAutoSave).toBe(false);
    expect(s.translateUndoSnapshot).toBeNull();
  });

  it("切换文件（openFile）：重置抑制与快照", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "原文", filePath: "a.md", key: 0 });
    useEditorStore.getState().openFile("D:\\test\\other.md");
    const s = useEditorStore.getState();
    expect(s.suppressAutoSave).toBe(false);
    expect(s.translateUndoSnapshot).toBeNull();
  });

  it("取消翻译恢复：清除快照 + 解除抑制（手动组合调用）", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "原文", filePath: "a.md", key: 0 });
    // undoTranslation 中的关键 store 序列
    useEditorStore.getState().setTranslateUndoSnapshot(null);
    useEditorStore.getState().setSuppressAutoSave(false);
    const s = useEditorStore.getState();
    expect(s.translateUndoSnapshot).toBeNull();
    expect(s.suppressAutoSave).toBe(false);
  });
});

// ─── 问题5：ModeSwitchButton ─────────────────────────────

describe("v0.6.1 问题5 ModeSwitchButton 模式切换按钮", () => {
  beforeEach(cleanup);

  it("阅读模式显示羽毛笔，点击切换到分屏", () => {
    const onSwitch = vi.fn();
    render(<ModeSwitchButton viewMode="preview" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSwitch).toHaveBeenCalledWith("split");
  });

  it("分屏模式显示书本，点击切回阅读", () => {
    const onSwitch = vi.fn();
    render(<ModeSwitchButton viewMode="split" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSwitch).toHaveBeenCalledWith("preview");
  });

  it("tooltip 文案随模式切换", () => {
    const { rerender } = render(<ModeSwitchButton viewMode="preview" onSwitch={() => {}} />);
    expect(screen.getByRole("button").title).toBe("切换到分屏模式");
    rerender(<ModeSwitchButton viewMode="split" onSwitch={() => {}} />);
    expect(screen.getByRole("button").title).toBe("切换回阅读模式");
    cleanup();
  });
});

// ─── 问题2：TranslateUndoToast ───────────────────────────

describe("v0.6.1 问题2 TranslateUndoToast 取消翻译气泡", () => {
  beforeEach(() => {
    cleanup();
    useEditorStore.getState().setTranslateUndoSnapshot(null);
  });

  it("无快照时不渲染", () => {
    const { container } = render(<TranslateUndoToast onUndo={() => {}} />);
    expect(container.querySelector(".translate-undo-toast")).toBeNull();
  });

  it("翻译回写后（有快照）显示气泡，点击触发恢复", () => {
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "# 原文", filePath: "a.md", key: 0 });
    const onUndo = vi.fn();
    render(<TranslateUndoToast onUndo={onUndo} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("取消翻译");
    fireEvent.click(btn);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("快照清除后气泡消失", () => {
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "# 原文", filePath: "a.md", key: 0 });
    const { container } = render(<TranslateUndoToast onUndo={() => {}} />);
    expect(container.querySelector(".translate-undo-toast")).not.toBeNull();
    // store 更新需要包裹 act 触发重渲染
    act(() => {
      useEditorStore.getState().setTranslateUndoSnapshot(null);
    });
    expect(container.querySelector(".translate-undo-toast")).toBeNull();
  });
});
