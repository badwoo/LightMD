/**
 * v0.17.0 第四轮 · T3 · **右屏 +169px / −182px 两笔写入的溯源（修正版）**
 *
 * ## 前一版为什么零写入（重要，别再踩）
 * 我在**父窗口**的 `Element.prototype.scrollTop` 上装 hook，结果 iframe 里的写入
 * **一笔都没捕获到**。原因是硬事实：
 *
 * > **iframe 有独立的 JS realm**，其内部元素的 `Element.prototype` 与父窗口的
 * > 不是同一个对象。父窗口上的 defineProperty 对 iframe 内的元素**完全不生效**。
 *
 * 正确做法：注入到 `iframe.contentWindow.Element.prototype`。
 * （同源可访问，本应用的分屏预览是 srcdoc/同源文档，实测可读写 contentDocument。）
 *
 * ## 另一处修正：**必须保存原描述符再恢复**
 * 前一版用 `delete Element.prototype.scrollTop` 还原 —— 但那个访问器是我
 * `defineProperty` 在 `Element.prototype` 上的自有属性，删掉后**原型链上没有原生访问器了**
 * （原生访问器本就在 `Element.prototype` 上）→ 之后所有滚动写入失效 →
 * 直接引发 `TypeError: Cannot read properties of undefined (reading 'enumerable')`，
 * 并把后续用例污染成 `caretY=-3959` 的 INVALID。
 * 正确做法：先 `Object.getOwnPropertyDescriptor` 存下来，恢复时 defineProperty 回去。
 *
 * ## 本探针要同时回答的三件事
 * 1. **右屏什么时候被重写**：监听 iframe `documentElement` 的子树 mutation +
 *    `body` 节点身份变化 + `load` 事件（记录时刻）。
 * 2. **两笔大写入（+169 / −182）的调用栈**（hook iframe realm 的 scrollTop setter）。
 * 3. **大跳与"重写时刻"的相对时间**：若 +169 紧跟在一次 body 替换之后，
 *    说明跳变来自"重写期间用陈旧/半成品锚点表做了映射"。
 *
 * ## 自校验（防 hook 改变被测行为）
 * 同一场景跑 2 次：无 hook 基线 / 有 hook。两组 `maxUp` 相差 >30% 则该组 INVALID。
 *
 * ## 前置断言
 * A1 右屏可读 / A2 左屏可滚动 / A3 光标在视口内 / A4 采样前稳定 / A5 回车加了行
 *
 * 用法：
 *   BROWSER_PROBE_DIST="D:/AI/markdown view/lightmd/_verify-out/dist-t3" node scripts/v0170-r4-enter-writer.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

const START_TRACE = (ms) => `
  window.__TR = [];
  window.__EV = [];      // iframe 重写事件时刻
  window.__BODYID = null;
  (function () {
    // ① 监听 iframe 文档结构变化（含 body 节点被替换）
    try {
      const f = document.querySelector("iframe.split-preview, iframe");
      const d = f && f.contentDocument;
      if (d && d.documentElement) {
        if (window.__IFOBS) window.__IFOBS.disconnect();
        const push = (k, extra) => {
          try { window.__EV.push(Object.assign({ t: Math.round(performance.now() - t0), k }, extra || {})); } catch (e) {}
        };
        window.__BODYID = d.body ? 1 : 0;
        window.__IFOBS = new MutationObserver((muts) => {
          let bodyReplaced = false, n = 0;
          for (const m of muts) {
            n += m.addedNodes.length + m.removedNodes.length;
            for (const nd of m.addedNodes) if (nd.nodeName === "BODY") bodyReplaced = true;
            for (const nd of m.removedNodes) if (nd.nodeName === "BODY") bodyReplaced = true;
          }
          push(bodyReplaced ? "body-replaced" : "mut", { n, st: Math.round((d.scrollingElement || d.documentElement).scrollTop) });
        });
        window.__IFOBS.observe(d.documentElement, { childList: true, subtree: true });
        push("obs-attached", { tagCount: d.querySelectorAll("[data-src-line]").length });
      }
    } catch (e) { window.__EV.push({ k: "obs-fail", err: String(e).slice(0, 60) }); }

    const t0 = performance.now();
    const tick = () => {
      const rec = { t: Math.round(performance.now() - t0) };
      const sc = document.querySelector(".cm-scroller");
      if (sc) rec.st = Math.round(sc.scrollTop * 100) / 100;
      const f = document.querySelector("iframe.split-preview, iframe");
      if (f) {
        try {
          const d = f.contentDocument;
          const se = d && (d.scrollingElement || d.documentElement);
          if (se) {
            rec.deST = Math.round(se.scrollTop * 100) / 100;
            rec.deSH = Math.round(se.scrollHeight);
            rec.tags = d.querySelectorAll("[data-src-line]").length;
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
    const se = d && (d.scrollingElement || d.documentElement);
    if (!se) return { ok: false, reason: "no scrollingElement" };
    return { ok: true, st: round(se.scrollTop), sh: round(se.scrollHeight),
             tags: d.querySelectorAll("[data-src-line]").length };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 50) }; }
`;

/**
 * 注入 iframe realm 的 scrollTop setter hook。
 *
 * ⚠️ 三个约束（都是前一版用失败换来的）：
 * 1. 必须取 `iframe.contentWindow.Element` —— 父窗口的 `Element` 不覆盖 iframe；
 * 2. 必须**保存原描述符**，恢复时 defineProperty 回去（不能 delete）；
 * 3. iframe 文档被 `doc.open()/write()` 重写后 **window 与 prototypes 不变**，
 *    所以只装一次即可；但 `scrollingElement` 可能换实例 → 判据用"是否 documentElement/body"。
 */
const INSTALL_IFRAME_SPY = `
  try {
    const f = document.querySelector("iframe.split-preview, iframe");
    const w = f && f.contentWindow;
    if (!w) return { ok: false, reason: "no contentWindow" };
    const E = w.Element;
    if (!E) return { ok: false, reason: "no iframe Element" };
    if (w.__SPY_ON) return { ok: true, already: true };
    const proto = Object.getOwnPropertyDescriptor(E.prototype, "scrollTop");
    if (!proto) return { ok: false, reason: "no descriptor" };
    w.__SPY_ON = true;
    w.__W = [];
    w.__ORIG = proto;
    Object.defineProperty(E.prototype, "scrollTop", {
      configurable: true,
      enumerable: proto.enumerable,
      get() { return proto.get.call(this); },
      set(v) {
        try {
          const doc = this.ownerDocument;
          const se = doc && (doc.scrollingElement || doc.documentElement);
          if (se && (this === se || this === doc.documentElement || this === doc.body)) {
            const stack = (new Error().stack || "").split("\\n").slice(1, 14)
              .map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 130));
            w.__W.push({ t: Math.round(performance.now()), v: Math.round(v * 100) / 100,
                         from: Math.round(proto.get.call(this) * 100) / 100, stack });
          }
        } catch (e) {}
        return proto.set.call(this, v);
      },
    });
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 100) }; }
`;

const RESTORE_IFRAME_SPY = `
  try {
    const f = document.querySelector("iframe.split-preview, iframe");
    const w = f && f.contentWindow;
    if (w && w.__SPY_ON && w.__ORIG) {
      Object.defineProperty(w.Element.prototype, "scrollTop", {
        configurable: true,
        enumerable: w.__ORIG.enumerable,
        get: w.__ORIG.get,
        set: w.__ORIG.set,
      });
      w.__SPY_ON = false;
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e).slice(0, 100) }; }
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
    bounceGapMs: upAt !== null && downAt !== null ? Math.round(Math.abs(downAt - upAt)) : null,
    reversals: Math.max(0, runs.length - 1), frames: nz.length,
    deltas: nz.slice(0, 24).map((it) => `${it.t}:${it.d}`),
  };
}

async function reinstallDoc(ui, doc) {
  const tmp = ui.path.join(ui.path.dirname(ui.docFile), "t3-writer.md");
  ui.fs.writeFileSync(tmp, doc, "utf8");
  for (let i = 0; i < 10; i++) {
    await ui.ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(tmp)}, name: "t3-writer.md", content: ${JSON.stringify(doc)} },
      }));
      return true;
    `).catch(() => {});
    await ui.sleep(450);
    const ok = await ui.ev(`try { const c=document.querySelector(".cm-content"); const v=c&&c.cmTile&&c.cmTile.view; return !!(v && v.state.doc.lines > 100); } catch(e) { return false; }`);
    if (ok) break;
  }
  await ui.sleep(900);
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

await runBrowserProbe({ name: "v0170-r4-enter-writer", doc: DOC }, async (ui) => {
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

  const run = async (tag, { spy }) => {
    // 每个用例重置文档（避免 undo 残留导致状态漂移 → 上一版就是这样把后续用例污染成 INVALID 的）
    await reinstallDoc(ui, DOC);
    await ui.focusSource();
    await ui.sleep(200);
    await wheelTo(ui, 0.5);
    const pt = await placeCursor(ui, 0.85);
    if (!pt) { ui.add(`I-${tag}`, "INVALID：落点找不到", "FAIL", "无"); return null; }
    await ui.sleep(800);
    const settled = await waitSettled(ui);
    const pre = await ui.ev(READ_STATE);
    const prePv = await ui.ev(READ_PREVIEW);

    let spyRes = null;
    if (spy) {
      spyRes = await ui.ev(INSTALL_IFRAME_SPY);
      ui.log(`[${tag}] 装 iframe spy = ` + JSON.stringify(spyRes));
      if (!spyRes.ok) { ui.add(`I-${tag}`, "INVALID：iframe spy 装不上", "FAIL", JSON.stringify(spyRes)); return null; }
    }

    await ui.ev(START_TRACE(1900));
    await ui.sleep(120);
    await ui.key("Enter", "Enter", 13);
    await ui.sleep(2300);

    const trace = await ui.ev(`return window.__TR || []`);
    const events = await ui.ev(`return window.__EV || []`);
    const writes = await ui.ev(`
      try { const f=document.querySelector("iframe.split-preview, iframe"); const w=f&&f.contentWindow; return (w&&w.__W)||[]; }
      catch(e) { return []; }
    `);
    const post = await ui.ev(READ_STATE);
    const postPv = await ui.ev(READ_PREVIEW);
    if (spy) {
      const r = await ui.ev(RESTORE_IFRAME_SPY);
      ui.log(`[${tag}] 还原 spy = ` + JSON.stringify(r));
    }

    const st = series(trace, "st");
    const deST = series(trace, "deST");
    const asserts = [
      { id: "A1", ok: prePv.ok && prePv.tags > 0, why: `右屏可读=${prePv.ok} 贴标=${prePv.tags}` },
      { id: "A2", ok: pre.max > 300, why: `max=${pre.max}` },
      { id: "A3", ok: pre.caretY !== null && pre.caretY >= 0 && pre.caretY <= pre.ch, why: `caretY=${pre.caretY}/${pre.ch}` },
      { id: "A4", ok: settled, why: `stable=${settled}` },
      { id: "A5", ok: (post.lines ?? 0) === (pre.lines ?? -1) + 1, why: `lines ${pre.lines}→${post.lines}` },
    ];
    const bad = asserts.filter((x) => !x.ok);
    if (bad.length) { ui.add(`I-${tag}`, "INVALID（前置断言不成立）", "FAIL", bad.map((x) => `${x.id}:${x.why}`).join("；")); return null; }

    ui.log(`[${tag}] 左屏 ${JSON.stringify({ net: st.net, up: st.maxUp, rev: st.reversals, frames: st.frames })}`);
    ui.log(`[${tag}] 右屏 ${JSON.stringify({ net: deST.net, up: deST.maxUp, at: deST.maxUpAt, down: deST.maxDown, downAt: deST.maxDownAt, bounce: deST.bounceGapMs, rev: deST.reversals, deltas: deST.deltas })}`);
    ui.log(`[${tag}] iframe 重写事件 ${events.length} 条：` + JSON.stringify(events.slice(0, 14)));
    ui.log(`[${tag}] iframe scrollTop 写入 ${writes.length} 笔`);
    for (const w of writes.slice(0, 16)) {
      ui.log(`    t=${w.t} v=${w.v}（from ${w.from}）`);
      for (const s of (w.stack || []).slice(0, 6)) ui.log(`        ${s}`);
    }
    ui.log(`[${tag}] 帧序(t:左/右/tags) = ` + JSON.stringify(trace.slice(0, 30).map((s) => `${s.t}:${s.st}/${s.deST}/T${s.tags}`)));
    return { tag, spy, st, deST, writes, events, pre, prePv, post, postPv, trace };
  };

  await setTw(true);
  ui.log("[tw] active=" + (await readTw()));

  const p1 = await run("P·无hook", { spy: false });
  const h1 = await run("H·hook iframe realm", { spy: true });
  const p2 = await run("P·无hook·重复", { spy: false });
  const h2 = await run("H·hook iframe realm·重复", { spy: true });

  /* ── 自校验 ─────────────────────────────────────────────── */
  const pairs = [[p1, h1], [p2, h2]].filter(([a, b]) => a && b);
  const selfCheck = pairs.map(([p, h]) => {
    const denom = Math.max(1, Math.max(p.deST.maxUp, h.deST.maxUp));
    return { p: p.deST.maxUp, h: h.deST.maxUp, spread: Math.round((Math.abs(p.deST.maxUp - h.deST.maxUp) / denom) * 100) / 100 };
  });
  ui.add("S1", "探针自校验：iframe-realm hook 不改变被测行为（跳变量级差 ≤30%）",
    selfCheck.length > 0 && selfCheck.every((s) => s.spread <= 0.3) ? "PASS" : "FAIL",
    selfCheck.length ? selfCheck.map((s) => `无hook ${s.p}px vs hook ${s.h}px（差 ${Math.round(s.spread * 100)}%）`).join("；") : "无配对数据");

  /* ── 真凶判定 ─────────────────────────────────────────── */
  const hRows = [h1, h2].filter(Boolean);
  const big = hRows.map((r) => ({
    tag: r.tag,
    up: r.writeBig ? null : r.writes.filter((w) => w.v - w.from > 50),
    down: r.writes.filter((w) => w.v - w.from < -50),
  }));
  const fmt = (arr) => arr.map((w) => {
    const s = (w.stack || []).slice(1, 5).filter((x) => x && !/record|__SPY|Object\.set|at Object/.test(x));
    return `v=${w.v}(from ${w.from}) @${w.t}ms 栈: ${s.join(" ← ")}`;
  }).join(" ‖ ");

  ui.add("W1", "★ 右屏大幅正跳（>50px）的写入者已抓到",
    big.length && big.every((b) => b.up.length > 0) ? "PASS" : "FAIL",
    big.length ? big.map((b) => `${b.tag}: ${b.up.length} 笔 — ${fmt(b.up)}`).join("；") : "无数据");
  ui.add("W2", "★ 右屏大幅回弹（<−50px）的写入者已抓到",
    big.length && big.every((b) => b.down.length > 0) ? "PASS" : "FAIL",
    big.length ? big.map((b) => `${b.tag}: ${b.down.length} 笔 — ${fmt(b.down)}`).join("；") : "无数据");
  ui.add("W3", "大跳是否紧跟一次 iframe 重写（body 替换 / 大量 mutation）",
    (() => {
      const r = h1 || h2;
      if (!r || !r.deST.valid || r.deST.maxUpAt === null) return "KNOWN";
      const near = (r.events || []).filter((e) => Math.abs(e.t - r.deST.maxUpAt) <= 120);
      return near.length > 0 ? "FAIL" : "PASS";
    })(),
    (() => {
      const r = h1 || h2;
      if (!r) return "无数据";
      return `右屏最大正跳 @${r.deST.maxUpAt}ms；±120ms 内的重写事件 = ` +
        JSON.stringify((r.events || []).filter((e) => Math.abs(e.t - r.deST.maxUpAt) <= 120));
    })());

  ui.log("[SUMMARY] " + JSON.stringify({
    selfCheck,
    rows: [p1, h1, p2, h2].filter(Boolean).map((r) => ({
      tag: r.tag, left: { net: r.st.net, up: r.st.maxUp },
      right: { net: r.deST.net, up: r.deST.maxUp, down: r.deST.maxDown, bounce: r.deST.bounceGapMs, rev: r.deST.reversals },
      writes: r.writes.length, bodyReplaced: (r.events || []).filter((e) => e.k === "body-replaced").length,
      events: (r.events || []).length, preTags: r.prePv.tags, postTags: r.postPv.tags,
    })),
    bigWrites: big,
  }, null, 1));

  await ui.shot("writer");
});
