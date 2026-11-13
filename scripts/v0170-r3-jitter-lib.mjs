/**
 * v0.17.0 第三轮 · T2「滚动/布局抖动」探针共用工具
 *
 * ## 为什么单独一份（而不是复用 `_lib/scroll-probe.mjs`）
 *
 * 那份是**滚动位置**探针（撤销/恢复判"内容有没有变"），它的逐帧采样只记
 * `scrollTop / pi / top`。本轮的三个问题需要的是**"运动曲线"**：
 *   · #1/#4 判"抖动" → 需要 `scrollTop` 的**一阶差分（单帧跳变）**与**方向反转**
 *   · #8  判"平滑"   → 需要单帧位移**占总位移的比例**与**单调性**
 *   · #12 判"平滑"   → 需要**左缘 X** 的时间序列 + **二阶差分**（加速度突变）
 *
 * 所以这里给的是「曲线分析」而非「两点比较」。判据口径见 `_plan/v0170-r3-t2-scroll-jitter.md`
 * 的「量化口径」一节 —— **口径必须先于修复确定**，否则就是"改完再挑一个能过的指标"。
 */

/** 页面内：启动逐帧采样（rAF，约 16ms 一帧） */
export const startTrace = (opts) => {
  const sel = JSON.stringify(opts.selector);
  const msRaw = opts.ms ?? 2000;
  const anchor = JSON.stringify(opts.anchorText ?? null);
  const kind = JSON.stringify(opts.kind ?? "cm");
  return `
  window.__TR = [];
  window.__KEYS = [];
  (function () {
    const t0 = performance.now();
    window.__T0 = t0;
    const SEL = ${sel};
    const KIND = ${kind};
    const ANCHOR = ${anchor};
    const el0 = document.querySelector(SEL);
    const tick = () => {
      const el = document.querySelector(SEL);
      const rec = { t: Math.round(performance.now() - t0) };
      if (el) {
        rec.st = Math.round(el.scrollTop * 100) / 100;
        rec.sh = Math.round(el.scrollHeight);
        rec.ch = Math.round(el.clientHeight);
        rec.max = Math.round(el.scrollHeight - el.clientHeight);
        rec.padL = Math.round(parseFloat(getComputedStyle(el).paddingLeft) * 100) / 100;
      }
      if (KIND === "cm") {
        // 内容锚：含 PIxx 且离视口中线最近的行
        if (el) {
          const er = el.getBoundingClientRect();
          const midY = er.top + el.clientHeight / 2;
          let best = null, bestD = Infinity;
          for (const l of el.querySelectorAll(".cm-line")) {
            const txt = l.textContent || "";
            if (!/PI\\d{2}/.test(txt)) continue;
            const r = l.getBoundingClientRect();
            const d = Math.abs((r.top + r.bottom) / 2 - midY);
            if (d < bestD) { bestD = d; best = l; }
          }
          if (best) {
            const m = /PI(\\d{2})/.exec(best.textContent || "");
            rec.pi = m ? Number(m[1]) : null;
            rec.piTop = Math.round(best.getBoundingClientRect().top - er.top);
            rec.piLeft = Math.round(best.getBoundingClientRect().left - er.left);
          }
          const caret = el.querySelector(".cm-cursor");
          if (caret) {
            const cr = caret.getBoundingClientRect();
            rec.caretY = Math.round(cr.top - er.top);
            rec.caretX = Math.round(cr.left - er.left);
          }
        }
      } else {
        // 阅读面（ProseMirror）：内容锚 = 含 PIxx 的块元素（PM 没有 .cm-line）
        if (el) {
          const er0 = el.getBoundingClientRect();
          const midY0 = er0.top + el.clientHeight / 2;
          let best = null, bestD = Infinity;
          for (const n of el.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote")) {
            const txt = n.textContent || "";
            if (!/PI\\d{2}/.test(txt)) continue;
            const r = n.getBoundingClientRect();
            const d = Math.abs((r.top + r.bottom) / 2 - midY0);
            if (d < bestD) { bestD = d; best = n; }
          }
          if (best) {
            const m = /PI(\\d{2})/.exec(best.textContent || "");
            rec.pi = m ? Number(m[1]) : null;
            rec.piTop = Math.round(best.getBoundingClientRect().top - er0.top);
            rec.piLeft = Math.round(best.getBoundingClientRect().left - er0.left);
          }
        }
        // 阅读面（ProseMirror）：用原生选区取光标矩形
        try {
          const s = window.getSelection();
          if (s && s.rangeCount) {
            const r = s.getRangeAt(0).getBoundingClientRect();
            const er = el ? el.getBoundingClientRect() : { top: 0, left: 0 };
            rec.caretY = Math.round(r.top - er.top);
            rec.caretX = Math.round(r.left - er.left);
          }
        } catch (e) {}
        // 内容锚：指定文本所在块的矩形（#12 判"同一段文字的左缘 X 随时间"）
        if (el && ANCHOR) {
          const nodes = el.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote");
          for (const n of nodes) {
            if ((n.textContent || "").indexOf(ANCHOR) < 0) continue;
            const r = n.getBoundingClientRect();
            const er = el.getBoundingClientRect();
            rec.aLeft = Math.round((r.left - er.left) * 100) / 100;
            rec.aTop = Math.round((r.top - er.top) * 100) / 100;
            break;
          }
        }
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < ${msRaw}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;
};

/**
 * 曲线分析：把逐帧 `scrollTop`（或任意一维序列）翻译成"用户感受"指标。
 *
 * ## 为什么是这三个量（量化口径的论证，写进报告也要用它）
 *
 * 1. **单帧跳变 `maxJump`** —— 视觉上的"跳"。人眼对 60Hz 下相邻帧 >3px 的
 *    整体位移敏感（相当于 180px/s 的瞬时速度）；打字机/滚动同步的正常情形
 *    是每帧 1~3px 的连续变化，所以 **>3px 记一次"跳"**。
 *    取**最大值**而不是平均值：偶发一次 40px 的大跳，平均值会被大量 0 稀释掉，
 *    但用户看到的就是那一次跳。
 * 2. **方向反转 `reversals`** —— 视觉上的"抖"。只有往复才叫抖：
 *    单调移动（哪怕很快）是"滚动"，来回摆才是"抖"。
 *    定义：把非零位移的方向符号序列压缩成 runs，runs 数 − 1 = 反转次数。
 * 3. **净位移 `net` 与帧数 `frames`** —— 用来对照"该不该动"：
 *    删除一行内容时上移一行是**正确**的净位移；净位移为 0 却出现大跳，
 *    说明"动过去了又回来"（往返），这是最典型的抖动形态。
 */
export function analyzeTrack(samples, field = "st") {
  const seq = samples.map((s) => s[field]).filter((v) => typeof v === "number");
  if (seq.length < 2) {
    return { n: seq.length, maxJump: 0, reversals: 0, net: 0, frames: 0, jumps: [], runs: [] };
  }
  const deltas = [];
  for (let i = 1; i < seq.length; i++) deltas.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
  let maxJump = 0;
  const jumps = [];
  for (let i = 0; i < deltas.length; i++) {
    const a = Math.abs(deltas[i]);
    if (a > maxJump) maxJump = a;
    // 每帧位移都记（报告里给"逐帧位移序列"，是最硬的证据）
    if (a > 3) jumps.push({ frame: i + 1, at: samples[i + 1]?.t ?? null, d: deltas[i] });
  }
  // 方向反转：压缩同号连续段（忽略 0，0 不改变方向）
  const runs = [];
  for (const d of deltas) {
    if (d === 0) continue;
    const sign = d > 0 ? 1 : -1;
    if (runs.length === 0 || runs[runs.length - 1].sign !== sign) runs.push({ sign, sum: 0, n: 0 });
    runs[runs.length - 1].sum += d;
    runs[runs.length - 1].n++;
  }
  return {
    n: seq.length,
    first: seq[0],
    last: seq[seq.length - 1],
    min: Math.min(...seq),
    max: Math.max(...seq),
    net: Math.round((seq[seq.length - 1] - seq[0]) * 100) / 100,
    frames: deltas.filter((d) => d !== 0).length,
    maxJump: Math.round(maxJump * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    jumps,
    runs: runs.map((r) => ({ sign: r.sign, sum: Math.round(r.sum * 100) / 100, n: r.n })),
    deltas,
  };
}

/**
 * 平滑性分析：判"是不是渐进移动"而不是"瞬移"（#8 / #12 主判据）。
 *
 * ## 口径论证
 * 用户原话"要有平滑/渐进的移动效果，而不是突然页面就居中"。
 * "突然"= 一帧完成全部位移 → `firstFrameShare`（首帧位移 / 总位移）≈ 1。
 * 正常情况下浏览器 smooth 滚动约 300ms ≈ 18 帧，首帧一般只走总位移的 10~20%
 *（缓动曲线起步慢）。所以取 **首帧 < 60%** 作为"不是瞬移"的门槛，
 * 留出足够的机器抖动余量（第一帧可能因节流晚到 ~30ms）。
 *
 * `monotoneFrames` = 单调逼近的帧数：要求 ≥6 帧（≈100ms 以上），
 * 这是"人能看出是动画"的下限（低于 100ms 会被感知为瞬变）。
 */
export function analyzeSmoothness(samples, field = "st") {
  const seq = samples.map((s) => s[field]).filter((v) => typeof v === "number");
  if (seq.length < 2) {
    return { n: seq.length, totΔ: 0, frames: 0, firstFrameShare: 1, reversals: 0, monotone: false, target: null, lastΔ: null };
  }
  const start = seq[0];
  const end = seq[seq.length - 1];
  const totΔ = Math.abs(end - start);
  const seq2 = seq.map((v) => Math.round(v * 100) / 100);
  const deltas = [];
  for (let i = 1; i < seq2.length; i++) deltas.push(seq2[i] - seq2[i - 1]);
  const nonZero = deltas.filter((d) => Math.abs(d) >= 0.01);
  // 首帧位移：取第一个非零位移帧（rAF 可能晚到，第一个采样点可能还是起始值）
  const firstMove = nonZero.length ? Math.abs(nonZero[0]) : 0;
  const dir = Math.sign(end - start);
  // 单调：所有非零位移方向一致
  const sameDir = nonZero.every((d) => Math.sign(d) === dir);
  // 单调逼近的帧数（方向一致且逐步靠近终值）
  const monotoneFrames = sameDir ? nonZero.length : nonZero.filter((d) => Math.sign(d) === dir).length;
  return {
    n: seq.length,
    first: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    totΔ: Math.round(totΔ * 100) / 100,
    frames: nonZero.length,
    firstMove: Math.round(firstMove * 100) / 100,
    /** 首帧位移 / 总位移。1.0 = 一帧瞬移 */
    firstFrameShare: totΔ > 0 ? Math.round((firstMove / totΔ) * 1000) / 1000 : 0,
    reversals: (() => {
      const runs = [];
      for (const d of nonZero) {
        const s = d > 0 ? 1 : -1;
        if (!runs.length || runs[runs.length - 1] !== s) runs.push(s);
      }
      return Math.max(0, runs.length - 1);
    })(),
    /** 是否 ≥6 帧单调逼近（人能看出是动画） */
    monotone: sameDir && nonZero.length >= 6,
    monotoneFrames,
    /** 每帧位移序列（报告证据） */
    deltas: deltas.map((d) => Math.round(d * 100) / 100),
  };
}

/**
 * 二阶差分分析（#12 专用）：判"左缘 X 的移动曲线是否平滑"。
 *
 * 用户说"文档会抖动""要保证左屏尽量平滑"。
 * 一阶差分突变 = 速度突变（视觉上的"咯噔一下"）；
 * 二阶差分突变 = 加速度突变（视觉上的"抖/颤"）。
 * 对 420ms 的缓动动画，二阶差分理论上连续；若中途出现 `|a| > 2px/帧²` 的尖峰，
 * 说明有两套动画叠加或发生了 snap（先不动→突变）。
 */
export function analyzeSecondDiff(samples, field) {
  const raw = samples.map((s) => s[field]).filter((v) => typeof v === "number");
  if (raw.length < 3) return { n: raw.length, maxV: 0, maxA: 0, spikes: [], reversals: 0 };
  const v = [];
  for (let i = 1; i < raw.length; i++) v.push(Math.round((raw[i] - raw[i - 1]) * 100) / 100);
  const a = [];
  for (let i = 1; i < v.length; i++) a.push(Math.round((v[i] - v[i - 1]) * 100) / 100);
  let maxV = 0, maxA = 0;
  const spikes = [];
  for (let i = 0; i < v.length; i++) {
    if (Math.abs(v[i]) > maxV) maxV = Math.abs(v[i]);
  }
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]) > maxA) maxA = Math.abs(a[i]);
    if (Math.abs(a[i]) > 2) spikes.push({ frame: i + 2, a: a[i] });
  }
  // 方向反转（速度符号变化且速度足够大）
  const runs = [];
  for (const d of v) {
    if (Math.abs(d) < 0.05) continue;
    const s = d > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== s) runs.push(s);
  }
  return {
    n: raw.length,
    first: Math.round(raw[0] * 100) / 100,
    last: Math.round(raw[raw.length - 1] * 100) / 100,
    net: Math.round((raw[raw.length - 1] - raw[0]) * 100) / 100,
    maxV: Math.round(maxV * 100) / 100,
    maxA: Math.round(maxA * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    spikes: spikes.slice(0, 20),
    /** 速度序列（报告里画曲线） */
    v: v.map((x) => Math.round(x * 100) / 100),
  };
}

/** 生成带 PIxx 标记的长文档（#1/#4/#8 共用；CM6/PM 都能按标记定位） */
export function makeDoc(paras = 60, markerPrefix = "PI") {
  const parts = ["# 滚动稳定性审计", ""];
  for (let i = 1; i <= paras; i++) {
    parts.push(
      `${markerPrefix}${String(i).padStart(2, "0")} 第 ${i} 段。Lorem ipsum dolor sit amet ` +
        `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      "",
    );
  }
  return parts.join("\n");
}

/** 页面内：读 CM6 全文（视口外的行不在 DOM，不能用 .cm-line 拼） */
export const READ_CM_TEXT = `
  const c = document.querySelector(".cm-content");
  try {
    const v = c && c.cmTile && c.cmTile.view;
    if (v && v.state && v.state.doc) return { ok: true, len: v.state.doc.length, text: v.state.doc.toString() };
  } catch (e) {}
  return { ok: false };
`;

/** 页面内：给 scrollTop/scrollLeft 的写入打桩，抓"谁在写滚动"（溯源利器） */
export const INSTALL_SCROLL_SPY = `
  if (!window.__ST_SPY) {
    window.__ST_SPY = true;
    window.__ST_WRITES = [];
    const INTERESTING = (el) => {
      const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
      return String(cls).includes("cm-scroller") || String(cls).includes("editor-container") || String(cls).includes("source-editor");
    };
    const nameOf = (el) => {
      const cls = (el.className && typeof el.className === "string") ? el.className : (el.tagName || "");
      return String(cls).slice(0, 40);
    };
    const record = (el, v, how) => {
      try {
        if (!INTERESTING(el)) return;
        const stack = (new Error().stack || "").split("\\n").slice(1, 16)
          .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));
        window.__ST_WRITES.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(el.scrollTop), k: nameOf(el), how, stack });
      } catch (e) {}
    };
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true, enumerable: proto.enumerable,
      get() { return proto.get.call(this); },
      set(v) {
        record(this, v, "scrollTop=");
        return proto.set.call(this, v);
      },
    });
    /** ⚠️ 必须同时 hook scrollTo/scrollBy：smooth 滚动走的是这两条路径，
     *   **不经过 scrollTop setter** —— 只 hook setter 会把 smooth 写入全漏掉
     *   （第一版探针就是因此得出"零写入"的错误结论）。 */
    for (const m of ["scrollTo", "scrollBy"]) {
      const orig = Element.prototype[m];
      if (!orig) continue;
      Element.prototype[m] = function (a, b) {
        try {
          const top = (typeof a === "object" && a) ? a.top : b;
          if (typeof top === "number") record(this, top, m + "()");
          else record(this, this.scrollTop, m + "()");
        } catch (e) {}
        return orig.call(this, a, b);
      };
    }
    /** 让探针能打"按键时刻"标记，便于把帧归到具体按键 */
    window.__MARK = (label) => { window.__KEYS.push({ t: Math.round(performance.now() - (window.__T0 || 0)), label }); return window.__KEYS.length; };
  }
  return true;
`;

/** 滚轮滚动到目标比例（#1/#4 要求"真实滚轮"，不能瞬移 scrollTop） */
export async function wheelScrollToPercent(ui, pct, selector, opts = {}) {
  const step = opts.step ?? 140;
  const box = await ui.ev(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + Math.min(r.height - 20, r.height / 2)),
      st: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
    };
  `);
  if (!box) return null;
  const target = Math.round(box.max * pct);
  let cur = box.st;
  // 先回顶部，保证自上而下逐段测量（CM6 heightMap 估算修正的已知坑）
  let guard = 0;
  while (cur > 8 && guard++ < 400) {
    await ui.wheel(box.x, box.y, -Math.min(step * 4, cur));
    cur = await ui.ev(`return Math.round(document.querySelector(${JSON.stringify(selector)}).scrollTop)`);
  }
  guard = 0;
  while (cur < target - 8 && guard++ < 800) {
    await ui.wheel(box.x, box.y, Math.min(step, target - cur));
    const next = await ui.ev(`return Math.round(document.querySelector(${JSON.stringify(selector)}).scrollTop)`);
    if (next === cur) break;
    cur = next;
  }
  await ui.sleep(opts.settle ?? 500);
  return await ui.ev(`
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? { st: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) } : null;
  `);
}
