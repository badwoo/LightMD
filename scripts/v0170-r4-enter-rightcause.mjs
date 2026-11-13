/**
 * v0.17.0 第四轮 · T3 · **候选 A 决定性单变量**：右屏 +188px 猛跳是"内容重渲染"还是"滚动同步"？
 *
 * ## 已确证的形态（`v0170-r4-enter-rightpane.mjs`，打字机开、点击 0.85）
 * ```
 * 左屏 st : 4243 → 4248 → 4263 → 4268 → 4270 → 4271     （5 帧，平滑 28px，反转 0）
 * 右屏 deST: 3012 → 3012 → 3200 → 3212 → 3215 → 3217 → 3015
 *            ↑ 单帧 +188px         ↑ 215ms 后 −185px 回弹
 * 同帧对照：右屏 +188 的那一帧，左屏只 +15px  ⇒ 比值 12.5（不是线性同步）
 * 右屏 scrollHeight 全程 6130 不变 ⇒ **不是内容变高/变矮**
 * ```
 * 两个候选，判据完全不同：
 *
 * | 假说 | 机制 | 可测判据 |
 * |---|---|---|
 * | **H1 内容重渲染** | 回车改 doc → 右屏 markdown 重渲染 → 块几何/锚点表变 → 同步写入的映射目标跳 | 右屏 `scrollHeight` 或块几何变化；iframe DOM mutation 数 >0 |
 * | **H2 滚动同步** | 左屏 smooth 动画期间每帧触发 `syncToPreview`，方向锁 250ms 到期后右屏自己的 scroll 事件被接受 → 反算回写 → 回弹 | 右屏跳变时 `scrollHeight` 不变、iframe 无 mutation；**不改文档的操作（方向键）同样能触发** |
 *
 * ## 决定性实验：**方向键 vs 回车**
 * - `ArrowDown`：只移动光标 + 触发打字机 smooth 居中，**不改文档**（无重渲染）
 *   → 若右屏同样猛跳 ⇒ **H2**（滚动同步）
 * - `Enter`：改文档 + 同样的 smooth 居中
 *   → 若右屏行为与 ArrowDown 一致 ⇒ 内容重渲染是无关变量（进一步确认 H2）
 *
 * 每组都记录：左屏 / 右屏逐帧 scrollTop、右屏 scrollHeight、iframe 内 DOM mutation 计数、
 * 以及"回弹时间差"（右屏最大正跳与最大负跳相隔多久 —— 若 ≈250ms 就指向方向锁）。
 *
 * ## 前置断言（不满足即 INVALID）
 * A1 右屏可读 / A2 左屏可滚动 / A3 光标在视口内 / A4 采样前稳定 / A5 操作确实生效
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-rightcause.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

const START_TRACE = (ms) => `
  window.__TR = [];
  window.__IFMUT = 0;
  (function () {
    // 只读：统计 iframe 内 DOM 变更（内容重渲染的直接证据）
    try {
      const f = document.querySelector("iframe.split-preview, iframe");
      const d = f && f.contentDocument;
      if (d && d.body) {
        if (window.__IFOBS) window.__IFOBS.disconnect();
        window.__IFOBS = new MutationObserver((m) => { window.__IFMUT += m.length; });
        window.__IFOBS.observe(d.body, { childList: true, subtree: true, characterData: true, attributes: true });
      }
    } catch (e) {}
    const t0 = performance.now();
    const tick = () => {
      const rec = { t: Math.round(performance.now() - t0) };
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        const caret = sc.querySelector(".cm-cursor");
        if (caret) rec.caretY = Math.round((caret.getBoundingClientRect().top - sc.getBoundingClientRect().top) * 100) / 100;
      }
      const f = document.querySelector("iframe.split-preview, iframe");
      if (f) {
        try {
          const d = f.contentDocument;
          if (d && d.documentElement) {
            rec.deST = Math.round(d.documentElement.scrollTop * 100) / 100;
            rec.deSH = Math.round(d.documentElement.scrollHeight);
            rec.ifmut = window.__IFMUT;
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
  const r = sc.getBoundingClientRect();
  const caret = sc.querySelector(".cm-cursor");
  const cr = caret ? caret.getBoundingClientRect() : null;
  let lines = null;
  try { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view;
        if (v && v.state && v.state.doc) lines = v.state.doc.lines; } catch (e) {}
  return { st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight), ch: round(sc.clientHeight),
           caretY: cr ? round(cr.top - r.top) : null, focused: !!document.querySelector(".cm-focused"), lines };
`;

const READ_PREVIEW = `
  const round = (n) => Math.round(n * 100) / 100;
  const f = document.querySelector("iframe.split-preview, iframe");
  if (!f) return { ok: false, reason: "no iframe" };
  try {
    const d = f.contentDocument;
    if (!d || !d.documentElement) return { ok: false, reason: "no doc" };
    return { ok: true, st: round(d.documentElement.scrollTop), sh: round(d.documentElement.scrollHeight) };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 50) }; }
`;

function series(trace, field, noisePx = 5) {
  const vals = [], idx = [];
  trace.forEach((s, i) => { if (typeof s[field] === "number") { vals.push(s[field]); idx.push(i); } });
  if (vals.length < 2) return { valid: false, n: vals.length };
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
    maxDown: Math.round(maxDown * 100) / 100, maxDownAt: downAt,
    /** 正跳与负跳相隔多久 —— ≈250ms 即指向方向锁窗口到期 */
    bounceGapMs: upAt !== null && downAt !== null ? Math.round(Math.abs(downAt - upAt)) : null,
    reversals: Math.max(0, runs.length - 1), frames: nz.length,
    deltas: nz.slice(0, 24).map((it) => `${it.t}:${it.d}`),
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
      if (hit && (hit.closest(".cm-content") || hit.classList.contains("cm-line"))) return { x, y };
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

await runBrowserProbe({ name: "v0170-r4-enter-rightcause", doc: DOC }, async (ui) => {
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

  /**
   * 跑一次操作。op = "enter" | "arrowdown"
   *
   * ⚠️ ArrowDown 与 Enter 的差别只有"是否改文档"：
   * 两者都触发打字机 keyup 的 `isTypewriterTriggerKey` 分支 → `scrollCursorToCenter()`（smooth）。
   */
  const run = async (tag, op, frac) => {
    await wheelTo(ui, 0.5);
    const pt = await placeCursor(ui, frac);
    if (!pt) { ui.add(`C-${tag}`, "INVALID：落点找不到", "FAIL", "无"); return null; }
    await ui.sleep(800);
    const settled = await waitSettled(ui);
    const pre = await ui.ev(READ_STATE);
    const prePv = await ui.ev(READ_PREVIEW);

    await ui.ev(START_TRACE(1800));
    await ui.sleep(110);
    if (op === "enter") await ui.key("Enter", "Enter", 13);
    else await ui.key("ArrowDown", "ArrowDown", 40);
    await ui.sleep(2200);

    const trace = await ui.ev(`return window.__TR || []`);
    const post = await ui.ev(READ_STATE);
    const postPv = await ui.ev(READ_PREVIEW);
    const ifmut = await ui.ev(`return window.__IFMUT || 0`);

    const st = series(trace, "st");
    const deST = series(trace, "deST");
    const deSH = series(trace, "deSH");
    const caret = series(trace, "caretY");

    const asserts = [
      { id: "A1", ok: prePv.ok, why: `右屏可读 ${prePv.ok} ${prePv.reason || ""}` },
      { id: "A2", ok: pre.max > 300, why: `max=${pre.max}` },
      { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY}` },
      { id: "A4", ok: settled, why: `stable=${settled}` },
      {
        id: "A5",
        ok: op === "enter" ? (post.lines ?? 0) === (pre.lines ?? -1) + 1 : st.valid && Math.abs(st.net) > 5,
        why: op === "enter" ? `lines ${pre.lines}→${post.lines}` : `左屏净Δ=${st.net}（方向键应产生滚动）`,
      },
    ];
    const bad = asserts.filter((x) => !x.ok);
    if (bad.length) { ui.add(`C-${tag}`, "INVALID（前置断言不成立）", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); return null; }

    const sameFrame = (() => {
      if (!deST.valid || deST.maxUp <= 3) return null;
      // 找右屏最大正跳那一帧，读同帧左屏位移
      for (let i = 1; i < trace.length; i++) {
        if (trace[i].deST === undefined || trace[i - 1].deST === undefined) continue;
        if (Math.abs((trace[i].deST - trace[i - 1].deST) - deST.maxUp) < 0.01) {
          return { t: trace[i].t, dRight: Math.round((trace[i].deST - trace[i - 1].deST) * 100) / 100,
                   dLeft: Math.round(((trace[i].st ?? 0) - (trace[i - 1].st ?? 0)) * 100) / 100 };
        }
      }
      return null;
    })();

    ui.log(`[${tag}] 左屏 ${JSON.stringify({ net: st.net, up: st.maxUp, rev: st.reversals, frames: st.frames, deltas: st.deltas })}`);
    ui.log(`[${tag}] 右屏 ${JSON.stringify({ net: deST.net, up: deST.maxUp, at: deST.maxUpAt, down: deST.maxDown, downAt: deST.maxDownAt, bounce: deST.bounceGapMs, rev: deST.reversals, deltas: deST.deltas })}`);
    ui.log(`[${tag}] 右屏 scrollHeight 单帧最大变化 = ${deSH.valid ? Math.abs(deSH.last - deSH.first) : "?"}；iframe DOM mutation = ${ifmut}`);
    ui.log(`[${tag}] 同帧对照 = ${JSON.stringify(sameFrame)}；帧序 = ${JSON.stringify(trace.slice(0, 28).map((s) => `${s.t}:${s.st}/${s.deST}`))}`);
    return { tag, op, frac, st, deST, deSH, sameFrame, ifmut, pre, prePv };
  };

  await setTw(true);
  ui.log("[tw] active=" + (await readTw()));

  const enter = await run("ON·Enter·0.85", "enter", 0.85);
  // 撤销回车，恢复文档
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1200);
  const arrow = await run("ON·ArrowDown·0.85", "arrowdown", 0.85);
  // 再跑一次 Enter 交叉验证（顺序效应排除）
  const enter2 = await run("ON·Enter·0.85·第二次", "enter", 0.85);
  await ui.key("z", "KeyZ", 90, 2);
  await ui.sleep(1000);

  const rows = [enter, arrow, enter2].filter(Boolean);
  ui.log("[SUMMARY] " + JSON.stringify(rows.map((r) => ({
    tag: r.tag, op: r.op,
    left: { net: r.st.net, up: r.st.maxUp, rev: r.st.reversals },
    right: { net: r.deST.net, up: r.deST.maxUp, down: r.deST.maxDown, bounce: r.deST.bounceGapMs, rev: r.deST.reversals, frames: r.deST.frames },
    deSHchange: r.deSH.valid ? Math.abs(r.deSH.last - r.deSH.first) : null,
    iframeMutations: r.ifmut, sameFrame: r.sameFrame,
  })), null, 1));

  ui.add("C1", "★ 右屏猛跳与「改不改文档」无关（方向键同样触发）⇒ 不是内容重渲染",
    arrow && enter && (arrow.deST.maxUp > 3) === (enter.deST.maxUp > 3) ? "PASS" : "FAIL",
    `Enter: 右屏最大跳 ${enter?.deST.maxUp}px / iframe mutation ${enter?.ifmut}；` +
    `ArrowDown: 右屏最大跳 ${arrow?.deST.maxUp}px / iframe mutation ${arrow?.ifmut}`);
  ui.add("C2", "右屏跳变不是内容高度变化引起（scrollHeight 不变）",
    rows.every((r) => !r.deSH.valid || Math.abs(r.deSH.last - r.deSH.first) <= 1) ? "PASS" : "FAIL",
    rows.map((r) => `${r.tag}: scrollHeight ${r.deSH.valid ? r.deSH.first + "→" + r.deSH.last : "?"}`).join("；"));
  ui.add("C3", "右屏回弹时间差 ≈ 方向锁窗口 250ms（指向 syncToSource 反向接管）",
    rows.every((r) => r.deST.bounceGapMs !== null && Math.abs(r.deST.bounceGapMs - 250) <= 120) ? "PASS" : "KNOWN",
    rows.map((r) => `${r.tag}: 正跳@${r.deST.maxUpAt}ms 负跳@${r.deST.maxDownAt}ms 差 ${r.deST.bounceGapMs}ms`).join("；"));

  await ui.shot("rightcause");
});
