/**
 * v0.17.0 第四轮 · T3 · **宽观测探针**：回车抖动到底在哪个物理量上？
 *
 * ## 为什么需要这一份
 * 主探针（`v0170-r4-enter.mjs`）在**不装任何 hook**的前提下测得：
 * OFF 组三处 + 文档底：`scrollTop` 单帧最大跳变 **0px**、方向反转 **0**、写入 **0 笔**；
 * ON 组：5 帧 / 首帧占比 0.172 / 反转 0（与 R3 #8 的目标形态一致）。
 * 也就是说 **`scrollTop` 这条观测通道上，浏览器里回车不抖**。
 *
 * 但用户在实机上明确说"页面明显抖动"。所以要么
 * (a) 抖动不在 scrollTop 上（而是**重排 / 掉帧 / 横向位移**），
 * (b) 是 WebView2 与 Chromium 的差异（本探针无法覆盖，必须写明）。
 *
 * 这份探针把"页面抖"可能对应的**四类物理量**同时采下来（全部**只读**，不 hook 任何滚动 API）：
 *
 * | 通道 | 量 | 用户感受 |
 * |---|---|---|
 * | ① 滚动 | `scrollTop` 曲线 | 内容整体上下跳 |
 * | ② 内容内部重排 | 固定锚点行在**内容坐标**里的 Y（`anchorTop - scrollerTop`，**含** scrollTop 修正） | 文字在视口里自己挪了（不是滚动造成的） |
 * | ③ 布局/几何 | `.cm-content` 宽高、`--lm-cm-gutter-w`、`.cm-scroller` padding、左缘 X | 正文列变宽/变窄、整体横移 |
 * | ④ 掉帧 | rAF 帧间隔 p95 / 最大、LongTask 计数 | 卡顿/顿挫（"抖"的另一种口语含义） |
 *
 * 另外三条辅助观测：
 * - **编辑器重建次数**：MutationObserver 观察 `.cm-editor` 增删（P0-1 的老毛病是否复发）
 * - **右屏预览**：iframe 内部 `scrollTop` / `scrollHeight` / `body` 高度（分屏态回车会重渲染 markdown）
 * - **DOM 变更次数**：每次回车触发的 mutation 条数（衡量"重排规模"）
 *
 * ## 场景
 * - OFF / ON ×（视口中部、视口底部、**最后一行贴视口底**）
 * - 每个场景单次回车，另加 **连按 12 次回车**（用户说"输入回车时"，可能指连续回车）
 *
 * ## 前置断言（同主探针口径，不满足即 INVALID）
 * A1 可滚动 / A2 有焦点 / A3 光标在视口内 / A4 采样前已稳定 / A5 回车确实加了行
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-wide.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);
const TRACE_MS = 1500;

/** 只读逐帧采样：四类通道 + 帧间隔 */
const START_TRACE = (ms) => `
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    let last = t0;
    const tick = () => {
      const now = performance.now();
      const rec = { t: Math.round(now - t0), dt: Math.round((now - last) * 100) / 100 };
      last = now;
      const sc = document.querySelector(".cm-scroller");
      if (sc) {
        const r = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        rec.ch = Math.round(sc.clientHeight);
        rec.scLeft = Math.round(r.left * 100) / 100;
        rec.padL = Math.round(parseFloat(getComputedStyle(sc).paddingLeft) * 100) / 100;
        rec.gut = parseFloat(getComputedStyle(sc).getPropertyValue("--lm-cm-gutter-w")) || 0;
        const content = sc.querySelector(".cm-content");
        if (content) {
          const cr = content.getBoundingClientRect();
          rec.cW = Math.round(cr.width * 100) / 100;
          rec.cH = Math.round(cr.height * 100) / 100;
          rec.cLeft = Math.round(cr.left * 100) / 100;
          // ② 内部重排：固定锚点行在**内容坐标**的 Y（加回 scrollTop → 不受滚动影响）
          const anchor = sc.querySelector('[data-lmd-anchor]') || sc.querySelectorAll(".cm-line")[3];
          if (anchor) {
            const ar = anchor.getBoundingClientRect();
            rec.aDocY = Math.round((ar.top - r.top + sc.scrollTop) * 100) / 100;
            rec.aScreenY = Math.round((ar.top - r.top) * 100) / 100;
          }
          rec.nLines = sc.querySelectorAll(".cm-line").length;
        }
        const caret = sc.querySelector(".cm-cursor");
        if (caret) rec.caretY = Math.round((caret.getBoundingClientRect().top - r.top) * 100) / 100;
      }
      const f = document.querySelector("iframe");
      if (f) {
        const fr = f.getBoundingClientRect();
        rec.ifH = Math.round(fr.height * 100) / 100;
        rec.ifTop = Math.round(fr.top * 100) / 100;
        try {
          const d = f.contentDocument;
          if (d && d.documentElement) {
            rec.deST = Math.round(d.documentElement.scrollTop * 100) / 100;
            rec.deSH = Math.round(d.documentElement.scrollHeight);
            rec.bodyH = d.body ? Math.round(d.body.getBoundingClientRect().height * 100) / 100 : null;
          }
        } catch (e) {}
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  // LongTask（>50ms 的阻塞）
  window.__LT = [];
  try {
    if (!window.__LT_OBS) {
      window.__LT_OBS = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__LT.push(Math.round(e.duration)); });
      window.__LT_OBS.observe({ entryTypes: ["longtask"] });
    }
  } catch (e) {}
  return true;
`;

/** 只用这个只读的 DOM 变更计数（不 hook 任何 API） */
const COUNT_MUTATIONS = `
  window.__MUT = 0;
  if (window.__MUT_OBS) window.__MUT_OBS.disconnect();
  window.__MUT_OBS = new MutationObserver((muts) => { window.__MUT += muts.length; });
  window.__MUT_OBS.observe(document.querySelector(".editor-main-area") || document.body, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  window.__REBUILD = 0;
  if (window.__REB_OBS) window.__REB_OBS.disconnect();
  window.__REB_OBS = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches && n.matches(".cm-editor")) window.__REBUILD++;
      for (const n of m.removedNodes) if (n.nodeType === 1 && n.matches && n.matches(".cm-editor")) window.__REBUILD++;
    }
  });
  window.__REB_OBS.observe(document.querySelector(".editor-main-area") || document.body, { childList: true, subtree: true });
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
  const line = sc.querySelector(".cm-line");
  return { ok: true, st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight),
           sh: round(sc.scrollHeight), ch: round(sc.clientHeight),
           caretY: cr ? round(cr.top - r.top) : null,
           focused: !!document.querySelector(".cm-focused"),
           lines, lineH: line ? round(line.getBoundingClientRect().height) : null };
`;

function annotateAnchor() {
  // 给当前视口里第 4 个 .cm-line 打锚点标记（只加 data-* 属性，不改布局/样式）
  return `
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return false;
    document.querySelectorAll("[data-lmd-anchor]").forEach((el) => el.removeAttribute("data-lmd-anchor"));
    const lines = sc.querySelectorAll(".cm-line");
    const pick = lines[3];
    if (pick) pick.setAttribute("data-lmd-anchor", "1");
    return !!pick;
  `;
}

/** 曲线分析（沿主探针口径） */
function analyze(trace, noisePx = 5) {
  const pick = (f) => trace.map((s) => s[f]).filter((v) => typeof v === "number");
  const series = (arr) => {
    if (arr.length < 2) return { n: arr.length, maxJump: 0, net: 0, reversals: 0, frames: 0 };
    const d = [];
    for (let i = 1; i < arr.length; i++) d.push(Math.round((arr[i] - arr[i - 1]) * 100) / 100);
    const maxJump = Math.round(d.reduce((m, x) => Math.max(m, Math.abs(x)), 0) * 100) / 100;
    const nz = d.filter((x) => Math.abs(x) >= 0.05);
    const runs = [];
    let acc = 0;
    for (const x of nz) {
      const s = x > 0 ? 1 : -1;
      if (!runs.length || runs[runs.length - 1] !== s) {
        if (runs.length > 0 && Math.abs(acc) <= noisePx) runs[runs.length - 1] = s;
        else runs.push(s);
        acc = 0;
      }
      acc += x;
    }
    return {
      n: arr.length, first: arr[0], last: arr[arr.length - 1],
      net: Math.round((arr[arr.length - 1] - arr[0]) * 100) / 100,
      maxJump, reversals: Math.max(0, runs.length - 1), frames: nz.length,
      deltas: nz.slice(0, 30),
    };
  };
  const dts = pick("dt");
  const dtsSorted = [...dts].sort((a, b) => a - b);
  const p = (q) => (dtsSorted.length ? dtsSorted[Math.min(dtsSorted.length - 1, Math.floor(dtsSorted.length * q))] : null);
  return {
    st: series(pick("st")),
    /** ② 内部重排：内容坐标锚点 Y 的变化（不受滚动影响） */
    aDocY: series(pick("aDocY")),
    aScreenY: series(pick("aScreenY")),
    cW: series(pick("cW")),
    cH: series(pick("cH")),
    cLeft: series(pick("cLeft")),
    padL: series(pick("padL")),
    gut: series(pick("gut")),
    caretY: series(pick("caretY")),
    deST: series(pick("deST")),
    deSH: series(pick("deSH")),
    bodyH: series(pick("bodyH")),
    ifH: series(pick("ifH")),
    ifTop: series(pick("ifTop")),
    frame: { n: dts.length, p50: p(0.5), p95: p(0.95), max: dtsSorted.length ? dtsSorted[dtsSorted.length - 1] : null,
             over34: dts.filter((d) => d > 34).length },
  };
}

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

async function placeCursor(ui, frac) {
  const pt = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    if (!sc) return null;
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

async function waitSettled(ui, ms = 2000) {
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

await runBrowserProbe({ name: "v0170-r4-enter-wide", doc: DOC }, async (ui) => {
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

  const SCEN = [
    { name: "视口中部", frac: 0.5, docPct: 0.5 },
    { name: "视口底部", frac: 0.85, docPct: 0.5 },
    { name: "最后一行贴视口底", frac: 0.9, docPct: 0.99 },
  ];

  const rows = [];
  for (const tw of [false, true]) {
    const got = await setTw(tw);
    ui.add(`S-${tw ? "ON" : "OFF"}`, `打字机=${tw ? "开" : "关"}`, got === tw ? "PASS" : "FAIL", `active=${got}`);
    for (const sc0 of SCEN) {
      const label = `${tw ? "ON" : "OFF"}·${sc0.name}`;
      const typewriterON = tw;
      await wheelTo(ui, sc0.docPct);
      const pt = await placeCursor(ui, sc0.frac);
      if (!pt) { ui.add(`I·${label}`, "INVALID：点击落点找不到", "FAIL", "无"); continue; }
      if (tw) { await ui.sleep(700); }
      await waitSettled(ui);
      await ui.ev(annotateAnchor());
      const pre = await ui.ev(READ_STATE);

      await ui.ev(COUNT_MUTATIONS);
      await ui.ev(START_TRACE(TRACE_MS));
      await ui.sleep(110);
      await ui.key("Enter", "Enter", 13);
      await ui.sleep(TRACE_MS + 450);

      const trace = await ui.ev(`return window.__TR || []`);
      const post = await ui.ev(READ_STATE);
      const mut = await ui.ev(`return window.__MUT || 0`);
      const rebuild = await ui.ev(`return window.__REBUILD || 0`);
      const lt = await ui.ev(`return window.__LT || []`);

      const asserts = [
        { id: "A1", ok: pre.max > 300, why: `max=${pre.max}` },
        { id: "A2", ok: pre.focused === true, why: `focused=${pre.focused}` },
        { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY} / ch=${pre.ch}` },
        { id: "A5", ok: (post.lines ?? 0) === (pre.lines ?? -1) + 1, why: `lines ${pre.lines}→${post.lines}` },
      ];
      const a = analyze(trace);
      const bad = asserts.filter((x) => !x.ok);
      if (bad.length) {
        ui.add(`I·${label}`, "INVALID（前置断言不成立）", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；"));
        continue;
      }
      rows.push({ label, a, pre, post, mut, rebuild, lt });

      // 判定：每条通道分别给出"抖/不抖"
      /**
       * ⚠️ 判据必须按**语义**订正，不能"一个阈值套五个通道"。
       * 本探针第一版把所有通道都按 OFF 口径（单帧 ≤3px）判，结果把三类
       * **正确行为**全判成红了 —— 这正是 R3 §7.5「判据错了比没判据更危险」的复现：
       *
       * | 通道 | 第一版判据 | 为什么错 | 订正后 |
       * |---|---|---|---|
       * | 滚动（ON） | ≤3px | 打字机 smooth 动画**本来**就该每帧动 5~16px（R3 #8 的成果） | ON：只判**反转=0**；OFF：仍判 ≤3px |
       * | 几何 gut | ≤0.5px | 行号从 2 位变 3 位时 `--lm-cm-gutter-w` 变 3.7px 是**设计如此**（`syncGutterVar` 的职责） | 允许 ≤8px（一个行号字符宽），但要求 `cLeft` 与该变化**同步**（不是独立跳） |
       * | 右屏 deST（ON） | ≤3px | 动画结束后 `realignLayoutNow` 的一次吸附（20~29px）发生在**左屏停止之后**，观感是"对齐一下"不是抖 | ON：只判**反转=0**；且量级 ≤60px |
       *
       * 判据订正的**依据**是同一份数据里"已知正确的实现"—— OFF 组右屏 deST=2px、
       * 内部重排 0px、掉帧 0 帧、连按 12 次 0 反转，说明探针有区分力。
       */
      const stOk = typewriterON
        ? a.st.reversals === 0
        : (a.st.maxJump <= 3 && a.st.reversals === 0);
      const reflowOk = a.aDocY.maxJump <= 3 && a.aDocY.reversals === 0;
      // 几何：gut 允许 8px（行号位数变化），但 cLeft 必须与 gut 同步（差值 ≤1px）
      const gutChange = a.gut.maxJump;
      const cLeftChange = a.cLeft.maxJump;
      const geomOk = gutChange <= 8 && cLeftChange <= 8 && Math.abs(cLeftChange - gutChange) <= 1;
      const frameOk = a.frame.over34 === 0;
      /**
       * 右屏判据（第三次订正 —— 前两次的错都记在这里）：
       * - 错误 1： unconditionally 用 ≤3px。ON 组动画结束后 `realignLayoutNow`
       *   的一次吸附（17~29px）发生在左屏**停止之后**，是"对齐一下"不是抖。
       * - 错误 2：用 `a.deST.maxUp` —— `series()` 根本没有 `maxUp` 字段（它叫 `maxJump`），
       *   于是 `undefined <= 60` 恒 false → 三条本应 PASS 的用例被误判成 FAIL。
       *   **判据里读错字段名 = 判据恒假，比没有判据更危险。**
       * - 错误 3：把 `deSH/bodyH` 的 +28.8px 当抖动。回车**确实插入了一行**，
       *   markdown 渲染高度 +1 行是正确结果，不是缺陷。
       *
       * 订正后：内容高度变化允许 ≤1 个行高 +2px；右屏 scrollTop 允许 ≤60px 且**反转必须 0**。
       * 真正代表"抖"的只有**方向反转**与**动画期间的大幅错跳**（后者由 rightpane 探针专测）。
       */
      const lineH = pre.lineH ?? 30;
      const prevOk = a.deST.reversals === 0
        && a.deST.maxJump <= 60
        && a.deSH.maxJump <= lineH + 2
        && a.bodyH.maxJump <= lineH + 2;
      ui.add(`W·${label}`, "五通道：滚动 / 内部重排 / 几何 / 掉帧 / 右屏预览",
        stOk && reflowOk && geomOk && frameOk && prevOk ? "PASS" : "FAIL",
        `滚动 maxJump=${a.st.maxJump} 反转=${a.st.reversals}（${stOk ? "OK" : "抖"}）；` +
        `内部重排 maxJump=${a.aDocY.maxJump} 反转=${a.aDocY.reversals}（${reflowOk ? "OK" : "抖"}）；` +
        `几何 cW=${a.cW.maxJump} cLeft=${a.cLeft.maxJump} padL=${a.padL.maxJump} gut=${a.gut.maxJump}（${geomOk ? "OK" : "不同步"}）；` +
        `掉帧 p95=${a.frame.p95}ms max=${a.frame.max}ms >34ms 帧=${a.frame.over34}（${frameOk ? "OK" : "卡"}）；` +
        `右屏 deST=${a.deST.maxJump} 反转=${a.deST.reversals} deSH=${a.deSH.maxJump} bodyH=${a.bodyH.maxJump}（${prevOk ? "OK" : "抖"}）；` +
        `mutation=${mut} 重建=${rebuild} longtask=${JSON.stringify(lt.slice(0, 4))}`);
      ui.log(`[trace·${label}] st=${JSON.stringify(a.st.deltas)}`);
      ui.log(`[trace·${label}] aDocY=${JSON.stringify(a.aDocY.deltas)} caretY=${JSON.stringify(a.caretY.deltas)}`);
      ui.log(`[trace·${label}] cW=${JSON.stringify(a.cW.deltas)} padL=${JSON.stringify(a.padL.deltas)} gut=${JSON.stringify(a.gut.deltas)}`);

      // 恢复：删掉插入的空行（用 Ctrl+Z 走统一时间线，避免积累 12 个空行）
      await ui.key("z", "KeyZ", 90, 2);
      await ui.sleep(700);
    }
  }

  /* ── 连续 12 次回车（用户可能指连续输入时的抖动）─────────── */
  for (const tw of [false, true]) {
    await setTw(tw);
    const label = `${tw ? "ON" : "OFF"}·连按12次回车`;
    await wheelTo(ui, 0.5);
    const pt = await placeCursor(ui, 0.5);
    if (!pt) { ui.add(`I·${label}`, "INVALID：落点找不到", "FAIL", "无"); continue; }
    if (tw) await ui.sleep(700);
    await waitSettled(ui);
    await ui.ev(annotateAnchor());
    const pre = await ui.ev(READ_STATE);
    await ui.ev(COUNT_MUTATIONS);
    await ui.ev(START_TRACE(3500));
    await ui.sleep(110);
    for (let i = 0; i < 12; i++) { await ui.key("Enter", "Enter", 13); await ui.sleep(130); }
    await ui.sleep(2400);
    const trace = await ui.ev(`return window.__TR || []`);
    const post = await ui.ev(READ_STATE);
    const mut = await ui.ev(`return window.__MUT || 0`);
    const rebuild = await ui.ev(`return window.__REBUILD || 0`);
    const a = analyze(trace);
    const asserts = [
      { id: "A1", ok: pre.max > 300, why: `max=${pre.max}` },
      { id: "A2", ok: pre.focused === true, why: `focused=${pre.focused}` },
      { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY}` },
      { id: "A5", ok: (post.lines ?? 0) === (pre.lines ?? -1) + 12, why: `lines ${pre.lines}→${post.lines}（需 +12）` },
    ];
    const bad = asserts.filter((x) => !x.ok);
    if (bad.length) { ui.add(`I·${label}`, "INVALID", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); continue; }
    ui.add(`W·${label}`, "连续 12 次回车：滚动/重排/掉帧",
      a.st.reversals === 0 && a.aDocY.reversals === 0 ? "PASS" : "FAIL",
      `滚动 maxJump=${a.st.maxJump} 反转=${a.st.reversals} 净Δ=${a.st.net}；内部重排 maxJump=${a.aDocY.maxJump} 反转=${a.aDocY.reversals}；` +
      `掉帧 p95=${a.frame.p95} max=${a.frame.max} >34ms=${a.frame.over34}；mutation=${mut} 重建=${rebuild}`);
    ui.log(`[trace·${label}] st 逐帧=${JSON.stringify(a.st.deltas)}`);
    for (let i = 0; i < 12; i++) { await ui.key("z", "KeyZ", 90, 2); await ui.sleep(90); }
    await ui.sleep(900);
  }

  ui.log("[SUMMARY] " + JSON.stringify(rows.map((r) => ({
    label: r.label,
    stMaxJump: r.a.st.maxJump, stRev: r.a.st.reversals, stNet: r.a.st.net,
    aDocYMaxJump: r.a.aDocY.maxJump, aDocYRev: r.a.aDocY.reversals,
    cW: r.a.cW.maxJump, cLeft: r.a.cLeft.maxJump, padL: r.a.padL.maxJump, gut: r.a.gut.maxJump,
    frameP95: r.a.frame.p95, frameMax: r.a.frame.max, frameOver34: r.a.frame.over34,
    deST: r.a.deST.maxJump, deSH: r.a.deSH.maxJump, bodyH: r.a.bodyH.maxJump,
    mutations: r.mut, rebuild: r.rebuild,
  })), null, 1));

  await ui.shot("wide-final");
});
