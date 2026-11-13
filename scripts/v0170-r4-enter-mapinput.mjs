/**
 * v0.17.0 第四轮 · T3 · **决定性：动画期间右屏映射值（3200+）为什么是错的？**
 *
 * ## 已确证的时序（`v0170-r4-enter-rightpane.mjs`，我的加固版之后仍复现）
 * ```
 * 左屏 st : 4243 → 4248 → 4263 → 4268 → 4270 → 4271   （smooth，+28px，正确）
 * 右屏 de : 3012 → 3012 → 3200 → 3212 → 3215 → 3217  （动画期间，错）
 *                                 → 3032             （t=447，realignLayoutNow force 纠正）
 * ```
 * - 左屏只动 +28px，右屏却先 +188 再 −185 ⇒ **动画期间那 4 个值全是错的**；
 * - 3032 才是正确值（与动画前 3012 相比 +20，符合两屏高度比 ~0.7）；
 * - `realignLayoutNow`（480ms 定时器）把右屏拉回 3032 = 用户看到的"弹回来"。
 *
 * ## 本探针要回答的**唯一问题**
 * 动画期间 `syncToPreview` 算出的映射值为什么是 3200+？两个候选：
 *
 * | 假说 | 机制 | 判据 |
 * |---|---|---|
 * | **H-1 输入错**：`currentTopSourceLine()` 在动画期间算出了错误的源码行 | 行轴 `measureBlockTops` 在动画期间不稳（两种坐标口径混用） | 用**稳定后的**行轴重算：若结果回到 3032 附近 ⇒ 输入是错的 |
 * | **H-2 输入对、映射表错**：`collectAnchors()` 读到 iframe 重写期间的半成品几何 | 回车 → 内容同步 → iframe 重渲染 → `[data-src-line]` 贴标过程 | 记录每帧 `tags` 数量与 `totalHeight`；若动画期与稳定后差异大 ⇒ 映射表是错的 |
 *
 * ## 做法（**全程只读，绝不 hook 任何滚动 API**）
 * 在页面内直接复算映射的**输入端**（不改任何行为）：
 * - `topLine`：用与 `estimateTopSourceLine` 同一公式（线性兜底 + 行轴不可得）
 * - `tags`：`iframe.contentDocument.querySelectorAll("[data-src-line]").length`
 * - `totalHeight`：iframe `scrollHeight`
 * - `contentDocH`：iframe body 高度
 * - `scrollH_left`：左屏 scrollHeight（行轴缓存键的一部分）
 * 并逐帧对比「动画期」与「稳定后」的**同名字段**，定位是哪个输入在跳。
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-mapinput.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

const START_TRACE = (ms) => `
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const rec = { t: Math.round(performance.now() - t0) };
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        rec.ch = sc.clientHeight;
        rec.max = Math.round(sc.scrollHeight - sc.clientHeight);
        // 用与 estimateTopSourceLine 完全相同的**线性兜底**公式（行轴不可得时的路径）
        try {
          const c = sc.querySelector(".cm-content");
          const v = c && c.cmTile && c.cmTile.view;
          if (v && v.state && v.state.doc) {
            const total = v.state.doc.lines;
            rec.docLines = total;
            const max = rec.max;
            rec.topLineLinear = max > 0 ? Math.round(((sc.scrollTop / max) * (total - 1)) * 100) / 100 : 0;
            // 视口顶真实所在行（用 DOM 实测：第一个 .cm-line 的行号不可得，
            // 改用"第一个可见截断元素"的 data 属性不可得 → 用 posAtCoords 反查）
            try {
              const r = sc.getBoundingClientRect();
              const pos = v.posAtCoords({ x: r.left + 80, y: r.top + 8 });
              if (pos) rec.topLineReal = v.state.doc.lineAt(pos.pos).number - 1;
            } catch (e) {}
          }
        } catch (e) {}
        // 行轴口径混合的直接度量：lineBlockAt vs coordsAtPos − documentTop
        try {
          const c = sc.querySelector(".cm-content");
          const v = c && c.cmTile && c.cmTile.view;
          if (v) {
            rec.documentTop = Math.round(v.documentTop * 100) / 100;
            const doc = v.state.doc;
            const deltas = [];
            for (let n = 1; n <= doc.lines; n += Math.max(1, Math.floor(doc.lines / 8))) {
              const line = doc.line(n);
              let a = null, b = null;
              try { const blk = v.lineBlockAt(line.from); if (blk && Number.isFinite(blk.top)) a = blk.top; } catch (e) {}
              try { const co = v.coordsAtPos(line.from); if (co && Number.isFinite(co.top)) b = co.top - v.documentTop; } catch (e) {}
              deltas.push({ n, a: a === null ? null : Math.round(a * 100) / 100, b: b === null ? null : Math.round(b * 100) / 100 });
            }
            rec.axis = deltas;
          }
        } catch (e) {}
      }
      const f = document.querySelector("iframe.split-preview, iframe");
      if (f) {
        try {
          const d = f.contentDocument;
          const se = d && (d.scrollingElement || d.documentElement);
          if (se) {
            rec.deST = Math.round(se.scrollTop * 100) / 100;
            rec.deSH = Math.round(se.scrollHeight);
            rec.tags = d.querySelectorAll("[data-src-line]").length;
            rec.bodyH = d.body ? Math.round(d.body.getBoundingClientRect().height * 100) / 100 : null;
            // 锚点表的**首尾**（能看出表是否被整体重建/重排）
            const tagged = d.querySelectorAll("[data-src-line]");
            if (tagged.length) {
              const first = tagged[0], last = tagged[tagged.length - 1];
              rec.firstLine = first.dataset.srcLine;
              rec.lastLine = last.dataset.srcLine;
              rec.firstTop = Math.round(first.getBoundingClientRect().top * 100) / 100;
            }
          }
        } catch (e) {}
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
  try { const c = sc.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view;
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
    return { ok: true, st: round(se.scrollTop), sh: round(se.scrollHeight),
             tags: d.querySelectorAll("[data-src-line]").length };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 50) }; }
`;

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

await runBrowserProbe({ name: "v0170-r4-enter-mapinput", doc: DOC }, async (ui) => {
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

  const run = async (tag) => {
    await wheelTo(ui, 0.5);
    const pt = await placeCursor(ui, 0.85);
    if (!pt) { ui.add(`I-${tag}`, "INVALID：落点找不到", "FAIL", "无"); return null; }
    await ui.sleep(800);
    const settled = await waitSettled(ui);
    const pre = await ui.ev(READ_STATE);
    const prePv = await ui.ev(READ_PREVIEW);

    await ui.ev(START_TRACE(2100));
    await ui.sleep(120);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(2600);

    const trace = await ui.ev(`return window.__TR || []`);
    const post = await ui.ev(READ_STATE);
    const postPv = await ui.ev(READ_PREVIEW);

    const asserts = [
      { id: "A1", ok: prePv.ok && prePv.tags > 0, why: `右屏可读=${prePv.ok} tags=${prePv.tags}` },
      { id: "A2", ok: pre.max > 300, why: `max=${pre.max}` },
      { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY}` },
      { id: "A4", ok: settled, why: `stable=${settled}` },
      { id: "A5", ok: (post.lines ?? 0) === (pre.lines ?? -1) + 1, why: `lines ${pre.lines}→${post.lines}` },
    ];
    const bad = asserts.filter((x) => !x.ok);
    if (bad.length) { ui.add(`I-${tag}`, "INVALID", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); return null; }

    // 逐帧打印关键输入
    ui.log(`[${tag}] 逐帧（t:左st/右st/tags/deSH/topLineLinear/topLineReal/documentTop）`);
    for (const s of trace.slice(0, 40)) {
      ui.log(`  ${s.t}: ${s.st}/${s.deST}/T${s.tags}/sh${s.deSH}/lin${s.topLineLinear}/real${s.topLineReal}/dt${s.documentTop}`);
    }
    ui.log(`[${tag}] 最终 左st=${post.st} 右st=${postPv.st} tags=${postPv.tags} deSH=${postPv.sh}`);

    // 行轴口径差（A−B）逐帧极差
    const byN = new Map();
    for (const f of trace) {
      if (!Array.isArray(f.axis)) continue;
      for (const r of f.axis) {
        if (r.a === null || r.b === null) continue;
        if (!byN.has(r.n)) byN.set(r.n, []);
        byN.get(r.n).push(Math.round((r.a - r.b) * 100) / 100);
      }
    }
    const ranges = [];
    for (const [n, arr] of byN) {
      if (arr.length < 3) continue;
      ranges.push({ n, samples: arr.length, min: Math.min(...arr), max: Math.max(...arr), range: Math.round((Math.max(...arr) - Math.min(...arr)) * 100) / 100 });
    }
    ranges.sort((a, b) => b.range - a.range);
    ui.log(`[${tag}] ★ 行轴口径(A−B)极差 top5 = ` + JSON.stringify(ranges.slice(0, 5)));

    // tags / deSH 在动画期间是否变化
    const tagsSet = [...new Set(trace.map((s) => s.tags).filter((v) => v !== undefined))];
    const deSHSet = [...new Set(trace.map((s) => s.deSH).filter((v) => v !== undefined))];
    const bodyHSet = [...new Set(trace.map((s) => s.bodyH).filter((v) => v !== undefined))];
    const shSet = [...new Set(trace.map((s) => s.sh).filter((v) => v !== undefined))];
    ui.log(`[${tag}] tags 取值集=${JSON.stringify(tagsSet)} deSH=${JSON.stringify(deSHSet)} bodyH=${JSON.stringify(bodyHSet)} 左sh=${JSON.stringify(shSet)}`);

    return { tag, pre, post, prePv, postPv, trace, ranges, tagsSet, deSHSet, bodyHSet, shSet };
  };

  await setTw(true);
  ui.log("[tw] active=" + (await readTw()));

  const r1 = await run("ON·Enter·0.85");
  await ui.key("z", "KeyZ", 90, 2); await ui.sleep(1200);
  const r2 = await run("ON·Enter·0.85·重复");

  const rows = [r1, r2].filter(Boolean);
  const maxAxisRange = rows.length ? Math.max(...rows.map((r) => (r.ranges[0]?.range ?? 0))) : null;
  ui.add("H1", "★ 行轴两种口径（估算 vs 实测）在动画期间是否漂移 → 判定 H-1",
    maxAxisRange !== null && maxAxisRange <= 5 ? "PASS" : "FAIL",
    `最大 A−B 极差 = ${maxAxisRange}px（阈值 5px）`);
  ui.add("H2", "★ 动画期间 iframe 锚点表/内容高度是否在变 → 判定 H-2",
    rows.length && rows.every((r) => r.tagsSet.length <= 1 && r.deSHSet.length <= 1) ? "PASS" : "FAIL",
    rows.map((r) => `${r.tag}: tags 取值 ${JSON.stringify(r.tagsSet)}；iframe scrollHeight 取值 ${JSON.stringify(r.deSHSet)}`).join("；"));
  ui.add("H3", "★ 左屏 scrollHeight 在动画期间是否变化（行轴缓存键失效源）",
    rows.length && rows.every((r) => r.shSet.length <= 1) ? "PASS" : "FAIL",
    rows.map((r) => `${r.tag}: 左屏 scrollHeight 取值 ${JSON.stringify(r.shSet)}`).join("；"));

  await ui.shot("mapinput");
});
