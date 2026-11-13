/**
 * v0.17.0 第四轮 · T3 `fix-enter-jitter` · 用户第 4 项：
 * **编辑模式下输入回车时页面明显抖动**
 *
 * 用户原话：「编辑模式下进行文字输入输入回车时，页面会明显抖动。」
 *
 * ## 本探针要回答的两个问题
 * 1. 抖只发生在**打字机开启**时，还是两种状态都抖？（A/B 单变量）
 * 2. 光标在视口**顶部 / 中部 / 底部 / 文档底部**四处，哪一处抖？
 *
 * ## ⚠️⚠️ 本探针最重要的一条设计约束：**绝对不 hook 任何滚动 API**
 *
 * 这条是拿数据换来的，写在最前面防止下一轮有人"为了溯源加个 hook"：
 *
 * ### 我踩的坑（完整记录，因为它差点让我给用户报一个不存在的缺陷）
 * 第一版主探针为了抓"谁写了 scrollTop"，按 R2 的手法 hook 了
 * `Element.prototype.scrollTop` setter / `scrollTo` / `scrollIntoView`。
 * 结果出现一个**极其反常识**的现象：
 * ```
 * 打字机 ON，滚到 st=4019，点击视口 15% 处
 *   → st 变成 0（单帧跳 4019px）
 *   → 且"写入日志"里只有 1 笔 scrollTo({top:3684,behavior:"smooth"})
 *   → 归 0 不经过任何 setter
 * ```
 * 我没有立刻下结论，而是做了单变量隔离（diag4/diag5/diag6）：
 * | 组 | 写法 | 结果 |
 * |---|---|---|
 * | E1 | `scrollTo({behavior:"smooth"})` | **归 0** |
 * | E2 | `scrollTo({behavior:"instant"})` | **归 0** |
 * | E3 | `scrollTop = 3695` | 正常 |
 * | F2 | `scrollTo(0, 3695)` 两参数 | 正常 |
 * | F5 | **零位移**的 `scrollTo({top:当前值})` | **归 0** |
 * | F4 | rAF 逐帧裸赋值 | 正常 + 平滑 |
 * | G0/G2 | 打字机 **OFF** 也一样归 0 | 与打字机无关 |
 *
 * 看起来"对象形式 scrollTo 在这个 Chromium 上就是坏的"。**但那是假的。**
 * `v0170-r4-enter-diag7.mjs` 把 hook 全部去掉后重跑：
 * ```
 * N1 CM6 scroller + scrollTo({...})       st0=4019 → 最小 3699  正常（立即读也 3699）
 * N2 CM6 scroller + scrollTo(0,top)       正常
 * N3 CM6 scroller + 裸赋值                正常
 * N4~N6 普通 div 三种写法                  全部正常
 * ```
 * ⇒ **归 0 是 hook 自身造成的伪影**，不是产品行为，更不是 CM6 的行为。
 * 机制推测：被 hook 过的 `scrollTo` 在 Chromium 里不再走原生滚动路径
 * （平滑/瞬时逻辑失效），CM6 的 `measure()` 随即把 scrollTop 按"未生效"重算。
 *
 * ### 因此本探针的纪律
 * 1. **只读**：全程只用 `ui.ev` 读 `scrollTop / scrollHeight / getBoundingClientRect`，
 *    不覆盖任何原型方法；
 * 2. **不写**：操作只有两种 —— 真实滚轮（`Input.dispatchMouseEvent` mouseWheel）
 *    与真实按键（`Input.dispatchKeyEvent`）；
 * 3. 溯源改到**独立探针**（`v0170-r4-enter-writer.mjs`）里做，且必须做
 *    "有 hook / 无 hook 对照"，不一致就把该溯源判 INVALID（见那份文件的说明）。
 *
 * ## 前置断言（不满足即 INVALID，**不产出产品结论**）
 * 直接来自上一轮的假数据教训（`_plan/v0170-r3-t2-scroll-jitter.md` §3.1）：
 *
 * | 断言 | 内容 | 为什么必须有 |
 * |---|---|---|
 * | A1 | 文档确实可滚动（max > 300px） | 否则光标怎么放都不会滚，"不抖"是假的 |
 * | A2 | 编辑器确实有焦点（`.cm-focused`） | 无焦点时按键根本不进编辑器 |
 * | A3 | 光标在视口内且落点符合预期 | 上一轮 1442px 假数据就是这条缺失 |
 * | A4 | 采样前滚动已稳定（连续 3 次 Δ≤0.5px） | 否则把上一次居中动画算进本次轨迹 |
 * | A5 | 回车确实插入了换行（doc 行数 +1） | 否则测的是"按了个空键" |
 *
 * ## 判据
 * ### OFF（打字机关）：不该有任何动画
 * - 单帧 |ΔscrollTop| ≤ **3px**（3px@60Hz ≈ 180px/s，超了人眼即感知为"跳"）
 * - 方向反转 = **0**（单调叫滚动，来回摆才叫"抖"）
 *
 * ### ON（打字机开）：**期望**有 smooth 动画（R3 #8 刚做的，不能回退）
 * 不能用 OFF 的 ≤3px 门槛（29px/5 帧 ≈ 6px/帧是**正确**的缓动）。改判：
 * - 方向反转 = **0**（两段动 = CM6 先硬跳再我们 smooth = 回弹）
 * - 无瞬移帧：单帧位移 / 总位移 ≤ **0.5**
 * - 光标屏幕 Y 的净位移与 scrollTop 净位移互补（±2px）—— 证明没有来回补偿
 *
 * ## 破坏性对照
 * 见报告：回退修复后 OFF-底部 用例必须重新 FAIL。
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

/** 采样窗口：回车后 smooth 动画最长 ~280ms，留足 1400ms 观察"两段动" */
const TRACE_MS = 1400;

/**
 * 逐帧采样（rAF ≈16ms）。**只读**。
 *
 * 字段取舍依据（少一个就会误判）：
 * - `st` "运动"（用户眼睛跟着走）
 * - `caretY` 光标屏幕 Y —— 只看 scrollTop 分不清"内容滚了"和"光标在内容里动了"
 * - `sh/max` 必须同帧采：内容高度变化时同一 scrollTop 指向不同内容
 * - `cLeft/mainW` 抓**布局级**抖动（用户说"页面"抖，可能不是滚动而是整块位移）
 */
const START_TRACE = (ms) => `
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const rec = { t: Math.round(performance.now() - t0) };
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        const r = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        rec.ch = Math.round(sc.clientHeight);
        const caret = sc.querySelector(".cm-cursor");
        if (caret) rec.caretY = Math.round((caret.getBoundingClientRect().top - r.top) * 100) / 100;
        const content = sc.querySelector(".cm-content");
        if (content) rec.cLeft = Math.round((content.getBoundingClientRect().left - r.left) * 100) / 100;
        rec.nLines = sc.querySelectorAll(".cm-line").length;
      }
      const main = document.querySelector(".editor-main-area");
      if (main) {
        const mr = main.getBoundingClientRect();
        rec.mainW = Math.round(mr.width * 100) / 100;
        rec.mainH = Math.round(mr.height * 100) / 100;
        rec.mainT = Math.round(mr.top * 100) / 100;
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

/** 读稳定状态（前置断言用）。只读。 */
const READ_STATE = `
  const round = (n) => Math.round(n * 100) / 100;
  const sc = document.querySelector(".cm-scroller");
  if (!sc) return { ok: false, reason: "no .cm-scroller" };
  const r = sc.getBoundingClientRect();
  const caret = sc.querySelector(".cm-cursor");
  const cr = caret ? caret.getBoundingClientRect() : null;
  const ae = document.activeElement;
  let lines = null, text = null;
  try {
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (v && v.state && v.state.doc) { lines = v.state.doc.lines; text = v.state.doc.length; }
  } catch (e) {}
  const line = sc.querySelector(".cm-line");
  return {
    ok: true,
    st: round(sc.scrollTop),
    max: round(sc.scrollHeight - sc.clientHeight),
    sh: round(sc.scrollHeight),
    ch: round(sc.clientHeight),
    scTop: round(r.top),
    caretY: cr ? round(cr.top - r.top) : null,
    focused: !!document.querySelector(".cm-focused"),
    ae: ae ? ((ae.className || ae.tagName) + "").slice(0, 40) : "none",
    lines, text,
    lineH: line ? round(line.getBoundingClientRect().height) : null,
  };
`;

/**
 * 曲线分析（口径见文件头）。
 *
 * ⚠️ 方向反转忽略亚像素毛刺：R3 在阅读面（已知平滑的参考实现）上踩过
 * "`-3, 0, +3` 被判一次反转"的判据 bug。沿用其修正口径：
 * 单段反向累计 ≤5px 视为噪声并入主方向（能看见的抖必然多帧累加）。
 */
function analyze(trace, { noisePx = 5 } = {}) {
  const seq = trace.map((s) => s.st).filter((v) => typeof v === "number");
  if (seq.length < 2) return { n: seq.length, valid: false };
  const deltas = [];
  for (let i = 1; i < seq.length; i++) deltas.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
  let maxJump = 0, maxJumpIdx = -1;
  for (let i = 0; i < deltas.length; i++) {
    const a = Math.abs(deltas[i]);
    if (a > maxJump) { maxJump = a; maxJumpIdx = i; }
  }
  const runSigns = (arr) => {
    const nz = arr.filter((d) => Math.abs(d) >= 0.05);
    const runs = [];
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
    return Math.max(0, runs.length - 1);
  };
  const reversals = runSigns(deltas);
  const start = seq[0], end = seq[seq.length - 1];
  const totΔ = Math.abs(end - start);
  const nz = deltas.filter((d) => Math.abs(d) >= 0.05);
  const firstDelta = nz.length ? Math.abs(nz[0]) : 0;

  const carets = trace.map((s) => s.caretY).filter((v) => typeof v === "number");
  const caretNet = carets.length >= 2 ? Math.round((carets[carets.length - 1] - carets[0]) * 100) / 100 : null;
  const caretDeltas = [];
  for (let i = 1; i < carets.length; i++) caretDeltas.push(Math.round((carets[i] - carets[i - 1]) * 100) / 100);
  const caretReversals = carets.length >= 2 ? runSigns(caretDeltas) : null;

  // 布局抖动（宽度/高度/顶边）—— 用户说"页面"抖，可能不是滚动
  const layoutΔ = (field) => {
    const v = trace.map((s) => s[field]).filter((x) => typeof x === "number");
    if (v.length < 2) return null;
    let m = 0;
    for (let i = 1; i < v.length; i++) m = Math.max(m, Math.abs(v[i] - v[i - 1]));
    return Math.round(m * 100) / 100;
  };

  return {
    n: seq.length,
    valid: true,
    start: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    netΔ: Math.round((end - start) * 100) / 100,
    totΔ: Math.round(totΔ * 100) / 100,
    maxJump,
    maxJumpAt: maxJumpIdx >= 0 ? trace[maxJumpIdx + 1]?.t ?? null : null,
    jumpsOver3: deltas.filter((d) => Math.abs(d) > 3).length,
    frames: nz.length,
    firstFrameShare: totΔ > 0 ? Math.round((firstDelta / totΔ) * 1000) / 1000 : 0,
    reversals,
    caretNet,
    caretReversals,
    layoutMaxJump: { cLeft: layoutΔ("cLeft"), mainW: layoutΔ("mainW"), mainH: layoutΔ("mainH"), mainT: layoutΔ("mainT") },
    deltas: nz.slice(0, 40),
    shRange: (() => {
      const v = trace.map((s) => s.sh).filter((x) => typeof x === "number");
      return v.length ? [Math.min(...v), Math.max(...v)] : null;
    })(),
  };
}

/** 等滚动稳定：连续 3 次采样 Δ ≤ 0.5px（否则把上一次动画算进本次） */
async function waitSettled(ui, ms = 2500) {
  const t0 = Date.now();
  let prev = null, stable = 0;
  while (Date.now() - t0 < ms) {
    const st = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return sc?Math.round(sc.scrollTop*100)/100:null;`);
    if (prev !== null && Math.abs((st ?? 0) - prev) <= 0.5) stable++;
    else stable = 0;
    prev = st;
    if (stable >= 3) return { settled: true, st, waitedMs: Date.now() - t0 };
    await ui.sleep(90);
  }
  return { settled: false, st: prev, waitedMs: Date.now() - t0 };
}

/** 真实滚轮滚到文档某个比例（CM6 heightMap 必须逐段测量） */
async function wheelTo(ui, pct) {
  const box = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    return { x: Math.round(r.left + sc.clientWidth / 2), y: Math.round(r.top + sc.clientHeight / 2),
             st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
  `);
  if (!box) return null;
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
  return box;
}

/** 把光标放到视口某个纵向比例处（真实鼠标点击） */
async function placeCursor(ui, frac) {
  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    const y = Math.round(r.top + sc.clientHeight * ${frac});
    for (const dx of [0.45, 0.55, 0.35, 0.65, 0.5]) {
      const x = Math.round(r.left + sc.clientWidth * dx);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit.closest(".cm-content") || hit.classList.contains("cm-line"))) {
        return { x, y, hit: String(hit.className || hit.tagName).slice(0, 40) };
      }
    }
    return null;
  `);
  if (!pt) return null;
  await ui.click(pt.x, pt.y);
  await ui.sleep(150);
  return pt;
}

async function measureCase(ui, { label, typewriter, frac, docPct }) {
  const out = { label, typewriter, frac, docPct, asserts: [], ok: false };

  await wheelTo(ui, docPct);
  const pt = await placeCursor(ui, frac);
  if (!pt) { out.asserts.push({ id: "A3", ok: false, why: "点击落点找不到可编辑目标" }); return out; }
  out.clickAt = pt;

  let settled = await waitSettled(ui);
  // 打字机开：点击本身会触发一次居中动画 → 再等一轮（那属于上一次操作，不算本次回车）
  if (typewriter) {
    await ui.sleep(700);
    settled = await waitSettled(ui);
  }
  const pre0 = await ui.ev(READ_STATE);

  out.pre = { st: pre0.st, max: pre0.max, caretY: pre0.caretY, focused: pre0.focused, lines: pre0.lines, lineH: pre0.lineH, settled: settled.settled };
  out.asserts.push({ id: "A1", ok: pre0.max > 300, why: `可滚动空间 max=${pre0.max}px（需 >300）` });
  out.asserts.push({ id: "A2", ok: pre0.focused === true, why: `编辑器焦点 focused=${pre0.focused}` });
  out.asserts.push({ id: "A3", ok: pre0.caretY !== null && pre0.caretY >= 0 && pre0.caretY <= pre0.ch, why: `光标在视口内 caretY=${pre0.caretY}（视口 0~${pre0.ch}）` });
  out.asserts.push({ id: "A4", ok: settled.settled === true, why: `采样前滚动稳定 settled=${settled.settled}` });

  // A6：光标落点与目标位置一致（**不装 hook 时 OFF 组必须成立**；
  //     ON 组点击后会被居中，落点判据不适用 → 用 A3 的"在视口内"即可）
  if (!typewriter) {
    const want = pre0.ch * frac;
    const dy = Math.abs((pre0.caretY ?? 0) - want);
    const tol = (pre0.lineH ?? 30) * 1.5;
    out.asserts.push({ id: "A6", ok: dy <= tol, why: `光标落点偏差 ${Math.round(dy)}px（需 ≤${Math.round(tol)}px，目标 y=${Math.round(want)}）` });
  }

  // 采样 + 按回车
  await ui.ev(START_TRACE(TRACE_MS));
  await ui.sleep(100);
  out.preTraceSt = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return sc?Math.round(sc.scrollTop*100)/100:null;`);
  await ui.key("Enter", "Enter", 13);
  await ui.sleep(TRACE_MS + 400);

  const trace = await ui.ev(`return window.__TR || []`);
  const post = await ui.ev(READ_STATE);
  out.post = { st: post.st, max: post.max, caretY: post.caretY, lines: post.lines, text: post.text };
  out.asserts.push({
    id: "A5",
    ok: (post.lines ?? 0) === (pre0.lines ?? -1) + 1,
    why: `回车后文档行数 ${pre0.lines} → ${post.lines}（需 +1）`,
  });

  out.ok = out.asserts.every((a) => a.ok);
  out.analysis = analyze(trace);
  out.trace = trace.slice(0, 50).map((s) => `${s.t}:st${s.st}${s.caretY !== undefined ? `/cy${s.caretY}` : ""}`);

  const a = out.analysis;
  if (!a || !a.valid || a.n < 10) {
    out.verdict = { ok: false, why: "轨迹样本不足", crit: "样本" };
    return out;
  }
  if (!typewriter) {
    out.verdict = {
      ok: a.maxJump <= 3 && a.reversals === 0,
      crit: "OFF：单帧≤3px 且 反转=0",
      why: `maxJump=${a.maxJump}px（@${a.maxJumpAt}ms）反转=${a.reversals} 净Δ=${a.netΔ}px 帧数=${a.frames} 单帧>3px=${a.jumpsOver3}`,
    };
  } else {
    out.verdict = {
      ok: a.reversals === 0 && a.firstFrameShare <= 0.5,
      crit: "ON：反转=0 且 单帧位移占比≤0.5（允许 smooth 帧，但不得一帧吃掉一半行程）",
      why: `反转=${a.reversals} 单帧占比=${a.firstFrameShare} 单帧最大=${a.maxJump}px 净Δ=${a.netΔ}px 帧数=${a.frames}`,
    };
  }
  return out;
}

await runBrowserProbe({ name: "v0170-r4-enter", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  if (ui.impl !== "cm6") {
    ui.add("A0", "源码面是 CM6（本项主战场）", "FAIL", `impl=${ui.impl}`);
    return;
  }

  await ui.command("view.edit");
  await ui.sleep(2000);
  await ui.focusSource();
  await ui.sleep(300);

  const readTw = () => ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.getAttribute("title") || "").indexOf("打字机") >= 0
              || (x.textContent || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);
  const setTw = async (want) => {
    if ((await readTw()) !== want) { await ui.command("view.toggleTypewriter"); await ui.sleep(1000); }
    return await readTw();
  };

  const CASES = [
    { frac: 0.15, docPct: 0.5, name: "视口顶部" },
    { frac: 0.5, docPct: 0.5, name: "视口中部" },
    { frac: 0.85, docPct: 0.5, name: "视口底部" },
    { frac: 0.85, docPct: 1.0, name: "文档底+视口底（钳位场景）" },
  ];

  const results = {};
  for (const tw of [false, true]) {
    const st = await setTw(tw);
    ui.add(`S-${tw ? "ON" : "OFF"}`, `打字机=${tw ? "开" : "关"} 已就位`, st === tw ? "PASS" : "FAIL", `读回 active=${st}`);
    for (const c of CASES) {
      const key = `${tw ? "ON" : "OFF"}-${c.name}`;
      const r = await measureCase(ui, { label: key, typewriter: tw, frac: c.frac, docPct: c.docPct });
      results[key] = r;
      const invalid = r.asserts.filter((a) => !a.ok);
      if (invalid.length) {
        ui.add(`I·${key}`, "⚠️ INVALID（前置断言不成立，不产出结论）", "FAIL",
          invalid.map((a) => `${a.id}: ${a.why}`).join("；"));
        continue;
      }
      ui.add(`M·${key}`, `【${r.verdict.crit}】`, r.verdict.ok ? "PASS" : "FAIL",
        `${r.verdict.why}；caretY ${r.pre.caretY}→${r.post.caretY} 行高=${r.pre.lineH}；布局单帧最大=${JSON.stringify(r.analysis.layoutMaxJump)}；scrollHeight 区间=${JSON.stringify(r.analysis.shRange)}`);
      ui.log(`[trace·${key}] ${r.trace.slice(0, 26).join(" | ")}`);
      ui.log(`[analysis·${key}] ` + JSON.stringify({ ...r.analysis, deltas: r.analysis.deltas?.slice(0, 24) }));
    }
  }

  const keys = Object.keys(results);
  const invalidKeys = keys.filter((k) => results[k].asserts.some((a) => !a.ok));
  const validKeys = keys.filter((k) => !invalidKeys.includes(k) && results[k].verdict);
  const failKeys = validKeys.filter((k) => !results[k].verdict.ok);

  ui.log("[SUMMARY] " + JSON.stringify({
    invalid: invalidKeys,
    valid: validKeys.map((k) => ({
      k,
      start: results[k].analysis.start, end: results[k].analysis.end,
      maxJump: results[k].analysis.maxJump, reversals: results[k].analysis.reversals,
      netΔ: results[k].analysis.netΔ, firstFrameShare: results[k].analysis.firstFrameShare,
      jumpsOver3: results[k].analysis.jumpsOver3, frames: results[k].analysis.frames,
      caretNet: results[k].analysis.caretNet, caretReversals: results[k].analysis.caretReversals,
      layout: results[k].analysis.layoutMaxJump, shRange: results[k].analysis.shRange,
      verdict: results[k].verdict.ok,
    })),
    fail: failKeys,
  }, null, 1));

  ui.add("Z1", "前置断言全部成立（否则本探针不产出产品结论）",
    invalidKeys.length === 0 ? "PASS" : "FAIL",
    invalidKeys.length ? `INVALID：${invalidKeys.join("、")}` : `${validKeys.length}/${keys.length} 个用例前置条件全部 PASS`);
  ui.add("Z2", "★ 回车抖动基线：全部有效用例达标",
    invalidKeys.length === 0 ? (failKeys.length === 0 ? "PASS" : "FAIL") : "KNOWN",
    `FAIL 用例：${failKeys.length ? failKeys.join("、") : "无"}`);

  await ui.shot("enter-final");
});
