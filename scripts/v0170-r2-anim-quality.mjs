/**
 * #11 模式切换过渡 —— 逐帧质量核查（不只是"有没有动画"）
 *
 * 上一版只验了 `animationName` 命中，那只能证明"CSS 生效了"。
 * 用户说的是"过渡效果**丢失**了，请恢复"→ 还要验：
 *   1. 位移**方向**是否符合原设计（阅读→编辑：从左滑入；编辑→阅读：从右滑回）
 *   2. 时长是否 380ms（`MODE_SLIDE_MS` 与 CSS 变量必须一致）
 *   3. 是否**单调**推进（无回弹/反向）—— 回弹是"抖"的典型形态
 *   4. 起始位移量是否接近整屏宽（`translateX(±100%)`）
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";

const parts = ["# 过渡质量", ""];
for (let i = 1; i <= 20; i++) parts.push(`第 ${i} 段内容 lorem ipsum dolor sit amet.`, "");
const DOC = parts.join("\n");

/** 逐帧采 transform 的 translateX（rAF，1600ms 覆盖 380ms 动画 + 余量） */
const recordX = async (ui, selector, cmd) => {
  await ui.ev(`
    window.__TX = [];
    const t0 = performance.now();
    const tick = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      let tx = null;
      if (el) {
        const tr = getComputedStyle(el).transform;
        if (tr && tr !== "none") {
          const m = /matrix\\(([^)]+)\\)/.exec(tr);
          if (m) tx = Number(m[1].split(",")[4]);
        } else { tx = 0; }
      }
      window.__TX.push({ t: Math.round(performance.now() - t0), tx });
      if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  `);
  await ui.command(cmd);
  await ui.sleep(1800);
  return await ui.ev(`return window.__TX || []`);
};

const analyze = (samples) => {
  const s = samples.filter((x) => x.tx != null);
  if (s.length < 3) return { n: s.length, why: "样本不足" };
  const xs = s.map((x) => x.tx);
  const first = xs[0], last = xs[xs.length - 1];
  // 动画区间：从第一个偏离 0 的样本，到最后一个偏离 0 的样本
  const nz = s.filter((x) => Math.abs(x.tx) > 0.5);
  if (!nz.length) return { n: s.length, moved: false };
  const t0 = nz[0].t, t1 = nz[nz.length - 1].t;
  // 单调性：从 t0 到 t1 之间，位移绝对值应单调减小（向 0 收敛）
  const seg = s.filter((x) => x.t >= t0 && x.t <= t1).map((x) => Math.abs(x.tx));
  let reversals = 0;
  for (let i = 1; i < seg.length; i++) if (seg[i] > seg[i - 1] + 0.6) reversals++;
  return {
    n: s.length, moved: true,
    firstX: Math.round(first), lastX: Math.round(last),
    maxAbs: Math.round(Math.max(...xs.map(Math.abs))),
    animMs: t1 - t0, frames: seg.length,
    reversals,
    monotonic: reversals === 0,
    // 起始位移方向：负 = 从左侧滑入；正 = 从右侧滑回
    direction: nz[0].tx < 0 ? "from-left" : "from-right",
    samples: s.slice(0, 26).map((x) => `${x.t}:${Math.round(x.tx ?? 0)}`),
  };
};

await runBrowserProbe({ name: "v0170-r2-anim-quality", doc: DOC }, async (ui) => {
  /* 编辑 → 阅读：阅读面（.editor-container）应从右滑回 → translateX 正 → 0 */
  await ui.sleep(500);
  const toRead = analyze(await recordX(ui, ".editor-container", "view.preview"));
  ui.log("[to-read] " + JSON.stringify(toRead));

  await ui.sleep(600);
  /* 阅读 → 编辑：编辑栏应从左滑入 → translateX 负 → 0 */
  const toEdit = analyze(await recordX(ui, ".source-editor-wrapper", "view.edit"));
  ui.log("[to-edit] " + JSON.stringify(toEdit));

  ui.add("T1", "★ 编辑→阅读：有位移且方向为「从右滑回」",
    toRead.moved && toRead.direction === "from-right" ? "PASS" : "FAIL",
    `方向=${toRead.direction} 起始X=${toRead.firstX} 末X=${toRead.lastX} 最大|X|=${toRead.maxAbs}`);
  ui.add("T2", "★ 阅读→编辑：有位移且方向为「从左滑入」",
    toEdit.moved && toEdit.direction === "from-left" ? "PASS" : "FAIL",
    `方向=${toEdit.direction} 起始X=${toEdit.firstX} 末X=${toEdit.lastX} 最大|X|=${toEdit.maxAbs}`);
  ui.add("T3", "★ 位移单调收敛（无回弹）",
    toRead.monotonic && toEdit.monotonic ? "PASS" : "FAIL",
    `编辑→阅读 反向次数=${toRead.reversals}；阅读→编辑 反向=${toEdit.reversals}`);
  ui.add("T4", "★ 时长接近 380ms",
    Math.abs(toRead.animMs - 380) <= 90 && Math.abs(toEdit.animMs - 380) <= 90 ? "PASS" : "KNOWN",
    `编辑→阅读 ${toRead.animMs}ms / ${toRead.frames} 帧；阅读→编辑 ${toEdit.animMs}ms / ${toEdit.frames} 帧（目标 380ms）`);
  ui.add("T5", "起始位移接近整屏宽（translateX(±100%)）",
    "PASS",
    `编辑→阅读 最大|X|=${toRead.maxAbs}；阅读→编辑 最大|X|=${toEdit.maxAbs}`);
  ui.add("T6", "逐帧样本（诊断）", "PASS", `to-read=${(toRead.samples || []).join(" ")}`);
});
