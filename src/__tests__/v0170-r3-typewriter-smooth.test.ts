/**
 * v0.17.0 第三轮 · T2 · 第 8 项单元测试：**打字机平滑能力通道**
 *
 * ## 为什么这些断言值得写（它们锁住的是"语义分离"，不是实现形态）
 *
 * 第 8 项的修法是"给 surface 加一条平滑通道"，很容易被后人"顺手优化"掉：
 * - 有人会把 `setScrollTopSmooth` 合并进 `setScrollTop(px, behavior)` —— 那会让
 *   几十处**恢复类**调用点（进度恢复/撤销恢复/预览开合冻结还原）静默变成 smooth，
 *   重演"模式切换后滚动位置丢失"那个历史 bug；
 * - 有人会把 `setScrollTop` 本身改成 `scrollTo({behavior})` —— 同样的问题。
 *
 * 所以这里断言的是**契约**：
 * A. `setScrollTop` 必须是"写完即到位"（同步可读回），不能是异步动画；
 * B. `setScrollTopSmooth(px, "instant")` 也必须即时到位（等价于 setScrollTop）；
 * C. `setScrollTopSmooth` 在接口上是**可选**方法（未实现方仍能类型通过）；
 * D. 两个实现（CM6 / textarea）**都必须**实现它（否则降级路径会丢平滑）；
 * E. `PreviewPane.writeScrollTop` 的分派必须"优先平滑能力、缺失时退回即时"。
 *
 * D/E 用源码结构断言（本项目既有做法，见 `v0152-mode-slide.test.ts` 的教训：
 * 读源文件只能证明"代码形态对"，证明不了"运行时生效" —— 所以运行时结论在
 * `scripts/v0170-r3-typewriter-smooth.mjs` 里用真实浏览器测，两者互补）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("A. `setScrollTop` 必须保持『即时』语义（不能被改成动画）", () => {
  const types = read("src/editor/types.ts");

  it("接口里 setScrollTop 的签名不带 behavior 参数", () => {
    // 若有人加了 behavior 参数，说明开始往"一个方法两种语义"的方向滑
    const m = /setScrollTop\(px: number\): void;/.exec(types);
    expect(m, "types.ts 应保留 `setScrollTop(px: number): void;`").toBeTruthy();
  });

  it("平滑能力是**可选**方法（`?`），这样未实现方仍能类型通过", () => {
    expect(types).toMatch(/setScrollTopSmooth\?\(px: number, behavior\?: "smooth" \| "instant"\): void;/);
  });

  it("CM6 的 setScrollTop 是裸赋值（不是 scrollTo({behavior})）", () => {
    const cm6 = read("src/editor/cm6/CmSourceSurface.ts");
    const body = /setScrollTop\(px: number\): void \{([\s\S]*?)\n  \}/.exec(cm6);
    expect(body, "应能找到 CmSourceSurface.setScrollTop 方法体").toBeTruthy();
    const src = body![1];
    // 只允许直接赋值；不允许在 setScrollTop 内部出现 scrollTo
    expect(src).toContain("scrollDOM.scrollTop = px");
    // ⚠️ 不能用 not.toContain("scrollTo")：`scrollTop` 本身就包含该子串。
    // 这里查的是**调用形态** `scrollTo(`
    expect(src, "setScrollTop 内部不得调用 scrollTo(...)（否则恢复类调用点会被动画化）").not.toContain("scrollTo(");
  });

  it("textarea 的 setScrollTop 是裸赋值", () => {
    const ta = read("src/editor/surface/TextareaSourceSurface.ts");
    const body = /setScrollTop\(px: number\): void \{([\s\S]*?)\n  \}/.exec(ta);
    expect(body).toBeTruthy();
    const src = body![1];
    expect(src).toContain("ta.scrollTop = px");
    expect(src, "setScrollTop 内部不得调用 scrollTo(...)").not.toContain("scrollTo(");
  });
});

describe("B. 两个 surface 实现都必须提供平滑能力（否则降级路径丢平滑）", () => {
  const cm6 = read("src/editor/cm6/CmSourceSurface.ts");
  const ta = read("src/editor/surface/TextareaSourceSurface.ts");

  it("CmSourceSurface 实现了 setScrollTopSmooth 且用 scrollTo({behavior})", () => {
    expect(cm6).toContain("setScrollTopSmooth(px: number");
    expect(cm6).toMatch(/scrollTo\(\{\s*top,\s*behavior:\s*"smooth"\s*\}\)/);
  });

  it("TextareaSourceSurface 同样实现了（两实现必须同观感）", () => {
    expect(ta).toContain("setScrollTopSmooth(px: number");
    expect(ta).toMatch(/scrollTo\(\{\s*top,\s*behavior:\s*"smooth"\s*\}\)/);
  });

  it("两个实现的 instant 分支都是即时写入（不是动画）", () => {
    // instant 走裸赋值是这两条通道"语义分离"的保证
    const cm6Body = /setScrollTopSmooth\(px: number, behavior[^)]*\): void \{([\s\S]*?)\n  \}/.exec(cm6);
    const taBody = /setScrollTopSmooth\(px: number, behavior[^)]*\): void \{([\s\S]*?)\n  \}/.exec(ta);
    expect(cm6Body).toBeTruthy();
    expect(taBody).toBeTruthy();
    expect(cm6Body![1]).toMatch(/behavior === "instant"[\s\S]*?el\.scrollTop = px/);
    expect(taBody![1]).toMatch(/behavior === "instant"[\s\S]*?ta\.scrollTop = px/);
  });

  it("两实现都钳制到 [0, max]（避免不同内核钳位时机不一致导致首帧方向反了）", () => {
    for (const src of [cm6, ta]) {
      const body = /setScrollTopSmooth\(px: number, behavior[^)]*\): void \{([\s\S]*?)\n  \}/.exec(src);
      expect(body![1]).toMatch(/Math\.max\(0, Math\.min\(max, px\)\)/);
    }
  });
});

describe("C. PreviewPane 的 writeScrollTop 分派：优先平滑、缺失退回即时", () => {
  const pane = read("src/components/editor/panes/previewpane/PreviewPane.tsx");

  it("CM6 分支使用 setScrollTopSmooth 并把 behavior 透传下去（修复前 behavior 被丢弃）", () => {
    const body = /const writeScrollTop = \(top: number, behavior: "smooth" \| "instant"\) => \{([\s\S]*?)\n    \};/.exec(pane);
    expect(body, "应能找到 writeScrollTop").toBeTruthy();
    const src = body![1];
    expect(src, "必须调用 setScrollTopSmooth 并传 behavior").toMatch(/setScrollTopSmooth\(top, behavior\)/);
    expect(src, "必须保留 setScrollTop 兜底（实现缺失时不能什么都不做）").toContain("sourceSurface.setScrollTop(top)");
  });

  it("平滑通道的调用发生在打字机居中路径上（不是恢复路径）", () => {
    // 打字机的两处 smooth 写入：scrollCursorToCenter 与 handleKeyUp 的普通字符分支
    const calls = pane.match(/writeScrollTop\([^)]*"smooth"\)/g) || [];
    expect(calls.length, "打字机路径上应至少有 2 处 smooth 写入（居中 + keyup 偏离）").toBeGreaterThanOrEqual(2);
  });

  it("isRestoringScrollRef 防线仍然存在且先于打字机滚动（历史 bug 不能回归）", () => {
    // 这条防线是为了阻止 smooth 覆盖 applyScroll 的 instant
    expect(pane).toContain("if (isRestoringScrollRef.current) return;");
    // handleKeyUp 内必须先消费基线、再判恢复态（顺序不能颠倒）
    const keyUp = /const handleKeyUp = \(e: KeyboardEvent\) => \{([\s\S]*?)\n    \};/.exec(pane);
    expect(keyUp).toBeTruthy();
    const src = keyUp![1];
    const iConsume = src.indexOf("consumeScrollKeyUp");
    const iRestore = src.indexOf("isRestoringScrollRef.current");
    expect(iConsume, "keyup 应先 consumeScrollKeyUp").toBeGreaterThanOrEqual(0);
    expect(iRestore, "keyup 应检查 isRestoringScrollRef").toBeGreaterThanOrEqual(0);
    expect(iConsume).toBeLessThan(iRestore);
  });

  it("shouldSkipInitialScrollToCenter 仍在初始居中前被调用（恢复期一律 skip）", () => {
    expect(pane).toMatch(
      /if \(!shouldSkipInitialScrollToCenter\(isRestoringScrollRef\.current, typewriterModeRef\.current\)\)/,
    );
  });
});

describe("D. 行为契约（用最小 stub 验证『instant 分支确实即时』）", () => {
  /** 最小 fake scrollDOM/textarea：记录 scrollTo 与直接赋值的区别 */
  function makeFakeEl(initial = 0) {
    const state = {
      scrollTop: initial,
      scrollHeight: 1000,
      clientHeight: 200,
      scrollToCalls: [] as Array<{ top: number; behavior?: string }>,
      assignCalls: 0,
    };
    return {
      state,
      el: {
        get scrollTop() {
          return state.scrollTop;
        },
        set scrollTop(v: number) {
          state.assignCalls++;
          state.scrollTop = Math.max(0, Math.min(state.scrollHeight - state.clientHeight, v));
        },
        scrollHeight: state.scrollHeight,
        clientHeight: state.clientHeight,
        scrollTo(opts: { top: number; behavior?: string }) {
          state.scrollToCalls.push(opts);
          // 模拟 instant：立即到位（真实浏览器 smooth 是异步的，这里只验"调用了谁"）
          if (opts.behavior === "instant") state.scrollTop = opts.top;
        },
      },
    };
  }

  it("CM6 风格实现：instant 走赋值、smooth 走 scrollTo", () => {
    const { el, state } = makeFakeEl(100);
    // 复刻 CmSourceSurface.setScrollTopSmooth 的分支逻辑
    const setScrollTopSmooth = (px: number, behavior: "smooth" | "instant" = "smooth") => {
      if (behavior === "instant") {
        el.scrollTop = px;
        return;
      }
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTo({ top: Math.max(0, Math.min(max, px)), behavior: "smooth" });
    };

    setScrollTopSmooth(500, "instant");
    expect(state.assignCalls, "instant 必须走直接赋值").toBe(1);
    expect(state.scrollToCalls.length, "instant 不得调用 scrollTo").toBe(0);
    expect(state.scrollTop, "instant 必须即时到位").toBe(500);

    setScrollTopSmooth(800);
    expect(state.scrollToCalls.length, "smooth 必须走 scrollTo").toBe(1);
    expect(state.scrollToCalls[0].behavior).toBe("smooth");
  });

  it("越界值被钳制到 [0, max]（不同内核钳位时机不一致）", () => {
    const { el } = makeFakeEl(0);
    const fn = (px: number) => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      return { top: Math.max(0, Math.min(max, px)) };
    };
    expect(fn(-50).top).toBe(0);
    expect(fn(99999).top).toBe(800); // 1000 - 200
    expect(fn(300).top).toBe(300);
  });
});
