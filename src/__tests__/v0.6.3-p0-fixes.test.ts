/**
 * v0.6.3 P0 修复测试
 *
 * 覆盖审核报告（docs/CODE_REVIEW_v0.6.2.md）三个 P0 缺陷的修复：
 * - P0-1：全文翻译「标签切换中止」检测恒 false → createContextAbortChecker
 *   （启动上下文快照 vs 每次渲染刷新的活跃上下文）
 * - P0-2：取消翻译快照跨标签/跨文件不清理 → store 加固 + 快照绑定文档上下文
 * - P0-3：回写前内容一致性校验 → DOC_CHANGED 错误码（UI 文案见 v0.6.1-full-translate-ui）
 *
 * 说明：原 v0.6.1-full-translate.test.ts 中的「shouldAbort 中止」用例注入的是假
 * shouldAbort，只验证循环契约，不构成对标签切换保护的验证（审核报告第六章指出的
 * 假象用例）。此处测试生产代码实际使用的 createContextAbortChecker 工厂。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createContextAbortChecker } from "../services/fullTranslate";
import { useEditorStore } from "../stores/useEditorStore";

// ─── P0-1：createContextAbortChecker ─────────────────────

describe("v0.6.3 P0-1 createContextAbortChecker 标签切换中止检测", () => {
  const start = { filePath: "D:\\docs\\a.md", key: 3 };

  it("上下文一致且未取消 → false（允许继续/回写）", () => {
    const check = createContextAbortChecker(
      start,
      () => ({ filePath: "D:\\docs\\a.md", key: 3 }),
      () => false,
    );
    expect(check()).toBe(false);
  });

  it("切换到另一文件 → true（原缺陷：恒 false，译文会写入错误文档）", () => {
    const check = createContextAbortChecker(
      start,
      () => ({ filePath: "D:\\docs\\b.md", key: 3 }),
      () => false,
    );
    expect(check()).toBe(true);
  });

  it("同一文件但 forceUpdateKey 变化（外部内容替换/版本恢复）→ true", () => {
    const check = createContextAbortChecker(
      start,
      () => ({ filePath: "D:\\docs\\a.md", key: 4 }),
      () => false,
    );
    expect(check()).toBe(true);
  });

  it("切走再切回同一文件（路径与 key 均还原）→ false（写回原文档安全）", () => {
    let active = { filePath: "D:\\docs\\a.md" as string | null, key: 3 };
    const check = createContextAbortChecker(start, () => active, () => false);
    expect(check()).toBe(false);
    active = { filePath: "D:\\docs\\b.md", key: 3 };
    expect(check()).toBe(true);
    active = { filePath: "D:\\docs\\a.md", key: 3 };
    expect(check()).toBe(false);
  });

  it("用户请求取消（cancelRequested）→ true", () => {
    const check = createContextAbortChecker(
      start,
      () => ({ filePath: "D:\\docs\\a.md", key: 3 }),
      () => true,
    );
    expect(check()).toBe(true);
  });

  it("未保存新文件（filePath: null）切换到已保存文件 → true", () => {
    const check = createContextAbortChecker(
      { filePath: null, key: 0 },
      () => ({ filePath: "D:\\docs\\a.md", key: 0 }),
      () => false,
    );
    expect(check()).toBe(true);
  });
});

// ─── P0-2/P2-4：useEditorStore 快照与保存抑制生命周期 ────

describe("v0.6.3 P0-2 useEditorStore 标签切换/关闭清理快照", () => {
  beforeEach(() => {
    useEditorStore.setState({
      openTabs: [
        { path: "D:\\docs\\a.md", name: "a.md" },
        { path: "D:\\docs\\b.md", name: "b.md" },
        { path: "D:\\docs\\c.md", name: "c.md" },
      ],
      activeTabIdx: 0,
      filePath: "D:\\docs\\a.md",
      isDirty: true,
      suppressAutoSave: false,
      translateUndoSnapshot: null,
    });
  });

  it("setActiveTab 切换标签：清除快照并解除自动保存抑制", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "A 原文", filePath: "D:\\docs\\a.md", key: 0 });
    useEditorStore.getState().setActiveTab(1);
    const s = useEditorStore.getState();
    expect(s.activeTabIdx).toBe(1);
    expect(s.translateUndoSnapshot).toBeNull();
    expect(s.suppressAutoSave).toBe(false);
  });

  it("setActiveTab 切到当前标签（索引不变）：不清除", () => {
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "A 原文", filePath: "D:\\docs\\a.md", key: 0 });
    useEditorStore.getState().setActiveTab(0);
    expect(useEditorStore.getState().translateUndoSnapshot).not.toBeNull();
  });

  it("closeTab 关闭激活标签：清除快照并解除抑制", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "A 原文", filePath: "D:\\docs\\a.md", key: 0 });
    useEditorStore.getState().closeTab(0);
    const s = useEditorStore.getState();
    expect(s.translateUndoSnapshot).toBeNull();
    expect(s.suppressAutoSave).toBe(false);
  });

  it("closeTab 关闭非激活标签：保留激活文档的快照", () => {
    useEditorStore.getState().setSuppressAutoSave(true);
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "A 原文", filePath: "D:\\docs\\a.md", key: 0 });
    useEditorStore.getState().closeTab(2); // 关闭 c.md（非激活）
    const s = useEditorStore.getState();
    expect(s.translateUndoSnapshot?.content).toBe("A 原文");
    expect(s.suppressAutoSave).toBe(true);
    expect(s.activeTabIdx).toBe(0); // 激活索引不变
  });

  it("快照结构：绑定 filePath 与 key（供 undoTranslation 归属校验）", () => {
    useEditorStore.getState().setTranslateUndoSnapshot({ content: "原文", filePath: "D:\\docs\\a.md", key: 7 });
    const snap = useEditorStore.getState().translateUndoSnapshot;
    expect(snap).toEqual({ content: "原文", filePath: "D:\\docs\\a.md", key: 7 });
  });
});
