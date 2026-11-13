/**
 * v0.17.0 第四轮 · T3 · **决定性实验：行轴混用两种坐标系，在 smooth 动画期间会跳**
 *
 * ## 假说 H-A（本轮最终锁定的根因方向）
 * `CmSourceSurface.measureBlockTops()`（`src/editor/cm6/CmSourceSurface.ts:1336`）：
 * ```ts
 * const block = view.lineBlockAt(line.from);         // ① heightMap 内容坐标
 * const coords = view.coordsAtPos(line.from);        // ② 屏幕坐标（仅视口内可测）
 * if (coords) return coords.top - view.documentTop;  // ← ②−documentTop = 内容坐标（实测）
 * return block.top;                                  // ← ①（估算）
 * ```
 * - `view.documentTop = scrollDOM.getBoundingClientRect().top − scrollTop`
 *   → **smooth 动画期间每帧都在变**；
 * - 但**哪些行能取到 `coords`** 也在变（只有视口内的行有真实 rect）。
 *
 * ⇒ 通篇「块起始行 → 内容坐标 Y」的表里，**一部分是实测、一部分是估算**，
 * 且这个混合比例随视口位置逐帧变化。任何用这张表做的映射
 * （`mapSourceLineToPreviewScroll`）在动画期间都会得到**逐渐漂移的目标值**。
 *
 * ## 为什么它会造成"右屏先猛跳 +189 再纠正 −185"
 * 动画期间左屏视口底部不断刷新 → 视口内实测的行集合变化 → 行轴被部分修正 →
 * `estimateTopSourceLine` 算出的"顶部源码行"整段跳变（不是线性）→ 右屏目标整段跳。
 * 动画一停，视口固定，行轴稳定，映射回到正确值 = 视觉上的"纠正"。
 *
 * ## 直接验证（不 hook 任何滚动 API —— 前车之鉴）
 * 行轴是内部函数，不能直接调。改为**在页面内复算同一套几何**：
 * 对同一批块的起始行，分别取
 * - `A = lineBlockAt(pos).top`（纯估算口径）
 * - `B = coordsAtPos(pos).top − documentTop`（实测口径）
 * 在动画的每个采样帧记录**两者的差值 A−B**。
 * - 若 A−B 恒定（≤1px）→ 两种口径等价，混用无害；
 * - 若 A−B 逐帧变化（>5px）→ **混用有害**，这就是根因。
 *
 * 另加一条**物理不变量**做交叉验证：同一行文本的 `内容 Y`（屏幕 Y + scrollTop）
 * 在动画期间必须恒定。若它变了，说明布局/测量确实不稳。
 *
 * ⚠️ 本探针拿不到内部函数，所以用 CM6 暴露在 DOM 上的 `.cm-content` 的 `cmTile.view`
 * （探针骨架 `readSourceText` 已用过同一路径，实测可用）来访问 `view`。
 * 这是**只读访问**，不修改任何行为。
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-axis.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

const START_TRACE = (ms) => `
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const sc = document.querySelector(".cm-scroller");
      const rec = { t: Math.round(performance.now() - t0) };
      if (sc) {
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        const scR = sc.getBoundingClientRect();
        // ① 物理不变量：视口内每行的"内容坐标 Y"（屏幕 Y + scrollTop）
        const lines = Array.from(sc.querySelectorAll(".cm-line")).slice(0, 20);
        rec.lines = lines.map((l) => {
          const r = l.getBoundingClientRect();
          return { k: (l.textContent || "").slice(0, 10), docY: Math.round((r.top - scR.top + sc.scrollTop) * 100) / 100 };
        });
        // ② 核心：同一批块的 A（lineBlockAt）vs B（coordsAtPos − documentTop）
        try {
          const c = document.querySelector(".cm-content");
          const view = c && c.cmTile && c.cmTile.view;
          if (view) {
            rec.documentTop = Math.round(view.documentTop * 100) / 100;
            const doc = view.state.doc;
            // 取 10 个块起始行（每 10 行一个），覆盖视口内外
            const rows = [];
            for (let n = 1; n <= doc.lines; n += Math.max(1, Math.floor(doc.lines / 10))) {
              const line = doc.line(n);
              let a = null, b = null;
              try {
                const blk = view.lineBlockAt(line.from);
                if (blk && Number.isFinite(blk.top)) a = blk.top;
              } catch (e) {}
              try {
                const co = view.coordsAtPos(line.from);
                if (co && Number.isFinite(co.top)) b = Math.round((co.top - view.documentTop) * 100) / 100;
              } catch (e) {}
              rows.push({ n, a: a === null ? null : Math.round(a * 100) / 100, b });
            }
            rec.rows = rows;
          }
        } catch (e) { rec.axisErr = String(e).slice(0, 60); }
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

const READ_STATE = `
  const round = (n) => Math.round(n * 100) / 100;
  const sc = document.querySelector(".cm-scroller");
  if (!sc) return { ok: false };
  const r = sc.getBoundingClientRect();
  const caret = sc.querySelector(".cm-cursor");
  const cr = caret ? caret.getBoundingClientRect() : null;
  let lines = null;
  try { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view;
        if (v && v.state && v.state.doc) lines = v.state.doc.lines; } catch (e) {}
  return { ok: true, st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight), ch: round(sc.clientHeight),
           caretY: cr ? round(cr.top - r.top) : null, focused: !!document.querySelector(".cm-focused"), lines };
`;

const READ_PREVIEW = `
  const round = (n) => Math.round(n * 100) / 100;
  const f = document.querySelector("iframe.split-preview, iframe");
  if (!f) return { ok: false, reason: "no iframe" };
  try {
    const d = f.contentDocument;
    const se = d && (d.scrollingElement || d.documentElement);
    if (!se) return { ok: false, reason: "no se" };
    return { ok: true, st: round(se.scrollTop), sh: round(se.scrollHeight) };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 50) }; }
`;

/** 右屏曲线（从 trace 里取；字段名 deST） */
function seriesOf(trace, field, noisePx = 5) {
  const vals = [], idx = [];
  trace.forEach((s, i) => { if (typeof s[field] === "number") { vals.push(s[field]); idx.push(i); } });
  if (vals.length < 2) return { valid: false, n: vals.length, values: vals };
  const d = [];
  for (let i = 1; i < vals.length; i++) d.push({ t: trace[idx[i]].t, d: Math.round((vals[i] - vals[i - 1]) * 100) / 100 });
  let maxUp = 0, upAt = null, maxDown = 0, downAt = null;
  for (const it of d) {
    if (it.d > maxUp) { maxUp = it.d; upAt = it.t; }
    if (it.d < -maxDown) { maxDown = -it.d; downAt = it.t; }
  }
  const nz = d.filter((it) => Math.abs(it.d) >= 0.05);
  const runs = [];
  let acc = 0;
  for (const it of nz) {
    const s = it.d > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== s) {
      if (runs.length > 0 && Math.abs(acc) <= noisePx) runs[runs.length - 1] = s;
      else runs.push(s);
      acc = 0;
    }
    acc += it.d;
  }
  return {
    valid: true, n: vals.length, first: vals[0], last: vals[vals.length - 1],
    net: Math.round((vals[vals.length - 1] - vals[0]) * 100) / 100,
    maxUp: Math.round(maxUp * 100) / 100, maxUpAt: upAt,
    maxDown: Math.round(maxDown * 100) / 100, downAt,
    reversals: Math.max(0, runs.length - 1), frames: nz.length,
    deltas: nz.slice(0, 20).map((it) => `${it.t}:${it.d}`),
  };
}

/**
 * 核心分析：A−B 的逐帧波动。
 *
 * 对每个采样帧，把 rows 里"同 n、A 与 B 都有限"的项算 delta = A − B。
 * 再对同一个 n 跨帧看 delta 的极差 → 只要有一个 n 的极差 > 阈值，
 * 就证明"估算口径与实测口径的偏差随视口变化"，即混用会产生漂移。
 */
function axisMixing(trace, threshold = 5) {
  const frames = trace.filter((s) => Array.isArray(s.rows) && s.rows.length > 0);
  if (frames.length < 2) return { valid: false, n: frames.length };
  /** n → [{t, delta, inViewport}] */
  const perN = new Map();
  for (const f of frames) {
    for (const r of f.rows) {
      if (r.a === null || r.b === null) continue;
      const delta = Math.round((r.a - r.b) * 100) / 100;
      if (!perN.has(r.n)) perN.set(r.n, []);
      perN.get(r.n).push({ t: f.t, delta, st: f.st });
    }
  }
  let maxRange = 0, worst = null;
  const perNRange = [];
  for (const [n, arr] of perN) {
    if (arr.length < 2) continue;
    const ds = arr.map((x) => x.delta);
    const range = Math.round((Math.max(...ds) - Math.min(...ds)) * 100) / 100;
    perNRange.push({ n, samples: arr.length, min: Math.min(...ds), max: Math.max(...ds), range });
    if (range > maxRange) { maxRange = range; worst = { n, arr: arr.slice(0, 12) }; }
  }
  perNRange.sort((a, b) => b.range - a.range);
  return {
    valid: true, n: frames.length,
    maxRange: Math.round(maxRange * 100) / 100,
    /** 超过阈值的行数 */
    offenders: perNRange.filter((r) => r.range > threshold).slice(0, 8),
    worst,
    /** 参与比较的行数（有 A 也有 B 的） */
    comparedN: perNRange.length,
    /** 每帧 documentTop（它随滚动变化，是混用风险的来源） */
    docTops: frames.slice(0, 10).map((f) => `${f.t}:${f.documentTop}`),
  };
}

/** 物理不变量：同一行文本的内容 Y 跨帧是否恒定 */
function docYStability(trace, threshold = 5) {
  const keyed = trace
    .filter((s) => Array.isArray(s.lines) && s.lines.length > 0)
    .map((s) => ({ t: s.t, st: s.st, map: new Map(s.lines.map((l) => [l.k, l.docY])) }));
  if (keyed.length < 2) return { valid: false, n: keyed.length };
  const last = keyed[keyed.length - 1];
  const rows = [];
  for (const f of keyed) {
    let worst = 0, key = null;
    for (const [k, y] of f.map) {
      if (!k || !last.map.has(k)) continue;
      const d = Math.abs(y - last.map.get(k));
      if (d > worst) { worst = d; key = k; }
    }
    rows.push({ t: f.t, worst: Math.round(worst * 100) / 100, key });
  }
  const maxWorst = rows.reduce((m, r) => Math.max(m, r.worst), 0);
  return {
    valid: true, n: keyed.length,
    maxWorst: Math.round(maxWorst * 100) / 100,
    offenders: rows.filter((r) => r.worst > threshold).slice(0, 6),
    stRange: [Math.min(...keyed.map((k) => k.st)), Math.max(...keyed.map((k) => k.st))],
  };
}

async function wheelTo(ui, pct) {
  const box = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2),
             st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
  `);
  let cur = box.st, guard = 0;
  while (cur > 8 && guard++ < 400) {
    await ui.wheel(box.x, box.y, -Math.min(560, cur));
    cur = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
  }
  const target = Math.round(box.max * pct);
  guard = 0;
  while (cur < target - 8 && guard++ < 800) {
    await ui.wheel(box.x, box.y, Math.min(140, target - cur));
    const next = await ui.ev(`return Math.round(document.querySelector(".cm-scroller").scrollTop)`);
    if (next === cur) break;
    cur = next;
  }
  await ui.sleep(500);
}

async function placeCursor(ui, frac) {
  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const r = sc.getBoundingClientRect();
    const y = Math.round(r.top + sc.clientHeight * ${frac});
    for (const dx of [0.45, 0.55, 0.35, 0.65]) {
      const x = Math.round(r.left + sc.clientWidth * dx);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit.closest(".cm-content") || hit.classList.contains(".cm-line"))) return { x, y };
    }
    return null;
  `);
  if (!pt) return null;
  await ui.click(pt.x, pt.y);
  await ui.sleep(200);
  return pt;
}

async function waitSettled(ui, ms = 2500) {
  const t0 = Date.now();
  let prev = null, stable = 0;
  while (Date.now() - t0 < ms) {
    const st = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return sc?Math.round(sc.scrollTop*100)/100:null;`);
    if (prev !== null && Math.abs((st ?? 0) - prev) <= 0.5) stable++;
    else stable = 0;
    prev = st;
    if (stable >= 3) return true;
    await ui.sleep(90);
  }
  return false;
}

await runBrowserProbe({ name: "v0170-r4-enter-axis", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  if (ui.impl !== "cm6") { ui.add("A0", "源码面 CM6", "FAIL", `impl=${ui.impl}`); return; }

  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(300);

  const readTw = () => ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);
  const setTw = async (w) => { if ((await readTw()) !== w) { await ui.command("view.toggleTypewriter"); await ui.sleep(1000); } return readTw(); };

  const run = async (tag, { withPreview }) => {
    await wheelTo(ui, 0.5);
    const pt = await placeCursor(ui, 0.85);
    if (!pt) { ui.add(`I-${tag}`, "INVALID：落点找不到", "FAIL", "无"); return null; }
    await ui.sleep(800);
    const settled = await waitSettled(ui);
    const pre = await ui.ev(READ_STATE);
    const prePv = await ui.ev(READ_PREVIEW);

    await ui.ev(START_TRACE(1900));
    await ui.sleep(120);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(2400);

    const trace = await ui.ev(`return window.__TR || []`);
    const post = await ui.ev(READ_STATE);
    const postPv = await ui.ev(READ_PREVIEW);

    const st = seriesOf(trace, "st");
    const axis = axisMixing(trace);
    const stab = docYStability(trace);

    const asserts = [
      { id: "A1", ok: withPreview ? prePv.ok : true, why: `右屏可读 ${prePv.ok}` },
      { id: "A2", ok: pre.max > 300, why: `max=${pre.max}` },
      { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY}` },
      { id: "A4", ok: settled, why: `stable=${settled}` },
      { id: "A5", ok: (post.lines ?? 0) === (pre.lines ?? -1) + 1, why: `lines ${pre.lines}→${post.lines}` },
      { id: "A6", ok: axis.valid && axis.comparedN >= 4, why: `行轴可比对项=${axis.comparedN}（需 ≥4，否则测不到混用）` },
    ];
    const bad = asserts.filter((x) => !x.ok);
    if (bad.length) { ui.add(`I-${tag}`, "INVALID（前置断言不成立）", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); return null; }

    ui.log(`[${tag}] 左屏 ${JSON.stringify({ net: st.net, up: st.maxUp, rev: st.reversals, frames: st.frames })}`);
    ui.log(`[${tag}] ★行轴混用 A−B 极差 = ${axis.maxRange}px（可比对 ${axis.comparedN} 行）`);
    ui.log(`[${tag}] 越界行 = ` + JSON.stringify(axis.offenders));
    ui.log(`[${tag}] documentTop 序列 = ` + JSON.stringify(axis.docTops));
    ui.log(`[${tag}] 物理不变量（行内容Y）最大漂移 = ${stab.maxWorst}px；越界=${JSON.stringify(stab.offenders)}`);
    ui.log(`[${tag}] 最差行样本 = ` + JSON.stringify(axis.worst));
    return { tag, st, axis, stab, pre, prePv, post };
  };

  await setTw(true);
  ui.log("[tw] active=" + (await readTw()));

  const r1 = await run("ON·Enter·0.85·分屏", { withPreview: true });
  await ui.key("z", "KeyZ", 90, 2); await ui.sleep(1200);
  const r2 = await run("ON·Enter·0.85·分屏·重复", { withPreview: true });

  const rows = [r1, r2].filter(Boolean);
  ui.log("[SUMMARY] " + JSON.stringify(rows.map((r) => ({
    tag: r.tag,
    stNet: r.st.net, stFrames: r.st.frames,
    axisMaxRange: r.axis.maxRange, axisCompared: r.axis.comparedN, axisOffenders: r.axis.offenders,
    docYMaxDrift: r.stab.maxWorst, stRange: r.stab.stRange,
  })), null, 1));

  ui.add("B1", "★ 行轴两种口径（lineBlockAt 估算 vs coordsAtPos 实测）在动画期间是否等价",
    rows.length && rows.every((r) => r.axis.maxRange <= 5) ? "PASS" : "FAIL",
    rows.map((r) => `${r.tag}: A−B 极差 ${r.axis.maxRange}px（阈值 5px），越界行 ${r.axis.offenders.length} 个`).join("；"));
  ui.add("B2", "物理不变量：视口内行内容坐标恒定",
    rows.length && rows.every((r) => r.stab.maxWorst <= 5) ? "PASS" : "FAIL",
    rows.map((r) => `${r.tag}: 最大漂移 ${r.stab.maxWorst}px；scrollTop 跨度 ${JSON.stringify(r.stab.stRange)}`).join("；"));

  await ui.shot("axis");
});
