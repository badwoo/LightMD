/**
 * v0.17.0 第四轮 · T3 · **真凶定位探针**（两个候选，各自单变量）
 *
 * ## 宽观测探针（`v0170-r4-enter-wide.mjs`）已给出的两条硬数据
 *
 * ### 候选 A：**分屏右屏预览**在回车时跳 170~188px（只在打字机开启时）
 * ```
 * OFF·视口中部  右屏 iframe scrollTop 单帧最大跳变 = 2px      ← 正常
 * ON ·视口中部  右屏 iframe scrollTop 单帧最大跳变 = 170px    ← 抖
 * ON ·视口底部  右屏 iframe scrollTop 单帧最大跳变 = 188px    ← 抖
 * ON ·连按12次  每次回车都是同一形态（5,16,5,2,1 帧）
 * ```
 * 左屏在 ON 组只平滑滚 28px（一个行高），右屏却跳 170~188px —— 这个量级差
 * 只可能来自"**块锚点映射**"：`syncToPreview` 用 `mapSourceLineToPreviewScroll`
 * 把左屏当前顶部行映射到右屏块边界，**逐块吸附**（不是逐像素）。
 * 用户眼睛在右屏 → 看到的就是"整页文字猛地跳一下"。
 *
 * ### 候选 B：行号槽宽度 `--lm-cm-gutter-w` 变化 3.7px → 正文列横向跳
 * ```
 * OFF/ON · 视口底部 / 最后一行：gut 3.7、cW -3.7、cLeft 3.7
 * （同一帧内）。其余场景 = 0（不跳）
 * ```
 * `gut` 从 2 位行号变 3 位（31 → 34.7px）→ `padding-inline-start` 补偿量变 →
 * **整篇正文横向移动 3.7px**。用户若正盯着文字，会看到"抖一下"。
 *
 * ## 本探针分别验证
 * ### A 组
 * - A1 复现：ON × 回车，逐帧同时采左屏 st 与右屏 deST，看是否**同一帧**
 * - A2 单变量：把 Iframe 临时隐藏（`visibility:hidden` 不影响布局，**不改代码**）
 *   不行 —— 我们要判的是"右屏跳是否是左屏同步引起的"，所以改判据：
 *   同时给 `syncToPreview` 的输入/输出打点是不可能的（不 hook）。
 *   改用**几何反算**：看右屏跳变后的位置是否恰等于"某个块顶"（块吸附特征）。
 * - A3 判据：右屏跳变 / 左屏净位移 的比值。ON 组左屏 28px → 右屏 170~188px
 *   比值 ≈ 6~6.7 ⇒ 显然不是线性同步（线性比值应为 1.0 左右）。
 * - A4 决定性单变量：**关掉右屏预览**（`view.togglePreview`）后再按回车 →
 *   若此时左屏也不抖/无异常，说明"抖"确实来自右屏而不是左屏。
 *
 * ### B 组
 * - B1 松开/收紧行号位数：造一份**刚好 99/100 行**的文档，回车跨越 3 位阈值，
 *   逐帧采 `--lm-cm-gutter-w` / `paddingLeft` / `.cm-content` 左缘。
 * - B2 判据：横向位移 ≥1px 且不可逆（不同帧内回弹）= 一次真实跳变。
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-rootcause.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

/** 60 段 → 约 121 行，行号是 3 位（B 组另造 99/100 行文档） */
const DOC = makeDoc(60);

/** 造一份"回车就跨行号位数阈值"的文档：先 97 行，回车 5 次跨 100 */
function makeThresholdDoc() {
  const lines = ["# 行号阈值文档", ""];
  // 每段 2 行（段 + 空行）。要正文字号下 99 行左右
  for (let i = 1; i <= 48; i++) {
    lines.push(`L${String(i).padStart(2, "0")} 短行`);
    lines.push("");
  }
  return lines.join("\n");
}
const DOC_THRESHOLD = makeThresholdDoc();

/** 只读逐帧采样：左右两屏 + 横向几何 */
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
        rec.padL = Math.round(parseFloat(getComputedStyle(sc).paddingLeft) * 100) / 100;
        rec.gut = Math.round((parseFloat(getComputedStyle(sc).getPropertyValue("--lm-cm-gutter-w")) || 0) * 100) / 100;
        const content = sc.querySelector(".cm-content");
        if (content) {
          const cr = content.getBoundingClientRect();
          rec.cLeft = Math.round(cr.left * 100) / 100;
          rec.cW = Math.round(cr.width * 100) / 100;
        }
        const caret = sc.querySelector(".cm-cursor");
        if (caret) rec.caretY = Math.round((caret.getBoundingClientRect().top - r.top) * 100) / 100;
      }
      const f = document.querySelector("iframe.split-preview, iframe");
      if (f) {
        const fr = f.getBoundingClientRect();
        rec.ifH = Math.round(fr.height * 100) / 100;
        try {
          const d = f.contentDocument;
          if (d && d.documentElement) {
            rec.deST = Math.round(d.documentElement.scrollTop * 100) / 100;
            rec.deSH = Math.round(d.documentElement.scrollHeight);
            // 反算：iframe 视口顶部那一块（用 elementFromPoint 太重，改取第一个块）
            const first = d.body ? d.body.firstElementChild : null;
            if (first) rec.blkDocY = Math.round((first.getBoundingClientRect().top + d.documentElement.scrollTop) * 100) / 100;
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
  try { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.view;
        if (v && v.state && v.state.doc) lines = v.state.doc.lines; } catch (e) {}
  const line = sc.querySelector(".cm-line");
  return { ok: true, st: round(sc.scrollTop), max: round(sc.scrollHeight - sc.clientHeight),
           ch: round(sc.clientHeight), caretY: cr ? round(cr.top - r.top) : null,
           focused: !!document.querySelector(".cm-focused"), lines,
           lineH: line ? round(line.getBoundingClientRect().height) : null };
`;

const readPreview = `
  const round = (n) => Math.round(n * 100) / 100;
  const f = document.querySelector("iframe.split-preview, iframe");
  if (!f) return { ok: false, reason: "no iframe" };
  try {
    const d = f.contentDocument;
    if (!d || !d.documentElement) return { ok: false, reason: "no contentDocument" };
    return { ok: true, st: round(d.documentElement.scrollTop), sh: round(d.documentElement.scrollHeight),
             ch: d.documentElement.clientHeight, bodyH: d.body ? round(d.body.getBoundingClientRect().height) : null };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 60) }; }
`;

function analyzeField(trace, field, noisePx = 5) {
  const arr = trace.map((s) => s[field]).filter((v) => typeof v === "number");
  if (arr.length < 2) return { n: arr.length, valid: false };
  const d = [];
  for (let i = 1; i < arr.length; i++) d.push(Math.round((arr[i] - arr[i - 1]) * 100) / 100);
  let maxJump = 0, at = null;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > maxJump) { maxJump = Math.abs(d[i]); at = trace[i + 1]?.t ?? null; }
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
    n: arr.length, valid: true, first: arr[0], last: arr[arr.length - 1],
    net: Math.round((arr[arr.length - 1] - arr[0]) * 100) / 100,
    min: Math.min(...arr), max: Math.max(...arr),
    maxJump: Math.round(maxJump * 100) / 100, maxJumpAt: at,
    reversals: Math.max(0, runs.length - 1), frames: nz.length,
    deltas: nz.slice(0, 30),
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

await runBrowserProbe({ name: "v0170-r4-enter-rootcause", doc: DOC }, async (ui) => {
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

  /* ══ A 组：左屏 vs 右屏 ═══════════════════════════════════ */
  const runA = async (tag, withPreview) => {
    await ui.sleep(300);
    const pv = await ui.ev(readPreview);
    await wheelTo(ui, 0.5);
    const pt = await placeCursor(ui, 0.75);
    if (!pt) { ui.add(`A-${tag}`, "INVALID：落点找不到", "FAIL", "无"); return null; }
    await ui.sleep(700);
    await waitSettled(ui);
    const pre = await ui.ev(READ_STATE);
    const prePv = await ui.ev(readPreview);

    await ui.ev(START_TRACE(1600));
    await ui.sleep(110);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(2000);
    const trace = await ui.ev(`return window.__TR || []`);
    const post = await ui.ev(READ_STATE);
    const postPv = await ui.ev(readPreview);

    const st = analyzeField(trace, "st");
    const deST = analyzeField(trace, "deST");
    const deSH = analyzeField(trace, "deSH");
    const ifH = analyzeField(trace, "ifH");
    const caret = analyzeField(trace, "caretY");
    const asserts = [
      { id: "A1", ok: pre.max > 300, why: `max=${pre.max}` },
      { id: "A2", ok: pre.focused, why: `focused=${pre.focused}` },
      { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY}` },
      { id: "A5", ok: (post.lines ?? 0) === (pre.lines ?? -1) + 1, why: `lines ${pre.lines}→${post.lines}` },
    ];
    if (withPreview) asserts.push({ id: "A6", ok: prePv.ok, why: `iframe 可读 ${prePv.ok} ${prePv.reason || ""}` });
    const bad = asserts.filter((x) => !x.ok);
    if (bad.length) { ui.add(`A-${tag}`, "INVALID", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); return null; }

    const ratio = st.net !== 0 && deST.valid ? Math.round((deST.net / st.net) * 100) / 100 : null;
    ui.log(`[A·${tag}] 左屏 st: ${JSON.stringify({ net: st.net, maxJump: st.maxJump, deltas: st.deltas })}`);
    ui.log(`[A·${tag}] 右屏 deST: ${JSON.stringify({ net: deST.net, maxJump: deST.maxJump, at: deST.maxJumpAt, first: deST.first, last: deST.last, deltas: deST.deltas })}`);
    ui.log(`[A·${tag}] 右屏 deSH: ${JSON.stringify({ maxJump: deSH.maxJump, first: deSH.first, last: deSH.last })} ifH: ${JSON.stringify({ maxJump: ifH.maxJump })}`);
    ui.log(`[A·${tag}] 比值 deST/st = ${ratio}`);
    ui.log(`[A·${tag}] 帧对齐: ` + JSON.stringify(trace.filter((s) => typeof s.deST === "number" || typeof s.st === "number").slice(0, 24).map((s) => `${s.t}:st${s.st}/de${s.deST}`)));
    return { tag, st, deST, deSH, ifH, caret, ratio, pre, post, prePv, postPv, trace };
  };

  const twBefore = await readTw();
  if (!twBefore) { await setTw(true); }

  const aWithPreview = await runA("ON-有右屏", true);
  // 关右屏预览
  await ui.command("view.togglePreview");
  await ui.sleep(1600);
  const hasIframe = await ui.ev(`return !!document.querySelector("iframe")`);
  ui.log("[A] 关预览后 hasIframe=" + hasIframe);
  const aNoPreview = await runA("ON-无右屏", false);
  // 恢复右屏
  await ui.command("view.togglePreview");
  await ui.sleep(1600);

  if (aWithPreview) {
    ui.add("A●", "★ 分屏右屏在回车时是否跳（打字机开）",
      aWithPreview.deST.valid && aWithPreview.deST.maxJump <= 3 ? "PASS" : "FAIL",
      `右屏 scrollTop 单帧最大跳变 ${aWithPreview.deST.maxJump}px（@${aWithPreview.deST.maxJumpAt}ms）净Δ=${aWithPreview.deST.net}px；` +
      `左屏净Δ=${aWithPreview.st.net}px ⇒ 比值 ${aWithPreview.ratio}（线性同步应≈1.0）`);
  }
  if (aNoPreview) {
    ui.add("A○", "关掉右屏后左屏自身是否还抖（隔离右屏影响）",
      aNoPreview.st.maxJump <= 3 && aNoPreview.st.reversals === 0 ? "PASS" : "FAIL",
      `左屏 maxJump=${aNoPreview.st.maxJump} 反转=${aNoPreview.st.reversals} 净Δ=${aNoPreview.st.net}`);
  }

  /* ══ B 组：行号槽宽度跨位数 ═══════════════════════════════ */
  ui.log("[B] 装载行号阈值文档…");
  const thresholdDoc = makeThresholdDoc();
  const thFile = ui.path.join(ui.path.dirname(ui.docFile), "t3-threshold.md");
  ui.fs.writeFileSync(thFile, thresholdDoc, "utf8");
  for (let i = 0; i < 8; i++) {
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(thFile)}, name: "t3-threshold.md", content: ${JSON.stringify(thresholdDoc)} },
      }));
      return true;
    `).catch(() => {});
    await ui.sleep(500);
    const ok = await ui.ev(`const c=document.querySelector(".cm-content"); try { const v=c&&c.cmTile&&c.cmTile.view; return !!(v && v.state.doc.toString().indexOf("L48")>=0); } catch(e) { return false; }`);
    if (ok) break;
  }
  await ui.sleep(1200);
  const thState = await ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const c = document.querySelector(".cm-content");
    let lines = null;
    try { const v = c && c.cmTile && c.cmTile.view; if (v) lines = v.state.doc.lines; } catch (e) {}
    return { lines, gut: Math.round((parseFloat(getComputedStyle(sc).getPropertyValue("--lm-cm-gutter-w")) || 0) * 100) / 100,
             padL: Math.round(parseFloat(getComputedStyle(sc).paddingLeft) * 100) / 100,
             cLeft: Math.round(c.getBoundingClientRect().left * 100) / 100,
             st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
  `);
  ui.log("[B] 阈值文档状态 = " + JSON.stringify(thState));

  // 把光标放到**文档最末**（这样回车会不断加行、跨过 99/100 阈值）
  await ui.focusSource();
  await ui.ev(`
    const c = document.querySelector(".cm-content");
    const v = c && c.cmTile && c.cmTile.view;
    if (!v) return false;
    const end = v.state.doc.length;
    v.dispatch({ selection: { anchor: end, head: end } });
    v.focus();
    return true;
  `);
  await ui.sleep(400);
  await waitSettled(ui);
  const bPre = await ui.ev(READ_STATE);
  ui.log("[B] 回车前 = " + JSON.stringify(bPre));

  await ui.ev(START_TRACE(4000));
  await ui.sleep(110);
  for (let i = 0; i < 8; i++) { await ui.key("Enter", "Enter", 13); await ui.sleep(180); }
  await ui.sleep(2200);
  const bTrace = await ui.ev(`return window.__TR || []`);
  const bPost = await ui.ev(READ_STATE);

  const gut = analyzeField(bTrace, "gut", 0.05);
  const padL = analyzeField(bTrace, "padL", 0.05);
  const cLeft = analyzeField(bTrace, "cLeft", 0.05);
  const cW = analyzeField(bTrace, "cW", 0.05);
  const bSt = analyzeField(bTrace, "st");
  ui.log("[B] gut 序列 = " + JSON.stringify(gut));
  ui.log("[B] padL 序列 = " + JSON.stringify(padL));
  ui.log("[B] cLeft 序列 = " + JSON.stringify(cLeft));
  ui.log("[B] 行数 " + bPre.lines + " → " + bPost.lines);
  ui.log("[B] 逐帧 = " + JSON.stringify(bTrace.slice(0, 36).map((s) => `${s.t}:L?/gut${s.gut}/pad${s.padL}/cL${s.cLeft}`)));

  const gutChanged = gut.valid && gut.maxJump > 0.5;
  ui.add("B●", "★ 回车跨行号位数时正文列是否横向跳",
    gutChanged && cLeft.maxJump > 1 ? "FAIL" : "PASS",
    `行号槽宽单帧最大变化 ${gut.maxJump ?? "?"}px；正文左缘单帧最大变化 ${cLeft.maxJump ?? "?"}px；列宽 ${cW.maxJump ?? "?"}px；` +
    `（gut ${gut.first}→${gut.last}，cLeft ${cLeft.first}→${cLeft.last}）`);

  await ui.shot("rootcause");
});
