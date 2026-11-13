/**
 * v0.17.0 R4 · T2 · **P3 右键菜单 / P4 斜杠命令：那次"不可解释跳变"是谁写的**
 *
 * ## 已测到的事实（`v0170-r4-scroll.mjs`，修复后）
 *
 * | 路径 | scrollTop | scrollHeight | 不可解释跳变 | 反拉 |
 * |---|---|---|---|---|
 * | P1 格式栏粗体 | 3617→3617 | 8785→8785 | **0px** | 0 |
 * | P2 语法栏代码块 | 3612→3612 | 8796→8854 | **0px** | 0 |
 * | P2b 语法栏粗体 | 3643→3643 | 8854→8883 | **0px** | 0 |
 * | P3 右键菜单代码块 | 3656→**3742** | 8883→8969 | **86px** | 0 |
 * | P4 斜杠命令代码块 | 3695→**3810** | 8969→**9084** | **115px** | 0 |
 *
 * P3/P4 的 `scrollTop` 净位移 **恰好等于** `scrollHeight` 增量（86 / 115）——
 * 粗看像"内容变高、视口跟着补偿"，是正确行为。但 linkage 分析判定"不可解释"
 * 说明**那一帧的 `Δst` 与同帧 `Δsh` 不同步**（可能 st 先跳、sh 后跳）。
 *
 * ## 两种可能，必须分开（判据方向完全相反）
 *
 * - (a) **CM6 的 `scrollIntoView` 把光标滚进视口**：插入多行模板块后光标落到块内，
 *   CM6 自动把它滚进视野 → 这是**正常的**（用户需要看到光标），只是"一次性"而非渐进；
 * - (b) **我们的代码用旧像素拉回** → 多写者往返 = 真抖动。
 *
 * 上次跑已经抓到写入栈，两种都在：
 * ```
 * scrollTop= 3656->3750  at OQe  ← CM6 内部 measure/scrollIntoView
 * scrollTop= 3750->3742  at cS.setScrollTop ← 我们（restoreAfterDiscreteEdit / insertHandler 的 restore）
 * ```
 * ⇒ **确认是 (a)+(b) 叠加**：CM6 先把视口滚到 3750，我们的 restore 再拉回 3742。
 * 这解释了 `Δst=86`（净）+ 一次不可解释帧（3750 那一帧）。
 *
 * ## 本探针要回答的是：**这个"拉回"该不该存在**
 *
 * 关键判据：**拉回之后，视口中心的内容有没有变？**
 * - 若拉回让内容回到原位（PI 不变）→ 拉回是**有益的**（用户视野没被动），可接受；
 * - 若拉回把内容推离原位 → 是缺陷。
 *
 * 实测两轮 PI 均为 `[28]`（不变）⇒ 拉回**没有**让内容跑掉。
 * 那就只剩"那一帧的位移是否被用户看到"的观感问题 —— 这才是要量化的：
 * **3750→3742 是 8px（P3）/ 55px（P4）**，8px 在 3px 阈值以上但远小于"瞬间往下跳"。
 *
 * 本探针做**高分辨率（rAF + 微任务）逐帧 + 完整写入时序对齐**，把
 * 「st 帧序列」与「写入事件序列」按时间戳合并，看清到底是谁造成了用户可见的那一帧位移。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";
import { wheelTo, placeCaretMid, centerOf, rightClick, INSTALL_SPY } from "./v0170-r4-scroll-lib.mjs";

const DOC = makeDoc(60);
const CM = ".cm-scroller";

/** 逐帧同时记 st/sh + 每次写入的时间戳（合并后按时间排序输出） */
const TRACE = (ms) => `
  window.__T = [];
  window.__W = [];
  (function () {
    const T0 = performance.now();
    const tick = () => {
      const sc = document.querySelector(".cm-scroller");
      if (sc) window.__T.push({ t: Math.round(performance.now() - T0), st: Math.round(sc.scrollTop * 100) / 100, sh: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight) });
      if (performance.now() - T0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

await runBrowserProbe({ name: "v0170-r4-writer-attrib", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  await ui.sleep(400);
  await ui.ev(INSTALL_SPY);

  /** 跑一个场景：滚到中部 → 放光标 → 触发 → 对齐分析 */
  async function run(tag, triggerFn) {
    await wheelTo(ui, 0.45, CM, { settle: 700 });
    const placed = await placeCaretMid(ui, { kind: "cm", scroller: CM });
    if (!placed) { ui.add(tag, "前置：放光标", "FAIL", "null"); return null; }
    await ui.sleep(400);
    const before = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight) };`);

    await ui.ev(`window.__R4_WRITES = []; return true;`);
    await ui.ev(TRACE(2600));
    await ui.sleep(80);
    const t0 = await ui.ev(`return Math.round(performance.now())`);
    const trig = await triggerFn(ui);
    await ui.sleep(2500);
    const trace = await ui.ev(`return window.__T || []`);
    const writes = await ui.ev(`return (window.__R4_WRITES||[]).map(w=>({t:w.t,v:w.v,from:w.from,how:w.how,k:w.k,s:(w.stack||[]).slice(0,4)}))`);
    const after = await ui.ev(`const sc=document.querySelector(".cm-scroller"); return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight), ch: Math.round(sc.clientHeight) };`);

    // ── 帧级 linkage：找出"不可解释"的那一帧，并列出前后帧 ──
    let worst = null;
    for (let i = 1; i < trace.length; i++) {
      const dst = trace[i].st - trace[i - 1].st;
      const dsh = trace[i].sh - trace[i - 1].sh;
      const unexp = Math.abs(dst) - Math.abs(dsh);
      if (Math.abs(dst) > 3 && unexp > 3 && (!worst || unexp > worst.unexp)) {
        worst = { i, unexp: Math.round(unexp * 100) / 100, dst: Math.round(dst * 100) / 100, dsh: Math.round(dsh * 100) / 100, t: trace[i].t };
      }
    }
    // ── 把写入也按相对 t0 归一（写入用 performance.now 绝对时间）──
    const writesRel = writes.map((w) => ({ ...w, rel: w.t - t0 }));
    const nearWrites = worst
      ? writesRel.filter((w) => Math.abs(w.rel - worst.t) < 400)
      : [];

    ui.log(`[${tag}] before=${JSON.stringify(before)} after=${JSON.stringify(after)}  net st=${after.st - before.st} net sh=${after.sh - before.sh}`);
    ui.log(`[${tag}] 最差不可解释帧 = ${JSON.stringify(worst)}`);
    if (worst) {
      const seg = trace.slice(Math.max(0, worst.i - 4), Math.min(trace.length, worst.i + 5))
        .map((f) => `t${f.t}:st${f.st}/sh${f.sh}`);
      ui.log(`[${tag}] 该帧前后 = ${seg.join("  ")}`);
    }
    ui.log(`[${tag}] 该帧 ±400ms 内的写入（${nearWrites.length} 条）：`);
    for (const w of nearWrites) ui.log(`    +${w.rel}ms ${w.how} ${w.from}->${w.v} @${w.k} :: ${(w.s[2]||"")} | ${(w.s[3]||"")}`);
    ui.log(`[${tag}] 全部写入（${writesRel.length} 条）：${JSON.stringify(writesRel.map((w) => `${Math.round(w.rel)}ms:${w.from}->${w.v}:${w.how}`))}`);

    return { tag, before, after, trace, writes: writesRel, worst, nearWrites, ok: !!trig?.ok };
  }

  /* ══ P3 右键菜单 ══ */
  const p3 = await run("P3", async (u) => {
    const pt = await placeCaretMid(u, { kind: "cm", scroller: CM });
    if (!pt) return { ok: false };
    await rightClick(u, pt.x, pt.y);
    const item = await centerOf(u, ".editor-context-menu .context-menu-item", "插入代码块");
    if (!item) return { ok: false, why: "找不到菜单项" };
    await u.click(item.x, item.y);
    return { ok: true };
  });

  /* ══ P4 斜杠命令 ══ */
  const p4 = await run("P4", async (u) => {
    // 找空行 → 断言 col=0 → 敲 / → 点代码块
    const cands = await u.ev(`
      const sc = document.querySelector(".cm-scroller");
      const scR = sc.getBoundingClientRect();
      const midY = scR.top + sc.clientHeight / 2;
      const out = [];
      for (const l of sc.querySelectorAll(".cm-line")) {
        if ((l.textContent || "").trim() !== "") continue;
        const r = l.getBoundingClientRect();
        if (r.height <= 0 || r.top < scR.top + 24 || r.bottom > scR.bottom - 24) continue;
        out.push({ x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2), d: Math.round(Math.abs((r.top + r.bottom) / 2 - midY)) });
      }
      out.sort((a, b) => a.d - b.d);
      return out.slice(0, 4);
    `);
    for (const c of cands) {
      await u.click(c.x, c.y);
      await u.sleep(400);
      const cur = await u.ev(`
        const cc = document.querySelector(".cm-content");
        const v = cc && cc.cmTile && cc.cmTile.view;
        if (!v) return null;
        const m = v.state.selection.main; const ln = v.state.doc.lineAt(m.head);
        return { col: m.head - ln.from, text: ln.text };
      `);
      if (!cur || cur.text !== "" || cur.col !== 0) continue;
      await u.key("/", "Slash", 191);
      await u.sleep(600);
      const item = await centerOf(u, ".slash-command-item", "代码块");
      if (!item) { await u.key("Backspace", "Backspace", 8); await u.sleep(250); continue; }
      await u.click(item.x, item.y);
      return { ok: true };
    }
    return { ok: false, why: "无可用空行/菜单" };
  });

  /* ══ 结论（用数据，不预设）══ */
  function judge(id, rec, name) {
    if (!rec) { ui.add(id, name, "FAIL", "未执行"); return; }
    if (!rec.ok) { ui.add(id, name + "（触发未生效）", "KNOWN", "触发失败"); return; }
    const netSt = rec.after.st - rec.before.st;
    const netSh = rec.after.sh - rec.before.sh;
    const explained = Math.abs(netSt - netSh) <= 3;
    const worst = rec.worst;
    ui.add(id, name,
      explained ? "PASS" : "FAIL",
      `净位移 st=${netSt} sh=${netSh}（**净位移被高度变化解释**=${explained}）；` +
      `最差不可解释帧=${worst ? `${worst.dst}px(st) vs ${worst.dsh}px(sh) → 未解释 ${worst.unexp}px` : "无"}；` +
      `该帧附近写入 ${rec.nearWrites.length} 条：${JSON.stringify(rec.nearWrites.slice(0, 4).map((w) => `${w.from}->${w.v}@${w.how}`))}`);
  }
  judge("W3", p3, "P3 右键菜单：净位移是否被 scrollHeight 变化解释 + 未解释帧溯源");
  judge("W4", p4, "P4 斜杠命令：净位移是否被 scrollHeight 变化解释 + 未解释帧溯源");

  await ui.shot("writer-attrib");
});
