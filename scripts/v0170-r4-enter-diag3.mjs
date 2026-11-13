/**
 * T3 诊断 3：**打字机开启（ON）时，一次点击把 scrollTop 从 4019 归 0 —— 谁干的？**
 *
 * 已确证（`v0170-r4-enter-diag2.mjs`）：
 * ```
 * 滚到 50%  st=4019
 * 点击 0.15 处
 * +150ms    st=0 / docTop 复位成 158.59 / pos 变成 3781（用户点击位置）
 *           ↑ 全程只有 1 笔写入：scrollTo({top:3684,behavior:"smooth"})
 * ```
 * 也就是**归 0 不经过任何 scrollTop setter** → 两个候选：
 *
 * | 假说 | 机制 | 如果成立，证据会是 |
 * |---|---|---|
 * | **H1 DOM 重建** | `CmSourceSurface.mount()` 新建 `EditorView` → 新 `.cm-scroller` 元素，其 scrollTop **天生是 0**（不需要任何写入），宿主再用 `setText`/`setSelection` 补内容与光标 | `.cm-scroller` 节点身份变化；`.cm-editor` 被移除再插入；mount 次数 +1 |
 * | **H2 浏览器钳位** | 内容高度瞬间塌到 ≤ clientHeight（受控写入把整篇清了一下）→ 浏览器把 scrollTop 钳到 0，**不经过 setter** | `.cm-scroller` 身份不变；`scrollHeight` 在中途出现远小于 8796 的采样 |
 *
 * 判据区别很关键：H1 要修重建源，H2 要修受控写入。**不能靠猜。**
 *
 * 做法：
 * 1. 给 `.cm-scroller` / `.cm-editor` 打身份标记（`__probeUid`）；
 * 2. MutationObserver 观察 `.editor-main-area`（childList+subtree），记录 `.cm-editor` 的增删；
 * 3. 高频采样（每帧 rAF）记录 `scrollerUid / st / sh`，抓"塌陷"那一帧；
 * 4. 记录所有 scrollTop/scrollTo 写入，**不过滤 cls**（避免漏掉别的容器）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);

await runBrowserProbe({ name: "v0170-r4-diag3", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);

  const readTw = () => ui.ev(`
    const b = Array.from(document.querySelectorAll(".statusbar-toggle"))
      .find(x => (x.getAttribute("title") || "").indexOf("打字机") >= 0);
    return b ? b.classList.contains("active") : null;
  `);

  /* ── 装身份标记 / MutationObserver / 全量写入打桩 ─────────── */
  await ui.ev(`
    if (!window.__DIAG3) {
      window.__DIAG3 = true;
      window.__UID_SEQ = 0;
      window.__EV = [];
      const push = (o) => { try { window.__EV.push(Object.assign({ t: Math.round(performance.now()) }, o)); } catch (e) {} };
      window.__PUSH = push;

      window.__STAMP = () => {
        for (const sel of [".cm-editor", ".cm-scroller", ".cm-content"]) {
          for (const el of document.querySelectorAll(sel)) {
            if (!el.__probeUid) { el.__probeUid = sel.replace(/\\W/g, "") + "#" + (++window.__UID_SEQ); }
          }
        }
        return true;
      };

      // 全量写入打桩（不筛 cls，只记顶层 tag/cls，便于发现"别的容器"）
      window.__W = [];
      const record = (el, v, how) => {
        try {
          const cls = String(el.className || el.tagName || "");
          if (!cls.includes("cm-") && !cls.includes("editor")) return;
          const stack = (new Error().stack || "").split("\\n").slice(1, 9).map(s => s.trim().replace(/https?:\\/\\/[^ )]+\\//g, "").slice(0, 110));
          window.__W.push({ t: Math.round(performance.now()), v: Math.round(v), from: Math.round(el.scrollTop), cls: cls.slice(0, 34), uid: el.__probeUid || null, how, stack });
        } catch (e) {}
      };
      const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true, enumerable: proto.enumerable,
        get() { return proto.get.call(this); }, set(v) { record(this, v, "scrollTop="); return proto.set.call(this, v); },
      });
      for (const m of ["scrollTo", "scrollBy"]) {
        const o = Element.prototype[m]; if (!o) continue;
        Element.prototype[m] = function (a, b) {
          const top = (typeof a === "object" && a) ? a.top : b;
          record(this, typeof top === "number" ? top : this.scrollTop, m + "()" + (typeof a === "object" && a && a.behavior ? ":" + a.behavior : ""));
          return o.call(this, a, b);
        };
      }

      // 观察 .editor-main-area：记录 .cm-editor 的增删（= 重建）
      window.__EV.length = 0;
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && (n.matches?.(".cm-editor") || n.querySelector?.(".cm-editor"))) push({ k: "add", node: String(n.className || n.tagName).slice(0, 40) });
          }
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && (n.matches?.(".cm-editor") || n.querySelector?.(".cm-editor"))) push({ k: "remove", node: String(n.className || n.tagName).slice(0, 40) });
          }
        }
      });
      const root = document.querySelector(".editor-main-area") || document.body;
      obs.observe(root, { childList: true, subtree: true });
      window.__OBS = obs;
      window.__STAMP();
    }
    return true;
  `);

  /** 逐帧采样：scroller 身份 + st + sh（抓"塌陷帧"） */
  const startFrame = (ms) => ui.ev(`
    window.__F = [];
    (function () {
      const t0 = performance.now();
      window.__F0 = t0;
      const tick = () => {
        const sc = document.querySelector(".cm-scroller");
        const rec = { t: Math.round(performance.now() - t0) };
        if (sc) {
          rec.uid = sc.__probeUid || null;
          rec.st = Math.round(sc.scrollTop * 100) / 100;
          rec.sh = Math.round(sc.scrollHeight);
          rec.ch = sc.clientHeight;
        } else rec.missing = true;
        const ed = document.querySelector(".cm-editor");
        rec.edUid = ed ? (ed.__probeUid || null) : null;
        window.__F.push(rec);
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
    return true;
  `);

  const wheelTo = async (pct) => {
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
    await ui.sleep(400);
    return ui.ev(`const sc=document.querySelector(".cm-scroller"); return { st: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight-sc.clientHeight) };`);
  };

  const stateOf = () => ui.ev(`
    const sc = document.querySelector(".cm-scroller");
    const ed = document.querySelector(".cm-editor");
    return {
      scUid: sc ? (sc.__probeUid || null) : null,
      edUid: ed ? (ed.__probeUid || null) : null,
      st: sc ? Math.round(sc.scrollTop) : null,
      sh: sc ? Math.round(sc.scrollHeight) : null,
      cards: document.querySelectorAll(".cm-editor").length,
      events: (window.__EV || []).length,
    };
  `);

  /* ── 先跑 OFF 组同一操作（对照：OFF 也重建吗？）─────────── */
  const runCase = async (tag) => {
    ui.log(`[${tag}] 起始 tw=${await readTw()}`);
    await ui.ev(`window.__STAMP(); window.__EV = []; window.__W = []; return true;`);
    const before = await stateOf();
    ui.log(`[${tag}] before = ` + JSON.stringify(before));

    const w = await wheelTo(0.5);
    await ui.ev(`window.__STAMP(); return true;`);
    const afterWheel = await stateOf();
    ui.log(`[${tag}] afterWheel = ` + JSON.stringify(afterWheel) + ` wheel=` + JSON.stringify(w));

    const pt = await ui.ev(`
      const sc = document.querySelector(".cm-scroller");
      const r = sc.getBoundingClientRect();
      const y = Math.round(r.top + sc.clientHeight * 0.15);
      for (const dx of [0.45, 0.55, 0.35]) {
        const x = Math.round(r.left + sc.clientWidth * dx);
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest(".cm-content")) return { x, y };
      }
      return null;
    `);

    await startFrame(1800);
    await ui.sleep(100);
    const beforeClick = await stateOf();
    if (pt) await ui.click(pt.x, pt.y);
    await ui.sleep(2000);

    const frames = await ui.ev(`return window.__F || []`);
    const evs = await ui.ev(`return window.__EV || []`);
    const writes = await ui.ev(`return (window.__W || []).slice(0, 40)`);
    const after = await stateOf();

    // 帧序列分析
    const uids = [...new Set(frames.map((f) => f.uid).filter(Boolean))];
    const eds = [...new Set(frames.map((f) => f.edUid).filter(Boolean))];
    const shMin = frames.reduce((m, f) => (typeof f.sh === "number" ? Math.min(m, f.sh) : m), Infinity);
    const stSeq = frames.filter((f) => typeof f.st === "number");
    let stMin = Infinity, stMax = -Infinity;
    for (const f of stSeq) { stMin = Math.min(stMin, f.st); stMax = Math.max(stMax, f.st); }
    // 找"塌陷帧"：sh 突然远小于终值
    const shFinal = stSeq.length ? stSeq[stSeq.length - 1].sh : null;
    const collapse = frames.filter((f) => typeof f.sh === "number" && shFinal && f.sh < shFinal * 0.8).length;

    ui.add(`H-${tag}-uid`, `【H1 DOM 重建】scroller 身份在点击前后是否不变`, uids.length <= 1 ? "PASS" : "FAIL",
      `帧内出现的 scroller uid = ${JSON.stringify(uids)}；editor uid = ${JSON.stringify(eds)}；MutationObserver 事件 = ${JSON.stringify(evs.slice(0, 6))}`);
    ui.add(`H-${tag}-collapse`, `【H2 浏览器钳位】内容高度是否中途塌陷（<80% 终值）`, collapse === 0 ? "PASS" : "FAIL",
      `塌陷帧 ${collapse} 个；sh 最小 ${shMin === Infinity ? "?" : shMin} / 终值 ${shFinal}`);
    ui.add(`H-${tag}-jump`, `点击后 scrollTop 是否发生大跳（>3px）`, (stMax - stMin) <= 3 ? "PASS" : "FAIL",
      `st 轨迹 min=${stMin === Infinity ? "?" : stMin} max=${stMax === -Infinity ? "?" : stMax}；beforeClick=${beforeClick.st} after=${after.st}`);
    ui.log(`[${tag}] writes=${writes.length}`, JSON.stringify(writes.map((w) => `${w.how}@${w.uid}:${w.v}(from ${w.from})`)));
    for (const w of writes.slice(0, 8)) {
      ui.log(`   ${w.how} v=${w.v} from=${w.from} uid=${w.uid} @${w.t}`);
      for (const s of (w.stack || []).slice(0, 4)) ui.log(`      ${s}`);
    }
    ui.log(`[${tag}] evs = ` + JSON.stringify(evs.slice(0, 10)));
    ui.log(`[${tag}] frame-head = ` + JSON.stringify(frames.slice(0, 16)));
    ui.log(`[${tag}] after = ` + JSON.stringify(after));
  };

  // OFF 组
  const tw0 = await readTw();
  if (tw0) { await ui.command("view.toggleTypewriter"); await ui.sleep(1200); }
  await runCase("OFF");
  // ON 组
  await ui.command("view.toggleTypewriter");
  await ui.sleep(1200);
  await runCase("ON");

  await ui.shot("diag3");
});
