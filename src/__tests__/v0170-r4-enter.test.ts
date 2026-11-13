// @vitest-environment jsdom
/**
 * v0.17.0 第四轮 · T3 `fix-enter-jitter` · 用户第 4 项：
 * **编辑模式下输入回车时页面明显抖动**
 *
 * ## 本文件锁的契约（都是本轮用探针实测出来的，不是推演）
 *
 * 缺陷的真实形态不是"左屏抖"，而是**分屏右屏（iframe 预览）先错跳、再弹回**：
 * ```
 * 左屏 st : 4243 → 4248 → 4263 → 4268 → 4270 → 4271     （smooth +28px，正确）
 * 右屏 deST: 3012 → 3222 → 3225 → 3226 → 3032
 *            ↑ +188（一帧，错）      ↑ −185（弹回）← 用户看到的"抖"
 * ```
 * 抓到的写入栈（未压缩构建，`scripts/v0170-r4-enter-writer.mjs`）：
 * ```
 * +188 帧：setScrollTop ← syncToPreview ← handler2（CM6 onDidScroll）
 * −185 帧：setScrollTop ← syncToPreview ← realignLayoutNow ← syncPreviewAfterToggle
 * ```
 *
 * ## 为什么这些测试是"纯函数 + 源码契约"两层，而不是渲染测试
 * 缺陷发生在 **iframe 跨文档 + CM6 虚拟滚动 + 浏览器 smooth 动画** 三者交互里，
 * jsdom 无法建模任何一项（iframe 不参与布局、没有合成器动画、CM6 的
 * `coordsAtPos` 抛异常）。所以：
 * - **纯函数层**：把本轮引入的判据（物理约束阈值）抽出来断言真值表；
 * - **源码契约层**：锁住"哪几处必须开窗""窗口内 syncToSource 必须早退"
 *   —— 这些是**防线**，一旦有人删掉，探针会在真机上复现，但单测能立刻红。
 *
 * ⚠️ 源码契约测试的边界（诚实声明）：它只能证明"那几行代码在/不在"，
 * **不能**证明行为正确。行为正确性由 `scripts/v0170-r4-enter-rightpane.mjs`
 * 与 `scripts/v0170-r4-enter-wide.mjs` 的逐帧数据负责。两者缺一不可
 * （R3 踩过"纯函数测试绿但 CSS 零 import"的坑，见 `v0152-mode-slide.test.ts`）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALLOW_RATIO, ALLOW_ABS, previewAllowedMove, clampPreviewTarget } from "../utils/scrollSyncPolicy";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PREVIEW_PANE = "src/components/editor/panes/previewpane/PreviewPane.tsx";

/* ═══════════════════════════════════════════════════════════════════════════
 * 一、物理约束判据（本轮新增的核心防线）—— v0.17.0 P1 起改为**有界连续钳制**
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ## ⚠️ P1 返修说明（为什么本节从"二值拒绝真值表"改成"连续钳制行为断言"）
 *
 * R4/R5 的防线是**二值拒绝**：`dRight > allowed` → `return null` 拒写。
 * 实测它有"延迟释放"缺陷：拒写时两个基准（`lastAcceptedPreviewTarget` /
 * `lastAcceptedSourceTop`）**不更新** → 下一帧 `dLeft` 从陈旧基准累积 →
 * `allowed = max(ALLOW_ABS, dLeft×3)` 越攒越大 → 累计跳变被**整包放行**
 * （实测 3 个非内容驱动脱同步帧 + 1 次方向反转，单帧最大 46px）。
 *
 * P1 改为**有界连续钳制**：每帧最多走 `allowed`，余量逐帧追上（右屏平滑
 * 追上而非不动后猛跳）；基准每帧更新（含被钳制的帧）→ 永不陈旧。
 *
 * 阈值与公式抽到 `src/utils/scrollSyncPolicy.ts`，**生产与测试 import 同一
 * 来源** —— 本节断言该共享函数的**行为**（真值表 + 时序回放），不再断言
 * 源码文本里的 `const ALLOW_ABS = …` 数值（R5 把 60 改 16 时，正则断言与
 * 实现永远对不上的那种"确定性失败"不可能再发生）。
 *
 * ## 历史判据试错记录（仍然有效：为什么用"两屏位移幅度比"这一个判据）
 * | 判据 | 结果 | 为什么无效 |
 * |---|---|---|
 * | ① 正逆映射自洽性（正向→反算回源码行） | ❌ 拦不住 | 锚点表整体平移时正逆互逆、仍然"自洽" |
 * | ② 看 `tags` 数 / iframe `scrollHeight` | ❌ 拦不住 | 实测全程恒定（tags=61、sh=6130 一帧没变） |
 * | ③ 两屏位移幅度比（本节） | ✅ 有效 | 正常比值 0.68，猛跳 14.5 倍，物理不可能 |
 *
 * 阈值取值依据（全部实测）：正常跟随比值 0.68/0.73 → `ALLOW_RATIO = 3`
 * （4 倍余量）；`ΔL≈0` 时的正常吸附实测 4~11px → `ALLOW_ABS = 16`
 * （R5 真机验证：60 曾放过 28.66px 的残余错跳）。完整推导表见
 * `src/utils/scrollSyncPolicy.ts` 文件头。
 */

describe("物理约束阈值：生产与测试同源（scrollSyncPolicy 共享常量）", () => {
  it("阈值必须是实测推导出的 3 / 16，且语义是'取大者'兜底", () => {
    expect(ALLOW_RATIO).toBe(3);
    expect(ALLOW_ABS).toBe(16);
    // allowed = max(ALLOW_ABS, |ΔL| × ALLOW_RATIO)：小位移时绝对量兜底占优
    expect(previewAllowedMove(0)).toBe(16);
    expect(previewAllowedMove(1.34)).toBe(16); // R5 残余错跳那帧：ΔL=1.34 → 仍 16
    expect(previewAllowedMove(28)).toBe(84); // 正常跟随（回车，打字机开）：ΔL=28
    expect(previewAllowedMove(400)).toBe(1200); // 用户滚轮大位移：ΔL=400
    expect(previewAllowedMove(-28)).toBe(84); // 幅度取绝对值，方向由调用方处理
  });
});

describe("连续钳制真值表（clampPreviewTarget：二值拒绝的替代者）", () => {
  it("正常跟随（实测 0.68 / 0.73 比值）必须原值放行，零损失", () => {
    expect(clampPreviewTarget(3014, 3034, previewAllowedMove(28))).toBe(3034); // 左+28 / 右+20
    expect(clampPreviewTarget(100, 111, previewAllowedMove(15))).toBe(111); // 左+15 / 右+11
    expect(clampPreviewTarget(3034, 3014, previewAllowedMove(28))).toBe(3014); // 方向反过来同样成立
  });

  it("本轮缺陷的实测猛跳（左+13 / 右+188）：钳到单帧 ≤39px，不是整包放行", () => {
    // 旧二值拒绝：return null 拒写 + 基准不更新（→ 延迟释放）；
    // 连续钳制：本帧只走 allowed = max(16, 13×3=39) = 39
    expect(clampPreviewTarget(3014, 3202, previewAllowedMove(13))).toBe(3053);
    // 回弹那一笔：左屏已停（+1）→ allowed=16，−185 被钳到 −16（基准随之更新）
    expect(clampPreviewTarget(3202, 3017, previewAllowedMove(1))).toBe(3186);
  });

  it("左屏不动时的吸附：≤16px 原值放行，>16px 逐帧追上", () => {
    // R5 实测这类吸附 4~11px，ALLOW_ABS=16 留 ~45% 余量 → 都应原值放行
    expect(clampPreviewTarget(100, 104, previewAllowedMove(0))).toBe(104);
    expect(clampPreviewTarget(100, 111, previewAllowedMove(0))).toBe(111);
    expect(clampPreviewTarget(100, 116, previewAllowedMove(0))).toBe(116); // 恰好 16
    expect(clampPreviewTarget(100, 117, previewAllowedMove(0))).toBe(116); // 17 → 本帧走 16
    // R4 记录的 29px 吸附：本帧走 16，余量由后续帧追上（不再单帧放行）
    expect(clampPreviewTarget(100, 129, previewAllowedMove(0))).toBe(116);
  });

  it("边界：恰好等于上限原值放行，超过 1px 只走上限", () => {
    /**
     * ⚠️ `allowed = max(ALLOW_ABS, |ΔL| × ALLOW_RATIO)` 是**取大者**，
     * 所以 ΔL=10 时 allowed = max(16, 30) = **30** —— 绝对量兜底只在
     * "小位移"区间占优。这一点 R4 写测试时先写错过一次，兜底语义必须钉住：
     * 它是"左屏几乎没动时也允许小幅吸附"这道防线的直接体现。
     */
    expect(clampPreviewTarget(0, 30, previewAllowedMove(10))).toBe(30); // 恰好 30
    expect(clampPreviewTarget(0, 31, previewAllowedMove(10))).toBe(30); // 超 1px → 走 30
    expect(clampPreviewTarget(0, 16, previewAllowedMove(0))).toBe(16); // 兜底区间恰好 16
    expect(clampPreviewTarget(0, 17, previewAllowedMove(0))).toBe(16);
    // 大位移区间是比值占优：ΔL=400 → allowed=1200
    expect(clampPreviewTarget(0, 1200, previewAllowedMove(400))).toBe(1200);
    expect(clampPreviewTarget(0, 1201, previewAllowedMove(400))).toBe(1200);
  });

  it("用户滚轮的大幅滚动必须原值放行（单次 ±300~600px 是常态）", () => {
    // 滚轮一档约 100~140px，两屏比值 0.6~0.8；allowed 给足余量
    expect(clampPreviewTarget(1000, 1084, previewAllowedMove(140))).toBe(1084);
    expect(clampPreviewTarget(1000, 1420, previewAllowedMove(700))).toBe(1420);
  });

  it("首帧（无基准）原值放行", () => {
    expect(clampPreviewTarget(null, 3012, previewAllowedMove(0))).toBe(3012);
  });

  it("非有限输入必须原地不动（映射算坏时绝不写入垃圾值）", () => {
    expect(clampPreviewTarget(100, Number.NaN, previewAllowedMove(0))).toBe(100);
    expect(clampPreviewTarget(100, 200, Number.NaN)).toBe(100);
    expect(clampPreviewTarget(100, 200, Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("时序回放：延迟释放（P1 缺陷形态）必须消失", () => {
  /**
   * 按生产同款状态机回放逐帧同步（与 `PreviewPane.computePreviewTarget`
   * 的钳制分支一一对应）：**每帧都更新两个基准（含被钳制的帧）**。
   */
  function replay(
    start: { target: number; sourceTop: number },
    frames: Array<{ sourceTop: number; next: number }>,
  ) {
    let lastTarget = start.target;
    let lastSourceTop = start.sourceTop;
    const moves: number[] = [];
    const alloweds: number[] = [];
    const out: number[] = [start.target];
    for (const f of frames) {
      const dLeft = Math.abs(f.sourceTop - lastSourceTop);
      const allowed = previewAllowedMove(dLeft);
      const clamped = clampPreviewTarget(lastTarget, f.next, allowed);
      moves.push(Math.abs(clamped - lastTarget));
      alloweds.push(allowed);
      // 关键：基准每帧更新（含被钳制帧）—— 旧二值拒绝正是漏了这一步
      lastTarget = clamped;
      lastSourceTop = f.sourceTop;
      out.push(clamped);
    }
    return { moves, alloweds, out, final: lastTarget };
  }

  it("R6 缺陷回放（左屏微动、映射突跳 +214px）：每帧 ≤ allowed，无整包放行", () => {
    // 实测形态：左屏每帧只动 1px，映射突然说要 +214px 并保持。
    // 旧二值拒绝：拒写若干帧 → dLeft 从陈旧基准累积 → allowed 涨到 >214 →
    // 某一帧把累计差**整包放出**（实测 3 个脱同步帧 + 1 次方向反转，最大 46px）。
    // 连续钳制：每帧走 16px，十余帧内平滑追上，永不猛跳。
    const frames = Array.from({ length: 16 }, (_, i) => ({
      sourceTop: 4243 + i, // ΔL = 1px/帧
      next: i === 0 ? 3012 : 3226, // 映射突跳后保持
    }));
    const r = replay({ target: 3012, sourceTop: 4243 }, frames);
    // ① 每帧位移都不超过该帧的 allowed → 不存在"攒欠账后整包放行"
    expect(r.moves.every((m, i) => m <= r.alloweds[i])).toBe(true);
    expect(Math.max(...r.moves)).toBeLessThanOrEqual(ALLOW_ABS);
    // ② 追帧方向全程单调（无方向反转 —— P1 验收标准）
    const signed = r.out.slice(1).map((v, i) => v - r.out[i]);
    expect(signed.every((d) => d >= 0)).toBe(true);
    // ③ 目标稳定后必然追平（右屏平滑追上，不是不动）
    expect(r.final).toBe(3226);
  });

  it("R5 残余错跳单帧（+28.66px @ ΔL=1.34）：钳到 16px 并逐帧清偿", () => {
    const frames = [
      { sourceTop: 4243 + 1.34, next: 3012 + 28.66 },
      { sourceTop: 4245, next: 3012 + 28.66 },
      { sourceTop: 4246, next: 3012 + 28.66 },
    ];
    const r = replay({ target: 3012, sourceTop: 4243 }, frames);
    expect(r.moves[0]).toBeLessThanOrEqual(ALLOW_ABS); // 28.66 → 本帧只走 16
    expect(r.moves.every((m, i) => m <= r.alloweds[i])).toBe(true);
    expect(r.final).toBeCloseTo(3040.66, 5); // 余量 12.66 由下一帧追平
  });

  it("正常跟随（回车实测序列）全程零钳制：修复不得伤及平滑跟随", () => {
    // R4 实测：左 4243→4271（+28），右屏比值 0.68（+20），逐帧跟随
    const frames = [
      { sourceTop: 4248, next: 3017 },
      { sourceTop: 4263, next: 3030 },
      { sourceTop: 4268, next: 3033 },
      { sourceTop: 4270, next: 3035 },
      { sourceTop: 4271, next: 3035 },
    ];
    const r = replay({ target: 3014, sourceTop: 4243 }, frames);
    // 与原始映射逐帧相等 = 钳制从未介入（正常跟随零损失）
    expect(r.out.slice(1)).toEqual([3017, 3030, 3033, 3035, 3035]);
    expect(r.moves.every((m, i) => m <= r.alloweds[i])).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 二、源码契约：三处必须开窗 + 一处必须早退
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("源码契约：打字机平滑窗口", () => {
  const src = read(PREVIEW_PANE);

  it("窗口常量与 ref 必须存在（删了它们三处开窗就失效）", () => {
    expect(src).toMatch(/TYPEWRITER_SMOOTH_WINDOW_MS\s*=\s*\d+/);
    expect(src).toMatch(/typewriterSmoothUntilRef\s*=\s*useRef\(0\)/);
    expect(src).toMatch(/markTypewriterSmooth/);
  });

  it("窗口只由打字机的 smooth 写入开启（不是任何写滚动都开）", () => {
    // markTypewriterSmooth 的调用点必须恰好 3 处：
    //   ① scrollCursorToCenter（编辑面）
    //   ② handleKeyUp 普通字符偏离中央分支（编辑面）
    //   ③ 阅读面 scrollToCenter（ProseMirror）
    const calls = src.match(/markTypewriterSmooth\(\);/g) ?? [];
    expect(calls.length).toBe(3);
  });

  it("三处开窗都紧邻 smooth 写入（顺序错就等于没开窗）", () => {
    /**
     * ⚠️ 用**行级**扫描而不是 `indexOf("…markTypewriterSmooth();\n…writeScrollTop…")`：
     * 第一版那样写会命中**注释里**的示例代码（注释里也写着
     * `writeScrollTop(target, "smooth")`）→ 断言恒假。
     * 这正是"判据把正确代码判红"的经典形态，必须用结构化的判断。
     *
     * 判据：找出所有 `markTypewriterSmooth();` 的**代码行**，
     * 其**下一非空代码行**必须是三种之一的 smooth 写入。
     */
    const lines = src.split(/\r?\n/);
    const smoothWritePatterns = [
      /^\s*writeScrollTop\(target, "smooth"\);$/,
      /^\s*scrollContainer\.scrollTo\(\{ top: target, behavior: "smooth" \}\);$/,
    ];
    const opens: Array<{ line: number; next: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      // 只认**代码行**（去掉行首空白后以 markTypewriterSmooth 开头）
      // 注释行以 * // /* 开头，会被这条排除
      if (!/^\s*markTypewriterSmooth\(\);$/.test(lines[i])) continue;
      // 找回下一行非空
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      opens.push({ line: i + 1, next: lines[j] ?? "" });
    }
    expect(opens.length).toBe(3);
    for (const o of opens) {
      expect(
        smoothWritePatterns.some((p) => p.test(o.next)),
        `第 ${o.line} 行的 markTypewriterSmooth() 之后必须紧跟 smooth 写入，实际下一行是：${o.next}`,
      ).toBe(true);
    }
  });

  it("syncToSource 必须在窗口内早退（这是消除 −185px 回弹的唯一防线）", () => {
    /**
     * 回弹机制：右屏写入派发的 scroll 事件**晚于**方向锁 250ms 才到 →
     * `syncToSource` 把回声当用户操作 → 反算写左屏 → `realignLayoutNow`
     * 又 force 写右屏。所以必须在 `syncToSource` 开头按时间窗口拦掉。
     */
    const idx = src.indexOf("const syncToSource = () => {");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2000);
    expect(body).toMatch(/if \(performance\.now\(\) < typewriterSmoothUntilRef\.current\) return;/);
  });

  it("窗口必须在动画期每次写入时**续期**，且续期条件带窗口判定", () => {
    /**
     * 为什么必须续期：iframe 内部文档的 scroll 事件比主文档晚约 140ms 才到
     * （实测：动画末次写入 @300ms，回声 @441ms）。若只在发起时开一次窗，
     * 掉帧拖长动画后就会滑出窗口 → 回弹复现。
     * 为什么条件是 `!force && now < 窗口`：无条件续期会让**用户滚轮**
     * （每次滚都写右屏）永久续期 → 双向联动被屏蔽成单向。
     */
    expect(src).toMatch(/if \(!force && performance\.now\(\) < typewriterSmoothUntilRef\.current\) \{\s*\n\s*typewriterSmoothUntilRef\.current = performance\.now\(\) \+ TYPEWRITER_SMOOTH_WINDOW_MS;/);
  });
});

describe("源码契约：computePreviewTarget 的三条分支语义", () => {
  const src = read(PREVIEW_PANE);

  it("物理约束必须走共享连续钳制（行为由第一节真值表锁，这里只锁'生产真的在用它'）", () => {
    /**
     * ⚠️ P1 起**不再断言源码文本里的阈值数值**（`const ALLOW_ABS = 60;`
     * 这种正则曾因实现改成 16 而确定性失败 —— 不是 flaky，是断言与实现
     * 永远对不上）。数值与公式的行为契约在第一节（scrollSyncPolicy
     * 真值表 + 时序回放）里；本测试只锁三件事：
     * ① 生产 import 并调用共享模块（阈值/公式与测试同源）；
     * ② 钳制发生在写入前，且钳制后的值（不是原始 next）才是写入基准；
     * ③ 旧"二值拒绝"路径（preview-sync-skip 拒写）已废除。
     */
    const idx = src.indexOf("const computePreviewTarget");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 4200);
    expect(body).toMatch(/previewAllowedMove\(/);
    expect(body).toMatch(/clampPreviewTarget\(/);
    // 钳制结果 = 写入基准：lastAcceptedPreviewTarget = clamped（不是 next）
    expect(body).toMatch(/lastAcceptedPreviewTarget = clamped;\s*\n\s*lastAcceptedSourceTop = sourceTop;\s*\n\s*return clamped;/);
    // 二值拒绝已废除：拒写 + 基准不更新的"preview-sync-skip"路径不得回归
    expect(body).not.toMatch(/preview-sync-skip/);
    // 阈值不再就地硬编码（必须来自共享模块）
    expect(body).not.toMatch(/const ALLOW_ABS =/);
    // 生产与测试必须 import 同一共享模块
    expect(src).toMatch(/import \{[^}]*\} from "[^"]*utils\/scrollSyncPolicy"/);
  });

  it("有锚点表但映射不出目标时，**不得**退回百分比映射", () => {
    /**
     * 实测：同一位置百分比映射给 3213、块锚点映射给 3032，差 181px ——
     * 正是那次猛跳的量级。两套口径混用就等于"两段动"。
     * 只有**完全拿不到锚点表**时才允许退回百分比（v0.13.x 的兜底语义）。
     */
    const idx = src.indexOf("const computePreviewTarget");
    const body = src.slice(idx, idx + 4200);
    // 锚点分支里 return null 之后，才轮到百分比
    const anchorBranchReturnNull = body.indexOf("return null;");
    const pctBranch = body.indexOf("computeSyncScrollTop(");
    expect(anchorBranchReturnNull).toBeGreaterThan(-1);
    expect(pctBranch).toBeGreaterThan(anchorBranchReturnNull);
  });

  it("computeSyncScrollTop 只在锚点表为 null 的兜底路径上出现一次", () => {
    const idx = src.indexOf("const computePreviewTarget");
    const body = src.slice(idx, idx + 4200);
    expect((body.match(/computeSyncScrollTop\(/g) ?? []).length).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 三、算法层：判据用的分析函数（防止"判据恒真/恒假"）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 把逐帧 `scrollTop` 序列压成"抖/不抖"指标。
 *
 * ⚠️ 方向反转必须忽略亚像素毛刺：单段反向累计 ≤5px 并入主方向。
 * 依据见 `_plan/v0170-r3-t2-scroll-jitter.md` §1——R3 在阅读面（已知平滑的
 * 参考实现）上踩过"`-3, 0, +3` 被判一次反转"的判据 bug。
 */
export function summarizeScroll(topSeq: number[], noisePx = 5) {
  if (topSeq.length < 2) return { valid: false, n: topSeq.length, maxJump: 0, reversals: 0, net: 0, nonzero: 0 };
  const deltas: number[] = [];
  for (let i = 1; i < topSeq.length; i++) deltas.push(Math.round((topSeq[i] - topSeq[i - 1]) * 100) / 100);
  const maxJump = deltas.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
  const nz = deltas.filter((d) => Math.abs(d) >= 0.05);
  const runs: number[] = [];
  let acc = 0;
  for (const d of nz) {
    const s = d > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== s) {
      if (runs.length > 0 && Math.abs(acc) <= noisePx) runs[runs.length - 1] = s;
      else runs.push(s);
      acc = 0;
    }
    acc += d;
  }
  return {
    valid: true,
    n: topSeq.length,
    maxJump: Math.round(maxJump * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    net: Math.round((topSeq[topSeq.length - 1] - topSeq[0]) * 100) / 100,
    nonzero: nz.length,
  };
}

describe("分析函数真值表（证明判据有区分力，不恒真也不恒假）", () => {
  it("完全不动 → 0 跳变 / 0 反转（OFF 组正确形态）", () => {
    const r = summarizeScroll([4019, 4019, 4019, 4019]);
    expect(r.maxJump).toBe(0);
    expect(r.reversals).toBe(0);
    expect(r.net).toBe(0);
  });

  it("单调平滑上移（ON 组正确形态）→ 有跳变但 0 反转", () => {
    const r = summarizeScroll([4243, 4248, 4263, 4268, 4270, 4271]);
    expect(r.reversals).toBe(0);
    expect(r.net).toBe(28);
    expect(r.maxJump).toBeLessThanOrEqual(16);
  });

  it("先上后下（本轮缺陷形态）→ 至少 1 次反转", () => {
    const r = summarizeScroll([3012, 3222, 3225, 3226, 3032]);
    expect(r.reversals).toBeGreaterThanOrEqual(1);
    expect(r.maxJump).toBeGreaterThan(100);
  });

  it("亚像素毛刺不算反转（R3 的判据 bug 回归防线）", () => {
    // 阅读面实测过的形态：-3, 0, +3 是点击落点噪声，不是回弹
    const r = summarizeScroll([100, 97, 97, 100, 103]);
    expect(r.reversals).toBe(0);
  });

  it("真正的多帧回弹必须算反转（不能被噪声门槛吞掉）", () => {
    const r = summarizeScroll([100, 130, 160, 190, 150, 110, 70]);
    expect(r.reversals).toBe(1);
  });
});
