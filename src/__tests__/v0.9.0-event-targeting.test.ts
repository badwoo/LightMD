/**
 * v0.9.0 实机测试发现的两个缺陷的回归用例：
 *
 * 1. **定向事件泄漏**：Tauri v2 的 `emit_to(label)` 不能把事件限制在单个 webview 内
 *    （JS 监听器注册目标为 `Any`）→ 必须按 `target` 自行过滤。
 *    症状：关闭主窗口导致所有窗口一起关闭；一次双击让所有窗口打开同一文件。
 * 2. **路径分隔符不一致**：Rust 事件里的路径是正斜杠（`path_key` 归一），
 *    而「用原生对话框打开」的标签存的是反斜杠 → `getTabByPath` 匹配失败，
 *    外部修改/删除联动静默失效。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { unwrapTargetedEvent, targetedEnvelope } from "../utils/targetedEvent";
import { pathCompareKey, isSamePath, normalizePath } from "../utils/path";
import { __setWindowLabelForTest } from "../utils/windowLabel";

afterEach(() => __setWindowLabelForTest(null));

describe("v0.9.0：定向事件过滤（Tauri v2 emit_to 语义坑）", () => {
  it("target 命中本窗口 → 解包出内层载荷", () => {
    __setWindowLabelForTest("sec-1");
    const raw = targetedEnvelope("sec-1", { path: "D:/a.md" });
    expect(unwrapTargetedEvent<{ path: string }>(raw)).toEqual({ path: "D:/a.md" });
  });

  it("target 指向其他窗口 → 返回 null（不得处理，否则所有窗口都响应）", () => {
    __setWindowLabelForTest("sec-2");
    const raw = targetedEnvelope("main", { label: "main" });
    expect(unwrapTargetedEvent(raw)).toBeNull();
  });

  it("主窗口只处理发往 main 的定向事件", () => {
    __setWindowLabelForTest("main");
    expect(unwrapTargetedEvent(targetedEnvelope("main", "x"))).toBe("x");
    expect(unwrapTargetedEvent(targetedEnvelope("sec-1", "x"))).toBeNull();
  });

  it("无 target 的旧式广播载荷原样返回（不漏事件）", () => {
    __setWindowLabelForTest("sec-3");
    expect(unwrapTargetedEvent({ files: ["D:/a.md"] })).toEqual({ files: ["D:/a.md"] });
    expect(unwrapTargetedEvent("plain-string")).toBe("plain-string");
  });

  it("null / 非对象载荷返回 null（不抛错）", () => {
    __setWindowLabelForTest("main");
    expect(unwrapTargetedEvent(null)).toBeNull();
    expect(unwrapTargetedEvent(undefined)).toBeNull();
  });

  it("target 命中但 payload 为空 → null（调用方忽略空事件）", () => {
    __setWindowLabelForTest("main");
    expect(unwrapTargetedEvent({ target: "main" })).toBeNull();
  });

  it("关闭请求载荷（label 字段）按窗口过滤的三态", () => {
    const closePayload = (label: string) => ({ label });
    __setWindowLabelForTest("main");
    expect(closePayload("main").label === "main").toBe(true);
    expect(closePayload("sec-1").label === "main").toBe(false);
  });
});

describe("v0.9.0：路径比较键（分隔符/大小写归一）", () => {
  it("反斜杠与正斜杠视为同一路径", () => {
    expect(isSamePath("D:\\docs\\a.md", "D:/docs/a.md")).toBe(true);
    expect(pathCompareKey("D:\\docs\\a.md")).toBe("d:/docs/a.md");
  });

  it("Windows 语义下大小写不敏感", () => {
    expect(isSamePath("D:/Docs/A.MD", "d:/docs/a.md")).toBe(true);
  });

  it("不同路径不误判（前缀相似的兄弟文件）", () => {
    expect(isSamePath("D:/docs/a.md", "D:/docs/ab.md")).toBe(false);
    expect(isSamePath("D:/docs/a.md", "D:/docs2/a.md")).toBe(false);
  });

  it("空路径不匹配任何路径", () => {
    expect(isSamePath("", "D:/a.md")).toBe(false);
    expect(isSamePath("D:/a.md", "")).toBe(false);
  });

  it("normalizePath 只换分隔符、不改大小写（与 pathCompareKey 分工明确）", () => {
    expect(normalizePath("D:\\Docs\\A.MD")).toBe("D:/Docs/A.MD");
  });

  it("Rust 事件路径（正斜杠）能匹配到以原生反斜杠打开的标签路径", () => {
    // 模拟 App.tsx 里 fileChanged 的匹配逻辑
    const tabs = [
      { path: "C:\\Users\\me\\Docs\\note.md" }, // 原生对话框打开的路径
      { path: "D:/other/file.md" },
    ];
    const eventPath = "C:/Users/me/Docs/note.md"; // Rust path_key 归一后的路径
    const key = pathCompareKey(eventPath);
    const idx = tabs.findIndex((t) => pathCompareKey(t.path) === key);
    expect(idx).toBe(0);
  });
});
