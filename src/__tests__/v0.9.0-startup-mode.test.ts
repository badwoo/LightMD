/**
 * v0.9.0 WP8：启动分流决策三态（main / sec / restore）。
 *
 * 该决策决定「v0.8.5 遗留恢复 effect 是否执行」，是最容易引入回归的一环
 * （REG-1 / REG-3 / AC-11 都由它把关），故对全部输入组合做穷举断言。
 */
import { describe, it, expect } from "vitest";
import { decideStartupMode, type StartupModeInput } from "../services/startupMode";

function input(overrides: Partial<StartupModeInput> = {}): StartupModeInput {
  return {
    isMain: true,
    bootRestore: false,
    restoreEnabled: true,
    hasSession: false,
    ...overrides,
  };
}

describe("v0.9.0 WP8：decideStartupMode", () => {
  it("纯单窗口用户（无会话 + 开关开启）→ legacy（REG-1：完全走 v0.8.5 路径）", () => {
    expect(decideStartupMode(input())).toBe("legacy");
  });

  it("主窗口 + 存在多窗口会话 → session（AC-11：精确恢复而非 recentFiles 近似）", () => {
    expect(decideStartupMode(input({ hasSession: true }))).toBe("session");
  });

  it("主窗口 + 关闭「启动载入上次文件」→ skip（REG-3：不恢复任何标签）", () => {
    expect(decideStartupMode(input({ restoreEnabled: false }))).toBe("skip");
    // 即便磁盘上有会话文件，开关关闭也必须不恢复
    expect(decideStartupMode(input({ restoreEnabled: false, hasSession: true }))).toBe("skip");
  });

  it("辅助窗口（非主）→ skip（初始内容只来自引导数据）", () => {
    expect(decideStartupMode(input({ isMain: false }))).toBe("skip");
    expect(decideStartupMode(input({ isMain: false, hasSession: true }))).toBe("skip");
  });

  it("会话恢复窗口（bootRestore）→ session，优先级高于主窗口判定", () => {
    expect(decideStartupMode(input({ bootRestore: true }))).toBe("session");
    expect(decideStartupMode(input({ bootRestore: true, isMain: false }))).toBe("session");
    // 即使全局开关关闭，被显式要求恢复的窗口也要恢复（用户在重启瞬间关掉开关属边界容忍）
    expect(decideStartupMode(input({ bootRestore: true, restoreEnabled: false }))).toBe("session");
  });

  it("恢复窗口不需要会话文件（restore 标记本身就是依据）", () => {
    expect(decideStartupMode(input({ bootRestore: true, hasSession: false }))).toBe("session");
  });

  it("穷举 2^4 输入组合：结果只可能是三态之一且规则稳定", () => {
    const allowed = new Set(["session", "legacy", "skip"]);
    for (const isMain of [true, false]) {
      for (const bootRestore of [true, false]) {
        for (const restoreEnabled of [true, false]) {
          for (const hasSession of [true, false]) {
            const result = decideStartupMode({ isMain, bootRestore, restoreEnabled, hasSession });
            expect(allowed.has(result)).toBe(true);
            // legacy 只可能出现在「主窗口 + 开关开启 + 无会话 + 非恢复窗口」
            if (result === "legacy") {
              expect({ isMain, bootRestore, restoreEnabled, hasSession }).toEqual({
                isMain: true,
                bootRestore: false,
                restoreEnabled: true,
                hasSession: false,
              });
            }
          }
        }
      }
    }
  });
});
