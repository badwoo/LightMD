/**
 * 共享工具：**渐进滚动到目标位置**（模拟用户滚轮/拖动滚动条的真实过程）
 *
 * ## 为什么必须渐进（本轮踩到的坑）
 * CM6 的 `scrollHeight` 来自 heightMap：**没被渲染/测量过的区块用估算高度**。
 * 探针里直接 `sc.scrollTop = (scrollHeight-clientHeight)*0.5` 是"瞬移"——
 * 视口上方的内容从未被测量过，估算值很粗。随后任何一次 dispatch 触发重新测量，
 * 估算被修正 → 估算总量变化上千像素 → 视口中央的**内容**就变了（PI30 → PI37）。
 *
 * 这个伪影会被误读成"滚动跳动缺陷"，实际上真实用户滚轮滚动时 CM6 是**逐段测量**的，
 * 不出现这种修正跳变。所以探针必须先真实滚到目标位置，再测缺陷。
 *
 * 用 CDP 的 `Input.dispatchMouseEvent`（type=mouseWheel）驱动真实滚轮滚动：
 * 它走浏览器的原生滚动路径，CM6 会按滚动过程逐段测量。
 */
import { runBrowserProbe } from "./browser-probe.mjs";

/** 页面内：读视口中心所在行的段落编号 + 滚动几何 + 焦点 */
export const READ_STATE = `
  const round = (n) => Math.round(n);
  const sc = document.querySelector(".cm-scroller");
  if (!sc) return { ok: false, reason: "no scroller" };
  const scR = sc.getBoundingClientRect();
  const midY = scR.top + sc.clientHeight / 2;
  const lines = Array.from(sc.querySelectorAll(".cm-line"));
  /**
   * ⚠️ 只取"覆盖视口中线的那一行"不够：文档窄（分屏 517px）时段落会**软换行**，
   * 覆盖中线的往往是续行，文本里没有 PIxx 标记 → 段号读成 null。
   * 因此改为：取"含 PIxx 且离中线最近"的行作为内容锚，同时记录它相对视口顶的 Y。
   * piTop 是比"段号相等"更细的判据（同一段内部偏了几像素也能看出来）。
   */
  let best = null, bestD = Infinity;
  for (const l of lines) {
    const t = l.textContent || "";
    if (!/PI\\d{2}/.test(t)) continue;
    const r = l.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - midY);
    if (d < bestD) { bestD = d; best = l; }
  }
  const txt = best ? (best.textContent || "") : "";
  const m = /PI(\\d{2})/.exec(txt);
  const ae = document.activeElement;
  const caret = document.querySelector(".cm-cursor");
  const caretR = caret ? caret.getBoundingClientRect() : null;
  return {
    ok: true,
    st: round(sc.scrollTop),
    max: round(sc.scrollHeight - sc.clientHeight),
    sh: round(sc.scrollHeight),
    ch: round(sc.clientHeight),
    pi: m ? Number(m[1]) : null,
    /** 锚行顶部相对视口顶的 Y（负 = 已滚出视口上方） */
    piTop: best ? round(best.getBoundingClientRect().top - scR.top) : null,
    ae: ae ? ((ae.className || ae.tagName) + "").slice(0, 40) : "none",
    focused: !!document.querySelector(".cm-focused"),
    caretY: caretR ? round(caretR.top - scR.top) : null,
    caretVisible: caretR ? (caretR.top >= scR.top - 2 && caretR.bottom <= scR.bottom + 2) : null,
  };
`;

/** 页面内：启动逐帧采样（16ms），记录 scrollTop / 视口中心段号 / 焦点 */
export const startFrameTrace = (ms) => `
  window.__FT = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        const scR = sc.getBoundingClientRect();
        const midY = scR.top + sc.clientHeight / 2;
        const lines = Array.from(sc.querySelectorAll(".cm-line"));
        let cl = null;
        for (const l of lines) {
          const r = l.getBoundingClientRect();
          if (r.top <= midY && r.bottom >= midY) { cl = l; break; }
        }
        const txt = cl ? (cl.textContent || "") : "";
        const m = /PI(\\d{2})/.exec(txt);
        const ae = document.activeElement;
        window.__FT.push({
          t: Math.round(performance.now() - t0),
          st: Math.round(sc.scrollTop),
          max: Math.round(sc.scrollHeight - sc.clientHeight),
          pi: m ? Number(m[1]) : null,
          top: cl ? Math.round(cl.getBoundingClientRect().top - scR.top) : null,
          ae: ae ? ((ae.className || ae.tagName) + "").slice(0, 18) : "none",
        });
      }
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

/** 汇总逐帧采样 */
export const summarizeFrames = (samples) => {
  const pis = samples.map((s) => s.pi);
  const sts = samples.map((s) => s.st);
  let maxJump = 0, jumpAt = null;
  for (let i = 1; i < sts.length; i++) {
    const d = Math.abs(sts[i] - sts[i - 1]);
    if (d > maxJump) { maxJump = d; jumpAt = { t: samples[i].t, from: sts[i - 1], to: sts[i] }; }
  }
  const piChanges = [];
  for (let i = 1; i < pis.length; i++) if (pis[i] !== pis[i - 1]) piChanges.push({ t: samples[i].t, from: pis[i - 1], to: pis[i] });
  const tops = samples.map((s) => s.top).filter((v) => v != null);
  return {
    n: samples.length,
    stFirst: sts[0] ?? null, stLast: sts[sts.length - 1] ?? null,
    stMin: sts.length ? Math.min(...sts) : null,
    stMax: sts.length ? Math.max(...sts) : null,
    maxJump, jumpAt,
    piFirst: pis[0] ?? null, piLast: pis[pis.length - 1] ?? null,
    piChanges: piChanges.slice(0, 10),
    topUniq: [...new Set(tops)].length,
    maxLast: samples.length ? samples[samples.length - 1].max : null,
    hitBottom: sts.some((v, i) => samples[i].max != null && v >= samples[i].max - 2),
    aeUniq: [...new Set(samples.map((s) => s.ae))].slice(0, 8),
  };
};

/**
 * 用真实滚轮事件滚动到目标比例（渐进）。
 *
 * @param ui 探针 ui
 * @param pct 目标滚动比例 0..1
 * @param opts.step 每步像素（默认 120）
 */
export async function wheelScrollToPercent(ui, pct, opts = {}) {
  const step = opts.step ?? 120;
  const scrollerPoint = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      st: Math.round(sc.scrollTop),
      max: Math.round(sc.scrollHeight - sc.clientHeight),
    };
  `);
  if (!scrollerPoint) return null;

  const target = Math.round(scrollerPoint.max * pct);
  let cur = (await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`));

  // 向上先滚回顶部（负 deltaY），再向下滚到目标 —— 保证测量覆盖整段
  let guard = 0;
  while (cur > 8 && guard++ < 400) {
    await ui.wheel(scrollerPoint.x, scrollerPoint.y, -Math.min(step * 4, cur));
    cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
  }
  guard = 0;
  while (cur < target - 8 && guard++ < 600) {
    const remain = target - cur;
    const dy = Math.min(step, remain);
    await ui.wheel(scrollerPoint.x, scrollerPoint.y, dy);
    const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    if (next === cur) break; // 已到底或滚不动
    cur = next;
  }
  // 等布局/heightMap 稳定
  await ui.sleep(opts.settle ?? 500);
  return await ui.ev(READ_STATE);
}
