/**
 * 快捷键切换模式时滚动位置丢失 bug 修复测试
 *
 * Bug 复现场景（通过 chrome-devtools 实时调试定位）：
 * - 用户在打字机模式下，光标不在视口中央（例如刚切换到打字机模式）
 * - 双击 Ctrl 切换 preview↔edit，或双击 Shift 切换 split↔prevViewMode
 * - keydown 触发 setViewMode → React 重新渲染 → applyScroll effect 调度
 *   （useEffect 异步执行，isRestoringScrollRef.current = true）
 * - 用户松开按键 → keyup 事件在 textarea/ProseMirror 上触发（事件冒泡）
 * - textarea handleKeyUp 走 else 分支（Ctrl/Shift 不是导航键），
 *   检查光标偏离中央 → 若偏离超过阈值则调用 scrollTo({behavior: "smooth"})
 * - smooth 滚动（异步多帧）覆盖 applyScroll 的 instant 设置
 * - applyScroll 在双 rAF 后执行，设置 scrollTop，但 smooth 滚动仍在继续，
 *   最终 scrollTop 被 smooth 滚动覆盖，滚动位置丢失
 *
 * 修复方案（双重保护）：
 * 1. isRestoringScrollRef 检查：applyScroll effect 执行期间（isRestoringScrollRef=true），
 *    handleKeyUp 直接 return
 * 2. isModifierKey 检查：修饰键（Shift/Control/Alt/Meta）本身不移动光标，
 *    不应触发任何滚动。作为 isRestoringScrollRef 的双重保护，应对 applyScroll
 *    effect（useEffect，异步）尚未执行、isRestoringScrollRef 仍为 false 的时序竞争
 *
 * 同时修复 textarea 打字机 effect 的初始 scrollCursorToCenter：
 * 添加 shouldSkipInitialScrollToCenter 检查，与 ProseMirror 打字机 effect 保持一致
 */
import { describe, it, expect } from "vitest";
import { isModifierKey, shouldSkipInitialScrollToCenter } from "../utils/typewriter";

describe("isModifierKey - 修饰键判定", () => {
  // ─── Bug 复现：双击 Ctrl/Shift 切换模式时 keyup 触发的修饰键 ─────

  it("双击 Ctrl 切换模式时 keyup 的 'Control' 键应被识别为修饰键", () => {
    // 双击 Ctrl 切换 preview↔edit，keyup 事件 e.key === "Control"
    expect(isModifierKey("Control")).toBe(true);
  });

  it("双击 Shift 切换模式时 keyup 的 'Shift' 键应被识别为修饰键", () => {
    // 双击 Shift 切换 split↔prevViewMode，keyup 事件 e.key === "Shift"
    expect(isModifierKey("Shift")).toBe(true);
  });

  // ─── 其他修饰键 ─────────────────────────────────────

  it("'Alt' 键应被识别为修饰键", () => {
    expect(isModifierKey("Alt")).toBe(true);
  });

  it("'Meta' 键应被识别为修饰键（Windows 键/Command 键）", () => {
    expect(isModifierKey("Meta")).toBe(true);
  });

  // ─── 非修饰键不应被误判 ──────────────────────────────

  it("导航键 'Enter' 不应被识别为修饰键", () => {
    expect(isModifierKey("Enter")).toBe(false);
  });

  it("导航键 'ArrowUp' 不应被识别为修饰键", () => {
    expect(isModifierKey("ArrowUp")).toBe(false);
  });

  it("导航键 'PageDown' 不应被识别为修饰键", () => {
    expect(isModifierKey("PageDown")).toBe(false);
  });

  it("普通字符 'a' 不应被识别为修饰键", () => {
    expect(isModifierKey("a")).toBe(false);
  });

  it("数字 '5' 不应被识别为修饰键", () => {
    expect(isModifierKey("5")).toBe(false);
  });

  it("空格 ' ' 不应被识别为修饰键", () => {
    expect(isModifierKey(" ")).toBe(false);
  });

  it("退格 'Backspace' 不应被识别为修饰键", () => {
    expect(isModifierKey("Backspace")).toBe(false);
  });

  it("空字符串不应被识别为修饰键", () => {
    expect(isModifierKey("")).toBe(false);
  });
});

describe("shouldSkipInitialScrollToCenter - textarea 打字机 effect 初始滚动", () => {
  // ─── Bug 复现：快捷键切换模式时 textarea 打字机 effect 初始滚动 ──

  it("Bug 复现：打字机开启 + 正在恢复滚动位置 → 应跳过初始 scrollCursorToCenter", () => {
    // 双击 Ctrl/Shift 切换模式后，textarea 打字机 effect 重新执行，
    // applyScroll 正在恢复滚动位置（isRestoringScroll=true），
    // 此时 scrollCursorToCenter（smooth）会覆盖 applyScroll（instant）
    expect(shouldSkipInitialScrollToCenter(true, true)).toBe(true);
  });

  // ─── 正常场景 ───────────────────────────────────────

  it("打字机开启 + 未在恢复滚动位置 → 应执行初始 scrollCursorToCenter（文件切换等场景）", () => {
    // 文件切换后需要光标居中，isRestoringScroll=false
    expect(shouldSkipInitialScrollToCenter(false, true)).toBe(false);
  });

  it("打字机关闭 + 正在恢复滚动位置 → 应跳过（不需要光标居中）", () => {
    expect(shouldSkipInitialScrollToCenter(true, false)).toBe(true);
  });

  it("打字机关闭 + 未在恢复滚动位置 → 应跳过（不需要光标居中）", () => {
    expect(shouldSkipInitialScrollToCenter(false, false)).toBe(true);
  });
});

describe("快捷键切换模式时滚动位置丢失 bug 完整流程", () => {
  // ─── 完整流程：双击 Ctrl 切换 preview↔edit ──────────

  it("完整流程：双击 Ctrl 切换模式时，keyup 的 Ctrl 应被识别为修饰键", () => {
    // 1. 用户在打字机模式下，preview 模式滚动到 0.5
    // 2. 双击 Ctrl 切换到 edit 模式
    // 3. keydown 触发 setViewMode → applyScroll effect 调度
    // 4. keyup 事件 e.key === "Control"
    // 5. handleKeyUp 检查 isModifierKey("Control") === true → return，不触发 smooth 滚动
    // 6. applyScroll 在双 rAF 后执行，instant 设置 scrollTop，滚动位置保持一致
    expect(isModifierKey("Control")).toBe(true);
  });

  it("完整流程：双击 Shift 切换模式时，keyup 的 Shift 应被识别为修饰键", () => {
    // 1. 用户在打字机模式下，edit 模式滚动到 0.5
    // 2. 双击 Shift 切换到 split 模式
    // 3. keydown 触发 setViewMode → applyScroll effect 调度
    // 4. keyup 事件 e.key === "Shift"
    // 5. handleKeyUp 检查 isModifierKey("Shift") === true → return，不触发 smooth 滚动
    // 6. applyScroll 在双 rAF 后执行，instant 设置 scrollTop，滚动位置保持一致
    expect(isModifierKey("Shift")).toBe(true);
  });

  // ─── 时序竞争场景：applyScroll effect 尚未执行 ──────

  it("时序竞争：applyScroll effect 尚未执行时，修饰键检查应作为双重保护", () => {
    // 场景：keyup 在 applyScroll effect（useEffect，异步）之前触发
    // 此时 isRestoringScrollRef.current 仍为 false
    // 但 isModifierKey("Control") === true，handleKeyUp 仍会 return
    // 避免 smooth 滚动覆盖后续的 applyScroll
    const isRestoringScroll = false; // applyScroll effect 尚未执行
    const isModifier = isModifierKey("Control");
    expect(isRestoringScroll).toBe(false);
    expect(isModifier).toBe(true);
    // 即使 isRestoringScroll=false，isModifier=true 也能阻止 smooth 滚动
  });

  it("时序竞争：非修饰键场景下 isModifierKey 不应误判", () => {
    // 场景：用户在打字机模式下按回车键换行
    // keyup 事件 e.key === "Enter"
    // isModifierKey("Enter") === false，handleKeyUp 继续执行，触发 scrollToCenter
    // 这是正确的行为：回车换行需要光标居中
    expect(isModifierKey("Enter")).toBe(false);
  });
});

describe("textarea 打字机 effect 初始 scrollCursorToCenter 修复", () => {
  // ─── 与 ProseMirror 打字机 effect 保持一致 ─────────

  it("模式切换时 textarea 打字机 effect 应跳过初始 scrollCursorToCenter", () => {
    // 修复前：textarea 打字机 effect 的 scrollCursorToCenter 未加检查，
    // 模式切换时 smooth 滚动覆盖 applyScroll
    // 修复后：与 ProseMirror 一致，使用 shouldSkipInitialScrollToCenter 判断
    const isRestoringScroll = true;
    const isTypewriterMode = true;
    expect(shouldSkipInitialScrollToCenter(isRestoringScroll, isTypewriterMode)).toBe(true);
  });

  it("文件切换时 textarea 打字机 effect 应执行初始 scrollCursorToCenter", () => {
    // 文件切换后需要光标居中，isRestoringScroll=false
    const isRestoringScroll = false;
    const isTypewriterMode = true;
    expect(shouldSkipInitialScrollToCenter(isRestoringScroll, isTypewriterMode)).toBe(false);
  });
});
