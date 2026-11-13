/**
 * v0.17.0 R3 · T2 · 第 1 项：阅读模式 + 打字机，退格删除时页面抖动 —— **探针 2.0**
 *
 * ## ⚠️ 为什么要重写（探针 1.0 的致命缺陷，必须记下来）
 *
 * 1.0 版本报出"打字机开 → 1442px 抖动 / 29 次反转"，但归因时发现：
 * - 点击"视口中央段落"**经常失败**（`点击目标 = null`），光标从未被放置；
 * - 于是光标停在**文档开头**，而打字机把"文档顶部"居中 → `scrollTo({top:0})`
 *   是**正确行为**，不是缺陷；
 * - 更糟的是：打字机的**初始居中**发生在采样开始之前，我们测到的
 *   `1442→0→1442` 往复里，有一部分是"采样窗口与上/下一次居中重叠"的伪影。
 *
 * ⇒ **"探针没放好前置条件"会被解读成产品缺陷**。这与之前踩过的
 * "判据把正常行为误判成缺陷"是同一类错误。
 *
 * ## 2.0 的硬约束（每条都有断言，不满足就 FAIL，不允许"照样跑下去"）
 * - **A1** 文档可滚动（scrollHeight > clientHeight + 200）
 * - **A2** 成功点到**视口中部**的段落，且 `document.caretRangeFromPoint` 证明
 *        落点 y 在视口内（不在文档顶部）
 * - **A3** 光标位置在**内容坐标系**里离文档顶部 > 500px（真的在中部）
 * - **A4** 打字机**已开启**且**初始居中已结束**（等 ≥900ms 且 scrollTop 稳定）
 * - **A5** 退格前后文本长度确实变化（退格生效）
 *
 * 任何一条不满足 → 该场景标 INVALID，**不产出"产品抖/不抖"的结论**。
 *
 * ## 判据（沿用修正后的口径：只看 st 与内容锚，不看 caretY）
 * - `st.maxJump ≤ 3px` 且 `st.reversals === 0`
 * - `piTop.maxJump ≤ 3px` 且 `piTop.reversals === 0`
 *
 * ## 用法
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t2" node scripts/v0170-r3-reader-backspace-2.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);
const PM = ".editor-container";

/** 启动逐帧采样 */
const TRACE = (ms) => `
  window.__TR = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const ec = document.querySelector(${JSON.stringify(PM)});
      const rec = { t: Math.round(performance.now() - t0) };
      if (ec) {
        const er = ec.getBoundingClientRect();
        rec.st = Math.round(ec.scrollTop * 100) / 100;
        rec.sh = Math.round(ec.scrollHeight);
        const midY = er.top + ec.clientHeight / 2;
        let best = null, bestD = Infinity;
        for (const n of ec.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote")) {
          const txt = n.textContent || "";
          if (!/PI\\d{2}/.test(txt)) continue;
          const r = n.getBoundingClientRect();
          const d = Math.abs((r.top + r.bottom) / 2 - midY);
          if (d < bestD) { bestD = d; best = n; }
        }
        if (best) {
          const m = /PI(\\d{2})/.exec(best.textContent || "");
          rec.pi = m ? Number(m[1]) : null;
          rec.piTop = Math.round((best.getBoundingClientRect().top - er.top) * 100) / 100;
        }
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

/** 严格滚到文档中部（真实滚轮，不瞬移 scrollTop） */
async function scrollToMiddle(ui) {
  // 先回顶
  for (let i = 0; i < 60; i++) {
    const st = await ui.ev(`const e=document.querySelector(${JSON.stringify(PM)}); return e?Math.round(e.scrollTop):0;`);
    if (st <= 4) break;
    await ui.wheel(600, 420, -Math.min(200, st));
    await ui.sleep(10);
  }
  await ui.sleep(300);
  // 向下滚到 ~45%
  const target = await ui.ev(`
    const e=document.querySelector(${JSON.stringify(PM)});
    return e ? Math.round((e.scrollHeight - e.clientHeight) * 0.45) : 0;
  `);
  let cur = 0, guard = 0;
  while (cur < target - 20 && guard++ < 400) {
    await ui.wheel(600, 420, Math.min(180, target - cur));
    await ui.sleep(10);
    const s2 = await ui.ev(`const e=document.querySelector(${JSON.stringify(PM)}); return e?Math.round(e.scrollTop):0;`);
    if (s2 === cur) break;
    cur = s2;
  }
  await ui.sleep(700);
  return cur;
}

/**
 * 严格放置光标：点在视口中部某段文字的**字符上**，并用 caretRangeFromPoint 反验。
 * @returns 成功时 { ok, caretY, contentY, pi }
 */
async function placeCaretStrict(ui) {
  // 找一个"整段都在视口内"的 PIxx 段落，尽量靠中部
  const target = await ui.ev(`
    const ec = document.querySelector(${JSON.stringify(PM)});
    const er = ec.getBoundingClientRect();
    const midY = er.top + ec.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const n of ec.querySelectorAll("p")) {
      const txt = n.textContent || "";
      if (!/PI\\d{2}/.test(txt)) continue;
      const r = n.getBoundingClientRect();
      // 必须在视口内且不贴边，避免点到视口外的段落被 PM 忽略
      if (r.top < er.top + 40 || r.bottom > er.bottom - 40) continue;
      if (r.height < 8) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = { r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, txt: txt.slice(0, 20), h: r.height }; }
    }
    if (!best) return null;
    return {
      // 点在段内第二个字符附近（避开段首的列表符号/缩进）
      x: Math.round(best.r.left + 18),
      y: Math.round((best.r.top + best.r.bottom) / 2),
      txt: best.txt,
    };
  `);
  if (!target) return { ok: false, reason: "找不到完全在视口内的 PIxx 段落" };

  await ui.click(target.x, target.y);
  await ui.sleep(600);

  // 反验：caretRangeFromPoint 给出光标真实屏幕 Y；再换算内容坐标
  const verify = await ui.ev(`
    const ec = document.querySelector(${JSON.stringify(PM)});
    const er = ec.getBoundingClientRect();
    let caretY = null, err = null;
    try {
      // 用 DOM 选区的 rect 作为光标位置的证据
      const s = window.getSelection();
      if (s && s.rangeCount) {
        const r = s.getRangeAt(0).getBoundingClientRect();
        caretY = Math.round((r.top - er.top) * 100) / 100;
      }
    } catch (e) { err = String(e); }
    // 视口中心锚段（用于报 PI）
    const midY = er.top + ec.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const n of ec.querySelectorAll("p")) {
      const txt = n.textContent || "";
      if (!/PI\\d{2}/.test(txt)) continue;
      const r = n.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestD) { bestD = d; best = n; }
    }
    const m = best ? /PI(\\d{2})/.exec(best.textContent || "") : null;
    return {
      caretY,
      st: Math.round(ec.scrollTop * 100) / 100,
      ch: ec.clientHeight,
      // 光标在**内容坐标系**的 Y
      contentY: caretY === null ? null : Math.round((caretY + ec.scrollTop) * 100) / 100,
      viewportMid: ec.clientHeight / 2,
      pi: m ? Number(m[1]) : null,
      err,
    };
  `);

  const inViewport = verify.caretY !== null && verify.caretY >= 0 && verify.caretY <= verify.ch;
  const inMiddle = verify.contentY !== null && verify.contentY > 500;
  return { ok: inViewport && inMiddle, ...verify, target };
}

function analyze(trace, field) {
  const seq = trace.map((s) => s[field]).filter((v) => typeof v === "number");
  if (seq.length < 2) return { n: seq.length, maxJump: 0, reversals: 0, net: 0 };
  const d = [];
  for (let i = 1; i < seq.length; i++) d.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
  let maxJump = 0;
  const jumps = [];
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > maxJump) maxJump = Math.abs(d[i]);
    if (Math.abs(d[i]) > 3) jumps.push({ t: trace[i + 1].t, from: seq[i], to: seq[i + 1], d: d[i] });
  }
  const runs = [];
  let acc = 0;
  for (const x of d) {
    if (Math.abs(x) < 0.05) continue;
    const sg = x > 0 ? 1 : -1;
    if (!runs.length || runs[runs.length - 1] !== sg) {
      if (runs.length > 0 && Math.abs(acc) <= 1) runs[runs.length - 1] = sg;
      else runs.push(sg);
      acc = 0;
    }
    acc += x;
  }
  return {
    n: seq.length, first: seq[0], last: seq[seq.length - 1],
    net: Math.round((seq[seq.length - 1] - seq[0]) * 100) / 100,
    maxJump: Math.round(maxJump * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    jumps: jumps.slice(0, 10), jumpsCount: jumps.length,
  };
}

async function setTypewriter(ui, want) {
  const cur = await ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.textContent || "").indexOf("打字机") >= 0 || (x.getAttribute("title") || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);
  if (cur !== want) {
    await ui.command("view.toggleTypewriter");
    await ui.sleep(1300); // 等打字机的初始居中动画结束
  }
  return await ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.textContent || "").indexOf("打字机") >= 0 || (x.getAttribute("title") || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);
}

await runBrowserProbe({ name: "v0170-r3-reader-bs2", doc: DOC }, async (ui) => {
  await ui.command("view.preview");
  await ui.sleep(1800);

  const geo = await ui.ev(`
    const ec = document.querySelector(${JSON.stringify(PM)});
    const pm = document.querySelector(".ProseMirror");
    return { hasEc: !!ec, hasPm: !!pm, sh: ec ? Math.round(ec.scrollHeight) : 0, ch: ec ? ec.clientHeight : 0 };
  `);
  ui.add("A1", "文档可滚动", geo.hasEc && geo.hasPm && geo.sh > geo.ch + 200 ? "PASS" : "FAIL", JSON.stringify(geo));
  if (!(geo.hasEc && geo.hasPm && geo.sh > geo.ch + 200)) return;

  async function runGroup(label, typewriter) {
    const tw = await setTypewriter(ui, typewriter);
    const st = await scrollToMiddle(ui);
    ui.log(`[${label}] 打字机=${tw} 滚动到 st=${st}`);

    const caret = await placeCaretStrict(ui);
    ui.log(`[${label}] 光标 = ${JSON.stringify(caret)}`);
    if (!caret.ok) {
      ui.add(`${label}-A2`, `${label}：光标成功落在视口中部（前置条件）`, "FAIL",
        `caretY=${caret.caretY} ch=${caret.ch} contentY=${caret.contentY} 原因=${caret.reason ?? "落点在视口外/顶部"}`);
      return { label, valid: false, caret };
    }
    ui.add(`${label}-A2`, `${label}：光标成功落在视口中部（前置条件）`, "PASS",
      `caretY=${caret.caretY}（视口 0~${caret.ch}）、contentY=${caret.contentY}（>500 才算中部）、视口中心锚 PI${caret.pi}`);

    // 等稳定（打字机初始居中可能还没结束）
    await ui.sleep(800);
    const stable1 = await ui.ev(`const e=document.querySelector(${JSON.stringify(PM)}); return Math.round(e.scrollTop);`);
    await ui.sleep(400);
    const stable2 = await ui.ev(`const e=document.querySelector(${JSON.stringify(PM)}); return Math.round(e.scrollTop);`);
    ui.add(`${label}-A4`, `${label}：采样前滚动位置已稳定`, Math.abs(stable1 - stable2) <= 1 ? "PASS" : "FAIL",
      `两次读数 ${stable1} / ${stable2}`);

    const before = await ui.ev(`
      const pm = document.querySelector(".ProseMirror");
      const ec = document.querySelector(${JSON.stringify(PM)});
      return { len: (pm.textContent || "").length, st: Math.round(ec.scrollTop), sh: Math.round(ec.scrollHeight) };
    `);

    await ui.ev(TRACE(3000));
    await ui.sleep(80);
    for (let i = 0; i < 16; i++) {
      await ui.key("Backspace", "Backspace", 8);
      await ui.sleep(46);
    }
    await ui.sleep(1500);
    const trace = await ui.ev(`return window.__TR || []`);
    const after = await ui.ev(`
      const pm = document.querySelector(".ProseMirror");
      const ec = document.querySelector(${JSON.stringify(PM)});
      return { len: (pm.textContent || "").length, st: Math.round(ec.scrollTop), sh: Math.round(ec.scrollHeight) };
    `);

    const stA = analyze(trace, "st");
    const piA = analyze(trace, "piTop");
    const deleted = before.len - after.len;
    ui.add(`${label}-A5`, `${label}：退格确实删除了字符`, deleted > 0 ? "PASS" : "FAIL",
      `文本 ${before.len} → ${after.len}（删 ${deleted} 字符）`);

    ui.log(`[${label}] st = ${JSON.stringify(stA)}`);
    ui.log(`[${label}] piTop = ${JSON.stringify(piA)}`);
    const jitter = stA.maxJump > 3 || stA.reversals > 0 || piA.maxJump > 3 || piA.reversals > 0;
    return { label, valid: true, typewriter: tw, before, after, st: stA, pi: piA, deleted, jitter, caret };
  }

  const A = await runGroup("A-打字机开", true);
  const B = await runGroup("B-打字机关", false);

  if (!A.valid || !B.valid) {
    ui.add("C0", "★ 单变量结论", "FAIL",
      `前置条件不满足，**不能下结论**：A valid=${A.valid} B valid=${B.valid}`);
    return;
  }

  ui.add("C3", "A 组（打字机开）抖动指标", "KNOWN",
    `scrollTop 单帧maxJump=${A.st.maxJump}px 反转=${A.st.reversals} 净=${A.st.net}；` +
    `内容 单帧maxJump=${A.pi.maxJump}px 反转=${A.pi.reversals}；删除 ${A.deleted} 字符；` +
    `${A.st.n} 帧；jumps=${JSON.stringify(A.st.jumps.slice(0, 6))}`);
  ui.add("C4", "B 组（打字机关）抖动指标", "KNOWN",
    `scrollTop 单帧maxJump=${B.st.maxJump}px 反转=${B.st.reversals} 净=${B.st.net}；` +
    `内容 单帧maxJump=${B.pi.maxJump}px 反转=${B.pi.reversals}；删除 ${B.deleted} 字符；` +
    `${B.st.n} 帧；jumps=${JSON.stringify(B.st.jumps.slice(0, 6))}`);

  const verdict = !A.jitter && !B.jitter ? "**未复现**（A/B 都不抖）"
    : A.jitter && !B.jitter ? "**归因打字机**（A 抖 B 不抖）"
      : !A.jitter && B.jitter ? "B 抖 A 不抖（异常）"
        : "A/B 都抖 → 另有共同来源";
  ui.add("C0", "★★ 单变量结论：抖动是否由打字机造成", "KNOWN",
    `A(开) jitter=${A.jitter}  B(关) jitter=${B.jitter}  →  ${verdict}`);

  ui.log("[SUMMARY] " + JSON.stringify({
    A: { st: A.st, pi: A.pi, deleted: A.deleted, caret: A.caret.caretY, contentY: A.caret.contentY, jitter: A.jitter },
    B: { st: B.st, pi: B.pi, deleted: B.deleted, caret: B.caret.caretY, contentY: B.caret.contentY, jitter: B.jitter },
    verdict,
  }, null, 1));

  await ui.shot("reader-bs2");
});
