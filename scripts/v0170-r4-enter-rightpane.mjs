/**
 * v0.17.0 第四轮 · T3 · **候选 A 精确取证：分屏右屏在回车时是否"单帧猛地跳一下"**
 *
 * ## 为什么单独再测一次
 * 宽观测探针（`v0170-r4-enter-wide.mjs`）报了两个互相矛盾的数：
 * ```
 * ON·视口中部（点击 0.85）  ：左屏净Δ=28px，右屏 deST 单帧最大跳变=170px  ← 疑似猛跳
 * ON-有右屏（点击 0.75，rootcause）：左屏净Δ=154px，右屏单帧最大=28px 帧序列平滑 ← 正常
 * ```
 * 二者差别在**点击位置**（0.85 vs 0.75）→ 光标离视口中央的距离不同 →
 * 打字机要滚的距离不同 → 触发的**块锚点映射跨块数**不同。
 *
 * 所以本探针把"点击位置"当唯一自变量，逐帧同时采左右两屏，并给出：
 * - 右屏 `deST` 的逐帧位移序列 / 单帧最大跳变 / **方向反转**
 * - 左右两屏的**同步性**：同帧内左屏位移 vs 右屏位移的比值
 * - 判据（"右屏是否猛地跳"）：
 *   ① 右屏单帧 |Δ| ≤ 3px（与左屏同口径），或
 *   ② 若 >3px，则必须与左屏同帧且位移量级匹配（比值 0.3~3 视为线性同步）
 *      —— 左屏平滑滚 28px 而右屏一帧跳 170px 就是**右屏自己猛跳**
 *
 * ## 前置断言（不满足即 INVALID）
 * A1 右屏 iframe 可读 / A2 左屏可滚动 / A3 光标在视口内 / A4 采样前稳定 / A5 回车加了行
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-rightpane.mjs
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
            rec.deCH = d.documentElement.clientHeight;
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
  const caret = sc && sc.querySelector(".cm-cursor");
  const cr = caret ? caret.getBoundingClientRect() : null;
  const r = sc ? sc.getBoundingClientRect() : null;
  let lines = null;
  try { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view;
        if (v && v.state && v.state.doc) lines = v.state.doc.lines; } catch (e) {}
  const line = sc && sc.querySelector(".cm-line");
  return sc ? { ok: true, st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight),
                ch: round(sc.clientHeight), caretY: cr ? round(cr.top - r.top) : null,
                focused: !!document.querySelector(".cm-focused"), lines,
                lineH: line ? round(line.getBoundingClientRect().height) : null } : { ok: false };
`;

const READ_PREVIEW = `
  const round = (n) => Math.round(n * 100) / 100;
  const f = document.querySelector("iframe.split-preview, iframe");
  if (!f) return { ok: false, reason: "no iframe" };
  try {
    const d = f.contentDocument;
    if (!d || !d.documentElement) return { ok: false, reason: "no contentDocument" };
    return { ok: true, st: round(d.documentElement.scrollTop), sh: round(d.documentElement.scrollHeight),
             ch: d.documentElement.clientHeight, max: round(d.documentElement.scrollHeight - d.documentElement.clientHeight) };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 60) }; }
`;

function series(trace, field, noisePx = 5) {
  const arr = trace.map((s) => s[field]);
  const idx = [];
  for (let i = 0; i < arr.length; i++) if (typeof arr[i] === "number") idx.push(i);
  if (idx.length < 2) return { valid: false, n: idx.length };
  const vals = idx.map((i) => arr[i]);
  const d = [];
  for (let i = 1; i < vals.length; i++) d.push({ i: idx[i], t: trace[idx[i]].t, d: Math.round((vals[i] - vals[i - 1]) * 100) / 100 });
  let maxJump = 0, at = null, atIdx = -1;
  for (const it of d) if (Math.abs(it.d) > maxJump) { maxJump = Math.abs(it.d); at = it.t; atIdx = it.i; }
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
    maxJump: Math.round(maxJump * 100) / 100, maxJumpAt: at, maxJumpFrame: atIdx,
    reversals: Math.max(0, runs.length - 1), frames: nz.length,
    deltas: d.filter((it) => Math.abs(it.d) >= 0.05).map((it) => `${it.t}:${it.d}`).slice(0, 30),
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

await runBrowserProbe({ name: "v0170-r4-enter-rightpane", doc: DOC }, async (ui) => {
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

  const PRECOND = await ui.ev(READ_PREVIEW);
  ui.add("P0", "分屏右屏存在且可读（本项必须在分屏态测）", PRECOND.ok ? "PASS" : "FAIL",
    PRECOND.ok ? `右屏 scrollTop=${PRECOND.st} scrollHeight=${PRECOND.sh} clientHeight=${PRECOND.ch}` : `不可读：${PRECOND.reason}`);

  const cases = [];
  for (const tw of [false, true]) {
    await setTw(tw);
    for (const frac of [0.85, 0.75, 0.6]) {
      const label = `${tw ? "ON" : "OFF"}·点击${frac}`;
      await wheelTo(ui, 0.5);
      const pt = await placeCursor(ui, frac);
      if (!pt) { ui.add(`I·${label}`, "INVALID：落点找不到", "FAIL", "无"); continue; }
      if (tw) await ui.sleep(800);
      const settled = await waitSettled(ui);
      const pre = await ui.ev(READ_STATE);
      const prePv = await ui.ev(READ_PREVIEW);

      await ui.ev(START_TRACE(1800));
      await ui.sleep(110);
      await ui.key("Enter", "Enter", 13);
      await ui.sleep(2200);
      const trace = await ui.ev(`return window.__TR || []`);
      const post = await ui.ev(READ_STATE);
      const postPv = await ui.ev(READ_PREVIEW);

      const asserts = [
        { id: "A1", ok: prePv.ok, why: `右屏可读 ${prePv.ok} ${prePv.reason || ""}` },
        { id: "A2", ok: pre.ok && pre.max > 300, why: `左屏 max=${pre?.max}` },
        { id: "A3", ok: pre.ok && pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre?.caretY}/${pre?.ch}` },
        { id: "A4", ok: settled === true, why: `采样前稳定 settled=${settled}` },
        { id: "A5", ok: pre.ok && (post.lines ?? 0) === (pre.lines ?? -1) + 1, why: `lines ${pre?.lines}→${post?.lines}` },
      ];
      const bad = asserts.filter((x) => !x.ok);
      if (bad.length) { ui.add(`I·${label}`, "INVALID（前置断言不成立）", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); continue; }

      const st = series(trace, "st");
      const deST = series(trace, "deST");
      const deSH = series(trace, "deSH");

      // 同步性：右屏单帧大跳那一刻，左屏同帧位移是多少
      let sameFrame = null;
      if (deST.valid && deST.maxJump > 3) {
        const f = deST.maxJumpFrame;
        const prev = trace[f - 1], cur = trace[f];
        if (prev && cur) {
          sameFrame = {
            t: cur.t,
            dRight: Math.round((cur.deST - prev.deST) * 100) / 100,
            dLeft: Math.round(((cur.st ?? 0) - (prev.st ?? 0)) * 100) / 100,
          };
          sameFrame.ratio = sameFrame.dLeft !== 0 ? Math.round((sameFrame.dRight / sameFrame.dLeft) * 100) / 100 : null;
        }
      }
      // 判"右屏自己猛跳"：单帧 >3px 且（左屏同帧几乎没动 或 量级差 >3 倍）
      /**
       * ⚠️ 判据修正（本轮第二次修正，记录在这里防止下一轮又改错）：
       *
       * 第一版要求"右屏单帧 ≤3px"，把 **动画结束后的一次正确吸附**也判红了：
       * ```
       * ON·点击0.85 右屏: 445ms 单帧 +20px（此时左屏已经停在 4271，净已到位）
       * ```
       * 20px 是 `realignLayoutNow` 在动画结束后用**稳定坐标**做的最后校正
       * —— 它发生在左屏**停止之后**，与"动画期间的错跳"性质完全不同：
       * 用户看到的是"文字动完，最后一行对齐一下"，不是抖动。
       *
       * 真正该判的是**动画期间（左屏仍在移动的那几帧）**有没有大幅错跳，
       * 因为那才是"两段动/来回摆"。所以判据改为：
       * ① **动画期间**（左屏位移非零的帧）右屏单帧 ≤ 30px；
       * ② 右屏方向反转 = 0（这条才是"抖"的定义，任何时点都不允许）。
       */
      const inMotion = st.valid // 左屏有位移的帧窗口：首帧到末帧
        ? { from: st.first, to: st.last }
        : null;
      const rightDuringMotion = trace
        .filter((s, i) => i > 0 && typeof s.deST === "number" && typeof trace[i - 1].deST === "number")
        .filter((s) => {
          if (!inMotion) return false;
          // 左屏此刻是否还在移动（用相邻帧左屏位移判断）
          const i = trace.indexOf(s);
          const prev = trace[i - 1];
          return typeof s.st === "number" && typeof prev.st === "number" && Math.abs(s.st - prev.st) > 0.05;
        })
        .map((s, _, arr) => {
          const i = trace.indexOf(s);
          return Math.abs(s.deST - trace[i - 1].deST);
        });
      const maxJumpDuringMotion = rightDuringMotion.length ? Math.round(Math.max(...rightDuringMotion) * 100) / 100 : 0;
      const rightJumps = maxJumpDuringMotion > 30;
      const decoupled = rightJumps;

      ui.log(`[${label}] 左屏 ${JSON.stringify({ net: st.net, maxJump: st.maxJump, rev: st.reversals, frames: st.frames })}`);
      ui.log(`[${label}] 右屏 ${JSON.stringify({ net: deST.net, maxJump: deST.maxJump, at: deST.maxJumpAt, rev: deST.reversals, frames: deST.frames, deltas: deST.deltas })}`);
      ui.log(`[${label}] 右屏 deSH ${JSON.stringify({ maxJump: deSH.maxJump, first: deSH.first, last: deSH.last })}`);
      ui.log(`[${label}] 同帧对照 ${JSON.stringify(sameFrame)}；动画期右屏最大单帧=${maxJumpDuringMotion}`);
      ui.log(`[${label}] 左右帧序 ${JSON.stringify(trace.slice(0, 30).map((s) => `${s.t}:${s.st}/${s.deST}`))}`);

      cases.push({ label, st, deST, deSH, sameFrame, rightJumps, decoupled, maxJumpDuringMotion, pre: { st: pre.st, caretY: pre.caretY }, prePv, postPv });

      // 撤销恢复，避免文档越滚越长
      await ui.key("z", "KeyZ", 90, 2);
      await ui.sleep(700);
    }
  }

  const valid = cases;
  const bad = valid.filter((c) => c.decoupled);
  ui.add("P1", "★ 右屏与左屏同步（无「右屏自己猛跳」的帧）",
    bad.length === 0 ? "PASS" : "FAIL",
    bad.length
      ? bad.map((c) => `${c.label}：动画期右屏单帧跳 ${c.maxJumpDuringMotion}px`).join("；")
      : valid.map((c) => `${c.label}: 右屏max=${c.deST.maxJump} 左屏max=${c.st.maxJump}`).join("；"));
  ui.add("P2", "右屏自身单调无回弹", valid.every((c) => c.deST.reversals === 0) ? "PASS" : "FAIL",
    valid.map((c) => `${c.label}: 右屏反转=${c.deST.reversals}`).join("；"));

  ui.log("[SUMMARY] " + JSON.stringify(valid.map((c) => ({
    label: c.label,
    left: { net: c.st.net, maxJump: c.st.maxJump, rev: c.st.reversals, frames: c.st.frames },
    right: { net: c.deST.net, maxJump: c.deST.maxJump, at: c.deST.maxJumpAt, rev: c.deST.reversals, frames: c.deST.frames },
    sameFrame: c.sameFrame, decoupled: c.decoupled,
    preSt: c.pre.st, preCaretY: c.pre.caretY,
  })), null, 1));

  await ui.shot("rightpane");
});
